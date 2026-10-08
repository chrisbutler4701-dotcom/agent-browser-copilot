import { REMOTE_INGEST_URL, chatEndpointUrl, normalizeBrokerUrl, pairingExchangeUrl, validateBrokerUrl, verifiedActionEndpointUrl, websocketEndpointUrl } from './broker-url.js';
import { executeBrowserCommand, executeVerifiedActionCommand } from './command-executor.js';

const CAPTURE_KEY = 'latestExplicitCapture';
export const READ_MONITORING_ENABLED_KEY = 'readMonitoringEnabled';
export const SENSITIVE_READ_RESTRICTED_KEY = 'sensitiveReadRestricted';
// Sensitive origins need their own durable, exact-origin consent. This does
// not grant Hermes control or trust arbitrary new origins.
export const APPROVED_SENSITIVE_READ_ORIGINS_KEY = 'approvedSensitiveReadOrigins';
export const HERMES_CONTROL_ENABLED_KEY = 'hermesControlEnabled';
export const COMMAND_POLL_HEARTBEAT_KEY = 'commandPollHeartbeat';
export const COMMAND_RESUME_KEY = 'commandResume';
const COMMAND_TRANSPORT_ALARM = 'work-edge-command-transport';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let contextUiOpen = false;
let commandPolling = false;
let controlPortCount = 0;
let brokerSocket = null;
let socketConnecting = false;
let socketRetry = 0;
let socketRetryTimer = null;
let socketKeepaliveTimer = null;
let offscreenCreation = null;
let durableRunnerEnsure = null;
const NAVIGATION_COMPLETE_TIMEOUT_MS = 10_000;
// Gmail and Outlook update their reading panes asynchronously after an in-page
// row click. Keep this bounded so ordinary commands do not wait on SPA work
// indefinitely.
const PAGE_STATE_CAPTURE_SETTLE_MS = 750;
const MAX_SCREENSHOT_DATA_URL_BYTES = 5 * 1024 * 1024;
// The broker treats a browser as stale after 15 seconds, so renew the WSS
// lease inside that window.
const SOCKET_KEEPALIVE_MS = 10_000;
// Outlook can move between these two application origins after sign-in or
// navigation. Keep this deliberately enumerated: it is not a Microsoft or
// Office domain wildcard and does not include account or login origins.
const OUTLOOK_APP_ORIGINS = new Set([
  'https://outlook.office.com',
  'https://outlook.cloud.microsoft'
]);

let recentScreenshotCache = null;

// Registered only inside the extension so this module stays importable in Node.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'capture-active-tab') {
      captureActiveTab().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'capture-active-tab-session') {
      captureActiveTabSession().then(sendResponse).catch(async (error) => sendResponse(await unavailablePage(error)));
      return true;
    }
    if (message.type === 'context-ui-open') {
      contextUiOpen = true;
      captureActiveTabSession().then(sendResponse).catch(async (error) => sendResponse(await unavailablePage(error)));
      return true;
    }
    if (message.type === 'context-ui-closed') {
      contextUiOpen = false;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'send-chat') {
      sendChat(message.message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'capture-status') {
      captureStatus().then(sendResponse).catch((error) => sendResponse({ capture: null, stale: true, activeTab: null, error: error.message }));
      return true;
    }
    if (message.type === 'approve-sensitive-read-origin') {
      approveSensitiveReadOrigin().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'forget-sensitive-read-origin') {
      forgetSensitiveReadOrigin().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'set-sensitive-read-restricted') {
      setSensitiveReadRestricted(message.restricted).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'pair-browser') {
      pairBrowser(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'reset-pairing') {
      reportControlState(false);
      chrome.storage.local.remove(['brokerToken', HERMES_CONTROL_ENABLED_KEY, COMMAND_RESUME_KEY])
        .then(async () => {
          await ensureDurableCommandRunner();
          brokerSocket?.close();
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'broker-status') {
      Promise.all([
        chrome.storage.local.get(['brokerUrl', 'brokerToken', HERMES_CONTROL_ENABLED_KEY, READ_MONITORING_ENABLED_KEY, SENSITIVE_READ_RESTRICTED_KEY, APPROVED_SENSITIVE_READ_ORIGINS_KEY]),
        chrome.storage.session.get(COMMAND_POLL_HEARTBEAT_KEY)
      ]).then(([value, session]) => sendResponse({
        configured: Boolean(value.brokerUrl),
        paired: Boolean(value.brokerToken),
        controlEnabled: value[HERMES_CONTROL_ENABLED_KEY] === true,
        readMonitoringEnabled: value[READ_MONITORING_ENABLED_KEY] !== false,
        sensitiveReadRestricted: value[SENSITIVE_READ_RESTRICTED_KEY] === true,
        approvedSensitiveOriginCount: normalizeApprovedOrigins(value[APPROVED_SENSITIVE_READ_ORIGINS_KEY]).length,
        pollHeartbeat: session[COMMAND_POLL_HEARTBEAT_KEY] || null
      })).catch((error) => sendResponse({
        configured: false,
        paired: false,
        controlEnabled: false,
        readMonitoringEnabled: false,
        sensitiveReadRestricted: false,
        approvedSensitiveOriginCount: 0,
        pollHeartbeat: null,
        error: error.message
      }));
      return true;
    }
    if (message.type === 'verified-actions-pending') {
      pendingVerifiedActions().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message, pending: [] }));
      return true;
    }
    if (message.type === 'verified-action-decision') {
      decideVerifiedAction(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'set-read-monitoring') {
      setReadMonitoringEnabled(message.enabled).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'toggle-hermes-control') { toggleHermesControl().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message })); return true; }
    if (message.type === 'synthesize-speech') {
      synthesizeSpeech(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'durable-runner-execute-command') {
      executeCommandInActiveTab(message.command).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'durable-runner-transport-state') {
      const state = ['websocket', 'active', 'starting', 'failed'].includes(message.state) ? message.state : 'failed';
      const diagnostic = runnerDiagnostic(true, true, true, state);
      setRunnerHeartbeat(state, diagnostic).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'hermes-control') return;
    controlPortCount += 1;
    // The offscreen document is the durable command owner. Starting another
    // WSS here creates two sockets for one paired browser and lets either close
    // invalidate the other one's broker lease.
    resumeCommandTransport();
    port.onDisconnect.addListener(() => { controlPortCount = Math.max(0, controlPortCount - 1); });
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => autoCaptureCurrentTab());
  chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === 'complete') autoCaptureCurrentTab(); });
  chrome.windows?.onFocusChanged.addListener((windowId) => { if (windowId !== chrome.windows.WINDOW_ID_NONE) autoCaptureCurrentTab(); });
}

