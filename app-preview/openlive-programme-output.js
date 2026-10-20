/* Programme projector: copy only the Broadcast owner's finished canvas.
   output-setup.htm governs windowed/fullscreen output; this dedicated surface
   owns no scene, capture, audio track, destination or renderer lifecycle. */
(function(root) {
  'use strict';

  function contain(sourceWidth, sourceHeight, width, height) {
    if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) return null;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const w = Math.min(width, sourceWidth * scale), h = Math.min(height, sourceHeight * scale);
    return {x:(width - w) / 2, y:(height - h) / 2, width:w, height:h};
  }

  function mount(host, doc) {
    host = host || root; doc = doc || host.document;
    const find = id => doc.getElementById(id);
    const canvas = find('programmeOutput'), controls = find('projectorControls');
    const status = find('projectorStatus'), title = find('projectorStatusTitle'), description = find('projectorStatusText');
    const fullscreen = find('projectorFullscreen'), close = find('projectorClose'), error = find('projectorError');
    if (!canvas || !controls || !status || !title || !description || !fullscreen || !close || !error) return null;
    const query = new URLSearchParams(host.location.search);
    const session = query.get('session') || '';
    const mode = query.get('mode') === 'display' ? 'display' : 'windowed';
    const tip = find('projectorTip');
    if (tip) tip.textContent = (mode === 'windowed' ? 'Drag to your display · ' : '') +
      'F or double-click for fullscreen · Ctrl+Shift+D to close · Video only';
    let context = null;
    try { context = canvas.getContext('2d', {alpha:false, desynchronized:true}); } catch (_) {}
    let opener = null, bridge = null, disposed = false, disconnected = false, hasFrame = false;
    let presented = null;
    let raf = 0, background = 0, idle = 0, fullscreenPending = false, keyboardInput = false;
    const listeners = [];
    function on(target, event, listener) {
      target.addEventListener(event, listener);
      listeners.push(() => target.removeEventListener(event, listener));
    }
    function resize() {
      const ratio = Number(host.devicePixelRatio) > 0 ? Number(host.devicePixelRatio) : 1;
      const width = Math.max(1, Math.round((Number(host.innerWidth) || 1) * ratio));
      const height = Math.max(1, Math.round((Number(host.innerHeight) || 1) * ratio));
      if (canvas.width !== width) { canvas.width = width; presented = null; }
      if (canvas.height !== height) { canvas.height = height; presented = null; }
    }
    function black() {
      presented = null;
      resize();
      if (context) { context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height); }
    }
    function stopPump() {
      if (raf) host.cancelAnimationFrame(raf); raf = 0;
      if (background) host.clearTimeout(background); background = 0;
    }
    function keyboardFocus() {
      return keyboardInput && typeof controls.contains === 'function' && controls.contains(doc.activeElement);
    }
    function reveal() {
      if (disposed) return;
      if (idle) host.clearTimeout(idle); idle = 0;
      controls.classList.remove('is-idle'); doc.body.classList.remove('projector-idle');
      if (hasFrame && !disconnected && !error.textContent && !keyboardFocus()) idle = host.setTimeout(() => {
        idle = 0;
        if (disposed || disconnected || !hasFrame || error.textContent || keyboardFocus()) return;
        controls.classList.add('is-idle'); doc.body.classList.add('projector-idle');
      }, 2200);
    }
    function waiting(message) {
      hasFrame = false; black(); status.hidden = false;
      title.textContent = 'Programme projector'; description.textContent = message;
      reveal();
    }
    function disconnect(message) {
      disconnected = true; stopPump(); waiting(message);
      title.textContent = 'Programme disconnected';
    }
    function currentBridge() {
      try {
        if (!opener || opener.closed || host.opener !== opener) return null;
        const api = opener.__openliveProgrammeOutput;
        return session && api && api === bridge && api.session === session && typeof api.frame === 'function' ? api : null;
      } catch (_) { return null; }
    }
    function paint() {
      if (disposed || disconnected) return;
      const api = currentBridge();
      if (!api) { disconnect('Broadcast was closed or reloaded. Open a new Programme projector from Broadcast.'); return; }
      let source, info;
      try {
        info = typeof api.frameInfo === 'function' ? api.frameInfo(session) : null;
        source = typeof api.frameInfo === 'function' ? info?.canvas : api.frame(session);
      }
      catch (_) { waiting('The Programme picture is temporarily unavailable.'); return; }
      resize();
      const rect = source && contain(Number(source.width), Number(source.height), canvas.width, canvas.height);
      if (!rect) { waiting('Waiting for the Programme picture from Broadcast…'); return; }
      const revision = info?.stamp;
      const stamped = Number.isSafeInteger(revision) && revision >= 0;
      const view = {source, revision, aspect:info?.aspect, sourceWidth:Number(source.width), sourceHeight:Number(source.height),
        width:canvas.width, height:canvas.height, viewportWidth:host.innerWidth, viewportHeight:host.innerHeight, ratio:host.devicePixelRatio};
      if (stamped && hasFrame && presented && Object.keys(view).every(key => view[key] === presented[key])) return;
      try {
        black();
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        context.drawImage(source, rect.x, rect.y, rect.width, rect.height);
      } catch (_) { waiting('The Programme picture could not be displayed.'); return; }
      const first = !hasFrame;
      presented = stamped ? view : null;
      hasFrame = true; status.hidden = true;
      if (first) reveal();
    }
    function schedule() {
      if (disposed || disconnected) return;
      if (doc.hidden) background = host.setTimeout(step, 500);
      else raf = host.requestAnimationFrame(step);
    }
    function step() {
      raf = 0; background = 0; paint(); schedule();
    }
    function fullscreenState() {
      const active = !!doc.fullscreenElement;
      fullscreen.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
      fullscreen.setAttribute('aria-pressed', String(active));
      fullscreen.disabled = fullscreenPending || (active ? typeof doc.exitFullscreen !== 'function' : typeof doc.documentElement.requestFullscreen !== 'function');
      fullscreen.title = fullscreen.disabled && !fullscreenPending ? 'Fullscreen is unavailable in this browser.' : 'F or double-click the picture to toggle fullscreen. Esc exits fullscreen.';
    }
    async function toggleFullscreen() {
      if (disposed || fullscreenPending) return;
      const active = !!doc.fullscreenElement;
      const target = active ? doc : doc.documentElement;
      const method = active ? target.exitFullscreen : target.requestFullscreen;
      if (typeof method !== 'function') {
        error.textContent = 'Fullscreen is unavailable. You can still move and resize this window.'; reveal(); return;
      }
      fullscreenPending = true; error.textContent = ''; fullscreenState(); reveal();
      try {
        await method.call(target, ...(active ? [] : [{navigationUI:'hide'}]));
        if (disposed) return;
        if (!!doc.fullscreenElement === active)
          error.textContent = active ? 'Fullscreen did not close. Press Esc to exit.' : 'Fullscreen did not start. Click Fullscreen to try again.';
      } catch (_) {
        if (!disposed) error.textContent = active ? 'Fullscreen could not close. Press Esc to exit.' : 'Fullscreen was not allowed. The Programme is still available in this window.';
      } finally {
        fullscreenPending = false;
        if (!disposed) { fullscreenState(); reveal(); }
      }
    }
    function dispose() {
      if (disposed) return;
      const api = currentBridge();
      disposed = true; stopPump();
      if (idle) host.clearTimeout(idle); idle = 0;
      listeners.splice(0).forEach(remove => remove());
      try { if (api && typeof api.surfaceClosed === 'function') api.surfaceClosed(session, host); } catch (_) {}
    }
    function closeWindow() { try { host.close(); } catch (_) { error.textContent = 'Close this projector using the window controls.'; reveal(); } }

    on(fullscreen, 'click', toggleFullscreen);
    on(close, 'click', closeWindow);
    on(canvas, 'dblclick', toggleFullscreen);
    on(doc, 'pointermove', reveal);
    on(doc, 'pointerdown', () => { keyboardInput = false; reveal(); });
    on(doc, 'focusin', reveal);
    on(doc, 'keydown', event => {
      keyboardInput = true;
      reveal();
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 'd') {
        event.preventDefault(); closeWindow();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && String(event.key).toLowerCase() === 'f' && !event.repeat) {
        event.preventDefault(); toggleFullscreen();
      }
    });
    on(doc, 'fullscreenchange', () => { fullscreenState(); reveal(); });
    on(doc, 'visibilitychange', () => { stopPump(); if (!disposed && !disconnected) { paint(); schedule(); } });
    on(canvas, 'contextlost', () => { presented = null; hasFrame = false; });
    on(canvas, 'contextrestored', () => { presented = null; if (!disposed && !disconnected) paint(); });
    on(host, 'resize', () => { if (disconnected) black(); else paint(); });
    on(host, 'pagehide', dispose);

    fullscreenState();
    try { opener = host.opener; bridge = opener && !opener.closed ? opener.__openliveProgrammeOutput : null; } catch (_) {}
    if (!context) disconnect('This browser could not create the Programme display surface.');
    else if (!currentBridge()) disconnect('Open this window using the Programme projector control in Broadcast.');
    else {
      description.textContent = mode === 'display' ? 'Connecting. Click Fullscreen or press F to fill this display.' : 'Connecting. You can drag this window to another display.';
      paint(); schedule();
    }
    return {dispose};
  }

  root.OpenLiveProgrammeSurface = Object.freeze({contain, mount});
  if (root.document && root.document.getElementById('programmeOutput')) mount(root, root.document);
})(window);
