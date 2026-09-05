'use strict';

const path = require('path');
try { require('dotenv').config(); } catch {}
const express = require('express');
const { chromium } = require('playwright');

const app = express();

const PORT = Number(process.env.PORT || 3930);
const HOST = process.env.HOST || '127.0.0.1';
const HEADLESS = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
const LOGIN_URL = process.env.BETPAWA_LOGIN_URL || 'https://www.betpawa.co.tz/login';
const HOME_URL = process.env.GAME_BASE_URL || 'https://www.betpawa.co.tz';
const VIEWPORT = {
  width: Number(process.env.WIDTH || 430),
  height: Number(process.env.HEIGHT || 850)
};
const AUTH_TIMEOUT = Number(process.env.AUTH_TIMEOUT || 40000);
const OPEN_GAME_TIMEOUT = Number(process.env.OPEN_GAME_TIMEOUT || 15000);
const WATCHDOG_MS = Number(process.env.DOM_WATCHDOG_MS || 250);
const STABLE_AUTH_CHECKS = Number(process.env.STABLE_AUTH_CHECKS || 2);

const GAMES = {
  aviator: {
    id: '34971',
    name: 'Aviator',
    url: process.env.AVIATOR_GAME_URL || 'https://www.betpawa.co.tz/casino/game/34971'
  },
  fortunerMine: {
    id: '35102',
    name: 'Fortuner Mine',
    url: process.env.FORTUNER_MINE_GAME_URL || 'https://www.betpawa.co.tz/casino/game/35102?redirectBack=%2Fcasino'
  }
};

const SELECTORS = {
  phone: [process.env.AUTH_PHONE_SELECTOR, '[data-test-id="login-form-phone-number-input"]', '#phoneNumber', 'input[name="username"]', 'input[type="tel"]', 'input[inputmode="numeric"]'].filter(Boolean),
  password: [process.env.AUTH_PASSWORD_SELECTOR, '[data-test-id="login-form-password-input"]', 'input[name="password"]', 'input[type="password"]'].filter(Boolean),
  loginButton: [process.env.AUTH_LOGIN_BUTTON_SELECTOR, '[data-test-id="log-in-button"]', 'button[type="submit"]'].filter(Boolean),
  profile: [process.env.AUTH_SUCCESS_SELECTOR, '[data-test-id="account-menu-icon-account"]'].filter(Boolean),
  balance: [process.env.AUTH_BALANCE_SELECTOR, '._balance_6umpy_40', '.balance-amount'].filter(Boolean),
  loginError: [process.env.AUTH_ERROR_SELECTOR, '[data-test-id="login-error"]', '[role="alert"]', '[aria-live="assertive"]', '[aria-live="polite"]', '[data-test-id*="error"]', '[class*="error"]', '[class*="Error"]'].filter(Boolean)
};

const DOM_GROUPS = {
  AUTH_PHONE: SELECTORS.phone,
  AUTH_PASSWORD: SELECTORS.password,
  AUTH_LOGIN_BUTTON: SELECTORS.loginButton,
  AUTH_PROFILE: SELECTORS.profile,
  AUTH_BALANCE: SELECTORS.balance,
  AUTH_ERROR: SELECTORS.loginError
};

const GAME_DOM_GROUPS = {
  COMMON: [
    'body',
    '#root',
    '#app',
    'main',
    '[role="main"]'
  ],
  IFRAME: ['iframe'],
  CANVAS: ['canvas'],
  SVG: ['svg'],
  GAME_ROOT: ['[class*="game"]', '[id*="game"]', '[class*="Game"]', '[id*="Game"]'],
  AVIATOR_PAYOUT: ['.payout', '[class*="payout"]', '[class*="Payout"]', '[class*="multiplier"]', '[class*="Multiplier"]'],
  FORTUNER_MINE: ['[class*="mine"]', '[id*="mine"]', '[class*="Mine"]', '[id*="Mine"]', '[class*="grid"]', '[class*="Grid"]', '[class*="cell"]', '[class*="Cell"]', '[data-test-id*="mine"]', '[data-testid*="mine"]']
};

let browser = null;
let context = null;
let page = null;
let connectorState = 'IDLE';
let authenticated = false;
let selectedGame = null;
let loginRunning = false;
let currentLoginRequestId = null;
const loginRequests = new Map();
let authGeneration = 0;
let lastAuthProof = null;
let lastGameUrl = null;
let startupReady = false;

// Authentication DOM monitor is state-aware. It is never used to report login
// controls after authentication has transitioned to a non-login state.
let monitorMode = 'BOOT'; // BOOT | LOGIN | AUTH | GAME
let domSnapshot = {};
let domEvents = [];
let domInitialized = false;
let domBaselineGeneration = 0;
let domWatchdogTimer = null;
let pageMutationVersion = 0;
let lastMutationVersion = 0;
let domPageUrl = null;

// Game monitor has its own baseline and event stream so game DOM health is
// visible without confusing it with authentication DOM health.
let gameDomSnapshot = {};
let gameDomInitialized = false;
let gameDomEvents = [];
let eventSequence = 0;
const eventClients = new Set();

// WebSocket sniffer buffer — only active while a game is connected. See
// addPageListeners() / recordWsFrame() for what this observes and why.
let wsFrames = [];
let wsSniffActive = false;
let gameDomState = {
  available: false,
  game: null,
  url: null,
  title: null,
  frames: [],
  groups: {},
  checkedAt: null,
  mutationVersion: 0
};
let gameState = {
  available: false,
  primaryValue: null,
  primaryLabel: null,
  roundText: null,
  gridCount: null,
  checkedAt: null,
  balance: null,
  betControls: []
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safePhone(v) { return String(v || '').replace(/\D/g, '').slice(0, 9); }
function requestId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
function now() { return new Date().toISOString(); }
function currentUrl() { try { return page && !page.isClosed() ? page.url() : null; } catch { return null; } }
function isLoginUrl(url) { try { return new URL(url).pathname.toLowerCase().includes('/login'); } catch { return false; } }
function getGame(key) { return GAMES[key] || null; }
function currentGame() { return selectedGame ? GAMES[selectedGame] || null : null; }

function publishEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of eventClients) { try { res.write(payload); } catch { eventClients.delete(res); } }
}

