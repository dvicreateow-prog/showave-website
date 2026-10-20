/* SHOWAVE public brand system
   -----------------------------------------------------------------------
   Customer-facing names live here. Compatibility identifiers intentionally
   remain OpenLive/Resolume-shaped elsewhere so existing shows, presets,
   browser storage, integrations and imported files keep working.
   ----------------------------------------------------------------------- */
(function installShowaveBrand(global) {
  'use strict';

  const modules = Object.freeze({
    live: Object.freeze({ name: 'SHOWAVE Live', label: 'LIVE', purpose: 'Live show control' }),
    forge: Object.freeze({ name: 'SHOWAVE Forge', label: 'FORGE', purpose: 'Node creation' }),
    encode: Object.freeze({ name: 'SHOWAVE Encode', label: 'ENCODE', purpose: 'Media preparation' }),
    map: Object.freeze({ name: 'SHOWAVE Map', label: 'MAP', purpose: 'Output mapping' }),
    lighting: Object.freeze({ name: 'GSL5 Lighting Library', label: 'GSL5', purpose: 'Professional lighting control' }),
    chaser: Object.freeze({ name: 'SHOWAVE Chaser', label: 'CHASER', purpose: 'Slice sequencing and pixel maps' }),
    timeline: Object.freeze({ name: 'SHOWAVE Timeline', label: 'TIMELINE', purpose: 'Timecoded show automation' }),
    grid: Object.freeze({ name: 'SHOWAVE Grid Tool', label: 'GRID', purpose: 'LED wall planning and signal mapping' }),
    broadcast: Object.freeze({ name: 'SHOWAVE Broadcast', label: 'BROADCAST', purpose: 'Live distribution' })
  });

  const vocabulary = Object.freeze({
    Composition: Object.freeze({ term: 'Show', meaning: 'The complete live production.' }),
    Deck: Object.freeze({ term: 'Bank', meaning: 'A collection of clips for one part of a show.' }),
    Column: Object.freeze({ term: 'Cue', meaning: 'A vertical trigger that launches clips together.' }),
    Dashboard: Object.freeze({ term: 'Quick Controls', meaning: 'The controls chosen for fast access.' }),
    Autopilot: Object.freeze({ term: 'Wave', meaning: 'An automated sequence through cues and clips.' })
  });

  const brand = Object.freeze({
    name: 'SHOWAVE',
    company: 'Afro Unity Group',
    creator: 'Godrick Sankofa',
    legalName: 'Agaba Godrick',
    tagline: 'Shape the signal. Command the show.',
    modules,
    vocabulary
  });

  function moduleFor(key) {
    return modules[String(key || '').toLowerCase()] || null;
  }

  /* The supplied artwork is a single hard-coded white fill, so it is painted as
     a mask rather than an <img>: masked, it takes currentColor and therefore
     follows all sixteen palettes in both modes, where an <img> would vanish on
     every light base. The wordmark is inside the mark, so the text lockup is
     dropped — but only for Live. SHOWAVE Map, Encode and Broadcast mount the
     same lockup, and without their module chip four separate applications would
     wear one identical anonymous logo. The name still reaches assistive tech
     through the mount's aria-label either way. */
  function lockupMarkup(key) {
    const module = moduleFor(key);
    const mark = '<span class="showave-mark" aria-hidden="true"></span>';
    const wearsChip = !module || module.label !== 'LIVE';
    const moduleLabel = module && wearsChip ? `<span class="showave-module">${module.label}</span>` : '';
    return mark + moduleLabel;
  }

  function term(value) {
    const raw = String(value == null ? '' : value);
    const aliases = {
      'Trigger First Column On Play': 'Trigger First Cue On Play',
      'Ignore Column Trigger': 'Ignore Cue Trigger',
      'Composition Determined': 'Show Determined',
      'Composition FFT': 'Show FFT',
      'Advanced Output': 'SHOWAVE Map',
      'Dashboard Dial': 'Quick Control Dial',
      'Dashboard Options': 'Quick Controls Options'
    };
    const entry = vocabulary[raw];
    return entry ? entry.term : (aliases[raw] || raw);
  }

  /* Presentation-only expansion for compound labels such as
     "Composition · Master" or "Previous Column". Callers opt in so paths,
     persistence values and imported compatibility data are never renamed. */
  function label(value) {
    return term(value)
      .replace(/\bAdvanced Output\b/g, 'SHOWAVE Map')
      .replace(/\bCompositions\b/g, 'Shows')
      .replace(/\bComposition\b/g, 'Show')
      .replace(/\bDecks\b/g, 'Banks')
      .replace(/\bDeck\b/g, 'Bank')
      .replace(/\bColumns\b/g, 'Cues')
      .replace(/\bColumn\b/g, 'Cue')
      .replace(/\bDashboard\b/g, 'Quick Controls')
      .replace(/\bAutopilot\b/g, 'Wave');
  }

  function vocabularyMarkup() {
    return Object.values(vocabulary).map(entry =>
      `<span class="showave-vocabulary-item"><strong>${entry.term}</strong><small>${entry.meaning}</small></span>`
    ).join('');
  }

  const aboutControllers = new WeakMap();
  function prepareAbout(doc) {
    const overlay = doc && doc.getElementById && doc.getElementById('dlgAbout');
    if (!overlay || !overlay.querySelector || !doc.addEventListener) return null;
    if (aboutControllers.has(overlay)) return aboutControllers.get(overlay);
    const dialog = overlay.querySelector('[role="dialog"],.dialog');
    if (!dialog) return null;
    let opened = false, opener = null, pendingOpener = null, requestedOpener = null, app = null, priorInert = null;
    const visible = () => overlay.classList.contains('show');
    const usable = node => node && node.isConnected && node !== doc.body && node !== doc.documentElement;
    function invoker(node) {
      if (!usable(node) || overlay.contains(node)) return null;
      // Menu items disappear after activation; retain their surviving menu-bar control.
      const seen = new Set();
      while (node.closest) {
        const menu = node.closest('[role="menu"]');
        if (!menu || !menu.id || seen.has(menu)) break;
        seen.add(menu);
        const owner = Array.from(doc.querySelectorAll('[aria-controls]')).find(control => control.getAttribute('aria-controls') === menu.id);
        if (!owner) break;
        node = owner;
      }
      return node;
    }
    function focusable() {
      return Array.from(dialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')).filter(node =>
        !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden],[inert]') &&
        node.getClientRects().length && global.getComputedStyle(node).visibility !== 'hidden');
    }
    function focusInside() {
      (focusable()[0] || dialog).focus({ preventScroll: true });
    }
    function sync() {
      if (visible() === opened) return;
      if (visible()) {
        opener = invoker(requestedOpener) || invoker(doc.activeElement) || (usable(pendingOpener) ? pendingOpener : null);
        requestedOpener = null;
        opened = true;
        app = doc.getElementById('app');
        if (app && !app.contains(overlay)) {
          priorInert = app.getAttribute('inert');
          app.setAttribute('inert', '');
        } else app = null;
        focusInside();
      } else {
        opened = false;
        // A direct About link can be used again after closing, without leaving
        // a stale anchor or reloading the operator's show.
        if (global.location && global.location.hash === '#about' && global.history) {
          try { global.history.replaceState(global.history.state, '', global.location.pathname + global.location.search); }
          catch (_) { /* Closing the dialog remains available if history is restricted. */ }
        }
        if (app) {
          if (priorInert === null) app.removeAttribute('inert');
          else app.setAttribute('inert', priorInert);
        }
        const target = usable(opener) ? opener : doc.querySelector('.showave-brand-lockup[role="button"]');
        opener = null; requestedOpener = null; app = null;
        if (usable(target) && !target.closest('[inert]')) target.focus({ preventScroll: true });
      }
    }
    const controller = {
      sync,
      open(node) { requestedOpener = node; overlay.classList.add('show'); sync(); },
      keydown(event) {
        sync();
        if (!visible()) return;
        // Stop later app-level capture shortcuts, without cancelling native button activation.
        event.stopImmediatePropagation();
        if (event.key === 'Escape') {
          event.preventDefault(); overlay.classList.remove('show'); sync();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          const nodes = focusable(), index = nodes.indexOf(doc.activeElement);
          const next = event.shiftKey ? (index <= 0 ? nodes.length - 1 : index - 1) : (index + 1) % nodes.length;
          (nodes[next] || dialog).focus({ preventScroll: true });
        } else if (!dialog.contains(event.target)) {
          event.preventDefault(); focusInside();
        }
      }
    };
    aboutControllers.set(overlay, controller);
    doc.addEventListener('focusin', event => {
      if (!visible()) { pendingOpener = invoker(event.target); return; }
      sync();
      if (!dialog.contains(event.target)) focusInside();
    }, true);
    // This also covers a dynamically inserted About host and a browser without MutationObserver.
    doc.addEventListener('click', () => { if (opened || visible()) sync(); });
    if (typeof global.MutationObserver === 'function') {
      const observer = new global.MutationObserver(sync);
      observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
    sync();
    return controller;
  }

  // Brand loads before app.js, so this capture guard precedes the Show shortcuts.
  if (global.addEventListener) global.addEventListener('keydown', event => {
    const doc = global.document, overlay = doc && doc.getElementById && doc.getElementById('dlgAbout');
    if (overlay && overlay.classList.contains('show')) prepareAbout(doc)?.keydown(event);
  }, true);

  let aboutNavigationWired = false;
  function openLinkedAbout() {
    if (!global.location || global.location.hash !== '#about') return;
    const doc = global.document;
    if (doc && doc.getElementById('showaveHomeButton')) {
      if (global.OpenLiveStartSplash) global.OpenLiveStartSplash.showSplash();
      else global.__showaveSplashRequested = true;
      try { global.history.replaceState(global.history.state, '', global.location.pathname + global.location.search); }
      catch (_) { /* Home remains available if history is restricted. */ }
      return;
    }
    const controller = prepareAbout(doc);
    if (!controller) return;
    const overlay = doc.getElementById('dlgAbout');
    if (!overlay.classList.contains('show')) {
      controller.open(doc.querySelector('.showave-brand-lockup[role="button"]'));
    }
  }

  /* The lockup doubles as the About button, the way a desktop application's
     title badge does. It is wired ONLY where an About dialog actually exists in
     the same document: Preferences, Wire, Alley and the floating editors mount
     the same lockup in their title bars and have no dialog to open, and a badge
     that looks clickable and does nothing is the exact failure this codebase
     refuses elsewhere. The lockup inside the dialog is excluded too — it would
     re-open what the operator is already reading.

     It opens by adding the `show` class because app.js is one IIFE and neither
     act('about') nor show() is reachable from here. That single class name is
     the whole contract (app.js:2985 `function show(id)` does exactly this, and
     the dialog's own data-close path removes it), so mirroring it duplicates a
     class name rather than any behaviour. */
  function wireAbout(node, module) {
    const doc = node.ownerDocument;
    const dialog = doc && doc.getElementById ? doc.getElementById('dlgAbout') : null;
    if (!dialog || (node.closest && node.closest('#dlgAbout'))) return;
    if (node.dataset.showaveAboutWired === 'true') return;
    node.dataset.showaveAboutWired = 'true';
    const name = module ? module.name : 'SHOWAVE';
    /* role/tabindex rather than a real <button>: the tag belongs to the page
       that mounts the lockup, and several of them use <span>, which cannot
       legally contain one. Enter and Space are therefore wired by hand, because
       only a real button gets them for free. */
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('title', `About ${name}`);
    const open = () => {
      const controller = prepareAbout(doc);
      if (controller) controller.open(node);
      else dialog.classList.add('show');
    };
    node.addEventListener('click', open);
    node.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      open();
    });
  }

  function mount(root) {
    const scope = root && root.querySelectorAll ? root : global.document;
    if (!scope || !scope.querySelectorAll) return;
    prepareAbout(scope.ownerDocument || scope);
    scope.querySelectorAll('[data-showave-brand]').forEach(node => {
      const key = node.getAttribute('data-showave-brand');
      const module = moduleFor(key);
      node.classList.add('showave-brand-lockup');
      node.innerHTML = lockupMarkup(key);
      // Home owns the main window's product information and startup actions.
      if (node.id === 'showaveHomeButton') {
        node.setAttribute('aria-label', 'Open SHOWAVE Home');
        node.setAttribute('title', 'Open Home');
        node.setAttribute('aria-haspopup', 'dialog');
        return;
      }
      /* Once it is a button the accessible name has to say what activating it
         does; the product framing stays in the visible title tooltip. */
      const activates = !!(node.ownerDocument && node.ownerDocument.getElementById
        && node.ownerDocument.getElementById('dlgAbout') && !(node.closest && node.closest('#dlgAbout')));
      node.setAttribute('aria-label', activates
        ? `About ${module ? module.name : 'SHOWAVE'}`
        : (module ? `${module.name}: an Afro Unity Group product` : 'SHOWAVE: an Afro Unity Group product'));
      wireAbout(node, module);
    });
    scope.querySelectorAll('[data-showave-company]').forEach(node => { node.textContent = brand.company; });
    scope.querySelectorAll('[data-showave-creator]').forEach(node => { node.textContent = brand.creator; });
    scope.querySelectorAll('[data-showave-tagline]').forEach(node => { node.textContent = brand.tagline; });
    scope.querySelectorAll('[data-showave-vocabulary]').forEach(node => {
      node.classList.add('showave-vocabulary');
      node.innerHTML = vocabularyMarkup();
    });
    if (!aboutNavigationWired && global.addEventListener) {
      global.addEventListener('hashchange', openLinkedAbout);
      aboutNavigationWired = true;
    }
    openLinkedAbout();
  }

  global.ShowaveBrand = Object.freeze({ ...brand, moduleFor, term, label, mount });
  /* One desktop-owned mobile mirror for the whole SHOWAVE suite. The remote
     page is inert and never loads this application bootstrap. */
  if (global.document && !global.document.querySelector('script[data-showave-mobile-host]')) {
    const script = global.document.createElement('script');
    script.src = 'openlive-mobile-host.js?v=preferences-qr-2';
    script.setAttribute('data-showave-mobile-host', '');
    script.defer = true;
    (global.document.head || global.document.documentElement).appendChild(script);
  }
  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', () => mount(global.document));
    else mount(global.document);
  }
})(window);
