'use strict';

const path = require('path');

try {
  require('dotenv').config();
} catch {}

const express = require('express');
const { chromium } = require('playwright');

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3930);
const HOST = process.env.HOST || '127.0.0.1';

const HEADLESS =
  String(process.env.HEADLESS || 'false').toLowerCase() === 'true';

const LOGIN_URL =
  process.env.BETPAWA_LOGIN_URL ||
  'https://www.betpawa.co.tz/login';

const HOME_URL =
  process.env.GAME_BASE_URL ||
  'https://www.betpawa.co.tz';

const VIEWPORT = {
  width: Number(process.env.WIDTH || 430),
  height: Number(process.env.HEIGHT || 850)
};

const AUTH_TIMEOUT =
  Number(process.env.AUTH_TIMEOUT || 40000);

const OPEN_GAME_TIMEOUT =
  Number(process.env.OPEN_GAME_TIMEOUT || 15000);

const NAVIGATION_TIMEOUT =
  Math.max(10000, OPEN_GAME_TIMEOUT);

/* =========================================================
   GAMES
========================================================= */

const GAMES = {
  aviator: {
    id: '34971',
    name: 'Aviator',
    url:
      process.env.AVIATOR_GAME_URL ||
      'https://www.betpawa.co.tz/casino/game/34971'
  },

  fortunerMine: {
    id: '35102',
    name: 'Fortuner Mine',
    url:
      process.env.FORTUNER_MINE_GAME_URL ||
      'https://www.betpawa.co.tz/casino/game/35102?redirectBack=%2Fcasino'
  }
};

/* =========================================================
   SELECTORS
========================================================= */

const SELECTORS = {
  phone: [
    process.env.AUTH_PHONE_SELECTOR,
    '[data-test-id="login-form-phone-number-input"]',
    '#phoneNumber',
    'input[name="username"]',
    'input[type="tel"]',
    'input[inputmode="numeric"]'
  ].filter(Boolean),

  password: [
    process.env.AUTH_PASSWORD_SELECTOR,
    '[data-test-id="login-form-password-input"]',
    'input[name="password"]',
    'input[type="password"]'
  ].filter(Boolean),

  loginButton: [
    process.env.AUTH_LOGIN_BUTTON_SELECTOR,
    '[data-test-id="log-in-button"]',
    'button[type="submit"]'
  ].filter(Boolean),

  profile: [
    process.env.AUTH_SUCCESS_SELECTOR,
    '[data-test-id="account-menu-icon-account"]'
  ].filter(Boolean),

  balance: [
    process.env.AUTH_BALANCE_SELECTOR,
    '._balance_6umpy_40',
    '.balance-amount'
  ].filter(Boolean),

  loginError: [
    process.env.AUTH_ERROR_SELECTOR,
    '[data-test-id="login-error"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[data-test-id*="error"]',
    '[class*="error"]',
    '[class*="Error"]'
  ].filter(Boolean)
};

/* =========================================================
   DOM GROUPS
========================================================= */

const DOM_GROUPS = {
  AUTH_PHONE: SELECTORS.phone,
  AUTH_PASSWORD: SELECTORS.password,
  AUTH_LOGIN_BUTTON: SELECTORS.loginButton,
  AUTH_PROFILE: SELECTORS.profile,
  AUTH_BALANCE: SELECTORS.balance,
  AUTH_ERROR: SELECTORS.loginError
};

/* =========================================================
   RUNTIME STATE
========================================================= */

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

let domSnapshot = {};
let domEvents = [];

let domInitialized = false;
let domWatchdogTimer = null;

let pageMutationVersion = 0;
let lastMutationVersion = 0;

let lastGameUrl = null;
let lastAuthProof = null;

let domPageUrl = null;

let startupReady = false;

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safePhone(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .slice(0, 9);
}

function requestId() {
  return (
    `${Date.now().toString(36)}-` +
    `${Math.random().toString(36).slice(2, 10)}`
  );
}

function now() {
  return new Date().toISOString();
}

function currentUrl() {
  try {
    if (!page || page.isClosed()) {
      return null;
    }

    return page.url();
  } catch {
    return null;
  }
}

function isLoginUrl(url) {
  try {
    if (!url) {
      return false;
    }

    return new URL(url)
      .pathname
      .toLowerCase()
      .includes('/login');
  } catch {
    return false;
  }
}

function getGame(key) {
  return GAMES[key] || null;
}

/* =========================================================
   DOM EVENTS
========================================================= */

function pushDomEvent(
  type,
  group,
  message,
  selector = null
) {
  const event = {
    id:
      `${Date.now()}-` +
      `${Math.random().toString(36).slice(2, 7)}`,

    time: now(),
    type,
    group,
    message,
    selector
  };

  domEvents.unshift(event);

  if (domEvents.length > 30) {
    domEvents.length = 30;
  }

  console.log(
    `[DOM] ${type} ${group}` +
    `${selector ? ` :: ${selector}` : ''}` +
    ` — ${message}`
  );
}

/* =========================================================
   LOGIN REQUEST STATE
========================================================= */