function autoCaptureCurrentTab() {
  // Watch mode begins after normal-tab permission and pairing, unless the user
  // explicitly turns it off in the popup. Sensitive-page restriction is an
  // optional per-site approval mode.
  activeTab().then(async (tab) => {
    const settings = await chrome.storage.local.get(['brokerToken', READ_MONITORING_ENABLED_KEY]);
    if (!settings.brokerToken || settings[READ_MONITORING_ENABLED_KEY] === false || !autoCaptureEligibility(tab).allowed) return;
    chrome.storage.session.remove(CAPTURE_KEY).catch(() => {});
    notifyContext({ ok: false, reading: true, capture: null });
    return captureTabForDelivery(tab, true, false);
  }).then((response) => { if (response) notifyContext(response); }).catch(async (error) => notifyContext(await unavailablePage(error)));
}

function notifyContext(payload) {
  const sent = chrome.runtime?.sendMessage?.({ type: 'context-capture-updated', ...payload });
  sent?.catch(() => {});
}

async function captureActiveTab() {
  const { rawCapture: _rawCapture, ...response } = await captureActiveTabForDelivery(true);
  return response;
}

async function captureActiveTabSession() {
  const { rawCapture: _rawCapture, ...response } = await captureActiveTabForDelivery(false, false);
  return response;
}

async function captureActiveTabForDelivery(deliver, userInitiated = true) {
  const tab = await activeTab();
  return captureTabForDelivery(tab, deliver, userInitiated);
}

