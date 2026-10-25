import {
  Card,
  Chat,
  Modal,
  TextInput,
  type ActionEvent,
  type Message,
  type Thread,
} from "chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeActionValue } from "./cards";
import { createChatwootAdapter } from "./factory";
import type { ChatwootAdapterConfig } from "./types";
import {
  AGENT_WEBHOOK,
  createMemoryState,
  createWaitUntilTracker,
  restMessage,
  signRequest,
  stubFetch,
  webhookMessage,
  type RecordedRequest,
} from "./test-utils";

const BASE_URL = "https://chat.example.com";
const SECRET = "s3cret";
const THREAD_ID = "chatwoot:10:20:300";

interface Handlers {
  onAction?: (event: ActionEvent) => void | Promise<void>;
  onMention?: (thread: Thread, message: Message) => void | Promise<void>;
  onSubscribed?: (thread: Thread, message: Message) => void | Promise<void>;
}

function createContext(
  handlers: Handlers = {},
  config: Partial<ChatwootAdapterConfig> = {},
) {
  const adapter = createChatwootAdapter({
    baseUrl: BASE_URL,
    accessToken: "test-token",
    accountId: 2,
    webhookSecret: SECRET,
    ...config,
  });

  const bot = new Chat({
    userName: "Grace",
    adapters: { chatwoot: adapter },
    state: createMemoryState(),
    logger: "error",
  });

  const captured = {
    mentions: [] as Message[],
    followUps: [] as Message[],
    actions: [] as ActionEvent[],
  };

  bot.onNewMention(async (thread, message) => {
    captured.mentions.push(message);
    await handlers.onMention?.(thread, message);
  });
  bot.onSubscribedMessage(async (thread, message) => {
    captured.followUps.push(message);
    await handlers.onSubscribed?.(thread, message);
  });
  bot.onAction(async (event) => {
    captured.actions.push(event);
    await handlers.onAction?.(event);
  });

  const tracker = createWaitUntilTracker();
  const requests = stubFetch((request: RecordedRequest) =>
    request.url.endsWith("/profile")
      ? { id: 7, name: "Grace Hopper", available_name: "Grace" }
      : restMessage(),
  );

  return {
    adapter,
    bot,
    captured,
    requests,
    deliver: async (payload: unknown) => {
      await bot.webhooks.chatwoot(
        signRequest(payload, SECRET),
        tracker.options,
      );
      await tracker.settled();
    },
    posted: () =>
      requests.filter((request) => request.url.endsWith("/messages")),
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`Unstubbed request to ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Chatwoot adapter integration", () => {
  it("handles mention, subscribe and follow-up through a real Chat instance", async () => {
    const context = createContext({
      onMention: async (thread) => {
        await thread.subscribe();
        await thread.post("Got it!");
      },
      onSubscribed: async (thread, message) => {
        await thread.post(`Echo: ${message.text}`);
      },
    });

    await context.deliver(webhookMessage({ content: "@Grace hello" }));

    expect(context.captured.mentions.map((message) => message.text)).toEqual([
      "@Grace hello",
    ]);
    expect(context.captured.mentions[0].isMention).toBe(true);
    expect(context.posted()[0].body).toMatchObject({
      content: "Got it!",
      message_type: "outgoing",
    });

    await context.deliver(webhookMessage({ id: 3060, content: "follow up" }));

    expect(context.captured.followUps.map((message) => message.text)).toEqual([
      "follow up",
    ]);
    expect(context.posted()[1].body).toMatchObject({
      content: "Echo: follow up",
    });
  });

  it("ignores the messages it posted itself", async () => {
    const context = createContext();

    await context.deliver(
      webhookMessage({ message_type: "outgoing", sender: AGENT_WEBHOOK }),
    );

    expect(context.captured.mentions).toHaveLength(0);
    expect(context.captured.followUps).toHaveLength(0);
  });

  it("routes a card button click back to onAction", async () => {
    const context = createContext({
      onMention: async (thread) => {
        await thread.post(
          Card({
            title: "Order 42",
            children: [
              {
                type: "actions",
                children: [
                  {
                    type: "button",
                    id: "approve",
                    label: "Approve",
                    value: "42",
                  },
                ],
              },
            ],
          }),
        );
      },
      onAction: async (event) => {
        await event.thread?.post(`Approved by ${event.user.fullName}`);
      },
    });

    await context.deliver(webhookMessage({ content: "@Grace review this" }));

    const sent = context.posted()[0].body as Record<string, unknown>;
    expect(sent.content_type).toBe("input_select");
    const items = (sent.content_attributes as { items: { value: string }[] })
      .items;
    expect(items[0].value).toBe(encodeActionValue("approve", "42"));

    await context.deliver(
      webhookMessage({
        event: "message_updated",
        id: restMessage().id,
        message_type: "outgoing",
        content_type: "input_select",
        sender: AGENT_WEBHOOK,
        content_attributes: {
          items,
          submitted_values: [{ title: "Approve", value: items[0].value }],
        },
      }),
    );

    expect(context.captured.actions).toHaveLength(1);
    expect(context.captured.actions[0]).toMatchObject({
      actionId: "approve",
      value: "42",
      threadId: THREAD_ID,
    });
    expect(context.posted()[1].body).toMatchObject({
      content: "Approved by Ada Lovelace",
    });
  });

  it("answers a slash command in its conversation, and the modal it opens", async () => {
    const context = createContext({}, { slashCommands: ["/book"] });
    context.bot.onSlashCommand("/book", async (event) => {
      await event.channel.post(`Booking ${event.text}`);
      await event.openModal(
        Modal({
          callbackId: "book",
          title: "Book",
          children: [
            TextInput({ id: "guests", label: "Guests", maxLength: 2 }),
          ],
        }),
      );
    });
    context.bot.onModalSubmit("book", async (event) => {
      await event.relatedChannel?.post(`Booked for ${event.values.guests}`);
    });

    await context.deliver(webhookMessage({ content: "/book dinner" }));
    await context.deliver(webhookMessage({ id: 3061, content: "4" }));

    expect(
      context
        .posted()
        .map(({ url, body }) => [
          url.split("/accounts/2")[1],
          (body as { content: string }).content,
        ]),
    ).toEqual([
      ["/conversations/300/messages", "Booking dinner"],
      [
        "/conversations/300/messages",
        "**Book**\n\n_Send **cancel** to stop._\n\n**Guests**",
      ],
      ["/conversations/300/messages", "Booked for 4"],
    ]);
    expect(context.captured.mentions).toHaveLength(0);
  });

  it("rejects an unsigned webhook before any handler runs", async () => {
    const context = createContext();
    const response = await context.bot.webhooks.chatwoot(
      signRequest(webhookMessage()),
    );

    expect(response.status).toBe(401);
    expect(context.captured.mentions).toHaveLength(0);
  });
});
