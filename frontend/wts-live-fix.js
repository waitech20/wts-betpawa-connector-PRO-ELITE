/* WTS LIVE FIX V3 — additive only */
(() => {
  'use strict';
  const OVERLAY_ID = 'wts-crash-signal-live-overlay-v3';
  const STYLE_ID = 'wts-crash-signal-live-style-v3';

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID}{position:fixed;right:18px;top:88px;z-index:2147483000;display:flex;align-items:center;gap:9px;padding:10px 14px;border:1px solid rgba(255,23,79,.45);border-radius:12px;background:rgba(7,10,20,.95);box-shadow:0 0 24px rgba(255,23,79,.20);font:800 12px/1 Arial,sans-serif;letter-spacing:.05em;color:#fff;backdrop-filter:blur(9px)}
      #${OVERLAY_ID} .label{color:#aab3c5} #${OVERLAY_ID} .value{font-size:17px;color:#ff174f;min-width:54px;text-align:right} #${OVERLAY_ID} .state{font-size:9px;color:#00e676}
      #${OVERLAY_ID}.waiting .value{color:#7e8799}.wts-cs-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.18);border-top-color:#ff174f;border-radius:50%;animation:wtsCsSpin .65s linear infinite}@keyframes wtsCsSpin{to{transform:rotate(360deg)}}
      .is-not-ready{filter:none!important;opacity:1!important;cursor:pointer!important}
    `;
    document.head.appendChild(style);
  }

  function overlay() {
    installStyle();
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className = 'waiting';
    el.innerHTML = '<span class="label">CRASH X</span><strong class="value"><span class="wts-cs-spin"></span></strong><span class="state">WAITING WS</span>';
    document.body.appendChild(el);
    return el;
  }

  function showCrashX(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const el = overlay();
    el.classList.remove('waiting');
    el.querySelector('.value').textContent = n.toFixed(2) + 'x';
    el.querySelector('.state').textContent = 'FLYING • WS';
  }

  window.__wtsEliteCrashSignal = (data) => {
    if (!data || typeof data.crashX !== 'number') return;
    showCrashX(data.crashX);
  };

  function moveHistoryAboveLiveData() {
    const root = document.querySelector('.wts-phase2-shell');
    if (!root) return;
    const history = root.querySelector('.wts-p3-history-card');
    const grid = root.querySelector('.wts-p2-main-grid');
    if (history && grid && history.nextElementSibling !== grid) root.insertBefore(history, grid);
  }

  function enableBetButtons() {
    document.querySelectorAll('button').forEach(btn => {
      const text = (btn.textContent || '').trim().toUpperCase();
      if (text.includes('PLACE BET') || text.includes('BET —') || text.includes('BET -')) {
        if (!btn.dataset.wtsSending) {
          btn.disabled = false;
          btn.classList.add('is-not-ready');
        }
      }
    });
  }

  function boot() {
    overlay();
    moveHistoryAboveLiveData();
    enableBetButtons();
    const observer = new MutationObserver(() => {
      moveHistoryAboveLiveData();
      enableBetButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class'] });

    try {
      const source = new EventSource('/api/events');
      source.addEventListener('message', ev => {
        try {
          const event = JSON.parse(ev.data || '{}');
          if (event.type === 'CRASH_SIGNAL_LIVE') {
            const d = event.data || {};
            showCrashX(d.crashX);
            if (typeof window.__wtsEliteCrashSignal === 'function') window.__wtsEliteCrashSignal(d);
          } else if (event.type === 'STATE_LIVE' && event.data?.newStateId != null) {
            const el = overlay();
            el.classList.add('waiting');
            el.querySelector('.value').innerHTML = '<span class="wts-cs-spin"></span>';
            el.querySelector('.state').textContent = 'WAITING WS';
          }
        } catch {}
      });
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
