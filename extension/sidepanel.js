// Hermes Side Panel Chat & Control Client
const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const controlToggle = document.getElementById('control-toggle');
const statusDot = document.getElementById('status-dot');
const pairingBanner = document.getElementById('pairing-banner');
const pairCodeInput = document.getElementById('pair-code-input');
const pairBtn = document.getElementById('pair-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const chips = document.querySelectorAll('.chip');
const typingIndicator = document.getElementById('typing-indicator');
const dropOverlay = document.getElementById('drop-overlay');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachmentTray = document.getElementById('attachment-tray');
const micBtn = document.getElementById('mic-btn');
const charCounter = document.getElementById('char-counter');
const toastEl = document.getElementById('toast');

let isSending = false;
let attachedFiles = []; // Array of { name, size, type, dataUrl, textContent }
let currentlySpeakingBtn = null;
let speechUtterance = null;
let speechRecognizer = null;
let isRecognizing = false;

// ---------------------------------------------------------------------------
// Toast Notification
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(text, duration = 2200) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, duration);
}

let currentSpeechAudio = null;
let speechGenerationId = 0;

// ---------------------------------------------------------------------------
// Speech Synthesis (Text-to-Speech / "Listen" via Kokoro TTS)
// ---------------------------------------------------------------------------
function stopSpeech() {
  speechGenerationId += 1;
  if (currentSpeechAudio) {
    try {
      currentSpeechAudio.pause();
      currentSpeechAudio.currentTime = 0;
      currentSpeechAudio.src = '';
    } catch { /* ignore */ }
    currentSpeechAudio = null;
  }
  if (window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch { /* ignore */ }
  }
  if (currentlySpeakingBtn) {
    resetListenButton(currentlySpeakingBtn);
    currentlySpeakingBtn = null;
  }
  speechUtterance = null;
}

