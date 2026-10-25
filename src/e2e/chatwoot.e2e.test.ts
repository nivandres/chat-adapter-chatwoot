import {
  Actions,
  Button,
  Card,
  Chat,
  Modal,
  Select,
  SelectOption,
  TextInput,
  type ActionEvent,
  type Message,
  type ModalSubmitEvent,
  type Thread,
} from "chat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatwootAdapter } from "../adapter";
import { createChatwootAdapter } from "../factory";
import {
  toDate,
  type ChatwootMessage,
  type ChatwootWebhookPayload,
} from "../schema";
import { createMemoryState } from "../test-utils";
import {
  agentApi,
  customer,
  e2e,
  eventually,
  serveWebhooks,
  visitor,
  type WebhookServer,
} from "./chatwoot";

/**
 * Against a real Chatwoot: `bun e2e/bootstrap.ts`, then `bun run test:e2e`.
 * Skipped when no instance is configured.
 */
describe.skipIf(!e2e.url)(
  "against a real Chatwoot",
  { timeout: 120_000 },
  () => {
    const admin = agentApi(e2e.adminToken);
    const colleague = agentApi(e2e.agentToken);
    const received: { thread: Thread; message: Message<ChatwootMessage> }[] =
      [];
    const deleted: { threadId: string; messageId: string }[] = [];
    const updated: Message<ChatwootMessage>[] = [];
    const actions: ActionEvent[] = [];
    const events: ChatwootWebhookPayload[] = [];
    const refused: number[] = [];
    const submits: ModalSubmitEvent[] = [];

    let adapter: ChatwootAdapter;
    let bot: Chat;
    let server: WebhookServer;
    let inbox: { id: number; inbox_identifier: string; secret: string };
    let widget: { id: number; website_token: string };

    /** Messages the handlers saw in one conversation, contact's and agents' alike. */
    const seen = (conversationId: number) =>
      received.filter(({ message }) =>
        message.threadId.endsWith(`:${conversationId}`),
      );

    beforeAll(async () => {
      let handle = async (_request: Request) =>
        new Response("not ready", { status: 503 });
      server = await serveWebhooks((request) => handle(request));

      inbox = await admin("/inboxes", {
        body: {
          name: `API ${Date.now()}`,
          channel: { type: "api", webhook_url: server.url("/api-inbox") },
        },
      });
      await admin("/inbox_members", {
        body: { inbox_id: inbox.id, user_ids: [e2e.agentId] },
      });
      widget = await admin("/inboxes", {
        body: {
          name: `Widget ${Date.now()}`,
          channel: { type: "web_widget", website_url: "http://localhost" },
        },
      });
      const { payload } = await admin("/webhooks", {
        body: {
          webhook: {
            url: server.url("/account"),
            subscriptions: [
              "message_created",
              "message_updated",
              "conversation_created",
              "conversation_updated",
              "conversation_status_changed",
              "conversation_typing_on",
              "conversation_typing_off",
            ],
          },
        },
      });

      adapter = createChatwootAdapter({
        baseUrl: e2e.url,
        accessToken: e2e.adminToken,
        accountId: e2e.accountId,
        // The account webhook and the API inbox each sign with their own.
        webhookSecret: [payload.webhook.secret, inbox.secret],
        slashCommands: ["/status", "/order"],
        onEvent: (event) => void events.push(event),
      });
      bot = new Chat({
        userName: "Grace",
        adapters: { chatwoot: adapter },
        state: createMemoryState(),
        logger: "error",
      });
      bot.onDirectMessage(async (thread, message) => {
        received.push({ thread, message: message as Message<ChatwootMessage> });
        if (message.text.startsWith("echo "))
          await thread.post(message.text.slice(5));
      });
      bot.onMessageDeleted(async (event) => void deleted.push(event));
      bot.onMessageUpdated(
        async (_thread, message) =>
          void updated.push(message as Message<ChatwootMessage>),
      );
      bot.onAction(async (event) => void actions.push(event));
      bot.onSlashCommand("/status", async (event) => {
        await event.channel.post(`status: ${event.text}`);
      });
      // The same modal: the inbox decides whether it is a form or a conversation.
      bot.onSlashCommand("/order", async (event) => {
        await event.openModal(
          Modal({
            callbackId: "order",
            title: "Order",
            children: [
              TextInput({ id: "name", label: "Name" }),
              Select({
                id: "size",
                label: "Size",
                options: [
                  SelectOption({ label: "Small", value: "s" }),
                  SelectOption({ label: "Large", value: "l" }),
                ],
              }),
            ],
          }),
        );
      });
      bot.onModalSubmit("order", async (event) => {
        submits.push(event);
        await event.relatedChannel?.post(
          `Thanks ${event.values.name}, ${event.values.size}`,
        );
      });
      await bot.initialize();

      handle = async (request) => {
        const response = await bot.webhooks.chatwoot(request);
        if (response.status !== 200) refused.push(response.status);
        return response;
      };
    }, 120_000);

    afterAll(async () => {
      const { payload } = await admin("/webhooks");
      for (const webhook of payload.webhooks)
        if (webhook.url.startsWith(server.url("")))
          await admin(`/webhooks/${webhook.id}`, { method: "DELETE" });
      await server?.close();
    });

    it("answers a contact once, though the account and the inbox both deliver it", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const sent = await ada.say("echo **hola** mundo");

      const reply = await eventually(
        async () =>
          (await ada.transcript()).find(
            (message) => message.message_type === 1,
          ),
        "the bot's reply",
      );
      expect(reply.content).toBe("hola mundo");

      const [first] = seen(ada.conversationId);
      expect(first!.message).toMatchObject({
        id: String(sent.id),
        threadId: `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`,
        text: "echo hola mundo",
        author: { fullName: "Ada Lovelace", isMe: false, isBot: false },
      });
      // The reply's own webhook comes back too, and is the bot's.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(seen(ada.conversationId)).toHaveLength(1);
      expect(refused).toEqual([]);
    });

    it("keeps colleagues' replies, their notes and the bot's own from the handlers", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;
      const route = `/conversations/${ada.conversationId}/messages`;

      await colleague(route, {
        body: { content: "I'll take it", message_type: "outgoing" },
      });
      await colleague(route, {
        body: { content: "VIP customer", private: true },
      });
      await adapter.postPrivateNote(thread, "note from the bot");

      await eventually(
        () =>
          events.filter(
            (event) =>
              event.event === "message_created" &&
              event.conversation?.id === ada.conversationId,
          ).length >= 3 || undefined,
        "the messages' webhooks",
      );
      expect(seen(ada.conversationId)).toEqual([]);
    });

    it("reports a deleted message once", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const { id } = await ada.say("oops");
      await eventually(() => seen(ada.conversationId)[0], "the message");

      await admin(`/conversations/${ada.conversationId}/messages/${id}`, {
        method: "DELETE",
      });

      await eventually(
        () => deleted.find((event) => event.messageId === String(id)),
        "the delete",
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(
        deleted.filter((event) => event.messageId === String(id)),
      ).toHaveLength(1);
      expect(updated.filter((message) => message.id === String(id))).toEqual(
        [],
      );
    });

    it("downloads a contact's file through Chatwoot's storage redirect", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const bytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4,
      ]);
      await ada.upload(
        "my receipt",
        new Blob([bytes], { type: "image/png" }),
        "receipt.png",
      );

      const { message } = await eventually(
        () => seen(ada.conversationId)[0],
        "the message with a file",
      );
      const [attachment] = message.attachments;
      expect(attachment).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      expect(new Uint8Array(await attachment!.fetchData!())).toEqual(bytes);
    });

    it("sends files, quotes and markdown the contact receives as sent", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const { id } = await ada.say("hi");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;

      await adapter.reply(thread, String(id), {
        markdown: "Your **invoice**:\n\n- item one\n- item two",
        files: [{ data: Buffer.from("%PDF-1.4 e2e"), filename: "invoice.pdf" }],
      });

      const reply = await eventually(
        async () =>
          (await ada.transcript()).find(
            (message) => message.message_type === 1,
          ),
        "the reply",
      );
      expect(reply.content).toBe("Your **invoice**:\n\n* item one\n* item two");
      expect(reply.content_attributes?.in_reply_to).toBe(id);
      expect(reply.attachments?.[0]).toMatchObject({ file_type: "file" });
    });

    it("streams into a single message behind the typing indicator", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;

      await adapter.stream(
        thread,
        (async function* () {
          for (const word of ["One ", "two ", "**three**"]) yield word;
        })(),
      );

      const replies = await eventually(async () => {
        const outgoing = (await ada.transcript()).filter(
          (message) => message.message_type === 1,
        );
        return outgoing.length ? outgoing : undefined;
      }, "the streamed reply");
      expect(replies.map((message) => message.content)).toEqual([
        "One two **three**",
      ]);
      await eventually(
        () =>
          events.find(
            (event) =>
              event.event === "conversation_typing_off" &&
              event.conversation.id === ada.conversationId,
          ),
        "typing off",
      );
    });

    it("pages through history in both directions without gaps or repeats", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;
      const ids: string[] = [];
      for (let n = 0; n < 45; n++)
        ids.push(String((await ada.say(`m${n}`)).id));

      const backward: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await adapter.fetchMessages(thread, { cursor });
        backward.unshift(...page.messages.map((message) => message.id));
        cursor = page.nextCursor;
      } while (cursor);

      const forward: string[] = [];
      cursor = undefined;
      do {
        const page = await adapter.fetchMessages(thread, {
          direction: "forward",
          cursor,
          limit: 10,
        });
        forward.push(...page.messages.map((message) => message.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(backward.filter((id) => ids.includes(id))).toEqual(ids);
      expect(forward.filter((id) => ids.includes(id))).toEqual(ids);
      expect((await adapter.fetchMessage(thread, ids[30]!))?.text).toBe("m30");
    });

    it("drives the conversation the way an agent would", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;
      const conversation = () => admin(`/conversations/${ada.conversationId}`);

      await adapter.setLabels(thread, ["vip", "billing"]);
      await adapter.setPriority({ threadId: thread, priority: "urgent" });
      await adapter.setCustomAttributes(thread, { order: "A-42" });
      await adapter.assign({ threadId: thread, assigneeId: e2e.agentId });
      const until = new Date(Date.now() + 86_400_000);
      await adapter.toggleStatus({
        threadId: thread,
        status: "snoozed",
        snoozedUntil: until,
      });

      const snoozed = await conversation();
      expect(snoozed).toMatchObject({
        labels: expect.arrayContaining(["vip", "billing"]),
        priority: "urgent",
        custom_attributes: { order: "A-42" },
        status: "snoozed",
        meta: { assignee: { id: e2e.agentId } },
      });
      expect(
        Math.abs(toDate(snoozed.snoozed_until)!.getTime() - until.getTime()),
      ).toBeLessThan(5000);

      const info = await adapter.fetchThread(thread);
      expect(info.metadata).toMatchObject({
        status: "snoozed",
        priority: "urgent",
      });
      expect(
        (await adapter.fetchChannelInfo(adapter.channelIdFromThreadId(thread)))
          .name,
      ).toBe((await admin(`/inboxes/${ada.inboxId}`)).name);

      await adapter.markAsRead(thread);
      await adapter.markAsUnread(thread);
      await adapter.setPriority({ threadId: thread, priority: null });
      await adapter.assign({ threadId: thread, assigneeId: null });
      await adapter.toggleStatus({ threadId: thread, status: "resolved" });
      expect(await conversation()).toMatchObject({
        status: "resolved",
        priority: null,
      });
    });

    it("opens a DM in an existing conversation, or a new one when there is none", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      expect(await adapter.openDM(String(ada.contactId))).toBe(
        `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`,
      );

      const { payload } = await admin("/contacts", {
        body: { name: "Charles Babbage", inbox_id: inbox.id },
      });
      const opened = adapter.decodeThreadId(
        await adapter.openDM(String(payload.contact.id)),
      );
      expect(opened).toMatchObject({
        inboxId: inbox.id,
        contactId: payload.contact.id,
      });

      await adapter.postMessage(
        adapter.encodeThreadId(opened),
        "Hello Charles",
      );
      const { payload: messages } = await admin(
        `/conversations/${opened.conversationId}/messages`,
      );
      expect(messages.at(-1).content).toBe("Hello Charles");
    });

    it("turns a card's click into onAction, from the widget and from a WhatsApp-style reply", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;
      const card = Card({
        title: "Order 42",
        children: [
          Actions([
            Button({ id: "approve", label: "Approve", value: "42" }),
            Button({ id: "reject", label: "Reject", value: "42" }),
          ]),
        ],
      });

      const sent = await adapter.postMessage(thread, card);
      const shown = await eventually(
        async () =>
          (await ada.transcript()).find(
            (message) => message.id === Number(sent.id),
          ),
        "the card",
      );
      expect(
        shown.content_attributes.items.map(
          (item: { title: string }) => item.title,
        ),
      ).toEqual(["Approve", "Reject"]);

      await ada.pick(Number(sent.id), shown.content_attributes.items[0]);
      const clicked = await eventually(
        () => actions.find((action) => action.threadId === thread),
        "the widget click",
      );
      expect(clicked).toMatchObject({
        actionId: "approve",
        value: "42",
        messageId: sent.id,
      });

      // What WhatsApp delivers for a tapped button: its title, quoting the card.
      await admin(`/conversations/${ada.conversationId}/messages`, {
        body: {
          content: "Reject",
          message_type: "incoming",
          content_attributes: { in_reply_to: Number(sent.id) },
        },
      });
      await eventually(
        () =>
          actions.find(
            (action) =>
              action.threadId === thread && action.actionId === "reject",
          ),
        "the reply as a click",
      );
      expect(seen(ada.conversationId)).toHaveLength(0);
    });

    it("sends a card's image as an attachment of the same message", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const thread = `chatwoot:${ada.inboxId}:${ada.contactId}:${ada.conversationId}`;

      await adapter.postMessage(
        thread,
        Card({ title: "Menu", imageUrl: `${e2e.url}/apple-icon.png` }),
      );

      const card = await eventually(
        async () =>
          (await ada.transcript()).find(
            (message) => message.message_type === 1,
          ),
        "the card",
      );
      expect(card.content).toBe("**Menu**");
      expect(card.attachments?.[0]).toMatchObject({ file_type: "image" });
    });

    it("answers a declared slash command in the conversation it came from", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      await ada.say("/status order 42");

      const reply = await eventually(
        async () =>
          (await ada.transcript()).find(
            (message) => message.message_type === 1,
          ),
        "the command's answer",
      );
      expect(reply.content).toBe("status: order 42");
      expect(seen(ada.conversationId)).toHaveLength(0);
    });

    it("runs a modal as a conversation in an API inbox", async () => {
      const ada = await customer(inbox.inbox_identifier, "Ada Lovelace");
      const lastReply = async () =>
        (await ada.transcript())
          .filter((message) => message.message_type === 1)
          .at(-1)?.content;

      await ada.say("/order");
      await eventually(
        async () => (await lastReply())?.includes("**Name**"),
        "the first question",
      );
      await ada.say("Ada");
      await eventually(
        async () => (await lastReply())?.includes("2. Large"),
        "the options",
      );
      await ada.say("2");

      await eventually(
        async () => (await lastReply()) === "Thanks Ada, l",
        "the submission",
      );
      expect(seen(ada.conversationId)).toHaveLength(0);
    });

    it("shows the same modal as a website widget's native form, and submits what the visitor fills in", async () => {
      const bea = await visitor(widget.website_token);
      await bea.say("/order");

      const form = await eventually(
        async () =>
          (await bea.transcript()).find(
            (message) => message.content_type === "form",
          ),
        "the form",
      );
      expect(
        form.content_attributes.items.map(
          (item: { name: string; type: string }) => [item.name, item.type],
        ),
      ).toEqual([
        ["name", "text"],
        ["size", "select"],
      ]);
      await bea.submit(form.id, [
        { name: "name", value: "Bea" },
        { name: "size", value: "s" },
      ]);

      await eventually(
        async () =>
          (await bea.transcript()).find(
            (message) => message.content === "Thanks Bea, s",
          ),
        "the submission's answer",
      );
      expect(submits.at(-1)?.values).toEqual({ name: "Bea", size: "s" });
    });

    it("refuses a delivery signed with a secret it was not given", async () => {
      const body = JSON.stringify({ event: "message_created" });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(
        server.url("/account").replace(e2e.hookHost, "127.0.0.1"),
        {
          method: "POST",
          body,
          headers: {
            "X-Chatwoot-Timestamp": timestamp,
            "X-Chatwoot-Signature": "sha256=" + "0".repeat(64),
          },
        },
      );
      expect(response.status).toBe(401);
      refused.length = 0;
    });
  },
);
