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

## Routes named only in the page bundle (BUNDLE)

Appendix A lists every call the page's JavaScript makes to the backend: method, path, and the
query and body keys the call site names. Call sites come from the whole build: the entry chunks
and all lazy chunks. A listed route exists in the client. It does not prove the server accepts
the call for this account. Do not call one without first observing the page call it.

The bundle also contains a route-label table used for the page's own telemetry, which pairs
these route shapes with IDs: `conversations` (CONV-02), `conversation/{id}/stream_status`
(CONV-05), `conversation/{id}` (CONV-03), `conversations/{id}` and `conversations/{id}/messages`
(CONV-26). The routes `conversation/{id}` and `conversation/{id}/stream_status` are separate
routes from `conversations/{id}`.

The page builds a request URL by joining a base (`https://chatgpt.com/backend-api`) with a
relative path, so a path can appear in the bundle without a leading `/backend-api`.

## Appendix A: client call catalogue (BUNDLE)

Source: every `.safeGet/.safePost/…("/path", {…})` call site in the page's JavaScript (the entry chunks and all 8,920 lazy chunks of the build served on 2026-11-22; 6 chunks did not download). Each line is one distinct method and path (1472 in all). `query` and `body` list the top-level keys the call site writes in `parameters.query` and `requestBody`; a call site that builds either object by spreading another value shows `...spread`, and its other keys are not listed. Paths are relative to `https://chatgpt.com/backend-api`. Response schemas are in minified code and are not extracted. An empty `query` or `body` means the call site names no key, not that the server accepts none. None of these lines was called live unless the main text says so.


### `accounts` (119)

| Call | query | body |
| --- | --- | --- |
| `POST /accounts/add_email/begin` |  | auth0_client_id, email |
| `GET /accounts/add_password/eligibility` |  |  |
| `GET /accounts/business_workspace_provisioning` | checkout_session_id, wait_ms |  |
| `POST /accounts/change_email/begin` |  | auth0_client_id, email, remove_social_subs |
| `GET /accounts/change_email/eligibility` |  |  |
| `GET /accounts/change_password/eligibility` |  |  |
| `GET /accounts/check/{version}` |  |  |
| `POST /accounts/create_quorum_workspace` |  | workspace_name |
| `POST /accounts/create_workspace_without_subscription` |  | agreed_to_dpa, plan_type, workspace_name |
| `POST /accounts/data_export` |  |  |
| `GET /accounts/data_usage_for_training` |  |  |
| `POST /accounts/deactivate` |  |  |
| `GET /accounts/discoverable-workspaces/v2` | cursor, include_free_workspaces, include_member_counts, query, use_k12_lookup |  |
| `POST /accounts/export_and_deactivate` |  |  |
| `GET /accounts/logout-impact` |  |  |
| `POST /accounts/logout_all` |  |  |
| `POST /accounts/mfa/enroll` |  | factor_type, phone_number, phone_verification_channel, source |
| `POST /accounts/mfa/factor_decision` |  | entrypoint |
| `POST /accounts/mfa/user/activate_enrollment` |  | code, factor_type, session_id, source |
| `POST /accounts/mfa/user/disable_in_house` |  | factor_id |
| `POST /accounts/mfa/user/request_mfa_token_in_house` |  |  |
| `POST /accounts/mfa/user/sms/resend_otp_for_enrollment` |  | factor_id, session_id |
| `POST /accounts/mfa/user/update_factor_name` |  | factor_id, factor_name |
| `GET /accounts/mfa_info` |  |  |
| `GET /accounts/optimized/check` |  |  |
| `GET /accounts/pending_team_workspace` |  |  |
| `POST /accounts/pending_team_workspace` |  | query_params, step_name, user_segment |
| `POST /accounts/personal` |  |  |
| `GET /accounts/personal-migration/grace-period` |  |  |
| `GET /accounts/policy_status` |  |  |
| `POST /accounts/policy_status/{moderation_action_id}/appeal_link` |  |  |
| `GET /accounts/restrictions` |  |  |
| `GET /accounts/restrictions/notice` | product_area |  |
| `GET /accounts/security/recommendations` |  |  |
| `POST /accounts/security/session_review/acknowledge` |  |  |
| `POST /accounts/security_settings/advanced_protection_mode/disable` |  |  |
| `GET /accounts/security_settings/info` |  |  |
| `POST /accounts/security_settings/yubikey/order_link` |  |  |
| `POST /accounts/send_add_credits_nudge_email` |  | credit_type |
| `GET /accounts/sessions` | include_trusted_devices |  |
| `POST /accounts/sessions/revoke` |  | session_id |
| `POST /accounts/transfer` |  | expected_billing, migration_trigger, workspace_id |
| `GET /accounts/transfer/billing` | workspace_id |  |
| `GET /accounts/transfer/status` | include_accepted, workspace_id |  |
| `POST /accounts/trusted_devices/revoke` |  | device_id_hash |
| `GET /accounts/user_events` | cursor, limit |  |
| `PATCH /accounts/users/name` |  | name |
| `POST /accounts/users/signup_attribution` |  |  |
| `GET /accounts/verified_access` |  |  |
| `PATCH /accounts/{account_id}` |  | name, profile_picture_id |
| `GET /accounts/{account_id}/admin/pending_request_count` |  |  |
| `GET /accounts/{account_id}/admin/usage_recovery` |  |  |
| `GET /accounts/{account_id}/connectors/{connector_id}/workspace_permissions` | include_admin_only |  |
| `POST /accounts/{account_id}/connectors/{connector_id}/workspace_permissions` |  |  |
| `GET /accounts/{account_id}/customer-balance` | include_redemption_status |  |
| `GET /accounts/{account_id}/groups` | include_member_counts, include_total, limit, offset, query, selected_ids |  |
| `GET /accounts/{account_id}/identity` |  |  |
| `GET /accounts/{account_id}/invite-link` |  |  |
| `PATCH /accounts/{account_id}/invite-link` |  | auto_approve_requests |
| `POST /accounts/{account_id}/invite-link` |  |  |
| `DELETE /accounts/{account_id}/invites` |  | email_address |
| `GET /accounts/{account_id}/invites` | include_expired, include_pending, include_requests, limit, offset, query, request_type |  |
| `POST /accounts/{account_id}/invites` |  | email_addresses, flow_id, resend_emails, role, seat_type, submission_id |
| `POST /accounts/{account_id}/invites/accept` |  |  |
| `POST /accounts/{account_id}/invites/accept_all_requests` | request_type |  |
| `POST /accounts/{account_id}/invites/request` |  | analytics_context, intent, seat_type |
| `PATCH /accounts/{account_id}/invites/{invite_id}` |  | ...spread, accept_request |
| `POST /accounts/{account_id}/invites/{invite_id}/resend` |  |  |
| `GET /accounts/{account_id}/metadata` |  |  |
| `GET /accounts/{account_id}/migration-candidates/count` |  |  |
| `GET /accounts/{account_id}/onboarding_metadata` |  |  |
| `PATCH /accounts/{account_id}/onboarding_metadata` |  |  |
| `GET /accounts/{account_id}/reactivation/member_names` |  |  |
| `GET /accounts/{account_id}/reactivation/paid_members` |  |  |
| `PATCH /accounts/{account_id}/reactivation/paid_members` |  | member_ids, seat_type |
| `DELETE /accounts/{account_id}/reactivation/paid_members/{user_id}` | checkout_session_id, processor_entity |  |
| `PATCH /accounts/{account_id}/reactivation/paid_members/{user_id}` |  | seat_type |
| `GET /accounts/{account_id}/remaining_balance` |  |  |
| `GET /accounts/{account_id}/renewal-prompt` |  |  |
| `POST /accounts/{account_id}/renewal-prompt/request` |  |  |
| `GET /accounts/{account_id}/settings` | include_workspace_discovery |  |
| `POST /accounts/{account_id}/settings/auto_accept_requests` |  | value |
| `GET /accounts/{account_id}/settings/auto_accept_requests/pending` |  |  |
| `POST /accounts/{account_id}/settings/workspace_discoverable` |  |  |
| `GET /accounts/{account_id}/spend-controls/current-user/monthly-usage` | supports_usage_limit_modes |  |
| `GET /accounts/{account_id}/teammate-invite-suggestions` |  |  |
| `GET /accounts/{account_id}/teams` | include_space_resolution, limit, offset |  |
| `POST /accounts/{account_id}/teams` |  |  |
| `GET /accounts/{account_id}/teams/avatars` |  |  |
| `DELETE /accounts/{account_id}/teams/{team_id}` |  |  |
| `GET /accounts/{account_id}/teams/{team_id}` |  |  |
| `PATCH /accounts/{account_id}/teams/{team_id}` |  | avatar |
| `GET /accounts/{account_id}/teams/{team_id}/activities` | cursor, limit |  |
| `POST /accounts/{account_id}/teams/{team_id}/join` |  |  |
| `DELETE /accounts/{account_id}/teams/{team_id}/members` | principal_id, principal_type |  |
| `GET /accounts/{account_id}/teams/{team_id}/members` | limit, offset |  |
| `PATCH /accounts/{account_id}/teams/{team_id}/members` |  | principal_id, principal_type, role |
| `POST /accounts/{account_id}/teams/{team_id}/members/batch` |  | members |
| `GET /accounts/{account_id}/teams/{team_id}/sites` | cursor, limit |  |
| `GET /accounts/{account_id}/teams/{team_id}/spaces` | cursor, limit |  |
| `POST /accounts/{account_id}/teams/{team_id}/spaces` |  |  |
| `POST /accounts/{account_id}/usage_requests` |  | ...spread, reason |
| `GET /accounts/{account_id}/users` | include_last_month_usage, include_profile_photos, include_service_accounts, include_total, limit, offset, query, role, selected_ids |  |
| `GET /accounts/{account_id}/users/owner_count` |  |  |
| `GET /accounts/{account_id}/users/seat_type_counts` | for_reactivation_checkout |  |
| `DELETE /accounts/{account_id}/users/{user_id}` |  |  |
| `PATCH /accounts/{account_id}/users/{user_id}` |  | credit_limits, onboarding_information, role, seat_type |
| `GET /accounts/{account_id}/users/{user_id}/onboarding_answers` |  |  |
| `PATCH /accounts/{account_id}/users/{user_id}/onboarding_answers` |  | custom_role, kind, role |
| `GET /accounts/{account_id}/users/{user_id}/onboarding_information` |  |  |
| `POST /accounts/{account_id}/users/{user_id}/seat/update` |  | operation, seat_type |
| `GET /accounts/{account_id}/welcome-details` |  |  |
| `GET /accounts/{account_id}/workspace_admin_requests` | cursor, limit |  |
| `POST /accounts/{account_id}/workspace_admin_requests` |  | justification |
| `PATCH /accounts/{account_id}/workspace_admin_requests/{request_id}` |  | justification |
| `GET /accounts/{account_id}/workspace_banner` |  |  |
| `GET /accounts/{account_id}/workspace_policy` |  |  |
| `GET /accounts/{account_id}/workspace_policy/acknowledge` |  |  |
| `POST /accounts/{account_id}/workspace_policy/acknowledge` |  | policy_hash |

### `admin-requests` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /admin-requests` |  | request |

### `aeon-messaging` (5)

| Call | query | body |
| --- | --- | --- |
| `DELETE /aeon-messaging/phone` | generation |  |
| `GET /aeon-messaging/phone` | include_texting |  |
| `POST /aeon-messaging/phone` |  | phone_number |
| `POST /aeon-messaging/phone/verify` |  | challenge_id, code |
| `POST /aeon-messaging/texting/activate` |  | consent, expected_aeon_id, phone_generation |

### `agent` (1)

| Call | query | body |
| --- | --- | --- |
| `DELETE /agent/browser_context` | ...spread, surface |  |

### `ai` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /ai/account_linking` |  | identifier, proof |
| `POST /ai/account_linking/pre_check` |  |  |

### `aip` (65)

| Call | query | body |
| --- | --- | --- |
| `POST /aip/connectors/batch` | apply_eligibility_filter | connector_ids, include_actions |
| `POST /aip/connectors/email/send_email` |  |  |
| `POST /aip/connectors/email/send_email_status` |  |  |
| `POST /aip/connectors/email/unsend_email` |  |  |
| `POST /aip/connectors/github/has_installations` |  | link_id |
| `POST /aip/connectors/google_contacts/search_contacts` |  | limit, link_id, query |
| `DELETE /aip/connectors/links` |  | connector_id |
| `POST /aip/connectors/links/api_key` |  | ...spread, install_attempt_id |
| `POST /aip/connectors/links/list_accessible` |  | include_tags, link_refresh_strategy, principals |
| `POST /aip/connectors/links/noauth` |  | ...spread, action_names, connector_id, install_attempt_id, name |
| `POST /aip/connectors/links/oauth` |  | ...spread, install_attempt_id, post_auth_url, requested_companion_connector_ids, siwc_login, slack_team_id |
| `POST /aip/connectors/links/oauth/callback` |  | full_redirect_url |
| `POST /aip/connectors/links/oauth/reauth` |  | callback_url, link_id, post_auth_url, requested_scopes |
| `DELETE /aip/connectors/links/{link_id}` |  |  |
| `PATCH /aip/connectors/links/{link_id}` |  | apps_privacy_control |
| `POST /aip/connectors/mcp` |  | ...spread, auth_request, description, logo_url, name |
| `POST /aip/connectors/mcp/oauth_config` |  | ...spread, custom_headers, mcp_key, plugin_id, release_id |
| `POST /aip/connectors/mcp/refresh_actions` |  | link_id |
| `GET /aip/connectors/mcp/tunnels` |  |  |
| `GET /aip/connectors/oauth/callback_id` | mcp_url |  |
| `GET /aip/connectors/oauth_clients` | service |  |
| `POST /aip/connectors/service_accounts/links/api_key` |  |  |
| `POST /aip/connectors/service_accounts/links/list` |  | service_account_account_user_id |
| `POST /aip/connectors/service_accounts/links/noauth` |  |  |
| `POST /aip/connectors/service_accounts/links/oauth` |  | ...spread, service_account_account_user_id |
| `DELETE /aip/connectors/service_accounts/links/{link_id}` |  |  |
| `DELETE /aip/connectors/{connector_id}` |  |  |
| `GET /aip/connectors/{connector_id}` | apply_eligibility_filter, include_actions |  |
| `GET /aip/connectors/{connector_id}/actions` |  |  |
| `PATCH /aip/connectors/{connector_id}/description` |  | description |
| `GET /aip/connectors/{connector_id}/link` |  |  |
| `PATCH /aip/connectors/{connector_id}/logo` |  | logo_url |
| `GET /aip/connectors/{connector_id}/mfa_requirement` |  |  |
| `PATCH /aip/connectors/{connector_id}/name` |  | name |
| `GET /aip/connectors/{connector_id}/siwc` |  |  |
| `GET /aip/connectors/{connector_id}/tos` |  |  |
| `GET /aip/connectors/{connector_id}/workspace_configuration` |  |  |
| `GET /aip/first-party/eligibility` |  |  |
| `GET /aip/ledger/chats` | offset |  |
| `POST /aip/ledger/credit/alerts/{notification_token}/open` |  |  |
| `GET /aip/ledger/credit/connection` |  |  |
| `GET /aip/ledger/files` |  |  |
| `GET /aip/ledger/files/{file_id}/download_link` |  |  |
| `GET /aip/ledger/financial_memories` |  |  |
| `DELETE /aip/ledger/financial_memories/{ledger_financial_memory_id}` |  |  |
| `POST /aip/ledger/funnel-events` |  | beacon_type, component, entry_point, event_id, flow_id, flow_type, source, start, step |
| `GET /aip/ledger/links` |  |  |
| `DELETE /aip/ledger/links/{ledger_link_id}` |  |  |
| `DELETE /aip/ledger/links/{ledger_link_id}/accounts/{ledger_account_id}` |  |  |
| `POST /aip/ledger/links/{ledger_link_id}/sync` |  |  |
| `POST /aip/ledger/oauth/start` |  |  |
| `GET /aip/ledger/oauth/state/{oauth_state_id}` |  |  |
| `PATCH /aip/ledger/oauth/state/{oauth_state_id}` |  | status |
| `POST /aip/ledger/oauth/submit-public-token` |  |  |
| `GET /aip/ledger/widget_preferences` |  |  |
| `PATCH /aip/ledger/widget_preferences` |  |  |
| `GET /aip/ledger/widgets` | dashboard_limit, dashboard_offset, include_dashboard, include_onboarding |  |
| `GET /aip/ledger/widgets/metadata` |  |  |
| `GET /aip/olympic/chats` | offset |  |
| `POST /aip/olympic/debug/apple-health-fixture` |  | profile |
| `POST /aip/olympic/debug/google-health-connect-fixture` |  |  |
| `POST /aip/olympic/debug/test-account-connection` |  | mode, profile |
| `POST /aip/olympic/oauth/callback` |  | full_redirect_url |
| `GET /aip/workspace/connector-recommendation` | include_workspace_stats |  |
| `GET /aip/workspace/connector-stats` |  |  |

