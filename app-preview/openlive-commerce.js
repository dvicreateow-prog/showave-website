/* ===========================================================================
   openlive-commerce.js — persistent QR and live-sales overlays for SHOWAVE.

   Assets are global to the Studio, not copied into individual scenes. Exactly
   one asset can be on programme at a time, so a scene change cannot silently
   remove a donation link or replace a product. The overlay is drawn into the
   Studio compositor and therefore reaches every orientation, destination,
   recording and clip that receives the programme canvas.

   QR encoding is local. No destination URL is sent to a third-party image API.
   openlive-qrcode.js (qrcode-generator, MIT) must load before this file.
   =========================================================================== */
window.OpenLiveCommerce = (() => {
  'use strict';

  const STORE = 'showave.studio.commerce.v1';
  const PROGRAMME_BASE = 'showave.studio.commerce.programme.v1';
  const draftContext = window.OpenLiveStudioDraftContext || null;
  const PROGRAMME_STORE = draftContext && draftContext.error ? ''
    : draftContext && draftContext.independent && typeof draftContext.key === 'function'
      ? draftContext.key(PROGRAMME_BASE) : STORE;
  const TYPES = Object.freeze(['qr', 'qr-image', 'product']);
  const MAX_TARGET = 1024;
  const MAX_IMAGE_DATA = 1400000;
  const MAX_DOCUMENT = 4400000;
  const listeners = new Set();
  const qrCache = new Map();
  const imageCache = new Map();
  let automaticTargetProvider = null;
  let lastError = '';
  let state = { version: 1, assets: [], activeId: null, salesStyle: 'compact' };

  const copy = value => JSON.parse(JSON.stringify(value));
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const newId = () => {
    try { if (crypto && crypto.randomUUID) return 'asset-' + crypto.randomUUID(); } catch (_) {}
    return 'asset-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  };

  function safeProtocol(value) {
    const target = String(value == null ? '' : value).trim();
    // Never encode a shortened link or allow URL parsing to silently remove
    // control characters. Credentials do not belong in a public on-air QR.
    if (!target || target.length > MAX_TARGET || /[\u0000-\u001f\u007f]/.test(target)) return '';
    try {
      const parsed = new URL(target);
      if (!['http:', 'https:', 'mailto:', 'tel:', 'sms:'].includes(parsed.protocol)) return '';
      if (parsed.username || parsed.password || !parsed.pathname) return '';
      return target;
    } catch (_) { return ''; }
  }

  function normalizeAsset(raw) {
    const type = TYPES.includes(raw && raw.type) ? raw.type : 'qr';
    const targetMode = raw && raw.targetMode === 'custom' ? 'custom' : 'broadcast';
    const target = targetMode === 'custom' ? safeProtocol(raw && raw.target) : '';
    const asset = {
      id: clean(raw && raw.id, 96) || newId(),
      type,
      title: clean(raw && raw.title, 80) || (type === 'product' ? 'Featured product' : 'Scan this code'),
      targetMode,
      target,
      imageDataUrl: clean(raw && raw.imageDataUrl, MAX_IMAGE_DATA),
      price: clean(raw && raw.price, 32),
      callToAction: clean(raw && raw.callToAction, 48) || (type === 'product' ? 'Shop now' : 'Scan to open'),
      createdAt: Number(raw && raw.createdAt) || Date.now(),
      updatedAt: Number(raw && raw.updatedAt) || Date.now()
    };
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(asset.imageDataUrl)) asset.imageDataUrl = '';
    return asset;
  }

  function normalizeState(raw) {
    const next = { version: 1, assets: [], activeId: null, salesStyle: 'compact' };
    if (!raw || typeof raw !== 'object') return next;
    const seen = new Set();
    if (Array.isArray(raw.assets)) raw.assets.forEach(item => {
      const asset = normalizeAsset(item);
      if (seen.has(asset.id)) asset.id = newId();
      seen.add(asset.id); next.assets.push(asset);
    });
    next.activeId = seen.has(String(raw.activeId || '')) ? String(raw.activeId) : null;
    next.salesStyle = raw.salesStyle === 'classic' ? 'classic' : 'compact';
    return next;
  }

  function programmeState(raw, assets) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const id = String(value.activeId || '');
    return {
      activeId:(assets || []).some(asset => asset.id === id) ? id : null,
      salesStyle:value.salesStyle === 'classic' ? 'classic' : 'compact'
    };
  }

  function read(key) {
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }

  function load() {
    const shared = normalizeState(read(STORE));
    if (PROGRAMME_STORE === STORE) { state = shared; return; }
    state = Object.assign(shared, programmeState(read(PROGRAMME_STORE), shared.assets));
  }

  function announce(reason) {
    const snapshot = getState();
    listeners.forEach(listener => { try { listener(snapshot, reason); } catch (_) {} });
  }

  function commit(next, reason) {
    let normalized = normalizeState(next);
    let encoded = JSON.stringify(normalized);
    if (encoded.length > MAX_DOCUMENT)
      throw new Error('My Assets is full. Remove an image asset before adding another.');
    try {
      if (!PROGRAMME_STORE) throw new Error('The Studio draft context is invalid.');
      if (PROGRAMME_STORE === STORE) localStorage.setItem(STORE, encoded);
      else {
        /* QR/product definitions are reusable My Assets. Visibility and sales
           layout are programme choices and therefore stay inside this draft. */
        const legacy = normalizeState(read(STORE));
        const before = new Map(state.assets.map(asset => [asset.id, asset]));
        const after = new Map(normalized.assets.map(asset => [asset.id, asset]));
        const changedAssets = JSON.stringify(state.assets) !== JSON.stringify(normalized.assets);
        let shared = legacy;
        if (changedAssets) {
          let assets = legacy.assets.slice();
          if (reason === 'create') {
            after.forEach((asset, id) => { if (!before.has(id) && !assets.some(row => row.id === id)) assets.push(asset); });
          } else if (reason === 'update') {
            after.forEach((asset, id) => {
              if (!before.has(id) || JSON.stringify(before.get(id)) === JSON.stringify(asset)) return;
              const index = assets.findIndex(row => row.id === id);
              if (index < 0) throw new Error('That asset no longer exists.');
              assets[index] = asset;
            });
          } else if (reason === 'remove') {
            const removed = new Set([...before.keys()].filter(id => !after.has(id)));
            assets = assets.filter(asset => !removed.has(asset.id));
          } else assets = normalized.assets;
          shared = normalizeState(Object.assign({}, legacy, { assets }));
          normalized = Object.assign(normalized, { assets:shared.assets });
          encoded = JSON.stringify(normalized);
          if (JSON.stringify(shared).length > MAX_DOCUMENT)
            throw new Error('My Assets is full. Remove an image asset before adding another.');
        }
        const programme = JSON.stringify({
          version:1, activeId:normalized.activeId, salesStyle:normalized.salesStyle
        });
        const previousProgramme = localStorage.getItem(PROGRAMME_STORE);
        localStorage.setItem(PROGRAMME_STORE, programme);
        try {
          if (changedAssets) localStorage.setItem(STORE, JSON.stringify(shared));
        } catch (error) {
          if (localStorage.getItem(PROGRAMME_STORE) === programme) {
            if (previousProgramme === null) localStorage.removeItem(PROGRAMME_STORE);
            else localStorage.setItem(PROGRAMME_STORE, previousProgramme);
          }
          throw error;
        }
      }
    }
    catch (_) { throw new Error('SHOWAVE could not save My Assets in this browser.'); }
    state = normalized;
    // Decoded images can be much larger than their saved data URLs. Release
    // replaced/deleted artwork; shared images remain cached while referenced.
    const retainedImages = new Set(state.assets.map(asset => asset.imageDataUrl).filter(Boolean));
    imageCache.forEach((_, key) => { if (!retainedImages.has(key)) imageCache.delete(key); });
    lastError = '';
    announce(reason || 'change');
    return getState();
  }

  function getState() { return copy(state); }
  function recallSceneState(saved) {
    if (!saved) return;
    const asset=saved.status?.asset;
    state=normalizeState({...state,assets:asset?[...state.assets.filter(row=>row.id!==asset.id),copy(asset)]:state.assets,
      activeId:asset?.id||null,salesStyle:saved.salesStyle});
  }
  function list(type) {
    const rows = type && TYPES.includes(type) ? state.assets.filter(asset => asset.type === type) : state.assets;
    return copy(rows);
  }
  function find(id) { return state.assets.find(asset => asset.id === String(id || '')) || null; }

  function qrMatrix(text) {
    const payload = String(text == null ? '' : text).trim();
    if (!payload) throw new Error('A QR destination is required.');
    if (payload.length > MAX_TARGET)
      throw new Error('The QR destination is too long. Use a link under 1,024 characters.');
    const factory = window.qrcode;
    if (typeof factory !== 'function') throw new Error('The local QR encoder did not load.');
    /* The upstream default truncates Unicode to one byte. Its bundled UTF-8
       encoder is selected explicitly so names and international links survive. */
    if (factory.stringToBytesFuncs && factory.stringToBytesFuncs['UTF-8'])
      factory.stringToBytes = factory.stringToBytesFuncs['UTF-8'];
    const qr = factory(0, 'M');
    try { qr.addData(payload, 'Byte'); qr.make(); }
    catch (_) { throw new Error('This destination is too long to make a reliable QR code.'); }
    const size = qr.getModuleCount();
    const cells = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++)
      cells[row * size + col] = qr.isDark(row, col) ? 1 : 0;
    return { size, cells };
  }

  function validateDraft(raw, id) {
    const rawImage = String(raw && raw.imageDataUrl || '');
    const rawTarget = String(raw && raw.target || '').trim();
    if (rawTarget.length > MAX_TARGET)
      throw new Error('The QR destination is too long. Use a link under 1,024 characters.');
    if (rawImage.length > MAX_IMAGE_DATA)
      throw new Error('The image is too large. Choose an image under 1 MB.');
    const asset = normalizeAsset(Object.assign({}, raw, { id: id || (raw && raw.id) || newId() }));
    if (!clean(raw && raw.title, 80)) throw new Error('Give this asset a name.');
    if (asset.targetMode === 'custom') {
      if (!asset.target) throw new Error('Enter a safe http, https, mail, phone or SMS destination.');
      qrMatrix(asset.target);
    }
    if (asset.type === 'qr-image' && !asset.imageDataUrl)
      throw new Error('Choose an image for the QR + image asset.');
    return asset;
  }

  function create(raw) {
    const asset = validateDraft(Object.assign({}, raw, { id: newId() }));
    const next = getState();
    next.assets.push(asset);
    commit(next, 'create');
    return copy(asset);
  }

  function update(id, raw) {
    const current = find(id);
    if (!current) throw new Error('That asset no longer exists.');
    const asset = validateDraft(Object.assign({}, current, raw, {
      id: current.id, createdAt: current.createdAt, updatedAt: Date.now()
    }), current.id);
    const next = getState();
    next.assets = next.assets.map(row => row.id === current.id ? asset : row);
    commit(next, 'update');
    return copy(asset);
  }

  function duplicate(id) {
    const current = find(id);
    if (!current) throw new Error('That asset no longer exists.');
    // Creating a copy is an asset-library action, never a programme trigger.
    return create(Object.assign({}, current, {
      title: clean(current.title, 73) + ' (copy)',
      createdAt: Date.now(), updatedAt: Date.now()
    }));
  }

  function remove(id) {
    const current = find(id);
    if (!current) return false;
    const next = getState();
    next.assets = next.assets.filter(asset => asset.id !== current.id);
    if (next.activeId === current.id) next.activeId = null;
    commit(next, 'remove');
    imageCache.delete(current.imageDataUrl);
    return true;
  }

  function setVisible(id, visible) {
    const asset = find(id);
    if (visible !== false && !asset) throw new Error('That asset no longer exists.');
    // A delayed Hide action for A must not clear B after B has gone on air.
    // Passing no id retains the explicit hide-all behaviour.
    if (visible === false && id && state.activeId !== String(id)) return state.activeId;
    const next = getState();
    next.activeId = visible === false ? null : String(id);
    commit(next, 'visibility');
    return next.activeId;
  }

  function setSalesStyle(value) {
    const next = getState();
    next.salesStyle = value === 'classic' ? 'classic' : 'compact';
    commit(next, 'style');
    return next.salesStyle;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setAutomaticTargetProvider(provider) {
    automaticTargetProvider = typeof provider === 'function' ? provider : null;
    announce('automatic-target');
  }

  function automaticTarget() {
    if (!automaticTargetProvider) return '';
    try {
      const supplied = automaticTargetProvider();
      return safeProtocol(typeof supplied === 'string' ? supplied : supplied && supplied.url);
    } catch (_) { return ''; }
  }

  function resolveTarget(assetOrId) {
    const asset = typeof assetOrId === 'string' ? find(assetOrId) : assetOrId;
    if (!asset) return '';
    return asset.targetMode === 'custom' ? safeProtocol(asset.target) : automaticTarget();
  }

  function activeStatus() {
    const asset = find(state.activeId);
    if (!asset) return { state: 'hidden', asset: null, target: '' };
    const target = resolveTarget(asset);
    return { state: target ? 'visible' : 'armed', asset: copy(asset), target };
  }

  // Shared programme layout needs only visibility and kind, not a per-frame
  // JSON copy of an uploaded image or the rest of the editable asset.
  function activeRenderInfo() {
    const asset = find(state.activeId);
    return asset ? { state: resolveTarget(asset) ? 'visible' : 'armed', type: asset.type }
      : { state: 'hidden', type: '' };
  }

  // Font readiness runs on the compositor clock. Return just immutable text
  // fields, so checking glyph coverage never copies uploaded image data.
  function activeTypography() {
    const asset=find(state.activeId);
    if(!asset)return {state:'hidden',type:'',title:'',callToAction:'',price:'',target:''};
    const target=resolveTarget(asset);
    return {state:target?'visible':'armed',type:asset.type,title:asset.title,
      callToAction:asset.callToAction,price:asset.price,target};
  }

  function trimQrCache() {
    while (qrCache.size > 20) qrCache.delete(qrCache.keys().next().value);
  }

  function qrCanvas(target) {
    if (qrCache.has(target)) return qrCache.get(target);
    const matrix = qrMatrix(target), quiet = 4, side = matrix.size + quiet * 2;
    const canvas = document.createElement('canvas');
    canvas.width = side; canvas.height = side;
    const qrctx = canvas.getContext('2d', { alpha: false });
    qrctx.fillStyle = '#fff'; qrctx.fillRect(0, 0, side, side);
    qrctx.fillStyle = '#07090d';
    for (let row = 0; row < matrix.size; row++) for (let col = 0; col < matrix.size; col++)
      if (matrix.cells[row * matrix.size + col]) qrctx.fillRect(col + quiet, row + quiet, 1, 1);
    const result = { canvas, modules: side };
    qrCache.set(target, result); trimQrCache();
    return result;
  }

  function imageFor(dataUrl) {
    if (!dataUrl) return null;
    if (imageCache.has(dataUrl)) {
      const cached = imageCache.get(dataUrl);
      imageCache.delete(dataUrl); imageCache.set(dataUrl, cached);
      return cached;
    }
    const image = new Image();
    const record = { image, ready: false, failed: false };
    image.addEventListener('load', () => { record.ready = true; }, { once: true });
    image.addEventListener('error', () => { record.failed = true; }, { once: true });
    image.src = dataUrl;
    imageCache.set(dataUrl, record);
    // Unsaved editor previews are not in My Assets, so commit-time cleanup
    // alone cannot bound their decoded-image memory.
    while (imageCache.size > 6) imageCache.delete(imageCache.keys().next().value);
    return record;
  }

  function roundedPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, width, height, r); return; }
    ctx.moveTo(x + r, y); ctx.lineTo(x + width - r, y); ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r); ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function fillRounded(ctx, x, y, width, height, radius, colour) {
    roundedPath(ctx, x, y, width, height, radius); ctx.fillStyle = colour; ctx.fill();
  }

  function shortTarget(target) {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        return (parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname)).slice(0, 58);
    } catch (_) {}
    return clean(target, 58);
  }

  function themeProfile(options) {
    const supplied = options && options.theme;
    if (supplied && supplied.id && supplied.family && supplied.card) return supplied;
    const theme = window.OpenLiveTheme;
    if (theme && typeof theme.profile === 'function') return theme.profile(supplied);
    return {
      id:'base', family:'system-ui, sans-serif', primary:'#3FDDAA', primaryText:'#238B72',
      card:'#FFFFFF', cardText:'#111827', cardMuted:'#667085', radiusScale:.08, shadow:false
    };
  }

  function fontFor(weight, pixels, theme) {
    return String(weight || 600) + ' ' + Math.max(1, Math.round(pixels)) + 'px ' +
      (theme && theme.family || 'system-ui, sans-serif');
  }

  function fittedText(ctx, text, maxWidth, start, minimum, weight, theme) {
    let px = Math.max(minimum, Math.round(start));
    while (px > minimum) {
      ctx.font = fontFor(weight, px, theme);
      if (ctx.measureText(String(text || '')).width <= maxWidth) break;
      px--;
    }
    return fontFor(weight, px, theme);
  }

  function cardRadius(theme, unit) {
    if (theme.id === 'news') return 0;
    if (theme.id === 'base') return unit * .005;
    if (theme.id === 'round') return unit * .038;
    return unit * .018;
  }

  function drawCardSurface(ctx, x, y, width, height, radius, theme, unit) {
    ctx.save();
    if (theme.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.38)'; ctx.shadowBlur = unit * .025; ctx.shadowOffsetY = unit * .008;
    }
    fillRounded(ctx, x, y, width, height, radius, theme.card);
    ctx.restore();
    if (theme.id === 'base') {
      ctx.fillStyle = theme.primary; ctx.fillRect(x, y, Math.max(4, unit * .007), height);
    } else if (theme.id === 'news') {
      ctx.fillStyle = theme.primary; ctx.fillRect(x, y, width, Math.max(5, unit * .009));
    }
  }

  function drawImageCover(ctx, record, x, y, width, height, radius, accent) {
    ctx.save(); roundedPath(ctx, x, y, width, height, radius); ctx.clip();
    if (record && record.ready) {
      const image = record.image;
      const sw = image.naturalWidth || image.width || 1, sh = image.naturalHeight || image.height || 1;
      const scale = Math.max(width / sw, height / sh);
      const dw = sw * scale, dh = sh * scale;
      try { ctx.drawImage(image, x + (width - dw) / 2, y + (height - dh) / 2, dw, dh); }
      catch (_) { ctx.fillStyle = accent; ctx.fillRect(x, y, width, height); }
    } else {
      const gradient = typeof ctx.createLinearGradient === 'function' ? ctx.createLinearGradient(x, y, x + width, y + height) : null;
      if (gradient) { gradient.addColorStop(0, accent); gradient.addColorStop(1, '#17233c'); ctx.fillStyle = gradient; }
      else ctx.fillStyle = accent;
      ctx.fillRect(x, y, width, height);
    }
    ctx.restore();
  }

  function positionCard(cv, width, height, options) {
    const unit = Math.min(cv.width, cv.height), margin = unit * .03;
    let anchor = options && options.anchor || 'br';
    if (anchor === 'br' && options && options.avoidLower) anchor = 'tr';
    if (options && options.logoCorner === anchor) anchor = anchor.endsWith('r') ? anchor[0] + 'l' : anchor[0] + 'r';
    const x = anchor.endsWith('l') ? margin : cv.width - width - margin;
    const y = anchor.startsWith('t') ? margin : cv.height - height - margin;
    return { x, y };
  }

  function drawQr(ctx, target, x, y, size) {
    const rendered = qrCanvas(target);
    ctx.save(); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(rendered.canvas, x, y, size, size);
    ctx.restore();
  }

  function drawNewsQrCard(ctx, cv, asset, target, options) {
    const shared = window.OpenLiveBroadcastLayout, theme = themeProfile(options);
    const grid = options && options.broadcastLayout || shared.plan(cv, {
      theme, commerceKind:asset.type, hasLower:!!(options && options.avoidLower),
      logoRect:options && options.logoRect
    });
    const box = grid.commerce;
    if (!box) throw new Error('No clear safe-area space is available for this QR card.');
    const u = box.height / .28, pad = u * .02, qr = u * .19;
    drawCardSurface(ctx, box.x, box.y, box.width, box.height, 0, theme, u);
    const qx = box.x + box.width - pad - qr, qy = box.y + pad;
    if (asset.type === 'qr-image') drawImageCover(ctx, imageFor(asset.imageDataUrl),
      box.x + pad, qy, u * .19, qr, 0, theme.primary);
    drawQr(ctx, target, qx, qy, qr);
    const textWidth = box.width - pad * 2;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = theme.cardText;
    ctx.font = fittedText(ctx, asset.title, textWidth, u * .020, u * .013, 720, theme);
    ctx.fillText(asset.title, box.x + pad, box.y + u * .232, textWidth);
    ctx.fillStyle = theme.primaryText;
    ctx.font = fittedText(ctx, asset.callToAction, textWidth, u * .014, u * .011, 600, theme);
    ctx.fillText(asset.callToAction, box.x + pad, box.y + u * .258, textWidth);
    return {destination:box, qr:{x:qx,y:qy,width:qr,height:qr}};
  }

  function drawQrCard(ctx, cv, asset, target, options) {
    const u = Math.min(cv.width, cv.height), pad = u * .018, qr = u * .19;
    const theme = themeProfile(options);
    const imageWidth = asset.type === 'qr-image' ? u * .20 : 0;
    const textWidth = u * (asset.type === 'qr-image' ? .22 : .30);
    const width = Math.min(cv.width - u * .06, pad * 4 + qr + imageWidth + textWidth);
    const height = qr + pad * 2;
    const p = positionCard(cv, width, height, options), radius = cardRadius(theme, u);
    drawCardSurface(ctx, p.x, p.y, width, height, radius, theme, u);
    let cursor = p.x + pad;
    if (asset.type === 'qr-image') {
      drawImageCover(ctx, imageFor(asset.imageDataUrl), cursor, p.y + pad, imageWidth, qr,
        radius * .65, theme.primary);
      cursor += imageWidth + pad;
    }
    drawQr(ctx, target, cursor, p.y + pad, qr); cursor += qr + pad * 1.2;
    const max = Math.max(u * .10, p.x + width - pad - cursor);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = theme.cardText;
    ctx.font = fittedText(ctx, asset.title, max, u * .027, u * .014, 720, theme);
    ctx.fillText(asset.title, cursor, p.y + height * .40, max);
    ctx.fillStyle = theme.primaryText; ctx.font = fontFor(700, u * .014, theme);
    ctx.fillText(asset.callToAction, cursor, p.y + height * .61, max);
    ctx.fillStyle = theme.cardMuted; ctx.font = fontFor(500, u * .011, theme);
    ctx.fillText(shortTarget(target), cursor, p.y + height * .78, max);
  }

  function drawProductCompact(ctx, cv, asset, target, options) {
    const u = Math.min(cv.width, cv.height), pad = u * .016, height = u * .22;
    const theme = themeProfile(options);
    const qr = height - pad * 2, image = qr, width = Math.min(cv.width - u * .06, u * .69);
    const p = positionCard(cv, width, height, options), radius = cardRadius(theme, u);
    drawCardSurface(ctx, p.x, p.y, width, height, radius, theme, u);
    drawImageCover(ctx, imageFor(asset.imageDataUrl), p.x + pad, p.y + pad, image, image,
      radius * .7, theme.primary);
    drawQr(ctx, target, p.x + width - pad - qr, p.y + pad, qr);
    const tx = p.x + pad * 2 + image, tw = width - image - qr - pad * 4;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = theme.cardText;
    ctx.font = fittedText(ctx, asset.title, tw, u * .025, u * .013, 720, theme);
    ctx.fillText(asset.title, tx, p.y + height * .39, tw);
    ctx.fillStyle = theme.primaryText; ctx.font = fontFor(750, u * .022, theme);
    ctx.fillText(asset.price || asset.callToAction, tx, p.y + height * .64, tw);
    ctx.fillStyle = theme.cardMuted; ctx.font = fontFor(600, u * .011, theme);
    ctx.fillText(asset.callToAction, tx, p.y + height * .82, tw);
  }

  function drawProductClassic(ctx, cv, asset, target, options) {
    const u = Math.min(cv.width, cv.height), pad = u * .018;
    const theme = themeProfile(options);
    const width = Math.min(cv.width - u * .06, u * .47), height = Math.min(cv.height - u * .06, u * .61);
    const p = positionCard(cv, width, height, options), radius = cardRadius(theme, u);
    drawCardSurface(ctx, p.x, p.y, width, height, radius, theme, u);
    const imageHeight = height * .50;
    drawImageCover(ctx, imageFor(asset.imageDataUrl), p.x + pad, p.y + pad, width - pad * 2, imageHeight,
      radius * .7, theme.primary);
    const qr = height * .29, tx = p.x + pad, ty = p.y + pad * 2 + imageHeight;
    drawQr(ctx, target, p.x + width - pad - qr, p.y + height - pad - qr, qr);
    const tw = width - qr - pad * 3;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = theme.cardText;
    ctx.font = fittedText(ctx, asset.title, tw, u * .026, u * .014, 720, theme);
    ctx.fillText(asset.title, tx, ty + height * .10, tw);
    ctx.fillStyle = theme.primaryText; ctx.font = fontFor(750, u * .024, theme);
    ctx.fillText(asset.price || asset.callToAction, tx, ty + height * .20, tw);
    ctx.fillStyle = theme.cardMuted; ctx.font = fontFor(600, u * .011, theme);
    ctx.fillText(asset.callToAction, tx, ty + height * .29, tw);
  }

  function renderStatus(ctx, cv, status, options, salesStyle) {
    if (status.state !== 'visible' || !ctx || !cv) return status;
    let geometry = null, error = '', imageState = 'none';
    try {
      if (status.asset.imageDataUrl && status.asset.type !== 'qr') {
        const record = imageFor(status.asset.imageDataUrl);
        imageState = record.failed ? 'failed' : record.ready ? 'ready' : 'pending';
        if (record.failed) throw new Error('The asset image could not be decoded. Choose another PNG, JPEG, WebP or GIF image.');
      }
      if (status.asset.type === 'product') {
        if (salesStyle === 'classic') drawProductClassic(ctx, cv, status.asset, status.target, options);
        else drawProductCompact(ctx, cv, status.asset, status.target, options);
      } else if (window.OpenLiveBroadcastLayout && themeProfile(options).id === 'news') {
        geometry = drawNewsQrCard(ctx, cv, status.asset, status.target, options);
      } else drawQrCard(ctx, cv, status.asset, status.target, options);
    } catch (caught) { error = caught && caught.message || String(caught); }
    return Object.assign({}, status, { geometry, error, imageState });
  }

  function draw(ctx, cv, options) {
    const captured = options?.commerceState;
    const result = renderStatus(ctx, cv, captured?.status || activeStatus(), options, captured?.salesStyle || state.salesStyle);
    if (result.state === 'visible' && ctx && cv) lastError = result.error || '';
    return result;
  }

  function drawPreview(ctx, cv, rawDraft, options) {
    // Editor preview uses the actual compositor without creating, saving or
    // selecting a temporary asset. It must not overwrite programme diagnostics.
    try {
      const asset = validateDraft(rawDraft);
      const target = resolveTarget(asset);
      if (!target) return { state:'armed', asset, target:'',
        error:'No broadcast watch page is available yet. Choose a custom destination to preview its QR code.' };
      const salesStyle = options && ['compact', 'classic'].includes(options.salesStyle)
        ? options.salesStyle : state.salesStyle;
      return renderStatus(ctx, cv, { state:'visible', asset, target }, options, salesStyle);
    } catch (error) {
      return { state:'invalid', asset:null, target:'', error:error && error.message || String(error) };
    }
  }

  load();

  return {
    STORE, PROGRAMME_STORE, TYPES, getState, list, create, update, duplicate, remove, setVisible, setSalesStyle,
    subscribe, setAutomaticTargetProvider, automaticTarget, resolveTarget, activeStatus, activeRenderInfo, activeTypography, recallSceneState,
    validateDraft, qrMatrix, draw, drawPreview,
    get lastError() { return lastError; }
  };
})();