export async function captureTabForDelivery(tab, deliver, userInitiated = true) {
  // A successful capture proves this MV3 worker is awake, not that its
  // in-memory WSS survived suspension. Re-establish the authenticated command
  // path on every capture wake so read/watch activity cannot mask a dead
  // control channel when the popup is closed.
  void resumeCommandTransport().catch(() => {});
  if (!tab?.id || !isCapturableTab(tab)) throw new Error('Browser-internal and file pages cannot be read. Open a normal webpage.');
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/capture.js'] });
  if (!result?.url || !isCapturableUrl(result.url)) throw new Error('Browser-internal and file pages cannot be read.');
  const origin = new URL(result.url).origin;
  const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
  const sensitive = isSensitivePage(result);
  const sensitiveReadPersistent = !restrict || isApprovedOrigin(origin, approvedSensitiveOrigins);
  if (restrict && sensitive && !sensitiveReadPersistent) {
    const metadataOnly = { title: result.title, url: result.url, text: '', elementSummary: [], sensitiveSignals: result.sensitiveSignals || [], tabId: tab.id, capturedAt: new Date().toISOString(), userInitiated, sensitiveReadRestricted: true };
    await chrome.storage.session.set({ [CAPTURE_KEY]: metadataOnly });
    return { ok: true, sent: false, capture: publicCapture(metadataOnly, { needsApproval: true, sensitive: true, sensitiveReadRestricted: true, sensitiveReadPersistent: false }), rawCapture: metadataOnly, needsApproval: true, sensitive: true, sensitiveReadRestricted: true, sensitiveReadPersistent: false };
  }
  const capture = {
    ...result,
    tabId: tab.id,
    capturedAt: new Date().toISOString(),
    userInitiated,
    // Only background delivery uses this mode. The broker treats it as a
    // sanitized, approved-origin watch capture, never as control authority.
    readOnlyWatch: deliver && !userInitiated,
    approvedSensitiveOriginCount: approvedSensitiveOrigins.length,
    sensitiveReadRestricted: restrict,
    sensitiveReadPersistent
  };
  await chrome.storage.session.set({ [CAPTURE_KEY]: capture });
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  let sent = false;
  if (deliver && settings.brokerUrl) {
    if (!validateBrokerUrl(settings.brokerUrl)) throw new Error('Broker URL is not an approved local or B2 ingest endpoint.');
    if (!settings.brokerToken) throw new Error('Pair this browser before broker delivery.');
    const response = await fetch(settings.brokerUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` }, body: JSON.stringify(capture), cache: 'no-store' });
    if (!response.ok) throw new Error(`Broker rejected capture (${response.status}).`);
    sent = true;
  }
  return { ok: true, sent, capture: publicCapture(capture, { sensitive, sensitiveReadRestricted: restrict, sensitiveReadPersistent }), rawCapture: capture, sensitive, sensitiveReadRestricted: restrict, sensitiveReadPersistent };
}

export function isCapturableUrl(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol);
  } catch { return false; }
}

export function isCapturableTab(tab) { return Boolean(tab?.url && isCapturableUrl(tab.url)); }

export function autoCaptureEligibility(tab) {
  if (!isCapturableTab(tab)) return { allowed: false, reason: 'not_capturable' };
  return { allowed: true, origin: new URL(tab.url).origin };
}

export function isApprovedOrigin(origin, approvedOrigins) {
  const normalized = normalizeApprovedOrigins(approvedOrigins);
  if (normalized.includes(origin)) return true;
  return OUTLOOK_APP_ORIGINS.has(origin) && normalized.some((approvedOrigin) => OUTLOOK_APP_ORIGINS.has(approvedOrigin));
}

function withoutApprovedOriginGroup(approvedOrigins, origin) {
  if (!OUTLOOK_APP_ORIGINS.has(origin)) return approvedOrigins.filter((item) => item !== origin);
  return approvedOrigins.filter((item) => !OUTLOOK_APP_ORIGINS.has(item));
}

function pageUnavailable(error, tab = null) {
  return { ok: false, unavailable: true, error: error.message, capture: null, activeTab: activeTabMetadata(tab) };
}

async function unavailablePage(error) { return pageUnavailable(error, await activeTab()); }

async function sendChat(message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Enter a message for Hermes.');
  if (message.length > 8000) throw new Error('Message exceeds the 8,000-character limit.');
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  if (!settings.brokerUrl || !validateBrokerUrl(settings.brokerUrl)) throw new Error('Configure an approved broker URL first.');
  if (!settings.brokerToken) throw new Error('Pair this browser before sending a message.');
  const endpoint = chatEndpointUrl(settings.brokerUrl);
  // This uses the same explicit, sanitized active-tab path as Capture. It does
  // not invoke any model, retain chat history, or make a separate agent.
  const captured = await captureActiveTabForDelivery(false);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
    body: JSON.stringify({ message: message.trim(), capture: captured.rawCapture }),
    cache: 'no-store'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.response !== 'string') throw new Error(result.error || `Broker rejected chat (${response.status}).`);
  return { ok: true, response: result.response, capture: captured.capture };
}

async function activeTab() {
  const [activeInWindow] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (activeInWindow && isCapturableTab(activeInWindow)) return activeInWindow;

  const [activeInCurrent] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (activeInCurrent && isCapturableTab(activeInCurrent)) return activeInCurrent;

  const allActive = await chrome.tabs.query({ active: true }).catch(() => []);
  const capturableActive = allActive.find(isCapturableTab);
  if (capturableActive) return capturableActive;

  try {
    const normalTabs = await chrome.tabs.query({ windowType: 'normal' });
    const capturableNormal = normalTabs.filter(isCapturableTab);
    if (capturableNormal.length > 0) {
      capturableNormal.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return capturableNormal[0];
    }
  } catch {}
  return activeInWindow || activeInCurrent || null;
}

export function activeTabMetadata(tab) {
  if (!tab) return null;
  let url = null;
  try { url = tab.url ? new URL(tab.url).origin : null; } catch { /* A malformed URL cannot be displayed. */ }
  return { title: tab.title || 'Current page', url };
}

export function isFreshCaptureForTab(capture, tab) {
  return Boolean(capture && tab?.id && typeof tab.url === 'string'
    && capture.tabId === tab.id && capture.url === tab.url
    && String(capture.title || '') === String(tab.title || ''));
}

export function isSensitivePage(capture) {
  try {
    const url = new URL(capture?.url || '');
    const sensitivePath = /(?:^|\/)(?:login|signin|sign-in|auth|password|mfa|account)(?:[/?#._-]|$)/i.test(url.pathname);
    const sensitiveHost = /(?:^|\.)(?:login|account)\./i.test(url.hostname) || /microsoftonline\.com$/i.test(url.hostname);
    return sensitivePath || sensitiveHost || (Array.isArray(capture?.sensitiveSignals) && capture.sensitiveSignals.length > 0);
  } catch { return false; }
}

export function publicCapture(capture, state = {}) {
  return { title: capture.title, url: new URL(capture.url).origin, text: capture.text, capturedAt: capture.capturedAt, ...state };
}

async function readApprovedSensitiveOrigins() {
  const settings = await chrome.storage.local.get(APPROVED_SENSITIVE_READ_ORIGINS_KEY);
  return normalizeApprovedOrigins(settings[APPROVED_SENSITIVE_READ_ORIGINS_KEY]);
}

export async function readSensitiveReadRestricted() {
  const settings = await chrome.storage.local.get(SENSITIVE_READ_RESTRICTED_KEY);
  return settings[SENSITIVE_READ_RESTRICTED_KEY] === true;
}

export function normalizeApprovedOrigins(value) {
  return Array.isArray(value) ? [...new Set(value.filter((origin) => {
    try { return new URL(origin).origin === origin && /^https?:/.test(new URL(origin).protocol); } catch { return false; }
  }))] : [];
}

export async function approveSensitiveReadOrigin() {
  const tab = await activeTab();
  if (!isCapturableTab(tab)) throw new Error('Browser-internal and file pages cannot be read.');
  const origin = new URL(tab.url).origin;
  const approvedSensitiveOrigins = await readApprovedSensitiveOrigins();
  await chrome.storage.local.set({ [APPROVED_SENSITIVE_READ_ORIGINS_KEY]: [...new Set([...approvedSensitiveOrigins, origin])] });
  return captureActiveTabSession();
}

async function forgetSensitiveReadOrigin() {
  const tab = await activeTab();
  if (!isCapturableTab(tab)) throw new Error('Browser-internal and file pages cannot be read.');
  const origin = new URL(tab.url).origin;
  const approvedSensitiveOrigins = withoutApprovedOriginGroup(await readApprovedSensitiveOrigins(), origin);
  await chrome.storage.local.set({ [APPROVED_SENSITIVE_READ_ORIGINS_KEY]: approvedSensitiveOrigins });
  return captureActiveTabSession();
}

async function setReadMonitoringEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Read monitoring must be on or off.');
  await chrome.storage.local.set({ [READ_MONITORING_ENABLED_KEY]: enabled });
  if (enabled) autoCaptureCurrentTab();
  return { ok: true, enabled };
}

async function setSensitiveReadRestricted(restricted) {
  if (typeof restricted !== 'boolean') throw new Error('Sensitive read restriction must be on or off.');
  await chrome.storage.local.set({ [SENSITIVE_READ_RESTRICTED_KEY]: restricted });
  if (restricted) await chrome.storage.session.remove(CAPTURE_KEY);
  return { ok: true, sensitiveReadRestricted: restricted };
}

async function captureStatus() {
  const [tab, stored, settings] = await Promise.all([activeTab(), chrome.storage.session.get(CAPTURE_KEY), chrome.storage.local.get([APPROVED_SENSITIVE_READ_ORIGINS_KEY, SENSITIVE_READ_RESTRICTED_KEY])]);
  const capture = stored[CAPTURE_KEY] || null;
  if (!isFreshCaptureForTab(capture, tab)) {
    if (capture) await chrome.storage.session.remove(CAPTURE_KEY);
    return { capture: null, stale: true, activeTab: activeTabMetadata(tab), unavailable: !isCapturableTab(tab), error: !isCapturableTab(tab) ? 'Browser-internal and file pages cannot be read.' : null };
  }
  const sensitiveReadRestricted = settings[SENSITIVE_READ_RESTRICTED_KEY] === true;
  const sensitiveReadPersistent = !sensitiveReadRestricted || isApprovedOrigin(new URL(capture.url).origin, settings[APPROVED_SENSITIVE_READ_ORIGINS_KEY]);
  const needsApproval = sensitiveReadRestricted && isSensitivePage(capture) && !sensitiveReadPersistent;
  return { capture: publicCapture(capture, { sensitive: isSensitivePage(capture), needsApproval, sensitiveReadRestricted, sensitiveReadPersistent }), stale: false, activeTab: activeTabMetadata(tab), sensitiveReadRestricted };
}

async function pairBrowser({ brokerUrl, code }) {
  if (!brokerUrl) {
    const settings = await chrome.storage.local.get(['brokerUrl']);
    brokerUrl = settings.brokerUrl || REMOTE_INGEST_URL;
  }
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) throw new Error('Broker URL is not an approved local or B2 ingest endpoint.');
  if (typeof code !== 'string' || !/^[A-Z2-9]{12}$/.test(code)) throw new Error('Enter the 12-character pairing code.');
  const endpoint = pairingExchangeUrl(brokerUrl);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.token !== 'string' || !result.token) throw new Error(result.error || `Pairing was rejected (${response.status}).`);
  await chrome.storage.local.set({ brokerUrl, brokerToken: result.token, [HERMES_CONTROL_ENABLED_KEY]: false });
  ensureBrokerSocket();
  return { ok: true };
}

async function verifiedActionRequest(action, body) {
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  const endpoint = verifiedActionEndpointUrl(settings.brokerUrl, action);
  if (!settings.brokerToken || !endpoint) throw new Error('Pair this browser with an approved broker first.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Verified action request was rejected (${response.status}).`);
  return result;
}

export async function pendingVerifiedActions() {
  const result = await verifiedActionRequest('pending', {});
  return { ok: true, pending: Array.isArray(result.pending) ? result.pending : [] };
}

export async function decideVerifiedAction({ decision, transactionId, proposalHash }) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject.');
  if (typeof transactionId !== 'string' || !transactionId) throw new Error('Transaction ID is required.');
  if (typeof proposalHash !== 'string' || !/^[a-f0-9]{64}$/.test(proposalHash)) throw new Error('Proposal hash is invalid.');
  const result = await verifiedActionRequest(decision, { transactionId, proposalHash });
  return { ok: true, transaction: result.transaction };
}

