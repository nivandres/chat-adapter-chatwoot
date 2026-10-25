import type {
  ChatInstance,
  Logger,
  Message,
  ModalResponse,
  OptionsLoadResult,
  QueueEntry,
  StateAdapter,
  WebhookOptions,
} from "chat";
import { ConsoleLogger } from "chat";
import crypto from "node:crypto";
import type { ChatwootMessage } from "./schema";

export const ACCOUNT = { id: 2, name: "Acme" };
export const INBOX = { id: 10, name: "Website" };

/** `Contact#webhook_data` — the only sender Chatwoot serializes without a `type`. */
export const CONTACT_SENDER = {
  id: 20,
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone_number: null,
  identifier: null,
  thumbnail: "",
  avatar: "",
  blocked: false,
  additional_attributes: {},
  custom_attributes: {},
  account: ACCOUNT,
};

/** `Contact#push_event_data` — the nested form, which does carry a `type`. */
export const CONTACT_PUSH = {
  id: 20,
  name: "Ada Lovelace",
  email: "ada@example.com",
  identifier: null,
  phone_number: null,
  thumbnail: "",
  blocked: false,
  type: "contact",
  additional_attributes: {},
  custom_attributes: {},
};

/** `User#push_event_data` */
export const AGENT_PUSH = {
  id: 7,
  name: "Grace Hopper",
  available_name: "Grace",
  avatar_url: "",
  type: "user",
  availability_status: "online",
  thumbnail: "",
};

/** `User#webhook_data` — the webhook form, with no `available_name`. */
export const AGENT_WEBHOOK = {
  id: 7,
  name: "Grace Hopper",
  email: "grace@example.com",
  type: "user",
};

/**
 * `Message#push_event_data` — the form nested inside a conversation payload.
 * Its `message_type` is an ordinal and its `conversation` is a slim subset with
 * neither `id` nor `inbox_id`.
 */
export function pushMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 3042,
    content: "Hi there",
    account_id: 2,
    inbox_id: 10,
    conversation_id: 300,
    message_type: 0,
    content_type: "text",
    status: "sent",
    content_attributes: {},
    created_at: 1777456800,
    updated_at: "2026-04-29T10:00:00.000Z",
    private: false,
    source_id: null,
    sender_type: "Contact",
    sender_id: 20,
    sender: CONTACT_PUSH,
    conversation: {
      assignee_id: null,
      unread_count: 1,
      last_activity_at: 1777456800,
      contact_inbox: { source_id: "3d1f" },
    },
    ...overrides,
  };
}

/** `Conversations::EventDataPresenter#webhook_data` — note the absent `account_id`. */
export const CONVERSATION = {
  additional_attributes: {},
  can_reply: true,
  channel: "Channel::WebWidget",
  contact_inbox: {
    id: 55,
    contact_id: 20,
    inbox_id: 10,
    source_id: "3d1f",
    created_at: "2026-04-28T09:00:00.000Z",
    updated_at: "2026-04-29T10:00:00.000Z",
    hmac_verified: false,
    pubsub_token: "tok",
  },
  id: 300,
  inbox_id: 10,
  labels: [],
  messages: [pushMessage()],
  meta: {
    sender: CONTACT_PUSH,
    assignee: null,
    assignee_type: null,
    team: null,
    hmac_verified: false,
  },
  status: "open",
  custom_attributes: {},
  snoozed_until: null,
  unread_count: 1,
  first_reply_created_at: null,
  priority: null,
  waiting_since: 1777456800,
  agent_last_seen_at: 0,
  contact_last_seen_at: 0,
  last_activity_at: 1777456800,
  timestamp: 1777456800,
  created_at: 1777456200,
  updated_at: 1777456800.1234,
};

/**
 * `api/v1/conversations/partials/_conversation.json.jbuilder` — the REST shape,
 * which carries `account_id` and `muted`, nests the channel class under `meta`,
 * and lists the conversation's latest message as `push_event_data`.
 */
