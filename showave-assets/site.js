/* SHOWAVE website. Deliberately independent from the desktop application's runtime. */
(() => {
  'use strict';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motionPaused = reducedMotion.matches;
  try { const preference = localStorage.getItem('showave.site.motion'); if (preference !== null) motionPaused = preference === 'paused'; } catch { /* Optional preference storage. */ }

  function setMotion(paused, persist = false) {
    motionPaused = Boolean(paused);
    document.body.classList.toggle('motion-paused', motionPaused);
    $$('.motion-toggle').forEach(button => {
      button.setAttribute('aria-pressed', String(motionPaused));
      button.setAttribute('aria-label', motionPaused ? 'Resume motion' : 'Pause motion');
      button.title = motionPaused ? 'Resume motion' : 'Pause motion';
      button.innerHTML = `<span aria-hidden="true">${motionPaused ? '▷' : 'Ⅱ'}</span>`;
    });
    document.dispatchEvent(new CustomEvent('showave:motion', { bubbles: true, detail: { paused: motionPaused } }));
    if (persist) { try { localStorage.setItem('showave.site.motion', motionPaused ? 'paused' : 'playing'); } catch { /* Motion still works without storage. */ } }
  }
  setMotion(motionPaused);
  $$('.motion-toggle').forEach(button => button.addEventListener('click', () => setMotion(!motionPaused, true)));
  reducedMotion.addEventListener('change', event => setMotion(event.matches));

  const menuButton = $('.menu-toggle');
  const mobileMenu = $('#mobile-menu');
  function closeMenu() {
    if (!menuButton || !mobileMenu) return;
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open menu');
    mobileMenu.hidden = true;
  }
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    mobileMenu.hidden = !open;
  });
  $$('#mobile-menu a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') { closeMenu(); menuButton.focus(); } });
  window.matchMedia('(min-width:801px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  if ('IntersectionObserver' in window) {
    document.body.classList.add('motion-ready');
    const reveal = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); reveal.unobserve(entry.target); }
    }), { threshold: .09, rootMargin: '0px 0px -15px 0px' });
    $$('.reveal').forEach(element => reveal.observe(element));
  }
  let scrollPending = false;
  const hero = $('.hero');
  const progress = $('.reading-progress');
  function updateScroll() {
    scrollPending = false;
    const y = window.scrollY;
    const range = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.width = `${range > 0 ? (y / range) * 100 : 0}%`;
    if (hero && !motionPaused && !reducedMotion.matches && y < window.innerHeight * 1.5) {
      hero.style.setProperty('--hero-y', `${Math.min(y * .12, 90)}px`);
      hero.style.setProperty('--hero-scale', String(1.02 + Math.min(y / 9000, .06)));
    }
  }
  window.addEventListener('scroll', () => { if (!scrollPending) { scrollPending = true; requestAnimationFrame(updateScroll); } }, { passive: true });
  updateScroll();

  function bindTabKeyboard(tabs, select) {
    tabs.forEach((tab, index) => tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); select(tabs[next]); tabs[next].focus({ preventScroll: true }); }
    }));
  }
  // The deployable site only uses explicitly configured public HTTPS links.
  // The localhost preview can additionally serve the three exact, existing build artifacts.
  const platformDetails = {
    windows: { title: 'Windows desktop preview', arch: 'x64', icon: '⊞', description: 'An unsigned preview for testing SHOWAVE on Windows. Rehearse with your hardware and sources before using it in a live production.' },
    linux: { title: 'Linux portable preview', arch: 'x64', icon: '◇', description: 'A portable Linux build with its local helper included. Graphics, screen capture, and production hardware still need testing on a real Linux desktop.' },
    android: { title: 'Android review APK', arch: 'Android 8+', icon: '◉', description: 'An offline interface and media-player review build. Desktop production services are not included; Android device validation is still pending.' }
  };
  const dialog = $('#download-dialog');
  let selectedPlatform = /Android/i.test(navigator.userAgent) ? 'android' : /Linux/i.test(navigator.userAgent) ? 'linux' : 'windows';
  let releases = { version: '0.1.0-preview.6', platforms: {} };
  let releasePromise;
  const isLocalPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  function safeDownload(value) {
    if (!value || typeof value !== 'string') return null;
    try { const url = new URL(value, location.href); if (url.username || url.password) return null; return url.protocol === 'https:' || (isLocalPreview && url.origin === location.origin && /^\/downloads\/(windows|linux|android)$/.test(url.pathname)) ? url.href : null; } catch { return null; }
  }
  async function loadReleases() {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      try {
        const response = await fetch('/showave-assets/release-config.json');
        if (response.ok) { const config = await response.json(); if (config.version && config.platforms) releases = config; }
      } catch { /* Keep the truthful unavailable state when offline. */ }
      if (isLocalPreview) {
        try { const response = await fetch('/_preview/releases.json'); if (response.ok) { const local = await response.json(); if (local.version === releases.version) releases.platforms = { ...releases.platforms, ...local.platforms }; } } catch { /* A generic static preview has no local release endpoint. */ }
      }
      renderPlatform(selectedPlatform);
      $$('[data-platform-summary]').forEach(label => {
        const entry = releases.platforms[label.dataset.platformSummary];
        const available = Boolean(safeDownload(entry?.url));
        label.textContent = [entry?.version || releases.version, available ? [entry.size ? `${(entry.size / 1e6).toFixed(0)} MB` : '', entry.local ? 'Local installer available' : 'Public installer available'].filter(Boolean).join(' · ') : 'Public installer link is being prepared'].join(' · ');
      });
    })();
    return releasePromise;
  }
  function renderPlatform(key) {
    if (!dialog || !platformDetails[key]) return;
    selectedPlatform = key;
    const details = platformDetails[key];
    const release = releases.platforms[key];
    const url = safeDownload(release?.url);
    $$('[data-platform]').forEach(tab => { const selected = tab.dataset.platform === key; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    $('#release-panel').setAttribute('aria-labelledby', `platform-${key}`);
    $('#release-name').textContent = details.title;
    const version = release?.version || releases.version;
    $('#release-version').textContent = `${version} · ${details.arch}`;
    $$('[data-release-build]', dialog).forEach(label => { label.textContent = `BUILD ${version.toUpperCase()} / BETA`; });
    $('#platform-icon').textContent = details.icon;
    $('#release-description').textContent = details.description;
    const download = $('#release-download');
    download.hidden = !url;
    if (url) { download.href = url; download.innerHTML = `Download ${key === 'android' ? 'review APK' : `${key === 'linux' ? 'Linux' : 'Windows'} preview`} <span aria-hidden="true">↓</span>`; }
    else download.removeAttribute('href');
    $('#release-unavailable').hidden = Boolean(url);
    $('#release-unavailable').textContent = 'No installer is available from this server yet. Public download links are being prepared.';
    $('#release-size').textContent = url ? [release.size ? `${(release.size / 1e6).toFixed(0)} MB` : '', release.local ? 'Available from your local preview server.' : 'Preview build. Read the release notes before installing.'].filter(Boolean).join(' · ') : 'The release page will link to verified installers when public hosting is ready.';
  }
  if (dialog) {
    let originalOverflow = '';
    const supportStep = $('#download-support', dialog);
    const releaseStep = $('#download-release', dialog);
    function showDownloadStep(step, focus = false) {
      const support = step === 'support';
      if (supportStep) supportStep.hidden = !support;
      if (releaseStep) releaseStep.hidden = support;
      dialog.setAttribute('aria-labelledby', support ? 'download-title' : 'download-release-title');
      $$('[data-stage-label]', dialog).forEach(label => label.classList.toggle('is-current', label.dataset.stageLabel === step));
      if (focus) (support ? $('[data-download-continue]', dialog) : $(`[data-platform="${selectedPlatform}"]`, dialog))?.focus({ preventScroll: true });
    }
    $$('[data-download]').forEach(button => button.addEventListener('click', event => {
      event.preventDefault();
      closeMenu();
      if (platformDetails[button.dataset.platformChoice]) selectedPlatform = button.dataset.platformChoice;
      renderPlatform(selectedPlatform);
      showDownloadStep('support');
      const recipient = $('[data-support-recipient]', dialog);
      if (recipient) recipient.textContent = window.SHOWAVE_SITE_CONFIG?.donation?.recipient || 'See the donation details';
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
      loadReleases();
    }));
    $('[data-download-continue]', dialog)?.addEventListener('click', () => showDownloadStep('release', true));
    $('[data-download-back]', dialog)?.addEventListener('click', () => showDownloadStep('support', true));
    $('.dialog-close', dialog).addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
    dialog.addEventListener('close', () => { document.body.style.overflow = originalOverflow; });
    const platformTabs = $$('[data-platform]');
    platformTabs.forEach(tab => tab.addEventListener('click', () => renderPlatform(tab.dataset.platform)));
    bindTabKeyboard(platformTabs, tab => renderPlatform(tab.dataset.platform));
  }
  if ($('[data-platform-summary]')) loadReleases();

  const articleMount = $('#article-mount');
  if (articleMount) {
    const routeArticles = { '/plugins': 'plugins', '/api': 'api', '/developers': 'api', '/mcp': 'mcp', '/donate': 'donate', '/source': 'open-source', '/governance': 'governance', '/contribute': 'contribute', '/sponsors': 'sponsorship' };
    const key = new URLSearchParams(location.search).get('article') || routeArticles[location.pathname.replace(/\/$/, '') || '/'] || 'getting-started';
    const collection = window.SHOWAVE_CONTENT || {};
    const article = Object.prototype.hasOwnProperty.call(collection, key) ? collection[key] : null;
    if (article) {
      document.title = `${article.title} — SHOWAVE`;
      $('meta[name="description"]').content = article.intro;
      const shell = document.createElement('article');
      shell.className = 'article-content';
      const category = document.createElement('p'); category.className = 'eyebrow'; category.textContent = article.category;
      const title = document.createElement('h1'); title.textContent = article.title;
      const intro = document.createElement('p'); intro.className = 'article-intro'; intro.textContent = article.intro;
      const body = document.createElement('div'); body.className = 'article-body'; body.innerHTML = article.body; // Only reviewed, repository-owned content.js; no user HTML.
      const bottom = document.createElement('div'); bottom.className = 'article-bottom'; bottom.innerHTML = '<a class="button button-dark" href="/software">Explore the SHOWAVE family <span aria-hidden="true">↗</span></a>';
      shell.append(category, title, intro, body, bottom);
      articleMount.replaceWith(shell);
      if (key === 'donate') {
        const paymentLink = window.SHOWAVE_SITE_CONFIG?.donation?.url;
        try {
          const url = new URL(paymentLink);
          const allowed = ['flutterwave.com', 'www.flutterwave.com', 'checkout.flutterwave.com'];
          if (url.protocol === 'https:' && allowed.includes(url.hostname) && url.pathname.length > 1 && !url.username && !url.password) {
            const checkout = $('[data-flutterwave-checkout]');
            checkout.href = url.href;
            checkout.hidden = false;
            $('[data-donation-pending]').hidden = true;
            $('[data-donation-recipient]').textContent = `Current recipient: ${window.SHOWAVE_SITE_CONFIG.donation.recipient || 'See Flutterwave checkout'}`;
            $('[data-donation-note]').textContent = 'Choose your amount and complete your donation on Flutterwave.';
          }
        } catch { /* No verified merchant checkout configured yet. */ }
      }
      const active = $(`.article-sidebar [data-article="${CSS.escape(key)}"]`); active?.setAttribute('aria-current', 'page');
      if (location.hash) { const target = document.getElementById(decodeURIComponent(location.hash.slice(1))); target?.scrollIntoView({ behavior: 'instant' }); }
    } else {
      articleMount.innerHTML = '<h1>That page has left the stage.</h1><p>Let’s get you back to the right place.</p><a class="underlined-link" href="/manuals?article=getting-started">Open the getting started guide <span aria-hidden="true">↗</span></a>';
      document.title = 'Page not found — SHOWAVE';
    }
  }
  // One destination registry serves the dashboard and the library. Swapping the
  // temporary repository later updates these links without rewriting articles.
  if ($('[data-community-link]')) {
    import('./community-config.js').then(({ communityConfig, githubLink }) => {
      $$('[data-community-link]').forEach(link => {
        const url = githubLink(communityConfig.links[link.dataset.communityLink]);
        if (url) {
          link.href = url;
          link.target = '_blank'; link.rel = 'noopener noreferrer';
        }
      });
    }).catch(() => { /* The local contribution guide remains available offline. */ });
  }
})();