### `amphora` (16)

| Call | query | body |
| --- | --- | --- |
| `GET /amphora` |  |  |
| `POST /amphora` |  | role |
| `POST /amphora/clear_settings_cache` |  |  |
| `GET /amphora/notifications` | cursor, limit |  |
| `POST /amphora/notifications/{notification_id}/reacted` |  |  |
| `GET /amphora/settings_layout` |  |  |
| `GET /amphora/u18_graduation_unlink_setting_notices` |  |  |
| `POST /amphora/u18_graduation_unlink_setting_notices/dismiss` |  | notice_ids |
| `POST /amphora/{amphora_id}/invite` |  | choice |
| `GET /amphora/{amphora_id}/members` |  |  |
| `POST /amphora/{amphora_id}/members` |  | members |
| `POST /amphora/{amphora_id}/members/resend` |  | account_identifier |
| `PATCH /amphora/{amphora_id}/members/{user_id}/permissions` |  |  |
| `GET /amphora/{amphora_id}/members/{user_id}/settings` |  |  |
| `PATCH /amphora/{amphora_id}/members/{user_id}/settings` |  |  |
| `POST /amphora/{amphora_id}/remove` |  | user_id |

### `automation` (10)

| Call | query | body |
| --- | --- | --- |
| `GET /automation/{automation_id}` |  |  |
| `GET /automation/{automation_id}/execution_threads` | cursor, limit |  |
| `GET /automation/{automation_id}/latest_backing_run` | include_snapshot |  |
| `POST /automation/{automation_id}/run` |  |  |
| `GET /automation/{automation_id}/runs` | cursor, include_chat_ref, limit |  |
| `GET /automation/{automation_id}/runs/latest` |  |  |
| `GET /automation/{automation_id}/runs/{run_id}` |  |  |
| `POST /automation/{automation_id}/runs/{run_id}/read` |  | read_at |
| `POST /automation/{automation_id}/webhook_batch/run_now` |  | request_id |
| `GET /automation/{automation_id}/webhook_batch_state` |  |  |

### `automations` (7)

| Call | query | body |
| --- | --- | --- |
| `GET /automations` | ...spread, cursor, filter, limit, owner |  |
| `POST /automations/generate_creation_prompt` |  | post_id, prompt, schedule, timing_mode, title |
| `POST /automations/query` |  | ...spread, cursor |
| `POST /automations/remove` |  | automation_id |
| `POST /automations/save` |  | ...spread, team_id |
| `GET /automations/schedule_policy` | service_account_id |  |
| `POST /automations/set_status` |  | is_enabled, jawbone_id |

### `bazaar` (11)

| Call | query | body |
| --- | --- | --- |
| `POST /bazaar/ad-survey/render` |  |  |
| `POST /bazaar/ad-survey/response` |  | ...spread, reason_ids, response |
| `POST /bazaar/event` |  | ...spread, action, ad_data_token, display_type, target, web_frontend |
| `POST /bazaar/feedback-form` |  | ads_request_id, impressed_ad_data_tokens, type |
| `POST /bazaar/feedback-form/submit` |  | ads_request_id, feedback_option_id, feedback_text, impressed_ad_data_tokens, is_custom_text, type |
| `GET /bazaar/history` | cursor |  |
| `POST /bazaar/obi/sync-token` |  | obi, operation |
| `GET /bazaar/preferences` | cursor |  |
| `DELETE /bazaar/profile` |  |  |
| `POST /bazaar/signal-event` |  | ...spread, action, ad_data_token, ads_request_id, asset_origin, business_agent_gizmo_id, business_agent_id, debug_preview_ad_data_token, detection_source, interaction_type, probe_outcome |
| `POST /bazaar/visibility` |  | ...spread |

### `beacons` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /beacons/event` |  | beacon_id, conversation_id, event_cta_id, event_type, message_id |
| `GET /beacons/home` | ...spread, codex_fast_mode_eligible, codex_fast_mode_saved_ms, codex_fast_mode_thread_count, codex_window_type, desktop_voice_available, desktop_voice_nux_seen, notification_state, product, selected_model_slug, space_tooltip_ready, supported_home_tooltip_targets, web_frontend |  |
| `POST /beacons/request-account-team-contact` |  | beacon_id, campaign_id, client_event_id, event_cta_id, notification_type |

### `beacons_v2` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /beacons_v2` | ...spread, surface |  |

### `browser` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /browser/auth/store-credentials` |  | ...spread, operation_id, origin |
| `GET /browser/windows` | environment_id, tbo_id, thread_id |  |

### `business-profiles` (4)

| Call | query | body |
| --- | --- | --- |
| `POST /business-profiles/category-suggestions` |  | ...spread, business_type |
| `POST /business-profiles/product-card-chat-target` |  | hostname, source_surface |
| `POST /business-profiles/share-links/resolve` |  | segment |
| `POST /business-profiles/shopify/connect` |  | action, business_profile_id, idempotency_key, shop_hint, shopify_shop_gid |

### `buying-advisor` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /buying-advisor/session` |  | conversation_id, launch_attempt_id, message_id |

### `calpico` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /calpico/chatgpt/profile_files` |  |  |

### `celsius` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /celsius/ws/user` |  |  |

### `chat` (55)

| Call | query | body |
| --- | --- | --- |
| `GET /chat/frontend/v1/business-profiles` |  |  |
| `POST /chat/frontend/v1/business-profiles/creation` |  | action, business_profile_id, cursor, limit, session_id |
| `GET /chat/frontend/v1/business-profiles/invitations` | include_tenant_invitations |  |
| `GET /chat/frontend/v1/business-profiles/presence` | cursor |  |
| `POST /chat/frontend/v1/business-profiles/resolve` |  | ...spread, business_profile_id, entity_key, provider, provider_business_id, sidebar_summary, website_url |
| `GET /chat/frontend/v1/business-profiles/search` | include_local, limit, query |  |
| `POST /chat/frontend/v1/business-profiles/shopify/connect` |  | ...spread, action, flow_id, idempotency_key, receipt, shopify_shop_gid, shopify_test_override |
| `POST /chat/frontend/v1/business-profiles/shopify/discovery` |  |  |
| `POST /chat/frontend/v1/business-profiles/verification-flows` |  | ...spread, flow_type, idempotency_key, verification_method |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/ad-account-invitations` |  | ad_account_id, email |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts` | ...spread, include_connection_recovery, view |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts/connect` |  | ...spread, ad_account_id |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts/connect-operations` |  | ...spread, ad_account_id, request_id |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts/connect-operations/{operation_id}` | ad_account_id |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts/connection-lifecycle` |  | action, ad_account_id, expected_primary_revision, operation_id |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts/{ad_account_id}/connect-enrollment` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/ad-accounts/{ad_account_id}/connect-enrollment/retry` |  | operation_id, retry_token, step |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/admin-view` | consistency |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/claim-access/redeem` |  | grant_id |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/claim-preparation` | ...spread |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/hide` |  | expected_access_revoked_at |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/insights` |  | ...spread, compare_previous |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/insights/discovery-topics` |  | ...spread, compare_previous, latest_available |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/invitations/accept` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/invitations/decline` |  |  |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/manager` | ...spread, consistency |  |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/manager/business-verification` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/manager/business-verification` |  | action, challenge_id |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/manager/fields/{field_key}` | consistency, include_media_urls | confirmed, expected_revision, idempotency_key, operation, value, verify_website_domain |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/manager/verification-flows/{flow_id}` | consistency, include_media_urls, projection |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/manager/verification-flows/{flow_id}/checks/{check_key}/challenge` | consistency, projection |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/media/uploads` |  | file_name, mime_type, size_bytes, upload_key |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/media/uploads/{upload_id}/abandon` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/media/uploads/{upload_id}/finalize` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/member-ad-accounts/preview` |  | email |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/members` |  | ...spread, email |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/members/{member_id}/remove` |  | ...spread, expected_membership_revision |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/pending-identity` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/reauthentication-compatibility` |  | expected_tenant_id |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/share-links` |  |  |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/cancel` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/change-method` |  | ...spread, expected_updated_at, verification_method |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/domain-challenge` |  | action, challenge_id, idempotency_key, test_domain |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/email-challenge` |  | action, code, verification_id |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/resume` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/shopify-challenge` |  | action, receipt, shop_hint |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/verifications/{verification_id}/destination-confirmation` |  | confirmed, destination_channel, test_phone_number |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/verifications/{verification_id}/phone-otp` |  | code |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/verification-flows/{flow_id}/verifications/{verification_id}/resend` |  |  |
| `GET /chat/frontend/v1/business-profiles/{business_profile_id}/website-crawl` |  |  |
| `POST /chat/frontend/v1/business-profiles/{business_profile_id}/website-crawl/recrawl` |  |  |
| `POST /chat/frontend/v1/saved-entities` |  | ...spread, origin |
| `POST /chat/frontend/v1/saved-entities/remove` |  | saved_target |
| `POST /chat/frontend/v1/saved-entities/status` |  | targets |

### `checkout_pricing_config` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /checkout_pricing_config/configs/{country_code}` |  |  |

### `client_applications` (4)

| Call | query | body |
| --- | --- | --- |
| `GET /client_applications` |  |  |
| `DELETE /client_applications/{client_id}` |  |  |
| `GET /client_applications/{client_id}/permissions` |  |  |
| `POST /client_applications/{client_id}/permissions/revoke` |  | target |

### `cloud-aeons` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /cloud-aeons/avatar-snapshots` |  |  |
| `PUT /cloud-aeons/primary` |  | thread_id |
| `PATCH /cloud-aeons/{aeon_id}` |  | avatar_manifest, avatar_type, avatar_url |

### `cme` (6)

| Call | query | body |
| --- | --- | --- |
| `GET /cme/account` |  |  |
| `PATCH /cme/account` |  |  |
| `POST /cme/claims` |  |  |
| `GET /cme/conversations` | page, page_size, status |  |
| `POST /cme/conversations/{conversation_id}/remove` |  |  |
| `GET /cme/credits` | page, page_size |  |

### `codex-app-server` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /codex-app-server/prediction` |  |  |

### `codex` (19)

| Call | query | body |
| --- | --- | --- |
| `POST /codex/app-download-signal` |  | client_event_id, destination, platform, route_path, surface |
| `POST /codex/notification/subscriptions` |  |  |
| `PATCH /codex/optimize/jobs/{job_id}` |  | max_parallel_sessions |
| `POST /codex/optimize/jobs/{job_id}/cancel` |  |  |
| `GET /codex/sites/access` |  |  |
| `GET /codex/sites/projects/{project_id}/owner` |  |  |
| `POST /codex/sites/projects/{project_id}/owner` |  | owner_account_user_id |
| `PUT /codex/sites/projects/{project_id}/remix` |  | remix_enabled |
| `POST /codex/sites/projects/{project_id}/unpublish` |  | expected_project_etag |
| `POST /codex/sites/session_bootstrap` |  | ...spread, target_url |
| `GET /codex/sites/space/{page_id}` |  |  |
| `PUT /codex/sites/space/{page_id}` |  | project_id |
| `POST /codex/sites/toolbar/prewarm` |  | site_origin |
| `GET /codex/spo/dashboard/capabilities` |  |  |
| `GET /codex/spo/dashboard/jobs` | ...spread, limit, order |  |
| `GET /codex/spo/dashboard/jobs/{job_id}` |  |  |
| `GET /codex/spo/dashboard/jobs/{job_id}/session-page` | limit, offset, view |  |
| `GET /codex/spo/dashboard/jobs/{job_id}/sessions` | ...spread, limit, order |  |
| `GET /codex/spo/dashboard/jobs/{job_id}/sessions/{session_id}` |  |  |

### `college-plan` (18)

| Call | query | body |
| --- | --- | --- |
| `DELETE /college-plan` |  | expected_project_id |
| `GET /college-plan` |  |  |
| `GET /college-plan/automations` |  |  |
| `GET /college-plan/availability` |  |  |
| `POST /college-plan/initialize` |  |  |
| `GET /college-plan/items` | cursor, limit |  |
| `POST /college-plan/items` |  |  |
| `DELETE /college-plan/items/{item_id}` |  |  |
| `PATCH /college-plan/items/{item_id}` |  | completed |
| `GET /college-plan/profile` |  |  |
| `GET /college-plan/schools` | cursor, limit |  |
| `DELETE /college-plan/schools/{school_id}` |  |  |
| `GET /college-plan/schools/{school_id}` |  |  |
| `DELETE /college-plan/share` |  |  |
| `GET /college-plan/share` |  |  |
| `POST /college-plan/share` |  |  |
| `GET /college-plan/shared/{plan_id}` |  |  |
| `GET /college-plan/timeline` | cursor, include_completed, include_undated, limit, timezone |  |

### `compliance` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /compliance/age_verification/persona/inquiries/{inquiry_id}/status` |  |  |
| `POST /compliance/npi_verification/persona/inquiries` |  | enabled |

### `composer` (4)

| Call | query | body |
| --- | --- | --- |
| `POST /composer/intents` |  | context, context_revision, draft, draft_revision, enabled_intents, previous_file_search, schema_version |
| `GET /composer/items` | entrypoint, limit, supports_saved_lesson_chat, timezone |  |
| `POST /composer/items` |  | context, context_revision, decision_id, draft, draft_revision, entrypoint, mode, selection, target_key |
| `POST /composer/items/interactions` |  | chat_home_unit_id, entrypoint, id, interaction_type, item_type, producer |

### `computers` (1)

| Call | query | body |
| --- | --- | --- |
| `DELETE /computers/{environment_id}` |  |  |

### `conversation` (37)