function commandEndpoint(brokerUrl, path) { return new URL(`/work-edge/commands/${path}`, brokerUrl).toString(); }
function extensionVersion() {
  try { return chrome.runtime?.getManifest?.().version || null; } catch { return null; }
}
export function controlHeartbeatState(enabled, socketOpen) {
  if (!enabled) return 'off';
  return socketOpen ? 'websocket' : 'starting';
}
export function runnerDiagnostic(controlEnabled, offscreenPresent, acknowledged, transportState) {
  if (!controlEnabled) return 'control_disabled';
  if (!offscreenPresent) return 'offscreen_absent';
  if (!acknowledged) return 'runner_configured_unacknowledged';
  if (transportState === 'websocket') return 'websocket_active';
  if (transportState === 'active') return 'polling_recovery_active';
  return 'no_viable_command_transport';
}
function setRunnerHeartbeat(state, diagnostic) {
  return chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state, diagnostic, at: Date.now() } });
}
function reportControlState(enabled) {
  if (socketIsOpen()) brokerSocket.send(JSON.stringify({ type: 'control-state', enabled }));
}

async function toggleHermesControl() {
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  if (!settings.brokerToken || !validateBrokerUrl(settings.brokerUrl)) throw new Error('Pair this browser with an approved broker first.');
  const state = await chrome.storage.local.get(HERMES_CONTROL_ENABLED_KEY);
  const enabled = state[HERMES_CONTROL_ENABLED_KEY] !== true;
  await chrome.storage.local.set({ [HERMES_CONTROL_ENABLED_KEY]: enabled });
  await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: controlHeartbeatState(enabled, brokerSocket?.readyState === WebSocket.OPEN), at: Date.now() } });
  await resumeCommandTransport();
  reportControlState(enabled);
  return { ok: true, enabled };
}

