# Migration to Remote Headless Server (`dzack@rack`)

This document records the architecture, configuration, and operation of the headless Chat On Steroids deployment on `dzack@rack`.

---

## 1. Architecture Overview

```text
 [ ChatGPT Cloud (OpenAI) ]
             │
             │ HTTPS (MCP JSON-RPC)
             ▼
 [ Cloudflare Edge Network ]
   (cos-rack.dzackgarza.com)
             │
             │ Cloudflare Tunnel (quic)
             ▼
 [ Server: dzack@rack ]
   ┌─────────────────────────────────────────────────────────┐
   │ chat-on-steroids-tunnel.service (cloudflared)           │
   │   └─ Proxies to http://127.0.0.1:4050                   │
   │                                                         │
   │ chat-on-steroids.service (Node daemon)                  │
   │   ├─ Entrypoint: src/main/headless.ts                   │
   │   ├─ Port: 127.0.0.1:4050                               │
   │   ├─ Token: ~/.config/chat-on-steroids/token            │
   │   └─ Root: /home/dzack (mapped to virtual path /home)   │
   └─────────────────────────────────────────────────────────┘
```

- **Zero Desktop Dependency:** Runs completely headlessly without Electron UI, X11, or virtual framebuffers (`xvfb`).
- **No Headless Browser:** OpenAI communicates directly with the server via the Model Context Protocol over HTTPS. No automated browser automation is used, eliminating Cloudflare bot detection and Turnstile challenges.

---

## 2. ChatGPT Connector Configuration

To connect ChatGPT to the server:

1. Open ChatGPT Settings.
2. Navigate to **Connected Apps** / **Custom MCP Connectors**.
3. Add the following URL:

```text
https://cos-rack.dzackgarza.com/mcp/core/rQbhNvIy2Hn6GjOBsBPm2tOAYKTk5i42xmfnmMQpHJg
```

---

## 3. Server Configuration & Files

### A. Persistent State & Secrets

- **Configuration:** `~/.config/chat-on-steroids/config.json`
- **Bearer Path Token:** `~/.config/chat-on-steroids/token`
  - Value: `rQbhNvIy2Hn6GjOBsBPm2tOAYKTk5i42xmfnmMQpHJg`
  - Preserved across service restarts so the ChatGPT endpoint URL never changes.

### B. Daemon Service (`chat-on-steroids.service`)

Located at `~/.config/systemd/user/chat-on-steroids.service`:

```ini
[Unit]
Description=Chat On Steroids Headless MCP Server
After=network-online.target cloudflared-rack.service
Wants=network-online.target cloudflared-rack.service

[Service]
Type=simple
WorkingDirectory=/home/dzack/gitclones/chat-on-steroids
Environment=HOME=/home/dzack
Environment=NODE_ENV=production
Environment=COS_PORT=4050
Environment=COS_EXTERNAL_URL=https://cos-rack.dzackgarza.com
Environment=PATH=/home/dzack/.nvm/versions/node/v25.6.1/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/dzack/.nvm/versions/node/v25.6.1/bin/node /home/dzack/gitclones/chat-on-steroids/node_modules/tsx/dist/cli.mjs src/main/headless.ts
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

### C. Tunnel Configuration & Service (`chat-on-steroids-tunnel.service`)

- **Tunnel Config:** `~/.cloudflared/cos-tunnel.yml`:
  ```yaml
  tunnel: 320f1db6-16bb-458c-b889-6ffe9046045b
  credentials-file: /home/dzack/.cloudflared/320f1db6-16bb-458c-b889-6ffe9046045b.json

  ingress:
    - hostname: cos-rack.dzackgarza.com
      service: http://127.0.0.1:4050
      originRequest:
        httpHostHeader: localhost
    - service: http_status:404
  ```

- **Tunnel Service:** `~/.config/systemd/user/chat-on-steroids-tunnel.service`:
  ```ini
  [Unit]
  Description=Cloudflare tunnel for Chat On Steroids (cos-rack.dzackgarza.com)
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  ExecStart=/usr/local/bin/cloudflared tunnel --config /home/dzack/.cloudflared/cos-tunnel.yml run
  Restart=on-failure
  RestartSec=5
  Environment=HOME=/home/dzack

  [Install]
  WantedBy=default.target
  ```

---

## 4. Operational Management

### Service Commands

```bash
# Check server status
systemctl --user status chat-on-steroids.service

# View live server logs
journalctl --user -u chat-on-steroids.service -f

# Restart server
systemctl --user restart chat-on-steroids.service

# Check tunnel status
systemctl --user status chat-on-steroids-tunnel.service

# Restart tunnel
systemctl --user restart chat-on-steroids-tunnel.service
```

### Verification Command

Test the live endpoint from any machine:

```bash
curl -i -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  https://cos-rack.dzackgarza.com/mcp/core/rQbhNvIy2Hn6GjOBsBPm2tOAYKTk5i42xmfnmMQpHJg
```

---

## 5. Tool Capabilities and Path Mapping

- **Approved Root:** `/home/dzack` is mounted as `/home`.
- **Paths in ChatGPT:**
  - Files under `/home/dzack/...` are addressed as `/home/...`.
  - For example: `/home/gitclones/chat-on-steroids/package.json`.
- **Available Tools:**
  - `read`: Read files and list directory contents.
  - `apply_patch`: Atomic multi-file creation, patching, and deletion.
  - `exec_command`: Run commands in bash/zsh with persistent session support.
  - `write_stdin`: Interactive stdin for long-running processes.
  - `view_image`: Image inspection.

---

## 6. Headless Shepherding & Browser Service

For autonomous shepherding (`just say`, `just new`, worker agent management) without a desktop client, `rack` runs a headless Chromium instance with the extension under `xvfb-run`.

### Architecture

```text
 [ CLI: just say / just new ]
              │
              │ HTTP POST /send
              ▼
   [ bridge.ts (port 8765) ]
              │
              │ PUT /json/new?https://chatgpt.com/?clf=<id>
              ▼
 [ Headless Chrome (CDP port 9222) ]
   (chat-on-steroids-browser.service)
              │
              │ Extension content.js injects into DOM
              ▼
     [ #prompt-textarea ] ──(Click Send)──► [ ChatGPT Backend ]
```

### Browser Service (`chat-on-steroids-browser.service`)

Located at `~/.config/systemd/user/chat-on-steroids-browser.service`:

```ini
[Unit]
Description=Chat On Steroids Headless Chrome Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/dzack
Environment=HOME=/home/dzack
ExecStart=/usr/bin/xvfb-run -a /home/dzack/.local/share/browsers/chrome/linux-152.0.7977.82/chrome-linux64/chrome --no-sandbox --disable-setuid-sandbox --remote-debugging-port=9222 --user-data-dir=/home/dzack/.config/chrome-cos --load-extension=/home/dzack/gitclones/chat-on-steroids/extension --disable-gpu --no-first-run https://chatgpt.com/
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### Shepherding Operations on Rack

```bash
# List recent chats
just chats 24

# Send a follow-up message to an existing conversation
just say <conversationId> "<prompt>"

# Start a fresh conversation
just new "<opening prompt>"

# Inspect browser service
systemctl --user status chat-on-steroids-browser.service
```
