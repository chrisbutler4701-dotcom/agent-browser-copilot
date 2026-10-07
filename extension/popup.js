import { normalizeBrokerUrl, validateBrokerUrl } from './service-worker.js';

const status = document.querySelector('#status');
const pageTitle = document.querySelector('#pageTitle');
const captureButton = document.querySelector('#capture');
const brokerUrl = document.querySelector('#brokerUrl');
const saveBroker = document.querySelector('#saveBroker');
const pairCode = document.querySelector('#pairCode');
const pairBrowser = document.querySelector('#pairBrowser');
const resetPairing = document.querySelector('#resetPairing');
const pairStatus = document.querySelector('#pairStatus');
const toggleHermesControl = document.querySelector('#toggleHermesControl');
const armStatus = document.querySelector('#armStatus');
const enableReading = document.querySelector('#enableReading');
const readApproval = document.querySelector('#readApproval');
const restrictSensitiveRead = document.querySelector('#restrictSensitiveRead');
const allowSensitiveRead = document.querySelector('#allowSensitiveRead');
const forgetSensitiveRead = document.querySelector('#forgetSensitiveRead');
const sensitiveReadStatus = document.querySelector('#sensitiveReadStatus');
const readMonitoring = document.querySelector('#readMonitoring');
const verifiedApprovalCard = document.querySelector('#verifiedApprovalCard');
const approvalIntent = document.querySelector('#approvalIntent');
const approvalTarget = document.querySelector('#approvalTarget');
const approvalChanges = document.querySelector('#approvalChanges');
const approvalCommit = document.querySelector('#approvalCommit');
const approveVerifiedAction = document.querySelector('#approveVerifiedAction');
const rejectVerifiedAction = document.querySelector('#rejectVerifiedAction');
const verifiedApprovalStatus = document.querySelector('#verifiedApprovalStatus');
let hermesControlPort = null;
let sensitiveReadRestricted = false;
let pendingVerifiedAction = null;

function ensureHermesControlPort() {
  if (hermesControlPort) return hermesControlPort;
  hermesControlPort = chrome.runtime.connect({ name: 'hermes-control' });
  hermesControlPort.onDisconnect.addListener(() => { hermesControlPort = null; });
  return hermesControlPort;
}

const openSidePanelBtn = document.querySelector('#openSidePanelBtn');
if (openSidePanelBtn) {
  openSidePanelBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (chrome.sidePanel?.open && tab?.id) {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
      }
    } catch (err) {
      console.error('Failed to open side panel:', err);
    }
  });
}

chrome.storage.local.get(['brokerUrl']).then((settings) => { brokerUrl.value = settings.brokerUrl || brokerUrl.defaultValue; });

function showCapture(capture, { stale = false, activeTab = null, unavailable = false } = {}) {
  const restricted = capture?.sensitiveReadRestricted === true || sensitiveReadRestricted;
  readApproval.hidden = !readMonitoring.checked;
  allowSensitiveRead.hidden = !(restricted && capture?.needsApproval);
  forgetSensitiveRead.hidden = !(restricted && capture?.sensitiveReadPersistent);
  sensitiveReadStatus.hidden = !(restricted && capture?.needsApproval);
  if (stale || unavailable) {
    pageTitle.textContent = `${activeTab?.title || 'Current page'} — cannot read`;
    return;
  }
  pageTitle.textContent = capture?.title || 'No page context yet';
}

async function refreshPairStatus() {
  const value = await chrome.runtime.sendMessage({ type: 'broker-status' });
  readMonitoring.checked = value.readMonitoringEnabled !== false;
  readApproval.hidden = !readMonitoring.checked;
  sensitiveReadRestricted = value.sensitiveReadRestricted === true;
  restrictSensitiveRead.checked = sensitiveReadRestricted;
  pairStatus.textContent = value.configured ? (value.paired ? 'Browser paired: read-only watch stays connected in the background.' : 'Broker saved; pair only for first-time setup or recovery.') : 'Broker URL ready — click Save broker URL.';
  const polling = value.pollHeartbeat?.state;
  armStatus.textContent = value.controlEnabled
    ? (polling === 'websocket' ? 'Hermes control is ON. WebSocket command channel active.' : polling === 'active' ? 'Hermes control is ON. Command polling active.' : polling === 'failed' ? 'Hermes control is ON, but command polling could not start.' : 'Hermes control is ON. Starting command polling.')
    : 'Hermes control is OFF.';
  toggleHermesControl.textContent = value.controlEnabled ? 'Turn Hermes control off' : 'Turn Hermes control on';
  if (value.controlEnabled) ensureHermesControlPort();
}

