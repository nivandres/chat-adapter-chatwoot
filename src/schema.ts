import { z } from "zod";

export const CHATWOOT_MESSAGE_TYPES = [
  "incoming",
  "outgoing",
  "activity",
  "template",
] as const;
export const CHATWOOT_MESSAGE_STATUSES = [
  "sent",
  "delivered",
  "read",
  "failed",
] as const;
export const CHATWOOT_CONTENT_TYPES = [
  "text",
  "input_text",
  "input_textarea",
  "input_email",
  "input_select",
  "cards",
  "form",
  "article",
  "incoming_email",
  "input_csat",
  "integrations",
  "sticker",
  "voice_call",
] as const;
export const CHATWOOT_FILE_TYPES = [
  "image",
  "audio",
  "video",
  "file",
  "location",
  "fallback",
  "share",
  "story_mention",
  "contact",
  "ig_reel",
  "ig_post",
  "ig_story",
  "embed",
] as const;
export const CHATWOOT_CONVERSATION_STATUSES = [
  "open",
  "resolved",
  "pending",
  "snoozed",
] as const;
export const CHATWOOT_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const CHATWOOT_SENDER_TYPES = [
  "contact",
  "user",
  "agent_bot",
  "captain_assistant",
] as const;
/** Sender kinds whose messages are machine-authored. */
export const CHATWOOT_BOT_SENDER_TYPES = [
  "agent_bot",
  "captain_assistant",
] as const;

export type ChatwootMessageType = (typeof CHATWOOT_MESSAGE_TYPES)[number];
export type ChatwootMessageStatus = (typeof CHATWOOT_MESSAGE_STATUSES)[number];
export type ChatwootContentType = (typeof CHATWOOT_CONTENT_TYPES)[number];
export type ChatwootFileType = (typeof CHATWOOT_FILE_TYPES)[number];
export type ChatwootConversationStatus =
  (typeof CHATWOOT_CONVERSATION_STATUSES)[number];
export type ChatwootPriority = (typeof CHATWOOT_PRIORITIES)[number];
export type ChatwootSenderType = (typeof CHATWOOT_SENDER_TYPES)[number];

/**
 * Rails enums reach webhooks as labels and REST payloads as ordinals, so both
 * are accepted. A value a newer Chatwoot added passes through as it came: a
 * message webhook the adapter refuses hands an agent bot's conversation to a
 * human.
 */
const enumerated = <const T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .union([z.string(), z.int()])
    .transform((value): T[number] | (string & {}) =>
      typeof value === "number" ? (values[value] ?? String(value)) : value,
    );

/** Unix seconds in REST payloads, an ISO 8601 string in webhooks. */
export const ChatwootTimestampSchema = z.union([z.number(), z.string()]);
export type ChatwootTimestamp = z.infer<typeof ChatwootTimestampSchema>;

export function toDate(
  timestamp: ChatwootTimestamp | null | undefined,
): Date | undefined {
  if (timestamp == null) return undefined;
  const date = new Date(
    typeof timestamp === "number" ? timestamp * 1000 : timestamp,
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const attributes = z.record(z.string(), z.unknown());

export const ChatwootChangedAttributesSchema = z.array(
  z.record(
    z.string(),
    z.looseObject({ current_value: z.unknown(), previous_value: z.unknown() }),
  ),
);

export const ChatwootAccountSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
});

export const ChatwootInboxSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  channel_type: z.string().nullish(),
  channel_id: z.number().nullish(),
  avatar_url: z.string().nullish(),
  provider: z.string().nullish(),
});

/**
 * Message and conversation senders.
 *
 * Contacts are the only sender Chatwoot serializes without a `type`
 * discriminator, so an absent `type` means `"contact"`. The type is kept as a
 * free string rather than an enum: Chatwoot adds sender kinds over releases
 * — `captain_assistant` came with Captain — and an unknown one must not reject
 * the whole payload. {@link CHATWOOT_SENDER_TYPES} lists the known values.
 */