function updateRequest(id, patch) {
  const request = loginRequests.get(id);

  if (!request) {
    return null;
  }

  Object.assign(
    request,
    patch,
    {
      updatedAt: Date.now()
    }
  );

  return request;
}

/* =========================================================
   PAGE EVENTS
========================================================= */

function addPageListeners() {
  if (!page) {
    return;
  }

  page.on('pageerror', error => {
    console.log(
      '[PAGE ERROR]',
      error?.message || 'Unknown page error'
    );
  });

  page.on('dialog', async dialog => {
    try {
      await dialog.dismiss();
    } catch {}
  });

  page.on('framenavigated', frame => {
    try {
      if (frame === page.mainFrame()) {
        console.log('[NAV]', frame.url());
      }
    } catch {}
  });
}

/* =========================================================
   BROWSER
========================================================= */

async function ensureBrowser() {
  if (
    browser &&
    browser.isConnected() &&
    context &&
    page &&
    !page.isClosed()
  ) {
    return;
  }

  console.log('[BROWSER] Starting Chromium...');

  browser = await chromium.launch({
    headless: HEADLESS
  });

  context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-TZ'
  });

  page = await context.newPage();

  page.setDefaultTimeout(7000);

  page.setDefaultNavigationTimeout(
    NAVIGATION_TIMEOUT
  );

  addPageListeners();

  console.log('[BROWSER] Chromium ready');
}

async function ensurePage() {
  await ensureBrowser();

  if (!page || page.isClosed()) {
    page = await context.newPage();

    page.setDefaultTimeout(7000);

    page.setDefaultNavigationTimeout(
      NAVIGATION_TIMEOUT
    );

    addPageListeners();
  }

  return page;
}

/* =========================================================
   DOM PROBE
========================================================= */

async function probe(selectors) {
  if (!page || page.isClosed()) {
    return {
      found: false,
      visible: false,
      selector: null
    };
  }

  for (const selector of selectors) {
    try {
      const locator = page
        .locator(selector)
        .first();

      const count = await locator.count();

      if (count > 0) {
        const visible =
          await locator
            .isVisible()
            .catch(() => false);

        if (visible) {
          return {
            found: true,
            visible: true,
            selector
          };
        }

        return {
          found: true,
          visible: false,
          selector
        };
      }
    } catch {}
  }

  return {
    found: false,
    visible: false,
    selector: null
  };
}

/* =========================================================
   TEXT EXTRACTION
========================================================= */

async function textFor(selectors) {
  if (!page || page.isClosed()) {
    return '';
  }

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);

      const count = Math.min(
        await locator.count(),
        8
      );

      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);

        const visible =
          await item
            .isVisible()
            .catch(() => false);

        if (!visible) {
          continue;
        }

        const text =
          (
            await item
              .innerText()
              .catch(() => '')
          ).trim();

        if (text) {
          return text;
        }
      }
    } catch {}
  }

  return '';
}

/* =========================================================
   EXPECTED DOM — STATE-AWARE MONITORING
========================================================= */

function expectedDomGroups() {
  const url = currentUrl();

  const loginPage = isLoginUrl(url);

  /*
   * LOGIN STATE:
   * Only login controls are relevant during login flow.
   * Do NOT monitor these after authentication.
   */

  if (loginPage && !authenticated) {
    return new Set([
      'AUTH_PHONE',
      'AUTH_PASSWORD',
      'AUTH_LOGIN_BUTTON'
    ]);
  }

  /*
   * AUTHENTICATED STATE:
   * Only account indicators matter after successful auth.
   * Login fields are no longer needed.
   */

  if (authenticated && !loginPage) {
    return new Set([
      'AUTH_PROFILE',
      'AUTH_BALANCE'
    ]);
  }

  /*
   * TRANSITIONAL/UNKNOWN STATE:
   * Don't generate false DOM alarms during navigation.
   */

  return new Set();
}

/* =========================================================
   DOM HEALTH SNAPSHOT
========================================================= */

async function snapshotDomHealth() {
  if (!page || page.isClosed()) {
    return {
      available: false,
      groups: {},
      url: null,
      mutationVersion: pageMutationVersion,
      checkedAt: now()
    };
  }

  const groups = {};

  for (const [name, selectors] of Object.entries(
    DOM_GROUPS
  )) {
    groups[name] = await probe(selectors);
  }

  const url = currentUrl();

  const expected = expectedDomGroups();

  const result = {
    available: true,
    groups,
    url,
    mutationVersion: pageMutationVersion,
    checkedAt: now()
  };

  /*
   * First snapshot is silent.
   *
   * This prevents:
   * MISSING AUTH_PHONE
   * MISSING AUTH_PASSWORD
   *
   * during startup/about:blank/loading.
   */

  if (domInitialized) {
    for (const name of expected) {
      const previous = domSnapshot[name];

      const previousOk =
        !!(
          previous &&
          previous.visible
        );

      const currentOk =
        !!(
          groups[name] &&
          groups[name].visible
        );

      if (
        previous &&
        previousOk !== currentOk
      ) {
        if (currentOk) {
          pushDomEvent(
            'RECOVERED',
            name,
            'Relevant DOM element is available again.',
            groups[name].selector
          );
        } else {
          pushDomEvent(
            'MISSING',
            name,
            'Relevant DOM element is no longer visible.',
            previous.selector || null
          );
        }
      }
    }
  }

  domSnapshot = groups;
  domPageUrl = url;
  domInitialized = true;

  return result;
}

