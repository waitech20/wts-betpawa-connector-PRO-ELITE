'use strict';

const path = require('path');

try {
  require('dotenv').config();
} catch {}

const express = require('express');
const { chromium } = require('playwright');


// ============================================================
// OPTIONAL MESSAGEPACK DECODER
// ============================================================

let msgpackDecode = null;

try {
  ({ decode: msgpackDecode } = require('@msgpack/msgpack'));
  console.log('[WS-SNIFF] MessagePack decoder loaded.');
} catch {
  console.log(
    '[WS-SNIFF] @msgpack/msgpack not installed.'
  );
  console.log(
    '[WS-SNIFF] Run: npm install @msgpack/msgpack'
  );
}


// ============================================================
// SERVER CONFIG
// ============================================================

const app = express();

const PORT =
  Number(process.env.PORT || 3930);

const HOST =
  process.env.HOST || '127.0.0.1';

const HEADLESS =
  String(
    process.env.HEADLESS || 'false'
  ).toLowerCase() === 'true';

const LOGIN_URL =
  process.env.BETPAWA_LOGIN_URL ||
  'https://www.betpawa.co.tz/login';

const HOME_URL =
  process.env.GAME_BASE_URL ||
  'https://www.betpawa.co.tz';

const VIEWPORT = {
  width:
    Number(process.env.WIDTH || 430),

  height:
    Number(process.env.HEIGHT || 850)
};

const AUTH_TIMEOUT =
  Number(process.env.AUTH_TIMEOUT || 40000);

const OPEN_GAME_TIMEOUT =
  Number(
    process.env.OPEN_GAME_TIMEOUT || 15000
  );

const WATCHDOG_MS =
  Number(
    process.env.DOM_WATCHDOG_MS || 250
  );

const STABLE_AUTH_CHECKS =
  Number(
    process.env.STABLE_AUTH_CHECKS || 2
  );


// ============================================================
// GAMES
// ============================================================

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


// ============================================================
// AUTH SELECTORS
// ============================================================

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


const DOM_GROUPS = {

  AUTH_PHONE:
    SELECTORS.phone,

  AUTH_PASSWORD:
    SELECTORS.password,

  AUTH_LOGIN_BUTTON:
    SELECTORS.loginButton,

  AUTH_PROFILE:
    SELECTORS.profile,

  AUTH_BALANCE:
    SELECTORS.balance,

  AUTH_ERROR:
    SELECTORS.loginError

};


// ============================================================
// GAME DOM GROUPS
// ============================================================

const GAME_DOM_GROUPS = {

  COMMON: [
    'body',
    '#root',
    '#app',
    'main',
    '[role="main"]'
  ],

  IFRAME: [
    'iframe'
  ],

  CANVAS: [
    'canvas'
  ],

  SVG: [
    'svg'
  ],

  GAME_ROOT: [
    '[class*="game"]',
    '[id*="game"]',
    '[class*="Game"]',
    '[id*="Game"]'
  ],

  AVIATOR_PAYOUT: [
    '.payout',
    '[class*="payout"]',
    '[class*="Payout"]',
    '[class*="multiplier"]',
    '[class*="Multiplier"]'
  ],

  FORTUNER_MINE: [
    '[class*="mine"]',
    '[id*="mine"]',
    '[class*="Mine"]',
    '[id*="Mine"]',
    '[class*="grid"]',
    '[class*="Grid"]',
    '[class*="cell"]',
    '[class*="Cell"]',
    '[data-test-id*="mine"]',
    '[data-testid*="mine"]'
  ]

};


// ============================================================
// GLOBAL STATE
// ============================================================

let browser = null;

let context = null;

let page = null;

let connectorState =
  'IDLE';

let authenticated =
  false;

let selectedGame =
  null;

let loginRunning =
  false;

let currentLoginRequestId =
  null;

const loginRequests =
  new Map();

let authGeneration =
  0;

let lastAuthProof =
  null;

let lastGameUrl =
  null;

let startupReady =
  false;

let monitorMode =
  'BOOT';

let domSnapshot =
  {};

let domEvents =
  [];

let domInitialized =
  false;

let domBaselineGeneration =
  0;

let domWatchdogTimer =
  null;

let pageMutationVersion =
  0;

let lastMutationVersion =
  0;

let domPageUrl =
  null;

let gameDomSnapshot =
  {};

let gameDomInitialized =
  false;

let gameDomEvents =
  [];

let eventSequence =
  0;

const eventClients =
  new Set();


// ============================================================
// WEBSOCKET STATE
// ============================================================

let wsFrames =
  [];

let wsRoundEvents =
  [];

let wsSniffActive =
  false;

let wsEventSequence =
  0;

let currentRoundId =
  null;


// ============================================================
// ROUND STATE
// ============================================================

let liveRoundState = {

  phase:
    'WAITING',

  multiplier:
    null,

  liveMultiplier:
    null,

  crashX:
    null,

  confirmedCrashX:
    null,

  roundId:
    null,

  newStateId:
    null,

  timeLeft:
    null,

  updatedAt:
    null,

  roundStartedAt:
    null,

  crashDetectedAt:
    null,

  crashConfirmedAt:
    null,

  nextCrash:
    null,

  nextCrashAt:
    null,

  nextCrashRoundId:
    null,

  confidence:
    'UNVERIFIED'

};


// ============================================================
// GAME STATE
// ============================================================

let gameDomState = {

  available:
    false,

  game:
    null,

  url:
    null,

  title:
    null,

  frames:
    [],

  groups:
    {},

  checkedAt:
    null,

  mutationVersion:
    0

};


let gameState = {

  available:
    false,

  primaryValue:
    null,

  primaryLabel:
    null,

  roundText:
    null,

  gridCount:
    null,

  checkedAt:
    null,

  balance:
    null,

  betControls:
    [],

  roundHistory:
    [],

  wsMultiplier:
    null,

  wsConnected:
    false

};


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}


function safePhone(value) {

  return String(value || '')
    .replace(/\D/g, '')
    .slice(0, 9);

}


function requestId() {

  return (
    `${Date.now().toString(36)}-` +
    `${Math.random()
      .toString(36)
      .slice(2, 10)}`
  );

}


function now() {

  return new Date().toISOString();

}


function currentUrl() {

  try {

    return page &&
      !page.isClosed()
      ? page.url()
      : null;

  } catch {

    return null;

  }

}


