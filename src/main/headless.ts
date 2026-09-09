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
import { initDurableStore } from './durable.js';
import { APP_VERSION } from './version.js';
import { setBrowserOpener, shutdownBridge, startBridge } from './bridge.js';
import { enableHeadlessSecretStore, initSecretsPath } from './secrets.js';

async function main(): Promise<void> {
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
