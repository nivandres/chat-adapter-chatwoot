import { ValidationError } from "@chat-adapter/shared";
import { ChatwootAdapter } from "./adapter";
import type { ChatwootAdapterConfig } from "./types";

/**
 * Create a Chatwoot adapter for Chat SDK.
 *
 * Credentials fall back to `CHATWOOT_BASE_URL`, `CHATWOOT_ACCESS_TOKEN`,
 * `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_INBOX_ID`, `CHATWOOT_USER_NAME` and
 * `CHATWOOT_WEBHOOK_SECRET`.
 *
 * @example
 * ```typescript
 * import { Chat } from "chat";
 * import { createChatwootAdapter } from "chat-adapter-chatwoot";
 *
 * const bot = new Chat({
 *   userName: "mybot",
 *   adapters: { chatwoot: createChatwootAdapter() },
 * });
 *
 * bot.onDirectMessage(async (thread, message) => {
 *   await thread.post(`Hello, ${message.author.fullName}!`);
 * });
 * ```
 */
export function createChatwootAdapter(
  config?: Partial<ChatwootAdapterConfig>,
): ChatwootAdapter {
  const baseUrl = config?.baseUrl ?? process.env.CHATWOOT_BASE_URL;
  const accessToken = config?.accessToken ?? process.env.CHATWOOT_ACCESS_TOKEN;
  const accountId =
    config?.accountId ?? toNumber(process.env.CHATWOOT_ACCOUNT_ID);
  const inboxId = config?.inboxId ?? toNumber(process.env.CHATWOOT_INBOX_ID);
  const userName = config?.userName ?? process.env.CHATWOOT_USER_NAME;
  const webhookSecret =
    config?.webhookSecret ??
    process.env.CHATWOOT_WEBHOOK_SECRET?.split(",").filter(Boolean);

  if (!accessToken)
    throw new ValidationError(
      "chatwoot",
      "Chatwoot access token is required. Pass accessToken or set CHATWOOT_ACCESS_TOKEN.",
    );
  if (accountId === undefined)
    throw new ValidationError(
      "chatwoot",
      "Chatwoot account ID is required. Pass accountId or set CHATWOOT_ACCOUNT_ID.",
    );

  return new ChatwootAdapter({
    ...config,
    accessToken,
    accountId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(inboxId !== undefined ? { inboxId } : {}),
    ...(userName ? { userName } : {}),
    ...(webhookSecret?.length ? { webhookSecret } : {}),
  });
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