/* =========================================================
   MUTATION OBSERVER
========================================================= */

async function installMutationObserver() {
  if (!page || page.isClosed()) {
    return;
  }

  try {
    await page.evaluate(() => {
      if (window.__WTS_DOM_WATCHDOG__) {
        return;
      }

      window.__WTS_DOM_WATCHDOG__ = {
        version: 0
      };

      const observer =
        new MutationObserver(() => {
          try {
            window.__WTS_DOM_WATCHDOG__.version++;
          } catch {}
        });

      observer.observe(
        document.documentElement || document,
        {
          subtree: true,
          childList: true,
          attributes: true
        }
      );
    });
  } catch {}
}

/* =========================================================
   MUTATION VERSION
========================================================= */

async function syncMutationVersion() {
  if (!page || page.isClosed()) {
    return;
  }

  try {
    const version =
      await page.evaluate(
        () =>
          window.__WTS_DOM_WATCHDOG__?.version || 0
      );

    if (version !== lastMutationVersion) {
      pageMutationVersion = version;
      lastMutationVersion = version;
    }
  } catch {}
}

/* =========================================================
   DOM WATCHDOG
========================================================= */

function startDomWatchdog() {
  if (domWatchdogTimer) {
    return;
  }

  domWatchdogTimer = setInterval(() => {
    void syncMutationVersion()
      .then(() => snapshotDomHealth())
      .catch(() => {});
  }, 300);
}

/* =========================================================
   AUTH SNAPSHOT
========================================================= */

async function authSnapshot() {
  await syncMutationVersion();

  const dom =
    await snapshotDomHealth();

  const loginFormVisible =
    !!(
      dom.groups.AUTH_PHONE?.visible &&
      dom.groups.AUTH_PASSWORD?.visible &&
      dom.groups.AUTH_LOGIN_BUTTON?.visible
    );

  const profileVisible =
    !!dom.groups.AUTH_PROFILE?.visible;

  const balanceVisible =
    !!dom.groups.AUTH_BALANCE?.visible;

  const indicatorVisible =
    profileVisible ||
    balanceVisible;

  const url = dom.url;

  /*
   * STRICT AUTH RULE:
   *
   * profile/balance
   * +
   * login form absent
   * +
   * not on /login
   */

  const authenticatedNow =
    indicatorVisible &&
    !loginFormVisible &&
    !isLoginUrl(url);

  let proof = null;

  if (authenticatedNow) {
    if (
      profileVisible &&
      balanceVisible
    ) {
      proof = 'PROFILE_AND_BALANCE';
    } else if (profileVisible) {
      proof = 'PROFILE';
    } else {
      proof = 'BALANCE';
    }
  }

  return {
    authenticated: authenticatedNow,
    loginFormVisible,
    profile: profileVisible,
    balance: balanceVisible,
    indicatorVisible,
    url,
    dom,
    proof
  };
}

/* =========================================================
   STRICT AUTH VERIFICATION
========================================================= */

async function verifyAuthenticatedSession(
  stableChecks = 2
) {
  let positive = 0;
  let last = null;

  for (
    let i = 0;
    i < stableChecks;
    i++
  ) {
    last = await authSnapshot();

    if (last.authenticated) {
      positive++;
    } else {
      positive = 0;
    }

    if (
      positive >= stableChecks
    ) {
      authenticated = true;

      connectorState =
        selectedGame
          ? 'GAME_CONNECTED'
          : 'AUTHENTICATED';

      lastAuthProof = last.proof;

      return last;
    }

    await sleep(150);
  }

  return (
    last || {
      authenticated: false
    }
  );
}

/* =========================================================
   CREDENTIAL ERROR
========================================================= */

function credentialErrorTextMatches(text) {
  const value =
    String(text || '').toLowerCase();

  if (!value) {
    return false;
  }

  const phrases = [
    'at least one detail entered was incorrect',
    'mobile number is incorrect',
    'password is incorrect',
    'incorrect password',
    'incorrect mobile number',
    'invalid password',
    'invalid mobile number',
    'invalid credentials',
    'login rejected',
    'credentials are incorrect',
    'details entered were incorrect',
    'make sure your password is correct',
    'make sure your mobile number is correct'
  ];

  return phrases.some(
    phrase => value.includes(phrase)
  );
}

async function detectCredentialError() {
  const text =
    await textFor(
      SELECTORS.loginError
    );

  return credentialErrorTextMatches(text)
    ? text
    : '';
}

/* =========================================================
   LOGIN FORM
========================================================= */