function pushDomEvent(type, group, message, selector = null) {
  const event = { seq: ++eventSequence, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: now(), type, group, message, selector, mode: monitorMode, source: 'auth-dom' };
  domEvents.unshift(event);
  if (domEvents.length > 40) domEvents.length = 40;
  publishEvent(event);
  console.log(`[DOM] ${type} ${group}${selector ? ` :: ${selector}` : ''} — ${message}`);
}

function pushGameDomEvent(type, group, message, selector = null) {
  const event = { seq: ++eventSequence, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: now(), type, group, message, selector, game: selectedGame, source: 'game-dom' };
  gameDomEvents.unshift(event);
  if (gameDomEvents.length > 40) gameDomEvents.length = 40;
  publishEvent(event);
  console.log(`[GAME DOM] ${type} ${group}${selector ? ` :: ${selector}` : ''} — ${message}`);
}

function pushStateEvent(type, message, data = {}) {
  const event = { seq: ++eventSequence, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: now(), type, message, source: 'game-state', game: selectedGame, data };
  gameDomEvents.unshift(event);
  if (gameDomEvents.length > 40) gameDomEvents.length = 40;
  publishEvent(event);
}

function updateRequest(id, patch) {
  const r = loginRequests.get(id);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: Date.now() });
  return r;
}

function addPageListeners() {
  if (!page) return;
  page.on('pageerror', e => console.log('[PAGE ERROR]', e.message));
  page.on('dialog', async d => { try { await d.dismiss(); } catch {} });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      console.log('[NAV]', frame.url());
      // Navigation between login/auth/game modes is a mode boundary. The next
      // snapshot starts a fresh baseline rather than comparing unrelated DOM.
      scheduleMonitorRebaseline();
    }
  });

  /*
   * WebSocket sniffer.
   *
   * Aviator-style Spribe games render the live multiplier on a <canvas>,
   * which has no readable DOM text — the number and the crash moment are
   * pixels, not text. The real live values travel over the same WebSocket
   * connection the game itself already opened in this authenticated
   * session. This only observes traffic the browser already receives;
   * it does not intercept, modify, or send anything.
   *
   * Capture is inert unless wsSniffActive is true (entered automatically
   * once a game is connected), and the buffer is capped so it can't grow
   * unbounded.
   */
  page.on('websocket', ws => {
    const wsUrl = ws.url();
    ws.on('framereceived', event => recordWsFrame('received', wsUrl, event.payload));
    ws.on('framesent', event => recordWsFrame('sent', wsUrl, event.payload));
  });
}

function recordWsFrame(direction, url, payload) {
  if (!wsSniffActive) return;
  let text;
  try {
    text = typeof payload === 'string' ? payload : payload?.toString('utf8') ?? String(payload);
  } catch {
    text = '[unreadable payload]';
  }
  if (text.length > 2000) text = text.slice(0, 2000) + '…(truncated)';
  wsFrames.unshift({ time: now(), direction, url, payload: text });
  if (wsFrames.length > 300) wsFrames.length = 300;
}

async function ensureBrowser() {
  if (browser && browser.isConnected() && context && page && !page.isClosed()) return;
  console.log('[BROWSER] Starting Chromium...');
  browser = await chromium.launch({ headless: HEADLESS });
  context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-TZ' });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.setDefaultNavigationTimeout(OPEN_GAME_TIMEOUT);
  addPageListeners();
  console.log('[BROWSER] Chromium ready');
}

async function ensurePage() {
  await ensureBrowser();
  if (!page || page.isClosed()) {
    page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(OPEN_GAME_TIMEOUT);
    addPageListeners();
  }
  return page;
}

async function safeGoto(url, options = {}) {
  if (!page || page.isClosed()) await ensurePage();
  try {
    await page.goto(url, {
      waitUntil: options.waitUntil || 'commit',
      timeout: options.timeout || Math.max(OPEN_GAME_TIMEOUT, 10000)
    });
    return { success: true, timeout: false };
  } catch (e) {
    console.log(`[NAV] Navigation did not fully settle: ${url}`);
    return { success: false, timeout: true, message: e.message };
  }
}

async function probe(selectors) {
  if (!page || page.isClosed()) return { found: false, visible: false, selector: null, count: 0 };
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      const count = await loc.count();
      if (count) {
        const visible = await loc.isVisible().catch(() => false);
        return { found: true, visible, selector, count };
      }
    } catch {}
  }
  return { found: false, visible: false, selector: null, count: 0 };
}

async function textFor(selectors) {
  if (!page || page.isClosed()) return '';
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector);
      const n = Math.min(await loc.count(), 8);
      for (let i = 0; i < n; i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          const t = (await item.innerText().catch(() => '')).trim();
          if (t) return t;
        }
      }
    } catch {}
  }
  return '';
}

function modeForPage() {
  const url = currentUrl();
  if (selectedGame && authenticated && url && !isLoginUrl(url)) return 'GAME';
  if (authenticated && url && !isLoginUrl(url)) return 'AUTH';
  if (url && isLoginUrl(url) && !authenticated) return 'LOGIN';
  return monitorMode === 'BOOT' ? 'BOOT' : monitorMode;
}

function expectedDomGroups(mode = modeForPage()) {
  if (mode === 'LOGIN') return new Set(['AUTH_PHONE', 'AUTH_PASSWORD', 'AUTH_LOGIN_BUTTON']);
  if (mode === 'AUTH') return new Set(['AUTH_PROFILE', 'AUTH_BALANCE']);
  if (mode === 'GAME') return new Set(['AUTH_PROFILE', 'AUTH_BALANCE']);
  return new Set();
}

function resetDomBaseline(reason = 'state transition') {
  domInitialized = false;
  domSnapshot = {};
  domPageUrl = currentUrl();
  domBaselineGeneration++;
  if (reason) console.log(`[DOM] Silent re-baseline: ${reason}`);
}

