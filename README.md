[![Chatwoot adapter for Chat SDK](https://chat-sdk.dev/en/adapters/community/chatwoot/og)](https://chat-sdk.dev/adapters/community/chatwoot)

# chat-adapter-chatwoot

> npm package: [`chat-adapter-chatwoot`](https://www.npmjs.com/package/chat-adapter-chatwoot)

[![npm version](https://img.shields.io/npm/v/chat-adapter-chatwoot?style=flat-square&logo=npm&logoColor=white&labelColor=000&color=000)](https://www.npmjs.com/package/chat-adapter-chatwoot)
[![npm downloads](https://img.shields.io/npm/dm/chat-adapter-chatwoot?style=flat-square&logo=npm&logoColor=white&labelColor=000&color=000)](https://www.npmjs.com/package/chat-adapter-chatwoot)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Chatwoot adapter for [Chat SDK](https://chat-sdk.dev), using the [Chatwoot](https://www.chatwoot.com) Application API. Your bot answers every channel Chatwoot connects, including the website widget, WhatsApp, email, Telegram, Instagram, and SMS, through one webhook.

Documentation: [chat-sdk.dev/adapters/community/chatwoot](https://chat-sdk.dev/adapters/community/chatwoot)

## Installation

```bash
pnpm add chat-adapter-chatwoot chat @chat-adapter/shared
```

`chat` and `@chat-adapter/shared` are peer dependencies, so your app and the adapter share one copy of each. The package is ESM only and needs Node.js 20 or later.

## Usage

```typescript
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createChatwootAdapter } from "chat-adapter-chatwoot";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    chatwoot: createChatwootAdapter(),
  },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`Hello, ${message.author.fullName}!`);
});
```

When using `createChatwootAdapter()` without arguments, credentials are auto-detected from environment variables.

Every Chatwoot conversation is a one-to-one thread between a contact and your account, so `onDirectMessage` sees all of them. Only the contact's own messages reach your handlers by default. Replies from other agents and bots, and private notes, stay out until you opt in with `receiveAgentMessages` or `receivePrivateNotes`, so a bot never repeats an internal note to the customer and two bots on one account never answer each other.

The adapter keeps card options, edit tracking, and webhook deduplication in the Chat SDK state adapter. Use a persistent one, such as [Redis](https://chat-sdk.dev/adapters/official/redis), in production.

## Chatwoot setup

### 1. Get an access token

1. In Chatwoot, open **Settings > Agents** and add the agent the bot posts as.
2. Sign in as that agent, open **Profile Settings**, and copy its **Access Token** into `CHATWOOT_ACCESS_TOKEN`.
3. Copy your account ID from the dashboard URL, `/app/accounts/<id>/...`, into `CHATWOOT_ACCOUNT_ID`.

An agent bot's token works too, within the limits in [Agent bot tokens](#agent-bot-tokens).

### 2. Choose how webhooks reach the bot

Point one or more of these at your webhook route:

| Source          | Where to set it up                                   | Delivers                                                                                                                                                                               |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account webhook | **Settings > Integrations > Webhooks**               | The events you subscribe to, across the account                                                                                                                                        |
| API inbox       | The API inbox's **Webhook URL** setting              | Events in that inbox                                                                                                                                                                   |
| Agent bot       | **Settings > Bots**, then assign the bot to an inbox | `message_created`, `message_updated`, `conversation_opened`, `conversation_resolved`, `conversation_status_changed`, `conversation_updated`, and `webwidget_triggered` for its inboxes |

Subscribe an account webhook to at least `message_created`. Add `message_updated` for edits, deletes, and card picks from the web widget, plus any `conversation_*`, `contact_*`, or typing event you want in `onEvent`. When the account webhook and an API inbox both deliver the same event, the adapter handles it once.

### 3. Copy the webhook secret

Each source signs with its own secret. Copy every one that reaches your route into `CHATWOOT_WEBHOOK_SECRET`, separated by commas, or pass `webhookSecret: [accountSecret, inboxSecret]`. Without a secret, the adapter refuses every webhook with `401`.

### Agent bot tokens

Chatwoot's `BOT_ACCESSIBLE_ENDPOINTS` let an agent bot token post messages and private notes, stream, read the conversation, toggle typing, and change status, priority, assignment, labels, and custom attributes. Chatwoot refuses the rest with `401 Access to this endpoint is not authorized for bots`, which the adapter raises as a `PermissionError`: `fetchMessage`, `deleteMessage`, `markAsRead`, `markAsUnread`, `mute`, `unmute`, `listThreads`, `fetchChannelInfo`, `getUser`, `fetchContact`, `listAgents`, and `openDM`. Since a bot token cannot list messages, `fetchMessages` answers empty and Chat SDK serves the thread history it keeps (`persistThreadHistory`). The adapter detects an agent bot token at startup and logs a warning rather than failing.

A conversation in an agent bot's inbox starts `pending`, and `toggleStatus({ threadId, status: "open" })` hands it to people. Chatwoot does the same on its own when a `message_created` or `message_updated` delivery to the bot fails.

## Configuration

All options are auto-detected from environment variables when not provided. You can call `createChatwootAdapter()` with no arguments if the env vars are set.

| Option                    | Required | Description                                                                                                                                            |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accessToken`             | No\*     | Agent or agent bot access token. Auto-detected from `CHATWOOT_ACCESS_TOKEN`                                                                            |
| `accountId`               | No\*     | Chatwoot account ID. Auto-detected from `CHATWOOT_ACCOUNT_ID`                                                                                          |
| `webhookSecret`           | No\*\*   | Secret, or list of secrets, that verify `X-Chatwoot-Signature`. Auto-detected from `CHATWOOT_WEBHOOK_SECRET` (comma-separated)                         |
| `baseUrl`                 | No       | Chatwoot base URL, for a self-hosted install. Auto-detected from `CHATWOOT_BASE_URL` (defaults to `https://app.chatwoot.com`)                          |
| `inboxId`                 | No       | Inbox `openDM` searches and opens new conversations in. Auto-detected from `CHATWOOT_INBOX_ID`                                                         |
| `userName`                | No       | Bot display name. Auto-detected from `CHATWOOT_USER_NAME` (defaults to the authenticated agent's name)                                                 |
| `adapterName`             | No       | Adapter identity and thread ID prefix, to run several accounts in one bot (defaults to `"chatwoot"`)                                                   |
| `receiveAgentMessages`    | No       | Also hand other agents' and bots' replies to message handlers (defaults to `false`)                                                                    |
| `receivePrivateNotes`     | No       | Also hand private notes to message handlers (defaults to `false`)                                                                                      |
| `slashCommands`           | No       | Commands, such as `"/help"`, whose messages from the contact reach `onSlashCommand` instead of message handlers                                        |
| `modalTexts`              | No       | The phrases a conversational modal sends, to translate them: `cancel`, `cancelHint`, `cancelled`, `invalid`, `noResults`, `search`, `skip`, `skipHint` |
| `allowUnverifiedWebhooks` | No       | Accept webhooks while no `webhookSecret` is set. For local development only (defaults to `false`)                                                      |
| `timestampToleranceMs`    | No       | How old a signed webhook may be before it reads as a replay (defaults to 5 minutes)                                                                    |
| `maxBodyBytes`            | No       | Largest webhook body read (defaults to 4 MiB)                                                                                                          |
| `timeoutMs`               | No       | Deadline for one API request or attachment download (defaults to 30 seconds)                                                                           |
| `onEvent`                 | No       | Called with every verified webhook payload, including events Chat SDK has no handler for                                                               |
| `logger`                  | No       | Logger used until `Chat` initializes the adapter, which then logs through Chat's logger (defaults to `ConsoleLogger("info")`)                          |

\*Required at runtime, either via config or environment variable.

\*\*Required to receive webhooks, unless `allowUnverifiedWebhooks` is set.

## Environment variables

```bash
CHATWOOT_ACCESS_TOKEN=...      # Agent or agent bot access token
CHATWOOT_ACCOUNT_ID=...        # Account ID, from /app/accounts/<id>/ in the dashboard
CHATWOOT_WEBHOOK_SECRET=...    # Webhook secret; separate several with commas
CHATWOOT_BASE_URL=...          # Optional, self-hosted Chatwoot URL (defaults to https://app.chatwoot.com)
CHATWOOT_INBOX_ID=...          # Optional, inbox openDM uses for new conversations
CHATWOOT_USER_NAME=...         # Optional, bot display name
```

## Webhook setup

```typescript
// Next.js App Router example: app/api/webhooks/chatwoot/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function POST(request: Request) {
  return bot.webhooks.chatwoot(request, {
    waitUntil: (task) => after(() => task),
  });
}
```

The adapter verifies the request, answers `200`, and runs your handlers in the background through `waitUntil`. Chatwoot counts any other status as a failed delivery, so an event type the adapter doesn't know yet is acknowledged with `200` and ignored.

## Features

### Messaging

| Feature            | Supported                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Post message       | Yes                                                                                                |
| Message replies    | Outbound only (`thread.reply()` quotes with Chatwoot's `in_reply_to`)                              |
| Edit message       | No (Chatwoot has no message edit API)                                                              |
| Delete message     | Yes (Chatwoot leaves a "deleted" placeholder)                                                      |
| File uploads       | Yes (up to 15 per message)                                                                         |
| Streaming          | Buffered (Chatwoot can't edit a sent message, so a stream posts once, behind the typing indicator) |
| Scheduled messages | No                                                                                                 |

### Rich content

| Feature         | Supported                                                                                |
| --------------- | ---------------------------------------------------------------------------------------- |
| Card format     | Partial (markdown text, buttons and selects as an `input_select`, images as attachments) |
| Buttons         | Yes (`input_select` options; a pick reaches `onAction` on every channel)                 |
| Link buttons    | Partial (markdown links)                                                                 |
| Select menus    | Partial (options as `input_select` buttons, or a native select in a widget modal)        |
| Tables          | Partial (monospaced text in a code block)                                                |
| Charts          | No                                                                                       |
| Fields          | Partial (`**Label:** value` lines)                                                       |
| Images in cards | Yes (attachments of the same message)                                                    |
| Modals          | Partial (a native form in the website widget, a conversation elsewhere)                  |

### Conversations

| Feature               | Supported                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Slash commands        | Partial (declared commands, sent by the contact)                                             |
| Mentions              | Partial (Chatwoot notifies mentions in private notes only; build one with `chatwootMention`) |
| Add reactions         | No (Chatwoot has no reaction API)                                                            |
| Remove reactions      | No                                                                                           |
| Typing indicator      | Partial (shown to agents and in the web widget)                                              |
| Mark as read          | Partial (per conversation, not per message)                                                  |
| Message edit events   | Yes                                                                                          |
| Message delete events | Yes                                                                                          |
| DMs                   | Yes (every conversation; `openDM` reuses or opens one)                                       |
| Ephemeral messages    | No                                                                                           |
| User lookup           | Partial (contacts first, then agents)                                                        |
| Parent subject        | Yes (the conversation, its labels, assignee, and dashboard link)                             |
| Native client         | Partial (`fetch()` reaches any Application API route)                                        |
| Custom API endpoint   | Yes (`baseUrl`, for self-hosted Chatwoot)                                                    |

### Message history

| Feature                | Supported                                              |
| ---------------------- | ------------------------------------------------------ |
| Fetch messages         | Yes (Chat SDK keeps the history for agent bot tokens)  |
| Fetch single message   | Yes                                                    |
| Fetch thread info      | Yes                                                    |
| Fetch channel messages | No                                                     |
| List threads           | Yes (25 conversations per page, newest activity first) |
| Fetch channel info     | Yes                                                    |
| Post channel message   | No                                                     |

`fetchMessages` pages back 20 messages at a time and forward up to 100. It returns private notes and activity messages too, so filter on `message.raw.private` and `message.author.isSystem`.

### Incoming message types

| Type                                | Supported                                                               |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Text                                | Yes (markdown, with links collected)                                    |
| Images, video, audio, and files     | Yes (downloaded on demand through `fetchData()`)                        |
| Voice notes                         | Yes (Chatwoot's transcript becomes the text when the message has none)  |
| Locations                           | Yes (`Location: <name> (<lat>, <long>)` as the text)                    |
| Instagram posts, reels, and stories | Yes (as images and videos)                                              |
| Card picks                          | Yes (reach `onAction`, with a `triggerId`, instead of message handlers) |
| Declared slash commands             | Yes (reach `onSlashCommand`)                                            |
| Modal answers and widget forms      | Yes (reach `onModalSubmit`)                                             |
| Edits and deletes                   | Yes (`onMessageUpdated` and `onMessageDeleted`)                         |
| Other agents' and bots' replies     | Opt-in (`receiveAgentMessages`)                                         |
| Private notes                       | Opt-in (`receivePrivateNotes`)                                          |
| Activity messages                   | No (Chatwoot never sends them as webhooks)                              |

Chatwoot fires `message_updated` for any change, delivery status included, and delivers webhooks in no particular order. An update reaches `onMessageUpdated` only when its content differs from what the adapter last saw for that message, and an update that arrives before its message is no edit. Deletes reach `onMessageDeleted` once.

[sample-messages.md](sample-messages.md) shows the payload shapes Chatwoot sends.

### Cards and buttons

A card's text renders as markdown, with fields as `**Label:** value` lines and tables in a code block, and its images go out as attachments of the same message, which every inbox delivers. Its buttons and select options become an `input_select`, the only interactive content Chatwoot patches back onto a message. Each channel answers it its own way:

- The web widget reports the pick on the card itself.
- WhatsApp renders native buttons (up to 3, then a list) and sends the tapped button's title back, quoting the card.
- Telegram and LINE send the button's value, and Facebook its title.
- Instagram and email show the options as text, and a reply that is exactly an option's title or value counts as the pick.

The adapter keeps each card's options in Chat SDK state for 24 hours. A message that matches an option of the card it quotes, or of the conversation's latest card, fires `onAction` and never reaches your message handlers. Keep labels under 20 characters, which WhatsApp enforces and Chatwoot doesn't check, and values under 64 bytes for Telegram. Link buttons render as markdown links, and a card posted as a private note goes without its options. Chatwoot's own `cards` content is not used: its postback buttons only raise an event in the visitor's browser and never reach Chatwoot.

A card image keeps the name its URL ends with, and Chatwoot shows it as an image when that name has an image extension, such as `.png` or `.jpg`.

### Slash commands

Chatwoot has no slash commands, so list yours in `slashCommands`. A contact's message whose first word matches one, ignoring case, reaches `onSlashCommand` instead of the message handlers: `"/help me"` arrives as command `/help` with text `"me"`, and any other text starting with `/` stays a message. The event's channel is the conversation, so `event.channel.post()` answers there.

```typescript
createChatwootAdapter({ slashCommands: ["/help"] });

bot.onSlashCommand("/help", async (event) => {
  await event.channel.post(`Looking into ${event.text}`);
});
```

### Modals

`event.openModal()` works from every slash command and card pick, since each carries a `triggerId`. Build one yourself with `triggerIdOf(threadId, contactId)` to call `adapter.openModal()` directly.

- **In a website widget**, a modal whose fields are all required text inputs, text areas, selects, or radio selects shows as Chatwoot's native form, and the values the visitor submits reach `onModalSubmit`. The adapter only accepts the fields it asked, with the options it offered.
- **Anywhere else**, or with a number, date, external select, optional, or length-limited field, the modal runs as a conversation. Each field is asked in turn, a select as numbered options answered by number or label, and a reply that doesn't fit is asked again. `skip` keeps an optional field empty or its initial value, an external select searches through `onOptionsLoad`, and `cancel`, or the modal's `closeLabel`, stops it, telling `onModalClose` when the modal sets `notifyOnClose`.

Either way, an `errors` response asks again for just those fields, and `update` or `push` opens the new modal. An open modal waits a day for its answers, kept in Chat SDK state per account, conversation, and contact. Set `modalTexts` to put the conversation's few phrases in your contacts' language.

## Chatwoot extensions

Reach Chatwoot features that have no Chat SDK equivalent through `requireChatwootAdapter(thread)`, or narrow with `isChatwootAdapter(thread.adapter)` when the bot runs other adapters too:

```typescript
import { chatwootMention, requireChatwootAdapter } from "chat-adapter-chatwoot";

bot.onDirectMessage(async (thread, message) => {
  const chatwoot = requireChatwootAdapter(thread);

  await chatwoot.postPrivateNote(
    thread.id,
    `${chatwootMention(30, "Bruce")} needs a look`,
  );
  await chatwoot.setLabels(thread.id, ["needs-human"]);
  await chatwoot.assign({ threadId: thread.id, assigneeId: 30 });
  await chatwoot.toggleStatus({ threadId: thread.id, status: "open" });
});
```

| Method                                             | Description                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postPrivateNote(threadId, message)`               | Post a private note, which agents see and the contact never does. Mentions built with `chatwootMention(id, name)` notify the agent or team                                         |
| `toggleStatus({ threadId, status, snoozedUntil })` | Open, resolve, snooze, or move a conversation back to pending                                                                                                                      |
| `assign({ threadId, assigneeId, teamId })`         | Assign an agent, a team, or both. Pass `null` to unassign                                                                                                                          |
| `setPriority({ threadId, priority })`              | Set the priority, or clear it with `null`                                                                                                                                          |
| `setLabels(threadId, labels)`                      | Replace the conversation's labels                                                                                                                                                  |
| `setCustomAttributes(threadId, attributes)`        | Replace the conversation's custom attributes; Chatwoot doesn't merge them                                                                                                          |
| `mute(threadId)` / `unmute(threadId)`              | Resolve the conversation and **block the contact across the account**, then unblock them. This is Chatwoot's mute, not a notification setting                                      |
| `markAsUnread(threadId)`                           | Restore the conversation's unread badge                                                                                                                                            |
| `openDM(contactId)`                                | Reuse one of the contact's conversations, preferring an unresolved one, or open one in their own inbox (or `inboxId`) when they have none                                          |
| `openModal(triggerId, modal)`                      | Open a modal for the contact a `triggerIdOf(threadId, contactId)` names, as described in [Modals](#modals)                                                                         |
| `getUser(userId)`                                  | Look a user up as a contact, then among agents when no contact has that ID. Contacts and agents are numbered apart, so an agent that shares a contact's ID resolves to the contact |
| `fetchContact(contactId)`                          | Fetch a contact's full record                                                                                                                                                      |
| `listAgents()`                                     | List the account's agents                                                                                                                                                          |
| `fetch(endpoint, request)`                         | Call any Application API route under `/api/v1`, with typed errors, the request timeout, and retries                                                                                |

`onEvent` receives every verified payload, so conversation lifecycle, typing, contact, and inbox events are available too:

```typescript
createChatwootAdapter({
  onEvent: (event) => {
    if (event.event === "conversation_resolved") metrics.increment("resolved");
  },
});
```

A GET that fails on the network, times out, or gets a 5xx is retried up to three times with backoff, and so is a 429 whose `Retry-After` is 5 seconds or less. Writes are never retried, since Chatwoot cannot tell a retried write from a new one. Timeouts and 5xx responses raise `NetworkError`, and other failures map onto the matching `@chat-adapter/shared` error.

## Security

- **Signatures.** Every webhook must carry an `X-Chatwoot-Signature`, the HMAC-SHA256 of `{timestamp}.{body}`, that matches one of the configured secrets. A signature more than five minutes old is refused as a replay. An unsigned body is refused before it is read, and an oversized one before it is buffered. Without a secret every webhook is refused. `allowUnverifiedWebhooks` lifts that for local development, and anyone who can reach the route can then post as any contact.
- **Account check.** Thread IDs come from the payload, while replies go to the configured account. Every webhook names its account, a typing event through its conversation, and one that names another account is acknowledged and ignored, `onEvent` included. A secret shared across accounts, such as a global agent bot's, therefore cannot make the bot answer in the wrong one. A message that names no account is ignored as well.
- **Private notes and agents.** Only the contact's messages reach your handlers unless you opt in, as described in [Usage](#usage).
- **Card picks and forms.** A contact can rewrite any message's `submitted_values` through Chatwoot's public API. The adapter only accepts an option it offered on that card, in that conversation, within 24 hours, and a private note's card offers none. A form counts only when it is the one the adapter sent that contact, answered with exactly its fields and options.
- **Access token.** The token goes only to Chatwoot's API and its ActiveStorage file paths on the configured origin. Attachment URLs off that origin, including the storage service ActiveStorage redirects to, go through the shared SSRF-guarded downloader: HTTPS only, private addresses refused, and every redirect checked again. Downloads stop at 40 MB and at `timeoutMs`.

## Thread ID format

```
chatwoot:{inboxId}:{contactId}:{conversationId}
```

Example: `chatwoot:10:20:300`

`conversationId` is Chatwoot's account-scoped `display_id`, the ID every conversation route takes. `contactId` is `0` when a payload names no contact. Channel IDs are `chatwoot:{inboxId}`.

To run two Chatwoot accounts in one bot, give each adapter an `adapterName` and register it under that same key, so `chat.thread(threadId)` resolves the right one:

```typescript
adapters: {
  "chatwoot-sales": createChatwootAdapter({ adapterName: "chatwoot-sales", accountId: 2 }),
  "chatwoot-support": createChatwootAdapter({ adapterName: "chatwoot-support", accountId: 3 }),
}
```

## Troubleshooting

### Every webhook is refused with 401

- `No webhook secret configured`: set `CHATWOOT_WEBHOOK_SECRET` or `webhookSecret`.
- `Invalid signature`: the secret doesn't match the source. The account webhook, each API inbox, and each agent bot sign with their own, so pass every one that reaches the route.
- `Stale signature`: the request's timestamp is more than five minutes from the server clock. Check the clock, or raise `timestampToleranceMs`.

### Every agent bot conversation opens at once

Chatwoot hands a conversation in an agent bot's inbox to people whenever a `message_created` or `message_updated` delivery fails: any status but `200`, a timeout, or the route being down. A missing or wrong secret shows up exactly like this.

### Agents' replies or private notes never reach the handlers

That is the default. Set `receiveAgentMessages` or `receivePrivateNotes` to receive them.

### Events are ignored as "from another Chatwoot account"

The payload's account differs from `accountId`. Check `CHATWOOT_ACCOUNT_ID`, or run one adapter per account with its own `adapterName`.

### `PermissionError` mentioning "agent access token"

The token belongs to an agent bot, and Chatwoot refuses that method for bots. Use an agent's access token for the full adapter, as described in [Agent bot tokens](#agent-bot-tokens).

### Attachment downloads fail with `NetworkError`

A file outside Chatwoot's origin must be on a public HTTPS host. Storage on a private network or over plain HTTP is refused by the SSRF guard, as are files over 40 MB.

## License

MIT
