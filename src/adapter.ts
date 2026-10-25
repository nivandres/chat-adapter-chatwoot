import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
  downloadAttachment,
  extractCard,
  extractFiles,
  extractPostableAttachments,
} from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  LinkPreview,
  ModalElement,
  ListThreadsOptions,
  ListThreadsResult,
  Logger,
  MessageSubject,
  RawMessage,
  Root,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  UserInfo,
  WebhookOptions,
} from "chat";
import {
  ConsoleLogger,
  Message,
  NotImplementedError,
  StreamingMarkdownRenderer,
  isLinkNode,
  walkAst,
} from "chat";
import crypto from "node:crypto";
import { z } from "zod";
import {
  decodeActionValue,
  renderCard,
  type ChatwootSelectItem,
} from "./cards";
import {
  DEFAULT_MODAL_TEXTS,
  answerOf,
  createForm,
  currentField,
  flattenOptions,
  formItemsOf,
  fromTrigger,
  introOf,
  questionOf,
  submittedOf,
  triggerIdOf,
  type Form,
} from "./modals";
import { ChatwootFormatConverter } from "./format-converter";
import {
  ChatwootAgentSchema,
  ChatwootContactSchema,
  ChatwootContactableInboxSchema,
  ChatwootConversationSchema,
  ChatwootInboxSchema,
  ChatwootMessageSchema,
  ChatwootMessagesPageSchema,
  ChatwootProfileSchema,
  ChatwootWebhookPayloadSchema,
  toDate,
  CHATWOOT_BOT_SENDER_TYPES,
  CHATWOOT_WEBHOOK_EVENTS,
  type ChatwootAgent,
  type ChatwootAttachment,
  type ChatwootContact,
  type ChatwootConversation,
  type ChatwootMessage,
  type ChatwootSender,
  type ChatwootWebhookPayload,
} from "./schema";
import { ChatwootErrorCode } from "./types";
import type {
  ChatwootAdapterConfig,
  ChatwootAssignArgs,
  ChatwootModalTexts,
  ChatwootPriorityArgs,
  ChatwootRequest,
  ChatwootThreadId,
  ChatwootToggleStatusArgs,
} from "./types";

const DEFAULT_BASE_URL = "https://app.chatwoot.com";
/** `MessageFinder` caps `before` at 20 rows and `after` at 100. */
const PAGE_LIMITS = { backward: 20, forward: 100 } as const;
/** `Message::NUMBER_OF_PERMITTED_ATTACHMENTS` */
const MAX_ATTACHMENTS = 15;
/** `validates :content, length: { maximum: 150_000 }` */
const MAX_CONTENT_LENGTH = 150_000;
/** How long a message's answers, delete and last content are remembered, so a resend cannot replay them. */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a card's options answer a reply, as long as WhatsApp lets the bot write back. */
const CARD_TTL_MS = 24 * 60 * 60 * 1000;
/** Chat SDK's own dedupe window; the account webhook and an API inbox deliver a payload seconds apart. */
const EVENT_TTL_MS = 10 * 60 * 1000;
/** A modal left unanswered stops waiting for its answers. */
const FORM_TTL_MS = 24 * 60 * 60 * 1000;
/** Kaminari's default page, which `ConversationFinder` paginates conversations by. */
const CONVERSATIONS_PAGE_SIZE = 25;

/** Chatwoot signs with the time it sends, retries included, so an older signature is a replay. */
const DEFAULT_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
/** Far above any webhook Chatwoot sends, which carries one message and its conversation. */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A Chatwoot request or download that hangs longer than this fails instead of holding the caller. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Backoff before each retry of a GET that failed transiently. */
const RETRY_DELAYS_MS = [500, 1_000, 2_000];
/** A longer `Retry-After` is the caller's to wait out, not a webhook handler's. */
const MAX_RETRY_AFTER_MS = 5_000;

/** Chatwoot answers 401, not 403, when an agent bot reaches an agent-only endpoint. */
const BOT_FORBIDDEN = /not authorized for bots/i;

/** ActiveStorage redirects once to the storage service; a couple more is ample. */
const MAX_DOWNLOAD_REDIRECTS = 5;
/** Chatwoot's default `MAXIMUM_FILE_UPLOAD_SIZE`, the largest file it stores. */
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/**
 * Web widget inboxes reject anything outside `Attachment::ACCEPTABLE_FILE_TYPES`
 * plus `image/*`, `video/*` and `audio/*`, and a `FileUpload` without a
 * `mimeType` would otherwise upload as `application/octet-stream`.
 */