function setMonitorMode(next, reason = '') {
  if (monitorMode === next) return;
  monitorMode = next;
  resetDomBaseline(reason || `mode=${next}`);
  gameDomInitialized = false;
  gameDomSnapshot = {};
  wsSniffActive = (next === 'GAME');
  if (wsSniffActive) wsFrames = [];
}

let rebaselineTimer = null;
function scheduleMonitorRebaseline() {
  clearTimeout(rebaselineTimer);
  rebaselineTimer = setTimeout(() => {
    resetDomBaseline('navigation boundary');
    gameDomInitialized = false;
    gameDomSnapshot = {};
  }, 50);
}

async function snapshotDomHealth() {
  if (!page || page.isClosed()) return { available: false, groups: {}, url: null, mode: monitorMode, mutationVersion: pageMutationVersion, checkedAt: now() };

  const groups = {};
  for (const [name, selectors] of Object.entries(DOM_GROUPS)) groups[name] = await probe(selectors);

  const mode = modeForPage();
  const url = currentUrl();
  const expected = expectedDomGroups(mode);
  const next = { available: true, groups, url, mode, expected: [...expected], mutationVersion: pageMutationVersion, checkedAt: now(), baselineGeneration: domBaselineGeneration };

  // A mode change is a boundary, not a missing/recovered event. This is what
  // prevents AUTH_PHONE/PASSWORD noise immediately after Connected.
  if (domInitialized && domPageUrl === url) {
    for (const name of expected) {
      const prev = domSnapshot[name];
      const prevOk = !!(prev && prev.visible);
      const nextOk = !!groups[name]?.visible;
      if (prev && prevOk !== nextOk) {
        if (nextOk) pushDomEvent('RECOVERED', name, 'Relevant DOM element is available again.', groups[name].selector);
        else pushDomEvent('MISSING', name, 'Relevant DOM element is no longer visible.', prev.selector || null);
      }
    }
  }

  domSnapshot = groups;
  domPageUrl = url;
  domInitialized = true;
  return next;
}

function startDomWatchdog() {
  if (domWatchdogTimer) return;
  domWatchdogTimer = setInterval(() => {
    void (async () => {
      await syncMutationVersion();
      const mode = modeForPage();
      if (mode !== monitorMode) setMonitorMode(mode, `automatic transition to ${mode}`);
      await snapshotDomHealth();
      if (monitorMode === 'GAME') await snapshotGameDomHealth();
    })().catch(() => {});
  }, WATCHDOG_MS);
}

