/* Desktop-owned SHOWAVE controller. Nothing runs on the controller except an
 * inert view: each action is replayed into the original desktop controls. */
(function installMobileHost(global) {
  'use strict';
  if (global.ShowaveMobileHost || !global.document) return;
  const doc = global.document;
  const embedded = global.top !== global;
  const hostId = 'desktop-' + Math.random().toString(36).slice(2);
  const ids = new WeakMap();
  const sensitiveControls = new WeakSet();
  const imageCache = new WeakMap(), previewCache = new WeakMap(), cssCache = new WeakMap();
  const documentKeys=new WeakMap(),stableKeys=new Map(),semanticRecords=new Map();
  let documentCount=0;
  let nodes = new Map(), nextId = 0, sequence = 0;
  let pairing = null, owner = '', cursor = 0, sending = false, polling = false;
  let channel = null, dialog = null, dialogControls = null, dialogDismiss = null;
  let apiStatus = null, lastError = '', starting = null, stopping = null, qrLoader = null;
  let sessionRevision = 0, announcedPaired = null;
  const pairingViews = new Set();
  const captures = new Map();
  const captureRects = new Map();
  const remoteWindows = new Map();
  const ownUi = '[data-sw-mobile-private],[data-mobile-private]';
  const blockedTags = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'OBJECT', 'EMBED']);
  const mouseTypes = {pointerdown:'mousedown',pointermove:'mousemove',pointerup:'mouseup',pointercancel:'mouseup'};
  const escapeText = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const headingOf=section=>section?.querySelector('h4')?.textContent.trim() || '';
  const labelOf=row=>row?.querySelector('label')?.textContent.trim() || '';
  function mapContext(sourceDoc) {
    const state=sourceDoc.defaultView?.__ao?.editor?.state;
    return state ? JSON.stringify([state.screenId,state.sel || [],state.stage,state.tab || state.mode || '',state.point || null]) : null;
  }
  function semanticRecord(node) {
    const sourceDoc=node.ownerDocument;
    if(node.id) return {doc:sourceDoc,elementId:node.id,signature:node.tagName+':'+(node.type || '')};
    if(!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(node.tagName)) return null;
    const row=node.closest('.ao-row'),section=row?.closest('.ao-sec');
    const context=mapContext(sourceDoc);
    if(!row || !section || context===null) return null;
    const heading=headingOf(section),label=labelOf(row);
    const sections=Array.from(sourceDoc.querySelectorAll('.ao-sec')).filter(item=>headingOf(item)===heading);
    const rows=Array.from(section.querySelectorAll('.ao-row')).filter(item=>labelOf(item)===label);
    const controls=Array.from(row.querySelectorAll(node.tagName));
    return {doc:sourceDoc,context,heading,label,sectionIndex:sections.indexOf(section),rowIndex:rows.indexOf(row),controlIndex:controls.indexOf(node),tag:node.tagName,signature:node.tagName+':'+(node.type || '')};
  }
  function resolveRecord(record) {
    let node;
    if(record.elementId) node=record.doc.getElementById(record.elementId);
    else {
      if(mapContext(record.doc)!==record.context) return null;
      const section=Array.from(record.doc.querySelectorAll('.ao-sec')).filter(item=>headingOf(item)===record.heading)[record.sectionIndex];
      const row=section && Array.from(section.querySelectorAll('.ao-row')).filter(item=>labelOf(item)===record.label)[record.rowIndex];
      node=row?.querySelectorAll(record.tag)[record.controlIndex];
    }
    return node && node.tagName+':'+(node.type || '')===record.signature ? node : null;
  }
  function idFor(node) {
    const record=semanticRecord(node);
    if(record) {
      if(!documentKeys.has(record.doc))documentKeys.set(record.doc,++documentCount);
      const key=documentKeys.get(record.doc)+':'+JSON.stringify({...record,doc:undefined});
      if(!stableKeys.has(key))stableKeys.set(key,hostId+'-'+(++nextId));
      const id=stableKeys.get(key);ids.set(node,id);semanticRecords.set(id,record);
    } else if (!ids.has(node)) ids.set(node, hostId + '-' + (++nextId));
    const id = ids.get(node); nodes.set(id, node); return id;
  }
  function sensitive(node) {
    if (!node.matches) return false;
    if (sensitiveControls.has(node)) return true;
    const protectedControl = node.matches('input[type=password],input[type=file],[data-sw-mobile-private],[data-mobile-private]') ||
      (node.tagName === 'INPUT' && (
        /^(?:nfUrl|nfKey|olsWhipUrl|olsObsPass|olsWhipToken)$/i.test(node.id || '') ||
        /^(?:rtmp-ingest|whip-token)$/.test(node.getAttribute('data-destination-action') || '') ||
        /^The full ingest URL including the stream key\b/i.test(node.title || '') ||
        /^(?:password|current-password|new-password|stream[-_]?key|bearer[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i.test(node.name || '') ||
        /^(?:current-password|new-password)$/.test(node.autocomplete || '')));
    // Revealing a desktop password must never turn it into a remote field.
    if (protectedControl) sensitiveControls.add(node);
    return protectedControl;
  }
  function safeAsset(value, base) {
    if (/^data:image\//i.test(value || '')) return value;
    try {
      const url = new URL(value, base);
      if (url.origin === global.location.origin &&
          (/^\/assets\/(?:brand|source-controls|creative-icons|fonts)\//.test(url.pathname) ||
           /^\/assets\/presenter-icons\/[^/]+\.(?:svg|png|ico)$/i.test(url.pathname))) return url.pathname;
    } catch (_) {}
    return '';
  }
  function imagePixels(node) {
    const view = node.ownerDocument.defaultView;
    const width = node.videoWidth || node.naturalWidth || node.width;
    const height = node.videoHeight || node.naturalHeight || node.height;
    if (!width || !height) return '';
    if(captures.size && node.tagName!=='IMG' && previewCache.has(node)) return previewCache.get(node);
    const source=node.currentSrc || node.src || '';
    const rect=node.getBoundingClientRect();
    if(node.tagName!=='IMG') {
      const hit=view.document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      if(!hit || (hit!==node && !node.contains(hit))) return previewCache.get(node) || '';
    }
    const scale = Math.min(1, 1024 / width, 768 / height,Math.max(1,rect.width*2)/width,Math.max(1,rect.height*2)/height);
    const rasterWidth=Math.max(1,Math.round(width*scale)),rasterHeight=Math.max(1,Math.round(height*scale));
    if(node.tagName==='IMG') { const cached=imageCache.get(node); if(cached && cached.source===source && cached.width===rasterWidth && cached.height===rasterHeight) return cached.pixels; }
    try {
      const canvas = view.document.createElement('canvas');
      canvas.width = rasterWidth; canvas.height = rasterHeight;
      canvas.getContext('2d').drawImage(node, 0, 0, canvas.width, canvas.height);
      const pixels=node.tagName === 'IMG' && !/\.jpe?g(?:[?#]|$)|^data:image\/jpeg/i.test(source) ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', .7);
      if(node.tagName==='IMG') imageCache.set(node,{source,width:rasterWidth,height:rasterHeight,pixels});
      else previewCache.set(node,pixels);
      return pixels;
    } catch (_) { return ''; }
  }
  function documentCSS(sourceDoc) {
    const css = [];
    for (const sheet of Array.from(sourceDoc.styleSheets || [])) {
      try {
        const base = sheet.href || sourceDoc.baseURI;
        const signature=sheet.cssRules.length + ':' + (sheet.ownerNode?.textContent || '');
        const cached=cssCache.get(sheet);
        if(cached && cached.signature===signature){css.push(cached.css);continue;}
        const text=Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, quote, url) => {
          if (url.startsWith('#')) return all;
          const asset = safeAsset(url, base);
          return asset ? 'url("' + asset.replace(/"/g, '') + '")' : 'none';
        });
        cssCache.set(sheet,{signature,css:text});css.push(text);
      } catch (_) { /* A third party stylesheet has no readable CSSOM. */ }
    }
    const computed = sourceDoc.defaultView.getComputedStyle(sourceDoc.documentElement);
    const variables = [];
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i];
      if (name.startsWith('--')) variables.push(name + ':' + computed.getPropertyValue(name));
    }
    css.push(':root{' + variables.join(';') + '}');
    css.push('html,body{overscroll-behavior:none;touch-action:none} [data-sw-mobile-canvas]{object-fit:fill}');
    return css.join('\n');
  }
  function serializeNode(node, fields, depth) {
    if (node.nodeType === 3) return node.cloneNode();
    if (node.nodeType !== 1 || blockedTags.has(node.tagName) || node.matches(ownUi)) return null;
    const sourceDoc = node.ownerDocument;
    if(node.hidden || sourceDoc.defaultView.getComputedStyle(node).display==='none') return null;
    const clone = node.cloneNode(false);
    const id = idFor(node);
    clone.setAttribute('data-sw-mobile-id', id);
    for (const attr of Array.from(clone.attributes)) {
      if (/^on/i.test(attr.name) || ['srcdoc','srcset','action','formaction','integrity','nonce','autofocus'].includes(attr.name) ||
          /(?:token|secret|credential|password)/i.test(attr.name)) clone.removeAttribute(attr.name);
    }
    if (clone.hasAttribute('href') && clone.tagName !== 'USE') clone.setAttribute('href', '#');
    if (sensitive(node)) {
      clone.removeAttribute('value'); clone.setAttribute('disabled', '');
      clone.setAttribute('placeholder', node.type === 'file' ? 'Choose files on the desktop' : 'Enter on the desktop');
      clone.setAttribute('data-sw-mobile-blocked', '1');
      if (node.tagName === 'TEXTAREA') clone.textContent = '';
      return clone;
    }
    const field = {id};
    if (node.scrollLeft || node.scrollTop || node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) { field.scrollLeft = node.scrollLeft; field.scrollTop = node.scrollTop; }
    if (node.isContentEditable) field.value = node.textContent;
    if (['INPUT','TEXTAREA','SELECT'].includes(node.tagName)) {
      field.value = node.value;
      if (node.tagName === 'INPUT') { clone.setAttribute('value', node.value); field.checked = node.checked; clone.toggleAttribute('checked', node.checked); }
      if (node.tagName === 'SELECT') field.selectedIndex = node.selectedIndex;
    }
    if (Object.keys(field).length > 1) fields.push(field);
    if (['CANVAS','VIDEO','IMG'].includes(node.tagName)) {
      const img = sourceDoc.createElement('img');
      for (const attr of Array.from(clone.attributes)) if (!['src','autoplay','controls','poster'].includes(attr.name)) img.setAttribute(attr.name, attr.value);
      const rect = node.getBoundingClientRect();
      const pixels = (rect.width>0 && rect.height>0 ? imagePixels(node) : '') || safeAsset(node.currentSrc || node.src, sourceDoc.baseURI);
      if (pixels) img.setAttribute('src', pixels);
      else img.setAttribute('alt', node.tagName === 'IMG' ? (node.alt || '') : 'Preview unavailable');
      if (node.tagName !== 'IMG') img.setAttribute('data-sw-mobile-canvas', '1');
      const computed=sourceDoc.defaultView.getComputedStyle(node);
      for(const name of ['display','position','top','right','bottom','left','width','height','min-width','min-height','max-width','max-height','margin','padding','border','border-radius','box-sizing','object-fit','opacity','transform','transform-origin','flex','align-self','z-index','visibility']) img.style.setProperty(name,computed.getPropertyValue(name));
      return img;
    }
    if (node.tagName === 'IFRAME') {
      clone.removeAttribute('src'); clone.setAttribute('sandbox', 'allow-same-origin');
      const rect = node.getBoundingClientRect();
      if (depth < 4 && rect.width > 1 && rect.height > 1 && sourceDoc.defaultView.getComputedStyle(node).display !== 'none') {
        try {
          const frameDoc = node.contentDocument;
          if (frameDoc && frameDoc.body && node.contentWindow.location.origin === global.location.origin) {
            const frame = serializeDocument(frameDoc, depth + 1);
            fields.push(...frame.fields);
            clone.setAttribute('data-sw-mobile-frame', '1');
            clone.setAttribute('srcdoc', '<!doctype html><html class="' + escapeText(frame.rootClass) + '"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: \'self\'; style-src \'unsafe-inline\'; font-src \'self\'; script-src \'none\'; form-action \'none\'"><style>' + frame.css.replace(/<\/style/gi, '<\\/style') + '</style></head><body class="' + escapeText(frame.bodyClass) + '" style="' + escapeText(frame.bodyStyle) + '" data-sw-mobile-id="' + frame.bodyId + '">' + frame.html + '</body></html>');
          }
        } catch (_) { clone.setAttribute('title', 'This view requires the desktop'); }
      }
      return clone;
    }
    if (clone.hasAttribute('src')) {
      const asset = safeAsset(clone.getAttribute('src'), sourceDoc.baseURI);
      if (asset) clone.setAttribute('src', asset); else clone.removeAttribute('src');
    }
    for (const child of Array.from(node.childNodes)) {
      const copy = serializeNode(child, fields, depth); if (copy) clone.appendChild(copy);
    }
    if (node.tagName === 'TEXTAREA') clone.textContent = node.value;
    if (node.tagName === 'OPTION') clone.toggleAttribute('selected', node.selected);
    return clone;
  }
  function serializeDocument(sourceDoc, depth) {
    const fields = [], container = sourceDoc.createElement('div');
    for (const node of Array.from(sourceDoc.body.childNodes)) {
      const copy = serializeNode(node, fields, depth); if (copy) container.appendChild(copy);
    }
    return {html:container.innerHTML, css:documentCSS(sourceDoc), fields,
      rootClass:sourceDoc.documentElement.className, rootStyle:sourceDoc.documentElement.style.cssText,
      bodyClass:sourceDoc.body.className, bodyStyle:sourceDoc.body.style.cssText, bodyId:idFor(sourceDoc.body)};
  }
  function snapshot() {
    nodes = new Map();
    const frame = serializeDocument(doc, 0);
    for(const id of semanticRecords.keys())if(!nodes.has(id))semanticRecords.delete(id);
    return {...frame, hostId, width:global.innerWidth, height:global.innerHeight,
      scrollX:global.scrollX,scrollY:global.scrollY,title:doc.title,url:global.location.pathname,
      module:doc.querySelector('[data-showave-brand]')?.getAttribute('data-showave-brand') || 'live',
      sequence:++sequence,at:Date.now()};
  }
  function openRemoteWindow(original, view, url, name, features) {
    let address;
    try { address = new URL(url, view.location.href); } catch (_) { return null; }
    // Existing popups are used when the browser allows them. A remote gesture
    // cannot open a new browser window, so first-party editors get a retained
    // desktop panel instead. External sign-in remains a desktop browser action.
    if (address.origin !== global.location.origin || !/\/(?:broadcast|advanced-output|workspace|wire|alley|gsl5|chaser|timeline|grid-tool|preferences|shortcuts|fixture-editor|encoder-editor|media-manager|presets|panel|wire-settings|envelope-editor)\.html$/.test(address.pathname)) return original.call(view,url,name,features);
    const existing = remoteWindows.get(name || address.pathname);
    if (existing && existing.overlay.isConnected) return existing.handle;
    const popup = original.call(view,url,name,features);
    if (popup) return popup;
    const overlay = doc.createElement('section');
    overlay.style.cssText='position:fixed;inset:0;z-index:2147483000;background:var(--panel,#17202b);display:flex;flex-direction:column';
    const bar=doc.createElement('div'); bar.style.cssText='height:28px;display:flex;align-items:center;justify-content:space-between;padding:0 8px;font:11px system-ui;color:var(--n100,#fff)';
    const label=doc.createElement('span'); label.textContent='SHOWAVE · Remote controller window'; bar.appendChild(label);
    const close=doc.createElement('button');close.className='btn';close.textContent='Close window';close.type='button';bar.appendChild(close);overlay.appendChild(bar);
    const frame=doc.createElement('iframe');frame.src=address.pathname+address.search+address.hash;frame.style.cssText='width:100%;flex:1;min-height:0;border:0';overlay.appendChild(frame);doc.body.appendChild(overlay);
    const key=name||address.pathname;
    const dismiss=()=>{overlay.remove();remoteWindows.delete(key);};close.onclick=dismiss;
    const handle=new Proxy(frame.contentWindow,{get(target,key){if(key==='closed')return !overlay.isConnected;if(key==='close')return dismiss;if(key==='focus')return ()=>frame.focus();const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    remoteWindows.set(key,{overlay,handle});return handle;
  }
  function applyCommand(command) {
    if (!command || (command.hostId && command.hostId !== hostId)) return false;
    const captured=['pointermove','pointerup','pointercancel'].includes(command.type) && captures.get(command.pointerId || 1);
    let target = captured || nodes.get(command.target);
    const record=semanticRecords.get(command.target);
    if(!captured && record) {
      if(record.context!==undefined && mapContext(record.doc)!==record.context)return false;
      if(!target?.isConnected){target=resolveRecord(record);if(target)nodes.set(command.target,target);}
    }
    if (!target || !target.isConnected || sensitive(target) || target.closest?.(ownUi) || target.disabled) return false;
    const view = target.ownerDocument.defaultView;
    if(!view || view.document!==target.ownerDocument) return false;
    if(command.type==='focus') {target.focus?.({preventScroll:true});return true;}
    if(command.type==='blur') {target.blur?.();return true;}
    if (command.type === 'scroll') {
      target.scrollLeft = Number(command.scrollLeft) || 0; target.scrollTop = Number(command.scrollTop) || 0;
      target.dispatchEvent(new view.Event('scroll', {bubbles:true})); return true;
    }
    if (command.type === 'input' || command.type === 'change') {
      if (!['INPUT','TEXTAREA','SELECT'].includes(target.tagName) && !target.isContentEditable) return false;
      if (typeof command.value === 'string') { if(target.isContentEditable) target.textContent=command.value; else target.value = command.value; }
      if (typeof command.checked === 'boolean') target.checked = command.checked;
      target.dispatchEvent(new view.Event(command.type, {bubbles:true})); return true;
    }
    const pointerId=command.pointerId || 1;
    const rect = captureRects.get(pointerId) || target.getBoundingClientRect();
    const init = {bubbles:true,cancelable:true,composed:true,view,
      clientX:rect.left + (Number.isFinite(command.x) ? command.x : .5) * rect.width,
      clientY:rect.top + (Number.isFinite(command.y) ? command.y : .5) * rect.height,
      button:Number(command.button) || 0, buttons:Number(command.buttons) || 0,
      ctrlKey:!!command.ctrlKey,altKey:!!command.altKey,shiftKey:!!command.shiftKey,metaKey:!!command.metaKey,
      pointerId:command.pointerId || 1,pointerType:'mouse',isPrimary:true,
      key:String(command.key || ''),code:String(command.code || ''),
      deltaX:Number(command.deltaX) || 0,deltaY:Number(command.deltaY) || 0,deltaMode:0};
    const type = command.type;
    if (!['pointerdown','pointermove','pointerup','pointercancel','click','dblclick','contextmenu','wheel','keydown','keyup','mouseover'].includes(type)) return false;
    const proto = view.Element.prototype;
    const originalSet = proto.setPointerCapture, originalRelease = proto.releasePointerCapture;
    // A synthetic pointer has no browser-native capture. Keep the app's drag
    // target here so unguarded capture calls in the Map editor remain usable.
    proto.setPointerCapture = function(id) { captures.set(id, this); };
    proto.releasePointerCapture = function(id) { captures.delete(id); captureRects.delete(id); };
    const views=Array.from(new Set([view,global]));
    const opens=views.map(win=>({win,open:win.open}));
    for(const item of opens) item.win.open=function(url,name,features){return openRemoteWindow(item.open,item.win,url,name,features);};
    try {
      if (type === 'pointerdown') { target.focus?.({preventScroll:true}); captures.set(init.pointerId, target); captureRects.set(init.pointerId,{left:rect.left,top:rect.top,width:rect.width,height:rect.height}); }
      if(type==='mouseover') target.dispatchEvent(new view.MouseEvent('mouseenter',{...init,bubbles:false}));
      const Constructor = type.startsWith('key') ? view.KeyboardEvent : type === 'wheel' ? view.WheelEvent : type.startsWith('pointer') ? view.PointerEvent : view.MouseEvent;
      const accepted=target.dispatchEvent(new Constructor(type, init));
      if (mouseTypes[type]) target.dispatchEvent(new view.MouseEvent(mouseTypes[type], init));
      if(type==='wheel' && accepted) {
        let scroll=target;
        while(scroll && scroll!==target.ownerDocument.body && scroll.scrollHeight<=scroll.clientHeight && scroll.scrollWidth<=scroll.clientWidth) scroll=scroll.parentElement;
        if(scroll){scroll.scrollTop+=init.deltaY;scroll.scrollLeft+=init.deltaX;}
      }
    } finally {
      proto.setPointerCapture = originalSet; proto.releasePointerCapture = originalRelease;
      for(const item of opens) item.win.open=item.open;
      if (type === 'pointerup' || type === 'pointercancel') { captures.delete(init.pointerId); captureRects.delete(init.pointerId); }
    }
    return true;
  }
  async function request(path, data) {
    const abort=new global.AbortController();
    const timeout=global.setTimeout(()=>abort.abort(),10000);
    try {
      const result = await global.fetch('/api/mobile/' + path, {...(data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {}),signal:abort.signal});
      const payload = await result.json();
      if (!result.ok) { const error=new Error(payload.error || payload.reason || 'Desktop connection failed'); error.status=result.status; throw error; }
      return payload;
    } finally {global.clearTimeout(timeout);}
  }
  function announce(type) { try { channel?.postMessage({type, pairing, owner, from:hostId}); } catch (_) {} }
  function setPair(value, nextOwner) { if(!value)releaseAbandonedDrag();if (value?.room !== pairing?.room) cursor = 0; pairing = value; owner = nextOwner || hostId; updateButtons(); }
  async function publish() {
    if (!pairing || owner !== hostId || sending) return;
    const current = pairing;
    sending = true;
    try {
      await request('snapshot', {room:current.room,token:current.hostToken,snapshot:snapshot()});
      if(pairing !== current) return;
      lastError = ''; updateButtons();
      return true;
    } catch (error) { if(pairing !== current) return; if(error.status===410){setPair(null);announce('stop');} lastError = error.message; updateButtons(); }
    finally { sending = false; }
  }
  async function pollCommands() {
    if (!pairing || owner !== hostId || polling) return;
    const current = pairing;
    polling = true;
    try {
      const result = await request('commands?room=' + encodeURIComponent(current.room) + '&token=' + encodeURIComponent(current.hostToken) + '&after=' + cursor);
      if(pairing !== current || owner !== hostId) return;
      for (const entry of result.commands || []) { if (entry.id > cursor) { applyCommand(entry.command); cursor = entry.id; } }
      cursor = Math.max(cursor, result.cursor || 0);
      if(result.controllerConnected===false) releaseAbandonedDrag();
    } catch (error) { if(pairing !== current) return; if(error.status===410){setPair(null);announce('stop');} lastError = error.message; }
    finally { polling = false; }
  }
  function releaseAbandonedDrag() {
    if(!captures.size) return;
    for(const [pointerId,target] of Array.from(captures)) {
      applyCommand({type:'pointercancel',target:idFor(target),pointerId,buttons:0});
      captures.delete(pointerId);captureRects.delete(pointerId);
    }
  }
  function updateButtons() {
    doc.querySelectorAll('[data-sw-mobile-open]').forEach(button => { button.textContent = pairing ? 'Show controller QR code' : 'Pair a remote controller'; });
    for (const update of pairingViews) update();
    if (announcedPaired !== !!pairing) {
      announcedPaired = !!pairing;
      global.dispatchEvent(new global.CustomEvent('showave:mobile-pairing-changed', {detail:{paired:announcedPaired}}));
    }
  }
  async function start() {
    if (embedded && global.top.ShowaveMobileHost) return global.top.ShowaveMobileHost.start();
    if (stopping) { await stopping; return start(); }
    if (starting) return starting;
    const revision = sessionRevision;
    const requireCurrent = () => { if (revision !== sessionRevision) throw new Error('Mirroring stopped. Show a new QR code to reconnect.'); };
    const createPair = async () => {
      const value = await request('pair', {});
      if (revision !== sessionRevision) {
        // Stop may happen while the native service is discovering adapters. A
        // room returned afterward must not become an untracked active session.
        try { await request('revoke', {room:value.room,token:value.hostToken}); }
        catch (error) {
          if (error.status !== 410) { setPair(value, hostId); announce('pair'); throw error; }
        }
        requireCurrent();
      }
      setPair(value, hostId); announce('pair');
    };
    lastError = '';
    const pending = (async () => {
      if (!pairing) await createPair();
      requireCurrent();
      await publish();
      requireCurrent();
      if (!pairing) { await createPair(); await publish(); requireCurrent(); }
      if(lastError) throw new Error(lastError);
      return pairing;
    })();
    starting = pending;
    try { return await pending; }
    finally { if (starting === pending) starting = null; }
  }
  async function stop() {
    if (embedded && global.top.ShowaveMobileHost) return global.top.ShowaveMobileHost.stop();
    if (stopping) return stopping;
    const pendingStart = starting;
    sessionRevision++;
    const pending = (async () => {
      if (pendingStart) { try { await pendingStart; } catch (_) {} }
      while (pairing) {
        const current = pairing;
        try { await request('revoke', {room:current.room,token:current.hostToken}); }
        catch (error) { if (error.status !== 410) { lastError=error.message; updateButtons(); throw error; } }
        // A different desktop can announce its room during revocation. Never
        // erase that room without asking the service to end it as well.
        if (pairing===current) setPair(null);
      }
      lastError=''; setPair(null); announce('stop');
    })();
    stopping = pending;
    try { return await pending; }
    finally { if (stopping === pending) stopping=null; updateButtons(); }
  }
  async function loadQr() {
    if (typeof global.qrcode !== 'function') {
      if (!qrLoader) qrLoader = new Promise((resolve,reject) => {
        const script = doc.createElement('script'); script.src = 'openlive-qrcode.js';
        script.onload = resolve; script.onerror = () => { qrLoader=null; reject(new Error('The QR code could not load. Try again.')); };
        doc.head.appendChild(script);
      });
      await qrLoader;
    }
  }
  function mountPairing(container) {
    if (embedded && global.top.ShowaveMobileHost) return global.top.ShowaveMobileHost.mountPairing(container);
    if (!container || !container.ownerDocument) throw new TypeError('A local container is required for Mirror Display.');
    const viewDoc = container.ownerDocument, view = viewDoc.defaultView || global;
    const panel = viewDoc.createElement('div');
    panel.className='showave-mobile-pairing'; panel.hidden=true;
    panel.setAttribute('data-sw-mobile-pairing',''); panel.setAttribute('data-sw-mobile-private','');
    const qrRegion=viewDoc.createElement('div'); qrRegion.className='showave-mobile-pairing-qr'; qrRegion.setAttribute('data-sw-mobile-qr',''); panel.appendChild(qrRegion);
    const details=viewDoc.createElement('div'); details.className='showave-mobile-pairing-details'; panel.appendChild(details);
    const intro=viewDoc.createElement('p'); intro.className='showave-mobile-pairing-intro';
    intro.textContent='Scan with a phone, tablet or laptop on the same network. Anyone with this link can operate this Show.'; details.appendChild(intro);
    const address=viewDoc.createElement('select'); address.className='showave-mobile-pairing-address'; address.hidden=true;
    address.setAttribute('data-sw-mobile-address',''); address.setAttribute('aria-label','Controller network address'); details.appendChild(address);
    const link=viewDoc.createElement('a'); link.className='showave-mobile-pairing-link'; link.hidden=true;
    link.setAttribute('data-sw-mobile-link',''); link.target='_blank'; link.rel='noopener noreferrer';
    link.style.cssText='overflow-wrap:anywhere;font-size:10px'; details.appendChild(link);
    const status=viewDoc.createElement('p'); status.className='showave-mobile-pairing-status';
    status.setAttribute('data-sw-mobile-status',''); status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); details.appendChild(status);
    const actions=viewDoc.createElement('div'); actions.className='showave-mobile-pairing-actions'; details.appendChild(actions);
    const button = (marker, label) => {
      const item=viewDoc.createElement('button'); item.type='button'; item.className='btn tb-btn'; item.textContent=label;
      item.setAttribute(marker,''); actions.appendChild(item); return item;
    };
    const copy=button('data-sw-mobile-copy','Copy Link'); copy.disabled=true;
    const retry=button('data-sw-mobile-retry','Show QR code');
    const end=button('data-sw-mobile-stop','Stop mirroring'); end.disabled=true;
    container.replaceChildren(panel);
    let visible=false, destroyed=false, busy=false, revision=0, renderedPair=null, selectedUrl='', chosenHost='', renderPending=null, shownError='';
    const readyText='Ready to scan. This computer runs the Show, media and outputs.';
    const current = value => !destroyed && visible && revision===value;
    const clear = () => {
      qrRegion.replaceChildren(); address.replaceChildren(); address.hidden=true;
      link.removeAttribute('href'); link.textContent=''; link.hidden=true;
      selectedUrl=''; renderedPair=null; copy.disabled=true;
    };
    const paintUrl = url => {
      if (!visible || destroyed || !renderedPair || !(renderedPair.joinUrls || []).includes(url)) return;
      const qr=global.qrcode(0,'M'); qr.addData(url); qr.make();
      const image=viewDoc.createElement('img'); image.setAttribute('data-sw-mobile-qr-image','');
      image.src=qr.createDataURL(5,12); image.alt='Scan to pair your SHOWAVE remote controller';
      image.style.cssText='display:block;width:var(--showave-mobile-qr-size,176px);height:auto;max-width:100%;image-rendering:pixelated';
      qrRegion.replaceChildren(image); selectedUrl=url;
      link.href=url; link.textContent=url; link.hidden=false; copy.disabled=false;
      try { chosenHost=new URL(url).host; } catch (_) { chosenHost=''; }
      shownError=lastError; status.textContent=lastError || readyText;
    };
    const render = async (pair, value) => {
      await loadQr();
      if (!current(value) || pairing !== pair) return false;
      const urls=(pair.joinUrls || []).filter(url => {
        try { const parsed=new URL(url); return /^https?:$/.test(parsed.protocol) && parsed.pathname==='/mobile.html' && !parsed.username && !parsed.password; }
        catch (_) { return false; }
      });
      if (!urls.length) throw new Error('No network address was found. Connect this computer to Wi-Fi or Ethernet, then try again.');
      address.replaceChildren();
      for (const url of urls) {
        const option=viewDoc.createElement('option'); option.value=url; option.textContent=new URL(url).host; address.appendChild(option);
      }
      address.hidden=urls.length < 2;
      renderedPair=pair;
      const selected=urls.find(url=>new URL(url).host===chosenHost) || urls[0];
      address.value=selected; paintUrl(selected); end.disabled=false; retry.textContent='Refresh QR code';
      return true;
    };
    const sync = () => {
      if (!visible || destroyed || busy) return;
      end.disabled=!pairing || !!stopping;
      if (!pairing) {
        clear(); status.textContent=lastError || 'Mirroring stopped. Show a new QR code to reconnect.'; retry.textContent='Show QR code';
      } else if (renderedPair !== pairing && !renderPending) {
        const pair=pairing, value=revision;
        renderPending=render(pair,value).catch(error=>{
          if (current(value)) { clear(); status.textContent=error.message || 'The connection could not start.'; retry.textContent='Try again'; }
        }).finally(()=>{renderPending=null;});
      } else if (lastError) { shownError=lastError; status.textContent=lastError; }
      else if (shownError) { shownError=''; status.textContent=readyText; }
    };
    const show = async () => {
      if (destroyed) return false;
      if (visible && busy) return false;
      visible=true; panel.hidden=false; const value=++revision; busy=true;
      clear(); retry.disabled=true; end.disabled=true; status.textContent='Preparing your controller QR code…';
      try {
        const pair=await start();
        if (!current(value)) return false;
        return await render(pair,value);
      } catch (error) {
        if (current(value)) { clear(); status.textContent=error.message || 'The desktop connection could not start. Try again.'; retry.textContent='Try again'; }
        return false;
      } finally {
        if (current(value)) { busy=false; retry.disabled=false; end.disabled=!pairing || !!stopping; }
      }
    };
    const hide = () => {
      if (destroyed) return;
      visible=false; revision++; busy=false; renderPending=null; panel.hidden=true;
      clear(); status.textContent=''; retry.disabled=false; end.disabled=true;
    };
    address.addEventListener('change',()=>paintUrl(address.value));
    copy.addEventListener('click',async()=>{
      const url=selectedUrl, value=revision;
      if (!url || copy.disabled || !current(value)) return;
      copy.disabled=true;
      try {
        let copied=false;
        try { if (view.navigator.clipboard?.writeText) { await view.navigator.clipboard.writeText(url); copied=true; } } catch (_) {}
        if (!current(value) || selectedUrl!==url) return;
        if (!copied) {
          const previous=viewDoc.activeElement, selection=view.getSelection?.(), ranges=[];
          if (selection) for (let i=0;i<selection.rangeCount;i++) ranges.push(selection.getRangeAt(i).cloneRange());
          const field=viewDoc.createElement('textarea'); field.value=url; field.setAttribute('data-sw-mobile-private','');
          field.setAttribute('readonly',''); field.style.cssText='position:fixed;left:-10000px;top:0;opacity:0'; panel.appendChild(field);
          try { field.focus({preventScroll:true}); field.select(); copied=!!viewDoc.execCommand?.('copy'); }
          finally {
            field.remove(); previous?.focus?.({preventScroll:true});
            if (selection) { selection.removeAllRanges(); for (const range of ranges) { try { selection.addRange(range); } catch (_) {} } }
          }
        }
        if (current(value)) {
          if (copied) status.textContent='Link copied. Open it on a device connected to the same network.';
          else { status.textContent='Copy is unavailable. Select the link above and copy it manually.'; link.focus(); }
        }
      } finally { if (current(value)) copy.disabled=!selectedUrl; }
    });
    retry.addEventListener('click',show);
    end.addEventListener('click',async()=>{
      if (busy || !visible || destroyed) return;
      const value=++revision; busy=true; end.disabled=true; retry.disabled=true; copy.disabled=true;
      status.textContent='Stopping mirroring…';
      try { await stop(); if (current(value)) { clear(); status.textContent='Mirroring stopped. Show a new QR code to reconnect.'; retry.textContent='Show QR code'; } }
      catch (error) { if (current(value)) status.textContent=error.message || 'Mirroring could not stop. Try again.'; }
      finally { if (current(value)) { busy=false; retry.disabled=false; end.disabled=!pairing; copy.disabled=!selectedUrl; } }
    });
    pairingViews.add(sync);
    return Object.freeze({show,hide,destroy(){if(destroyed)return;hide();destroyed=true;pairingViews.delete(sync);panel.remove();}});
  }
  async function openPairing() {
    if (embedded && global.top.ShowaveMobileHost) return global.top.ShowaveMobileHost.openPairing();
    dialogDismiss?.();
    dialog = doc.createElement('div'); dialog.setAttribute('data-sw-mobile-private', '');
    dialog.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:#0009;display:grid;place-items:center;font:13px system-ui;color:#edf2fa';
    const box = doc.createElement('section'); box.setAttribute('role','dialog'); box.setAttribute('aria-label','Remote controller pairing');
    box.style.cssText = 'background:#17202b;border:1px solid #65758a;border-radius:14px;padding:20px;width:min(480px,90vw);max-height:90vh;overflow:auto';
    dialog.appendChild(box); doc.body.appendChild(dialog);
    const heading = doc.createElement('h2'); heading.textContent = 'Mirror Display'; heading.style.cssText = 'font-size:18px;margin:0 0 10px'; box.appendChild(heading);
    const content=doc.createElement('div'); box.appendChild(content); dialogControls=mountPairing(content);
    const ownDialog=dialog, ownControls=dialogControls, previous=doc.activeElement;
    const dismiss = () => {
      doc.removeEventListener('keydown',keyDown); ownControls.destroy(); ownDialog.remove();
      if (dialog===ownDialog) { dialog=null; dialogControls=null; dialogDismiss=null; }
      previous?.focus?.({preventScroll:true});
    };
    const keyDown=event=>{if(event.key==='Escape'){event.preventDefault();dismiss();}};
    dialogDismiss=dismiss;
    doc.addEventListener('keydown',keyDown); ownDialog.addEventListener('click',event=>{if(event.target===ownDialog)dismiss();});
    const close = doc.createElement('button'); close.type='button'; close.textContent = 'Close'; close.className = 'btn'; close.onclick=dismiss; box.appendChild(close); close.focus();
    await ownControls.show();
  }
  function mountPreferences() {
    const section = doc.querySelector('section[data-tab="remote-controller"]');
    if (!section || section.hasAttribute('data-sw-mobile-mounted')) return;
    section.setAttribute('data-sw-mobile-mounted','');
    const container=section.querySelector('[data-sw-mobile-settings]') || section;
    const controls=mountPairing(container); let visible=false;
    const selected = () => { const next=!section.hidden; if(next!==visible) { if(next)controls.show();else controls.hide(); } visible=next; };
    new global.MutationObserver(selected).observe(section,{attributes:true,attributeFilter:['hidden']}); selected();
    global.addEventListener('pagehide',()=>controls.destroy(),{once:true});
    const webserver = doc.querySelector('section[data-tab="webserver"]');
    if (webserver && !webserver.querySelector('[data-sw-mobile-shortcut]')) {
      const group=doc.createElement('div'); group.className='formgroup'; group.setAttribute('data-sw-mobile-shortcut','');
      group.innerHTML='<h3>Remote Controller</h3><p class="hint">Scan a QR code to mirror this Show on your phone, tablet or laptop.</p><button class="tb-btn" type="button" data-sw-mobile-open>Open controller QR code</button>';
      group.querySelector('button').addEventListener('click',()=>doc.querySelector('[data-t="remote-controller"]')?.click()); webserver.appendChild(group);
    }
  }
  function boot() {
    mountPreferences();
    if (embedded) return;
    try {
      channel = new global.BroadcastChannel('showave-mobile-host-v1');
      channel.onmessage = event => {
        const message = event.data;
        if (!message || message.from === hostId) return;
        if (message.type === 'hello' && pairing) announce('pair');
        if (message.type === 'pair') {
          setPair(message.pairing, message.owner);
          if (pairing && doc.hasFocus() && owner !== hostId) { owner=hostId; announce('claim'); publish(); }
        }
        if (message.type === 'claim' && pairing) { owner = message.owner; captures.clear(); captureRects.clear(); }
        if (message.type === 'stop') { sessionRevision++; setPair(null); }
      };
      announce('hello');
    } catch (_) {}
    global.addEventListener('focus', () => { if (pairing) { owner=hostId; announce('claim'); publish(); } });
    global.addEventListener('pageshow', () => announce('hello'));
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState !== 'hidden') announce('hello'); });
    global.setInterval(publish, 500); global.setInterval(pollCommands, 100);
    request('status').then(value=>{apiStatus=value;}).catch(()=>{}); updateButtons();
  }
  global.ShowaveMobileHost = Object.freeze({snapshot,applyCommand,idFor,start,stop,openPairing,mountPairing,
    get paired(){return embedded && global.top.ShowaveMobileHost ? global.top.ShowaveMobileHost.paired : !!pairing;},get available(){return embedded && global.top.ShowaveMobileHost ? global.top.ShowaveMobileHost.available : !!(apiStatus?.available || apiStatus?.canEnable);},get hostId(){return hostId;}});
  global.dispatchEvent(new global.CustomEvent('showave:mobile-host-ready'));
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
