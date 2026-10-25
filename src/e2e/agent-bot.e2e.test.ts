import { Chat, type Message } from "chat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatwootAdapter } from "../adapter";
import { createChatwootAdapter } from "../factory";
import type { ChatwootMessage } from "../schema";
import { createMemoryState } from "../test-utils";
import {
  agentApi,
  customer,
  e2e,
  eventually,
  serveWebhooks,
  type WebhookServer,
} from "./chatwoot";

/** An agent bot: its own token, its own webhook, and Chatwoot's pending-then-handoff flow. */
describe.skipIf(!e2e.url)(
  "as a Chatwoot agent bot",
  { timeout: 120_000 },
  () => {
    const admin = agentApi(e2e.adminToken);
    const received: Message<ChatwootMessage>[] = [];
    const histories: string[][] = [];

    let adapter: ChatwootAdapter;
    let server: WebhookServer;
    let inbox: { id: number; inbox_identifier: string };
    let refusingInbox: { id: number; inbox_identifier: string };
    const bots: number[] = [];

    const botInbox = async (outgoingUrl: string) => {
      const created = await admin("/inboxes", {
        body: { name: `Bot ${Date.now()}`, channel: { type: "api" } },
      });
      const bot = await admin("/agent_bots", {
        body: { name: `bot-${created.id}`, outgoing_url: outgoingUrl },
      });
      bots.push(bot.id);
      await admin(`/inboxes/${created.id}/set_agent_bot`, {
        body: { agent_bot: bot.id },
      });
      return { inbox: created, bot };
    };

    beforeAll(async () => {
      let handle = async (_request: Request) =>
        new Response("not ready", { status: 503 });
      server = await serveWebhooks(async (request) =>
        new URL(request.url).pathname === "/refuse"
          ? new Response("Invalid signature", { status: 401 })
          : handle(request),
      );

      const { inbox: created, bot } = await botInbox(server.url("/bot"));
      inbox = created;
      refusingInbox = (await botInbox(server.url("/refuse"))).inbox;

      adapter = createChatwootAdapter({
        baseUrl: e2e.url,
        accessToken: bot.access_token,
        accountId: e2e.accountId,
        webhookSecret: bot.secret,
      });
      const chat = new Chat({
        userName: "support-bot",
        adapters: { chatwoot: adapter },
        state: createMemoryState(),
        logger: "error",
      });
      chat.onDirectMessage(async (thread, message) => {
        received.push(message as Message<ChatwootMessage>);
        if (message.text === "human") {
          await adapter.toggleStatus({ threadId: thread.id, status: "open" });
          return;
        }
        await thread.post(`bot heard: ${message.text}`);
        const history: string[] = [];
        for await (const entry of thread.messages) history.push(entry.text);
        histories.push(history);
      });
      await chat.initialize();
      handle = (request) => chat.webhooks.chatwoot(request);
    }, 120_000);

    afterAll(async () => {
      for (const id of bots)
        await admin(`/agent_bots/${id}`, { method: "DELETE" });
      await server?.close();
    });

    it("answers as the bot while the conversation waits, and never hears itself", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      expect((await admin(`/conversations/${ada.conversationId}`)).status).toBe(
        "pending",
      );

      await ada.say("hola");

      const reply = await eventually(
        async () =>
          (await ada.transcript()).find(
            (message) => message.message_type === 1,
          ),
        "the bot's reply",
      );
      expect(reply.content).toBe("bot heard: hola");
      expect(adapter.botUserId).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(received.map((message) => message.text)).toEqual(["hola"]);
      // Listing messages is outside what Chatwoot lets a bot token do, so
      // Chat SDK serves the history it kept, newest first.
      expect(adapter.persistThreadHistory).toBe(true);
      expect(histories).toEqual([["bot heard: hola", "hola"]]);
    });

    it("hands the conversation to people by opening it", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      await ada.say("human");

      await eventually(
        async () =>
          (await admin(`/conversations/${ada.conversationId}`)).status ===
          "open",
        "the handoff",
      );
    });

    it("is handed off by Chatwoot itself when the bot refuses a message", async () => {
      const ada = await customer(
        refusingInbox.inbox_identifier,
        "Ada Lovelace",
      );
      await ada.say("hola");

      await eventually(
        async () =>
          (await admin(`/conversations/${ada.conversationId}`)).status ===
          "open",
        "Chatwoot opening the conversation",
      );
    });
  },
);