export function restConversation(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      sender: CONTACT_PUSH,
      channel: "Channel::WebWidget",
      hmac_verified: false,
    },
    id: 300,
    messages: [pushMessage()],
    account_id: 2,
    uuid: "5f2c1e10-0b8e-4c2f-9f0a-2d1b3c4d5e6f",
    additional_attributes: {},
    agent_last_seen_at: 0,
    assignee_last_seen_at: 0,
    can_reply: true,
    contact_last_seen_at: 0,
    custom_attributes: {},
    inbox_id: 10,
    labels: [],
    muted: false,
    snoozed_until: null,
    status: "open",
    created_at: 1777456200,
    updated_at: 1777456800.1234,
    timestamp: 1777456800,
    first_reply_created_at: 0,
    unread_count: 1,
    last_non_activity_message: pushMessage(),
    last_activity_at: 1777456800,
    priority: null,
    waiting_since: 1777456800,
    sla_policy_id: null,
    ...overrides,
  };
}

/** `Message#webhook_data` merged with the event name. */
export function webhookMessage(overrides: Record<string, unknown> = {}) {
  return {
    event: "message_created",
    id: 3042,
    content: "Hi there",
    created_at: "2026-04-29T10:00:00.000Z",
    message_type: "incoming",
    content_type: "text",
    content_attributes: {},
    additional_attributes: {},
    private: false,
    source_id: null,
    account: ACCOUNT,
    inbox: INBOX,
    sender: CONTACT_SENDER,
    conversation: CONVERSATION,
    ...overrides,
  };
}

/** `api/v1/models/_message.json.jbuilder` — ordinal `message_type`, unix `created_at`. */
export function restMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 3043,
    content: "Sure, one moment",
    inbox_id: 10,
    conversation_id: 300,
    message_type: 1,
    content_type: "text",
    status: "sent",
    content_attributes: {},
    created_at: 1777456860,
    private: false,
    source_id: null,
    sender: AGENT_PUSH,
    ...overrides,
  };
}

