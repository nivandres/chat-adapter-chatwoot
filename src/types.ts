import type { Logger } from "chat";
import type {
  ChatwootConversationStatus,
  ChatwootPriority,
  ChatwootWebhookPayload,
} from "./schema";

/** Decoded thread ID components for Chatwoot */
export interface ChatwootThreadId {
  /** Inbox ID in Chatwoot */
  inboxId: number;
  /** Contact ID in Chatwoot */
  contactId: number;
  /** Conversation `display_id` in Chatwoot, the ID every conversation route takes */
  conversationId: number;
}

/** Configuration for the Chatwoot adapter */
export interface ChatwootAdapterConfig {
  /** Chatwoot base URL. Defaults to `https://app.chatwoot.com` */
  baseUrl?: string;
  /**
   * `api_access_token` the adapter authenticates with.
   *
   * An agent (user) token unlocks the whole adapter. An agent bot token is
   * limited by Chatwoot's `BOT_ACCESSIBLE_ENDPOINTS` to reading and writing one
   * conversation, its messages, assignments and labels — listing messages,
   * deleting, read receipts, mute, contacts, inboxes and agents are rejected
   * server-side.
   */
  accessToken: string;
  /** Account ID */
  accountId: number;
  /**
   * Adapter identity, used as the thread ID prefix.
   *
   * Set a unique value per account to run several Chatwoot accounts in one
   * `Chat` instance, and register the adapter under the same key so
   * `chat.thread(threadId)` resolves it. Must not contain `:`. Defaults to
   * `"chatwoot"`.
   *
   * @example
   * ```typescript
   * adapters: {
   *   "chatwoot-sales": createChatwootAdapter({ adapterName: "chatwoot-sales", ... }),
   * }
   * ```
   */
  adapterName?: string;
  /** Bot display name override. Defaults to the authenticated agent's name */
  userName?: string;
  /** Inbox used by {@link ChatwootAdapter.openDM} when a contact has no conversation yet */
  inboxId?: number;
  /**
   * Secret Chatwoot signs webhooks with. The account webhook, an API inbox and
   * an agent bot each sign with their own, so pass every one whose webhooks
   * reach this adapter; any of them verifies. Without one, every webhook is
   * refused unless {@link ChatwootAdapterConfig.allowUnverifiedWebhooks} is set.
   */
  webhookSecret?: string | readonly string[];
  /**
   * Accept webhooks while no `webhookSecret` is set. Anyone who can reach the
   * route can then post as any contact of the account, so keep it to local
   * development against a Chatwoot that signs nothing.
   */
  allowUnverifiedWebhooks?: boolean;
  /**
   * Also hand other agents' and bots' replies to Chat SDK's message handlers.
   * Off by default, so only the contact's own messages reach them and two bots
   * on one account never answer each other.
   */
  receiveAgentMessages?: boolean;
  /**
   * Also hand private notes to Chat SDK's message handlers. Off by default, so
   * a bot never reads an agent's internal note and answers the contact with it.
   */
  receivePrivateNotes?: boolean;
  /**
   * Commands, such as `"/help"`, whose messages from the contact reach
   * `onSlashCommand` rather than the message handlers. `"/help me"` arrives as
   * command `/help` with text `"me"`. Any other text starting with `/` stays a
   * message.
   */
  slashCommands?: string[];
  /** The few phrases a conversational modal sends, to put them in your contacts' language. */
  modalTexts?: Partial<ChatwootModalTexts>;
  /**
   * How far a signed webhook's `X-Chatwoot-Timestamp` may be from now. Chatwoot
   * signs every attempt afresh, so only a replay is older. Defaults to 5 minutes.
   */
  timestampToleranceMs?: number;
  /** Largest webhook body read, in bytes. Defaults to 4 MiB */
  maxBodyBytes?: number;
  /** How long one Chatwoot request or attachment download may take, in milliseconds. Defaults to 30 seconds */
  timeoutMs?: number;
  /** Logger instance */
  logger?: Logger;
  /**
   * Called for every verified webhook payload, including the events Chat SDK has
   * no handler for: conversation lifecycle, typing, contact and inbox changes.
   *
   * @example
   * ```typescript
   * onEvent: (event) => {
   *   if (event.event === "conversation_resolved") console.log(event.id, "closed");
   * }
   * ```
   */
  onEvent?: (payload: ChatwootWebhookPayload) => void | Promise<void>;
}

/** The phrases a conversational modal sends; `cancel` and `skip` are the words contacts answer with. */
export interface ChatwootModalTexts {
  cancel: string;
  cancelHint: string;
  cancelled: string;
  invalid: string;
  noResults: string;
  search: string;
  skip: string;
  skipHint: string;
}

/** A single Chatwoot Application API request */
export interface ChatwootRequest {
  /** JSON body, or a `FormData` for multipart uploads. Implies `POST` unless `method` says otherwise */
  body?: unknown;
  /** HTTP method. Defaults to `POST` when a body is present, `GET` otherwise */
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Query string values. `undefined` entries are dropped */
  query?: Record<string, string | number | boolean | undefined>;
}

/** Named arguments for {@link ChatwootAdapter.toggleStatus} */
export interface ChatwootToggleStatusArgs {
  /** Encoded thread ID of the conversation to move */
  threadId: string;
  /** Status to move the conversation to */
  status: ChatwootConversationStatus;
  /** When to wake a snoozed conversation back up */
  snoozedUntil?: Date;
}

/** Named arguments for {@link ChatwootAdapter.assign} */
export interface ChatwootAssignArgs {
  /** Encoded thread ID of the conversation to assign */
  threadId: string;
  /** Agent to assign. Pass `null` to unassign */
  assigneeId?: number | null;
  /** Team to assign. Pass `null` to unassign */
  teamId?: number | null;
}

/** Named arguments for {@link ChatwootAdapter.setPriority} */
export interface ChatwootPriorityArgs {
  /** Encoded thread ID of the conversation to prioritise */
  threadId: string;
  /** Priority to set. Pass `null` to clear it */
  priority: ChatwootPriority | null;
}

export enum ChatwootErrorCode {
  REQUEST_FAILED = "REQUEST_FAILED",
  INVALID_RESPONSE = "INVALID_RESPONSE",
}