export const ChatwootSenderSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  type: z.string().default("contact"),
  available_name: z.string().nullish(),
  email: z.string().nullish(),
  identifier: z.string().nullish(),
  phone_number: z.string().nullish(),
  avatar: z.string().nullish(),
  avatar_url: z.string().nullish(),
  thumbnail: z.string().nullish(),
  availability_status: z.string().nullish(),
  blocked: z.boolean().nullish(),
  additional_attributes: attributes.nullish(),
  custom_attributes: attributes.nullish(),
});

export const ChatwootContactInboxSchema = z.looseObject({
  id: z.number().nullish(),
  contact_id: z.number().nullish(),
  inbox_id: z.number().nullish(),
  /** `GET /contacts/:id` nests the inbox instead of its ID. */
  inbox: ChatwootInboxSchema.nullish(),
  source_id: z.string().nullish(),
  hmac_verified: z.boolean().nullish(),
  pubsub_token: z.string().nullish(),
  created_at: ChatwootTimestampSchema.nullish(),
  updated_at: ChatwootTimestampSchema.nullish(),
});

export const ChatwootAttachmentSchema = z.looseObject({
  id: z.number(),
  message_id: z.number().nullish(),
  account_id: z.number().nullish(),
  file_type: enumerated(CHATWOOT_FILE_TYPES),
  extension: z.string().nullish(),
  content_type: z.string().nullish(),
  data_url: z.string().nullish(),
  thumb_url: z.string().nullish(),
  file_size: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  fallback_title: z.string().nullish(),
  coordinates_lat: z.number().nullish(),
  coordinates_long: z.number().nullish(),
  transcribed_text: z.string().nullish(),
});

/**
 * A conversation as Chatwoot serializes it. `id` is the account-scoped
 * `display_id` used by every conversation route, not the database primary key.
 */
export const ChatwootConversationSchema = z.looseObject({
  id: z.number(),
  inbox_id: z.number(),
  account_id: z.number().nullish(),
  /** Webhooks name the account here; REST payloads carry `account_id` instead. */
  account: ChatwootAccountSchema.nullish(),
  uuid: z.string().nullish(),
  channel: z.string().nullish(),
  status: enumerated(CHATWOOT_CONVERSATION_STATUSES).nullish(),
  priority: enumerated(CHATWOOT_PRIORITIES).nullish(),
  can_reply: z.boolean().nullish(),
  muted: z.boolean().nullish(),
  labels: z.array(z.string()).nullish(),
  unread_count: z.number().nullish(),
  additional_attributes: attributes.nullish(),
  custom_attributes: attributes.nullish(),
  contact_inbox: ChatwootContactInboxSchema.nullish(),
  meta: z
    .looseObject({
      // The REST partial nests the channel class here; the webhook presenter
      // puts it at the top level instead.
      channel: z.string().nullish(),
      sender: ChatwootSenderSchema.nullish(),
      assignee: ChatwootSenderSchema.nullish(),
      assignee_type: z.string().nullish(),
      team: z
        .looseObject({ id: z.number(), name: z.string().nullish() })
        .nullish(),
      hmac_verified: z.boolean().nullish(),
    })
    .nullish(),
  messages: z.array(z.unknown()).nullish(),
  changed_attributes: ChatwootChangedAttributesSchema.nullish(),
  created_at: ChatwootTimestampSchema.nullish(),
  updated_at: ChatwootTimestampSchema.nullish(),
  timestamp: ChatwootTimestampSchema.nullish(),
  last_activity_at: ChatwootTimestampSchema.nullish(),
  waiting_since: ChatwootTimestampSchema.nullish(),
  snoozed_until: ChatwootTimestampSchema.nullish(),
  first_reply_created_at: ChatwootTimestampSchema.nullish(),
  agent_last_seen_at: ChatwootTimestampSchema.nullish(),
  assignee_last_seen_at: ChatwootTimestampSchema.nullish(),
  contact_last_seen_at: ChatwootTimestampSchema.nullish(),
});

