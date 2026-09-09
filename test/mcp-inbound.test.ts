import { describe, expect, it } from 'vitest';
import {
  connectorSessionFromHeader,
  inboundConnectorSession,
  inboundRequestId,
  requestIdFromHeader,
  withInboundIdentity,
  withInboundRequestId
} from '../src/main/mcp/inbound.js';

describe('MCP inbound request id boundary', () => {
  it('normalizes the raw x-request-id to the page join key once at ingress', () => {
    expect(requestIdFromHeader('wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1')).toBe(
      'wfr_01a014bdd7cd7a15b6b533d3ce2b42f2'
    );
    expect(requestIdFromHeader('  wfr_abc_123/relay-hop')).toBe('wfr_abc_123');
    expect(requestIdFromHeader(['wfr_only/a'])).toBe('wfr_only');
    expect(requestIdFromHeader(['wfr_first/a', 'wfr_second/b'])).toBeNull();

    expect(requestIdFromHeader('/missing-base')).toBeNull();
    expect(requestIdFromHeader('wfr.bad/suffix')).toBeNull();
    expect(requestIdFromHeader('x'.repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it('keeps normalized ids isolated across concurrent async requests', async () => {
    const seen = await Promise.all([
      withInboundRequestId('wfr_a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inboundRequestId();
      }),
      withInboundRequestId('wfr_b', async () => {
        await Promise.resolve();
        return inboundRequestId();
      })
    ]);

    expect(seen).toEqual(['wfr_a', 'wfr_b']);
    expect(inboundRequestId()).toBeNull();
  });
});

describe('MCP inbound connector session boundary', () => {
  /**
   * Measured live on 2026-09-09 after the connector-platform migration: tools/call arrives
   * with NO x-request-id at all, and the only per-conversation identity on the wire is the
   * `x-openai-session` header (mirrored in params._meta["openai/session"]), an opaque
   * `v1/<base62>` token that was distinct across three concurrently executing worker chats
   * and stable across each worker's own calls. It never matches page evidence directly, so
   * it is a session key for the degraded attribution tiers — not a request-id join.
   */
  it('normalizes the x-openai-session header to an opaque session key at ingress', () => {
    const live = 'v1/2WxZ4WCHyEoXhhPTurudVauILFfqZawr3uznsDomLmgqvR8cdZ4ubzbwajJDTubdTa5Xw5Sfkk2l';
    expect(connectorSessionFromHeader(live)).toBe(live);
    expect(connectorSessionFromHeader(`  ${live}  `)).toBe(live);
    expect(connectorSessionFromHeader([live])).toBe(live);

    // Identity evidence is not a "pick one" field; duplicates fail closed like x-request-id.
    expect(connectorSessionFromHeader([live, 'v1/otherKeyOfPlausibleLength123'])).toBeNull();
    expect(connectorSessionFromHeader('')).toBeNull();
    expect(connectorSessionFromHeader('short')).toBeNull();
    expect(connectorSessionFromHeader('has spaces inside the value')).toBeNull();
    expect(connectorSessionFromHeader('x'.repeat(301))).toBeNull();
    expect(connectorSessionFromHeader(undefined)).toBeNull();
  });

  it('carries the session key beside the request id and keeps them isolated per request', async () => {
    const seen = await Promise.all([
      withInboundIdentity({ requestId: 'wfr_a', sessionKey: 'v1/sessionKeyAlpha' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [inboundRequestId(), inboundConnectorSession()];
      }),
      withInboundIdentity({ requestId: null, sessionKey: 'v1/sessionKeyBravo' }, async () => {
        await Promise.resolve();
        return [inboundRequestId(), inboundConnectorSession()];
      })
    ]);

    expect(seen).toEqual([
      ['wfr_a', 'v1/sessionKeyAlpha'],
      [null, 'v1/sessionKeyBravo']
    ]);
    expect(inboundConnectorSession()).toBeNull();
  });
});