| Call | query | body |
| --- | --- | --- |
| `POST /conversation/business-agent-native/init` |  | ...spread, gizmo_id, native_business_agent, timezone, timezone_offset_min |
| `POST /conversation/experimental/generate_entity_autocompletions` |  | input_text |
| `DELETE /conversation/id/{conversation_id}` |  |  |
| `POST /conversation/id/{conversation_id}/rename` |  | title |
| `POST /conversation/implicit_message_feedback` |  | conversation_id, feedback, location, message_id, source |
| `POST /conversation/init` |  | conversation_id, conversation_origin, gizmo_id, requested_default_model, system_hints, timezone, timezone_offset_min |
| `POST /conversation/message/code-blocks` |  | code_block, conversation_id, index, message_id, updated_at |
| `POST /conversation/message/code-blocks/feedback` |  | code_block_index, code_block_type, conversation_id, feedback, language, message_id, user_edited_code_block |
| `POST /conversation/message/code-blocks/magic-edit` |  | conversation_id, end_index, instruction, language, marked_block_body_markdown, mode, num_variations, start_index |
| `POST /conversation/message/immersive-maps/feedback` |  | checked_reasons, conversation_id, feedback, language, message_id, source, timestamp_client, user_agent |
| `POST /conversation/message/language-learning-blocks/feedback` |  | checked_reasons, content_text_length, conversation_id, feedback, has_pronunciation_hint, intent, message_id, playback_speed, pronunciation_language, surface, version, widget_reference_index |
| `POST /conversation/message/learning-blocks/feedback` |  | checked_reasons, content, conversation_id, feedback, initial_values, learning_block_type, message_id, rendered_learning_block_version, server_learning_block_version, source, user_edited_learning_block, widget_type |
| `POST /conversation/message/translation-blocks/feedback` |  | checked_reasons, conversation_id, feedback, message_id, metadata |
| `POST /conversation/message/writing-blocks` |  |  |
| `POST /conversation/message/writing-blocks/feedback` |  | conversation_id, feedback, message_id, user_edited_writing_block, writing_block_id |
| `POST /conversation/message/writing-blocks/magic-edit` |  | conversation_id, end_index, full_block_body_markdown, instruction, message_id, mode, num_variations, personalization_enabled, start_index |
| `DELETE /conversation/message_feedback` |  |  |
| `POST /conversation/message_feedback` |  |  |
| `POST /conversation/new_branch` |  | conversation_id, message_id |
| `POST /conversation/voice/feedback` |  |  |
| `GET /conversation/voice/feedback-options` |  |  |
| `POST /conversation/voice/status` |  |  |
| `GET /conversation/{conversation_id}` | ...spread, include_model_switcher_metadata |  |
| `PATCH /conversation/{conversation_id}` |  | consumer_lockdown_mode_disabled, current_node_id, is_archived, is_starred |
| `POST /conversation/{conversation_id}/followup_suggestions` |  | action_client, assistant_message_id, supported_system_hints |
| `GET /conversation/{conversation_id}/interpreter/download` | download_intent, message_id, sandbox_path |  |
| `POST /conversation/{conversation_id}/lock` |  |  |
| `POST /conversation/{conversation_id}/message/{message_id}/dil/view_state` |  | client_session_id, updates |
| `POST /conversation/{conversation_id}/message/{message_id}/genui/refresh_widget` |  |  |
| `GET /conversation/{conversation_id}/messages/{message_id}/existence` |  |  |
| `DELETE /conversation/{conversation_id}/messages/{message_id}/reactions` |  |  |
| `POST /conversation/{conversation_id}/messages/{message_id}/reactions` |  | reaction |
| `POST /conversation/{conversation_id}/messages/{message_id}/request_user_input/snooze` |  |  |
| `POST /conversation/{conversation_id}/rating` |  |  |
| `GET /conversation/{conversation_id}/stream_status` |  |  |
| `POST /conversation/{conversation_id}/unlock_permanently` |  |  |
| `GET /conversation/{id}/attachment/{file_id}/download` | gizmo_id |  |

### `conversations` (9)

| Call | query | body |
| --- | --- | --- |
| `GET /conversations` | conversation_origin, exclude_conversation_origin, expand, hide_snorlax, is_archived, is_starred, limit, offset, order |  |
| `PATCH /conversations` |  | delete_confirmation, is_archived |
| `POST /conversations/batch` |  | conversation_ids, include_full_history |
| `POST /conversations/by-work-thread` |  | thread_ids |
| `GET /conversations/search` | cursor, query |  |
| `GET /conversations/{conversation_id}` | include_has_versions, include_message_id, include_model_editable_context, num_turns |  |
| `GET /conversations/{conversation_id}/files` | cursor, limit |  |
| `GET /conversations/{conversation_id}/messages` | before, include_has_versions, num_turns |  |
| `GET /conversations/{conversation_id}/versions` | message_id |  |

### `courses` (1)

| Call | query | body |
| --- | --- | --- |
| `DELETE /courses/{course_id}` |  |  |

### `credits` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /credits/pleas` |  | product |

### `cyber_verification` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /cyber_verification/application_eligibility` |  |  |
| `POST /cyber_verification/refresh_status` |  | inquiry_id |
| `GET /cyber_verification/status` |  |  |

### `data-import` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /data-import/conversation` |  | conversation, source |

### `dictation` (4)

| Call | query | body |
| --- | --- | --- |
| `GET /dictation/custom_dictionary` |  |  |
| `POST /dictation/custom_dictionary/words` |  | text |
| `DELETE /dictation/custom_dictionary/words/{word_id}` |  |  |
| `POST /dictation/upload-asset` |  |  |

### `ecosystem` (10)

| Call | query | body |
| --- | --- | --- |
| `POST /ecosystem/call_mcp` |  | app_uri, conversation_id, launcher_host, message_id, method, params, thread_id |
| `POST /ecosystem/file_authorize_app` |  | authorized_app_uri, file_ids |
| `POST /ecosystem/file_download_url` |  | app_uri, file_id |
| `POST /ecosystem/launch_widget` |  | app_uri, conversation_id, launcher_host, link_id, mode, template, tool_input, tool_name, view_params |
| `POST /ecosystem/launcher/auto_install` |  | ...spread, conversation_id |
| `POST /ecosystem/launcher/bootstrap` |  |  |
| `POST /ecosystem/url_safe` |  | resolved_pineapple_uri, url |
| `GET /ecosystem/widget` | ...spread, action_name, connector_id, launcher_host, link_id, resource_path, template_pointer, uri |  |
| `POST /ecosystem/widget_close` |  | close_reason, conversation_id, message_id |
| `POST /ecosystem/widget_state` |  | conversation_id, message_id, operation_id, revision, state |

### `enterprise_surveys` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /enterprise_surveys/{survey_id}/complete` |  |  |

### `epic` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /epic/native-launch/resolve` |  | snapshot |

### `executors` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /executors/{environment_id}/shares` |  | recipient |
| `DELETE /executors/{environment_id}/shares/{share_id}` |  |  |

### `explore` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /explore/interactions` |  |  |
| `POST /explore/interactions/batch` |  |  |

### `export_doc` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /export_doc/writing_block/file` |  | conversation_id, export_type, index, message_id |

### `f` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /f/conversation/prepare` |  | ...spread, client_contextual_info, client_prepare_source, device_rate_limits |
| `POST /f/steer_turn` |  |  |

### `file_upload_action_suggestions` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /file_upload_action_suggestions` |  | conversation_id, entrypoint, files, history_and_training_disabled, model_slug, request_id |

### `files` (79)

| Call | query | body |
| --- | --- | --- |
| `POST /files` |  | file_name, file_size, reset_rate_limits, timezone_offset_min, use_case |
| `GET /files/download/{file_id}` | download_intent, gizmo_id |  |
| `GET /files/drive/entries/{entry_id}/invitation` | invitation_id |  |
| `GET /files/drive/entries/{entry_id}/shares` |  |  |
| `POST /files/drive/entries/{entry_id}/shares` |  | recipient, role_id |
| `DELETE /files/drive/entries/{entry_id}/shares/{share_id}` |  |  |
| `PATCH /files/drive/entries/{entry_id}/shares/{share_id}` |  | role_id |
| `POST /files/import/prism/projects/{project_id}` |  | main_file_path |
| `POST /files/import_image` |  | content_url, upload_source |
| `POST /files/library` |  | ...spread, allowlist_ids, categories, cursor, defer_page_sharing_badges, defer_sharing_badges, defer_site_metadata, enable_page_type_filters, exclude_embedded_artifacts, exclude_saved_responses, exclude_space_roots, external_account_keys, include_hidden_files, include_imagegen_files, include_native_files, include_pages, include_saved_entities, include_site_projects, include_sites, include_uploaded_files, limit, providers, q, ranking, sidebar_recents, source, state, trashed_only |
| `GET /files/library/automation-plans/{automation_id}/plan-summary` |  |  |
| `POST /files/library/directories` |  | name, parent_directory_id |
| `GET /files/library/directories/path` | directory_id |  |
| `DELETE /files/library/directories/{directory_id}` |  |  |
| `PATCH /files/library/directories/{directory_id}` |  | name, parent_directory_id |
| `DELETE /files/library/directories/{directory_id}/shared-with-me` |  |  |
| `DELETE /files/library/directories/{directory_id}/shares/{share_id}` |  |  |
| `GET /files/library/favorites` | ...spread, cursor, include_sites, limit |  |
| `POST /files/library/favorites` |  | target_ref |
| `GET /files/library/favorites/conversations/{conversation_id}` | cursor, limit |  |
| `POST /files/library/favorites/status` |  | target_refs |
| `DELETE /files/library/favorites/{favorite_id}` |  |  |
| `POST /files/library/files` |  | file_id, file_name, mime_type, parent_directory_id |
| `POST /files/library/files/delete-batch` |  | files |
| `POST /files/library/files/inline-content` |  | content, create_key, directory_id, file_name, library_file_info |
| `DELETE /files/library/files/{library_file_id}` | file_id, file_name, page_id, parent_directory_id, soft_delete |  |
| `GET /files/library/files/{library_file_id}` |  |  |
| `PATCH /files/library/files/{library_file_id}` |  | expected_current_version, file_name, inline_content |
| `GET /files/library/files/{library_file_id}/content_url` |  |  |
| `GET /files/library/files/{library_file_id}/deep-research` |  |  |
| `POST /files/library/files/{library_file_id}/deep-research/tools/{tool_name}` |  | args |
| `GET /files/library/files/{library_file_id}/download_url` |  |  |
| `PATCH /files/library/files/{library_file_id}/move` |  | directory_id |
| `GET /files/library/files/{library_file_id}/node` | page_id |  |
| `POST /files/library/files/{library_file_id}/opened` |  |  |
| `GET /files/library/files/{library_file_id}/plan-summary` |  |  |
| `POST /files/library/files/{library_file_id}/restore` |  |  |
| `DELETE /files/library/files/{library_file_id}/shared-with-me` |  |  |
| `DELETE /files/library/files/{library_file_id}/shares/{share_id}` |  |  |
| `GET /files/library/files/{library_file_id}/sharing-state` | include_profile_photos |  |
| `GET /files/library/files/{library_file_id}/thumbnail` |  |  |
| `GET /files/library/files/{library_file_id}/thumbnail_url` | generate_if_missing, size |  |
| `GET /files/library/files/{library_file_id}/versions` | cursor, limit |  |
| `POST /files/library/files/{library_file_id}/versions/{version_number}/restore` |  | expected_current_version |
| `POST /files/library/folder-previews` |  | directory_ids |
| `POST /files/library/image-edits` |  | conversation_id, rendered_file_id, source_file_id |
| `POST /files/library/image-favorites` |  |  |
| `POST /files/library/image-favorites/status` |  | sources |
| `GET /files/library/mounted/capabilities` | link_id, provider |  |
| `GET /files/library/mounted/capabilities/onedrive` |  |  |
| `POST /files/library/mounted/dropbox/preview` |  | file_id |
| `POST /files/library/mounted/dropbox/resolve_file_url` |  | url |
| `POST /files/library/mounted/materialize` |  | file_id, index_for_retrieval, mime_type, name |
| `GET /files/library/mounted/search` | limit, providers, q |  |
| `GET /files/library/mounted/search/cache` | limit, provider, q |  |
| `POST /files/library/mounted/sharepoint/preview` |  | file_id |
| `POST /files/library/mounted/sharepoint/resolve_file_url` |  | url |
| `POST /files/library/mounted/{provider_key}/file_metadata` |  | file_id |
| `GET /files/library/nodes` | categories, cursor, defer_page_sharing_badges, defer_sharing_badges, enable_page_type_filters, entry_surface, hydrate_folder_thumbnails, include_files, include_folder_counts, include_hidden_files, include_onedrive, include_pages, include_provider_roots, include_saved_entities, include_site_projects, include_sites, parent_directory_id, q, source |  |
| `GET /files/library/recents` | exclude_saved_responses, external_account_keys, library_providers, limit, providers |  |
| `GET /files/library/reference-images` | cursor, limit |  |
| `POST /files/library/reference-images` |  | asset_pointer, entity_description, entity_name, entity_type, idempotency_key, image_index, library_file_id, request_kind, source_conversation_id, source_message_id, suggestion_message_id |
| `DELETE /files/library/reference-images/{reference_image_id}` |  |  |
| `PATCH /files/library/reference-images/{reference_image_id}` |  | entity_name, entity_type |
| `POST /files/library/saved-chat-messages` |  | conversation_id, message_id |
| `GET /files/library/shared/files/{library_file_id}/access` |  |  |
| `GET /files/library/shared/search` | exclude_saved_responses, limit, q |  |
| `POST /files/library/sharing-badges` |  | items |
| `POST /files/library/site-metadata` |  | file_ids |
| `GET /files/library/sites/{project_id}` |  |  |
| `POST /files/library/slides` |  | collection, cursor, include_files, include_hidden_files, include_shared, include_shared_pages, query, source |
| `GET /files/library/storage/usage` |  |  |
| `DELETE /files/library/trash` |  |  |
| `POST /files/library/trash` |  | allowlist_ids, categories, cursor, defer_page_metadata, exclude_saved_responses, include_files, include_hidden_files, include_pages, include_spaces, limit, q, source |
| `POST /files/upload_reservations` |  | entry_surface, intended_use_case, library_persistence_mode, requires_gizmo_id, store_in_library |
| `GET /files/{file_id}` | gizmo_id |  |
| `POST /files/{file_id}/image_safety_preview` |  |  |
| `GET /files/{file_id}/simple` | conversation_id, gizmo_id |  |
| `POST /files/{file_id}/uploaded` |  |  |

### `flora` (15)

| Call | query | body |
| --- | --- | --- |
| `POST /flora/browser/auth/prepare` |  | challenge_id, conversation_id |
| `GET /flora/browser/config` |  |  |
| `PATCH /flora/browser/config` |  | origin_mutation |
| `GET /flora/browser/cookies` | surface |  |
| `GET /flora/browser/credential-availability` | challenge_id, conversation_id |  |
| `POST /flora/browser/credential-candidates` |  | challenge_id, conversation_id, cursor |
| `POST /flora/browser/credential-operations/{operation_id}/reconcile` |  | challenge_id, conversation_id, selection_id |
| `POST /flora/browser/form-fill` |  | challenge_id, conversation_id, fields, selected_option |
| `GET /flora/browser/handoff` | conversation_id |  |
| `GET /flora/browser/passkeys` |  |  |
| `DELETE /flora/browser/passkeys/{credential_id}` |  |  |
| `POST /flora/browser/password-managers/{provider}/access-requests` |  | challenge_id, conversation_id, expected_account_user_id |
| `POST /flora/browser/password-managers/{provider}/access-requests/status` |  | access_handle, challenge_id, conversation_id, expected_account_user_id |
| `GET /flora/subagent/thread/turns` | conversationId, limit, threadId |  |
| `POST /flora/workspace/reset` |  |  |

