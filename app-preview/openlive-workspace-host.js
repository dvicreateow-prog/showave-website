(function installWorkspaceHost(global) {
  'use strict';
  if (global.OpenLiveWorkspaceHost || global.parent !== global) return;
  const app = document.getElementById('app');
  if (!app) return;

  // Keep Show's original document and one browsing context for each tool.
  // Switching workspaces must never reload the show or its live output.
  const routes = Object.freeze([
    Object.freeze({ id: 'show', title: 'Show', route: 'index.html', root: '#app' }),
    Object.freeze({ id: 'broadcast', title: 'Broadcast', route: 'broadcast.html', root: '.bc-navigation-tabs' }),
    Object.freeze({ id: 'timeline', title: 'Timeline', route: 'timeline.html', root: '#timelineRoot' }),
    Object.freeze({ id: 'forge', title: 'Forge', route: 'wire.html', root: '#wireRoot' }),
    Object.freeze({ id: 'map', title: 'Map', route: 'advanced-output.html', root: '#aoRoot' }),
    Object.freeze({ id: 'encode', title: 'Encode', route: 'alley.html', root: '#alleyRoot' }),
    Object.freeze({ id: 'chaser', title: 'Chaser', route: 'chaser.html', root: '#chaserRoot', utility:true })
  ]);
  const byId = new Map(routes.map(route => [route.id, route]));
  const records = new Map();
  const detached = new Map();
  const dragTokens = new Map();
  const tabOrder = routes.filter(route => !route.utility).map(route => route.id);
  const boundTabs = new WeakSet();
  const boundPointerTabs = new WeakSet(), clickBlocked = new WeakSet();
  const DRAG_TYPE = 'application/x-showave-workspace-drag';
  const DRAG_TTL = 60000;
  const suspended = new Map();
  const pickerKinds = new Set(['files', 'folder', 'pdf', 'powerpoint', 'image', 'audio', 'video']);
  const windowCommands = new Set(['minimize', 'maximize', 'restore', 'always-on-top']);
  let activeId = 'show', activation = 0, observedShell = null, tabDrag = null, tabMenu = null,
    pointerDrag = null, ownerScreenOffset = null, focusedArea = null;

  const style = document.createElement('style');
  style.id = 'showave-workspace-host-style';
  style.textContent = `
    #showave-workspace-host { position:fixed; z-index:930; top:0; right:0; bottom:0; left:var(--showave-rail-width,0px); overflow:hidden; background:#252525; }
    #showave-workspace-host[hidden], #showave-workspace-host [hidden] { display:none !important; }
    #showave-workspace-host iframe { position:absolute; inset:0; width:100%; height:100%; border:0; background:#252525; }
    #showave-workspace-host-status { position:absolute; z-index:1; inset:0; display:grid; place-content:center; gap:10px; padding:24px; color:#c8c8c8; background:#252525; font:12px/1.5 "Segoe UI",Arial,sans-serif; text-align:center; }
    #showave-workspace-host-status button { justify-self:center; padding:5px 14px; border:1px solid #555; border-radius:2px; background:#333; color:#eee; font:inherit; cursor:pointer; }
    [data-showave-workspace-suspended] { visibility:hidden !important; }
    #showave-workspace-host[data-retained-only] { background:transparent; pointer-events:none; }
    #showave-workspace-host iframe[data-detached-owner] { opacity:.0001; pointer-events:none; z-index:0; }
    #showave-workspace-host iframe:not([data-detached-owner]) { z-index:1; }
  `;
  document.head.append(style);
  const host = document.createElement('section');
  host.id = 'showave-workspace-host';
  host.setAttribute('aria-label', 'SHOWAVE workspace');
  host.hidden = true;
  const loading = document.createElement('div');
  loading.id = 'showave-workspace-host-status';
  loading.setAttribute('role', 'status');
  loading.hidden = true;
  host.append(loading);
  document.body.append(host);

  // Map is already Show's retained programme renderer. Move it while blank,
  // before app.js starts, instead of creating a competing output owner.
  const mapFrame = document.getElementById('advancedOutputFrame');
  if (mapFrame) {
    mapFrame.name = 'showave-workspace-map';
    mapFrame.dataset.showaveWorkspaceFrame = 'map';
    host.append(mapFrame);
  }

  function frameUrl(route) {
    const url = new URL(route.route, global.location.href);
    url.searchParams.set('showaveWorkspace', '1');
    if (route.id === 'broadcast') url.searchParams.set('ui', 'control-room-4');
    return url;
  }

  function trustedRecord(record) {
    try {
      const child = record.frame.contentWindow;
      const actual = new URL(child.location.href);
      const expected = new URL(record.route.route, global.location.href);
      return record.frame.isConnected && child.parent === global &&
        actual.origin === expected.origin && actual.pathname === expected.pathname &&
        actual.searchParams.get('showaveWorkspace') === '1' &&
        !actual.username && !actual.password;
    } catch (_) { return false; }
  }

  function guardBridge(record) {
    if (!trustedRecord(record)) throw new Error('This workspace is no longer connected to SHOWAVE.');
  }

  function installChildBridge(record) {
    if (!trustedRecord(record)) return;
    const child = record.frame.contentWindow;
    const desktop = global.OpenLiveDesktop;
    if (desktop && !child.OpenLiveDesktop) {
      // Native calls still originate in the trusted top frame. Embedded tools
      // receive file capabilities and picker choices, never arbitrary paths
      // or the Show project/recovery store.
      child.OpenLiveDesktop = Object.freeze({
        platform: desktop.platform, version: desktop.version, nativeWindowFrame: true,
        resolveOriginal(file) {
          guardBridge(record);
          try {
            // A file chosen in a detached shared view belongs to that view's
            // realm. Native getters verify its File/Blob brand without losing
            // the original browser file capability through reconstruction.
            Object.getOwnPropertyDescriptor(child.File.prototype,'name').get.call(file);
            Object.getOwnPropertyDescriptor(child.File.prototype,'lastModified').get.call(file);
            Object.getOwnPropertyDescriptor(child.Blob.prototype,'size').get.call(file);
          } catch (_) { throw new TypeError('Choose an original file from this computer.'); }
          return desktop.resolveOriginal(file);
        },
        selectOriginalFiles(options = {}) {
          guardBridge(record);
          if (!pickerKinds.has(options.kind)) throw new Error('Unknown file selection.');
          return desktop.selectOriginalFiles({ kind: options.kind });
        },
        ...(typeof desktop.getHardwareProfile === 'function' ? {
          getHardwareProfile() { guardBridge(record); return desktop.getHardwareProfile(); }
        } : {}),
        openWorkspace(id) { guardBridge(record); return activate(id); },
        listWorkspaces() {
          guardBridge(record);
          return Promise.resolve({ workspaces: routes.map(route => ({ id: route.id, title: route.title,
            open: route.id === 'show' || records.has(route.id), active: route.id === activeId })), sessionOnly: true });
        },
        windowAction(command) {
          guardBridge(record);
          if (command === 'close') return activate('show');
          if (!windowCommands.has(command)) throw new Error('Unknown window command.');
          return desktop.windowAction(command);
        }
      });
    }
    child.OpenLiveWorkspaceHost = Object.freeze({
      activate(id) { guardBridge(record); return activate(id); },
      current() { guardBridge(record); return activeId; },
      undock(id) { guardBridge(record); return undock(id); },
      redock(id, options) { guardBridge(record); return redock(id, options); },
      state() { guardBridge(record); return state(); },
      hasDetachedView(id) { guardBridge(record); return hasDetachedView(id); },
      setAreaFocus(focused) { guardBridge(record); return setAreaFocus(record.route.id, focused === true); },
      routes
    });
    const doc = child.document;
    child.addEventListener('showave:areas-changed', () => {
      if (trustedRecord(record))
        global.dispatchEvent(new CustomEvent('showave:workspace-ready', { detail: { id: record.route.id } }));
    });
    if (!doc.getElementById('showave-workspace-embedded-style')) {
      const embeddedStyle = doc.createElement('style');
      embeddedStyle.id = 'showave-workspace-embedded-style';
      embeddedStyle.textContent = '.win-title{display:none !important}';
      doc.head.append(embeddedStyle);
    }
    // Links between modules return through the parent shell so Show's live
    // document survives a Broadcast "SHOWAVE Live" link as well as tab clicks.
    doc.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!anchor || anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self') return;
      let url;
      try { url = new URL(anchor.href, child.location.href); } catch (_) { return; }
      if (url.origin !== global.location.origin) return;
      const route = routes.find(item => new URL(item.route, global.location.href).pathname === url.pathname);
      if (route) { event.preventDefault(); activate(route.id).catch(showError); }
      else if (/\/openlive-home\.html$/i.test(url.pathname)) {
        event.preventDefault(); global.OpenLiveStartSplash?.showSplash();
      }
    }, true);
    notifyVisibility(record);
  }

  function hasDetachedView(id) {
    const entry = detached.get(id);
    return !!entry && !entry.popup.closed;
  }

  function notifyVisibility(record) {
    if (!trustedRecord(record)) return;
    const child = record.frame.contentWindow;
    const separate = hasDetachedView(record.route.id);
    const visible = record.route.id === activeId || separate;
    child.__showaveWorkspaceActive = visible;
    child.__showaveWorkspaceDetached = separate;
    child.dispatchEvent(new child.CustomEvent('showave:workspace-visibility', {
      detail: { active: visible, detached:separate, id: record.route.id }
    }));
  }

  function mapVisibility(visible) {
    const record = records.get('map');
    if (!record || !trustedRecord(record)) return;
    try {
      const api = record.frame.contentWindow.__openliveOutput;
      if (api?.setUiVisible) api.setUiVisible(visible);
      if (visible && typeof global.__openliveEnsureAdvancedOutputWorkspace === 'function')
        global.__openliveEnsureAdvancedOutputWorkspace();
    } catch (_) {}
  }

  function setAreaFocus(id, focused) {
    if (!focused) {
      if (!focusedArea || focusedArea.id !== id) return false;
      for (const [name,value,priority] of focusedArea.styles)
        value ? host.style.setProperty(name,value,priority) : host.style.removeProperty(name);
      focusedArea = null; delete host.dataset.areaFocus;
      const record = records.get(id);
      if (record && trustedRecord(record)) {
        const child = record.frame.contentWindow;
        child.dispatchEvent(new child.Event('showave:area-focus-ended'));
      }
      return true;
    }
    const record = records.get(id);
    if (id !== activeId || hasDetachedView(id) || !record || !trustedRecord(record)) return false;
    if (focusedArea?.id === id) return true;
    if (focusedArea) setAreaFocus(focusedArea.id,false);
    focusedArea = {id,styles:['top','left','z-index','transition','border-radius'].map(name =>
      [name,host.style.getPropertyValue(name),host.style.getPropertyPriority(name)])};
    host.dataset.areaFocus = id;
    host.style.setProperty('transition','none','important');
    host.style.setProperty('border-radius','0','important');
    host.style.setProperty('top','0','important');
    host.style.setProperty('left','0','important');
    host.style.setProperty('z-index','200000','important');
    return true;
  }

  function positionHost() {
    const chrome = document.getElementById('menubar') || document.getElementById('showave-workspace-tabs');
    if (!chrome) return;
    if (!focusedArea) host.style.top = Math.max(0, chrome.getBoundingClientRect().bottom) + 'px';
    if (observedShell !== chrome && typeof ResizeObserver === 'function') {
      observedShell = chrome;
      new ResizeObserver(positionHost).observe(chrome);
    }
  }

  function suspendShow(value) {
    if (value) {
      const elements = [...app.children, ...document.body.children];
      elements.forEach(element => {
        if (element === app || element === host || element.id === 'showave-start-shell' || element.id === 'menubar' || element.id === 'showave-source-rail' ||
            element.id === 'showave-workspace-notice' || element.classList?.contains('ol-area-menu') ||
            element.id === 'openlive-performance-toggle' || element.id === 'openlive-performance-panel' ||
            ['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName) || suspended.has(element)) return;
        suspended.set(element, { inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('data-showave-workspace-suspended', '');
      });
    } else {
      suspended.forEach((original, element) => {
        element.inert = original.inert;
        if (original.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', original.ariaHidden);
        element.removeAttribute('data-showave-workspace-suspended');
      });
      suspended.clear();
    }
  }

  function showError(error) {
    loading.replaceChildren();
    const message = document.createElement('span');
    message.textContent = error?.message || 'This workspace could not be opened.';
    const back = document.createElement('button');
    back.type = 'button'; back.textContent = 'Return to Show';
    back.addEventListener('click', () => activate('show'));
    loading.append(message, back); loading.hidden = false;
  }

  function createRecord(route) {
    const frame = route.id === 'map' && mapFrame ? mapFrame : document.createElement('iframe');
    if (route.id !== 'map' || !mapFrame) frame.id = 'showave-workspace-frame-' + route.id;
    frame.name = 'showave-workspace-' + route.id;
    frame.dataset.showaveWorkspaceFrame = route.id;
    frame.title = 'SHOWAVE ' + route.title;
    frame.setAttribute('allow', 'camera; microphone; display-capture; autoplay; fullscreen; clipboard-write; window-management; midi');
    frame.hidden = true;
    if (frame.parentElement !== host) host.append(frame);
    const record = { route, frame, ready: false, promise: null };
    records.set(route.id, record);
    record.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(route.title + ' did not finish loading. Return to Show and try again.')), 45000);
      const loaded = () => {
        try {
          if (!trustedRecord(record)) throw new Error(route.title + ' opened an unexpected page.');
          // Map has several editions; its output API is the stable readiness
          // marker rather than a particular editor root's historical ID.
          if (route.id === 'map' ? !frame.contentWindow.__openliveOutput : !frame.contentDocument.querySelector(route.root))
            throw new Error(route.title + ' could not load its editor.');
          installChildBridge(record); record.ready = true; clearTimeout(timer);
          global.dispatchEvent(new CustomEvent('showave:workspace-ready', { detail: { id: route.id } }));
          if (activeId === route.id) loading.hidden = true;
          mapVisibility(activeId === 'map' || detached.has('map'));
          resolve(record);
        } catch (error) { clearTimeout(timer); reject(error); }
      };
      frame.addEventListener('load', loaded, { once: true });
      const existing = frame.getAttribute('src');
      if (existing && trustedRecord(record) && route.id === 'map' && frame.contentWindow.__openliveOutput) {
        frame.removeEventListener('load', loaded); loaded();
      } else if (!existing) frame.src = frameUrl(route).href;
    });
    return record;
  }

  async function activate(id) {
    if (focusedArea && focusedArea.id !== id) setAreaFocus(focusedArea.id,false);
    if (id === 'home') { global.OpenLiveStartSplash?.showSplash(); return { id: activeId }; }
    const route = byId.get(id);
    if (!route) throw new Error('Unknown SHOWAVE workspace.');
    const separate = detached.get(id);
    if (separate && !separate.popup.closed) {
      separate.popup.focus();
      return { id, title:route.title, ready:!!separate.mounted, detached:true };
    }
    if (separate) redock(id, {activate:false, close:false});
    if (!tabOrder.includes(id)) { tabOrder.push(id); tabsChanged(); }
    const revision = ++activation;
    activeId = id;
    document.body.dataset.showaveWorkspace = id;
    updateHostPresentation(); positionHost();
    loading.hidden = true;
    mapVisibility(id === 'map' || detached.has('map'));
    global.dispatchEvent(new CustomEvent('showave:workspace-changed', { detail: { id, title: route.title } }));
    if (id === 'show') return { id, title: route.title, ready: true };
    let record = records.get(id);
    if (!record) record = createRecord(route);
    record.frame.hidden = false;
    if (!record.ready) { loading.textContent = 'Opening ' + route.title + '…'; loading.hidden = false; }
    try {
      await record.promise;
      if (revision === activation) {
        loading.hidden = true; mapVisibility(id === 'map' || detached.has('map')); record.frame.focus();
      }
      return { id, title: route.title, ready: true };
    } catch (error) { if (revision === activation) showError(error); throw error; }
  }

  function state() {
    return {activeId, order:tabOrder.slice(), workspaces:routes.map(route => ({
      id:route.id,title:route.title,ready:route.id === 'show' || !!records.get(route.id)?.ready,
      detached:detached.has(route.id),nonce:detached.get(route.id)?.nonce || null
    }))};
  }

  function tabsChanged() {
    global.dispatchEvent(new CustomEvent('showave:workspace-tabs-changed',{detail:state()}));
  }

  function updateHostPresentation() {
    const retainedOnly = activeId === 'show' && !detached.has('show');
    const hasDetachedTools = [...detached.keys()].some(id => id !== 'show');
    host.hidden = retainedOnly && !hasDetachedTools;
    host.toggleAttribute('data-retained-only',retainedOnly && hasDetachedTools);
    suspendShow(!retainedOnly);
    records.forEach(record => {
      const separate = detached.get(record.route.id);
      record.frame.hidden = record.route.id !== activeId && !separate;
      record.frame.toggleAttribute('data-detached-owner',!!separate);
      if (!separate) {
        record.frame.style.removeProperty('width'); record.frame.style.removeProperty('height');
      }
      notifyVisibility(record);
    });
  }

  function notify(message) {
    let node = document.getElementById('showave-workspace-notice');
    if (!node) {
      node = document.createElement('div'); node.id = 'showave-workspace-notice';
      node.className = 'ol-area-notice'; node.setAttribute('role','status');
      node.setAttribute('aria-live','polite'); document.body.append(node);
    }
    node.textContent = message; node.hidden = false;
    clearTimeout(node._workspaceTimer);
    node._workspaceTimer = setTimeout(() => { node.hidden = true; },6000);
    global.dispatchEvent(new CustomEvent('showave:workspace-notice',{detail:{message}}));
  }

  function trustedPopup(entry,popup = entry?.popup) {
    try {
      if (!entry || popup !== entry.popup || popup.closed || popup.opener !== global) return false;
      const url = new URL(popup.location.href), expected = new URL('workspace-window.html',global.location.href);
      return url.origin === expected.origin && url.pathname === expected.pathname && !url.hash &&
        [...url.searchParams.keys()].length === 2 && url.searchParams.get('workspace') === entry.id &&
        url.searchParams.get('nonce') === entry.nonce && !url.username && !url.password;
    } catch (_) { return false; }
  }

  function resizeDetachedOwner(entry) {
    const frame = records.get(entry.id)?.frame;
    if (!trustedPopup(entry)) return;
    const view = entry.popup.document.getElementById('showave-detached-view');
    const bounds = view?.getBoundingClientRect();
    const width = Math.max(320,Math.round(bounds?.width || entry.popup.innerWidth || 960));
    const height = Math.max(200,Math.round(bounds?.height || entry.popup.innerHeight || 640));
    if (entry.id === 'show') {
      const editor = document.getElementById('showave-areas-show');
      if (!editor) return;
      if (!entry.showSizing) {
        const properties = ['width','height','flex','min-height'];
        entry.showSizing = {editor,properties:properties.map(name => ({name,
          value:editor.style.getPropertyValue(name),priority:editor.style.getPropertyPriority(name)}))};
        // Header/font initialization can finish after the shared view mounts.
        // Reserve its final measured footprint as well as the status footer.
        entry.showSizing.observer = new ResizeObserver(() => {
          if (detached.get(entry.id) !== entry || entry.showSizing.pending) return;
          entry.showSizing.pending = global.requestAnimationFrame(() => {
            if (!entry.showSizing) return;
            entry.showSizing.pending = null;
            if (detached.get(entry.id) === entry) resizeDetachedOwner(entry);
          });
        });
        [...app.children].filter(node => node !== editor).forEach(node => entry.showSizing.observer.observe(node));
      }
      // The split manager measures its real owner nodes. Fit that editor to
      // the displayed viewport, while the owner's global menus retain their
      // normal width. No loaded iframe or live control changes documents.
      const editorStyle = global.getComputedStyle(editor);
      const horizontal = (parseFloat(editorStyle.marginLeft) || 0) + (parseFloat(editorStyle.marginRight) || 0);
      let chrome = 0;
      [...app.children].forEach(node => {
        if (node === editor) return;
        const s = global.getComputedStyle(node);
        if (s.display === 'none' || ['absolute','fixed'].includes(s.position)) return;
        chrome += node.getBoundingClientRect().height + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
      });
      editor.style.setProperty('flex','0 0 auto');
      editor.style.setProperty('width',Math.max(0,width-horizontal) + 'px');
      editor.style.setProperty('height',Math.max(0,height-chrome) + 'px');
      editor.style.setProperty('min-height','0');
      return;
    }
    if (!frame) return;
    frame.style.width = width + 'px';
    frame.style.height = height + 'px';
    frame.hidden = false;
    notifyVisibility(records.get(entry.id));
  }

  function emptyWorkspace() {
    activeId = null; document.body.dataset.showaveWorkspace = '';
    updateHostPresentation(); loading.replaceChildren();
    const message = document.createElement('span'); message.textContent = 'Your workspaces are open in separate windows.';
    loading.append(message);
    routes.filter(route => detached.has(route.id)).forEach(route => {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = 'Dock ' + route.title; button.addEventListener('click',() => redock(route.id)); loading.append(button);
    });
    loading.hidden = false;
    global.dispatchEvent(new CustomEvent('showave:workspace-changed',{detail:{id:null,title:'Separate workspaces'}}));
  }

  function nonce() {
    if (typeof global.crypto?.randomUUID !== 'function') throw new Error('This browser cannot securely detach a workspace.');
    return global.crypto.randomUUID();
  }

  function workspaceWindowPlacement(options) {
    const ownerWidth = Math.round(global.innerWidth || 1100), ownerHeight = Math.round(global.innerHeight || 760);
    const ownerX = Number.isFinite(global.screenX) ? global.screenX : 0;
    const ownerY = Number.isFinite(global.screenY) ? global.screenY : 0;
    // A tear-off follows the operator's pointer, including another display.
    if (Number.isFinite(options.screenX) || Number.isFinite(options.screenY)) return {
      width:Math.min(1600,Math.max(640,ownerWidth)),height:Math.min(1200,Math.max(400,ownerHeight)),
      x:Number.isFinite(options.screenX) ? Math.round(options.screenX - 40) : Math.round(ownerX + 48),
      y:Number.isFinite(options.screenY) ? Math.round(options.screenY - 14) : Math.round(ownerY + 48)
    };
    const screen = global.screen || {};
    const left = Number.isFinite(screen.availLeft) ? Math.round(screen.availLeft) : Math.round(ownerX);
    const top = Number.isFinite(screen.availTop) ? Math.round(screen.availTop) : Math.round(ownerY);
    const workWidth = Number.isFinite(screen.availWidth) && screen.availWidth > 0 ? Math.round(screen.availWidth) : ownerWidth;
    const workHeight = Number.isFinite(screen.availHeight) && screen.availHeight > 0 ? Math.round(screen.availHeight) : ownerHeight;
    const margin = 12;
    // Reserve room for earlier title bars rather than filling the owner again.
    const width = Math.max(1,Math.min(1440,Math.max(720,Math.round(ownerWidth * .84)),
      workWidth - margin * 2 - Math.min(192,Math.round(workWidth * .16))));
    const height = Math.max(1,Math.min(1000,Math.max(440,Math.round(ownerHeight * .84)),
      workHeight - margin * 2 - Math.min(192,Math.round(workHeight * .18))));
    const rangeX = Math.max(0,workWidth - margin * 2 - width), rangeY = Math.max(0,workHeight - margin * 2 - height);
    const startX = Math.max(0,Math.min(rangeX,Math.round(ownerX + 48 - left - margin)));
    const startY = Math.max(0,Math.min(rangeY,Math.round(ownerY + 48 - top - margin)));
    const occupied = [...detached.values()].filter(entry => !entry.popup.closed).map(entry => ({
      x:Number.isFinite(entry.popup.screenX) ? Math.round(entry.popup.screenX) : entry.placement?.x,
      y:Number.isFinite(entry.popup.screenY) ? Math.round(entry.popup.screenY) : entry.placement?.y
    }));
    let placement;
    for (let slot = 0; slot < routes.length; slot++) {
      placement = {width,height,x:left + margin + (startX + slot * 32) % (rangeX + 1),
        y:top + margin + (startY + slot * 32) % (rangeY + 1)};
      if (!occupied.some(point => Math.abs(point.x - placement.x) < 8 && Math.abs(point.y - placement.y) < 8)) break;
    }
    return placement;
  }

  function undock(id,options = {}) {
    if (focusedArea?.id === id) setAreaFocus(id,false);
    const route = byId.get(id);
    if (!route) throw new Error('Unknown SHOWAVE workspace.');
    const previous = detached.get(id);
    if (previous && !previous.popup.closed) { previous.popup.focus(); return previous.popup; }
    if (previous) redock(id,{activate:false,close:false});
    const key = nonce(), url = new URL('workspace-window.html',global.location.href);
    url.searchParams.set('workspace',id); url.searchParams.set('nonce',key);
    const placement = workspaceWindowPlacement(options), {width,height,x,y} = placement;
    // Opening happens synchronously during the originating tab/menu gesture;
    // editor readiness is awaited only after the native/browser popup exists.
    const popup = global.open(url.href,'showave_workspace_' + id + '_' + key,
      `popup=yes,width=${width},height=${height},left=${x},top=${y}`);
    if (!popup) { notify('The browser blocked the workspace window. Allow popups, then choose Open in separate window again.'); return null; }
    const index = tabOrder.indexOf(id), home = {index:index < 0 ? tabOrder.length : index,beforeId:tabOrder[index + 1] || null};
    const entry = {id,route,nonce:key,popup,home,placement,dispose:null,mounted:false,mounting:null,resize:null,poll:null};
    detached.set(id,entry); if (index >= 0) tabOrder.splice(index,1);
    if (id !== 'show' && !records.has(id)) createRecord(route);
    records.get(id)?.promise.catch(error => {
      if (detached.get(id) !== entry) return;
      notify(route.title + ' could not finish opening. Its original workspace remains available.');
      redock(id); console.error('SHOWAVE detached workspace',error);
    });
    updateHostPresentation(); mapVisibility(activeId === 'map' || detached.has('map')); tabsChanged();
    entry.poll = setInterval(() => {
      if (popup.closed || entry.mounted && !trustedPopup(entry)) redock(id,{close:!popup.closed});
    },350);
    if (activeId === id) {
      const next = tabOrder.includes('show') ? 'show' : tabOrder[Math.min(home.index,tabOrder.length - 1)];
      if (next) void activate(next).catch(showError); else emptyWorkspace();
    }
    return popup;
  }

  function reorder(id,beforeId) {
    const index = tabOrder.indexOf(id);
    if (index < 0 || beforeId === id) return index >= 0;
    if (beforeId != null && !tabOrder.includes(beforeId)) return false;
    tabOrder.splice(index,1);
    const target = beforeId == null ? tabOrder.length : tabOrder.indexOf(beforeId);
    tabOrder.splice(target,0,id); tabsChanged(); return true;
  }

  function redock(id,options = {}, nativeRestored = false) {
    const entry = detached.get(id);
    if (!entry) return false;
    if (options.beforeId != null && (!byId.has(options.beforeId) || !tabOrder.includes(options.beforeId))) return false;
    const nativeReturn = global.OpenLiveDesktop?.workspaceWindows?.returnToOwner;
    if (!nativeRestored && options.close !== false && !entry.popup.closed &&
        trustedPopup(entry) && typeof nativeReturn === 'function') {
      if (entry.returning) return true;
      entry.returning = true;
      // Keep the working view and its Dock button until native restoration is
      // confirmed. A rejected request must remain safely retryable.
      Promise.resolve().then(() => nativeReturn({id,nonce:entry.nonce})).then(() => {
        if (detached.get(id) === entry) redock(id,options,true);
      },error => {
        if (detached.get(id) !== entry) return;
        entry.returning = false;
        const message = error?.message || 'The main workspace window could not be restored. Choose Dock to retry.';
        notify(message);
        try {
          const doc = entry.popup.document;
          let alert = doc.getElementById('showave-detached-return-error');
          if (!alert) {
            alert = doc.createElement('p'); alert.id = 'showave-detached-return-error';
            alert.setAttribute('role','alert'); alert.style.margin = '4px 8px';
            doc.getElementById('showave-detached-header')?.after(alert);
          }
          alert.textContent = message + ' Choose Dock to retry.';
        } catch (_) {}
      });
      return true;
    }
    detached.delete(id); clearInterval(entry.poll);
    if (entry.resize) try { entry.popup.removeEventListener('resize',entry.resize); } catch (_) {}
    try { entry.dispose?.(); } catch (_) {}
    entry.dispose = null;
    if (entry.showSizing) {
      const {editor,properties} = entry.showSizing;
      entry.showSizing.observer?.disconnect();
      if (entry.showSizing.pending) global.cancelAnimationFrame(entry.showSizing.pending);
      properties.forEach(({name,value,priority}) => value ? editor.style.setProperty(name,value,priority) : editor.style.removeProperty(name));
      entry.showSizing = null;
    }
    const specifiedPosition = Object.prototype.hasOwnProperty.call(options,'beforeId');
    const before = specifiedPosition ? options.beforeId : (tabOrder.includes(entry.home.beforeId) ? entry.home.beforeId : null);
    const index = before ? tabOrder.indexOf(before) : specifiedPosition ? tabOrder.length : Math.min(entry.home.index,tabOrder.length);
    tabOrder.splice(index,0,id);
    // The iframe/Show document remains exactly where it was; only its view is
    // restored. Closing a secondary window never unloads the live owner.
    if (options.close !== false && !entry.popup.closed) try { entry.popup.close(); } catch (_) {}
    updateHostPresentation(); tabsChanged();
    if (options.activate !== false) void activate(id).catch(showError);
    else mapVisibility(activeId === 'map' || detached.has('map'));
    return true;
  }

  async function mountWindow(id,key,popup) {
    const entry = detached.get(id);
    if (!entry || key !== entry.nonce || !trustedPopup(entry,popup)) return false;
    if (entry.mounted) return true;
    if (entry.mounting) return entry.mounting;
    entry.mounting = (async () => {
      const record = id === 'show' ? null : records.get(id);
      if (record) await record.promise;
      if (detached.get(id) !== entry || !trustedPopup(entry,popup)) return false;
      const owner = record ? record.frame.contentWindow : global;
      if (record && !trustedRecord(record)) return false;
      const shared = global.OpenLiveAreas?.createSharedView || owner.OpenLiveAreas?.createSharedView;
      const view = popup.document.getElementById('showave-detached-view');
      if (typeof shared !== 'function' || !view) throw new Error('The shared workspace view is still starting. Dock this window and try again.');
      // Window actions belong to the displayed native popup. The original
      // Show source rail remains a working part of its editor workflow.
      const exclusions = ['#showave-workspace-host','#showave-start-shell',
          '#showave-workspace-tabs','#showave-panels-button','#showave-workspace-host-style',
          '#showave-workspace-notice','[data-window-action]','script'];
      if (id !== 'show') exclusions.push('#showave-source-rail');
      entry.dispose = shared(owner.document.body,view,{workspace:true,
        excludeSelectors:exclusions,
        ignoreAttributes:['data-showave-workspace-suspended','inert']});
      entry.mounted = true;
      entry.resize = () => resizeDetachedOwner(entry); popup.addEventListener('resize',entry.resize);
      resizeDetachedOwner(entry); updateHostPresentation(); tabsChanged();
      return true;
    })();
    return entry.mounting;
  }

  function beginDrag(id,sourceWindow = global) {
    if (!byId.has(id)) return null;
    if (sourceWindow !== global && !trustedPopup(detached.get(id),sourceWindow)) return null;
    const now = Date.now();
    dragTokens.forEach((entry,token) => { if (now - entry.at > DRAG_TTL) dragTokens.delete(token); });
    const token = nonce(); dragTokens.set(token,{id,source:sourceWindow,at:now}); return token;
  }

  function cancelDrag(token) { return dragTokens.delete(token); }

  function dropDrag(token,options = {}) {
    const entry = typeof token === 'string' && dragTokens.get(token);
    if (!entry) return false;
    if (Date.now() - entry.at > DRAG_TTL || entry.source.closed ||
        entry.source !== global && !trustedPopup(detached.get(entry.id),entry.source)) {
      dragTokens.delete(token); return false;
    }
    if (options.beforeId != null && (!byId.has(options.beforeId) || !tabOrder.includes(options.beforeId))) return false;
    dragTokens.delete(token);
    return detached.has(entry.id) ? redock(entry.id,{beforeId:options.beforeId}) : reorder(entry.id,options.beforeId);
  }

  function transferToken(transfer) {
    if (!transfer) return '';
    const token = transfer.getData(DRAG_TYPE);
    if (token) return token;
    const plain = transfer.getData('text/plain');
    return plain.startsWith('showave-workspace:') ? plain.slice(18) : '';
  }

  function beforePoint(nav,x) {
    const buttons = [...nav.querySelectorAll('[data-workspace]')].filter(button => tabOrder.includes(button.dataset.workspace));
    return buttons.find(button => {
      const bounds = button.getBoundingClientRect(); return x <= bounds.left + bounds.width / 2;
    })?.dataset.workspace || null;
  }

  function containsPoint(bounds,x,y) {
    return !!bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  }

  async function dropAtScreen(token,x,y) {
    const capability = dragTokens.get(token), nav = document.getElementById('showave-workspace-tabs');
    if (!capability || !Number.isFinite(x) || !Number.isFinite(y) || !nav || !nav.getClientRects().length) return false;
    let bounds = null;
    const separate = detached.get(capability.id), geometry = global.OpenLiveDesktop?.workspaceWindows?.geometry;
    if (separate && typeof geometry === 'function') {
      try {
        const result = await geometry({id:separate.id,nonce:separate.nonce});
        if (result.owner?.visible === false) return false;
        if (Number.isFinite(result.owner?.x) && Number.isFinite(result.owner?.y)) bounds = result.owner;
      } catch (_) { return false; }
    }
    if (!bounds) {
      const border = Math.max(0,((global.outerWidth || global.innerWidth) - global.innerWidth) / 2);
      bounds = {x:ownerScreenOffset?.x ?? (global.screenX || 0) + border,
        y:ownerScreenOffset?.y ?? (global.screenY || 0) + Math.max(0,(global.outerHeight || global.innerHeight) - global.innerHeight - border)};
    }
    const clientX = x - bounds.x, clientY = y - bounds.y, target = nav.getBoundingClientRect();
    if (!containsPoint(target,clientX,clientY)) return false;
    return dropDrag(token,{beforeId:beforePoint(nav,clientX)});
  }

  function pointerTab(tab,id,sourceWindow = global) {
    if (!tab || boundPointerTabs.has(tab) || !byId.has(id)) return false;
    if (sourceWindow !== global && !trustedPopup(detached.get(id),sourceWindow)) return false;
    boundPointerTabs.add(tab);
    tab.addEventListener('click',event => {
      if (clickBlocked.has(tab)) { clickBlocked.delete(tab); event.preventDefault(); event.stopImmediatePropagation(); }
    },true);
    tab.addEventListener('pointerdown',event => {
      if (event.button !== 0 || pointerDrag) return;
      event.preventDefault(); tab.focus({preventScroll:true}); closeTabMenu();
      if (sourceWindow === global && Number.isFinite(event.screenX) && Number.isFinite(event.screenY))
        ownerScreenOffset = {x:event.screenX - event.clientX,y:event.screenY - event.clientY};
      const gesture = {id,tab,source:sourceWindow,pointerId:event.pointerId,token:null,moved:false,cancelled:false,
        start:{x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY},cursor:tab.style.cursor};
      pointerDrag = gesture;
      tab.setPointerCapture?.(event.pointerId);
      const cleanup = () => {
        sourceWindow.removeEventListener('pointermove',move,true); sourceWindow.removeEventListener('pointerup',up,true);
        sourceWindow.removeEventListener('pointercancel',abort,true); sourceWindow.removeEventListener('keydown',key,true);
        if (tab.hasPointerCapture?.(gesture.pointerId)) tab.releasePointerCapture(gesture.pointerId);
        tab.style.cursor = gesture.cursor; tab.classList.remove('dragging');
        if (pointerDrag === gesture) pointerDrag = null;
      };
      const move = next => {
        if (next.pointerId !== gesture.pointerId) return;
        if (!gesture.moved && Math.hypot(next.clientX - gesture.start.x,next.clientY - gesture.start.y) > 8) {
          gesture.token = beginDrag(id,sourceWindow); gesture.moved = !!gesture.token;
          if (gesture.moved) { tab.style.cursor = 'grabbing'; tab.classList.add('dragging'); }
        }
        if (gesture.moved) { next.preventDefault(); next.stopPropagation(); }
      };
      const finish = (next,cancelled) => {
        cleanup();
        if (!gesture.moved) {
          if (!cancelled && sourceWindow === global) void activate(id).catch(showError);
          return;
        }
        clickBlocked.add(tab); next?.preventDefault(); next?.stopPropagation();
        if (cancelled || gesture.cancelled) { cancelDrag(gesture.token); return; }
        if (sourceWindow === global) {
          const nav = document.getElementById('showave-workspace-tabs'), bounds = nav?.getBoundingClientRect();
          if (nav && containsPoint(bounds,next.clientX,next.clientY)) dropDrag(gesture.token,{beforeId:beforePoint(nav,next.clientX)});
          else { cancelDrag(gesture.token); undock(id,{screenX:next.screenX,screenY:next.screenY}); }
        } else {
          void dropAtScreen(gesture.token,next.screenX,next.screenY).then(dropped => {
            if (dropped || !cancelDrag(gesture.token)) return;
            const entry = detached.get(id), nativeMove = sourceWindow.OpenLiveDesktop?.workspaceWindows?.move;
            if (entry && typeof nativeMove === 'function')
              void nativeMove({id,nonce:entry.nonce,x:Math.round(next.screenX - 40),y:Math.round(next.screenY - 14)}).catch(() => {});
          });
        }
      };
      const up = next => { if (next.pointerId === gesture.pointerId) finish(next,false); };
      const abort = next => { if (next.pointerId === gesture.pointerId) finish(next,true); };
      const key = next => {
        if (next.key === 'Escape') { gesture.cancelled = true; next.preventDefault(); finish(next,true); }
      };
      sourceWindow.addEventListener('pointermove',move,true); sourceWindow.addEventListener('pointerup',up,true);
      sourceWindow.addEventListener('pointercancel',abort,true); sourceWindow.addEventListener('keydown',key,true);
    });
    return true;
  }

  function closeTabMenu() { tabMenu?.remove(); tabMenu = null; }

  function openTabMenu(id,anchor,event) {
    closeTabMenu();
    const menu = document.createElement('div'); menu.className = 'ol-area-menu'; menu.setAttribute('role','menu');
    const add = (label,action,disabled = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role','menuitem');
      button.textContent = label; button.disabled = disabled;
      button.addEventListener('click',() => { closeTabMenu(); action(); }); menu.append(button);
    };
    add(detached.has(id) ? 'Dock back into tabs' : 'Open in separate window',() => detached.has(id) ? redock(id) : undock(id));
    if (!detached.has(id)) {
      const index = tabOrder.indexOf(id);
      add('Move tab left',() => reorder(id,tabOrder[index - 1]),index <= 0);
      add('Move tab right',() => reorder(id,tabOrder[index + 2] || null),index >= tabOrder.length - 1);
    }
    const bounds = anchor.getBoundingClientRect(); document.body.append(menu); tabMenu = menu;
    menu.style.left = Math.max(4,Math.min(event?.clientX || bounds.left,global.innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4,Math.min(event?.clientY || bounds.bottom,global.innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
    menu.addEventListener('keydown',key => {
      if (key.key === 'Escape') { key.preventDefault(); closeTabMenu(); anchor.focus(); }
      if (['ArrowDown','ArrowUp'].includes(key.key)) {
        key.preventDefault(); const items = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement), delta = key.key === 'ArrowDown' ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      }
    });
  }

  function bindTabs(nav) {
    if (!nav || boundTabs.has(nav)) return;
    boundTabs.add(nav);
    const prepare = () => [...nav.querySelectorAll('[data-workspace]')].forEach(button => {
      button.draggable = true;
      pointerTab(button,button.dataset.workspace);
      button.setAttribute('aria-haspopup','menu');
      button.title = (button.dataset.workspace === 'forge' ? 'Forge workspace (Preview). ' : '') +
        'Drag to reorder or pull outside the window. Right-click or Shift+F10 for window options.';
    });
    prepare(); new MutationObserver(prepare).observe(nav,{childList:true});
    const tabFor = target => target?.closest?.('[data-workspace]');
    const beforeAt = event => {
      const target = tabFor(event.target);
      if (!target || !nav.contains(target)) return null;
      const id = target.dataset.workspace, rect = target.getBoundingClientRect();
      return event.clientX <= rect.left + rect.width / 2 ? id : tabOrder[tabOrder.indexOf(id) + 1] || null;
    };
    nav.addEventListener('dragstart',event => {
      const tab = tabFor(event.target); if (!tab || !nav.contains(tab)) return;
      const token = beginDrag(tab.dataset.workspace); if (!token) { event.preventDefault(); return; }
      closeTabMenu(); tabDrag = {id:tab.dataset.workspace,token,cancelled:false};
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE,token);
      event.dataTransfer.setData('text/plain','showave-workspace:' + token); event.stopPropagation();
    });
    nav.addEventListener('dragover',event => {
      if (!Array.from(event.dataTransfer?.types || []).includes(DRAG_TYPE)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    });
    nav.addEventListener('drop',event => {
      event.preventDefault(); event.stopPropagation();
      if (dropDrag(transferToken(event.dataTransfer),{beforeId:beforeAt(event)})) tabDrag = null;
    });
    nav.addEventListener('dragend',event => {
      const drag = tabDrag; tabDrag = null;
      if (!drag || !dragTokens.has(drag.token)) return;
      cancelDrag(drag.token);
      const outside = event.clientX < 0 || event.clientY < 0 || event.clientX > global.innerWidth || event.clientY > global.innerHeight;
      if (!drag.cancelled && outside && event.dataTransfer?.dropEffect === 'none' && (event.screenX || event.screenY))
        undock(drag.id,{screenX:event.screenX,screenY:event.screenY});
    });
    nav.addEventListener('contextmenu',event => {
      const tab = tabFor(event.target); if (!tab || !nav.contains(tab)) return;
      event.preventDefault(); openTabMenu(tab.dataset.workspace,tab,event);
    });
    nav.addEventListener('keydown',event => {
      const tab = tabFor(event.target); if (!tab) return;
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault(); openTabMenu(tab.dataset.workspace,tab);
      }
    });
  }

  function panelOwner() {
    if (activeId === 'show') return global;
    const record = records.get(activeId);
    return record?.ready && trustedRecord(record) ? record.frame.contentWindow : null;
  }
  function hasPanels() {
    const owner = panelOwner();
    return !!owner?.OpenLiveAreas?.get(activeId) && typeof owner.OpenLiveAreas.openPanelPicker === 'function';
  }
  function openPanels(anchor) {
    const owner = panelOwner();
    if (!hasPanels()) return false;
    if (anchor?.getAttribute('aria-expanded') === 'true') {
      owner.OpenLiveAreas.closePanelPicker();
      return null;
    }
    return owner.OpenLiveAreas.openPanelPicker(activeId, anchor);
  }
  global.OpenLiveWorkspaceHost = Object.freeze({activate,current:() => activeId,hasPanels,openPanels,
    undock,redock,mountWindow,bindTabs,state,hasDetachedView,setAreaFocus,beginDrag,cancelDrag,dropDrag,dropAtScreen,
    bindDetachedTab:pointerTab,
    getFrame:id => records.get(id)?.frame || null,
    getWindow:id => detached.get(id)?.popup || null,dragType:DRAG_TYPE,dragMaxAge:DRAG_TTL,routes});
  global.addEventListener('resize', positionHost);
  global.addEventListener('showave:rail-changed', positionHost);
  global.addEventListener('showave:rail-changed', () => {
    const entry = detached.get('show'); if (entry?.mounted) resizeDetachedOwner(entry);
  });
  // The persistent Show menus act on Show's document. Bring that document
  // forward before a menu can create a confirmation or preferences dialog.
  const bringShowMenuForward = event => {
    if (event.__showaveMirror) return;
    if (activeId === 'show' || !event.target.closest?.('#menus .menu-top, #showave-source-system .menu-top')) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
    void activate('show');
  };
  document.addEventListener('mousedown', bringShowMenuForward, true);
  document.addEventListener('keydown', bringShowMenuForward, true);
  document.addEventListener('pointerdown',event => {
    if (tabMenu && !tabMenu.contains(event.target)) closeTabMenu();
  },true);
  document.addEventListener('keydown',event => {
    if (event.key === 'Escape' && tabDrag) { tabDrag.cancelled = true; cancelDrag(tabDrag.token); }
  },true);
  new MutationObserver(() => { positionHost(); if (activeId !== 'show') suspendShow(true); })
    .observe(app, { childList: true });
  if (typeof global.OpenLiveDesktop?.onWorkspaceActivate === 'function')
    global.OpenLiveDesktop.onWorkspaceActivate(id => activate(id).then(() => global.OpenLiveStartSplash?.hideSplash()).catch(showError));
  if (typeof global.OpenLiveDesktop?.onWorkspaceWindowReturn === 'function')
    global.OpenLiveDesktop.onWorkspaceWindowReturn(({id,nonce:key,closed}) => {
      if (detached.get(id)?.nonce === key) redock(id,closed ? {close:false} : {},true);
    });
  global.addEventListener('pagehide',() => {
    dragTokens.clear(); closeTabMenu();
    detached.forEach(entry => {
      clearInterval(entry.poll); try { entry.dispose?.(); } catch (_) {}
      try { if (!entry.popup.closed) entry.popup.close(); } catch (_) {}
    });
    detached.clear();
  });
  bindTabs(document.getElementById('showave-workspace-tabs'));
})(window);
