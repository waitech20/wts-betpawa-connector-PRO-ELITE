(() => {
  'use strict';

  const API_ORIGIN = 'http://127.0.0.1:3930';
  const API = {
    startLogin: `${API_ORIGIN}/api/start-login`,
    waitLogin: `${API_ORIGIN}/api/wait-login`,
    connectGame: `${API_ORIGIN}/api/connect-game`,
    status: `${API_ORIGIN}/api/status`,
    reset: `${API_ORIGIN}/api/reset`
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
  let pollAbort = false;
  let lastDomEventId = null;
  let statusTimer = null;

  injectStyles();

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function setStatus(message, type = '') {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.className = `wts-login-status ${type ? `is-${type}` : ''}`;
  }

  function toast(message, type = 'success') {
    let el = document.getElementById('wts-login-toast');
    if (!el) { el = document.createElement('div'); el.id = 'wts-login-toast'; document.body.appendChild(el); }
    el.textContent = message;
    el.className = `wts-login-toast is-visible is-${type}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('is-visible'), 3000);
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

  function disableCredentials() {
    phoneInput.disabled = true;
    passwordInput.disabled = true;
    if (togglePassword) togglePassword.disabled = true;
    if (rememberInput) rememberInput.disabled = true;
    loginButton.disabled = true;
    loginButton.classList.remove('is-active', 'is-loading');
  }

  function enableCredentials() {
    if (connected) return;
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
    pollAbort = false;
    updateLoginButton();
    setStatus('Authenticating…', 'loading');

    try {
      const response = await fetch(API.startLogin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password }), cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Login could not be started.');
      if (data.authenticated) { onAuthenticated(); return; }
      if (!data.requestId) throw new Error('Login request was not created.');
      await pollLogin(data.requestId);
    } catch (e) {
      loginRunning = false;
      enableCredentials();
      setStatus(e.message || 'Could not connect to the local connector.', 'error');
      toast('🔴 Login failed.', 'error');
    }
  }

  async function pollLogin(requestId) {
    const started = Date.now();
    while (!pollAbort && Date.now() - started < 40000) {
      try {
        const r = await fetch(`${API.waitLogin}?requestId=${encodeURIComponent(requestId)}`, { cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        consumeDomEvents(d.domHealth, d.domEvents);
        if (d.status === 'AUTHENTICATED' && d.authenticated) { onAuthenticated(); return; }
        if (d.status === 'LOGIN_FAILED') {
          loginRunning = false;
          enableCredentials();
          setStatus(d.message || 'Mobile number or password is incorrect.', 'error');
          toast('🔴 Login not verified.', 'error');
          return;
        }
        setStatus('Authenticating…', 'loading');
      } catch {}
      await sleep(100);
    }
    loginRunning = false;
    enableCredentials();
    setStatus('Login could not be verified. Please try again.', 'error');
    toast('🔴 Authentication verification timed out.', 'error');
  }

  function onAuthenticated() {
    loginRunning = false;
    connected = true;
    disableCredentials();
    setStatus('Connected.', 'success');
    toast('🟢 BetPawa authentication verified.', 'success');
    showGameSelector();
    startStatusMonitor();
  }

  function showGameSelector() {
    if (gameSection) { renderGameChooser(); return; }
    gameSection = document.createElement('section');
    gameSection.id = 'wts-game-selector';
    form.insertAdjacentElement('afterend', gameSection);
    renderGameChooser();
  }

  function renderGameChooser() {
    if (!gameSection) return;
    gameSection.className = 'wts-game-selector';
    gameSection.innerHTML = `
      <div class="wts-game-head"><div><strong>Choose Game</strong><span>Select one game to connect</span></div><b class="wts-auth-badge"><i class="fa-solid fa-circle-check"></i> Authenticated</b></div>
      <div class="wts-game-options">
        <label class="wts-game-option" data-game="aviator"><input type="radio" name="wts-game" value="aviator"><span class="wts-game-radio"></span><span><strong>Aviator</strong><small>34971</small></span></label>
        <label class="wts-game-option" data-game="fortunerMine"><input type="radio" name="wts-game" value="fortunerMine"><span class="wts-game-radio"></span><span><strong>Fortuner Mine</strong><small>35102</small></span></label>
      </div>
      <button type="button" id="wts-connect-game" class="wts-connect-game" disabled><i class="fa-solid fa-link"></i><span>Connect Game</span></button>
    `;
    gameSection.querySelectorAll('input[name="wts-game"]').forEach(r => r.addEventListener('change', () => {
      selectedGame = r.value;
      gameSection.querySelectorAll('.wts-game-option').forEach(o => o.classList.toggle('is-selected', o.dataset.game === selectedGame));
      const b = document.getElementById('wts-connect-game'); if (b) b.disabled = !selectedGame;
    }));
    document.getElementById('wts-connect-game')?.addEventListener('click', () => void connectGame());
  }

  async function connectGame() {
    if (!connected || !selectedGame) return;
    const b = document.getElementById('wts-connect-game');
    if (!b) return;
    b.disabled = true; b.classList.add('is-loading'); b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Verifying & connecting…</span>';
    setStatus('Verifying authentication before game access…', 'loading');
    try {
      const r = await fetch(API.connectGame, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: selectedGame }), cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.message || 'Game connection blocked.');
      showConnectedGame(d.game?.name || selectedGame, d.game?.id || '');
      setStatus(`${d.game?.name || 'Game'} connected.`, 'success');
      toast(`🟢 ${d.game?.name || 'Game'} connected.`, 'success');
    } catch (e) {
      b.disabled = false; b.classList.remove('is-loading'); b.innerHTML = '<i class="fa-solid fa-link"></i><span>Connect Game</span>';
      setStatus(e.message || 'Game connection failed.', 'error');
      toast('🔴 Game connection blocked.', 'error');
    }
  }

  function showConnectedGame(name, id) {
    if (!gameSection) return;
    gameSection.className = 'wts-game-selector is-connected';
    gameSection.innerHTML = `
      <div class="wts-connected-row"><div class="wts-connected-icon"><i class="fa-solid fa-check"></i></div><div class="wts-connected-info"><strong>${escapeHtml(name)}</strong><span>Game ${escapeHtml(id)}</span></div><span class="wts-connected-badge">CONNECTED</span></div>
      <button type="button" id="wts-change-game" class="wts-change-game"><i class="fa-solid fa-arrows-rotate"></i><span>Change Game</span></button>
    `;
    document.getElementById('wts-change-game')?.addEventListener('click', () => {
      selectedGame = null;
      renderGameChooser();
      setStatus('Choose another game.', '');
    });
  }

  function consumeDomEvents(domHealth, events) {
    if (Array.isArray(events) && events.length) {
      const fresh = events.slice().reverse().filter(e => !lastDomEventId || e.id !== lastDomEventId);
      if (fresh.length) {
        lastDomEventId = events[0].id;
        const important = fresh[fresh.length - 1];
        if (important.type === 'MISSING') toast(`🔴 DOM: ${important.group} not found`, 'error');
        if (important.type === 'RECOVERED') toast(`🟢 DOM: ${important.group} recovered`, 'success');
      }
    }
  }

  function startStatusMonitor() {
    if (statusTimer) return;
    statusTimer = setInterval(async () => {
      try {
        const r = await fetch(API.status, { cache: 'no-store' });
        const d = await r.json();
        consumeDomEvents(d.domHealth, d.domEvents);
        if (connected && !d.authenticated && ['AUTHENTICATING', 'LOGIN_FAILED'].includes(d.state)) {
          connected = false;
          selectedGame = null;
          gameSection?.remove(); gameSection = null;
          enableCredentials();
          setStatus('Authentication session is no longer verified.', 'error');
          toast('🔴 Session verification lost.', 'error');
        }
      } catch {}
    }, 600);
  }

  function escapeHtml(v) { return String(v || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

  function injectStyles() {
    if (document.getElementById('wts-pro-runtime-css')) return;
    const style = document.createElement('style');
    style.id = 'wts-pro-runtime-css';
    style.textContent = `
      .wts-login-card{max-height:calc(100vh - 24px);overflow:auto;scrollbar-width:none}.wts-login-card::-webkit-scrollbar{display:none}
      #wts-login-status{min-height:15px;margin-top:6px;font-size:11px}.wts-login-status.is-success{color:#9ce800}.wts-login-status.is-error{color:#ff5c5c}.wts-login-status.is-loading{opacity:.72}
      #wts-game-selector{width:100%;margin:10px auto 0;padding:10px;border:1px solid rgba(156,232,0,.16);border-radius:13px;background:rgba(255,255,255,.025);box-sizing:border-box}
      .wts-game-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.wts-game-head>div{display:flex;flex-direction:column}.wts-game-head strong{font-size:13px}.wts-game-head span{font-size:9px;opacity:.55;margin-top:2px}.wts-auth-badge{font-size:8px;color:#9ce800;white-space:nowrap}.wts-auth-badge i{font-size:9px}
      .wts-game-options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.wts-game-option{min-width:0;display:flex;align-items:center;gap:7px;padding:8px;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:rgba(255,255,255,.02);cursor:pointer}.wts-game-option.is-selected{border-color:rgba(156,232,0,.65);background:rgba(156,232,0,.07)}.wts-game-option input{position:absolute;opacity:0}.wts-game-radio{width:13px;height:13px;flex:0 0 13px;border:2px solid #596267;border-radius:50%;position:relative}.wts-game-option.is-selected .wts-game-radio{border-color:#9ce800}.wts-game-option.is-selected .wts-game-radio:after{content:"";position:absolute;inset:3px;border-radius:50%;background:#9ce800}.wts-game-option>span:last-child{display:flex;flex-direction:column;min-width:0}.wts-game-option strong{font-size:11px}.wts-game-option small{font-size:8px;opacity:.5;margin-top:2px}
      .wts-connect-game,.wts-change-game{width:100%;height:34px;margin-top:8px;border:0;border-radius:9px;background:linear-gradient(135deg,#9ce800,#b9ff19);color:#121719;font-size:10px;font-weight:800;cursor:pointer}.wts-connect-game:disabled{opacity:.4;cursor:not-allowed}.wts-connect-game.is-loading{opacity:.65}
      .wts-connected-row{display:flex;align-items:center;gap:8px}.wts-connected-icon{width:28px;height:28px;flex:0 0 28px;display:grid;place-items:center;border-radius:50%;background:rgba(156,232,0,.12);color:#9ce800;font-size:11px}.wts-connected-info{min-width:0;flex:1;display:flex;flex-direction:column}.wts-connected-info strong{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wts-connected-info span{font-size:8px;opacity:.5;margin-top:2px}.wts-connected-badge{font-size:7px;font-weight:800;color:#9ce800;padding:4px 6px;border-radius:999px;background:rgba(156,232,0,.1)}.wts-change-game{height:30px;background:transparent;border:1px solid rgba(255,255,255,.09);color:#aab1b4;margin-top:7px}.wts-change-game:hover{border-color:rgba(156,232,0,.35);color:#9ce800}
      #wts-login-toast{position:fixed;left:50%;bottom:12px;z-index:99999;max-width:calc(100vw - 24px);padding:8px 11px;border-radius:9px;font-size:10px;font-weight:700;line-height:1.25;opacity:0;pointer-events:none;transform:translate(-50%,8px);transition:.18s;background:#181d20;color:#fff;border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 24px rgba(0,0,0,.3)}#wts-login-toast.is-visible{opacity:1;transform:translate(-50%,0)}#wts-login-toast.is-error{border-color:rgba(255,80,80,.35)}#wts-login-toast.is-success{border-color:rgba(156,232,0,.3)}
      @media(max-width:380px){.wts-game-options{grid-template-columns:1fr}.wts-game-option{padding:7px}}
    `;
    document.head.appendChild(style);
  }

  window.__wts = {
    getState: () => ({ loginRunning, connected, selectedGame }),
    status: async () => (await fetch(API.status, { cache: 'no-store' })).json(),
    reset: async () => (await fetch(API.reset, { method: 'POST' })).json()
  };

  updateLoginButton();
})();
