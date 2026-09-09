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

---

## 7. ChatGPT Session Resync Workflow

When ChatGPT login expires on the remote server, synchronize the session from the local authenticated browser using Chrome DevTools Protocol (CDP).

### Prerequisites

- Local Chrome running with `--remote-debugging-port=9222` and logged into `https://chatgpt.com/`.
- Remote Chrome running on `rack` via `chat-on-steroids-browser.service` with CDP on port `9222`.
- `websocat` available on both hosts (`~/.local/bin/websocat`).

### Step 1: Extract Session from Local Chrome

Run the extraction script on the local machine:

```python
import json, subprocess, os, stat

# 1. Connect to local Chrome CDP
targets = json.loads(subprocess.run(["curl", "-s", "http://127.0.0.1:9222/json"], capture_output=True, text=True).stdout)
target = next(t for t in targets if t.get("type") == "page" and "chatgpt.com" in t.get("url", ""))
ws = target["webSocketDebuggerUrl"]

# 2. Extract cookies
payload_cookies = json.dumps({"id": 1, "method": "Network.getCookies", "params": {"urls": ["https://chatgpt.com"]}})
raw_cookies = subprocess.run(["timeout", "5", "websocat", "-n1", ws], input=payload_cookies, capture_output=True, text=True).stdout
cookies_list = json.loads(raw_cookies)["result"]["cookies"]
cookies = {c["name"]: c["value"] for c in cookies_list}

# 3. Extract access token from active page
expr = "fetch(\"/api/auth/session\").then(r => r.json())"
payload_session = json.dumps({"id": 2, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}})
raw_session = subprocess.run(["timeout", "5", "websocat", "-n1", ws], input=payload_session, capture_output=True, text=True).stdout
session = json.loads(raw_session)["result"]["result"]["value"]

creds = {
    "accessToken": session.get("accessToken"),
    "accountId": session.get("account", {}).get("id"),
    "expires": session.get("expires"),
    "cookies": cookies
}

# 4. Save to local config file
path = os.path.expanduser("~/.config/chat-on-steroids/chatgpt-session.json")
with open(path, "w") as f:
    json.dump(creds, f, indent=2)
os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
print(f"Extracted session for {session.get('user', {}).get('email')}, expires: {creds['expires']}")
```

### Step 2: Copy Session File to Rack

Transfer the credential file securely:

```bash
scp ~/.config/chat-on-steroids/chatgpt-session.json dzack@rack:~/.config/chat-on-steroids/chatgpt-session.json
ssh dzack@rack "chmod 600 ~/.config/chat-on-steroids/chatgpt-session.json"
```

### Step 3: Inject Cookies into Remote Headless Chrome

Execute the injection script on `rack` to apply cookies via CDP and navigate to ChatGPT:

```bash
ssh dzack@rack "/usr/bin/python3 -c '
import json, subprocess, urllib.request

with open(\"/home/dzack/.config/chat-on-steroids/chatgpt-session.json\") as f:
    creds = json.load(f)

targets = json.loads(urllib.request.urlopen(\"http://127.0.0.1:9222/json\").read())
page = next(t for t in targets if t.get(\"type\") == \"page\" and \"chatgpt.com\" in t.get(\"url\", \"\"))
ws_url = page[\"webSocketDebuggerUrl\"]

cookies_list = []
for name, val in creds.get(\"cookies\", {}).items():
    cookies_list.append({
        \"name\": name,
        \"value\": val,
        \"url\": \"https://chatgpt.com\"
    })

# Set cookies
payload1 = json.dumps({\"id\": 1, \"method\": \"Network.setCookies\", \"params\": {\"cookies\": cookies_list}})
subprocess.run([\"timeout\", \"5\", \"/home/dzack/.local/bin/websocat\", \"-n1\", ws_url], input=payload1, capture_output=True, text=True)

# Reload page to apply session
payload2 = json.dumps({\"id\": 2, \"method\": \"Page.navigate\", \"params\": {\"url\": \"https://chatgpt.com/\"}})
subprocess.run([\"timeout\", \"5\", \"/home/dzack/.local/bin/websocat\", \"-n1\", ws_url], input=payload2, capture_output=True, text=True)
print(\"Injected cookies and reloaded remote page.\")
'"
```

### Step 4: Verify Remote Authentication

Verify authentication on `rack`:

```bash
ssh dzack@rack "/usr/bin/python3 -c '
import json, subprocess, urllib.request, time

time.sleep(3)
targets = json.loads(urllib.request.urlopen(\"http://127.0.0.1:9222/json\").read())
page = next(t for t in targets if t.get(\"type\") == \"page\" and \"chatgpt.com\" in t.get(\"url\", \"\"))
ws_url = page[\"webSocketDebuggerUrl\"]

expr = \"fetch(\\\"/api/auth/session\\\").then(r => r.json()).then(s => ({ email: s?.user?.email, hasToken: !!s?.accessToken, expires: s?.expires }))\"
payload = json.dumps({\"id\": 1, \"method\": \"Runtime.evaluate\", \"params\": {\"expression\": expr, \"awaitPromise\": True, \"returnByValue\": True}})
res = subprocess.run([\"timeout\", \"8\", \"/home/dzack/.local/bin/websocat\", \"-n1\", ws_url], input=payload, capture_output=True, text=True).stdout
print(\"Remote auth state:\", res)
'"
```

Successful output indicates `hasToken: true` with the authenticated email address.