### `gift-cards` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /gift-cards/api-organizations` |  |  |
| `POST /gift-cards/api/redeem` |  |  |
| `POST /gift-cards/redeem` |  |  |

### `gift-credits` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /gift-credits/senders/eligibility` |  |  |

### `gizmo_creators` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /gizmo_creators/{uid}/gizmos` |  |  |

### `gizmos` (27)

| Call | query | body |
| --- | --- | --- |
| `POST /gizmos` | gizmo_id | ...spread, display |
| `GET /gizmos/bootstrap` | limit |  |
| `GET /gizmos/business-agents/chat-access` |  |  |
| `POST /gizmos/business-agents/disclosures/viewed` |  | ...spread, version |
| `POST /gizmos/business-agents/{business_agent_id}/conversation-starter` |  | ad_data_token, interaction_id, native_runtime_version, source_assistant_message_id, source_conversation_id |
| `POST /gizmos/business-agents/{business_agent_id}/interactions` |  | ...spread, entry_context, include_disclosure_state, include_gizmo_resource |
| `POST /gizmos/business-agents/{business_agent_id}/product-card-conversation-starter` |  | ...spread, interaction_id, product, source_product_hostname, source_profile_lookup_id |
| `POST /gizmos/business-agents/{business_agent_id}/profile-starter` |  | ...spread, conversation_id, source_profile_lookup_id |
| `POST /gizmos/fetch_openapi` |  | url |
| `GET /gizmos/firstparty/sidebar` |  |  |
| `GET /gizmos/search` | cursor, limit, q, workspace_only |  |
| `POST /gizmos/snorlax/decline` |  | project_id |
| `POST /gizmos/snorlax/join` | gizmo_id |  |
| `POST /gizmos/snorlax/leave` |  | gizmo_id, save_copy |
| `GET /gizmos/snorlax/sidebar` | conversations_per_gizmo, cursor, limit, owned_only |  |
| `POST /gizmos/validate_openapi` |  | raw_spec |
| `GET /gizmos/{gizmo_id_or_short_url}` | draft, include_file_limits |  |
| `DELETE /gizmos/{gizmo_id}` |  |  |
| `GET /gizmos/{gizmo_id}/about` |  |  |
| `GET /gizmos/{gizmo_id}/conversations` | cursor, limit, owned_only |  |
| `GET /gizmos/{gizmo_id}/export/plugin/capabilities` |  |  |
| `GET /gizmos/{gizmo_id}/migrate/plugin` |  |  |
| `POST /gizmos/{gizmo_id}/migrate/plugin` |  | deleted_plugin_id, gizmo_config_id |
| `GET /gizmos/{gizmo_id}/migrate/plugin/sharing` |  |  |
| `POST /gizmos/{gizmo_id}/promote` |  |  |
| `POST /gizmos/{gizmo_id}/share` |  |  |
| `GET /gizmos/{gizmo_id}/version/{version}` |  |  |

### `global` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /global/search` | cursor, limit, query, query_id, sources |  |
| `POST /global/search` |  | ...spread, cursor, entrypoint, limit, query, query_id, scope, source_requests |

### `hazelnuts` (14)

| Call | query | body |
| --- | --- | --- |
| `GET /hazelnuts` | include_permissions, scope |  |
| `POST /hazelnuts/draft` |  | ...spread, files |
| `POST /hazelnuts/draft/uploads` |  | files |
| `POST /hazelnuts/uploads/create` |  |  |
| `POST /hazelnuts/uploads/finish` |  | file_id |
| `DELETE /hazelnuts/{hazelnut_id}` |  |  |
| `GET /hazelnuts/{hazelnut_id}` | include_permissions |  |
| `PATCH /hazelnuts/{hazelnut_id}` |  | safety_check_status |
| `POST /hazelnuts/{hazelnut_id}/files/get_download_link` |  | file_id |
| `DELETE /hazelnuts/{hazelnut_id}/share` |  | principal_id, principal_type |
| `GET /hazelnuts/{hazelnut_id}/share` |  |  |
| `POST /hazelnuts/{hazelnut_id}/share` |  | targets |
| `POST /hazelnuts/{hazelnut_id}/status` |  | enabled |
| `POST /hazelnuts/{hazelnut_id}/workspace-access` |  | state |

### `hermes` (63)

| Call | query | body |
| --- | --- | --- |
| `POST /hermes/agent` |  |  |
| `GET /hermes/agent-templates` |  |  |
| `DELETE /hermes/agent/{agent_id}` |  |  |
| `GET /hermes/agent/{agent_id}` |  |  |
| `GET /hermes/agent/{agent_id}/analytics/runs` | cursor, limit |  |
| `GET /hermes/agent/{agent_id}/analytics/runs/timeseries` | end_date, granularity, start_date |  |
| `GET /hermes/agent/{agent_id}/builder-view` |  |  |
| `POST /hermes/agent/{agent_id}/clone` |  | name |
| `GET /hermes/agent/{agent_id}/conversations` | cursor, limit |  |
| `GET /hermes/agent/{agent_id}/detail-view` |  |  |
| `POST /hermes/agent/{agent_id}/files/folders` |  |  |
| `GET /hermes/agent/{agent_id}/files/nodes` |  |  |
| `PATCH /hermes/agent/{agent_id}/files/nodes/{node_id}` |  |  |
| `POST /hermes/agent/{agent_id}/files/nodes/{node_id}` | recursive |  |
| `GET /hermes/agent/{agent_id}/files/nodes/{node_id}/download-url` |  |  |
| `GET /hermes/agent/{agent_id}/files/tree` |  |  |
| `POST /hermes/agent/{agent_id}/files/upload-sessions` |  | collision_handling, current_tree_revision, expected_draft_revision, expected_draft_version_id, mime_type, name, parent_node_id, size_bytes |
| `POST /hermes/agent/{agent_id}/files/upload-sessions/{session_id}/complete` |  | expected_draft_revision |
| `GET /hermes/agent/{agent_id}/list-connector-readiness` | version_scope |  |
| `GET /hermes/agent/{agent_id}/permissions` |  |  |
| `POST /hermes/agent/{agent_id}/permissions` |  |  |
| `GET /hermes/agent/{agent_id}/persistent-folder/files/{file_id}/download_url` |  |  |
| `GET /hermes/agent/{agent_id}/persistent-folder/tree` | channel_binding_channel_id, channel_binding_link_id, channel_binding_type |  |
| `POST /hermes/agent/{agent_id}/pin` |  | action |
| `GET /hermes/agent/{agent_id}/published_versions` |  |  |
| `GET /hermes/agent/{agent_id}/published_versions/{version_id}` |  |  |
| `POST /hermes/agent/{agent_id}/save` |  | ...spread, save_source |
| `POST /hermes/agent/{agent_id}/save_publish` |  | ...spread, changes_count, publish_type |
| `GET /hermes/agent/{agent_id}/skills/{skill_id}/definition` |  |  |
| `POST /hermes/agent/{agent_id}/skills/{skill_id}/definition` |  | default_prompt, display_name, expected_draft_revision, expected_draft_version_id, icon, instructions, short_description, skill_description, skill_name |
| `GET /hermes/agent/{agent_id}/skills/{skill_id}/download-url` | download |  |
| `POST /hermes/agent/{agent_id}/skills/{skill_id}/files/folders` |  |  |
| `GET /hermes/agent/{agent_id}/skills/{skill_id}/files/nodes` |  |  |
| `PATCH /hermes/agent/{agent_id}/skills/{skill_id}/files/nodes/{node_id}` |  |  |
| `POST /hermes/agent/{agent_id}/skills/{skill_id}/files/nodes/{node_id}` | recursive |  |
| `GET /hermes/agent/{agent_id}/skills/{skill_id}/files/nodes/{node_id}/download-url` |  |  |
| `GET /hermes/agent/{agent_id}/skills/{skill_id}/files/tree` |  |  |
| `POST /hermes/agent/{agent_id}/skills/{skill_id}/files/upload-sessions` |  |  |
| `POST /hermes/agent/{agent_id}/skills/{skill_id}/files/upload-sessions/{session_id}/complete` |  |  |
| `PATCH /hermes/agent/{agent_id}/slack_handle` |  | agent_handle |
| `GET /hermes/agent/{agent_id}/system-hint` | system_hint |  |
| `GET /hermes/agent/{agent_id}/triggers` | scope |  |
| `POST /hermes/agent/{agent_id}/triggers` |  | trigger |
| `DELETE /hermes/agent/{agent_id}/triggers/{trigger_id}` |  |  |
| `PATCH /hermes/agent/{agent_id}/triggers/{trigger_id}` |  | trigger |
| `POST /hermes/agent/{agent_id}/triggers/{trigger_id}/run_now` |  |  |
| `POST /hermes/agent_version/{version_id}/publish` |  | publish_type, republish_id |
| `GET /hermes/agents` | cursor, limit, list_type |  |
| `GET /hermes/agents/pinned` | limit |  |
| `GET /hermes/apps/browse` |  |  |
| `POST /hermes/apps/content` |  | app_ids |
| `POST /hermes/feedback` |  | feedback_text |
| `GET /hermes/models` |  |  |
| `POST /hermes/pluto/attachments` |  |  |
| `POST /hermes/pluto/starter-prompts` |  |  |
| `GET /hermes/skills/chatgpt-search` | limit, query, scope |  |
| `POST /hermes/skills/upload` |  |  |
| `POST /hermes/slack/join_channel` |  | channel_id |
| `GET /hermes/slack/readiness` |  |  |
| `GET /hermes/whats-new` |  |  |
| `POST /hermes/whats-new/{update_id}/view` |  |  |
| `GET /hermes/workspace-store/agents` | cursor, limit |  |
| `GET /hermes/workspace-store/agents/search` | cursor, limit, query |  |

### `image-gen` (7)

| Call | query | body |
| --- | --- | --- |
| `POST /image-gen/delayed/accept` |  | conversation_id, message_id |
| `POST /image-gen/gif/select_speed` |  | asset_pointer, conversation_id, message_id, selected_speed |
| `POST /image-gen/layer-extractions` |  | source_file_id |
| `GET /image-gen/layer-extractions/documents/{document_id}` |  |  |
| `POST /image-gen/layer-extractions/documents/{document_id}/snapshots` |  | items, rendered_file_id |
| `GET /image-gen/layer-extractions/{extraction_id}` |  |  |
| `POST /image-gen/markup-preview` |  |  |

### `images` (8)

| Call | query | body |
| --- | --- | --- |
| `GET /images/image-tags` |  |  |
| `POST /images/image-tags` |  | asset_pointer, kind |
| `DELETE /images/image-tags/{image_tag_id}` |  |  |
| `PATCH /images/image-tags/{image_tag_id}` |  | asset_pointer |
| `GET /images/init` |  |  |
| `GET /images/prompt-items` | surface |  |
| `GET /images/prompt-items/{item_id}` | lookup_mode |  |
| `GET /images/styles` | include_image_suggestions |  |

### `incentives` (4)

| Call | query | body |
| --- | --- | --- |
| `GET /incentives/claims` |  |  |
| `GET /incentives/lenovo/reward-receipts` |  |  |
| `GET /incentives/{campaign_id}` |  |  |
| `POST /incentives/{campaign_id}/enroll` |  |  |

### `ios` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /ios/attestation_challenge` |  |  |

### `language-learning-block` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /language-learning-block/translate` |  |  |

### `learning-hub` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /learning-hub/active-session` |  |  |
| `GET /learning-hub/tips` | work_home_slot |  |
| `POST /learning-hub/tips/{card_id}/complete` |  |  |

### `learning` (6)

| Call | query | body |
| --- | --- | --- |
| `GET /learning/courses` |  |  |
| `GET /learning/courses/{course_id}` | include_reminder, lesson_cursor, lesson_limit |  |
| `PUT /learning/courses/{course_id}/reminder` |  |  |
| `PATCH /learning/flashcards/{library_file_id}` |  | artifact, expected_current_version |
| `GET /learning/flashcards/{library_file_id}/progress` |  |  |
| `POST /learning/flashcards/{library_file_id}/progress` |  | item_id, outcome |

### `legalapi` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /legalapi/enabled` |  |  |

### `live` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /live/conversations/{conversation_id}/av-sessions/{av_session_id}/share` |  |  |

### `local` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /local/entities/{entity_id}` |  |  |
| `POST /local/entity-shares` |  | entity_key |

### `locked_chats` (5)

| Call | query | body |
| --- | --- | --- |
| `POST /locked_chats/pin/change` |  | current_pin, new_pin |
| `POST /locked_chats/pin/reset` |  |  |
| `POST /locked_chats/pin/reset/challenge` |  |  |
| `GET /locked_chats/status` |  |  |
| `POST /locked_chats/unlock` |  | pin, pin_confirmation |

### `me` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /me` |  |  |

### `memories` (7)

| Call | query | body |
| --- | --- | --- |
| `GET /memories` | include_memory_entries |  |
| `GET /memories/about_you/selection_correction_actions` |  |  |
| `POST /memories/about_you/summary` | source |  |
| `POST /memories/about_you/summary/cache/delete` |  | disableMemory |
| `GET /memories/about_you/summary/checksum` | source |  |
| `DELETE /memories/{memory_id}` |  |  |
| `PATCH /memories/{memory_id}/status` |  | status |

### `messaging` (22)

| Call | query | body |
| --- | --- | --- |
| `POST /messaging/connector-auth/{reference}/complete` |  | completion_token |
| `POST /messaging/connector-auth/{reference}/start` |  |  |
| `POST /messaging/dots/{dot_id}/dm` |  |  |
| `GET /messaging/plugin-suggestions/{reference}` | shared_setup |  |
| `POST /messaging/plugin-suggestions/{reference}/continue` |  | connected_plugin_ids |
| `GET /messaging/rooms/{room_id}` |  |  |
| `GET /messaging/rooms/{room_id}/browser-activity` | message_id |  |
| `POST /messaging/rooms/{room_id}/files` |  |  |
| `POST /messaging/rooms/{room_id}/files/uploads` |  |  |
| `GET /messaging/rooms/{room_id}/files/uploads/{upload_id}` |  |  |
| `POST /messaging/rooms/{room_id}/files/uploads/{upload_id}/complete` |  |  |
| `GET /messaging/rooms/{room_id}/files/{file_id}` |  |  |
| `POST /messaging/rooms/{room_id}/journal/catch-up` |  |  |
| `GET /messaging/rooms/{room_id}/messages` | ...spread, limit |  |
| `POST /messaging/rooms/{room_id}/messages` |  | activity_topic_id, app_attest_challenge, content, idempotency_token, message_metadata, page_context, reply_to, request_id, timezone_offset_min, used_dictation |
| `GET /messaging/rooms/{room_id}/messages/{message_id}/elicitation` | inspect |  |
| `POST /messaging/rooms/{room_id}/messages/{message_id}/elicitation/response` |  |  |
| `GET /messaging/rooms/{room_id}/messages/{message_id}/email` |  |  |
| `DELETE /messaging/rooms/{room_id}/messages/{message_id}/reactions` |  |  |
| `POST /messaging/rooms/{room_id}/messages/{message_id}/reactions` |  | reaction |
| `POST /messaging/rooms/{room_id}/read` |  | last_read_at |
| `POST /messaging/rooms/{room_id}/responding_heartbeat` |  |  |

### `model_first_landings` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /model_first_landings/resolve_message` |  | landing_ref |

### `models` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /models` | iim, include_icons, is_gizmo |  |

