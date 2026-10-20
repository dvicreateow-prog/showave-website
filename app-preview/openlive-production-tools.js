/* SHOWAVE production starters. Browsing and editor previews never write to Programme. */
window.OpenLiveProductionTools = (() => {
  'use strict';
  const mounted = new WeakMap();
  function mount(api) {
    const doc = api.document, catalog = window.OpenLiveProductionPresets;
    if (!doc || !catalog) throw new Error('Production template catalogue is unavailable.');
    if (mounted.has(doc)) return mounted.get(doc);
    const byId = id => doc.getElementById(id), disposers = [], nodes = [];
    const on = (node, event, handler) => {
      node.addEventListener(event, handler); disposers.push(() => node.removeEventListener(event, handler));
    };
    function el(tag, parent, text, className) {
      const node = doc.createElement(tag);
      if (text != null) node.textContent = text;
      if (className) node.className = className;
      if (parent) parent.appendChild(node);
      return node;
    }
    function button(parent, text, handler) {
      const node = el('button', parent, text, 'tb-btn production-button'); node.type = 'button';
      on(node, 'click', handler); return node;
    }
    function section(parent, title, description, svgCategories) {
      if (!parent) return null;
      const node = el('section', null, null, 'production-section');
      el('h3', node, title); el('p', node, description, 'production-note');
      if (svgCategories) svgNavigation(node, svgCategories);
      parent.prepend(node); nodes.push(node); return node;
    }
    function svgNavigation(parent, categories) {
      const parts = typeof api.openSvgParts === 'function';
      if (!parts && typeof api.openFullTemplates !== 'function') return;
      el('p', parent, parts
        ? 'SVG pieces belong to the editing scene: preview, then Add a piece or Apply staged edits in the SVG panel. Browsing saves nothing.'
        : 'Complete SVG presets use the scene template browser, separately from the asset controls below.', 'production-note');
      const actions = el('div', parent, null, 'production-actions'), message = status(parent);
      if (parts) {
        for (const [category, label] of categories) {
          const node = button(actions, label, () => report(message, () => {
            if (api.openSvgParts(category) === false) throw new Error('The SVG editing panel could not be opened.');
            return 'SVG pieces opened for browsing. Add or Apply is a separate action.';
          }));
          node.dataset.svgCategory = category;
          if (category === 'all') node.title = 'Browse all SVG pieces and edit each piece\'s own colours in the scene.';
        }
      } else button(actions, 'Browse complete SVG templates', () => report(message, () => {
        if (api.openFullTemplates() === false) throw new Error('The SVG template browser could not be opened.');
        return 'Complete SVG templates opened for browsing. Choosing a scene preset is a separate action.';
      }));
    }
    function status(parent) {
      const node = el('p', parent, '', 'production-status');
      node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); return node;
    }
    function report(node, task) {
      try { node.textContent = task() || ''; node.classList.remove('error'); }
      catch (error) { node.textContent = error.message || String(error); node.classList.add('error'); }
    }
    function preview(parent, id, label, changed) {
      const wrapper = el('div', parent, null, 'production-preview');
      const tools = el('div', wrapper, null, 'production-preview-tools');
      const field = el('label', tools, 'Preview format ');
      const orientation = el('select', field); orientation.setAttribute('aria-label', label + ' format');
      for (const [value, name] of [['landscape', 'Landscape 16:9'], ['portrait', 'Portrait 9:16']]) {
        const option = el('option', orientation, name); option.value = value;
      }
      const canvas = el('canvas', wrapper); canvas.id = id;
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label);
      const message = status(wrapper);
      function prepare(background) {
        const portrait = orientation.value === 'portrait';
        canvas.width = portrait ? 540 : 960; canvas.height = portrait ? 960 : 540;
        canvas.classList.toggle('portrait', portrait);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas preview is unavailable in this browser.');
        ctx.fillStyle = '#101c2d'; ctx.fillRect(0,0,canvas.width,canvas.height);
        const graphics = window.OpenLiveGraphicsPresets;
        if (background && graphics) graphics.draw(background, ctx, canvas, 0);
        else {
          ctx.strokeStyle = '#263c56'; ctx.lineWidth = 1;
          for (let x = 0; x < canvas.width; x += 60) { ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke(); }
          for (let y = 0; y < canvas.height; y += 60) { ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke(); }
        }
        return ctx;
      }
      on(orientation, 'change', changed);
      return {canvas, message, prepare};
    }
    const themePanel = byId('themePanel'), captionsPanel = byId('captionsPanel'), commercePanel = byId('commercePanel');
    const brandRoot = section(themePanel && themePanel.querySelector('.bc-commerce-scroll'),
      'Production brand kits', 'Adapted from your reference templates. Applying a brand updates this scene in Preview; Cut/Fade publishes the scene to Programme.',
      [['logos','SVG logos'],['live-badges','SVG LIVE badges'],['all','SVG palette & colours']]);
    let selectedBrand = catalog.brands[0], brandPreview, brandStatus, brandButtons = [];
    function renderBrand() {
      if (!brandPreview) return;
      report(brandPreview.message, () => {
        const ctx = brandPreview.prepare(selectedBrand.background);
        const hypothetical = Object.assign({}, api.theme.getState(), selectedBrand, {preset:'news',logoPlacement:'template'});
        api.captions.drawPreview(ctx, brandPreview.canvas,
          {type:'lower-third',line1:'Your programme headline',line2:'YOUR COMMUNITY'}, {theme:api.theme.profile(hypothetical)});
        return selectedBrand.description + ' · Preview only.';
      });
      brandButtons.forEach(([node, brand]) => node.setAttribute('aria-pressed', String(brand.id === selectedBrand.id)));
    }
    if (brandRoot) {
      const grid = el('div', brandRoot, null, 'production-grid');
      catalog.brands.forEach(brand => {
        const node = button(grid, '', () => { selectedBrand = brand; renderBrand(); brandStatus.textContent = ''; });
        node.classList.add('production-kit'); node.dataset.brandKit = brand.id;
        const swatch = el('span', node, null, 'production-swatch'); swatch.style.backgroundColor = brand.primaryColor;
        el('span', node, brand.name); node.setAttribute('aria-label', 'Preview ' + brand.name);
        brandButtons.push([node, brand]);
      });
      brandPreview = preview(brandRoot, 'productionBrandPreview', 'Brand kit preview', renderBrand);
      const actions = el('div', brandRoot, null, 'production-actions');
      button(actions, 'Apply brand to Preview', () => report(brandStatus, () => {
        api.theme.applyBrandKit(selectedBrand.id);
        return 'Applied ' + selectedBrand.name + ' in Preview. Cut/Fade publishes the scene to Programme.';
      }));
      button(actions, 'Use matching scene background', () => report(brandStatus, () => {
        if (!api.applyBackground) throw new Error('Scene backgrounds are unavailable.');
        api.applyBackground(selectedBrand);
        return 'Background applied to ' + api.targetLabel() + '. Brand and sources are unchanged.';
      }));
      brandStatus = status(brandRoot); renderBrand();
    }
    const captionRoot = section(captionsPanel && captionsPanel.querySelector('.bc-commerce-scroll'),
      'Caption starters', 'Open a caption draft. Save adds it to My Assets; Save & Show displays it in Preview. Cut/Fade publishes the scene to Programme.',
      [['lower-thirds','SVG lower thirds'],['headlines','SVG headlines'],['text','SVG text']]);
    if (captionRoot) {
      const grid = el('div', captionRoot, null, 'production-grid'), message = status(captionRoot);
      catalog.captions.forEach(starter => button(grid, starter.name, event => report(message, () => {
        api.openCaption(starter.type, null, event.currentTarget);
        byId('captionLine1').value = starter.line1 || ''; byId('captionLine2').value = starter.line2 || '';
        byId('captionTicker').value = starter.text || ''; refreshEditors();
        return 'Draft opened. Save & Show displays it in Preview; Cut/Fade publishes the scene to Programme.';
      })));
    }
    const commerceRoot = section(commercePanel && commercePanel.querySelector('.bc-commerce-scroll'),
      'QR & live-sale starters', 'Link to your watch page, website, donation page or checkout. Save keeps the card in My Assets; Save & Show displays it in Preview. Cut/Fade publishes the scene to Programme. Payment processing happens on the linked site.',
      [['qr','SVG QR pieces'],['logos','SVG logos'],['text','SVG text']]);
    if (commerceRoot) {
      const grid = el('div', commerceRoot, null, 'production-grid'), message = status(commerceRoot);
      catalog.commerce.forEach(starter => button(grid, starter.name, event => report(message, () => {
        api.openCommerce(starter.type, null, event.currentTarget);
        for (const [id, field] of [['commerceTitle','title'],['commerceTargetMode','targetMode'],['commerceTarget','target'],
          ['commercePrice','price'],['commerceCta','callToAction']]) byId(id).value = starter[field] || '';
        api.refreshCommerceFields(); refreshEditors();
        return 'Draft opened; add your own link' + (starter.type === 'qr-image' ? ' and image' : '') + ', then save.';
      })));
    }
    const widgetRoot = section(byId('widgetsLayersView'), 'Quick placement',
      'Applies to the selected widget in the current editing scene. In Studio mode this is Preview; otherwise it is Programme. Widgets currently render in landscape only, without audio.',
      [['feeds','SVG feeds']]);
    if (widgetRoot) {
      const grid = el('div', widgetRoot, null, 'production-grid'), message = status(widgetRoot);
      catalog.placements.forEach(placement => button(grid, placement.name, () => report(message, () => {
        if (!api.placeWidget) throw new Error('Widget placement is unavailable.');
        api.placeWidget(placement); return placement.name + ' applied to ' + api.targetLabel() + '.';
      })));
    }
    const graphicsPanel = byId('graphicsPanel');
    if (typeof api.openSvgParts === 'function' || typeof api.openFullTemplates === 'function')
      section(graphicsPanel && graphicsPanel.querySelector('.bc-commerce-scroll'), 'SVG graphics pieces',
        'Original backgrounds, logos and LIVE badge artwork become scene-owned layers. Generic graphics below keep their own asset controls.',
        [['backgrounds','SVG backgrounds'],['logos','SVG logos'],['live-badges','SVG LIVE badges']]);
    const editors = [];
    for (const kind of ['caption', 'commerce']) {
      const editor = byId(kind + 'Editor'), form = byId(kind + 'Form');
      if (!editor || !form) continue;
      const host = section(form.querySelector('.bc-commerce-editor-body') || form, 'Draft preview',
        'Save updates this asset and any visible copy in Preview. Save & Show displays it in Preview; Cut/Fade publishes the scene to Programme.');
      let timer = null, retries = 0, disposed = false;
      const drawing = preview(host, kind === 'caption' ? 'productionCaptionPreview' : 'productionCommercePreview',
        kind === 'caption' ? 'Caption draft preview' : 'QR and live-sale draft preview', refresh);
      function clear() { if (timer != null) window.clearTimeout(timer); timer = null; }
      function render() {
        clear(); if (disposed || editor.hidden) return;
        report(drawing.message, () => {
          const ctx = drawing.prepare();
          const result = kind === 'caption'
            ? api.captions.drawPreview(ctx, drawing.canvas, api.captionDraft())
            : api.commerce.drawPreview(ctx, drawing.canvas, api.commerceDraft());
          if (result.error) throw new Error(result.error);
          if (result.state === 'invalid' || result.state === 'armed') throw new Error('Complete this draft to render its preview.');
          if (result.imageState === 'pending') {
            if (retries++ < 30) timer = window.setTimeout(render, 100);
            return 'Preparing image preview…' + (retries > 30 ? ' Use Refresh preview to check again.' : '');
          }
          if (result.imageState === 'failed') throw new Error(result.error || 'Image preview could not be decoded.');
          return kind === 'caption' ? 'Draft only · shown with the current Preview scene theme.'
            : 'Draft only · QR encodes ' + result.target;
        });
      }
      function refresh() { if (disposed) return; retries = 0; clear(); if (!editor.hidden) timer = window.setTimeout(render, 50); }
      on(form, 'input', refresh); on(form, 'change', refresh); on(form, 'click', refresh);
      button(host, 'Refresh preview', refresh);
      const observer = new MutationObserver(refresh); observer.observe(editor, {attributes:true,attributeFilter:['hidden']});
      const image = kind === 'commerce' && byId('commerceImagePreview');
      if (image) observer.observe(image, {attributes:true,attributeFilter:['src','hidden']});
      disposers.push(() => { disposed = true; clear(); observer.disconnect(); });
      editors.push(refresh);
    }
    function refreshEditors() { editors.forEach(refresh => refresh()); }
    if (api.theme && api.theme.subscribe) {
      const unsubscribe = api.theme.subscribe(() => { renderBrand(); refreshEditors(); });
      if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
    }
    const result = {refresh:refreshEditors, destroy() {
      disposers.forEach(dispose => dispose()); nodes.forEach(node => node.remove()); mounted.delete(doc);
    }};
    mounted.set(doc, result); return result;
  }
  return Object.freeze({mount});
})();
