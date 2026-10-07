#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const PASS = '\x1b[32m✔ PASS\x1b[0m';
const WARN = '\x1b[33m⚠ WARN\x1b[0m';
const FAIL = '\x1b[31m✖ FAIL\x1b[0m';

let passed = 0;
let warnings = 0;
let failed = 0;

function report(status, title, details = '') {
  console.log(`  ${status}  ${title}`);
  if (details) {
    console.log(`         \x1b[90m${details}\x1b[0m`);
  }
  if (status === PASS) passed++;
  else if (status === WARN) warnings++;
  else failed++;
}

async function runDoctor() {
  console.log('\n======================================================');
  console.log('🩺 AGENT BROWSER COPILOT — SYSTEM DOCTOR');
  console.log('   Auditing runtime, security, extension, & bot health');
  console.log('======================================================\n');

  // 1. Node Version
  const nodeVer = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeVer >= 18) {
    report(PASS, `Node.js Environment`, `v${process.versions.node} (Modern ES modules, fetch & WebSockets supported)`);
  } else {
    report(FAIL, `Node.js Environment`, `v${process.versions.node} is below required Node 18. Please upgrade.`);
  }

  // 2. Config File
  const configPath = path.join(ROOT_DIR, 'config.json');
  let config = null;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      report(PASS, `Configuration (config.json)`, `Valid JSON found with port ${config?.server?.port || 8766}`);
    } catch (err) {
      report(FAIL, `Configuration (config.json)`, `Malformed JSON: ${err.message}`);
    }
  } else {
    report(FAIL, `Configuration (config.json)`, `Missing config.json. Run "copilot setup" to create one.`);
  }

  // 3. Extension Assets
  const extDir = path.join(ROOT_DIR, 'extension');
  const manifestPath = path.join(extDir, 'manifest.json');
  const swPath = path.join(extDir, 'service-worker.js');
  if (fs.existsSync(manifestPath) && fs.existsSync(swPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      report(PASS, `Chrome Extension Template`, `Manifest v${manifest.manifest_version}, Version ${manifest.version} ready for Chrome`);
    } catch {
      report(FAIL, `Chrome Extension Template`, `manifest.json is invalid JSON.`);
    }
  } else {
    report(FAIL, `Chrome Extension Template`, `Extension files missing in ${extDir}`);
  }

  // 4. Broker HTTP Service Check
  const port = config?.server?.port || 8766;
  let brokerRunning = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const status = await res.json();
      brokerRunning = true;
      report(PASS, `Broker Server (Port ${port})`, `HTTP 200 OK — Active Tab: "${status.activeTab?.title || 'None'}"`);
    } else {
      report(WARN, `Broker Server (Port ${port})`, `HTTP ${res.status}. Broker returned non-200 status.`);
    }
  } catch (err) {
    report(WARN, `Broker Server (Port ${port})`, `Not running locally. Start it with "copilot start".`);
  }

  // 5. TMA Preview Dashboard Check
  if (brokerRunning) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/preview/index.html`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        report(PASS, `Telegram Mini App (TMA) Preview`, `Serving HTML, CSS, & WebApp JS on /preview/`);
      } else {
        report(WARN, `Telegram Mini App (TMA) Preview`, `Returned HTTP ${res.status}`);
      }
    } catch (err) {
      report(WARN, `Telegram Mini App (TMA) Preview`, err.message);
    }
  }

  // 6. Telegram Bot Integration
  const botToken = config?.telegram?.botToken;
  if (botToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      if (data.ok) {
        report(PASS, `Telegram Bot Connectivity`, `@${data.result.username} (${data.result.first_name}) authenticated`);

        // Check Menu Button
        const menuRes = await fetch(`https://api.telegram.org/bot${botToken}/getChatMenuButton`);
        const menuData = await menuRes.json();
        if (menuData.ok && menuData.result?.type === 'web_app') {
          report(PASS, `Telegram Menu Button`, `Mapped to TMA WebApp: ${menuData.result.web_app?.url}`);
        } else {
          report(WARN, `Telegram Menu Button`, `Not set to WebApp. Run "copilot setup" to reconfigure.`);
        }
      } else {
        report(FAIL, `Telegram Bot Connectivity`, `Telegram rejected token: ${data.description}`);
      }
    } catch (err) {
      report(WARN, `Telegram Bot Connectivity`, `Could not reach api.telegram.org: ${err.message}`);
    }
  } else {
    report(WARN, `Telegram Bot Integration`, `No bot token configured. Bot features disabled.`);
  }

  // 7. Paired Browser Check
  const dbPath = path.join(ROOT_DIR, 'data', 'browsers.json');
  if (fs.existsSync(dbPath)) {
    try {
      const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const count = db.browsers?.length || 0;
      if (count > 0) {
        report(PASS, `Paired Browsers`, `${count} browser(s) registered in database`);
      } else {
        report(WARN, `Paired Browsers`, `No browser paired yet. Pair from extension sidepanel using a pairing code.`);
      }
    } catch {
      report(WARN, `Paired Browsers`, `Database unreadable`);
    }
  } else {
    report(WARN, `Paired Browsers`, `No browsers paired yet. Open extension to pair.`);
  }

  // Summary
  console.log('\n------------------------------------------------------');
  console.log(`Audit Summary: ${passed} Passed, ${warnings} Warnings, ${failed} Failed`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) {
    console.log('❌ Doctor found blocking issues. Please address the [FAIL] items above.\n');
    process.exit(1);
  } else if (warnings > 0) {
    console.log('💡 System is operable with non-critical warnings.\n');
  } else {
    console.log('✨ All systems operational and ready for live agent workflows!\n');
  }
}

runDoctor().catch(err => {
  console.error('Doctor crashed:', err);
  process.exit(1);
});
