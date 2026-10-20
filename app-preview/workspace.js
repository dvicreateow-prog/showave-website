/* ===========================================================================
   workspace.js — the dock engine.
   ---------------------------------------------------------------------------
   Arena's workspace is a nested flex tree. That is why it splits, tabs, docks
   and undocks the way it does, and it is recorded verbatim in the ten layout
   presets the application ships:

     Window            a top-level window; main="1" is the primary one, the
                       others are real separate windows on other displays
     FlexContainer     orientation 0 = row, 1 = column; *_desired is the flex
                       basis in points, measured along the parent's axis
     TabbedContainer   one visible child at a time, with a tab strip
     <PanelType/>      a leaf — Clip, Layer, Files, Monitor, Toolbar, …
     HiddenPanels      panels not currently placed, each remembering the
                       container and tab index it should return to
     Params            the 43 View-menu toggles, with defaults

   This module renders that tree, makes every edge draggable, every tab
   re-dockable and every panel undockable into its own browser window, and
   keeps the whole thing serialisable back to the same shape.

   It knows nothing about what any panel contains. Panels register themselves
   through Workspace.register(); see panels.js for the contract.
   =========================================================================== */
window.Workspace = (() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---- panel registry ---------------------------------------------------
     A panel is: a title, a builder, and optionally a teardown. The builder
     receives its mount element and the decoded node (so a Monitor can read
     subject_type="Preview" and instance="1" straight off the layout). */
  const REGISTRY = new Map();
  function register(type, def) {
    REGISTRY.set(type, Object.assign({ title: type, build() {}, destroy() {} }, def));
  }
  const known = type => REGISTRY.has(type);
  const get = type => REGISTRY.get(type) || null;
  const titleOf = type => {
    const raw=(REGISTRY.get(type) || {}).title || type;
    return window.ShowaveBrand && window.ShowaveBrand.label ? window.ShowaveBrand.label(raw) : raw;
  };

  /* ---- state ------------------------------------------------------------ */
  const W = {
    layoutName: null,
    tree: null,          // { windows:[node], hidden:[node], params:{} }
    params: {},          // live view toggles
    mounted: new Map(),  // uid -> { node, host, def }
    popouts: new Map(),  // uid -> window handle
    popoutGeom: new Map(), // uid -> { x, y, w, h } before a window was maximised
    onchange: [],
    root: null,
    activeUid: null,
  };
  let uid = 0;
  const sessionUid = Date.now().toString(36);
  const nextUid = () => 'p' + sessionUid + '_' + (++uid);
  const emit = () => W.onchange.forEach(fn => { try { fn(W); } catch (e) { console.error(e); } });

  /* =======================================================================
     layout source
     ======================================================================= */
  function layouts() {
    const r = window.RESOLUME && window.RESOLUME.arena;
    return (r && r.layouts) || {};
  }
  function layoutNames() { return Object.keys(layouts()); }
  function defaultParams() {
    const r = window.RESOLUME && window.RESOLUME.arena;
    const p = (r && r.layout_params) || {};
    const out = {};
    Object.entries(p).forEach(([k, v]) => { out[k] = v.default === '1'; });
    return out;
  }

  /* deep clone so editing the workspace never mutates the decoded presets */
  const clone = o => JSON.parse(JSON.stringify(o));

  /* =======================================================================
     render
     ======================================================================= */
  function load(name, mountInto) {
    const L = layouts()[name];
    if (!L) { console.warn('Workspace: no layout', name); return false; }
    closePopouts();
    W.layoutName = name;
    W.params = Object.assign(defaultParams(),
      Object.fromEntries(Object.entries(L.params || {}).map(([k, v]) => [k, v.value === '1'])));
    W.tree = { windows: clone(L.windows), hidden: clone(L.hidden), params: clone(L.params || {}) };
    stamp(W.tree.windows); stamp(W.tree.hidden);
    render(mountInto || $('#wsRoot'));
    emit();
    return true;
  }
  function stamp(nodes) {
    (nodes || []).forEach(n => { n.uid = n.uid || nextUid(); stamp(n.children); });
  }

  function render(root) {
    if (!root) return;
    W.root = root;
    if (!W.tree) return;
    stamp(W.tree.windows); stamp(W.tree.hidden);
    destroyAll();
    root.innerHTML = '';
    const main = W.tree.windows[0];
    if (!main) return;
    if (!findNode(W.activeUid)) W.activeUid = firstLeaf(main)?.uid || null;
    root.appendChild(main.children && !main.children.length ? emptyDrop(main)
      : buildNode(main.children ? main.children[0] : main, true));
    /* minimised and maximised survive a rebuild — the state lives on the node,
       but the classes and the flex hold can only be applied once the panel is
       actually in the document */
    applyAllChrome(root);
    /* the extra Window entries are the layout's undocked windows — offer them
       rather than opening popups unasked, which browsers would block anyway */
    W.pendingWindows = W.tree.windows.slice(1);
  }
  const rerender = () => render(W.root || $('#wsRoot'));

  /* =======================================================================
     minimise / maximise / restore
     -----------------------------------------------------------------------
     Arena's panels roll up to their title bar and blow up to fill the window.
     Both are per-panel and both survive a layout rebuild, so the state is
     kept on the node itself rather than on the element.

       null   normal
       'min'  rolled up — the header stays, the body is gone, and the flex
              cell stops claiming space so its siblings take the room
       'max'  filling the workspace — one at a time, like Arena's
     ======================================================================= */
  /* a leaf panel and a tab group both take chrome: a tab group rolls up to its
     tab strip the way a panel rolls up to its title bar */
  function panelBox(uid, root) {
    return (root || W.root || $('#wsRoot') || document).querySelector(
      `.ws-panel[data-uid="${uid}"], .ws-tabs[data-uid="${uid}"]`);
  }
  function applyChrome(box, node) {
    if (!box) return;
    const st = node.ws_state || null;
    box.classList.toggle('ws-minimised', st === 'min');
    box.classList.toggle('ws-maximised', st === 'max');
    /* a minimised panel must stop holding its slice of the flex axis, and get
       it back untouched on restore */
    const cell = box.closest('.ws-cell');
    if (cell) {
      if (st === 'min') {
        if (cell.dataset.flexHold == null) cell.dataset.flexHold = cell.style.flex || '';
        cell.style.flex = '0 0 auto';
      } else if (cell.dataset.flexHold != null) {
        cell.style.flex = cell.dataset.flexHold;
        delete cell.dataset.flexHold;
      }
    }
    const root = W.root || $('#wsRoot');
    if (root) root.classList.toggle('ws-has-max', !!root.querySelector('.ws-maximised'));
    const head = box.querySelector('.ws-head') || box.querySelector('.ws-tabstrip');
    if (head) {
      const mn = head.querySelector('[data-ws-min]'), mx = head.querySelector('[data-ws-max]');
      if (mn) { mn.textContent = st === 'min' ? '▣' : '▁'; mn.title = st === 'min' ? 'Restore' : 'Minimise'; }
      if (mx) { mx.textContent = st === 'max' ? '❐' : '▢'; mx.title = st === 'max' ? 'Restore' : 'Maximise'; }
    }
  }
  /* walk the tree, not the mounted map — a TabbedContainer carries chrome too
     and it is not a mounted leaf */
  function applyAllChrome(root, nodes) {
    (nodes || (W.tree ? W.tree.windows : [])).forEach(n => {
      if (n.ws_state) applyChrome(panelBox(n.uid, root), n);
      if (n.children) applyAllChrome(root, n.children);
    });
  }
  /* setting one to 'max' restores whatever else was maximised */
  function setState(node, st) {
    if (!node) return;
    if (st === 'max') {
      (function clearMax(nodes) {
        (nodes || []).forEach(n => {
          if (n !== node && n.ws_state === 'max') { n.ws_state = null; applyChrome(panelBox(n.uid), n); }
          clearMax(n.children);
        });
      })(W.tree ? W.tree.windows : []);
    }
    node.ws_state = st || null;
    applyChrome(panelBox(node.uid), node);
    emit();
  }
  const minimise = node => setState(node, node.ws_state === 'min' ? null : 'min');
  const maximise = node => setState(node, node.ws_state === 'max' ? null : 'max');
  const restorePanel = node => setState(node, null);
  function byType(type) { return firstOfType(type); }

  function buildNode(node, isRoot) {
    if (!node) return el('div');
    if (node.type === 'FlexContainer') return buildFlex(node, isRoot);
    if (node.type === 'TabbedContainer') return buildTabs(node);
    return buildPanel(node);
  }

  function basis(node, dir) {
    const v = dir === 'row' ? node.width_desired : node.height_desired;
    return Number.isFinite(+v) && +v > 0 ? +v : null;
  }

  function minimum(node, dir) {
    const leaf = dir === 'row' ? 96 : 64;
    if (!node || !node.children || !node.children.length) return leaf;
    const sizes = node.children.filter(visible).map(child => minimum(child, dir));
    if (!sizes.length) return leaf;
    if (node.type === 'FlexContainer' && node.dir === dir)
      return sizes.reduce((sum, n) => sum + n, 0) + (sizes.length - 1) * 3;
    return Math.max(...sizes) + (dir === 'column' && node.type === 'TabbedContainer' ? 22 : 0);
  }

  function buildFlex(node, isRoot) {
    const box = el('div', 'ws-flex ws-' + node.dir);
    box.dataset.uid = node.uid;
    box.style.flexDirection = node.dir;
    if (isRoot) box.classList.add('ws-root-flex');
    const kids = (node.children || []).filter(c => visible(c));
    const weighted = kids.every(child => Number.isFinite(+child.ws_weight) && +child.ws_weight > 0);
    const allDesired = kids.every(child => basis(child, node.dir));
    kids.forEach((child, i) => {
      const wrap = el('div', 'ws-cell');
      wrap.dataset.uid = child.uid;
      const b = basis(child, node.dir);
      /* Arena's *_desired are points, not weights — treat them as a basis and
         let everything without one share the remainder. */
      if (weighted) wrap.style.flex = `${child.ws_weight} 1 0px`;
      else if (allDesired) wrap.style.flex = `${b} 1 0px`;
      else if (b) { wrap.style.flex = `0 1 ${b}px`; wrap.dataset.basis = b; }
      else wrap.style.flex = '1 1 0';
      wrap.appendChild(buildNode(child));
      box.appendChild(wrap);
      if (i < kids.length - 1) box.appendChild(splitter(node, child, kids[i + 1]));
    });
    if (!kids.length) box.appendChild(emptyDrop(node));
    return box;
  }

  /* a panel is visible unless its View toggle is off */
  const TOGGLE = {
    Composition: 'Show Composition', Layer: 'Show Layer', Clip: 'Show Clip',
    Column: 'Show Column', Group: 'Show Group', Files: 'Show Files',
    Effects: 'Show Effects', Sources: 'Show Sources', Compositions: 'Show Compositions',
    Monitor: 'Show Monitor', Slices: 'Show Slices', Notes: 'Show Notes',
    ClipTime: 'Show Clip Time', Recording: 'Show Recordings',
    RenderQueue: 'Show Render Queue', Shortcuts: 'Show Shortcuts', SMPTE: 'Show SMPTE',
  };
  function visible(node) {
    if (!node) return false;
    if (node.type === 'FlexContainer' || node.type === 'TabbedContainer')
      return (node.children || []).some(visible);
    const t = TOGGLE[node.type];
    return t ? W.params[t] !== false : true;
  }

  function splitter(parent, previousNode, nextNode) {
    const dir = parent.dir;
    const s = el('div', 'ws-split ws-split-' + dir);
    s.setAttribute('role', 'separator');
    s.setAttribute('aria-orientation', dir === 'row' ? 'vertical' : 'horizontal');
    s.tabIndex = 0;
    s.title = 'Drag to resize areas · right-click for area operations';
    function resizePair(delta) {
      const prev = s.previousElementSibling, next = s.nextElementSibling;
      if (!prev || !next) return;
      const horiz = dir === 'row';
      const cells = [...s.parentElement.children].filter(c => c.classList.contains('ws-cell'));
      const sizes = cells.map(c => horiz ? c.offsetWidth : c.offsetHeight);
      const at = cells.indexOf(prev), p0 = sizes[at], n0 = sizes[at + 1], total = p0 + n0;
      const minP = minimum(previousNode, dir), minN = minimum(nextNode, dir);
      const factor = Math.min(1, total / (minP + minN));
      sizes[at] = clamp(p0 + delta, minP * factor, total - minN * factor);
      sizes[at + 1] = total - sizes[at];
      cells.forEach((cell, i) => {
        const child = parent.children.find(n => n.uid === cell.dataset.uid);
        if (child) {
          child.ws_weight = Math.max(1, sizes[i]);
          child[dir === 'row' ? 'width_desired' : 'height_desired'] = String(Math.round(sizes[i]));
        }
        cell.style.flex = `${Math.max(1, sizes[i])} 1 0px`;
      });
      s.setAttribute('aria-valuenow', Math.round(sizes[at] / Math.max(1, total) * 100));
    }
    s.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const prev = s.previousElementSibling, next = s.nextElementSibling;
      if (!prev || !next) return;
      const horiz = dir === 'row';
      const start = horiz ? ev.clientX : ev.clientY;
      let last = start;
      document.body.classList.add(horiz ? 'ws-resizing-x' : 'ws-resizing-y');
      const mv = e2 => {
        const value = horiz ? e2.clientX : e2.clientY;
        resizePair(value - last); last = value;
      };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up); removeEventListener('blur', up);
        document.body.classList.remove('ws-resizing-x', 'ws-resizing-y');
        emit();
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
      addEventListener('pointercancel', up); addEventListener('blur', up);
    });
    s.addEventListener('keydown', e => {
      const negative = dir === 'row' ? 'ArrowLeft' : 'ArrowUp';
      const positive = dir === 'row' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== negative && e.key !== positive) return;
      e.preventDefault(); resizePair((e.key === negative ? -1 : 1) * (e.shiftKey ? 32 : 8)); emit();
    });
    s.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation(); showMenu(menuItems(previousNode), e.clientX, e.clientY);
    });
    return s;
  }

  function buildTabs(node) {
    const box = el('div', 'ws-tabs');
    box.dataset.uid = node.uid;
    const strip = el('div', 'ws-tabstrip');
    const body = el('div', 'ws-tabbody');
    const kids = (node.children || []).filter(visible);
    if (!kids.length) { box.appendChild(emptyDrop(node)); return box; }
    if (!kids.some(child => child.uid === node.active_uid)) node.active_uid = kids[0].uid;
    kids.forEach((child, i) => {
      const selected = child.uid === node.active_uid;
      const tab = el('div', 'ws-tab' + (selected ? ' on' : ''));
      const label = el('span'); label.textContent = titleOf(child.type); tab.appendChild(label);
      tab.draggable = true;
      tab.dataset.uid = child.uid;
      tab.addEventListener('click', () => {
        node.active_uid = child.uid; W.activeUid = child.uid;
        $$('.ws-tab', strip).forEach(t => t.classList.toggle('on', t === tab));
        $$('.ws-pane', body).forEach(p => p.classList.toggle('on', p.dataset.uid === child.uid));
        emit();
      });
      tab.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ ws: 'tab', uid: child.uid }));
        e.dataTransfer.effectAllowed = 'move';
      });
      const close = el('span', 'ws-tabx', '✕');
      close.title = 'Hide this panel';
      close.addEventListener('click', e => { e.stopPropagation(); hidePanel(child); });
      tab.appendChild(close);
      strip.appendChild(tab);

      const pane = el('div', 'ws-pane' + (selected ? ' on' : ''));
      pane.dataset.uid = child.uid;
      pane.appendChild(buildPanel(child, true));
      body.appendChild(pane);
    });
    /* the tab group's own chrome: rolling it up leaves the tab strip, which is
       what a tabbed dock collapses to */
    const mn = el('div', 'ws-tabpop', '▁'); mn.title = 'Minimise'; mn.dataset.wsMin = '1';
    mn.addEventListener('click', () => minimise(node));
    const mx = el('div', 'ws-tabpop', '▢'); mx.title = 'Maximise'; mx.dataset.wsMax = '1';
    mx.addEventListener('click', () => maximise(node));
    const pop = el('div', 'ws-tabpop', '⧉');
    pop.title = 'Undock the active panel into its own window';
    pop.addEventListener('click', () => {
      const on = $('.ws-tab.on', strip);
      const child = kids.find(k => k.uid === (on && on.dataset.uid));
      if (child) undock(child);
    });
    const options = el('button', 'ws-tabpop ws-area-options', '▾'); options.type = 'button';
    options.title = 'Area operations and editor type';
    options.addEventListener('click', e => {
      const active = kids.find(k => k.uid === node.active_uid) || kids[0];
      const rect = e.currentTarget.getBoundingClientRect(); showMenu(menuItems(active), rect.left, rect.bottom);
    });
    strip.appendChild(options); strip.appendChild(mn); strip.appendChild(mx); strip.appendChild(pop);
    strip.addEventListener('dblclick', e => {
      if (e.target.closest('.ws-tab, .ws-tabpop')) return;
      maximise(node);
    });
    box.appendChild(strip); box.appendChild(body);
    dropTarget(box, node);
    return box;
  }

  function buildPanel(node, inTab) {
    const def = REGISTRY.get(node.type);
    const box = el('div', 'ws-panel' + (inTab ? ' in-tab' : ''));
    box.dataset.uid = node.uid;
    box.dataset.type = node.type;
    box.tabIndex = -1;
    box.addEventListener('pointerenter', () => { W.activeUid = node.uid; });
    box.addEventListener('focusin', () => { W.activeUid = node.uid; });
    if (!inTab) {
      const head = el('div', 'ws-head');
      const editor = el('button', 'ws-editor-type'); editor.type = 'button';
      editor.textContent = titleOf(node.type) + ' ▾';
      editor.title = 'Area operations and editor type';
      editor.addEventListener('click', e => {
        const rect = e.currentTarget.getBoundingClientRect(); showMenu(menuItems(node), rect.left, rect.bottom);
      });
      head.appendChild(editor);
      const mn = el('span', 'ws-btn', '▁'); mn.title = 'Minimise'; mn.dataset.wsMin = '1';
      mn.addEventListener('click', () => minimise(node));
      const mx = el('span', 'ws-btn', '▢'); mx.title = 'Maximise'; mx.dataset.wsMax = '1';
      mx.addEventListener('click', () => maximise(node));
      const pop = el('span', 'ws-btn', '⧉'); pop.title = 'Undock';
      pop.addEventListener('click', () => undock(node));
      const x = el('span', 'ws-btn', '✕'); x.title = 'Hide';
      x.addEventListener('click', () => hidePanel(node));
      head.appendChild(mn); head.appendChild(mx); head.appendChild(pop); head.appendChild(x);
      /* double-clicking the title bar toggles maximise, as it does everywhere else */
      head.addEventListener('dblclick', e => {
        if (e.target.classList.contains('ws-btn')) return;
        maximise(node);
      });
      head.draggable = true;
      head.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ ws: 'tab', uid: node.uid }));
        e.dataTransfer.effectAllowed = 'move';
      });
      box.appendChild(head);
    }
    const host = el('div', 'ws-body');
    box.appendChild(host);
    if (def) {
      W.mounted.set(node.uid, { node, host, def });
      queueMicrotask(() => {
        if (W.mounted.get(node.uid)?.host !== host || !host.isConnected) return;
        try { def.build(host, node, W); } catch (e) { console.error(node.type, e); }
      });
    } else {
      host.appendChild(el('div', 'ws-todo',
        `<b>${node.type}</b><span>no panel registered for this type</span>`));
    }
    dropTarget(box, node);
    return box;
  }

  function emptyDrop(node) {
    const d = el('div', 'ws-empty');
    const add = el('button', 'ws-empty-add', 'Create area'); add.type = 'button';
    add.addEventListener('click', e => showMenu(editorItems(type => create(type)), e.clientX, e.clientY));
    d.appendChild(add); d.appendChild(el('span', '', 'or drop a panel here'));
    dropTarget(d, node);
    return d;
  }

  /* ---- re-docking -------------------------------------------------------- */
  function dropTarget(elm, node) {
    const clear = () => { elm.classList.remove('ws-drop'); delete elm.dataset.dropEdge; };
    const edgeAt = e => {
      const r = elm.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width), y = (e.clientY - r.top) / Math.max(1, r.height);
      const distances = { left:x, right:1-x, top:y, bottom:1-y };
      const edge = Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
      return distances[edge] < .24 ? edge : 'center';
    };
    elm.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault(); e.stopPropagation();
      elm.classList.add('ws-drop');
      elm.dataset.dropEdge = edgeAt(e);
      e.dataTransfer.dropEffect = 'move';
    });
    elm.addEventListener('dragleave', e => { if (!elm.contains(e.relatedTarget)) clear(); });
    elm.addEventListener('drop', e => {
      const edge = edgeAt(e); clear();
      let d; try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (!d || d.ws !== 'tab') return;
      e.preventDefault(); e.stopPropagation();
      moveInto(d.uid, node, edge);
    });
  }
  function findNode(uid, nodes = W.tree?.windows || []) {
    for (const n of nodes) {
      if (n.uid === uid) return n;
      const hit = n.children && findNode(uid, n.children);
      if (hit) return hit;
    }
    return null;
  }
  function findParent(uid, nodes = W.tree?.windows || [], parent = null) {
    for (const n of nodes) {
      if (n.uid === uid) return parent;
      const hit = n.children && findParent(uid, n.children, n);
      if (hit) return hit;
    }
    return null;
  }
  const resolve = value => typeof value === 'string'
    ? findNode(value) || findNode(value, W.tree?.hidden || []) : value;
  const contains = (node, targetUid) => node?.uid === targetUid ||
    (node?.children || []).some(child => contains(child, targetUid));
  function areaOf(node) {
    const parent = node && findParent(node.uid);
    return parent?.type === 'TabbedContainer' ? parent : node;
  }
  function replaceNode(node, replacement) {
    const parent = findParent(node.uid);
    if (!parent) return false;
    const at = parent.children.indexOf(node);
    if (at < 0) return false;
    parent.children[at] = replacement;
    return true;
  }
  function rememberHome(node) {
    const parent = findParent(node.uid);
    if (!parent) return;
    const at = parent.children.indexOf(node);
    const neighbor = parent.children[at + 1] || parent.children[at - 1];
    node.ws_home = { parent_uid:parent.uid, index:at, dir:parent.dir || null,
      neighbor_uid:neighbor?.uid || null, before:!!parent.children[at + 1],
      weight:node.ws_weight, neighbor_weight:neighbor?.ws_weight };
  }
  function detach(node) {
    const parent = findParent(node.uid);
    if (parent) parent.children = parent.children.filter(child => child !== node);
    W.tree.hidden = (W.tree.hidden || []).filter(child => child !== node);
  }
  function insertBeside(node, target, edge) {
    const direction = edge === 'left' || edge === 'right' ? 'row' : 'column';
    const before = edge === 'left' || edge === 'top';
    const parent = findParent(target.uid);
    if (!parent) return false;
    if (parent.type === 'FlexContainer' && parent.dir === direction) {
      normalizeWeights(parent);
      const index = parent.children.indexOf(target);
      const held = +target.ws_weight || basis(target, direction) || 1;
      node.ws_weight = target.ws_weight = held / 2;
      parent.children.splice(index + (before ? 0 : 1), 0, node);
    } else {
      const flex = { type:'FlexContainer', uid:nextUid(), dir:direction,
        width_desired:target.width_desired, height_desired:target.height_desired,
        ws_weight:target.ws_weight, children:before ? [node, target] : [target, node] };
      node.ws_weight = target.ws_weight = 1;
      if (!replaceNode(target, flex)) return false;
    }
    return true;
  }
  function normalizeWeights(parent) {
    if (!parent || parent.type !== 'FlexContainer') return;
    const box = (W.root || document).querySelector(`.ws-flex[data-uid="${parent.uid}"]`);
    (parent.children || []).forEach(child => {
      if (+child.ws_weight > 0) return;
      const cell = box && [...box.children].find(c => c.classList.contains('ws-cell') && c.dataset.uid === child.uid);
      child.ws_weight = (cell && (parent.dir === 'row' ? cell.offsetWidth : cell.offsetHeight))
        || basis(child, parent.dir) || 1;
    });
  }
  function placeInTabs(node, target) {
    let dest = target;
    if (dest.type !== 'TabbedContainer') {
      if (dest.type === 'FlexContainer' || dest.type === 'Window') {
        if (dest.type === 'Window' && dest.children?.length) return placeInTabs(node, dest.children[0]);
        dest.children = dest.children || [];
        dest.children.push(node); return true;
      }
      const tabs = { type:'TabbedContainer', uid:nextUid(), children:[dest],
        width_desired:dest.width_desired, height_desired:dest.height_desired, ws_weight:dest.ws_weight };
      if (!replaceNode(dest, tabs)) return false;
      dest = tabs;
    }
    dest.children.push(node); dest.active_uid = node.uid;
    return true;
  }
  function moveInto(uid, target, edge = 'center') {
    target = resolve(target); const node = resolve(uid);
    if (!node || !target || node === target || contains(node, target.uid)) return false;
    if (!findParent(target.uid) && target !== W.tree.windows[0]) return false;
    if (!['left', 'right', 'top', 'bottom', 'center'].includes(edge)) return false;
    const dest = areaOf(target), from = findParent(node.uid);
    if (dest === from && (edge === 'center' || dest.children.length === 1)) return false;
    if (contains(dest, node.uid) && dest.children.length === 1) return false;
    detach(node);
    delete node.ws_home; delete node.ws_undocked;
    const moved = edge === 'center' ? placeInTabs(node, dest) : insertBeside(node, dest, edge);
    if (!moved) { W.tree.hidden.push(node); prune(); rerender(); emit(); return false; }
    const popup = W.popouts.get(node.uid);
    W.popouts.delete(node.uid); W.popoutGeom.delete(node.uid);
    if (popup && !popup.closed) popup.close();
    prune(); rerender(); emit(); return true;
  }
  /* containers left holding nothing collapse, the way Arena's do */
  function prune(nodes = W.tree.windows) {
    (nodes || []).forEach(n => {
      if (!n.children) return;
      prune(n.children);
      n.children = n.children.filter(c =>
        !((c.type === 'FlexContainer' || c.type === 'TabbedContainer') && !(c.children || []).length));
      n.children = n.children.map(child => {
        if ((child.type === 'FlexContainer' || child.type === 'TabbedContainer') && child.children.length === 1) {
          const survivor = child.children[0];
          for (const key of ['width_desired', 'height_desired', 'ws_weight'])
            if (child[key] != null) survivor[key] = child[key];
          return survivor;
        }
        return child;
      });
    });
  }

  /* ---- show / hide ------------------------------------------------------- */
  function hidePanel(uidOrNode) {
    const node = resolve(uidOrNode);
    if (!node || node.type === 'Window') return false;
    rememberHome(node); detach(node);
    node.ws_hidden = true; delete node.ws_undocked;
    W.tree.hidden.push(node);
    const popup = W.popouts.get(node.uid);
    W.popouts.delete(node.uid); W.popoutGeom.delete(node.uid);
    if (popup && !popup.closed) popup.close();
    prune(); rerender(); emit(); return true;
  }
  function putBack(node) {
    const home = node.ws_home || {};
    detach(node);
    let parent = home.parent_uid && findNode(home.parent_uid);
    if (parent?.type === 'Window' && parent.children?.length) {
      placeInTabs(node, parent.children[0]);
    } else if (parent?.children) {
      parent.children.splice(clamp(home.index || 0, 0, parent.children.length), 0, node);
      if (parent.type === 'TabbedContainer') parent.active_uid = node.uid;
    } else {
      const neighbor = home.neighbor_uid && findNode(home.neighbor_uid);
      if (neighbor && home.dir) insertBeside(node, areaOf(neighbor), home.dir === 'row'
        ? (home.before ? 'left' : 'right') : (home.before ? 'top' : 'bottom'));
      else if (neighbor) placeInTabs(node, areaOf(neighbor));
      else {
        parent = firstTabbed() || firstFlex() || W.tree.windows[0];
        if (parent?.type === 'Window' && parent.children?.length) placeInTabs(node, parent.children[0]);
        else if (parent) { parent.children = parent.children || []; parent.children.push(node); }
      }
    }
    const neighbor = home.neighbor_uid && findNode(home.neighbor_uid);
    if (neighbor && home.dir && +home.weight > 0 && +home.neighbor_weight > 0) {
      node.ws_weight = home.weight; areaOf(neighbor).ws_weight = home.neighbor_weight;
    }
    const toggle = TOGGLE[node.type]; if (toggle) W.params[toggle] = true;
    delete node.ws_hidden; delete node.ws_undocked;
    return node;
  }
  function hide(type) {
    const t = TOGGLE[type];
    if (t) { W.params[t] = false; render($('#wsRoot')); emit(); return; }
    /* no View toggle for this one — move it to the hidden list instead */
    const node = firstOfType(type);
    if (!node) return;
    hidePanel(node);
  }
  function show(type) {
    if (!W.tree) return;
    const t = TOGGLE[type];
    if (t) W.params[t] = true;
    const closed = W.tree.hidden.filter(h => h.type === type && h.ws_hidden && !W.popouts.has(h.uid));
    if (closed.length) {
      closed.forEach(putBack); prune(); rerender(); emit(); return;
    }
    if (!firstOfType(type)) {
      const held = W.tree.hidden.find(h => h.type === type);
      const node = held || { type, uid: nextUid(), leaf: true };
      if (held?.ws_home) {
        const popup = W.popouts.get(held.uid);
        W.popouts.delete(held.uid); W.popoutGeom.delete(held.uid);
        if (popup && !popup.closed) popup.close();
        putBack(held); prune(); rerender(); emit(); return;
      }
      W.tree.hidden = W.tree.hidden.filter(h => h !== held);
      /* HiddenPanels records where a panel came from: unhide_panel_id is the
         container it belongs in and unhide_target_index its tab position. */
      const home = node.unhide_panel_id && findByPanelId(node.unhide_panel_id);
      /* HiddenPanels names a home for the panels the layout shipped with. A
         panel the layout never held — AdvancedOutput, or anything registered
         later — has no home and no recorded tab index, so it lands in the
         first tab group. Not every layout is guaranteed to have one, and
         falling through to nothing would place the node nowhere and render
         nothing without an error, so the fallback walks down: recorded home,
         any tab group, any flex container, and finally the root. */
      const dest = home || firstTabbed() || firstFlex() || W.tree.windows[0];
      if (dest?.type === 'Window' && dest.children?.length) placeInTabs(node, dest.children[0]);
      else if (dest) { dest.children = dest.children || []; dest.children.push(node); }
      else console.warn('Workspace: nowhere to place', type);
    }
    render($('#wsRoot')); emit();
  }
  function firstFlex(nodes = W.tree.windows) {
    for (const n of nodes) {
      if (n.type === 'FlexContainer') return n;
      const hit = n.children && firstFlex(n.children);
      if (hit) return hit;
    }
    return null;
  }
  function toggle(type) { (firstOfType(type) && visible(firstOfType(type))) ? hide(type) : show(type); }
  function firstOfType(type, nodes = W.tree.windows) {
    for (const n of nodes) {
      if (n.type === type) return n;
      const hit = n.children && firstOfType(type, n.children);
      if (hit) return hit;
    }
    return null;
  }
  function findByPanelId(pid, nodes = W.tree.windows) {
    for (const n of nodes) {
      if (n.panel_id === String(pid)) return n;
      const hit = n.children && findByPanelId(pid, n.children);
      if (hit) return hit;
    }
    return null;
  }
  function firstTabbed(nodes = W.tree.windows) {
    for (const n of nodes) {
      if (n.type === 'TabbedContainer') return n;
      const hit = n.children && firstTabbed(n.children);
      if (hit) return hit;
    }
    return null;
  }

  /* ---- duplicate a panel ------------------------------------------------
     layouts.htm, Multiple Monitors: "To create multiple monitors, simply right
     click on an existing monitor and press duplicate. Press the cogwheel at the
     bottom-right of a monitor to change what you want to monitor."

     That is Resolume's own name for the thing OBS calls a projector — a SECOND
     view of a chosen surface, existing at the same time as the first. The cog
     menu in panels/monitor.js has carried a Duplicate Monitor row since it was
     written, disabled with the reason "its engine has no duplicate operation".
     That was true. This is the operation.

     A duplicate is a fresh subtree, not a shared reference: every uid is
     reissued, or the two copies would be the same panel to every map keyed by
     uid — mounted, popouts, popoutGeom — and closing one would unmount both. */
  function cloneNode(node) {
    const copy = JSON.parse(JSON.stringify(node));
    (function reuid(n) {
      n.uid = nextUid();
      /* A duplicate is not maximised or minimised just because its original
         was; chrome state belongs to the window, not to what it shows. */
      delete n.ws_state;
      delete n.ws_home; delete n.ws_hidden; delete n.ws_undocked; delete n.panel_id;
      delete n.active_uid;
      (n.children || []).forEach(reuid);
    })(copy);
    return copy;
  }
  /* Insert the copy beside the original so it lands where the operator is
     looking. Falls back to a top-level window when the node has no parent —
     a root panel duplicated still has to go somewhere. */
  function duplicate(uidOrNode) {
    const node = resolve(uidOrNode);
    if (!node) return null;
    if (W.popouts.has(node.uid)) {
      const copy = cloneNode(node);
      W.tree.hidden.push(copy);
      return undock(copy) ? copy : (W.tree.hidden = W.tree.hidden.filter(n => n !== copy), null);
    }
    return split(node, 'row');
  }

  function split(uidOrNode, direction = 'row', type) {
    const node = resolve(uidOrNode);
    if (!node || !findParent(node.uid) || (type && !known(type))) return null;
    const copy = type ? { type, uid:nextUid(), leaf:true } : cloneNode(node);
    const target = areaOf(node);
    const dir = direction === 'column' || direction === 'horizontal' ? 'column' : 'row';
    if (!insertBeside(copy, target, dir === 'row' ? 'right' : 'bottom')) return null;
    if (TOGGLE[copy.type]) W.params[TOGGLE[copy.type]] = true;
    W.activeUid = copy.uid; rerender(); emit(); return copy;
  }
  function create(type, targetUid, edge = 'right') {
    if (!known(type) || !W.tree) return null;
    const node = { type, uid:nextUid(), leaf:true };
    const target = findNode(targetUid || W.activeUid) || firstLeaf(W.tree.windows[0]);
    const main = W.tree.windows[0];
    if (!target && main) {
      if (main.children?.length) {
        const base = main.children[0];
        if (base.type === 'FlexContainer') base.children.push(node);
        else if (!insertBeside(node, base, edge)) return null;
      } else main.children = [node];
    }
    else if (!target || !(edge === 'center' ? placeInTabs(node, areaOf(target)) : insertBeside(node, areaOf(target), edge))) return null;
    if (TOGGLE[type]) W.params[TOGGLE[type]] = true;
    W.activeUid = node.uid; rerender(); emit(); return node;
  }
  function firstLeaf(node) {
    if (!node) return null;
    if (!node.children && node.type !== 'Window') return node;
    for (const child of node.children || []) {
      const found = firstLeaf(child); if (found && visible(found)) return found;
    }
    return null;
  }
  function changeType(uidOrNode, type) {
    const node = resolve(uidOrNode);
    if (!node || node.children || !known(type) || node.type === type) return false;
    const mounted = W.mounted.get(node.uid);
    if (mounted) {
      try { mounted.def.destroy?.(mounted.host, node); } catch {}
      W.mounted.delete(node.uid);
    }
    const keep = { type, uid:node.uid, leaf:true };
    for (const key of ['width_desired','height_desired','ws_weight','ws_state'])
      if (node[key] != null) keep[key] = node[key];
    Object.keys(node).forEach(key => delete node[key]); Object.assign(node, keep);
    if (TOGGLE[type]) W.params[TOGGLE[type]] = true;
    rerender(); emit(); return true;
  }
  function neighbors(uidOrNode) {
    let area = areaOf(resolve(uidOrNode));
    if (!area) return [];
    const parent = findParent(area.uid);
    if (parent?.type !== 'FlexContainer') return [];
    const index = parent.children.indexOf(area);
    return [parent.children[index - 1], parent.children[index + 1]].filter(Boolean);
  }
  function join(uidOrNode, neighborUid) {
    const area = areaOf(resolve(uidOrNode));
    const choices = neighbors(area);
    const neighbor = neighborUid ? choices.find(n => n.uid === neighborUid) : choices[0];
    if (!area || !neighbor) return false;
    const parent = findParent(area.uid); normalizeWeights(parent);
    neighbor.ws_weight = (+neighbor.ws_weight || 1) + (+area.ws_weight || 1);
    const store = n => {
      if (n.children) n.children.forEach(store);
      else { rememberHome(n); n.ws_hidden = true; W.tree.hidden.push(n); }
    };
    store(area); parent.children = parent.children.filter(n => n !== area);
    prune(); rerender(); emit(); return true;
  }

  function editorItems(action) {
    return [...REGISTRY.keys()].sort((a,b) => titleOf(a).localeCompare(titleOf(b)))
      .map(type => ({ l:titleOf(type), fn:() => action(type) }));
  }
  function menuItems(uidOrNode) {
    const node = resolve(uidOrNode);
    if (!node) return [];
    const adjacent = neighbors(node);
    return [
      { head:titleOf(node.type) },
      { l:'Editor Type', sub:editorItems(type => changeType(node, type)) },
      { l:'Create Area', sub:editorItems(type => create(type, node.uid)) },
      { sep:1 },
      { l:'Split Vertically', fn:() => split(node, 'row') },
      { l:'Split Horizontally', fn:() => split(node, 'column') },
      { l:'Duplicate Area', fn:() => duplicate(node) },
      { l:'Join Area', dis:!adjacent.length, sub:adjacent.length ? adjacent.map(n => ({
        l:'Keep ' + titleOf(firstLeaf(n)?.type || n.type), fn:() => join(node, n.uid) })) : null },
      { sep:1 },
      { l:'Undock Area', fn:() => undock(node) },
      { l:areaOf(node).ws_state === 'max' ? 'Restore Area' : 'Maximise Area', k:'Ctrl+Space', fn:() => maximise(areaOf(node)) },
      { l:'Close Area', fn:() => hidePanel(node) },
    ];
  }
  let areaMenu = null;
  function closeMenu() { if (areaMenu) areaMenu.remove(); areaMenu = null; }
  function showMenu(items, x, y) {
    closeMenu();
    const menu = el('div', 'ws-area-menu'); menu.setAttribute('role','menu');
    items.forEach(item => {
      if (item.sep) { menu.appendChild(el('div', 'ws-menu-separator')); return; }
      if (item.head) { const head = el('div', 'ws-menu-heading'); head.textContent = item.head; menu.appendChild(head); return; }
      const button = el('button', 'ws-menu-item'); button.type = 'button'; button.disabled = !!item.dis;
      button.textContent = item.l + (item.sub ? '  ›' : item.k ? '  ' + item.k : '');
      button.setAttribute('role','menuitem');
      button.addEventListener('click', () => {
        if (item.sub) showMenu([{ l:'‹ Area operations', fn:() => showMenu(items, x, y) }, ...item.sub], x, y);
        else { closeMenu(); item.fn?.(); }
      }); menu.appendChild(button);
    });
    document.body.appendChild(menu); areaMenu = menu;
    const rect = menu.getBoundingClientRect();
    menu.style.left = clamp(x, 4, Math.max(4, innerWidth - rect.width - 4)) + 'px';
    menu.style.top = clamp(y, 4, Math.max(4, innerHeight - rect.height - 4)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  addEventListener('pointerdown', e => { if (!e.target.closest?.('.ws-area-menu')) closeMenu(); });
  addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
    if (!e.ctrlKey || e.code !== 'Space' || e.repeat || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const node = resolve(W.activeUid);
    if (!node || !W.root?.isConnected) return;
    e.preventDefault(); e.stopImmediatePropagation(); maximise(areaOf(node));
  }, true);

  /* ---- undock into a real window ---------------------------------------- */
  function undock(node, geom) {
    node = resolve(node);
    if (!node || node.children || !W.tree) return null;
    const existing = W.popouts.get(node.uid);
    if (existing && !existing.closed) { existing.focus(); return existing; }
    rememberHome(node);
    const type = node.type;
    const g = geom || {};
    const w = g.width || +(node.width_desired || 520), h = g.height || +(node.height_desired || 420);
    const feat = `popup=yes,width=${w},height=${h}` +
      (g.x != null ? `,left=${g.x},top=${g.y}` : '');
    const url = `panel.html?type=${encodeURIComponent(type)}&uid=${encodeURIComponent(node.uid)}` +
      `&node=${encodeURIComponent(JSON.stringify(node))}` +
      (node.subject_type ? `&subject=${encodeURIComponent(node.subject_type)}` : '') +
      (node.instance ? `&instance=${encodeURIComponent(node.instance)}` : '');
    /* THE WINDOW NAME IS PER PANEL, NOT PER TYPE. It was 'ws_' + type, so a
       second undocked Monitor did not open a second window — window.open reuses
       a window of the same name, so it REPLACED the first one. That alone made
       "two monitors on two projectors", the whole point of duplicating a
       monitor, impossible even once the tree could hold two. */
    const win = window.open(url, 'ws_' + type + '_' + node.uid, feat);
    if (!win) { console.warn('Workspace: the browser blocked the popup for', type); return null; }
    W.popouts.set(node.uid, win);
    W.popoutGeom.set(node.uid, { w, h, x: g.x ?? null, y: g.y ?? null });
    /* while it is out, it is not in the tree */
    detach(node); node.ws_undocked = true; delete node.ws_hidden;
    W.tree.hidden.push(node);
    prune(); rerender(); emit();
    const poll = setInterval(() => {
      if (W.popouts.get(node.uid) !== win) { clearInterval(poll); return; }
      if (win.closed) { clearInterval(poll); redock(node.uid); }
    }, 700);
    return win;
  }
  /* An undocked panel is a real window, so its chrome is the real thing. A
     script-opened popup can be moved and resized, which covers maximise and
     restore. Minimise is not scriptable from the page at all — no browser
     exposes it — so rather than pretend, minimising an undocked panel docks it
     back, which is the same end state Arena reaches by other means. */
  function maximiseWindow(uid) {
    const win = W.popouts.get(uid);
    if (!win || win.closed) return false;
    const g = W.popoutGeom.get(uid) || {};
    if (!g.maxed) {
      W.popoutGeom.set(uid, Object.assign({}, g, {
        maxed: true,
        restore: { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight },
      }));
      win.moveTo(0, 0);
      win.resizeTo(win.screen.availWidth, win.screen.availHeight);
    } else {
      const r = g.restore || { x: 80, y: 80, w: g.w || 520, h: g.h || 420 };
      win.moveTo(r.x, r.y);
      win.resizeTo(r.w, r.h);
      W.popoutGeom.set(uid, Object.assign({}, g, { maxed: false }));
    }
    win.focus();
    return true;
  }
  function redock(uid) {
    if (!W.tree) return false;
    const win = W.popouts.get(uid);
    const node = W.tree.hidden.find(h => h.uid === uid);
    W.popouts.delete(uid); W.popoutGeom.delete(uid);
    if (win && !win.closed) win.close();
    if (node) { putBack(node); prune(); rerender(); emit(); }
    return !!node;
  }
  function closePopouts() {
    const handles = [...W.popouts.values()];
    W.popouts.clear(); W.popoutGeom.clear();
    handles.forEach(win => { try { if (!win.closed) win.close(); } catch {} });
  }

  /* open every extra Window the layout describes — Dual Display ships 2,
     Triple Display 3, at the coordinates the show was designed on */
  function openLayoutWindows() {
    const extra = W.pendingWindows || [];
    let opened = 0;
    extra.forEach(win => {
      const leaves = [];
      (function walk(n) {
        if (!n) return;
        if (n.leaf || (!n.children && n.type !== 'Window')) leaves.push(n);
        (n.children || []).forEach(walk);
      })(win);
      const first = leaves[0];
      if (!first) return;
      undock(first, { width: +win.width || 900, height: +win.height || 700 });
      opened++;
    });
    return opened;
  }

  function destroyAll() {
    W.mounted.forEach(m => { try { m.def.destroy && m.def.destroy(m.host, m.node); } catch {} });
    W.mounted.clear();
  }

  /* ---- persistence ------------------------------------------------------- */
  const KEY = 'ws.layout';
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(
        { name: W.layoutName, params: W.params, tree: W.tree }));
      return true;
    } catch { return false; }
  }
  function loadState(s, mountInto) {
    if (!s?.tree || !Array.isArray(s.tree.windows)) return false;
    closePopouts();
    W.layoutName = s.name; W.params = Object.assign(defaultParams(), s.params || {}); W.tree = clone(s.tree);
    W.tree.hidden = W.tree.hidden || [];
    stamp(W.tree.windows); stamp(W.tree.hidden);
    W.tree.hidden.filter(n => n.ws_undocked).forEach(putBack);
    prune();
    render(mountInto || W.root || $('#wsRoot'));
    emit();
    return true;
  }
  function restore(mountInto) {
    let s; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return false; }
    return loadState(s, mountInto);
  }
  function forget() { try { localStorage.removeItem(KEY); } catch {} }

  /* ---- view params ------------------------------------------------------- */
  function param(name, value) {
    if (value === undefined) return W.params[name];
    W.params[name] = !!value;
    if (value && W.tree) {
      const type = Object.keys(TOGGLE).find(type => TOGGLE[type] === name);
      if (type) {
        W.tree.hidden.filter(node => node.type === type && node.ws_hidden && !W.popouts.has(node.uid)).forEach(putBack);
        prune();
      }
    }
    render($('#wsRoot'));
    emit();
    return value;
  }
  function paramNames() {
    const r = window.RESOLUME && window.RESOLUME.arena;
    return Object.keys((r && r.layout_params) || {}).sort();
  }

  /* ---- what is where ----------------------------------------------------- */
  function inventory() {
    const placed = [], hidden = W.tree ? W.tree.hidden.map(h => h.type) : [];
    (function walk(nodes) {
      (nodes || []).forEach(n => {
        if (n.leaf || (!n.children && n.type !== 'Window')) placed.push(n.type);
        walk(n.children);
      });
    })(W.tree ? W.tree.windows : []);
    return {
      layout: W.layoutName,
      placed: [...new Set(placed)].sort(),
      hidden: [...new Set(hidden)].sort(),
      registered: [...REGISTRY.keys()].sort(),
      unregistered: [...new Set(placed.concat(hidden))].filter(t => !REGISTRY.has(t)).sort(),
      popouts: [...W.popouts.keys()].length,
    };
  }

  return { register, known, get, titleOf, load, layouts, layoutNames, render: rerender,
           show, hide, toggle, hidePanel, undock, duplicate, split, create, changeType, join, neighbors,
           moveInto, findNode:resolve, menuItems, openLayoutWindows, save, loadState, restore, forget,
           minimise, maximise, restorePanel, byType, maximiseWindow, redock,
           param, paramNames, inventory, state: W,
           onchange: fn => W.onchange.push(fn) };
})();