async function installMutationObserver() {
  if (!page || page.isClosed()) return;
  try {
    await page.evaluate(() => {
      if (window.__WTS_DOM_WATCHDOG__) return;
      window.__WTS_DOM_WATCHDOG__ = { version: 0 };
      const observer = new MutationObserver(() => { window.__WTS_DOM_WATCHDOG__.version++; });
      observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  } catch {}
}

async function syncMutationVersion() {
  if (!page || page.isClosed()) return;
  try {
    const v = await page.evaluate(() => window.__WTS_DOM_WATCHDOG__?.version || 0);
    if (v !== lastMutationVersion) { pageMutationVersion = v; lastMutationVersion = v; }
  } catch {}
}

async function getFrameSummary() {
  if (!page || page.isClosed()) return [];
  return page.frames().map((frame, index) => ({ index, url: frame.url(), name: frame.name() || null, main: frame === page.mainFrame() }));
}

async function probeInFrame(frame, selectors) {
  for (const selector of selectors) {
    try {
      const loc = frame.locator(selector).first();
      const count = await loc.count();
      if (count) return { found: true, visible: await loc.isVisible().catch(() => false), selector, count };
    } catch {}
  }
  return { found: false, visible: false, selector: null, count: 0 };
}

async function probeGameGroup(selectors) {
  const frames = page?.frames?.() || [];
  for (const frame of frames) {
    const result = await probeInFrame(frame, selectors);
    if (result.found) return { ...result, frameUrl: frame.url(), frameName: frame.name() || null };
  }
  return { found: false, visible: false, selector: null, count: 0, frameUrl: null, frameName: null };
}

async function snapshotGameState() {
  if (!page || page.isClosed() || !selectedGame) {
    gameState = { available: false, primaryValue: null, primaryLabel: null, roundText: null, gridCount: null, checkedAt: now(), balance: null, betControls: [] };
    return gameState;
  }
  const game = currentGame();
  try {
    const result = await page.evaluate((key) => {
      const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
      const docs = [document];
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
      }
      let balance = null;
      const balanceSelectors = ['._balance_6umpy_40', '.balance-amount'];
      for (const doc of docs) {
        for (const sel of balanceSelectors) {
          try {
            const el = doc.querySelector(sel);
            const t = text(el);
            if (t) { balance = t; break; }
          } catch {}
        }
        if (balance) break;
      }
      const betControls = [];
      if (key === 'aviator') {
        Array.from(document.querySelectorAll('.bet-control')).slice(0, 2).forEach((control, index) => {
          const amountInput = control.querySelector('input[inputmode="decimal"]');
          const tab = control.querySelector('.navigation-switcher .tab.active');

          // A bet-control cycles through three distinct buttons depending on
          // round phase. All three share class "bet" on BetPawa's Aviator, so
          // they must be told apart by their OTHER class, not by ".bet" alone:
          //   BET     -> button.bet.btn-success  ("Bet", place a wager)
          //   CANCEL  -> button.bet.btn-danger   ("Cancel", wager already placed, waiting for round)
          //   CASHOUT -> button.cashout          ("Cash Out", round in flight)
          const betBtn = control.querySelector('.buttons-block button.bet.btn-success');
          const cancelBtn = control.querySelector('.buttons-block button.bet.btn-danger');
          const cashoutBtn = control.querySelector('.buttons-block button.cashout');

          let state = 'BET';
          let activeBtn = betBtn;
          let amount = (amountInput?.value || text(control.querySelector('.buttons-block .amount')) || '1.00');
          let buttonText = 'Bet';

          if (cashoutBtn) {
            state = 'CASHOUT';
            activeBtn = cashoutBtn;
            amount = text(cashoutBtn.querySelector('.amount')) || amount;
            buttonText = 'Cash Out';
          } else if (cancelBtn) {
            state = 'CANCEL';
            activeBtn = cancelBtn;
            buttonText = 'Cancel';
          } else if (betBtn) {
            state = 'BET';
            activeBtn = betBtn;
            amount = text(betBtn.querySelector('.amount')) || amount;
            buttonText = 'Bet';
          } else {
            activeBtn = null;
          }

          betControls.push({
            index: index + 1,
            label: index === 0 ? '2' : '3',
            state,
            amount: String(amount).replace(/\s+/g, ' ').trim(),
            buttonText,
            ready: !!activeBtn && !activeBtn.disabled,
            disabled: !activeBtn || !!activeBtn.disabled,
            tab: text(tab) || 'Bet'
          });
        });
      }
      const candidates = [];
      const selectors = key === 'aviator'
        ? ['.payout','[class*="payout"]','[class*="Payout"]','[class*="multiplier"]','[class*="Multiplier"]']
        : ['[class*="mine"]','[id*="mine"]','[class*="Mine"]','[id*="Mine"]','[class*="grid"]','[class*="Grid"]','[class*="cell"]','[class*="Cell"]'];
      for (const doc of docs) {
        for (const sel of selectors) {
          let nodes = [];
          try { nodes = Array.from(doc.querySelectorAll(sel)).slice(0, 30); } catch {}
          for (const node of nodes) { const t = text(node); if (t) candidates.push(t); }
        }
      }
      const bodyText = text(document.body);
      if (key === 'aviator') {
        const match = candidates.join(' ').match(/(?:^|\s)(\d+(?:\.\d+)?x)(?=\s|$)/i) || bodyText.match(/(?:^|\s)(\d+(?:\.\d+)?x)(?=\s|$)/i);
        return { available: true, primaryValue: match ? match[1] : null, primaryLabel: match ? 'MULTIPLIER' : 'MULTIPLIER WAITING', roundText: candidates.slice(0,3).join(' • ') || 'Waiting for multiplier data…', gridCount: null, balance, betControls };
      }
      let gridCount = 0;
      for (const doc of docs) { try { gridCount += doc.querySelectorAll('[class*="cell"],[class*="Cell"],[data-test-id*="cell"],[data-testid*="cell"]').length; } catch {} }
      return { available: true, primaryValue: gridCount ? String(gridCount) : null, primaryLabel: gridCount ? 'GRID CELLS DETECTED' : 'GAME STATE', roundText: candidates.slice(0,4).join(' • ') || 'Waiting for mine/grid data…', gridCount, balance, betControls };
    }, selectedGame);
    const changed = gameState.primaryValue !== result.primaryValue || gameState.roundText !== result.roundText || gameState.balance !== result.balance;
    gameState = { ...result, gameName: game?.name || null, checkedAt: now() };
    if (changed) pushStateEvent('GAME_STATE_CHANGED', 'Live game state changed.', { primaryValue: gameState.primaryValue, primaryLabel: gameState.primaryLabel, roundText: gameState.roundText, gridCount: gameState.gridCount, balance: gameState.balance, betControls: gameState.betControls });
  } catch {
    gameState = { available: false, primaryValue: null, primaryLabel: null, roundText: null, gridCount: null, checkedAt: now(), balance: null, betControls: [] };
  }
  return gameState;
}

async function snapshotGameDomHealth() {
  if (!page || page.isClosed() || !selectedGame) {
    gameDomState = { available: false, game: selectedGame, url: currentUrl(), title: null, frames: [], groups: {}, checkedAt: now(), mutationVersion: pageMutationVersion };
    gameState = { available: false, primaryValue: null, primaryLabel: null, roundText: null, gridCount: null, checkedAt: now() };
    return gameDomState;
  }

  const game = currentGame();
  const groups = {};
  for (const [name, selectors] of Object.entries(GAME_DOM_GROUPS)) groups[name] = await probeGameGroup(selectors);
  const frames = await getFrameSummary();
  const title = await page.title().catch(() => '');
  const url = currentUrl();
  const next = { available: true, game: selectedGame, gameName: game?.name || null, url, title, frames, groups, checkedAt: now(), mutationVersion: pageMutationVersion };

  if (gameDomInitialized && gameDomState.url === url && gameDomState.game === selectedGame) {
    for (const name of Object.keys(GAME_DOM_GROUPS)) {
      const prev = gameDomSnapshot[name];
      const prevOk = !!(prev && prev.visible);
      const nextOk = !!groups[name]?.visible;
      if (prev && prevOk !== nextOk) {
        if (nextOk) pushGameDomEvent('RECOVERED', name, 'Game DOM is available again.', groups[name].selector);
        else pushGameDomEvent('MISSING', name, 'Game DOM is no longer visible.', prev.selector || null);
      }
    }
  }

  gameDomSnapshot = groups;
  gameDomState = next;
  gameDomInitialized = true;
  await snapshotGameState();
  return next;
}

async function authSnapshot() {
  await syncMutationVersion();
  const dom = await snapshotDomHealth();
  const loginFormVisible = !!(dom.groups.AUTH_PHONE?.visible && dom.groups.AUTH_PASSWORD?.visible && dom.groups.AUTH_LOGIN_BUTTON?.visible);
  const profileVisible = !!dom.groups.AUTH_PROFILE?.visible;
  const balanceVisible = !!dom.groups.AUTH_BALANCE?.visible;
  const indicatorVisible = profileVisible || balanceVisible;
  const url = dom.url;
  const authenticatedNow = indicatorVisible && !loginFormVisible && !isLoginUrl(url);
  const proof = authenticatedNow ? (profileVisible && balanceVisible ? 'PROFILE_AND_BALANCE' : profileVisible ? 'PROFILE' : 'BALANCE') : null;
  return { authenticated: authenticatedNow, loginFormVisible, profile: profileVisible, balance: balanceVisible, indicatorVisible, url, dom, proof };
}

async function verifyAuthenticatedSession(stableChecks = STABLE_AUTH_CHECKS) {
  let positive = 0;
  let last = null;
  for (let i = 0; i < stableChecks; i++) {
    last = await authSnapshot();
    if (last.authenticated) positive++; else positive = 0;
    if (positive >= stableChecks) {
      authenticated = true;
      lastAuthProof = last.proof;
      setMonitorMode(selectedGame ? 'GAME' : 'AUTH', 'authenticated session verified');
      connectorState = selectedGame ? 'GAME_CONNECTED' : 'AUTHENTICATED';
      return last;
    }
    await sleep(120);
  }
  return last || { authenticated: false };
}

function credentialErrorTextMatches(text) {
  const v = String(text || '').toLowerCase();
  if (!v) return false;
  return [
    'at least one detail entered was incorrect', 'mobile number is incorrect', 'password is incorrect',
    'incorrect password', 'incorrect mobile number', 'invalid password', 'invalid mobile number',
    'invalid credentials', 'login rejected', 'credentials are incorrect', 'details entered were incorrect',
    'make sure your password is correct', 'make sure your mobile number is correct'
  ].some(x => v.includes(x));
}

async function detectCredentialError() {
  const t = await textFor(SELECTORS.loginError);
  return credentialErrorTextMatches(t) ? t : '';
}

async function waitForLoginForm(timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const s = await authSnapshot();
    if (s.authenticated) return { authenticated: true, ...s };
    if (s.dom.groups.AUTH_PHONE?.visible && s.dom.groups.AUTH_PASSWORD?.visible && s.dom.groups.AUTH_LOGIN_BUTTON?.visible) {
      return { authenticated: false, formReady: true, phoneSelector: s.dom.groups.AUTH_PHONE.selector, passwordSelector: s.dom.groups.AUTH_PASSWORD.selector, buttonSelector: s.dom.groups.AUTH_LOGIN_BUTTON.selector, ...s };
    }
    await sleep(100);
  }
  const s = await authSnapshot();
  return { authenticated: s.authenticated, formReady: !!(s.dom.groups.AUTH_PHONE?.visible && s.dom.groups.AUTH_PASSWORD?.visible && s.dom.groups.AUTH_LOGIN_BUTTON?.visible), phoneSelector: s.dom.groups.AUTH_PHONE?.selector, passwordSelector: s.dom.groups.AUTH_PASSWORD?.selector, buttonSelector: s.dom.groups.AUTH_LOGIN_BUTTON?.selector, ...s };
}

