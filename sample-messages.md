# Chatwoot sample payloads

Real webhook and REST payload shapes, transcribed from Chatwoot 4.13. The producing method is
named above each one, because Chatwoot serializes the same record differently per route and the
differences are what `src/schema.ts` exists to absorb.

## `message_created` webhook

`Message#webhook_data` merged with the event name. Note that the contact sender has **no `type`
field**, `message_type` and `content_type` are **labels**, `created_at` is **ISO 8601**, the nested
conversation has **no `account_id`**, and its timestamps are **unix seconds** (`updated_at` a float).

```json
{
  "event": "message_created",
  "id": 3042,
  "content": "Hi there",
  "created_at": "2026-04-29T10:00:00.000Z",
  "message_type": "incoming",
  "content_type": "text",
  "content_attributes": {},
  "additional_attributes": {},
  "private": false,
  "source_id": null,
  "account": { "id": 2, "name": "Acme" },
  "inbox": { "id": 10, "name": "Website" },
  "sender": {
    "id": 20,
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "phone_number": null,
    "identifier": null,
    "thumbnail": "",
    "avatar": "",
    "blocked": false,
    "additional_attributes": {},
    "custom_attributes": {},
    "account": { "id": 2, "name": "Acme" }
  },
  "conversation": {
    "additional_attributes": {},
    "can_reply": true,
    "channel": "Channel::WebWidget",
    "contact_inbox": {
      "id": 55,
      "contact_id": 20,
      "inbox_id": 10,
      "source_id": "3d1f",
      "created_at": "2026-04-28T09:00:00.000Z",
      "updated_at": "2026-04-29T10:00:00.000Z",
      "hmac_verified": false,
      "pubsub_token": "tok"
    },
    "id": 300,
    "inbox_id": 10,
    "labels": [],
    "messages": [{ "id": 3042, "message_type": 0, "content_type": "text" }],
    "meta": {
      "sender": { "id": 20, "name": "Ada Lovelace", "type": "contact" },
      "assignee": null,
      "assignee_type": null,
      "team": null,
      "hmac_verified": false
    },
    "status": "open",
    "custom_attributes": {},
    "snoozed_until": null,
    "unread_count": 1,
    "first_reply_created_at": null,
    "priority": null,
    "waiting_since": 1777456800,
    "agent_last_seen_at": 0,
    "contact_last_seen_at": 0,
    "last_activity_at": 1777456800,
    "timestamp": 1777456800,
    "created_at": 1777456200,
    "updated_at": 1777456800.1234
  }
}
```

`conversation.id` is the account-scoped `display_id`, which is what every conversation route takes.

## Agent, agent bot and Captain senders

Only contacts omit `type`. `User#webhook_data` is slimmer than `User#push_event_data`, which is why
`available_name` is absent from webhooks.

```json
{
  "id": 7,
  "name": "Grace Hopper",
  "email": "grace@example.com",
  "type": "user"
}
```

```json
{ "id": 9, "name": "support-bot", "type": "agent_bot" }
```

```json
{
  "id": 3,
  "name": "Captain",
  "avatar_url": "https://…",
  "description": "…",
  "created_at": "2026-04-01T00:00:00.000Z",
  "type": "captain_assistant"
}
```

## `message_updated` webhook: a delete

Chatwoot has no delete event. `DELETE …/messages/:id` rewrites the content, resets `content_type`
and flags `content_attributes.deleted`, then the update event fires.

```json
{
  "event": "message_updated",
  "id": 3042,
  "content": "This message was deleted",
  "content_type": "text",
  "content_attributes": { "deleted": true },
  "message_type": "incoming",
  "created_at": "2026-04-29T10:00:00.000Z",
  "private": false,
  "account": { "id": 2, "name": "Acme" },
  "inbox": { "id": 10, "name": "Website" },
  "sender": { "id": 20, "name": "Ada Lovelace" },
  "conversation": { "id": 300, "inbox_id": 10, "status": "open" }
}
```

## `message_updated` webhook: an answered `input_select`

A web widget click patches `content_attributes.submitted_values`. The same event also fires for a
delivery-status change with identical content, which is why the adapter claims content once.

```json
{
  "event": "message_updated",
  "id": 3050,
  "content": "Approve this order?",
  "content_type": "input_select",
  "message_type": "outgoing",
  "created_at": "2026-04-29T10:02:00.000Z",
  "private": false,
  "content_attributes": {
    "items": [{ "title": "Approve", "value": "approve\napprove-42" }],
    "submitted_values": [{ "title": "Approve", "value": "approve\napprove-42" }]
  },
  "account": { "id": 2, "name": "Acme" },
  "inbox": { "id": 10, "name": "Website" },
  "sender": { "id": 7, "name": "Grace Hopper", "type": "user" },
  "conversation": { "id": 300, "inbox_id": 10, "status": "open" }
}
```

