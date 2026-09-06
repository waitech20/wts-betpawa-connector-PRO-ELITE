(() => {
  'use strict';

  const HISTORY_SELECTOR = '.wts-p3-history-card';
  const MAIN_GRID_SELECTOR = '.wts-p2-main-grid';

  function arrangeHistory() {
    const root = document.querySelector('.wts-phase2-shell');
    if (!root) return;

    const historyCard = root.querySelector(HISTORY_SELECTOR);
    const mainGrid = root.querySelector(MAIN_GRID_SELECTOR);
    if (!historyCard || !mainGrid) return;

    // Keep the existing real round-history data, but make the UI explicitly
    // show the latest 20 rounds and place it above LIVE GAME DATA.
    const heading = historyCard.querySelector('.wts-p3-menu-head strong');
    const sub = historyCard.querySelector('.wts-p3-menu-head small');
    const history = historyCard.querySelector('#wts-p3-history');

    if (heading) heading.textContent = 'History / Last 20 Rounds';
    if (sub) sub.textContent = 'Latest 20 rounds';

    if (history) {
      while (history.children.length > 20) history.removeChild(history.lastElementChild);
    }

    // Move the existing card; do not recreate it, so all current event/state
    // updates continue to target the same #wts-p3-history element.
    if (historyCard.nextElementSibling !== mainGrid) {
      root.insertBefore(historyCard, mainGrid);
    }
  }

  const observer = new MutationObserver(arrangeHistory);
  observer.observe(document.body, { childList: true, subtree: true });
  arrangeHistory();
})();
