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

  function hideCredentialsUI() {
    const formGroups = form.querySelectorAll('.wts-login-form-group');
    const optionsSection = form.querySelector('.wts-login-options');
    formGroups.forEach(group => group.style.display = 'none');
    if (optionsSection) optionsSection.style.display = 'none';
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
    hideCredentialsUI();
    setStatus('✓ Authentication Verified', 'success');
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
      <div class="wts-authenticated-status">
        <div class="wts-status-indicator"></div>
        <div class="wts-status-text">
          <strong>● CONNECTED</strong>
          <span class="wts-status-badge">Authentication<br><strong>VERIFIED ✓</strong></span>
        </div>
      </div>
      <div class="wts-game-head"><div><strong>Choose Game</strong><span>Select one game to connect</span></div></div>
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
      <div class="wts-connected-row"><div class="wts-connected-icon"><i class="fa-solid fa-check"></i></div><div class="wts-connected-info"><strong>${escapeHtml(name)}</strong><span>Game ${escapeHtml(id)}</span></div></div>
      <button type="button" id="wts-change-game" class="wts-change-game"><i class="fa-solid fa-arrows-rotate"></i><span>Change Game</span></button>
      <button type="button" id="wts-disconnect" class="wts-disconnect"><i class="fa-solid fa-plug-circle-xmark"></i><span>Disconnect</span></button>
    `;
    document.getElementById('wts-change-game')?.addEventListener('click', () => {
      selectedGame = null;
      renderGameChooser();
      setStatus('Choose another game.', '');
    });
    document.getElementById('wts-disconnect')?.addEventListener('click', () => void disconnectSession());
  }

  async function disconnectSession() {
    try {
      const r = await fetch(API.reset, { method: 'POST', cache: 'no-store' });
      if (!r.ok) throw new Error('Reset failed');
      location.reload();
    } catch (e) {
      toast('🔴 Disconnect failed.', 'error');
      console.error('Disconnect error:', e);
    }
  }

  function consumeDomEvents(domHealth, events) {
    if (Array.isArray(events) && events.length) {
      const fresh = events.slice().reverse().filter(e => !lastDomEventId || e.id !== lastDomEventId);
      if (fresh.length) {
        lastDomEventId = events[0].id;
        const important = fresh[fresh.length - 1];
        if (important.type === 'MISSING' && connected) toast(`🔴 DOM: ${important.group} not found`, 'error');
        if (important.type === 'RECOVERED' && connected) toast(`🟢 DOM: ${important.group} recovered`, 'success');
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
          form.querySelectorAll('.wts-login-form-group').forEach(g => g.style.display = '');
          form.querySelector('.wts-login-options').style.display = '';
          setStatus('Authentication session is no longer verified.', 'error');
          toast('🔴 Session verification lost.', 'error');
        }
      } catch {}
    }, 600);
  }

  function showInfoModal() {
    let modal = document.getElementById('wts-info-modal');
    if (modal) { modal.classList.add('is-visible'); return; }
    
    modal = document.createElement('div');
    modal.id = 'wts-info-modal';
    modal.className = 'wts-info-modal';
    modal.innerHTML = `
      <div class="wts-modal-backdrop"></div>
      <div class="wts-modal-content">
        <button class="wts-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        <h2>How It Works</h2>
        <div class="wts-modal-steps">
          <div class="wts-step">
            <div class="wts-step-number">①</div>
            <div class="wts-step-content">
              <strong>LOGIN</strong>
              <p>Enter your BetPawa mobile number and password.</p>
            </div>
          </div>
          <div class="wts-step">
            <div class="wts-step-number">②</div>
            <div class="wts-step-content">
              <strong>VERIFY</strong>
              <p>Your authentication is verified server-side first.</p>
            </div>
          </div>
          <div class="wts-step">
            <div class="wts-step-number">③</div>
            <div class="wts-step-content">
              <strong>CHOOSE GAME</strong>
              <p>Select one available game to connect.</p>
            </div>
          </div>
          <div class="wts-step">
            <div class="wts-step-number">④</div>
            <div class="wts-step-content">
              <strong>CONNECT</strong>
              <p>Open the selected game using your authenticated session.</p>
            </div>
          </div>
          <div class="wts-step">
            <div class="wts-step-number">⑤</div>
            <div class="wts-step-content">
              <strong>CHANGE GAME</strong>
              <p>Switch games without logging in again while authenticated.</p>
            </div>
          </div>
          <div class="wts-step">
            <div class="wts-step-number">⑥</div>
            <div class="wts-step-content">
              <strong>MONITOR</strong>
              <p>Important DOM elements are monitored for changes.</p>
            </div>
          </div>
        </div>
        <div class="wts-modal-divider"></div>
        <div class="wts-modal-attention">
          <div class="wts-attention-title">⚠ ATTENTION</div>
          <p>This connector is for authorized account connection and monitoring only.</p>
          <p>It does not predict game results or guarantee winnings.</p>
          <p>Keep your credentials private and never share your password.</p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    modal.querySelector('.wts-modal-close').addEventListener('click', () => modal.classList.remove('is-visible'));
    modal.querySelector('.wts-modal-backdrop').addEventListener('click', () => modal.classList.remove('is-visible'));
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.classList.remove('is-visible'); });
    
    modal.classList.add('is-visible');
  }

  function escapeHtml(v) { return String(v || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

  function injectStyles() {
    if (document.getElementById('wts-pro-runtime-css')) return;
    const style = document.createElement('style');
    style.id = 'wts-pro-runtime-css';
    style.textContent = `
      .wts-login-card{max-height:calc(100vh - 24px);overflow:auto;scrollbar-width:none}.wts-login-card::-webkit-scrollbar{display:none}
      #wts-login-status{min-height:15px;margin-top:6px;font-size:11px}.wts-login-status.is-success{color:#9ce800}.wts-login-status.is-error{color:#ff5c5c}.wts-login-status.is-loading{opacity:.72}
      .wts-info-btn{position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;border-radius:50%;background:rgba(156,232,0,.1);color:#9ce800;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;transition:.2s ease}
      .wts-info-btn:hover{background:rgba(156,232,0,.2)}
      #wts-game-selector{width:100%;margin:10px auto 0;padding:10px;border:1px solid rgba(156,232,0,.16);border-radius:13px;background:rgba(255,255,255,.025);box-sizing:border-box}
      .wts-authenticated-status{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px;border-radius:9px;background:rgba(156,232,0,.08)}
      .wts-status-indicator{width:8px;height:8px;border-radius:50%;background:#9ce800;animation:pulse 2s infinite}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
      .wts-status-text strong{font-size:12px;color:#9ce800}.wts-status-badge{display:block;font-size:9px;color:#8e989d;margin-top:3px}
      .wts-game-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.wts-game-head>div{display:flex;flex-direction:column}.wts-game-head strong{font-size:13px;color:#fff}.wts-game-head span{font-size:10px;color:#8e989d}
      .wts-game-options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.wts-game-option{min-width:0;display:flex;align-items:center;gap:7px;padding:8px;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:rgba(255,255,255,.01);cursor:pointer;transition:.2s ease}.wts-game-option input{display:none}.wts-game-option.is-selected{border-color:#9ce800;background:rgba(156,232,0,.1)}.wts-game-option span:first-of-type{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-radius:50%;display:grid;place-items:center}.wts-game-option.is-selected span:first-of-type{border-color:#9ce800;background:#9ce800}.wts-game-option.is-selected span:first-of-type::after{content:'';width:4px;height:4px;background:#121719;border-radius:50%}.wts-game-option strong{font-size:11px}.wts-game-option small{font-size:9px;color:#8e989d;display:block}
      .wts-connect-game,.wts-change-game,.wts-disconnect{width:100%;height:34px;margin-top:8px;border:0;border-radius:9px;background:linear-gradient(135deg,#9ce800,#b9ff19);color:#121719;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:.2s ease}
      .wts-connect-game:disabled{opacity:.5;cursor:not-allowed}.wts-connect-game:not(:disabled):hover,.wts-change-game:hover,.wts-disconnect:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(156,232,0,.2)}
      .wts-change-game,.wts-disconnect{background:linear-gradient(135deg,rgba(156,232,0,.8),rgba(185,255,25,.8))}
      .wts-disconnect{background:linear-gradient(135deg,rgba(255,92,92,.6),rgba(255,150,150,.6));color:#fff}
      .wts-connect-game.is-loading,.wts-change-game.is-loading{opacity:.7}
      .wts-connected-row{display:flex;align-items:center;gap:8px}.wts-connected-icon{width:28px;height:28px;flex:0 0 28px;display:grid;place-items:center;border-radius:50%;background:rgba(156,232,0,.2);color:#9ce800;font-size:14px}
      .wts-connected-info{flex:1}.wts-connected-info strong{font-size:11px;color:#fff;display:block}.wts-connected-info span{font-size:9px;color:#8e989d;display:block}
      #wts-login-toast{position:fixed;left:50%;bottom:12px;z-index:99999;max-width:calc(100vw - 24px);padding:8px 11px;border-radius:9px;font-size:10px;font-weight:700;line-height:1.25;opacity:0;pointer-events:none;transform:translateX(-50%) translateY(100px);transition:.3s ease;background:#1a1a1a;color:#fff;border:1px solid rgba(156,232,0,.3)}
      #wts-login-toast.is-visible{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
      #wts-login-toast.is-success{border-color:#9ce800;color:#9ce800}
      #wts-login-toast.is-error{border-color:#ff5c5c;color:#ff5c5c}
      .wts-info-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:99998;align-items:center;justify-content:center}
      .wts-info-modal.is-visible{display:flex}
      .wts-modal-backdrop{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);cursor:pointer}
      .wts-modal-content{position:relative;z-index:1;width:min(100%,420px);max-height:80vh;overflow-y:auto;background:linear-gradient(145deg,rgba(31,37,40,.98),rgba(20,25,28,.98));border:1px solid rgba(156,232,0,.2);border-radius:16px;padding:20px;box-shadow:0 25px 70px rgba(0,0,0,.62)}
      .wts-modal-close{position:absolute;top:10px;right:10px;width:28px;height:28px;border:0;background:rgba(156,232,0,.1);border-radius:50%;color:#9ce800;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:.2s ease;z-index:10}
      .wts-modal-close:hover{background:rgba(156,232,0,.2)}
      .wts-info-modal h2{margin:0 0 16px;font-size:18px;color:#fff;text-align:center}
      .wts-modal-steps{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
      .wts-step{display:flex;gap:10px}
      .wts-step-number{width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(156,232,0,.2);color:#9ce800;font-weight:700;font-size:12px}
      .wts-step-content strong{display:block;font-size:10px;color:#9ce800;margin-bottom:2px}
      .wts-step-content p{margin:0;font-size:9px;color:#8e989d;line-height:1.3}
      .wts-modal-divider{height:1px;background:rgba(255,255,255,.08);margin:12px 0}
      .wts-modal-attention{padding:10px;background:rgba(255,92,92,.08);border-radius:8px;border-left:3px solid #ff5c5c}
      .wts-attention-title{font-size:11px;font-weight:700;color:#ff5c5c;margin-bottom:6px}
      .wts-modal-attention p{margin:4px 0;font-size:9px;color:#8e989d;line-height:1.3}
      @media(max-width:380px){.wts-game-options{grid-template-columns:1fr}.wts-game-option{padding:7px}}
    `;
    document.head.appendChild(style);
    
    // Add info button to heading
    const heading = document.querySelector('.wts-login-heading');
    if (heading) {
      const infoBtn = document.createElement('button');
      infoBtn.className = 'wts-info-btn';
      infoBtn.type = 'button';
      infoBtn.title = 'How it works';
      infoBtn.innerHTML = '<i class="fa-solid fa-circle-info"></i>';
      infoBtn.addEventListener('click', (e) => { e.preventDefault(); showInfoModal(); });
      heading.appendChild(infoBtn);
    }
  }

  window.__wts = {
    getState: () => ({ loginRunning, connected, selectedGame }),
    status: async () => (await fetch(API.status, { cache: 'no-store' })).json(),
    reset: async () => (await fetch(API.reset, { method: 'POST' })).json()
  };

  updateLoginButton();
})();
