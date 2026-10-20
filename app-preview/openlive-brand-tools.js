/* Scene-owned SVG branding controls. Navigation is read-only; Studio prepares
 * and atomically persists explicit visibility changes without touching drafts. */
window.OpenLiveBrandTools = (() => {
  'use strict';
  const mounts = new WeakMap(), clone = value => JSON.parse(JSON.stringify(value));
  const categories = [['logos','Add logo'],['live-badges','Add LIVE badge'],
    ['lower-thirds','Lower thirds'],['headlines','Headlines'],['text','Text']];
  function isBrandPiece(component) {
    if (!component || component.type === 'background' || component.type === 'feed-frame' ||
        Number.isInteger(component.frameIndex) || component.type === 'qr' || component.editableQr) return false;
    return ['logo','badge','live-badge','lower-third','headline'].includes(component.type) || component.editableText === true;
  }
  function mount(options = {}) {
    const doc = options.document || document, studio = options.studio || window.OpenLiveStudio,
      templates = options.templates || window.OpenLiveFullTemplates;
    const target = typeof options.target === 'string' ? doc.querySelector(options.target) : options.target;
    if (!target || !studio || typeof templates?.list !== 'function') throw new Error('The SVG branding controls are unavailable.');
    if (mounts.has(target)) return mounts.get(target);
    const metadata = new Map();
    for (const template of templates.list()) for (const component of template.components || [])
      metadata.set(template.id + '/' + component.id, {template,component});
    const disposers = {static:[],rows:[]}, controls = new Map();
    let destroyed = false, busy = false, serial = 0, renderedScene = null, rowScene = null, rowStamp = null, pendingFocus = null;
    const scene = () => typeof options.controlScene === 'function' ? options.controlScene() : null;
    const stamp = value => value ? JSON.stringify({id:value.id,layout:value.layout,
      fullTemplateId:value.fullTemplateId,fullTemplateStyle:value.fullTemplateStyle,fullTemplateExtras:value.fullTemplateExtras,
      svgParts:value.svgParts,svgPartsMode:value.svgPartsMode,svgPartsExtras:value.svgPartsExtras,slots:value.slots}) : '';
    const node = (tag, parent, text, className) => {
      const value = doc.createElement(tag); if (text != null) value.textContent = text;
      if (className) value.className = className; if (parent) parent.appendChild(value); return value;
    };
    function on(value, event, callback, scope = 'static') {
      value.addEventListener(event, callback); disposers[scope].push(() => value.removeEventListener(event, callback));
    }
    function clearRows() {
      disposers.rows.splice(0).forEach(dispose => dispose());
      for (const [control, scope] of controls) if (scope.rows) controls.delete(control);
      list.textContent = '';
    }
    function button(parent, label, callback, {rows = false, available = true} = {}) {
      const value = node('button', parent, label, 'production-button brand-svg-button'); value.type = 'button';
      controls.set(value, {rows,available}); on(value, 'click', () => {
        if (destroyed || busy || !available) return null; return callback();
      }, rows ? 'rows' : 'static'); return value;
    }
    function say(message, error = false) {
      if (destroyed) return; status.textContent = message; status.classList.toggle('error', error);
    }
    function rememberListFocus(origin) {
      const focused = doc.activeElement;
      let parent = focused;
      while (parent && parent !== list) parent = parent.parentNode;
      if (parent === list && focused.dataset?.brandAction)
        pendingFocus = {node:focused,scene:origin,layerId:focused.dataset.layerId,action:focused.dataset.brandAction};
    }
    function updateBusy() {
      if (destroyed) return;
      root.setAttribute('aria-busy', String(busy));
      for (const [control, config] of controls) control.disabled = busy || !config.available;
      if (!busy && pendingFocus) {
        const previous = pendingFocus; pendingFocus = null;
        if (scene() !== previous.scene || (doc.activeElement !== previous.node && doc.activeElement !== doc.body)) return;
        const replacement = [...controls.keys()].find(control => control.dataset.layerId === previous.layerId && control.dataset.brandAction === previous.action);
        if (replacement && !replacement.disabled) replacement.focus({preventScroll:true});
      }
    }
    function cancel() { serial++; busy = false; pendingFocus = null; updateBusy(); }
    async function navigate(callback, argument) {
      const request = serial;
      try {
        if (typeof callback !== 'function' || await callback(argument) === false) throw new Error('The SVG editor could not be opened.');
      } catch (error) { if (!destroyed && request === serial) say(error?.message || String(error), true); }
    }
    function lookup(layer) { return layer && metadata.get(layer.templateId + '/' + layer.componentId); }
    function current(origin, fingerprint, request) {
      if (destroyed || request !== serial || scene() !== origin || stamp(origin) !== fingerprint) return false;
      return typeof studio.scenes !== 'function' || studio.scenes().includes(origin);
    }
    async function setVisibility(origin, layerId, visible) {
      if (destroyed || busy) return null;
      let request = serial;
      try {
        if (!origin?.id || scene() !== origin) throw new Error('The editing scene changed. Choose a layer in the current scene.');
        const layer = (origin.svgParts || []).find(part => part.id === layerId), entry = lookup(layer);
        if (!layer || !isBrandPiece(entry?.component)) throw new Error('This branding layer is no longer available in the editing scene.');
        if (typeof studio.updateSceneSvgPart !== 'function') throw new Error('Saving SVG layer visibility is unavailable.');
        const fingerprint = stamp(origin), style = clone(layer.style || {}), label = entry.component.label || layer.componentId;
        style.components = {...(style.components || {}), [layer.componentId]:{...(style.components?.[layer.componentId] || {}), visible}};
        // Disabling a focused button can blur it immediately in the browser.
        // Remember ownership before doing so, not only before rebuilding rows.
        rememberListFocus(origin);
        request = ++serial; busy = true; updateBusy(); say('Saving ' + label + ' visibility…');
        // Omit sourceSlot entirely: Studio retains the saved binding. Do not read
        // or overwrite the independent editor's potentially uncommitted fields.
        const result = await studio.updateSceneSvgPart(origin.id, layerId, {style},
          {isCurrent:() => current(origin, fingerprint, request)});
        if (!result || result.id !== layerId) throw new Error('Visibility could not be saved. Refresh the scene and try again.');
        if (destroyed || request !== serial || scene() !== origin) return result;
        busy = false; refresh();
        say((visible ? 'Visibility enabled for ' + label + '. Saved' : 'Hidden ' + label + '. Visibility saved') + '; layer, sources and audio are preserved.');
        try { if (typeof options.onChanged === 'function') await options.onChanged(result); }
        catch (error) {
          if (!destroyed && request === serial && scene() === origin)
            say('Visibility saved, but the view could not refresh: ' + (error?.message || String(error)), true);
        }
        return result;
      } catch (error) {
        if (!destroyed && request === serial) say(error?.message || String(error), true);
        return null;
      } finally {
        if (!destroyed && request === serial) { busy = false; refresh(); }
      }
    }
    const root = node('section', target, null, 'brand-svg-tools production-section');
    node('h3', root, 'SVG branding layers');
    const targetNote = node('p', root, '', 'production-note brand-svg-target');
    node('p', root, 'Add buttons browse only; Add or Apply in the SVG editor saves to the editing scene. Show/Hide below saves visibility immediately without deleting the layer or changing sources/audio.', 'production-note');
    const actions = node('div', root, null, 'production-actions brand-svg-categories');
    for (const [category,label] of categories) {
      const value = button(actions, label, () => navigate(options.openCategory, category), {available:typeof options.openCategory === 'function'});
      value.dataset.svgCategory = category; value.title = 'Browse ' + category + ' without applying or copying a piece.';
    }
    const splitNote = node('div', root, null, 'brand-svg-split');
    node('p', splitNote, 'This scene uses a complete SVG template. Open the SVG editor and choose “Break current template into layers” explicitly to control its branding pieces independently. Browsing does not split or replace it.', 'production-note');
    button(splitNote, 'Open SVG editor', () => navigate(options.openCategory, 'all'), {available:typeof options.openCategory === 'function'});
    const count = node('p', root, '', 'production-note brand-svg-count');
    const list = node('ul', root, null, 'brand-svg-layers');
    const empty = node('p', root, '', 'production-note brand-svg-empty');
    node('p', root, 'LIVE badges are artwork, not actual streaming status. Thumbnails show the original SVG pieces; Customize opens saved settings.', 'production-note');
    const status = node('p', root, '', 'production-status brand-svg-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    function refresh() {
      if (destroyed) return;
      const value = scene();
      if (value !== renderedScene) { cancel(); say(''); renderedScene = value; }
      targetNote.textContent = value?.id
        ? (typeof options.targetLabel === 'function' ? String(options.targetLabel()) : 'Editing scene · ' + value.id)
        : 'Choose an editing scene first.';
      const entries = (value?.svgParts || []).map((layer,index) => ({layer,position:index+1,...lookup(layer)})).filter(entry => isBrandPiece(entry.component));
      splitNote.hidden = !value?.fullTemplateId || !!value.svgParts?.length;
      count.textContent = entries.length + ' branding layer' + (entries.length === 1 ? '' : 's') + ' · bottom to top';
      empty.hidden = entries.length > 0;
      empty.textContent = value?.id ? 'No independent branding layers in this scene. Browse a category to choose a piece.' : 'Select a scene to see its saved branding layers.';
      const nextStamp = JSON.stringify(entries.map(entry => [entry.layer,entry.position,entry.template.id,entry.template.name,
        entry.component.label,entry.component.thumbnail,entry.component.thumbnailSurface]));
      if (rowScene === value && rowStamp === nextStamp) { updateBusy(); return; }
      if (rowScene === value) rememberListFocus(value);
      clearRows(); rowScene = value; rowStamp = nextStamp;
      for (const {layer,position,template,component} of entries) {
        const row = node('li', list, null, 'brand-svg-layer'); row.dataset.layerId = layer.id;
        const label = component.label || component.id;
        const location = (template.name || template.id) + ' · layer ' + position;
        row.setAttribute('aria-label', label + ' · ' + location);
        if (component.thumbnail && typeof templates.assetUrl === 'function') {
          try {
            const image = node('img', row, null, 'brand-svg-thumbnail'); image.src = templates.assetUrl(component.thumbnail);
            image.alt = label + ' · original SVG reference'; image.loading = 'lazy';
            image.setAttribute('data-surface', component.thumbnailSurface === 'dark' ? 'dark' : 'light');
          } catch (_) { node('span', row, 'Original preview unavailable', 'production-note'); }
        }
        const info = node('div', row, null, 'brand-svg-info'); node('strong', info, label);
        node('span', info, template.name || template.id, 'brand-svg-page');
        const settings = layer.style?.components?.[component.id] || {}, shown = settings.visible !== false;
        node('span', info, shown ? (settings.opacity === 0 ? 'Enabled · opacity 0% (not visible)' : 'Enabled') : 'Hidden', 'brand-svg-visibility');
        const rowActions = node('div', row, null, 'production-actions brand-svg-layer-actions');
        const customize = button(rowActions, 'Customize', () => {
          if (scene() !== value || !(value.svgParts || []).some(part => part.id === layer.id)) {
            say('The editing scene or layer changed. Refresh this list before customizing.', true); return null;
          }
          return navigate(options.editLayer, layer.id);
        }, {rows:true,available:typeof options.editLayer === 'function'});
        customize.dataset.layerId = layer.id; customize.dataset.brandAction = 'customize';
        customize.setAttribute('aria-label', 'Customize ' + label + ' · ' + location);
        const visibility = button(rowActions, shown ? 'Hide' : 'Show', () => setVisibility(value, layer.id, !shown),
          {rows:true,available:typeof studio.updateSceneSvgPart === 'function'});
        visibility.dataset.layerId = layer.id; visibility.dataset.brandAction = 'visibility';
        visibility.setAttribute('aria-label', (shown ? 'Hide ' : 'Show ') + label + ' · ' + location);
        visibility.title = 'Save this layer\'s visibility only. Hiding does not delete it or change sources/audio.';
      }
      updateBusy();
    }
    const api = {refresh,cancel,isBusy:() => busy,destroy() {
      if (destroyed) return; cancel(); destroyed = true;
      disposers.static.splice(0).forEach(dispose => dispose()); clearRows(); controls.clear(); root.remove(); mounts.delete(target);
    }};
    mounts.set(target, api); refresh(); return api;
  }
  return Object.freeze({mount});
})();