function renderVerifiedAction(transaction) {
  pendingVerifiedAction = transaction || null;
  verifiedApprovalCard.hidden = !transaction;
  approvalChanges.replaceChildren();
  if (!transaction) return;
  approvalIntent.textContent = transaction.proposal?.intent || 'Proposed browser change';
  approvalTarget.textContent = transaction.proposal?.target?.origin || 'Current approved page';
  const locatorText = (locator) => {
    if (locator?.targetText) return `visible text “${locator.targetText}”`;
    if (locator?.selector) return `selector ${locator.selector}`;
    if (locator?.ref) return `page reference ${locator.ref}`;
    return 'unspecified target';
  };
  const steps = transaction.proposal?.target?.operation?.steps || [];
  for (const change of transaction.proposal?.changes || []) {
    const step = steps.find((item) => item.field === change.field);
    const field = document.createElement('dt');
    field.textContent = step ? `${change.field} · ${step.control} · ${locatorText(step.locator)}` : change.field;
    const value = document.createElement('dd');
    value.textContent = change.to === null ? 'null' : String(change.to);
    approvalChanges.append(field, value);
  }
  approvalCommit.textContent = `Final action: ${locatorText(transaction.proposal?.target?.operation?.commit)}`;
  verifiedApprovalStatus.textContent = 'Waiting for your decision.';
}

async function refreshVerifiedActions() {
  const response = await chrome.runtime.sendMessage({ type: 'verified-actions-pending' });
  if (!response?.ok) { renderVerifiedAction(null); return; }
  renderVerifiedAction(response.pending?.[0] || null);
}

async function decidePendingVerifiedAction(decision) {
  if (!pendingVerifiedAction) return;
  approveVerifiedAction.disabled = true;
  rejectVerifiedAction.disabled = true;
  verifiedApprovalStatus.textContent = decision === 'approve' ? 'Binding approval to these exact changes…' : 'Rejecting proposal…';
  const response = await chrome.runtime.sendMessage({
    type: 'verified-action-decision',
    decision,
    transactionId: pendingVerifiedAction.proposal.transactionId,
    proposalHash: pendingVerifiedAction.proposalHash
  });
  verifiedApprovalStatus.textContent = response?.ok ? (decision === 'approve' ? 'Exact changes approved.' : 'Proposal rejected.') : (response?.error || 'Decision was not accepted.');
  approveVerifiedAction.disabled = false;
  rejectVerifiedAction.disabled = false;
  if (response?.ok) await refreshVerifiedActions();
}

async function refreshStatus() {
  const canReadNormalTabs = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  if (!canReadNormalTabs) {
    enableReading.hidden = false;
    status.textContent = 'Enable reading normal tabs once so Hermes can monitor work pages with read-only page context.';
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'capture-status' });
  showCapture(response.capture, response);
  status.textContent = response.capture ? (response.sensitiveReadRestricted ? 'Sensitive reads are restricted; Hermes receives approved page context.' : 'Hermes can read sensitive content by default.') : (response.error || 'Reading is ready when this browser is paired and monitoring is on.');
}

async function openContextReader() {
  const canReadNormalTabs = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  if (!canReadNormalTabs) throw new Error('Normal-page permission is not enabled.');
  const response = await chrome.runtime.sendMessage({ type: 'context-ui-open' });
  if (response?.ok) {
    enableReading.hidden = true;
    showCapture(response.capture);
    status.textContent = response.capture?.sensitiveReadRestricted ? 'Sensitive reads are restricted; monitoring continues after this popup closes unless you turn it off.' : 'Hermes can read sensitive content by default; monitoring continues after this popup closes unless you turn it off.';
  } else if (response?.needsApproval) {
    showCapture(response.capture);
    status.textContent = 'This protected workflow needs redacted-read approval before Hermes can receive page text.';
  } else {
    showCapture(null, { unavailable: true, activeTab: response?.activeTab });
    status.textContent = response?.error || 'Cannot read this page.';
  }
}

saveBroker.addEventListener('click', async () => {
  const url = normalizeBrokerUrl(brokerUrl.value.trim());
  if (url && !validateBrokerUrl(url)) {
    status.textContent = 'Broker URL must be the approved B2 ingest URL or an approved loopback broker URL.';
    return;
  }
  brokerUrl.value = url;
  await chrome.storage.local.set({ brokerUrl: url });
  status.textContent = url ? 'Broker URL saved. Pair once to connect Hermes.' : 'Broker disabled.';
  await refreshPairStatus();
});

pairBrowser.addEventListener('click', async () => {
  const url = normalizeBrokerUrl(brokerUrl.value.trim());
  brokerUrl.value = url;
  const code = pairCode.value.trim().toUpperCase();
  pairCode.value = '';
  pairBrowser.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'pair-browser', brokerUrl: url, code });
  pairStatus.textContent = response.ok ? 'Browser paired. Read-only watch now reconnects in the background.' : `Pairing unavailable: ${response.error}`;
  pairBrowser.disabled = false;
});