function resetListenButton(btn) {
  btn.classList.remove('speaking');
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    </svg>
    <span>Listen</span>
  `;
}

function setLoadingButton(btn) {
  btn.classList.add('speaking');
  btn.innerHTML = `
    <span class="audio-wave">
      <span class="audio-bar" style="animation-duration: 0.5s;"></span>
      <span class="audio-bar" style="animation-duration: 0.5s;"></span>
      <span class="audio-bar" style="animation-duration: 0.5s;"></span>
    </span>
    <span>Voice...</span>
  `;
}

function setSpeakingButton(btn) {
  btn.classList.add('speaking');
  btn.innerHTML = `
    <span class="audio-wave">
      <span class="audio-bar"></span>
      <span class="audio-bar"></span>
      <span class="audio-bar"></span>
    </span>
    <span>Stop</span>
  `;
}

function cleanTextForSpeech(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, ' [code snippet omitted] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[-*•→►▸]/g, ' ')
    .replace(/[#_~><]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTextIntoSpeechChunks(text, maxChars = 200) {
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return [];
  const rawSentences = cleaned
    .replace(/([.?!;:])\s+/g, '$1\n')
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  const chunks = [];
  let currentChunk = '';
  for (const sentence of rawSentences) {
    if ((currentChunk + ' ' + sentence).trim().length <= maxChars) {
      currentChunk = currentChunk ? (currentChunk + ' ' + sentence) : sentence;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      if (sentence.length > maxChars) {
        const words = sentence.split(' ');
        let sub = '';
        for (const word of words) {
          if ((sub + ' ' + word).trim().length <= maxChars) {
            sub = sub ? (sub + ' ' + word) : word;
          } else {
            if (sub) chunks.push(sub);
            sub = word;
          }
        }
        currentChunk = sub;
      } else {
        currentChunk = sentence;
      }
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

async function fetchSpeechAudio(textChunk) {
  if (!textChunk || !textChunk.trim()) return null;
  try {
    return await new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'synthesize-speech', text: textChunk, voice: 'af_bella' },
          (res) => {
            if (chrome.runtime?.lastError) {
              resolve(null);
            } else if (res?.ok && res.audioDataUrl) {
              resolve(res.audioDataUrl);
            } else {
              resolve(null);
            }
          }
        );
      } else {
        fetch('http://127.0.0.1:8791/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: textChunk, voice: 'af_bella' })
        })
          .then(async (r) => {
            if (!r.ok) return resolve(null);
            const blob = await r.blob();
            resolve(URL.createObjectURL(blob));
          })
          .catch(() => resolve(null));
      }
    });
  } catch {
    return null;
  }
}

async function toggleListen(btn, rawText) {
  // If clicking on the currently speaking/loading button, stop it
  if (currentlySpeakingBtn === btn) {
    stopSpeech();
    return;
  }

  // Stop any other active speech
  stopSpeech();

  const currentGen = ++speechGenerationId;
  const chunks = splitTextIntoSpeechChunks(rawText);
  if (!chunks.length) {
    showToast('No readable text to speak.');
    return;
  }

  currentlySpeakingBtn = btn;
  setLoadingButton(btn);

  // Synchronously play a tiny silent sound to ensure autoplay activation for the sidepanel document
  try {
    const unlock = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
    unlock.volume = 0.01;
    unlock.play().catch(() => {});
  } catch { /* ignore */ }

  try {
    // Pipeline: start fetching Chunk 0 immediately
    let nextAudioPromise = fetchSpeechAudio(chunks[0]);

    for (let i = 0; i < chunks.length; i++) {
      if (currentGen !== speechGenerationId) break;

      const audioDataUrl = await nextAudioPromise;
      if (currentGen !== speechGenerationId) break;

      if (!audioDataUrl) {
        // If the very first chunk fails, fallback to browser speech synthesis
        if (i === 0) {
          console.warn('Kokoro TTS unavailable for first chunk, using browser fallback');
          fallbackBrowserSpeech(btn, cleanTextForSpeech(rawText));
        }
        break;
      }

      // Pre-fetch next chunk while current chunk plays
      if (i + 1 < chunks.length) {
        nextAudioPromise = fetchSpeechAudio(chunks[i + 1]);
      } else {
        nextAudioPromise = Promise.resolve(null);
      }

      // Play current audio chunk
      const audio = new Audio(audioDataUrl);
      currentSpeechAudio = audio;
      setSpeakingButton(btn);

      await new Promise((resolve) => {
        audio.onended = () => {
          if (currentSpeechAudio === audio) currentSpeechAudio = null;
          resolve();
        };
        audio.onerror = (e) => {
          console.warn('Audio playback error on chunk', i, e);
          if (currentSpeechAudio === audio) currentSpeechAudio = null;
          resolve();
        };
        audio.play().catch((err) => {
          console.warn('audio.play() rejected:', err);
          if (currentSpeechAudio === audio) currentSpeechAudio = null;
          resolve();
        });
      });

      if (currentGen !== speechGenerationId) break;
    }
  } catch (err) {
    console.warn('Speech playback loop error:', err);
  } finally {
    if (currentGen === speechGenerationId) {
      stopSpeech();
    }
  }
}

function fallbackBrowserSpeech(btn, spokenText) {
  if (!('speechSynthesis' in window)) {
    showToast('Speech synthesis not supported in this browser.');
    stopSpeech();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(spokenText);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const preferredVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha')));
  if (preferredVoice) utterance.voice = preferredVoice;

  utterance.onend = () => {
    if (currentlySpeakingBtn === btn) {
      resetListenButton(btn);
      currentlySpeakingBtn = null;
    }
    speechUtterance = null;
  };

  utterance.onerror = (e) => {
    if (e.error !== 'canceled' && e.error !== 'interrupted') {
      console.warn('Speech error:', e);
    }
    if (currentlySpeakingBtn === btn) {
      resetListenButton(btn);
      currentlySpeakingBtn = null;
    }
    speechUtterance = null;
  };

  currentlySpeakingBtn = btn;
  speechUtterance = utterance;
  setSpeakingButton(btn);
  window.speechSynthesis.speak(utterance);
}

// ---------------------------------------------------------------------------
// Speech Recognition (Voice Input / Dictation)
// ---------------------------------------------------------------------------
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.style.opacity = '0.5';
    micBtn.title = 'Speech recognition not supported in this environment';
    return;
  }

  try {
    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = false;
    speechRecognizer.interimResults = true;
    speechRecognizer.lang = 'en-US';

    speechRecognizer.onstart = () => {
      isRecognizing = true;
      micBtn.classList.add('recording');
      micBtn.title = 'Listening... Click to stop';
      showToast('🎤 Listening...');
    };

    speechRecognizer.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      const text = finalTranscript || interimTranscript;
      if (text) {
        const current = chatInput.value;
        const separator = current.length > 0 && !current.endsWith(' ') ? ' ' : '';
        chatInput.value = current + separator + text;
        autoResizeTextarea();
      }
    };

    speechRecognizer.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      isRecognizing = false;
      micBtn.classList.remove('recording');
      micBtn.title = 'Dictate message (Speech-to-Text)';
      if (event.error === 'not-allowed') {
        showToast('Microphone access denied.');
      } else if (event.error !== 'no-speech') {
        showToast(`Voice error: ${event.error}`);
      }
    };

    speechRecognizer.onend = () => {
      isRecognizing = false;
      micBtn.classList.remove('recording');
      micBtn.title = 'Dictate message (Speech-to-Text)';
    };
  } catch (err) {
    console.warn('Speech recognition init failed:', err);
  }
}

if (micBtn) {
  initSpeechRecognition();
  micBtn.addEventListener('click', () => {
    if (!speechRecognizer) {
      showToast('Speech recognition not available.');
      return;
    }
    if (isRecognizing) {
      speechRecognizer.stop();
    } else {
      try {
        speechRecognizer.start();
      } catch (err) {
        console.warn('Error starting speech:', err);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Copy Utility
// ---------------------------------------------------------------------------
async function copyToClipboard(text, btnElement = null) {
  try {
    await navigator.clipboard.writeText(text);
    if (btnElement) {
      const originalHTML = btnElement.innerHTML;
      btnElement.classList.add('copied');
      btnElement.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Copied!</span>
      `;
      setTimeout(() => {
        btnElement.classList.remove('copied');
        btnElement.innerHTML = originalHTML;
      }, 2000);
    }
    showToast('Copied to clipboard!');
  } catch (err) {
    console.error('Clipboard copy failed:', err);
    showToast('Failed to copy to clipboard.');
  }
}