async function offscreenDocumentExists() {
  if (!chrome.offscreen || !chrome.runtime?.getContexts) return false;
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [documentUrl] });
  return contexts.some((context) => context.contextType === 'OFFSCREEN_DOCUMENT');
}

// The offscreen page has only chrome.runtime. Its dedicated worker owns network
// transport; every command still returns here for the existing active-tab,
// permission, and final-action checks.
async function ensureDurableCommandRunnerOnce() {
  if (typeof chrome === 'undefined' || !chrome.offscreen || !chrome.runtime?.getURL || !chrome.runtime?.getContexts) return false;
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken', HERMES_CONTROL_ENABLED_KEY]);
  if (settings[HERMES_CONTROL_ENABLED_KEY] !== true || !settings.brokerToken || !validateBrokerUrl(settings.brokerUrl)) {
    if (await offscreenDocumentExists()) await chrome.offscreen.closeDocument();
    return false;
  }
  let exists = await offscreenDocumentExists();
  if (!exists) {
    await setRunnerHeartbeat('starting', runnerDiagnostic(true, false, false, null));
    if (!offscreenCreation) {
      offscreenCreation = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['WORKERS'],
        justification: 'Run the bounded Hermes command transport worker while control is enabled.'
      }).finally(() => { offscreenCreation = null; });
    }
    await offscreenCreation;
    exists = true;
  }
  await setRunnerHeartbeat('starting', runnerDiagnostic(true, exists, false, null));
  try {
    const response = await chrome.runtime.sendMessage({ type: 'durable-runner-configure', brokerUrl: settings.brokerUrl, brokerToken: settings.brokerToken, controlEnabled: true, extensionVersion: extensionVersion() });
    if (response?.ok === true && response.ready === true) return true;
  } catch { /* Fall back to the worker-owned recovery transport. */ }
  await setRunnerHeartbeat('failed', runnerDiagnostic(true, exists, true, 'failed'));
  return false;
}

export function ensureDurableCommandRunner() {
  if (!durableRunnerEnsure) {
    durableRunnerEnsure = ensureDurableCommandRunnerOnce().finally(() => { durableRunnerEnsure = null; });
  }
  return durableRunnerEnsure;
}

function isSafeRemoteNavigation(url) {
  return typeof url === 'string'
    && isCapturableUrl(url)
    && !/(?:save|submit|send|delete|remove|upload|e-?sign|sign(?:\s|$)|buy|purchase|checkout|place order|confirm)/i.test(url);
}

