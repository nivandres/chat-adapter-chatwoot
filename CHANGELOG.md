# Changelog

## 0.1.0

Initial release, run end to end against Chatwoot 4.18 — account webhooks, API inbox webhooks and an agent bot.

- Every Chatwoot channel through one webhook: messages, attachments, voice-note transcripts and locations in; markdown, files, quoted replies, private notes and buffered streams out.
- Only the contact's own messages reach Chat SDK's handlers. Other agents' and bots' replies, and private notes, come in with `receiveAgentMessages` and `receivePrivateNotes`, so a bot never repeats an internal note to a customer and two bots never answer each other.
- A card's buttons and select options become an `input_select`, and a pick reaches `onAction` on every channel: the web widget's own report, and the message WhatsApp, Telegram, Facebook and LINE send back instead. Only an option the adapter offered on that card, in that conversation, counts, since a contact can patch the widget's answer through Chatwoot's public API.
- A card's images go out as attachments of the same message, its fields as bold labels and its tables in a code block.
- Declared `slashCommands` reach `onSlashCommand`, and `event.channel.post()` answers in the conversation they came from.
- Modals: a website widget shows one as Chatwoot's native form, and anywhere else each field is asked in turn, with numbers, dates, searches, `skip` and `cancel`. Every card pick and command carries a `triggerId`, and `triggerIdOf` builds one.
- Deletes reach `onMessageDeleted` and edits `onMessageUpdated`, each once, though Chatwoot fires `message_updated` for any change, resends it, and delivers webhooks out of order. An edit back to earlier content counts as an edit too.
- Conversation control: status and snooze, assignee and team, priority, labels, custom attributes, read state and mute, with `openDM` reusing a contact's conversation or opening one in their own inbox, and `getUser` reading contacts, then agents.
- Agent and agent bot tokens alike. A bot token is detected at startup, Chat SDK keeps its thread history since it cannot list messages, and what Chatwoot refuses it surfaces as a `PermissionError`.
- Webhooks must be signed, and are verified against every secret given, since the account, an API inbox and an agent bot each sign with their own. Without a secret they are refused unless `allowUnverifiedWebhooks` is set. A signature older than five minutes is refused as a replay, an unsigned or oversized body is refused without buffering it, and an event from another account is ignored.
- The same payload from the account webhook and an API inbox is handled once. An event a newer Chatwoot adds is acknowledged, and a value it adds to an enum passes through, rather than failing the webhook, which would hand an agent bot's conversation to a person.
- Every request times out, and a GET that fails on the network, with a 5xx, or with a short `Retry-After` is retried with backoff. Writes never are.
- Files sent with a message keep their line breaks, which `FormData` would have turned into CRLF.
- Attachments download with the access token on Chatwoot's ActiveStorage paths only, and anything off its origin, the storage redirect included, goes through the shared SSRF-guarded downloader, within a size and time limit.
- `@chat-adapter/shared` is a peer dependency, so its error classes are the ones your app imports.