async function openLoginPage() {
  await ensurePage();
  const existing = await verifyAuthenticatedSession(2).catch(() => ({ authenticated: false }));
  if (existing.authenticated) { startupReady = true; return { alreadyAuthenticated: true, ...existing }; }

  if (!isLoginUrl(currentUrl() || '')) {
    console.log('[NAV] Opening BetPawa login page...');
    await safeGoto(LOGIN_URL, { waitUntil: 'commit', timeout: Math.max(OPEN_GAME_TIMEOUT, 10000) });
  }

  authenticated = false;
  selectedGame = null;
  connectorState = 'IDLE';
  lastAuthProof = null;
  setMonitorMode('LOGIN', 'login page ready');
  await sleep(500);
  await installMutationObserver();
  resetDomBaseline('login page baseline');
  await syncMutationVersion();
  await snapshotDomHealth();
  if (!domWatchdogTimer) startDomWatchdog();
  startupReady = true;
  return waitForLoginForm(10000);
}

async function waitForAuthenticationAfterSubmit(rid, baseline, timeout = AUTH_TIMEOUT) {
  const start = Date.now();
  let positive = 0;
  while (Date.now() - start < timeout) {
    const auth = await authSnapshot();
    const loginError = await detectCredentialError();

    // Success is authoritative: only post-submit auth proof can transition to
    // AUTHENTICATED. Error text cannot override a verified success.
    const transitionSeen = !auth.loginFormVisible && auth.indicatorVisible && !isLoginUrl(auth.url);
    if (transitionSeen) positive++; else positive = 0;

    if (positive >= STABLE_AUTH_CHECKS) {
      authenticated = true;
      authGeneration++;
      lastAuthProof = auth.proof;
      setMonitorMode('AUTH', 'post-login authentication verified');
      connectorState = 'AUTHENTICATED';
      updateRequest(rid, { status: 'AUTHENTICATED', message: 'Connected.', authenticated: true, proof: auth.proof });
      console.log(`[AUTH] VERIFIED via ${auth.proof}; generation=${authGeneration}`);
      return { success: true, authenticated: true, proof: auth.proof };
    }

    // Credential errors are only actionable while the login form is still
    // visible. Stale error nodes on a transitioned page are ignored.
    if (auth.loginFormVisible && loginError) {
      updateRequest(rid, { status: 'LOGIN_FAILED', message: loginError, authenticated: false, reason: 'INVALID_CREDENTIALS' });
      connectorState = 'LOGIN_FAILED';
      setMonitorMode('LOGIN', 'login failed; form remains active');
      return { success: false, authenticated: false, reason: 'INVALID_CREDENTIALS', message: loginError };
    }

    updateRequest(rid, { status: 'AUTHENTICATING', message: 'Authenticating...', authenticated: false });
    await sleep(100);
  }

  updateRequest(rid, { status: 'LOGIN_FAILED', message: 'Login could not be verified within the allowed time.', authenticated: false, reason: 'AUTH_TIMEOUT' });
  connectorState = 'LOGIN_FAILED';
  return { success: false, authenticated: false, reason: 'AUTH_TIMEOUT' };
}