function waitForTabComplete(tabId, timeoutMs = NAVIGATION_COMPLETE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(completed);
    };
    const listener = (updatedTabId, change) => {
      if (updatedTabId === tabId && change.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateAndCapture(tab, command) {
  if (!isSafeRemoteNavigation(command.url)) return { ok: false, error: 'Refused: remote navigation is limited to normal URLs and cannot be a final action.' };
  const completed = waitForTabComplete(tab.id);
  await chrome.tabs.update(tab.id, { url: command.url });
  if (!await completed) return { ok: false, error: 'Navigation did not finish before the 10-second limit.' };
  const captured = await captureTabForDelivery({ ...tab, url: command.url }, true, false);
  return { ok: true, result: { navigated: true, captureDelivered: captured.sent, capture: captured.capture } };
}

function screenshotIngestUrl(brokerUrl) {
  if (!validateBrokerUrl(brokerUrl)) return null;
  const endpoint = new URL(brokerUrl);
  endpoint.pathname = '/work-edge/ingest-screenshot';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

async function deliverScreenshot(screenshot) {
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken']);
  const endpoint = screenshotIngestUrl(settings.brokerUrl);
  if (!endpoint || !settings.brokerToken) return false;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` },
      body: JSON.stringify(screenshot),
      cache: 'no-store'
    });
    return response.ok;
  } catch { return false; }
}

export async function screenshotActiveTab(tab, command) {
  const durable = await chrome.storage.local.get(HERMES_CONTROL_ENABLED_KEY);
  if (durable[HERMES_CONTROL_ENABLED_KEY] !== true) return { ok: false, error: 'Control is not enabled.' };
  if (!tab?.id || !isCapturableTab(tab)) return { ok: false, error: 'Screenshot capture is limited to an active normal web tab.' };
  if (typeof command?.id !== 'string' || !/^[a-f0-9]{16}$/.test(command.id)) return { ok: false, error: 'Screenshot command identity is invalid.' };
  const canReadNormalTabs = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  if (!canReadNormalTabs) return { ok: false, error: 'Enable reading normal tabs before requesting a screenshot.' };
  const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
  if (restrict && isSensitivePage({ url: tab.url }) && !isApprovedOrigin(new URL(tab.url).origin, approvedSensitiveOrigins)) return { ok: false, error: 'Screenshot on a sensitive page requires sensitive-read approval.' };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    } catch (err2) {
      if (recentScreenshotCache && (Date.now() - recentScreenshotCache.timestamp < 2500) && recentScreenshotCache.tabId === tab.id) {
        dataUrl = recentScreenshotCache.dataUrl;
      } else {
        return { ok: false, error: `Visible-tab screenshot capture failed: ${err.message || err} (fallback: ${err2.message || err2})` };
      }
    }
  }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return { ok: false, error: 'Screenshot capture did not return a PNG data URL.' };
  recentScreenshotCache = { dataUrl, tabId: tab.id, timestamp: Date.now() };
  if (new TextEncoder().encode(dataUrl).byteLength > MAX_SCREENSHOT_DATA_URL_BYTES) return { ok: false, error: 'Screenshot exceeds the 5 MB limit.' };
  const capturedAt = new Date().toISOString();
  const delivered = await deliverScreenshot({ commandId: command.id, dataUrl, tabId: tab.id, url: tab.url, capturedAt, mimeType: 'image/png' });
  if (!delivered) return { ok: false, error: 'Screenshot could not be stored by the broker.' };
  return { ok: true, result: { tabId: tab.id, capturedAt, mimeType: 'image/png', screenshotDelivered: true } };
}

function shouldCaptureAfterCommand(command, outcome) {
  return outcome?.ok === true && ['click', 'press', 'type', 'select', 'scroll', 'wait'].includes(command?.type);
}

async function captureAfterCommand(tab, command, outcome) {
  if (!shouldCaptureAfterCommand(command, outcome)) return outcome;
  if (command.type === 'click' || command.type === 'press') await new Promise((resolve) => setTimeout(resolve, PAGE_STATE_CAPTURE_SETTLE_MS));

  // Re-read the active tab after the action: an SPA may have updated its title
  // or route without emitting a normal navigation-load event.
  const refreshedTab = await activeTab();
  if (!refreshedTab?.id || refreshedTab.id !== tab.id || !isCapturableTab(refreshedTab)) return outcome;
  const monitoring = await chrome.storage.local.get(READ_MONITORING_ENABLED_KEY);
  if (monitoring[READ_MONITORING_ENABLED_KEY] === false || !autoCaptureEligibility(refreshedTab).allowed) return outcome;

  try {
    const captured = await captureTabForDelivery(refreshedTab, true, false);
    return { ...outcome, result: { ...(outcome.result || {}), captureDelivered: captured.sent, capture: captured.capture } };
  } catch (error) {
    // The action happened. Report delivery failure separately rather than
    // falsely reporting that the command itself failed.
    return { ...outcome, result: { ...(outcome.result || {}), captureDelivered: false, captureError: error.message || 'Fresh capture delivery failed.' } };
  }
}

export async function executeCommandInActiveTab(command) {
  const durable = await chrome.storage.local.get(HERMES_CONTROL_ENABLED_KEY);
  if (durable[HERMES_CONTROL_ENABLED_KEY] !== true) return { ok: false, error: 'Control is not enabled.' };
  const tab = await activeTab();
  if (!tab?.id || !isCapturableTab(tab)) return { ok: false, error: 'Remote control is limited to an active normal web tab.' };
  if (['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type) && command.expectedTabId !== undefined) {
    if (tab.id !== command.expectedTabId || new URL(tab.url).origin !== command.expectedOrigin) return { ok: false, error: 'The active tab no longer matches the approved verified-action target.' };
  }
  if (command?.type === 'find') {
    const [restrict, approvedSensitiveOrigins] = await Promise.all([readSensitiveReadRestricted(), readApprovedSensitiveOrigins()]);
    if (restrict && isSensitivePage({ url: tab.url }) && !isApprovedOrigin(new URL(tab.url).origin, approvedSensitiveOrigins)) return { ok: false, error: 'Live discovery on a sensitive page requires sensitive-read approval.' };
  }
  if (command?.type === 'navigate') return navigateAndCapture(tab, command);
  if (command?.type === 'screenshot') return screenshotActiveTab(tab, command);
  const executor = ['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type) ? executeVerifiedActionCommand : executeBrowserCommand;
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: executor, args: [command] });
  const outcome = result || { ok: false, error: 'Command returned no result.' };
  if (outcome.ok && ['verified_preflight', 'verified_apply', 'verified_verify'].includes(command?.type)) {
    outcome.result = { ...(outcome.result || {}), tabId: tab.id, origin: new URL(tab.url).origin };
  }
  return captureAfterCommand(tab, command, outcome);
}

function scheduleSocketReconnect() { if (socketRetryTimer) return; const delay = Math.min(30_000, 500 * (2 ** socketRetry++)); socketRetryTimer = setTimeout(() => { socketRetryTimer = null; resumeCommandTransport(); }, delay); }
function socketIsOpen(socket = brokerSocket) { return typeof WebSocket !== 'undefined' && socket?.readyState === WebSocket.OPEN; }
async function ensureBrokerSocket() {
  if (typeof WebSocket === 'undefined') return;
  if (socketConnecting || brokerSocket?.readyState === WebSocket.OPEN || brokerSocket?.readyState === WebSocket.CONNECTING) return;
  const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken', HERMES_CONTROL_ENABLED_KEY, COMMAND_RESUME_KEY]);
  if (!settings.brokerToken || settings[HERMES_CONTROL_ENABLED_KEY] !== true || !validateBrokerUrl(settings.brokerUrl)) return;
  const endpoint = websocketEndpointUrl(settings.brokerUrl); if (!endpoint) return;
  socketConnecting = true;
  try {
    const socket = new WebSocket(endpoint); brokerSocket = socket;
    const connectTimeout = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 10_000);
    socket.onopen = async () => { clearTimeout(connectTimeout); socketConnecting = false; socketRetry = 0; const [resumeState, controlState] = await Promise.all([chrome.storage.local.get(COMMAND_RESUME_KEY), chrome.storage.local.get(HERMES_CONTROL_ENABLED_KEY)]); const resume = resumeState[COMMAND_RESUME_KEY] || {}; socket.send(JSON.stringify({ type: 'hello', token: settings.brokerToken, controlEnabled: controlState[HERMES_CONTROL_ENABLED_KEY] === true, extensionVersion: extensionVersion(), lastReceivedSeq: Number(resume.lastReceivedSeq) || 0, lastCompletedSeq: Number(resume.lastCompletedSeq) || 0 })); chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'websocket', at: Date.now() } }); socketKeepaliveTimer = setInterval(async () => { if (socket.readyState === WebSocket.OPEN) { const state = await chrome.storage.local.get(HERMES_CONTROL_ENABLED_KEY); socket.send(JSON.stringify({ type: 'keepalive', controlEnabled: state[HERMES_CONTROL_ENABLED_KEY] === true })); } }, SOCKET_KEEPALIVE_MS); };
    socket.onmessage = (event) => handleBrokerSocketMessage(socket, event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => { clearTimeout(connectTimeout); clearInterval(socketKeepaliveTimer); socketKeepaliveTimer = null; socketConnecting = false; if (brokerSocket === socket) brokerSocket = null; recoverCommandTransport().catch(() => {}); scheduleSocketReconnect(); };
  } catch { socketConnecting = false; recoverCommandTransport().catch(() => {}); scheduleSocketReconnect(); }
}
async function handleBrokerSocketMessage(socket, raw) {
  let message; try { message = JSON.parse(raw); } catch { return; }
  if (message.type !== 'command' || !message.command || !Number.isInteger(message.seq)) return;
  // Receipt is intentionally sent before command execution. It distinguishes a
  // live command consumer from a stale socket that can still carry keepalives.
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'command-received', id: message.command.id, seq: message.seq }));
  const resume = (await chrome.storage.local.get(COMMAND_RESUME_KEY))[COMMAND_RESUME_KEY] || {};
  await chrome.storage.local.set({ [COMMAND_RESUME_KEY]: { lastReceivedSeq: Math.max(Number(resume.lastReceivedSeq) || 0, message.seq), lastCompletedSeq: Number(resume.lastCompletedSeq) || 0 } });
  const outcome = await executeCommandInActiveTab(message.command).catch((error) => ({ ok: false, error: error.message }));
  const current = (await chrome.storage.local.get(COMMAND_RESUME_KEY))[COMMAND_RESUME_KEY] || {};
  await chrome.storage.local.set({ [COMMAND_RESUME_KEY]: { lastReceivedSeq: Math.max(Number(current.lastReceivedSeq) || 0, message.seq), lastCompletedSeq: Math.max(Number(current.lastCompletedSeq) || 0, message.seq) } });
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'result', id: message.command.id, ok: outcome.ok === true, result: outcome.result, error: outcome.error, lastReceivedSeq: Math.max(Number(current.lastReceivedSeq) || 0, message.seq), lastCompletedSeq: Math.max(Number(current.lastCompletedSeq) || 0, message.seq) }));
  else startCommandPolling();
}

if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  // Service-worker termination can close the WebSocket without executing its
  // close handler. A persistent alarm wakes the worker and resumes its
  // authenticated recovery transport without needing the popup to be open.
  chrome.alarms.create(COMMAND_TRANSPORT_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== COMMAND_TRANSPORT_ALARM) return;
    resumeCommandTransport();
  });
}
if (typeof chrome !== 'undefined' && chrome.runtime?.id) resumeCommandTransport();
async function submitCommandResult(settings, command, outcome) {
  await fetch(commandEndpoint(settings.brokerUrl, 'result'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` }, body: JSON.stringify({ id: command.id, ok: outcome.ok === true, result: outcome.result, error: outcome.error }), cache: 'no-store' });
}
async function startCommandPolling() {
  if (commandPolling) return;
  commandPolling = true;
  try {
    while (true) {
      const settings = await chrome.storage.local.get(['brokerUrl', 'brokerToken', HERMES_CONTROL_ENABLED_KEY]);
      if (!settings.brokerToken || !validateBrokerUrl(settings.brokerUrl) || settings[HERMES_CONTROL_ENABLED_KEY] !== true) break;
      if (socketIsOpen()) break;
      let response;
      try { response = await fetch(commandEndpoint(settings.brokerUrl, 'poll'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.brokerToken}` }, body: JSON.stringify({ waitMs: 25_000, controlEnabled: true, extensionVersion: extensionVersion() }), cache: 'no-store' }); } catch {
        await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'failed', at: Date.now() } });
        break;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'failed', at: Date.now() } });
        break;
      }
      await chrome.storage.session.set({ [COMMAND_POLL_HEARTBEAT_KEY]: { state: 'active', at: Date.now() } });
      if (!payload.command) continue;
      const outcome = await executeCommandInActiveTab(payload.command).catch((error) => ({ ok: false, error: error.message }));
      await submitCommandResult(settings, payload.command, outcome).catch(() => {});
    }
  } finally { commandPolling = false; }
}

// An MV3 worker may be suspended after a socket close, losing in-memory retry
// timers. The authenticated long poll is the durable recovery transport until
// a new WSS connection takes over.
export async function recoverCommandTransport() {
  const settings = await chrome.storage.local.get(HERMES_CONTROL_ENABLED_KEY);
  if (settings[HERMES_CONTROL_ENABLED_KEY] !== true || socketIsOpen()) return;
  return startCommandPolling();
}

// Call this on every durable wake, toggle-on, and retry. The authenticated poll
// starts immediately rather than waiting for a WebSocket close callback that an
// MV3 suspension may never run; a healthy WebSocket takes over on its own.
export function resumeCommandTransport() {
  // The offscreen runner is the sole command transport owner. Falling back to
  // this service worker would create competing authenticated sockets after a
  // context restart and can duplicate delivery of a durable queue record.
  return ensureDurableCommandRunner();
}

export async function synthesizeSpeech({ text, voice } = {}) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) {
    return { ok: false, error: 'Empty text provided for speech synthesis' };
  }

  // Look for any customized TTS endpoint in storage, defaulting to local Kokoro server
  let ttsEndpoint = 'http://127.0.0.1:8791/speak';
  let targetVoice = voice || 'af_bella';

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['ttsUrl', 'ttsVoice']);
      if (stored.ttsUrl) ttsEndpoint = stored.ttsUrl;
      if (stored.ttsVoice && !voice) targetVoice = stored.ttsVoice;
    } catch { /* ignore */ }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice: targetVoice }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { ok: false, error: `Kokoro TTS returned ${response.status}: ${errBody.slice(0, 150)}` };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
    return {
      ok: true,
      audioDataUrl: `data:audio/wav;base64,${base64}`,
      voice: targetVoice,
      provider: 'kokoro'
    };
  } catch (error) {
    clearTimeout(timeoutId);
    return { ok: false, error: error.message };
  }
}

export { normalizeBrokerUrl, validateBrokerUrl, chatEndpointUrl };