export function signRequest(
  payload: unknown,
  secret?: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) {
    headers["X-Chatwoot-Timestamp"] = timestamp;
    headers["X-Chatwoot-Signature"] =
      `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  }
  return new Request("https://bot.example.com/webhooks/chatwoot", {
    method: "POST",
    headers,
    body,
  });
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  form?: FormData;
}

/** Replace `globalThis.fetch` with a recorder. Returns the recorded requests. */
export function stubFetch(
  handler: (request: RecordedRequest) => unknown = () => ({}),
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const form =
      init?.body instanceof FormData
        ? init.body
        : init?.body instanceof Blob
          ? await new Response(init.body, {
              headers: { "Content-Type": init.body.type },
            }).formData()
          : undefined;
    const recorded: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: form
        ? undefined
        : typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined,
      ...(form ? { form } : {}),
    };
    requests.push(recorded);

    const result = handler(recorded);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return requests;
}

export interface WaitUntilTracker {
  /** Pass as the `options` argument of `handleWebhook`. */
  options: WebhookOptions;
  /** Await every task handed to `waitUntil`, including those the first ones hand over. */
  settled: () => Promise<unknown>;
}

/** Collects the background work a webhook defers, so tests can await it. */
export function createWaitUntilTracker(): WaitUntilTracker {
  const tasks: Promise<unknown>[] = [];
  return {
    options: { waitUntil: (task) => void tasks.push(task) },
    settled: async () => {
      while (tasks.length) await Promise.all(tasks.splice(0));
    },
  };
}

export interface ChatRecorder {
  state: StateAdapter;
  chat: ChatInstance;
  messages: { threadId: string; message: Message<ChatwootMessage> }[];
  updates: { threadId: string; message: Message<ChatwootMessage> }[];
  deletes: { threadId: string; messageId: string }[];
  actions: {
    actionId: string;
    value?: string;
    threadId: string;
    triggerId?: string;
    userId: string;
  }[];
  commands: {
    command: string;
    text: string;
    channelId: string;
    triggerId?: string;
    userId: string;
  }[];
  submits: {
    callbackId: string;
    values: Record<string, string>;
    contextId?: string;
  }[];
  closes: { callbackId: string; contextId?: string }[];
  searches: { actionId: string; query: string }[];
  /** What `processModalSubmit` answers, one per submission. */
  responses: (ModalResponse | undefined)[];
  /** What `processOptionsLoad` finds. */
  found?: OptionsLoadResult;
}

/** A `ChatInstance` stand-in exposing only what the adapter calls. */
export function createChatRecorder(
  logger: Logger = new ConsoleLogger("error"),
): ChatRecorder {
  const state = createMemoryState();
  const recorder: ChatRecorder = {
    state,
    messages: [],
    updates: [],
    deletes: [],
    actions: [],
    commands: [],
    submits: [],
    closes: [],
    searches: [],
    responses: [],
    chat: {} as ChatInstance,
  };

  const chat: Pick<
    ChatInstance,
    | "getLogger"
    | "getState"
    | "processMessage"
    | "processMessageUpdated"
    | "processMessageDeleted"
    | "processAction"
    | "processSlashCommand"
    | "processModalSubmit"
    | "processModalClose"
    | "processOptionsLoad"
  > = {
    getLogger: () => logger,
    getState: () => state,
    processMessage: async (_adapter, threadId, message) => {
      recorder.messages.push({
        threadId,
        message: (typeof message === "function"
          ? await message()
          : message) as Message<ChatwootMessage>,
      });
    },
    processMessageUpdated: async (event) => {
      recorder.updates.push({
        threadId: event.threadId,
        message: (typeof event.message === "function"
          ? await event.message()
          : event.message) as Message<ChatwootMessage>,
      });
    },
    processMessageDeleted: async (event) => {
      recorder.deletes.push({
        threadId: event.threadId,
        messageId: event.messageId,
      });
    },
    processAction: async (event) => {
      recorder.actions.push({
        actionId: event.actionId,
        value: event.value,
        threadId: event.threadId,
        triggerId: event.triggerId,
        userId: event.user.userId,
      });
    },
    processSlashCommand: (event) => {
      recorder.commands.push({
        command: event.command,
        text: event.text,
        channelId: event.channelId,
        triggerId: event.triggerId,
        userId: event.user.userId,
      });
    },
    processModalSubmit: async (event, contextId) => {
      recorder.submits.push({
        callbackId: event.callbackId,
        values: event.values,
        contextId,
      });
      return recorder.responses.shift();
    },
    processModalClose: (event, contextId) => {
      recorder.closes.push({ callbackId: event.callbackId, contextId });
    },
    processOptionsLoad: async (event) => {
      recorder.searches.push({ actionId: event.actionId, query: event.query });
      return recorder.found;
    },
  };

  recorder.chat = chat as ChatInstance;
  return recorder;
}

/**
 * Just enough of `StateAdapter` to drive a real `Chat` instance in tests, with
 * no TTL expiry and no cross-process concerns.
 */
export function createMemoryState(): StateAdapter {
  const values = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const queues = new Map<string, QueueEntry[]>();
  const subscribed = new Set<string>();
  const locks = new Set<string>();

  return {
    connect: async () => undefined,
    disconnect: async () => undefined,
    get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
    setIfNotExists: async (key, value) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    appendToList: async (key, value, options) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      if (options?.maxLength && list.length > options.maxLength)
        list.splice(0, list.length - options.maxLength);
      lists.set(key, list);
    },
    getList: async <T>(key: string) => (lists.get(key) ?? []) as T[],
    enqueue: async (threadId, entry, maxSize) => {
      const queue = queues.get(threadId) ?? [];
      queue.push(entry);
      if (queue.length > maxSize) queue.shift();
      queues.set(threadId, queue);
      return queue.length;
    },
    dequeue: async (threadId) => queues.get(threadId)?.shift() ?? null,
    queueDepth: async (threadId) => queues.get(threadId)?.length ?? 0,
    subscribe: async (threadId) => void subscribed.add(threadId),
    unsubscribe: async (threadId) => void subscribed.delete(threadId),
    isSubscribed: async (threadId) => subscribed.has(threadId),
    acquireLock: async (threadId) => {
      if (locks.has(threadId)) return null;
      locks.add(threadId);
      return { threadId, token: threadId, expiresAt: 0 };
    },
    extendLock: async () => true,
    releaseLock: async (lock) => void locks.delete(lock.threadId),
    forceReleaseLock: async (threadId) => void locks.delete(threadId),
  };
}