const MIME_TYPES: Record<string, string> = {
  "7z": "application/x-7z-compressed",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  odt: "application/vnd.oasis.opendocument.text",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rar: "application/vnd.rar",
  rtf: "application/rtf",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

const ATTACHMENT_TYPES: Record<string, Attachment["type"]> = {
  image: "image",
  ig_post: "image",
  ig_story: "image",
  story_mention: "image",
  audio: "audio",
  video: "video",
  ig_reel: "video",
};

export class ChatwootAdapter implements Adapter<
  ChatwootThreadId,
  ChatwootMessage
> {
  readonly name: string;
  userName: string;
  botUserId?: string;

  readonly accountId: number;

  private chat: ChatInstance | null = null;
  private logger: Logger;
  private readonly config: ChatwootAdapterConfig;
  private readonly converter = new ChatwootFormatConverter();
  private readonly base: string;
  private readonly origin: string;
  /** `baseUrl` without its trailing slash, so a subpath install keeps its prefix. */
  private readonly root: string;
  /** Where ActiveStorage serves files, the only paths outside the API that receive the token. */
  private readonly storage: string;
  private agentBot = false;

  constructor(config: ChatwootAdapterConfig) {
    if (
      typeof config.webhookSecret === "object" &&
      !config.webhookSecret.every(Boolean)
    )
      throw new ValidationError(
        "chatwoot",
        "webhookSecret must not contain an empty secret, which would accept any signature",
      );
    if (config.adapterName?.includes(":"))
      throw new ValidationError(
        "chatwoot",
        `adapterName must not contain ":": ${config.adapterName}`,
      );

    this.config = { ...config, baseUrl: config.baseUrl ?? DEFAULT_BASE_URL };
    this.name = config.adapterName ?? "chatwoot";
    this.userName = config.userName ?? this.name;
    this.accountId = config.accountId;
    this.logger = config.logger ?? new ConsoleLogger("info").child(this.name);
    this.base = `/accounts/${config.accountId}`;
    const baseUrl = new URL(this.config.baseUrl!);
    this.origin = baseUrl.origin;
    this.root = `${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, "")}`;
    this.storage = `${this.root}/rails/active_storage/`;
  }

  /**
   * Issue a Chatwoot Application API request, relative to `/api/v1`.
   *
   * Non-2xx responses become the matching `@chat-adapter/shared` error, so a
   * rejected token, a missing conversation and a rate limit are distinguishable
   * without reading status codes. A timeout or a 5xx is a `NetworkError`. A GET
   * that fails transiently — on the network, a 5xx, or a 429 whose
   * `Retry-After` is a few seconds — is retried with backoff; nothing else is,
   * since Chatwoot cannot tell a retried write from a new one.
   *
   * @example
   * ```typescript
   * const labels = await chatwoot.fetch(`/accounts/1/conversations/7/labels`);
   * ```
   */
  async fetch<T = unknown>(
    endpoint: string,
    request: ChatwootRequest = {},
  ): Promise<T> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = new URL(`${this.root}/api/v1${path}`);
    for (const [key, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));

    const method =
      request.method ?? (request.body === undefined ? "GET" : "POST");
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.call<T>(method, url, request.body);
      } catch (error) {
        const delay = method === "GET" ? retryDelay(error, attempt) : undefined;
        if (delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async call<T>(method: string, url: URL, body: unknown): Promise<T> {
    const multipart = body instanceof FormData || body instanceof Blob;
    const fail = (error: Error): never => {
      throw new NetworkError(
        this.name,
        `Failed to reach ${url.href}: ${error.message}`,
        error,
      );
    };
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        api_access_token: this.config.accessToken,
        ...(body !== undefined && !multipart
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: multipart
        ? (body as FormData | Blob)
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    }).catch(fail);

    const text = await response.text().catch(fail);
    if (!response.ok) throw this.requestError(method, url, response, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdapterError(
        `Chatwoot returned a non-JSON response for ${method} ${url.pathname}`,
        this.name,
        ChatwootErrorCode.INVALID_RESPONSE,
      );
    }
  }

  private requestError(
    method: string,
    url: URL,
    response: Response,
    body: string,
  ): AdapterError {
    const detail = body.slice(0, 500);
    const route = `${method} ${url.pathname}`;
    switch (response.status) {
      case 401:
        if (BOT_FORBIDDEN.test(detail))
          return new PermissionError(
            this.name,
            `call ${route}`,
            "agent access token",
          );
        return new AuthenticationError(
          this.name,
          `Chatwoot rejected the access token for ${route}`,
        );
      case 403:
        return new PermissionError(
          this.name,
          `call ${route}`,
          this.agentBot ? "agent token" : undefined,
        );
      case 404:
        return new ResourceNotFoundError(this.name, "resource", url.pathname);
      case 422:
        return new ValidationError(
          this.name,
          `Chatwoot rejected ${route}: ${detail}`,
        );
      case 429:
        return new AdapterRateLimitError(
          this.name,
          retryAfterSeconds(response.headers.get("retry-after")),
        );
      default: {
        const message = `${route} failed with status ${response.status}${detail ? `: ${detail}` : ""}`;
        return response.status >= 500
          ? new NetworkError(this.name, message)
          : new AdapterError(
              message,
              this.name,
              ChatwootErrorCode.REQUEST_FAILED,
            );
      }
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, route: string): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new AdapterError(
      `Unexpected Chatwoot response for ${route}: ${z.prettifyError(result.error)}`,
      this.name,
      ChatwootErrorCode.INVALID_RESPONSE,
    );
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(this.name);

    if (!this.config.webhookSecret?.length)
      this.logger.warn(
        this.config.allowUnverifiedWebhooks
          ? "No webhookSecret configured. Incoming webhooks are accepted unverified."
          : "No webhookSecret configured. Incoming webhooks are refused until one is set.",
      );

    try {
      const profile = this.parse(
        ChatwootProfileSchema,
        await this.fetch("/profile"),
        "GET /profile",
      );
      this.botUserId = String(profile.id);
      if (!this.config.userName)
        this.userName = profile.available_name ?? profile.name ?? this.userName;
      this.logger.info("Authenticated with Chatwoot", {
        accountId: this.accountId,
        userId: this.botUserId,
        userName: this.userName,
      });
    } catch (error) {
      if (!(error instanceof PermissionError)) throw error;
      // /profile is outside Chatwoot's BOT_ACCESSIBLE_ENDPOINTS, so an agent
      // bot is refused here and cannot learn its own ID.
      this.agentBot = true;
      this.logger.warn(
        "Access token belongs to an agent bot. Listing messages, deleting, read receipts, mute, contacts, " +
          "inboxes and agents are rejected by Chatwoot; use an agent access token for the full adapter.",
      );
    }
  }

  encodeThreadId(platformData: ChatwootThreadId): string {
    const { inboxId, contactId, conversationId } = platformData;
    return `${this.name}:${inboxId}:${contactId}:${conversationId}`;
  }

  decodeThreadId(threadId: string): ChatwootThreadId {
    const parts = threadId.split(":");
    if (parts.length !== 4 || parts[0] !== this.name)
      throw new ValidationError(
        this.name,
        `Invalid Chatwoot thread ID: ${threadId}`,
      );

    const [inbox, contact, conversation] = parts.slice(1);
    return {
      inboxId: this.toId(inbox, `inbox in thread ID ${threadId}`),
      // 0 marks a payload that never named the contact; it is not used in a route.
      contactId:
        contact === "0"
          ? 0
          : this.toId(contact, `contact in thread ID ${threadId}`),
      conversationId: this.toId(
        conversation,
        `conversation in thread ID ${threadId}`,
      ),
    };
  }

  /** Chatwoot IDs are positive integers; `Number` alone would accept "" and 1.5. */
  private toId(
    value: string | number | null | undefined,
    label: string,
  ): number {
    const id = Number(value);
    if (value === "" || !Number.isInteger(id) || id <= 0)
      throw new ValidationError(
        this.name,
        `Invalid Chatwoot ${label}: ${String(value)}`,
      );
    return id;
  }

  channelIdFromThreadId(threadId: string): string {
    return `${this.name}:${this.decodeThreadId(threadId).inboxId}`;
  }

  /** Every Chatwoot conversation is a one-to-one thread between a contact and the account. */
  isDM(): boolean {
    return true;
  }

  verifySignature(
    rawBody: string,
    timestamp: string,
    receivedSignature: string,
    secret: string,
  ): boolean {
    const expected = Buffer.from(
      `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`,
    );
    const received = Buffer.from(receivedSignature);
    return (
      expected.length === received.length &&
      crypto.timingSafeEqual(expected, received)
    );
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    const secrets = [this.config.webhookSecret ?? []].flat().filter(Boolean);
    const signature = request.headers.get("X-Chatwoot-Signature");
    const timestamp = request.headers.get("X-Chatwoot-Timestamp");

    // Checked before the body is read, so an unsigned flood is never buffered.
    if (secrets.length) {
      if (!signature || !timestamp)
        return new Response("Missing signature", { status: 401 });
      const tolerance =
        this.config.timestampToleranceMs ?? DEFAULT_TIMESTAMP_TOLERANCE_MS;
      if (!(Math.abs(Date.now() - Number(timestamp) * 1000) <= tolerance))
        return new Response("Stale signature", { status: 401 });
    } else if (!this.config.allowUnverifiedWebhooks)
      return new Response("No webhook secret configured", { status: 401 });

    const bytes = await readBody(
      request,
      this.config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    );
    if (bytes === null)
      return new Response("Payload too large", { status: 413 });
    const body = bytes.toString("utf8");
    if (
      secrets.length &&
      !secrets.some((secret) =>
        this.verifySignature(body, timestamp!, signature!, secret),
      )
    )
      return new Response("Invalid signature", { status: 401 });

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      this.logger.error("Failed to parse webhook payload as JSON", { error });
      return new Response("Invalid JSON", { status: 400 });
    }

    const payload = ChatwootWebhookPayloadSchema.safeParse(json);
    if (!payload.success) {
      // Chatwoot counts anything but a 2xx as a failed delivery, so an event a
      // newer release added is acknowledged and left alone.
      const event = z.object({ event: z.string() }).safeParse(json).data?.event;
      if (
        event &&
        !(CHATWOOT_WEBHOOK_EVENTS as readonly string[]).includes(event)
      ) {
        this.logger.debug("Ignoring an unknown webhook event", { event });
        return new Response("OK", { status: 200 });
      }
      this.logger.error("Failed to validate webhook payload", {
        error: z.prettifyError(payload.error),
      });
      return new Response("Invalid payload", { status: 400 });
    }

    // The account webhook and an API inbox deliver the same payload, each
    // under its own delivery ID, so the payload itself is claimed.
    if (
      this.chat &&
      !(await this.claim(this.chat, `event:${digest(body)}`, EVENT_TTL_MS))
    )
      return new Response("OK", { status: 200 });
    this.dispatch(payload.data, options);
    return new Response("OK", { status: 200 });
  }

  private dispatch(
    payload: ChatwootWebhookPayload,
    options?: WebhookOptions,
  ): void {
    // Thread IDs come from the payload while replies go to the configured
    // account, so another account's message would be answered in this one.
    // Every event names its account, a typing event through its conversation;
    // a message that names none is not trusted to be this account's.
    const { account } =
      payload.event === "conversation_typing_on" ||
      payload.event === "conversation_typing_off"
        ? payload.conversation
        : payload;
    const message =
      payload.event === "message_created" ||
      payload.event === "message_updated";
    if (account ? account.id !== this.accountId : message) {
      this.logger.warn("Ignoring an event from another Chatwoot account", {
        event: payload.event,
        accountId: account?.id,
      });
      return;
    }

    const chat = this.chat;
    if (!chat)
      this.logger.warn(
        "Received a webhook before initialize(), no handlers will run",
      );
    else if (payload.event === "message_created")
      this.settle(
        this.dispatchCreated(chat, payload, options),
        payload.event,
        options,
      );
    else if (payload.event === "message_updated")
      this.settle(
        this.dispatchUpdate(chat, payload, options),
        payload.event,
        options,
      );

    const onEvent = this.config.onEvent;
    if (onEvent)
      this.settle(Promise.resolve(onEvent(payload)), "onEvent", options);
  }

  /** Keeps a rejected handler off the process's unhandled rejections either way. */
  private settle(
    task: Promise<unknown>,
    label: string,
    options?: WebhookOptions,
  ): void {
    const guarded = task.catch((error: unknown) =>
      this.logger.error(`Failed to handle ${label}`, { error }),
    );
    options?.waitUntil?.(guarded);
  }

  private async dispatchCreated(
    chat: ChatInstance,
    payload: ChatwootMessage,
    options?: WebhookOptions,
  ): Promise<void> {
    if (!this.receives(payload)) return;
    const threadId = this.threadIdOf(payload);
    // Recorded so that a later status-only update is not read as an edit.
    await this.recordContent(chat, payload);
    const user = this.authorOf(payload.sender);
    if (
      payload.message_type === "incoming" &&
      !payload.private &&
      ((await this.answer(chat, payload, threadId, user, options)) ||
        (await this.command(chat, payload, threadId, user, options)))
    )
      return;
    const answer = await this.cardAnswer(chat, payload, threadId);
    if (answer) {
      if (!(await this.claim(chat, `answered:${payload.id}`))) return;
      const { actionId, value } = decodeActionValue(answer.item.value);
      await chat.processAction(
        {
          adapter: this,
          actionId,
          value,
          messageId: String(answer.cardId),
          threadId,
          raw: payload,
          triggerId: triggerIdOf(threadId, user.userId),
          user,
        },
        options,
      );
      return;
    }
    await chat.processMessage(
      this,
      threadId,
      this.parseMessage(payload, threadId),
      options,
    );
  }

  /**
   * Chatwoot has no edit or delete event: a delete rewrites the message and
   * flags `content_attributes.deleted`, and an answered `input_select` patches
   * `content_attributes.submitted_values`. Both arrive as `message_updated`.
   */
  private async dispatchUpdate(
    chat: ChatInstance,
    payload: ChatwootMessage,
    options?: WebhookOptions,
  ): Promise<void> {
    const threadId = this.threadIdOf(payload);
    const attributes = payload.content_attributes ?? {};

    // `content_attributes.deleted` stays set forever, so every later update
    // would replay the delete. Chatwoot also replaces the content with a
    // placeholder, which is not the message that was removed, so no
    // `previousMessage` is offered.
    if (attributes.deleted === true) {
      if (!(await this.claim(chat, `deleted:${payload.id}`))) return;
      await chat.processMessageDeleted(
        {
          adapter: this,
          channelId: this.channelIdFromThreadId(threadId),
          threadId,
          messageId: String(payload.id),
          raw: payload,
        },
        options,
      );
      return;
    }

    const user = this.authorOf(payload.conversation?.meta?.sender);
    if (payload.content_type === "form" && attributes.submitted_values) {
      const form = await this.recall<Form>(
        chat,
        this.formKey(threadId, user.userId),
      );
      const values =
        form?.messageId === payload.id
          ? submittedOf(form, attributes.submitted_values)
          : undefined;
      if (form && values && (await this.claim(chat, `submitted:${payload.id}`)))
        await this.submit(chat, threadId, user, { ...form, values }, payload);
      return;
    }

    const answers = submittedActionValues(payload);
    if (answers.length) {
      // A contact can patch `submitted_values` through Chatwoot's public API,
      // so only an option this adapter offered on this card, here, is a pick.
      const items = await this.recall<ChatwootSelectItem[]>(
        chat,
        this.cardKey(threadId, payload.id),
      );
      for (const answer of answers) {
        if (
          !items?.some((item) => item.value === answer) ||
          !(await this.claim(chat, `answered:${payload.id}:${answer}`))
        )
          continue;
        const { actionId, value } = decodeActionValue(answer);
        await chat.processAction(
          {
            adapter: this,
            actionId,
            value,
            messageId: String(payload.id),
            threadId,
            raw: payload,
            triggerId: triggerIdOf(threadId, user.userId),
            user,
          },
          options,
        );
      }
      return;
    }

    // Chatwoot fires `message_updated` for any change, a delivery status
    // included, and sends no `changed_attributes` for messages. Only content
    // that differs from what the message last held is therefore an edit.
    // Webhooks are not delivered in order either, so the `source_id` a channel
    // sets right after sending can arrive first: a message not seen yet has no
    // earlier content to have been edited from.
    if (!this.receives(payload) || !(await this.recordContent(chat, payload)))
      return;

    const message = this.parseMessage(payload, threadId);
    message.metadata.edited = true;
    await chat.processMessageUpdated(
      { adapter: this, threadId, message },
      options,
    );
  }

  /**
   * Only the web widget reports a pick as `submitted_values`. Every other
   * channel turns it into a new incoming message: WhatsApp with the option's
   * title, quoting the card; Facebook with the title; Telegram and LINE with
   * its value. A message matching an option of the card it quotes, or of the
   * conversation's latest one, is that pick.
   */
  private async cardAnswer(
    chat: ChatInstance,
    message: ChatwootMessage,
    threadId: string,
  ): Promise<{ cardId: number; item: ChatwootSelectItem } | undefined> {
    const content = message.content?.trim();
    if (message.message_type !== "incoming" || message.private || !content)
      return undefined;
    const quoted = Number(message.content_attributes?.in_reply_to);
    const cardId =
      quoted ||
      (await this.recall<number>(chat, this.cardKey(threadId, "latest")));
    if (!cardId) return undefined;
    const items = await this.recall<ChatwootSelectItem[]>(
      chat,
      this.cardKey(threadId, cardId),
    );
    const item = items?.find(
      ({ title, value }) =>
        value === content ||
        title.trim().toLowerCase() === content.toLowerCase(),
    );
    return item && { cardId, item };
  }

  /** Scoped to the account and the conversation, so a card answers only where it was sent. */
  private cardKey(threadId: string, card: number | "latest"): string {
    return `${this.name}:card:${this.accountId}:${this.decodeThreadId(threadId).conversationId}:${card}`;
  }

  /** Never fails the send: the card is out, only its answers are lost. */
  private async rememberCard(
    threadId: string,
    cardId: number,
    items: ChatwootSelectItem[],
  ): Promise<void> {
    try {
      const state = this.chat?.getState();
      await state?.set(this.cardKey(threadId, cardId), items, CARD_TTL_MS);
      await state?.set(this.cardKey(threadId, "latest"), cardId, CARD_TTL_MS);
    } catch (error) {
      this.logger.warn("Could not record a card's options", { error });
    }
  }

  /** Never fails the webhook: without the state adapter, a card's or a form's answers are only lost. */
  private async recall<T>(chat: ChatInstance, key: string): Promise<T | null> {
    try {
      return await chat.getState().get<T>(key);
    } catch (error) {
      this.logger.warn("Could not read from the state adapter", {
        error,
        key,
      });
      return null;
    }
  }

  /**
   * Claim a webhook fact once, across every process sharing the state adapter.
   * Returns true the first time, and again if the state adapter is unavailable,
   * so an outage never silently drops an event.
   */
  private async claim(
    chat: ChatInstance,
    key: string,
    ttlMs = CLAIM_TTL_MS,
  ): Promise<boolean> {
    try {
      return await chat
        .getState()
        .setIfNotExists(`${this.name}:${key}`, true, ttlMs);
    } catch (error) {
      this.logger.warn("Could not claim a webhook key, handling it anyway", {
        error,
        key,
      });
      return true;
    }
  }

  /**
   * Record the content a message holds now, and report whether it differs from
   * the content last seen. Never fails the webhook: without the state adapter
   * nothing reads as an edit.
   */
  private async recordContent(
    chat: ChatInstance,
    message: ChatwootMessage,
  ): Promise<boolean> {
    const key = `${this.name}:content:${message.id}`;
    const content = digest(message.content ?? "");
    try {
      const state = chat.getState();
      const previous = await state.get<string>(key);
      await state.set(key, content, CLAIM_TTL_MS);
      return previous !== null && previous !== content;
    } catch (error) {
      this.logger.warn("Could not record a message's content", { error, key });
      return false;
    }
  }

  private formKey(threadId: string, userId: string): string {
    return `${this.name}:form:${this.accountId}:${this.decodeThreadId(threadId).conversationId}:${userId}`;
  }

  private texts(): ChatwootModalTexts {
    return { ...DEFAULT_MODAL_TEXTS, ...this.config.modalTexts };
  }

  /**
   * Show the fields still to ask: as a native form when the conversation is a
   * website widget's and every one maps onto it, else the first as a question.
   */
  private async present(
    threadId: string,
    userId: string,
    form: Form,
    lead: string,
    hint?: string,
  ): Promise<void> {
    const chat = this.chat;
    if (!chat)
      throw new ValidationError(
        this.name,
        "A modal needs Chat to be initialized.",
      );
    const key = this.formKey(threadId, userId);
    const items = formItemsOf(form);
    const { conversationId } = this.decodeThreadId(threadId);
    const conversation =
      items && (await this.fetchConversation(conversationId));
    if (
      items &&
      (conversation?.channel ?? conversation?.meta?.channel) ===
        "Channel::WebWidget"
    ) {
      const route = `${this.base}/conversations/${conversationId}/messages`;
      const sent = this.parse(
        ChatwootMessageSchema,
        await this.fetch(route, {
          body: {
            content: lead,
            message_type: "outgoing",
            content_type: "form",
            content_attributes: {
              items,
              ...(form.submitLabel ? { button_label: form.submitLabel } : {}),
            },
          },
        }),
        `POST ${route}`,
      );
      await chat
        .getState()
        .set(key, { ...form, messageId: sent.id }, FORM_TTL_MS);
      return;
    }
    const field = currentField(form);
    await chat.getState().set(key, form, FORM_TTL_MS);
    await this.postMessage(
      threadId,
      [
        lead,
        hint && `_${hint}_`,
        field && questionOf(field, form, this.texts()),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  /** A contact's reply while a conversational modal is open answers it, before anything else sees it. */
  private async answer(
    chat: ChatInstance,
    payload: ChatwootMessage,
    threadId: string,
    user: Author,
    options?: WebhookOptions,
  ): Promise<boolean> {
    const key = this.formKey(threadId, user.userId);
    const form = await this.recall<Form>(chat, key);
    const field =
      form && form.messageId === undefined ? currentField(form) : undefined;
    if (!form || !field) return false;
    const state = chat.getState();
    const texts = this.texts();
    const text = payload.content?.trim() ?? "";
    if (
      text.toLowerCase() === (form.closeLabel ?? texts.cancel).toLowerCase()
    ) {
      await state.delete(key);
      await this.postMessage(threadId, texts.cancelled);
      if (form.notifyOnClose)
        chat.processModalClose(
          {
            adapter: this,
            callbackId: form.callbackId,
            privateMetadata: form.privateMetadata,
            raw: payload,
            user,
            viewId: form.viewId,
          },
          form.contextId,
          options,
        );
      return true;
    }
    const answer = answerOf(field, form, text, texts);
    if ("search" in answer) {
      const found = flattenOptions(
        await chat.processOptionsLoad({
          actionId: field.id,
          adapter: this,
          query: answer.search,
          raw: payload,
          user,
        }),
      );
      const next = { ...form, found: found.length ? found : undefined };
      await state.set(key, next, FORM_TTL_MS);
      const question = questionOf(field, next, texts);
      await this.postMessage(
        threadId,
        found.length ? question : `${texts.noResults}\n\n${question}`,
      );
      return true;
    }
    if ("error" in answer) {
      await this.postMessage(
        threadId,
        `${answer.error}\n\n${questionOf(field, form, texts)}`,
      );
      return true;
    }
    const { [field.id]: _previous, ...rest } = form.values;
    const next: Form = {
      ...form,
      found: undefined,
      pending: form.pending.slice(1),
      values:
        answer.value === undefined
          ? rest
          : { ...rest, [field.id]: answer.value },
    };
    const following = currentField(next);
    if (!following) {
      await this.submit(chat, threadId, user, next, payload);
      return true;
    }
    await state.set(key, next, FORM_TTL_MS);
    await this.postMessage(threadId, questionOf(following, next, texts));
    return true;
  }

  /** Hand a completed modal to `onModalSubmit`, asking again what it rejects and opening what it returns. */
  private async submit(
    chat: ChatInstance,
    threadId: string,
    user: Author,
    form: Form,
    raw: ChatwootMessage,
  ): Promise<void> {
    await chat.getState().delete(this.formKey(threadId, user.userId));
    const response = await chat.processModalSubmit(
      {
        adapter: this,
        callbackId: form.callbackId,
        privateMetadata: form.privateMetadata,
        raw,
        user,
        values: form.values,
        viewId: form.viewId,
      },
      form.contextId,
    );
    if (response?.action === "errors") {
      const pending = form.fields
        .map(({ id }) => id)
        .filter((id) => id in response.errors);
      if (pending.length)
        await this.present(
          threadId,
          user.userId,
          { ...form, messageId: undefined, pending },
          Object.values(response.errors).join("\n"),
        );
    } else if (response?.action === "update" || response?.action === "push") {
      const viewId =
        response.action === "update" ? form.viewId : crypto.randomUUID();
      await this.present(
        threadId,
        user.userId,
        createForm(response.modal, viewId, form.contextId),
        introOf(response.modal),
        this.texts().cancelHint,
      );
    }
  }

  /** Chatwoot has no slash commands, so a contact's message naming a declared one becomes one. */
  private async command(
    chat: ChatInstance,
    payload: ChatwootMessage,
    threadId: string,
    user: Author,
    options?: WebhookOptions,
  ): Promise<boolean> {
    const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(
      payload.content?.trim() ?? "",
    );
    const command =
      match &&
      this.config.slashCommands?.find(
        (name) => name.toLowerCase() === match[1]!.toLowerCase(),
      );
    if (!command) return false;
    // `event.channel.post()` posts to the channel ID, so it names this
    // conversation rather than its inbox.
    if (await this.claim(chat, `command:${payload.id}`))
      chat.processSlashCommand(
        {
          adapter: this,
          channelId: threadId,
          command,
          raw: payload,
          text: match[2] ?? "",
          triggerId: triggerIdOf(threadId, user.userId),
          user,
        },
        options,
      );
    return true;
  }

  /** Contacts' messages reach the handlers; other agents' replies and private notes only when opted in. */
  private receives(message: ChatwootMessage): boolean {
    if (message.private) return this.config.receivePrivateNotes ?? false;
    return (
      message.message_type === "incoming" ||
      (this.config.receiveAgentMessages ?? false)
    );
  }

  /**
   * Normalise a Chatwoot message, from either a webhook or a REST payload.
   *
   * The payload is validated first, so labelled and ordinal enums both work and
   * `message.raw` always reads the same way. `threadId` is derived from the
   * payload when omitted, which needs the nested `conversation` a webhook
   * carries; pass it explicitly for REST payloads.
   */
  parseMessage(
    raw: ChatwootMessage,
    threadId?: string,
  ): Message<ChatwootMessage> {
    const message = this.parse(ChatwootMessageSchema, raw, "parseMessage");
    const content = message.content || describeAttachments(message.attachments);
    const formatted = this.converter.toAst(content);
    const author = this.authorOf(message.sender);
    // An agent token posts as a `user`, which is no bot to Chatwoot but is one
    // to Chat SDK, whose own sent messages read `isBot: true, isMe: true`.
    if (this.isSelf(message)) author.isMe = author.isBot = true;
    if (message.message_type === "activity") author.isSystem = true;

    return new Message<ChatwootMessage>({
      id: String(message.id),
      threadId: threadId ?? this.threadIdOf(message),
      text: this.converter.extractPlainText(content),
      formatted,
      raw: message,
      author,
      metadata: {
        dateSent: toDate(message.created_at) ?? new Date(),
        edited: false,
      },
      attachments: (message.attachments ?? []).map((attachment) =>
        this.toAttachment(attachment),
      ),
      links: linksOf(formatted),
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ChatwootMessage>> {
    return this.send(threadId, message, false);
  }

  /**
   * Post a private note, visible to the account's agents and never delivered to
   * the contact. Mentions only notify from here — see {@link chatwootMention}.
   */
  async postPrivateNote(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ChatwootMessage>> {
    return this.send(threadId, message, true);
  }

  /** Post a message quoting another one, using Chatwoot's `in_reply_to`. */
  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ChatwootMessage>> {
    return this.send(
      threadId,
      message,
      false,
      this.toId(messageId, "message ID"),
    );
  }

  private async send(
    threadId: string,
    message: AdapterPostableMessage,
    isPrivate: boolean,
    inReplyTo?: number,
  ): Promise<RawMessage<ChatwootMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const card = extractCard(message);
    const rendered = card ? renderCard(card) : null;
    const content = trimTrailing(
      rendered ? rendered.content : this.converter.renderPostable(message),
    );
    // A private note reaches no contact, so its card offers nothing to pick.
    const items = isPrivate ? [] : (rendered?.items ?? []);

    if (content.length > MAX_CONTENT_LENGTH)
      throw new ValidationError(
        this.name,
        `Message content is ${content.length} characters, Chatwoot allows ${MAX_CONTENT_LENGTH}`,
      );

    const uploads = await this.collectUploads(message, rendered?.images ?? []);
    const attributes: Record<string, unknown> = {};
    if (items.length) attributes.items = items;
    if (inReplyTo !== undefined) attributes.in_reply_to = inReplyTo;

    const fields = {
      content,
      message_type: "outgoing",
      private: isPrivate,
      content_type: items.length ? "input_select" : "text",
      ...(Object.keys(attributes).length
        ? { content_attributes: attributes }
        : {}),
    };

    const route = `${this.base}/conversations/${conversationId}/messages`;
    const response = await this.fetch(route, {
      body: toRequestBody(fields, uploads),
    });
    const raw = this.parse(ChatwootMessageSchema, response, `POST ${route}`);
    if (items.length) await this.rememberCard(threadId, raw.id, items);

    return { id: String(raw.id), raw, threadId };
  }

  /**
   * Chatwoot has no message edit API — the dashboard cannot edit a sent message
   * either — so streaming buffers instead of editing, and this always throws.
   */
  async editMessage(): Promise<RawMessage<ChatwootMessage>> {
    throw new NotImplementedError(
      "Chatwoot has no message edit API. Delete the message and post a new one.",
      "editMessage",
    );
  }

  /** Chatwoot replaces the content with a deleted placeholder and drops its attachments. */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    const id = this.toId(messageId, "message ID");
    await this.fetch(
      `${this.base}/conversations/${conversationId}/messages/${id}`,
      {
        method: "DELETE",
      },
    );
  }

  /**
   * An agent bot token cannot list messages, so `fetchMessages` answers empty
   * and Chat SDK serves the history it keeps instead.
   */
  get persistThreadHistory(): boolean {
    return this.agentBot;
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<ChatwootMessage>> {
    if (this.agentBot) return { messages: [] };
    const { conversationId } = this.decodeThreadId(threadId);
    const direction = options?.direction ?? "backward";
    const limit = Math.max(
      1,
      Math.min(
        options?.limit ?? PAGE_LIMITS[direction],
        PAGE_LIMITS[direction],
      ),
    );
    const cursor = options?.cursor;

    const route = `${this.base}/conversations/${conversationId}/messages`;
    const response = await this.fetch(route, {
      query:
        direction === "forward" ? { after: cursor ?? 0 } : { before: cursor },
    });
    const { payload } = this.parse(
      ChatwootMessagesPageSchema,
      response,
      `GET ${route}`,
    );

    // Chatwoot answers oldest-first either way; keep the end of the window the
    // cursor moves away from.
    const page =
      direction === "forward" ? payload.slice(0, limit) : payload.slice(-limit);
    const edge = direction === "forward" ? page.at(-1) : page.at(0);

    return {
      messages: page.map((message) => this.parseMessage(message, threadId)),
      nextCursor: page.length === limit && edge ? String(edge.id) : undefined,
    };
  }

  async fetchMessage(
    threadId: string,
    messageId: string,
  ): Promise<Message<ChatwootMessage> | null> {
    const { conversationId } = this.decodeThreadId(threadId);
    const id = this.toId(messageId, "message ID");

    const route = `${this.base}/conversations/${conversationId}/messages`;
    // `MessageFinder#messages_between` is `id >= after AND id < before`.
    const response = await this.fetch(route, {
      query: { after: id, before: id + 1 },
    });
    const { payload } = this.parse(
      ChatwootMessagesPageSchema,
      response,
      `GET ${route}`,
    );
    const found = payload.find((message) => message.id === id);

    return found ? this.parseMessage(found, threadId) : null;
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { conversationId } = this.decodeThreadId(threadId);
    const conversation = await this.fetchConversation(conversationId);

    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: true,
      metadata: {
        conversationId: conversation.id,
        inboxId: conversation.inbox_id,
        // Chatwoot's channel class, e.g. "Channel::WebWidget". The inbox name
        // is not part of a conversation payload — read it from fetchChannelInfo.
        channel: conversation.channel ?? conversation.meta?.channel,
        status: conversation.status,
        priority: conversation.priority,
        labels: conversation.labels ?? [],
        unreadCount: conversation.unread_count,
        canReply: conversation.can_reply,
        muted: conversation.muted,
        uuid: conversation.uuid,
        contact: conversation.meta?.sender,
        assignee: conversation.meta?.assignee,
      },
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const inboxId = this.inboxIdOf(channelId);
    const route = `${this.base}/inboxes/${inboxId}`;
    const inbox = this.parse(
      ChatwootInboxSchema,
      await this.fetch(route),
      `GET ${route}`,
    );

    return {
      id: channelId,
      name: inbox.name ?? undefined,
      metadata: { inboxId, channelType: inbox.channel_type, inbox },
    };
  }

  /**
   * List an inbox's conversations, newest activity first.
   *
   * `ConversationFinder` defaults to open conversations only, so `status=all`
   * is sent explicitly. Chatwoot's conversation list carries each
   * conversation's *latest* message rather than its first, so `rootMessage` is
   * the most recent one, and a conversation Chatwoot returns without any
   * message is skipped because a thread summary needs one. Chatwoot pages
   * conversations 25 at a time, so a call reads one page at most, returns up
   * to `options.limit` of its conversations, and the cursor is an offset.
   */
  async listThreads(
    channelId: string,
    options?: ListThreadsOptions,
  ): Promise<ListThreadsResult<ChatwootMessage>> {
    const inboxId = this.inboxIdOf(channelId);
    const offset = options?.cursor ? this.toId(options.cursor, "cursor") : 0;
    const start = offset % CONVERSATIONS_PAGE_SIZE;
    const route = `${this.base}/conversations`;
    const response = await this.fetch<{
      data?: { payload?: unknown[] };
      payload?: unknown[];
    }>(route, {
      query: {
        inbox_id: inboxId,
        status: "all",
        page: (offset - start) / CONVERSATIONS_PAGE_SIZE + 1,
      },
    });
    const rows = response.data?.payload ?? response.payload ?? [];
    const conversations = rows
      .slice(start, start + Math.max(1, options?.limit ?? rows.length))
      .map((row) =>
        this.parse(ChatwootConversationSchema, row, `GET ${route}`),
      );
    const end = start + conversations.length;

    const threads = conversations.flatMap((conversation) => {
      const threadId = this.threadIdOfConversation(conversation);
      const latest = ChatwootMessageSchema.safeParse(
        conversation.messages?.[0],
      );
      if (!latest.success) return [];
      return [
        {
          id: threadId,
          lastReplyAt: toDate(
            conversation.last_activity_at ?? conversation.timestamp,
          ),
          rootMessage: this.parseMessage(latest.data, threadId),
        },
      ];
    });

    return {
      threads,
      nextCursor:
        end < rows.length || rows.length === CONVERSATIONS_PAGE_SIZE
          ? String(offset + conversations.length)
          : undefined,
    };
  }

  /** Chatwoot conversations have no title, so the contact's name stands in. */
  async fetchSubject(raw: ChatwootMessage): Promise<MessageSubject | null> {
    const conversation = raw.conversation;
    if (conversation?.id === undefined) return null;
    const contact = conversation.meta?.sender;
    const assignee = conversation.meta?.assignee;

    return {
      id: String(conversation.id),
      type: "conversation",
      title: contact?.name ?? `Conversation ${conversation.id}`,
      status: conversation.status ?? undefined,
      labels: conversation.labels ?? undefined,
      url: `${this.root}/app/accounts/${this.accountId}/conversations/${conversation.id}`,
      ...(contact
        ? { author: { id: String(contact.id), name: contact.name ?? "" } }
        : {}),
      ...(assignee
        ? { assignee: { id: String(assignee.id), name: assignee.name ?? "" } }
        : {}),
      raw: conversation,
    };
  }

  async startTyping(threadId: string): Promise<void> {
    await this.toggleTyping(threadId, "on");
  }

  async endTyping(threadId: string): Promise<void> {
    await this.toggleTyping(threadId, "off");
  }

  private async toggleTyping(
    threadId: string,
    typingStatus: "on" | "off",
  ): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(
      `${this.base}/conversations/${conversationId}/toggle_typing_status`,
      {
        body: { typing_status: typingStatus },
      },
    );
  }

  /**
   * Mark the conversation as seen by this agent. Chatwoot tracks read state per
   * conversation, not per message, so the message ID is unused.
   */
  async markAsRead(threadId: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(
      `${this.base}/conversations/${conversationId}/update_last_seen`,
      { body: {} },
    );
  }

  /** Reopen the conversation's unread badge for the agents watching it. */
  async markAsUnread(threadId: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(`${this.base}/conversations/${conversationId}/unread`, {
      body: {},
    });
  }

  /**
   * Chatwoot buffers instead of editing: it has no message edit API, so the
   * whole stream is collected and posted as one message while the conversation
   * shows the typing indicator. A stream that yields no text still posts, so
   * the caller always gets a message back rather than the edit-based fallback.
   * An aborted `options.signal` stops reading, and what arrived so far posts.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<RawMessage<ChatwootMessage>> {
    const renderer = new StreamingMarkdownRenderer();
    await this.startTyping(threadId).catch((error: unknown) =>
      this.logger.debug("Could not start the typing indicator", { error }),
    );

    try {
      for await (const chunk of textStream) {
        if (options?.signal?.aborted) break;
        const text =
          typeof chunk === "string"
            ? chunk
            : chunk.type === "markdown_text"
              ? chunk.text
              : "";
        if (text) renderer.push(text);
      }
    } finally {
      await this.endTyping(threadId).catch((error: unknown) =>
        this.logger.debug("Could not clear the typing indicator", { error }),
      );
    }

    return this.postMessage(threadId, { markdown: renderer.finish() });
  }

  /** Chatwoot has no reaction model on any channel, so reactions are unsupported. */
  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "Chatwoot has no reaction API",
      "addReaction",
    );
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "Chatwoot has no reaction API",
      "removeReaction",
    );
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  /**
   * Open, resolve, snooze or move a conversation back to pending.
   *
   * `snoozedUntil` is sent as unix seconds because Chatwoot reads it with
   * `DateTime.strptime(value, "%s")`, which would silently land an ISO 8601
   * string in 1970.
   *
   * Moving a conversation to `open` with an **agent** token runs Chatwoot's
   * `handle_human_open`, which clears the AI assignee and assigns the
   * conversation to that agent. An agent bot token leaves the assignee alone.
   */
  async toggleStatus({
    threadId,
    status,
    snoozedUntil,
  }: ChatwootToggleStatusArgs): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(
      `${this.base}/conversations/${conversationId}/toggle_status`,
      {
        body: {
          status,
          ...(snoozedUntil
            ? {
                snoozed_until: Math.floor(snoozedUntil.getTime() / 1000),
              }
            : {}),
        },
      },
    );
  }

  /**
   * Hand the conversation to an agent, a team, or neither.
   *
   * Chatwoot's endpoint answers `assignee_id` and ignores `team_id` in the same
   * request, so both are sent as two calls. Pass `null` to unassign.
   */
  async assign({
    threadId,
    assigneeId,
    teamId,
  }: ChatwootAssignArgs): Promise<void> {
    if (assigneeId === undefined && teamId === undefined)
      throw new ValidationError(
        this.name,
        "assign needs an assigneeId, a teamId, or both",
      );

    const { conversationId } = this.decodeThreadId(threadId);
    const route = `${this.base}/conversations/${conversationId}/assignments`;
    if (assigneeId !== undefined)
      await this.fetch(route, { body: { assignee_id: assigneeId } });
    if (teamId !== undefined)
      await this.fetch(route, { body: { team_id: teamId } });
  }

  async setPriority({
    threadId,
    priority,
  }: ChatwootPriorityArgs): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(
      `${this.base}/conversations/${conversationId}/toggle_priority`,
      {
        body: { priority },
      },
    );
  }

  /** Replace the conversation's labels with `labels`. */
  async setLabels(threadId: string, labels: string[]): Promise<string[]> {
    const { conversationId } = this.decodeThreadId(threadId);
    const route = `${this.base}/conversations/${conversationId}/labels`;
    const response = await this.fetch<{ payload?: string[] }>(route, {
      body: { labels },
    });
    return response.payload ?? labels;
  }

  /** Replace the conversation's custom attributes; Chatwoot does not merge them. */
  async setCustomAttributes(
    threadId: string,
    customAttributes: Record<string, unknown>,
  ): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(
      `${this.base}/conversations/${conversationId}/custom_attributes`,
      {
        body: { custom_attributes: customAttributes },
      },
    );
  }

  /**
   * Chatwoot's mute, which resolves the conversation **and blocks the contact
   * across the whole account** — it is not a notification setting. Reverse it
   * with {@link ChatwootAdapter.unmute}, which unblocks the contact.
   */
  async mute(threadId: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(`${this.base}/conversations/${conversationId}/mute`, {
      body: {},
    });
  }

  /** Unblock the contact this conversation belongs to. */
  async unmute(threadId: string): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.fetch(`${this.base}/conversations/${conversationId}/unmute`, {
      body: {},
    });
  }

  /**
   * Resolve a thread for a contact, reusing their most recent unresolved
   * conversation and opening a new one only when they have none. A configured
   * `inboxId` restricts both the search and the new conversation to that inbox.
   *
   * @param userId - Chatwoot contact ID
   */
  async openDM(userId: string): Promise<string> {
    const contactId = this.toId(userId, "contact ID");

    const route = `${this.base}/contacts/${contactId}/conversations`;
    const response = await this.fetch<{ payload?: unknown[] }>(route);
    const inboxId = this.config.inboxId;
    const conversations = (response.payload ?? [])
      .map((row) => this.parse(ChatwootConversationSchema, row, `GET ${route}`))
      .filter(
        (conversation) =>
          inboxId === undefined || conversation.inbox_id === inboxId,
      );
    const existing =
      conversations.find(
        (conversation) => conversation.status !== "resolved",
      ) ?? conversations[0];
    if (existing) return this.threadIdOfConversation(existing, contactId);

    const inbox = await this.contactableInbox(contactId);
    const created = this.parse(
      ChatwootConversationSchema,
      await this.fetch(`${this.base}/conversations`, {
        body: {
          contact_id: contactId,
          inbox_id: inbox.inbox.id,
          ...(inbox.source_id ? { source_id: inbox.source_id } : {}),
        },
      }),
      `POST ${this.base}/conversations`,
    );

    return this.threadIdOfConversation(created, contactId);
  }

  /**
   * Open a modal in the conversation and for the contact a trigger names. A
   * website widget shows it as Chatwoot's native `form` when the widget can
   * render every field; anywhere else, or for a number, date, search or
   * optional field, each field is asked in turn, a select by number or label,
   * and `cancel`, or the modal's `closeLabel`, stops it. The answers reach
   * `onModalSubmit` either way.
   */
  async openModal(
    triggerId: string,
    modal: ModalElement,
    contextId?: string,
  ): Promise<{ viewId: string }> {
    const [threadId, userId] = fromTrigger(triggerId);
    const form = createForm(modal, crypto.randomUUID(), contextId);
    await this.present(
      threadId,
      userId,
      form,
      introOf(modal),
      this.texts().cancelHint,
    );
    return { viewId: form.viewId };
  }

  /**
   * Look a user up as a contact, the author of every message the handlers
   * receive by default, then among the account's agents when no contact has
   * that ID. Contacts and agents are numbered apart, so an agent sharing a
   * contact's ID resolves to the contact: read agents from
   * {@link ChatwootAdapter.listAgents}, and a contact's full record from
   * {@link ChatwootAdapter.fetchContact}.
   */
  async getUser(userId: string): Promise<UserInfo | null> {
    const id = this.toId(userId, "user ID");
    const contact = await this.fetchContact(id).catch((error: unknown) => {
      if (error instanceof ResourceNotFoundError) return undefined;
      throw error;
    });
    const person:
      | Pick<ChatwootSender, "name" | "available_name" | "email" | "thumbnail">
      | undefined =
      contact ?? (await this.listAgents()).find((agent) => agent.id === id);
    if (!person) return null;

    return {
      userId,
      userName: person.available_name ?? person.name ?? userId,
      fullName: person.name ?? "",
      isBot: false,
      ...(person.email ? { email: person.email } : {}),
      ...(person.thumbnail ? { avatarUrl: person.thumbnail } : {}),
    };
  }

  /** Fetch a contact. Chatwoot agents are separate — see {@link ChatwootAdapter.listAgents}. */
  async fetchContact(contactId: number): Promise<ChatwootContact> {
    const route = `${this.base}/contacts/${contactId}`;
    const response = await this.fetch<{ payload?: unknown }>(route);
    return this.parse(
      ChatwootContactSchema,
      response.payload ?? response,
      `GET ${route}`,
    );
  }

  async listAgents(): Promise<ChatwootAgent[]> {
    const route = `${this.base}/agents`;
    return this.parse(
      z.array(ChatwootAgentSchema),
      await this.fetch(route),
      `GET ${route}`,
    );
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const url = attachment.fetchMetadata?.url ?? attachment.url;
    if (!url) return attachment;
    return { ...attachment, fetchData: () => this.download(url) };
  }

  /**
   * Accepts the `name:inboxId` channel ID, a bare inbox ID, and a thread ID,
   * which a slash command's channel carries.
   */
  private inboxIdOf(channelId: string): number {
    return this.toId(
      channelId.split(":").slice(0, 2).pop(),
      `channel ID: ${channelId}`,
    );
  }

  private async fetchConversation(
    conversationId: number,
  ): Promise<ChatwootConversation> {
    const route = `${this.base}/conversations/${conversationId}`;
    return this.parse(
      ChatwootConversationSchema,
      await this.fetch(route),
      `GET ${route}`,
    );
  }

  private async contactableInbox(contactId: number) {
    const route = `${this.base}/contacts/${contactId}/contactable_inboxes`;
    const response = await this.fetch<{ payload?: unknown[] }>(route);
    const inboxes = (response.payload ?? []).map((row) =>
      this.parse(ChatwootContactableInboxSchema, row, `GET ${route}`),
    );
    // Without a configured inbox, the contact's own come first: any contactable
    // inbox would do for Chatwoot, but the customer is reachable on theirs.
    const preferred =
      this.config.inboxId ??
      (await this.fetchContact(contactId)).contact_inboxes
        ?.map((contactInbox) => contactInbox.inbox?.id ?? contactInbox.inbox_id)
        .find((id) => inboxes.some((candidate) => candidate.inbox.id === id));
    const inbox = preferred
      ? inboxes.find((candidate) => candidate.inbox.id === preferred)
      : inboxes[0];

    if (!inbox)
      throw new ResourceNotFoundError(
        this.name,
        "contactable inbox",
        preferred ? String(preferred) : `contact ${contactId}`,
      );
    return inbox;
  }

  /** A card's images go out as attachments of the same message, through the same safe download. */
  private async collectUploads(
    message: AdapterPostableMessage,
    images: string[],
  ): Promise<FileUpload[]> {
    const attachments = [
      ...extractPostableAttachments(message),
      ...images.map((url): Attachment => ({
        type: "image",
        url,
        name: fileNameOf(url, undefined),
      })),
    ];
    const files = extractFiles(message);
    const requested = files.length + attachments.length;

    // Checked before resolving, so an oversized batch is not downloaded first.
    if (requested > MAX_ATTACHMENTS)
      throw new ValidationError(
        this.name,
        `Chatwoot allows ${MAX_ATTACHMENTS} attachments per message, received ${requested}`,
      );

    const uploads: FileUpload[] = [...files];
    for (const attachment of attachments) {
      const data =
        attachment.data ?? (await this.resolveAttachmentData(attachment));
      if (!data)
        throw new ValidationError(
          this.name,
          `Attachment ${attachment.name ?? attachment.type} has no data, fetchData or url to send`,
        );
      uploads.push({
        data,
        filename: attachment.name ?? `attachment-${uploads.length + 1}`,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      });
    }

    return uploads;
  }

  private async resolveAttachmentData(
    attachment: Attachment,
  ): Promise<Buffer | undefined> {
    if (attachment.fetchData) {
      const data = await attachment.fetchData();
      return Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
    }
    if (attachment.url) return this.download(attachment.url);
    return undefined;
  }

  /**
   * Files on the configured Chatwoot are fetched directly, with the access
   * token on its ActiveStorage paths only. Anything off its origin — the
   * storage service ActiveStorage redirects to, or a third-party URL Chatwoot
   * stored — goes through the shared SSRF-guarded downloader. Every download
   * is bounded in time and size.
   */
  private async download(url: string): Promise<Buffer> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    let target = new URL(url, this.root);
    const fail = (error: Error): never => {
      throw new NetworkError(
        this.name,
        `Failed to download ${target.href}: ${error.message}`,
        error,
      );
    };

    // Each hop is followed by hand, so the token never leaves ActiveStorage.
    for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop += 1) {
      if (target.origin !== this.origin)
        return downloadAttachment(target.href, {
          adapter: this.name,
          limit: MAX_DOWNLOAD_BYTES,
          timeoutMs,
        });
      const response = await fetch(target, {
        redirect: "manual",
        signal,
        headers: target.href.startsWith(this.storage)
          ? { api_access_token: this.config.accessToken }
          : {},
      }).catch(fail);

      const location =
        response.status >= 300 && response.status < 400
          ? response.headers.get("location")
          : null;
      if (location) {
        target = new URL(location, target);
        continue;
      }
      if (!response.ok)
        throw new NetworkError(
          this.name,
          `Failed to download ${target.href}: status ${response.status}`,
        );
      const data = await readBody(response, MAX_DOWNLOAD_BYTES).catch(fail);
      if (data === null)
        throw new NetworkError(
          this.name,
          `${target.href} exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`,
        );
      return data;
    }

    throw new NetworkError(
      this.name,
      `Too many redirects while downloading ${url}`,
    );
  }

  private toAttachment(attachment: ChatwootAttachment): Attachment {
    const url = attachment.data_url ?? undefined;
    return {
      type: ATTACHMENT_TYPES[attachment.file_type] ?? "file",
      ...(url
        ? { url, fetchMetadata: { url }, fetchData: () => this.download(url) }
        : {}),
      ...(attachment.content_type ? { mimeType: attachment.content_type } : {}),
      ...(attachment.file_size != null ? { size: attachment.file_size } : {}),
      ...(attachment.width != null ? { width: attachment.width } : {}),
      ...(attachment.height != null ? { height: attachment.height } : {}),
      name: attachment.fallback_title ?? fileNameOf(url, attachment.extension),
    };
  }

  private authorOf(sender: ChatwootSender | null | undefined): Author {
    if (!sender)
      return {
        userId: "",
        userName: "",
        fullName: "",
        isBot: "unknown",
        isMe: false,
        isSystem: true,
      };

    return {
      userId: String(sender.id),
      userName: sender.available_name ?? sender.name ?? String(sender.id),
      fullName: sender.name ?? "",
      ...(sender.email ? { email: sender.email } : {}),
      isBot: (CHATWOOT_BOT_SENDER_TYPES as readonly string[]).includes(
        sender.type,
      ),
      isMe: false,
    };
  }

  private isSelf(message: ChatwootMessage): boolean {
    const sender = message.sender;
    if (!sender || sender.type === "contact") return false;
    // Contacts, users, agent bots and Captain assistants each have their own ID
    // sequence, so the kind has to match before the ID means anything.
    if (this.botUserId)
      return sender.type === "user" && String(sender.id) === this.botUserId;
    // Without /profile the bot has no ID, and Chatwoot only ever lets an agent
    // bot token write as its own agent bot.
    return this.agentBot && sender.type === "agent_bot";
  }

  private threadIdOf(message: ChatwootMessage): string {
    const conversation = message.conversation;
    const contact = conversation?.meta?.sender;
    const sender = message.sender;

    return this.encodeThreadId({
      inboxId: this.toId(
        message.inbox_id ?? conversation?.inbox_id,
        `inbox for message ${message.id}`,
      ),
      contactId: contact?.id ?? (sender?.type === "contact" ? sender.id : 0),
      conversationId: this.toId(
        conversation?.id ?? message.conversation_id,
        `conversation for message ${message.id}`,
      ),
    });
  }

  private threadIdOfConversation(
    conversation: ChatwootConversation,
    contactId?: number,
  ): string {
    return this.encodeThreadId({
      inboxId: conversation.inbox_id,
      contactId:
        contactId ??
        conversation.meta?.sender?.id ??
        conversation.contact_inbox?.contact_id ??
        0,
      conversationId: conversation.id,
    });
  }
}

