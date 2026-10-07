import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Load config
let config = {};
const configPath = path.join(ROOT_DIR, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('Failed to parse config.json:', err.message);
  }
}

const PORT = process.env.PORT || config?.server?.port || 8766;
const PREVIEW_DIR = path.join(ROOT_DIR, 'tma-preview', 'public');

// Runtime memory store
const state = {
  pairedBrowsers: new Map(), // browserId -> { token, name, lastSeen, ip }
  activeBrowserId: null,
  activeTab: null,
  lastCapture: null,
  lastScreenshot: null, // { data: Buffer, capturedAt, mimeType }
  pendingCommands: new Map(), // deliveryId -> { resolve, reject, timer }
  pendingPairCodes: new Map(), // code -> { createdAt, expiresAt }
  connectedSockets: new Map() // browserId -> WebSocket
};

// Data persistence
const DB_FILE = path.join(ROOT_DIR, 'data', 'browsers.json');
function saveDatabase() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      activeBrowserId: state.activeBrowserId,
      browsers: Array.from(state.pairedBrowsers.entries()).map(([id, b]) => ({ id, ...b }))
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not save database:', err.message);
  }
}

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (Array.isArray(data.browsers)) {
        for (const b of data.browsers) {
          state.pairedBrowsers.set(b.id, { token: b.token, name: b.name || 'Browser', lastSeen: b.lastSeen || new Date().toISOString() });
        }
      }
      state.activeBrowserId = data.activeBrowserId || (data.browsers?.[0]?.id || null);
    }
  } catch (err) {
    console.warn('Could not load database:', err.message);
  }
}
loadDatabase();

// Pairing code generator
export function createPairingCode() {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const token = crypto.randomBytes(32).toString('base64url');
  state.pendingPairCodes.set(code, {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 min
  });
  return { code, token };
}

// Token verifier helper
function verifyBearerToken(req, expectedToken) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  return token === expectedToken;
}

function verifyBrowserToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  for (const [id, browser] of state.pairedBrowsers.entries()) {
    if (browser.token === token) return id;
  }
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const reqPath = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- 1. Extension Ingest Endpoint ---
  if (reqPath === '/work-edge/ingest' && req.method === 'POST') {
    const browserId = verifyBrowserToken(req);
    if (!browserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized browser token' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        state.lastCapture = payload;
        state.activeTab = {
          id: payload.tabId,
          title: payload.title,
          url: payload.url,
          capturedAt: payload.capturedAt || new Date().toISOString()
        };
        const browser = state.pairedBrowsers.get(browserId);
        if (browser) browser.lastSeen = new Date().toISOString();
        state.activeBrowserId = browserId;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Malformed JSON payload' }));
      }
    });
    return;
  }

  // --- 2. Pairing Endpoint ---
  if (reqPath === '/work-edge/pair' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { code } = JSON.parse(body);
        const normCode = String(code || '').trim().toUpperCase();
        const pending = state.pendingPairCodes.get(normCode);
        if (!pending || pending.expiresAt < Date.now()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Pairing code invalid or expired' }));
          return;
        }

        const browserId = crypto.createHash('sha256').update(pending.token).digest('hex');
        state.pairedBrowsers.set(browserId, {
          token: pending.token,
          name: 'Customer Browser',
          lastSeen: new Date().toISOString()
        });
        state.activeBrowserId = browserId;
        state.pendingPairCodes.delete(normCode);
        saveDatabase();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, brokerToken: pending.token, browserId }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // --- 3. MCP JSON-RPC Endpoint (For Hermes, OpenClaw, Claude) ---
  if (reqPath === '/work-edge/mcp' && req.method === 'POST') {
    const expectedToken = config?.security?.mcpToken;
    if (expectedToken && !verifyBearerToken(req, expectedToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized MCP token' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const rpc = JSON.parse(body);
        const result = await handleMcpCall(rpc);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } }));
      }
    });
    return;
  }

  // --- 4. TMA & Preview API Routes ---
  if (reqPath === '/preview/api/status' || reqPath === '/api/status') {
    const isSocketConnected = Boolean(state.activeBrowserId && state.connectedSockets.has(state.activeBrowserId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configured: Boolean(state.activeBrowserId),
      connected: isSocketConnected || Boolean(state.activeTab),
      selectedBrowserId: state.activeBrowserId,
      agentIdentity: config?.agent?.name || 'Agent Browser Copilot',
      activeTab: state.activeTab,
      connector: isSocketConnected ? 'connected' : (state.activeTab ? 'idle' : 'disconnected'),
      capture: state.lastCapture ? 'available' : 'idle',
      watchMode: 'active',
      capturedAt: state.activeTab?.capturedAt || null,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (reqPath === '/preview/api/snapshot' || reqPath === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: Boolean(state.lastCapture),
      snapshot: state.lastCapture ? {
        id: state.lastCapture.tabId,
        title: state.lastCapture.title,
        url: state.lastCapture.url,
        text: state.lastCapture.text || '',
        capturedAt: state.lastCapture.capturedAt
      } : null
    }));
    return;
  }

  if (reqPath === '/preview/api/elements' || reqPath === '/api/elements') {
    const elements = state.lastCapture?.elementSummary || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, elements }));
    return;
  }

  if (reqPath === '/preview/api/screenshot' || reqPath === '/api/screenshot') {
    if (!state.activeBrowserId) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No browser paired on broker.' }));
      return;
    }

    try {
      const shot = await executeBrowserCommand({ type: 'screenshot', id: crypto.randomBytes(8).toString('hex') });
      if (shot?.ok && state.lastScreenshot?.data) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store, must-revalidate',
          'x-captured-at': state.lastScreenshot.capturedAt || new Date().toISOString()
        });
        res.end(state.lastScreenshot.data);
        return;
      }
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: shot?.error || 'Screenshot capture failed' }));
    } catch (err) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message || 'Screenshot timed out' }));
    }
    return;
  }

  // --- 5. Screenshot Ingest (from extension delivery) ---
  if (reqPath === '/work-edge/screenshot-delivery' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload.dataUrl && payload.dataUrl.startsWith('data:image/png;base64,')) {
          const base64 = payload.dataUrl.replace(/^data:image\/png;base64,/, '');
          state.lastScreenshot = {
            data: Buffer.from(base64, 'base64'),
            capturedAt: payload.capturedAt || new Date().toISOString(),
            mimeType: 'image/png'
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid data URL' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // --- 6. Static TMA Preview Frontend Hosting ---
  if (reqPath.startsWith('/preview') || reqPath === '/') {
    let fileSub = reqPath.replace(/^\/preview/, '');
    if (!fileSub || fileSub === '/') fileSub = '/index.html';
    let filePath = path.join(PREVIEW_DIR, fileSub);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(PREVIEW_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Frame-Options': 'ALLOWALL',
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Preview not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// WebSocket Server for Extension Relay
const wss = new WebSocketServer({ server, path: '/work-edge/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const auth = req.headers['authorization'] || url.searchParams.get('token') || '';
  const token = auth.replace(/^Bearer\s+/, '').trim();

  let browserId = null;
  for (const [id, b] of state.pairedBrowsers.entries()) {
    if (b.token === token) {
      browserId = id;
      break;
    }
  }

  if (!browserId) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  state.connectedSockets.set(browserId, ws);
  state.activeBrowserId = browserId;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command-result' && msg.deliveryId) {
        const pending = state.pendingCommands.get(msg.deliveryId);
        if (pending) {
          clearTimeout(pending.timer);
          state.pendingCommands.delete(msg.deliveryId);
          pending.resolve(msg.outcome);
        }
      }
    } catch (err) {
      console.warn('WS Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    if (state.connectedSockets.get(browserId) === ws) {
      state.connectedSockets.delete(browserId);
    }
  });
});

// Dispatch command to browser over WebSocket
export function executeBrowserCommand(command, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = state.activeBrowserId ? state.connectedSockets.get(state.activeBrowserId) : null;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'Browser extension is not connected to broker.' });
      return;
    }

    const deliveryId = crypto.randomUUID();
    const timer = setTimeout(() => {
      state.pendingCommands.delete(deliveryId);
      resolve({ ok: false, error: 'Command timed out waiting for browser extension response.' });
    }, timeoutMs);

    state.pendingCommands.set(deliveryId, { resolve, reject, timer });

    ws.send(JSON.stringify({
      type: 'execute-command',
      deliveryId,
      command
    }));
  });
}

