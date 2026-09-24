/**
 * Headless server entrypoint for running Chat On Steroids as a standalone daemon.
 *
 * Runs the core MCP server and Cloudflare tunnel without any Electron UI, display server,
 * or browser dependencies.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  effectiveCapabilities,
  getConfig,
  initConfigPath,
  loadConfig,
  updateConfig
} from './config.js';
import { startMcpServer, tunnelProbeHeaders, type McpEndpoint } from './mcp/server.js';
import { startTunnel, type TunnelHandle } from './tunnel/index.js';
import { initSessionStore } from './session/store.js';
import { restoreRequestCorrelations } from './session/correlation.js';
import { initDurableStore } from './durable.js';
import { APP_VERSION } from './version.js';
import { setBrowserCloser, setBrowserOpener, shutdownBridge, startBridge } from './bridge.js';
import { restoreSleepWake, setSleepWakeDriver, sleepWakeSettings } from './session/sleep-wake.js';
import { stopExecReaper } from './exec-reaper.js';
import { unifiedExecManager } from './codex/manager.js';
import { enableHeadlessSecretStore, initSecretsPath } from './secrets.js';
import { enableConsoleFailureEcho } from './logger.js';

async function main(): Promise<void> {
  // The daemon has no diagnostics panel, so the in-memory log is unreadable in production.
  // Echo error/warn records to stderr unconditionally so the systemd journal captures them;
  // without this the 2026-09 attribution alarm "fired" into a buffer nobody could see.
  enableConsoleFailureEcho();
  console.log(`Starting Chat On Steroids v${APP_VERSION} (Headless Daemon)...`);

  const userDataDir = process.env.COS_DATA_DIR || path.join(os.homedir(), '.config', 'chat-on-steroids');
  await fs.mkdir(userDataDir, { recursive: true });

  initConfigPath(userDataDir);
  initSecretsPath(userDataDir);
  enableHeadlessSecretStore();
  initSessionStore(userDataDir);
  initDurableStore(userDataDir);

  if (!process.env.COS_TOKEN) {
    const tokenFile = path.join(userDataDir, 'token');
    try {
      const stored = (await fs.readFile(tokenFile, 'utf8')).trim();
      if (stored) process.env.COS_TOKEN = stored;
    } catch {
      /* token file optional */
    }
  }

  await loadConfig();

  // Request ownership must exist before either the MCP server or the bridge can race in —
  // the same startup contract the desktop entrypoint honors (see index.ts). Skipping this
  // left the in-memory registry empty after every daemon restart, and because the durable
  // snapshot is overwritten wholesale on the next live observation, it also destroyed every
  // previously proven owner on disk.
  await restoreRequestCorrelations();

  const currentConfig = getConfig();
  if (currentConfig.roots.length === 0) {
    const defaultRoot = process.env.COS_ROOT || os.homedir();
    console.log(`Configuring default approved root: ${defaultRoot}`);
    await updateConfig((latest) => ({
      ...latest,
      roots: [{ name: 'home', path: defaultRoot }],
      tunnel: {
        ...latest.tunnel,
        kind: 'cloudflared'
      }
    }));
  }

  const liveConfig = getConfig();
  console.log('Approved roots:', liveConfig.roots.map((r) => `${r.name} -> ${r.path}`).join(', '));
  console.log('Tunnel provider:', liveConfig.tunnel.kind);

  console.log('Starting local MCP server...');
  const endpoint: McpEndpoint = await startMcpServer(() => {
    const live = getConfig();
    return {
      roots: live.roots,
      caps: effectiveCapabilities(live),
      readOnly: live.readOnly,
      privacyScreenshots: false
    };
  });

  console.log(`Local MCP endpoint listening on port ${endpoint.port}`);

  let tunnelHandle: TunnelHandle | null = null;
  const externalBaseUrl = process.env.COS_EXTERNAL_URL?.replace(/\/+$/, '');

  if (externalBaseUrl) {
    const local = new URL(endpoint.url);
    const publicUrl = `${externalBaseUrl}${local.pathname}`;
    console.log('\n======================================================');
    console.log('Chat On Steroids Headless MCP Server is LIVE!');
    console.log('Public MCP URL for ChatGPT:');
    console.log(publicUrl);
    console.log('======================================================\n');
  } else {
    console.log('Starting Cloudflare tunnel...');
    try {
      tunnelHandle = await startTunnel({
        localUrl: endpoint.url,
        settings: liveConfig.tunnel,
        apiKey: null,
        discoveryHeaders: tunnelProbeHeaders(),
        label: 'core',
        report: (report) => {
          if (report.publicUrl) {
            console.log('\n======================================================');
            console.log('Chat On Steroids Headless MCP Server is LIVE!');
            console.log('Public MCP URL for ChatGPT:');
            console.log(report.publicUrl);
            console.log('======================================================\n');
          }
          if (report.detail) {
            console.log(`[Tunnel] ${report.state}: ${report.detail}`);
          }
        }
      });
    } catch (err) {
      console.error('Failed to start tunnel:', err);
      await endpoint.stop();
      process.exit(1);
    }
  }

  // Configure browser opener for headless environments via Chrome DevTools Protocol
  setBrowserOpener(async (url: string) => {
    const devtoolsPort = process.env.CHROME_DEVTOOLS_PORT || '9222';
    try {
      const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT'
      });
      if (!res.ok) {
        console.warn(`Failed to open URL in headless browser via CDP: ${res.statusText}`);
      }
    } catch (err) {
      console.warn(`CDP opener failed on port ${devtoolsPort}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // The tab an expired command was opened in. The marker is unique per command, so matching
  // on it can only ever reach the tab the opener above created for that command.
  setBrowserCloser(async (url: string) => {
    const devtoolsPort = process.env.CHROME_DEVTOOLS_PORT || '9222';
    const marker = new URL(url).searchParams.get('clf');
    if (!marker) throw new Error(`no command marker in ${url}`);
    const listed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
    if (!listed.ok) throw new Error(`CDP /json/list answered ${listed.status} ${listed.statusText}`);
    const targets = (await listed.json()) as Array<{ id?: string; type?: string; url?: string }>;
    for (const target of targets) {
      if (target.type !== 'page' || !target.id || typeof target.url !== 'string') continue;
      let carries = false;
      try {
        const opened = new URL(target.url);
        carries = opened.searchParams.get('clf') === marker || opened.hash === `#clf=${encodeURIComponent(marker)}`;
      } catch {
        continue;
      }
      if (!carries) continue;
      const closed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/close/${target.id}`);
      if (!closed.ok) throw new Error(`CDP /json/close answered ${closed.status} ${closed.statusText}`);
    }
  });

  // The sleep/wake tab driver, over the same CDP HTTP endpoint. Unlike the opener above it
  // throws on failure on purpose: sleep-wake.ts treats a failed close/open as the loud
  // abort of that sleep or wake, never as something to paper over. /json/new is PUT-only on
  // current Chrome, and /json/close/<id> is the HTTP form of Target.closeTarget.
  setSleepWakeDriver({
    openConversationTab: async (
      conversationId: string,
      options?: { remountExisting?: boolean },
    ) => {
      const devtoolsPort = process.env.CHROME_DEVTOOLS_PORT || '9222';
      const url = `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
      const listed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
      if (!listed.ok) throw new Error(`CDP /json/list answered ${listed.status} ${listed.statusText}`);
      const targets = (await listed.json()) as Array<{ id?: string; type?: string; url?: string }>;
      const existing = targets.find(
        (target) =>
          target.type === 'page' &&
          typeof target.url === 'string' &&
          target.url.includes(`/c/${conversationId}`)
      );
      if (existing && !options?.remountExisting) return;
      if (existing?.id) {
        const closed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/close/${existing.id}`);
        if (!closed.ok) throw new Error(`CDP /json/close answered ${closed.status} ${closed.statusText}`);
      }
      const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT'
      });
      if (!res.ok) throw new Error(`CDP /json/new answered ${res.status} ${res.statusText}`);
    },
    closeConversationTab: async (conversationId: string) => {
      const devtoolsPort = process.env.CHROME_DEVTOOLS_PORT || '9222';
      const listed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
      if (!listed.ok) throw new Error(`CDP /json/list answered ${listed.status} ${listed.statusText}`);
      const targets = (await listed.json()) as Array<{ id?: string; type?: string; url?: string }>;
      const tab = targets.find(
        (target) =>
          target.type === 'page' && typeof target.url === 'string' && target.url.includes(`/c/${conversationId}`)
      );
      if (!tab?.id) throw new Error('no open tab is showing that conversation');
      const closed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/close/${tab.id}`);
      if (!closed.ok) throw new Error(`CDP /json/close answered ${closed.status} ${closed.statusText}`);
    }
  });
  // Slept conversations survive a daemon restart as durable state; restore them (keyless,
  // on the fallback timer) before the bridge starts refusing or accepting pushes for them.
  await restoreSleepWake();
  if (sleepWakeSettings().enabled) {
    console.log('Sleep/wake tab architecture is ENABLED (sleepWake.enabled in config.json).');
  }

  const bridgePort = await startBridge();
  if (bridgePort) {
    console.log(`Local bridge listening on port ${bridgePort}`);
  }

  async function shutdown(): Promise<void> {
    console.log('\nShutting down headless daemon...');
    await shutdownBridge().catch(() => {});
    if (tunnelHandle) {
      await tunnelHandle.stop().catch(() => {});
    }
    await endpoint.stop().catch(() => {});
    // Same phase order as the desktop teardown (index.ts): only after the listeners have
    // stopped admitting work may the request handlers' owned child processes go. Exiting
    // without this left every live exec session — shells, servers, watchers — running
    // until cgroup teardown happened to clear them, the exact accumulation recorded in
    // docs/exec-orphan-audit-2026-09-09.md.
    stopExecReaper();
    await unifiedExecManager.terminateAllProcesses().catch((err) => {
      console.warn(
        `Failed to terminate exec sessions during shutdown: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    console.log('Shutdown complete.');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error('Fatal error in headless daemon:', err);
  process.exit(1);
});
