import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import {
  Card,
  ExternalSelect,
  Modal,
  NotImplementedError,
  NumberInput,
  RadioSelect,
  Select,
  SelectOption,
  TextInput,
} from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatwootAdapter } from "./adapter";
import { decodeActionValue, encodeActionValue } from "./cards";
import { createChatwootAdapter } from "./factory";
import { triggerIdOf } from "./modals";
import type { ChatwootAdapterConfig } from "./types";
import {
  ACCOUNT,
  AGENT_PUSH,
  AGENT_WEBHOOK,
  CONTACT_PUSH,
  CONVERSATION,
  restConversation,
  createChatRecorder,
  restMessage,
  signRequest,
  createWaitUntilTracker,
  stubFetch,
  webhookMessage,
  type RecordedRequest,
} from "./test-utils";

const BASE_URL = "https://chat.example.com";
const SECRET = "s3cret";
const THREAD_ID = "chatwoot:10:20:300";

function createAdapter(overrides: Partial<ChatwootAdapterConfig> = {}) {
  return new ChatwootAdapter({
    baseUrl: BASE_URL,
    accessToken: "test-token",
    accountId: 2,
    ...overrides,
  });
}

const originalFetch = globalThis.fetch;

const PROFILE = { id: 7, name: "Grace Hopper", available_name: "Grace" };
/** Chatwoot answers 401, not 403, when an agent bot reaches an agent-only route. */
const BOT_REFUSAL = () =>
  new Response(
    JSON.stringify({
      error: "Access to this endpoint is not authorized for bots",
    }),
    { status: 401 },
  );
/** A Chatwoot that never answers, until the request is aborted. */
const hang = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
  )) as typeof fetch;