// ---------------------------------------------------------------------------
// Markdown & Content Renderer
// ---------------------------------------------------------------------------
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderMarkdown(rawText) {
  if (!rawText) return document.createDocumentFragment();

  const container = document.createElement('div');
  container.className = 'msg-content';

  // Extract fenced code blocks first
  const codeBlocks = [];
  let processed = rawText.replace(/```([a-zA-Z0-9_\-\.]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang.trim() || 'code', code: code.replace(/\n$/, '') });
    return `__CODE_BLOCK_${idx}__`;
  });

  // Paragraphs
  const paragraphs = processed.split(/\n{2,}/);

  paragraphs.forEach(para => {
    if (para.includes('__CODE_BLOCK_')) {
      const parts = para.split(/(__CODE_BLOCK_\d+__)/);
      parts.forEach(part => {
        const match = part.match(/__CODE_BLOCK_(\d+)__/);
        if (match) {
          const block = codeBlocks[parseInt(match[1], 10)];
          if (block) {
            const blockWrap = document.createElement('div');
            blockWrap.className = 'code-block-wrapper';

            const header = document.createElement('div');
            header.className = 'code-block-header';
            header.innerHTML = `<span>${escapeHTML(block.lang)}</span>`;

            const copyBtn = document.createElement('button');
            copyBtn.className = 'code-copy-btn';
            copyBtn.innerHTML = `
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            `;
            copyBtn.onclick = () => copyToClipboard(block.code, copyBtn);
            header.appendChild(copyBtn);

            const pre = document.createElement('pre');
            pre.className = 'code-block-pre';
            pre.textContent = block.code;

            blockWrap.appendChild(header);
            blockWrap.appendChild(pre);
            container.appendChild(blockWrap);
          }
        } else if (part.trim()) {
          const p = document.createElement('p');
          p.innerHTML = formatInlineMarkdown(part);
          container.appendChild(p);
        }
      });
    } else {
      const p = document.createElement('p');
      p.innerHTML = formatInlineMarkdown(para);
      container.appendChild(p);
    }
  });

  return container;
}

function formatInlineMarkdown(text) {
  let s = escapeHTML(text);

  // Bold **text**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline code `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Convert newlines within paragraph to <br>
  s = s.replace(/\n/g, '<br>');

  return s;
}

// ---------------------------------------------------------------------------
// Append Message to Chat
// ---------------------------------------------------------------------------
function appendMessage(text, role, meta = null, userAttachments = []) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper msg-${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Agent Message Header & Active Tab Badge
  if (role === 'agent') {
    const agentHeader = document.createElement('div');
    agentHeader.className = 'msg-agent-header';

    const author = document.createElement('div');
    author.className = 'msg-agent-author';
    author.innerHTML = `<span class="msg-agent-author-dot"></span><span>Hermes Agent</span>`;
    agentHeader.appendChild(author);

    if (meta?.title) {
      const badge = document.createElement('div');
      badge.className = 'context-badge';
      badge.title = `${meta.title} (${meta.url || ''})`;
      badge.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span>${escapeHTML(meta.title.slice(0, 32))}${meta.title.length > 32 ? '…' : ''}</span>
      `;
      agentHeader.appendChild(badge);
    }
    bubble.appendChild(agentHeader);
  }

  // Body content
  if (role === 'agent') {
    bubble.appendChild(renderMarkdown(text));
  } else {
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.style.whiteSpace = 'pre-wrap';
    content.textContent = text;
    bubble.appendChild(content);

    // If user attached files to this message, display attachment chips
    if (userAttachments && userAttachments.length > 0) {
      const attachBox = document.createElement('div');
      attachBox.className = 'msg-attachments';
      userAttachments.forEach(att => {
        const item = document.createElement('div');
        item.className = 'msg-attachment-item';
        if (att.dataUrl && att.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = att.dataUrl;
          img.className = 'msg-attachment-thumb';
          item.appendChild(img);
        } else {
          item.innerHTML = `
            <svg class="msg-attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
          `;
        }
        const nameSpan = document.createElement('span');
        nameSpan.textContent = att.name;
        item.appendChild(nameSpan);
        attachBox.appendChild(item);
      });
      bubble.appendChild(attachBox);
    }
  }

  wrapper.appendChild(bubble);

  // Message Actions (Copy & Listen)
  if (role === 'agent' || role === 'user') {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Copy Button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn copy-btn';
    copyBtn.title = 'Copy message text';
    copyBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy</span>
    `;
    copyBtn.onclick = () => copyToClipboard(text, copyBtn);
    actions.appendChild(copyBtn);

    // Listen Button (Text-to-Speech, for Agent)
    if (role === 'agent') {
      const listenBtn = document.createElement('button');
      listenBtn.className = 'msg-action-btn listen-btn';
      listenBtn.title = 'Listen to response';
      resetListenButton(listenBtn);
      listenBtn.onclick = () => toggleListen(listenBtn, text);
      actions.appendChild(listenBtn);
    }

    wrapper.appendChild(actions);
  }

  // Insert before typing indicator
  chatContainer.insertBefore(wrapper, typingIndicator);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return wrapper;
}

// ---------------------------------------------------------------------------
// Attachment Management
// ---------------------------------------------------------------------------
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachmentTray() {
  if (!attachmentTray) return;
  attachmentTray.innerHTML = '';

  if (attachedFiles.length === 0) {
    attachmentTray.classList.remove('has-items');
    return;
  }

  attachmentTray.classList.add('has-items');

  attachedFiles.forEach((fileObj, idx) => {
    const chip = document.createElement('div');
    chip.className = 'tray-chip';

    if (fileObj.dataUrl && fileObj.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = fileObj.dataUrl;
      img.className = 'tray-thumb';
      chip.appendChild(img);
    } else {
      const ext = fileObj.name.split('.').pop().toUpperCase().slice(0, 4) || 'FILE';
      const badge = document.createElement('span');
      badge.style.fontSize = '9px';
      badge.style.fontWeight = '700';
      badge.style.color = '#38bdf8';
      badge.textContent = ext;
      chip.appendChild(badge);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tray-chip-name';
    nameSpan.title = `${fileObj.name} (${formatFileSize(fileObj.size)})`;
    nameSpan.textContent = fileObj.name;
    chip.appendChild(nameSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tray-chip-remove';
    removeBtn.title = 'Remove attachment';
    removeBtn.innerHTML = '&times;';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      attachedFiles.splice(idx, 1);
      renderAttachmentTray();
    };
    chip.appendChild(removeBtn);

    attachmentTray.appendChild(chip);
  });
}

async function processIncomingFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB

  for (const file of Array.from(fileList)) {
    if (attachedFiles.length >= MAX_FILES) {
      showToast(`Maximum ${MAX_FILES} attachments allowed.`);
      break;
    }

    if (file.size > MAX_FILE_SIZE) {
      showToast(`${file.name} is too large (max 4MB).`);
      continue;
    }

    // Read content
    if (file.type.startsWith('image/')) {
      const dataUrl = await new Promise((res) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result);
        reader.readAsDataURL(file);
      });
      attachedFiles.push({
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl,
        textContent: null
      });
    } else {
      const textContent = await new Promise((res) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result);
        reader.readAsText(file);
      });
      attachedFiles.push({
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: null,
        textContent: textContent.slice(0, 30000) // safety truncate
      });
    }
  }

  renderAttachmentTray();
}

