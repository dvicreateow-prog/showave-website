(function installSourceRail(global) {
  'use strict';
  if (global.OpenLiveSourceRail || !document.getElementById('app')) return;
  const rail = document.createElement('aside');
  rail.id = 'showave-source-rail';
  rail.setAttribute('aria-label', 'Sources and system');
  rail.dataset.expanded = 'false';
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'showave-source-rail-toggle';
  toggle.className = 'showave-source-rail-action';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'showave-source-rail-tools');
  toggle.innerHTML = '<svg class="showave-rail-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5"/></svg><span class="showave-rail-label">Sources</span>';
  const vector = (name, className = 'showave-rail-chevron') => {
    if (!global.OpenLiveControlIcons?.has(name)) return null;
    const icon = global.OpenLiveControlIcons.create(name, document);
    icon.classList.add(className);
    return icon;
  };
  const toggleVector = vector('right');
  if (toggleVector) toggle.querySelector('svg').replaceWith(toggleVector);
  const visibility = document.createElement('button');
  visibility.type = 'button'; visibility.id = 'showave-source-rail-visibility';
  visibility.setAttribute('aria-controls', rail.id);
  visibility.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M6 2v12"/><path class="showave-rail-toggle-indicator" d="M4 5v6"/></svg>';
  const menubar = document.getElementById('menubar');
  if (menubar) menubar.prepend(visibility);
  const tools = document.createElement('nav');
  tools.id = 'showave-source-rail-tools'; tools.setAttribute('aria-label', 'Source shortcuts');
  const status = document.createElement('p');
  status.className = 'showave-source-rail-status'; status.setAttribute('role', 'status');
  status.hidden = true;
  const label = (node, text, type) => {
    const span = document.createElement('span'); span.className = 'showave-rail-label'; span.textContent = text;
    node.append(span);
    const controlName = {folder:'folder',scene:'layers',camera:'camera',video:'playback',
      'audio-input':'microphone',color:'brush',plus:'plus',screen:'screen',phone:'phone',cogs:'gear'}[type];
    const controlIcon = controlName && vector(controlName);
    if (controlIcon) node.prepend(controlIcon);
    else if (type === 'folder') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('showave-rail-file');
      svg.innerHTML = '<path d="M2 4h6l2 2h8v10H2z"/>';
      node.prepend(svg);
    } else global.OpenLiveSourceIcons?.prepend(node, type);
    node.setAttribute('aria-label', text);
  };
  const action = (text, type, title) => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'showave-source-rail-action'; button.title = title || text;
    label(button, text, type); return button;
  };
  const categories = [
    ['files', 'Files', 'folder', 'Browse files and import media'],
    ['sources', 'All sources', 'scene', 'Browse the existing source library'],
    ['capture', 'Capture', 'camera', 'Browse capture device inputs'],
    ['video', 'Video sources', 'video', 'Browse video sources'],
    ['audio', 'Audio sources', 'audio-input', 'Browse audio sources'],
    ['generators', 'Generators', 'color', 'Browse video generators']
  ];
  let selection = 0;
  function announce(text) { status.textContent = text; status.hidden = !text; }
  async function browse(id) {
    const request = ++selection;
    announce('');
    try {
      await global.OpenLiveWorkspaceHost?.activate('show');
      if (request !== selection) return null;
      const manager = global.OpenLiveAreas?.get('show');
      const libraries = manager?.panels().filter(panel => panel.type === 'library') || [];
      let library = libraries.find(panel => panel.state !== 'hidden') || libraries[0];
      if (manager && !library) {
        const id = manager.create('library');
        library = manager.panels().find(panel => panel.id === id);
      }
      if (library?.state === 'hidden') manager.reopen(library.id);
      // Reuse the original browser even when its panel is detached. Its mirror
      // forwards the same controls; no extra preview, decoder or source exists.
      const result = global.OpenLiveSourceBrowser?.open(id);
      if (!result) { announce('The source browser is unavailable.'); return null; }
      tools.querySelectorAll('[data-source-category]').forEach(button =>
        button.setAttribute('aria-pressed', String(button.dataset.sourceCategory === id)));
      const record = library && manager.records.get(library.id);
      if (library?.state === 'window' && record?.popup && !record.popup.closed) record.popup.focus();
      return result;
    } catch (_) { announce('Could not open the source browser.'); return null; }
  }
  categories.forEach(([id, text, type, title]) => {
    const button = action(text, type, title);
    button.dataset.sourceCategory = id; button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => void browse(id)); tools.append(button);
  });
  const add = action('Add source', 'plus', 'Open the Broadcast source chooser');
  add.id = 'showave-source-rail-add';
  add.addEventListener('click', async () => {
    const request = ++selection;
    announce('');
    try {
      await global.OpenLiveWorkspaceHost?.activate('broadcast');
      if (request !== selection || global.OpenLiveWorkspaceHost?.current() !== 'broadcast') return;
      const frame = global.OpenLiveWorkspaceHost?.getFrame('broadcast');
      const button = frame?.contentDocument?.getElementById('workflowSources');
      if (!button || button.disabled) { announce('Select an editable Broadcast scene to add a source.'); return; }
      button.click();
    } catch (_) { announce('Could not open Broadcast sources.'); }
  });
  const auxiliary = document.createElement('div'); auxiliary.className = 'showave-source-rail-auxiliary';
  auxiliary.append(add);
  const mirror = action('Mirror Display', 'screen', 'Open the remote display QR code and Copy Link in Home');
  mirror.id = 'showave-source-rail-mirror';
  mirror.setAttribute('aria-haspopup', 'dialog');
  mirror.setAttribute('aria-expanded', 'false');
  mirror.setAttribute('aria-controls', 'showave-start-mirror-content');
  mirror.querySelector('.bc-source-icon')?.remove();
  const mirrorIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mirrorIcon.setAttribute('viewBox', '0 0 20 20'); mirrorIcon.setAttribute('aria-hidden', 'true');
  mirrorIcon.classList.add('showave-rail-chevron');
  mirrorIcon.innerHTML = '<rect x="1.5" y="2.5" width="12" height="10" rx="1"/><path d="M5 16h5M7.5 12.5V16"/><rect x="13" y="7" width="5.5" height="10.5" rx="1"/>';
  mirror.querySelector('svg')?.remove();
  mirror.prepend(vector('mirror') || mirrorIcon);
  mirror.addEventListener('click', () => global.OpenLiveStartSplash?.openMirror());
  global.addEventListener('showave:home-mirror-changed', event => mirror.setAttribute('aria-expanded', String(event.detail?.open === true)));
  auxiliary.append(mirror);
  const phone = document.getElementById('showavePhoneMirrorButton');
  if (phone) {
    phone.replaceChildren(); phone.classList.add('showave-source-rail-action');
    label(phone, 'Phone Mirror', 'phone'); auxiliary.append(phone);
  }
  const systemSlot = document.createElement('div'); systemSlot.id = 'showave-source-system';
  systemSlot.setAttribute('role', 'menubar'); systemSlot.setAttribute('aria-label', 'System');
  const system = document.querySelector('#menus .menu-top[data-menu-label="Arena"]');
  if (system) {
    system.replaceChildren(); label(system, 'System', 'cogs');
    system.classList.add('showave-source-rail-action'); system.title = 'System menu'; systemSlot.append(system);
    // The remaining horizontal menubar needs an initial keyboard entry after
    // moving its original first item. Keep both real menu openers reachable.
    system.tabIndex = 0;
    const first = document.querySelector('#menus .menu-top'); if (first) first.tabIndex = 0;
  }
  rail.append(toggle, tools, auxiliary, systemSlot, status);
  document.body.append(rail);
  function updateRail() {
    const expanded = rail.dataset.expanded === 'true';
    document.body.dataset.showaveSourceRail = rail.hidden ? 'hidden' : expanded ? 'expanded' : 'compact';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Collapse source rail' : 'Expand source rail');
    toggle.title = expanded ? 'Collapse source rail' : 'Expand source rail';
    visibility.setAttribute('aria-expanded', String(!rail.hidden));
    visibility.setAttribute('aria-label', rail.hidden ? 'Show source sidebar' : 'Hide source sidebar');
    visibility.title = rail.hidden ? 'Show source sidebar' : 'Hide source sidebar';
    global.dispatchEvent(new CustomEvent('showave:rail-changed'));
  }
  function expand(value, focus = false) {
    rail.dataset.expanded = String(!!value);
    updateRail();
    if (focus && !rail.hidden) toggle.focus({ preventScroll: true });
  }
  function setVisible(value) {
    // The System menu is mounted outside the rail. Use its own Escape handler
    // to close it and restore focus before hiding its opener.
    if (!value && system?.getAttribute('aria-expanded') === 'true') {
      const menu = document.getElementById(system.getAttribute('aria-controls'));
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
    }
    if (!value && rail.contains(document.activeElement)) visibility.focus({ preventScroll: true });
    rail.hidden = !value;
    if (rail.hidden) announce('');
    updateRail();
  }
  visibility.addEventListener('click', () => setVisible(rail.hidden));
  toggle.addEventListener('click', () => expand(rail.dataset.expanded !== 'true'));
  // Focused sidebar controls keep native button activation instead of
  // bubbling Enter/Space into the Show's transport shortcuts.
  for (const button of [visibility, toggle]) {
    for (const type of ['keydown', 'keyup']) button.addEventListener(type, event => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
  }
  rail.addEventListener('keydown', event => {
    if (event.key === 'Escape' && rail.dataset.expanded === 'true') {
      event.preventDefault(); event.stopPropagation(); expand(false, true);
    }
  });
  expand(false);
  global.OpenLiveSourceRail = Object.freeze({ browse, expand, setVisible, isVisible: () => !rail.hidden,
    width: () => rail.getBoundingClientRect().width });
})(window);