async function performLogin({ phone, password, requestId: rid }) {
  const form = await openLoginPage();
  if (form.authenticated) {
    authenticated = true;
    updateRequest(rid, { status: 'AUTHENTICATED', message: 'Connected.', authenticated: true, proof: form.proof });
    return { success: true, authenticated: true };
  }

  const ready = await waitForLoginForm(10000);
  if (!ready.formReady) {
    updateRequest(rid, { status: 'LOGIN_FAILED', message: 'Login form is not ready.', authenticated: false, reason: 'LOGIN_FORM_NOT_READY' });
    connectorState = 'LOGIN_FAILED';
    return { success: false, authenticated: false, reason: 'LOGIN_FORM_NOT_READY' };
  }

  const baseline = await authSnapshot();
  setMonitorMode('LOGIN', 'before submit');

  try {
    const phoneLoc = page.locator(ready.phoneSelector).first();
    const passwordLoc = page.locator(ready.passwordSelector).first();
    const buttonLoc = page.locator(ready.buttonSelector).first();
    await phoneLoc.fill(phone);
    await passwordLoc.fill(password);
    await sleep(40);
    if (!(await phoneLoc.isVisible().catch(() => false)) || !(await passwordLoc.isVisible().catch(() => false))) throw new Error('Login form changed before submit.');
    await buttonLoc.click();
  } catch (e) {
    const after = await authSnapshot().catch(() => ({ authenticated: false }));
    if (after.authenticated) {
      authenticated = true;
      authGeneration++;
      lastAuthProof = after.proof;
      setMonitorMode('AUTH', 'authentication verified after interaction error');
      connectorState = 'AUTHENTICATED';
      updateRequest(rid, { status: 'AUTHENTICATED', message: 'Connected.', authenticated: true, proof: after.proof });
      return { success: true, authenticated: true };
    }
    updateRequest(rid, { status: 'LOGIN_FAILED', message: 'Login interaction failed. Please try again.', authenticated: false, reason: 'LOGIN_INTERACTION_ERROR' });
    connectorState = 'LOGIN_FAILED';
    return { success: false, authenticated: false, reason: 'LOGIN_INTERACTION_ERROR' };
  }

  return waitForAuthenticationAfterSubmit(rid, baseline, Math.min(AUTH_TIMEOUT, 30000));
}

async function verifyBeforeGame() {
  // Never trust frontend state. This is the server-side root gate.
  let auth = await verifyAuthenticatedSession(2);
  if (auth.authenticated) return auth;

  const url = currentUrl();
  if (url && !isLoginUrl(url)) {
    await safeGoto(HOME_URL, { waitUntil: 'commit', timeout: OPEN_GAME_TIMEOUT });
    await installMutationObserver();
    resetDomBaseline('re-checking authentication on home');
    setMonitorMode('AUTH', 'server-side game gate recheck');
    auth = await verifyAuthenticatedSession(2);
  }
  return auth;
}

async function connectGame(key) {
  const game = getGame(key);
  if (!game) return { success: false, message: 'Choose exactly one valid game.' };

  const auth = await verifyBeforeGame();
  if (!auth.authenticated) {
    authenticated = false;
    selectedGame = null;
    connectorState = 'SESSION_LOST';
    setMonitorMode('LOGIN', 'game gate blocked; authentication not verified');
    return { success: false, code: 'AUTH_REQUIRED', message: 'BetPawa authentication could not be verified. Game navigation was blocked.' };
  }

  console.log(`[GAME] Opening ${game.name} (${game.id})...`);
  connectorState = 'CONNECTING_GAME';
  selectedGame = key;
  lastGameUrl = game.url;
  setMonitorMode('GAME', `opening ${game.name}`);
  gameDomEvents = [];
  gameDomInitialized = false;
  gameDomSnapshot = {};

  const navigation = await safeGoto(game.url, { waitUntil: 'commit', timeout: Math.max(OPEN_GAME_TIMEOUT, 10000) });
  await sleep(450);
  await installMutationObserver();
  resetDomBaseline(`game ${game.name} navigation`);
  await syncMutationVersion();
  await snapshotDomHealth();
  await snapshotGameDomHealth();

  // A navigation timeout alone is not a failure because the game can continue
  // loading. But we do require the browser to actually reach the requested
  // game route before claiming GAME_CONNECTED.
  const landedUrl = currentUrl() || '';
  const routeReached = landedUrl.includes(`/casino/game/${game.id}`);
  if (!routeReached) {
    connectorState = 'GAME_CONNECTION_FAILED';
    console.log(`[GAME] ${game.name} was not reached; current URL: ${landedUrl}`);
    return { success: false, code: 'GAME_NAVIGATION_FAILED', message: `Could not reach ${game.name}.`, navigation, currentUrl: landedUrl };
  }

  // Do not claim game DOM is ready merely because navigation returned. The
  // connector reports GAME_CONNECTED plus a separate DOM readiness snapshot.
  connectorState = 'GAME_CONNECTED';
  console.log(`[GAME] ${game.name} opened`);
  return {
    success: true,
    game: { key, id: game.id, name: game.name },
    url: game.url,
    authGeneration,
    proof: lastAuthProof,
    gameDom: gameDomState,
    gameState
  };
}

function clearSensitiveLoginRequestData(rid) {
  // Requests contain status only. This function exists as a guardrail if the
  // implementation is extended later; credentials are never stored here.
  const r = loginRequests.get(rid);
  if (!r) return;
  delete r.phone;
  delete r.password;
}

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'WTS BetPawa Local Connector PRO', time: now() }));

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const hello = { seq: eventSequence, id: `hello-${Date.now()}`, time: now(), type: 'STREAM_CONNECTED', message: 'Real-time event stream connected.', source: 'event-engine', game: selectedGame };
  res.write(`data: ${JSON.stringify(hello)}\n\n`);
  eventClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch {} }, 15000);
  req.on('close', () => { clearInterval(heartbeat); eventClients.delete(res); });
});

app.get('/api/status', async (req, res) => {
  let auth = { authenticated: false, profile: false, balance: false, loginFormVisible: false, url: currentUrl(), proof: null };
  try { auth = await authSnapshot(); } catch {}
  const dom = await snapshotDomHealth().catch(() => ({ available: false, groups: {}, url: currentUrl(), mode: monitorMode }));
  const gameDom = monitorMode === 'GAME' ? await snapshotGameDomHealth().catch(() => gameDomState) : gameDomState;
  res.json({
    ok: true,
    state: connectorState,
    authenticated: auth.authenticated,
    authenticationVerification: { profile: auth.profile, balance: auth.balance, loginFormVisible: auth.loginFormVisible, proof: auth.proof || lastAuthProof || null, generation: authGeneration },
    selectedGame,
    selectedGameName: currentGame()?.name || null,
    currentUrl: currentUrl(),
    lastGameUrl,
    loginRunning,
    currentLoginRequestId,
    monitorMode,
    domHealth: dom,
    domEvents: domEvents.slice(0, 15),
    gameDomHealth: gameDom,
    gameState,
    gameDomEvents: gameDomEvents.slice(0, 15),
    mutationVersion: pageMutationVersion,
    startupReady
  });
});

