import { ValidationError } from "@chat-adapter/shared";
import { ChatwootAdapter } from "./adapter";

/**
 * Type guard for narrowing a Chat SDK adapter to {@link ChatwootAdapter}.
 *
 * @example
 * ```typescript
 * if (isChatwootAdapter(thread.adapter)) {
 *   await thread.adapter.postPrivateNote(thread.id, "escalating");
 * }
 * ```
 */
export function isChatwootAdapter(
  adapter: unknown,
): adapter is ChatwootAdapter {
  return adapter instanceof ChatwootAdapter;
}

/**
 * Require that a Chat SDK context belongs to a {@link ChatwootAdapter}.
 *
 * Accepts either an adapter directly or any object with an `adapter` property,
 * such as `Thread` and `Channel`.
 *
 * @example
 * ```typescript
 * const chatwoot = requireChatwootAdapter(thread);
 * await chatwoot.toggleStatus({ threadId: thread.id, status: "resolved" });
 * ```
 */
export function requireChatwootAdapter(value: unknown): ChatwootAdapter {
  const adapter =
    value && typeof value === "object" && "adapter" in value
      ? (value as { adapter: unknown }).adapter
      : value;
  if (isChatwootAdapter(adapter)) return adapter;

  throw new ValidationError(
    "chatwoot",
    "This context does not belong to a Chatwoot adapter.",
  );
}
