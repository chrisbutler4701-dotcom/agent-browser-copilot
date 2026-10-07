# 🌐 Agent Browser Copilot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node: >=18.0.0](https://img.shields.io/badge/Node-%3E=18.0.0-green.svg)](https://nodejs.org)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest_V3-red.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Telegram Mini App](https://img.shields.io/badge/Telegram-Mini_App-2CA5E0.svg)](https://core.telegram.org/bots/webapps)

> **Complete, self-hostable browser copilot suite for AI agents (Hermes, OpenClaw, Claude, & custom LLMs).**
> Enables any agent to inspect, read, and drive web browsers with zero local daemon dependencies on the workstation, complete with a live **Telegram Mini App (TMA)** mobile preview.

---

## ⚡ 1-Command Universal Install

Run this command on your Linux server, VPS, or Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/chrisbutler4701-dotcom/agent-browser-copilot/main/install.sh | bash
```

The installer will:
1. Validate your runtime environment (Node >= 18).
2. Clone the repository and install dependencies.
3. Launch the **interactive setup wizard** to configure your domain, Telegram Bot, and agent type.
4. Auto-configure the Chrome extension template with your broker URL and CSP rules.
5. Run the **System Doctor** to verify end-to-end health.

---

## 📦 What's Inside the Suite

```
agent-browser-copilot/
├── bin/
│   ├── copilot           # Master CLI runner (setup, doctor, start, status, pair)
│   └── doctor.js         # Comprehensive health audit engine
├── setup.js              # Interactive configuration wizard
├── install.sh            # 1-command installer script
├── broker/               # Work Edge Broker & WebSocket relay
│   └── server.js         # MCP server, WebSocket gateway, & TMA backend
├── tma-preview/          # Telegram Mini App (TMA) & Web Preview
│   └── public/           # Live screen stage, DOM text, & element inspector
├── telegram-bot/         # Telegram Bot bridge daemon
│   └── bot.js            # Auto menu button, commands (/preview, /status, /pair)
├── extension/            # Unpacked Chrome MV3 Extension
│   ├── manifest.json     # Pre-configured permissions & CSP
│   ├── service-worker.js # Durable relay with resilient active-tab fallback
│   ├── sidepanel.html    # In-browser chat & pairing interface
│   └── icons/            # High-res icons (16, 32, 48, 128)
├── systemd/              # Production systemd service unit
├── docker-compose.yml    # Containerized Docker deployment
└── Dockerfile
```

---

## 🚀 Quickstart (Manual Setup)

If you prefer manual setup:

```bash
# 1. Clone repository
git clone https://github.com/chrisbutler4701-dotcom/agent-browser-copilot.git
cd agent-browser-copilot

# 2. Install dependencies
npm install

# 3. Run interactive configuration wizard
node setup.js

# 4. Verify system health
node bin/doctor.js

# 5. Start broker & bot services
node bin/copilot start
```

---

## 🧩 Loading the Chrome Extension

1. Open **Google Chrome** on your computer.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** (top-left).
5. Select the `extension/` directory from this repository.
6. Click the extension icon in Chrome toolbar to open the **Side Panel** and complete pairing.

---

## 🩺 System Doctor (`copilot doctor`)

The built-in doctor audits your environment, network, extension, and bot connectivity:

```bash
copilot doctor
```

Output:
```
======================================================
🩺 AGENT BROWSER COPILOT — SYSTEM DOCTOR
   Auditing runtime, security, extension, & bot health
======================================================

  ✔ PASS  Node.js Environment
         v22.0.0 (Modern ES modules, fetch & WebSockets supported)
  ✔ PASS  Configuration (config.json)
         Valid JSON found with port 8766
  ✔ PASS  Chrome Extension Template
         Manifest v3, Version 0.4.0 ready for Chrome
  ✔ PASS  Broker Server (Port 8766)
         HTTP 200 OK — Active Tab: "Home | Hostinger"
  ✔ PASS  Telegram Mini App (TMA) Preview
         Serving HTML, CSS, & WebApp JS on /preview/
  ✔ PASS  Telegram Bot Connectivity
         @YourCopilotBot (Browser Copilot) authenticated
  ✔ PASS  Telegram Menu Button
         Mapped to TMA WebApp: https://your-domain.com/preview/
  ✔ PASS  Paired Browsers
         1 browser(s) registered in database

------------------------------------------------------
Audit Summary: 8 Passed, 0 Warnings, 0 Failed
------------------------------------------------------
✨ All systems operational and ready for live agent workflows!
```

---

## 📱 Telegram Bot Commands

| Command | Description |
|---|---|
| `/preview` | Launch the live browser Telegram Mini App (TMA) |
| `/status` | View connection state, active tab title, and current URL |
| `/pair <code>` | Complete pairing with the Chrome extension |
| `/newcode` | Generate a 6-character one-time pairing code |
| `/help` | List available commands |

---

## 🤖 Agent Integration (MCP)

This suite exposes a standard **Model Context Protocol (MCP)** JSON-RPC endpoint at:
`http://127.0.0.1:8766/work-edge/mcp`

### Connecting to Hermes Agent
Add the tool server to your profile in `hermes.yaml` or `.hermes/profiles/default/config.yaml`:

```yaml
tools:
  mcp_servers:
    work_edge:
      url: "http://127.0.0.1:8766/work-edge/mcp"
      headers:
        Authorization: "Bearer YOUR_MCP_TOKEN"
```

### Available MCP Tools

- `edge_status`: Get browser connection and active tab metadata.
- `edge_active_tab`: Read tab title, URL, and capture state.
- `edge_snapshot`: Extract clean text content of the active web page.
- `edge_find_elements`: Locate interactive buttons, links, and forms.
- `edge_screenshot`: Capture a full visible PNG viewport screenshot.
- `edge_navigate`: Direct the browser to a new URL.
- `edge_click`: Click buttons or links by CSS selector.

---

## 🛡️ Security Architecture

- **Zero Local Workstation Daemons**: The Chrome extension communicates directly via secure WebSockets to your broker. No Python, Node, or background servers run on the client machine.
- **Sensitive Origin Guard**: Automatically restricts extraction on login, banking, and MFA pages until approved by the user.
- **Dual-Token Authentication**: Separate bearer tokens for browser pairing, agent MCP calls, and TMA view streams.

---

## 📄 License

MIT License. Free for personal, commercial, and enterprise deployment.