async function waitForLoginForm(
  timeout = 7000
) {
  const start = Date.now();

  while (
    Date.now() - start <
    timeout
  ) {
    const snapshot =
      await authSnapshot();

    if (snapshot.authenticated) {
      return {
        authenticated: true,
        ...snapshot
      };
    }

    const phone =
      snapshot.dom.groups.AUTH_PHONE;

    const password =
      snapshot.dom.groups.AUTH_PASSWORD;

    const button =
      snapshot.dom.groups.AUTH_LOGIN_BUTTON;

    if (
      phone?.visible &&
      password?.visible &&
      button?.visible
    ) {
      return {
        authenticated: false,
        formReady: true,
        phoneSelector: phone.selector,
        passwordSelector: password.selector,
        buttonSelector: button.selector,
        ...snapshot
      };
    }

    await sleep(100);
  }

  const final =
    await authSnapshot();

  return {
    authenticated:
      final.authenticated,

    formReady:
      !!(
        final.dom.groups.AUTH_PHONE?.visible &&
        final.dom.groups.AUTH_PASSWORD?.visible &&
        final.dom.groups.AUTH_LOGIN_BUTTON?.visible
      ),

    phoneSelector:
      final.dom.groups.AUTH_PHONE?.selector,

    passwordSelector:
      final.dom.groups.AUTH_PASSWORD?.selector,

    buttonSelector:
      final.dom.groups.AUTH_LOGIN_BUTTON?.selector,

    ...final
  };
}

/* =========================================================
   SAFE NAVIGATION
========================================================= */

async function safeGoto(
  url,
  options = {}
) {
  await ensurePage();

  const waitUntil =
    options.waitUntil || 'commit';

  const timeout =
    Number(
      options.timeout ||
      NAVIGATION_TIMEOUT
    );

  try {
    await page.goto(url, {
      waitUntil,
      timeout
    });

    return {
      success: true,
      url: currentUrl()
    };
  } catch (error) {
    /*
     * IMPORTANT:
     *
     * Navigation timeout must NEVER crash
     * the local connector.
     *
     * The page may already be usable.
     */

    console.log(
      `[NAV] Navigation did not fully settle: ${url}`
    );

    return {
      success: false,
      timeout: true,
      url: currentUrl(),
      error: 'NAVIGATION_NOT_SETTLED'
    };
  }
}

/* =========================================================
   OPEN LOGIN PAGE
========================================================= */

async function openLoginPage() {
  await ensurePage();

  /*
   * Check if an already authenticated
   * session exists first.
   */

  const existing =
    await verifyAuthenticatedSession(2)
      .catch(() => ({
        authenticated: false
      }));

  if (existing.authenticated) {
    startupReady = true;

    return {
      alreadyAuthenticated: true,
      ...existing
    };
  }

  let url = currentUrl();

  /*
   * Never report DOM missing while about:blank.
   */

  if (
    !url ||
    url === 'about:blank' ||
    !isLoginUrl(url)
  ) {
    console.log(
      '[NAV] Opening BetPawa login page...'
    );

    await safeGoto(
      LOGIN_URL,
      {
        waitUntil: 'commit',
        timeout: NAVIGATION_TIMEOUT
      }
    );

    /*
     * Give the application a short chance
     * to mount its React/UI DOM.
     */

    await sleep(700);

    url = currentUrl();
  }

  /*
   * Install observer only after a real document
   * navigation attempt.
   */

  await installMutationObserver();

  /*
   * Silent first baseline.
   */

  domInitialized = false;
  domSnapshot = {};

  await syncMutationVersion();

  await snapshotDomHealth();

  if (!domWatchdogTimer) {
    startDomWatchdog();
  }

  startupReady = true;

  /*
   * BetPawa can still be rendering.
   * This must not crash startup.
   */

  const form =
    await waitForLoginForm(10000);

  return {
    alreadyAuthenticated: false,
    ...form
  };
}

/* =========================================================
   POST-SUBMIT AUTH PROOF
========================================================= */

