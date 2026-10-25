import { describe, expect, it } from "vitest";
import {
  ChatwootAttachmentSchema,
  ChatwootConversationSchema,
  ChatwootMessageSchema,
  ChatwootSenderSchema,
  ChatwootWebhookPayloadSchema,
  toDate,
} from "./schema";
import {
  AGENT_PUSH,
  CONTACT_SENDER,
  restMessage,
  webhookMessage,
} from "./test-utils";

describe("ChatwootSenderSchema", () => {
  it("defaults a sender without a type to a contact", () => {
    expect(ChatwootSenderSchema.parse(CONTACT_SENDER).type).toBe("contact");
  });

  it("keeps the discriminator when Chatwoot sends one", () => {
    expect(ChatwootSenderSchema.parse(AGENT_PUSH).type).toBe("user");
    expect(
      ChatwootSenderSchema.parse({ id: 9, name: "Bot", type: "agent_bot" })
        .type,
    ).toBe("agent_bot");
  });

  it("keeps unknown fields so new Chatwoot releases still parse", () => {
    const sender = ChatwootSenderSchema.parse({
      id: 1,
      name: "x",
      future_field: 42,
    });
    expect(sender.future_field).toBe(42);
  });
});

describe("ChatwootMessageSchema", () => {
  it("accepts the labelled enums a webhook sends", () => {
    const message = ChatwootMessageSchema.parse(webhookMessage());
    expect(message.message_type).toBe("incoming");
    expect(message.content_type).toBe("text");
    expect(message.created_at).toBe("2026-04-29T10:00:00.000Z");
  });

  it("accepts the ordinal enums a REST payload sends", () => {
    const message = ChatwootMessageSchema.parse(restMessage());
    expect(message.message_type).toBe("outgoing");
    expect(message.status).toBe("sent");
    expect(message.created_at).toBe(1777456860);
  });

  it("normalises every message_type ordinal", () => {
    const types = [0, 1, 2, 3].map(
      (ordinal) =>
        ChatwootMessageSchema.parse(restMessage({ message_type: ordinal }))
          .message_type,
    );
    expect(types).toEqual(["incoming", "outgoing", "activity", "template"]);
  });

  it("keeps a value a newer Chatwoot added, rather than rejecting the message", () => {
    const message = ChatwootMessageSchema.parse(
      webhookMessage({ content_type: "carousel", status: 9 }),
    );
    expect(message.content_type).toBe("carousel");
    expect(message.status).toBe("9");
    expect(
      ChatwootMessageSchema.parse(
        webhookMessage({
          attachments: [{ id: 1, file_type: "hologram", data_url: null }],
        }),
      ).attachments?.[0]?.file_type,
    ).toBe("hologram");
  });

  it("defaults private to false", () => {
    const { private: isPrivate } = ChatwootMessageSchema.parse(
      restMessage({ private: undefined }),
    );
    expect(isPrivate).toBe(false);
  });
});

describe("ChatwootConversationSchema", () => {
  it("parses the webhook conversation, which carries no account_id", () => {
    const conversation = ChatwootConversationSchema.parse(
      webhookMessage().conversation,
    );
    expect(conversation.id).toBe(300);
    expect(conversation.account_id).toBeUndefined();
    expect(conversation.status).toBe("open");
    expect(conversation.meta?.sender?.type).toBe("contact");
  });

  it("accepts unix seconds and floats for timestamps", () => {
    const conversation = ChatwootConversationSchema.parse(
      webhookMessage().conversation,
    );
    expect(toDate(conversation.created_at)?.toISOString()).toBe(
      "2026-04-29T09:50:00.000Z",
    );
    expect(toDate(conversation.updated_at)).toBeInstanceOf(Date);
  });
});

describe("ChatwootAttachmentSchema", () => {
  it("parses an image attachment without optional geometry", () => {
    const attachment = ChatwootAttachmentSchema.parse({
      id: 5,
      message_id: 3042,
      account_id: 2,
      file_type: "image",
      extension: "png",
      data_url: "https://chat.example.com/rails/active_storage/blobs/x/cat.png",
      thumb_url: "",
      file_size: 1024,
    });
    expect(attachment.file_type).toBe("image");
    expect(attachment.width).toBeUndefined();
  });

  it("parses a location attachment, which has no file", () => {
    const attachment = ChatwootAttachmentSchema.parse({
      id: 6,
      message_id: 3042,
      account_id: 2,
      file_type: "location",
      coordinates_lat: 1.5,
      coordinates_long: -2.5,
      fallback_title: "Office",
      data_url: null,
    });
    expect(attachment.file_type).toBe("location");
    expect(attachment.coordinates_lat).toBe(1.5);
  });
});

describe("ChatwootWebhookPayloadSchema", () => {
  it("discriminates on the event name", () => {
    const payload = ChatwootWebhookPayloadSchema.parse(webhookMessage());
    expect(payload.event).toBe("message_created");
    if (payload.event === "message_created")
      expect(payload.content).toBe("Hi there");
  });

  it("parses conversation lifecycle events", () => {
    for (const event of [
      "conversation_created",
      "conversation_updated",
      "conversation_status_changed",
      "conversation_opened",
      "conversation_resolved",
    ] as const) {
      const payload = ChatwootWebhookPayloadSchema.parse({
        event,
        ...webhookMessage().conversation,
      });
      expect(payload.event).toBe(event);
    }
  });

  it("parses typing events", () => {
    const payload = ChatwootWebhookPayloadSchema.parse({
      event: "conversation_typing_on",
      conversation: webhookMessage().conversation,
      user: AGENT_PUSH,
      is_private: false,
    });
    expect(payload.event).toBe("conversation_typing_on");
  });

  it("reads is_private as Chatwoot passes it on, a string from a form included", () => {
    const typing = (is_private: unknown) =>
      ChatwootWebhookPayloadSchema.parse({
        event: "conversation_typing_on",
        conversation: webhookMessage().conversation,
        user: CONTACT_SENDER,
        ...(is_private === undefined ? {} : { is_private }),
      });
    expect(typing("true")).toMatchObject({ is_private: true });
    expect(typing("false")).toMatchObject({ is_private: false });
    expect(typing(undefined)).toMatchObject({ is_private: false });
  });

  it("parses contact events", () => {
    const payload = ChatwootWebhookPayloadSchema.parse({
      event: "contact_updated",
      ...CONTACT_SENDER,
      changed_attributes: [
        { email: { current_value: "a@b.c", previous_value: null } },
      ],
    });
    expect(payload.event).toBe("contact_updated");
  });

  it("rejects an unknown event", () => {
    expect(
      ChatwootWebhookPayloadSchema.safeParse({ event: "nope" }).success,
    ).toBe(false);
  });
});

describe("toDate", () => {
  it("reads unix seconds, ISO strings and nothing at all", () => {
    expect(toDate(1777456800)?.toISOString()).toBe("2026-04-29T10:00:00.000Z");
    expect(toDate("2026-04-29T10:00:00.000Z")?.toISOString()).toBe(
      "2026-04-29T10:00:00.000Z",
    );
    expect(toDate(null)).toBeUndefined();
    expect(toDate("not a date")).toBeUndefined();
  });
});
