/* Full supplied artwork is rendered from the original, optimized SVG geometry.
 * Only catalogue-owned vector paints and identified backdrop images can change.
 * PNG remains a fallback for legacy catalogue entries without an SVG resource.
 * No SVG, image bytes or object URLs enter persisted Studio state. */
window.OpenLiveFullTemplates = (() => {
  'use strict';
  const catalog = window.OpenLiveFullTemplateCatalog || [];
  const scriptUrl = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  const assetUrl = path => scriptUrl ? new URL(path,scriptUrl).href : path;
  const byId = new Map(catalog.map(item => [item.id, item])), cache = new Map(), sources = new Map();
  const MAX_VARIANTS = 12, MAX_SOURCE = 8 * 1024 * 1024, TIMEOUT = 15000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The supplied artwork uses hash IDs that can start with a digit. SVG image
  // fragment references support those IDs; a CSS identifier rule rejects them.
  const LOCAL_FRAGMENT = /^#[A-Za-z0-9_][\w.:-]*$/;
  const LOCAL_PAINT = /^url\(\s*#[A-Za-z0-9_][\w.:-]*\s*\)$/;
  const get = id => byId.get(id) || null;
  const list = () => catalog.slice();
  const plainSettings = value => value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype,null].includes(Object.getPrototypeOf(value));
  const PART_ONLY = new Set(['scaleX','scaleY','rotation','flipX','flipY','fontFamily','fontWeight','fontStyle','textAlign','feedFit','imageId','imageFit']);
  const TEXT_FONTS = Object.freeze([...new Set(['Arial','Verdana','Georgia','Times New Roman','Courier New','League Spartan',
    ...(window.OpenLiveFontAssets?.catalog?.() || []).map(font=>font.name)])]);
  const TEXT_OPTIONS = Object.freeze({fontFamily:TEXT_FONTS,
    fontWeight:['700','400'],fontStyle:['normal','italic'],textAlign:['left','center','right']});
  function replacementFonts(template, style) {
    const families = new Map();
    for (const component of template.components || []) {
      if (!component.editableText) continue;
      const change = style.components && style.components[component.id];
      if (!change || !Object.keys(change).some(name => ['text','textColor','fontSize','fontFamily','fontWeight','fontStyle','textAlign'].includes(name))) continue;
      const family = change.fontFamily || component.defaultFontFamily || 'Arial';
      const weight=change.fontWeight||'700',fontStyle=change.fontStyle||'normal',text=change.text??component.defaultText??'';
      const key=JSON.stringify([family,weight,fontStyle]);
      const existing=families.get(key);
      families.set(key,{family,weight,fontStyle,text:existing?existing.text+'\n'+text:text});
    }
    return families;
  }
  function ensureReplacementFonts(template, style) {
    const families = replacementFonts(template, style);
    if (!families.size) return null;
    const loader = typeof window !== 'undefined' && window.OpenLiveFontAssets && window.OpenLiveFontAssets.ensure;
    const fonts = typeof document !== 'undefined' && document.fonts;
    if (typeof loader !== 'function' && (!fonts || typeof fonts.load !== 'function')) return null;
    return Promise.all([...families.values()].map(({family,weight,fontStyle,text}) => {
      if (typeof loader === 'function') return loader(family, weight, {style:fontStyle,text});
      if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
      return fonts.load(fontStyle+' '+String(weight) + ' 20px "' + family.replace(/"/g, '') + '"', text);
    })).then(()=>{textLayouts.clear();});
  }
  function normalizeComponents(template, raw, independent = false) {
    if (!plainSettings(raw)) throw new Error('Template components must be a plain settings object.');
    const available = new Map((template.components || []).map(component => [component.id,component]));
    const result = {};
    for (const id of Object.keys(raw).sort()) {
      const component = available.get(id), settings = raw[id], changed = {};
      if (!component) throw new Error('That component is not available in this template: ' + id + '.');
      if (!plainSettings(settings)) throw new Error('Each template component needs a plain settings object.');
      for (const name of Object.keys(settings).sort()) {
        const value = settings[name];
        if (!independent && PART_ONLY.has(name)) throw new Error('This control requires an independent SVG layer: ' + name + '.');
        if (name === 'visible') {
          if (typeof value !== 'boolean') throw new Error('Component visibility must be true or false.');
          if (!value) changed.visible = false;
        } else if (['x','y','scale','scaleX','scaleY','rotation','opacity'].includes(name)) {
          const [min,max,original] = ['scale','scaleX','scaleY'].includes(name) ? [.1,4,1] : name === 'opacity' ? [0,1,1] : name === 'rotation' ? [-180,180,0] : [-2,2,0];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
            throw new Error('Component ' + name + ' must be between ' + min + ' and ' + max + '.');
          const number = Math.round(value * 1e6) / 1e6;
          if (number !== original) changed[name] = number;
        } else if (name === 'flipX' || name === 'flipY') {
          if (typeof value !== 'boolean') throw new Error('Component flip must be true or false.');
          if (value) changed[name] = true;
        } else if (Object.hasOwn(TEXT_OPTIONS,name) && component.editableText === true) {
          const values = TEXT_OPTIONS[name];
          if (typeof value !== 'string' || !values.includes(value)) throw new Error('Choose a supported replacement text ' + name + '.');
          if (value !== values[0]) changed[name] = value;
        } else if (name === 'feedFit' && Number.isInteger(component.frameIndex)) {
          if (!['contain','cover','stretch'].includes(value)) throw new Error('Feed fit must be contain, cover or stretch.');
          if (value !== 'contain') changed.feedFit = value;
        } else if ((name === 'imageId' || name === 'imageFit') && !component.virtual &&
            !Number.isInteger(component.frameIndex) && !component.editableText && !component.editableQr) {
          if (name === 'imageId') {
            if (typeof value !== 'string' || !/^svgimg-[a-f0-9]{64}$/.test(value)) throw new Error('Choose a locally imported SVG-part image.');
            changed.imageId = value;
          } else {
            if (!['contain','cover','stretch'].includes(value)) throw new Error('Image fit must be contain, cover or stretch.');
            if (value !== 'contain') changed.imageFit = value;
          }
        } else if (['text','textColor','fontSize'].includes(name) && component.editableText === true) {
          if (name === 'text') {
            if (typeof value !== 'string' || value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
              throw new Error('Replacement text must contain at most 500 printable characters.');
            changed.text = value.replace(/\r\n?/g,'\n');
          } else if (name === 'textColor') {
            if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Text colour must use a six-digit hexadecimal value.');
            changed.textColor = value.toLowerCase();
          } else {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 4 || value > 120)
              throw new Error('Replacement font size must be between 4 and 120.');
            changed.fontSize = Math.round(value * 100) / 100;
          }
        } else if(name==='overflow'&&component.editableText===true){
          if(!['scroll','clip'].includes(value))throw Error('Choose Scroll or Clip for text overflow.');changed.overflow=value;
        } else if(name==='overflowSpeed'&&component.editableText===true){
          if(typeof value!=='number'||!Number.isFinite(value)||value<1||value>600)throw Error('Text scroll speed must be between 1 and 600 HD pixels per second.');
          changed.overflowSpeed=Math.round(value*100)/100;
        } else if (name === 'target' && component.editableQr === true) {
          if (typeof value !== 'string' || !value.trim() || value.trim().length > 1024 || /[\u0000-\u0020\u007f]/.test(value.trim()))
            throw new Error('Use a QR destination under 1,024 characters with no whitespace.');
          let url;
          try { url = new URL(value.trim()); } catch (_) { throw new Error('Enter a complete HTTP or HTTPS QR destination.'); }
          if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href.length > 1024)
            throw new Error('QR destinations must use HTTP or HTTPS without embedded credentials.');
          changed.target = url.href;
        } else throw new Error('That control is not available for this component: ' + name + '.');
      }
      if (Object.hasOwn(settings,'imageFit') && changed.imageId === undefined)
        throw new Error('Choose a replacement image before setting its fit.');
      if (['fontSize','textColor','overflow','overflowSpeed',...Object.keys(TEXT_OPTIONS)].some(name => changed[name] !== undefined) && changed.text === undefined) {
        if (typeof component.defaultText !== 'string') throw new Error('Enter replacement text before changing its font or colour.');
        changed.text = component.defaultText;
      }
      if (Object.keys(changed).length) result[id] = Object.freeze(Object.fromEntries(Object.keys(changed).sort().map(name => [name,changed[name]])));
    }
    return Object.freeze(result);
  }
  function normalizeStyle(id, raw = {}, independent = false) {
    const template = get(id);
    if (!template) throw new Error('That full SVG template is unavailable.');
    if (!plainSettings(raw))
      throw new Error('Template colours must be a plain settings object.');
    const palette = new Map((template.palette || []).map(entry => [entry.key, entry]));
    const normalized = {};
    for (const name of Object.keys(raw).sort()) {
      const value = raw[name];
      if (name === 'components') {
        const components = normalizeComponents(template,value,independent);
        if (Object.keys(components).length) normalized.components = components;
      } else if (name === 'backgroundHue' && (template.backgroundImageIds || []).length) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < -180 || value > 180)
          throw new Error('Background hue must be a number between -180 and 180 degrees.');
        const hue = Math.round(value * 100) / 100;
        if (hue !== 0) normalized[name] = hue;
      } else {
        const entry = palette.get(name);
        if (!entry) throw new Error('That colour control is not available for this template: ' + name + '.');
        if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value))
          throw new Error('Template colours must use six-digit hexadecimal values.');
        const colour = value.toLowerCase();
        if (colour !== String(entry.defaultColor).toLowerCase()) normalized[name] = colour;
      }
    }
    if (Object.keys(normalized).length && !template.svgArtwork)
      throw new Error('This legacy artwork does not have an editable SVG source.');
    if (normalized.components && !template.componentArtwork)
      throw new Error('The separated native component artwork is unavailable for this template.');
    return Object.freeze(normalized);
  }
  function key(id, style) { return id + '|' + JSON.stringify(normalizeStyle(id, style)); }
  function status(id, style) {
    if (!get(id)) return {state:'failed',error:'That full SVG template is unavailable.'};
    let token;
    try { token = key(id, style); } catch (error) { return {state:'failed',error:error.message}; }
    const record = cache.get(token);
    return record ? {state:record.state,error:record.error || ''} : {state:'idle',error:''};
  }
  function touch(token, record) { cache.delete(token); cache.set(token, record); }
  function makeRoom() {
    while (cache.size >= MAX_VARIANTS) {
      const candidate = [...cache].find(([, record]) => record.state !== 'loading') || cache.entries().next().value;
      const [token, record] = candidate;
      if (record.state === 'loading') record.cancel(new Error('A newer template preview replaced this pending artwork load. Retry to load it again.'));
      record.image = null; record.layers = null; cache.delete(token);
    }
  }
  function safeSource(text) {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('SVG document declarations are not allowed.');
    if (/<\?(?!xml\s)[\s\S]*?\?>/i.test(text)) throw new Error('SVG processing instructions are not allowed.');
    const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = xml.documentElement;
    if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS || xml.getElementsByTagName('parsererror').length)
      throw new Error('The template SVG could not be parsed.');
    const tags = new Set(['svg','defs','g','path','rect','circle','ellipse','polygon','polyline','line',
      'clipPath','mask','filter','feColorMatrix','image','use','linearGradient','radialGradient','stop']);
    const attrs = new Set(['id','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','viewBox',
      'preserveAspectRatio','version','zoomAndPan','fill','fill-opacity','fill-rule','stroke','stroke-opacity',
      'stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','stroke-dasharray','stroke-dashoffset',
      'opacity','d','points','transform','clip-path','clip-rule','clipPathUnits','mask','filter',
      'color-interpolation-filters','gradientUnits','gradientTransform','spreadMethod','offset','stop-color',
      'stop-opacity','values','type','result','in','in2','filterUnits','primitiveUnits','maskUnits','maskContentUnits','href']);
    for (const node of [root, ...root.getElementsByTagName('*')]) {
      if (node.namespaceURI !== SVG_NS || !tags.has(node.localName)) throw new Error('Unsupported active or external SVG content.');
      for (const attr of [...node.attributes]) {
        if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') {
          if (![SVG_NS,'http://www.w3.org/1999/xlink'].includes(attr.value)) throw new Error('Unsupported SVG namespace.');
          continue;
        }
        if (!attrs.has(attr.localName) || (attr.namespaceURI && attr.namespaceURI !== 'http://www.w3.org/1999/xlink'))
          throw new Error('Unsupported SVG attribute: ' + attr.name + '.');
        if (attr.localName === 'href') {
          const value = attr.value;
          if (LOCAL_FRAGMENT.test(value)) continue;
          if (node.localName === 'image' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(value)) continue;
          throw new Error('Template images and references must stay embedded or local to the SVG.');
        }
        if (/url\s*\(/i.test(attr.value) && !LOCAL_PAINT.test(attr.value))
          throw new Error('External SVG paint references are not allowed.');
      }
    }
    return xml;
  }
  async function sourceText(response, controller) {
    if (!response.ok) throw new Error('Could not read the local SVG artwork (' + response.status + ').');
    if (Number(response.headers && response.headers.get('content-length')) > MAX_SOURCE)
      throw new Error('The editable SVG is larger than 8 MiB.');
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) {
          const result = await reader.read(); if (result.done) break;
          length += result.value.byteLength;
          if (length > MAX_SOURCE) { controller.abort(); throw new Error('The editable SVG is larger than 8 MiB.'); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
      return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SOURCE) throw new Error('The editable SVG is larger than 8 MiB.');
    return text;
  }
  function acquireSource(template, consumer, resource = template.svgArtwork) {
    const sourceKey = assetUrl(resource);
    let source = sources.get(sourceKey);
    if (!source) {
      const controller = new AbortController();
      source = {controller, users:new Set(), ready:false, promise:null};
      sources.set(sourceKey, source);
      source.promise = (async () => {
        try {
          const response = await fetch(sourceKey, {signal:controller.signal, credentials:'same-origin'});
          const xml = safeSource(await sourceText(response, controller));
          source.ready = true; return xml;
        } catch (error) {
          controller.abort(); if (sources.get(sourceKey) === source) sources.delete(sourceKey);
          throw error;
        }
      })();
      source.promise.catch(() => {});
    }
    source.users.add(consumer);
    return {promise:source.promise, release() {
      source.users.delete(consumer);
      if (!source.ready && source.users.size === 0) {
        source.controller.abort(); if (sources.get(sourceKey) === source) sources.delete(sourceKey);
      }
    }};
  }
  function sourceBounds(template, bounds) {
    if (!bounds || !['x','y','w','h'].every(name => Number.isFinite(bounds[name])) || bounds.w <= 0 || bounds.h <= 0)
      throw new Error('The native component has no valid placement bounds.');
    const map = template.sourceToHd || {scaleX:1,scaleY:1,translateX:0,translateY:0};
    return {x:(bounds.x*template.width-map.translateX)/map.scaleX,y:(bounds.y*template.height-map.translateY)/map.scaleY,
      w:bounds.w*template.width/map.scaleX,h:bounds.h*template.height/map.scaleY};
  }
  function componentTransform(template, component, change) {
    const bounds = sourceBounds(template,component.bounds), scale = change.scale === undefined ? 1 : change.scale;
    bounds.x -= component.sourceParentOffset && component.sourceParentOffset.x || 0;
    bounds.y -= component.sourceParentOffset && component.sourceParentOffset.y || 0;
    const map = template.sourceToHd || {scaleX:1,scaleY:1};
    const x = (change.x || 0)*template.width/map.scaleX + (bounds.x+bounds.w/2)*(1-scale);
    const y = (change.y || 0)*template.height/map.scaleY + (bounds.y+bounds.h/2)*(1-scale);
    return 'matrix(' + [scale,0,0,scale,x,y].join(' ') + ')';
  }
  function replacementQr(target) {
    let matrix;
    if (window.OpenLiveCommerce && typeof window.OpenLiveCommerce.qrMatrix === 'function') matrix = window.OpenLiveCommerce.qrMatrix(target);
    else {
      const factory = window.qrcode;
      if (typeof factory !== 'function') throw new Error('The local QR encoder is unavailable.');
      if (factory.stringToBytesFuncs && factory.stringToBytesFuncs['UTF-8']) factory.stringToBytes = factory.stringToBytesFuncs['UTF-8'];
      const qr = factory(0,'M'); qr.addData(target,'Byte'); qr.make();
      const size = qr.getModuleCount(), cells = new Uint8Array(size*size);
      for (let y=0;y<size;y++) for (let x=0;x<size;x++) cells[y*size+x] = qr.isDark(y,x) ? 1 : 0;
      matrix = {size,cells};
    }
    if (!matrix || !Number.isInteger(matrix.size) || matrix.size < 21 || matrix.size > 177 ||
        !matrix.cells || matrix.cells.length !== matrix.size*matrix.size || [...matrix.cells].some(cell => cell !== 0 && cell !== 1))
      throw new Error('The QR encoder returned an invalid module matrix.');
    return matrix;
  }
  let textMeasure = null;
  const textLayouts=new Map(),TEXT_LAYOUT_LIMIT=128;
  function measureNativeText(lines,size,change) {
    if (!textMeasure && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      try { textMeasure = document.createElement('canvas').getContext('2d'); } catch (_) {}
    }
    if (textMeasure) textMeasure.font = (change.fontStyle || 'normal') + ' ' + (change.fontWeight || '700') + ' ' + size + 'px "' + (change.fontFamily || 'Arial') + '"';
    const metrics=lines.map(line=>textMeasure?.measureText?.(line)||{width:[...line].length*size});
    return {width:Math.max(0,...metrics.map(item=>item.width)),
      ascent:Math.max(...metrics.map(item=>Number.isFinite(item.actualBoundingBoxAscent)&&item.actualBoundingBoxAscent>0?item.actualBoundingBoxAscent:size*.8)),
      descent:Math.max(...metrics.map(item=>Number.isFinite(item.actualBoundingBoxDescent)&&item.actualBoundingBoxDescent>=0?item.actualBoundingBoxDescent:size*.2))};
  }
  function replacementTextLayout(component,change,bounds) {
    const fontFamily=change.fontFamily||component.defaultFontFamily||'Arial';
    const token=JSON.stringify([component.id,component.defaultFontSize,fontFamily,change,bounds]);
    if(textLayouts.has(token)){const stored=textLayouts.get(token);textLayouts.delete(token);textLayouts.set(token,stored);return stored;}
    const overflow=change.overflow||'scroll',rows=change.text.split('\n').map(line=>line.replace(/\t/g,' ')),
      lines=overflow==='scroll'?[rows.join(' · ')]:rows,size=change.fontSize||component.defaultFontSize||32,
      metrics=measureNativeText(lines,size,{...change,fontFamily}),lineHeight=size*1.2,
      height=metrics.ascent+metrics.descent+(lines.length-1)*lineHeight,overflows=metrics.width>bounds.w,
      align=overflow==='scroll'&&overflows?'left':change.textAlign||'left';
    const layout={lines,size,fontFamily,align,x:bounds.x+(align==='center'?bounds.w/2:align==='right'?bounds.w:0),
      baseline:bounds.y+(bounds.h-height)/2+metrics.ascent,lineHeight,...metrics,overflow,overflows,
      wordCount:change.text.trim()?change.text.trim().split(/\s+/).length:0};
    textLayouts.set(token,layout);while(textLayouts.size>TEXT_LAYOUT_LIMIT)textLayouts.delete(textLayouts.keys().next().value);return layout;
  }
  function applyComponents(template,xml,style,contentsOnly = false) {
    if (!style.components) return;
    const svg = xml.documentElement, elements = [svg,...svg.getElementsByTagName('*')];
    const byId = new Map(elements.map(node => [node.getAttribute('id'),node]));
    for (const component of template.components || []) {
      const change = style.components[component.id]; if (!change) continue;
      const targets = (component.nodeIds || []).map(id => {
        const node = byId.get(id);
        if (!node || !node.parentNode) throw new Error('The original component wrapper could not be found: ' + component.label + '.');
        return node;
      });
      if (!targets.length && !Number.isInteger(component.frameIndex)) throw new Error('The original component has no drawable elements.');
      const replacingText = change.text !== undefined, replacingQr = change.target !== undefined;
      const transform = componentTransform(template,component,change);
      targets.forEach(node => {
        if ((!contentsOnly && change.visible === false) || replacingText || replacingQr) node.setAttribute('display','none');
        else if (!contentsOnly) {
          if (change.opacity !== undefined) node.setAttribute('opacity',String(change.opacity));
          if (change.x || change.y || change.scale !== undefined)
            node.setAttribute('transform',transform + (node.getAttribute('transform') ? ' ' + node.getAttribute('transform') : ''));
        }
      });
      if ((!replacingText && !replacingQr) || (!contentsOnly && change.visible === false)) continue;
      if (!targets.length) throw new Error('The replaceable component has no native artwork position.');
      const group = xml.createElementNS(SVG_NS,'g');
      group.setAttribute('id','sw-replacement-' + component.id);
      if (!contentsOnly) {
        group.setAttribute('transform',transform);
        if (change.opacity !== undefined) group.setAttribute('opacity',String(change.opacity));
      }
      if (targets.some(node => node.parentNode !== targets[0].parentNode)) throw new Error('The replacement component spans incompatible coordinate spaces.');
      targets[0].parentNode.insertBefore(group,targets[0]);
      const bounds = sourceBounds(template,component.bounds);
      bounds.x -= component.sourceParentOffset && component.sourceParentOffset.x || 0;
      bounds.y -= component.sourceParentOffset && component.sourceParentOffset.y || 0;
      if (replacingText) {
        if (!change.text) continue;
        // Replacement text stays inside its original component box. Original
        // glyph paths are never rebuilt until the operator supplies a replacement.
        const {lines,size,fontFamily,align,x:textX,baseline}=replacementTextLayout(component,change,bounds);
        const text = xml.createElementNS(SVG_NS,'text');
        // Match canvas text: preserve intentional spaces in replacement wording.
        text.setAttribute('xml:space','preserve');
        text.setAttribute('font-family',fontFamily === 'Arial' ? 'Arial, Helvetica, sans-serif' : fontFamily);
        text.setAttribute('font-size',String(size));
        text.setAttribute('fill',change.textColor || component.defaultTextColor || '#ffffff');
        text.setAttribute('font-weight',change.fontWeight || '700');
        if (change.fontStyle) text.setAttribute('font-style',change.fontStyle);
        const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
        if (align !== 'left') text.setAttribute('text-anchor',anchor);
        text.setAttribute('x',String(textX));
        lines.forEach((line,index) => {
          const span = xml.createElementNS(SVG_NS,'tspan'); span.setAttribute('x',String(textX));
          span.setAttribute('y',String(baseline+index*size*1.2)); span.textContent = line; text.appendChild(span);
        });
        group.appendChild(text);
      } else {
        const matrix = replacementQr(change.target), quiet = 4, side = matrix.size+quiet*2;
        const size = Math.min(bounds.w,bounds.h), scale = size/side;
        const qr = xml.createElementNS(SVG_NS,'g');
        qr.setAttribute('transform','translate(' + (bounds.x+(bounds.w-size)/2) + ' ' + (bounds.y+(bounds.h-size)/2) + ') scale(' + scale + ')');
        const paper = xml.createElementNS(SVG_NS,'rect'); paper.setAttribute('width',String(side)); paper.setAttribute('height',String(side)); paper.setAttribute('fill','#ffffff');
        qr.appendChild(paper);
        let path = '';
        for (let y=0;y<matrix.size;y++) for (let x=0;x<matrix.size;x++)
          if (matrix.cells[y*matrix.size+x]) path += 'M' + (x+quiet) + ' ' + (y+quiet) + 'h1v1h-1z';
        const ink = xml.createElementNS(SVG_NS,'path'); ink.setAttribute('d',path); ink.setAttribute('fill','#000000');
        qr.appendChild(ink); group.appendChild(qr);
      }
    }
  }
  function styleSource(template, document, style, contentsOnly = false) {
    const xml = document.cloneNode(true), svg = xml.documentElement;
    const nodes = [svg, ...svg.getElementsByTagName('*')];
    const find = id => nodes.find(node => node.getAttribute('id') === id);
    const ignoredPaint = node => {
      for (let parent = node; parent && parent !== svg; parent = parent.parentNode)
        if (parent.localName === 'mask' || parent.localName === 'clipPath') return true;
      return false;
    };
    const substitutions = new Map();
    (template.palette || []).forEach(entry => {
      if (style[entry.key] && !entry.gradientPosition)
        (entry.paints || []).forEach(paint => substitutions.set(paint.toLowerCase(), style[entry.key]));
    });
    nodes.forEach(node => {
      if (ignoredPaint(node)) return;
      for (const attr of ['fill','stroke','stop-color']) {
        const replacement = substitutions.get(String(node.getAttribute(attr) || '').toLowerCase());
        if (replacement) node.setAttribute(attr, replacement);
      }
    });
    const entries = (template.palette || []).filter(entry => entry.gradientPosition);
    if (entries.some(entry => style[entry.key])) {
      const start = entries.find(entry => entry.gradientPosition === 'start');
      const end = entries.find(entry => entry.gradientPosition === 'end');
      if (!start || !end) throw new Error('The template gradient controls are incomplete.');
      const rgb = colour => [1,3,5].map(index => parseInt(colour.slice(index,index+2),16));
      const a = rgb(style[start.key] || start.defaultColor), b = rgb(style[end.key] || end.defaultColor);
      const ids = new Set([...(template.frameGradientIds || []), ...(start.gradientIds || []), ...(end.gradientIds || [])]);
      ids.forEach(id => {
        const gradient = find(id);
        if (!gradient || !['linearGradient','radialGradient'].includes(gradient.localName))
          throw new Error('The original template gradient could not be found.');
        [...gradient.getElementsByTagName('stop')].forEach(stop => {
          const raw = stop.getAttribute('offset') || '0';
          const position = Number(raw.replace('%','')) / (raw.includes('%') ? 100 : 1);
          if (!Number.isFinite(position) || position < 0 || position > 1) throw new Error('Invalid SVG gradient offset.');
          const colour = '#' + a.map((channel,index) => Math.round(channel + (b[index]-channel)*position).toString(16).padStart(2,'0')).join('');
          stop.setAttribute('stop-color', colour);
        });
      });
    }
    if (style.backgroundHue) {
      let defs = nodes.find(node => node.localName === 'defs');
      if (!defs) { defs = xml.createElementNS(SVG_NS, 'defs'); svg.insertBefore(defs,svg.firstChild); }
      let id = 'showave-background-hue-' + template.id;
      while (find(id)) id += '-variant';
      const filter = xml.createElementNS(SVG_NS,'filter');
      filter.setAttribute('id',id); filter.setAttribute('x','0%'); filter.setAttribute('y','0%');
      filter.setAttribute('width','100%'); filter.setAttribute('height','100%');
      filter.setAttribute('color-interpolation-filters','sRGB');
      const rotate = xml.createElementNS(SVG_NS,'feColorMatrix');
      rotate.setAttribute('type','hueRotate'); rotate.setAttribute('values',String(style.backgroundHue));
      filter.appendChild(rotate); defs.appendChild(filter);
      (template.backgroundImageIds || []).forEach(imageId => {
        const image = find(imageId);
        if (!image || !['image','use'].includes(image.localName) || image.getAttribute('filter'))
          throw new Error('The isolated template backdrop could not be safely recoloured.');
        image.setAttribute('filter','url(#' + id + ')');
      });
    }
    applyComponents(template,xml,style,contentsOnly);
    return contentsOnly ? xml : new XMLSerializer().serializeToString(xml);
  }
  function pruneDefinitions(xml) {
    const svg = xml.documentElement, nodes = [svg,...svg.getElementsByTagName('*')];
    const ids = new Map(nodes.filter(node => node.getAttribute('id')).map(node => [node.getAttribute('id'),node]));
    const required = new Set(), visited = new Set(), pending = [];
    const references = node => {
      for (const attr of [...node.attributes]) {
        if (attr.localName === 'href' && LOCAL_FRAGMENT.test(attr.value)) pending.push(attr.value.slice(1));
        for (const match of attr.value.matchAll(/url\(\s*#([A-Za-z0-9_][\w.:-]*)\s*\)/g)) pending.push(match[1]);
      }
    };
    const visible = node => {
      if (node.localName === 'defs') return;
      references(node);
      for (const child of [...node.childNodes]) if (child.localName) visible(child);
    };
    visible(svg);
    while (pending.length) {
      const id = pending.pop(); if (visited.has(id)) continue; visited.add(id);
      const node = ids.get(id);
      if (!node) throw new Error('The native component has an unresolved local SVG reference: ' + id + '.');
      required.add(node);
      // href inheritance, nested <use>, clip/mask/filter paints and embedded
      // image definitions can refer to one another, including harmless cycles.
      for (const child of [node,...node.getElementsByTagName('*')]) references(child);
    }
    const retain = node => {
      if (required.has(node)) return true;
      let kept = false;
      for (const child of [...node.childNodes]) {
        if (!child.localName) continue;
        if (retain(child)) kept = true; else node.removeChild(child);
      }
      return kept;
    };
    for (const defs of nodes.filter(node => node.localName === 'defs')) {
      if (defs.parentNode && !retain(defs)) defs.parentNode.removeChild(defs);
    }
  }
  function componentLayers(template,xml,style) {
    const layers = [], batches = [];
    for (const component of [...template.components].sort((a,b) => a.order-b.order)) {
      const change = style.components[component.id] || {};
      if (change.visible === false || change.opacity === 0) continue;
      if(directText(component,style)){batches.push({liveText:true,members:[component]});continue;}
      // A shared source clip is a compositing boundary, not seven independent
      // masks. Keep adjacent, unposed members together so its fractional alpha
      // is applied once. Individually transformed/faded pieces intentionally
      // become independent clipped sprites; their clip travels with the piece.
      const shared = component.sharedAncestorClipId && !Number.isInteger(component.frameIndex) &&
        change.x === undefined && change.y === undefined && change.scale === undefined && change.opacity === undefined;
      const previous = batches[batches.length-1];
      if (shared && previous && previous.clip === component.sharedAncestorClipId) previous.members.push(component);
      else batches.push({clip:shared ? component.sharedAncestorClipId : null,members:[component]});
    }
    for (const batch of batches) {
      const members = batch.members, component = members.length === 1 ? members[0] : {
        id:'sw-shared-clip-' + batch.clip + '-' + members[0].id,label:members.map(item => item.label).join(', '),
        bounds:members.reduce((bounds,item) => {
          const x = Math.min(bounds.x,item.bounds.x), y = Math.min(bounds.y,item.bounds.y);
          return {x,y,w:Math.max(bounds.x+bounds.w,item.bounds.x+item.bounds.w)-x,
            h:Math.max(bounds.y+bounds.h,item.bounds.y+item.bounds.h)-y};
        },members[0].bounds)
      };
      const bounds = component.bounds;
      sourceBounds(template,bounds);
      const crop = {x:Math.max(0,Math.floor(bounds.x*template.width)-1),y:Math.max(0,Math.floor(bounds.y*template.height)-1)};
      crop.w = Math.min(template.width,Math.ceil((bounds.x+bounds.w)*template.width)+1)-crop.x;
      crop.h = Math.min(template.height,Math.ceil((bounds.y+bounds.h)*template.height)+1)-crop.y;
      if (!(crop.w > 0 && crop.h > 0)) throw new Error('The native component is outside its artwork board.');
      if(batch.liveText){layers.push({component,crop,image:null,liveText:true});continue;}
      if (component.virtual && Number.isInteger(component.frameIndex)) { layers.push({component,crop,image:null}); continue; }
      const part = xml.cloneNode(true), svg = part.documentElement;
      const ids = new Set(members.flatMap(item => [...(item.nodeIds || []),'sw-replacement-'+item.id]));
      let found = 0;
      const retain = node => {
        if (node.localName === 'defs') return true;
        if (ids.has(node.getAttribute('id'))) { found++; return true; }
        let kept = false;
        for (const child of [...node.childNodes]) {
          if (!child.localName) continue;
          if (retain(child)) kept = true; else node.removeChild(child);
        }
        return node === svg || kept;
      };
      retain(svg);
      if (!found) throw new Error('The original component could not be isolated: ' + component.label + '.');
      pruneDefinitions(part);
      const viewport = sourceBounds(template,{x:crop.x/template.width,y:crop.y/template.height,w:crop.w/template.width,h:crop.h/template.height});
      svg.setAttribute('width',String(crop.w)); svg.setAttribute('height',String(crop.h));
      svg.setAttribute('viewBox',[viewport.x,viewport.y,viewport.w,viewport.h].join(' ')); svg.setAttribute('preserveAspectRatio','none');
      layers.push({component,crop,image:null,svg:new XMLSerializer().serializeToString(part)});
    }
    return layers;
  }
  function load(id, options = {}) {
    const template = get(id);
    if (!template) return Promise.reject(new Error('Choose one of your nine full SVG templates.'));
    let style, token;
    try { style = normalizeStyle(id,options.style); token = key(id,style); }
    catch (error) { return Promise.reject(error); }
    const previous = cache.get(token);
    if (previous && (previous.state !== 'failed' || !options.retry)) { touch(token,previous); return previous.promise; }
    if (previous) cache.delete(token);
    makeRoom();
    const record = {state:'loading',error:'',image:null,layers:null,promise:null,cancel:null};
    cache.set(token,record);
    record.promise = new Promise((resolve,reject) => {
      let image = null, finished = false, timer = null, blobUrl = '', source = null;
      const layerImages = [], layerUrls = [];
      function finish(error) {
        if (finished) return; finished = true; window.clearTimeout(timer);
        if (image) { image.onload = null; image.onerror = null; }
        layerImages.forEach(image => { image.onload = null; image.onerror = null; });
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        layerUrls.forEach(url => URL.revokeObjectURL(url));
        if (source) source.release();
        if (error) {
          // A timed-out/evicted image should stop its pending decode or request.
          // Its handlers are already detached, so cancellation cannot change state.
          if (image) { try { image.src = ''; } catch (_) {} }
          layerImages.forEach(image => { try { image.src = ''; } catch (_) {} });
          record.state = 'failed'; record.error = error.message || String(error); reject(error);
        }
        else { record.state = 'ready'; record.image = image; resolve(status(id,style)); }
      }
      record.cancel = finish;
      function decode(url) {
        if (finished) return;
        image = new Image();
        image.onload = () => {
          if (image.naturalWidth !== template.width || image.naturalHeight !== template.height)
            finish(new Error('Template artwork dimensions do not match its saved frame map.'));
          else finish();
        };
        image.onerror = () => finish(new Error('Could not load the full template artwork. Check the local asset files, then retry.'));
        image.decoding = 'async'; image.src = url;
      }
      timer = window.setTimeout(() => finish(new Error('Template artwork timed out. Retry while the local server is running.')),TIMEOUT);
      const fontsReady = ensureReplacementFonts(template,style), start = () => {
        if (finished) return;
        try {
          if (!Object.keys(style).length) decode(assetUrl(template.svgArtwork || template.artwork));
          else {
            source = acquireSource(template, record, style.components ? template.componentArtwork : template.svgArtwork);
            source.promise.then(xml => {
              if (finished) return;
              try {
                if (style.components) {
                  const layers = componentLayers(template,styleSource(template,xml,style,true),style);
                  Promise.all(layers.map(layer => {
                    if (!layer.svg) return Promise.resolve();
                    return new Promise((resolve,reject) => {
                      const asset = new Image(); layerImages.push(asset);
                      asset.onload = () => asset.naturalWidth === layer.crop.w && asset.naturalHeight === layer.crop.h
                        ? resolve() : reject(new Error('The native component dimensions do not match its bounds.'));
                      asset.onerror = () => reject(new Error('A native template component could not be decoded. Retry its preview.'));
                      const url = URL.createObjectURL(new Blob([layer.svg],{type:'image/svg+xml'})); layerUrls.push(url);
                      delete layer.svg; layer.image = asset; asset.decoding = 'async'; asset.src = url;
                    });
                  })).then(() => { if (!finished) { record.layers = layers; finish(); } },finish);
                } else {
                  const text = styleSource(template,xml,style);
                  blobUrl = URL.createObjectURL(new Blob([text],{type:'image/svg+xml'}));
                  decode(blobUrl);
                }
              } catch (error) { finish(error); }
            }, error => finish(error));
          }
        } catch (error) { finish(error); }
      };
      if (fontsReady && typeof fontsReady.then === 'function') fontsReady.then(start, finish); else start();
    });
    // Decoding can be requested by the compositor during restore; keep an
    // unobserved rejection from becoming a console error, while callers still receive it.
    record.promise.catch(() => {}); return record.promise;
  }
  function board(id, canvas) {
    const template = get(id), width = Number(canvas && canvas.width), height = Number(canvas && canvas.height);
    if (!template || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error('A full template needs a valid output canvas.');
    const scale = Math.min(width/template.width,height/template.height);
    return {x:(width-template.width*scale)/2,y:(height-template.height*scale)/2,
      width:template.width*scale,height:template.height*scale,scale};
  }
  function frameState(template,index,style) {
    const frame = template.frames[index], component = (template.components || []).find(item => item.frameIndex === index);
    const change = component && style.components && style.components[component.id] || {};
    const scale = change.scale === undefined ? 1 : change.scale, bounds = component && component.bounds || frame;
    const cx = bounds.x+bounds.w/2, cy = bounds.y+bounds.h/2;
    const transform = rect => ({...rect,x:cx+(rect.x-cx)*scale+(change.x || 0),y:cy+(rect.y-cy)*scale+(change.y || 0),
      w:rect.w*scale,h:rect.h*scale,radius:(rect.radius || 0)*scale});
    return {...transform(frame),outer:frame.outer ? transform(frame.outer) : undefined,
      hidden:change.visible === false || change.opacity === 0,opacity:change.opacity === undefined ? 1 : change.opacity,
      componentId:component && component.id};
  }
  function frameRects(id, canvas,style) {
    const template = get(id); if (!template) return [];
    return mappedFrameRects(template,canvas,normalizeStyle(id,style));
  }
  function mappedFrameRects(template,canvas,style) {
    const box = board(template.id,canvas), unit = Math.min(canvas.width,canvas.height);
    const map = frame => ({x:(box.x+frame.x*box.width)/canvas.width,
      y:(box.y+frame.y*box.height)/canvas.height,w:frame.w*box.width/canvas.width,h:frame.h*box.height/canvas.height,
      radius:(frame.radius || 0)*Math.min(template.width,template.height)*box.scale/unit});
    return template.frames.map((_,index) => {
      const frame = frameState(template,index,style);
      return {...map(frame),hidden:frame.hidden,opacity:frame.opacity,componentId:frame.componentId,
        outer:frame.outer ? map(frame.outer) : undefined};
    });
  }
  const POSE_FIELDS = new Set(['x','y','scale','scaleX','scaleY','rotation','flipX','flipY']);
  const advancedPose = change => ['scaleX','scaleY','rotation','flipX','flipY'].some(name => change[name] !== undefined);
  function unposedPartStyle(style,componentId) {
    const change = style.components && style.components[componentId] || {};
    return {...style,components:{[componentId]:Object.fromEntries(Object.entries(change).filter(([name]) => !POSE_FIELDS.has(name)))}};
  }
  // The whole feed group uses this same matrix as an artwork sprite. Coordinates
  // are device pixels; the native crop still lands on integer HD pixels at rest.
  function applyPartPose(ctx,canvas,template,component,change) {
    const box = board(template.id,canvas), bounds = component.bounds;
    const cx = box.x+(bounds.x+bounds.w/2)*box.width, cy = box.y+(bounds.y+bounds.h/2)*box.height;
    const scale = change.scale === undefined ? 1 : change.scale;
    ctx.translate(cx+(change.x || 0)*box.width,cy+(change.y || 0)*box.height);
    if (change.rotation) ctx.rotate(change.rotation*Math.PI/180);
    ctx.scale(scale*(change.scaleX === undefined ? 1 : change.scaleX)*(change.flipX ? -1 : 1),
      scale*(change.scaleY === undefined ? 1 : change.scaleY)*(change.flipY ? -1 : 1));
    ctx.translate(-cx,-cy);
  }
  function paintPartPixels(ctx,layer,x,y,w,h,change) {
    if (!layer.replacement) { ctx.drawImage(layer.image,x,y,w,h); return; }
    const iw = layer.imageWidth, ih = layer.imageHeight, fit = change.imageFit || 'contain';
    if (fit === 'stretch') ctx.drawImage(layer.image,x,y,w,h);
    else if (fit === 'cover') {
      const scale = Math.max(w/iw,h/ih), sw = w/scale, sh = h/scale;
      ctx.drawImage(layer.image,(iw-sw)/2,(ih-sh)/2,sw,sh,x,y,w,h);
    } else {
      const scale = Math.min(w/iw,h/ih), dw = iw*scale, dh = ih*scale;
      ctx.drawImage(layer.image,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
    }
  }
  function paintComponent(ctx,canvas,template,layer,style,opacity = true) {
    if (!layer.image) return;
    const box = board(template.id,canvas), bounds = layer.component.bounds;
    const change = style.components && style.components[layer.component.id] || {}, scale = change.scale === undefined ? 1 : change.scale;
    // Keep an unposed HD crop on exact integer device pixels. A normalized
    // round trip can produce 1045.9999999999999 and trigger an extra browser
    // resampling pass, especially when a transparent sprite is copied again.
    const cx = (bounds.x+bounds.w/2)*template.width, cy = (bounds.y+bounds.h/2)*template.height;
    const x = layer.crop.x*scale+cx*(1-scale)+(change.x || 0)*template.width;
    const y = layer.crop.y*scale+cy*(1-scale)+(change.y || 0)*template.height;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(box.x,box.y,box.width,box.height); ctx.clip();
      if (opacity && change.opacity !== undefined) ctx.globalAlpha *= change.opacity;
      if (advancedPose(change)) {
        applyPartPose(ctx,canvas,template,layer.component,change);
        paintPartPixels(ctx,layer,box.x+layer.crop.x*box.scale,box.y+layer.crop.y*box.scale,layer.crop.w*box.scale,layer.crop.h*box.scale,change);
      } else paintPartPixels(ctx,layer,box.x+x*box.scale,box.y+y*box.scale,layer.crop.w*scale*box.scale,layer.crop.h*scale*box.scale,change);
    } finally { ctx.restore(); }
  }
  let feedCanvas = null;
  function renderComponents(id,ctx,canvas,style,paintFeed,renderOptions={}) {
    const current = status(id,style); if (current.state !== 'ready') return current;
    const template = get(id), canonical = normalizeStyle(id,style), token = key(id,canonical), record = cache.get(token);
    if (!record.layers) return {state:'failed',error:'The editable template components have not been prepared.'};
    touch(token,record);
    try {
      const frames = frameRects(id,canvas,canonical), box = board(id,canvas);
      for (const layer of record.layers) {
        if(layer.liveText){paintLiveText(ctx,canvas,template,layer.component,canonical,renderOptions);continue;}
        const index = layer.component.frameIndex;
        if (!Number.isInteger(index) || typeof paintFeed !== 'function') { paintComponent(ctx,canvas,template,layer,canonical); continue; }
        const frame = frames[index]; if (!frame || frame.hidden) continue;
        if (!feedCanvas) feedCanvas = document.createElement('canvas');
        if (feedCanvas.width !== canvas.width) feedCanvas.width = canvas.width;
        if (feedCanvas.height !== canvas.height) feedCanvas.height = canvas.height;
        const group = feedCanvas.getContext('2d'); group.clearRect(0,0,feedCanvas.width,feedCanvas.height);
        group.save();
        try {
          group.beginPath(); group.rect(box.x,box.y,box.width,box.height); group.clip();
          paintComponent(group,feedCanvas,template,layer,canonical,false);
          if (paintFeed(index,group,frame) === true && template.frames[index].outer)
            drawFrame(id,index,group,feedCanvas,canonical,{group:true});
        } finally { group.restore(); }
        ctx.save();
        try { ctx.globalAlpha *= frame.opacity; ctx.drawImage(feedCanvas,0,0); }
        finally { ctx.restore(); }
      }
      return {state:'drawn',error:'',geometry:box};
    } catch (error) { return {state:'failed',error:error.message || String(error)}; }
  }
  function draw(id,ctx,canvas,style,renderOptions={}) {
    const current = status(id,style);
    if (current.state === 'idle') { load(id,{style}); return {state:'loading',error:''}; }
    if (current.state !== 'ready') return current;
    try {
      const box = board(id,canvas);
      const token = key(id,style), record = cache.get(token); touch(token,record);
      if (record.layers) return renderComponents(id,ctx,canvas,style,undefined,renderOptions);
      ctx.drawImage(record.image,box.x,box.y,box.width,box.height);
      return {state:'drawn',error:'',geometry:box};
    } catch (error) { return {state:'failed',error:error.message || String(error)}; }
  }
  function drawFrame(id,index,ctx,canvas,style,options = {}) {
    const template = get(id);
    if (!template || !template.frames[index] || status(id,style).state !== 'ready') return false;
    const canonical = normalizeStyle(id,style), frame = frameState(template,index,canonical);
    if (!frame.outer || frame.hidden) return false;
    const box = board(id,canvas), unit = Math.min(template.width,template.height)*box.scale;
    ctx.save();
    try {
      ctx.beginPath();
      // A later overlapping frame owns its complete foreground region, even
      // when its live source is empty or contained with letterboxing. The
      // default restores only the border after media has been painted.
      const interior = options && options.interior === true;
      for (const rect of interior ? [frame.outer] : [frame.outer,frame]) {
        const x = box.x+rect.x*box.width, y = box.y+rect.y*box.height;
        const w = rect.w*box.width, h = rect.h*box.height, radius = Math.min((rect.radius || 0)*unit,w/2,h/2);
        if (radius && typeof ctx.roundRect === 'function') ctx.roundRect(x,y,w,h,radius);
        else if (radius) {
          if (typeof ctx.arcTo !== 'function') throw new Error('The output canvas cannot clip rounded template artwork.');
          ctx.moveTo(x+radius,y); ctx.lineTo(x+w-radius,y);
          ctx.arcTo(x+w,y,x+w,y+radius,radius); ctx.lineTo(x+w,y+h-radius);
          ctx.arcTo(x+w,y+h,x+w-radius,y+h,radius); ctx.lineTo(x+radius,y+h);
          ctx.arcTo(x,y+h,x,y+h-radius,radius); ctx.lineTo(x,y+radius);
          ctx.arcTo(x,y,x+radius,y,radius); ctx.closePath();
        } else ctx.rect(x,y,w,h);
      }
      ctx.clip(interior ? 'nonzero' : 'evenodd');
      const token = key(id,style), record = cache.get(token); touch(token,record);
      if (record.layers) {
        const layer = record.layers.find(item => item.component.frameIndex === index);
        if (!layer) return false;
        paintComponent(ctx,canvas,template,layer,canonical,!(options && options.group));
      } else ctx.drawImage(record.image,box.x,box.y,box.width,box.height);
      return true;
    } finally { ctx.restore(); }
  }
  // Independent scene parts use an asset cache separate from complete-page
  // previews. Pose/visibility never causes SVG decoding or another cache entry.
  const partCache = new Map(), MAX_PART_ASSETS = 96;
  // Replacement wording or typography is live canvas content. An SVG Image
  // cannot inherit document FontFaces, so selecting a font must use this same
  // path even when the operator keeps the original wording.
  const liveTextFonts=new Map();
  const directText=(component,style)=>component.editableText&&
    ['text','fontFamily','fontSize','fontWeight','fontStyle','textAlign'].some(name=>style.components?.[component.id]?.[name]!==undefined);
  const liveTextChange=(component,style)=>({...style.components[component.id],text:style.components[component.id].text??component.defaultText??''});
  function liveTextFontKey(component,style) {
    const change=liveTextChange(component,style);
    // Latin typing shares its prepared face. A changed non-Latin glyph set
    // prepares its Unicode subsets before paint rather than borrowing a Latin
    // readiness record; the selected font's network assets remain deduplicated.
    const glyphs=[...new Set(Array.from(change.text).filter(char=>char.codePointAt(0)>255))].sort().join('');
    return JSON.stringify([change.fontFamily||component.defaultFontFamily||'Arial',change.fontWeight||'700',change.fontStyle||'normal',glyphs]);
  }
  function liveTextStatus(component,style) {
    if(liveTextChange(component,style).text==='')return {state:'ready',error:''};
    const record=liveTextFonts.get(liveTextFontKey(component,style));
    return {state:record?.state||'idle',error:record?.error||''};
  }
  function prepareLiveText(template,component,style,retry) {
    if(liveTextChange(component,style).text==='')return Promise.resolve({state:'ready',error:''});
    const key=liveTextFontKey(component,style),old=liveTextFonts.get(key);
    if(old&&(old.state!=='failed'||!retry))return old.promise;
    const record={state:'loading',error:'',promise:null};liveTextFonts.set(key,record);
    if(liveTextFonts.size>128)for(const [cachedKey,value] of liveTextFonts){if(cachedKey!==key&&value.state!=='loading'){liveTextFonts.delete(cachedKey);break;}}
    record.promise=new Promise((resolve,reject)=>{
      let finished=false,timer=null;
      const finish=error=>{
        if(finished)return;finished=true;if(timer!==null)window.clearTimeout(timer);
        if(error){record.state='failed';record.error=error.message||String(error);reject(error);}
        else{record.state='ready';textLayouts.clear();resolve({state:'ready',error:''});}
      };
      try{
        const pending=ensureReplacementFonts({...template,components:[component]},style);
        if(pending){timer=window.setTimeout(()=>finish(new Error('The replacement font timed out. Retry its preview.')),TIMEOUT);Promise.resolve(pending).then(()=>finish(),finish);}
        else finish();
      }catch(error){finish(error);}
    });
    record.promise.catch(()=>{});return record.promise;
  }
  function paintLiveText(ctx,canvas,template,component,style,renderOptions={}) {
    const change=liveTextChange(component,style);if(!change.text)return;
    const box=board(template.id,canvas),bounds=component.bounds;
    const layout=replacementTextLayout(component,change,sourceBounds(template,bounds));
    const map=template.sourceToHd||{scaleX:1,scaleY:1,translateX:0,translateY:0};
    // Match componentLayers' native HD crop, board clipping and pose exactly.
    const left=Math.max(0,Math.floor(bounds.x*template.width)-1),top=Math.max(0,Math.floor(bounds.y*template.height)-1);
    const right=Math.min(template.width,Math.ceil((bounds.x+bounds.w)*template.width)+1);
    const bottom=Math.min(template.height,Math.ceil((bounds.y+bounds.h)*template.height)+1);
    ctx.save();try {
      ctx.beginPath();ctx.rect(box.x,box.y,box.width,box.height);ctx.clip();
      applyPartPose(ctx,canvas,template,component,change);
      ctx.beginPath();ctx.rect(box.x+left*box.scale,box.y+top*box.scale,(right-left)*box.scale,(bottom-top)*box.scale);ctx.clip();
      ctx.translate(box.x+(map.translateX||0)*box.scale,box.y+(map.translateY||0)*box.scale);
      ctx.scale(map.scaleX*box.scale,map.scaleY*box.scale);
      ctx.globalAlpha*=change.opacity===undefined?1:change.opacity;
      ctx.font=(change.fontStyle||'normal')+' '+(change.fontWeight||'700')+' '+layout.size+'px "'+layout.fontFamily+'"';
      ctx.fillStyle=change.textColor||component.defaultTextColor||'#ffffff';
      ctx.textAlign=layout.align;ctx.textBaseline='alphabetic';ctx.direction='ltr';
      const time=Number.isFinite(renderOptions.timeMs)?renderOptions.timeMs:0,
        anchor=Number.isFinite(renderOptions.anchorMs)?renderOptions.anchorMs:0,
        period=layout.width+96/map.scaleX,scrolling=layout.overflow==='scroll'&&layout.overflows,
        offset=scrolling?(Math.max(0,time-anchor)*(change.overflowSpeed||80)/1000/map.scaleX)%period:0;
      layout.lines.forEach((line,index)=>{const x=layout.x-offset,y=layout.baseline+index*layout.lineHeight;
        ctx.fillText(line,x,y);if(scrolling)ctx.fillText(line,x+period,y);});
    }finally{ctx.restore();}
  }
  function partComponent(id,componentId) {
    const template = get(id), component = template && (template.components || []).find(item => item.id === componentId);
    if (!component) throw new Error('That native SVG part is unavailable.');
    return {template,component};
  }
  function textLayout(id,componentId,raw={}){
    const {template,component}=partComponent(id,componentId),style=normalizePartStyle(id,componentId,raw);
    if(!component.editableText)throw Error('This native part has no editable lettering.');
    const change={...(style.components?.[componentId]||{})};
    if(change.text===undefined)change.text=component.defaultText||'';
    const bounds=sourceBounds(template,component.bounds),layout=replacementTextLayout(component,change,bounds),scale=template.sourceToHd?.scaleX||1;
    return Object.freeze({...layout,lines:Object.freeze(layout.lines.slice()),defaultFontSize:component.defaultFontSize,
      viewportWidthHD:bounds.w*scale,contentWidthHD:layout.width*scale,overflowSpeed:change.overflowSpeed||80});
  }
  function normalizePartStyle(id,componentId,raw = {}) {
    partComponent(id,componentId);
    const style = normalizeStyle(id,raw,true);
    if (style.components && Object.keys(style.components).some(key => key !== componentId))
      throw new Error('An independent SVG layer can change only its own component.');
    return style;
  }
  function partAssetStyle(id,componentId,raw) {
    const style = normalizePartStyle(id,componentId,raw), result = {...style};
    delete result.components;
    const content = Object.fromEntries(Object.entries(style.components && style.components[componentId] || {})
      .filter(([name]) => ['text','textColor','fontSize','fontFamily','fontWeight','fontStyle','textAlign','target','imageId'].includes(name)));
    if (Object.keys(content).length) result.components = {[componentId]:content};
    return result;
  }
  function partKey(id,componentId,style) { return id+'|'+componentId+'|'+JSON.stringify(partAssetStyle(id,componentId,style)); }
  function partStatus(id,componentId,style) {
    try {
      const {component}=partComponent(id,componentId),canonical=normalizePartStyle(id,componentId,style);
      if(directText(component,canonical))return liveTextStatus(component,canonical);
      const record = partCache.get(partKey(id,componentId,canonical)); return record ? {state:record.state,error:record.error || ''} : {state:'idle',error:''};
    }
    catch (error) { return {state:'failed',error:error.message}; }
  }
  function loadPart(id,componentId,options = {}) {
    let template,component,style,token;
    try { ({template,component} = partComponent(id,componentId)); style = partAssetStyle(id,componentId,options.style); token = partKey(id,componentId,style); }
    catch (error) { return Promise.reject(error); }
    if(directText(component,style))return prepareLiveText(template,component,style,options.retry);
    const old = partCache.get(token);
    if (old && (old.state !== 'failed' || !options.retry)) { partCache.delete(token);partCache.set(token,old);return old.promise; }
    if (old) partCache.delete(token);
    while (partCache.size >= MAX_PART_ASSETS) {
      const [key,record] = [...partCache].find(([,item]) => item.state !== 'loading') || partCache.entries().next().value;
      if (record.state === 'loading') record.cancel(new Error('An older SVG part preparation was replaced. Retry it.'));
      partCache.delete(key);
    }
    const record = {state:'loading',error:'',layer:null,promise:null,cancel:null};partCache.set(token,record);
    record.promise = new Promise((resolve,reject) => {
      let finished = false,source = null,image = null,url = '',timer = null;
      const finish = error => {
        if (finished) return;finished = true;window.clearTimeout(timer);
        if (image) {image.onload=null;image.onerror=null;}if (url) URL.revokeObjectURL(url);if(source)source.release();
        if(error){if(image)try{image.src='';}catch(_){}record.state='failed';record.error=error.message||String(error);reject(error);}
        else{record.state='ready';resolve({state:'ready',error:''});}
      };
      record.cancel=finish;
      timer=window.setTimeout(()=>finish(new Error('The SVG part timed out. Retry while the local server is running.')),TIMEOUT);
      const fontsReady = ensureReplacementFonts(template,style), start = () => {
       if (finished) return;
       try {
        const change=style.components&&style.components[componentId]||{};
        if(change.imageId){
          const store=window.OpenLiveSvgImages;
          if(!store||typeof store.load!=='function')throw new Error('The local SVG-part image library is unavailable.');
          Promise.resolve(store.load(change.imageId,{retry:options.retry===true})).then(asset=>{
            if(finished)return;
            if(!asset||asset.id!==change.imageId||!asset.image||![asset.width,asset.height].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0)){
              finish(new Error('The local SVG-part image could not be prepared.'));return;
            }
            const bounds=component.bounds;
            record.layer={component,replacement:true,image:asset.image,imageWidth:asset.width,imageHeight:asset.height,
              crop:{x:bounds.x*template.width,y:bounds.y*template.height,w:bounds.w*template.width,h:bounds.h*template.height}};
            finish();
          },finish);
          return;
        }
        if(component.virtual){record.layer={component,crop:{x:0,y:0,w:1,h:1},image:null};finish();return;}
        if(!component.artwork)throw new Error('This SVG part has no standalone native asset.');
        source=acquireSource(template,record,component.artwork);
        source.promise.then(xml=>{
          if(finished)return;
          try{
            const ids=new Set([xml.documentElement,...xml.documentElement.getElementsByTagName('*')].map(node=>node.getAttribute('id')));
            const scoped={...template,components:[component],frameGradientIds:(template.frameGradientIds||[]).filter(id=>ids.has(id)),
              palette:(template.palette||[]).map(entry=>({...entry,gradientIds:(entry.gradientIds||[]).filter(id=>ids.has(id))})),
              backgroundImageIds:(template.backgroundImageIds||[]).filter(id=>ids.has(id))};
            const prepared={...style,components:style.components||{}}, document=styleSource(scoped,xml,prepared,true);
            const layer=componentLayers(scoped,document,prepared)[0];
            if(!layer || !layer.svg)throw new Error('The SVG part contains no native artwork.');
            image=new Image();record.layer=layer;layer.image=image;
            image.onload=()=>image.naturalWidth===layer.crop.w&&image.naturalHeight===layer.crop.h?finish():finish(new Error('The SVG part dimensions do not match its native bounds.'));
            image.onerror=()=>finish(new Error('The SVG part could not be decoded. Retry its preview.'));
            url=URL.createObjectURL(new Blob([layer.svg],{type:'image/svg+xml'}));delete layer.svg;image.decoding='async';image.src=url;
          }catch(error){finish(error);}
        },finish);
       }catch(error){finish(error);}
      };
      if (fontsReady && typeof fontsReady.then === 'function') fontsReady.then(start, finish); else start();
    });
    record.promise.catch(()=>{});return record.promise;
  }
  function partFrameRect(id,componentId,canvas,style) {
    const {template,component}=partComponent(id,componentId),canonical=normalizePartStyle(id,componentId,style);
    if(!Number.isInteger(component.frameIndex))return null;
    const change=canonical.components&&canonical.components[componentId]||{},unposed=advancedPose(change);
    const frame=mappedFrameRects(template,canvas,unposed?unposedPartStyle(canonical,componentId):canonical)[component.frameIndex];
    return {...frame,fit:change.feedFit||'contain',...(unposed?{unposed:true}:{})};
  }
  function partFramePath(ctx,rect,canvas) {
    const x=rect.x*canvas.width,y=rect.y*canvas.height,w=rect.w*canvas.width,h=rect.h*canvas.height;
    const r=Math.min((rect.radius||0)*Math.min(canvas.width,canvas.height),w/2,h/2);
    if(!r)ctx.rect(x,y,w,h);
    else if(typeof ctx.roundRect==='function')ctx.roundRect(x,y,w,h,r);
    else if(typeof ctx.arcTo==='function'){
      ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.arcTo(x+w,y,x+w,y+r,r);ctx.lineTo(x+w,y+h-r);
      ctx.arcTo(x+w,y+h,x+w-r,y+h,r);ctx.lineTo(x+r,y+h);ctx.arcTo(x,y+h,x,y+h-r,r);
      ctx.lineTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.closePath();
    }else throw new Error('The output canvas cannot clip rounded SVG parts.');
  }
  function drawPart(id,componentId,ctx,canvas,style,paintFeed,renderOptions={}) {
    // Hidden layers need no decoded asset, including immediately after reload.
    // Starting an idle hidden asset here would falsely poison Studio readiness.
    try{
      const canonical=normalizePartStyle(id,componentId,style),change=canonical.components&&canonical.components[componentId]||{};
      if(change.visible===false||change.opacity===0)return {state:'drawn',error:''};
    }catch(error){return {state:'failed',error:error.message||String(error)};}
    const current=partStatus(id,componentId,style);
    if(current.state==='idle'){loadPart(id,componentId,{style});return {state:'loading',error:''};}
    if(current.state!=='ready')return current;
    try{
      const {template,component}=partComponent(id,componentId),canonical=normalizePartStyle(id,componentId,style);
      if(directText(component,canonical)){paintLiveText(ctx,canvas,template,component,canonical,renderOptions);return {state:'drawn',error:''};}
      const change=canonical.components&&canonical.components[componentId]||{},token=partKey(id,componentId,canonical),record=partCache.get(token);
      partCache.delete(token);partCache.set(token,record);
      if(change.visible===false||change.opacity===0)return {state:'drawn',error:''};
      const frame=partFrameRect(id,componentId,canvas,canonical);
      if(!frame||typeof paintFeed!=='function'){paintComponent(ctx,canvas,template,record.layer,canonical);return {state:'drawn',error:''};}
      const groupStyle=frame.unposed?unposedPartStyle(canonical,componentId):canonical;
      if(!feedCanvas)feedCanvas=document.createElement('canvas');
      if(feedCanvas.width!==canvas.width)feedCanvas.width=canvas.width;if(feedCanvas.height!==canvas.height)feedCanvas.height=canvas.height;
      const group=feedCanvas.getContext('2d');group.clearRect(0,0,canvas.width,canvas.height);
      group.save();try{
        const box=board(id,canvas);group.beginPath();group.rect(box.x,box.y,box.width,box.height);group.clip();
        paintComponent(group,feedCanvas,template,record.layer,groupStyle,false);
        if(paintFeed(component.frameIndex,group,frame)===true&&frame.outer){
          group.save();try{group.beginPath();partFramePath(group,frame.outer,canvas);partFramePath(group,frame,canvas);group.clip('evenodd');
            paintComponent(group,feedCanvas,template,record.layer,groupStyle,false);}finally{group.restore();}
        }
      }finally{group.restore();}
      ctx.save();try{
        if(frame.unposed){const box=board(id,canvas);ctx.beginPath();ctx.rect(box.x,box.y,box.width,box.height);ctx.clip();applyPartPose(ctx,canvas,template,component,change);}
        ctx.globalAlpha*=frame.opacity;ctx.drawImage(feedCanvas,0,0);
      }finally{ctx.restore();}
      return {state:'drawn',error:''};
    }catch(error){return {state:'failed',error:error.message||String(error)};}
  }
  return Object.freeze({list,get,textFonts:TEXT_FONTS,normalizeStyle:(id,raw)=>normalizeStyle(id,raw),key,status,load,board,frameRects,draw,drawFrame,renderComponents,assetUrl,
    normalizePartStyle,partKey,partStatus,loadPart,drawPart,partFrameRect,textLayout});
})();
