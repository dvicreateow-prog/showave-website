/* Standard page navigation outside the native homepage's Barba transitions. */
(() => {
  const mark = root => { if (root.nodeType !== 1 && root !== document) return; if (root.matches?.('a')) root.setAttribute('data-barba-prevent', 'all'); root.querySelectorAll?.('a').forEach(a => a.setAttribute('data-barba-prevent', 'all')); };
  mark(document);
  const current = (location.pathname.replace(/\/$/, '') || '/') === '/contributors' ? '/community' : (location.pathname.replace(/\/$/, '') || '/');
  document.querySelectorAll('.desktop-nav a').forEach(a => { if (new URL(a.href).pathname === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  new MutationObserver(changes => changes.forEach(change => change.addedNodes.forEach(mark))).observe(document.body, { childList: true, subtree: true });
})();
