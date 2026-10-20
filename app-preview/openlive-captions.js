/* ===========================================================================
   openlive-captions.js — reusable lower-third and ticker assets for SHOWAVE.

   Captions belong to the show, not to one scene. A scene cut must not make an
   identifying lower third or an urgent ticker disappear. The two asset types
   have independent programme slots: at most one lower third and one ticker may
   be visible, and they may be visible together. Everything is painted into the
   Studio programme canvas, so destinations, recordings and clips receive the
   same pixels as the operator monitor.

   Classic script. Publishes window.OpenLiveCaptions. No network or libraries.
   =========================================================================== */
window.OpenLiveCaptions = (() => {
  'use strict';

  const STORE = 'showave.studio.captions.v1';
  const PROGRAMME_BASE = 'showave.studio.captions.programme.v1';
  const draftContext = window.OpenLiveStudioDraftContext || null;
  const PROGRAMME_STORE = draftContext && draftContext.error ? ''
    : draftContext && draftContext.independent && typeof draftContext.key === 'function'
      ? draftContext.key(PROGRAMME_BASE) : STORE;
  const TYPES = Object.freeze(['lower-third', 'ticker']);
  const MAX_DOCUMENT = 512000;
  const listeners = new Set();
  let state = {
    version: 1,
    assets: [],
    activeLowerThirdId: null,
    activeTickerId: null,
    tickerSpeed: 1
  };
  let lastError = '';

  const copy = value => JSON.parse(JSON.stringify(value));
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const newId = () => {
    try { if (crypto && crypto.randomUUID) return 'caption-' + crypto.randomUUID(); } catch (_) {}
    return 'caption-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  };

  function normalizeAsset(raw) {
    const type = raw && raw.type === 'ticker' ? 'ticker' : 'lower-third';
    return {
      id: clean(raw && raw.id, 96) || newId(),
      type,
      line1: type === 'lower-third' ? clean(raw && raw.line1, 80) : '',
      line2: type === 'lower-third' ? clean(raw && raw.line2, 180) : '',
      text: type === 'ticker' ? clean(raw && raw.text, 500) : '',
      createdAt: finite(raw && raw.createdAt) || Date.now(),
      updatedAt: finite(raw && raw.updatedAt) || Date.now()
    };
  }

  function normalizeState(raw) {
    const next = {
      version: 1,
      assets: [],
      activeLowerThirdId: null,
      activeTickerId: null,
      tickerSpeed: 1
    };
    if (!raw || typeof raw !== 'object') return next;
    const seen = new Set();
    if (Array.isArray(raw.assets)) raw.assets.forEach(item => {
      const asset = normalizeAsset(item);
      if (seen.has(asset.id)) asset.id = newId();
      seen.add(asset.id); next.assets.push(asset);
    });
    const lower = String(raw.activeLowerThirdId || '');
    const ticker = String(raw.activeTickerId || '');
    if (next.assets.some(asset => asset.id === lower && asset.type === 'lower-third'))
      next.activeLowerThirdId = lower;
    if (next.assets.some(asset => asset.id === ticker && asset.type === 'ticker'))
      next.activeTickerId = ticker;
    const savedSpeed = Number(raw.tickerSpeed);
    next.tickerSpeed = Number.isFinite(savedSpeed)
      ? Math.max(.4, Math.min(2.5, savedSpeed)) : 1;
    return next;
  }

  function programmeState(raw, assets) {
    const next = { activeLowerThirdId:null, activeTickerId:null, tickerSpeed:1 };
    const value = raw && typeof raw === 'object' ? raw : {};
    const lower = String(value.activeLowerThirdId || '');
    const ticker = String(value.activeTickerId || '');
    if ((assets || []).some(asset => asset.id === lower && asset.type === 'lower-third'))
      next.activeLowerThirdId = lower;
    if ((assets || []).some(asset => asset.id === ticker && asset.type === 'ticker'))
      next.activeTickerId = ticker;
    const speed = Number(value.tickerSpeed);
    if (Number.isFinite(speed)) next.tickerSpeed = Math.max(.4, Math.min(2.5, speed));
    return next;
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

  function getState() { return copy(state); }
  function recallSceneState(saved) {
    if (!saved) return;
    const assets=[saved.lowerThird,saved.ticker].filter(Boolean).map(copy),ids=new Set(assets.map(asset=>asset.id));
    state=normalizeState({...state,assets:[...state.assets.filter(asset=>!ids.has(asset.id)),...assets],
      activeLowerThirdId:saved.lowerThird?.id||null,activeTickerId:saved.ticker?.id||null,tickerSpeed:saved.tickerSpeed});
  }
  function find(id) { return state.assets.find(asset => asset.id === String(id || '')) || null; }
  function list(type) {
    const rows = TYPES.includes(type) ? state.assets.filter(asset => asset.type === type) : state.assets;
    return copy(rows);
  }
  function has(type) { return state.assets.some(asset => !type || asset.type === type); }

  function announce(reason) {
    const snapshot = getState();
    listeners.forEach(listener => { try { listener(snapshot, reason); } catch (_) {} });
  }

  function commit(next, reason) {
    let normalized = normalizeState(next);
    let combined = JSON.stringify(normalized);
    if (combined.length > MAX_DOCUMENT)
      throw new Error('My Assets is full. Remove a caption before adding another.');
    try {
      if (!PROGRAMME_STORE) throw new Error('The Studio draft context is invalid.');
      if (PROGRAMME_STORE === STORE) localStorage.setItem(STORE, combined);
      else {
        /* My Assets remains reusable. Only which two captions are on this
           programme (and its ticker speed) belongs to the independent draft. */
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
              if (index < 0) throw new Error('That caption no longer exists.');
              assets[index] = asset;
            });
          } else if (reason === 'remove') {
            const removed = new Set([...before.keys()].filter(id => !after.has(id)));
            assets = assets.filter(asset => !removed.has(asset.id));
          } else assets = normalized.assets;
          shared = normalizeState(Object.assign({}, legacy, { assets }));
          normalized = Object.assign(normalized, { assets:shared.assets });
          combined = JSON.stringify(normalized);
          if (JSON.stringify(shared).length > MAX_DOCUMENT)
            throw new Error('My Assets is full. Remove a caption before adding another.');
        }
        const programme = JSON.stringify({
          version:1, activeLowerThirdId:normalized.activeLowerThirdId,
          activeTickerId:normalized.activeTickerId, tickerSpeed:normalized.tickerSpeed
        });
        const previousProgramme = localStorage.getItem(PROGRAMME_STORE);
        localStorage.setItem(PROGRAMME_STORE, programme);
        try {
          if (changedAssets) localStorage.setItem(STORE, JSON.stringify(shared));
        } catch (error) {
          /* Do not leave a programme record claiming an asset whose shared
             library update failed. Restore only if nobody replaced our write. */
          if (localStorage.getItem(PROGRAMME_STORE) === programme) {
            if (previousProgramme === null) localStorage.removeItem(PROGRAMME_STORE);
            else localStorage.setItem(PROGRAMME_STORE, previousProgramme);
          }
          throw error;
        }
      }
    } catch (_) { throw new Error('SHOWAVE could not save caption assets in this browser.'); }
    state = normalized; lastError = ''; announce(reason || 'change');
    return getState();
  }

  function validateDraft(raw, id) {
    const asset = normalizeAsset(Object.assign({}, raw, { id: id || (raw && raw.id) || newId() }));
    if (asset.type === 'lower-third' && !asset.line1)
      throw new Error('Enter the lower-third headline.');
    if (asset.type === 'ticker' && !asset.text)
      throw new Error('Enter the ticker message.');
    return asset;
  }

  function create(raw) {
    const asset = validateDraft(Object.assign({}, raw, { id: newId() }));
    const next = getState(); next.assets.push(asset); commit(next, 'create');
    return copy(asset);
  }

  function update(id, raw) {
    const current = find(id);
    if (!current) throw new Error('That caption no longer exists.');
    const asset = validateDraft(Object.assign({}, current, raw, {
      id: current.id, type: current.type, createdAt: current.createdAt, updatedAt: Date.now()
    }), current.id);
    const next = getState();
    next.assets = next.assets.map(row => row.id === current.id ? asset : row);
    commit(next, 'update'); return copy(asset);
  }

  function remove(id) {
    const current = find(id);
    if (!current) return false;
    const next = getState();
    next.assets = next.assets.filter(asset => asset.id !== current.id);
    if (next.activeLowerThirdId === current.id) next.activeLowerThirdId = null;
    if (next.activeTickerId === current.id) next.activeTickerId = null;
    commit(next, 'remove'); return true;
  }

  function setVisible(id, visible) {
    const asset = find(id);
    if (visible !== false && !asset) throw new Error('That caption no longer exists.');
    const next = getState();
    if (visible === false) {
      if (next.activeLowerThirdId === String(id)) next.activeLowerThirdId = null;
      if (next.activeTickerId === String(id)) next.activeTickerId = null;
    } else if (asset.type === 'ticker') next.activeTickerId = asset.id;
    else next.activeLowerThirdId = asset.id;
    commit(next, 'visibility');
    return asset && asset.type === 'ticker' ? next.activeTickerId : next.activeLowerThirdId;
  }

  function hideAll() {
    const next = getState();
    next.activeLowerThirdId = null; next.activeTickerId = null;
    commit(next, 'visibility');
  }

  function setTickerSpeed(value) {
    const supplied = Number(value);
    const speed = Number.isFinite(supplied) ? Math.max(.4, Math.min(2.5, supplied)) : 1;
    const next = getState(); next.tickerSpeed = Math.round(speed * 10) / 10;
    commit(next, 'speed'); return next.tickerSpeed;
  }

  function active(type) {
    const id = type === 'ticker' ? state.activeTickerId : state.activeLowerThirdId;
    const asset = find(id);
    return asset && asset.type === type ? copy(asset) : null;
  }

  function activeStatus() {
    return {
      lowerThird: active('lower-third'),
      ticker: active('ticker'),
      tickerSpeed: state.tickerSpeed
    };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener); return () => listeners.delete(listener);
  }

  function themeProfile(options) {
    const theme = window.OpenLiveTheme;
    const supplied = options && options.theme;
    if (supplied && supplied.id && supplied.family && supplied.surface) return supplied;
    if (theme && typeof theme.profile === 'function') return theme.profile(supplied);
    return {
      id:'base', family:'system-ui, sans-serif', primary:'#3FDDAA',
      accent:'#3FDDAA', surface:'rgba(8,12,22,.90)', surfaceStrong:'rgba(7,10,18,.93)',
      foreground:'#FFFFFF', muted:'rgba(255,255,255,.76)', radiusScale:0, shadow:false
    };
  }

  function fontFor(weight, pixels, theme) {
    return String(weight || 600) + ' ' + Math.max(1, Math.round(pixels)) + 'px ' +
      (theme && theme.family || 'system-ui, sans-serif');
  }

  function textOnPrimary(primary) {
    const theme = window.OpenLiveTheme;
    if (theme && typeof theme.contrastingText === 'function') return theme.contrastingText(primary);
    // Optional-module fallback for the same hex-colour theme contract.
    const hex = /^#([a-f\d]{6})$/i.exec(String(primary || ''));
    if (!hex) return '#FFFFFF';
    const values = [0,2,4].map(index => {
      const value = parseInt(hex[1].slice(index,index + 2),16) / 255;
      return value <= .03928 ? value / 12.92 : Math.pow((value + .055) / 1.055,2.4);
    });
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2] > .47 ? '#0A1020' : '#FFFFFF';
  }

  function fittedText(ctx, text, maxWidth, start, minimum, weight, theme) {
    let px = Math.max(minimum, Math.round(start));
    const value = String(text || '');
    while (px > minimum) {
      ctx.font = fontFor(weight, px, theme);
      if (ctx.measureText(value).width <= maxWidth) break;
      px--;
    }
    return fontFor(weight, px, theme);
  }

  function fillBox(ctx, x, y, width, height, radius, colour) {
    ctx.fillStyle = colour;
    if (radius > 0 && typeof ctx.roundRect === 'function' && typeof ctx.fill === 'function') {
      ctx.beginPath(); ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2)); ctx.fill();
    } else ctx.fillRect(x, y, width, height);
  }

  function layout(cv, options) {
    const shared = window.OpenLiveBroadcastLayout;
    const theme = themeProfile(options);
    if (shared && theme.id === 'news') {
      const grid = options && options.broadcastLayout || shared.plan(cv, {
        theme, hasLower:true, hasTicker:!!(options?.captionState ? options.captionState.ticker : active('ticker')), logoRect:options && options.logoRect
      });
      const lower = grid.lower || {x:grid.safe.x,y:grid.safe.bottom,width:grid.safe.width,height:0};
      return {unit:grid.safe.unit, margin:grid.safe.x, lowerHeight:lower.height, lowerY:lower.y,
        tickerHeight:grid.ticker ? grid.ticker.height : 0, tickerY:grid.ticker ? grid.ticker.y : grid.safe.bottom,
        bottomInset:0, broadcastLayout:grid};
    }
    const unit = Math.min(cv.width, cv.height);
    const margin = unit * .035;
    const ticker = options?.captionState ? options.captionState.ticker : active('ticker');
    const tickerHeight = ticker ? Math.min(cv.height * .085, cv.width * .12) : 0;
    const bottomLogo = options && /^b/.test(String(options.logoCorner || ''));
    const bottomInset = bottomLogo ? unit * .17 : 0;
    const tickerY = cv.height - margin - tickerHeight - bottomInset;
    const lowerHeight = Math.min(cv.height * .13, cv.width * .23);
    const lowerY = tickerY - (ticker ? margin * .45 : 0) - lowerHeight;
    return { unit, margin, tickerHeight, tickerY, lowerHeight, lowerY, bottomInset };
  }

  function drawLowerThird(ctx, cv, asset, geometry, options) {
    if (geometry.broadcastLayout && geometry.broadcastLayout.lower) {
      const box = geometry.broadcastLayout.lower, theme = themeProfile(options), u = geometry.unit;
      const template = geometry.broadcastLayout.template;
      if (theme.id === 'news' && template && drawTemplateLower(ctx, box, asset, u, theme, template)) return;
      const pad = u * .023, maxText = box.width - pad * 2;
      const titleHeight = box.height * .63, rule = u * .004;
      ctx.save();
      ctx.fillStyle = theme.card; ctx.fillRect(box.x, box.y, box.width, titleHeight);
      ctx.fillStyle = theme.primary; ctx.fillRect(box.x, box.y, box.width, rule);
      ctx.fillStyle = theme.surfaceStrong;
      ctx.fillRect(box.x, box.y + titleHeight, box.width, box.height - titleHeight);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.cardText;
      ctx.font = fittedText(ctx, asset.line1, maxText, u * .041, u * .019, 720, theme);
      ctx.fillText(String(asset.line1 || ''), box.x + pad, box.y + titleHeight * .54, maxText);
      ctx.fillStyle = theme.foreground;
      ctx.font = fittedText(ctx, asset.line2, maxText, u * .024, u * .015, 500, theme);
      ctx.fillText(String(asset.line2 || ''), box.x + pad,
        box.y + titleHeight + (box.height - titleHeight) / 2, maxText);
      ctx.restore();
      return;
    }
    const g = geometry, accent = Math.max(5, g.unit * .008), inset = g.unit * .024;
    const x = g.margin, maxPlate = cv.width - g.margin * 2;
    const theme = themeProfile(options);
    const leading = theme.id === 'base' ? accent : 0;
    const roundInset = theme.id === 'round' ? inset * .45 : 0;
    const maxText = Math.max(g.unit * .24, maxPlate - inset * 2 - leading - roundInset * 2);
    const line1 = String(asset.line1 || ''), line2 = String(asset.line2 || '');
    const font1 = fittedText(ctx, line1, maxText, g.lowerHeight * .34, g.unit * .018, 720, theme);
    ctx.font = font1; const width1 = ctx.measureText(line1).width;
    const font2 = fittedText(ctx, line2, maxText, g.lowerHeight * .23, g.unit * .014, 500, theme);
    ctx.font = font2; const width2 = ctx.measureText(line2).width;
    const plateWidth = Math.min(maxPlate,
      Math.max(g.unit * .42, Math.max(width1, width2) + inset * 2 + leading + roundInset * 2));
    const radius = theme.id === 'round' ? g.lowerHeight / 2
      : theme.id === 'air' ? g.lowerHeight * .16 : 0;
    const textX = x + inset + leading + roundInset;
    ctx.save();
    if (theme.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.34)'; ctx.shadowBlur = g.unit * .025; ctx.shadowOffsetY = g.unit * .007;
    }
    fillBox(ctx, x, g.lowerY, plateWidth, g.lowerHeight, radius, theme.surface);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    if (theme.id === 'base') {
      ctx.fillStyle = theme.primary; ctx.fillRect(x, g.lowerY, accent, g.lowerHeight);
    } else if (theme.id === 'news') {
      ctx.fillStyle = theme.primary;
      ctx.fillRect(x, g.lowerY + g.lowerHeight - Math.max(accent, g.lowerHeight * .08),
        plateWidth, Math.max(accent, g.lowerHeight * .08));
    } else if (theme.id === 'air') {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x + inset * .42, g.lowerY + g.lowerHeight * .22, Math.max(3, accent * .55), g.lowerHeight * .56);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = theme.foreground; ctx.font = font1;
    ctx.fillText(line1, textX, g.lowerY + g.lowerHeight * (line2 ? .43 : .62), maxText);
    if (line2) {
      ctx.fillStyle = theme.muted; ctx.font = font2;
      ctx.fillText(line2, textX, g.lowerY + g.lowerHeight * .77, maxText);
    }
    ctx.restore();
  }

  /* A template changes presentation only: both saved lines remain available,
     and the shared planner remains the sole owner of position and dimensions. */
  function drawTemplateLower(ctx, box, asset, u, theme, template) {
    const style = template.lowerStyle;
    if (!['floating','white','dark','accent','outline','framed','stripe','centered','chevron'].includes(style)) return false;
    const {x,y,width:w,height:h} = box;
    if (!(w > 0 && h > 0)) return true;
    const line1 = String(asset.line1 || ''), line2 = String(asset.line2 || '');
    const pad = Math.min(u * .023, w * .06, h * .18);
    const edge = Math.min(u * .005, h * .055, w * .025);
    const primary = theme.primary || '#1265DE', white = theme.card || '#FFFFFF';
    const primaryInk = textOnPrimary(primary);
    const ink = theme.cardText || '#172033', muted = theme.cardMuted || '#596579';
    const dark = theme.surfaceStrong || 'rgba(7,10,18,.93)';
    const fill = (rx,ry,rw,rh,colour) => { ctx.fillStyle = colour; ctx.fillRect(rx,ry,rw,rh); };
    const text = (value,rx,ry,rw,rh,colour,weight,align,desired) => {
      if (!value || !(rw > 0 && rh > 0)) return;
      const start = Math.max(1, Math.min(desired, rh * .68));
      ctx.font = fittedText(ctx, value, rw, start, Math.max(1, start * .52), weight, theme);
      ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = colour;
      ctx.fillText(value, align === 'center' ? rx + rw / 2 : rx, ry + rh / 2, rw);
    };
    const lines = (rx,ry,rw,rh,colour,secondary,align) => {
      const titleHeight = line2 ? rh * .62 : rh;
      text(line1,rx,ry,rw,titleHeight,colour,720,align,u * .047);
      if (line2) text(line2,rx,ry + titleHeight,rw,rh - titleHeight,secondary,500,align,u * .027);
    };
    ctx.save();
    // The clip includes shadows and antialiasing, not just the plate itself.
    ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    if (style === 'chevron') {
      const badge = line2 ? w * .24 : 0, slash = Math.min(h * .32,w * .045);
      fill(x,y,w,h,white);
      if (badge) {
        fill(x,y,badge,h,primary);
        text(line2,x + pad,y,badge - pad * 2,h,primaryInk,750,'left',u * .026);
      }
      for (let i = 0; i < 3; i++) {
        const sx = x + badge + i * slash * .65;
        ctx.beginPath(); ctx.moveTo(sx,y); ctx.lineTo(sx + slash * .48,y);
        ctx.lineTo(sx + slash * .12,y + h * .26); ctx.lineTo(sx - slash * .36,y + h * .26);
        ctx.closePath(); ctx.fillStyle = primary; ctx.fill();
      }
      text(line1,x + badge + pad,y + h * .22,w - badge - pad * 2,h * .78,ink,750,'left',u * .043);
    } else if (style === 'floating') {
      let scrim = 'rgba(0,0,0,.20)';
      if (typeof ctx.createLinearGradient === 'function') {
        scrim = ctx.createLinearGradient(x,y,x,y + h);
        scrim.addColorStop(0,'rgba(0,0,0,0)'); scrim.addColorStop(1,'rgba(0,0,0,.30)');
      }
      fill(x,y,w,h,scrim);
      ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = Math.min(u * .007,h * .08);
      ctx.shadowOffsetY = Math.min(u * .0015,h * .02);
      const inset = Math.min(u * .002,w * .01), maxWidth = w - inset * 2;
      const headlineScale = Number(template.headlineScale) > 0 ? Number(template.headlineScale) : .063;
      const fittedLine = (value,desired,cap,weight) => {
        const start = Math.max(1,Math.min(desired,cap));
        const font = fittedText(ctx,value,maxWidth,start,Math.max(1,start * .52),weight,theme);
        // fontFor emits an integer pixel size; use the fitted value, not the
        // requested size, to reserve the actual subtitle line and its gap.
        return {font,size:Number(font.match(/([\d.]+)px/)[1])};
      };
      const title = fittedLine(line1,u * headlineScale,h * (line2 ? .45 : .68),720);
      const subtitle = line2 ? fittedLine(line2,u * .027,h * .22,500) : null;
      const bottom = y + h - Math.min(u * .006,h * .06);
      const gap = Math.min(u * .008,h * .08);
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#FFFFFF';
      ctx.font = title.font;
      ctx.fillText(line1,x + inset,bottom - (subtitle ? subtitle.size * 1.15 + gap : 0),maxWidth);
      if (subtitle) {
        ctx.font = subtitle.font; ctx.fillText(line2,x + inset,bottom,maxWidth);
      }
    } else if (style === 'framed') {
      const tabHeight = line2 ? h * .31 : 0;
      fill(x,y + tabHeight,w,h - tabHeight,primary);
      fill(x + edge,y + tabHeight + edge,w - edge * 2,h - tabHeight - edge * 2,white);
      if (line2) {
        ctx.font = fontFor(650,Math.min(u * .026,tabHeight * .68),theme);
        const tabWidth = Math.min(w,Math.max(w * .32,ctx.measureText(line2).width + pad * 2));
        fill(x,y,tabWidth,tabHeight,primary);
        text(line2,x + pad,y,tabWidth - pad * 2,tabHeight,primaryInk,650,'left',u * .026);
      }
      text(line1,x + pad + edge,y + tabHeight + edge,w - (pad + edge) * 2,
        h - tabHeight - edge * 2,ink,750,'left',u * .047);
    } else if (style === 'accent') {
      const titleHeight = line2 ? h * .64 : h;
      fill(x,y,w,titleHeight,primary);
      text(line1,x + pad,y,w - pad * 2,titleHeight,primaryInk,740,'left',u * .047);
      if (line2) {
        fill(x,y + titleHeight,w,h - titleHeight,white);
        text(line2,x + pad,y + titleHeight,w - pad * 2,h - titleHeight,ink,550,'left',u * .027);
      }
    } else if (style === 'outline') {
      fill(x,y,w,h,'rgba(7,10,18,.62)');
      fill(x,y,w,edge,primary); fill(x,y + h - edge,w,edge,primary);
      fill(x,y,edge,h,primary); fill(x + w - edge,y,edge,h,primary);
      lines(x + pad + edge,y + pad * .3,w - (pad + edge) * 2,h - pad * .6,'#FFFFFF','#FFFFFF');
    } else if (style === 'stripe') {
      const stripe = Math.min(h * .20,w * .10);
      fill(x,y,w,h,white); fill(x,y,stripe,h,primary);
      fill(x + stripe,y + h - edge,w - stripe,edge,dark);
      lines(x + stripe + pad,y + pad * .25,w - stripe - pad * 2,h - pad * .5,ink,muted);
    } else if (style === 'centered') {
      fill(x,y,w,h,white);
      fill(x + w * .4,y + h - edge,w * .2,edge,primary);
      lines(x + pad,y + pad * .2,w - pad * 2,h - pad * .65,ink,muted,'center');
    } else if (style === 'dark') {
      fill(x,y,w,h,dark); fill(x,y + h - edge,w,edge,primary);
      lines(x + pad,y + pad * .2,w - pad * 2,h - pad * .6,'#FFFFFF',theme.muted || '#CCD7E8');
    } else {
      fill(x,y,w,h,white); fill(x,y,edge,h,primary);
      lines(x + pad + edge,y + pad * .2,w - (pad + edge) * 2,h - pad * .4,ink,muted);
    }
    ctx.restore();
    return true;
  }

  function drawTemplateTicker(ctx, cv, asset, geometry, nowMs, theme, speed = state.tickerSpeed) {
    const grid = geometry.broadcastLayout, template = grid && grid.template;
    if (theme.id !== 'news' || !template || template.id === 'classic' ||
        !template.id && (!template.lowerStyle || template.lowerStyle === 'classic') || !grid.ticker) return false;
    const box = grid.ticker, u = geometry.unit, {x,y,width:w,height:h} = box;
    if (!(w > 0 && h > 0)) return true;
    const badge = Math.min(u * .20,w * .28), pad = Math.min(u * .015,badge * .1);
    const label = Array.from(String(theme.tickerLabel || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ')
      .replace(/\s+/g,' ').trim()).slice(0,24).join('') || 'NEWS';
    const light = template.tickerStyle === 'light';
    const fontSize = Math.max(1,Math.min(h * .48,u * .027));
    ctx.save();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
    ctx.fillStyle = light ? theme.card || '#FFFFFF' : theme.surfaceStrong || 'rgba(7,10,18,.93)';
    ctx.fillRect(x,y,w,h);
    ctx.fillStyle = theme.primary || '#1265DE'; ctx.fillRect(x,y,badge,h);
    ctx.fillStyle = textOnPrimary(theme.primary || '#1265DE'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = fittedText(ctx,label,badge - pad * 2,fontSize,Math.max(1,fontSize * .55),750,theme);
    ctx.fillText(label,x + badge / 2,y + h / 2,badge - pad * 2);
    const contentStart = x + badge, right = x + w;
    ctx.beginPath(); ctx.rect(contentStart,y,w - badge,h); ctx.clip();
    ctx.font = fontFor(600,fontSize,theme); ctx.textAlign = 'left';
    ctx.fillStyle = light ? theme.cardText || '#172033' : '#FFFFFF';
    const text = String(asset.text || ''), textWidth = Math.max(1,ctx.measureText(text).width);
    const loop = textWidth + Math.max(u * .30,fontSize * 6);
    const pixelsPerSecond = Math.max(72,u * .135) * speed;
    const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let tx = right - (((now / 1000) * pixelsPerSecond) % loop);
    while (tx > contentStart) tx -= loop;
    while (tx + textWidth < contentStart) tx += loop;
    for (; tx < right; tx += loop) ctx.fillText(text,tx + pad,y + h / 2);
    ctx.restore();
    return true;
  }

  function drawTicker(ctx, cv, asset, geometry, nowMs, options) {
    const g = geometry, y = g.tickerY, h = g.tickerHeight;
    const accentWidth = Math.max(7, g.unit * .01), pad = g.unit * .025;
    const fontSize = Math.max(15, Math.round(Math.min(h * .39, cv.width * .042)));
    const text = String(asset.text || '');
    const theme = themeProfile(options);
    const speed = options?.tickerSpeed ?? state.tickerSpeed;
    if (drawTemplateTicker(ctx, cv, asset, geometry, nowMs, theme, speed)) return;
    const radius = theme.id === 'round' ? h / 2 : theme.id === 'air' ? h * .22 : 0;
    const x0 = g.broadcastLayout && g.broadcastLayout.ticker ? g.broadcastLayout.ticker.x : g.margin;
    const width = g.broadcastLayout && g.broadcastLayout.ticker ? g.broadcastLayout.ticker.width : cv.width - g.margin * 2;
    const contentStart = x0 + (theme.id === 'base' ? accentWidth : 0);
    ctx.save();
    if (theme.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.32)'; ctx.shadowBlur = g.unit * .02; ctx.shadowOffsetY = g.unit * .005;
    }
    fillBox(ctx, x0, y, width, h, radius, theme.id === 'news' ? theme.surfaceStrong : theme.surface);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    if (theme.id === 'base') {
      ctx.fillStyle = theme.primary; ctx.fillRect(x0, y, accentWidth, h);
    } else if (theme.id === 'news') {
      ctx.fillStyle = theme.primary; ctx.fillRect(x0, y, width, Math.max(4, h * .10));
    }
    ctx.beginPath(); ctx.rect(contentStart, y, width - (contentStart - x0), h); ctx.clip();
    ctx.font = fontFor(650, fontSize, theme);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = theme.foreground;
    const textWidth = Math.max(1, ctx.measureText(text).width);
    const gap = Math.max(g.unit * .30, fontSize * 6);
    const loop = textWidth + gap;
    const pixelsPerSecond = Math.max(72, g.unit * .135) * speed;
    const now = Number.isFinite(nowMs) ? nowMs : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let x = cv.width - (((now / 1000) * pixelsPerSecond) % loop);
    while (x > contentStart) x -= loop;
    while (x + textWidth < contentStart) x += loop;
    const right = cv.width - g.margin;
    for (; x < right; x += loop) ctx.fillText(text, x + pad, y + h / 2);
    ctx.restore();
  }

  function draw(ctx, cv, options) {
    const status = options?.captionState || activeStatus();
    if (!ctx || !cv) return status;
    const geometry = layout(cv, options);
    const theme = themeProfile(options);
    try {
      if (status.lowerThird) drawLowerThird(ctx, cv, status.lowerThird, geometry, { theme });
      if (status.ticker) drawTicker(ctx, cv, status.ticker, geometry, options && options.nowMs, { theme, tickerSpeed:status.tickerSpeed });
      lastError = '';
    } catch (error) { lastError = error && error.message || String(error); }
    return Object.assign({}, status, { geometry, theme, error: lastError });
  }

  // Pure editor preview: no temporary active asset and no persistence or events.
  function drawPreview(ctx, cv, raw, options = {}) {
    const asset = validateDraft(raw), theme = themeProfile(options);
    const u = Math.min(cv.width,cv.height), margin = u * .035, ticker = asset.type === 'ticker';
    const geometry = {unit:u,margin,lowerHeight:Math.min(cv.height * .13,cv.width * .23),
      tickerHeight:Math.min(cv.height * .085,cv.width * .12),bottomInset:0};
    geometry.tickerY = cv.height - margin - geometry.tickerHeight;
    geometry.lowerY = cv.height - margin - geometry.lowerHeight;
    if (theme.id === 'news' && window.OpenLiveBroadcastLayout) {
      geometry.broadcastLayout = window.OpenLiveBroadcastLayout.plan(cv,{theme,hasLower:!ticker,hasTicker:ticker});
      const grid = geometry.broadcastLayout;
      if (grid.lower) { geometry.lowerHeight = grid.lower.height; geometry.lowerY = grid.lower.y; }
      if (grid.ticker) { geometry.tickerHeight = grid.ticker.height; geometry.tickerY = grid.ticker.y; }
    }
    if (ticker) drawTicker(ctx,cv,asset,geometry,options.nowMs == null ? 2000 : options.nowMs,{theme});
    else drawLowerThird(ctx,cv,asset,geometry,{theme});
    return {asset,geometry,theme};
  }

  load();

  return {
    STORE, PROGRAMME_STORE, TYPES, getState, list, has, create, update, remove, setVisible, hideAll,
    setTickerSpeed, active, activeStatus, subscribe, validateDraft, layout, recallSceneState,
    drawLowerThird, drawTicker, draw, drawPreview,
    get lastError() { return lastError; }
  };
})();
