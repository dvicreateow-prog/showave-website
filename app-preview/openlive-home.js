(function installHome(global) {
  'use strict';

  const workspaces = [
    { id: 'show', title: 'Show', detail: 'Clips, cues and live mixing', route: 'index.html', icon: 'creative-icons/video.svg', accent: '#e9a16a' },
    { id: 'broadcast', title: 'Broadcast', detail: 'Scenes, graphics and streaming', route: 'broadcast.html', icon: 'obs-icons/sources/camera.svg', accent: '#75aaff' },
    { id: 'timeline', title: 'Timeline', detail: 'Timecoded show automation', route: 'timeline.html', icon: 'creative-icons/cue.svg', accent: '#e6b965' },
    { id: 'forge', title: 'Forge', detail: 'Node workspace', preview: true, route: 'wire.html', icon: 'creative-icons/position.svg', accent: '#d08cc5' },
    { id: 'map', title: 'Map', detail: 'Outputs and projection mapping', route: 'advanced-output.html', icon: 'creative-icons/corners.svg', accent: '#e78c77' },
    { id: 'encode', title: 'Encode', detail: 'Trim and prepare media', route: 'alley.html', icon: 'creative-icons/crop.svg', accent: '#91bb76' },
    { id: 'preferences', title: 'Preferences', route: 'preferences.html', icon: 'obs-icons/cogs.svg' }
  ];
  const byId = new Map(workspaces.map(item => [item.id, item]));
  const desktop = global.OpenLiveDesktop;
  const projects = global.OpenLiveProjects;
  const browserWindows = new Map();
  const pendingWorkspaces = new Set();
  const $ = id => document.getElementById(id);
  let recentShows = [];
  let recovery = null;
  let projectBusy = false;
  let recentLoadError = false;
  let refreshRevision = 0;

  function icon(asset, className) {
    const element = document.createElement('span');
    element.className = 'icon ' + (className || '');
    element.setAttribute('aria-hidden', 'true');
    element.style.setProperty('--icon', 'url("assets/' + asset + '")');
    return element;
  }

  function status(message, error) {
    $('homeStatus').textContent = message || '';
    $('homeStatus').classList.toggle('is-error', !!error);
  }

  function readableDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function renderWorkspaces() {
    const query = $('workspaceSearch').value.trim().toLowerCase();
    const items = workspaces.filter(item => item.id !== 'preferences' &&
      (item.title + ' ' + item.detail).toLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace';
      button.dataset.workspace = item.id;
      button.style.setProperty('--workspace-accent', item.accent);
      button.disabled = pendingWorkspaces.has(item.id);
      button.append(icon(item.icon, 'workspace-icon'), icon('creative-icons/forward.svg', 'launch-icon'));
      const title = document.createElement('strong');
      title.textContent = item.title;
      if (item.preview) {
        const badge = document.createElement('span');
        badge.className = 'preview-tag';
        badge.textContent = 'Preview';
        title.append(badge);
      }
      const detail = document.createElement('span');
      detail.className = 'workspace-detail';
      detail.textContent = item.detail;
      button.append(title, detail);
      fragment.append(button);
    });
    $('workspaceGrid').replaceChildren(fragment);
    $('workspaceCount').textContent = items.length + (items.length === 1 ? ' workspace' : ' workspaces');
    $('noMatches').hidden = items.length > 0;
  }

  function renderRecent() {
    const query = $('workspaceSearch').value.trim().toLowerCase();
    const view = location.hash.slice(1);
    const matching = recentShows.filter(item => (item.name || 'Untitled Show').toLowerCase().includes(query));
    const visible = view === 'recent' ? matching : matching.slice(0, 4);
    const fragment = document.createDocumentFragment();
    visible.forEach(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-row';
      button.dataset.projectId = entry.id;
      button.disabled = projectBusy;
      button.setAttribute('aria-label', 'Open ' + (entry.name || 'Untitled Show'));
      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = entry.name || 'Untitled Show';
      const date = document.createElement('span');
      date.className = 'recent-date';
      date.textContent = [entry.copyOnly ? 'saved copy' : '', readableDate(entry.updatedAt)].filter(Boolean).join(' · ');
      button.append(icon('creative-icons/video.svg', 'recent-icon'), title, date, icon('creative-icons/forward.svg', 'recent-arrow'));
      fragment.append(button);
    });
    $('recentList').replaceChildren(fragment);
    $('recentEmpty').hidden = visible.length > 0;
    $('recentEmpty').textContent = recentLoadError ? 'Recent shows could not be loaded.' :
      query && recentShows.length ? 'No matching recent shows.' :
      'No recent shows yet. Open a saved show to see it here.';
    $('allRecent').hidden = view === 'recent';
  }

  function renderRecovery() {
    const button = $('recoverLastSession');
    button.disabled = projectBusy || !recovery;
    const detail = $('recoveryDetail');
    const savedAt = recovery && readableDate(recovery.savedAt || recovery.updatedAt);
    detail.textContent = recovery ?
      'Restore unsaved work' + (savedAt ? ' from ' + savedAt : '') + '.' :
      'No recoverable show is available.';
  }

  function setProjectBusy(busy) {
    projectBusy = busy;
    $('newShow').disabled = busy;
    $('openShow').disabled = busy;
    renderRecovery();
    renderRecent();
  }

  async function refreshProjects() {
    const revision = ++refreshRevision;
    if (!projects || typeof projects.list !== 'function' || typeof projects.getRecovery !== 'function') {
      recentShows = [];
      recovery = null;
      recentLoadError = true;
      renderRecent();
      renderRecovery();
      status('Show files are unavailable. Workspaces can still be opened.', true);
      return;
    }
    const [listResult, recoveryResult] = await Promise.allSettled([
      Promise.resolve().then(() => projects.list()),
      Promise.resolve().then(() => projects.getRecovery())
    ]);
    if (revision !== refreshRevision) return;
    recentLoadError = listResult.status === 'rejected';
    recentShows = listResult.status === 'fulfilled' && Array.isArray(listResult.value) ?
      listResult.value.filter(item => item && item.id != null).map(item => ({
        id: String(item.id), name: typeof item.name === 'string' ? item.name : '',
        updatedAt: item.updatedAt, copyOnly: item.copyOnly === true
      })).sort((a, b) => (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0)) : [];
    recovery = recoveryResult.status === 'fulfilled' && recoveryResult.value && typeof recoveryResult.value.text === 'string' ? recoveryResult.value : null;
    renderRecent();
    renderRecovery();
    if (recentLoadError && !projectBusy) status('Recent shows could not be loaded. You can still open a show file.', true);
  }

  function reserveBrowserWindow(id) {
    const item = byId.get(id);
    if (id === 'show') seedShowFromOpener();
    let child = browserWindows.get(id);
    if (!child || child.closed) {
      // This runs directly in the click handler, before an asynchronous file
      // picker can consume the browser's popup activation.
      child = global.open('', 'showave-home-' + id);
      if (!child) throw new Error('The browser blocked the workspace window. Allow pop-ups and try again.');
      browserWindows.set(id, child);
    }
    let href;
    try { href = child.location.href; }
    catch (_) { throw new Error('The existing workspace window is outside SHOWAVE. Close it before reopening from Home.'); }
    const blank = href === 'about:blank';
    const route = new URL(item.route, location.href);
    if (!blank) {
      const current = new URL(href);
      if (current.origin !== route.origin || current.pathname !== route.pathname) {
        throw new Error('The named workspace window has another page open. Close it before reopening from Home.');
      }
    }
    return { child, blank };
  }

  function activateBrowserWindow(id, target) {
    if (!target || !target.child || target.child.closed) throw new Error('The workspace window was closed. Please try again.');
    if (target.blank) target.child.location.replace(new URL(byId.get(id).route, location.href).href);
    target.child.focus();
  }

  function knownBrowserShowWindow() {
    seedShowFromOpener();
    const child = browserWindows.get('show');
    if (!child || child.closed) return null;
    try {
      const current = new URL(child.location.href);
      const show = new URL(byId.get('show').route, location.href);
      return current.origin === show.origin && current.pathname === show.pathname ? { child, blank: false } : null;
    } catch (_) { return null; }
  }

  function seedShowFromOpener() {
    const child = global.opener;
    if (!child || child.closed) return;
    try {
      const current = new URL(child.location.href);
      const show = new URL(byId.get('show').route, location.href);
      if (current.origin === show.origin && current.pathname === show.pathname) browserWindows.set('show', child);
    } catch (_) {}
  }

  async function openWorkspace(id) {
    const item = byId.get(id);
    if (!item || pendingWorkspaces.has(id)) return;
    let target;
    try {
      if (!desktop || typeof desktop.openWorkspace !== 'function') target = reserveBrowserWindow(id);
    } catch (error) {
      status(error.message, true);
      return;
    }
    pendingWorkspaces.add(id);
    renderWorkspaces();
    status('Opening ' + item.title + '…');
    try {
      if (desktop && typeof desktop.openWorkspace === 'function') await desktop.openWorkspace(id);
      else activateBrowserWindow(id, target);
      status(item.title + ' is open.');
    } catch (error) {
      status(error && error.message ? error.message : 'The workspace could not be opened. Please try again.', true);
    } finally {
      pendingWorkspaces.delete(id);
      renderWorkspaces();
    }
  }

  function projectRequestId() {
    return global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() :
      'home-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  async function browserTargetId(target) {
    if (!target) return null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (target.child.closed) throw new Error('The Show window was closed before it started.');
      try {
        const id = target.child.ShowaveProjectWindowId;
        if (typeof id === 'string' && id) return id;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The Show window did not finish starting. Check that window and try again.');
  }

  async function sendToShow(action, documentData, target) {
    if (typeof global.BroadcastChannel !== 'function') return Promise.reject(new Error('This browser cannot connect Home to Show.'));
    const targetId = await browserTargetId(target);
    const channel = new global.BroadcastChannel('showave-project-actions-v1');
    const request = { type: 'request', id: projectRequestId(), action };
    if (documentData) request.document = documentData;
    if (targetId) request.targetId = targetId;
    return new Promise((resolve, reject) => {
      let active = true;
      let retryTimer;
      let warningTimer;
      let deadlineTimer;
      let attempts = 0;
      function finish(error, reply) {
        if (!active) return;
        active = false;
        clearInterval(retryTimer);
        clearTimeout(warningTimer);
        clearTimeout(deadlineTimer);
        channel.close();
        if (error) reject(error);
        else resolve(reply);
      }
      channel.onmessage = event => {
        const reply = event.data;
        if (!reply || reply.type !== 'ack' || reply.id !== request.id) return;
        finish(null, reply);
      };
      const send = () => {
        if (target && target.child.closed) return finish(new Error('The Show window was closed before it responded.'));
        try { channel.postMessage(request); }
        catch (error) { return finish(error); }
        if (++attempts % 5 === 0 && desktop && typeof desktop.listWorkspaces === 'function') {
          Promise.resolve().then(() => desktop.listWorkspaces()).then(state => {
            if (!active || !state || !Array.isArray(state.workspaces)) return;
            const show = state.workspaces.find(item => item.id === 'show');
            if (show && !show.open) finish(new Error('The Show window was closed before it responded.'));
          }).catch(() => {});
        }
      };
      send();
      if (active) {
        retryTimer = setInterval(send, 400);
        warningTimer = setTimeout(() => { if (active) status('Waiting for Show to respond. Finish any confirmation in Show…'); }, 8000);
        deadlineTimer = setTimeout(() => finish(new Error('Show did not respond. Check the Show window and try again.')), 180000);
      }
    });
  }

  async function projectAction(kind, recentId) {
    if (projectBusy) return;
    let target;
    try {
      // Open Show invokes a native file picker on the click activation. A
      // browser popup could consume that activation, so Open uses an existing
      // Show window or a same-tab handoff after the file has been chosen.
      if (kind !== 'open' && (!desktop || typeof desktop.openWorkspace !== 'function')) target = reserveBrowserWindow('show');
    } catch (error) {
      status(error.message, true);
      return;
    }
    setProjectBusy(true);
    status(kind === 'new' ? 'Starting a new show…' : kind === 'recover' ? 'Checking the last session…' : 'Opening show…');
    try {
      let documentData;
      let action = kind === 'new' ? 'new' : 'open';
      if (kind === 'open') {
        if (!projects || typeof projects.open !== 'function') throw new Error('Show files are unavailable.');
        documentData = await projects.open();
      } else if (kind === 'recent') {
        if (!projects || typeof projects.openRecent !== 'function') throw new Error('Recent shows are unavailable.');
        documentData = await projects.openRecent(recentId);
      } else if (kind === 'recover') {
        if (!projects || typeof projects.getRecovery !== 'function') throw new Error('Recovery is unavailable.');
        const snapshot = await projects.getRecovery();
        if (snapshot && typeof snapshot.text === 'string') documentData = {
          name: 'Recovered Show.openlive.json', text: snapshot.text,
          recoveryId: snapshot.recoveryId
        };
      }
      if (action === 'open' && !documentData) {
        if (target && target.blank && !target.child.closed) target.child.close();
        if (kind === 'open') status('Open Show cancelled.');
        else status(kind === 'recover' ? 'No recoverable show is available.' : 'This recent show is unavailable.', kind !== 'open');
        return;
      }
      if (kind === 'open' && (!desktop || typeof desktop.openWorkspace !== 'function')) {
        target = knownBrowserShowWindow();
        if (!target) {
          if (!documentData.recentSaved || !documentData.id) {
            throw new Error('The selected Show could not be stored for opening in this tab. Open Show from an already open Show window and try again.');
          }
          const route = new URL(byId.get('show').route, location.href);
          route.searchParams.set('showaveProject', documentData.id);
          global.location.assign(route.href);
          return;
        }
      }
      if (desktop && typeof desktop.openWorkspace === 'function') await desktop.openWorkspace('show');
      else activateBrowserWindow('show', target);
      const reply = await sendToShow(action, documentData, target);
      if (reply.status === 'ok') {
        status(kind === 'new' ? 'A new show is ready.' : kind === 'recover' ? 'Your last session is open as a new show.' : 'Show opened.');
        await refreshProjects();
      } else if (reply.status === 'cancel') {
        status(reply.message || 'The action was cancelled in Show.');
      } else {
        status(reply.message || 'Show could not complete the action.', true);
      }
    } catch (error) {
      if (target && target.blank) {
        try { if (!target.child.closed && target.child.location.href === 'about:blank') target.child.close(); }
        catch (_) {}
      }
      status(error && error.message ? error.message : 'The show could not be opened. Please try again.', true);
    } finally {
      setProjectBusy(false);
    }
  }

  function showView() {
    const requested = location.hash.slice(1);
    const view = ['recent', 'workspaces', 'news'].includes(requested) ? requested : 'home';
    $('pageHeading').textContent = { home: 'Home', recent: 'Recent Shows', workspaces: 'Workspaces', news: "What's new" }[view];
    $('actionsSection').hidden = view !== 'home';
    $('recentSection').hidden = view !== 'home' && view !== 'recent';
    $('workspaceSection').hidden = view !== 'home' && view !== 'workspaces';
    $('newsSection').hidden = view !== 'news';
    document.querySelectorAll('[data-view]').forEach(link => {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    renderRecent();
  }

  document.addEventListener('click', event => {
    const action = event.target.closest('[data-project-action]');
    if (action) { projectAction(action.dataset.projectAction); return; }
    const recent = event.target.closest('[data-project-id]');
    if (recent) { projectAction('recent', recent.dataset.projectId); return; }
    const workspace = event.target.closest('[data-workspace]');
    if (workspace) openWorkspace(workspace.dataset.workspace);
  });
  $('workspaceSearch').addEventListener('input', () => {
    if (location.hash === '#news') location.hash = '#home';
    renderWorkspaces();
    renderRecent();
  });
  global.addEventListener('hashchange', showView);
  global.addEventListener('focus', refreshProjects);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshProjects(); });
  if (desktop && desktop.version) $('releaseVersion').textContent = 'Preview ' + desktop.version;
  seedShowFromOpener();
  renderWorkspaces();
  showView();
  refreshProjects();
})(window);
