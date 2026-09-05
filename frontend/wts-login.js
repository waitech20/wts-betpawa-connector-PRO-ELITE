(() => {
  'use strict';

  const API_ORIGIN = 'http://127.0.0.1:3930';
  const API = {
    startLogin: `${API_ORIGIN}/api/start-login`,
    waitLogin: `${API_ORIGIN}/api/wait-login`,
    connectGame: `${API_ORIGIN}/api/connect-game`,
    status: `${API_ORIGIN}/api/status`,
    gameDom: `${API_ORIGIN}/api/game-dom`,
    reset: `${API_ORIGIN}/api/reset`,
    events: `${API_ORIGIN}/api/events`,
    manualBet: `${API_ORIGIN}/api/manual-bet`
  };

  const form = document.getElementById('wts-login-form');
  const phoneInput = document.getElementById('wts-login-phone');
  const passwordInput = document.getElementById('wts-login-password');
  const togglePassword = document.getElementById('wts-login-toggle-password');
  const rememberInput = document.getElementById('wts-login-remember');
  const loginButton = document.getElementById('wts-login-button');
  const statusElement = document.getElementById('wts-login-status');

  if (!form || !phoneInput || !passwordInput || !loginButton) {
    console.error('[WTS LOGIN] Required elements are missing.');
    return;
  }

  let loginRunning = false;
  let connected = false;
  let selectedGame = null;
  let gameSection = null;
  let statusTimer = null;
  let lastDomEventId = null;
  let lastGameDomEventId = null;
  let infoModal = null;
  let sessionLostShown = false;
  let phase2Page = false;
  let eventSource = null;
  let phase2EventHistory = [];
  let eventStreamReconnectTimer = null;

  injectStyles();
  injectInfoButton();

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function setStatus(message, type = '') {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = `wts-login-status ${type ? `is-${type}` : ''}`;
  }

  function toast(message, type = 'success') {
    let el = document.getElementById('wts-login-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wts-login-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `wts-login-toast is-visible is-${type}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('is-visible'), 3200);
  }

  function sanitizePhone() {
    phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 9);
    updateLoginButton();
  }

  function updateLoginButton() {
    const can = phoneInput.value.length >= 4 && passwordInput.value.length >= 4 && !loginRunning && !connected;
    loginButton.disabled = !can;
    loginButton.classList.toggle('is-active', can);
    loginButton.classList.toggle('is-loading', loginRunning);
    loginButton.setAttribute('aria-disabled', String(!can));
  }

  function clearCredentialFields() {
    // Clear the browser-side copies immediately after verified authentication.
    phoneInput.value = '';
    passwordInput.value = '';
    phoneInput.removeAttribute('value');
    passwordInput.removeAttribute('value');
    if (passwordInput.type !== 'password') passwordInput.type = 'password';
    if (togglePassword) {
      const icon = togglePassword.querySelector('i');
      const label = togglePassword.querySelector('span');
      if (icon) icon.className = 'fa-regular fa-eye';
      if (label) label.textContent = 'Show';
      togglePassword.setAttribute('aria-label', 'Show password');
      togglePassword.setAttribute('aria-pressed', 'false');
    }
  }

  function hideCredentialUI() {
    clearCredentialFields();
    form.classList.add('is-authenticated');
    form.querySelectorAll('.wts-login-form-group, .wts-login-options, #wts-login-button, .wts-login-secure').forEach(el => {
      el.setAttribute('hidden', 'hidden');
    });
    phoneInput.disabled = true;
    passwordInput.disabled = true;
    if (togglePassword) togglePassword.disabled = true;
    if (rememberInput) rememberInput.disabled = true;
    loginButton.disabled = true;
  }

  function showCredentialUI() {
    if (connected) return;
    form.classList.remove('is-authenticated');
    form.querySelectorAll('.wts-login-form-group, .wts-login-options, #wts-login-button, .wts-login-secure').forEach(el => el.removeAttribute('hidden'));
    phoneInput.disabled = false;
    passwordInput.disabled = false;
    if (togglePassword) togglePassword.disabled = false;
    if (rememberInput) rememberInput.disabled = false;
    updateLoginButton();
  }

  if (togglePassword) {
    togglePassword.addEventListener('click', () => {
      if (togglePassword.disabled) return;
      const showing = passwordInput.type === 'text';
      passwordInput.type = showing ? 'password' : 'text';
      const icon = togglePassword.querySelector('i');
      const label = togglePassword.querySelector('span');
      if (icon) icon.className = showing ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
      if (label) label.textContent = showing ? 'Show' : 'Hide';
      togglePassword.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      togglePassword.setAttribute('aria-pressed', String(!showing));
    });
  }

  phoneInput.addEventListener('input', sanitizePhone);
  passwordInput.addEventListener('input', updateLoginButton);
  form.addEventListener('submit', e => { e.preventDefault(); void startLogin(); });

  async function startLogin() {
    if (loginRunning || connected) return;
    const phone = phoneInput.value.replace(/\D/g, '').slice(0, 9);
    const password = passwordInput.value;
    if (!/^\d{9}$/.test(phone)) { setStatus('Enter a valid 9-digit mobile number.', 'error'); phoneInput.focus(); return; }
    if (password.length < 4) { setStatus('Password must contain at least 4 characters.', 'error'); passwordInput.focus(); return; }

    loginRunning = true;
    updateLoginButton();
    setStatus('Authenticating…', 'loading');

    try {
      const response = await fetch(API.startLogin, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }), cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Login could not be started.');
      if (data.authenticated) { onAuthenticated(); return; }
      if (!data.requestId) throw new Error('Login request was not created.');
      await pollLogin(data.requestId);
    } catch (e) {
      loginRunning = false;
      showCredentialUI();
      setStatus(e.message || 'Could not connect to the local connector.', 'error');
      toast('🔴 Login failed.', 'error');
    }
  }

  async function pollLogin(requestId) {
    const started = Date.now();
    while (Date.now() - started < 40000) {
      try {
        const r = await fetch(`${API.waitLogin}?requestId=${encodeURIComponent(requestId)}`, { cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        consumeDomEvents(d.domEvents);
        if (d.status === 'AUTHENTICATED' && d.authenticated) { onAuthenticated(); return; }
        if (d.status === 'LOGIN_FAILED') {
          loginRunning = false;
          showCredentialUI();
          setStatus(d.message || 'Mobile number or password is incorrect.', 'error');
          toast('🔴 Login not verified.', 'error');
          return;
        }
        setStatus('Authenticating…', 'loading');
      } catch {}
      await sleep(100);
    }
    loginRunning = false;
    showCredentialUI();
    setStatus('Login could not be verified. Please try again.', 'error');
    toast('🔴 Authentication verification timed out.', 'error');
  }

  function onAuthenticated() {
    loginRunning = false;
    connected = true;
    sessionLostShown = false;
    hideCredentialUI();
    setStatus('Connected • Authentication VERIFIED', 'success');
    toast('🟢 BetPawa authentication verified.', 'success');
    showGameSelector();
    startStatusMonitor();
  }

  function showGameSelector() {
    if (!gameSection) {
      gameSection = document.createElement('section');
      gameSection.id = 'wts-game-selector';
      form.insertAdjacentElement('afterend', gameSection);
    }
    renderGameChooser();
  }

  function renderGameChooser() {
    if (!gameSection) return;
    gameSection.className = 'wts-game-selector';
    gameSection.innerHTML = `
      <div class="wts-game-head">
        <div><strong>Choose Game to Connect</strong><span>Authentication is verified. Select exactly one game.</span></div>
        <b class="wts-auth-badge"><i class="fa-solid fa-circle-check"></i> AUTHENTICATED</b>
      </div>
      <div class="wts-game-options">
        <label class="wts-game-option" data-game="aviator">
          <input type="radio" name="wts-game" value="aviator">
          <span class="wts-game-radio"></span>
          <span class="wts-game-info"><strong>Aviator</strong><small>Game ID 34971</small></span>
        </label>
        <label class="wts-game-option" data-game="fortunerMine">
          <input type="radio" name="wts-game" value="fortunerMine">
          <span class="wts-game-radio"></span>
          <span class="wts-game-info"><strong>Fortuner Mine</strong><small>Game ID 35102</small></span>
        </label>
      </div>
      <button type="button" id="wts-connect-game" class="wts-connect-game" disabled>
        <i class="fa-solid fa-link"></i><span>Connect Selected Game</span>
      </button>
    `;
    gameSection.querySelectorAll('input[name="wts-game"]').forEach(r => r.addEventListener('change', () => {
      selectedGame = r.value;
      gameSection.querySelectorAll('.wts-game-option').forEach(o => o.classList.toggle('is-selected', o.dataset.game === selectedGame));
      const b = document.getElementById('wts-connect-game');
      if (b) b.disabled = !selectedGame;
    }));
    document.getElementById('wts-connect-game')?.addEventListener('click', () => void connectGame());
  }

  async function connectGame() {
    if (!connected || !selectedGame) return;
    const b = document.getElementById('wts-connect-game');
    if (!b) return;
    b.disabled = true;
    b.classList.add('is-loading');
    b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Verifying session & connecting…</span>';
    setStatus('Server is re-verifying authentication before game access…', 'loading');
    try {
      const r = await fetch(API.connectGame, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: selectedGame }), cache: 'no-store'
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.message || 'Game connection blocked.');
      const gameName = d.game?.name || selectedGame;
      enterPhase2(gameName, d.game?.id || '', d.gameDom || d.gameDomHealth || null, d.gameState || null);
      setStatus(`${gameName} connected • Phase 2 dashboard ACTIVE`, 'success');
      toast(`🟢 ${gameName} connected.`, 'success');
    } catch (e) {
      b.disabled = false;
      b.classList.remove('is-loading');
      b.innerHTML = '<i class="fa-solid fa-link"></i><span>Connect Selected Game</span>';
      setStatus(e.message || 'Game connection failed.', 'error');
      toast('🔴 Game connection blocked.', 'error');
    }
  }

  function enterPhase2(name, id, domData, gameState) {
    phase2Page = true;
    document.body.classList.add('wts-phase2');
    document.documentElement.classList.add('wts-phase2');
    if (!gameSection) {
      gameSection = document.createElement('section');
      gameSection.id = 'wts-game-selector';
    }
    // Phase 2 is a true application surface, not a child of the narrow login card.
    // Move it to <body> so it can use the full viewport and center correctly.
    document.body.appendChild(gameSection);
    gameSection.className = 'wts-phase2-shell';
    renderPhase2Dashboard(gameSection, name, id, domData, gameState);
    startEventStream();
  }

  function leavePhase2ToGameChooser(message = 'Authentication remains active. Choose another game.') {
    phase2Page = false;
    stopEventStream();
    document.body.classList.remove('wts-phase2');
    document.documentElement.classList.remove('wts-phase2');
    selectedGame = null;
    renderGameChooser();
    setStatus(message, '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEventStream() {
    stopEventStream(false);
    if (!window.EventSource) return;
    try {
      eventSource = new EventSource(API.events);
      eventSource.onopen = () => updateEventStreamBadge('LIVE');
      eventSource.onmessage = e => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'STREAM_CONNECTED') { updateEventStreamBadge('LIVE'); return; }
          phase2EventHistory.unshift(event);
          phase2EventHistory = phase2EventHistory.slice(0, 30);
          window.__wtsLastGameEvents = phase2EventHistory.slice(0, 8);
          renderEventHistory();
          if (event.type === 'GAME_STATE_CHANGED') {
            const d = event.data || {};
            const value = d.primaryValue || '—';
            const valueEl = document.querySelector('.wts-p2-value');
            if (valueEl) { valueEl.textContent = value; valueEl.classList.toggle('is-empty', value === '—'); }
            const labelEl = document.querySelector('.wts-p2-live-card .wts-p2-card-head strong');
            if (labelEl) labelEl.textContent = d.primaryLabel || 'LIVE GAME DATA';
            const roundEl = document.getElementById('wts-p2-round');
            if (roundEl) roundEl.textContent = d.roundText || 'Waiting for game data…';
          }
        } catch {}
      };
      eventSource.onerror = () => {
        updateEventStreamBadge('RECONNECTING');
        try { eventSource.close(); } catch {}
        eventSource = null;
        clearTimeout(eventStreamReconnectTimer);
        eventStreamReconnectTimer = setTimeout(() => { if (phase2Page) startEventStream(); }, 1800);
      };
    } catch { updateEventStreamBadge('POLLING'); }
  }

  function stopEventStream(reset = true) {
    clearTimeout(eventStreamReconnectTimer);
    eventStreamReconnectTimer = null;
    if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
    if (reset) phase2EventHistory = [];
  }

  function updateEventStreamBadge(state) {
    const el = document.getElementById('wts-p2-event-stream');
    if (!el) return;
    el.textContent = state;
    el.className = `wts-p2-stream ${state === 'LIVE' ? 'is-live' : 'is-warn'}`;
  }

  function renderEventHistory() {
    const panel = document.getElementById('wts-p2-events');
    if (!panel) return;
    const events = phase2EventHistory.length ? phase2EventHistory : [{type:'SYSTEM',message:'Waiting for live events…',time:'LIVE'}];
    panel.innerHTML = events.slice(0,8).map(e => {
      const label = e.type === 'MISSING' ? `${e.group || 'DOM'} missing` : e.type === 'RECOVERED' ? `${e.group || 'DOM'} recovered` : e.message || e.type;
      const cls = e.type === 'MISSING' ? 'is-bad' : e.type === 'RECOVERED' ? 'is-good' : 'is-info';
      return `<div class="wts-p2-event ${cls}"><i></i><span>${escapeHtml(label)}</span><time>${escapeHtml(e.time || 'LIVE')}</time></div>`;
    }).join('');
  }

  function renderPhase2Dashboard(root, name, id, domData, gameState) {
    if (!root) return;
    const g = domData?.groups || {};
    const isAviator = String(selectedGame) === 'aviator';
    const primaryGroup = isAviator ? g.AVIATOR_PAYOUT : g.FORTUNER_MINE;
    const domReady = !!primaryGroup?.visible;
    const frames = Array.isArray(domData?.frames) ? domData.frames : [];
    const state = gameState || {};
    const value = state.primaryValue || '—';
    const valueLabel = state.primaryLabel || (isAviator ? 'MULTIPLIER' : 'GAME STATE');
    const round = state.roundText || 'Waiting for game data…';
    const balance = state.balance || '—';
    const bets = Array.isArray(state.betControls) ? state.betControls : [];
    const betCard = (slot, label) => {
      const b = bets[slot-1] || {};
      const meta = betActionMeta(b.state, label);
      return `<div class="wts-p3-bet-card wts-p3-state-${meta.cls}"><div class="wts-p3-bet-head"><span>BET CONTROL ${label}</span><b class="${b.ready ? 'ready' : 'waiting'}">${b.ready ? 'READY' : 'WAITING'}</b></div><div class="wts-p3-bet-amount">${escapeHtml(b.amount || '1.00')} <small>TZS</small></div><button type="button" class="wts-p3-bet-button wts-p3-btn-${meta.cls}" data-bet-slot="${slot}" ${b.ready ? '' : 'disabled'}>${meta.text}</button><small class="wts-p3-bet-note">${meta.note}</small></div>`;
    };
    const common = !!g.COMMON?.visible;
    const iframe = !!g.IFRAME?.visible;
    const canvas = !!g.CANVAS?.visible;
    const svg = !!g.SVG?.visible;
    const gameRoot = !!g.GAME_ROOT?.visible;
    const mine = !!g.FORTUNER_MINE?.visible;
    const payout = !!g.AVIATOR_PAYOUT?.visible;
    const healthItems = isAviator
      ? [['GAME ROOT', gameRoot], ['GAME FRAME', iframe], ['PAYOUT / MULTIPLIER', payout], ['CANVAS', canvas], ['SVG', svg], ['PAGE ROOT', common]]
      : [['GAME ROOT', gameRoot], ['GAME FRAME', iframe], ['MINE / GRID', mine], ['CANVAS', canvas], ['SVG', svg], ['PAGE ROOT', common]];

    root.innerHTML = `
      <div class="wts-p2-topbar">
        <div class="wts-p2-brand"><span class="wts-p2-brand-dot"></span><div><strong>WTS GAME CONTROL</strong><small>PHASE 3 • LIVE GAME CONTROL</small></div></div>
        <div class="wts-p2-top-actions"><span class="wts-p2-session"><i></i> AUTH SESSION VERIFIED</span><button type="button" id="wts-p2-change">CHANGE GAME</button><button type="button" id="wts-p2-disconnect">DISCONNECT</button></div>
      </div>

      <div class="wts-p2-heading">
        <div><span class="wts-p2-kicker">CONNECTED GAME</span><h1>${escapeHtml(name)}</h1><p>Game ID ${escapeHtml(id)} <span>•</span> Same authenticated Playwright session <span>•</span> Live structural monitoring</p></div>
        <div class="wts-p2-live"><i></i><strong>LIVE</strong><span>MONITORING</span></div>
      </div>

      <div class="wts-p2-main-grid">
        <section class="wts-p2-card wts-p2-live-card">
          <div class="wts-p2-card-head"><div><span>LIVE GAME DATA</span><strong>${escapeHtml(valueLabel)}</strong></div><b class="wts-p2-source">DOM DETECTED</b></div>
          <div class="wts-p2-value ${value === '—' ? 'is-empty' : ''}">${escapeHtml(value)}</div>
          <div class="wts-p2-round"><span>ROUND / ACTIVITY</span><strong id="wts-p2-round">${escapeHtml(round)}</strong></div>
          <div class="wts-p2-note">Values are displayed only when detected from the connected game DOM. No prediction or result generation is performed.</div>
        </section>

        <section class="wts-p2-card">
          <div class="wts-p2-card-head"><div><span>CONNECTION</span><strong>Game Session</strong></div><b class="wts-p2-ok">CONNECTED</b></div>
          <div class="wts-p2-stat-list">
            <div><span>Authentication</span><b>VERIFIED</b></div>
            <div><span>Game Route</span><b>REACHED</b></div>
            <div><span>Playwright Page</span><b>ACTIVE</b></div>
            <div><span>Frames</span><b id="wts-p2-frames">${frames.length}</b></div>
          </div>
        </section>
      </div>

      <section class="wts-p3-control-strip">
        <div class="wts-p3-balance-card"><span>LIVE BALANCE</span><strong id="wts-p3-balance">${escapeHtml(balance)}</strong><small>Read from connected BetPawa DOM</small></div>
        <div class="wts-p3-bets">${isAviator ? betCard(1,'2') + betCard(2,'3') : '<div class="wts-p3-unavailable">Manual bet controls are available for Aviator.</div>'}</div>
      </section>

      <div class="wts-p2-section-title"><div><span>DOM HEALTH</span><strong>Game structure monitor</strong></div><span class="wts-p2-health-state ${domReady ? 'ok' : 'warn'}"><i></i>${domReady ? 'PRIMARY DOM READY' : 'WAITING FOR PRIMARY DOM'}</span></div>
      <section class="wts-p2-health-grid">
        ${healthItems.map(([label, ok]) => `<div class="wts-p2-health-item ${ok ? 'ok' : 'missing'}"><span class="wts-p2-health-icon">${ok ? '✓' : '!'}</span><div><strong>${escapeHtml(label)}</strong><small>${ok ? 'FOUND & VISIBLE' : 'NOT FOUND / NOT VISIBLE'}</small></div><b>${ok ? 'READY' : 'MISSING'}</b></div>`).join('')}
      </section>

      <div class="wts-p2-bottom-grid">
        <section class="wts-p2-card">
          <div class="wts-p2-card-head"><div><span>ACTIVITY</span><strong>Live DOM events</strong></div><b id="wts-p2-event-stream" class="wts-p2-stream is-live">LIVE</b></div>
          <div id="wts-p2-events" class="wts-p2-events"><div class="wts-p2-event"><i></i><span>Game connection established</span><time>NOW</time></div><div class="wts-p2-event"><i></i><span>DOM monitor is active</span><time>LIVE</time></div></div>
        </section>
        <section class="wts-p2-card">
          <div class="wts-p2-card-head"><div><span>EVENT ENGINE</span><strong>Mutation & DOM state</strong></div><b class="wts-p2-source">REAL-TIME</b></div>
          <div class="wts-p2-monitor-box"><div><span>Mutation Version</span><b id="wts-p2-mutation">${escapeHtml(domData?.mutationVersion ?? '—')}</b></div><div><span>Checked</span><b id="wts-p2-checked">${escapeHtml(domData?.checkedAt || '—')}</b></div></div>
          <p class="wts-p2-monitor-copy">The monitor reports structural changes and recovery. It does not alter game outcomes or bypass platform protections.</p>
        </section>
      </div>
    `;

    document.getElementById('wts-p2-change')?.addEventListener('click', () => leavePhase2ToGameChooser());
    document.getElementById('wts-p2-disconnect')?.addEventListener('click', () => void disconnectSession());
    gameSection.querySelectorAll('[data-bet-slot]').forEach(btn => btn.addEventListener('click', () => void manualBet(Number(btn.dataset.betSlot), btn)));
  }

  function updatePhase2Dashboard(domData, gameStateData) {
    if (!phase2Page || !gameSection) return;
    const g = domData?.groups || {};
    const isAviator = String(selectedGame) === 'aviator';
    const primaryGroup = isAviator ? g.AVIATOR_PAYOUT : g.FORTUNER_MINE;
    const value = gameStateData?.primaryValue || '—';
    const valueLabel = gameStateData?.primaryLabel || (isAviator ? 'MULTIPLIER' : 'GAME STATE');
    const round = gameStateData?.roundText || 'Waiting for game data…';
    const balance = gameStateData?.balance || '—';
    const bets = Array.isArray(gameStateData?.betControls) ? gameStateData.betControls : [];
    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setText('wts-p2-round', round);
    setText('wts-p3-balance', balance);
    gameSection.querySelectorAll('[data-bet-slot]').forEach(btn => {
      const slot = Number(btn.dataset.betSlot);
      const label = slot === 1 ? '2' : '3';
      const b = bets[slot - 1] || {};
      const meta = betActionMeta(b.state, label);
      btn.disabled = !b.ready;
      btn.textContent = meta.text;
      btn.className = `wts-p3-bet-button wts-p3-btn-${meta.cls}`;
      const card = btn.closest('.wts-p3-bet-card');
      if (card) card.className = `wts-p3-bet-card wts-p3-state-${meta.cls}`;
    });
    gameSection.querySelectorAll('.wts-p3-bet-card').forEach((card, i) => { const b = bets[i] || {}; const amount = card.querySelector('.wts-p3-bet-amount'); const status = card.querySelector('.wts-p3-bet-head b'); if (amount) amount.innerHTML = `${escapeHtml(b.amount || '1.00')} <small>TZS</small>`; if (status) { status.textContent = b.ready ? 'READY' : 'WAITING'; status.className = b.ready ? 'ready' : 'waiting'; }});
    setText('wts-p2-frames', String(Array.isArray(domData?.frames) ? domData.frames.length : '—'));
    setText('wts-p2-mutation', String(domData?.mutationVersion ?? '—'));
    setText('wts-p2-checked', String(domData?.checkedAt || '—'));
    const valueEl = gameSection.querySelector('.wts-p2-value');
    if (valueEl) { valueEl.textContent = value; valueEl.classList.toggle('is-empty', value === '—'); }
    const labelEl = gameSection.querySelector('.wts-p2-live-card .wts-p2-card-head strong');
    if (labelEl) labelEl.textContent = valueLabel;
    const stateEl = gameSection.querySelector('.wts-p2-health-state');
    if (stateEl) {
      const ready = !!primaryGroup?.visible;
      stateEl.classList.toggle('ok', ready); stateEl.classList.toggle('warn', !ready);
      stateEl.innerHTML = `<i></i>${ready ? 'PRIMARY DOM READY' : 'WAITING FOR PRIMARY DOM'}`;
    }
    const healthLabels = isAviator ? ['GAME ROOT','GAME FRAME','PAYOUT / MULTIPLIER','CANVAS','SVG','PAGE ROOT'] : ['GAME ROOT','GAME FRAME','MINE / GRID','CANVAS','SVG','PAGE ROOT'];
    const healthValues = isAviator ? [g.GAME_ROOT?.visible,g.IFRAME?.visible,g.AVIATOR_PAYOUT?.visible,g.CANVAS?.visible,g.SVG?.visible,g.COMMON?.visible] : [g.GAME_ROOT?.visible,g.IFRAME?.visible,g.FORTUNER_MINE?.visible,g.CANVAS?.visible,g.SVG?.visible,g.COMMON?.visible];
    gameSection.querySelectorAll('.wts-p2-health-item').forEach((el, i) => {
      const ok = !!healthValues[i];
      el.classList.toggle('ok', ok); el.classList.toggle('missing', !ok);
      const icon = el.querySelector('.wts-p2-health-icon'); if (icon) icon.textContent = ok ? '✓' : '!';
      const small = el.querySelector('small'); if (small) small.textContent = ok ? 'FOUND & VISIBLE' : 'NOT FOUND / NOT VISIBLE';
      const b = el.querySelector('b'); if (b) b.textContent = ok ? 'READY' : 'MISSING';
    });
    const eventsPanel = document.getElementById('wts-p2-events');
    const events = Array.isArray(window.__wtsLastGameEvents) ? window.__wtsLastGameEvents : [];
    if (eventsPanel && events.length) {
      eventsPanel.innerHTML = events.slice(0,6).map(e => `<div class="wts-p2-event"><i></i><span>${escapeHtml(e.type === 'MISSING' ? `${e.group.replaceAll('_',' ')} missing` : e.type === 'RECOVERED' ? `${e.group.replaceAll('_',' ')} recovered` : e.message || e.type)}</span><time>${escapeHtml(e.time || 'LIVE')}</time></div>`).join('');
    }
  }

  async function manualBet(slot, button) {
    if (!button || button.disabled || ![1,2].includes(slot)) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'SENDING…';
    try {
      const response = await fetch(API.manualBet, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({slot}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || 'Manual action failed.');
      const actionLabel = data.action === 'CASHOUT' ? 'Cash Out' : data.action === 'CANCEL' ? 'Cancel' : 'Bet';
      toast(`🟢 Manual ${actionLabel} (control ${slot === 1 ? '2' : '3'}) clicked.`, 'success');
    } catch (e) {
      toast(`🔴 ${e.message || 'Manual action failed.'}`, 'error');
    } finally {
      button.textContent = original;
      void refreshStatus();
    }
  }

  function showGameMonitor(initial) {
    if (phase2Page) return;
    const panel = document.getElementById('wts-game-monitor');
    if (!panel) return;
    renderGameMonitor(panel, initial || null);
  }

  function renderGameMonitor(panel, data) {
    if (!panel) return;
    const groups = data?.groups || {};
    const names = ['COMMON', 'IFRAME', 'CANVAS', 'SVG', 'GAME_ROOT', 'AVIATOR_PAYOUT', 'FORTUNER_MINE'];
    panel.innerHTML = `
      <div class="wts-monitor-head"><div><strong>Game DOM Monitor</strong><span>Live structural health • no game-action automation</span></div><span class="wts-monitor-live"><i></i> LIVE</span></div>
      <div class="wts-monitor-grid">${names.map(n => { const gg = groups[n] || {}; const ok = !!gg.visible; return `<div class="wts-monitor-item ${ok ? 'is-ok' : 'is-missing'}"><span>${escapeHtml(n.replaceAll('_', ' '))}</span><b>${ok ? 'READY' : 'NOT FOUND'}</b></div>`; }).join('')}</div>
      <div class="wts-monitor-meta"><span>Game: <b>${escapeHtml(data?.gameName || selectedGame || '—')}</b></span><span>Frames: <b>${Array.isArray(data?.frames) ? data.frames.length : '—'}</b></span></div>
      <div class="wts-monitor-events" id="wts-game-monitor-events">Monitoring game DOM changes…</div>
    `;
  }

  function consumeGameDomEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    if (lastGameDomEventId === events[0]?.id) return;
    lastGameDomEventId = events[0]?.id || lastGameDomEventId;
    window.__wtsLastGameEvents = events.slice(0, 8);
    const newest = events[0];
    const panel = document.getElementById('wts-game-monitor-events');
    if (panel && newest) panel.textContent = `${newest.type === 'MISSING' ? '🔴' : '🟢'} ${newest.group.replaceAll('_', ' ')} — ${newest.message}`;
  }

  function consumeDomEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    if (lastDomEventId === events[0]?.id) return;
    lastDomEventId = events[0]?.id || lastDomEventId;
    const newest = events[0];
    // Login DOM notifications are intentionally ignored after authentication.
    if (!connected && newest) {
      if (newest.type === 'MISSING') toast(`🔴 DOM: ${newest.group} not found`, 'error');
      if (newest.type === 'RECOVERED') toast(`🟢 DOM: ${newest.group} recovered`, 'success');
    }
  }

  async function refreshStatus() {
    try {
      const r = await fetch(API.status, { cache: 'no-store' });
      const d = await r.json();
      consumeDomEvents(d.domEvents);
      consumeGameDomEvents(d.gameDomEvents);

      if (connected && (d.state === 'SESSION_LOST' || d.state === 'LOGIN_FAILED')) {
        if (!sessionLostShown) {
          sessionLostShown = true;
          connected = false;
          selectedGame = null;
          phase2Page = false;
          document.body.classList.remove('wts-phase2');
          document.documentElement.classList.remove('wts-phase2');
          gameSection?.remove();
          gameSection = null;
          showCredentialUI();
          setStatus('Authentication session is no longer verified.', 'error');
          toast('🔴 Session verification lost.', 'error');
        }
        return;
      }

      if (connected && d.authenticated) sessionLostShown = false;
      if (connected && d.gameDomHealth?.available) {
        if (phase2Page && gameSection) {
          updatePhase2Dashboard(d.gameDomHealth, d.gameState || null);
          consumeGameDomEvents(d.gameDomEvents);
          updatePhase2Dashboard(d.gameDomHealth, d.gameState || null);
        } else {
          const panel = document.getElementById('wts-game-monitor');
          if (panel) renderGameMonitor(panel, d.gameDomHealth);
        }
      }
    } catch {}
  }

  function startStatusMonitor() {
    if (statusTimer) return;
    statusTimer = setInterval(() => void refreshStatus(), 450);
    void refreshStatus();
  }

  async function disconnectSession() {
    if (!confirm('Disconnect the current authenticated session and return to login?')) return;
    try {
      const r = await fetch(API.reset, { method: 'POST', cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.message || 'Disconnect failed.');
      connected = false;
      selectedGame = null;
      phase2Page = false;
      document.body.classList.remove('wts-phase2');
      document.documentElement.classList.remove('wts-phase2');
      sessionLostShown = false;
      gameSection?.remove();
      gameSection = null;
      showCredentialUI();
      setStatus('Disconnected. Enter credentials to connect again.', '');
      toast('Session disconnected.', 'success');
    } catch (e) {
      setStatus(e.message || 'Disconnect failed.', 'error');
      toast('🔴 Disconnect failed.', 'error');
    }
  }

  function injectInfoButton() {
    if (document.getElementById('wts-info-button')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'wts-info-button';
    btn.className = 'wts-info-button';
    btn.setAttribute('aria-label', 'How this connector works');
    btn.innerHTML = '!';
    document.body.appendChild(btn);
    btn.addEventListener('click', openInfoModal);
  }

  function openInfoModal() {
    if (infoModal) { infoModal.classList.add('is-open'); return; }
    infoModal = document.createElement('div');
    infoModal.className = 'wts-info-modal is-open';
    infoModal.innerHTML = `
      <div class="wts-info-backdrop"></div>
      <section class="wts-info-dialog" role="dialog" aria-modal="true" aria-labelledby="wts-info-title">
        <button type="button" class="wts-info-close" aria-label="Close">×</button>
        <div class="wts-info-icon">!</div>
        <div class="wts-info-title"><strong id="wts-info-title">How this connector works</strong><span>Secure, state-aware account connection flow</span></div>
        <div class="wts-info-steps">
          ${[
            ['01', 'LOGIN', 'Enter your Tanzania mobile number and password.'],
            ['02', 'VERIFY', 'The server submits the login and requires real post-login proof.'],
            ['03', 'CONNECTED', 'After authentication is verified, credentials are cleared and hidden.'],
            ['04', 'CHOOSE GAME', 'Select exactly one game. No game opens automatically after login.'],
            ['05', 'CONNECT / CHANGE', 'The server re-verifies the session before every game navigation.'],
            ['06', 'MONITOR', 'Live DOM monitoring reports relevant authentication and game-structure changes.']
          ].map(s => `<div class="wts-info-step"><b>${s[0]}</b><div><strong>${s[1]}</strong><span>${s[2]}</span></div></div>`).join('')}
        </div>
        <div class="wts-attention"><strong><i class="fa-solid fa-triangle-exclamation"></i> ATTENTION</strong><p>This connector is for authorized account connection and monitoring only. It does not predict results, guarantee winnings, or bypass CAPTCHA, MFA, rate limits, anti-bot controls, or other security protections. Keep your credentials private.</p></div>
      </section>
    `;
    document.body.appendChild(infoModal);
    const close = () => infoModal?.classList.remove('is-open');
    infoModal.querySelector('.wts-info-close')?.addEventListener('click', close);
    infoModal.querySelector('.wts-info-backdrop')?.addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') close(); }, { once: true });
  }

  function escapeHtml(v) {
    return String(v || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  // A bet-control's single action button changes meaning with the live round
  // phase. This maps the server-detected state to what the button should say
  // and look like — it never decides *when* to act, only how to label the
  // one action the person is about to click themselves.
  function betActionMeta(state, label) {
    if (state === 'CASHOUT') return { cls: 'cashout', text: `CASH OUT — ${label}`, note: 'Manual click only' };
    if (state === 'CANCEL') return { cls: 'cancel', text: `CANCEL BET — ${label}`, note: 'Manual click only' };
    return { cls: 'bet', text: `PLACE BET — ${label}`, note: 'Manual click only' };
  }

  function injectStyles() {
    if (document.getElementById('wts-pro-runtime-css')) return;
    const style = document.createElement('style');
    style.id = 'wts-pro-runtime-css';
    style.textContent = `
      html,body{min-height:100%;height:auto;overflow:auto}
      body{padding:clamp(18px,4vw,44px);align-items:center}
      .wts-login-card{width:min(100%,560px);max-height:calc(100vh - 36px);overflow:auto;scrollbar-width:thin;padding:38px 36px 32px}
      .wts-login-card::-webkit-scrollbar{width:6px}.wts-login-card::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:20px}
      #wts-login-status{min-height:22px;margin-top:9px;font-size:12px;font-weight:650;text-align:center}.wts-login-status.is-success{color:#9ce800}.wts-login-status.is-error{color:#ff5c5c}.wts-login-status.is-loading{color:#c8ced1;opacity:.8}
      .wts-login-form.is-authenticated .wts-login-status{margin-top:2px}
      #wts-game-selector{width:100%;margin:18px auto 0;padding:18px;border:1px solid rgba(156,232,0,.18);border-radius:18px;background:rgba(255,255,255,.028);box-sizing:border-box;box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}
      .wts-game-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px}.wts-game-head>div{display:flex;flex-direction:column;min-width:0}.wts-game-head strong{font-size:16px}.wts-game-head span{font-size:11px;opacity:.55;margin-top:4px;line-height:1.35}.wts-auth-badge{font-size:9px;color:#9ce800;white-space:nowrap}.wts-auth-badge i{font-size:10px}
      .wts-game-options{display:grid;grid-template-columns:1fr 1fr;gap:11px}.wts-game-option{min-width:0;display:flex;align-items:center;gap:11px;padding:15px;border:1px solid rgba(255,255,255,.08);border-radius:13px;background:rgba(255,255,255,.022);cursor:pointer;transition:.18s}.wts-game-option:hover{border-color:rgba(156,232,0,.35);transform:translateY(-1px)}.wts-game-option.is-selected{border-color:rgba(156,232,0,.7);background:rgba(156,232,0,.075);box-shadow:0 0 0 2px rgba(156,232,0,.06)}.wts-game-option input{position:absolute;opacity:0}.wts-game-radio{width:17px;height:17px;flex:0 0 17px;border:2px solid #596267;border-radius:50%;position:relative}.wts-game-option.is-selected .wts-game-radio{border-color:#9ce800}.wts-game-option.is-selected .wts-game-radio:after{content:"";position:absolute;inset:4px;border-radius:50%;background:#9ce800}.wts-game-info{display:flex;flex-direction:column;min-width:0}.wts-game-option strong{font-size:14px}.wts-game-option small{font-size:10px;opacity:.5;margin-top:4px}
      .wts-connect-game,.wts-change-game,.wts-disconnect{width:100%;height:43px;margin-top:12px;border-radius:11px;font-size:12px;font-weight:800;cursor:pointer;transition:.18s}.wts-connect-game{border:0;background:linear-gradient(135deg,#9ce800,#b9ff19);color:#121719}.wts-connect-game:disabled{opacity:.38;cursor:not-allowed}.wts-connect-game.is-loading{opacity:.68}.wts-change-game,.wts-disconnect{background:transparent;border:1px solid rgba(255,255,255,.1);color:#b8c0c4;margin-top:0}.wts-change-game:hover{border-color:rgba(156,232,0,.4);color:#9ce800}.wts-disconnect:hover{border-color:rgba(255,92,92,.4);color:#ff7777}.wts-game-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:13px}
      .wts-connected-row{display:flex;align-items:center;gap:12px}.wts-connected-icon{width:36px;height:36px;flex:0 0 36px;display:grid;place-items:center;border-radius:50%;background:rgba(156,232,0,.12);color:#9ce800;font-size:13px}.wts-connected-info{min-width:0;flex:1;display:flex;flex-direction:column}.wts-connected-info strong{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wts-connected-info span{font-size:10px;opacity:.5;margin-top:4px}.wts-connected-badge{font-size:8px;font-weight:850;color:#9ce800;padding:6px 8px;border-radius:999px;background:rgba(156,232,0,.1)}
      .wts-game-monitor{margin-top:15px;padding:13px;border-radius:13px;border:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.12)}.wts-monitor-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.wts-monitor-head>div{display:flex;flex-direction:column}.wts-monitor-head strong{font-size:12px}.wts-monitor-head span{font-size:9px;opacity:.48;margin-top:3px}.wts-monitor-live{font-size:8px;font-weight:850;color:#9ce800;display:flex!important;flex-direction:row!important;align-items:center;gap:5px!important;margin:0!important}.wts-monitor-live i{width:6px;height:6px;border-radius:50%;background:#9ce800;box-shadow:0 0 8px rgba(156,232,0,.7)}.wts-monitor-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:10px}.wts-monitor-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;border-radius:8px;background:rgba(255,255,255,.025);font-size:8px}.wts-monitor-item span{opacity:.7}.wts-monitor-item b{font-size:7px}.wts-monitor-item.is-ok b{color:#9ce800}.wts-monitor-item.is-missing b{color:#ff7474}.wts-monitor-meta{display:flex;justify-content:space-between;gap:8px;margin-top:9px;font-size:8px;opacity:.55}.wts-monitor-events{margin-top:9px;font-size:8px;line-height:1.4;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* Phase 1 background: retain all existing UI/layout, add only the requested blue hue. */
      body:not(.wts-phase2){background:radial-gradient(circle at 50% 0%,rgba(75,135,255,.14),transparent 34%),radial-gradient(circle at 100% 100%,rgba(0,191,255,.08),transparent 38%),linear-gradient(145deg,#08111f 0%,#0c1728 50%,#091923 100%)}

      /* ============================================================
         PHASE 2 — FULL SCREEN GAME CONTROL UI
         This layer is dormant during Phase 1 and only activates after
         a verified game connection. Phase 1 layout/components remain intact.
         ============================================================ */
      html.wts-phase2,body.wts-phase2{width:100%;min-height:100%;height:auto;overflow:auto}
      body.wts-phase2{display:block;padding:0;background:radial-gradient(circle at 15% 0%,rgba(91,120,255,.22),transparent 34%),radial-gradient(circle at 92% 100%,rgba(0,191,255,.13),transparent 38%),linear-gradient(135deg,#070d1d 0%,#0b1328 48%,#071a25 100%)}
      body.wts-phase2::before{width:760px;height:760px;background:radial-gradient(circle,rgba(45,125,255,.10),transparent 67%)}
      .wts-phase2-shell{position:relative;z-index:2;width:100%;min-height:100vh;padding:clamp(22px,3vw,44px);box-sizing:border-box;color:#f4f7fb}
      .wts-p2-topbar{width:100%;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 0 24px;border-bottom:1px solid rgba(150,180,255,.14)}
      .wts-p2-brand{display:flex;align-items:center;gap:14px}.wts-p2-brand-dot{width:16px;height:16px;border-radius:50%;background:#64b5ff;box-shadow:0 0 22px rgba(80,170,255,.8)}.wts-p2-brand div{display:flex;flex-direction:column;gap:4px}.wts-p2-brand strong{font-size:clamp(18px,1.6vw,25px);letter-spacing:.06em}.wts-p2-brand small{font-size:clamp(11px,1vw,14px);letter-spacing:.12em;color:#8fa6c5}
      .wts-p2-top-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.wts-p2-top-actions button{height:48px;padding:0 19px;border-radius:12px;border:1px solid rgba(151,180,230,.2);background:rgba(255,255,255,.045);color:#dbe6f5;font-size:clamp(12px,.95vw,15px);font-weight:850;cursor:pointer}.wts-p2-top-actions button:hover{border-color:rgba(92,177,255,.55);background:rgba(92,177,255,.08)}.wts-p2-top-actions button:last-child{color:#ff9b9b;border-color:rgba(255,110,110,.2)}
      .wts-p2-session{display:flex;align-items:center;gap:8px;font-size:clamp(11px,.9vw,14px);font-weight:850;color:#9ee8b2;padding:0 10px}.wts-p2-session i{width:9px;height:9px;border-radius:50%;background:#69e48e;box-shadow:0 0 10px rgba(105,228,142,.7)}
      .wts-p2-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:30px;padding:clamp(32px,4vw,58px) 0 30px}.wts-p2-kicker,.wts-p2-card-head span,.wts-p2-section-title span:first-child{font-size:clamp(12px,1vw,15px);letter-spacing:.14em;color:#7fa3cf;font-weight:850}.wts-p2-heading h1{margin:8px 0 8px;font-size:clamp(40px,5vw,76px);line-height:.98;letter-spacing:-.035em}.wts-p2-heading p{margin:0;color:#91a4bf;font-size:clamp(14px,1.15vw,18px);line-height:1.55}.wts-p2-heading p span{color:#5f82ad;margin:0 7px}.wts-p2-live{display:flex;align-items:center;gap:10px;padding:13px 16px;border:1px solid rgba(105,228,142,.2);border-radius:14px;background:rgba(105,228,142,.06)}.wts-p2-live i{width:11px;height:11px;border-radius:50%;background:#69e48e;box-shadow:0 0 14px rgba(105,228,142,.7)}.wts-p2-live strong{font-size:14px;color:#8ef0ac}.wts-p2-live span{font-size:12px;color:#7f968e}
      .wts-p2-main-grid,.wts-p2-bottom-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,.8fr);gap:18px}.wts-p2-card{min-width:0;padding:clamp(22px,2vw,30px);border:1px solid rgba(145,177,226,.15);border-radius:22px;background:linear-gradient(145deg,rgba(20,32,57,.84),rgba(9,19,35,.9));box-shadow:0 20px 60px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.035)}.wts-p2-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.wts-p2-card-head>div{display:flex;flex-direction:column;gap:7px}.wts-p2-card-head strong{font-size:clamp(17px,1.4vw,23px)}.wts-p2-source,.wts-p2-ok{font-size:clamp(10px,.8vw,13px);letter-spacing:.08em;padding:8px 11px;border-radius:999px;white-space:nowrap}.wts-p2-source{color:#7ec6ff;background:rgba(72,166,255,.08);border:1px solid rgba(72,166,255,.16)}.wts-p2-ok{color:#8df0aa;background:rgba(90,220,125,.08);border:1px solid rgba(90,220,125,.16)}
      .wts-p2-value{min-height:150px;display:flex;align-items:center;justify-content:center;font-size:clamp(62px,8vw,122px);font-weight:900;letter-spacing:-.05em;color:#f6fbff;text-shadow:0 8px 40px rgba(80,180,255,.18)}.wts-p2-value.is-empty{font-size:clamp(40px,5vw,70px);color:#71849f}.wts-p2-round{display:flex;justify-content:space-between;gap:18px;padding-top:20px;border-top:1px solid rgba(145,177,226,.11)}.wts-p2-round span{font-size:clamp(11px,.9vw,14px);color:#7087a6;letter-spacing:.09em}.wts-p2-round strong{font-size:clamp(13px,1vw,16px);color:#dce8f6;text-align:right}.wts-p2-note{margin-top:18px;font-size:clamp(12px,1vw,15px);line-height:1.6;color:#7489a4}
      .wts-p2-stat-list{display:grid;gap:0;margin-top:24px}.wts-p2-stat-list div{display:flex;justify-content:space-between;gap:18px;padding:17px 0;border-bottom:1px solid rgba(145,177,226,.09)}.wts-p2-stat-list span{font-size:clamp(13px,1vw,16px);color:#8297b3}.wts-p2-stat-list b{font-size:clamp(12px,.95vw,15px);color:#9ce9b1}
      .wts-p2-section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin:30px 0 15px}.wts-p2-section-title>div{display:flex;flex-direction:column;gap:7px}.wts-p2-section-title strong{font-size:clamp(22px,2vw,32px)}.wts-p2-health-state{display:flex;align-items:center;gap:8px;font-size:clamp(11px,.9vw,14px);font-weight:850}.wts-p2-health-state i{width:9px;height:9px;border-radius:50%}.wts-p2-health-state.ok{color:#8debaa}.wts-p2-health-state.ok i{background:#69e48e;box-shadow:0 0 10px rgba(105,228,142,.65)}.wts-p2-health-state.warn{color:#ffc96b}.wts-p2-health-state.warn i{background:#ffc96b}
      .wts-p2-health-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.wts-p2-health-item{display:flex;align-items:center;gap:13px;min-width:0;padding:18px;border-radius:17px;border:1px solid rgba(145,177,226,.11);background:rgba(8,18,34,.62)}.wts-p2-health-icon{width:34px;height:34px;flex:0 0 34px;border-radius:50%;display:grid;place-items:center;font-size:17px;font-weight:900}.wts-p2-health-item.ok{border-color:rgba(95,220,128,.15)}.wts-p2-health-item.ok .wts-p2-health-icon{color:#75e89a;background:rgba(95,220,128,.09)}.wts-p2-health-item.missing{border-color:rgba(255,120,120,.15)}.wts-p2-health-item.missing .wts-p2-health-icon{color:#ff8b8b;background:rgba(255,100,100,.08)}.wts-p2-health-item div{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.wts-p2-health-item strong{font-size:clamp(13px,1vw,16px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wts-p2-health-item small{font-size:clamp(10px,.78vw,13px);color:#7187a5}.wts-p2-health-item>b{font-size:clamp(10px,.8vw,12px)}.wts-p2-health-item.ok>b{color:#79e89b}.wts-p2-health-item.missing>b{color:#ff8e8e}
      .wts-p2-bottom-grid{margin-top:18px}.wts-p2-events{display:grid;gap:10px;margin-top:20px}.wts-p2-event{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid rgba(145,177,226,.08)}.wts-p2-event i{width:8px;height:8px;border-radius:50%;background:#64b5ff;box-shadow:0 0 10px rgba(100,181,255,.5)}.wts-p2-event span{font-size:clamp(13px,1vw,16px);color:#b8c8dc}.wts-p2-event time{font-size:clamp(10px,.8vw,12px);color:#66809f}.wts-p2-monitor-box{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.wts-p2-monitor-box div{padding:15px;border-radius:13px;background:rgba(255,255,255,.025);display:flex;flex-direction:column;gap:7px}.wts-p2-monitor-box span{font-size:clamp(11px,.85vw,13px);color:#7288a6}.wts-p2-monitor-box b{font-size:clamp(12px,.95vw,15px);color:#d9e6f5;word-break:break-word}.wts-p2-monitor-copy{margin:17px 0 0;font-size:clamp(12px,.9vw,14px);line-height:1.6;color:#7187a3}
      @media(max-width:1000px){.wts-p2-topbar,.wts-p2-heading{align-items:flex-start;flex-direction:column}.wts-p2-top-actions{width:100%}.wts-p2-main-grid,.wts-p2-bottom-grid{grid-template-columns:1fr}.wts-p2-health-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:620px){.wts-phase2-shell{padding:18px}.wts-p2-topbar{padding-bottom:18px}.wts-p2-top-actions{display:grid;grid-template-columns:1fr 1fr}.wts-p2-session{grid-column:1/-1;padding:0}.wts-p2-top-actions button{width:100%;height:50px}.wts-p2-heading{padding:30px 0 22px}.wts-p2-heading h1{font-size:42px}.wts-p2-heading p{font-size:14px}.wts-p2-health-grid{grid-template-columns:1fr}.wts-p2-card{border-radius:18px;padding:20px}.wts-p2-value{min-height:125px;font-size:64px}.wts-p2-round{align-items:flex-start;flex-direction:column;gap:8px}.wts-p2-round strong{text-align:left}.wts-p2-monitor-box{grid-template-columns:1fr}.wts-p2-section-title{align-items:flex-start;flex-direction:column}.wts-p2-live{width:max-content}.wts-p2-brand strong{font-size:18px}}
      @media(max-width:380px){.wts-p2-top-actions{grid-template-columns:1fr}.wts-p2-session{grid-column:auto}.wts-p2-heading h1{font-size:36px}.wts-p2-value{font-size:56px}}
            #wts-login-toast{position:fixed;left:50%;bottom:18px;z-index:99999;max-width:min(560px,calc(100vw - 28px));padding:10px 14px;border-radius:10px;font-size:11px;font-weight:750;line-height:1.3;opacity:0;pointer-events:none;transform:translate(-50%,10px);transition:.18s;background:#181d20;color:#fff;border:1px solid rgba(255,255,255,.08);box-shadow:0 12px 30px rgba(0,0,0,.35)}#wts-login-toast.is-visible{opacity:1;transform:translate(-50%,0)}#wts-login-toast.is-error{border-color:rgba(255,80,80,.35)}#wts-login-toast.is-success{border-color:rgba(156,232,0,.3)}
      .wts-info-button{position:fixed;right:18px;top:18px;width:42px;height:42px;border-radius:50%;border:1px solid rgba(156,232,0,.45);background:rgba(20,25,28,.94);color:#9ce800;font-size:20px;font-weight:900;line-height:1;cursor:pointer;z-index:100000;box-shadow:0 8px 25px rgba(0,0,0,.35);transition:.18s}.wts-info-button:hover{transform:scale(1.05);background:rgba(156,232,0,.1)}
      .wts-info-modal{position:fixed;inset:0;z-index:100001;display:none}.wts-info-modal.is-open{display:block}.wts-info-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(5px)}.wts-info-dialog{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,calc(100vw - 30px));max-height:calc(100vh - 40px);overflow:auto;padding:25px;border-radius:20px;border:1px solid rgba(156,232,0,.22);background:linear-gradient(145deg,#202629,#13181b);box-shadow:0 30px 90px rgba(0,0,0,.65)}.wts-info-close{position:absolute;right:14px;top:12px;width:32px;height:32px;border:0;border-radius:50%;background:rgba(255,255,255,.05);color:#aab1b4;font-size:23px;cursor:pointer}.wts-info-icon{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:rgba(156,232,0,.1);border:1px solid rgba(156,232,0,.35);color:#9ce800;font-size:19px;font-weight:900;float:left;margin-right:12px}.wts-info-title{padding-top:2px;min-height:40px;display:flex;flex-direction:column}.wts-info-title strong{font-size:16px}.wts-info-title span{font-size:10px;opacity:.5;margin-top:4px}.wts-info-steps{clear:both;display:grid;gap:7px;margin-top:19px}.wts-info-step{display:flex;gap:11px;padding:10px;border-radius:11px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05)}.wts-info-step>b{font-size:10px;color:#9ce800;padding-top:1px}.wts-info-step div{display:flex;flex-direction:column;gap:3px}.wts-info-step strong{font-size:10px}.wts-info-step span{font-size:9px;line-height:1.4;opacity:.58}.wts-attention{margin-top:13px;padding:12px;border-radius:11px;border:1px solid rgba(255,170,50,.25);background:rgba(255,170,50,.055)}.wts-attention strong{font-size:10px;color:#ffc36b}.wts-attention p{margin:6px 0 0;font-size:9px;line-height:1.5;color:#c5c9ca}
      @media(max-width:620px){.wts-login-card{width:100%;padding:30px 23px 26px}.wts-game-options{grid-template-columns:1fr}.wts-game-head{align-items:flex-start;flex-direction:column}.wts-auth-badge{align-self:flex-start}.wts-info-button{right:12px;top:12px}}
      @media(max-height:650px){body{align-items:flex-start}.wts-login-card{max-height:calc(100vh - 24px);padding-top:24px;padding-bottom:22px}.wts-login-brand{margin-bottom:16px}.wts-login-heading{margin-bottom:16px}.wts-info-dialog{top:12px;transform:translateX(-50%);max-height:calc(100vh - 24px)}}

      /* ============================================================
         PHASE 2C + 2D — REAL-TIME EVENT ENGINE + COMMAND CENTER
         ============================================================ */
      body.wts-phase2{box-sizing:border-box;min-width:0;width:100vw;max-width:100vw;margin:0;padding:0;display:block;overflow-x:hidden!important}
      body.wts-phase2 .wts-login-card{display:none!important}
      body.wts-phase2 #wts-game-selector{display:block!important;position:relative;width:100%!important;max-width:none!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important}
      .wts-phase2-shell{width:100%;min-height:100dvh;padding:clamp(28px,4vw,64px) clamp(20px,4vw,72px)!important;box-sizing:border-box}
      .wts-phase2-shell>*{width:100%;max-width:1720px;margin-left:auto;margin-right:auto}
      .wts-p2-topbar,.wts-p2-heading,.wts-p2-main-grid,.wts-p2-health-grid,.wts-p2-bottom-grid,.wts-p2-section-title{margin-left:auto;margin-right:auto}
      .wts-p2-topbar{max-width:1720px!important}
      .wts-p2-heading{max-width:1720px!important}
      .wts-p2-main-grid,.wts-p2-bottom-grid{max-width:1720px!important;grid-template-columns:minmax(0,1.55fr) minmax(390px,.75fr)!important;gap:26px!important}
      .wts-p2-health-grid{max-width:1720px!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:18px!important}
      .wts-p2-section-title{max-width:1720px!important}
      .wts-p2-card{padding:clamp(28px,2.4vw,42px)!important;border-radius:26px!important}
      .wts-p2-brand strong{font-size:clamp(22px,1.8vw,30px)!important}
      .wts-p2-brand small{font-size:clamp(13px,1.05vw,16px)!important}
      .wts-p2-top-actions button{height:54px!important;font-size:clamp(14px,1vw,17px)!important;padding:0 22px!important}
      .wts-p2-session{font-size:clamp(13px,1vw,16px)!important}
      .wts-p2-heading h1{font-size:clamp(48px,5.8vw,88px)!important}
      .wts-p2-heading p{font-size:clamp(16px,1.25vw,20px)!important}
      .wts-p2-kicker,.wts-p2-card-head span,.wts-p2-section-title span:first-child{font-size:clamp(13px,1vw,16px)!important}
      .wts-p2-live strong{font-size:16px!important}.wts-p2-live span{font-size:14px!important}
      .wts-p2-card-head strong{font-size:clamp(20px,1.55vw,26px)!important}
      .wts-p2-source,.wts-p2-ok{font-size:clamp(12px,.9vw,15px)!important;padding:9px 13px!important}
      .wts-p2-value{min-height:210px!important;font-size:clamp(76px,9vw,150px)!important}
      .wts-p2-value.is-empty{font-size:clamp(48px,5vw,78px)!important}
      .wts-p2-round span{font-size:clamp(13px,1vw,16px)!important}.wts-p2-round strong{font-size:clamp(15px,1.05vw,18px)!important}
      .wts-p2-note,.wts-p2-monitor-copy{font-size:clamp(14px,1vw,17px)!important}
      .wts-p2-stat-list span{font-size:clamp(15px,1.05vw,18px)!important}.wts-p2-stat-list b{font-size:clamp(14px,1vw,17px)!important}
      .wts-p2-section-title strong{font-size:clamp(26px,2.2vw,36px)!important}
      .wts-p2-health-item{padding:21px!important;gap:15px!important}.wts-p2-health-item strong{font-size:clamp(15px,1.05vw,18px)!important}.wts-p2-health-item small{font-size:clamp(12px,.9vw,15px)!important}.wts-p2-health-item>b{font-size:clamp(12px,.85vw,14px)!important}
      .wts-p2-event span{font-size:clamp(14px,1.05vw,17px)!important}.wts-p2-event time{font-size:clamp(11px,.85vw,14px)!important}
      .wts-p2-stream{font-size:clamp(12px,.9vw,14px)!important;letter-spacing:.08em;padding:8px 12px;border-radius:999px;white-space:nowrap}.wts-p2-stream.is-live{color:#8df0aa;background:rgba(90,220,125,.08);border:1px solid rgba(90,220,125,.16)}.wts-p2-stream.is-warn{color:#ffc96b;background:rgba(255,190,80,.08);border:1px solid rgba(255,190,80,.16)}

      /* Phase 1 typography uplift — layout untouched, only readability increased. */
      body:not(.wts-phase2) .wts-login-heading h1{font-size:clamp(32px,7vw,42px)!important}
      body:not(.wts-phase2) .wts-login-heading p{font-size:clamp(15px,3vw,18px)!important}
      body:not(.wts-phase2) .wts-login-form-label{font-size:15px!important}
      body:not(.wts-phase2) .wts-login-input,.wts-login-input{font-size:17px!important}
      body:not(.wts-phase2) .wts-login-button{font-size:16px!important}
      body:not(.wts-phase2) .wts-login-status{font-size:14px!important}
      body:not(.wts-phase2) .wts-login-options,.wts-login-options{font-size:14px!important}
      body:not(.wts-phase2) .wts-login-secure{font-size:13px!important}
      body:not(.wts-phase2) .wts-game-head strong{font-size:20px!important}.wts-game-head span{font-size:13px!important}.wts-auth-badge{font-size:12px!important}
      body:not(.wts-phase2) .wts-game-option{padding:18px!important}.wts-game-option strong{font-size:17px!important}.wts-game-option small{font-size:13px!important}
      body:not(.wts-phase2) .wts-connect-game,.wts-change-game,.wts-disconnect{font-size:14px!important;height:50px!important}
      body:not(.wts-phase2) .wts-connected-info strong{font-size:18px!important}.wts-connected-info span{font-size:13px!important}.wts-connected-badge{font-size:11px!important}
      .wts-monitor-head strong{font-size:15px!important}.wts-monitor-head span{font-size:12px!important}.wts-monitor-item{font-size:12px!important;padding:11px!important}.wts-monitor-item b{font-size:11px!important}.wts-monitor-meta{font-size:11px!important}.wts-monitor-events{font-size:11px!important}

      @media(max-width:1100px){.wts-p2-main-grid,.wts-p2-bottom-grid{grid-template-columns:1fr!important}.wts-p2-health-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}

      .wts-p3-control-strip{display:grid;grid-template-columns:minmax(260px,.75fr) minmax(0,2fr);gap:18px;margin:20px 0 34px}
      .wts-p3-balance-card,.wts-p3-bet-card{border:1px solid rgba(120,180,255,.16);background:rgba(10,19,38,.72);border-radius:20px;padding:22px;box-shadow:0 16px 45px rgba(0,0,0,.18)}
      .wts-p3-balance-card{display:flex;flex-direction:column;justify-content:center;min-height:170px}.wts-p3-balance-card>span,.wts-p3-bet-head>span{font-size:13px;font-weight:800;letter-spacing:.12em;opacity:.7}.wts-p3-balance-card strong{font-size:clamp(30px,4vw,52px);margin:8px 0}.wts-p3-balance-card small,.wts-p3-bet-note{font-size:13px;opacity:.62}
      .wts-p3-bets{display:grid;grid-template-columns:1fr 1fr;gap:18px}.wts-p3-bet-card{display:flex;flex-direction:column;gap:14px}.wts-p3-bet-head{display:flex;justify-content:space-between;align-items:center}.wts-p3-bet-head b{font-size:11px;padding:6px 9px;border-radius:999px}.wts-p3-bet-head b.ready{background:rgba(34,197,94,.14);color:#6ee7a0}.wts-p3-bet-head b.waiting{background:rgba(245,158,11,.12);color:#fbbf24}.wts-p3-bet-amount{font-size:28px;font-weight:800}.wts-p3-bet-amount small{font-size:14px;opacity:.65}.wts-p3-bet-button{width:100%;min-height:58px;border:0;border-radius:14px;background:linear-gradient(135deg,#1d8cff,#00c8ff);color:white;font-weight:900;font-size:16px;cursor:pointer}.wts-p3-bet-button:disabled{opacity:.38;cursor:not-allowed}.wts-p3-unavailable{padding:28px;border:1px dashed rgba(255,255,255,.14);border-radius:18px;opacity:.7}
      .wts-p3-btn-bet{background:linear-gradient(135deg,#1d8cff,#00c8ff)}.wts-p3-btn-cancel{background:linear-gradient(135deg,#ef4444,#dc2626)}.wts-p3-btn-cashout{background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#1a1300}
      .wts-p3-state-cancel{border-color:rgba(239,68,68,.28)}.wts-p3-state-cashout{border-color:rgba(245,158,11,.32)}
      @media(max-width:850px){.wts-p3-control-strip{grid-template-columns:1fr}.wts-p3-bets{grid-template-columns:1fr}}
      @media(max-width:700px){.wts-phase2-shell{padding:22px 16px!important}.wts-p2-topbar{gap:18px}.wts-p2-heading h1{font-size:46px!important}.wts-p2-heading p{font-size:16px!important}.wts-p2-health-grid{grid-template-columns:1fr!important}.wts-p2-card{padding:24px!important}.wts-p2-value{min-height:160px!important;font-size:72px!important}.wts-p2-top-actions{width:100%}.wts-p2-top-actions button{flex:1;min-width:0}.wts-p2-session{width:100%;justify-content:flex-start;padding:0}.wts-p2-event{grid-template-columns:10px 1fr;gap:10px}.wts-p2-event time{grid-column:2}}
      @media(max-width:430px){.wts-p2-heading h1{font-size:40px!important}.wts-p2-card{padding:20px!important}.wts-p2-top-actions{display:grid!important;grid-template-columns:1fr 1fr}.wts-p2-session{grid-column:1/-1}.wts-p2-top-actions button{width:100%}.wts-p2-value{font-size:60px!important}.wts-p2-round{gap:10px}}
    `;
    document.head.appendChild(style);
  }

  window.__wts = {
    getState: () => ({ loginRunning, connected, selectedGame }),
    status: async () => (await fetch(API.status, { cache: 'no-store' })).json(),
    gameDom: async () => (await fetch(API.gameDom, { cache: 'no-store' })).json(),
    reset: async () => (await fetch(API.reset, { method: 'POST', cache: 'no-store' })).json()
  };

  updateLoginButton();
})();