### `my` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /my/recent/image_gen` | after, limit |  |
| `GET /my/recent/uploaded_images` | images_app_only, limit |  |

### `notifications` (11)

| Call | query | body |
| --- | --- | --- |
| `GET /notifications` | cursor, include_display_details, limit |  |
| `POST /notifications/conversation/{conversation_id}/claim_seeded` |  |  |
| `GET /notifications/counts` |  |  |
| `GET /notifications/grouped` | cursor, group_join_requests, include_display_details, limit |  |
| `POST /notifications/groups/workspace_join_requests/read` |  | read_token |
| `POST /notifications/pages/{page_id}/read` |  | read_token |
| `GET /notifications/settings` |  |  |
| `PATCH /notifications/settings` |  | updates |
| `DELETE /notifications/subscription/deregister` |  | platform, token |
| `POST /notifications/subscription/register` |  | platform, token, web_metadata |
| `POST /notifications/{notification_id}/read` |  |  |

### `onboarding` (5)

| Call | query | body |
| --- | --- | --- |
| `GET /onboarding/matched_paid_social` |  |  |
| `POST /onboarding/quorum/examples` |  | department, role, source |
| `GET /onboarding/recommendations` | ...spread, default, provider_id, role |  |
| `POST /onboarding/recommendations` |  | mail_provider, provider_id, role |
| `GET /onboarding/recommendations/status` |  |  |

### `pageConfigs` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /pageConfigs/billing` |  |  |
| `GET /pageConfigs/usage_limits` |  |  |

### `pages` (66)

| Call | query | body |
| --- | --- | --- |
| `GET /pages` | ...spread, cursor, include_checkpoint, include_checkpoint_cdn, include_has_children, limit, parent_page_id, query, surface |  |
| `POST /pages` |  |  |
| `GET /pages/archived` | cursor, limit |  |
| `POST /pages/archived/metadata` |  | items |
| `GET /pages/catalog` | ...spread, cursor, include_identity_details, include_shared_with_me, include_sharing_details, limit, order_by |  |
| `GET /pages/child-hints` | page_ids |  |
| `POST /pages/convert-response` |  | conversation_id, message_ids |
| `GET /pages/creation-capabilities` |  |  |
| `POST /pages/from-response` |  |  |
| `POST /pages/import/jobs` |  |  |
| `GET /pages/import/jobs/{import_id}` |  |  |
| `GET /pages/import/prism/eligibility` |  |  |
| `GET /pages/import/prism/projects` | limit |  |
| `POST /pages/link-workspace` |  |  |
| `GET /pages/mentions/inbox` | cursor, include_comments, limit, page_id, unread_only |  |
| `GET /pages/mentions/inbox/{notification_id}` |  |  |
| `POST /pages/mentions/inbox/{notification_id}/read` |  |  |
| `POST /pages/metadata/batch` |  | page_ids |
| `GET /pages/product-access` |  |  |
| `GET /pages/sharing-badges` | ...spread, page_ids |  |
| `POST /pages/sharing/recipients` |  | entry_id, limit, page_id, query, space_id |
| `POST /pages/sharing/recipients/recent` |  | ...spread, include_suggestions, limit |
| `GET /pages/suggestions` |  |  |
| `POST /pages/suggestions/{suggestion_id}/create` |  |  |
| `GET /pages/tasks/assigned` | cursor, limit |  |
| `GET /pages/{page_id}` | include_block_attributions, include_checkpoint, include_checkpoint_cdn, include_content, include_display_metadata, include_document_bootstrap, include_parent_metadata, prefer_lite_checkpoint, stream_kind |  |
| `GET /pages/{page_id}/access-requests` | cursor |  |
| `POST /pages/{page_id}/access-requests` |  |  |
| `POST /pages/{page_id}/access-requests/for-others` |  |  |
| `POST /pages/{page_id}/access-requests/for-self` |  |  |
| `GET /pages/{page_id}/access-requests/requested` | cursor, limit |  |
| `POST /pages/{page_id}/access-requests/{request_id}/approve` |  | recipient, request_created_at, role |
| `POST /pages/{page_id}/access-requests/{request_id}/reject` |  | recipient, request_created_at |
| `POST /pages/{page_id}/archive` |  |  |
| `POST /pages/{page_id}/archive-operation` | operation_id |  |
| `GET /pages/{page_id}/archive-status` | operation_id |  |
| `GET /pages/{page_id}/automation-attachments` |  |  |
| `DELETE /pages/{page_id}/automation-attachments/{automation_id}` |  |  |
| `GET /pages/{page_id}/chats` | cursor, limit |  |
| `PUT /pages/{page_id}/chats/default` |  | conversation_id, host_id |
| `POST /pages/{page_id}/delete` |  |  |
| `DELETE /pages/{page_id}/delete-forever` | archived_at |  |
| `GET /pages/{page_id}/duplicate-limits` | include_files |  |
| `POST /pages/{page_id}/duplicate-operations` |  | include_descendants, include_files, operation_id, share_permissions, title |
| `GET /pages/{page_id}/duplicate-operations/{operation_id}` |  |  |
| `GET /pages/{page_id}/files` | cursor, limit |  |
| `GET /pages/{page_id}/invitation` | invitation_id |  |
| `POST /pages/{page_id}/library-files/{library_file_id}/shares` |  |  |
| `POST /pages/{page_id}/link-preview` |  | url |
| `POST /pages/{page_id}/mentions/access` |  | account_user_ids |
| `PATCH /pages/{page_id}/metadata` |  | parent_page_id, skill, template |
| `POST /pages/{page_id}/move` |  |  |
| `POST /pages/{page_id}/move-preview` |  |  |
| `POST /pages/{page_id}/personal-move-admission` |  | parent_page_id |
| `POST /pages/{page_id}/preview` |  |  |
| `POST /pages/{page_id}/realtime-token` | ...spread | ...spread, allow_read_fallback, requested_scope |
| `POST /pages/{page_id}/restore` |  |  |
| `GET /pages/{page_id}/shares` | cursor, include_inherited_access, limit, read_only |  |
| `POST /pages/{page_id}/shares` |  | recipient, role_id |
| `DELETE /pages/{page_id}/shares/{share_id}` |  |  |
| `PATCH /pages/{page_id}/shares/{share_id}` |  | role_id |
| `GET /pages/{page_id}/versions` | cursor, limit, stream_kind |  |
| `GET /pages/{page_id}/versions/{checkpoint_id}/checkpoint-bootstrap` | prefer_lite_checkpoint, stream_kind |  |
| `GET /pages/{page_id}/views` | cursor, limit |  |
| `POST /pages/{page_id}/views` |  | observed_sequence |
| `POST /pages/{source_page_id}/link-resolutions` |  | target_page_ids |

### `paid_image_handoff` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /paid_image_handoff/redeem` |  | token |

### `paragen_submission` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /paragen_submission` |  |  |

### `password-managers` (3)

| Call | query | body |
| --- | --- | --- |
| `DELETE /password-managers/1password` |  |  |
| `GET /password-managers/1password` |  |  |
| `POST /password-managers/1password/enrollment` |  | ...spread, expected_account_user_id |

### `payments` (31)

| Call | query | body |
| --- | --- | --- |
| `POST /payments/billing/mandate-authorization` |  | account_id, supports_saved_card_retry |
| `GET /payments/billing_info` | account_id |  |
| `POST /payments/billing_info` |  | ...spread, account_id, address |
| `POST /payments/checkout` |  | ...spread, cancel_url, checkout_appearance, checkout_source, checkout_ui_mode, purchase_attempt_id, supports_saved_payment_link, team_plan_data |
| `POST /payments/checkout/approve` |  | checkout_session_id, processor_entity |
| `POST /payments/checkout/confirm` |  | checkout_session_id |
| `POST /payments/checkout/credits/quote` |  |  |
| `POST /payments/checkout/custom_payment_method/continue` |  | action_result, checkout_session_id |
| `POST /payments/checkout/custom_payment_method/start` |  |  |
| `POST /payments/checkout/taxes` |  | billing_address, billing_country, billing_name, checkout_email, checkout_session_id, currency, processor_entity, tax_id |
| `POST /payments/checkout/update` |  | ...spread, supports_payment_method_updates |
| `POST /payments/checkout/update_email` |  |  |
| `POST /payments/checkout/update_tax_id` |  |  |
| `GET /payments/checkout/{processor_entity}/{checkout_session_id}` | payment_state_source, setup_attempt_id, supports_business_seat_offer |  |
| `POST /payments/checkout_session` |  | payment_method_behavior, processor_entity, stripe_checkout_session_id |
| `GET /payments/customer_portal` | account_id |  |
| `GET /payments/invoice-expensing` |  |  |
| `PATCH /payments/invoice-expensing` |  |  |
| `POST /payments/invoice-expensing/{invoice_id}/send` |  | destination |
| `GET /payments/non_profit_org_eligibility` |  |  |
| `POST /payments/payment_method` |  | account_id, caller_surface, subscription_renewal_mandate |
| `POST /payments/payment_method/backup` |  | account_id, enabled |
| `POST /payments/payment_method/confirm` |  |  |
| `POST /payments/payment_method/default` |  | account_id, payment_method_id |
| `DELETE /payments/payment_method/{payment_method_id}` | account_id |  |
| `GET /payments/payment_method/{payment_method_id}` | account_id |  |
| `PATCH /payments/payment_method/{payment_method_id}` |  | account_id, billing_details, card |
| `POST /payments/payment_method/{payment_method_id}/finalize` |  | account_id, caller_surface, setup_intent_id |
| `GET /payments/payment_methods` | account_id |  |
| `GET /payments/stripe_client_bootstrap` | account_id |  |
| `GET /payments/transaction-history` | account_id, cursor, limit |  |

### `personality_settings_impression` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /personality_settings_impression` |  |  |

### `personality_trait_types` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /personality_trait_types` |  |  |

### `personality_types` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /personality_types` |  |  |

### `pets` (8)

| Call | query | body |
| --- | --- | --- |
| `GET /pets` | cursor, limit |  |
| `GET /pets/share/{shared_pet_id}` |  |  |
| `POST /pets/share/{shared_pet_id}/adopt` |  |  |
| `DELETE /pets/{pet_id}` |  |  |
| `PATCH /pets/{pet_id}` |  | description, name |
| `GET /pets/{pet_id}/download` |  |  |
| `DELETE /pets/{pet_id}/share` |  |  |
| `POST /pets/{pet_id}/share` |  |  |

### `pins` (6)

| Call | query | body |
| --- | --- | --- |
| `GET /pins` | item_type |  |
| `GET /pins/content` | include_checkpoint_cdn, include_pages, include_sites, limit, prefer_lite_checkpoint |  |
| `DELETE /pins/pages/{page_id}` |  |  |
| `POST /pins/pages/{page_id}` |  |  |
| `DELETE /pins/{item_type}/{item_id}` |  |  |
| `POST /pins/{item_type}/{item_id}` |  |  |

### `plugins` (4)

| Call | query | body |
| --- | --- | --- |
| `POST /plugins/admin/{plugin_id}/instantiate` |  |  |
| `GET /plugins/featured` | platform |  |
| `POST /plugins/user-suggestions` |  | suggestion |
| `GET /plugins/{plugin_id}/instances` | ...spread, limit, scope |  |

### `premium-usage` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /premium-usage/summary/v2` |  |  |

### `product-account-links` (6)

| Call | query | body |
| --- | --- | --- |
| `GET /product-account-links/accounts/{account_id}` |  |  |
| `POST /product-account-links/accounts/{account_id}` |  |  |
| `GET /product-account-links/accounts/{account_id}/ads-benefits/{program_id}` |  |  |
| `GET /product-account-links/accounts/{account_id}/benefits/{program_id}` |  |  |
| `DELETE /product-account-links/accounts/{account_id}/links/{link_id}` |  |  |
| `GET /product-account-links/discovery` |  |  |

### `profiles` (20)

| Call | query | body |
| --- | --- | --- |
| `GET /profiles/` | limit, offset, query |  |
| `GET /profiles/me` |  |  |
| `PATCH /profiles/me` |  | description, display_name, photo_frame_style, profile_asset_pointer, profile_visibility |
| `GET /profiles/me/page` | ...spread, include_search_visibility |  |
| `PATCH /profiles/me/page` |  | display_settings |
| `GET /profiles/me/page/pin_options` | cursor, kind, limit |  |
| `GET /profiles/me/page/pins` |  |  |
| `POST /profiles/me/page/pins` |  |  |
| `DELETE /profiles/me/page/pins/{pin_id}` | expected_version |  |
| `GET /profiles/me/stats/streak` |  |  |
| `GET /profiles/me/sticker-layout` |  |  |
| `PUT /profiles/me/sticker-layout` |  | expected_version, placements |
| `GET /profiles/v2/me/page/pin_options` | cursor, kind, limit, pin_kinds |  |
| `GET /profiles/v2/me/page/pins` | pin_kinds |  |
| `PUT /profiles/v2/me/page/pins` | pin_kinds | expected_version, pins |
| `GET /profiles/v2/{username}/artifacts` | cursor, kind, workspace_slug |  |
| `GET /profiles/{username}/activity` |  |  |
| `GET /profiles/{username}/page` | ...spread, personal, workspace_slug |  |
| `GET /profiles/{username}/pins` | ...spread, pin_kinds |  |
| `GET /profiles/{username}/sticker-layout` | personal, workspace_slug |  |

### `projects` (13)

| Call | query | body |
| --- | --- | --- |
| `POST /projects` |  |  |
| `POST /projects/share` |  |  |
| `PATCH /projects/{project_id}` |  | emoji, instructions, memory_scope, name, theme |
| `GET /projects/{project_id}/connector_scopes` | cursor, limit |  |
| `POST /projects/{project_id}/connector_scopes` |  | connector_type, original_url |
| `DELETE /projects/{project_id}/connector_scopes/{scope_id}` |  |  |
| `POST /projects/{project_id}/connector_scopes/{scope_id}/sync` |  |  |
| `POST /projects/{project_id}/files` |  | files |
| `DELETE /projects/{project_id}/files/{file_id}` |  |  |
| `GET /projects/{project_id}/saves` |  |  |
| `POST /projects/{project_id}/saves` |  | conversation_id, message_id |
| `DELETE /projects/{project_id}/saves/{save_id}` |  |  |
| `PATCH /projects/{project_id}/saves/{save_id}` |  | title |

### `promo_campaign` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /promo_campaign/check_coupon` | coupon, is_coupon_from_query_param, workspace_id |  |

### `promotions` (5)

| Call | query | body |
| --- | --- | --- |
| `GET /promotions/cp` | account_id |  |
| `GET /promotions/eligibility/{code}` |  |  |
| `GET /promotions/metadata/{code}` | type |  |
| `GET /promotions/sci` | country, currency |  |
| `POST /promotions/{promo_code}/claim` |  | account_id |

### `prompt_library` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /prompt_library/` | limit, model_slug, source, supports_moment_starter_actions, supports_saved_lesson_chat, use_v2 |  |
| `GET /prompt_library/use_case/{use_case_id}` |  |  |

### `ps` (37)