function isLoginUrl(url) {

  try {

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


function currentGame() {

  return selectedGame
    ? GAMES[selectedGame] || null
    : null;

}


// ============================================================
// IMPORTANT AVIATOR SOCKET FILTER
// ============================================================

function isAviatorSocket(url) {

  return /spribegaming\.com\/BlueBox\/websocket/i
    .test(
      String(url || '')
    );

}


// ============================================================
// EVENTS
// ============================================================

function publishEvent(event) {

  const payload =
    `data: ${JSON.stringify(event)}\n\n`;

  for (
    const res of eventClients
  ) {

    try {

      res.write(payload);

    } catch {

      eventClients.delete(res);

    }

  }

}


function makeEvent(
  type,
  message,
  source,
  data = {}
) {

  return {

    seq:
      ++eventSequence,

    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,

    time:
      now(),

    type,

    message,

    source,

    game:
      selectedGame,

    data

  };

}


function pushDomEvent(
  type,
  group,
  message,
  selector = null
) {

  const event =
    makeEvent(
      type,
      message,
      'auth-dom',
      {
        group,
        selector,
        mode:
          monitorMode
      }
    );

  event.group =
    group;

  event.selector =
    selector;

  event.mode =
    monitorMode;

  domEvents.unshift(
    event
  );

  if (
    domEvents.length > 40
  ) {

    domEvents.length = 40;

  }

  publishEvent(event);

}


function pushGameDomEvent(
  type,
  group,
  message,
  selector = null
) {

  const event =
    makeEvent(
      type,
      message,
      'game-dom',
      {
        group,
        selector
      }
    );

  event.group =
    group;

  event.selector =
    selector;

  gameDomEvents.unshift(
    event
  );

  if (
    gameDomEvents.length > 40
  ) {

    gameDomEvents.length = 40;

  }

  publishEvent(event);

}


function pushStateEvent(
  type,
  message,
  data = {}
) {

  const event =
    makeEvent(
      type,
      message,
      'game-state',
      data
    );

  gameDomEvents.unshift(
    event
  );

  if (
    gameDomEvents.length > 40
  ) {

    gameDomEvents.length = 40;

  }

  publishEvent(event);

}


// ============================================================
// WEBSOCKET ROUND EVENT
// ============================================================

function pushWsRoundEvent(
  type,
  data = {},
  sourceUrl = null
) {

  const event = {

    seq:
      ++wsEventSequence,

    time:
      now(),

    type,

    source:
      'websocket',

    url:
      sourceUrl,

    roundId:
      data.roundId ??
      liveRoundState.roundId ??
      null,

    multiplier:
      data.multiplier ??
      null,

    crashX:
      data.crashX ??
      null,

    confirmedCrashX:
      data.confirmedCrashX ??
      null,

    stateId:
      data.stateId ??
      liveRoundState.newStateId ??
      null,

    message:
      data.message ||
      type

  };


  wsRoundEvents.unshift(
    event
  );


  if (
    wsRoundEvents.length > 100
  ) {

    wsRoundEvents.length = 100;

  }


  publishEvent({

    seq:
      ++eventSequence,

    id:
      `ws-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,

    time:
      event.time,

    type,

    message:
      event.message,

    source:
      'websocket',

    game:
      selectedGame,

    data:
      event

  });


  console.log(
    `[WS EVENT] ${type} ${event.message}`
  );


  return event;

}


// ============================================================
// ROUND RESET
// ============================================================

function resetRoundState(
  roundId = null
) {

  currentRoundId =
    roundId == null
      ? null
      : String(roundId);


  liveRoundState = {

    phase:
      'WAITING',

    multiplier:
      null,

    liveMultiplier:
      null,

    crashX:
      null,

    confirmedCrashX:
      null,

    roundId,

    newStateId:
      null,

    timeLeft:
      null,

    updatedAt:
      now(),

    roundStartedAt:
      now(),

    crashDetectedAt:
      null,

    crashConfirmedAt:
      null,

    nextCrash:
      null,

    nextCrashAt:
      null,

    nextCrashRoundId:
      null,

    confidence:
      'UNVERIFIED'

  };

}


// ============================================================
// NUMBER NORMALIZATION
// ============================================================

function keyNorm(key) {

  return String(
    key ?? ''
  )
    .replace(
      /[-_\s]/g,
      ''
    )
    .toLowerCase();

}


function toNumber(value) {

  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {

    return value;

  }


  if (
    typeof value === 'string' &&
    value.trim() !== ''
  ) {

    const n =
      Number(value);

    if (
      Number.isFinite(n)
    ) {

      return n;

    }

  }


  return null;

}


// ============================================================
// DEEP MESSAGEPACK SCANNER
// ============================================================

function deepScan(value) {

  const result = {

    x: [],

    crashX: [],

    maxMultiplier: [],

    roundId: [],

    stateId: [],

    playerActivity:
      false

  };


  const seen =
    new WeakSet();


  function walk(
    current,
    path = '$',
    parentKey = ''
  ) {

    const key =
      keyNorm(parentKey);


    if (
      current === null ||
      current === undefined
    ) {

      return;

    }


    if (
      typeof current !== 'object'
    ) {

      const number =
        toNumber(current);


      if (
        key === 'x' &&
        number !== null
      ) {

        result.x.push({

          value:
            number,

          path

        });

      }


      if (
        key === 'crashx' &&
        number !== null
      ) {

        result.crashX.push({

          value:
            number,

          path

        });

      }


      if (
        key === 'maxmultiplier' &&
        number !== null
      ) {

        result.maxMultiplier.push({

          value:
            number,

          path

        });

      }


      if (
        [
          'roundid',
          'round',
          'roundnumber',
          'gameid'
        ].includes(key)
      ) {

        result.roundId.push({

          value:
            current,

          path

        });

      }


      if (
        [
          'newstateid',
          'stateid'
        ].includes(key)
      ) {

        result.stateId.push({

          value:
            current,

          path

        });

      }


      return;

    }


    if (
      seen.has(current)
    ) {

      return;

    }


    seen.add(current);


    if (
      Array.isArray(current)
    ) {

      current.forEach(
        (item, index) => {

          walk(
            item,
            `${path}[${index}]`,
            parentKey
          );

        }
      );

      return;

    }


    for (
      const [
        keyName,
        child
      ] of Object.entries(current)
    ) {

      const normalized =
        keyNorm(keyName);


      if (
        [
          'playerid',
          'betid',
          'winamount',
          'cashouts',
          'openbetscount',
          'activeplayerscount',
          'totalcashout',
          'topplayerprofileimages'
        ].includes(normalized)
      ) {

        result.playerActivity =
          true;

      }


      walk(
        child,
        `${path}.${keyName}`,
        keyName
      );

    }

  }


  walk(value);

  return result;

}


// ============================================================
// FIRST VALUE
// ============================================================

function firstValue(list) {

  return Array.isArray(list) &&
    list.length
    ? list[0].value
    : null;

}


// ============================================================
// SAFE JSON CLONE
// ============================================================

function safeClone(value) {

  try {

    return JSON.parse(
      JSON.stringify(
        value,
        (
          _,
          item
        ) =>
          typeof item === 'bigint'
            ? String(item)
            : item
      )
    );

  } catch {

    return String(value);

  }

}


// ============================================================
// PLAYWRIGHT PAYLOAD -> BUFFER
// ============================================================

function payloadBuffer(payload) {

  try {

    if (
      Buffer.isBuffer(payload)
    ) {

      return payload;

    }


    if (
      payload instanceof ArrayBuffer
    ) {

      return Buffer.from(
        payload
      );

    }


    if (
      ArrayBuffer.isView(payload)
    ) {

      return Buffer.from(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength
      );

    }


    /*
     * Important:
     *
     * Some Playwright environments
     * can expose binary data as a string.
     *
     * latin1 preserves byte values.
     */

    if (
      typeof payload === 'string'
    ) {

      return Buffer.from(
        payload,
        'latin1'
      );

    }

  } catch {}

  return null;

}


// ============================================================
// MESSAGEPACK MULTI-OFFSET DECODER
// ============================================================

function decodeCandidates(
  buffer
) {

  if (
    !buffer ||
    !buffer.length
  ) {

    return {

      decoded:
        null,

      scan:
        null,

      offset:
        null,

      score:
        0,

      error:
        'Empty binary frame'

    };

  }


  if (
    !msgpackDecode
  ) {

    return {

      decoded:
        null,

      scan:
        null,

      offset:
        null,

      score:
        0,

      error:
        '@msgpack/msgpack is not installed'

    };

  }


  let best =
    null;


  /*
   * Try offset 0 and possible
   * application-level headers.
   */

  const maxOffset =
    Math.min(
      32,
      buffer.length - 1
    );


  for (
    let offset = 0;
    offset <= maxOffset;
    offset++
  ) {

    try {

      const decoded =
        msgpackDecode(
          buffer.subarray(
            offset
          )
        );


      const scan =
        deepScan(
          decoded
        );


      let score =
        0;


      /*
       * crashX is our strongest
       * signal.
       */

      if (
        scan.crashX.length
      ) {

        score += 1000;

      }


      if (
        scan.maxMultiplier.length
      ) {

        score += 500;

      }


      if (
        scan.x.length
      ) {

        score += 100;

      }


      if (
        scan.roundId.length
      ) {

        score += 80;

      }


      if (
        scan.stateId.length
      ) {

        score += 40;

      }


      if (
        typeof decoded === 'object'
      ) {

        score += 10;

      }


      if (
        !best ||
        score > best.score
      ) {

        best = {

          decoded:
            safeClone(decoded),

          scan,

          offset,

          score

        };

      }

    } catch {}

  }


  if (
    !best
  ) {

    return {

      decoded:
        null,

      scan:
        null,

      offset:
        null,

      score:
        0,

      error:
        'MessagePack decode failed'

    };

  }


  return {

    ...best,

    error:
      null

  };

}


// ============================================================
// AVIATOR ROUND DECODER
// ============================================================

function applyDecodedRoundUpdate(
  decoded,
  sourceUrl
) {

  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !isAviatorSocket(sourceUrl)
  ) {

    return null;

  }


  const scan =
    deepScan(
      decoded
    );


  // ----------------------------------------------------------
  // ROUND ID
  // ----------------------------------------------------------

  const roundId =
    firstValue(
      scan.roundId
    );


  if (
    roundId !== null &&
    roundId !== undefined
  ) {

    const id =
      String(roundId);


    if (
      currentRoundId !== id
    ) {

      resetRoundState(
        roundId
      );


      pushWsRoundEvent(

        'NEW_ROUND_STARTED',

        {

          roundId,

          message:
            `🟢 NEW ROUND STARTED — Round ${roundId}`

        },

        sourceUrl

      );

    }


    liveRoundState.roundId =
      roundId;

  }


  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------

  const stateId =
    firstValue(
      scan.stateId
    );


  if (
    stateId !== null &&
    stateId !== undefined
  ) {

    liveRoundState.newStateId =
      stateId;

  }


  // ----------------------------------------------------------
  // CRASH X
  //
  // THIS IS THE MAIN TARGET
  // ----------------------------------------------------------

  const crashX =
    toNumber(
      firstValue(
        scan.crashX
      )
    );


  if (
    crashX !== null &&
    crashX >= 1
  ) {

    const changed =
      liveRoundState.crashX !== crashX;


    liveRoundState.crashX =
      crashX;


    liveRoundState.multiplier =
      crashX;


    liveRoundState.liveMultiplier =
      null;


    liveRoundState.phase =
      'CRASHED';


    liveRoundState.crashDetectedAt =
      now();


    liveRoundState.nextCrash =
      crashX;


    liveRoundState.nextCrashAt =
      liveRoundState.crashDetectedAt;


    liveRoundState.nextCrashRoundId =
      liveRoundState.roundId;


    liveRoundState.confidence =
      'CRASH_DETECTED';


    if (
      changed
    ) {

      pushWsRoundEvent(

        'CRASH_DETECTED',

        {

          roundId:
            liveRoundState.roundId,

          crashX,

          multiplier:
            crashX,

          message:
            `🔴 CRASH DETECTED — crashX: ${crashX.toFixed(2)}x`

        },

        sourceUrl

      );

    }


    /*
     * STOP HERE.
     *
     * We already found the exact
     * crashX frame.
     */

    return 'CRASH_DETECTED';

  }


  // ----------------------------------------------------------
  // MAX MULTIPLIER
  // ----------------------------------------------------------

  const maxMultiplier =
    toNumber(
      firstValue(
        scan.maxMultiplier
      )
    );


  if (
    maxMultiplier !== null &&
    maxMultiplier >= 1
  ) {

    liveRoundState.confirmedCrashX =
      maxMultiplier;


    liveRoundState.crashConfirmedAt =
      now();


    const match =
      liveRoundState.crashX !== null &&
      Math.abs(
        liveRoundState.crashX -
        maxMultiplier
      ) < 0.000001;


    liveRoundState.confidence =
      match
        ? 'CONFIRMED_MATCH'
        : liveRoundState.crashX === null
          ? 'CHART_CONFIRMED'
          : 'MISMATCH';


    if (
      match
    ) {

      pushWsRoundEvent(

        'CRASH_CONFIRMED',

        {

          roundId:
            liveRoundState.roundId,

          confirmedCrashX:
            maxMultiplier,

          multiplier:
            maxMultiplier,

          message:
            `✅ CONFIRMED maxMultiplier: ${maxMultiplier.toFixed(2)}x — MATCH: YES`

        },

        sourceUrl

      );

    }


    return 'MAX_MULTIPLIER';

  }


  // ----------------------------------------------------------
  // LIVE X
  // ----------------------------------------------------------

  const x =
    toNumber(
      firstValue(
        scan.x
      )
    );


  /*
   * Player/bet frames containing
   * x-like data are ignored.
   */

  if (
    x !== null &&
    x >= 1 &&
    !scan.playerActivity &&
    liveRoundState.phase !== 'CRASHED'
  ) {

    liveRoundState.liveMultiplier =
      x;


    liveRoundState.multiplier =
      x;


    liveRoundState.phase =
      'FLYING';


    liveRoundState.updatedAt =
      now();


    return 'LIVE_TICK';

  }


  liveRoundState.updatedAt =
    now();


  return null;

}


// ============================================================
// WEBSOCKET FRAME RECORDER
//
// IMPORTANT:
//
// ONLY RECEIVED AVIATOR GAME FRAMES
// ARE STORED.
//
// This removes the huge flood from:
// openBetsCount
// cashouts
// player_id
// winAmount
// etc.
// ============================================================

function recordWsFrame(
  direction,
  url,
  payload
) {

  if (
    !wsSniffActive
  ) {

    return;

  }


  /*
   * Only Aviator game socket.
   */

  if (
    !isAviatorSocket(url)
  ) {

    return;

  }


  /*
   * Only server -> browser.
   *
   * We don't need sent frames for
   * crashX proof.
   */

  if (
    direction !== 'received'
  ) {

    return;

  }


  const buffer =
    payloadBuffer(
      payload
    );


  if (
    !buffer ||
    !buffer.length
  ) {

    return;

  }


  const decoded =
    decodeCandidates(
      buffer
    );


  let analysis =
    null;


  if (
    decoded.decoded &&
    typeof decoded.decoded === 'object'
  ) {

    analysis =
      applyDecodedRoundUpdate(
        decoded.decoded,
        url
      );

  }


  const scan =
    decoded.scan;


  const hasCrash =
    !!(
      scan &&
      scan.crashX &&
      scan.crashX.length
    );


  const hasMax =
    !!(
      scan &&
      scan.maxMultiplier &&
      scan.maxMultiplier.length
    );


  const hasX =
    !!(
      scan &&
      scan.x &&
      scan.x.length
    );


  const hasRound =
    !!(
      scan &&
      scan.roundId &&
      scan.roundId.length
    );


  /*
   * ONLY useful frames.
   *
   * Frames such as:
   *
   * openBetsCount
   * player_id
   * cashouts
   *
   * are NOT stored.
   */

  if (
    !hasCrash &&
    !hasMax &&
    !hasX &&
    !hasRound
  ) {

    return;

  }


  const frame = {

    time:
      now(),

    direction:
      'received',

    url,

    socket:
      'AVIATOR_GAME',

    kind:
      'binary',

    byteLength:
      buffer.length,

    analysis,

    decodeOffset:
      decoded.offset,

    decodeScore:
      decoded.score,

    decodeError:
      decoded.error,

    fields: {

      x:
        scan.x.slice(0, 5),

      crashX:
        scan.crashX.slice(0, 5),

      maxMultiplier:
        scan.maxMultiplier.slice(0, 5),

      roundId:
        scan.roundId.slice(0, 5),

      stateId:
        scan.stateId.slice(0, 5),

      playerActivity:
        scan.playerActivity

    },

    hex:
      buffer
        .subarray(
          0,
          Math.min(
            160,
            buffer.length
          )
        )
        .toString('hex')
        .match(/.{1,2}/g)
        ?.join(' ') ||
        '',

    decoded:
      decoded.decoded ||
      null

  };


  wsFrames.unshift(
    frame
  );


  if (
    wsFrames.length > 80
  ) {

    wsFrames.length = 80;

  }


  console.log(
    `[WS USEFUL] ${analysis || 'DATA'} ` +
    `bytes=${frame.byteLength} ` +
    `offset=${frame.decodeOffset}`
  );


  if (
    hasCrash
  ) {

    console.log(
      '[WS CRASHX]',
      scan.crashX
    );

  }

}


// ============================================================
// REQUEST / AUTH HELPERS
// ============================================================

function updateRequest(
  id,
  patch
) {

  const request =
    loginRequests.get(id);

  if (
    !request
  ) {

    return null;

  }


  Object.assign(
    request,
    patch,
    {
      updatedAt:
        Date.now()
    }
  );


  return request;

}


// ============================================================
// PAGE LISTENERS
// ============================================================

function addPageListeners() {

  if (
    !page
  ) {

    return;

  }


  page.on(
    'pageerror',
    error => {

      console.log(
        '[PAGE ERROR]',
        error.message
      );

    }
  );


  page.on(
    'dialog',
    async dialog => {

      try {

        await dialog.dismiss();

      } catch {}

    }
  );


  page.on(
    'framenavigated',
    frame => {

      if (
        frame === page.mainFrame()
      ) {

        console.log(
          '[NAV]',
          frame.url()
        );

        scheduleMonitorRebaseline();

      }

    }
  );


  // ==========================================================
  // WEBSOCKET
  // ==========================================================

  page.on(
    'websocket',
    ws => {

      const wsUrl =
        ws.url();


      const aviator =
        isAviatorSocket(
          wsUrl
        );


      if (
        aviator
      ) {

        console.log(
          '[WS] AVIATOR GAME SOCKET:',
          wsUrl
        );

      }


      if (
        wsSniffActive &&
        selectedGame === 'aviator' &&
        aviator
      ) {

        gameState.wsConnected =
          true;

      }


      ws.on(
        'framereceived',
        event => {

          recordWsFrame(
            'received',
            wsUrl,
            event.payload
          );

        }
      );


      ws.on(
        'framesent',
        event => {

          /*
           * Intentionally ignored.
           *
           * We are looking for server-reported
           * crashX only.
           */

        }
      );


      ws.on(
        'close',
        () => {

          if (
            aviator
          ) {

            gameState.wsConnected =
              false;

            console.log(
              '[WS] AVIATOR SOCKET CLOSED'
            );

          }

        }
      );

    }
  );

}


// ============================================================
// BROWSER
// ============================================================

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


  console.log(
    '[BROWSER] Starting Chromium...'
  );


  browser =
    await chromium.launch({

      headless:
        HEADLESS

    });


  context =
    await browser.newContext({

      viewport:
        VIEWPORT,

      locale:
        'en-TZ'

    });


  page =
    await context.newPage();


  page.setDefaultTimeout(
    7000
  );


  page.setDefaultNavigationTimeout(
    OPEN_GAME_TIMEOUT
  );


  addPageListeners();


  console.log(
    '[BROWSER] Chromium ready'
  );

}


async function ensurePage() {

  await ensureBrowser();


  if (
    !page ||
    page.isClosed()
  ) {

    page =
      await context.newPage();


    page.setDefaultTimeout(
      7000
    );


    page.setDefaultNavigationTimeout(
      OPEN_GAME_TIMEOUT
    );


    addPageListeners();

  }


  return page;

}


// ============================================================
// NAVIGATION
// ============================================================

async function safeGoto(
  url,
  options = {}
) {

  if (
    !page ||
    page.isClosed()
  ) {

    await ensurePage();

  }


  try {

    await page.goto(
      url,
      {

        waitUntil:
          options.waitUntil ||
          'commit',

        timeout:
          options.timeout ||
          Math.max(
            OPEN_GAME_TIMEOUT,
            10000
          )

      }
    );


    return {

      success:
        true,

      timeout:
        false

    };

  } catch (error) {

    console.log(
      `[NAV] Navigation did not fully settle: ${url}`
    );


    return {

      success:
        false,

      timeout:
        true,

      message:
        error.message

    };

  }

}


// ============================================================
// DOM PROBES
// ============================================================

async function probe(
  selectors
) {

  if (
    !page ||
    page.isClosed()
  ) {

    return {

      found:
        false,

      visible:
        false,

      selector:
        null,

      count:
        0

    };

  }


  for (
    const selector of selectors
  ) {

    try {

      const locator =
        page
          .locator(selector)
          .first();


      const count =
        await locator.count();


      if (
        count
      ) {

        return {

          found:
            true,

          visible:
            await locator
              .isVisible()
              .catch(
                () => false
              ),

          selector,

          count

        };

      }

    } catch {}

  }


  return {

    found:
      false,

    visible:
      false,

    selector:
      null,

    count:
      0

  };

}


async function textFor(
  selectors
) {

  if (
    !page ||
    page.isClosed()
  ) {

    return '';

  }


  for (
    const selector of selectors
  ) {

    try {

      const locator =
        page.locator(
          selector
        );


      const count =
        Math.min(
          await locator.count(),
          8
        );


      for (
        let i = 0;
        i < count;
        i++
      ) {

        const item =
          locator.nth(i);


        if (
          await item
            .isVisible()
            .catch(
              () => false
            )
        ) {

          const text =
            (
              await item
                .innerText()
                .catch(
                  () => ''
                )
            ).trim();


          if (
            text
          ) {

            return text;

          }

        }

      }

    } catch {}

  }


  return '';

}


// ============================================================
// MONITOR MODE
// ============================================================

function modeForPage() {

  const url =
    currentUrl();


  if (
    selectedGame &&
    authenticated &&
    url &&
    !isLoginUrl(url)
  ) {

    return 'GAME';

  }


  if (
    authenticated &&
    url &&
    !isLoginUrl(url)
  ) {

    return 'AUTH';

  }


  if (
    url &&
    isLoginUrl(url) &&
    !authenticated
  ) {

    return 'LOGIN';

  }


  return
    monitorMode === 'BOOT'
      ? 'BOOT'
      : monitorMode;

}


function expectedDomGroups(
  mode = modeForPage()
) {

  if (
    mode === 'LOGIN'
  ) {

    return new Set([

      'AUTH_PHONE',

      'AUTH_PASSWORD',

      'AUTH_LOGIN_BUTTON'

    ]);

  }


  if (
    mode === 'AUTH' ||
    mode === 'GAME'
  ) {

    return new Set([

      'AUTH_PROFILE',

      'AUTH_BALANCE'

    ]);

  }


  return new Set();

}


// ============================================================
// RESET DOM
// ============================================================

function resetDomBaseline(
  reason =
    'state transition'
) {

  domInitialized =
    false;

  domSnapshot =
    {};

  domPageUrl =
    currentUrl();

  domBaselineGeneration++;


  console.log(
    `[DOM] Silent re-baseline: ${reason}`
  );

}


// ============================================================
// RESET WS PROOF
// ============================================================

function resetWebSocketProof() {

  wsFrames =
    [];

  wsRoundEvents =
    [];

  wsEventSequence =
    0;

  currentRoundId =
    null;

  resetRoundState();

}


// ============================================================
// SET MONITOR MODE
// ============================================================

function setMonitorMode(
  next,
  reason = ''
) {

  if (
    monitorMode === next
  ) {

    return;

  }


  monitorMode =
    next;


  resetDomBaseline(
    reason ||
    `mode=${next}`
  );


  gameDomInitialized =
    false;

  gameDomSnapshot =
    {};


  wsSniffActive =
    next === 'GAME';


  if (
    wsSniffActive
  ) {

    resetWebSocketProof();

  }

}


// ============================================================
// REBASELINE TIMER
// ============================================================

let rebaselineTimer =
  null;


function scheduleMonitorRebaseline() {

  clearTimeout(
    rebaselineTimer
  );


  rebaselineTimer =
    setTimeout(
      () => {

        resetDomBaseline(
          'navigation boundary'
        );


        gameDomInitialized =
          false;


        gameDomSnapshot =
          {};

      },
      50
    );

}


// ============================================================
// DOM HEALTH
// ============================================================

async function snapshotDomHealth() {

  if (
    !page ||
    page.isClosed()
  ) {

    return {

      available:
        false,

      groups:
        {},

      url:
        null,

      mode:
        monitorMode,

      mutationVersion:
        pageMutationVersion,

      checkedAt:
        now()

    };

  }


  const groups =
    {};


  for (
    const [
      name,
      selectors
    ] of Object.entries(
      DOM_GROUPS
    )
  ) {

    groups[name] =
      await probe(
        selectors
      );

  }


  const mode =
    modeForPage();


  const url =
    currentUrl();


  const expected =
    expectedDomGroups(
      mode
    );


  const next = {

    available:
      true,

    groups,

    url,

    mode,

    expected:
      [...expected],

    mutationVersion:
      pageMutationVersion,

    checkedAt:
      now(),

    baselineGeneration:
      domBaselineGeneration

  };


  if (
    domInitialized &&
    domPageUrl === url
  ) {

    for (
      const name of expected
    ) {

      const previous =
        domSnapshot[name];


      const previousOk =
        !!(
          previous &&
          previous.visible
        );


      const nextOk =
        !!groups[name]?.visible;


      if (
        previous &&
        previousOk !== nextOk
      ) {

        pushDomEvent(

          nextOk
            ? 'RECOVERED'
            : 'MISSING',

          name,

          nextOk
            ? 'Relevant DOM element is available again.'
            : 'Relevant DOM element is no longer visible.',

          nextOk
            ? groups[name].selector
            : previous.selector ||
              null

        );

      }

    }

  }


  domSnapshot =
    groups;


  domPageUrl =
    url;


  domInitialized =
    true;


  return next;

}


// ============================================================
// MUTATION OBSERVER
// ============================================================

async function installMutationObserver() {

  if (
    !page ||
    page.isClosed()
  ) {

    return;

  }


  try {

    await page.evaluate(
      () => {

        if (
          window.__WTS_DOM_WATCHDOG__
        ) {

          return;

        }


        window.__WTS_DOM_WATCHDOG__ = {

          version:
            0

        };


        const observer =
          new MutationObserver(
            () => {

              window
                .__WTS_DOM_WATCHDOG__
                .version++;

            }
          );


        observer.observe(

          document.documentElement ||
          document,

          {

            subtree:
              true,

            childList:
              true,

            attributes:
              true,

            characterData:
              true

          }

        );

      }
    );

  } catch {}

}


async function syncMutationVersion() {

  if (
    !page ||
    page.isClosed()
  ) {

    return;

  }


  try {

    const version =
      await page.evaluate(
        () =>
          window
            .__WTS_DOM_WATCHDOG__
            ?.version ||
          0
      );


    if (
      version !==
      lastMutationVersion
    ) {

      pageMutationVersion =
        version;

      lastMutationVersion =
        version;

    }

  } catch {}

}


// ============================================================
// GAME DOM
// ============================================================

async function getFrameSummary() {

  if (
    !page ||
    page.isClosed()
  ) {

    return [];

  }


  return page.frames()
    .map(
      (
        frame,
        index
      ) => ({

        index,

        url:
          frame.url(),

        name:
          frame.name() ||
          null,

        main:
          frame ===
          page.mainFrame()

      })
    );

}


async function probeInFrame(
  frame,
  selectors
) {

  for (
    const selector of selectors
  ) {

    try {

      const locator =
        frame
          .locator(selector)
          .first();


      const count =
        await locator.count();


      if (
        count
      ) {

        return {

          found:
            true,

          visible:
            await locator
              .isVisible()
              .catch(
                () => false
              ),

          selector,

          count

        };

      }

    } catch {}

  }


  return {

    found:
      false,

    visible:
      false,

    selector:
      null,

    count:
      0

  };

}


async function probeGameGroup(
  selectors
) {

  for (
    const frame of page?.frames?.() ||
    []
  ) {

    const result =
      await probeInFrame(
        frame,
        selectors
      );


    if (
      result.found
    ) {

      return {

        ...result,

        frameUrl:
          frame.url(),

        frameName:
          frame.name() ||
          null

      };

    }

  }


  return {

    found:
      false,

    visible:
      false,

    selector:
      null,

    count:
      0,

    frameUrl:
      null,

    frameName:
      null

  };

}


// ============================================================
// GAME STATE
// ============================================================

async function snapshotGameState() {

  if (
    !page ||
    page.isClosed() ||
    !selectedGame
  ) {

    gameState = {

      available:
        false,

      primaryValue:
        null,

      primaryLabel:
        null,

      roundText:
        null,

      gridCount:
        null,

      checkedAt:
        now(),

      balance:
        null,

      betControls:
        [],

      roundHistory:
        [],

      wsMultiplier:
        null,

      wsConnected:
        false

    };


    return gameState;

  }


  const game =
    currentGame();


  try {

    const result =
      await page.evaluate(
        key => {

          const text =
            element =>
              (
                element?.textContent ||
                ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();


          const docs =
            [document];


          for (
            const frame of
            Array.from(
              document.querySelectorAll(
                'iframe'
              )
            )
          ) {

            try {

              if (
                frame.contentDocument
              ) {

                docs.push(
                  frame.contentDocument
                );

              }

            } catch {}

          }


          let balance =
            null;


          for (
            const doc of docs
          ) {

            for (
              const selector of [
                '._balance_6umpy_40',
                '.balance-amount'
              ]
            ) {

              try {

                const value =
                  text(
                    doc.querySelector(
                      selector
                    )
                  );


                if (
                  value
                ) {

                  balance =
                    value;

                  break;

                }

              } catch {}

            }

          }


          const betControls =
            [];


          if (
            key === 'aviator'
          ) {

            Array.from(
              document.querySelectorAll(
                '.bet-control'
              )
            )
              .slice(0, 2)
              .forEach(
                (
                  control,
                  index
                ) => {

                  const input =
                    control.querySelector(
                      'input[inputmode="decimal"]'
                    );


                  const tab =
                    control.querySelector(
                      '.navigation-switcher .tab.active'
                    );


                  const betBtn =
                    control.querySelector(
                      '.buttons-block button.bet.btn-success'
                    );


                  const cancelBtn =
                    control.querySelector(
                      '.buttons-block button.bet.btn-danger'
                    );


                  const cashoutBtn =
                    control.querySelector(
                      '.buttons-block button.cashout'
                    );


                  let state =
                    'BET';


                  let active =
                    betBtn;


                  let amount =
                    input?.value ||
                    text(
                      control.querySelector(
                        '.buttons-block .amount'
                      )
                    ) ||
                    '1.00';


                  let buttonText =
                    'Bet';


                  if (
                    cashoutBtn
                  ) {

                    state =
                      'CASHOUT';

                    active =
                      cashoutBtn;

                    amount =
                      text(
                        cashoutBtn.querySelector(
                          '.amount'
                        )
                      ) ||
                      amount;

                    buttonText =
                      'Cash Out';

                  } else if (
                    cancelBtn
                  ) {

                    state =
                      'CANCEL';

                    active =
                      cancelBtn;

                    buttonText =
                      'Cancel';

                  }


                  betControls.push({

                    index:
                      index + 1,

                    label:
                      index === 0
                        ? '2'
                        : '3',

                    state,

                    amount:
                      String(
                        amount
                      )
                        .replace(
                          /\s+/g,
                          ' '
                        )
                        .trim(),

                    buttonText,

                    ready:
                      !!active &&
                      !active.disabled,

                    disabled:
                      !active ||
                      !!active.disabled,

                    tab:
                      text(tab) ||
                      'Bet'

                  });

                }
              );

          }


          const candidates =
            [];


          const selectors =
            key === 'aviator'

              ? [

                  '.payout',

                  '[class*="payout"]',

                  '[class*="Payout"]',

                  '[class*="multiplier"]',

                  '[class*="Multiplier"]'

                ]

              : [

                  '[class*="mine"]',

                  '[id*="mine"]',

                  '[class*="Mine"]',

                  '[id*="Mine"]',

                  '[class*="grid"]',

                  '[class*="Grid"]',

                  '[class*="cell"]',

                  '[class*="Cell"]'

                ];


          for (
            const doc of docs
          ) {

            for (
              const selector of selectors
            ) {

              let nodes =
                [];


              try {

                nodes =
                  Array.from(
                    doc.querySelectorAll(
                      selector
                    )
                  ).slice(
                    0,
                    30
                  );

              } catch {}


              for (
                const node of nodes
              ) {

                const value =
                  text(node);


                if (
                  value
                ) {

                  candidates.push(
                    value
                  );

                }

              }

            }

          }


          const roundHistory =
            [];


          if (
            key === 'aviator'
          ) {

            for (
              const doc of docs
            ) {

              try {

                for (
                  const node of
                  Array.from(
                    doc.querySelectorAll(
                      '.payouts-block .payout, .payout'
                    )
                  ).slice(
                    0,
                    10
                  )
                ) {

                  const value =
                    text(node);


                  if (
                    /^\d+(?:\.\d+)?x$/i
                      .test(value)
                  ) {

                    roundHistory.push(
                      value
                    );

                  }

                }

              } catch {}


              if (
                roundHistory.length >=
                10
              ) {

                break;

              }

            }

          }


          const bodyText =
            text(
              document.body
            );


          if (
            key === 'aviator'
          ) {

            const match =
              candidates
                .join(' ')
                .match(
                  /(?:^|\s)(\d+(?:\.\d+)?x)(?=\s|$)/i
                ) ||
              bodyText.match(
                /(?:^|\s)(\d+(?:\.\d+)?x)(?=\s|$)/i
              );


            return {

              available:
                true,

              primaryValue:
                match
                  ? match[1]
                  : null,

              primaryLabel:
                match
                  ? 'MULTIPLIER'
                  : 'MULTIPLIER WAITING',

              roundText:
                candidates
                  .slice(
                    0,
                    3
                  )
                  .join(
                    ' • '
                  ) ||
                'Waiting for multiplier data…',

              gridCount:
                null,

              balance,

              betControls,

              roundHistory

            };

          }


          let gridCount =
            0;


          for (
            const doc of docs
          ) {

            try {

              gridCount +=
                doc.querySelectorAll(
                  '[class*="cell"],[class*="Cell"],[data-test-id*="cell"],[data-testid*="cell"]'
                ).length;

            } catch {}

          }


          return {

            available:
              true,

            primaryValue:
              gridCount
                ? String(gridCount)
                : null,

            primaryLabel:
              gridCount
                ? 'GRID CELLS DETECTED'
                : 'GAME STATE',

            roundText:
              candidates
                .slice(
                  0,
                  4
                )
                .join(
                  ' • '
                ) ||
              'Waiting for mine/grid data…',

            gridCount,

            balance,

            betControls

          };

        },

        selectedGame
      );


    const wsValue =
      liveRoundState.liveMultiplier ||
      null;


    if (
      selectedGame === 'aviator' &&
      wsValue &&
      !result.primaryValue
    ) {

      result.primaryValue =
        wsValue;

      result.primaryLabel =
        'MULTIPLIER (WEBSOCKET)';

      result.roundText =
        `LIVE • ${wsValue}`;

    }


    gameState = {

      ...result,

      gameName:
        game?.name ||
        null,

      checkedAt:
        now(),

      wsMultiplier:
        wsValue,

      wsConnected:
        !!gameState.wsConnected

    };

  } catch {

    gameState = {

      available:
        false,

      primaryValue:
        null,

      primaryLabel:
        null,

      roundText:
        null,

      gridCount:
        null,

      checkedAt:
        now(),

      balance:
        null,

      betControls:
        [],

      roundHistory:
        [],

      wsMultiplier:
        null,

      wsConnected:
        false

    };

  }


  return gameState;

}


// ============================================================
// GAME DOM HEALTH
// ============================================================

async function snapshotGameDomHealth() {

  if (
    !page ||
    page.isClosed() ||
    !selectedGame
  ) {

    gameDomState = {

      available:
        false,

      game:
        selectedGame,

      url:
        currentUrl(),

      title:
        null,

      frames:
        [],

      groups:
        {},

      checkedAt:
        now(),

      mutationVersion:
        pageMutationVersion

    };


    return gameDomState;

  }


  const game =
    currentGame();


  const groups =
    {};


  for (
    const [
      name,
      selectors
    ] of Object.entries(
      GAME_DOM_GROUPS
    )
  ) {

    groups[name] =
      await probeGameGroup(
        selectors
      );

  }


  const frames =
    await getFrameSummary();


  const title =
    await page
      .title()
      .catch(
        () => ''
      );


  const url =
    currentUrl();


  gameDomState = {

    available:
      true,

    game:
      selectedGame,

    gameName:
      game?.name ||
      null,

    url,

    title,

    frames,

    groups,

    checkedAt:
      now(),

    mutationVersion:
      pageMutationVersion

  };


  gameDomSnapshot =
    groups;


  gameDomInitialized =
    true;


  await snapshotGameState();


  return gameDomState;

}


// ============================================================
// WATCHDOG
// ============================================================

function startDomWatchdog() {

  if (
    domWatchdogTimer
  ) {

    return;

  }


  domWatchdogTimer =
    setInterval(
      () => {

        void (
          async () => {

            await syncMutationVersion();


            const mode =
              modeForPage();


            if (
              mode !== monitorMode
            ) {

              setMonitorMode(
                mode,
                `automatic transition to ${mode}`
              );

            }


            await snapshotDomHealth();


            if (
              monitorMode === 'GAME'
            ) {

              await snapshotGameDomHealth();

            }

          }
        )()
          .catch(
            () => {}
          );

      },
      WATCHDOG_MS
    );

}


// ============================================================
// AUTH
// ============================================================

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


  const url =
    dom.url;


  const authenticatedNow =
    indicatorVisible &&
    !loginFormVisible &&
    !isLoginUrl(url);


  const proof =
    authenticatedNow

      ? (
          profileVisible &&
          balanceVisible
            ? 'PROFILE_AND_BALANCE'
            : profileVisible
              ? 'PROFILE'
              : 'BALANCE'
        )

      : null;


  return {

    authenticated:
      authenticatedNow,

    loginFormVisible,

    profile:
      profileVisible,

    balance:
      balanceVisible,

    indicatorVisible,

    url,

    dom,

    proof

  };

}


async function verifyAuthenticatedSession(
  stableChecks =
    STABLE_AUTH_CHECKS
) {

  let positive =
    0;

  let last =
    null;


  for (
    let i = 0;
    i < stableChecks;
    i++
  ) {

    last =
      await authSnapshot();


    if (
      last.authenticated
    ) {

      positive++;

    } else {

      positive =
        0;

    }


    if (
      positive >=
      stableChecks
    ) {

      authenticated =
        true;

      lastAuthProof =
        last.proof;


      setMonitorMode(

        selectedGame
          ? 'GAME'
          : 'AUTH',

        'authenticated session verified'

      );


      connectorState =
        selectedGame
          ? 'GAME_CONNECTED'
          : 'AUTHENTICATED';


      return last;

    }


    await sleep(
      120
    );

  }


  return (
    last ||
    {
      authenticated:
        false
    }
  );

}


// ============================================================
// LOGIN ERROR
// ============================================================

function credentialErrorTextMatches(
  text
) {

  const value =
    String(
      text || ''
    ).toLowerCase();


  if (
    !value
  ) {

    return false;

  }


  return [

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

  ].some(
    phrase =>
      value.includes(
        phrase
      )
  );

}


async function detectCredentialError() {

  const text =
    await textFor(
      SELECTORS.loginError
    );


  return credentialErrorTextMatches(
    text
  )
    ? text
    : '';

}


// ============================================================
// LOGIN FORM
// ============================================================

async function waitForLoginForm(
  timeout = 10000
) {

  const start =
    Date.now();


  while (
    Date.now() - start <
    timeout
  ) {

    const auth =
      await authSnapshot();


    if (
      auth.authenticated
    ) {

      return {

        authenticated:
          true,

        ...auth

      };

    }


    if (
      auth.dom.groups.AUTH_PHONE?.visible &&
      auth.dom.groups.AUTH_PASSWORD?.visible &&
      auth.dom.groups.AUTH_LOGIN_BUTTON?.visible
    ) {

      return {

        authenticated:
          false,

        formReady:
          true,

        phoneSelector:
          auth.dom.groups.AUTH_PHONE.selector,

        passwordSelector:
          auth.dom.groups.AUTH_PASSWORD.selector,

        buttonSelector:
          auth.dom.groups.AUTH_LOGIN_BUTTON.selector,

        ...auth

      };

    }


    await sleep(
      100
    );

  }


  const auth =
    await authSnapshot();


  return {

    authenticated:
      auth.authenticated,

    formReady:
      !!(
        auth.dom.groups.AUTH_PHONE?.visible &&
        auth.dom.groups.AUTH_PASSWORD?.visible &&
        auth.dom.groups.AUTH_LOGIN_BUTTON?.visible
      ),

    phoneSelector:
      auth.dom.groups.AUTH_PHONE?.selector,

    passwordSelector:
      auth.dom.groups.AUTH_PASSWORD?.selector,

    buttonSelector:
      auth.dom.groups.AUTH_LOGIN_BUTTON?.selector,

    ...auth

  };

}


// ============================================================
// OPEN LOGIN
// ============================================================

async function openLoginPage() {

  await ensurePage();


  const existing =
    await verifyAuthenticatedSession(
      2
    ).catch(
      () => ({
        authenticated:
          false
      })
    );


  if (
    existing.authenticated
  ) {

    startupReady =
      true;


    return {

      alreadyAuthenticated:
        true,

      ...existing

    };

  }


  if (
    !isLoginUrl(
      currentUrl() ||
      ''
    )
  ) {

    await safeGoto(
      LOGIN_URL,
      {
        waitUntil:
          'commit',

        timeout:
          Math.max(
            OPEN_GAME_TIMEOUT,
            10000
          )
      }
    );

  }


  authenticated =
    false;


  selectedGame =
    null;


  connectorState =
    'IDLE';


  lastAuthProof =
    null;


  setMonitorMode(
    'LOGIN',
    'login page ready'
  );


  await sleep(
    500
  );


  await installMutationObserver();


  resetDomBaseline(
    'login page baseline'
  );


  await syncMutationVersion();


  await snapshotDomHealth();


  if (
    !domWatchdogTimer
  ) {

    startDomWatchdog();

  }


  startupReady =
    true;


  return waitForLoginForm(
    10000
  );

}


// ============================================================
// WAIT AUTH
// ============================================================

async function waitForAuthenticationAfterSubmit(
  rid,
  baseline,
  timeout = AUTH_TIMEOUT
) {

  const start =
    Date.now();


  let positive =
    0;


  while (
    Date.now() - start <
    timeout
  ) {

    const auth =
      await authSnapshot();


    const loginError =
      await detectCredentialError();


    const transitionSeen =
      !auth.loginFormVisible &&
      auth.indicatorVisible &&
      !isLoginUrl(
        auth.url
      );


    if (
      transitionSeen
    ) {

      positive++;

    } else {

      positive =
        0;

    }


    if (
      positive >=
      STABLE_AUTH_CHECKS
    ) {

      authenticated =
        true;


      authGeneration++;


      lastAuthProof =
        auth.proof;


      setMonitorMode(
        'AUTH',
        'post-login authentication verified'
      );


      connectorState =
        'AUTHENTICATED';


      updateRequest(
        rid,
        {

          status:
            'AUTHENTICATED',

          message:
            'Connected.',

          authenticated:
            true,

          proof:
            auth.proof

        }
      );


      return {

        success:
          true,

        authenticated:
          true,

        proof:
          auth.proof

      };

    }


    if (
      auth.loginFormVisible &&
      loginError
    ) {

      updateRequest(
        rid,
        {

          status:
            'LOGIN_FAILED',

          message:
            loginError,

          authenticated:
            false,

          reason:
            'INVALID_CREDENTIALS'

        }
      );


      connectorState =
        'LOGIN_FAILED';


      setMonitorMode(
        'LOGIN',
        'login failed; form remains active'
      );


      return {

        success:
          false,

        authenticated:
          false,

        reason:
          'INVALID_CREDENTIALS',

        message:
          loginError

      };

    }


    updateRequest(
      rid,
      {

        status:
          'AUTHENTICATING',

        message:
          'Authenticating...',

        authenticated:
          false

      }
    );


    await sleep(
      100
    );

  }


  updateRequest(
    rid,
    {

      status:
        'LOGIN_FAILED',

      message:
        'Login could not be verified within the allowed time.',

      authenticated:
        false,

      reason:
        'AUTH_TIMEOUT'

    }
  );


  connectorState =
    'LOGIN_FAILED';


  return {

    success:
      false,

    authenticated:
      false,

    reason:
      'AUTH_TIMEOUT'

  };

}


// ============================================================
// LOGIN
// ============================================================

async function performLogin({
  phone,
  password,
  requestId: rid
}) {

  const form =
    await openLoginPage();


  if (
    form.authenticated
  ) {

    authenticated =
      true;


    updateRequest(
      rid,
      {

        status:
          'AUTHENTICATED',

        message:
          'Connected.',

        authenticated:
          true,

        proof:
          form.proof

      }
    );


    return {

      success:
        true,

      authenticated:
        true

    };

  }


  const ready =
    await waitForLoginForm(
      10000
    );


  if (
    !ready.formReady
  ) {

    updateRequest(
      rid,
      {

        status:
          'LOGIN_FAILED',

        message:
          'Login form is not ready.',

        authenticated:
          false,

        reason:
          'LOGIN_FORM_NOT_READY'

      }
    );


    connectorState =
      'LOGIN_FAILED';


    return {

      success:
        false,

      authenticated:
        false,

      reason:
        'LOGIN_FORM_NOT_READY'

    };

  }


  const baseline =
    await authSnapshot();


  setMonitorMode(
    'LOGIN',
    'before submit'
  );


  try {

    const phoneLoc =
      page
        .locator(
          ready.phoneSelector
        )
        .first();


    const passwordLoc =
      page
        .locator(
          ready.passwordSelector
        )
        .first();


    const buttonLoc =
      page
        .locator(
          ready.buttonSelector
        )
        .first();


    await phoneLoc.fill(
      phone
    );


    await passwordLoc.fill(
      password
    );


    await sleep(
      40
    );


    if (
      !await phoneLoc
        .isVisible()
        .catch(
          () => false
        ) ||
      !await passwordLoc
        .isVisible()
        .catch(
          () => false
        )
    ) {

      throw new Error(
        'Login form changed before submit.'
      );

    }


    await buttonLoc.click();

  } catch {

    const after =
      await authSnapshot()
        .catch(
          () => ({
            authenticated:
              false
          })
        );


    if (
      after.authenticated
    ) {

      authenticated =
        true;


      authGeneration++;


      lastAuthProof =
        after.proof;


      setMonitorMode(
        'AUTH',
        'authentication verified after interaction error'
      );


      connectorState =
        'AUTHENTICATED';


      updateRequest(
        rid,
        {

          status:
            'AUTHENTICATED',

          message:
            'Connected.',

          authenticated:
            true,

          proof:
            after.proof

        }
      );


      return {

        success:
          true,

        authenticated:
          true

      };

    }


    updateRequest(
      rid,
      {

        status:
          'LOGIN_FAILED',

        message:
          'Login interaction failed. Please try again.',

        authenticated:
          false,

        reason:
          'LOGIN_INTERACTION_ERROR'

      }
    );


    connectorState =
      'LOGIN_FAILED';


    return {

      success:
        false,

      authenticated:
        false,

      reason:
        'LOGIN_INTERACTION_ERROR'

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


// ============================================================
// VERIFY BEFORE GAME
// ============================================================

async function verifyBeforeGame() {

  let auth =
    await verifyAuthenticatedSession(
      2
    );


  if (
    auth.authenticated
  ) {

    return auth;

  }


  const url =
    currentUrl();


  if (
    url &&
    !isLoginUrl(url)
  ) {

    await safeGoto(
      HOME_URL,
      {
        waitUntil:
          'commit',

        timeout:
          OPEN_GAME_TIMEOUT
      }
    );


    await installMutationObserver();


    resetDomBaseline(
      're-checking authentication on home'
    );


    setMonitorMode(
      'AUTH',
      'server-side game gate recheck'
    );


    auth =
      await verifyAuthenticatedSession(
        2
      );

  }


  return auth;

}


// ============================================================
// CONNECT GAME
// ============================================================

async function connectGame(
  key
) {

  const game =
    getGame(key);


  if (
    !game
  ) {

    return {

      success:
        false,

      message:
        'Choose exactly one valid game.'

    };

  }


  const auth =
    await verifyBeforeGame();


  if (
    !auth.authenticated
  ) {

    authenticated =
      false;


    selectedGame =
      null;


    connectorState =
      'SESSION_LOST';


    setMonitorMode(
      'LOGIN',
      'game gate blocked; authentication not verified'
    );


    return {

      success:
        false,

      code:
        'AUTH_REQUIRED',

      message:
        'BetPawa authentication could not be verified. Game navigation was blocked.'

    };

  }


  console.log(
    `[GAME] Opening ${game.name} (${game.id})...`
  );


  connectorState =
    'CONNECTING_GAME';


  selectedGame =
    key;


  lastGameUrl =
    game.url;


  setMonitorMode(
    'GAME',
    `opening ${game.name}`
  );


  gameDomEvents =
    [];


  gameDomInitialized =
    false;


  gameDomSnapshot =
    {};


  const navigation =
    await safeGoto(
      game.url,
      {
        waitUntil:
          'commit',

        timeout:
          Math.max(
            OPEN_GAME_TIMEOUT,
            10000
          )
      }
    );


  await sleep(
    450
  );


  await installMutationObserver();


  resetDomBaseline(
    `game ${game.name} navigation`
  );


  await syncMutationVersion();


  await snapshotDomHealth();


  await snapshotGameDomHealth();


  const landedUrl =
    currentUrl() ||
    '';


  const routeReached =
    landedUrl.includes(
      `/casino/game/${game.id}`
    );


  if (
    !routeReached
  ) {

    connectorState =
      'GAME_CONNECTION_FAILED';


    return {

      success:
        false,

      code:
        'GAME_NAVIGATION_FAILED',

      message:
        `Could not reach ${game.name}.`,

      navigation,

      currentUrl:
        landedUrl

    };

  }


  connectorState =
    'GAME_CONNECTED';


  console.log(
    `[GAME] ${game.name} opened`
  );


  return {

    success:
      true,

    game: {

      key,

      id:
        game.id,

      name:
        game.name

    },

    url:
      game.url,

    authGeneration,

    proof:
      lastAuthProof,

    gameDom:
      gameDomState,

    gameState

  };

}


// ============================================================
// CLEAR SENSITIVE LOGIN DATA
// ============================================================

function clearSensitiveLoginRequestData(
  rid
) {

  const request =
    loginRequests.get(
      rid
    );


  if (
    !request
  ) {

    return;

  }


  delete request.phone;

  delete request.password;

}


// ============================================================
// EXPRESS
// ============================================================

app.use(
  express.json({
    limit:
      '64kb'
  })
);


app.use(
  express.urlencoded({
    extended:
      false,

    limit:
      '64kb'
  })
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      ok:
        true,

      service:
        'WTS BetPawa Local Connector PRO ELITE',

      time:
        now()

    });

  }
);


// ============================================================
// SSE
// ============================================================

app.get(
  '/api/events',
  (req, res) => {

    res.setHeader(
      'Content-Type',
      'text/event-stream'
    );


    res.setHeader(
      'Cache-Control',
      'no-cache, no-transform'
    );


    res.setHeader(
      'Connection',
      'keep-alive'
    );


    res.flushHeaders?.();


    const hello = {

      seq:
        eventSequence,

      id:
        `hello-${Date.now()}`,

      time:
        now(),

      type:
        'STREAM_CONNECTED',

      message:
        'Real-time event stream connected.',

      source:
        'event-engine',

      game:
        selectedGame

    };


    res.write(
      `data: ${JSON.stringify(hello)}\n\n`
    );


    eventClients.add(
      res
    );


    const heartbeat =
      setInterval(
        () => {

          try {

            res.write(
              `: heartbeat ${Date.now()}\n\n`
            );

          } catch {}

        },
        15000
      );


    req.on(
      'close',
      () => {

        clearInterval(
          heartbeat
        );

        eventClients.delete(
          res
        );

      }
    );

  }
);


// ============================================================
// STATUS
// ============================================================

app.get(
  '/api/status',
  async (req, res) => {

    let auth = {

      authenticated:
        false,

      profile:
        false,

      balance:
        false,

      loginFormVisible:
        false,

      url:
        currentUrl(),

      proof:
        null

    };


    try {

      auth =
        await authSnapshot();

    } catch {}


    const dom =
      await snapshotDomHealth()
        .catch(
          () => ({
            available:
              false,

            groups:
              {},

            url:
              currentUrl(),

            mode:
              monitorMode

          })
        );


    const gameDom =
      monitorMode === 'GAME'

        ? await snapshotGameDomHealth()
            .catch(
              () =>
                gameDomState
            )

        : gameDomState;


    res.json({

      ok:
        true,

      state:
        connectorState,

      authenticated:
        auth.authenticated,

      authenticationVerification: {

        profile:
          auth.profile,

        balance:
          auth.balance,

        loginFormVisible:
          auth.loginFormVisible,

        proof:
          auth.proof ||
          lastAuthProof ||
          null,

        generation:
          authGeneration

      },

      selectedGame,

      selectedGameName:
        currentGame()?.name ||
        null,

      currentUrl:
        currentUrl(),

      lastGameUrl,

      loginRunning,

      currentLoginRequestId,

      monitorMode,

      domHealth:
        dom,

      domEvents:
        domEvents.slice(
          0,
          15
        ),

      gameDomHealth:
        gameDom,

      gameState,

      gameDomEvents:
        gameDomEvents.slice(
          0,
          15
        ),

      liveRoundState,

      wsRoundEvents:
        wsRoundEvents.slice(
          0,
          100
        ),

      mutationVersion:
        pageMutationVersion,

      startupReady

    });

  }
);


// ============================================================
// WEBSOCKET API
//
// Only useful Aviator frames are returned.
// ============================================================

app.get(
  '/api/ws-sniff',
  (req, res) => {

    const lastUsefulFrame =
      wsFrames.find(
        frame =>
          frame.fields &&
          (
            frame.fields.crashX?.length ||
            frame.fields.maxMultiplier?.length ||
            frame.fields.x?.length ||
            frame.fields.roundId?.length
          )
      ) || null;


    res.json({

      ok:
        true,

      active:
        wsSniffActive,

      mode:
        monitorMode,

      selectedGame,

      socket:
        gameState.wsConnected,

      count:
        wsFrames.length,

      eventCount:
        wsRoundEvents.length,

      liveRoundState,

      roundEvents:
        wsRoundEvents.slice(
          0,
          100
        ),

      lastFrame:
        wsFrames[0] ||
        null,

      lastUsefulFrame

    });

  }
);


// ============================================================
// CLEAR WEBSOCKET PROOF
// ============================================================

app.post(
  '/api/ws-sniff/clear',
  (req, res) => {

    resetWebSocketProof();


    res.json({

      ok:
        true,

      count:
        0,

      eventCount:
        0

    });

  }
);


// ============================================================
// WEBSOCKET EVENTS
// ============================================================

app.get(
  '/api/ws-sniff/events',
  (req, res) => {

    res.json({

      ok:
        true,

      active:
        wsSniffActive,

      liveRoundState,

      events:
        wsRoundEvents.slice(
          0,
          100
        )

    });

  }
);


// ============================================================
// GAME DOM API
// ============================================================

app.get(
  '/api/game-dom',
  async (req, res) => {

    if (
      !selectedGame
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'No game is connected.'

        });

    }


    const gameDom =
      await snapshotGameDomHealth();


    res.json({

      ok:
        true,

      gameDom,

      events:
        gameDomEvents.slice(
          0,
          20
        )

    });

  }
);


// ============================================================
// START LOGIN
// ============================================================

app.post(
  '/api/start-login',
  async (req, res) => {

    if (
      loginRunning
    ) {

      return res
        .status(409)
        .json({

          ok:
            false,

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
        req.body?.password ||
        ''
      );


    if (
      !/^\d{9}$/.test(
        phone
      )
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

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

          ok:
            false,

          message:
            'Password must contain at least 4 characters.'

        });

    }


    await ensurePage();


    const existing =
      await verifyAuthenticatedSession(
        2
      ).catch(
        () => ({
          authenticated:
            false
        })
      );


    if (
      existing.authenticated
    ) {

      authenticated =
        true;


      connectorState =
        selectedGame
          ? 'GAME_CONNECTED'
          : 'AUTHENTICATED';


      setMonitorMode(
        selectedGame
          ? 'GAME'
          : 'AUTH',

        'existing authenticated session'
      );


      return res.json({

        ok:
          true,

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

        id:
          rid,

        status:
          'AUTHENTICATING',

        message:
          'Authenticating...',

        authenticated:
          false,

        createdAt:
          Date.now(),

        updatedAt:
          Date.now()

      }
    );


    currentLoginRequestId =
      rid;


    loginRunning =
      true;


    connectorState =
      'AUTHENTICATING';


    authenticated =
      false;


    setMonitorMode(
      'LOGIN',
      'login attempt started'
    );


    void performLogin({

      phone,

      password,

      requestId:
        rid

    })
      .catch(
        () => {

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

        }
      )
      .finally(
        () => {

          loginRunning =
            false;


          clearSensitiveLoginRequestData(
            rid
          );

        }
      );


    return res.json({

      ok:
        true,

      requestId:
        rid,

      status:
        'AUTHENTICATING',

      message:
        'Authenticating...'

    });

  }
);


// ============================================================
// WAIT LOGIN
// ============================================================

app.get(
  '/api/wait-login',
  async (req, res) => {

    const rid =
      String(
        req.query.requestId ||
        ''
      );


    const request =
      loginRequests.get(
        rid
      );


    if (
      !rid ||
      !request
    ) {

      return res
        .status(404)
        .json({

          ok:
            false,

          message:
            'Login request not found.'

        });

    }


    const auth =
      await authSnapshot()
        .catch(
          () => ({
            authenticated:
              false,

            profile:
              false,

            balance:
              false,

            proof:
              null

          })
        );


    res.json({

      ok:
        true,

      requestId:
        rid,

      status:
        request.status,

      message:
        request.message,

      authenticated:
        request.status ===
          'AUTHENTICATED' &&
        auth.authenticated,

      profile:
        !!auth.profile,

      balance:
        !!auth.balance,

      proof:
        request.status ===
          'AUTHENTICATED'
          ? (
              request.proof ||
              auth.proof ||
              lastAuthProof
            )
          : null,

      authGeneration,

      domHealth:
        await snapshotDomHealth()
          .catch(
            () => null
          )

    });

  }
);


// ============================================================
// CONNECT GAME API
// ============================================================

app.post(
  '/api/connect-game',
  async (req, res) => {

    const key =
      String(
        req.body?.game ||
        ''
      );


    if (
      !getGame(key)
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Choose exactly one valid game.'

        });

    }


    try {

      const result =
        await connectGame(
          key
        );


      if (
        !result.success
      ) {

        return res
          .status(401)
          .json({

            ok:
              false,

            ...result

          });

      }


      return res.json({

        ok:
          true,

        ...result

      });

    } catch (error) {

      connectorState =
        'ERROR';


      console.log(
        '[GAME] Open error:',
        error.message
      );


      return res
        .status(500)
        .json({

          ok:
            false,

          message:
            'Could not open the selected game.'

        });

    }

  }
);


// ============================================================
// MANUAL BET
// ============================================================

app.post(
  '/api/manual-bet',
  async (req, res) => {

    const slot =
      Number(
        req.body?.slot
      );


    if (
      ![1, 2].includes(
        slot
      )
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Choose bet control 1 or 2.'

        });

    }


    if (
      selectedGame !== 'aviator'
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Manual bet controls are available for Aviator only.'

        });

    }


    try {

      const auth =
        await verifyAuthenticatedSession(
          2
        );


      if (
        !auth.authenticated
      ) {

        authenticated =
          false;


        connectorState =
          'SESSION_LOST';


        return res
          .status(401)
          .json({

            ok:
              false,

            code:
              'AUTH_REQUIRED',

            message:
              'Authentication could not be verified.'

          });

      }


      const controls =
        await page
          .locator(
            '.bet-control'
          )
          .all();


      if (
        !controls[slot - 1]
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            message:
              `Bet control ${slot} was not found.`

          });

      }


      const control =
        controls[slot - 1];


      const betBtn =
        control
          .locator(
            '.buttons-block button.bet.btn-success'
          )
          .first();


      const cancelBtn =
        control
          .locator(
            '.buttons-block button.bet.btn-danger'
          )
          .first();


      const cashoutBtn =
        control
          .locator(
            '.buttons-block button.cashout'
          )
          .first();


      let action =
        null;


      let button =
        null;


      if (
        await cashoutBtn.count()
      ) {

        action =
          'CASHOUT';

        button =
          cashoutBtn;

      } else if (
        await cancelBtn.count()
      ) {

        action =
          'CANCEL';

        button =
          cancelBtn;

      } else if (
        await betBtn.count()
      ) {

        action =
          'BET';

        button =
          betBtn;

      }


      if (
        !button
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            message:
              `No active action button was found for control ${slot}.`

          });

      }


      if (
        !await button
          .isVisible()
          .catch(
            () => false
          ) ||
        !await button
          .isEnabled()
          .catch(
            () => false
          )
      ) {

        return res
          .status(409)
          .json({

            ok:
              false,

            message:
              `The ${action.toLowerCase()} action for control ${slot} is not ready.`

          });

      }


      const amount =
        action === 'CASHOUT'

          ? await button
              .locator(
                '.amount'
              )
              .first()
              .innerText()
              .catch(
                () => ''
              )

          : await control
              .locator(
                'input[inputmode="decimal"]'
              )
              .first()
              .inputValue()
              .catch(
                async () =>
                  await control
                    .locator(
                      '.buttons-block .amount'
                    )
                    .first()
                    .innerText()
                    .catch(
                      () =>
                        '1.00'
                    )
              );


      await button.click();


      pushStateEvent(

        'MANUAL_BET_CLICK',

        `Manual ${action} on control ${slot === 1 ? '2' : '3'} clicked.`,

        {
          slot,

          action,

          amount

        }

      );


      await snapshotGameState();


      return res.json({

        ok:
          true,

        slot,

        action,

        label:
          slot === 1
            ? '2'
            : '3',

        amount,

        message:
          `Manual ${action} clicked by user.`

      });

    } catch {

      return res
        .status(500)
        .json({

          ok:
            false,

          message:
            'Manual action click could not be completed.'

        });

    }

  }
);


// ============================================================
// SET BET AMOUNT
// ============================================================

app.post(
  '/api/set-bet-amount',
  async (req, res) => {

    const slot =
      Number(
        req.body?.slot
      );


    const amount =
      String(
        req.body?.amount ??
        ''
      ).trim();


    if (
      ![1, 2].includes(
        slot
      )
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Choose bet control 1 or 2.'

        });

    }


    if (
      !/^(?:\d+)(?:\.\d{1,2})?$/
        .test(amount)
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Invalid amount.'

        });

    }


    const number =
      Number(amount);


    if (
      !Number.isFinite(number) ||
      number < 1 ||
      number > 1000000
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Amount must be between 1 and 1,000,000 TZS.'

        });

    }


    if (
      selectedGame !== 'aviator'
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Aviator only.'

        });

    }


    try {

      const auth =
        await verifyAuthenticatedSession(
          2
        );


      if (
        !auth.authenticated
      ) {

        return res
          .status(401)
          .json({

            ok:
              false,

            message:
              'Authentication could not be verified.'

          });

      }


      const controls =
        await page
          .locator(
            '.bet-control'
          )
          .all();


      const control =
        controls[slot - 1];


      if (
        !control
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            message:
              `Bet control ${slot} not found.`

          });

      }


      const input =
        control
          .locator(
            'input[inputmode="decimal"]'
          )
          .first();


      if (
        !await input.count()
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            message:
              'Amount input not found.'

          });

      }


      await input.fill(
        number.toFixed(2)
      );


      await input.dispatchEvent(
        'change'
      );


      await input.dispatchEvent(
        'blur'
      );


      await snapshotGameState();


      return res.json({

        ok:
          true,

        slot,

        amount:
          number.toFixed(2)

      });

    } catch {

      return res
        .status(500)
        .json({

          ok:
            false,

          message:
            'Could not set bet amount.'

        });

    }

  }
);


// ============================================================
// REFRESH GAME
// ============================================================

app.post(
  '/api/refresh-game',
  async (req, res) => {

    try {

      const auth =
        await verifyAuthenticatedSession(
          2
        );


      if (
        !auth.authenticated
      ) {

        return res
          .status(401)
          .json({

            ok:
              false,

            message:
              'Authentication could not be verified.'

          });

      }


      await snapshotGameDomHealth();

      await snapshotGameState();


      return res.json({

        ok:
          true,

        state:
          gameState,

        dom:
          gameDomState

      });

    } catch {

      return res
        .status(500)
        .json({

          ok:
            false,

          message:
            'Game refresh failed.'

        });

    }

  }
);


// ============================================================
// GAME MENU
// ============================================================

app.post(
  '/api/game-menu',
  async (req, res) => {

    const action =
      String(
        req.body?.action ||
        ''
      );


    if (
      ![
        'history',
        'howto',
        'music'
      ].includes(
        action
      )
    ) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            'Unknown menu action.'

        });

    }


    try {

      const auth =
        await verifyAuthenticatedSession(
          2
        );


      if (
        !auth.authenticated
      ) {

        return res
          .status(401)
          .json({

            ok:
              false,

            message:
              'Authentication could not be verified.'

          });

      }


      if (
        action === 'history'
      ) {

        const item =
          page
            .getByText(
              'My bet history',
              {
                exact:
                  true
              }
            )
            .first();


        if (
          await item.count()
        ) {

          await item.click();


          return res.json({

            ok:
              true,

            action,

            message:
              'My bet history opened in the connected game.'

          });

        }


        return res
          .status(404)
          .json({

            ok:
              false,

            message:
              'My bet history menu item was not found.'

          });

      }


      if (
        action === 'music'
      ) {

        const item =
          page
            .getByText(
              'Music',
              {
                exact:
                  true
              }
            )
            .first();


        if (
          await item.count()
        ) {

          await item.click();


          return res.json({

            ok:
              true,

            action,

            message:
              'Music control toggled in the connected game.'

          });

        }


        return res
          .status(404)
          .json({

            ok:
              false,

            message:
              'Music menu item was not found.'

          });

      }


      return res.json({

        ok:
          true,

        action,

        message:
          'How to Use: choose an amount, place Bet manually, then use Cash Out manually while the round is active.'

      });

    } catch {

      return res
        .status(500)
        .json({

          ok:
            false,

          message:
            'Menu action failed.'

        });

    }

  }
);


// ============================================================
// RESET
// ============================================================

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


    gameDomEvents =
      [];


    eventSequence =
      0;


    wsSniffActive =
      false;


    resetWebSocketProof();


    gameDomState = {

      available:
        false,

      game:
        null,

      url:
        null,

      title:
        null,

      frames:
        [],

      groups:
        {},

      checkedAt:
        null,

      mutationVersion:
        0

    };


    gameState = {

      available:
        false,

      primaryValue:
        null,

      primaryLabel:
        null,

      roundText:
        null,

      gridCount:
        null,

      checkedAt:
        null,

      balance:
        null,

      betControls:
        [],

      roundHistory:
        [],

      wsMultiplier:
        null,

      wsConnected:
        false

    };


    try {

      await ensurePage();


      await safeGoto(
        LOGIN_URL,
        {
          waitUntil:
            'commit',

          timeout:
            OPEN_GAME_TIMEOUT
        }
      );


      await installMutationObserver();


      setMonitorMode(
        'LOGIN',
        'manual reset'
      );


      resetDomBaseline(
        'manual reset baseline'
      );


      await syncMutationVersion();


      await snapshotDomHealth();


      if (
        !domWatchdogTimer
      ) {

        startDomWatchdog();

      }

    } catch {}


    res.json({

      ok:
        true,

      state:
        connectorState

    });

  }
);


// ============================================================
// CRASH X PROOF UI
// ============================================================

app.get(
  '/ws-sniff.html',
  (req, res) => {

    res.type('html')
      .send(`<!doctype html>

<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
WTS AVIATOR CRASH X PROOF
</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  background:
    #070b0c;

  color:
    #e6efeb;

  font-family:
    Consolas,
    "Courier New",
    monospace;

  padding:
    18px;

}

.wrap {

  max-width:
    1100px;

  margin:
    auto;

}

h1 {

  color:
    #b7ff28;

  font-size:
    20px;

  margin:
    0 0 5px;

}

.sub {

  color:
    #84908b;

  font-size:
    12px;

  margin-bottom:
    14px;

}

.grid {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    8px;

}

.card {

  background:
    #101617;

  border:
    1px solid #29332f;

  border-radius:
    10px;

  padding:
    12px;

}

.label {

  font-size:
    10px;

  color:
    #78847f;

}

.value {

  font-size:
    20px;

  font-weight:
    700;

  margin-top:
    6px;

}

.green {

  color:
    #b7ff28;

}

.red {

  color:
    #ff6262;

}

.yellow {

  color:
    #ffd45c;

}

.blue {

  color:
    #55aaff;

}

.section {

  margin-top:
    14px;

}

.section h2 {

  font-size:
    13px;

  color:
    #b7ff28;

  margin:
    0 0 8px;

}

.event {

  background:
    #0d1213;

  border:
    1px solid #29332f;

  border-radius:
    9px;

  padding:
    10px;

  margin:
    7px 0;

}

.event.start {

  border-left:
    4px solid #b7ff28;

}

.event.crash {

  border-left:
    4px solid #ff4f5e;

}

.event.confirm {

  border-left:
    4px solid #ffd45c;

}

.event.live {

  border-left:
    4px solid #55aaff;

}

.meta {

  font-size:
    10px;

  color:
    #73807a;

}

.msg {

  font-size:
    13px;

  margin-top:
    5px;

}

.proof {

  font-size:
    11px;

  color:
    #aab5b0;

  margin-top:
    6px;

}

.toolbar {

  margin:
    12px 0;

}

button {

  border:
    0;

  border-radius:
    7px;

  padding:
    8px 12px;

  margin-right:
    6px;

  font-weight:
    700;

  cursor:
    pointer;

}

.clear {

  background:
    #ff5866;

  color:
    white;

}

.refresh {

  background:
    #b7ff28;

  color:
    #071006;

}

.debug {

  background:
    #55aaff;

  color:
    #06101a;

}

pre {

  background:
    #0b1011;

  border:
    1px solid #26312d;

  border-radius:
    8px;

  padding:
    10px;

  white-space:
    pre-wrap;

  word-break:
    break-all;

  font-size:
    11px;

  line-height:
    1.4;

}

.muted {

  color:
    #7d8984;

}

@media(max-width:700px) {

  .grid {

    grid-template-columns:
      repeat(2,1fr);

  }

}

</style>

</head>

<body>

<div class="wrap">

<h1>
WTS AVIATOR — CRASH X PROOF
</h1>

<div class="sub">
SERVER-REPORTED DATA ONLY — NO PREDICTION
</div>

<div
  id="status"
  class="sub"
>
Waiting for Aviator WebSocket...
</div>


<div class="grid">


<div class="card">

<div class="label">
ROUND ID
</div>

<div
  id="round"
  class="value"
>
—
</div>

</div>


<div class="card">

<div class="label">
PHASE
</div>

<div
  id="phase"
  class="value"
>
WAITING
</div>

</div>


<div class="card">

<div class="label">
LIVE X
</div>

<div
  id="live"
  class="value blue"
>
—
</div>

</div>


<div class="card">

<div class="label">
CRASH X
</div>

<div
  id="crash"
  class="value red"
>
—
</div>

</div>


</div>


<div class="grid section">


<div class="card">

<div class="label">
CRASH TIME
</div>

<div
  id="ctime"
  class="value"
  style="font-size:12px"
>
—
</div>

</div>


<div class="card">

<div class="label">
maxMultiplier
</div>

<div
  id="max"
  class="value yellow"
>
—
</div>

</div>


<div class="card">

<div class="label">
MATCH
</div>

<div
  id="match"
  class="value"
>
—
</div>

</div>


<div class="card">

<div class="label">
CONFIDENCE
</div>

<div
  id="conf"
  class="value"
  style="font-size:12px"
>
UNVERIFIED
</div>

</div>


</div>


<div class="toolbar">

<button
  class="clear"
  onclick="clearProof()"
>
CLEAR
</button>

<button
  class="refresh"
  onclick="load()"
>
REFRESH
</button>

<button
  class="debug"
  onclick="debugLast()"
>
DEBUG LAST USEFUL FRAME
</button>

</div>


<div class="section">

<h2>
PROOF EVENTS
</h2>

<div id="events">

<div class="muted">
Waiting for crashX...
</div>

</div>

</div>


<div
  id="debug"
  class="section"
  style="display:none"
>

<h2>
LAST USEFUL WEBSOCKET FRAME
</h2>

<pre id="debugData"></pre>

</div>


</div>


<script>

const esc =
  value =>
    String(
      value ?? ''
    ).replace(
      /[&<>"']/g,
      char => ({

        '&':
          '&amp;',

        '<':
          '&lt;',

        '>':
          '&gt;',

        '"':
          '&quot;',

        "'":
          '&#39;'

      }[char])
    );


function formatX(
  value
) {

  return (
    typeof value ===
      'number' &&
    Number.isFinite(value)
  )

    ? value.toFixed(2) + 'x'

    : (
        value ??
        '—'
      );

}


function eventClass(
  type
) {

  if (
    type ===
    'NEW_ROUND_STARTED'
  ) {

    return 'start';

  }


  if (
    type ===
    'CRASH_DETECTED'
  ) {

    return 'crash';

  }


  if (
    type ===
    'CRASH_CONFIRMED'
  ) {

    return 'confirm';

  }


  if (
    type ===
    'LIVE_TICK'
  ) {

    return 'live';

  }


  return '';

}


function renderEvent(
  event
) {

  let proof =
    '';


  if (
    event.type ===
    'CRASH_DETECTED'
  ) {

    proof =
      'Go to Aviator and manually confirm that the displayed round really crashed at ' +
      formatX(
        event.crashX
      ) +
      '.';

  }


  if (
    event.type ===
    'CRASH_CONFIRMED'
  ) {

    proof =
      'Server crashX == maxMultiplier — MATCH YES.';

  }


  return `

<div class="event ${eventClass(event.type)}">

<div class="meta">

${esc(event.time)}

—

${esc(event.type)}

—

Round:

${esc(event.roundId || '—')}

</div>


<div class="msg">

${esc(
  event.message ||
  event.type
)}

</div>


<div class="proof">

${esc(proof)}

</div>

</div>

`;

}


async function load() {

  try {

    const response =
      await fetch(
        '/api/ws-sniff',
        {
          cache:
            'no-store'
        }
      );


    const data =
      await response.json();


    const state =
      data.liveRoundState ||
      {};


    document
      .getElementById(
        'status'
      )
      .textContent =

        'WS ' +
        (
          data.socket
            ? 'CONNECTED'
            : 'WAITING'
        ) +

        ' | useful frames: ' +
        (
          data.count ||
          0
        ) +

        ' | proof events: ' +
        (
          data.eventCount ||
          0
        );


    document
      .getElementById(
        'round'
      )
      .textContent =
        state.roundId ??
        '—';


    document
      .getElementById(
        'phase'
      )
      .textContent =
        state.phase ||
        'WAITING';


    document
      .getElementById(
        'live'
      )
      .textContent =
        formatX(
          state.liveMultiplier
        );


    document
      .getElementById(
        'crash'
      )
      .textContent =
        formatX(
          state.crashX
        );


    document
      .getElementById(
        'ctime'
      )
      .textContent =
        state.crashDetectedAt ||
        '—';


    document
      .getElementById(
        'max'
      )
      .textContent =
        formatX(
          state.confirmedCrashX
        );


    let match =
      '—';


    if (
      state.crashX !== null &&
      state.confirmedCrashX !== null
    ) {

      match =
        Math.abs(
          Number(
            state.crashX
          ) -
          Number(
            state.confirmedCrashX
          )
        ) < 0.000001

          ? 'YES'

          : 'NO';

    }


    document
      .getElementById(
        'match'
      )
      .textContent =
        match;


    document
      .getElementById(
        'conf'
      )
      .textContent =
        state.confidence ||
        'UNVERIFIED';


    const events =
      data.roundEvents ||
      [];


    document
      .getElementById(
        'events'
      )
      .innerHTML =

        events.length

          ? events
              .map(
                renderEvent
              )
              .join('')

          : `

<div class="muted">

Waiting for server-reported crashX...

</div>

`;

  } catch (error) {

    document
      .getElementById(
        'status'
      )
      .textContent =
        'ERROR: ' +
        error.message;

  }

}


async function debugLast() {

  try {

    const response =
      await fetch(
        '/api/ws-sniff',
        {
          cache:
            'no-store'
        }
      );


    const data =
      await response.json();


    document
      .getElementById(
        'debug'
      )
      .style.display =
        'block';


    document
      .getElementById(
        'debugData'
      )
      .textContent =
        JSON.stringify(
          data.lastUsefulFrame ||
          data.lastFrame ||
          {},
          null,
          2
        );

  } catch {}

}


async function clearProof() {

  await fetch(
    '/api/ws-sniff/clear',
    {
      method:
        'POST'
    }
  );


  load();

}


load();


setInterval(
  load,
  350
);

</script>

</body>

</html>`);

};


// ============================================================
// STATIC FRONTEND
// ============================================================

app.use(
  express.static(
    path.join(
      __dirname,
      '..',
      'frontend'
    )
  )
);


// ============================================================
// SPA FALLBACK
// ============================================================

app.use(
  (
    req,
    res,
    next
  ) => {

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


// ============================================================
// ERROR HANDLER
// ============================================================

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


    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }


    res
      .status(500)
      .json({

        ok:
          false,

        message:
          'Internal server error.'

      });

  }
);


// ============================================================
// START
// ============================================================

async function start() {

  await ensurePage();


  try {

    await openLoginPage();

  } catch {

    startupReady =
      false;

  }


  if (
    !domWatchdogTimer
  ) {

    try {

      await installMutationObserver();

      await syncMutationVersion();

      await snapshotDomHealth();

    } catch {}


    startDomWatchdog();

  }


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
        ` Games: Aviator ${GAMES.aviator.id} | Fortuner Mine ${GAMES.fortunerMine.id}`
      );

      console.log(
        ' WebSocket target: crashX + maxMultiplier'
      );

      console.log(
        ' Player/bet flood: FILTERED'
      );

      console.log(
        ` Watchdog: ${WATCHDOG_MS}ms`
      );

      console.log(
        ' Sniffer UI: /ws-sniff.html'
      );

      console.log(
        '=============================================='
      );

    }
  );

}


// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {

  console.log(
    `\\n[SERVER] ${signal} received`
  );


  if (
    domWatchdogTimer
  ) {

    clearInterval(
      domWatchdogTimer
    );

  }


  clearTimeout(
    rebaselineTimer
  );


  try {

    await context?.close();

  } catch {}


  try {

    await browser?.close();

  } catch {}


  process.exit(
    0
  );

}


process.on(
  'SIGINT',
  () =>
    void shutdown(
      'SIGINT'
    )
);


process.on(
  'SIGTERM',
  () =>
    void shutdown(
      'SIGTERM'
    )
);


// ============================================================
// BOOT
// ============================================================

start()
  .catch(
    error => {

      console.error(
        '[START ERROR]',
        error
      );


      try {

        app.listen(
          PORT,
          HOST,
          () =>
            console.log(
              `WTS local connector fallback: http://${HOST}:${PORT}`
            )
        );

      } catch {}

    }
  );