## `conversation_typing_on` webhook

```json
{
  "event": "conversation_typing_on",
  "is_private": false,
  "user": {
    "id": 7,
    "name": "Grace Hopper",
    "email": "grace@example.com",
    "type": "user"
  },
  "conversation": { "id": 300, "inbox_id": 10, "status": "open" }
}
```

## An attachment

`Attachment#push_event_data`. `extension`, `width` and `height` only appear for stored files;
`location`, `fallback` and `contact` types carry `fallback_title` and no file metadata at all.

```json
{
  "id": 5,
  "message_id": 3042,
  "file_type": "image",
  "account_id": 2,
  "extension": "png",
  "content_type": "image/png",
  "data_url": "https://chat.example.com/rails/active_storage/blobs/redirect/eyJ…/cat.png",
  "thumb_url": "https://chat.example.com/rails/active_storage/representations/redirect/eyJ…/cat.png",
  "file_size": 2048,
  "width": 64,
  "height": 48
}
```

## REST: `GET /api/v1/accounts/:id/conversations/:display_id/messages`

`api/v1/models/_message.json.jbuilder`. `message_type` is an **ordinal**, `created_at` is **unix
seconds**, there is no `conversation` object, and the sender is `push_event_data`, so it does carry
a `type`.

```json
{
  "meta": {
    "labels": [],
    "additional_attributes": {},
    "contact": { "id": 20, "name": "Ada Lovelace", "type": "contact" },
    "agent_last_seen_at": 0,
    "assignee_last_seen_at": 0
  },
  "payload": [
    {
      "id": 3043,
      "content": "Sure, one moment",
      "inbox_id": 10,
      "conversation_id": 300,
      "message_type": 1,
      "content_type": "text",
      "status": "sent",
      "content_attributes": {},
      "created_at": 1777456860,
      "private": false,
      "source_id": null,
      "sender": {
        "id": 7,
        "name": "Grace Hopper",
        "available_name": "Grace",
        "avatar_url": "",
        "type": "user",
        "availability_status": "online",
        "thumbnail": ""
      }
    }
  ]
}
```

`before=<id>` returns the 20 messages with a lower ID, oldest first. `after=<id>` returns up to 100
with a higher ID. `after=<id>&before=<id+1>` returns exactly that one message.

## REST: `GET /api/v1/accounts/:id/conversations/:display_id`

`api/v1/conversations/partials/_conversation.json.jbuilder`. This shape **does** carry `account_id`
and `muted`, nests the channel class under `meta.channel` rather than at the top level, and lists
the conversation's latest message as `push_event_data` — whose own nested `conversation` is a slim
subset with neither `id` nor `inbox_id`.

```json
{
  "meta": {
    "sender": { "id": 20, "name": "Ada Lovelace", "type": "contact" },
    "channel": "Channel::WebWidget",
    "hmac_verified": false
  },
  "id": 300,
  "messages": [
    {
      "id": 3042,
      "content": "Hi there",
      "account_id": 2,
      "inbox_id": 10,
      "conversation_id": 300,
      "message_type": 0,
      "content_type": "text",
      "status": "sent",
      "created_at": 1777456800,
      "private": false,
      "sender_type": "Contact",
      "sender_id": 20,
      "sender": { "id": 20, "name": "Ada Lovelace", "type": "contact" },
      "conversation": {
        "assignee_id": null,
        "unread_count": 1,
        "last_activity_at": 1777456800,
        "contact_inbox": { "source_id": "3d1f" }
      }
    }
  ],
  "account_id": 2,
  "uuid": "5f2c1e10-0b8e-4c2f-9f0a-2d1b3c4d5e6f",
  "can_reply": true,
  "inbox_id": 10,
  "labels": [],
  "muted": false,
  "snoozed_until": null,
  "status": "open",
  "created_at": 1777456200,
  "updated_at": 1777456800.1234,
  "timestamp": 1777456800,
  "unread_count": 1,
  "last_activity_at": 1777456800,
  "priority": null,
  "waiting_since": 1777456800
}
```

## Webhook headers

Chatwoot signs a webhook only when it has a secret.

```
Content-Type: application/json
X-Chatwoot-Delivery: 8e0f7f6a-1f4e-4a6b-9a3f-0b1c2d3e4f5a
X-Chatwoot-Timestamp: 1777456800
X-Chatwoot-Signature: sha256=<hex HMAC-SHA256 of "{timestamp}.{body}">
```
