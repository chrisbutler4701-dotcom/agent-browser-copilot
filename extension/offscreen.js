// This page intentionally has no page access. It only relays a bounded command
// transport worker to the service worker, which remains the executor.
let runner = null;
let configuredSignature = null;

function relayTransportState(state) {
  chrome.runtime.sendMessage({ type: 'durable-runner-transport-state', state }).catch(() => {});
}

function startRunner(settings) {
  if (!runner) {
    runner = new Worker('command-runner-worker.js', { type: 'module' });
    runner.onmessage = async (event) => {
      const message = event.data || {};
      if (message.type === 'transport-state') return relayTransportState(message.state);
      if (message.type !== 'execute-command') return;
      let outcome = { ok: false, error: 'Command executor did not respond.' };
      try { outcome = await chrome.runtime.sendMessage({ type: 'durable-runner-execute-command', command: message.command }); } catch { /* Do not expose transport details. */ }
      runner?.postMessage({ type: 'command-result', deliveryId: message.deliveryId, outcome });
    };
  }
  const signature = JSON.stringify([settings.brokerUrl, settings.brokerToken, settings.controlEnabled, settings.extensionVersion]);
  if (configuredSignature === signature) return;
  configuredSignature = signature;
  runner.postMessage({ type: 'configure', settings });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'durable-runner-configure') return false;
  if (message.controlEnabled === true && typeof message.brokerUrl === 'string' && typeof message.brokerToken === 'string') {
    startRunner(message);
    sendResponse({ ok: true, ready: true });
  } else {
    runner?.postMessage({ type: 'stop' });
    configuredSignature = null;
    sendResponse({ ok: true, ready: false });
  }
  return false;
});
