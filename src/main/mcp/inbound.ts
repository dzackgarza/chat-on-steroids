import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The identity material on the HTTP request that carries a tool call.
 *
 * Two generations of connector platform, both measured live:
 *
 * Until 2026-09 the request arrived with `x-request-id: wfr_<id>/<suffix>`, and the same
 * `wfr_<id>` is what the page's own message model holds as `metadata.request_id` on the
 * request behind the call. That makes it a deterministic join between a call and the
 * conversation that issued it — no window, no ordering, and no coin toss when two workers
 * call the same tool at the same moment.
 *
 * Since the 2026-09 platform migration (captured live 2026-09-09 from real traffic on the
 * rack) the request carries NO `x-request-id` at all, and the page-side request UUIDs appear
 * nowhere in the request. What does arrive is one opaque `x-openai-session` header
 * (mirrored in `params._meta["openai/session"]`), observed distinct across concurrently
 * generating worker chats and stable across each worker's own calls. It never matches page
 * evidence directly, so it is a *session key* for the degraded attribution tiers, not a
 * request-id join. Both are read here so ingress stays the single parser for either shape.
 *
 * They have to be carried out of band because the MCP server's own call context does not
 * expose the request headers: live, `mcpCtx.http.headers` is null while the headers are
 * plainly there on the socket. So the surface's request handler runs inside this store and
 * the tool dispatch reads them back.
 */
export interface InboundIdentity {
  /** Normalized exact page-join key, when the transport still sends one. */
  requestId: string | null;
  /** Opaque connector session key, when the transport sends one. */
  sessionKey: string | null;
}

const store = new AsyncLocalStorage<InboundIdentity>();

/** Runs `body` with the identity of the HTTP request currently being served. */
export function withInboundIdentity<T>(identity: InboundIdentity, body: () => T): T {
  return store.run(identity, body);
}

/** Back-compat wrapper for callers/tests that only carry the exact join key. */
export function withInboundRequestId<T>(requestId: string | null, body: () => T): T {
  return withInboundIdentity({ requestId, sessionKey: null }, body);
}

/** The request id of the HTTP request this call is being served on, if it had one. */
export function inboundRequestId(): string | null {
  return store.getStore()?.requestId ?? null;
}

/** Distinguishes missing request context from a header that parsed to null. */
export function hasInboundIdentity(): boolean {
  return store.getStore() !== undefined;
}

/** The connector session key of the HTTP request this call is being served on, if any. */
export function inboundConnectorSession(): string | null {
  return store.getStore()?.sessionKey ?? null;
}

/**
 * The join key inside a raw header value.
 *
 * Only the part before the `/` matches the page: the suffix is per-hop and differs between
 * the header and the message model.
 */
export function requestIdFromHeader(value: string | string[] | undefined): string | null {
  // Identity evidence is not a "pick one" field. If a proxy/runtime ever gives us duplicate
  // request-id values, choosing the first would turn an ambiguous request into authority for
  // one conversation. Fail closed instead. (A one-element array is only a representation
  // detail and is still unambiguous.)
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const id = raw.split('/')[0]!.trim();
  return id.length > 0 && id.length <= 100 && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}

/**
 * The opaque connector session key inside a raw `x-openai-session` header value.
 *
 * Deliberately opaque: the observed shape is `v1/<base62>`, but OpenAI owns that format and
 * may change it, so only fail-closed representation checks apply — printable, no spaces,
 * bounded length, exactly one value. Unlike the request id the `/` is part of the key, so
 * nothing is split off.
 */
export function connectorSessionFromHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key.length >= 8 && key.length <= 300 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}
