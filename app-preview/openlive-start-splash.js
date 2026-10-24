(function installStartSplash(global) {
  'use strict';
  if (global.OpenLiveStartSplash) return;

  const app = document.getElementById('app');
  if (!app) return;
  const routes = [
    { id: 'show', title: 'Show', route: 'index.html' },
    { id: 'broadcast', title: 'Broadcast', route: 'broadcast.html' },
    { id: 'timeline', title: 'Timeline', route: 'timeline.html' },
    { id: 'forge', title: 'Forge', route: 'wire.html', preview: true },
    { id: 'map', title: 'Map', route: 'advanced-output.html' },
    { id: 'encode', title: 'Encode', route: 'alley.html' }
  ];
  const byId = new Map(routes.map(route => [route.id, route]));
  let busy = false;
  let recovery = null;
  let recents = [];
  let listFailed = false;
  let revision = 0;
  let focusBeforeSplash = null;
  let coverBusy = false;

  const shell = document.createElement('div');
  shell.id = 'showave-start-shell';
  const tabs = document.createElement('nav');
  tabs.id = 'showave-workspace-tabs';
  tabs.setAttribute('aria-label', 'SHOWAVE workspaces');
  const tabButtons = new Map();
  routes.forEach(route => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.workspace = route.id;
    button.className = 'showave-workspace-tab';
    button.textContent = route.id === 'show' ? 'Show Grid' : route.title;
    if (route.preview) {
      button.title = 'Forge workspace (Preview)';
    }
    if (route.id === 'show') button.setAttribute('aria-current', 'page');
    tabButtons.set(route.id, button);
    tabs.append(button);
  });
  const menubar = document.getElementById('menubar');
  if (menubar) menubar.insertBefore(tabs, menubar.querySelector('.mb-right'));
  else shell.append(tabs);
  function updateTabs() {
    const host = global.OpenLiveWorkspaceHost, state = host?.state?.();
    if (!state) return;
    for (const route of host.routes) {
      if (!byId.has(route.id)) byId.set(route.id, route);
      if (!tabButtons.has(route.id)) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.workspace = route.id;
        button.className = 'showave-workspace-tab'; button.textContent = route.title;
        tabButtons.set(route.id, button);
      }
    }
    for (const [id,button] of tabButtons) if (!state.order.includes(id)) button.remove();
    for (const id of state.order) tabs.append(tabButtons.get(id));
    host.bindTabs?.(tabs);
  }
  global.addEventListener('showave:workspace-tabs-changed', updateTabs);
  // The workspace host loads before this module creates the tabs.
  updateTabs();
  const panels = document.createElement('button');
  panels.id = 'showave-panels-button';
  panels.type = 'button';
  panels.className = 'showave-panels-button';
  panels.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M7 2v12M7 7h7"/></svg>';
  panels.title = 'Add, hide, undock or dock workspace panels';
  panels.setAttribute('aria-label', 'Manage workspace panels');
  panels.setAttribute('aria-haspopup', 'dialog');
  panels.setAttribute('aria-expanded', 'false');
  if (menubar) menubar.insertBefore(panels, menubar.querySelector('.mb-right'));
  else shell.append(panels);
  const updatePanels = () => {
    panels.disabled = !global.OpenLiveWorkspaceHost?.hasPanels?.();
  };
  panels.addEventListener('click', () => global.OpenLiveWorkspaceHost?.openPanels?.(panels));
  global.addEventListener('showave:workspace-changed', updatePanels);
  global.addEventListener('showave:workspace-ready', updatePanels);
  global.addEventListener('showave:areas-changed', updatePanels);
  updatePanels();

  const icons = {
    new: '<path d="M3 5h7v9H3zM5 5V2h5v3M12 3v5M9.5 5.5h5"/>',
    broadcast: '<rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5 14h6M8 11.5V14M6.5 5l4 2-4 2z"/>',
    timeline: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 6h13M5 2.5V6M11 2.5V6M4 9h3M9 11h3"/>',
    forge: '<rect x="1.5" y="2" width="4" height="4" rx=".5"/><rect x="10.5" y="10" width="4" height="4" rx=".5"/><path d="M3.5 6v6h7M5.5 4h7v6"/>',
    map: '<path d="M2 3l4-1 4 2 4-1v10l-4 1-4-2-4 1zM6 2v10M10 4v10"/>',
    encode: '<path d="M3 1.5h6.5L13 5v9.5H3zM9.5 1.5V5H13M5 9h6M8.5 6.5L11 9l-2.5 2.5"/>',
    grid: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12"/>',
    chaser: '<path d="M2 4h4v8H2zM6 8h4M10 3h4v4h-4zM10 10h4v4h-4z"/>',
    lighting: '<path d="M5 2h6l2 6-5 4-5-4zM6 12l-2 2M8 12v3M10 12l2 2M5 5h6"/>',
    expand: '<path d="M4 6l4 4 4-4"/>',
    open: '<path d="M2 5h5l2 2h5v7H2zM2 5V3h5l2 2"/>',
    recover: '<path d="M3 6a6 6 0 1 1-1 5M1 3v4h4M8 4v5l3 2"/>',
    recent: '<path d="M4 2h6l3 3v9H4zM10 2v4h3M1 8h6M3 6l-2 2 2 2"/>',
    more: '<circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l4 4"/>',
    news: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c4 4 4 8 0 12M8 2c-4 4-4 8 0 12"/>',
    image: '<rect x="1.5" y="2" width="13" height="12" rx="1"/><circle cx="5" cy="5.5" r="1"/><path d="M2 12l4-4 3 3 2-2 3 3"/>',
    mirror: '<rect x="1" y="2" width="10" height="8" rx="1"/><path d="M4 13h4M6 10v3"/><rect x="11" y="6" width="4" height="8" rx=".7"/>',
    reset: '<path d="M3 5a5.5 5.5 0 1 1-1 6M1 2v4h4"/>'
  };
  const icon = name => '<svg class="showave-start-icon" viewBox="0 0 16 16" aria-hidden="true">' + icons[name] + '</svg>';
  const workspaceRows = routes.filter(route => route.id !== 'show').map(route =>
    '<button type="button" data-start-workspace="' + route.id + '" title="Open ' + route.title + ' workspace">' +
    icon(route.id) + '<span>' + route.title + (route.preview ? ' (Preview)' : '') + '</span></button>').join('');

  const backdrop = document.createElement('div');
  backdrop.id = 'showave-start-backdrop';
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <div id="showave-start-panel" aria-labelledby="showave-start-title">
      <header class="showave-start-hero">
        <div class="showave-cover-frames" aria-hidden="true"><img class="showave-cover-frame" alt="" src="assets/brand/showave-splash-default-1.jpg"><img class="showave-cover-frame" alt="" src="assets/brand/showave-splash-default-2.jpg"></div>
        <div class="showave-start-brand"><span class="showave-start-mark" aria-hidden="true"></span><span>SHOWAVE</span></div>
        <h1 id="showave-start-title" class="showave-start-sr-only">SHOWAVE startup</h1>
        <span id="showave-start-version" class="showave-start-version"></span>
        <button id="showave-start-close" type="button" aria-label="Close Home" title="Close Home"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        <div class="showave-start-credit"><span class="showave-start-credit-label">Founded by</span><strong id="showave-start-founder">Godrick Sakonfa</strong><span id="showave-start-organization">Afro Unity Ground</span></div>
        <div class="showave-start-cover-controls" aria-label="Startup cover">
          <button id="showave-start-cover-pause" type="button" aria-label="Pause animated cover" title="Pause animated cover" aria-pressed="false" hidden>Ⅱ</button>
          <button id="showave-start-cover-change" type="button" aria-label="Change cover" title="Change cover">${icon('image')}</button>
          <button id="showave-start-cover-reset" type="button" aria-label="Restore default images" title="Restore default images">${icon('reset')}</button>
        </div>
        <span id="showave-start-artwork-credit" hidden></span>
        <input id="showave-start-cover-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      </header>
      <div class="showave-start-body">
        <section class="showave-start-actions" aria-labelledby="showave-start-actions-title">
          <h2 id="showave-start-actions-title">New / Workspaces</h2>
          <div class="showave-start-workspace-list">
          <button id="showave-start-new" type="button" data-start-action="new" title="Create a new Show">${icon('new')}<span>Live Show</span></button>
          ${workspaceRows}
          <div id="showave-start-extra-workspaces" class="showave-start-extra-workspaces" hidden>
            <button type="button" data-start-panel="grid-tool.html" title="Open SHOWAVE Grid Tool">${icon('grid')}<span>Grid Tool</span></button>
            <button type="button" data-start-workspace="chaser" title="Open SHOWAVE Chaser workspace">${icon('chaser')}<span>Chaser</span></button>
            <button type="button" data-start-panel="gsl5.html" title="Open GSL5 Lighting Library in its own window">${icon('lighting')}<span>GSL5 Lighting Library</span></button>
          </div>
          </div>
          <button id="showave-start-workspaces-toggle" type="button" aria-expanded="false" aria-controls="showave-start-extra-workspaces">${icon('expand')}<span>Show more</span></button>
        </section>
        <section class="showave-start-recent" aria-labelledby="showave-start-recent-title">
          <h2 id="showave-start-recent-title">Recent Files</h2>
          <div id="showave-start-recent-list" class="showave-start-recent-list"></div>
          <p id="showave-start-recent-empty" class="showave-start-empty">No recent shows yet.</p>
          <button id="showave-start-more" type="button" class="showave-start-more" hidden>${icon('more')}<span>More…</span></button>
        </section>
      </div>
      <footer class="showave-start-footer">
        <div><button id="showave-start-open" type="button" data-start-action="open" title="Choose a .openlive.json Show file">${icon('open')}<span>Open…</span></button>
          <button id="showave-start-recover" type="button" data-start-action="recover" disabled>${icon('recover')}<span>Recover Last Session</span></button></div>
        <div><a id="showave-start-news" href="https://showave.afrounity.club/downloads/#beta" target="_blank" rel="noopener noreferrer" title="See current SHOWAVE releases and updates">${icon('news')}<span>What's New</span></a>
          <a id="showave-start-donate" href="https://showave.afrounity.club/fund" target="_blank" rel="noopener noreferrer" aria-label="Donate" title="Support SHOWAVE development"><img class="showave-start-donate-logo" src="assets/brand/showave-donate-animated.svg" alt="" width="112" height="23"></a></div>
        <span id="showave-start-status" role="status" aria-live="polite"></span>
      </footer>
      <section class="showave-start-mirror" data-sw-mobile-private aria-label="Mirror Display">
        <button id="showave-start-mirror-toggle" type="button" aria-expanded="false" aria-controls="showave-start-mirror-content">${icon('mirror')}<span>Mirror Display</span><span class="showave-start-mirror-hint">Remote QR / link</span><svg class="showave-start-mirror-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></button>
        <div id="showave-start-mirror-content" hidden><p class="showave-start-mirror-loading" role="status">Remote controls are starting…</p></div>
      </section>
    </div>`;
  shell.append(backdrop);
  app.insertBefore(shell, app.firstChild);
  // Home controls remain active while the Show's body is suspended in another
  // workspace. Keep its editor inside the same retained chrome container.
  const coverEditorBackdrop = document.getElementById('showave-cover-editor-backdrop');
  if (coverEditorBackdrop) shell.append(coverEditorBackdrop);

  const $ = id => document.getElementById(id);
  const projects = global.OpenLiveProjects;
  $('showave-start-version').textContent = global.OpenLiveDesktop?.version || '0.1.0-preview.16';
  let showAllRecent = false;
  let mirrorPanel = null, mirrorExpanded = false;
  function publishMirrorState() {
    global.dispatchEvent(new CustomEvent('showave:home-mirror-changed', { detail: { open: !backdrop.hidden && mirrorExpanded } }));
  }
  function mountMirror() {
    if (!mirrorPanel && typeof global.ShowaveMobileHost?.mountPairing === 'function') {
      mirrorPanel = global.ShowaveMobileHost.mountPairing($('showave-start-mirror-content'));
    }
    return mirrorPanel;
  }
  function setMirrorExpanded(value) {
    mirrorExpanded = !!value;
    $('showave-start-mirror-toggle').setAttribute('aria-expanded', String(mirrorExpanded));
    $('showave-start-mirror-content').hidden = !mirrorExpanded;
    const panel = mountMirror();
    if (mirrorExpanded && !backdrop.hidden) panel?.show();
    else panel?.hide();
    publishMirrorState();
  }
  $('showave-start-mirror-toggle').addEventListener('click', () => setMirrorExpanded(!mirrorExpanded));
  global.addEventListener('showave:mobile-host-ready', () => {
    const panel = mountMirror();
    if (mirrorExpanded && !backdrop.hidden) panel?.show();
  });

  const cover = global.OpenLiveSplashCover;
  const hero = backdrop.querySelector('.showave-start-hero');
  const frames = [...hero.querySelectorAll('.showave-cover-frame')];
  const reducedMotion = global.matchMedia('(prefers-reduced-motion: reduce)');
  let coverValue = cover?.get() || { custom: false };
  let frame = 0, slideshowTimer = null, defaultsReady = false, customCoverPaused = false;
  function stopSlideshow() { if (slideshowTimer !== null) global.clearTimeout(slideshowTimer); slideshowTimer = null; }
  function selectFrame(index) {
    frame = index;
    frames[1].classList.toggle('is-active', index === 1);
    hero.dataset.coverFrame = String(index);
  }
  selectFrame(0);
  function syncCoverPlayback() {
    stopSlideshow();
    const playback = $('showave-start-cover-pause');
    playback.hidden = !coverValue.animated;
    playback.disabled = reducedMotion.matches;
    playback.setAttribute('aria-pressed', String(customCoverPaused));
    playback.setAttribute('aria-label', reducedMotion.matches ? 'Animation paused for reduced motion' : customCoverPaused ? 'Play animated cover' : 'Pause animated cover');
    playback.title = playback.getAttribute('aria-label'); playback.textContent = customCoverPaused ? '▶' : 'Ⅱ';
    if (coverValue.custom) {
      const paused = customCoverPaused || reducedMotion.matches || backdrop.hidden || document.hidden || global.OpenLiveCoverEditor?.isOpen();
      hero.dataset.coverSlideshow = coverValue.animated ? (paused ? 'custom-paused' : 'custom-running') : 'custom';
      const url = coverValue.animated && paused ? coverValue.posterUrl : coverValue.url;
      hero.style.backgroundImage = 'url(' + JSON.stringify(url) + ')'; return;
    }
    if (!defaultsReady) { hero.dataset.coverSlideshow = 'loading'; return; }
    if (reducedMotion.matches) { selectFrame(0); hero.dataset.coverSlideshow = 'reduced-motion'; return; }
    if (backdrop.hidden || document.hidden || global.OpenLiveCoverEditor?.isOpen()) { hero.dataset.coverSlideshow = 'paused'; return; }
    hero.dataset.coverSlideshow = 'running';
    slideshowTimer = global.setTimeout(() => { slideshowTimer = null; selectFrame(frame ? 0 : 1); syncCoverPlayback(); }, 8000);
  }
  $('showave-start-cover-pause').addEventListener('click', () => { customCoverPaused = !customCoverPaused; syncCoverPlayback(); });
  $('showave-start-cover-pause').addEventListener('keydown', activateMoreToolOnKey);
  Promise.all(frames.map(image => typeof image.decode === 'function' ? image.decode() : new Promise((resolve, reject) => {
    if (image.complete && image.naturalWidth) resolve();
    else { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', reject, { once: true }); }
  }))).then(() => { defaultsReady = true; hero.dataset.coverReady = 'true'; syncCoverPlayback(); }).catch(() => {
    hero.dataset.coverSlideshow = 'paused';
  });
  reducedMotion.addEventListener?.('change', syncCoverPlayback);
  document.addEventListener('visibilitychange', syncCoverPlayback);
  global.addEventListener('pagehide', stopSlideshow);
  global.addEventListener('pageshow', syncCoverPlayback);
  function renderCover(value) {
    const wasCustom = coverValue.custom;
    if (coverValue.url !== value.url) customCoverPaused = false;
    coverValue = value;
    hero.dataset.customCover = value.custom ? 'true' : 'false';
    hero.style.backgroundImage = value.custom ? 'url(' + JSON.stringify(value.url) + ')' : '';
    hero.querySelector('.showave-cover-frames').hidden = !!value.custom;
    $('showave-start-artwork-credit').hidden = true;
    $('showave-start-cover-change').title = 'Choose and adjust a cover image';
    if (wasCustom && !value.custom) selectFrame(0);
    syncCoverPlayback();
  }
  function setCoverBusy(value) {
    coverBusy = !!value;
    $('showave-start-cover-change').disabled = coverBusy;
    $('showave-start-cover-reset').disabled = coverBusy;
  }
  if (cover) {
    cover.subscribe(renderCover);
    renderCover(cover.get());
    cover.load().catch(() => status('Your saved cover could not be loaded. You can choose another image.', true));
  } else {
    $('showave-start-cover-change').disabled = true;
    $('showave-start-cover-reset').disabled = true;
  }
  function openCoverEditor() {
    if (!cover || coverBusy) return;
    global.OpenLiveCoverEditor.open({ cover,
      onUpload: () => $('showave-start-cover-input').click(),
      onSaved: value => status(value.custom ? 'Cover saved for this device.' : 'Default images restored.'),
      onClose: () => { syncCoverPlayback(); syncHomeGlobe(); } });
    syncCoverPlayback(); syncHomeGlobe();
  }
  $('showave-start-cover-change').addEventListener('click', () => {
    if (!cover || coverBusy) return;
    openCoverEditor();
  });
  $('showave-start-cover-input').addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !cover || coverBusy) return;
    openCoverEditor();
    global.OpenLiveCoverEditor.editFile(file);
  });
  $('showave-start-cover-reset').addEventListener('click', async () => {
    if (!cover || coverBusy) return;
    setCoverBusy(true); status('Restoring the default images…');
    try { await cover.reset(); selectFrame(0); syncCoverPlayback(); status('Default images restored.'); }
    catch (error) { status(error?.message || 'The default images could not be restored.', true); }
    finally { setCoverBusy(false); }
  });

  function status(message, error) {
    const element = $('showave-start-status');
    element.textContent = message || '';
    element.classList.toggle('is-error', !!error);
  }

  function readableDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  }

  function renderRecent() {
    const list = $('showave-start-recent-list');
    const fragment = document.createDocumentFragment();
    recents.slice(0, showAllRecent ? 30 : 5).forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'showave-start-recent-item';
      button.dataset.recentId = item.id;
      button.disabled = busy;
      button.setAttribute('aria-label', 'Open ' + (item.name || 'Untitled Show'));
      const icon = document.createElement('span');
      icon.className = 'showave-start-file-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg class="showave-start-icon" viewBox="0 0 16 16" aria-hidden="true">' + icons.recent + '</svg>';
      const title = document.createElement('span');
      title.className = 'showave-start-recent-name';
      title.textContent = item.name || 'Untitled Show';
      const meta = document.createElement('span');
      meta.className = 'showave-start-recent-meta';
      meta.textContent = [item.copyOnly ? 'saved copy' : '', readableDate(item.updatedAt)].filter(Boolean).join(' · ');
      button.title = [item.name, meta.textContent].filter(Boolean).join(' · ');
      button.append(icon, title);
      fragment.append(button);
    });
    list.replaceChildren(fragment);
    $('showave-start-more').hidden = recents.length <= 5;
    $('showave-start-more').querySelector('span').textContent = showAllRecent ? 'Less…' : 'More…';
    $('showave-start-recent-empty').hidden = recents.length > 0;
    $('showave-start-recent-empty').textContent = listFailed ? 'Recent files unavailable.' : 'No recent files';
  }

  function renderRecovery() {
    $('showave-start-recover').disabled = busy || !recovery;
    const date = recovery && readableDate(recovery.savedAt || recovery.updatedAt);
    $('showave-start-recover').title = recovery ?
      'Restore unsaved work' + (date ? ' from ' + date : '') : 'No recoverable Show available';
  }

  function setBusy(value) {
    busy = !!value;
    $('showave-start-new').disabled = busy;
    $('showave-start-open').disabled = busy;
    renderRecovery();
    renderRecent();
  }

  async function refresh() {
    const thisRevision = ++revision;
    if (!projects || typeof projects.list !== 'function' || typeof projects.getRecovery !== 'function') {
      recents = [];
      recovery = null;
      listFailed = true;
      renderRecent(); renderRecovery();
      status('Show files are unavailable. You can still use the workspaces.', true);
      return;
    }
    const [listResult, recoveryResult] = await Promise.allSettled([
      Promise.resolve().then(() => projects.list()),
      Promise.resolve().then(() => projects.getRecovery())
    ]);
    if (thisRevision !== revision) return;
    listFailed = listResult.status === 'rejected';
    recents = listResult.status === 'fulfilled' && Array.isArray(listResult.value) ?
      listResult.value.filter(item => item && item.id != null).map(item => ({
        id: String(item.id), name: typeof item.name === 'string' ? item.name : '',
        updatedAt: item.updatedAt, copyOnly: item.copyOnly === true
      })) : [];
    recovery = recoveryResult.status === 'fulfilled' && recoveryResult.value &&
      typeof recoveryResult.value.text === 'string' ? recoveryResult.value : null;
    renderRecent(); renderRecovery();
    if (listFailed && !busy) status('Recent shows could not be loaded. You can still open a Show file.', true);
  }

  // Load the shared website globe only when Home is requested.
  let homeGlobeModule = null, homeGlobeLoading = null;
  function syncHomeGlobe() {
    if (backdrop.hidden || global.OpenLiveCoverEditor?.isOpen()) { homeGlobeModule?.hide(); return; }
    if (homeGlobeModule) { homeGlobeModule.show($('showave-start-panel')); return; }
    if (homeGlobeLoading) return;
    homeGlobeLoading = import('./openlive-home-globe.js').then(module => {
      homeGlobeModule = module;
      if (!backdrop.hidden && !global.OpenLiveCoverEditor?.isOpen()) module.show($('showave-start-panel'));
      else module.hide();
    }).catch(() => { /* Decoration must never block a workspace or Show file. */ })
      .finally(() => { homeGlobeLoading = null; });
  }
  let splashVisibilityRevision = 0;
  function showSplash() {
    splashVisibilityRevision++;
    if (backdrop.hidden) focusBeforeSplash = document.activeElement;
    global.__showaveSplashRequested = false;
    backdrop.hidden = false;
    syncCoverPlayback();
    syncHomeGlobe();
    const panel = $('showave-start-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    status('');
    refresh();
    // Returning to ordinary Home must not restart a session the user stopped.
    if (mirrorExpanded) {
      if (global.ShowaveMobileHost?.paired) mountMirror()?.show();
      else setMirrorExpanded(false);
    }
    publishMirrorState();
    requestAnimationFrame(() => { if (!backdrop.hidden) $('showave-start-new').focus(); });
  }

  function hideSplash() {
    if (global.OpenLiveCoverEditor?.isOpen() && !global.OpenLiveCoverEditor.close()) return;
    splashVisibilityRevision++;
    backdrop.hidden = true;
    syncHomeGlobe();
    mirrorPanel?.hide();
    publishMirrorState();
    syncCoverPlayback();
    $('showave-start-panel').removeAttribute('role');
    $('showave-start-panel').removeAttribute('aria-modal');
    const focus = focusBeforeSplash && focusBeforeSplash.isConnected ? focusBeforeSplash : $('showaveHomeButton');
    focusBeforeSplash = null;
    if (focus && typeof focus.focus === 'function') focus.focus({ preventScroll: true });
  }

  function openMirror() {
    showSplash();
    setMirrorExpanded(true);
    requestAnimationFrame(() => {
      if (!backdrop.hidden) $('showave-start-mirror-toggle').focus({ preventScroll: true });
    });
  }

  function showApi() {
    const api = global.OpenLiveShowProjects;
    if (!api || typeof api.newShow !== 'function' || typeof api.openRecord !== 'function')
      throw new Error('The Show is still starting. Please try again.');
    return api;
  }

  async function applyRecord(record) {
    if (!record) { status('The Show is no longer available. Open the file again.', true); return; }
    await global.OpenLiveWorkspaceHost?.activate('show');
    const changed = await showApi().openRecord(record, { initial: true });
    if (changed) hideSplash();
    else status('The action was cancelled in Show.');
  }

  async function runNew() {
    if (busy) return;
    setBusy(true); status('Creating a new Show…');
    try {
      await global.OpenLiveWorkspaceHost?.activate('show');
      const changed = await showApi().newShow({ initial: true });
      if (changed) hideSplash();
      else status('New Show cancelled.');
    } catch (error) { status(error && error.message || 'New Show could not be created.', true); }
    finally { setBusy(false); }
  }

  async function runOpen() {
    if (busy) return;
    if (!projects || typeof projects.open !== 'function') { status('Show files are unavailable.', true); return; }
    // Invoke the picker while this click still owns the browser's activation.
    let selection;
    try { selection = projects.open(); }
    catch (error) { status(error && error.message || 'The Show chooser could not open.', true); return; }
    setBusy(true); status('Choose a SHOWAVE Show file…');
    try {
      const record = await selection;
      if (!record) { status('Open Show cancelled.'); return; }
      await applyRecord(record);
    } catch (error) { status(error && error.message || 'The Show could not be opened.', true); }
    finally { setBusy(false); if (!backdrop.hidden) refresh(); }
  }

  async function runRecent(id) {
    if (busy) return;
    if (!projects || typeof projects.openRecent !== 'function') { status('Recent shows are unavailable.', true); return; }
    let selection;
    try { selection = projects.openRecent(id); }
    catch (error) { status(error && error.message || 'Recent Show could not be opened.', true); return; }
    setBusy(true); status('Opening recent Show…');
    try { await applyRecord(await selection); }
    catch (error) { status(error && error.message || 'Recent Show could not be opened.', true); }
    finally { setBusy(false); if (!backdrop.hidden) refresh(); }
  }

  async function runRecover() {
    if (busy) return;
    if (!projects || typeof projects.getRecovery !== 'function') { status('Recovery is unavailable.', true); return; }
    setBusy(true); status('Recovering the last session…');
    try {
      const snapshot = await projects.getRecovery();
      if (!snapshot || typeof snapshot.text !== 'string') { status('No recoverable Show is available.'); refresh(); return; }
      await applyRecord({ name: 'Recovered Show.openlive.json', text: snapshot.text,
        recoveryId: snapshot.recoveryId });
    } catch (error) { status(error && error.message || 'The last session could not be recovered.', true); }
    finally { setBusy(false); if (!backdrop.hidden) refresh(); }
  }

  async function openWorkspace(id) {
    const route = byId.get(id);
    if (!route) return;
    const visibilityRevision = splashVisibilityRevision;
    try {
      if (!global.OpenLiveWorkspaceHost) throw new Error('The workspace host is still starting.');
      await global.OpenLiveWorkspaceHost.activate(id);
      if (id === 'show') {
        const manager = global.OpenLiveAreas?.get('show');
        const grid = manager?.panels?.().find(panel => panel.default && panel.type === 'show-grid' && panel.state === 'hidden');
        if (grid) manager.reopen(grid.id);
      }
      // Reopening Home while a workspace loads owns the current cover session.
      if (visibilityRevision === splashVisibilityRevision) hideSplash();
      else if (global.OpenLiveCoverEditor?.isOpen()) global.OpenLiveCoverEditor.restoreFocus();
    } catch (error) { status(error && error.message || 'The workspace could not be opened.', true); }
  }

  // Use the existing utility authorities rather than inventing workspace IDs.
  async function openHomeTool(file) {
    if (file !== 'grid-tool.html' && file !== 'gsl5.html') return;
    try {
      if (typeof global.__openliveOpenPanel !== 'function') throw new Error('The tools are still starting.');
      if (file === 'grid-tool.html') {
        if (!global.OpenLiveWorkspaceHost) throw new Error('The workspace host is still starting.');
        await global.OpenLiveWorkspaceHost.activate('show');
      }
      // GSL5 must stay in this click's user gesture for its named product window.
      global.__openliveOpenPanel(file);
      hideSplash();
    } catch (error) { status(error && error.message || 'The tool could not be opened.', true); }
  }
  $('showave-start-workspaces-toggle').addEventListener('click', () => {
    const extra = $('showave-start-extra-workspaces');
    const expanded = extra.hidden;
    extra.hidden = !expanded;
    const toggle = $('showave-start-workspaces-toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.querySelector('span').textContent = expanded ? 'Show less' : 'Show more';
    const list = extra.parentElement;
    if (expanded) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight - list.clientHeight; });
    else list.scrollTop = 0;
  });
  function activateMoreToolOnKey(event) {
    const button = event.target.closest('button');
    if (!button || (event.key !== 'Enter' && event.key !== ' ')) return;
    // Home owns these keys; the Show's editable shortcuts stay in its workspace.
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) button.click();
  }
  $('showave-start-workspaces-toggle').addEventListener('keydown', activateMoreToolOnKey);
  $('showave-start-extra-workspaces').addEventListener('keydown', activateMoreToolOnKey);

  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-workspace]');
    if (button) openWorkspace(button.dataset.workspace);
  });
  global.addEventListener('showave:workspace-changed', event => {
    for (const button of tabs.querySelectorAll('[data-workspace]')) {
      if (button.dataset.workspace === event.detail.id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  });
  // Include the menu bar and workspace tabs, which sit above the backdrop.
  document.addEventListener('click', event => {
    if (global.OpenLiveCoverEditor?.isOpen()) return;
    if (!backdrop.hidden && !$('showave-start-panel').contains(event.target)) {
      hideSplash();
      // The Home logo also toggles the visible card closed.
      if ($('showaveHomeButton')?.contains(event.target)) event.stopPropagation();
    }
  }, true);
  backdrop.addEventListener('click', event => {
    if (global.OpenLiveCoverEditor?.isOpen()) {
      return;
    }
    if (event.target === backdrop) { hideSplash(); return; }
    const action = event.target.closest('[data-start-action]');
    if (action) {
      if (action.dataset.startAction === 'new') runNew();
      else if (action.dataset.startAction === 'open') runOpen();
      else if (action.dataset.startAction === 'recover') runRecover();
      return;
    }
    const recent = event.target.closest('[data-recent-id]');
    if (recent) runRecent(recent.dataset.recentId);
    const tool = event.target.closest('[data-start-panel]');
    if (tool) { openHomeTool(tool.dataset.startPanel); return; }
    const workspace = event.target.closest('[data-start-workspace]');
    if (workspace) openWorkspace(workspace.dataset.startWorkspace);
  });
  $('showave-start-close').addEventListener('click', hideSplash);
  $('showave-start-more').addEventListener('click', () => { showAllRecent = !showAllRecent; renderRecent(); });
  backdrop.addEventListener('keydown', event => {
    if (backdrop.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); hideSplash(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...backdrop.querySelectorAll('button:not([disabled]), summary, a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
      .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  global.addEventListener('focus', () => { if (!backdrop.hidden) refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !backdrop.hidden) refresh(); });

  global.OpenLiveStartSplash = Object.freeze({ showSplash, hideSplash, openMirror,
    isMirrorOpen: () => !backdrop.hidden && mirrorExpanded });
  if (global.__showaveSplashRequested || !global.__showaveSkipStartupSplash) showSplash();
})(window);
