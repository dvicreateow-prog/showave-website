/* A detached viewport, never another editor or Show engine. Its authenticated
 * owner retains the original documents and supplies the live shared view. */
(async function connectWorkspaceWindow(global) {
  'use strict';
  const status = document.getElementById('showave-detached-status');
  const dock = document.querySelector('[data-workspace-action="redock"]');
  if (dock && global.OpenLiveControlIcons) dock.prepend(global.OpenLiveControlIcons.create('dock',document));
  let owner = null, api = null, id = null, drag = null;
  function error(message) { if (status?.isConnected) status.textContent = message; }
  try {
    const params = new URLSearchParams(global.location.search);
    id = params.get('workspace'); const key = params.get('nonce');
    if (![...params.keys()].every(name => name === 'workspace' || name === 'nonce') ||
        [...params.keys()].length !== 2 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key || '') || global.location.hash)
      throw new Error('This workspace window is not linked to a live session.');
    owner = global.opener;
    if (!owner || owner.closed || owner.location.origin !== global.location.origin)
      throw new Error('The owning workspace has closed.');
    api = owner.OpenLiveWorkspaceHost;
    const route = api?.routes.find(route => route.id === id);
    if (!route) throw new Error('This workspace is not available.');
    const tab = document.getElementById('showave-detached-tab');
    tab.dataset.workspaceDetachedTab = id; tab.textContent = route.title;
    tab.setAttribute('aria-label',route.title + '. Drag back into the workspace tabs.');
    tab.title = 'Drag back into the workspace tabs, or choose Dock back.';
    document.title = 'SHOWAVE: ' + route.title;

    // Use the owner's existing sheets and appearance for the small tab header.
    // The shared-view iframe independently follows its editor's own styling.
    const copies = new Map(),managed = new Map();
    const ignoredAttributes = new Set(['id','style','inert','aria-hidden','data-openlive-window-state','data-workspace-ready']);
    const syncStyleAttributes = (from,to) => {
      [...to.attributes].forEach(attr => { if (!from.hasAttribute(attr.name)) to.removeAttribute(attr.name); });
      [...from.attributes].forEach(attr => to.setAttribute(attr.name,attr.value));
      if (to.tagName === 'LINK') to.href = from.href;
    };
    const copyAppearance = () => {
      if (owner.closed) return;
      const source = owner.document;
      for (const [from,to] of [[source.documentElement,document.documentElement],[source.body,document.body]]) {
        const previous = managed.get(to) || {attributes:new Set(),variables:new Set()};
        const attributes = [...from.attributes].filter(attr => !ignoredAttributes.has(attr.name));
        const names = new Set(attributes.map(attr => attr.name));
        previous.attributes.forEach(name => { if (!names.has(name)) to.removeAttribute(name); });
        attributes.forEach(attr => to.setAttribute(attr.name,attr.value));
        const variables = new Set([...from.style].filter(name => name.startsWith('--')));
        previous.variables.forEach(name => { if (!variables.has(name)) to.style.removeProperty(name); });
        variables.forEach(name => to.style.setProperty(name,from.style.getPropertyValue(name),from.style.getPropertyPriority(name)));
        managed.set(to,{attributes:names,variables});
      }
      source.head.querySelectorAll('link[rel="stylesheet"],style').forEach(original => {
        if (original.id === 'showave-workspace-host-style' || copies.has(original)) return;
        const copy = original.cloneNode(true);
        if (copy.tagName === 'LINK') copy.href = original.href;
        document.head.append(copy); copies.set(original,copy);
      });
      copies.forEach((copy,original) => {
        if (!original.isConnected) { copy.remove(); copies.delete(original); }
        else {
          syncStyleAttributes(original,copy);
          if (copy.tagName === 'STYLE' && copy.textContent !== original.textContent) copy.textContent = original.textContent;
        }
      });
    };
    copyAppearance();
    const appearance = new owner.MutationObserver(copyAppearance);
    appearance.observe(owner.document.documentElement,{attributes:true});
    appearance.observe(owner.document.body,{attributes:true});
    appearance.observe(owner.document.head,{subtree:true,childList:true,attributes:true,characterData:true});
    const switcher = document.getElementById('showave-workspace-switcher');
    const switcherToggle = document.getElementById('showave-workspace-switcher-toggle');
    if (global.OpenLiveControlIcons) switcherToggle.prepend(global.OpenLiveControlIcons.create('panels',document));
    const closeSwitcher = (restoreFocus = false) => {
      switcher.hidden = true; switcherToggle.setAttribute('aria-expanded','false');
      if (restoreFocus) switcherToggle.focus();
    };
    const navigate = async target => {
      closeSwitcher();
      try {
        const nativeFocus = global.OpenLiveDesktop?.workspaceWindows?.focus;
        if (typeof nativeFocus === 'function') await nativeFocus({id,nonce:key,target});
        await api.activate(target);
        if (!api.state().workspaces.find(workspace => workspace.id === target)?.detached) owner.OpenLiveStartSplash?.hideSplash();
        if (typeof nativeFocus !== 'function') (api.getWindow?.(target) || owner).focus();
        document.getElementById('showave-detached-navigation-status')?.remove();
      } catch (failure) {
        let notice = document.getElementById('showave-detached-navigation-status');
        if (!notice) {
          notice = document.createElement('p'); notice.id = 'showave-detached-navigation-status';
          notice.setAttribute('role','alert'); document.getElementById('showave-detached-header').after(notice);
        }
        notice.textContent = failure?.message || 'This workspace could not be brought forward. Try again.';
      }
    };
    const renderSwitcher = () => {
      const selected = switcher.querySelector('[data-workspace-target]:focus')?.dataset.workspaceTarget;
      const workspaces = api.state().workspaces;
      switcher.replaceChildren();
      for (const workspace of workspaces) {
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role','menuitem');
        button.dataset.workspaceTarget = workspace.id;
        const label = document.createElement('span'); label.textContent = workspace.id === 'show' ? 'Show Grid' : workspace.title;
        const location = document.createElement('small');
        location.textContent = workspace.id === id ? 'This window' : workspace.detached ? 'Separate window' : 'Main window';
        if (workspace.id === id) button.setAttribute('aria-current','page');
        if (global.OpenLiveControlIcons) button.append(global.OpenLiveControlIcons.create(workspace.detached ? 'undock' : 'panels',document));
        button.append(label,location); button.addEventListener('click',() => navigate(workspace.id)); switcher.append(button);
      }
      if (selected) [...switcher.querySelectorAll('button')].find(button => button.dataset.workspaceTarget === selected)?.focus();
    };
    const openSwitcher = () => {
      renderSwitcher(); switcher.hidden = false; switcherToggle.setAttribute('aria-expanded','true');
      switcher.style.top = Math.round(document.getElementById('showave-detached-header').getBoundingClientRect().bottom + 4) + 'px';
      (switcher.querySelector('[aria-current=page]') || switcher.querySelector('button'))?.focus();
    };
    switcherToggle.addEventListener('click',() => switcher.hidden ? openSwitcher() : closeSwitcher());
    switcherToggle.addEventListener('keydown',event => {
      if (event.key === 'ArrowDown') {event.preventDefault(); openSwitcher();}
    });
    switcher.addEventListener('keydown',event => {
      if (event.key === 'Escape') {event.preventDefault(); closeSwitcher(true);}
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...switcher.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    document.addEventListener('pointerdown',event => {
      if (!switcher.hidden && !switcher.contains(event.target) && !switcherToggle.contains(event.target)) closeSwitcher();
    },true);
    global.addEventListener('blur',() => closeSwitcher());
    const updateSwitcher = () => {if (!switcher.hidden) renderSwitcher();};
    owner.addEventListener('showave:workspace-tabs-changed',updateSwitcher);
    dock.addEventListener('click',() => api.redock(id));
    api.bindDetachedTab(tab,id,global);
    tab.addEventListener('contextmenu',event => { event.preventDefault(); dock.focus(); });
    tab.addEventListener('keydown',event => {
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault(); dock.focus();
      }
    });
    tab.addEventListener('dragstart',event => {
      const token = api.beginDrag(id,global);
      if (!token) { event.preventDefault(); return; }
      drag = {token,cancelled:false}; event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(api.dragType,token);
      event.dataTransfer.setData('text/plain','showave-workspace:' + token);
    });
    tab.addEventListener('dragend',event => {
      const current = drag; drag = null;
      if (!current || !api.cancelDrag(current.token)) return;
      if (!current.cancelled && event.dataTransfer?.dropEffect === 'none' && (event.screenX || event.screenY) &&
          (event.clientX < 0 || event.clientY < 0 || event.clientX > global.innerWidth || event.clientY > global.innerHeight)) {
        global.OpenLiveDesktop?.workspaceWindows?.move({id,nonce:key,x:Math.round(event.screenX - 40),y:Math.round(event.screenY - 14)}).catch(() => {});
      }
    });
    global.addEventListener('keydown',event => {
      if (event.key === 'Escape' && drag) { drag.cancelled = true; api.cancelDrag(drag.token); }
    },true);
    global.addEventListener('pagehide',() => {
      owner.removeEventListener('showave:workspace-tabs-changed',updateSwitcher);
      appearance.disconnect(); if (drag) api.cancelDrag(drag.token);
      try { if (!owner.closed) api.redock(id,{close:false}); } catch (_) {}
    });
    if (!await api.mountWindow(id,key,global)) throw new Error('This workspace window is no longer available.');
    status?.remove(); document.body.dataset.workspaceReady = 'true';
  } catch (failure) {
    error(failure?.message || 'This workspace could not connect.');
    if (!api || !id) dock.disabled = true;
    else dock.addEventListener('click',() => api.redock(id),{once:true});
  }
})(window);