async function waitForAuthenticationAfterSubmit(
  requestIdValue,
  baseline,
  timeoutMs
) {
  const start = Date.now();

  let positive = 0;

  while (
    Date.now() - start <
    timeoutMs
  ) {
    const snapshot =
      await authSnapshot();

    const proof =
      snapshot.authenticated &&
      !snapshot.loginFormVisible &&
      snapshot.indicatorVisible;

    /*
     * SUCCESS MUST BE A REAL TRANSITION.
     *
     * This prevents stale profile/balance DOM
     * from being accepted as a new login.
     */

    if (
      proof &&
      !baseline.indicatorVisible
    ) {
      positive++;

      if (positive >= 2) {
        authenticated = true;

        connectorState =
          'AUTHENTICATED';

        authGeneration++;

        lastAuthProof =
          snapshot.proof;

        updateRequest(
          requestIdValue,
          {
            status: 'AUTHENTICATED',
            message: 'Connected.',
            authenticated: true,
            profile: snapshot.profile,
            balance: snapshot.balance,
            proof: snapshot.proof,
            authGeneration
          }
        );

        console.log(
          `[AUTH] VERIFIED via ${snapshot.proof}; ` +
          `generation=${authGeneration}`
        );

        return {
          success: true,
          ...snapshot
        };
      }
    } else {
      positive = 0;
    }

    /*
     * Only trust credential errors while the
     * actual login form is still visible.
     */

    if (snapshot.loginFormVisible) {
      const errorText =
        await detectCredentialError();

      if (errorText) {
        authenticated = false;

        connectorState =
          'LOGIN_FAILED';

        updateRequest(
          requestIdValue,
          {
            status: 'LOGIN_FAILED',
            message:
              'Mobile number or password is incorrect.',
            authenticated: false,
            reason: 'INVALID_CREDENTIALS'
          }
        );

        console.log(
          '[AUTH] Credential rejection:',
          errorText.slice(0, 180)
        );

        return {
          success: false,
          authenticated: false,
          reason: 'INVALID_CREDENTIALS'
        };
      }
    }

    await sleep(100);
  }

  /*
   * Final strict check.
   */

  const final =
    await authSnapshot();

  if (
    final.authenticated &&
    !baseline.indicatorVisible
  ) {
    authenticated = true;

    connectorState =
      'AUTHENTICATED';

    authGeneration++;

    lastAuthProof =
      final.proof;

    updateRequest(
      requestIdValue,
      {
        status: 'AUTHENTICATED',
        message: 'Connected.',
        authenticated: true,
        proof: final.proof,
        authGeneration
      }
    );

    return {
      success: true,
      ...final
    };
  }

  authenticated = false;

  connectorState =
    'LOGIN_FAILED';

  updateRequest(
    requestIdValue,
    {
      status: 'LOGIN_FAILED',
      message:
        'Login could not be verified. No valid authenticated session was detected.',
      authenticated: false,
      reason: 'AUTH_NOT_VERIFIED'
    }
  );

  return {
    success: false,
    authenticated: false,
    reason: 'AUTH_NOT_VERIFIED'
  };
}

/* =========================================================
   PERFORM LOGIN
========================================================= */

async function performLogin({
  phone,
  password,
  requestId: rid
}) {
  await ensurePage();

  const loginPage =
    await openLoginPage();

  /*
   * If an authenticated session already exists,
   * don't submit the login form again.
   */

  if (
    loginPage.alreadyAuthenticated ||
    loginPage.authenticated
  ) {
    authenticated = true;

    connectorState =
      'AUTHENTICATED';

    updateRequest(
      rid,
      {
        status: 'AUTHENTICATED',
        message: 'Connected.',
        authenticated: true,
        proof:
          loginPage.proof ||
          lastAuthProof
      }
    );

    return {
      success: true,
      authenticated: true,
      alreadyAuthenticated: true
    };
  }

  let form =
    await waitForLoginForm(10000);

  /*
   * Silent recovery if BetPawa is still
   * loading its login DOM.
   */

  if (
    !form.authenticated &&
    !form.formReady
  ) {
    try {
      const url = currentUrl();

      if (
        !url ||
        url === 'about:blank' ||
        !isLoginUrl(url)
      ) {
        await safeGoto(
          LOGIN_URL,
          {
            waitUntil: 'commit',
            timeout: NAVIGATION_TIMEOUT
          }
        );

        await sleep(700);
      }
    } catch {}

    await installMutationObserver();

    form =
      await waitForLoginForm(10000);
  }

  /*
   * No form = no login.
   */

  if (!form.formReady) {
    connectorState =
      'LOGIN_FAILED';

    updateRequest(
      rid,
      {
        status: 'LOGIN_FAILED',
        message:
          'BetPawa login form could not be found. Please check the BetPawa page and try again.',
        authenticated: false,
        reason: 'LOGIN_FORM_NOT_FOUND'
      }
    );

    return {
      success: false,
      authenticated: false,
      reason: 'LOGIN_FORM_NOT_FOUND'
    };
  }

  /*
   * Capture the baseline immediately before
   * submitting credentials.
   */

  const baseline =
    await authSnapshot();

  if (
    baseline.authenticated ||
    baseline.indicatorVisible
  ) {
    console.log(
      '[AUTH] Ambiguous pre-login auth indicator; ' +
      'requiring real post-submit transition.'
    );
  }

  const normalizedPhone =
    safePhone(phone);

  if (
    !/^\d{9}$/.test(
      normalizedPhone
    )
  ) {
    connectorState =
      'LOGIN_FAILED';

    updateRequest(
      rid,
      {
        status: 'LOGIN_FAILED',
        message:
          'Enter a valid 9-digit mobile number.',
        authenticated: false,
        reason: 'INVALID_PHONE'
      }
    );

    return {
      success: false,
      authenticated: false,
      reason: 'INVALID_PHONE'
    };
  }

  try {
    /*
     * Fill phone.
     */

    await page
      .locator(form.phoneSelector)
      .fill(normalizedPhone);

    /*
     * Fill password.
     *
     * Password is never logged or returned.
     */

    await page
      .locator(form.passwordSelector)
      .fill(String(password));

    /*
     * Re-check form before click.
     */

    const preClick =
      await authSnapshot();

    if (!preClick.loginFormVisible) {
      connectorState =
        'LOGIN_FAILED';

      updateRequest(
        rid,
        {
          status: 'LOGIN_FAILED',
          message:
            'Login form changed before submission. Please try again.',
          authenticated: false,
          reason: 'LOGIN_FORM_CHANGED'
        }
      );

      return {
        success: false,
        authenticated: false,
        reason: 'LOGIN_FORM_CHANGED'
      };
    }

    /*
     * Submit.
     */

    await page
      .locator(form.buttonSelector)
      .click();

  } catch {
    /*
     * A click/navigation race can throw even though
     * the login was actually submitted.
     *
     * Verify state before declaring failure.
     */

    const after =
      await authSnapshot();

    if (
      after.authenticated &&
      !baseline.indicatorVisible
    ) {
      authenticated = true;

      connectorState =
        'AUTHENTICATED';

      authGeneration++;

      lastAuthProof =
        after.proof;

      updateRequest(
        rid,
        {
          status: 'AUTHENTICATED',
          message: 'Connected.',
          authenticated: true,
          proof: after.proof,
          authGeneration
        }
      );

      return {
        success: true,
        authenticated: true
      };
    }

    connectorState =
      'LOGIN_FAILED';

    updateRequest(
      rid,
      {
        status: 'LOGIN_FAILED',
        message:
          'Login interaction failed. Please try again.',
        authenticated: false,
        reason: 'LOGIN_INTERACTION_ERROR'
      }
    );

    return {
      success: false,
      authenticated: false,
      reason: 'LOGIN_INTERACTION_ERROR'
    };
  }

  return waitForAuthenticationAfterSubmit(
    rid,
    baseline,
    Math.min(
      AUTH_TIMEOUT,
      30000
    )
  );
}

