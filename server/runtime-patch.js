'use strict';

// WTS runtime patch layer. It preserves server/index.js as the known-good
// baseline and applies the live telemetry/UI fixes at startup via npm start.
const fs = require('fs');
const Module = require('module');
const path = require('path');

const target = path.resolve(__dirname, 'index.js');
const originalLoader = Module._extensions['.js'];

Module._extensions['.js'] = function(mod, filename) {
  if (path.resolve(filename) !== target) return originalLoader(mod, filename);

  let s = fs.readFileSync(filename, 'utf8');
  if (!s.includes('WTS_RUNTIME_PATCH_V3')) {
    const stateMarker = 'let gameState = {';
    const state = """// WTS_RUNTIME_PATCH_V3
let crashSignal = { phase: 'WAITING', crashX: null, roundId: null, signalReceivedAt: null };

""";
    if (!s.includes(stateMarker)) throw new Error('WTS patch: gameState marker not found');
    s = s.replace(stateMarker, state + stateMarker, 1);

    const a = s.indexOf("  if (tag === 'CRASH' && typeof fields.crashX === 'number') {");
    const b = s.indexOf("  if (tag === 'ROUND_CHART_INFO' && typeof fields.maxMultiplier === 'number') {", a);
    if (a < 0 || b < 0) throw new Error('WTS patch: CRASH branch markers not found');

    const branch = """  if (tag === 'CRASH' && typeof fields.crashX === 'number') {
    const wasFlying = liveRoundState.phase === 'FLYING';
    if (fields.roundId != null && liveRoundState.roundId != null && fields.roundId !== liveRoundState.roundId) {
      pushRoundHistory(fields.crashX);
      return;
    }
    if (!wasFlying) { pushRoundHistory(fields.crashX); return; }

    // Real crashX from the authenticated game WebSocket. Publish immediately;
    // do not change the live flight phase and do not wait for chart/screenshot.
    const signalAt = now();
    crashSignal = {
      phase: 'CRASH_SIGNAL',
      crashX: fields.crashX,
      roundId: liveRoundState.roundId,
      signalReceivedAt: signalAt
    };
    liveRoundState.phase = 'FLYING';
    liveRoundState.updatedAt = signalAt;
    publishLiveTick('CRASH_SIGNAL_LIVE', {
      phase: 'FLYING',
      multiplier: liveRoundState.multiplier,
      crashX: fields.crashX,
      roundId: liveRoundState.roundId,
      signalReceivedAt: signalAt
    });
    pushRoundHistory(fields.crashX);
    captureCrashScreenshot({ roundId: liveRoundState.roundId, multiplier: fields.crashX });
    return;
  }

""";
    s = s.slice(0, a) + branch + s.slice(b);

    if (!s.includes('    crashSignal,')) {
      s = s.replace('    liveRoundState,\n', '    liveRoundState,\n    crashSignal,\n', 1);
    }

    const reset = "  liveRoundState = { phase: 'UNKNOWN', multiplier: null, roundId: null, newStateId: null, timeLeft: null, updatedAt: null };\n";
    if (s.includes(reset) && !s.includes("crashSignal = { phase: 'WAITING'")) {
      s = s.replace(reset, reset + "  crashSignal = { phase: 'WAITING', crashX: null, roundId: null, signalReceivedAt: null };\n", 1);
    }

    const staticMarker = "app.use(express.static(path.join(__dirname, '..', 'frontend')));";
    if (!s.includes("app.get('/wts-live-fix.js'")) {
      const injected = """app.get('/wts-live-fix.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'wts-live-fix.js')));
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
      const tag = '<script src=\"/wts-live-fix.js\"></script>';
      return res.type('html').send(html.includes('/wts-live-fix.js') ? html : html.replace('</body>', tag + '</body>'));
    } catch {}
  }
  next();
});
""" + staticMarker;
      if (!s.includes(staticMarker)) throw new Error('WTS patch: static middleware marker not found');
      s = s.replace(staticMarker, injected, 1);
    }

    if (!s.includes("const fs = require('fs');")) {
      s = s.replace("const path = require('path');", "const path = require('path');\nconst fs = require('fs');", 1);
    }
  }

  mod._compile(s, filename);
};

require(target);
