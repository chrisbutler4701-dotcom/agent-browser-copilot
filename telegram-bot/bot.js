import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const configPath = path.join(ROOT_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('❌ config.json not found. Run "copilot setup" first.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const BOT_TOKEN = config?.telegram?.botToken;
const BROKER_URL = `http://127.0.0.1:${config?.server?.port || 8766}`;
const PUBLIC_PREVIEW_URL = config?.server?.previewUrl || `${config?.server?.publicUrl || 'http://localhost:8766'}/preview/`;
const ALLOWED_USERS = (config?.telegram?.allowedUserIds || []).map(Number);

if (!BOT_TOKEN) {
  console.error('❌ Telegram Bot Token is missing in config.json.');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgApi(method, payload = {}) {
  try {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Configure Menu Button and Bot Commands
async function initTelegramBot() {
  console.log('🤖 Initializing Telegram Bot...');
  const me = await tgApi('getMe');
  if (!me.ok) {
    console.error('❌ Invalid Telegram Bot Token:', me.description);
    process.exit(1);
  }
  console.log(`✅ Logged in as @${me.result.username} (${me.result.first_name})`);

  // Set Chat Menu Button to WebApp
  const menuRes = await tgApi('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🌐 Browser Preview',
      web_app: { url: PUBLIC_PREVIEW_URL }
    }
  });
  if (menuRes.ok) console.log(`✅ Chat menu button configured -> ${PUBLIC_PREVIEW_URL}`);

  // Set Commands list
  await tgApi('setMyCommands', {
    commands: [
      { command: 'preview', description: 'Open live browser preview window' },
      { command: 'status', description: 'Check connected browser & active tab' },
      { command: 'pair', description: 'Pair browser using pairing code: /pair <code>' },
      { command: 'newcode', description: 'Generate a new 6-character browser pairing code' },
      { command: 'help', description: 'Show available commands' }
    ]
  });
}

async function getBrokerStatus() {
  try {
    const res = await fetch(`${BROKER_URL}/api/status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function submitPairCode(code) {
  try {
    const res = await fetch(`${BROKER_URL}/work-edge/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  // Access control
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `⛔ Access denied. Your user ID (${userId}) is not in the allowed list.`
    });
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/preview')) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `🌐 *Agent Browser Copilot*\n\nTap below to open your live browser view, inspect interactive elements, and approve actions:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '📱 Open Browser Preview',
              web_app: { url: PUBLIC_PREVIEW_URL }
            }
          ]
        ]
      }
    });
    return;
  }

  if (text.startsWith('/status')) {
    const st = await getBrokerStatus();
    if (!st) {
      await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ Broker is offline or unreachable.' });
      return;
    }
    const emoji = st.connected ? '🟢' : '⚪';
    const tabTitle = st.activeTab?.title || 'No active tab';
    const tabUrl = st.activeTab?.url || 'Awaiting activity';
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `${emoji} *Copilot Status*\n\n• *Extension*: ${st.connector}\n• *Tab*: ${tabTitle}\n• *URL*: \`${tabUrl}\`\n• *Watch Mode*: ${st.watchMode}\n• *Updated*: ${st.capturedAt || 'never'}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🌐 Open Preview', web_app: { url: PUBLIC_PREVIEW_URL } }]]
      }
    });
    return;
  }

  if (text.startsWith('/pair')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: 'Usage: `/pair <6-CHAR-CODE>`\n\nEnter the pairing code from your browser extension.',
        parse_mode: 'Markdown'
      });
      return;
    }
    const code = parts[1].toUpperCase();
    const res = await submitPairCode(code);
    if (res.ok) {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `✅ *Browser Paired Successfully!*\n\nBrowser ID: \`${res.browserId.slice(0, 16)}...\`\nYour agent can now execute actions and read authorized tabs.`,
        parse_mode: 'Markdown'
      });
    } else {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `❌ *Pairing Failed*: ${res.error || 'Invalid or expired code.'}`,
        parse_mode: 'Markdown'
      });
    }
    return;
  }

  if (text.startsWith('/help')) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `📋 *Available Commands*\n\n/preview - Launch the live browser Mini App\n/status - View connected browser & active page\n/pair <code> - Complete pairing with your extension\n/help - Show this guide`,
      parse_mode: 'Markdown'
    });
    return;
  }
}

// Long Polling Loop
let offset = 0;
async function pollLoop() {
  while (true) {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 25 });
      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message);
          }
        }
      }
    } catch (err) {
      console.warn('Telegram poll error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function start() {
  await initTelegramBot();
  console.log('📡 Telegram Bot polling active...');
  pollLoop();
}

start();
