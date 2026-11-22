# ChatGPT web backend API (as observed)

This file records what this project knows about the HTTP API that the chatgpt.com web page
calls. OpenAI publishes no specification for it. Everything here comes from observation and can
change without notice. Treat each claim as true only for the evidence it names.

Snapshot: **2026-11-22**. Re-verify before relying on a field that matters.

## Evidence labels

| Label | Meaning |
| --- | --- |
| **LIVE** | A request sent from a signed-in chatgpt.com tab on 2026-11-22 returned this. |
| **PAGE** | The chatgpt.com page itself requested this URL (browser resource-timing entries of a live tab, 2026-11-22). |
| **REPO** | Code in this repository calls it; the cited file is the source. |
| **ARCHIVE** | A sample of 1,249 raw conversation bodies (2022-12 to 2026-11) archived by the sibling `chatgpt-web-export` tool. Field presence is a share of those files. |
| **BUNDLE** | The path appears as a string in the page's JavaScript bundles. This proves the name exists in the client. It does not prove the method, the body or whether the path is a backend route or a page route. |

Where a statement has no label, it is a definition or a consequence of labelled facts.

## Transport and authentication

- **Origin.** `https://chatgpt.com`. Every route below is relative to it. Backend routes start with
  `/backend-api/`. (PAGE, REPO)
- **Session.** `GET /api/auth/session` (cookies only) returns the session object. (LIVE)
  Its fields: `accessToken` (JWT), `expires`, `sessionToken`, `authProvider`, `user`
  (`id`, `email`, `name`, `iat`, `amr`, `acr`, `mfa`), `account` (`id`, `planType`, `structure`,
  `isDelinquent`, residency fields, workspace flags), `statsigContext` (`locale`, `userAgent`,
  `ip`, `country`, `region`, `regionCode`, `deviceId`, `adsSegmentId`), `marketingEligibility`,
  `WARNING_BANNER`. The body is about 37 KB and contains credentials. Never log it.
- **Backend calls.** Send `Authorization: Bearer <accessToken>` with `credentials: 'include'`,
  from inside a page on the chatgpt.com origin. (LIVE, REPO: `extension/background.js`,
  `scripts/chat-list.py`)
- **Calls from outside a page.** `/api/auth/session` answers 403 to scripts. A script instead
  needs the saved credentials and these headers: `Authorization`, `ChatGPT-Account-Id`, `Cookie`,
  a browser `User-Agent`, `Origin: https://chatgpt.com`, `Referer: https://chatgpt.com/`.
  (REPO: `src/main/chatgpt-limits.ts`)
- **Drive a signed-in tab.** This project reaches the page through the Chromium DevTools
  protocol on `127.0.0.1:9222` and evaluates `fetch` in the tab. `chatgpt-web-export`
  (`src/chatgpt_web_export/cdp.py`) does the same.
- **Not part of the API.** The page also calls `ab.chatgpt.com/v1/initialize` (HTTP 204), and
  `/ces/v1/rgstr`, `/ces/v1/telemetry/intake`, `/ces/statsc/flush` for analytics. (PAGE)

## Rate limits

Three separate limits exist. Do not mix them.

### 1. History-detail budget (HTTP 429)

- **What it limits.** Reads of a whole conversation: `GET /backend-api/conversation/{id}` and
  `GET /backend-api/conversations/{id}?num_turns=…`. (LIVE)
- **Answer.** `429` with body `{"detail":"Too many requests"}`, header `Retry-After: 50` or `51`
  (seconds), and header `X-OAI-History-Detail-Rate-Limited: 1`. (LIVE)
  `extension/content.js` records `Retry-After` of 12 to 34 s on 2026-10-11. (REPO)
- **What it does not limit.** While both reads answered 429, these answered 200: the sidebar
  list, `stream_status`, `wham/usage`, `conversation/init`, `me`, `models`, `accounts/check`,
  `settings/user`, `pins/content`, `tbo`, `pets`, `gizmos/snorlax/sidebar`. (LIVE)
- **Cost per read.** The page's own reads of a conversation moved 663 KB (largest
  `conversation/{id}` transfer) and 2.6 MB (largest `conversations/{id}?num_turns=…` transfer).
  (PAGE)