| Call | query | body |
| --- | --- | --- |
| `POST /ps/apps/batch` |  | app_ids, include_tools |
| `GET /ps/connectors/by-template` | template_id |  |
| `GET /ps/orbit/{thread_id}/teams` | install_attempt_id |  |
| `POST /ps/orbit/{thread_id}/teams` |  |  |
| `DELETE /ps/orbit/{thread_id}/teams/{binding_id}` | binding_version |  |
| `GET /ps/plugin-categories/{category_slug}/plugins` | limit, pageToken, q, scope, surface |  |
| `GET /ps/plugin-shares/{share_key}` |  |  |
| `GET /ps/plugins/admin/{plugin_id}` |  |  |
| `POST /ps/plugins/batch` |  | plugin_ids |
| `GET /ps/plugins/canonical-app/{app_id}` | includeDownloadUrls |  |
| `GET /ps/plugins/home` |  |  |
| `GET /ps/plugins/installed` | includeExtensions, limit, pageToken |  |
| `GET /ps/plugins/list` | ...spread, limit, pageToken, scope |  |
| `GET /ps/plugins/search` | ...spread, limit, pageToken, q, scope, surface |  |
| `GET /ps/plugins/workspace/created` | limit, pageToken |  |
| `GET /ps/plugins/workspace/shared` | limit, pageToken |  |
| `GET /ps/plugins/workspace/template-instances` | ...spread, limit, template_plugin_id |  |
| `DELETE /ps/plugins/{plugin_id}` |  |  |
| `GET /ps/plugins/{plugin_id}` | useTemplatePresentation |  |
| `POST /ps/plugins/{plugin_id}/enable` |  |  |
| `POST /ps/plugins/{plugin_id}/ensure` |  |  |
| `POST /ps/plugins/{plugin_id}/install` | includeAppsNeedingAuth | install_attempt_id |
| `GET /ps/plugins/{plugin_id}/shares` |  |  |
| `PUT /ps/plugins/{plugin_id}/shares` |  | discoverability, targets |
| `GET /ps/plugins/{plugin_id}/skills/{skill_name}` | includeDownloadUrls |  |
| `GET /ps/plugins/{plugin_id}/templates/{template_id}` |  |  |
| `POST /ps/plugins/{plugin_id}/templates/{template_id}/instantiate` |  |  |
| `POST /ps/plugins/{plugin_id}/templates/{template_id}/oauth-config` |  | mcp_url |
| `POST /ps/plugins/{plugin_id}/uninstall` |  |  |
| `GET /ps/v2/connectors/{connector_id}/safety_prompt` | link_id |  |
| `PUT /ps/v2/connectors/{connector_id}/safety_prompt` | link_id | safety_prompt |
| `POST /ps/v2/links/credentials` |  | configuration, connector_id, install_attempt_id, link_id, strategy_id |
| `POST /ps/v2/links/siwc/start` |  | connector_id |
| `PATCH /ps/v2/links/{link_id}` |  | is_read_only, name |
| `GET /ps/v2/service_accounts/{account_user_id}/workspace_connections` | team_id |  |
| `PATCH /ps/v2/service_accounts/{account_user_id}/workspace_connections/{link_id}` | team_id | enabled |
| `GET /ps/v2/service_accounts/{service_account_user_id}/link_shares` |  |  |

### `public-api` (10)

| Call | query | body |
| --- | --- | --- |
| `POST /public-api/business_agents/native_saved_preview/metadata` |  | credential, interaction_id, version |
| `POST /public-api/business_agents/native_saved_preview/open` |  | business_agent_id, gizmo_id, interaction_id, version |
| `POST /public-api/business_agents/native_saved_preview/redeem` |  | ...spread, raw_session |
| `POST /public-api/business_agents/native_saved_preview/redeem_signed_in` |  | ...spread, raw_session |
| `GET /public-api/business_agents/{business_agent_id}/published_preview` | gizmo_id |  |
| `GET /public-api/gizmos/discovery` |  |  |
| `GET /public-api/gizmos/discovery/{category_or_cut_id}` | cursor, limit, locale |  |
| `GET /public-api/gizmos/{gizmo_id_or_short_url}` |  |  |
| `POST /public-api/report_flow/reasons/ad` |  | ad_data_token |
| `POST /public-api/report_flow/report` |  | additional_entity_ids, additional_fields_values, entity_id, entity_type, product_area, reason |

### `public` (4)

| Call | query | body |
| --- | --- | --- |
| `GET /public/business-profile-share-links/{segment}` |  |  |
| `POST /public/plugins/workspace` |  |  |
| `POST /public/plugins/workspace/upload-url` |  | ...spread, filename, mime_type, size_bytes |
| `POST /public/plugins/workspace/{plugin_id}` |  |  |

### `quorum` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /quorum/preverify_npi` |  | npi |
| `POST /quorum/refresh_enrollment_status` |  |  |
| `POST /quorum/workspace/{account_id}/sign_baa` |  |  |

### `rbac` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /rbac/workspace/{workspace_id}/connector/{connector_id}/roles` | account_id, consistency |  |
| `PATCH /rbac/workspace/{workspace_id}/roles/{role_id}/connectors/{connector_id}` | account_id | permissions |

### `received-shares` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /received-shares` | cursor, limit |  |
| `POST /received-shares/open` |  | share_id, share_kind |
| `DELETE /received-shares/{share_kind}/{share_id}` |  |  |

### `record` (9)

| Call | query | body |
| --- | --- | --- |
| `GET /record/activity` |  |  |
| `GET /record/calendar/agenda` | ...spread, cursor, end_date, limit, start_date, time_zone |  |
| `POST /record/hosted-meetings` |  |  |
| `GET /record/hosted-meetings/active` | cursor, dot_id |  |
| `GET /record/hosted-meetings/{session_id}` |  |  |
| `GET /record/pages/{page_id}` |  |  |
| `GET /record/pages/{page_id}/transcript-window` | before, cursor |  |
| `GET /record/settings/preferences` |  |  |
| `PATCH /record/settings/preferences` |  | featureEnabled |

### `referrals` (8)

| Call | query | body |
| --- | --- | --- |
| `POST /referrals/invite` | placement | checkout, emails, entrypoint, program_id |
| `GET /referrals/invite/eligibility` | entrypoint, placement, program_id |  |
| `GET /referrals/invite/tracking` | cursor, limit, period, program_id |  |
| `POST /referrals/invite/{referral_id}/send-email` |  |  |
| `POST /referrals/link/{link_id}/claim` |  |  |
| `GET /referrals/workspace/domain-members` | source |  |
| `GET /referrals/workspace/domain-members/header` |  |  |
| `POST /referrals/workspace/domain-members/invite` | auto_approve_join_requests, source | cohort_token, source |

### `report_flow` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /report_flow/reasons/ad` |  | ad_data_token |
| `GET /report_flow/reasons/{entity_type}` |  |  |
| `POST /report_flow/report` |  | additional_fields_values, entity_id, entity_type, product_area, reason |

### `rosalind` (11)

| Call | query | body |
| --- | --- | --- |
| `GET /rosalind/applications` | cursor |  |
| `POST /rosalind/applications/drafts` |  | application_type |
| `DELETE /rosalind/applications/drafts/{draft_id}` |  |  |
| `PATCH /rosalind/applications/drafts/{draft_id}` |  | answers |
| `POST /rosalind/applications/drafts/{draft_id}/persona` |  |  |
| `POST /rosalind/applications/drafts/{draft_id}/persona/status` |  |  |
| `POST /rosalind/applications/drafts/{draft_id}/submit` |  | ...spread, attestations, form_schema_version |
| `GET /rosalind/applications/{application_id}` |  |  |
| `POST /rosalind/applications/{application_id}/activation` |  |  |
| `POST /rosalind/applications/{application_id}/cancel` |  |  |
| `PUT /rosalind/applications/{application_id}/retention-request` |  |  |

### `saved-credentials` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /saved-credentials` | cursor |  |
| `DELETE /saved-credentials/{credential_id}` |  |  |

### `search` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /search/browse_turn_filters` |  |  |
| `POST /search/browse_turn_product_descriptions` |  | conversation_id, message_id, products |
| `GET /search/browse_turn_products` | ...spread, filters, generate_filters, limit, offset |  |

### `sectioned-conversations` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /sectioned-conversations/{id}/on-section-complete` |  | section_id |

### `sentinel` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /sentinel/chat-requirements/finalize` |  | prepare_token, proofofwork, turnstile |
| `POST /sentinel/chat-requirements/prepare` |  | p |

### `service-accounts` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /service-accounts/{service_account_user_id}/plugins/installed` | team_id |  |
| `POST /service-accounts/{service_account_user_id}/plugins/{plugin_id}/install` |  |  |
| `POST /service-accounts/{service_account_user_id}/plugins/{plugin_id}/uninstall` |  |  |

### `settings` (11)

| Call | query | body |
| --- | --- | --- |
| `PATCH /settings/account_user_setting` | feature, value |  |
| `GET /settings/age_verification_enabled` |  |  |
| `POST /settings/announcement_viewed` | announcement_id |  |
| `DELETE /settings/clear_account_user_memory` |  |  |
| `POST /settings/clear_is_adult_caches` |  |  |
| `GET /settings/is_adult` |  |  |
| `GET /settings/user` |  |  |
| `POST /settings/user/bazaar/consent/seen` |  | presentation_id |
| `PATCH /settings/user_last_used_model_config` | model_slug, thinking_effort |  |
| `PATCH /settings/user_tpp_last_used_model_config` | model_slug, thinking_effort |  |
| `GET /settings/voices` | spoken_language, voice_mode |  |

### `share` (20)

| Call | query | body |
| --- | --- | --- |
| `DELETE /share/all` |  | confirm |
| `POST /share/automation` |  | automation_id |
| `DELETE /share/automation/{automation_id}` |  |  |
| `GET /share/automation/{automation_id}/current` |  |  |
| `POST /share/automation/{automation_id}/refresh` |  |  |
| `POST /share/create` |  | conversation_id, current_node_id, is_anonymous |
| `POST /share/post` |  | attachments_to_create |
| `POST /share/post/link` |  | attachments_to_create, post_text |
| `DELETE /share/post/{post_id}` |  |  |
| `GET /share/post/{post_id}/automation` |  |  |
| `PATCH /share/post/{post_id}/prompt-share` |  |  |
| `DELETE /share/posts/mine` |  |  |
| `GET /share/posts/mine` | cursor, limit |  |
| `POST /share/prompt-share` |  | conversation_id, idempotency_key, message_id, output_asset_pointer, post_text, published_content |
| `POST /share/v2/create` |  | conversation_id, current_node_id, is_anonymous |
| `DELETE /share/{shared_conversation_id}` |  |  |
| `GET /share/{shared_conversation_id}` |  |  |
| `PATCH /share/{shared_conversation_id}` |  | current_node_id, highlighted_message_id, is_anonymous, is_public, is_visible, title |
| `GET /share/{shared_conversation_id}/file/{file_id}` |  |  |
| `GET /share/{shared_conversation_id}/file_from_message/{message_id}` | file_path |  |

### `shared_conversations` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /shared_conversations` | order |  |

### `shared_textdocs` (2)

| Call | query | body |
| --- | --- | --- |
| `DELETE /shared_textdocs` |  |  |
| `GET /shared_textdocs` |  |  |

### `sharing` (5)

| Call | query | body |
| --- | --- | --- |
| `GET /sharing/invitations` | cursor, limit, resource_type |  |
| `GET /sharing/invitations/{invitation_id}` |  |  |
| `POST /sharing/invitations/{invitation_id}/accept` |  |  |
| `POST /sharing/invitations/{invitation_id}/decline` |  |  |
| `POST /sharing/recipients/resolve` |  | email |

### `shopping` (66)

| Call | query | body |
| --- | --- | --- |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/chatgpt-preview` |  | expectedRevision |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/industry-eligibility` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/insights` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/insights/improvements` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/insights/intents` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/insights/quality` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/insights/target` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/preview` |  | expectedRevision, message, sessionId |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/v2` | include_preparation |  |
| `PUT /shopping/business-profiles/{business_profile_id}/agent-builder/v2` |  | draft, expectedRevision |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/v2/create` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/v2/disable` |  | expectedRevision |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/v2/discard` |  | expectedRevision |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/v2/open-generated-draft` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/v2/prepare` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/agent-builder/v2/publish` |  | expectedRevision |
| `GET /shopping/business-profiles/{business_profile_id}/agent-builder/verification` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/feed-summaries` | ...spread, feed_ids, include_catalog_summary, include_connection_status |  |
| `GET /shopping/business-profiles/{business_profile_id}/feeds` | ...spread, cursor, limit |  |
| `POST /shopping/business-profiles/{business_profile_id}/feeds` |  | create_request_id, display_name |
| `GET /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/archive` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/hosted-url` |  |  |
| `PUT /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/hosted-url` |  | ...spread, enabled, frequency |
| `POST /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/hosted-url/runs` |  | ...spread, create_request_id |
| `POST /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/hosted-url/schedule/disable` |  |  |
| `GET /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/sftp` |  |  |
| `PATCH /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/sftp` |  | enabled |
| `POST /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/sftp` |  | authentication_method, ssh_public_key |
| `POST /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/sftp/password-reset` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/sftp/ssh-key` |  | ssh_public_key |
| `GET /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/uploads` | ...spread, cursor, limit |  |
| `GET /shopping/business-profiles/{business_profile_id}/feeds/{feed_id}/uploads/{upload_id}` | ...spread, include_hosted_failure |  |
| `GET /shopping/business-profiles/{business_profile_id}/merchant-agreement` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/merchant-agreement` |  | accepted_terms, agreement_version, consent_version |
| `POST /shopping/business-profiles/{business_profile_id}/shopify-products/connect` |  | idempotency_key, myshopify_domain, shop_gid |
| `GET /shopping/business-profiles/{business_profile_id}/shopify-products/connection` |  |  |
| `POST /shopping/business-profiles/{business_profile_id}/shopify-products/disconnect` |  |  |
| `GET /shopping/category-deals` | category, refresh, section |  |
| `POST /shopping/ecosystem/checkout_v2` |  | ...spread, connector_id, conversation_id, ecosystem_app_uri, link_id, logo_url, merchant, shared_conversation_url |
| `POST /shopping/ecosystem/checkout_v2/{checkout_session_id}/complete` |  | payment_attempt_id, payment_method |
| `GET /shopping/entities/{entity_share_id}` |  |  |
| `POST /shopping/entity-shares` |  | product_lookup_key |
| `GET /shopping/feeds` |  |  |
| `POST /shopping/feeds` |  | merchant_name, supported_countries, supported_currencies |
| `GET /shopping/feeds/{feed_id}/runs` |  |  |
| `POST /shopping/feeds/{feed_id}/runs` | business_profile_id | feed_type, file_name, headers, require_supported_filename, run_id, source, source_url |
| `GET /shopping/feeds/{feed_id}/runs/{run_id}` | business_profile_id, feed_type, include_upload_observation |  |
| `POST /shopping/feeds/{feed_id}/runs/{run_id}/submit` | business_profile_id, feed_type |  |
| `POST /shopping/feeds/{feed_id}/schedule` |  | enabled, feed_type, frequency, headers, source_url |
| `GET /shopping/feeds/{feed_id}/sftp-access` |  |  |
| `POST /shopping/feeds/{feed_id}/sftp-access/password-reset` |  |  |
| `POST /shopping/feeds/{feed_id}/sftp-access/ssh-key` |  | ssh_public_key |
| `GET /shopping/feeds/{feed_id}/uploads` | ...spread, business_profile_id, errors_only, lookback_days |  |
| `GET /shopping/feeds/{feed_id}/uploads/{upload_id}/diagnostics` | ...spread, business_profile_id, code |  |
| `POST /shopping/feeds/{feed_id}/validate` | business_profile_id | file_format_hint, file_name, headers, profile_source, require_supported_filename, sample_limit, sample_rows, source, source_url |
| `GET /shopping/for-you` | ...spread, cursor, refresh |  |
| `POST /shopping/for-you` |  | excluded_offer_ids, excluded_product_ids, preference, refresh |
| `GET /shopping/for-you/gmail` |  |  |
| `POST /shopping/for-you/gmail-refresh` |  |  |
| `POST /shopping/for-you/profile-selection` |  | task_id |
| `GET /shopping/for-you/profile-tasks` |  |  |
| `GET /shopping/home` | campaign |  |
| `POST /shopping/merchant-agreement/domain/accept` |  | accepted_terms, agreement_version, consent_version |
| `GET /shopping/merchant-agreement/status` |  |  |
| `POST /shopping/onboarding/observations` |  | ...spread, business_profile_id, operation, outcome |

### `sidebar` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /sidebar/conversation_context_citation_conversation_visibility` |  | conversation_id, conversation_ids, message_id |
| `POST /sidebar/conversation_context_citation_feedback` |  | citation_uuid, clicked_explain, conversation_id, deleted, feedback, memory_correction, message_id |
| `POST /sidebar/personalized_information_questionnaire_feedback` |  | ...spread, answer, citation, conversation_id, message_id, question_id, questionnaire_id, surface |

