#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ask(rl, question, defaultVal = '') {
  return new Promise(resolve => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, answer => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function runWizard() {
  console.log('\n======================================================');
  console.log('🚀 AGENT BROWSER COPILOT — SETUP WIZARD');
  console.log('   Empower your AI agent with real browser control');
  console.log('======================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const appName = await ask(rl, 'Copilot Name / Branding', 'Agent Browser Copilot');
    const portStr = await ask(rl, 'Broker & Preview Port', '8766');
    const port = parseInt(portStr, 10) || 8766;

    const publicUrl = await ask(rl, 'Public Base URL (Domain or IP with protocol)', `http://localhost:${port}`);
    const cleanPublicUrl = publicUrl.replace(/\/+$/, '');
    const previewUrl = `${cleanPublicUrl}/preview/`;

    console.log('\n📱 Telegram Integration (Optional - Press enter to skip):');
    const botToken = await ask(rl, 'Telegram Bot Token (from @BotFather)');
    let allowedUsers = [];
    if (botToken) {
      const allowedUsersStr = await ask(rl, 'Allowed Telegram User IDs (comma-separated, leave blank for all)');
      if (allowedUsersStr) {
        allowedUsers = allowedUsersStr.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
      }
    }

    console.log('\n🤖 Agent Provider Configuration:');
    console.log('  1) Hermes Agent Gateway');
    console.log('  2) OpenClaw / Claude Desktop / Generic MCP');
    console.log('  3) Custom REST / Webhook');
    const agentChoice = await ask(rl, 'Select agent type (1, 2, or 3)', '1');
    const agentType = agentChoice === '2' ? 'openclaw' : (agentChoice === '3' ? 'custom' : 'hermes');

    // Generate secure keys
    const brokerToken = crypto.randomBytes(32).toString('base64url');
    const mcpToken = crypto.randomBytes(32).toString('hex');
    const viewToken = crypto.randomBytes(32).toString('base64url');

    const config = {
      name: appName,
      server: {
        port,
        host: '0.0.0.0',
        publicUrl: cleanPublicUrl,
        previewUrl
      },
      security: {
        brokerToken,
        mcpToken,
        viewToken
      },
      telegram: {
        enabled: Boolean(botToken),
        botToken: botToken || null,
        allowedUserIds: allowedUsers
      },
      agent: {
        type: agentType,
        name: appName
      }
    };

    // 1. Write config.json
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    console.log('\n✅ Created config.json');

    // 2. Configure Extension Manifest & broker-url.js
    const extDir = path.join(__dirname, 'extension');
    const manifestPath = path.join(extDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.name = appName;

      // Extract hostname for CSP & host_permissions
      try {
        const u = new URL(cleanPublicUrl);
        const hostPattern = `${u.protocol}//${u.host}/*`;
        const wsPattern = `${u.protocol.replace('http', 'ws')}//${u.host}/*`;
        manifest.host_permissions = Array.from(new Set([
          hostPattern,
          wsPattern,
          'http://127.0.0.1/*',
          '<all_urls>'
        ]));
        manifest.content_security_policy = {
          extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${u.origin} ${u.origin.replace('http', 'ws')} http://127.0.0.1`
        };
      } catch {}

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      console.log('✅ Updated extension/manifest.json with custom domain & CSP');
    }

    // 3. Configure Telegram Bot if token provided
    if (botToken) {
      console.log('🤖 Verifying Telegram Bot token...');
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        const data = await res.json();
        if (data.ok) {
          console.log(`✅ Connected to Telegram Bot: @${data.result.username}`);
          // Configure Chat Menu Button
          await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              menu_button: {
                type: 'web_app',
                text: '🌐 Browser Preview',
                web_app: { url: previewUrl }
              }
            })
          });
          console.log(`✅ Configured Telegram Chat Menu button -> ${previewUrl}`);
        } else {
          console.warn('⚠️ Warning: Bot token rejected by Telegram:', data.description);
        }
      } catch (err) {
        console.warn('⚠️ Could not connect to Telegram API:', err.message);
      }
    }

    console.log('\n======================================================');
    console.log('🎉 SETUP COMPLETE!');
    console.log('======================================================');
    console.log('\nNext Steps:');
    console.log('1. Start services:');
    console.log('   ./bin/copilot start');
    console.log('\n2. Load Chrome Extension:');
    console.log('   - Open chrome://extensions/');
    console.log('   - Enable "Developer mode" (top right toggle)');
    console.log('   - Click "Load unpacked" and select:');
    console.log(`     ${path.join(__dirname, 'extension')}`);
    console.log('\n3. Run Health Doctor:');
    console.log('   ./bin/copilot doctor\n');

  } finally {
    rl.close();
  }
}

runWizard().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
