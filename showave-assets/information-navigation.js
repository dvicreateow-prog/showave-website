/* Route handoff only. The native homepage scene animation code is untouched. */
(() => {
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[data-barba-prevent="all"]');
    if (!anchor || anchor.hasAttribute('data-download')) return;
    // New information pages do not use the original Barba page containers.
    // Stop its anchor handler before the target phase; retain normal downloads,
    // external tabs and modifier-clicks rather than animating the homepage away.
    event.stopImmediatePropagation();
    if ((event.button ?? 0) !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.hasAttribute('download') || anchor.target === '_blank') return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
    event.preventDefault();
    location.assign(url.href);
  }, true);
})();