app.get('/api/ws-sniff', (req, res) => {
  res.json({ ok: true, active: wsSniffActive, mode: monitorMode, count: wsFrames.length, frames: wsFrames.slice(0, 150) });
});

app.post('/api/ws-sniff/clear', (req, res) => {
  wsFrames = [];
  res.json({ ok: true, count: 0 });
});

app.get('/api/game-dom', async (req, res) => {
  if (!selectedGame) return res.status(400).json({ ok: false, message: 'No game is connected.' });
  const gameDom = await snapshotGameDomHealth();
  res.json({ ok: true, gameDom, events: gameDomEvents.slice(0, 20) });
});

app.post('/api/start-login', async (req, res) => {
  if (loginRunning) return res.status(409).json({ ok: false, message: 'A login attempt is already running.', requestId: currentLoginRequestId });
  const phone = safePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  if (!/^\d{9}$/.test(phone)) return res.status(400).json({ ok: false, message: 'Enter a valid 9-digit mobile number.' });
  if (password.length < 4) return res.status(400).json({ ok: false, message: 'Password must contain at least 4 characters.' });

  await ensurePage();
  const existing = await verifyAuthenticatedSession(2).catch(() => ({ authenticated: false }));
  if (existing.authenticated) {
    authenticated = true;
    connectorState = selectedGame ? 'GAME_CONNECTED' : 'AUTHENTICATED';
    setMonitorMode(selectedGame ? 'GAME' : 'AUTH', 'existing authenticated session');
    return res.json({ ok: true, status: 'AUTHENTICATED', message: 'Connected.', authenticated: true, alreadyAuthenticated: true, proof: existing.proof });
  }

  const rid = requestId();
  // IMPORTANT: only status metadata is retained; credentials never enter the
  // request object and are never returned by any API.
  loginRequests.set(rid, { id: rid, status: 'AUTHENTICATING', message: 'Authenticating...', authenticated: false, createdAt: Date.now(), updatedAt: Date.now() });
  currentLoginRequestId = rid;
  loginRunning = true;
  connectorState = 'AUTHENTICATING';
  authenticated = false;
  setMonitorMode('LOGIN', 'login attempt started');

  void performLogin({ phone, password, requestId: rid })
    .catch(e => {
      console.log('[LOGIN] Unexpected error:', e.message);
      updateRequest(rid, { status: 'LOGIN_FAILED', message: 'Login could not be verified.', authenticated: false, reason: 'UNEXPECTED_ERROR' });
      connectorState = 'LOGIN_FAILED';
      authenticated = false;
    })
    .finally(() => { loginRunning = false; clearSensitiveLoginRequestData(rid); });

  return res.json({ ok: true, requestId: rid, status: 'AUTHENTICATING', message: 'Authenticating...' });
});

app.get('/api/wait-login', async (req, res) => {
  const rid = String(req.query.requestId || '');
  const r = loginRequests.get(rid);
  if (!rid || !r) return res.status(404).json({ ok: false, message: 'Login request not found.' });
  const latest = loginRequests.get(rid);
  const auth = await authSnapshot().catch(() => ({ authenticated: false, profile: false, balance: false, proof: null }));
  res.json({
    ok: true,
    requestId: rid,
    status: latest.status,
    message: latest.message,
    authenticated: latest.status === 'AUTHENTICATED' && auth.authenticated,
    profile: !!auth.profile,
    balance: !!auth.balance,
    proof: latest.status === 'AUTHENTICATED' ? (latest.proof || auth.proof || lastAuthProof) : null,
    authGeneration,
    domHealth: await snapshotDomHealth().catch(() => null)
  });
});

app.post('/api/connect-game', async (req, res) => {
  const key = String(req.body?.game || '');
  if (!getGame(key)) return res.status(400).json({ ok: false, message: 'Choose exactly one valid game.' });
  try {
    const result = await connectGame(key);
    if (!result.success) return res.status(401).json({ ok: false, ...result });
    return res.json({ ok: true, ...result });
  } catch (e) {
    connectorState = 'ERROR';
    console.log('[GAME] Open error:', e.message);
    return res.status(500).json({ ok: false, message: 'Could not open the selected game.' });
  }
});

app.post('/api/manual-bet', async (req, res) => {
  const slot = Number(req.body?.slot);
  if (![1, 2].includes(slot)) return res.status(400).json({ ok: false, message: 'Choose bet control 1 or 2.' });
  if (!selectedGame || selectedGame !== 'aviator') return res.status(400).json({ ok: false, message: 'Manual bet controls are available for Aviator only.' });
  try {
    const auth = await verifyAuthenticatedSession(2);
    if (!auth.authenticated) {
      authenticated = false;
      connectorState = 'SESSION_LOST';
      return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Authentication could not be verified.' });
    }
    const controls = await page.locator('.bet-control').all();
    if (!controls[slot - 1]) return res.status(404).json({ ok: false, message: `Bet control ${slot} was not found.` });
    const control = controls[slot - 1];

    /*
     * A bet-control shows exactly one of three buttons depending on the
     * live round phase, and this is re-checked fresh right before clicking
     * (never from cached state) so the correct action is always taken:
     *   BET     -> button.bet.btn-success  (place a wager)
     *   CANCEL  -> button.bet.btn-danger   (cancel a pending wager)
     *   CASHOUT -> button.cashout          (cash out mid-flight)
     */

    const betBtn = control.locator('.buttons-block button.bet.btn-success').first();
    const cancelBtn = control.locator('.buttons-block button.bet.btn-danger').first();
    const cashoutBtn = control.locator('.buttons-block button.cashout').first();

    let action = null;
    let button = null;

    if (await cashoutBtn.count()) { action = 'CASHOUT'; button = cashoutBtn; }
    else if (await cancelBtn.count()) { action = 'CANCEL'; button = cancelBtn; }
    else if (await betBtn.count()) { action = 'BET'; button = betBtn; }

    if (!button) return res.status(404).json({ ok: false, message: `No active action button was found for control ${slot}.` });
    if (!(await button.isVisible().catch(() => false)) || !(await button.isEnabled().catch(() => false))) {
      return res.status(409).json({ ok: false, message: `The ${action.toLowerCase()} action for control ${slot} is not ready.` });
    }

    const amount = action === 'CASHOUT'
      ? await button.locator('.amount').first().innerText().catch(() => '')
      : await control.locator('input[inputmode="decimal"]').first().inputValue().catch(async () => await control.locator('.buttons-block .amount').first().innerText().catch(() => '1.00'));

    await button.click();
    pushStateEvent('MANUAL_BET_CLICK', `Manual ${action} on control ${slot === 1 ? '2' : '3'} clicked.`, { slot, action, amount });
    await snapshotGameState();
    return res.json({ ok: true, slot, action, label: slot === 1 ? '2' : '3', amount, message: `Manual ${action} clicked by user.` });
  } catch {
    return res.status(500).json({ ok: false, message: 'Manual action click could not be completed.' });
  }
});

