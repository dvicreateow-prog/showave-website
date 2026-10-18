/* The same SHOWAVE drawing and entry treatment used by the homepage. */
(() => {
  'use strict';
  const ASSET = '/showave-assets/assets/showave-header-brand.svg?v=shared-header-1';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const brands = [];
  let bodyObserver;

  function syncMotion() {
    const paused = document.hidden || document.body.classList.contains('motion-paused');
    brands.forEach(brand => {
      if (reduced.matches) {
        brand.classList.remove('is-brand-entering');
        brand.dataset.brandEntry = 'complete';
      }
      brand.dataset.brandMotion = reduced.matches ? 'static' : paused ? 'paused' : 'active';
    });
  }

  function homeLink() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    let nav = document.querySelector('.hub-subnav');
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'hub-subnav';
      nav.setAttribute('aria-label', 'Explore SHOWAVE');
      header.after(nav);
    }
    if (nav.querySelector('.showave-home-link')) return;
    const home = document.createElement('a');
    home.className = 'showave-home-link';
    home.href = '/';
    home.setAttribute('data-barba-prevent', 'all');
    home.title = 'Return to the SHOWAVE homepage';
    home.innerHTML = '<span class="showave-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill-rule="evenodd" d="M10.75 3.4a2 2 0 0 1 2.5 0l7.5 6a1 1 0 0 1-1.25 1.56l-.5-.4V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8.44l-.5.4A1 1 0 1 1 3.25 9.4l7.5-6ZM10 19h4v-5h-4v5Z" clip-rule="evenodd"/></svg></span><span>Home</span>';
    nav.prepend(home);
    // The narrow-screen Appearance control can move into this navigation later.
    new MutationObserver(() => {
      if (nav.firstElementChild !== home) nav.prepend(home);
    }).observe(nav, { childList: true });
  }

  async function mount() {
    homeLink();
    const anchors = Array.from(document.querySelectorAll('.site-header a.brand'));
    if (!anchors.length) return;
    anchors.forEach(a => a.classList.add('showave-brand-logo'));
    try {
      const response = await fetch(ASSET, { credentials: 'same-origin' });
      if (!response.ok) return;
      const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      const svg = parsed.documentElement;
      if (parsed.querySelector('parsererror') || svg.localName !== 'svg' ||
          !svg.classList.contains('showave-brand-svg') ||
          svg.getAttribute('viewBox') !== '134 283 1197 297' ||
          svg.querySelector('script,foreignObject,image')) return;
      anchors.forEach(brand => {
        const drawing = document.importNode(svg, true);
        brand.replaceChildren(drawing);
        brand.dataset.brandReady = 'true';
        const enter = !reduced.matches && !document.body.classList.contains('motion-paused');
        brand.dataset.brandEntry = enter ? 'entering' : 'complete';
        if (enter) brand.classList.add('is-brand-entering');
        brand.addEventListener('animationend', event => {
          if (event.animationName !== 'showave-brand-word-in') return;
          brand.classList.remove('is-brand-entering');
          brand.dataset.brandEntry = 'complete';
        });
        brands.push(brand);
      });
      syncMotion();
      document.addEventListener('visibilitychange', syncMotion);
      reduced.addEventListener('change', syncMotion);
      bodyObserver = new MutationObserver(syncMotion);
      bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (_) {
      // Keep the original accessible mark and wordmark if the asset is unavailable.
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
