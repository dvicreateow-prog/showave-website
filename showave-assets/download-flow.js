/* Standalone optional-support-first download UI. No homepage animation or production hooks. */
(() => {
  'use strict';
  if (window.SHOWAVE_DOWNLOAD_FLOW_LOADED) return;
  window.SHOWAVE_DOWNLOAD_FLOW_LOADED = true;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
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
  let releases = { version: 'Preview', platforms: {} };
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
        const response = await fetch('/showave-assets/release-config.json', { cache: 'no-cache' });
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
    document.addEventListener('click', event => {
      const button = event.target.closest?.('[data-download]');
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (platformDetails[button.dataset.platformChoice]) selectedPlatform = button.dataset.platformChoice;
      renderPlatform(selectedPlatform);
      showDownloadStep('support');
      const recipient = $('[data-support-recipient]', dialog);
      if (recipient) recipient.textContent = window.SHOWAVE_SITE_CONFIG?.donation?.recipient || 'See the donation details';
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
      loadReleases();
    }, true);
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


})();