- **The page is limited too.** When the budget is spent the page renders no turns and shows
  "Could not load this ChatGPT conversation". (REPO: `extension/content.js`)
- **Unmeasured.** The size of the budget, its refill rate, and whether failed attempts consume
  it. On 2026-11-22 it stayed exhausted across repeated attempts over many minutes (not timed).
  Honour `Retry-After`. Do not retry in a loop.

### 2. Usage limit on sending

`POST /backend-api/conversation/init` returns `blocked_features: [{name: "send", resets_after}]`
while the seat is blocked from sending. The deadline is fixed and does not slide. The page then
removes its send button. (REPO: `src/main/chatgpt-limits.ts`, `AGENTS.md`)

### 3. Quota windows

`GET /backend-api/wham/usage` reports quota windows: `rate_limit.allowed`,
`rate_limit.limit_reached`, `rate_limit.primary_window` (`used_percent`, `limit_window_seconds`,
`reset_after_seconds`, `reset_at`), `rate_limit.secondary_window`, `credits`, `spend_control`,
`rate_limit_reached_type`, `rate_limit_upsell`, `rate_limit_reset_credits`. (LIVE)
`POST conversation/init` also returns `limits_progress: [{feature_name, remaining,
reset_after}]`. (LIVE)

## Endpoints verified live

Request shapes marked "none" send no body. Status is what the call returned on 2026-11-22.