app.post('/api/reset', async (req, res) => {
  authenticated = false;
  selectedGame = null;
  lastGameUrl = null;
  connectorState = 'IDLE';
  currentLoginRequestId = null;
  loginRunning = false;
  authGeneration = 0;
  lastAuthProof = null;
  domEvents = [];
  gameDomEvents = [];
  eventSequence = 0;
  wsFrames = [];
  wsSniffActive = false;
  gameDomState = { available: false, game: null, url: null, title: null, frames: [], groups: {}, checkedAt: null, mutationVersion: 0 };
  gameState = { available: false, primaryValue: null, primaryLabel: null, roundText: null, gridCount: null, checkedAt: null };
  try {
    await ensurePage();
    await safeGoto(LOGIN_URL, { waitUntil: 'commit', timeout: OPEN_GAME_TIMEOUT });
    await installMutationObserver();
    setMonitorMode('LOGIN', 'manual reset');
    resetDomBaseline('manual reset baseline');
    await syncMutationVersion();
    await snapshotDomHealth();
    if (!domWatchdogTimer) startDomWatchdog();
  } catch {}
  res.json({ ok: true, state: connectorState });
});

app.get('/ws-sniff.html', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WTS WebSocket Sniffer</title>
  <style>body{background:#0a0d0e;color:#dde4e1;font-family:Consolas,monospace;padding:16px}
  h1{color:#9ce800;font-size:16px}
  .frame{border:1px solid #223022;border-radius:8px;padding:10px;margin-bottom:8px;white-space:pre-wrap;word-break:break-all;font-size:12px}
  .sent{border-left:4px solid #4aa3ff}.received{border-left:4px solid #9ce800}
  .meta{color:#7cc200;font-size:11px;margin-bottom:4px}
  button{background:#9ce800;color:#0e1310;border:0;padding:8px 14px;border-radius:6px;font-weight:bold;cursor:pointer;margin-right:8px}
  #status{color:#8e989d;font-size:12px;margin-bottom:12px}</style></head>
  <body>
    <h1>WTS WebSocket Sniffer — live game traffic</h1>
    <div id="status">Loading…</div>
    <button onclick="clearFrames()">Clear buffer</button>
    <button onclick="load()">Refresh now</button>
    <div id="frames"></div>
    <script>
      async function load() {
        const r = await fetch('/api/ws-sniff', { cache: 'no-store' });
        const d = await r.json();
        document.getElementById('status').textContent =
          'active: ' + d.active + ' | mode: ' + d.mode + ' | captured: ' + d.count + ' (showing latest ' + d.frames.length + ')';
        document.getElementById('frames').innerHTML = d.frames.map(f =>
          '<div class="frame ' + f.direction + '"><div class="meta">' + f.time + ' — ' + f.direction.toUpperCase() + ' — ' + f.url + '</div>' +
          f.payload.replace(/</g,'&lt;') + '</div>'
        ).join('');
      }
      async function clearFrames() { await fetch('/api/ws-sniff/clear', { method: 'POST' }); load(); }
      load();
      setInterval(load, 1500);
    </script>
  </body></html>`);
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  next();
});
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: 'Internal server error.' });
});

async function start() {
  await ensurePage();
  try { await openLoginPage(); } catch { startupReady = false; }
  if (!domWatchdogTimer) {
    try { await installMutationObserver(); await syncMutationVersion(); await snapshotDomHealth(); } catch {}
    startDomWatchdog();
  }
  app.listen(PORT, HOST, () => {
    console.log('==============================================');
    console.log(' WTS BETPAWA LOCAL CONNECTOR — PRO ELITE v1.0');
    console.log('==============================================');
    console.log(` Local: http://${HOST}:${PORT}`);
    console.log(` Headless: ${HEADLESS}`);
    console.log(` Games: Aviator ${GAMES.aviator.id} | Fortuner Mine ${GAMES.fortunerMine.id}`);
    console.log(' Auth: strict baseline → submit → stable post-login proof');
    console.log(' Game gate: independent authenticated verification');
    console.log(' DOM: state-aware auth + game monitoring');
    console.log(` Watchdog: ${WATCHDOG_MS}ms`);
    console.log(` Startup: ${startupReady ? 'login page ready → silent baseline' : 'local server ready → recovery on login'}`);
    console.log('==============================================');
  });
}

async function shutdown(signal) {
  console.log(`\n[SERVER] ${signal} received`);
  if (domWatchdogTimer) clearInterval(domWatchdogTimer);
  clearTimeout(rebaselineTimer);
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
start().catch(() => {
  try {
    app.listen(PORT, HOST, () => console.log(`WTS local connector fallback: http://${HOST}:${PORT}`));
  } catch {}
});