/**
 * A conversation nested inside a message.
 *
 * Webhooks nest the whole presenter payload, while `Message#push_event_data`
 * nests only `assignee_id`, `unread_count`, `last_activity_at` and the contact
 * inbox's `source_id`, so neither `id` nor `inbox_id` is guaranteed here.
 */
export const ChatwootNestedConversationSchema =
  ChatwootConversationSchema.extend({
    id: z.number().optional(),
    inbox_id: z.number().optional(),
    assignee_id: z.number().nullish(),
  });

/**
 * A message as Chatwoot serializes it.
 *
 * The same message reaches an adapter in two shapes: webhooks nest `account`,
 * `inbox` and `conversation` and label their enums, while REST payloads carry
 * `conversation_id` and ordinal enums. Both parse into this one schema.
 */
export const ChatwootMessageSchema = z.looseObject({
  id: z.number(),
  content: z.string().nullish(),
  message_type: enumerated(CHATWOOT_MESSAGE_TYPES),
  content_type: enumerated(CHATWOOT_CONTENT_TYPES).nullish(),
  content_attributes: attributes.nullish(),
  additional_attributes: attributes.nullish(),
  status: enumerated(CHATWOOT_MESSAGE_STATUSES).nullish(),
  private: z.boolean().default(false),
  source_id: z.string().nullish(),
  echo_id: z.string().nullish(),
  created_at: ChatwootTimestampSchema,
  inbox_id: z.number().nullish(),
  conversation_id: z.number().nullish(),
  account: ChatwootAccountSchema.nullish(),
  inbox: ChatwootInboxSchema.nullish(),
  conversation: ChatwootNestedConversationSchema.nullish(),
  sender: ChatwootSenderSchema.nullish(),
  attachments: z.array(ChatwootAttachmentSchema).nullish(),
});

export const ChatwootMessagesPageSchema = z.looseObject({
  payload: z.array(ChatwootMessageSchema).default([]),
  meta: attributes.nullish(),
});

export const ChatwootConversationsPageSchema = z.looseObject({
  data: z
    .looseObject({
      payload: z.array(ChatwootConversationSchema).default([]),
      meta: attributes.nullish(),
    })
    .nullish(),
  payload: z.array(ChatwootConversationSchema).nullish(),
});

export const ChatwootProfileSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  available_name: z.string().nullish(),
  email: z.string().nullish(),
  avatar_url: z.string().nullish(),
  type: z.string().nullish(),
});

export const ChatwootAgentSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  available_name: z.string().nullish(),
  email: z.string().nullish(),
  thumbnail: z.string().nullish(),
  role: z.string().nullish(),
});

export const ChatwootContactSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  identifier: z.string().nullish(),
  phone_number: z.string().nullish(),
  thumbnail: z.string().nullish(),
  avatar: z.string().nullish(),
  blocked: z.boolean().nullish(),
  account: ChatwootAccountSchema.nullish(),
  additional_attributes: attributes.nullish(),
  custom_attributes: attributes.nullish(),
  changed_attributes: ChatwootChangedAttributesSchema.nullish(),
  contact_inboxes: z.array(ChatwootContactInboxSchema).nullish(),
});

export const ChatwootContactableInboxSchema = z.looseObject({
  source_id: z.string().nullish(),
  inbox: ChatwootInboxSchema,
});

const ChatwootInboxEventSchema = z.looseObject({
  account: ChatwootAccountSchema.nullish(),
  channel: attributes.nullish(),
  changed_attributes: ChatwootChangedAttributesSchema.nullish(),
});