/** Any request a test did not stub is a bug, not a call to the real Chatwoot. */
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`Unstubbed request to ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function initialized(overrides: Partial<ChatwootAdapterConfig> = {}) {
  const adapter = createAdapter({ webhookSecret: SECRET, ...overrides });
  const recorder = createChatRecorder();
  const tracker = createWaitUntilTracker();
  stubFetch(() => PROFILE);
  await adapter.initialize(recorder.chat);

  /** Deliver a signed webhook and await the work it defers. */
  const deliver = async (payload: unknown) => {
    await adapter.handleWebhook(signRequest(payload, SECRET), tracker.options);
    await tracker.settled();
  };

  return { adapter, recorder, tracker, deliver };
}

describe("createChatwootAdapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("creates adapter from explicit config", () => {
    const adapter = createChatwootAdapter({
      baseUrl: BASE_URL,
      accessToken: "explicit-token",
      accountId: 2,
    });

    expect(adapter.name).toBe("chatwoot");
    expect(adapter.accountId).toBe(2);
  });

  it("reads environment variables as fallback", () => {
    process.env.CHATWOOT_BASE_URL = BASE_URL;
    process.env.CHATWOOT_ACCESS_TOKEN = "env-token";
    process.env.CHATWOOT_ACCOUNT_ID = "7";

    const adapter = createChatwootAdapter();
    expect(adapter.accountId).toBe(7);
  });

  it("throws when the access token is missing", () => {
    delete process.env.CHATWOOT_ACCESS_TOKEN;
    expect(() => createChatwootAdapter({ accountId: 2 })).toThrow(
      "access token",
    );
  });

  it("throws when the account ID is missing", () => {
    delete process.env.CHATWOOT_ACCOUNT_ID;
    expect(() => createChatwootAdapter({ accessToken: "tok" })).toThrow(
      "account ID",
    );
  });

  it("rejects an adapter name containing a colon", () => {
    expect(() => createAdapter({ adapterName: "chat:woot" })).toThrow(
      ValidationError,
    );
  });
});

describe("thread IDs", () => {
  it("roundtrips inbox, contact and conversation", () => {
    const adapter = createAdapter();
    const encoded = adapter.encodeThreadId({
      inboxId: 10,
      contactId: 20,
      conversationId: 300,
    });

    expect(encoded).toBe(THREAD_ID);
    expect(adapter.decodeThreadId(encoded)).toEqual({
      inboxId: 10,
      contactId: 20,
      conversationId: 300,
    });
  });

  it("uses the configured adapter name as the prefix", () => {
    const adapter = createAdapter({ adapterName: "chatwoot-sales" });
    const encoded = adapter.encodeThreadId({
      inboxId: 1,
      contactId: 2,
      conversationId: 3,
    });

    expect(encoded).toBe("chatwoot-sales:1:2:3");
    expect(adapter.decodeThreadId(encoded).conversationId).toBe(3);
    expect(() => adapter.decodeThreadId(THREAD_ID)).toThrow(ValidationError);
  });

  it("rejects malformed thread IDs", () => {
    const adapter = createAdapter();
    for (const threadId of [
      "invalid",
      "chatwoot:10:20:abc",
      "chatwoot::20:300",
      "chatwoot:10:20:",
      "chatwoot:1.5:20:300",
      "chatwoot:-1:20:300",
      "chatwoot:10:20:0",
      "chatwoot:10:20:300:4",
      "slack:C123:ts",
    ])
      expect(() => adapter.decodeThreadId(threadId)).toThrow(ValidationError);
    expect(adapter.decodeThreadId("chatwoot:10:0:300").contactId).toBe(0);
  });

  it("derives the channel ID from the inbox", () => {
    expect(createAdapter().channelIdFromThreadId(THREAD_ID)).toBe(
      "chatwoot:10",
    );
  });

  it("treats every conversation as a direct message", () => {
    expect(createAdapter().isDM()).toBe(true);
  });
});

describe("handleWebhook", () => {
  it("returns 401 when the signature header is missing", async () => {
    const adapter = createAdapter({ webhookSecret: SECRET });
    const response = await adapter.handleWebhook(signRequest(webhookMessage()));

    expect(response.status).toBe(401);
  });

  it("returns 401 when the signature is invalid", async () => {
    const adapter = createAdapter({ webhookSecret: SECRET });
    const response = await adapter.handleWebhook(
      signRequest(webhookMessage(), "wrong-secret"),
    );

    expect(response.status).toBe(401);
  });

  it("returns 200 for a correctly signed request", async () => {
    const adapter = createAdapter({ webhookSecret: SECRET });
    const response = await adapter.handleWebhook(
      signRequest(webhookMessage(), SECRET),
    );

    expect(response.status).toBe(200);
  });

  it("verifies against any secret, since every webhook source signs with its own", async () => {
    const adapter = createAdapter({ webhookSecret: ["account", "inbox"] });

    for (const [secret, status] of [
      ["account", 200],
      ["inbox", 200],
      ["agent-bot", 401],
    ] as const)
      expect(
        (await adapter.handleWebhook(signRequest(webhookMessage(), secret)))
          .status,
      ).toBe(status);
  });

  it("refuses a secret list with an empty entry, which would accept any signature", () => {
    expect(() => createAdapter({ webhookSecret: ["account", ""] })).toThrow(
      ValidationError,
    );
  });

  it("refuses a correctly signed request replayed past the tolerance", async () => {
    const adapter = createAdapter({ webhookSecret: SECRET });
    const now = Math.floor(Date.now() / 1000);

    const stale = await adapter.handleWebhook(
      signRequest(webhookMessage(), SECRET, String(now - 301)),
    );
    const recent = await adapter.handleWebhook(
      signRequest(webhookMessage(), SECRET, String(now - 299)),
    );

    expect(stale.status).toBe(401);
    expect(recent.status).toBe(200);
  });

  it("refuses an oversized body, and an unsigned one before reading it", async () => {
    const adapter = createAdapter({ webhookSecret: SECRET, maxBodyBytes: 64 });
    const large = webhookMessage({ content: "x".repeat(100) });

    expect(
      (await adapter.handleWebhook(signRequest(large, SECRET))).status,
    ).toBe(413);
    expect((await adapter.handleWebhook(signRequest(large))).status).toBe(401);
  });

  it("refuses every webhook while no secret is set, unless unverified ones are allowed", async () => {
    expect(
      (await createAdapter().handleWebhook(signRequest(webhookMessage())))
        .status,
    ).toBe(401);
    expect(
      (
        await createAdapter({ allowUnverifiedWebhooks: true }).handleWebhook(
          signRequest(webhookMessage()),
        )
      ).status,
    ).toBe(200);
  });

  it("returns 400 for a body that is not JSON", async () => {
    const adapter = createAdapter({ allowUnverifiedWebhooks: true });
    const request = new Request("https://bot.example.com/webhooks/chatwoot", {
      method: "POST",
      body: "not json",
    });

    expect((await adapter.handleWebhook(request)).status).toBe(400);
  });

  it("returns 400 for a payload the schema rejects", async () => {
    const adapter = createAdapter({ webhookSecret: SECRET });
    const response = await adapter.handleWebhook(
      signRequest({ event: "message_created" }, SECRET),
    );

    expect(response.status).toBe(400);
  });

  it("acknowledges an event a newer Chatwoot added, and leaves it alone", async () => {
    const seen: string[] = [];
    const adapter = createAdapter({
      webhookSecret: SECRET,
      onEvent: (payload) => void seen.push(payload.event),
    });
    const response = await adapter.handleWebhook(
      signRequest({ event: "conversation_archived", id: 300 }, SECRET),
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("ignores a message from another account, which it would answer in this one", async () => {
    const seen: string[] = [];
    const { recorder, deliver } = await initialized({
      onEvent: (payload) => void seen.push(payload.event),
    });

    await deliver(webhookMessage({ account: { id: 3, name: "Other" } }));
    await deliver(webhookMessage({ id: 3043, account: undefined }));

    expect(recorder.messages).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it("ignores any other event from another account, a typing event's through its conversation", async () => {
    const seen: string[] = [];
    const { deliver } = await initialized({
      onEvent: (payload) => void seen.push(payload.event),
    });
    const other = { id: 3, name: "Other" };

    await deliver({
      event: "conversation_resolved",
      ...CONVERSATION,
      account: other,
    });
    await deliver({
      event: "conversation_typing_on",
      conversation: { ...CONVERSATION, account: other },
      user: AGENT_PUSH,
    });
    await deliver({
      event: "conversation_resolved",
      ...CONVERSATION,
      account: ACCOUNT,
    });
    await deliver({ event: "conversation_opened", ...CONVERSATION });

    expect(seen).toEqual(["conversation_resolved", "conversation_opened"]);
  });

  it("handles a payload once, though the account webhook and an API inbox both deliver it", async () => {
    const seen: string[] = [];
    const { deliver } = await initialized({
      onEvent: (payload) => void seen.push(payload.event),
    });
    const resolved = { event: "conversation_resolved", ...CONVERSATION };

    await deliver(resolved);
    await deliver(resolved);
    await deliver({ ...resolved, status: "resolved" });

    expect(seen).toEqual(["conversation_resolved", "conversation_resolved"]);
  });

  it("delivers message_created to processMessage with the derived thread ID", async () => {
    const { recorder, deliver } = await initialized();

    await deliver(webhookMessage());

    expect(recorder.messages).toHaveLength(1);
    const [{ threadId, message }] = recorder.messages;
    expect(threadId).toBe(THREAD_ID);
    expect(message.text).toBe("Hi there");
    expect(message.author).toMatchObject({
      userId: "20",
      fullName: "Ada Lovelace",
      isBot: false,
      isMe: false,
    });
  });

  it("marks the authenticated agent's own messages as isMe and isBot", async () => {
    const { adapter, recorder, deliver } = await initialized({
      receiveAgentMessages: true,
    });

    await deliver(
      webhookMessage({ message_type: "outgoing", sender: AGENT_WEBHOOK }),
    );

    // Chatwoot calls an agent token a `user`, but to Chat SDK this runtime is a
    // bot, and its own sent messages read `isBot: true, isMe: true`.
    expect(recorder.messages[0].message.author).toMatchObject({
      isMe: true,
      isBot: true,
    });
    expect(adapter.userName).toBe("Grace");
  });

  it("hands the handlers only the contact's messages, unless agents' replies or private notes are opted in", async () => {
    const colleague = { id: 99, name: "Alan Turing", type: "user" };
    const reply = webhookMessage({
      message_type: "outgoing",
      sender: colleague,
    });
    const note = webhookMessage({
      id: 3099,
      message_type: "outgoing",
      private: true,
      sender: colleague,
    });
    const received = async (overrides: Partial<ChatwootAdapterConfig>) => {
      const { recorder, deliver } = await initialized(overrides);
      await deliver(reply);
      await deliver(note);
      return recorder.messages.map(({ message }) => [
        message.author.isMe,
        message.author.isBot,
        message.raw.private,
      ]);
    };

    // `isMe` means "sent by this runtime", never "sent by my account", so an
    // opted-in colleague reads as someone else.
    expect(await received({})).toEqual([]);
    expect(await received({ receiveAgentMessages: true })).toEqual([
      [false, false, false],
    ]);
    expect(await received({ receivePrivateNotes: true })).toEqual([
      [false, false, true],
    ]);
  });

  it("does not mistake another account entity that shares the agent's ID", async () => {
    const { recorder, deliver } = await initialized({
      receiveAgentMessages: true,
    });

    await deliver(
      webhookMessage({
        message_type: "outgoing",
        sender: { id: 7, name: "Captain", type: "captain_assistant" },
      }),
    );

    expect(recorder.messages[0].message.author).toMatchObject({
      isMe: false,
      isBot: true,
    });
  });

  it("reports a deleted message through processMessageDeleted", async () => {
    const { adapter, recorder } = await initialized();
    const tracker = createWaitUntilTracker();

    await adapter.handleWebhook(
      signRequest(
        webhookMessage({
          event: "message_updated",
          content: "This message was deleted",
          content_attributes: { deleted: true },
        }),
        SECRET,
      ),
      tracker.options,
    );
    await tracker.settled();

    expect(recorder.deletes).toEqual([
      { threadId: THREAD_ID, messageId: "3042" },
    ]);
    expect(recorder.updates).toHaveLength(0);
  });

  it("reports an edited message through processMessageUpdated", async () => {
    const { recorder, deliver } = await initialized();

    await deliver(webhookMessage());
    await deliver(
      webhookMessage({ event: "message_updated", content: "Hi there, again" }),
    );

    expect(recorder.updates).toHaveLength(1);
    expect(recorder.updates[0].message.metadata.edited).toBe(true);
  });

  it("reads an update delivered before its message as no edit, since Chatwoot does not keep order", async () => {
    const { recorder, deliver } = await initialized();

    await deliver(
      webhookMessage({ event: "message_updated", source_id: "wamid.1" }),
    );
    await deliver(webhookMessage());
    await deliver(
      webhookMessage({ event: "message_updated", content: "Hi there!" }),
    );

    expect(recorder.messages).toHaveLength(1);
    expect(recorder.updates.map((update) => update.message.text)).toEqual([
      "Hi there!",
    ]);
  });

  it("does not report a delivery-status update as an edit", async () => {
    const { recorder, deliver } = await initialized();

    await deliver(webhookMessage());
    await deliver(webhookMessage({ event: "message_updated", status: "read" }));

    expect(recorder.messages).toHaveLength(1);
    expect(recorder.updates).toHaveLength(0);
  });

  it("reports an edit that follows a delivery-status update", async () => {
    const { recorder, deliver } = await initialized();

    await deliver(webhookMessage());
    await deliver(webhookMessage({ event: "message_updated", status: "read" }));
    await deliver(
      webhookMessage({ event: "message_updated", content: "Hi there!" }),
    );

    expect(recorder.updates).toHaveLength(1);
    expect(recorder.updates[0].message.text).toBe("Hi there!");
  });

  it("reports an edit back to content the message held before", async () => {
    const { recorder, deliver } = await initialized();

    await deliver(webhookMessage());
    await deliver(
      webhookMessage({ event: "message_updated", content: "Hi there, again" }),
    );
    await deliver(webhookMessage({ event: "message_updated" }));

    expect(recorder.updates.map((update) => update.message.text)).toEqual([
      "Hi there, again",
      "Hi there",
    ]);
  });

  it("reports a delete once, however often Chatwoot resends the flag", async () => {
    const { recorder, deliver } = await initialized();
    const deleted = webhookMessage({
      event: "message_updated",
      content: "This message was deleted",
      content_attributes: { deleted: true },
    });

    await deliver(deleted);
    await deliver(deleted);
    await deliver({
      ...deleted,
      conversation: { ...CONVERSATION, updated_at: 1777456900.5 },
    });

    expect(recorder.deletes).toHaveLength(1);
  });

  const card = Card({
    title: "Order 42",
    children: [
      {
        type: "actions",
        children: [
          { type: "button", id: "approve", label: "Approve", value: "42" },
          { type: "button", id: "reject", label: "Reject", value: "42" },
        ],
      },
    ],
  });

  async function withCard() {
    const context = await initialized();
    stubFetch(() => restMessage({ id: 3050, content_type: "input_select" }));
    await context.adapter.postMessage(THREAD_ID, card);
    return context;
  }

  describe("a pick another channel sends as a message", () => {
    it("reads WhatsApp's reply, the option's title quoting the card", async () => {
      const { recorder, deliver } = await withCard();

      await deliver(
        webhookMessage({
          id: 3051,
          content: "Approve",
          content_attributes: { in_reply_to: 3050 },
        }),
      );

      expect(recorder.actions).toEqual([
        {
          actionId: "approve",
          value: "42",
          threadId: THREAD_ID,
          triggerId: triggerIdOf(THREAD_ID, "20"),
          userId: "20",
        },
      ]);
      expect(recorder.messages).toHaveLength(0);
    });

    it("reads Telegram's and LINE's, the option's value with no quote", async () => {
      const { recorder, deliver } = await withCard();

      await deliver(
        webhookMessage({
          id: 3052,
          content: encodeActionValue("reject", "42"),
        }),
      );

      expect(recorder.actions).toMatchObject([{ actionId: "reject" }]);
    });

    it("reads Facebook's, the title alone, whatever its case", async () => {
      const { recorder, deliver } = await withCard();

      await deliver(webhookMessage({ id: 3053, content: " approve " }));

      expect(recorder.actions).toMatchObject([{ actionId: "approve" }]);
    });

    it("leaves anything else a message, and fires a pick once however often it is resent", async () => {
      const { recorder, deliver } = await withCard();

      await deliver(webhookMessage({ id: 3054, content: "Approve it please" }));
      await deliver(webhookMessage({ id: 3055, content: "Approve" }));
      await deliver(webhookMessage({ id: 3055, content: "Approve" }));

      expect(recorder.messages.map(({ message }) => message.text)).toEqual([
        "Approve it please",
      ]);
      expect(recorder.actions).toHaveLength(1);
    });

    it("answers no card the bot only noted privately, which goes without its options", async () => {
      const { adapter, recorder, deliver } = await initialized();
      const requests = stubFetch(() => restMessage({ id: 3060 }));
      await adapter.postPrivateNote(THREAD_ID, card);

      await deliver(webhookMessage({ id: 3061, content: "Approve" }));
      await deliver(
        webhookMessage({
          id: 3062,
          content: "Approve",
          content_attributes: { in_reply_to: 3060 },
        }),
      );

      expect(requests[0].body).toMatchObject({
        private: true,
        content_type: "text",
      });
      expect(requests[0].body).not.toHaveProperty("content_attributes");
      expect(recorder.actions).toHaveLength(0);
      expect(recorder.messages).toHaveLength(2);
    });

    it("answers no card from another conversation, quoted or latest", async () => {
      const { recorder, deliver } = await withCard();
      const elsewhere = { ...CONVERSATION, id: 301 };

      await deliver(
        webhookMessage({
          id: 3063,
          content: "Approve",
          content_attributes: { in_reply_to: 3050 },
          conversation: elsewhere,
        }),
      );
      await deliver(
        webhookMessage({
          id: 3064,
          content: "Approve",
          conversation: elsewhere,
        }),
      );

      expect(recorder.actions).toHaveLength(0);
      expect(recorder.messages).toHaveLength(2);
    });

    it("answers no card another account sent, though both share the state and the conversation number", async () => {
      const { recorder } = await withCard();
      const other = createAdapter({ accountId: 3, webhookSecret: SECRET });
      const tracker = createWaitUntilTracker();
      stubFetch(() => PROFILE);
      await other.initialize(recorder.chat);

      await other.handleWebhook(
        signRequest(
          webhookMessage({
            id: 3065,
            content: "Approve",
            account: { id: 3, name: "Other" },
          }),
          SECRET,
        ),
        tracker.options,
      );
      await tracker.settled();

      expect(recorder.actions).toHaveLength(0);
      expect(recorder.messages).toHaveLength(1);
    });
  });

  /** The web widget's report of a pick, patched onto the card `withCard` sent. */
  const answered = (value: string) =>
    webhookMessage({
      event: "message_updated",
      id: 3050,
      message_type: "outgoing",
      content_type: "input_select",
      sender: AGENT_PUSH,
      content_attributes: {
        items: [
          { title: "Approve", value: encodeActionValue("approve", "42") },
          { title: "Reject", value: encodeActionValue("reject", "42") },
        ],
        submitted_values: [{ title: "Approve", value }],
      },
    });

  it("turns an answered input_select into an action", async () => {
    const { recorder, deliver } = await withCard();

    await deliver(answered(encodeActionValue("approve", "42")));

    expect(recorder.actions).toEqual([
      {
        actionId: "approve",
        value: "42",
        threadId: THREAD_ID,
        triggerId: triggerIdOf(THREAD_ID, "20"),
        userId: "20",
      },
    ]);
    expect(recorder.updates).toHaveLength(0);
  });

  it("fires an answered select only once, however often Chatwoot resends it", async () => {
    const { recorder, deliver } = await withCard();
    const pick = answered(encodeActionValue("approve", "42"));

    await deliver(pick);
    await deliver(pick);
    await deliver({
      ...pick,
      conversation: { ...CONVERSATION, updated_at: 1777456900.5 },
    });

    expect(recorder.actions).toHaveLength(1);
  });

  it("takes no value the card did not offer, nor a pick on a card it did not send", async () => {
    const { recorder, deliver } = await withCard();

    // A contact can patch `submitted_values` through Chatwoot's public API.
    await deliver(answered(encodeActionValue("refund", "9999")));
    await deliver({
      ...answered(encodeActionValue("approve", "42")),
      id: 4000,
    });

    expect(recorder.actions).toHaveLength(0);
  });

  it("registers the message and the onEvent hook with waitUntil", async () => {
    const tasks: Promise<unknown>[] = [];
    const { adapter, recorder } = await initialized({
      onEvent: () => undefined,
    });

    await adapter.handleWebhook(signRequest(webhookMessage(), SECRET), {
      waitUntil: (task) => void tasks.push(task),
    });
    await Promise.all(tasks);

    expect(tasks).toHaveLength(2);
    expect(recorder.messages).toHaveLength(1);
  });

  it("still answers 200 and notifies onEvent before initialize", async () => {
    const seen: string[] = [];
    const adapter = createAdapter({
      webhookSecret: SECRET,
      onEvent: (payload) => void seen.push(payload.event),
    });

    const response = await adapter.handleWebhook(
      signRequest(webhookMessage(), SECRET),
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual(["message_created"]);
  });

  it("hands every verified event to onEvent", async () => {
    const seen: string[] = [];
    const { adapter } = await initialized({
      onEvent: (payload) => void seen.push(payload.event),
    });

    await adapter.handleWebhook(signRequest(webhookMessage(), SECRET));
    await adapter.handleWebhook(
      signRequest({ event: "conversation_resolved", ...CONVERSATION }, SECRET),
    );

    expect(seen).toEqual(["message_created", "conversation_resolved"]);
  });
});

describe("slash commands and modals", () => {
  const trigger = triggerIdOf(THREAD_ID, "20");
  /** A Chatwoot whose conversation sits in an inbox of `channel`, answering every post. */
  const serve = (channel = "Channel::Api") =>
    stubFetch((request) =>
      request.url.endsWith("/conversations/300")
        ? restConversation({ meta: { sender: CONTACT_PUSH, channel } })
        : restMessage({ id: 3200 }),
    );
  const lastPosted = (requests: RecordedRequest[]) =>
    (
      requests.filter(({ method }) => method === "POST").at(-1)!.body as {
        content: string;
      }
    ).content;

  it("turns a declared command into onSlashCommand, and leaves any other / text a message", async () => {
    const { recorder, deliver } = await initialized({
      slashCommands: ["/help"],
    });

    await deliver(webhookMessage({ id: 3101, content: "/HELP billing  " }));
    await deliver(webhookMessage({ id: 3102, content: "/other thing" }));

    expect(recorder.commands).toEqual([
      {
        command: "/help",
        text: "billing",
        channelId: THREAD_ID,
        triggerId: trigger,
        userId: "20",
      },
    ]);
    expect(recorder.messages.map(({ message }) => message.text)).toEqual([
      "/other thing",
    ]);
  });

  it("asks a modal's fields in turn, even in the widget when a field cannot be native, and submits the answers", async () => {
    const { adapter, recorder, deliver } = await initialized();
    const requests = serve("Channel::WebWidget");
    await adapter.openModal(
      trigger,
      Modal({
        callbackId: "booking",
        title: "Booking",
        children: [
          TextInput({ id: "name", label: "Name" }),
          NumberInput({ id: "guests", label: "Guests", min: 1, max: 8 }),
          Select({
            id: "day",
            label: "Day",
            options: [
              SelectOption({ label: "Mon", value: "mon" }),
              SelectOption({ label: "Tue", value: "tue" }),
            ],
          }),
          TextInput({ id: "note", label: "Note", optional: true }),
        ],
      }),
      "ctx",
    );
    expect(lastPosted(requests)).toBe(
      "**Booking**\n\n_Send **cancel** to stop._\n\n**Name**",
    );

    for (const [id, content, asked] of [
      [3111, "Iván", "**Guests**"],
      [3112, "20", "That doesn't fit"],
      [3113, "3", "1. Mon\n2. Tue"],
      [3114, "2", "Send **skip**"],
    ] as const) {
      await deliver(webhookMessage({ id, content }));
      expect(lastPosted(requests)).toContain(asked);
    }
    await deliver(webhookMessage({ id: 3115, content: "skip" }));

    expect(recorder.submits).toEqual([
      {
        callbackId: "booking",
        values: { name: "Iván", guests: "3", day: "tue" },
        contextId: "ctx",
      },
    ]);
    expect(recorder.messages).toHaveLength(0);
  });

  it("asks again for the fields the handler rejects, and opens the modal it pushes", async () => {
    const { adapter, recorder, deliver } = await initialized();
    const requests = serve();
    recorder.responses.push(
      { action: "errors", errors: { email: "That address bounced." } },
      {
        action: "push",
        modal: Modal({
          callbackId: "next",
          title: "Step 2",
          children: [TextInput({ id: "city", label: "City" })],
        }),
      },
    );
    await adapter.openModal(
      trigger,
      Modal({
        callbackId: "signup",
        title: "Sign up",
        children: [
          TextInput({ id: "name", label: "Name" }),
          TextInput({ id: "email", label: "Email" }),
        ],
      }),
    );

    await deliver(webhookMessage({ id: 3121, content: "Ana" }));
    await deliver(webhookMessage({ id: 3122, content: "ana@bad" }));
    expect(lastPosted(requests)).toBe("That address bounced.\n\n**Email**");
    await deliver(webhookMessage({ id: 3123, content: "ana@good.com" }));
    expect(lastPosted(requests)).toContain("**Step 2**");
    await deliver(webhookMessage({ id: 3124, content: "Bogotá" }));

    expect(recorder.submits.map(({ values }) => values)).toEqual([
      { name: "Ana", email: "ana@bad" },
      { name: "Ana", email: "ana@good.com" },
      { city: "Bogotá" },
    ]);
  });

  it("searches an external select through onOptionsLoad, then takes a pick", async () => {
    const { adapter, recorder, deliver } = await initialized();
    const requests = serve();
    recorder.found = [
      { label: "Bogotá", value: "bog" },
      { label: "Boston", value: "bos" },
    ];
    await adapter.openModal(
      trigger,
      Modal({
        callbackId: "city",
        title: "Where",
        children: [ExternalSelect({ id: "city", label: "City" })],
      }),
    );

    await deliver(webhookMessage({ id: 3131, content: "bo" }));
    expect(lastPosted(requests)).toContain("1. Bogotá\n2. Boston");
    await deliver(webhookMessage({ id: 3132, content: "2" }));

    expect(recorder.searches).toEqual([{ actionId: "city", query: "bo" }]);
    expect(recorder.submits[0]?.values).toEqual({ city: "bos" });
  });

  it("stops on cancel, telling onModalClose when the modal asks to be told", async () => {
    const { adapter, recorder, deliver } = await initialized();
    const requests = serve();
    await adapter.openModal(
      trigger,
      Modal({
        callbackId: "survey",
        title: "Survey",
        notifyOnClose: true,
        children: [
          RadioSelect({
            id: "score",
            label: "Score",
            options: [SelectOption({ label: "Good", value: "good" })],
          }),
        ],
      }),
      "ctx",
    );

    await deliver(webhookMessage({ id: 3141, content: "Cancel" }));
    expect(lastPosted(requests)).toBe("Cancelled.");
    await deliver(webhookMessage({ id: 3142, content: "after" }));

    expect(recorder.closes).toEqual([
      { callbackId: "survey", contextId: "ctx" },
    ]);
    expect(recorder.messages.map(({ message }) => message.text)).toEqual([
      "after",
    ]);
  });

  it("speaks the language it is given, and refuses a trigger it never issued", async () => {
    const { adapter } = await initialized({
      modalTexts: { cancelHint: "Envía **cancelar** para parar." },
    });
    const requests = serve();
    await adapter.openModal(
      trigger,
      Modal({
        callbackId: "x",
        title: "T",
        children: [TextInput({ id: "a", label: "A", maxLength: 9 })],
      }),
    );

    expect(lastPosted(requests)).toContain("_Envía **cancelar** para parar._");
    await expect(
      adapter.openModal("forged", Modal({ callbackId: "x", title: "T" })),
    ).rejects.toThrow("Not a trigger");
  });

  it("shows a website widget a native form, and submits only what it offered", async () => {
    const { adapter, recorder, deliver } = await initialized();
    const requests = serve("Channel::WebWidget");
    await adapter.openModal(
      trigger,
      Modal({
        callbackId: "order",
        title: "Order",
        submitLabel: "Send",
        children: [
          TextInput({ id: "name", label: "Name", placeholder: "Ada" }),
          TextInput({ id: "notes", label: "Notes", multiline: true }),
          Select({
            id: "size",
            label: "Size",
            initialOption: "s",
            options: [
              SelectOption({ label: "Small", value: "s" }),
              SelectOption({ label: "Large", value: "l" }),
            ],
          }),
        ],
      }),
      "ctx",
    );
    expect(requests.at(-1)!.body).toEqual({
      content: "**Order**",
      message_type: "outgoing",
      content_type: "form",
      content_attributes: {
        button_label: "Send",
        items: [
          { type: "text", name: "name", label: "Name", placeholder: "Ada" },
          { type: "text_area", name: "notes", label: "Notes" },
          {
            type: "select",
            name: "size",
            label: "Size",
            default: "s",
            options: [
              { label: "Small", value: "s" },
              { label: "Large", value: "l" },
            ],
          },
        ],
      },
    });
    const submitted = (id: number, size: string) =>
      webhookMessage({
        event: "message_updated",
        id,
        message_type: "outgoing",
        content_type: "form",
        sender: AGENT_PUSH,
        content_attributes: {
          submitted_values: [
            { name: "name", value: "Ada" },
            { name: "notes", value: "Hi" },
            { name: "size", value: size },
          ],
        },
      });

    await deliver(webhookMessage({ id: 3151, content: "hello" }));
    await deliver(submitted(3200, "xl"));
    await deliver(submitted(4000, "l"));
    await deliver(submitted(3200, "l"));

    expect(recorder.submits).toEqual([
      {
        callbackId: "order",
        values: { name: "Ada", notes: "Hi", size: "l" },
        contextId: "ctx",
      },
    ]);
    expect(recorder.messages.map(({ message }) => message.text)).toEqual([
      "hello",
    ]);
  });
});

describe("parseMessage", () => {
  it("parses a REST payload with the thread ID supplied", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(restMessage() as never, THREAD_ID);

    expect(message.id).toBe("3043");
    expect(message.threadId).toBe(THREAD_ID);
    expect(message.metadata.dateSent.toISOString()).toBe(
      "2026-04-29T10:01:00.000Z",
    );
    expect(message.author.userName).toBe("Grace");
  });

  it("normalises an unvalidated payload, whichever shape it arrives in", () => {
    const adapter = createAdapter();
    const rest = adapter.parseMessage(restMessage() as never, THREAD_ID);
    const webhook = adapter.parseMessage(webhookMessage() as never);

    expect(rest.raw.message_type).toBe("outgoing");
    expect(webhook.raw.message_type).toBe("incoming");
    expect(webhook.threadId).toBe(THREAD_ID);
  });

  it("rejects a payload that is not a Chatwoot message", () => {
    expect(() => createAdapter().parseMessage({ nope: true } as never)).toThrow(
      /parseMessage/,
    );
  });

  it("strips markdown for text and keeps it in formatted", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      webhookMessage({
        content: "**bold** and [@Bruce](mention://user/30/Bruce)",
      }) as never,
    );

    expect(message.text).toBe("bold and @Bruce");
    expect(adapter.renderFormatted(message.formatted)).toContain("**bold**");
  });

  it("collects links found in the content", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      webhookMessage({ content: "see https://example.com/docs" }) as never,
    );

    expect(message.links.map((link) => link.url)).toEqual([
      "https://example.com/docs",
    ]);
  });

  it("maps attachments onto downloadable Attachment objects", async () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      webhookMessage({
        content: "",
        attachments: [
          {
            id: 5,
            message_id: 3042,
            account_id: 2,
            file_type: "image",
            extension: "png",
            content_type: "image/png",
            data_url: `${BASE_URL}/rails/active_storage/blobs/abc/cat.png`,
            thumb_url: "",
            file_size: 2048,
            width: 64,
            height: 48,
          },
        ],
      }) as never,
    );

    const [attachment] = message.attachments;
    expect(attachment).toMatchObject({
      type: "image",
      mimeType: "image/png",
      size: 2048,
      width: 64,
      height: 48,
      name: "cat.png",
    });

    stubFetch(() => new Response("binary", { status: 200 }));
    expect((await attachment.fetchData!()).toString()).toBe("binary");
  });

  it("survives a data_url Chatwoot never percent-decoded", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      webhookMessage({
        content: "",
        attachments: [
          {
            id: 8,
            message_id: 3042,
            account_id: 2,
            file_type: "file",
            data_url: `${BASE_URL}/files/100%invoice.pdf`,
          },
        ],
      }) as never,
    );

    expect(message.attachments[0].name).toBe("100%invoice.pdf");
  });

  it("leaves an attachment without a URL undownloadable", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      webhookMessage({
        content: "",
        attachments: [
          {
            id: 7,
            message_id: 3042,
            account_id: 2,
            file_type: "location",
            coordinates_lat: 1.5,
            coordinates_long: -2.5,
            fallback_title: "Office",
            data_url: null,
          },
        ],
      }) as never,
    );

    expect(message.attachments[0]).toEqual({ type: "file", name: "Office" });
  });

  it("reads a transcribed voice note and a shared location as the text of a message without content", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      webhookMessage({
        content: null,
        attachments: [
          {
            id: 9,
            file_type: "audio",
            data_url: `${BASE_URL}/rails/active_storage/blobs/v/note.ogg`,
            transcribed_text: "Where is my order?",
          },
          {
            id: 10,
            file_type: "location",
            coordinates_lat: 1.5,
            coordinates_long: -2.5,
            fallback_title: "Office",
            data_url: null,
          },
        ],
      }) as never,
    );

    expect(message.text).toBe(
      "Where is my order?\n\nLocation: Office (1.5, -2.5)",
    );
    expect(message.attachments.map((attachment) => attachment.type)).toEqual([
      "audio",
      "file",
    ]);
  });

  it("sends the access token to ActiveStorage only, and a redirect off Chatwoot through the SSRF guard", async () => {
    const adapter = createAdapter();
    const tokens: (string | undefined)[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      tokens.push(
        (init?.headers as Record<string, string> | undefined)?.api_access_token,
      );
      return String(input).includes("/rails/active_storage/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://169.254.169.254/latest/meta-data" },
          })
        : new Response("{}", { status: 401 });
    }) as typeof fetch;
    const download = (url: string) =>
      adapter.rehydrateAttachment({ type: "file", fetchMetadata: { url } })
        .fetchData!();

    await expect(
      download(`${BASE_URL}/rails/active_storage/blobs/x/cat.png`),
    ).rejects.toThrow(NetworkError);
    await expect(
      download(`${BASE_URL}/api/v1/accounts/2/contacts`),
    ).rejects.toThrow(NetworkError);
    expect(tokens).toEqual(["test-token", undefined]);
  });

  it("bounds a download from Chatwoot in time and size", async () => {
    const adapter = createAdapter({ timeoutMs: 10 });
    const download = () =>
      adapter.rehydrateAttachment({
        type: "file",
        fetchMetadata: { url: `${BASE_URL}/rails/active_storage/blobs/x/a` },
      }).fetchData!();

    globalThis.fetch = hang;
    await expect(download()).rejects.toThrow(NetworkError);

    stubFetch(
      () =>
        new Response("x", {
          headers: { "content-length": String(41 * 1024 * 1024) },
        }),
    );
    await expect(download()).rejects.toThrow(/download limit/);
  });

  it("rebuilds fetchData when an attachment is rehydrated", async () => {
    const adapter = createAdapter();
    const rehydrated = adapter.rehydrateAttachment({
      type: "file",
      fetchMetadata: { url: `${BASE_URL}/x.pdf` },
    });

    stubFetch(() => new Response("pdf", { status: 200 }));
    expect((await rehydrated.fetchData!()).toString()).toBe("pdf");
  });

  it("flags activity messages as system messages", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      restMessage({ message_type: 2, sender: null }) as never,
      THREAD_ID,
    );

    expect(message.author.isSystem).toBe(true);
    expect(message.author.isBot).toBe("unknown");
  });

  it("flags an activity message that does carry a sender", () => {
    const adapter = createAdapter();
    const message = adapter.parseMessage(
      restMessage({ message_type: 2, sender: AGENT_PUSH }) as never,
      THREAD_ID,
    );

    expect(message.author).toMatchObject({ isSystem: true, userId: "7" });
  });
});

describe("postMessage", () => {
  it("posts outgoing text content", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());
    const sent = await adapter.postMessage(THREAD_ID, "Hello");

    expect(requests[0].url).toBe(
      `${BASE_URL}/api/v1/accounts/2/conversations/300/messages`,
    );
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toEqual({
      content: "Hello",
      message_type: "outgoing",
      private: false,
      content_type: "text",
    });
    expect(sent.id).toBe("3043");
    expect(sent.threadId).toBe(THREAD_ID);
  });

  it("renders a card's buttons as input_select items", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    await adapter.postMessage(
      THREAD_ID,
      Card({
        title: "Order 42",
        children: [
          { type: "text", content: "Approve this order?" },
          {
            type: "actions",
            children: [
              { type: "button", id: "approve", label: "Approve", value: "42" },
              {
                type: "link-button",
                label: "Open",
                url: "https://example.com/42",
              },
            ],
          },
        ],
      }),
    );

    const body = requests[0].body as Record<string, unknown>;
    expect(body.content_type).toBe("input_select");
    expect(body.content_attributes).toEqual({
      items: [{ title: "Approve", value: "approve\n42" }],
    });
    expect(body.content).toContain("**Order 42**");
    expect(body.content).toContain("[Open](https://example.com/42)");
  });

  it("uploads files as multipart attachments", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    await adapter.postMessage(THREAD_ID, {
      markdown: "report",
      files: [
        {
          data: Buffer.from("csv"),
          filename: "report.csv",
          mimeType: "text/csv",
        },
      ],
    });

    const form = requests[0].form!;
    expect(form.get("content")).toBe("report");
    expect(form.get("message_type")).toBe("outgoing");
    expect((form.get("attachments[]") as File).name).toBe("report.csv");
  });

  it("sends several files under the same repeated field", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    await adapter.postMessage(THREAD_ID, {
      markdown: "two",
      files: [
        { data: Buffer.from("a"), filename: "a.txt" },
        { data: Buffer.from("b"), filename: "b.txt" },
      ],
    });

    const uploaded = requests[0].form!.getAll("attachments[]") as File[];
    expect(uploaded.map((file) => file.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("sends a postable attachment by downloading it first", async () => {
    const adapter = createAdapter();
    const requests = stubFetch((request) =>
      request.url.endsWith("/report.pdf")
        ? new Response("pdf-bytes", { status: 200 })
        : restMessage(),
    );

    await adapter.postMessage(THREAD_ID, {
      markdown: "see attached",
      attachments: [
        {
          type: "file",
          url: `${BASE_URL}/report.pdf`,
          name: "report.pdf",
          mimeType: "application/pdf",
        },
      ],
    } as never);

    const uploaded = requests[1].form!.get("attachments[]") as File;
    expect(uploaded.name).toBe("report.pdf");
    expect(await uploaded.text()).toBe("pdf-bytes");
  });

  it("infers a mime type Chatwoot accepts from the filename", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    await adapter.postMessage(THREAD_ID, {
      markdown: "sheet",
      files: [{ data: Buffer.from("a,b"), filename: "report.CSV" }],
    });

    expect((requests[0].form!.get("attachments[]") as File).type).toBe(
      "text/csv",
    );
  });

  it("refuses an attachment it cannot resolve", async () => {
    const adapter = createAdapter();
    stubFetch(() => restMessage());

    await expect(
      adapter.postMessage(THREAD_ID, {
        markdown: "broken",
        attachments: [{ type: "file", name: "ghost.pdf" }],
      } as never),
    ).rejects.toThrow(/no data/);
  });

  it("serialises content_attributes as JSON for multipart requests", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    await adapter.reply(THREAD_ID, "3042", {
      markdown: "here",
      files: [{ data: Buffer.from("x"), filename: "x.txt" }],
    });

    expect(
      JSON.parse(requests[0].form!.get("content_attributes") as string),
    ).toEqual({
      in_reply_to: 3042,
    });
  });

  it("keeps the line breaks of a message sent with files, which FormData would turn into CRLF", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    await adapter.postMessage(THREAD_ID, {
      markdown: "Your invoice:\n\n- one\n- two",
      files: [
        { data: Buffer.from("x"), filename: 'evil"\r\nX-Injected: 1.pdf' },
      ],
    });

    const form = requests[0].form!;
    expect(form.get("content")).toBe("Your invoice:\n\n* one\n* two");
    expect((form.get("attachments[]") as File).name).toBe(
      'evil"\r\nX-Injected: 1.pdf',
    );
    expect([...form.keys()]).toEqual([
      "content",
      "message_type",
      "private",
      "content_type",
      "attachments[]",
    ]);
  });

  it("quotes another message with in_reply_to", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());
    await adapter.reply(THREAD_ID, "3042", "answering");

    expect(requests[0].body).toMatchObject({
      content_attributes: { in_reply_to: 3042 },
    });
  });

  it("rejects a reply target that is not a message ID", async () => {
    await expect(
      createAdapter().reply(THREAD_ID, "not-an-id", "hi"),
    ).rejects.toThrow(ValidationError);
  });

  it("marks private notes as private", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());
    await adapter.postPrivateNote(THREAD_ID, "internal");

    expect(requests[0].body).toMatchObject({ private: true });
  });

  it("rejects content longer than Chatwoot allows", async () => {
    const adapter = createAdapter();
    stubFetch(() => restMessage());

    await expect(
      adapter.postMessage(THREAD_ID, "x".repeat(150_001)),
    ).rejects.toThrow(ValidationError);
  });

  it("sends a card's images as attachments of the same message", async () => {
    const adapter = createAdapter();
    const requests = stubFetch((request) =>
      request.url.endsWith(".png")
        ? new Response("png-bytes", { status: 200 })
        : restMessage(),
    );

    await adapter.postMessage(
      THREAD_ID,
      Card({
        title: "Menu",
        imageUrl: `${BASE_URL}/images/header.png`,
        children: [
          { type: "image", url: `${BASE_URL}/images/dish.png`, alt: "dish" },
        ],
      }),
    );

    const form = requests.at(-1)!.form!;
    expect(form.get("content")).toBe("**Menu**");
    expect(
      (form.getAll("attachments[]") as File[]).map((file) => [
        file.name,
        file.type,
      ]),
    ).toEqual([
      ["header.png", "image/png"],
      ["dish.png", "image/png"],
    ]);
  });

  it("rejects more attachments than Chatwoot allows", async () => {
    const adapter = createAdapter();
    stubFetch(() => restMessage());
    const files = Array.from({ length: 16 }, (_, index) => ({
      data: Buffer.from("x"),
      filename: `file-${index}.txt`,
    }));

    await expect(
      adapter.postMessage(THREAD_ID, { markdown: "many", files }),
    ).rejects.toThrow(/15 attachments/);
  });
});

describe("editMessage and reactions", () => {
  it("throws because Chatwoot cannot edit a sent message", async () => {
    await expect(createAdapter().editMessage()).rejects.toThrow(
      NotImplementedError,
    );
  });

  it("throws because Chatwoot has no reaction API", async () => {
    const adapter = createAdapter();
    await expect(
      adapter.addReaction(THREAD_ID, "3042", "thumbs_up"),
    ).rejects.toThrow(NotImplementedError);
    await expect(
      adapter.removeReaction(THREAD_ID, "3042", "thumbs_up"),
    ).rejects.toThrow(NotImplementedError);
  });
});

describe("deleteMessage", () => {
  it("sends a DELETE to the message route", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.deleteMessage(THREAD_ID, "3042");

    expect(requests[0]).toMatchObject({
      url: `${BASE_URL}/api/v1/accounts/2/conversations/300/messages/3042`,
      method: "DELETE",
    });
  });

  it("rejects a message ID that would reach another route", async () => {
    const requests = stubFetch(() => ({}));

    await expect(
      createAdapter().deleteMessage(THREAD_ID, "../../../contacts/5"),
    ).rejects.toThrow(ValidationError);
    expect(requests).toHaveLength(0);
  });
});

describe("fetchMessages", () => {
  const page = (ids: number[]) => ({
    payload: ids.map((id) =>
      restMessage({
        id,
        content: `message ${id}`,
        created_at: 1777456800 + id,
      }),
    ),
  });

  it("fetches recent messages with backward pagination", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => page([95, 96, 97]));

    const result = await adapter.fetchMessages(THREAD_ID, {
      cursor: "99",
      direction: "backward",
      limit: 2,
    });

    expect(requests[0].url).toBe(
      `${BASE_URL}/api/v1/accounts/2/conversations/300/messages?before=99`,
    );
    expect(result.messages.map((message) => message.id)).toEqual(["96", "97"]);
    expect(result.nextCursor).toBe("96");
  });

  it("fetches older-to-newer messages with forward pagination", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => page([21, 22, 23]));

    const result = await adapter.fetchMessages(THREAD_ID, {
      cursor: "20",
      direction: "forward",
      limit: 2,
    });

    expect(requests[0].url).toBe(
      `${BASE_URL}/api/v1/accounts/2/conversations/300/messages?after=20`,
    );
    expect(result.messages.map((message) => message.id)).toEqual(["21", "22"]);
    expect(result.nextCursor).toBe("22");
  });

  it("starts forward pagination from the first message", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => page([1]));
    await adapter.fetchMessages(THREAD_ID, { direction: "forward" });

    expect(requests[0].url).toContain("after=0");
  });

  it("omits the cursor when the page is not full", async () => {
    const adapter = createAdapter();
    stubFetch(() => page([95]));
    const result = await adapter.fetchMessages(THREAD_ID, { limit: 5 });

    expect(result.nextCursor).toBeUndefined();
  });

  it("clamps the limit to what Chatwoot returns", async () => {
    const adapter = createAdapter();
    stubFetch(() => page(Array.from({ length: 20 }, (_, index) => index + 1)));
    const result = await adapter.fetchMessages(THREAD_ID, { limit: 500 });

    expect(result.messages).toHaveLength(20);
  });

  it("fetches a single message through the between-IDs window", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({
      payload: [restMessage({ id: 3043 })],
    }));
    const message = await adapter.fetchMessage(THREAD_ID, "3043");

    expect(requests[0].url).toContain("after=3043&before=3044");
    expect(message?.id).toBe("3043");
  });

  it("returns null when the message is gone", async () => {
    const adapter = createAdapter();
    stubFetch(() => ({ payload: [] }));

    expect(await adapter.fetchMessage(THREAD_ID, "999")).toBeNull();
  });
});

describe("conversation metadata", () => {
  it("fetches thread info from the REST conversation shape", async () => {
    const adapter = createAdapter();
    stubFetch(() => restConversation());
    const info = await adapter.fetchThread(THREAD_ID);

    expect(info).toMatchObject({
      id: THREAD_ID,
      channelId: "chatwoot:10",
      isDM: true,
    });
    expect(info.metadata).toMatchObject({
      conversationId: 300,
      status: "open",
      unreadCount: 1,
      channel: "Channel::WebWidget",
      muted: false,
    });
  });

  it("fetches thread info from the webhook conversation shape", async () => {
    const adapter = createAdapter();
    stubFetch(() => CONVERSATION);
    const info = await adapter.fetchThread(THREAD_ID);

    expect(info.metadata).toMatchObject({
      conversationId: 300,
      channel: "Channel::WebWidget",
    });
  });

  it("rejects a channel ID with no inbox", async () => {
    await expect(
      createAdapter().fetchChannelInfo("chatwoot:nope"),
    ).rejects.toThrow(ValidationError);
  });

  it("reads the inbox from a slash command's channel, which is its thread", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({ id: 10, name: "Website" }));
    await adapter.fetchChannelInfo(THREAD_ID);

    expect(requests[0].url).toBe(`${BASE_URL}/api/v1/accounts/2/inboxes/10`);
  });

  it("fetches channel info from the inbox", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({
      id: 10,
      name: "Website",
      channel_type: "Channel::WebWidget",
    }));
    const info = await adapter.fetchChannelInfo("chatwoot:10");

    expect(requests[0].url).toBe(`${BASE_URL}/api/v1/accounts/2/inboxes/10`);
    expect(info).toMatchObject({ id: "chatwoot:10", name: "Website" });
  });

  it("lists an inbox's conversations with their latest message", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({
      data: {
        payload: [{ ...CONVERSATION, messages: [restMessage({ id: 3043 })] }],
      },
    }));

    const result = await adapter.listThreads("chatwoot:10");

    expect(requests[0].url).toContain("inbox_id=10&status=all&page=1");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({ id: THREAD_ID });
    expect(result.threads[0].rootMessage.id).toBe("3043");
    expect(result.nextCursor).toBeUndefined();
  });

  it("pages through an inbox's conversations by offset, up to the limit", async () => {
    const adapter = createAdapter();
    const rows = Array.from({ length: 25 }, (_, index) => ({
      ...CONVERSATION,
      id: 300 + index,
    }));
    const requests = stubFetch((request) => ({
      data: {
        payload: request.url.endsWith("page=1") ? rows : rows.slice(0, 3),
      },
    }));

    const first = await adapter.listThreads("chatwoot:10", { limit: 10 });
    const rest = await adapter.listThreads("chatwoot:10", {
      cursor: first.nextCursor,
      limit: 20,
    });
    const last = await adapter.listThreads("chatwoot:10", {
      cursor: rest.nextCursor,
    });

    expect(first.threads.at(-1)?.id).toBe("chatwoot:10:20:309");
    expect([first.nextCursor, rest.nextCursor, last.nextCursor]).toEqual([
      "10",
      "25",
      undefined,
    ]);
    expect([rest.threads.length, last.threads.length]).toEqual([15, 3]);
    expect(
      requests.map((request) => new URL(request.url).searchParams.get("page")),
    ).toEqual(["1", "1", "2"]);
  });

  it("exposes the conversation as a message subject", async () => {
    const adapter = createAdapter();
    const subject = await adapter.fetchSubject(webhookMessage() as never);

    expect(subject).toMatchObject({
      id: "300",
      type: "conversation",
      title: "Ada Lovelace",
      status: "open",
      url: `${BASE_URL}/app/accounts/2/conversations/300`,
    });
  });

  it("has no subject for a message without its conversation", async () => {
    expect(
      await createAdapter().fetchSubject(restMessage() as never),
    ).toBeNull();
  });
});

describe("presence and read state", () => {
  it("toggles the typing indicator", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.startTyping(THREAD_ID);
    await adapter.endTyping(THREAD_ID);

    expect(requests.map((request) => request.body)).toEqual([
      { typing_status: "on" },
      { typing_status: "off" },
    ]);
    expect(requests[0].url).toBe(
      `${BASE_URL}/api/v1/accounts/2/conversations/300/toggle_typing_status`,
    );
  });

  it("marks a conversation as read and unread", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.markAsRead(THREAD_ID);
    await adapter.markAsUnread(THREAD_ID);

    expect(requests.map((request) => request.url)).toEqual([
      `${BASE_URL}/api/v1/accounts/2/conversations/300/update_last_seen`,
      `${BASE_URL}/api/v1/accounts/2/conversations/300/unread`,
    ]);
  });
});

describe("stream", () => {
  it("buffers the stream and posts one message between typing indicators", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());

    const chunks = ["Check", "ing ", "**now**"];
    const stream = (async function* () {
      yield* chunks;
      yield {
        type: "task_update",
        id: "1",
        status: "complete",
        title: "ignored",
      } as const;
    })();

    const sent = await adapter.stream(THREAD_ID, stream);

    expect(requests.map((request) => request.body)).toEqual([
      { typing_status: "on" },
      { typing_status: "off" },
      {
        content: "Checking **now**",
        message_type: "outgoing",
        private: false,
        content_type: "text",
      },
    ]);
    expect(sent.id).toBe("3043");
  });

  it("posts an empty message rather than falling back to an edit", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());
    const empty = (async function* () {})();

    const sent = await adapter.stream(THREAD_ID, empty);

    expect(sent.id).toBe("3043");
    expect(requests[2].body).toMatchObject({ content: "" });
  });

  it("keeps streaming when the typing indicator is rejected", async () => {
    const adapter = createAdapter();
    stubFetch((request) =>
      request.url.endsWith("toggle_typing_status")
        ? new Response("forbidden", { status: 403 })
        : restMessage(),
    );

    const stream = (async function* () {
      yield "done";
    })();

    expect((await adapter.stream(THREAD_ID, stream)).id).toBe("3043");
  });

  it("stops reading once its signal aborts, and posts what arrived", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => restMessage());
    const controller = new AbortController();
    const stream = (async function* () {
      yield "partial";
      controller.abort();
      yield " never";
    })();

    await adapter.stream(THREAD_ID, stream, { signal: controller.signal });

    expect(requests.at(-1)!.body).toMatchObject({ content: "partial" });
  });
});

describe("conversation actions", () => {
  it("resolves, snoozes, assigns, prioritises, labels and mutes", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({ payload: ["urgent"] }));

    await adapter.toggleStatus({ threadId: THREAD_ID, status: "resolved" });
    await adapter.toggleStatus({
      threadId: THREAD_ID,
      status: "snoozed",
      snoozedUntil: new Date("2026-05-01T00:00:00.000Z"),
    });
    await adapter.assign({ threadId: THREAD_ID, assigneeId: 7 });
    await adapter.assign({ threadId: THREAD_ID, assigneeId: null });
    await adapter.setPriority({ threadId: THREAD_ID, priority: "urgent" });
    await adapter.setLabels(THREAD_ID, ["urgent"]);
    await adapter.setCustomAttributes(THREAD_ID, { plan: "pro" });
    await adapter.mute(THREAD_ID);
    await adapter.unmute(THREAD_ID);

    expect(
      requests.map((request) => request.url.split("/conversations/300/")[1]),
    ).toEqual([
      "toggle_status",
      "toggle_status",
      "assignments",
      "assignments",
      "toggle_priority",
      "labels",
      "custom_attributes",
      "mute",
      "unmute",
    ]);
    // Chatwoot reads snoozed_until with DateTime.strptime(value, "%s").
    expect(requests[1].body).toEqual({
      status: "snoozed",
      snoozed_until: Date.parse("2026-05-01T00:00:00.000Z") / 1000,
    });
    expect(requests[2].body).toEqual({ assignee_id: 7 });
    expect(requests[6].body).toEqual({ custom_attributes: { plan: "pro" } });
    expect(requests[3].body).toEqual({ assignee_id: null });
    expect(requests[4].body).toEqual({ priority: "urgent" });
  });

  it("assigns an agent and a team as two requests", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.assign({ threadId: THREAD_ID, assigneeId: 7, teamId: 3 });

    expect(requests.map((request) => request.body)).toEqual([
      { assignee_id: 7 },
      { team_id: 3 },
    ]);
  });

  it("refuses an assignment that names neither an agent nor a team", async () => {
    await expect(
      createAdapter().assign({ threadId: THREAD_ID }),
    ).rejects.toThrow(ValidationError);
  });

  it("clears a priority with null", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.setPriority({ threadId: THREAD_ID, priority: null });

    expect(requests[0].body).toEqual({ priority: null });
  });
});

describe("openDM", () => {
  it("reuses the contact's most recent unresolved conversation", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({
      payload: [
        restConversation({ status: "resolved" }),
        restConversation({ id: 301 }),
      ],
    }));

    expect(await adapter.openDM("20")).toBe("chatwoot:10:20:301");
    expect(requests).toHaveLength(1);
  });

  it("opens a conversation in the contact's own inbox when there is none", async () => {
    const adapter = createAdapter();
    const requests = stubFetch((request: RecordedRequest) => {
      if (request.url.endsWith("/contacts/20/conversations"))
        return { payload: [] };
      if (request.url.endsWith("/contactable_inboxes"))
        return {
          payload: [
            { source_id: "e-mail", inbox: { id: 9, name: "Email" } },
            { source_id: "3d1f", inbox: { id: 10, name: "WhatsApp" } },
          ],
        };
      if (request.url.endsWith("/contacts/20"))
        return {
          payload: {
            id: 20,
            contact_inboxes: [{ source_id: "3d1f", inbox: { id: 10 } }],
          },
        };
      return restConversation({ id: 305 });
    });

    expect(await adapter.openDM("20")).toBe("chatwoot:10:20:305");
    expect(requests.at(-1)!.body).toEqual({
      contact_id: 20,
      inbox_id: 10,
      source_id: "3d1f",
    });
  });

  it("falls back to the first contactable inbox for a contact in none yet", async () => {
    const adapter = createAdapter();
    const requests = stubFetch((request: RecordedRequest) => {
      if (request.url.endsWith("/contacts/20/conversations"))
        return { payload: [] };
      if (request.url.endsWith("/contactable_inboxes"))
        return { payload: [{ source_id: "e-mail", inbox: { id: 9 } }] };
      if (request.url.endsWith("/contacts/20"))
        return { payload: { id: 20, contact_inboxes: [] } };
      return restConversation({ id: 306, inbox_id: 9 });
    });

    expect(await adapter.openDM("20")).toBe("chatwoot:9:20:306");
    expect(requests.at(-1)!.body).toMatchObject({ inbox_id: 9 });
  });

  it("stays inside the configured inbox", async () => {
    const adapter = createAdapter({ inboxId: 11 });
    stubFetch(() => ({
      payload: [
        restConversation({ id: 301 }),
        restConversation({ id: 302, inbox_id: 11 }),
      ],
    }));

    expect(await adapter.openDM("20")).toBe("chatwoot:11:20:302");
  });

  it("rejects a contact ID that is not a number", async () => {
    await expect(createAdapter().openDM("ada")).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("contacts and agents", () => {
  it("fetches a contact from the payload envelope", async () => {
    const adapter = createAdapter();
    stubFetch(() => ({ payload: { id: 20, name: "Ada Lovelace" } }));

    expect((await adapter.fetchContact(20)).name).toBe("Ada Lovelace");
  });

  it("lists agents", async () => {
    const adapter = createAdapter();
    stubFetch(() => [{ id: 7, name: "Grace Hopper", available_name: "Grace" }]);

    expect((await adapter.listAgents())[0].available_name).toBe("Grace");
  });

  it("looks a user up as a contact, then among the agents", async () => {
    const adapter = createAdapter();
    stubFetch((request) =>
      request.url.endsWith("/contacts/20")
        ? {
            payload: {
              id: 20,
              name: "Ada Lovelace",
              email: "ada@example.com",
              thumbnail: "https://cdn.example.com/ada.png",
            },
          }
        : request.url.endsWith("/agents")
          ? [{ id: 7, name: "Grace Hopper", available_name: "Grace" }]
          : new Response("{}", { status: 404 }),
    );

    expect(await adapter.getUser("20")).toEqual({
      userId: "20",
      userName: "Ada Lovelace",
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: "https://cdn.example.com/ada.png",
      isBot: false,
    });
    expect(await adapter.getUser("7")).toEqual({
      userId: "7",
      userName: "Grace",
      fullName: "Grace Hopper",
      isBot: false,
    });
    expect(await adapter.getUser("8")).toBeNull();
  });
});

describe("fetch", () => {
  const failWith = (
    status: number,
    body = "{}",
    headers: Record<string, string> = {},
  ) => stubFetch(() => new Response(body, { status, headers }));

  it("maps HTTP failures onto adapter errors", async () => {
    const adapter = createAdapter();

    failWith(401);
    await expect(adapter.fetch("/profile")).rejects.toThrow(
      AuthenticationError,
    );

    failWith(403);
    await expect(adapter.fetch("/profile")).rejects.toThrow(PermissionError);

    failWith(404);
    await expect(adapter.fetch("/profile")).rejects.toThrow(
      ResourceNotFoundError,
    );

    failWith(422, '{"error":"bad"}');
    await expect(adapter.fetch("/profile")).rejects.toThrow(ValidationError);

    const limited = failWith(429, "{}", { "retry-after": "30" });
    await expect(adapter.fetch("/profile")).rejects.toMatchObject({
      constructor: AdapterRateLimitError,
      retryAfter: 30,
    });
    expect(limited).toHaveLength(1);

    failWith(500, "boom");
    await expect(adapter.fetch("/profile", { body: {} })).rejects.toThrow(
      NetworkError,
    );
  });

  it("retries a GET that failed transiently, honouring an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const responses = [
        () => new Response("down", { status: 503 }),
        () => {
          throw new TypeError("fetch failed");
        },
        () =>
          new Response("{}", {
            status: 429,
            headers: {
              "retry-after": new Date(Date.now() + 3_000).toUTCString(),
            },
          }),
        () => new Response('{"id":7}', { status: 200 }),
      ];
      const requests = stubFetch(() => responses.shift()!());

      const result = adapter.fetch("/profile");
      await vi.runAllTimersAsync();

      expect(await result).toEqual({ id: 7 });
      expect(requests).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a write, and gives a GET up after its retries", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const requests = stubFetch(() => new Response("down", { status: 503 }));

      await expect(adapter.fetch("/profile", { body: {} })).rejects.toThrow(
        NetworkError,
      );
      expect(requests).toHaveLength(1);

      const result = expect(adapter.fetch("/profile")).rejects.toThrow(
        NetworkError,
      );
      await vi.runAllTimersAsync();
      await result;
      expect(requests).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times a request out as a NetworkError", async () => {
    globalThis.fetch = hang;

    await expect(
      createAdapter({ timeoutMs: 10 }).fetch("/profile", { body: {} }),
    ).rejects.toThrow(NetworkError);
  });

  it("drops undefined query values and sends DELETE without a body", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.fetch("/profile", {
      method: "DELETE",
      query: { keep: 1, skip: undefined, flag: false },
    });

    expect(requests[0]).toMatchObject({
      url: `${BASE_URL}/api/v1/profile?keep=1&flag=false`,
      method: "DELETE",
      body: undefined,
    });
  });

  it("keeps a subpath install's prefix", async () => {
    const adapter = createAdapter({ baseUrl: "https://example.com/chatwoot/" });
    const requests = stubFetch(() => ({}));
    await adapter.fetch("/profile");

    expect(requests[0].url).toBe("https://example.com/chatwoot/api/v1/profile");
  });

  it("accepts an endpoint with or without a leading slash", async () => {
    const adapter = createAdapter();
    const requests = stubFetch(() => ({}));
    await adapter.fetch("profile");

    expect(requests[0].url).toBe(`${BASE_URL}/api/v1/profile`);
  });

  it("returns undefined for an empty body", async () => {
    const adapter = createAdapter();
    stubFetch(() => new Response(null, { status: 204 }));

    expect(await adapter.fetch("/profile")).toBeUndefined();
  });

  it("sends the access token on every request", async () => {
    const adapter = createAdapter();
    const headers: (string | undefined)[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      headers.push(
        (init?.headers as Record<string, string> | undefined)?.api_access_token,
      );
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await adapter.fetch("/profile");
    expect(headers).toEqual(["test-token"]);
  });
});

describe("initialize", () => {
  it("adopts the authenticated agent's identity", async () => {
    const { adapter } = await initialized();

    expect(adapter.botUserId).toBe("7");
    expect(adapter.userName).toBe("Grace");
    expect(adapter.persistThreadHistory).toBe(false);
  });

  it("keeps working when the token belongs to an agent bot", async () => {
    const adapter = createAdapter({ userName: "support-bot" });
    stubFetch(BOT_REFUSAL);
    await adapter.initialize(createChatRecorder().chat);

    expect(adapter.botUserId).toBeUndefined();
    expect(adapter.userName).toBe("support-bot");
  });

  it("leaves an agent bot's history to Chat SDK, since its token cannot list messages", async () => {
    const adapter = createAdapter();
    stubFetch(BOT_REFUSAL);
    await adapter.initialize(createChatRecorder().chat);
    const requests = stubFetch(() => ({}));

    expect(adapter.persistThreadHistory).toBe(true);
    expect(await adapter.fetchMessages(THREAD_ID)).toEqual({ messages: [] });
    expect(requests).toHaveLength(0);
  });

  it("rejects an invalid access token", async () => {
    const adapter = createAdapter();
    stubFetch(() => new Response("unauthorized", { status: 401 }));

    await expect(adapter.initialize(createChatRecorder().chat)).rejects.toThrow(
      AuthenticationError,
    );
  });

  it("recognises an agent bot's own messages without an ID", async () => {
    const adapter = createAdapter({
      webhookSecret: SECRET,
      receiveAgentMessages: true,
    });
    stubFetch(BOT_REFUSAL);
    const recorder = createChatRecorder();
    const tracker = createWaitUntilTracker();
    await adapter.initialize(recorder.chat);

    await adapter.handleWebhook(
      signRequest(
        webhookMessage({
          message_type: "outgoing",
          sender: { id: 9, name: "support-bot", type: "agent_bot" },
        }),
        SECRET,
      ),
      tracker.options,
    );
    await tracker.settled();

    expect(recorder.messages[0].message.author).toMatchObject({
      isMe: true,
      isBot: true,
    });
  });
});

describe("action values", () => {
  it("roundtrips an action ID with and without a value", () => {
    expect(decodeActionValue(encodeActionValue("approve", "42"))).toEqual({
      actionId: "approve",
      value: "42",
    });
    expect(decodeActionValue(encodeActionValue("approve"))).toEqual({
      actionId: "approve",
    });
  });

  it("splits on the first delimiter so values may contain newlines", () => {
    expect(decodeActionValue(encodeActionValue("id", "a\nb"))).toEqual({
      actionId: "id",
      value: "a\nb",
    });
  });
});