| Method and path | Status | Purpose |
| --- | --- | --- |
| `GET /api/auth/session` | 200 | Session and access token. See above. |
| `GET /backend-api/conversations?order=updated&is_archived={bool}&offset={n}&limit={n}` | 200 | Sidebar list. See [Sidebar list](#sidebar-list). |
| `GET /backend-api/conversation/{id}/stream_status` | 200 | Whether a turn is generating. See [Stream status](#stream-status). |
| `GET /backend-api/conversation/{id}` | 429 | Full conversation body. See [Conversation body](#conversation-body). |
| `GET /backend-api/conversations/{id}?num_turns={n}&include_has_versions=true` | 429 | The page's own load call. Body shape not observed. |
| `POST /backend-api/conversation/init` | 200 | Defaults, send block, limits. |
| `GET /backend-api/wham/usage` | 200 | Quota windows. |
| `GET /backend-api/me` | 200 | User profile. |
| `GET /backend-api/models` | 200 | Model catalogue. About 75 KB. |
| `GET /backend-api/accounts/check/v4-2023-04-27` | 200 | Account entitlement and feature list. About 10 KB. |
| `GET /backend-api/settings/user` | 200 | User settings. About 14 KB. |
| `GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0` | 200 | Projects (folders) for the sidebar. |
| `GET /backend-api/pins/content?include_sites=false&include_pages=true&limit={n}&include_checkpoint_cdn=true&prefer_lite_checkpoint=true` | 200 | Pinned items. |
| `GET /backend-api/tbo?limit={n}&include_room_preview=false` | 200 | Agent ("tbo") list. |
| `GET /backend-api/pets?limit={n}` | 200 | Companion list. |
| `GET /backend-api/celsius/ws/user` | 200 | Returns `{websocket_url}` for the page's realtime socket. |
| `GET /backend-api/codex/notification/subscriptions` | 405 | GET is not allowed. The page calls this path with another method. |
| `GET /backend-api/memory/status` | 404 | No such route for GET. |

## Sidebar list

`GET /backend-api/conversations`. (LIVE unless marked)

| Parameter | Observed behaviour |
| --- | --- |
| `order=updated` | Accepted. |
| `order=created` | **HTTP 500** `{"detail": …}`. Do not send it. |
| `is_archived=false` / `true` | Accepted. Selects live or archived chats. |
| `offset`, `limit` | `limit` above 100 returns **HTTP 422** (`type: less_than_equal`, `ctx.le: 100`). `chatgpt-web-export` pages with `limit=100`. (REPO) |

Response: `{items: [...], total, limit, offset}`. Each item has these keys:
`id`, `title`, `create_time`, `update_time`, `latest_assistant_turn_created_at`, `pinned_time`,
`mapping` (null), `current_node` (null), `conversation_template_id`, `gizmo_id`, `is_archived`,
`is_starred`, `is_temporary_chat`, `is_do_not_remember`, `memory_scope`, `context_scopes`,
`context_scopes_v2` (`{context_scopes: [...]}`), `workspace_id`, `async_status`, `safe_urls`,
`blocked_urls`, `conversation_origin`, `trial_conversation_type`, `snippet`, `summary_metadata`,
`sugar_item_id`, `sugar_item_visible`.

Facts about the list:

- `create_time` and `update_time` are **ISO-8601 strings** here. In the conversation body they
  are **epoch seconds** (float). (LIVE, ARCHIVE)
- `update_time` equals the conversation's own `update_time` at rest. It stays **frozen while a
  long turn runs** (measured: list 20:04, conversation 20:38). It does not decide whether a chat
  is active. (measured in this repository's development; `AGENTS.md`)
- The sequence is not strictly newest first. Pinned chats come first. A prefix of the list is
  not "the newest N chats". (measured in this repository's development)
- `latest_assistant_turn_created_at` was null in every item sampled (4 items). Its meaning is
  not established.
- Reading the whole list took 52 s for 1,409 chats (15 requests of 100). (measured)

## Stream status

`GET /backend-api/conversation/{id}/stream_status` answers `200` with `{"status": "COMPLETE"}`.
The reply is 21 bytes and took 0.2 to 0.4 s. The page polls it (22 calls in one tab). (LIVE, PAGE)

- A conversation id that does not exist also answers `200 {"status":"COMPLETE"}`. `COMPLETE`
  does not prove the chat exists. (LIVE)
- A turn that is running answers `{"status":"IS_STREAMING"}`. (LIVE, one chat, 2026-11-22; the
  same chat's batch `update_time` was 41 minutes newer than its sidebar-list `update_time`.)
  `just chats` treats only `IS_STREAMING` as running.
- The page maps a 404 from this route to `UNAVAILABLE`. (PAGE)
- It stayed available while the history-detail budget was exhausted. (LIVE)

## Conversation batch

`POST /backend-api/conversations/batch` with `{"conversation_ids": [...], "include_full_history": false}`
answers `200` with a JSON array of chat metadata, about 0.5 KB per chat, in 0.5 s for 10 chats. (LIVE, PAGE)

- More than 10 ids answers `422` "conversation_ids must contain at most 10 elements". (LIVE)
- Item keys: `id`, `title`, `create_time`, `update_time`, `latest_assistant_turn_created_at`
  (absent when null), `async_status` (absent for some chats), `is_archived`, `is_temporary_chat`,
  `is_do_not_remember`, `memory_scope`, `context_scopes_v2.context_scopes[]`, `safe_urls[]`,
  `blocked_urls[]`, `sugar_item_visible`. It has no `mapping`. (LIVE)
- Times are ISO strings. For 9 of 10 chats `update_time` equals the sidebar list's; for a chat
  with a running turn it was newer. (LIVE)
- It answered while the history-detail budget was exhausted. (LIVE)

## Conversation body

`GET /backend-api/conversation/{id}`. Shape from ARCHIVE; this is the stored form, which can
differ in small ways from a live read. HTTP 413 with `code` (or `detail.code`)
`conversation_length_exceeds_limit` rejects an oversized conversation. (REPO: `extension/fiber.js`)

### Top level

All keys below were present in 100% of sampled bodies unless a share is given.

| Key | Type | Notes |
| --- | --- | --- |
| `conversation_id` | string | Same as the id in the URL. |
| `title` | string or null | |
| `create_time`, `update_time` | float epoch seconds | `update_time` is occasionally an int. |
| `current_node` | string | Id of the newest node on the current branch. |
| `mapping` | object | Node id → node. The whole tree, including branches. |
| `default_model_slug` | string or null | |
| `is_archived`, `is_study_mode`, `is_temporary_chat`, `sugar_item_visible` | bool | |
| `is_do_not_remember`, `is_read_only` | bool or null | |
| `memory_scope` | string | `global_enabled` in every sampled body. |
| `gizmo_id`, `gizmo_type`, `conversation_origin`, `conversation_template_id`, `voice` | string or null | `gizmo_type` was `gpt`, `conversation_origin` was `tpp` where set. |
| `async_status` | int or null | 3 or 4 where set. |
| `safe_urls`, `blocked_urls`, `disabled_tool_ids`, `moderation_results` | list | |
| `context_scopes` | list or null | |
| `plugin_ids`, `owner`, `pinned_time`, `is_starred`, `sugar_item_id`, `atlas_mode_enabled` | null | Null in every sampled body. |
| `context_truncation_continuation` (57%), `sectioned_conversation` (54%) | null | |

### Node

`mapping[<id>]` = `{id, parent, children[], message}`. `parent` is null for the root. `message`
is null for the root node. In 445 of 500 sampled bodies the root id is `client-created-root`.
The current branch is the chain of `parent` links from `current_node` to the root. `children`
holds every branch below a node.

### Message

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `author` | object | `{role, name, metadata}`. `role` is `user`, `assistant`, `tool` or `system`. `name` is the tool name for tool messages (for example `container.exec`, `web.run`, `api_tool.call_tool`). |
| `create_time`, `update_time` | float or null | |
| `content` | object | Discriminated by `content_type`. See below. |
| `status` | string | `finished_successfully` (99%), `in_progress`, `finished_partial_completion`. Also seen in the wider sample: `completed`, `success`, `requested`, `done`, `resolved`, `pending`, `running`, `finished`. |
| `end_turn` | bool or null | True on the message that ends an assistant turn. |
| `weight` | int | 1 (93% of messages) or 0. The meaning of 0 is not established. |
| `recipient` | string | `all` for ordinary text. A tool name when the message calls a tool. |
| `channel` | string or null | `commentary` or `final`. |
| `metadata` | object | See below. |

In 7 of 500 sampled bodies the newest message on the current branch had `status: in_progress`.
A stored `in_progress` can also be a turn that stopped without finishing, so it is a hint and
not proof that a chat is generating.

### Content types

`content_type` and the other keys of `content` (ARCHIVE, 500-body sample, share of messages):

| `content_type` | Keys besides `content_type` | Share |
| --- | --- | --- |
| `code` | `language`, `text`, `response_format_name` | 65% |
| `thoughts` | `thoughts[]`, `source_analysis_msg_id` | 12% |
| `text` | `parts[]` (strings) | 11% |
| `execution_output` | `text` | 6% |
| `multimodal_text` | `parts[]` (strings, or objects with `content_type: image_asset_pointer`) | 4% |
| `reasoning_recap` | `content` | 1% |
| `model_editable_context` | `model_set_context`, `repo_summary`, `repository`, `structured_context` | under 1% |
| `user_editable_context` | `user_instructions`, `user_profile` | under 1% |
| `system_error` | `name`, `text` | under 1% |
| `computer_output` | `computer_id`, `is_ephemeral`, `screenshot`, `state`, `tether_id` | under 1% |
| `tether_browsing_display` | `assets`, `result`, `summary`, `tether_id` | under 1% |
| `tether_quote` | `domain`, `tether_id`, `text`, `title`, `url` | under 1% |

Common role and type pairs: assistant `code` (tool calls), tool `code`, assistant `thoughts`,
tool `execution_output`, assistant `text`, user `text`.

### Message metadata

Share of messages that carry the key (ARCHIVE). `model_slug` and `request_id` identify the model
and request for assistant messages.

- **Always present:** `can_save`, `model_switcher_deny`.
- **Most messages (over 90%):** `model_slug`, `parent_id`, `request_id`, `message_source`,
  `content_references`, `message_type`, `citations`, `default_model_slug`.
- **Turn state (over 50%):** `finish_details` (`{type: stop | interrupted | max_tokens | skipped}`),
  `is_complete`, `serialization_metadata`, `reasoning_status` (`is_reasoning`, `reasoning_ended`,
  `reasoning_cancelled`), `turn_exchange_id`, `working_turn_id`, `resolved_model_slug`.
- **Reasoning display:** `reasoning_title`, `reasoning_titles`, `reasoning_start_time`,
  `reasoning_end_time`, `finished_duration_sec`, `cot_version`, `thinking_effort`,
  `skip_reasoning_title`, `reasoning_recap_type`, `reasoning_group_id`.
- **UI flags:** `hide_inline_actions`, `disable_turn_actions`, `is_visually_hidden_from_conversation`,
  `is_thinking_preamble_message`, `is_user_system_message`, `chime_version`, `tool_icons`,
  `tool_summary_type`, `tool_invoking_message`, `tool_invoked_message`.
- **Tools and sources:** `invoked_plugin`, `invoked_resource`, `connector_tool_payload`,
  `search_result_groups`, `search_queries`, `selected_sources`, `selected_github_repos`,
  `command`, `permissions`, `system_hints`, `async_source`.
- **Other:** `classifier_response`, `timestamp_` (`absolute`), `summary_type`, `view_state`,
  `model_dil_v2`, `aggregate_result`, `safe_urls`, `debug_sonic_thread_id`, `turn_id`.

`message_type` values: `next` (98%), `variant`, `stream`, `image`, `timeout_interrupt`,
`system_error_interrupt`. `model_slug` values seen: `gpt-5-6-thinking`, `gpt-6-pro`,
`gpt-6-thinking`, `gpt-6`, `gpt-5-5-thinking`, `gpt-5-6-pro`, `gpt-5-2-thinking`, `gpt-5-6`,
`gpt-5-5-pro`, `gpt-4o`, `auto` (as a default slug). New slugs appear often; never match on a
fixed list.

## Other responses (LIVE)

Shapes list keys and types only.

- **`POST /backend-api/conversation/init`** — body
  `{gizmo_id: null, requested_default_model: null, conversation_id: null, timezone_offset_min: 0}`.
  Response: `{type: "conversation_detail_metadata", banner_info, blocked_features: [{name,
  resets_after}], model_limits: [], limits_progress: [{feature_name, remaining, reset_after}],
  default_model_slug, intended_default_model_slug, atlas_mode_enabled, enable_websocket}`.
- **`GET /backend-api/me`** — `{object: "user", id, name, email, phone_number, picture, created,
  is_test_user, chatgpt_eval_data, ads_segment_id, country, region, region_code, first_name,
  email_domain_type}`.
- **`GET /backend-api/models`** — `{title, secondary_title, models[], internal_groups[],
  categories[], versions, icons, default_model_slug, model_picker_version}`. Each model:
  `slug`, `max_tokens`, `title`, `description`, `tags[]`, `capabilities`, `product_features`,
  `enable_infer`, `enable_infer_opt_out`, `reasoning_type`, `configurable_thinking_effort`,
  `thinking_efforts[]`, `is_work_mode_model`, `artifact_capabilities`, `enabled_tools[]`,
  `daybreak`. 25 models in this snapshot.
- **`GET /backend-api/accounts/check/v4-2023-04-27`** — `{accounts: {<account id>: {account,
  features[], entitlement, last_active_subscription, eligible_offers, …}}, account_ordering[]}`.
  `account` has `account_user_role`, `account_id`, `plan_type`, `plan_display_name`, `structure`,
  `created_time`, `is_deactivated`, residency fields, workspace flags, `tbo_config`. `features`
  is a list of 64 feature-flag strings.
- **`GET /backend-api/settings/user`** — `{beta_settings, announcements, eligible_announcements,
  eligible_announcement_strings, persistent_announcements, settings, available_options,
  permissions, flags}`.
- **`GET /backend-api/gizmos/snorlax/sidebar`** — `{items: [{gizmo: {gizmo, tools[], files[],
  product_features, has_tpp_conversation, is_space_backing, project_file_limits,
  project_connector_scope_limits}, conversations: {items[], cursor}}], cursor}`. `cursor` pages
  the call. `chatgpt-web-export` reads `gizmo.gizmo.id` and `gizmo.gizmo.display.name`.
  (REPO)
- **`GET /backend-api/gizmos/{project id}/conversations?cursor={c}`** — project chat list;
  `cursor` starts at `"0"`; items carry `gizmo_id`. (REPO: `chatgpt-web-export`)
- **`GET /backend-api/pins/content?…`** — `{items[], cursor}`.
- **`GET /backend-api/tbo?limit={n}&include_room_preview=false`** — `{items: [{id, display_name,
  avatar_*, messaging_room_id, status, last_check_in_at, created_at, updated_at,
  active_root_thread_id, owner_account_user_id, is_primary, model_options[], …}], …}`.
  Related PAGE calls: `tbo/{id}`, `tbo/by-thread/{id}`, `messaging/rooms/{id}`,
  `messaging/rooms/{id}/messages?limit={n}`.
- **`GET /backend-api/pets?limit={n}`** — `{pets: [{id, name, description, spritesheet_url,
  spritesheet_url_expires_at, artwork_revision, shared_pet_id, updated_at}], cursor}`.
- **`GET /backend-api/celsius/ws/user`** — `{websocket_url}`.

## Writes and streaming (REPO unless marked)

- **Send a message:** `POST /backend-api/f/conversation` answers `200` with `text/event-stream`.
  Each event is a line `data: {json}`. The stream ends with `data: [DONE]`. Application
  failures arrive **inside the HTTP-200 stream** as an event carrying `error_code` and
  `conversation_id`; `conversation_too_large` is the code this project recognises. (`extension/fiber.js`,
  `scripts/test-conversation-error-protocol.mjs`)
- **Before a send:** the page calls `POST /backend-api/f/conversation/prepare` (200, PAGE).
- **Archive:** `PATCH /backend-api/conversation/{id}` with JSON `{"is_archived": true}`. A
  following `GET` shows `is_archived: true`. A `404` on `GET` or `PATCH` means the chat is gone.
  (`scripts/live-chatgpt-workstream.mjs`)
- **Page-side file reads:** the page calls `files/download/{file id}?download_intent=false&inline=true`
  and `estuary/content?id={file id}&…` for attached files. (PAGE)

## Machine-readable specification

`docs/chatgpt-backend-api.openapi.json` is an OpenAPI 3.1 description of the API. It holds every
call the page's JavaScript makes to the backend (1,473 operations): method, path, path
parameters, the query and body keys the call site names, and `x-evidence` for what else confirms
the operation. Types, enums and response schemas are filled in only where a live request or an
archived body confirmed them (the sidebar list, batch, `stream_status`, the conversation body,
and the 429 response). An empty schema means the type is unknown. A listed operation exists in
the client; it does not prove the server accepts the call for this account. Do not call one
without first observing the page call it. Regenerate it with `scripts/chatgpt-openapi.py`; the
file is generated, so edit the script's `OBSERVED` table, not the JSON.

The bundle also contains a route-label table used for the page's own telemetry, which pairs
these route shapes with IDs: `conversations` (CONV-02), `conversation/{id}/stream_status`
(CONV-05), `conversation/{id}` (CONV-03), `conversations/{id}` and `conversations/{id}/messages`
(CONV-26). The routes `conversation/{id}` and `conversation/{id}/stream_status` are separate
routes from `conversations/{id}`.

The page builds a request URL by joining a base (`https://chatgpt.com/backend-api`) with a
relative path, so a path can appear in the bundle without a leading `/backend-api`.

## How to refresh this file

1. **Live shapes.** From a signed-in tab, run one `fetch` per endpoint with the bearer token
   from `/api/auth/session`, a pause of about one second between calls, and record key names and
   types only. Never record values of ids, titles, tokens or text.
2. **Page traffic.** In the tab, read `performance.getEntriesByType('resource')` and group the
   names by path shape. This lists the routes the page itself calls and the status codes and
   transfer sizes it saw. It makes no API request.
3. **Bundles.** Run `uv run scripts/chatgpt-openapi.py --cache <dir>`. It fetches the page HTML,
   the entry chunks and every lazy chunk the webpack runtime maps, extracts each
   `.safeGet/.safePost/…("/path", {…})` call site, and rewrites the OpenAPI file.
4. **Conversation body.** Aggregate key paths and the value sets of enum-like keys over archived
   bodies (`chatgpt-web-export` stores them under its library root).
5. Update the snapshot date and every status code you re-observed, and add what you confirmed to
   `OBSERVED` in `scripts/chatgpt-openapi.py`.