// MCP Dispatcher
async function handleMcpCall(rpc) {
  const { method, params } = rpc;
  if (method === 'tools/list') {
    return {
      tools: [
        { name: 'edge_status', description: 'Returns status of the connected browser and active tab' },
        { name: 'edge_active_tab', description: 'Returns title, URL, and metadata of the active tab' },
        { name: 'edge_snapshot', description: 'Returns extracted text content of the active page' },
        { name: 'edge_find_elements', description: 'Finds interactive DOM elements on the active page' },
        { name: 'edge_screenshot', description: 'Captures a visible PNG screenshot of the active browser tab' },
        { name: 'edge_navigate', description: 'Navigates the active tab to a new URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
        { name: 'edge_click', description: 'Clicks an element on the active tab', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } }
      ]
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'edge_status') {
      const isConnected = Boolean(state.activeBrowserId && state.connectedSockets.has(state.activeBrowserId));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connector: isConnected ? 'connected' : (state.activeTab ? 'idle' : 'disconnected'),
            capture: state.lastCapture ? 'available' : 'idle',
            watchMode: 'active',
            activeTab: state.activeTab,
            capturedAt: state.activeTab?.capturedAt || null
          })
        }]
      };
    }

    if (toolName === 'edge_active_tab') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(state.activeTab || { error: 'No active tab captured yet.' })
        }]
      };
    }

    if (toolName === 'edge_snapshot') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(state.lastCapture || { error: 'No page snapshot available.' })
        }]
      };
    }

    if (toolName === 'edge_find_elements') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ matches: state.lastCapture?.elementSummary || [] })
        }]
      };
    }

    if (toolName === 'edge_screenshot') {
      const outcome = await executeBrowserCommand({ type: 'screenshot', id: crypto.randomBytes(8).toString('hex') });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(outcome)
        }]
      };
    }

    if (toolName === 'edge_navigate') {
      const outcome = await executeBrowserCommand({ type: 'navigate', url: args.url });
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome) }]
      };
    }

    if (toolName === 'edge_click') {
      const outcome = await executeBrowserCommand({ type: 'click', selector: args.selector });
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome) }]
      };
    }
  }

  throw new Error(`Method ${method} not supported`);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Agent Browser Copilot Broker listening on http://0.0.0.0:${PORT}`);
  console.log(`📱 Telegram Mini App & Preview active on http://0.0.0.0:${PORT}/preview/`);
});