/* =========================================================
   CONNECT GAME
========================================================= */

async function connectGame(key) {
  const game =
    getGame(key);

  if (!game) {
    return {
      success: false,
      message:
        'Choose exactly one valid game.'
    };
  }

  /*
   * =======================================================
   * ROOT SECURITY GATE
   *
   * NEVER navigate to a game until the live session
   * is independently verified.
   * =======================================================
   */

  let auth =
    await verifyAuthenticatedSession(2);

  /*
   * If we're on another non-login route and the game
   * page doesn't expose account indicators, temporarily
   * go to BetPawa home using the SAME page/context/session.
   */

  if (
    !auth.authenticated &&
    currentUrl() &&
    !isLoginUrl(currentUrl())
  ) {
    await safeGoto(
      HOME_URL,
      {
        waitUntil: 'commit',
        timeout: NAVIGATION_TIMEOUT
      }
    );

    await sleep(500);

    await installMutationObserver();

    auth =
      await verifyAuthenticatedSession(2);

    if (!auth.authenticated) {
      authenticated = false;

      connectorState =
        'SESSION_LOST';

      return {
        success: false,
        code: 'AUTH_REQUIRED',
        message:
          'BetPawa authentication could not be verified. Game navigation was blocked.'
      };
    }

    console.log(
      '[AUTH] Session re-verified on BetPawa home before game navigation.'
    );
  }

  /*
   * Final gate.
   */

  if (!auth.authenticated) {
    authenticated = false;

    connectorState =
      'SESSION_LOST';

    return {
      success: false,
      code: 'AUTH_REQUIRED',
      message:
        'BetPawa authentication could not be verified. Game navigation was blocked.'
    };
  }

  /*
   * =======================================================
   * GAME NAVIGATION
   * =======================================================
   */

  console.log(
    `[GAME] Opening ${game.name} (${game.id})...`
  );

  connectorState =
    'CONNECTING_GAME';

  selectedGame = key;

  lastGameUrl =
    game.url;

  /*
   * commit means we don't wait for BetPawa's
   * entire network/application lifecycle.
   */

  await safeGoto(
    game.url,
    {
      waitUntil: 'commit',
      timeout: NAVIGATION_TIMEOUT
    }
  );

  /*
   * Give the game page a chance to mount.
   */

  await sleep(500);

  await installMutationObserver();

  /*
   * New page = new DOM baseline.
   */

  domInitialized = false;
  domSnapshot = {};

  await syncMutationVersion();

  await snapshotDomHealth();

  connectorState =
    'GAME_CONNECTED';

  console.log(
    `[GAME] ${game.name} opened`
  );

  return {
    success: true,

    game: {
      key,
      id: game.id,
      name: game.name
    },

    url: game.url,

    authGeneration,

    proof: lastAuthProof
  };
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(
  express.json({
    limit: '64kb'
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: '64kb'
  })
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'WTS BetPawa Local Connector PRO',
      time: now()
    });
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  '/api/status',
  async (req, res) => {
    let auth = {
      authenticated: false,
      profile: false,
      balance: false,
      loginFormVisible: false,
      url: currentUrl()
    };

    try {
      auth =
        await authSnapshot();
    } catch {}

    const dom =
      await snapshotDomHealth()
        .catch(() => ({
          available: false,
          groups: {},
          url: currentUrl()
        }));

    res.json({
      ok: true,

      state:
        connectorState,

      authenticated:
        auth.authenticated,

      authenticationVerification: {
        profile:
          auth.profile,

        balance:
          auth.balance,

        proof:
          auth.proof || null,

        generation:
          authGeneration
      },

      selectedGame,

      currentUrl:
        currentUrl(),

      lastGameUrl,

      loginRunning,

      currentLoginRequestId,

      domHealth:
        dom,

      domEvents:
        domEvents.slice(0, 12),

      mutationVersion:
        pageMutationVersion
    });
  }
);