### `sites` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /sites/mcp/plugins/{plugin_id}/sharing-info` |  |  |

### `sophia` (14)

| Call | query | body |
| --- | --- | --- |
| `POST /sophia/accept_invite` |  | account_invite_id |
| `GET /sophia/application` |  |  |
| `POST /sophia/application` |  |  |
| `GET /sophia/application/managed-workspace` |  |  |
| `POST /sophia/application/managed-workspace` |  | application_id, operations_revision, request_id, submission_revision, workspace_id |
| `POST /sophia/application/notification-authorization` |  | application_id, submission_revision |
| `POST /sophia/application/resume-verification` |  | resume_verification |
| `POST /sophia/application/verify-affiliation` |  | ...spread, application_verification_id, expected_submission_revision, redirect_url |
| `POST /sophia/create_verification` |  | redirect_url |
| `POST /sophia/refresh_invite_status` |  | account_invite_id |
| `POST /sophia/refresh_verification_status` |  |  |
| `GET /sophia/waitlist` |  |  |
| `POST /sophia/waitlist` |  |  |
| `GET /sophia/workspace-sign-in` |  |  |

### `spaces` (33)

| Call | query | body |
| --- | --- | --- |
| `GET /spaces/people` | ...spread, account_id, account_user_ids, include_profile_details, limit, offset, profiles_only, query |  |
| `GET /spaces/policy` |  |  |
| `GET /spaces/v2` | cursor, include_checkpoint_cdn, include_edit_hint, limit, prefer_lite_checkpoint, status |  |
| `POST /spaces/v2` |  |  |
| `GET /spaces/v2/{space_id}` | include_root_page_metadata |  |
| `GET /spaces/v2/{space_id}/access-requests` | cursor |  |
| `POST /spaces/v2/{space_id}/access-requests` |  |  |
| `POST /spaces/v2/{space_id}/access-requests/for-others` |  |  |
| `POST /spaces/v2/{space_id}/access-requests/for-self` |  |  |
| `GET /spaces/v2/{space_id}/access-requests/requested` | cursor, limit |  |
| `POST /spaces/v2/{space_id}/access-requests/{request_id}/approve` |  | recipient, request_created_at, role |
| `POST /spaces/v2/{space_id}/access-requests/{request_id}/reject` |  | recipient, request_created_at |
| `PATCH /spaces/v2/{space_id}/appearance` |  |  |
| `GET /spaces/v2/{space_id}/invitation` | invitation_id |  |
| `GET /spaces/v2/{space_id}/share-submissions/{submission_id}` |  |  |
| `GET /spaces/v2/{space_id}/shares` | cursor, include_inherited_access, limit, read_only |  |
| `POST /spaces/v2/{space_id}/shares` |  | recipient, role_id |
| `DELETE /spaces/v2/{space_id}/shares/{share_id}` |  |  |
| `PATCH /spaces/v2/{space_id}/shares/{share_id}` |  | role_id |
| `GET /spaces/{source_space_id}/page-moves/{operation_id}` |  |  |
| `POST /spaces/{source_space_id}/page-moves/{operation_id}/resume` |  |  |
| `DELETE /spaces/{space_id}` |  |  |
| `POST /spaces/{space_id}/archive` | attempt_id |  |
| `GET /spaces/{space_id}/archive-status` |  |  |
| `POST /spaces/{space_id}/archive/{operation_id}/retry` |  |  |
| `DELETE /spaces/{space_id}/delete-forever` |  |  |
| `POST /spaces/{space_id}/delete-forever/confirmed` |  |  |
| `GET /spaces/{space_id}/delete-forever/status` | archived_at, root_page_id |  |
| `GET /spaces/{space_id}/folders` | cursor, directory_id, limit |  |
| `POST /spaces/{space_id}/folders` |  | name |
| `GET /spaces/{space_id}/pages` | cursor, limit, parent_page_id, query |  |
| `POST /spaces/{space_id}/restore` | archived_at |  |
| `GET /spaces/{space_id}/restore-status` | archived_at |  |

### `stop_conversation` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /stop_conversation` |  |  |

### `students` (4)

| Call | query | body |
| --- | --- | --- |
| `POST /students/create_verification` |  | attribution, campaign_id, partner_id |
| `POST /students/grant_benefit` |  | account_id, benefit_kind, campaign_id, go_upgrade_offer, updated_plan |
| `POST /students/preverify_2025_redeemer` |  | attribution, campaign_id |
| `POST /students/refresh_enrollment_status` |  | attribution, campaign_id |

### `subscriptions` (18)

| Call | query | body |
| --- | --- | --- |
| `GET /subscriptions` | account_id |  |
| `POST /subscriptions/auto_top_up/disable` |  |  |
| `POST /subscriptions/auto_top_up/enable` |  |  |
| `GET /subscriptions/auto_top_up/settings` | include_payment_method |  |
| `POST /subscriptions/auto_top_up/update` |  |  |
| `POST /subscriptions/cancel` |  | account_id, cancellation_outcome |
| `POST /subscriptions/complete_payment` |  | account_id, context, payment_method_id |
| `POST /subscriptions/complete_payment/invoice_details` |  | account_id |
| `POST /subscriptions/complete_payment/recovery_assignment` |  | account_id |
| `GET /subscriptions/credits/discount-offer` |  |  |
| `POST /subscriptions/credits/preview` |  |  |
| `GET /subscriptions/deactivated_workspace_invoice_context` | account_id |  |
| `POST /subscriptions/renew` |  | account_id |
| `GET /subscriptions/renew/preview` | account_id |  |
| `POST /subscriptions/update` |  | ...spread, account_id, payment_method_id, promotion_acceptance_origin, setup_intent_id, updated_plan, updated_price_interval, updated_promo_code |
| `POST /subscriptions/update/cancel_pending` |  | account_id, expected_payment_intent_id, pending_update_invoice_id |
| `GET /subscriptions/update/delinquent_upgrade/preview` | account_id, updated_plan |  |
| `GET /subscriptions/update/preview` | ...spread, account_id, updated_price_interval, updated_promo_id |  |

### `suggested_automations` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /suggested_automations` |  |  |

### `system_hints` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /system_hints` | exclude_logo, gizmo_id, mode, suggestions |  |

### `task_suggestions` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /task_suggestions/dismiss` |  | action, task_suggestion_id |

### `tbo` (54)

| Call | query | body |
| --- | --- | --- |
| `GET /tbo` | cursor, include_room_preview, limit |  |
| `POST /tbo` |  | ...spread, create_thread, description, display_name, force_first_creation, should_initialize |
| `GET /tbo/by-thread/{thread_id}` |  |  |
| `POST /tbo/create_personal_dot` |  |  |
| `POST /tbo/deletion-recovery` |  |  |
| `POST /tbo/name/validate` |  | name |
| `GET /tbo/onboarding/connections` |  |  |
| `DELETE /tbo/primary` | generation |  |
| `GET /tbo/primary` |  |  |
| `PUT /tbo/primary` |  | tbo_id |
| `POST /tbo/start_dot_thread/{dot_id}` |  |  |
| `DELETE /tbo/{tbo_id}` | thread_id |  |
| `GET /tbo/{tbo_id}` |  |  |
| `PATCH /tbo/{tbo_id}` |  | avatar, display_name, only_if_default_avatar |
| `GET /tbo/{tbo_id}/activity/header` |  |  |
| `GET /tbo/{tbo_id}/activity/topics` | cursor, limit |  |
| `DELETE /tbo/{tbo_id}/activity/topics/{topic_id}` |  |  |
| `GET /tbo/{tbo_id}/activity/topics/{topic_id}/items` | ...spread, cursor, limit |  |
| `GET /tbo/{tbo_id}/automations` | cursor, limit |  |
| `DELETE /tbo/{tbo_id}/channels/email` |  |  |
| `GET /tbo/{tbo_id}/channels/email` |  |  |
| `PATCH /tbo/{tbo_id}/channels/email` |  |  |
| `PUT /tbo/{tbo_id}/channels/email` |  |  |
| `GET /tbo/{tbo_id}/channels/email/activity` | activity_folder |  |
| `GET /tbo/{tbo_id}/channels/email/activity/{message_id}` |  |  |
| `GET /tbo/{tbo_id}/channels/email/blocked-senders` |  |  |
| `POST /tbo/{tbo_id}/channels/email/blocked-senders` |  |  |
| `POST /tbo/{tbo_id}/channels/email/claim` |  |  |
| `GET /tbo/{tbo_id}/channels/email/options` |  |  |
| `GET /tbo/{tbo_id}/channels/phone` | include_texting |  |
| `GET /tbo/{tbo_id}/channels/slack` |  |  |
| `POST /tbo/{tbo_id}/channels/slack` |  | ...spread, display_name, enterprise_id, include_directory, parent_link_id, public_read_workspaces, workspace_id |
| `DELETE /tbo/{tbo_id}/channels/slack/{binding_id}` | binding_version |  |
| `GET /tbo/{tbo_id}/computers` | expected_thread_id, include_cloud, include_shareable_computers |  |
| `POST /tbo/{tbo_id}/computers/{environment_id}/disconnect` | expected_thread_id |  |
| `POST /tbo/{tbo_id}/environment/recreate` | thread_id |  |
| `GET /tbo/{tbo_id}/environment/status` | thread_id |  |
| `POST /tbo/{tbo_id}/environment/wake` |  |  |
| `POST /tbo/{tbo_id}/messaging-room` |  |  |
| `GET /tbo/{tbo_id}/misalignment-review` |  |  |
| `GET /tbo/{tbo_id}/plugins/installed` |  |  |
| `PUT /tbo/{tbo_id}/primary-computer` |  | installation_id |
| `GET /tbo/{tbo_id}/root-thread` |  |  |
| `POST /tbo/{tbo_id}/runtime/pause` |  |  |
| `POST /tbo/{tbo_id}/runtime/resume` |  | clear_safety_flag |
| `GET /tbo/{tbo_id}/shares` | cursor, limit |  |
| `POST /tbo/{tbo_id}/shares` |  | recipient, role_id |
| `DELETE /tbo/{tbo_id}/shares/me` |  |  |
| `GET /tbo/{tbo_id}/shares/me` |  |  |
| `DELETE /tbo/{tbo_id}/shares/{share_id}` |  |  |
| `GET /tbo/{tbo_id}/threads` | cursor, include_hidden, limit |  |
| `POST /tbo/{tbo_id}/voice/calls/{call_id}/attach` |  |  |
| `POST /tbo/{tbo_id}/voice/calls/{call_id}/stop` |  |  |
| `GET /tbo/{tbo_id}/voice/calls/{call_id}/transcript` |  |  |

### `teachers` (4)

| Call | query | body |
| --- | --- | --- |
| `POST /teachers/accept_teacher_invite` |  | account_invite_id, has_agreed_to_terms |
| `POST /teachers/create_verification` |  |  |
| `POST /teachers/refresh_enrollment_status` |  |  |
| `POST /teachers/refresh_invite_status` |  | account_invite_id |

### `templates` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /templates` | cursor, limit, query, template_type |  |
| `POST /templates/{page_id}/use/{operation_id}` |  |  |

### `textdoc` (2)

| Call | query | body |
| --- | --- | --- |
| `DELETE /textdoc/shared/{shared_textdoc_id}` |  |  |
| `POST /textdoc/shared/{shared_textdoc_id}/report` |  | takedown_type |

### `tpp` (8)

| Call | query | body |
| --- | --- | --- |
| `GET /tpp/default-tab-recommendation` |  |  |
| `POST /tpp/default-tab-recommendation` |  |  |
| `GET /tpp/models/` | iim, include_icons |  |
| `GET /tpp/onboarding/suggestions` |  |  |
| `POST /tpp/onboarding/suggestions` |  |  |
| `POST /tpp/work-handoff/convert` |  | handoff_id, source_conversation_id, source_title, supports_chat_backup_undo, work_model_slug |
| `POST /tpp/work-handoff/restore-chat` |  | handoff_id, source_conversation_id |
| `POST /tpp/work-handoff/undo` |  | handoff_id, source_conversation_id |

### `transcribe` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /transcribe` |  |  |

### `translation-block` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /translation-block/translate` |  | sourceLanguageCode, targetLanguageCode, text |

### `trusted-access` (3)

| Call | query | body |
| --- | --- | --- |
| `POST /trusted-access/aws` |  | ...spread, organization |
| `GET /trusted-access/aws/context` |  |  |
| `POST /trusted-access/aws/enrollments` |  | ...spread, organization |

### `trusted_contact` (7)

| Call | query | body |
| --- | --- | --- |
| `GET /trusted_contact` |  |  |
| `POST /trusted_contact` |  |  |
| `GET /trusted_contact/enabled` |  |  |
| `GET /trusted_contact/nominee` | token |  |
| `POST /trusted_contact/removal` |  | token, trusted_contact_id |
| `DELETE /trusted_contact/{trusted_contact_id}` |  |  |
| `PUT /trusted_contact/{trusted_contact_id}` |  |  |

### `unified_user_signals` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /unified_user_signals` |  | product_surface, signal_detail, signal_metadata, signal_type, user_metadata |

### `user_feedback` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /user_feedback/submit_feedback` |  | app_build_type, app_debug_info, app_platform, app_version, attachments, conversation_id, entry_point_element_id, feature_area, language, timestamp_client, user_agent, user_feedback_description, viewport_size, work_mode_diagnostics_consent, work_mode_feedback_classification |

### `user_granular_consent` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /user_granular_consent` |  |  |
| `POST /user_granular_consent` |  | granular_consent |

### `user_information` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /user_information/grants` |  |  |
| `POST /user_information/grants` |  | app_uri, provider_name |
| `DELETE /user_information/grants/{grant_id}` |  |  |

### `user_segments` (3)

| Call | query | body |
| --- | --- | --- |
| `GET /user_segments` | include_business_use_propensity, include_plus_work_use_propensity |  |
| `GET /user_segments/business_upsell` |  |  |
| `GET /user_segments/codex_surface_usage` |  |  |

### `user_system_messages` (2)

| Call | query | body |
| --- | --- | --- |
| `GET /user_system_messages` |  |  |
| `PATCH /user_system_messages` |  |  |

### `v1` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /v1/offer-configuration` |  |  |

### `veterans` (5)