resetPairing.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reset-pairing' });
  pairStatus.textContent = 'Browser unpaired.';
  armStatus.textContent = 'Hermes control is OFF.';
  toggleHermesControl.textContent = 'Turn Hermes control on';
});

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  status.textContent = 'Refreshing read-only page context…';
  const response = await chrome.runtime.sendMessage({ type: 'capture-active-tab' });
  if (response.ok) {
    showCapture(response.capture);
    status.textContent = response.sent ? 'Read-only context refreshed and delivered to Hermes.' : 'Read-only context refreshed. Pair the browser to deliver it to Hermes.';
  } else status.textContent = `Capture unavailable: ${response.error}`;
  captureButton.disabled = false;
});

toggleHermesControl.addEventListener('click', async () => {
  toggleHermesControl.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'toggle-hermes-control' });
  if (response.ok) {
    armStatus.textContent = response.enabled ? 'Hermes control is ON. Starting command polling.' : 'Hermes control is OFF.';
    toggleHermesControl.textContent = response.enabled ? 'Turn Hermes control off' : 'Turn Hermes control on';
    if (response.enabled) ensureHermesControlPort();
  } else armStatus.textContent = `Control unchanged: ${response.error}`;
  toggleHermesControl.disabled = false;
});

enableReading.addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  if (!granted) { status.textContent = 'Reading normal tabs was not enabled. You can still refresh pages Edge allows.'; return; }
  await openContextReader();
});
allowSensitiveRead.addEventListener('click', async () => {
  allowSensitiveRead.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'approve-sensitive-read-origin' });
  if (response.ok) { showCapture(response.capture); status.textContent = 'Sensitive reads are allowed for this site while restriction is on.'; }
  else status.textContent = response.error || 'Could not allow sensitive reads for this site.';
  allowSensitiveRead.disabled = false;
});
restrictSensitiveRead.addEventListener('change', async () => {
  restrictSensitiveRead.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'set-sensitive-read-restricted', restricted: restrictSensitiveRead.checked });
  if (response.ok) {
    sensitiveReadRestricted = response.sensitiveReadRestricted === true;
    restrictSensitiveRead.checked = sensitiveReadRestricted;
    status.textContent = sensitiveReadRestricted ? 'Sensitive reads are restricted and require per-site approval.' : 'Hermes can read sensitive content by default.';
    await openContextReader();
  } else {
    status.textContent = response.error || 'Could not update sensitive read restriction.';
    restrictSensitiveRead.checked = sensitiveReadRestricted;
  }
  restrictSensitiveRead.disabled = false;
});
readMonitoring.addEventListener('change', async () => {
  readMonitoring.disabled = true;
  readApproval.hidden = !readMonitoring.checked;
  const response = await chrome.runtime.sendMessage({ type: 'set-read-monitoring', enabled: readMonitoring.checked });
  if (response.ok) status.textContent = response.enabled ? 'Read monitoring is ON. Hermes can read visible text on work pages.' : 'Read monitoring is OFF. You can still refresh a page manually.';
  else status.textContent = response.error || 'Could not update read monitoring.';
  readMonitoring.checked = response.enabled !== false;
  readApproval.hidden = !readMonitoring.checked;
  readMonitoring.disabled = false;
});
forgetSensitiveRead.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'forget-sensitive-read-origin' });
  if (response.ok) { showCapture(response.capture); status.textContent = 'Sensitive read access removed for this site while restriction is on.'; }
  else status.textContent = response.error || 'Could not forget sensitive read access.';
});
approveVerifiedAction.addEventListener('click', () => decidePendingVerifiedAction('approve'));
rejectVerifiedAction.addEventListener('click', () => decidePendingVerifiedAction('reject'));

chrome.runtime.onMessage.addListener((event) => {
  if (event.type !== 'context-capture-updated') return false;
  if (event.reading) { pageTitle.textContent = 'Reading current page…'; status.textContent = 'Refreshing read-only page context…'; }
  else if (event.ok) { showCapture(event.capture); status.textContent = 'Read-only context is ready for Hermes.'; }
  else { showCapture(null, { unavailable: true, activeTab: event.activeTab }); status.textContent = event.error || 'Cannot read this page.'; }
  return false;
});

openContextReader().catch(async () => {
  enableReading.hidden = false;
  status.textContent = 'Enable reading normal tabs once so Hermes can use read-only page context.';
  await refreshStatus();
});
refreshPairStatus();
refreshVerifiedActions().catch(() => renderVerifiedAction(null));
window.setInterval(refreshPairStatus, 5_000);
window.setInterval(() => refreshVerifiedActions().catch(() => renderVerifiedAction(null)), 5_000);
window.addEventListener('unload', () => { chrome.runtime.sendMessage({ type: 'context-ui-closed' }).catch(() => {}); });