/* =========================================================
   START LOGIN
========================================================= */

app.post(
  '/api/start-login',
  async (req, res) => {

    /*
     * Prevent double-click / concurrent login.
     */

    if (loginRunning) {
      return res
        .status(409)
        .json({
          ok: false,
          message:
            'A login attempt is already running.',
          requestId:
            currentLoginRequestId
        });
    }

    const phone =
      safePhone(
        req.body?.phone
      );

    const password =
      String(
        req.body?.password || ''
      );

    if (
      !/^\d{9}$/.test(phone)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          message:
            'Enter a valid 9-digit mobile number.'
        });
    }

    if (
      password.length < 4
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          message:
            'Password must contain at least 4 characters.'
        });
    }

    await ensurePage();

    /*
     * If already authenticated, don't refresh
     * or submit the login form again.
     */

    const existing =
      await verifyAuthenticatedSession(2)
        .catch(() => ({
          authenticated: false
        }));

    if (existing.authenticated) {
      authenticated = true;

      connectorState =
        selectedGame
          ? 'GAME_CONNECTED'
          : 'AUTHENTICATED';

      return res.json({
        ok: true,
        status:
          'AUTHENTICATED',
        message:
          'Connected.',
        authenticated:
          true,
        alreadyAuthenticated:
          true,
        proof:
          existing.proof
      });
    }

    const rid =
      requestId();

    loginRequests.set(
      rid,
      {
        id: rid,
        status:
          'AUTHENTICATING',
        message:
          'Authenticating.',
        authenticated: false,
        createdAt:
          Date.now(),
        updatedAt:
          Date.now()
      }
    );

    currentLoginRequestId =
      rid;

    loginRunning = true;

    connectorState =
      'AUTHENTICATING';

    authenticated = false;

    /*
     * Password remains only in this function's local
     * execution context and is never logged/returned.
     */

    void performLogin({
      phone,
      password,
      requestId: rid
    })
      .catch(error => {
        console.log(
          '[LOGIN] Unexpected error:',
          error?.message ||
            'Unknown error'
        );

        updateRequest(
          rid,
          {
            status:
              'LOGIN_FAILED',
            message:
              'Login could not be verified.',
            authenticated:
              false,
            reason:
              'UNEXPECTED_ERROR'
          }
        );

        connectorState =
          'LOGIN_FAILED';

        authenticated =
          false;
      })
      .finally(() => {
        loginRunning =
          false;
      });

    return res.json({
      ok: true,
      requestId:
        rid,
      status:
        'AUTHENTICATING',
      message:
        'Authenticating.'
    });
  }
);

/* =========================================================
   WAIT LOGIN
========================================================= */

app.get(
  '/api/wait-login',
  async (req, res) => {
    const rid =
      String(
        req.query.requestId || ''
      );

    const request =
      loginRequests.get(rid);

    if (!rid || !request) {
      return res
        .status(404)
        .json({
          ok: false,
          message:
            'Login request not found.'
        });
    }

    const latest =
      loginRequests.get(rid);

    const profile =
      lastAuthProof === 'PROFILE' ||
      lastAuthProof ===
        'PROFILE_AND_BALANCE';

    const balance =
      lastAuthProof === 'BALANCE' ||
      lastAuthProof ===
        'PROFILE_AND_BALANCE';

    res.json({
      ok: true,

      requestId:
        rid,

      status:
        latest.status,

      message:
        latest.message,

      authenticated:
        latest.status ===
        'AUTHENTICATED',

      profile,

      balance,

      proof:
        lastAuthProof,

      authGeneration,

      domHealth:
        await snapshotDomHealth()
          .catch(() => null)
    });
  }
);

/* =========================================================
   CONNECT GAME API
========================================================= */

app.post(
  '/api/connect-game',
  async (req, res) => {
    const key =
      String(
        req.body?.game || ''
      );

    if (!getGame(key)) {
      return res
        .status(400)
        .json({
          ok: false,
          message:
            'Choose exactly one valid game.'
        });
    }

    try {
      const result =
        await connectGame(key);

      if (!result.success) {
        return res
          .status(401)
          .json({
            ok: false,
            ...result
          });
      }

      return res.json({
        ok: true,
        ...result
      });

    } catch (error) {
      connectorState =
        'ERROR';

      console.log(
        '[GAME] Internal open error:',
        error?.message ||
          'Unknown error'
      );

      return res
        .status(500)
        .json({
          ok: false,
          message:
            'Could not open the selected game.'
        });
    }
  }
);

