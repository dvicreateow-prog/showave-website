/* A landscape, inert desktop mirror. Only the desktop runs SHOWAVE and its outputs. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OpenLiveMobileView = api;
  if (root && root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', api.start, { once:true });
    else api.start();
  }
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';
  const ID = 'data-sw-mobile-id';
  const SESSION_KEY = 'showave.mobile.connection.v1';
  const TOOLBAR = 36;
  const FOOTER = 20;
  const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' about:; form-action 'none'; base-uri 'self'";
  const VIEW_CSS = '\nhtml,body{touch-action:none;overscroll-behavior:none}';
  const wired = new WeakSet();
  function finite(value, fallback) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
  function layout(width, height, desktopWidth, desktopHeight) {
    width = Math.max(1, finite(width, 1)); height = Math.max(1, finite(height, 1));
    const rotated = height > width;
    const shellWidth = rotated ? height : width;
    const shellHeight = rotated ? width : height;
    const sourceWidth = Math.max(1, finite(desktopWidth, 1280));
    const sourceHeight = Math.max(1, finite(desktopHeight, 720));
    const stageHeight = Math.max(1, shellHeight - TOOLBAR - FOOTER);
    const scale = Math.min(shellWidth / sourceWidth, stageHeight / sourceHeight);
    return { rotated, shellWidth, shellHeight, sourceWidth, sourceHeight, scale,
      x:(shellWidth - sourceWidth * scale) / 2, y:(stageHeight - sourceHeight * scale) / 2 };
  }
  function point(rect, x, y) {
    return { x:(finite(x, 0) - rect.left) / Math.max(1, rect.width), y:(finite(y, 0) - rect.top) / Math.max(1, rect.height) };
  }
  function parseConnection(value) {
    try {
      const text = String(value || '').trim();
      const fragment = text.includes('#') ? text.slice(text.indexOf('#') + 1) : text.replace(/^#/, '');
      const params = new URLSearchParams(fragment);
      const room = params.get('room') || '';
      const token = params.get('token') || '';
      return room && token && room.length <= 160 && token.length <= 256 ? { room, token } : null;
    } catch (_) { return null; }
  }
  function resourceAllowed(value, base) {
    if (/^data:image\//i.test(value)) return true;
    try { const url = new URL(value, base); return ['http:', 'https:', 'blob:'].includes(url.protocol) && url.origin === new URL(base).origin; }
    catch (_) { return false; }
  }
  function nestedDocument(html, base) {
    const parsed = new root.DOMParser().parseFromString(String(html || ''), 'text/html');
    const styles = Array.from(parsed.querySelectorAll('style')).map(style => style.textContent).join('\n');
    const body = sanitize(parsed, parsed.body.innerHTML, base);
    parsed.body.replaceChildren(body);
    parsed.head.replaceChildren();
    const policy = parsed.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = CSP;
    const origin = parsed.createElement('base'); origin.href = base;
    const style = parsed.createElement('style'); style.id = 'sw-mobile-nested-style'; style.textContent = styles + VIEW_CSS;
    parsed.head.append(policy, origin, style);
    for (const node of [parsed.documentElement, parsed.body]) for (const attribute of Array.from(node.attributes)) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    return '<!doctype html>' + parsed.documentElement.outerHTML;
  }
  function sanitize(doc, html, base) {
    const parsed = new root.DOMParser().parseFromString(String(html || ''), 'text/html');
    parsed.querySelectorAll('script,frame,object,embed,base,link,meta,source').forEach(node => node.remove());
    parsed.querySelectorAll('iframe').forEach(node => {
      if (node.getAttribute('data-sw-mobile-frame') !== '1' || !node.hasAttribute('srcdoc')) { node.remove(); return; }
      node.setAttribute('srcdoc', nestedDocument(node.getAttribute('srcdoc'), base));
      node.removeAttribute('src'); node.setAttribute('sandbox', 'allow-same-origin'); node.setAttribute('referrerpolicy', 'no-referrer');
    });
    parsed.body.querySelectorAll('*').forEach(node => {
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        const svgResource = ['use', 'image'].includes(node.tagName.toLowerCase()) && resourceAllowed(attribute.value, base);
        if (/^on/.test(name) || ['nonce', 'integrity', 'autofocus', 'formaction', 'action', 'target', 'download', 'autoplay'].includes(name) || (name === 'href' && !svgResource) || (name === 'srcdoc' && node.tagName !== 'IFRAME')) node.removeAttribute(attribute.name);
        else if (['src', 'poster', 'background', 'xlink:href'].includes(name) && !resourceAllowed(attribute.value, base)) node.removeAttribute(attribute.name);
        else if (name === 'srcset') node.removeAttribute(attribute.name);
      }
      if (node.tagName === 'BUTTON') node.type = 'button';
      if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') { node.removeAttribute('src'); node.removeAttribute('controls'); }
      if (node.tagName === 'INPUT' && /^(file|password)$/i.test(node.type)) {
        node.disabled = true; node.value = ''; node.removeAttribute('value');
        node.title = node.type === 'file' ? 'Choose files on the desktop.' : 'Enter passwords on the desktop.';
      }
    });
    const fragment = doc.createDocumentFragment();
    for (const child of Array.from(parsed.body.childNodes)) fragment.appendChild(doc.importNode(child, true));
    return fragment;
  }
  function sameNode(left, right) {
    if (!left || !right || left.nodeType !== right.nodeType) return false;
    if (left.nodeType !== 1) return true;
    return left.tagName === right.tagName && left.getAttribute(ID) === right.getAttribute(ID);
  }
  function updateAttributes(target, incoming, active) {
    for (const attribute of Array.from(target.attributes)) {
      if (!incoming.hasAttribute(attribute.name) && !(target === active && ['value', 'checked', 'selected'].includes(attribute.name))) target.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(incoming.attributes)) {
      if (target.tagName === 'IFRAME' && attribute.name === 'srcdoc') continue;
      if (target === active && ['value', 'checked', 'selected'].includes(attribute.name)) continue;
      if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
    }
  }
  function reconcile(target, incoming, active, onFrame) {
    const keyed = new Map();
    for (const child of Array.from(target.childNodes)) if (child.nodeType === 1 && child.hasAttribute(ID)) keyed.set(child.getAttribute(ID), child);
    let cursor = target.firstChild;
    const keep = new Set();
    for (const source of Array.from(incoming.childNodes)) {
      const key = source.nodeType === 1 ? source.getAttribute(ID) : null;
      let node = key ? keyed.get(key) : cursor;
      if (!sameNode(node, source)) node = source.cloneNode(true);
      if (node !== cursor) target.insertBefore(node, cursor);
      keep.add(node);
      if (node.nodeType === 1) {
        updateAttributes(node, source, active);
        if (node.tagName === 'IFRAME' && node.getAttribute('data-sw-mobile-frame') === '1') { if (onFrame) onFrame(node, source); }
        else reconcile(node, source, active, onFrame);
      }
      else if (node.nodeValue !== source.nodeValue) node.nodeValue = source.nodeValue;
      cursor = node.nextSibling;
    }
    for (const child of Array.from(target.childNodes)) if (!keep.has(child)) child.remove();
  }
  function editable(node) {
    return Boolean(node && (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable ||
      (node.tagName === 'INPUT' && !/^(button|submit|reset|image|file|password)$/i.test(node.type))));
  }
  function start() {
    const doc = root.document;
    const shell = doc.getElementById('mobile-shell');
    if (!shell || shell.dataset.started) return;
    shell.dataset.started = '1';
    const frame = doc.getElementById('mobile-frame');
    const welcome = doc.getElementById('mobile-welcome');
    const blocker = doc.getElementById('mobile-blocker');
    const panSurface = doc.getElementById('mobile-pan-surface');
    const panButton = doc.getElementById('mobile-pan');
    const status = doc.getElementById('mobile-status');
    const message = doc.getElementById('mobile-message');
    const moduleLabel = doc.getElementById('mobile-module');
    const help = doc.getElementById('mobile-help');
    const size = doc.getElementById('mobile-size');
    let connection = null, revision = 0, desktop = null, pendingSnapshot = null;
    let live = false, ended = false, booted = false, drag = null, renderWait = false, generation = 0;
    let commandTimer = null, commandRequest = null, lastCommandAt = 0, commands = [];
    let pollAbort = null, retryTimer = null, lastMoveAt = 0, cssText = null;
    let zoom = 1, panX = 0, panY = 0, panning = false, panDrag = null, geometry = null;
    let suppressClickUntil = 0;
    function fit() {
      const viewport = root.visualViewport;
      geometry = layout(viewport ? viewport.width : root.innerWidth, viewport ? viewport.height : root.innerHeight, desktop && desktop.width, desktop && desktop.height);
      shell.style.width = geometry.shellWidth + 'px'; shell.style.height = geometry.shellHeight + 'px';
      shell.style.transform = geometry.rotated ? 'translateX(' + geometry.shellHeight + 'px) rotate(90deg)' : '';
      frame.style.width = geometry.sourceWidth + 'px'; frame.style.height = geometry.sourceHeight + 'px';
      const scale = geometry.scale * zoom;
      const stageHeight = geometry.shellHeight - TOOLBAR - FOOTER;
      const excessX = Math.max(0, (geometry.sourceWidth * scale - geometry.shellWidth) / 2);
      const excessY = Math.max(0, (geometry.sourceHeight * scale - stageHeight) / 2);
      panX = Math.max(-excessX, Math.min(excessX, panX)); panY = Math.max(-excessY, Math.min(excessY, panY));
      frame.style.transform = 'translate(' + ((geometry.shellWidth - geometry.sourceWidth * scale) / 2 + panX) + 'px,' + ((stageHeight - geometry.sourceHeight * scale) / 2 + panY) + 'px) scale(' + scale + ')';
      size.textContent = desktop ? Math.round(scale * 100) + '% · ' + geometry.sourceWidth + ' × ' + geometry.sourceHeight : '';
      doc.getElementById('mobile-zoom-out').disabled = zoom <= 1;
      doc.getElementById('mobile-zoom-in').disabled = zoom >= 3;
      panButton.disabled = zoom <= 1;
      if (zoom <= 1) panning = false;
      panButton.setAttribute('aria-pressed', String(panning)); panSurface.hidden = !panning;
      help.textContent = geometry.rotated ? 'Horizontal view · Turn your phone or use Fullscreen' : 'Horizontal view · Desktop controls and output stay on the desktop';
    }
    function setStatus(state, detail) {
      live = state === 'live'; status.dataset.state = state;
      if (!live) commands = [];
      if (!live && drag) {
        try { const target = lookup(drag.id); if (target) target.releasePointerCapture(drag.pointerId); } catch (_) {}
        drag = null;
        if (pendingSnapshot && booted) render(pendingSnapshot);
      }
      status.textContent = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : 'Disconnected';
      blocker.hidden = live || !desktop;
      if (detail) { message.textContent = detail; help.textContent = detail; }
    }
    function lookup(id) {
      if (!id || !frame.contentDocument) return null;
      function find(mirror) {
        const found = Array.from(mirror.querySelectorAll('[' + ID + ']')).find(node => node.getAttribute(ID) === id);
        if (found) return found;
        for (const child of mirror.querySelectorAll('iframe[data-sw-mobile-frame="1"]')) {
          try { if (child.contentDocument) { const nested = find(child.contentDocument); if (nested) return nested; } } catch (_) {}
        }
        return null;
      }
      return find(frame.contentDocument);
    }
    function targetFor(event) {
      const element = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
      return element && element.closest('[' + ID + ']');
    }
    function modifiers(event) { return { ctrlKey:!!event.ctrlKey, altKey:!!event.altKey, shiftKey:!!event.shiftKey, metaKey:!!event.metaKey }; }
    function eventCommand(type, event, target, bounds) {
      return Object.assign({ type, target:target ? target.getAttribute(ID) : '', button:finite(event.button, 0), buttons:finite(event.buttons, 0) }, modifiers(event),
        target ? point(bounds || target.getBoundingClientRect(), event.clientX, event.clientY) : {});
    }
    function enqueue(command) {
      if (!live || !connection || ended) return;
      command.hostId = desktop && desktop.hostId;
      const last = commands[commands.length - 1];
      if (last && ['pointermove', 'input', 'scroll', 'wheel'].includes(command.type) && last.type === command.type && last.target === command.target) {
        if (command.type === 'wheel') { command.deltaX += last.deltaX; command.deltaY += last.deltaY; }
        commands[commands.length - 1] = command;
      } else commands.push(command);
      flushCommands();
    }
    function flushCommands() {
      if (commandRequest || commandTimer || !commands.length || !live) return;
      const wait = Math.max(0, 32 - (Date.now() - lastCommandAt));
      commandTimer = root.setTimeout(async () => {
        commandTimer = null;
        if (!live || !commands.length) return;
        const command = commands.shift(); const mine = generation;
        const current = { controller:new root.AbortController(), cancel:null };
        commandRequest = current; lastCommandAt = Date.now();
        let timeout;
        // Do not replay an uncertain command: it may already have reached the
        // desktop. Bound the wait and let the operator review the next snapshot.
        const deadline = new Promise((resolve, reject) => {
          current.cancel = () => { current.controller.abort(); reject(new Error('Controller connection changed.')); };
          timeout = root.setTimeout(() => {
            reject(new Error('Command timed out. Reconnecting; check the desktop before trying again.'));
            current.controller.abort();
          }, 10000);
        });
        try {
          const response = await Promise.race([root.fetch('/api/mobile/command', { method:'POST', headers:{ 'Content-Type':'application/json' }, cache:'no-store', referrerPolicy:'no-referrer',
            body:JSON.stringify({ room:connection.room, token:connection.token, command }), signal:current.controller.signal }), deadline]);
          if (mine !== generation || commandRequest !== current) return;
          if (!response.ok) throw new Error(response.status === 429 ? 'Command rate exceeded. Reconnecting…' : 'Desktop connection interrupted.');
        } catch (error) {
          if (mine === generation && commandRequest === current) { commands = []; setStatus('reconnecting', error.message); }
        } finally {
          root.clearTimeout(timeout);
          if (commandRequest === current) { commandRequest = null; flushCommands(); }
        }
      }, wait);
    }
    function cancelCommands() {
      commands = []; root.clearTimeout(commandTimer); commandTimer = null;
      const current = commandRequest; commandRequest = null;
      if (current) current.cancel();
    }
    function attachEvents(mirror) {
      if (!mirror || wired.has(mirror)) return;
      wired.add(mirror);
      mirror.addEventListener('submit', event => event.preventDefault(), true);
      mirror.addEventListener('click', event => {
        if (Date.now() < suppressClickUntil) { event.preventDefault(); return; }
        const target = targetFor(event); const native = editable(event.target);
        if (!native) event.preventDefault();
        if (!target || target.disabled || native) return;
        enqueue(eventCommand('click', event, target));
      }, true);
      mirror.addEventListener('dblclick', event => event.preventDefault(), true);
      mirror.addEventListener('dblclick', event => { const target = targetFor(event); if (target && !editable(event.target)) enqueue(eventCommand('dblclick', event, target)); }, true);
      mirror.addEventListener('pointerover', event => { const target = targetFor(event); if (target && live) enqueue(eventCommand('mouseover', event, target)); }, true);
      mirror.addEventListener('contextmenu', event => { event.preventDefault(); const target = targetFor(event); if (target) enqueue(eventCommand('contextmenu', event, target)); }, true);
      mirror.addEventListener('pointerdown', event => {
        if (!live) { event.preventDefault(); return; }
        const target = targetFor(event);
        if (!target || target.disabled || drag) return;
        let scrollNode = null;
        if (event.pointerType === 'touch' && !editable(event.target) && !target.hasAttribute('data-sw-mobile-canvas')) {
          for (let node = target; node && node !== mirror.body; node = node.parentElement) {
            const computed = mirror.defaultView.getComputedStyle(node);
            if ((/(auto|scroll)/.test(computed.overflowY) && node.scrollHeight > node.clientHeight + 2) || (/(auto|scroll)/.test(computed.overflowX) && node.scrollWidth > node.clientWidth + 2)) { scrollNode = node; break; }
          }
        }
        drag = { id:target.getAttribute(ID), rect:target.getBoundingClientRect(), pointerId:event.pointerId, scrollNode,
          startX:event.clientX,startY:event.clientY,scrollLeft:scrollNode ? scrollNode.scrollLeft : 0,scrollTop:scrollNode ? scrollNode.scrollTop : 0,scrolling:false };
        lastMoveAt = 0;
        const down = eventCommand('pointerdown', event, target, drag.rect);
        if (scrollNode) drag.pendingDown = down; else enqueue(down);
        try { target.setPointerCapture(event.pointerId); } catch (_) {}
        if (!editable(event.target)) event.preventDefault();
      }, true);
      mirror.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId || Date.now() - lastMoveAt < 50) return;
        lastMoveAt = Date.now(); const target = lookup(drag.id);
        if (drag.scrollNode) {
          const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
          if (drag.scrolling || Math.hypot(dx, dy) > 8) {
            drag.scrolling = true;
            drag.scrollNode.scrollLeft = drag.scrollLeft - dx; drag.scrollNode.scrollTop = drag.scrollTop - dy;
            const id = drag.scrollNode.getAttribute(ID);
            if (id) enqueue({ type:'scroll',target:id,scrollLeft:drag.scrollNode.scrollLeft,scrollTop:drag.scrollNode.scrollTop });
            return;
          }
          return;
        }
        if (target) enqueue(eventCommand('pointermove', event, target, drag.rect));
      }, true);
      function release(event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const target = lookup(drag.id);
        if (drag.pendingDown && !drag.scrolling) enqueue(drag.pendingDown);
        if (target && !drag.scrolling) enqueue(eventCommand('pointerup', event, target, drag.rect));
        if (drag.scrolling) suppressClickUntil = Date.now() + 400;
        drag = null;
        if (pendingSnapshot) render(pendingSnapshot);
      }
      mirror.addEventListener('pointerup', release, true);
      mirror.addEventListener('pointercancel', release, true);
      for (const type of ['input', 'change']) mirror.addEventListener(type, event => {
        const target = targetFor(event);
        if (!target || target.disabled) return;
        enqueue({ type, target:target.getAttribute(ID), value:target.isContentEditable ? target.textContent : target.value, checked:!!target.checked });
      }, true);
      for (const type of ['focusin', 'focusout']) mirror.addEventListener(type, event => {
        if (type === 'focusout' && renderWait) return;
        const target = targetFor(event);
        if (!target || target.disabled || !(editable(target) || target.matches('button,[tabindex],a,[contenteditable]'))) return;
        enqueue({ type:type === 'focusin' ? 'focus' : 'blur', target:target.getAttribute(ID) });
      }, true);
      for (const type of ['keydown', 'keyup']) mirror.addEventListener(type, event => {
        if (!editable(event.target) || event.key === 'Escape' || (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA')) event.preventDefault();
        const target = targetFor(event);
        enqueue(Object.assign({ type, target:target ? target.getAttribute(ID) : '', key:event.key, code:event.code }, modifiers(event)));
      }, true);
      mirror.addEventListener('wheel', event => {
        event.preventDefault(); const target = targetFor(event); if (!target) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? desktop.height : 1;
        enqueue(Object.assign(eventCommand('wheel', event, target), { deltaX:event.deltaX * unit, deltaY:event.deltaY * unit }));
      }, { capture:true, passive:false });
      mirror.addEventListener('scroll', event => {
        if (renderWait) return;
        const target = targetFor(event);
        if (target) enqueue({ type:'scroll', target:target.getAttribute(ID), scrollLeft:target.scrollLeft, scrollTop:target.scrollTop });
      }, true);
    }
    function render(snapshot) {
      pendingSnapshot = snapshot;
      if (drag || !booted) return;
      const mirror = frame.contentDocument;
      if (!mirror || !mirror.body) return;
      pendingSnapshot = null; renderWait = true;
      const active = mirror.activeElement;
      const base = new URL(snapshot.url || '/', root.location.href);
      const safeBase = base.origin === root.location.origin ? base.href : root.location.origin + '/';
      const incoming = sanitize(mirror, snapshot.html, safeBase);
      function updateFrame(node, source) {
        const wanted = source.getAttribute('srcdoc');
        node._swMobileWanted = wanted;
        function update() {
          const nested = node.contentDocument;
          if (!nested || !nested.body || !nested.getElementById('sw-mobile-nested-style')) return;
          attachEvents(nested);
          if (node._swMobileApplied === node._swMobileWanted) return;
          const parsed = new root.DOMParser().parseFromString(node._swMobileWanted || '', 'text/html');
          const fragment = nested.createDocumentFragment();
          for (const child of Array.from(parsed.body.childNodes)) fragment.appendChild(nested.importNode(child, true));
          reconcile(nested.body, fragment, nested.activeElement, updateFrame);
          nested.documentElement.className = parsed.documentElement.className;
          nested.documentElement.style.cssText = parsed.documentElement.style.cssText;
          nested.body.className = parsed.body.className; nested.body.style.cssText = parsed.body.style.cssText;
          if (parsed.body.hasAttribute(ID)) nested.body.setAttribute(ID, parsed.body.getAttribute(ID));
          const incomingStyle = parsed.getElementById('sw-mobile-nested-style');
          if (incomingStyle) nested.getElementById('sw-mobile-nested-style').textContent = incomingStyle.textContent;
          node._swMobileApplied = node._swMobileWanted;
        }
        if (!node._swMobileLoadBound) { node._swMobileLoadBound = true; node.addEventListener('load', update); }
        update();
      }
      reconcile(mirror.body, incoming, active, updateFrame);
      mirror.documentElement.className = String(snapshot.rootClass || '');
      mirror.documentElement.style.cssText = String(snapshot.rootStyle || '');
      mirror.body.className = String(snapshot.bodyClass || '');
      mirror.body.style.cssText = String(snapshot.bodyStyle || '');
      if (snapshot.bodyId) mirror.body.setAttribute(ID, snapshot.bodyId);
      const stylesheet = mirror.getElementById('sw-mobile-style');
      if (stylesheet && cssText !== snapshot.css) { cssText = String(snapshot.css || ''); stylesheet.textContent = cssText + VIEW_CSS; }
      const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
      for (const field of fields) {
        const node = lookup(field.id); if (!node) continue;
        if (node !== node.ownerDocument.activeElement) {
          if (field.value != null && !/^(file|password)$/i.test(node.type || '')) { if (node.isContentEditable) node.textContent = String(field.value); else node.value = String(field.value); }
          if (typeof field.checked === 'boolean') node.checked = field.checked;
          if (Number.isInteger(field.selectedIndex) && node.tagName === 'SELECT') node.selectedIndex = field.selectedIndex;
        }
        if (field.scrollLeft != null) node.scrollLeft = field.scrollLeft;
        if (field.scrollTop != null) node.scrollTop = field.scrollTop;
      }
      frame.contentWindow.scrollTo(finite(snapshot.scrollX, 0), finite(snapshot.scrollY, 0));
      if (desktop && snapshot.hostId !== desktop.hostId) commands = commands.filter(command => command.hostId === snapshot.hostId);
      desktop = snapshot; frame.hidden = false; welcome.hidden = true;
      moduleLabel.textContent = snapshot.module || snapshot.title || 'Desktop';
      doc.title = 'SHOWAVE · ' + (snapshot.module || 'Phone Mirror');
      fit();
      root.requestAnimationFrame(() => { renderWait = false; });
    }
    function bootFrame() {
      frame.addEventListener('load', () => { booted = true; attachEvents(frame.contentDocument); if (pendingSnapshot) render(pendingSnapshot); }, { once:true });
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '"><base href="' + root.location.origin + '/"><style id="sw-mobile-style"></style></head><body></body></html>';
    }
    async function poll(mine) {
      if (!connection || ended || mine !== generation) return;
      const controller = new root.AbortController(); pollAbort = controller;
      const timeout = root.setTimeout(() => controller.abort(), 16000);
      let delay = 250;
      try {
        const params = new URLSearchParams({ room:connection.room, token:connection.token, after:String(revision) });
        const response = await root.fetch('/api/mobile/snapshot?' + params.toString(), { cache:'no-store', referrerPolicy:'no-referrer', signal:controller.signal });
        if (mine !== generation) return;
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) { ended = true; throw new Error('The phone link has ended. Open a new link from Mirror Phone on the desktop.'); }
          throw new Error('Waiting for the desktop connection…');
        }
        const data = await response.json();
        if (mine !== generation) return;
        if (data.ended) { ended = true; setStatus('disconnected', 'The desktop ended this phone link. Open a new link to reconnect.'); }
        else {
          if (data.revision != null) revision = data.revision;
          if (data.snapshot && typeof data.snapshot.html === 'string') render(data.snapshot);
          setStatus(data.connected && (desktop || pendingSnapshot) ? 'live' : 'disconnected', data.connected ? '' : 'Waiting for SHOWAVE on the desktop…');
          if (live) flushCommands();
          if (!data.connected) delay = 1000;
        }
      } catch (error) {
        if (mine === generation) { commands = []; setStatus(ended ? 'disconnected' : 'reconnecting', ended ? error.message : 'Connection interrupted. Reconnecting…'); delay = 1500; }
      } finally { root.clearTimeout(timeout); if (mine === generation) pollAbort = null; }
      if (mine !== generation) return;
      if (ended) {
        try { root.sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
        if (!desktop) welcome.hidden = false;
        return;
      }
      retryTimer = root.setTimeout(() => { retryTimer = null; poll(mine); }, delay);
    }
    function connect(next) {
      generation++; cancelCommands(); connection = next; revision = 0; ended = false;
      if (pollAbort) pollAbort.abort();
      root.clearTimeout(retryTimer); retryTimer = null;
      try { root.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch (_) {}
      setStatus('reconnecting', 'Connecting to the SHOWAVE desktop…');
      poll(generation);
    }
    doc.getElementById('mobile-join').addEventListener('submit', event => {
      event.preventDefault(); const next = parseConnection(doc.getElementById('mobile-link').value);
      if (!next) { message.textContent = 'Paste the complete phone link from Mirror Phone on your desktop.'; return; }
      doc.getElementById('mobile-link').value = ''; connect(next);
    });
    doc.getElementById('mobile-fullscreen').addEventListener('click', async () => {
      let fullscreen = false;
      try { if (!doc.fullscreenElement && doc.documentElement.requestFullscreen) await doc.documentElement.requestFullscreen(); fullscreen = !!doc.fullscreenElement; }
      catch (_) {}
      let locked = false;
      try { if (root.screen.orientation && root.screen.orientation.lock) { await root.screen.orientation.lock('landscape'); locked = true; } }
      catch (_) {}
      fit();
      if (!locked) help.textContent = fullscreen ? 'Fullscreen · Horizontal layout stays fitted; turn your phone for native landscape.' : 'Horizontal layout stays fitted. This browser does not allow landscape fullscreen.';
    });
    doc.getElementById('mobile-zoom-in').addEventListener('click', () => { zoom = Math.min(3, zoom + .25); fit(); });
    doc.getElementById('mobile-zoom-out').addEventListener('click', () => { zoom = Math.max(1, zoom - .25); fit(); });
    doc.getElementById('mobile-fit').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; fit(); });
    panButton.addEventListener('click', () => { panning = !panning; fit(); });
    panSurface.addEventListener('pointerdown', event => { panDrag = { x:event.clientX, y:event.clientY, panX, panY }; panSurface.setPointerCapture(event.pointerId); });
    panSurface.addEventListener('pointermove', event => {
      if (!panDrag) return;
      const dx = event.clientX - panDrag.x, dy = event.clientY - panDrag.y;
      panX = panDrag.panX + (geometry.rotated ? dy : dx); panY = panDrag.panY + (geometry.rotated ? -dx : dy); fit();
    });
    const finishPan = () => { panDrag = null; };
    panSurface.addEventListener('pointerup', finishPan); panSurface.addEventListener('pointercancel', finishPan);
    root.addEventListener('resize', fit);
    doc.addEventListener('fullscreenchange', fit);
    if (root.visualViewport) root.visualViewport.addEventListener('resize', fit);
    doc.addEventListener('visibilitychange', () => {
      if (!doc.hidden && connection && !ended && !pollAbort) { root.clearTimeout(retryTimer); retryTimer = null; poll(generation); }
    });
    root.addEventListener('pagehide', () => { cancelCommands(); if (pollAbort) pollAbort.abort(); });
    fit(); bootFrame();
    root.addEventListener('hashchange', () => {
      const next = parseConnection(root.location.hash);
      if (!next) return;
      root.history.replaceState(null, '', root.location.pathname + root.location.search);
      connect(next);
    });
    let initial = parseConnection(root.location.hash);
    if (root.location.hash) root.history.replaceState(null, '', root.location.pathname + root.location.search);
    if (!initial) { try { const saved = JSON.parse(root.sessionStorage.getItem(SESSION_KEY) || 'null'); initial = saved && parseConnection('room=' + encodeURIComponent(saved.room) + '&token=' + encodeURIComponent(saved.token)); } catch (_) {} }
    if (initial) connect(initial);
  }
  return { start, layout, point, parseConnection, resourceAllowed, sanitize, reconcile };
});
