const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const controlToggle = document.getElementById('control-toggle');
const statusDot = document.getElementById('status-dot');
const pairingBanner = document.getElementById('pairing-banner');
const pairCodeInput = document.getElementById('pair-code-input');
const pairBtn = document.getElementById('pair-btn');
const chips = document.querySelectorAll('.chip');

let isSending = false;

function appendMessage(text, role, meta = null) {
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;

  if (role === 'agent' && meta?.title) {
    const badge = document.createElement('div');
    badge.className = 'context-badge';
    badge.textContent = `📌 ${meta.title.slice(0, 45)} (${meta.url || ''})`;
    div.appendChild(badge);
  }

  const contentSpan = document.createElement('div');
  contentSpan.style.whiteSpace = 'pre-wrap';
  contentSpan.textContent = text;
  div.appendChild(contentSpan);

  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

async function updateState() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'broker-status' });
    if (!status) return;

    if (status.paired) {
      pairingBanner.classList.add('hidden');
      statusDot.classList.add('connected');
      statusDot.title = 'Paired & Connected to twinbrowser.bbos.tech';
    } else {
      pairingBanner.classList.remove('hidden');
      statusDot.classList.remove('connected');
      statusDot.title = 'Browser is not paired with Hermes';
    }

    if (status.controlEnabled) {
      controlToggle.classList.add('active');
      controlToggle.textContent = 'Control: ON';
    } else {
      controlToggle.classList.remove('active');
      controlToggle.textContent = 'Control: OFF';
    }

    await checkPendingVerifiedActions();
  } catch (err) {
    console.error('Failed to read broker status:', err);
  }
}

// Pairing
pairBtn.addEventListener('click', async () => {
  const code = pairCodeInput.value.trim().toUpperCase();
  if (!code) return;

  pairBtn.disabled = true;
  pairBtn.textContent = 'Pairing...';

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'pair-browser',
      brokerUrl: 'https://twinbrowser.bbos.tech/work-edge/ingest',
      code
    });
    if (res?.ok) {
      pairCodeInput.value = '';
      appendMessage('Browser paired successfully! Hermes can now interact with this workstation.', 'system');
      await updateState();
    } else {
      alert(res?.error || 'Pairing failed. Please verify your one-time pairing code.');
    }
  } catch (err) {
    alert(`Pairing error: ${err.message}`);
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = 'Pair';
  }
});

// Control toggle
controlToggle.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'toggle-hermes-control' });
    await updateState();
  } catch (err) {
    console.error('Error toggling control:', err);
  }
});

// Chat Send
async function sendChatMessage(text) {
  const clean = text.trim();
  if (!clean || isSending) return;

  isSending = true;
  chatInput.value = '';
  sendBtn.disabled = true;
  sendBtn.textContent = '...';

  appendMessage(clean, 'user');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'send-chat',
      message: clean
    });

    if (response?.ok && response?.response) {
      appendMessage(response.response, 'agent', response.capture);
    } else {
      appendMessage(`Error: ${response?.error || 'No response from Hermes.'}`, 'system');
    }
  } catch (err) {
    appendMessage(`Failed to reach Hermes: ${err.message}`, 'system');
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    await checkPendingVerifiedActions();
  }
}

sendBtn.addEventListener('click', () => sendChatMessage(chatInput.value));
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage(chatInput.value);
  }
});

chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-text');
    if (prompt) sendChatMessage(prompt);
  });
});

// Verified Action Cards
async function checkPendingVerifiedActions() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'verified-actions-pending' });
    if (!res?.ok || !res.pending?.length) return;

    for (const transaction of res.pending) {
      renderVerifiedCard(transaction);
    }
  } catch (err) {
    // Ignore if not supported
  }
}

function renderVerifiedCard(tx) {
  const existing = document.getElementById(`tx-${tx.id}`);
  if (existing) return;

  const card = document.createElement('div');
  card.id = `tx-${tx.id}`;
  card.className = 'verified-card';

  const title = document.createElement('div');
  title.className = 'verified-title';
  title.textContent = `⚡ Hermes Proposed Action: ${tx.proposal?.intent || 'Change in page'}`;
  card.appendChild(title);

  const changes = document.createElement('div');
  changes.className = 'verified-changes';
  const list = (tx.proposal?.changes || []).map(c => `${c.field}: "${c.to}"`).join('\n');
  changes.textContent = list || 'Inspect & commit operation';
  card.appendChild(changes);

  const btnRow = document.createElement('div');
  btnRow.className = 'verified-buttons';

  const approve = document.createElement('button');
  approve.className = 'btn-approve';
  approve.textContent = '✓ Approve Exact Changes';
    approve.onclick = async () => {
    btnRow.remove();
    await chrome.runtime.sendMessage({
      type: 'verified-action-decision',
      decision: 'approve',
      transactionId: tx.proposal?.transactionId || tx.id,
      proposalHash: tx.proposalHash
    }).catch(() => {});
    changes.textContent += '\n(Approved - committing...)';
  };

  const reject = document.createElement('button');
  reject.className = 'btn-reject';
  reject.textContent = '✕ Reject';
  reject.onclick = async () => {
    btnRow.remove();
    await chrome.runtime.sendMessage({
      type: 'verified-action-decision',
      decision: 'reject',
      transactionId: tx.proposal?.transactionId || tx.id,
      proposalHash: tx.proposalHash
    }).catch(() => {});
    changes.textContent += '\n(Rejected by user)';
  };

  btnRow.appendChild(approve);
  btnRow.appendChild(reject);
  card.appendChild(btnRow);

  chatContainer.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Initial status & periodic polling
updateState();
setInterval(updateState, 8000);
