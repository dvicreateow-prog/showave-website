/* SHOWAVE Chaser / Mapper: deterministic Pixel Map export engine.
   -------------------------------------------------------------------------
   The operator UI owns dialogs and file-system permissions. This module owns
   the portable export contract: Input/Output targets, exact dimensions,
   styling, rendering, preflight metadata and the ZIP fallback package. */
(function installOpenLiveChaserExport(global) {
  'use strict';

  if (global.OpenLiveChaserExport) return;
  const C = global.OpenLiveChaser;
  if (!C) return;

  const SCHEMA = 1;
  const MAX_EDGE = 16384;
  const MAX_PIXELS = 67108864;
  const FONT_CHOICES = Object.freeze(['Arial', 'Segoe UI', 'Helvetica', 'Verdana', 'Tahoma', 'monospace']);
  const PLACEMENTS = Object.freeze(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-right']);
  const COORDINATES = Object.freeze(['none', 'mixed', 'letters', 'numbers']);
  const UNITS = Object.freeze(['mm', 'cm', 'in']);

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const number = (value, fallback, min, max) => clamp(
    Number.isFinite(Number(value)) ? Number(value) : fallback, min, max);
  const integer = (value, fallback, min, max) => Math.round(number(value, fallback, min, max));
  const bool = (value, fallback) => value == null ? !!fallback : !!value;
  const text = (value, fallback, limit) => String(value == null ? fallback || '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit || 512);
  const choice = (value, values, fallback) => values.includes(value) ? value : fallback;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

  function packedToHex(value, fallback) {
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    const packed = Number.isFinite(Number(value)) ? Number(value) >>> 0 : fallback >>> 0;
    return '#' + ((packed >>> 16) & 255).toString(16).padStart(2, '0')
      + ((packed >>> 8) & 255).toString(16).padStart(2, '0')
      + (packed & 255).toString(16).padStart(2, '0');
  }

  function color(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
  }

  function defaults(project) {
    const safe = C.normaliseProject(project), pixel = safe.pixelMap;
    return {
      schema:SCHEMA,
      targetId:'input',
      scale:100,
      project:{
        title:safe.name,
        notes:'',
        background:'#05070a',
        transparent:!!pixel.transparent,
        border:true,
        borderColor:'#8793a5',
        borderWidth:2,
        fontFamily:'Arial',
        fontSize:18,
        showTargetInfo:true,
        showScreenNames:true,
        showTargetResolution:true,
        showTargetAspect:true,
        showProjectNotes:true,
        infoPlacement:'bottom-right'
      },
      main:{name:''},
      panel:{
        sizeX:Math.max(1, Math.round(safe.map.composition.width / pixel.numX)),
        sizeY:Math.max(1, Math.round(safe.map.composition.height / pixel.numY)),
        pitchX:3.9,
        pitchY:3.9,
        unit:'mm',
        color1:packedToHex(pixel.color1, 0xff101010),
        color2:packedToHex(pixel.color2, 0xffe6e6e6),
        gridColor:packedToHex(pixel.gridColor, 0xff3d4652),
        gridWidth:1,
        coordinates:pixel.showLabels ? 'mixed' : 'none',
        coordinateSize:10
      },
      info:{
        name:true,
        screen:false,
        position:true,
        resolution:true,
        aspect:false,
        physical:true,
        placement:'bottom-left'
      },
      deco:{
        cross:false,
        circle:false,
        dots:false,
        color:'#f4f7fb',
        lineWidth:2,
        dotSize:4
      },
      logo:{
        enabled:false,
        dataUrl:'',
        name:'',
        size:28,
        position:'center',
        opacity:1
      },
      sliceStyles:{}
    };
  }

  function normaliseProjectStyle(raw, base) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const legacyHidden = own(value, 'showTargetInfo') && !value.showTargetInfo &&
      !['showTargetResolution', 'showTargetAspect', 'showProjectNotes', 'infoPlacement']
        .some(key => own(value, key));
    return {
      title:text(value.title, base.title, 160),
      notes:text(value.notes, base.notes, 500),
      background:color(value.background, base.background),
      transparent:bool(value.transparent, base.transparent),
      border:bool(value.border, base.border),
      borderColor:color(value.borderColor, base.borderColor),
      borderWidth:number(value.borderWidth, base.borderWidth, 0, 32),
      fontFamily:choice(value.fontFamily, FONT_CHOICES, base.fontFamily),
      fontSize:integer(value.fontSize, base.fontSize, 6, 160),
      showTargetInfo:bool(value.showTargetInfo, base.showTargetInfo),
      showScreenNames:legacyHidden ? false : bool(value.showScreenNames, base.showScreenNames),
      showTargetResolution:legacyHidden ? false : bool(value.showTargetResolution, base.showTargetResolution),
      showTargetAspect:legacyHidden ? false : bool(value.showTargetAspect, base.showTargetAspect),
      showProjectNotes:legacyHidden ? false : bool(value.showProjectNotes, base.showProjectNotes),
      infoPlacement:choice(value.infoPlacement, PLACEMENTS, base.infoPlacement)
    };
  }

  function normaliseMain(raw, base, partial) {
    const value = raw && typeof raw === 'object' ? raw : {}, out = {};
    if (!partial || own(value, 'name')) out.name = text(value.name, base.name, 160);
    return out;
  }

  function normalisePanel(raw, base, partial) {
    const value = raw && typeof raw === 'object' ? raw : {}, out = {};
    if (!partial || own(value, 'sizeX')) out.sizeX = integer(value.sizeX, base.sizeX, 1, 8192);
    if (!partial || own(value, 'sizeY')) out.sizeY = integer(value.sizeY, base.sizeY, 1, 8192);
    if (!partial || own(value, 'pitchX')) out.pitchX = number(value.pitchX, base.pitchX, 0.001, 10000);
    if (!partial || own(value, 'pitchY')) out.pitchY = number(value.pitchY, base.pitchY, 0.001, 10000);
    if (!partial || own(value, 'unit')) out.unit = choice(value.unit, UNITS, base.unit);
    if (!partial || own(value, 'color1')) out.color1 = color(value.color1, base.color1);
    if (!partial || own(value, 'color2')) out.color2 = color(value.color2, base.color2);
    if (!partial || own(value, 'gridColor')) out.gridColor = color(value.gridColor, base.gridColor);
    if (!partial || own(value, 'gridWidth')) out.gridWidth = number(value.gridWidth, base.gridWidth, 0, 24);
    if (!partial || own(value, 'coordinates'))
      out.coordinates = choice(value.coordinates, COORDINATES, base.coordinates);
    if (!partial || own(value, 'coordinateSize'))
      out.coordinateSize = integer(value.coordinateSize, base.coordinateSize, 5, 96);
    return out;
  }

  function normaliseInfo(raw, base, partial) {
    const value = raw && typeof raw === 'object' ? raw : {}, out = {};
    for (const key of ['name', 'screen', 'position', 'resolution', 'aspect', 'physical'])
      if (!partial || own(value, key)) out[key] = bool(value[key], base[key]);
    if (!partial || own(value, 'placement'))
      out.placement = choice(value.placement, PLACEMENTS, base.placement);
    return out;
  }

  function normaliseDeco(raw, base, partial) {
    const value = raw && typeof raw === 'object' ? raw : {}, out = {};
    for (const key of ['cross', 'circle', 'dots'])
      if (!partial || own(value, key)) out[key] = bool(value[key], base[key]);
    if (!partial || own(value, 'color')) out.color = color(value.color, base.color);
    if (!partial || own(value, 'lineWidth'))
      out.lineWidth = number(value.lineWidth, base.lineWidth, 0.25, 48);
    if (!partial || own(value, 'dotSize')) out.dotSize = number(value.dotSize, base.dotSize, 0.5, 96);
    return out;
  }

  function normaliseLogo(raw, base, partial) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const dataUrl = /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(String(value.dataUrl || ''))
      ? String(value.dataUrl).slice(0, 12 * 1024 * 1024) : '';
    const out = {};
    if (!partial || own(value, 'enabled')) out.enabled = bool(value.enabled, base.enabled);
    if (!partial) {
      out.dataUrl = dataUrl;
      out.name = text(value.name, dataUrl ? 'Logo' : '', 160);
    }
    if (!partial || own(value, 'size')) out.size = number(value.size, base.size, 2, 100);
    if (!partial || own(value, 'position')) out.position = choice(value.position, PLACEMENTS, base.position);
    if (!partial || own(value, 'opacity')) out.opacity = number(value.opacity, base.opacity, 0, 1);
    return out;
  }

  function normaliseSettings(raw, project) {
    const safeProject = C.normaliseProject(project), base = defaults(safeProject);
    const value = raw && typeof raw === 'object' ? raw : {};
    const settings = {
      schema:SCHEMA,
      targetId:text(value.targetId, base.targetId, 300),
      scale:choice(Number(value.scale), [25, 50, 100], base.scale),
      project:normaliseProjectStyle(value.project, base.project),
      main:normaliseMain(value.main, base.main, false),
      panel:normalisePanel(value.panel, base.panel, false),
      info:normaliseInfo(value.info, base.info, false),
      deco:normaliseDeco(value.deco, base.deco, false),
      logo:normaliseLogo(value.logo, base.logo, false),
      sliceStyles:{}
    };
    const valid = new Set(C.flatSlices(safeProject.map).map(slice => slice.id));
    const styles = value.sliceStyles && typeof value.sliceStyles === 'object' ? value.sliceStyles : {};
    Object.keys(styles).slice(0, 4096).forEach(id => {
      if (!valid.has(id) || !styles[id] || typeof styles[id] !== 'object') return;
      const style = styles[id], next = {};
      if (style.main) next.main = normaliseMain(style.main, settings.main, true);
      if (style.panel) next.panel = normalisePanel(style.panel, settings.panel, true);
      if (style.info) next.info = normaliseInfo(style.info, settings.info, true);
      if (style.deco) next.deco = normaliseDeco(style.deco, settings.deco, true);
      if (style.logo) next.logo = normaliseLogo(style.logo, settings.logo, true);
      if (Object.keys(next).some(key => Object.keys(next[key]).length)) settings.sliceStyles[id] = next;
    });
    const available = targets(safeProject);
    if (!available.some(target => target.id === settings.targetId)) settings.targetId = 'input';
    return settings;
  }

  function safeName(value, fallback) {
    let name = text(value, fallback || 'SHOWAVE-Chaser', 180)
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[. -]+|[. -]+$/g, '');
    name = (name || fallback || 'SHOWAVE-Chaser').slice(0, 120);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `SHOWAVE-${name}`;
    return name;
  }

  function targetSlice(slice, screen, geometry) {
    return {
      id:slice.id,
      name:slice.name,
      kind:slice.kind,
      screenId:screen.id,
      screenName:screen.name,
      geometry,
      input:slice.input,
      output:slice.output
    };
  }

  function targets(project) {
    const safe = C.normaliseProject(project), stem = safeName(safe.name, 'SHOWAVE-Chaser');
    const input = {
      id:'input', kind:'input', name:'Input Map', screenId:null,
      width:safe.map.composition.width, height:safe.map.composition.height,
      filename:`${stem}-input-map.png`,
      slices:safe.map.screens.flatMap(screen => screen.slices.map(slice =>
        targetSlice(slice, screen, slice.input)))
    };
    const result = [input, ...safe.map.screens.map(screen => ({
      id:`output:${screen.id}`,
      kind:'output',
      name:`${screen.name} Output`,
      screenId:screen.id,
      device:screen.device,
      followComposition:screen.followComposition,
      width:screen.raster.width,
      height:screen.raster.height,
      filename:`${stem}-${safeName(screen.name, 'screen')}-output-map.png`,
      slices:screen.slices.map(slice => targetSlice(slice, screen, slice.output))
    }))];
    /* Screen names need not be unique. Keep stable, Windows-safe package
       names without allowing a later Screen to overwrite an earlier PNG. */
    const used = new Set();
    result.forEach(target => {
      const original = target.filename, stemName = original.replace(/\.png$/i, '');
      let candidate = original, suffix = 2;
      while (used.has(candidate.toLowerCase())) candidate = `${stemName}-${suffix++}.png`;
      target.filename = candidate; used.add(candidate.toLowerCase());
    });
    return result;
  }

  function targetById(project, id) {
    const all = targets(project);
    return all.find(target => target.id === id) || all[0];
  }

  function exportPlan(target, scalePercent, policy) {
    const wanted = choice(Number(scalePercent), [25, 50, 100], 100) / 100;
    const options = policy || {};
    const maxEdge = integer(options.maxEdge, MAX_EDGE, 256, 32768);
    const maxPixels = integer(options.maxPixels, MAX_PIXELS, 65536, 1073741824);
    const requestedWidth = Math.max(1, Math.round(target.width * wanted));
    const requestedHeight = Math.max(1, Math.round(target.height * wanted));
    const safetyScale = Math.min(1, maxEdge / requestedWidth, maxEdge / requestedHeight,
      Math.sqrt(maxPixels / Math.max(1, requestedWidth * requestedHeight)));
    const width = Math.max(1, Math.floor(requestedWidth * safetyScale));
    const height = Math.max(1, Math.floor(requestedHeight * safetyScale));
    return {
      targetId:target.id,
      nativeWidth:target.width,
      nativeHeight:target.height,
      requestedScale:wanted,
      width,
      height,
      /* Rounding a reduced odd raster can give the two axes slightly
         different ratios. This is the same uniform fit render() uses. */
      renderScale:Math.min(width / target.width, height / target.height),
      limited:safetyScale < 0.999999,
      filename:target.filename
    };
  }

  function vertexBounds(vertices) {
    const xs = vertices.map(point => point.x), ys = vertices.map(point => point.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return {x, y, w:Math.max(1, Math.max(...xs) - x), h:Math.max(1, Math.max(...ys) - y)};
  }

  function pointDistance(a, b) {
    return Math.hypot((b && b.x || 0) - (a && a.x || 0),
      (b && b.y || 0) - (a && a.y || 0));
  }

  /* SHOWAVE Map quads are ordered TL, TR, BR, BL. Their bounding box is not
     their authored panel resolution once a slice is rotated or keystoned, so
     retain an intrinsic local width/height for panel counts and metadata. */
  function geometryMetrics(geometry) {
    const points = geometry && Array.isArray(geometry.vertices) ? geometry.vertices : [];
    const bounds = points.length ? vertexBounds(points) : {
      x:Number(geometry && geometry.x) || 0,
      y:Number(geometry && geometry.y) || 0,
      w:Math.max(1, Number(geometry && geometry.w) || 1),
      h:Math.max(1, Number(geometry && geometry.h) || 1)
    };
    if (points.length !== 4) return Object.assign({}, bounds, {
      width:bounds.w, height:bounds.h, topLeft:{x:bounds.x, y:bounds.y}, kind:'polygon'
    });
    const width = (pointDistance(points[0], points[1]) + pointDistance(points[3], points[2])) / 2;
    const height = (pointDistance(points[0], points[3]) + pointDistance(points[1], points[2])) / 2;
    return Object.assign({}, bounds, {
      width:Math.max(1, width), height:Math.max(1, height),
      topLeft:{x:points[0].x, y:points[0].y}, kind:'quad'
    });
  }

  function quadPoint(points, u, v) {
    const topX = points[0].x + (points[1].x - points[0].x) * u;
    const topY = points[0].y + (points[1].y - points[0].y) * u;
    const bottomX = points[3].x + (points[2].x - points[3].x) * u;
    const bottomY = points[3].y + (points[2].y - points[3].y) * u;
    return {x:topX + (bottomX - topX) * v, y:topY + (bottomY - topY) * v};
  }

  function axisAlignedQuad(points) {
    if (!points || points.length !== 4) return false;
    const bounds = vertexBounds(points), tolerance = Math.max(.01, Math.max(bounds.w, bounds.h) * 1e-6);
    return Math.abs(points[0].y - points[1].y) <= tolerance &&
      Math.abs(points[1].x - points[2].x) <= tolerance &&
      Math.abs(points[2].y - points[3].y) <= tolerance &&
      Math.abs(points[3].x - points[0].x) <= tolerance &&
      points[1].x > points[0].x + tolerance && points[2].y > points[1].y + tolerance &&
      points[2].x > points[3].x + tolerance && points[3].y > points[0].y + tolerance;
  }

  function layoutTarget(target, width, height, options) {
    const opts = options || {}, padding = Math.max(0, Number(opts.padding) || 0);
    const zoom = number(opts.zoom, 1, 0.25, 8);
    const fit = Math.min(Math.max(1, width - padding * 2) / target.width,
      Math.max(1, height - padding * 2) / target.height);
    const scale = (Number.isFinite(fit) && fit > 0 ? fit : 1) * zoom;
    const offsetX = (width - target.width * scale) / 2;
    const offsetY = (height - target.height * scale) / 2;
    return {
      target,
      scale,
      offsetX,
      offsetY,
      stage:{x:offsetX, y:offsetY, w:target.width * scale, h:target.height * scale},
      slices:target.slices.map(slice => {
        const source = slice.geometry && slice.geometry.vertices || [];
        const points = source.map(point => ({x:offsetX + point.x * scale, y:offsetY + point.y * scale}));
        return Object.assign({}, slice, {points, box:vertexBounds(points)});
      })
    };
  }

  function makePath(ctx, points) {
    if (!points || points.length < 3) return false;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
    ctx.closePath(); return true;
  }

  function mergedStyle(settings, sliceId) {
    const override = settings.sliceStyles[sliceId] || {};
    return {
      main:Object.assign({}, settings.main, override.main || {}),
      panel:Object.assign({}, settings.panel, override.panel || {}),
      info:Object.assign({}, settings.info, override.info || {}),
      deco:Object.assign({}, settings.deco, override.deco || {}),
      logo:Object.assign({}, settings.logo, override.logo || {})
    };
  }

  function columnLabel(index) {
    let number = Math.max(0, Math.floor(index)), label = '';
    do { label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26) - 1; }
    while (number >= 0);
    return label;
  }

  function coordinateLabel(mode, column, row, numX) {
    if (mode === 'letters') return columnLabel(row * numX + column);
    if (mode === 'numbers') return String(row * numX + column + 1);
    return `${columnLabel(column)}${row + 1}`;
  }

  function gcd(a, b) {
    let left = Math.max(1, Math.round(Math.abs(a))), right = Math.max(1, Math.round(Math.abs(b)));
    while (right) { const remainder = left % right; left = right; right = remainder; }
    return left;
  }

  function aspect(width, height) {
    const divisor = gcd(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
  }

  function formatMeasure(value) {
    if (value >= 1000) return value.toFixed(0);
    if (value >= 100) return value.toFixed(1).replace(/\.0$/, '');
    if (value < 1) return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function physicalLabel(width, height, panel) {
    let physicalWidth = width * panel.pitchX, physicalHeight = height * panel.pitchY;
    let unit = panel.unit, largest = Math.max(physicalWidth, physicalHeight);
    if (unit === 'mm' && largest >= 1000) {
      physicalWidth /= 1000; physicalHeight /= 1000; unit = 'm';
    } else if (unit === 'cm' && largest >= 100) {
      physicalWidth /= 100; physicalHeight /= 100; unit = 'm';
    } else if (unit === 'in' && largest >= 12) {
      physicalWidth /= 12; physicalHeight /= 12; unit = 'ft';
    }
    return `${formatMeasure(physicalWidth)} × ${formatMeasure(physicalHeight)} ${unit}`;
  }

  function placementPoint(box, placement, pad) {
    const gap = pad || 0;
    if (placement === 'top-right') return {x:box.x + box.w - gap, y:box.y + gap, align:'right', baseline:'top'};
    if (placement === 'center') return {x:box.x + box.w / 2, y:box.y + box.h / 2, align:'center', baseline:'middle'};
    if (placement === 'bottom-left') return {x:box.x + gap, y:box.y + box.h - gap, align:'left', baseline:'bottom'};
    if (placement === 'bottom-right') return {x:box.x + box.w - gap, y:box.y + box.h - gap, align:'right', baseline:'bottom'};
    return {x:box.x + gap, y:box.y + gap, align:'left', baseline:'top'};
  }

  function drawLogo(ctx, box, points, metrics, logo, image, scale) {
    if (!logo.enabled || !image || !logo.dataUrl || typeof ctx.drawImage !== 'function') return;
    const naturalWidth = image.naturalWidth || image.width || 1;
    const naturalHeight = image.naturalHeight || image.height || 1;
    const mapped = points && points.length === 4;
    const maxWidth = (mapped ? metrics.width * scale : box.w) * logo.size / 100;
    const maxHeight = (mapped ? metrics.height * scale : box.h) * logo.size / 100;
    const fit = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
    const width = Math.max(1, naturalWidth * fit), height = Math.max(1, naturalHeight * fit);
    const gap = 4 * scale;
    let x = box.x + gap, y = box.y + gap;
    if (mapped && !axisAlignedQuad(points)) {
      /* Artwork stays upright for operator readability. Centre its complete
         axis-aligned bounds at a point inset along the quad's local axes, so
         90°/180°/mirrored vertex order cannot send it outside the clip. */
      const radius = Math.hypot(width, height) / 2;
      const insetU = clamp((gap + radius) / Math.max(1, metrics.width * scale), 0, .45);
      const insetV = clamp((gap + radius) / Math.max(1, metrics.height * scale), 0, .45);
      let u = insetU, v = insetV;
      if (logo.position === 'top-right') u = 1 - insetU;
      else if (logo.position === 'bottom-left') v = 1 - insetV;
      else if (logo.position === 'bottom-right') { u = 1 - insetU; v = 1 - insetV; }
      else if (logo.position === 'center') { u = .5; v = .5; }
      const anchor = quadPoint(points, u, v);
      x = anchor.x - width / 2; y = anchor.y - height / 2;
    } else if (logo.position === 'top-right') x = box.x + box.w - gap - width;
    else if (logo.position === 'bottom-left') y = box.y + box.h - gap - height;
    else if (logo.position === 'bottom-right') {
      x = box.x + box.w - gap - width; y = box.y + box.h - gap - height;
    } else if (logo.position === 'center') {
      x = box.x + (box.w - width) / 2; y = box.y + (box.h - height) / 2;
    }
    ctx.save();
    try {
      ctx.globalAlpha = logo.opacity; ctx.drawImage(image, x, y, width, height);
    } finally { ctx.restore(); }
  }

  function drawDeco(ctx, box, points, metrics, deco, scale) {
    if (!deco.cross && !deco.circle && !deco.dots) return;
    const inset = Math.max(2 * scale, deco.lineWidth * scale * 1.5);
    if (points && points.length === 4) {
      const insetU = clamp(inset / Math.max(1, metrics.width * scale), 0, .45);
      const insetV = clamp(inset / Math.max(1, metrics.height * scale), 0, .45);
      const corners = [quadPoint(points, insetU, insetV), quadPoint(points, 1 - insetU, insetV),
        quadPoint(points, 1 - insetU, 1 - insetV), quadPoint(points, insetU, 1 - insetV)];
      ctx.save(); ctx.strokeStyle = deco.color; ctx.fillStyle = deco.color;
      ctx.lineWidth = Math.max(.5, deco.lineWidth * scale);
      if (deco.cross) {
        ctx.beginPath(); ctx.moveTo(corners[0].x, corners[0].y); ctx.lineTo(corners[2].x, corners[2].y);
        ctx.moveTo(corners[1].x, corners[1].y); ctx.lineTo(corners[3].x, corners[3].y); ctx.stroke();
      }
      if (deco.circle) {
        ctx.beginPath();
        for (let index = 0; index <= 48; index++) {
          const angle = index / 48 * Math.PI * 2;
          const point = quadPoint(points,
            .5 + Math.cos(angle) * (.5 - insetU), .5 + Math.sin(angle) * (.5 - insetV));
          if (index) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
        }
        ctx.closePath(); ctx.stroke();
      }
      if (deco.dots && typeof ctx.arc === 'function') {
        const radius = Math.max(.5, deco.dotSize * scale);
        corners.forEach(point => {
          ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill();
        });
      }
      ctx.restore(); return;
    }
    const left = box.x + inset, top = box.y + inset;
    const right = box.x + box.w - inset, bottom = box.y + box.h - inset;
    ctx.save(); ctx.strokeStyle = deco.color; ctx.fillStyle = deco.color;
    ctx.lineWidth = Math.max(.5, deco.lineWidth * scale);
    if (deco.cross) {
      ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(right, bottom);
      ctx.moveTo(right, top); ctx.lineTo(left, bottom); ctx.stroke();
    }
    if (deco.circle && typeof ctx.ellipse === 'function') {
      ctx.beginPath(); ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2,
        Math.max(1, box.w / 2 - inset), Math.max(1, box.h / 2 - inset), 0, 0, Math.PI * 2); ctx.stroke();
    }
    if (deco.dots && typeof ctx.arc === 'function') {
      const radius = Math.max(.5, deco.dotSize * scale);
      [[left, top], [right, top], [left, bottom], [right, bottom]].forEach(point => {
        ctx.beginPath(); ctx.arc(point[0], point[1], radius, 0, Math.PI * 2); ctx.fill();
      });
    }
    ctx.restore();
  }

  function drawInfo(ctx, slice, box, points, metrics, style, font, scale) {
    const info = style.info, panel = style.panel, lines = [];
    if (info.name) lines.push(style.main.name || slice.name);
    if (info.screen) lines.push(slice.screenName);
    if (info.position) lines.push(`${Math.round(metrics.topLeft.x)}, ${Math.round(metrics.topLeft.y)}`);
    if (info.resolution) lines.push(`${Math.round(metrics.width)} × ${Math.round(metrics.height)} px`);
    if (info.aspect) lines.push(aspect(metrics.width, metrics.height));
    if (info.physical) lines.push(physicalLabel(metrics.width, metrics.height, panel));
    if (!lines.length) return;
    const size = Math.max(5, font.size * .72 * scale), lineHeight = size * 1.18;
    if (box.w < size * 4 || box.h < lineHeight * 1.2) return;
    const gap = Math.max(4, 5 * scale);
    let point = placementPoint(box, info.placement, gap);
    const transformed = points && points.length === 4 && !axisAlignedQuad(points);
    if (transformed) {
      const blockWidth = Math.min(metrics.width * scale - gap * 2,
        Math.max(...lines.map(line => line.length), 4) * size * .62);
      const blockHeight = lines.length * lineHeight;
      const radius = Math.hypot(Math.max(1, blockWidth), blockHeight) / 2;
      const insetU = clamp((gap + radius) / Math.max(1, metrics.width * scale), 0, .45);
      const insetV = clamp((gap + radius) / Math.max(1, metrics.height * scale), 0, .45);
      let u = insetU, v = insetV;
      if (info.placement === 'top-right') u = 1 - insetU;
      else if (info.placement === 'bottom-left') v = 1 - insetV;
      else if (info.placement === 'bottom-right') { u = 1 - insetU; v = 1 - insetV; }
      else if (info.placement === 'center') { u = .5; v = .5; }
      point = Object.assign(quadPoint(points, u, v), {align:'center', baseline:'middle'});
    }
    ctx.save(); ctx.fillStyle = '#ffffff'; ctx.font = `${size}px ${font.family}`;
    ctx.textAlign = point.align; ctx.textBaseline = point.baseline;
    ctx.shadowColor = '#000000'; ctx.shadowBlur = Math.max(1, 3 * scale);
    let start = point.y;
    if (point.baseline === 'bottom') start -= lineHeight * (lines.length - 1);
    else if (point.baseline === 'middle') start -= lineHeight * (lines.length - 1) / 2;
    lines.forEach((line, index) => ctx.fillText(line, point.x, start + index * lineHeight, Math.max(10, box.w - 10 * scale)));
    ctx.restore();
  }

  function drawProjectInfo(ctx, target, settings, stage, scale) {
    const project = settings.project;
    const lines = [];
    if (project.showTargetInfo) lines.push(project.title || 'SHOWAVE Chaser');
    if (project.showScreenNames) lines.push(target.name);
    if (project.showTargetResolution) lines.push(`${target.width} × ${target.height} px`);
    if (project.showTargetAspect) lines.push(`Aspect ${aspect(target.width, target.height)}`);
    if (project.showProjectNotes && project.notes)
      project.notes.split(/\r?\n/).slice(0, 4).forEach(line => lines.push(line));
    if (!lines.length) return;
    const size = Math.max(7, project.fontSize * scale), lineHeight = size * 1.22;
    const pad = Math.max(5, 8 * scale), approxWidth = Math.min(stage.w * .72,
      Math.max(...lines.map(line => line.length), 12) * size * .62 + pad * 2);
    const blockHeight = lines.length * lineHeight + pad * 2;
    let x = stage.x, y = stage.y;
    if (project.infoPlacement === 'top-right') x += stage.w - approxWidth;
    else if (project.infoPlacement === 'center') {
      x += (stage.w - approxWidth) / 2; y += (stage.h - blockHeight) / 2;
    } else if (project.infoPlacement === 'bottom-left') y += stage.h - blockHeight;
    else if (project.infoPlacement === 'bottom-right') {
      x += stage.w - approxWidth; y += stage.h - blockHeight;
    }
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(x, y, approxWidth, blockHeight);
    ctx.strokeStyle = project.borderColor; ctx.lineWidth = Math.max(.5, scale); ctx.strokeRect(x, y, approxWidth, blockHeight);
    ctx.fillStyle = '#ffffff'; ctx.font = `${size}px ${project.fontFamily}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.shadowColor = '#000000'; ctx.shadowBlur = Math.max(1, 2 * scale);
    lines.forEach((line, index) => ctx.fillText(line, x + pad, y + pad + index * lineHeight, approxWidth - pad * 2));
    ctx.restore();
  }

  function drawPanelRaster(ctx, box, panel, columns, rows, cellWidth, cellHeight, exportScale) {
    const cells = columns * rows;
    /* Dense 1–4 px panel grids can contain millions of cells. A 2×2 repeating
       tile produces the same clipped raster in constant drawing work and
       avoids locking the operator UI during preview or export. */
    if (cells > 4096 && global.document && typeof global.document.createElement === 'function' &&
        typeof ctx.createPattern === 'function' && typeof ctx.translate === 'function' && typeof ctx.scale === 'function') {
      const tile = global.document.createElement('canvas'); tile.width = 32; tile.height = 32;
      const tileCtx = tile.getContext && tile.getContext('2d');
      if (tileCtx) {
        tileCtx.fillStyle = panel.color1; tileCtx.fillRect(0, 0, 32, 32);
        /* Keep A1 the same color as the direct and warped raster paths. */
        tileCtx.fillStyle = panel.color2; tileCtx.fillRect(0, 0, 16, 16); tileCtx.fillRect(16, 16, 16, 16);
        if (panel.gridWidth > 0) {
          /* Use the fitted cell dimensions, rather than the nominal panel
             size. Half a stroke belongs to each adjacent repeat at a seam. */
          const lineWidth = Math.max(.35, panel.gridWidth * exportScale);
          const gridX = Math.min(16, lineWidth * 16 / cellWidth);
          const gridY = Math.min(16, lineWidth * 16 / cellHeight);
          tileCtx.fillStyle = panel.gridColor;
          for (const boundary of [0, 16, 32]) {
            tileCtx.fillRect(boundary - gridX / 2, 0, gridX, 32);
            tileCtx.fillRect(0, boundary - gridY / 2, 32, gridY);
          }
        }
        const pattern = ctx.createPattern(tile, 'repeat');
        if (pattern) {
          ctx.save(); ctx.translate(box.x, box.y); ctx.scale(cellWidth / 16, cellHeight / 16);
          ctx.fillStyle = pattern; ctx.fillRect(0, 0, box.w * 16 / cellWidth, box.h * 16 / cellHeight);
          ctx.restore(); return;
        }
      }
    }
    if (cells > 65536)
      throw new RangeError('Panel grid exceeds the safe direct-render budget. Increase Panel width/height.');
    ctx.fillStyle = panel.color1; ctx.fillRect(box.x - 1, box.y - 1, box.w + 2, box.h + 2);
    ctx.fillStyle = panel.color2;
    for (let row = 0; row < rows; row++) for (let column = row & 1; column < columns; column += 2)
      ctx.fillRect(box.x + column * cellWidth, box.y + row * cellHeight, cellWidth + .5, cellHeight + .5);
    if (panel.gridWidth > 0) {
      ctx.strokeStyle = panel.gridColor; ctx.lineWidth = Math.max(.35, panel.gridWidth * exportScale);
      ctx.beginPath();
      for (let column = 0; column <= columns; column++) {
        const x = box.x + column * cellWidth; ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h);
      }
      for (let row = 0; row <= rows; row++) {
        const y = box.y + row * cellHeight; ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y);
      }
      ctx.stroke();
    }
  }

  function fillQuad(ctx, points, fillStyle) {
    if (!makePath(ctx, points)) return;
    ctx.fillStyle = fillStyle; ctx.fill();
  }

  function drawWarpedPanelRaster(ctx, points, panel, columns, rows, exportScale) {
    const cells = columns * rows;
    /* A repeating CanvasPattern cannot be projectively mapped by Canvas 2D.
       Keep transformed quads exact and fail fast before an authored 1 px grid
       can freeze the UI; axis-aligned maps retain the constant-work path. */
    if (cells > 65536)
      throw new RangeError('Transformed panel grid exceeds the safe render budget. Increase Panel width/height.');
    fillQuad(ctx, points, panel.color1);
    for (let row = 0; row < rows; row++) for (let column = row & 1; column < columns; column += 2) {
      const u0 = column / columns, u1 = (column + 1) / columns;
      const v0 = row / rows, v1 = (row + 1) / rows;
      fillQuad(ctx, [quadPoint(points, u0, v0), quadPoint(points, u1, v0),
        quadPoint(points, u1, v1), quadPoint(points, u0, v1)], panel.color2);
    }
    if (panel.gridWidth > 0) {
      ctx.strokeStyle = panel.gridColor; ctx.lineWidth = Math.max(.35, panel.gridWidth * exportScale);
      ctx.beginPath();
      for (let column = 0; column <= columns; column++) {
        const u = column / columns, start = quadPoint(points, u, 0), end = quadPoint(points, u, 1);
        ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
      }
      for (let row = 0; row <= rows; row++) {
        const v = row / rows, start = quadPoint(points, 0, v), end = quadPoint(points, 1, v);
        ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();
    }
  }

  function render(ctx, project, rawSettings, targetId, options) {
    const opts = options || {}, settings = normaliseSettings(rawSettings, project);
    const target = targetById(project, targetId || settings.targetId);
    const canvas = ctx.canvas || {}, width = Math.max(1, Number(opts.width) || canvas.width || target.width);
    const height = Math.max(1, Number(opts.height) || canvas.height || target.height);
    const layout = layoutTarget(target, width, height, opts);
    const projectStyle = settings.project, font = {family:projectStyle.fontFamily, size:projectStyle.fontSize};
    const exportScale = layout.scale;

    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.clearRect(0, 0, width, height);
      if (!projectStyle.transparent) {
        ctx.fillStyle = projectStyle.background;
        ctx.fillRect(layout.stage.x, layout.stage.y, layout.stage.w, layout.stage.h);
      }
      /* Preview padding and zoom are outside the target raster. Clip all map
         artwork to the target rectangle so the visible preview is the exact
         image that the zero-padding encoder will save. */
      ctx.save();
      try {
        ctx.beginPath(); ctx.rect(layout.stage.x, layout.stage.y, layout.stage.w, layout.stage.h); ctx.clip();

        layout.slices.forEach(slice => {
          if (!makePath(ctx, slice.points)) return;
          const style = mergedStyle(settings, slice.id), panel = style.panel, box = slice.box;
          const metrics = geometryMetrics(slice.geometry), warped = slice.points.length === 4 && !axisAlignedQuad(slice.points);
          /* Size X/Y is the authored panel resolution. A slice rarely divides by
             it perfectly, so use the nearest whole panel count and fit that grid
             to the slice instead of emitting a clipped sliver panel. */
          const columns = Math.max(1, Math.round(metrics.width / panel.sizeX));
          const rows = Math.max(1, Math.round(metrics.height / panel.sizeY));
          const cellWidth = metrics.width * exportScale / columns;
          const cellHeight = metrics.height * exportScale / rows;
          ctx.save();
          try {
            ctx.clip();
            if (warped) drawWarpedPanelRaster(ctx, slice.points, panel, columns, rows, exportScale);
            else drawPanelRaster(ctx, box, panel, columns, rows, box.w / columns, box.h / rows, exportScale);

            const coordinateSize = panel.coordinateSize * exportScale;
            if (panel.coordinates !== 'none' && coordinateSize >= 4 && cellWidth >= coordinateSize * 1.35 &&
                cellHeight >= coordinateSize * 1.2 && columns * rows <= 4096) {
              ctx.save();
              try {
                ctx.fillStyle = '#ffffff'; ctx.font = `${coordinateSize}px ${font.family}`;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.shadowColor = '#000000';
                ctx.shadowBlur = Math.max(1, 2 * exportScale);
                for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
                  const center = slice.points.length === 4
                    ? quadPoint(slice.points, (column + .5) / columns, (row + .5) / rows)
                    : {x:box.x + (column + .5) * box.w / columns,
                      y:box.y + (row + .5) * box.h / rows};
                  ctx.fillText(coordinateLabel(panel.coordinates, column, row, columns),
                    center.x, center.y, cellWidth * .9);
                }
              } finally { ctx.restore(); }
            }
            drawLogo(ctx, box, slice.points, metrics, style.logo, opts.logoImage, exportScale);
            drawDeco(ctx, box, slice.points, metrics, style.deco, exportScale);
            drawInfo(ctx, slice, box, slice.points, metrics, style, font, exportScale);
            if (projectStyle.border && projectStyle.borderWidth > 0) {
              makePath(ctx, slice.points); ctx.strokeStyle = projectStyle.borderColor;
              /* Canvas centres strokes on a path. Keep the requested border inside
                 its own slice so transparent gaps and adjacent panels stay clean. */
              ctx.lineWidth = Math.max(.5, projectStyle.borderWidth * exportScale) * 2; ctx.stroke();
            }
          } finally { ctx.restore(); }
        });

        if (opts.preview && opts.selectedIds && opts.selectedIds.size) {
          layout.slices.filter(slice => opts.selectedIds.has(slice.id)).forEach(slice => {
            makePath(ctx, slice.points); ctx.strokeStyle = opts.selectionColor || '#1495ff';
            ctx.lineWidth = 2; if (ctx.setLineDash) ctx.setLineDash([5, 3]); ctx.stroke();
            if (ctx.setLineDash) ctx.setLineDash([]);
          });
        }
        drawProjectInfo(ctx, target, settings, layout.stage, exportScale);
        if (projectStyle.border && projectStyle.borderWidth > 0) {
          const line = Math.max(.5, projectStyle.borderWidth * exportScale), inset = line / 2;
          ctx.strokeStyle = projectStyle.borderColor; ctx.lineWidth = line;
          ctx.strokeRect(layout.stage.x + inset, layout.stage.y + inset,
            Math.max(0, layout.stage.w - line), Math.max(0, layout.stage.h - line));
        }
      } finally { ctx.restore(); }
    } finally { ctx.restore(); }
    return layout;
  }

  function inspectTarget(target) {
    const warnings = [], names = new Map();
    /* Arena serializes float geometry with small errors (for example a
       1920 px edge at 1920.000244). Ignore only that subpixel storage noise. */
    const tolerance = Math.max(.001, Math.max(target.width, target.height) * 1e-7);
    target.slices.forEach(slice => {
      const geometry = slice.geometry, vertices = geometry.vertices || [];
      if (!slice.name.trim()) warnings.push({code:'missing-name', sliceId:slice.id, message:'A slice has no name.'});
      else names.set(slice.name, (names.get(slice.name) || 0) + 1);
      if (vertices.some(point => point.x < -tolerance || point.y < -tolerance ||
          point.x > target.width + tolerance || point.y > target.height + tolerance))
        warnings.push({code:'out-of-bounds', sliceId:slice.id, message:`${slice.name} extends outside ${target.name}.`});
      if (vertices.length !== 4) warnings.push({
        code:'bounded-polygon-raster', sliceId:slice.id,
        message:`${slice.name} is not a four-corner panel; its grid uses a clipped bounding raster.`
      });
    });
    [...names].filter(entry => entry[1] > 1).forEach(entry => warnings.push({
      code:'duplicate-name', message:`${entry[0]} is used by ${entry[1]} slices.`
    }));
    return {ok:!warnings.length, warnings, sliceCount:target.slices.length};
  }

  function manifest(project, rawSettings, suppliedPlans) {
    const safe = C.normaliseProject(project), settings = normaliseSettings(rawSettings, safe);
    const allTargets = targets(safe);
    const plans = Array.isArray(suppliedPlans) ? suppliedPlans : allTargets.map(target =>
      exportPlan(target, settings.scale));
    const plansById = new Map(plans.map(plan => [plan.targetId, plan]));
    const sanitizedSettings = JSON.parse(JSON.stringify(settings));
    sanitizedSettings.logo = Object.assign({}, sanitizedSettings.logo, {
      dataUrl:undefined,
      embedded:!!settings.logo.dataUrl
    });
    return {
      schema:'showave.chaser.pixelmap-export/1',
      createdAt:new Date().toISOString(),
      project:{id:safe.id, name:safe.name, source:safe.map.source, updatedAt:safe.updatedAt},
      composition:Object.assign({}, safe.map.composition),
      settings:sanitizedSettings,
      targets:allTargets.map(target => {
        const plan = plansById.get(target.id) || exportPlan(target, settings.scale);
        return {
          id:target.id,
          kind:target.kind,
          name:target.name,
          filename:target.filename,
          width:target.width,
          height:target.height,
          export:{
            requestedScale:plan.requestedScale,
            requestedWidth:Math.max(1, Math.round(target.width * plan.requestedScale)),
            requestedHeight:Math.max(1, Math.round(target.height * plan.requestedScale)),
            width:plan.width,
            height:plan.height,
            renderScale:plan.renderScale,
            limited:!!plan.limited
          },
          screenId:target.screenId,
          preflight:inspectTarget(target),
          slices:target.slices.map(slice => {
            const metrics = geometryMetrics(slice.geometry);
            return {
              id:slice.id,
              name:slice.name,
              screenId:slice.screenId,
              x:slice.geometry.x,
              y:slice.geometry.y,
              width:slice.geometry.w,
              height:slice.geometry.h,
              panelWidth:metrics.width,
              panelHeight:metrics.height,
              geometryType:metrics.kind,
              vertices:slice.geometry.vertices.map(point => ({x:point.x, y:point.y}))
            };
          })
        };
      })
    };
  }

  function utf8(value) {
    if (typeof global.TextEncoder === 'function') return new global.TextEncoder().encode(String(value));
    const encoded = unescape(encodeURIComponent(String(value))), out = new Uint8Array(encoded.length);
    for (let index = 0; index < encoded.length; index++) out[index] = encoded.charCodeAt(index);
    return out;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
    return (crc ^ 0xffffffff) >>> 0;
  }

  function write16(view, offset, value) { view.setUint16(offset, value, true); }
  function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  async function fileBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') return utf8(value);
    if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
    return utf8(String(value == null ? '' : value));
  }

  async function zipBytes(files) {
    const entries = [], usedNames = new Set();
    for (const file of files || []) {
      if (entries.length >= 65535)
        throw new RangeError('The export package has too many files for the supported ZIP format.');
      /* Each component is safe to extract on Windows. Disambiguate after
         sanitizing, since different original names can collapse to one path. */
      const original = String(file && file.name || 'file').split('/').map(part => safeName(part, 'file')).join('/');
      const lastSlash = original.lastIndexOf('/'), lastDot = original.lastIndexOf('.');
      const extension = lastDot > lastSlash + 1 ? original.slice(lastDot) : '';
      const stem = extension ? original.slice(0, -extension.length) : original;
      let displayName = original, suffix = 2;
      while (usedNames.has(displayName.toLowerCase())) displayName = `${stem}-${suffix++}${extension}`;
      usedNames.add(displayName.toLowerCase());
      const name = utf8(displayName);
      if (name.length > 65535)
        throw new RangeError('An export package filename is too long for the supported ZIP format.');
      const data = await fileBytes(file.data), crc = crc32(data);
      if (data.length > 0xffffffff)
        throw new RangeError('An export package file exceeds the supported ZIP size.');
      entries.push({name, data, crc});
    }
    const localParts = [], centralParts = [];
    let offset = 0;
    for (const entry of entries) {
      const cleanName = entry.name;
      const local = new Uint8Array(30 + cleanName.length), localView = new DataView(local.buffer);
      write32(localView, 0, 0x04034b50); write16(localView, 4, 20); write16(localView, 6, 0x0800);
      write16(localView, 8, 0); write16(localView, 10, 0); write16(localView, 12, 0x21);
      write32(localView, 14, entry.crc); write32(localView, 18, entry.data.length); write32(localView, 22, entry.data.length);
      write16(localView, 26, cleanName.length); write16(localView, 28, 0); local.set(cleanName, 30);
      localParts.push(local, entry.data);

      const central = new Uint8Array(46 + cleanName.length), centralView = new DataView(central.buffer);
      write32(centralView, 0, 0x02014b50); write16(centralView, 4, 20); write16(centralView, 6, 20);
      write16(centralView, 8, 0x0800); write16(centralView, 10, 0); write16(centralView, 12, 0); write16(centralView, 14, 0x21);
      write32(centralView, 16, entry.crc); write32(centralView, 20, entry.data.length); write32(centralView, 24, entry.data.length);
      write16(centralView, 28, cleanName.length); write16(centralView, 30, 0); write16(centralView, 32, 0);
      write16(centralView, 34, 0); write16(centralView, 36, 0); write32(centralView, 38, 0); write32(centralView, 42, offset);
      central.set(cleanName, 46); centralParts.push(central);
      offset += local.length + entry.data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    if (offset > 0xffffffff || centralSize > 0xffffffff || offset + centralSize + 22 > 0xffffffff)
      throw new RangeError('The export package exceeds the supported ZIP size.');
    const end = new Uint8Array(22), endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50); write16(endView, 4, 0); write16(endView, 6, 0);
    write16(endView, 8, entries.length); write16(endView, 10, entries.length);
    write32(endView, 12, centralSize); write32(endView, 16, offset); write16(endView, 20, 0);
    const total = offset + centralSize + end.length, output = new Uint8Array(total);
    let cursor = 0;
    [...localParts, ...centralParts, end].forEach(part => { output.set(part, cursor); cursor += part.length; });
    return output;
  }

  async function zipBlob(files) {
    const bytes = await zipBytes(files);
    return new Blob([bytes], {type:'application/zip'});
  }

  global.OpenLiveChaserExport = Object.freeze({
    schema:SCHEMA,
    maxEdge:MAX_EDGE,
    maxPixels:MAX_PIXELS,
    fontChoices:FONT_CHOICES,
    placements:PLACEMENTS,
    coordinateModes:COORDINATES,
    units:UNITS,
    defaults,
    normaliseSettings,
    safeName,
    targets,
    targetById,
    exportPlan,
    layoutTarget,
    geometryMetrics,
    mergedStyle,
    render,
    inspectTarget,
    manifest,
    zipBytes,
    zipBlob,
    aspect
  });
})(typeof window !== 'undefined' ? window : globalThis);