// Attachment button & file input
if (attachBtn && fileInput) {
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    processIncomingFiles(fileInput.files);
    fileInput.value = '';
  });
}

// Drag & Drop
if (chatContainer && dropOverlay) {
  let dragDepth = 0;
  chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.add('active');
  });

  chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      dropOverlay.classList.remove('active');
    }
  });

  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  chatContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('active');
    if (e.dataTransfer?.files?.length) {
      processIncomingFiles(e.dataTransfer.files);
    }
  });
}

// Paste support
document.addEventListener('paste', (e) => {
  if (e.clipboardData?.files?.length) {
    processIncomingFiles(e.clipboardData.files);
  }
});

// ---------------------------------------------------------------------------
// Textarea Auto-Resize & Character Counter
// ---------------------------------------------------------------------------
function autoResizeTextarea() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';

  const len = chatInput.value.length;
  if (charCounter) {
    if (len > 6000) {
      charCounter.textContent = `${len}/8000`;
      charCounter.style.color = len > 7500 ? 'var(--danger)' : 'var(--amber)';
    } else {
      charCounter.textContent = '';
    }
  }
}

chatInput.addEventListener('input', autoResizeTextarea);

// ---------------------------------------------------------------------------
// Broker Status & Control Toggle
// ---------------------------------------------------------------------------
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
      showToast(res?.error || 'Pairing failed.');
    }
  } catch (err) {
    showToast(`Pairing error: ${err.message}`);
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = 'Pair';
  }
});