/** Reads at most `maxBytes`, returning null past the limit rather than buffering the rest. */
async function readBody(
  message: Request | Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(message.headers.get("content-length"));
  if (declared > maxBytes) return null;
  if (!message.body) return Buffer.alloc(0);

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A 132-bit fingerprint, short enough for a state key. */
function digest(value: string): string {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * `Retry-After` in seconds, given either as seconds or as an HTTP date.
 * Undefined when absent or unreadable.
 */
function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const wait = Number.isNaN(seconds)
    ? (Date.parse(header) - Date.now()) / 1000
    : seconds;
  return Number.isNaN(wait) ? undefined : Math.max(0, Math.ceil(wait));
}

/**
 * How long to wait before retrying a GET, or undefined to give up: a network
 * failure, a timeout and a 5xx are retried, and a 429 when its `Retry-After`
 * is short enough to wait out.
 */
function retryDelay(error: unknown, attempt: number): number | undefined {
  const backoff = RETRY_DELAYS_MS[attempt];
  if (backoff === undefined) return undefined;
  if (error instanceof AdapterRateLimitError) {
    const wait = (error.retryAfter ?? 0) * 1000;
    return wait > MAX_RETRY_AFTER_MS ? undefined : Math.max(wait, backoff);
  }
  return error instanceof NetworkError ? backoff : undefined;
}

/**
 * What a voice note Chatwoot transcribed said and where a shared location
 * points, for a message that carries no content of its own.
 */
function describeAttachments(
  attachments: ChatwootAttachment[] | null | undefined,
): string {
  return (attachments ?? [])
    .map(
      ({
        transcribed_text,
        coordinates_lat,
        coordinates_long,
        fallback_title,
      }) => {
        if (transcribed_text) return transcribed_text;
        if (coordinates_lat == null || coordinates_long == null) return "";
        const place = `${coordinates_lat}, ${coordinates_long}`;
        return `Location: ${fallback_title ? `${fallback_title} (${place})` : place}`;
      },
    )
    .filter(Boolean)
    .join("\n\n");
}

/** Values a contact picked from an `input_select`, as encoded by {@link renderCard}. */
function submittedActionValues(message: ChatwootMessage): string[] {
  if (message.content_type !== "input_select") return [];
  const submitted = message.content_attributes?.submitted_values;
  if (!Array.isArray(submitted)) return [];
  return submitted
    .map((entry) => (entry as ChatwootSelectItem | null)?.value)
    .filter((value): value is string => typeof value === "string");
}

function linksOf(ast: Root): LinkPreview[] {
  const links: LinkPreview[] = [];
  walkAst(ast, (node) => {
    if (isLinkNode(node)) links.push({ url: node.url });
    return node;
  });
  return links;
}

function fileNameOf(
  url: string | undefined,
  extension: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  const segment = url.split("?")[0]!.split("/").pop() ?? "";
  const name = safeDecode(segment);
  if (!name) return undefined;
  return name.includes(".") || !extension ? name : `${name}.${extension}`;
}

/** Chatwoot stores whatever a channel sent, so an invalid escape is left as-is. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Encoded by hand because `FormData` turns every line break in a text field
 * into CRLF, which Chatwoot would store and deliver. `MessageBuilder` parses
 * `content_attributes` from a JSON string here.
 */
function toRequestBody(
  fields: Record<string, unknown>,
  uploads: FileUpload[],
): unknown {
  if (!uploads.length) return fields;

  const boundary = `chatwoot-${crypto.randomUUID()}`;
  const part = (name: string, extra = "") =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n`;
  const parts: BlobPart[] = [];
  for (const [key, value] of Object.entries(fields))
    parts.push(
      part(key),
      "\r\n",
      typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value),
      "\r\n",
    );
  for (const upload of uploads) {
    const type =
      upload.mimeType ??
      mimeTypeOf(upload.filename) ??
      "application/octet-stream";
    parts.push(
      part("attachments[]", `; filename="${escapeFilename(upload.filename)}"`),
      `Content-Type: ${type}\r\n\r\n`,
      toBytes(upload.data),
      "\r\n",
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` });
}

/** As browsers do, so a name cannot close its quotes or start a header. */
function escapeFilename(filename: string): string {
  return filename
    .replaceAll('"', "%22")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function mimeTypeOf(filename: string): string | undefined {
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension ? MIME_TYPES[extension] : undefined;
}

function toBytes(data: FileUpload["data"]): BlobPart {
  return data instanceof Blob ? data : (data as BlobPart);
}

/** `stringifyMarkdown` always ends with a newline, which Chatwoot would store verbatim. */
function trimTrailing(content: string): string {
  return content.replace(/\s+$/, "");
}