| Call | query | body |
| --- | --- | --- |
| `POST /veterans/apply_discount` |  | account_id |
| `POST /veterans/create_verification` |  | program_id |
| `POST /veterans/refresh_enrollment_status` |  |  |
| `POST /veterans/reset_verification` |  |  |
| `POST /veterans/submit_service_end_date` |  | service_end_date |

### `websites` (31)

| Call | query | body |
| --- | --- | --- |
| `GET /websites` | after, include_editable, limit |  |
| `GET /websites/access` |  |  |
| `GET /websites/automation-attachments` | project_ids |  |
| `GET /websites/automations/{automation_id}/sites` |  |  |
| `GET /websites/pinned` | after, limit, query |  |
| `GET /websites/previews/publish` | content_file_id, library_file_id |  |
| `POST /websites/previews/publish` |  | expected_content_sha256, library_file_id, version_number |
| `GET /websites/shared` | after, limit, query |  |
| `DELETE /websites/{project_id}` |  |  |
| `GET /websites/{project_id}` | projection |  |
| `GET /websites/{project_id}/access_request` | token |  |
| `POST /websites/{project_id}/access_request` |  |  |
| `POST /websites/{project_id}/automation-attachments` |  | automation_id |
| `GET /websites/{project_id}/custom_domains` |  |  |
| `POST /websites/{project_id}/custom_domains` |  | hostname |
| `DELETE /websites/{project_id}/custom_domains/{custom_domain_id}` |  |  |
| `POST /websites/{project_id}/custom_domains/{custom_domain_id}/refresh` |  |  |
| `GET /websites/{project_id}/environment` |  |  |
| `POST /websites/{project_id}/environment` |  |  |
| `POST /websites/{project_id}/metadata` |  | slug, title |
| `DELETE /websites/{project_id}/pin` |  |  |
| `GET /websites/{project_id}/pin` |  |  |
| `POST /websites/{project_id}/pin` |  |  |
| `GET /websites/{project_id}/plugins` |  |  |
| `GET /websites/{project_id}/preferred_live_url` |  |  |
| `GET /websites/{project_id}/share_access` |  |  |
| `PATCH /websites/{project_id}/share_access` |  |  |
| `POST /websites/{project_id}/share_access` |  |  |
| `POST /websites/{project_id}/slug/availability` |  | slug |
| `POST /websites/{project_id}/versions/{version_id}/publish` |  | expected_project_etag |
| `GET /websites/{project_id}/versions/{version_id}/publish_state` |  |  |

### `wham` (145)

| Call | query | body |
| --- | --- | --- |
| `GET /wham/accounts/check` |  |  |
| `POST /wham/analytics-events/events` |  |  |
| `GET /wham/analytics/code-attribution` | ...spread, group |  |
| `GET /wham/analytics/daily-code-review-metrics` |  |  |
| `GET /wham/analytics/daily-plugin-usage-metrics` | end_date, group_by, start_date, top_plugin_limit, workspace_user |  |
| `GET /wham/analytics/daily-skill-usage-metrics` | end_date, group_by, start_date, top_skill_limit, workspace_user |  |
| `GET /wham/analytics/daily-workspace-usage-counts` |  |  |
| `GET /wham/browser/settings` |  |  |
| `PATCH /wham/browser/settings` |  |  |
| `GET /wham/config/agent-bundle` | environment_os, environment_type |  |
| `GET /wham/config/agent-enterprise-managed` |  |  |
| `GET /wham/config/bundle` |  |  |
| `GET /wham/config/enterprise-managed` |  |  |
| `POST /wham/config/model-policy/evaluate` |  | scope_ids |
| `GET /wham/environments` |  |  |
| `POST /wham/environments` |  |  |
| `GET /wham/environments/search` | cursor, limit, query |  |
| `DELETE /wham/environments/{environment_id}` |  |  |
| `PATCH /wham/environments/{environment_id}` |  |  |
| `POST /wham/environments/{environment_id}/reset-cache` |  |  |
| `GET /wham/environments/{environment_id}/with-creator-and-machine` |  |  |
| `GET /wham/finance/eligibility` |  |  |
| `GET /wham/github/connections` |  |  |
| `GET /wham/github/installations/v2` | connector_id, link_id |  |
| `GET /wham/github/list-repositories` | connector_id, page, per_page |  |
| `POST /wham/github/operations/account` |  |  |
| `POST /wham/github/operations/gh-pr-body` |  |  |
| `POST /wham/github/operations/gh-pr-checks` |  | ...spread, account, headRevision |
| `POST /wham/github/operations/gh-pr-comment` |  |  |
| `POST /wham/github/operations/gh-pr-comment-update` |  |  |
| `POST /wham/github/operations/gh-pr-diff` |  |  |
| `POST /wham/github/operations/gh-pr-discussion` |  |  |
| `POST /wham/github/operations/gh-pr-label-update` |  | ...spread |
| `POST /wham/github/operations/gh-pr-labels` |  |  |
| `POST /wham/github/operations/gh-pr-merge` |  |  |
| `POST /wham/github/operations/gh-pr-metadata` |  |  |
| `POST /wham/github/operations/gh-pr-metadata-v2` |  |  |
| `POST /wham/github/operations/gh-pr-reaction-update` |  | ...spread |
| `POST /wham/github/operations/gh-pr-reactions` |  | account, pullRequest, subjects |
| `POST /wham/github/operations/gh-pr-review-snapshot` |  |  |
| `POST /wham/github/operations/gh-pr-review-thread-update` |  |  |
| `POST /wham/github/operations/gh-pr-reviews` |  |  |
| `POST /wham/github/operations/gh-pr-revision-diff` |  |  |
| `POST /wham/github/operations/gh-pr-revision-file` |  |  |
| `POST /wham/github/operations/gh-pr-search` | includeChecks |  |
| `POST /wham/github/operations/gh-pr-stack` |  |  |
| `POST /wham/github/operations/gh-pr-submit-review` |  |  |
| `POST /wham/github/operations/gh-pr-update` |  |  |
| `POST /wham/github/operations/gh-repository-labels` |  | ...spread, cursor, query |
| `POST /wham/github/operations/gh-user-search` |  |  |
| `POST /wham/github/operations/initial-detail` |  |  |
| `POST /wham/github/operations/read-media` |  | account, mediaKind, url |
| `POST /wham/github/operations/render-markdown` |  | account, pullRequest, text |
| `POST /wham/github/operations/review-metadata` |  | account, pullRequests |
| `POST /wham/github/operations/searches` | includeChecks | account, searches |
| `POST /wham/github/operations/summaries` |  | account, pullRequests |
| `GET /wham/github/repositories/search` | account_login, account_type, connector_id, link_id, page, per_page, query |  |
| `GET /wham/github/repositories/v2/{installation_id}` |  |  |
| `POST /wham/gitlab/operations/configure-auto-merge` |  | account, enabled, expectedHeadRevision, mergeMethod, pullRequest |
| `POST /wham/gitlab/operations/delete-comment` |  | account, commentId, pullRequest |
| `POST /wham/gitlab/operations/merge` |  | account, expectedHeadRevision, mergeMethod, pullRequest |
| `POST /wham/gitlab/operations/post-comment` |  | account, body, inlineComment, pullRequest |
| `POST /wham/gitlab/operations/read-check-diagnostics` |  | ...spread, account |
| `POST /wham/gitlab/operations/read-checks` |  | account, headRevision, pullRequest |
| `POST /wham/gitlab/operations/read-diff` |  | account, headRevision, pullRequest |
| `POST /wham/gitlab/operations/read-discussions` |  | account, pullRequest |
| `POST /wham/gitlab/operations/read-media` |  |  |
| `POST /wham/gitlab/operations/read-mention-suggestions` |  | account, pullRequest, query |
| `POST /wham/gitlab/operations/read-mergeability` |  | account, pullRequest |
| `POST /wham/gitlab/operations/read-pull-request` |  | account, pullRequest |
| `POST /wham/gitlab/operations/read-pull-requests-metadata` |  | account, pullRequests |
| `POST /wham/gitlab/operations/read-reviewers` |  | account, pullRequest |
| `POST /wham/gitlab/operations/read-revision-file` |  | account, basePath, comparison, headPath, pullRequest |
| `POST /wham/gitlab/operations/read-stack` |  | account, pullRequest |
| `POST /wham/gitlab/operations/reply-comment` |  | account, body, discussionId, pullRequest |
| `POST /wham/gitlab/operations/search-pull-requests` |  | account, search |
| `POST /wham/gitlab/operations/search-reviewer-candidates` |  | account, pullRequest, query |
| `POST /wham/gitlab/operations/submit-review` |  | account, pullRequest, review |
| `POST /wham/gitlab/operations/update-body` |  | account, body, pullRequest |
| `POST /wham/gitlab/operations/update-comment` |  | account, body, commentId, pullRequest |
| `POST /wham/gitlab/operations/update-reaction` |  | account, active, commentId, content, pullRequest |
| `POST /wham/gitlab/operations/update-resolution` |  | account, discussionId, pullRequest, resolved |
| `POST /wham/gitlab/operations/update-reviewer-assignment` |  | account, action, pullRequest, reviewers |
| `POST /wham/gitlab/operations/update-status` |  | account, action, pullRequest |
| `POST /wham/gitlab/operations/update-title` |  | account, pullRequest, title |
| `GET /wham/gitlab/repositories/search/all-installations` | connector_id, limit, page, query |  |
| `GET /wham/machines` |  |  |
| `GET /wham/memories/import` |  |  |
| `GET /wham/models` | client_version |  |
| `GET /wham/onboarding/context` |  |  |
| `POST /wham/onboarding/role` |  | role |
| `POST /wham/onboarding/role/classify` |  |  |
| `POST /wham/onboarding/web/tiles` |  | tiles_visible |
| `GET /wham/profiles/me` |  |  |
| `PATCH /wham/profiles/me` |  | username |
| `POST /wham/profiles/me/photo` |  |  |
| `POST /wham/profiles/username/check` |  | username |
| `GET /wham/rate-limit-reset-credits` |  |  |
| `POST /wham/rate-limit-reset-credits/consume` |  | credit_id, redeem_request_id |
| `GET /wham/rate-limit-reset-credits/history` | cursor |  |
| `POST /wham/remote/control/client/enroll/finish` |  | client_id, device_identity, device_key_proof, step_up_token |
| `POST /wham/remote/control/client/enroll/start` |  |  |
| `POST /wham/remote/control/client/pair` |  |  |
| `POST /wham/remote/control/client/refresh/finish` |  | client_id, device_key_proof |
| `POST /wham/remote/control/client/refresh/start` |  | client_id |
| `GET /wham/remote/control/clients` | cursor, limit |  |
| `DELETE /wham/remote/control/clients/{client_id}` |  |  |
| `GET /wham/remote/control/clients/{client_id}/environments` | cursor, limit |  |
| `GET /wham/remote/control/environments` | cursor, limit |  |
| `DELETE /wham/remote/control/environments/{env_id}` |  |  |
| `PATCH /wham/remote/control/environments/{env_id}` |  | name |
| `GET /wham/remote/control/mfa_requirement` |  |  |
| `GET /wham/settings/code_review` | connector_id, next_token, per_page, provider |  |
| `PATCH /wham/settings/code_review` |  | repo_review_settings |
| `GET /wham/settings/code_review/{repo_id}` | connector_id |  |
| `GET /wham/settings/code_review_search` | connector_id, limit, page, provider, query |  |
| `GET /wham/settings/configs/user-preferences` |  |  |
| `DELETE /wham/settings/gitlab/service-account-credential` | connector_id |  |
| `GET /wham/settings/gitlab/service-account-credential` | connector_id |  |
| `PUT /wham/settings/gitlab/service-account-credential` |  | connector_id, personal_access_token |
| `POST /wham/settings/gitlab/service-account-credential/create` |  | connector_id, group_ids, project_access_mode, project_ids |
| `POST /wham/settings/gitlab/service-account-credential/generate-token` |  | connector_id |
| `GET /wham/settings/gitlab/service-account-credential/groups` | ...spread, connector_id, page, page_size |  |
| `PATCH /wham/settings/gitlab/service-account-credential/projects` |  | connector_id, credential_revision, group_ids, project_access_mode, project_ids |
| `GET /wham/settings/user` |  |  |
| `PATCH /wham/settings/user` |  |  |
| `POST /wham/shared_threads` |  |  |
| `POST /wham/shared_threads/upload_urls` |  | ...spread, assets, snapshot |
| `GET /wham/shared_threads/{share_id}` |  |  |
| `GET /wham/task_suggestions/github/user_handle` | connector_id |  |
| `GET /wham/usage` |  |  |
| `GET /wham/usage/chatpass/apps` |  |  |
| `PUT /wham/usage/chatpass/limits` |  | global_percentage, per_app_percentage |
| `GET /wham/usage/credit-usage-events` |  |  |
| `POST /wham/usage/credits/estimate` |  | credits |
| `GET /wham/usage/daily-token-usage-breakdown` | end_date, group_by, start_date |  |
| `GET /wham/usage/daily-workspace-user-credit-usage` | ...spread, breakdown, end_date, start_date |  |
| `GET /wham/usage/daily-workspace-user-token-usage-breakdown` | breakdown_by, end_date, group_by, modes, start_date |  |
| `GET /wham/usage/plan_limit_balance_history` | cursor, window_minutes |  |
| `GET /wham/usage/plan_limit_history` | days |  |
| `POST /wham/usage/thread_usage/query` | include_credits_availability | thread_ids |
| `POST /wham/usage/thread_usage/query_v2` |  | threads |
| `GET /wham/work/settings` |  |  |
| `PATCH /wham/work/settings` |  | expected_revision, settings |
| `GET /wham/workspace-messages` |  |  |

### `widget_server_action` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /widget_server_action` |  | ...spread, action_type, conversation_id, message_id, native_widget_resolution_id, payload, ref_id |
| `POST /widget_server_action/public` |  | action_type, payload, public_action_context, ref_id |

### `workspace-invite-link` (2)

| Call | query | body |
| --- | --- | --- |
| `POST /workspace-invite-link/accept` |  |  |
| `POST /workspace-invite-link/request-seat` |  |  |

### `workspace-resources` (1)

| Call | query | body |
| --- | --- | --- |
| `GET /workspace-resources/{account_id}/gizmos` | categories, limit, query_continuation, user_ids |  |

### `writing-blocks` (1)

| Call | query | body |
| --- | --- | --- |
| `POST /writing-blocks/page` |  | conversation_id, id, index, message_id, writing_block |

## How to refresh this file

1. **Live shapes.** From a signed-in tab, run one `fetch` per endpoint with the bearer token
   from `/api/auth/session`, a pause of about one second between calls, and record key names and
   types only. Never record values of ids, titles, tokens or text.
2. **Page traffic.** In the tab, read `performance.getEntriesByType('resource')` and group the
   names by path shape. This lists the routes the page itself calls and the status codes and
   transfer sizes it saw. It makes no API request.
3. **Bundles.** Fetch the page HTML (`GET /`), read the `/cdn/assets/*.js` names it lists, and
   download them. The runtime chunk holds a map of lazy chunk ids to hashes; fetch each as
   `/cdn/assets/async/<id>.<hash>.js`. Extract `.safe(Get|Post|Put|Patch|Delete)("/path", {…})`
   call sites, cut each at its closing parenthesis, and list `parameters.query` and `requestBody` keys.
4. **Conversation body.** Aggregate key paths and the value sets of enum-like keys over archived
   bodies (`chatgpt-web-export` stores them under its library root).
5. Update the snapshot date and every status code you re-observed.