const ChatwootTypingEventSchema = z.looseObject({
  conversation: ChatwootConversationSchema,
  user: ChatwootSenderSchema.nullish(),
  // Passed through from the request untouched, so a string when a form sent it.
  is_private: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((value) => value === true || value === "true"),
});

const ChatwootWebwidgetEventSchema = z.looseObject({
  ...ChatwootContactInboxSchema.shape,
  contact: ChatwootContactSchema.nullish(),
  inbox: ChatwootInboxSchema.nullish(),
  account: ChatwootAccountSchema.nullish(),
  current_conversation: ChatwootConversationSchema.nullish(),
  event_info: attributes.nullish(),
});

/**
 * Every event an account webhook, an API inbox webhook or an agent bot can
 * receive. `conversation_opened` and `conversation_resolved` reach agent bots
 * only; the rest are the account webhook subscriptions.
 */
export const ChatwootWebhookPayloadSchema = z.discriminatedUnion("event", [
  ChatwootMessageSchema.extend({ event: z.literal("message_created") }),
  ChatwootMessageSchema.extend({ event: z.literal("message_updated") }),
  ChatwootConversationSchema.extend({
    event: z.literal("conversation_created"),
  }),
  ChatwootConversationSchema.extend({
    event: z.literal("conversation_updated"),
  }),
  ChatwootConversationSchema.extend({
    event: z.literal("conversation_status_changed"),
  }),
  ChatwootConversationSchema.extend({
    event: z.literal("conversation_opened"),
  }),
  ChatwootConversationSchema.extend({
    event: z.literal("conversation_resolved"),
  }),
  ChatwootTypingEventSchema.extend({
    event: z.literal("conversation_typing_on"),
  }),
  ChatwootTypingEventSchema.extend({
    event: z.literal("conversation_typing_off"),
  }),
  ChatwootContactSchema.extend({ event: z.literal("contact_created") }),
  ChatwootContactSchema.extend({ event: z.literal("contact_updated") }),
  ChatwootInboxEventSchema.extend({ event: z.literal("inbox_created") }),
  ChatwootInboxEventSchema.extend({ event: z.literal("inbox_updated") }),
  ChatwootWebwidgetEventSchema.extend({
    event: z.literal("webwidget_triggered"),
  }),
]);

/** Every event {@link ChatwootWebhookPayloadSchema} reads; any other is one a newer Chatwoot added. */
export const CHATWOOT_WEBHOOK_EVENTS = ChatwootWebhookPayloadSchema.options.map(
  (option) => option.shape.event.value,
);

export type ChatwootAccount = z.infer<typeof ChatwootAccountSchema>;
export type ChatwootInbox = z.infer<typeof ChatwootInboxSchema>;
export type ChatwootSender = z.infer<typeof ChatwootSenderSchema>;
export type ChatwootContactInbox = z.infer<typeof ChatwootContactInboxSchema>;
export type ChatwootAttachment = z.infer<typeof ChatwootAttachmentSchema>;
export type ChatwootConversation = z.infer<typeof ChatwootConversationSchema>;
export type ChatwootNestedConversation = z.infer<
  typeof ChatwootNestedConversationSchema
>;
export type ChatwootMessage = z.infer<typeof ChatwootMessageSchema>;
export type ChatwootMessagesPage = z.infer<typeof ChatwootMessagesPageSchema>;
export type ChatwootProfile = z.infer<typeof ChatwootProfileSchema>;
export type ChatwootAgent = z.infer<typeof ChatwootAgentSchema>;
export type ChatwootContact = z.infer<typeof ChatwootContactSchema>;
export type ChatwootContactableInbox = z.infer<
  typeof ChatwootContactableInboxSchema
>;
export type ChatwootChangedAttributes = z.infer<
  typeof ChatwootChangedAttributesSchema
>;
export type ChatwootWebhookPayload = z.infer<
  typeof ChatwootWebhookPayloadSchema
>;
export type ChatwootWebhookEvent = ChatwootWebhookPayload["event"];
