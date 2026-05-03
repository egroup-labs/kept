# Kept — API Process Flow

## Provider Overview

| Provider | Endpoints | Conversation | Pagination | Images |
|----------|-----------|-------------|------------|--------|
| ChatGPT | Auth → List → Detail → File download | Node tree, sorted by `create_time` | `offset` + `limit` query params | Downloaded locally via signed URL |
| Claude | Org → List → Detail | `chat_messages` array, chronological | Not needed (returns all) | Not implemented |
| Gemini | `batchexecute` RPC (MaZiqc → hNvQHb) | Nested arrays, reversed (newest-first) | Token at `parsed[1]`, 100/page max | External CDN URL (CORS blocks download) |
| Grok | List → Node map → Load responses | Two-step fetch, sorted by timestamp | `nextPageToken` → `pageToken`, 60/page | Downloaded locally from `assets.grok.com` |
| Kimi | ListChats → ListMessages | `blocks[].text.content`, reversed | `nextPageToken` → `page_token`, 50/page | Not implemented |

---

### ChatGPT

**Endpoints:**
- `GET chatgpt.com/api/auth/session` → access token
- `GET chatgpt.com/backend-api/conversations?offset=&limit=&order=updated` → list
- `GET chatgpt.com/backend-api/conversation/{id}` → full conversation
- `GET chatgpt.com/backend-api/files/download/{fileId}?conversation_id={convId}` → signed image URL

**Conversation:** Parses `mapping` node tree. Filters `user`, `assistant`, `system`, `tool` roles. Sorts by `create_time`. Filters out DALL-E param strings from parts.

**Images:** Detects `image_asset_pointer` parts (both `file-service://` and `sediment://` prefixes). Fetches signed download URL, downloads as base64, saves to `~/.kept/vault/chatgpt/assets/`. Referenced as `http://localhost:18241/api/assets/chatgpt/{file_id}.png`.

---

### Claude

**Endpoints:**
- `GET claude.ai/api/organizations` → org UUID
- `GET claude.ai/api/organizations/{orgId}/chat_conversations` → list
- `GET claude.ai/api/organizations/{orgId}/chat_conversations/{convId}` → full conversation

**Conversation:** Iterates `chat_messages` array. Maps `sender: "human"` → `user`, `"assistant"` → `assistant`. Extracts text from `content[].text`.

**Images:** Not implemented.

---

### Gemini

**Endpoints:**
- `POST gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc` → conversation list
- `POST gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb` → full conversation (turn limit set to 10,000)

**Conversation:** Payload sent as `f.req` form parameter with nested JSON arrays. User text at `turn[2][0][0]`, AI text at `turn[3][0][0][1][0]`. Turns reversed (API returns newest-first). Requires `SNlM0e` XSRF token.

**Pagination:** Server caps at 100 conversations per page. Request format: `[100, pageToken, [0, null, 1]]`. First request uses `null` for token. Response returns next token at `parsed[1]` (string). Loop until `parsed[1]` is `null`.

**Images:** Recursive walker searches nested arrays for `lh3.googleusercontent.com` URL (index 3) and `image/*` MIME (index 11). **Not downloaded** — Google CDN blocks CORS from extensions. URL embedded directly in markdown; images load at render time.

---

### Grok

**Endpoints:**
- `GET grok.com/rest/app-chat/conversations?pageSize=60[&pageToken=...]` → list
- `GET grok.com/rest/app-chat/conversations/{id}/response-node?includeThreads=true` → node map
- `POST grok.com/rest/app-chat/conversations/{id}/load-responses` → messages

**Conversation:** Two-step fetch: get response node IDs, then load content with `{ responseIds: [...] }`. Sorted by timestamp. Requires `x-xai-request-id` UUID header.

**Pagination:** 60 conversations per page. Response includes `nextPageToken` (= last conversation's ID). Pass as `&pageToken=` query param. Loop until no `nextPageToken` in response.

**Images:** Extracts `fileUri` from `fileAttachmentsMetadata`. Sanitizes filename (removes path separators). Downloads from `assets.grok.com/{fileUri}` with credentials. Saves locally. Referenced as `http://localhost:18241/api/assets/grok/{name}.{ext}`.

---

### Kimi

**Endpoints:**
- `POST kimi.com/apiv2/kimi.chat.v1.ChatService/ListChats` → list
- `POST kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages` → messages

**Conversation:** Extracts text from `blocks[].text.content`. Messages reversed (API returns newest-first). Auth token read from `kimi-auth` cookie.

**Pagination:** 50 conversations per page. Response includes `nextPageToken` (opaque base64 string). Pass as `page_token` in the JSON POST body. Loop until no `nextPageToken` in response.

**Images:** Not implemented.

---

## Final Markdown Structure

~~~markdown
---
id: "{conversation_id}"
platform: "chatgpt" | "claude" | "gemini" | "grok" | "kimi"
title: "{title}"
synced: "2026-02-24T15:00:00.000Z"
messages: {count}
model: "{model_slug}"
tags:
  - "kept/{platform}"
---

# {Title}

### You — {iso_timestamp}

{User message content}

---

### Assistant — {iso_timestamp}

{Assistant message content}

![image](http://localhost:18241/api/assets/{platform}/{file_id}.png)

> **Prompt:** {DALL-E prompt if available}

---
~~~

**Notes:**
- Each message block separated by `---`, headers use `### Role — Timestamp`
- System messages use `### System`, tool messages use `### tool`
- Missing timestamps omit the `— timestamp` suffix
- Image URLs: local server for ChatGPT/Grok, external CDN for Gemini