// Control toggle
controlToggle.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'toggle-hermes-control' });
    await updateState();
  } catch (err) {
    console.error('Error toggling control:', err);
  }
});

// Clear Chat
clearChatBtn.addEventListener('click', () => {
  stopSpeech();
  const messages = chatContainer.querySelectorAll('.msg-wrapper:not(.msg-system)');
  messages.forEach(m => m.remove());
  showToast('Chat cleared');
});

// ---------------------------------------------------------------------------
// Send Chat Message
// ---------------------------------------------------------------------------
async function sendChatMessage(text) {
  const clean = text.trim();
  const hasAttachments = attachedFiles.length > 0;

  if ((!clean && !hasAttachments) || isSending) return;

  isSending = true;
  chatInput.value = '';
  autoResizeTextarea();
  sendBtn.disabled = true;

  // Snapshot current attachments for this message
  const sendingAttachments = [...attachedFiles];
  attachedFiles = [];
  renderAttachmentTray();

  // Construct message text to send to Hermes
  let fullMessage = clean;
  if (sendingAttachments.length > 0) {
    const attachmentSummaries = [];
    sendingAttachments.forEach(att => {
      if (att.textContent) {
        attachmentSummaries.push(
          `[Attached file: ${att.name} (${formatFileSize(att.size)})]\n\`\`\`\n${att.textContent.slice(0, 3500)}\n\`\`\``
        );
      } else {
        attachmentSummaries.push(
          `[Attached image: ${att.name} (${formatFileSize(att.size)})]`
        );
      }
    });

    const attachmentBlock = attachmentSummaries.join('\n\n');
    fullMessage = fullMessage
      ? `${attachmentBlock}\n\n${fullMessage}`
      : attachmentBlock;
  }

  // Append user message bubble with attachment chips
  appendMessage(clean || `[Attached ${sendingAttachments.length} file(s)]`, 'user', null, sendingAttachments);

  // Show typing indicator
  typingIndicator.classList.add('active');
  chatContainer.scrollTop = chatContainer.scrollHeight;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'send-chat',
      message: fullMessage.slice(0, 7800) // keep within 8k safety limit
    });

    typingIndicator.classList.remove('active');

    if (response?.ok && response?.response) {
      appendMessage(response.response, 'agent', response.capture);
    } else {
      appendMessage(`Error: ${response?.error || 'No response from Hermes.'}`, 'system');
    }
  } catch (err) {
    typingIndicator.classList.remove('active');
    appendMessage(`Failed to reach Hermes: ${err.message}`, 'system');
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    await checkPendingVerifiedActions();
  }
}

sendBtn.addEventListener('click', () => sendChatMessage(chatInput.value));

// IME-safe Enter-to-Submit
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();

    // IME composition check to prevent premature submission
    if (e.isComposing || e.keyCode === 229) {
      return;
    }

    sendChatMessage(chatInput.value);
  }
});

// Quick action chips
chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-text');
    if (prompt) sendChatMessage(prompt);
  });
});

// ---------------------------------------------------------------------------
// Verified Action Cards
// ---------------------------------------------------------------------------
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
  title.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>
    <span>Hermes Proposed Action: ${escapeHTML(tx.proposal?.intent || 'Change in page')}</span>
  `;
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

  chatContainer.insertBefore(card, typingIndicator);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Initial status & periodic polling
updateState();
setInterval(updateState, 8000);
