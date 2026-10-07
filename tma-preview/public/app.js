(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const statusPill = $('#status-pill');
  const statusText = $('#status-text');
  const tabOrigin = $('#tab-origin');
  const tabAge = $('#tab-age');
  const tabTitle = $('#tab-title');
  const metaCapture = $('#meta-capture');
  const metaWatch = $('#meta-watch');
  const metaTransport = $('#meta-transport');
  const screenImg = $('#screen-img');
  const stagePlaceholder = $('#stage-placeholder');
  const placeholderMsg = $('#placeholder-msg');
  const capturedTime = $('#captured-time');
  const refreshRateSelect = $('#refresh-rate');
  const btnRefresh = $('#btn-refresh');
  const btnSnapNow = $('#btn-snap-now');
  const btnRefreshText = $('#btn-refresh-text');
  const btnRefreshElements = $('#btn-refresh-elements');
  const elementsTabBadge = $('#elements-tab-badge');
  const pageTextContent = $('#page-text-content');
  const elementList = $('#element-list');
  const toast = $('#toast');

  let autoRefreshTimer = null;
  let isFetching = false;
  let lastCapturedIso = null;

  function haptic(type = 'light') {
    try {
      if (tg?.HapticFeedback) {
        if (type === 'success' || type === 'warning' || type === 'error') {
          tg.HapticFeedback.notificationOccurred(type);
        } else {
          tg.HapticFeedback.impactOccurred(type);
        }
      }
    } catch {}
  }

  function showToast(msg, duration = 2500) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  const API_BASE = window.location.pathname.replace(/\/+$/, '');

  async function api(path, options = {}) {
    const cleanPath = path.replace(/^\/+/, '');
    const url = `${API_BASE}/${cleanPath}`;
    const headers = { ...(options.headers || {}) };
    if (tg?.initData) headers['x-tg-init-data'] = tg.initData;
    return await fetch(url, { ...options, headers });
  }

  function switchTab(tabName) {
    $$('.view-tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => p.classList.remove('active'));
    const btn = $(`[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('active');
    const targetPane = $(`#pane-${tabName}`);
    if (targetPane) targetPane.classList.add('active');

    if (tabName === 'preview') loadScreenshot();
    if (tabName === 'text') loadPageSnapshot();
    if (tabName === 'elements') loadPageElements();
  }

  $$('.view-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic('light');
      switchTab(btn.dataset.tab);
    });
  });

  async function refreshStatus() {
    try {
      const res = await api('api/status');
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json();

      if (data.connected) {
        statusPill.className = 'status-pill connected';
        statusText.textContent = 'Extension Live';
        metaTransport.textContent = 'Extension: Live';
      } else {
        statusPill.className = 'status-pill disconnected';
        statusText.textContent = data.configured ? 'Extension Idle' : 'Not Paired';
        metaTransport.textContent = data.configured ? 'Extension: Idle' : 'Not Paired';
      }

      metaCapture.textContent = `Capture: ${data.capture || 'available'}`;
      metaWatch.textContent = `Watch: ${data.watchMode || 'active'}`;

      if (data.activeTab && typeof data.activeTab === 'object') {
        tabTitle.textContent = data.activeTab.title || 'Untitled Tab';
        tabOrigin.textContent = data.activeTab.url || 'Webpage';
        if (data.activeTab.capturedAt) {
          lastCapturedIso = new Date(data.activeTab.capturedAt);
          updateAgeDisplay();
        }
      } else {
        tabTitle.textContent = 'Awaiting active tab...';
        tabOrigin.textContent = 'Awaiting activity';
      }
    } catch (err) {
      statusPill.className = 'status-pill disconnected';
      statusText.textContent = 'Offline';
    }
  }

  function updateAgeDisplay() {
    if (!lastCapturedIso) return;
    const diffSec = Math.max(0, Math.floor((Date.now() - lastCapturedIso.getTime()) / 1000));
    if (diffSec < 5) tabAge.textContent = 'Just now';
    else if (diffSec < 60) tabAge.textContent = `${diffSec}s ago`;
    else tabAge.textContent = `${Math.floor(diffSec / 60)}m ago`;
  }
  setInterval(updateAgeDisplay, 1000);

  async function loadScreenshot() {
    if (isFetching) return;
    isFetching = true;
    if (btnRefresh) btnRefresh.style.transform = 'rotate(180deg)';

    try {
      const res = await api('api/screenshot');
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        screenImg.src = url;
        screenImg.classList.remove('hidden');
        stagePlaceholder.classList.add('hidden');
        const cap = res.headers.get('x-captured-at') || new Date().toISOString();
        capturedTime.textContent = `Captured: ${new Date(cap).toLocaleTimeString()}`;
      } else {
        const err = await res.json().catch(() => ({}));
        if (screenImg.classList.contains('hidden') || !screenImg.src) {
          stagePlaceholder.classList.remove('hidden');
          const spinner = stagePlaceholder.querySelector('.spinner');
          if (spinner) spinner.style.display = 'none';
          placeholderMsg.innerHTML = `
            <div style="font-weight:600; color: #fff; margin-bottom: 4px;">📸 ${err.error || 'Screen capture standby'}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">Live DOM text and elements are active. View them in Page Content.</div>
            <button id="btn-goto-text" class="btn-primary-sm" style="margin: 0 auto; display: inline-block;">View Page Content 📄</button>
          `;
          $('#btn-goto-text')?.addEventListener('click', () => switchTab('text'));
        }
      }
    } catch (err) {
      console.warn('Screenshot load error:', err);
    } finally {
      isFetching = false;
      if (btnRefresh) setTimeout(() => { btnRefresh.style.transform = 'none'; }, 200);
    }
  }

  async function loadPageSnapshot() {
    try {
      pageTextContent.innerHTML = '<em>Loading extracted text...</em>';
      const res = await api('api/snapshot');
      if (!res.ok) throw new Error('Failed to load snapshot');
      const data = await res.json();
      if (data.ok && data.snapshot && data.snapshot.text) {
        pageTextContent.textContent = data.snapshot.text;
      } else {
        pageTextContent.innerHTML = '<em>No text extracted from current tab.</em>';
      }
    } catch (err) {
      pageTextContent.innerHTML = `<em>Failed to load text: ${err.message}</em>`;
    }
  }

  async function loadPageElements() {
    try {
      elementList.innerHTML = '<li class="empty-msg">Scanning elements...</li>';
      const res = await api('api/elements');
      if (!res.ok) throw new Error('Failed to load elements');
      const data = await res.json();
      const elements = data.elements || [];
      elementsTabBadge.textContent = elements.length;

      if (!elements.length) {
        elementList.innerHTML = '<li class="empty-msg">No interactive elements detected on page.</li>';
        return;
      }

      elementList.innerHTML = '';
      elements.slice(0, 50).forEach(el => {
        const li = document.createElement('li');
        li.className = 'element-item';
        li.innerHTML = `
          <span class="element-tag">${escapeHtml(el.tag || 'elem')}</span>
          <span class="element-text">${escapeHtml(el.text || '(empty)')}</span>
        `;
        elementList.appendChild(li);
      });
    } catch (err) {
      elementList.innerHTML = `<li class="empty-msg">Error loading elements: ${err.message}</li>`;
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function setupAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    const ms = parseInt(refreshRateSelect.value, 10);
    if (ms > 0) {
      autoRefreshTimer = setInterval(() => {
        refreshStatus();
        const activePane = $('.tab-pane.active');
        if (activePane && activePane.id === 'pane-preview') {
          loadScreenshot();
        }
      }, ms);
    }
  }

  refreshRateSelect.addEventListener('change', () => {
    haptic('light');
    setupAutoRefresh();
  });

  btnRefresh.addEventListener('click', () => {
    haptic('medium');
    const spinner = stagePlaceholder.querySelector('.spinner');
    if (spinner) spinner.style.display = 'block';
    placeholderMsg.textContent = 'Requesting screen snapshot...';
    loadScreenshot();
    refreshStatus();
    showToast('Refreshing screen snapshot...');
  });

  btnSnapNow.addEventListener('click', () => {
    haptic('medium');
    const spinner = stagePlaceholder.querySelector('.spinner');
    if (spinner) spinner.style.display = 'block';
    placeholderMsg.textContent = 'Capturing live screen...';
    loadScreenshot();
    refreshStatus();
    showToast('Capturing live screen...');
  });

  btnRefreshText?.addEventListener('click', () => {
    haptic('light');
    loadPageSnapshot();
    showToast('Refreshed page content');
  });

  btnRefreshElements?.addEventListener('click', () => {
    haptic('light');
    loadPageElements();
    showToast('Refreshed interactive elements');
  });

  // Initial loads
  refreshStatus();
  loadScreenshot();
  setupAutoRefresh();
  loadPageElements();
})();