/* =========================================================
   RESET
========================================================= */

app.post(
  '/api/reset',
  async (req, res) => {

    authenticated =
      false;

    selectedGame =
      null;

    lastGameUrl =
      null;

    connectorState =
      'IDLE';

    currentLoginRequestId =
      null;

    loginRunning =
      false;

    authGeneration =
      0;

    lastAuthProof =
      null;

    domEvents =
      [];

    domInitialized =
      false;

    domSnapshot =
      {};

    try {
      await ensurePage();

      /*
       * IMPORTANT:
       * Use safeGoto so a BetPawa navigation timeout
       * cannot kill the reset request/server.
       */

      await safeGoto(
        LOGIN_URL,
        {
          waitUntil: 'commit',
          timeout: NAVIGATION_TIMEOUT
        }
      );

      await sleep(700);

      await installMutationObserver();

      domInitialized =
        false;

      domSnapshot =
        {};

      await syncMutationVersion();

      await snapshotDomHealth();

      if (!domWatchdogTimer) {
        startDomWatchdog();
      }

    } catch {}

    res.json({
      ok: true,
      state:
        connectorState
    });
  }
);

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      '..',
      'frontend'
    )
  )
);

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.use(
  (req, res, next) => {
    if (
      req.method === 'GET' &&
      !req.path.startsWith('/api/')
    ) {
      return res.sendFile(
        path.join(
          __dirname,
          '..',
          'frontend',
          'index.html'
        )
      );
    }

    next();
  }
);

/* =========================================================
   EXPRESS ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      '[SERVER ERROR]',
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    return res
      .status(500)
      .json({
        ok: false,
        message:
          'Internal server error.'
      });
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function start() {

  /*
   * Browser startup itself should normally succeed.
   */

  try {
    await ensurePage();
  } catch (error) {
    /*
     * Don't expose a raw Playwright stack trace.
     */

    console.log(
      '[BROWSER] Browser startup could not be completed yet.'
    );
  }

  /*
   * BetPawa startup navigation is NON-FATAL.
   */

  try {
    if (page && !page.isClosed()) {
      await openLoginPage();
    }
  } catch {
    startupReady =
      false;
  }

  /*
   * Watchdog is started regardless of whether
   * BetPawa completed its initial load.
   */

  if (!domWatchdogTimer) {
    try {
      if (page && !page.isClosed()) {
        await installMutationObserver();

        await syncMutationVersion();

        /*
         * Silent baseline.
         */

        await snapshotDomHealth();
      }
    } catch {}

    startDomWatchdog();
  }

  /*
   * LOCAL SERVER MUST START EVEN IF BETPAWA IS SLOW.
   */

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        '=============================================='
      );

      console.log(
        ' WTS BETPAWA LOCAL CONNECTOR — PRO ELITE'
      );

      console.log(
        '=============================================='
      );

      console.log(
        ` Local: http://${HOST}:${PORT}`
      );

      console.log(
        ` Headless: ${HEADLESS}`
      );

      console.log(
        ` Games: Aviator ${GAMES.aviator.id} | ` +
        `Fortuner Mine ${GAMES.fortunerMine.id}`
      );

      console.log(
        ' Auth: strict baseline → submit → post-login proof'
      );

      console.log(
        ' Game gate: independent authenticated verification'
      );

      console.log(
        ' DOM watchdog: ACTIVE (state-aware)'
      );

      console.log(
        ` Startup: ${
          startupReady
            ? 'login page ready → silent DOM baseline'
            : 'local server ready → BetPawa will recover/retry'
        }`
      );

      console.log(
        '=============================================='
      );
    }
  );
}

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(signal) {
  console.log(
    `\n[SERVER] ${signal} received`
  );

  if (domWatchdogTimer) {
    clearInterval(
      domWatchdogTimer
    );

    domWatchdogTimer =
      null;
  }

  try {
    await context?.close();
  } catch {}

  try {
    await browser?.close();
  } catch {}

  process.exit(0);
}

process.on(
  'SIGINT',
  () => {
    void shutdown('SIGINT');
  }
);

process.on(
  'SIGTERM',
  () => {
    void shutdown('SIGTERM');
  }
);

/* =========================================================
   BOOT
========================================================= */

start().catch(() => {

  /*
   * Last-resort protection:
   * even if browser initialization has a transient failure,
   * keep the local HTTP server alive.
   */

  try {
    app.listen(
      PORT,
      HOST,
      () => {
        console.log(
          '=============================================='
        );

        console.log(
          ' WTS BETPAWA LOCAL CONNECTOR — PRO ELITE'
        );

        console.log(
          '=============================================='
        );

        console.log(
          ` Local: http://${HOST}:${PORT}`
        );

        console.log(
          ' Startup: local server ready'
        );

        console.log(
          '=============================================='
        );
      }
    );
  } catch {}
});
