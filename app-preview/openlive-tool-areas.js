/* Retain each tool's native editor and attach the shared area manager to its
 * existing content well. No tool engine, renderer, or iframe is recreated. */
(function installToolAreas(global) {
  'use strict';
  if (global.OpenLiveToolAreas || !global.OpenLiveAreas) return;
  const doc = global.document, areas = global.OpenLiveAreas;
  const element = (tag, cls) => { const node = doc.createElement(tag); node.className = cls || ''; return node; };
  const usableRatio = (pixels, total, fallback) => total > 0 ? Math.max(.12,Math.min(.85,pixels / total)) : fallback;
  function extraTypes() {
    return [
      {id:'phone-mirror',title:'Phone Mirror',build:host => global.OpenLivePhoneMirror && global.OpenLivePhoneMirror.build(host)},
      {id:'notes',title:'Notes',build:host => {
        const notes = element('textarea','ol-area-notes'); notes.setAttribute('aria-label','Area notes');
        notes.placeholder = 'Show notes…'; host.append(notes);
      }}
    ];
  }
  function native(id, title, node) {
    node.classList.add('ol-area-native-content');
    return {id,title,element:node};
  }
  function attach(id, root, types, tree) {
    root.classList.add('ol-tool-areas');
    root.dataset.toolAreas = id;
    const manager = areas.install({id,root,types:types.concat(extraTypes()),tree});
    /* Timeline's canvases and Forge's wires already redraw on window resize.
     * Area dividers change their containers without resizing the window. */
    let frame = null;
    const refresh = () => {
      if (frame !== null) return;
      frame = global.requestAnimationFrame(() => {
        frame = null; global.dispatchEvent(new global.Event('resize'));
      });
    };
    const observer = new global.ResizeObserver(refresh);
    types.forEach(type => observer.observe(type.element));
    refresh();
    global.addEventListener('pagehide',() => {
      observer.disconnect(); if (frame !== null) global.cancelAnimationFrame(frame);
    },{once:true});
    return manager;
  }
  function installTimeline() {
    const existing = areas.get('timeline'); if (existing) return existing;
    const root = doc.querySelector('#timelineRoot .tl-main');
    const browser = root && root.querySelector(':scope > .tl-browser');
    const editor = root && root.querySelector(':scope > .tl-workspace');
    const inspector = root && root.querySelector(':scope > .tl-inspector');
    if (!browser || !editor || !inspector) return null;
    const total = root.getBoundingClientRect().width;
    const leftWidth = browser.getBoundingClientRect().width || 218;
    const rightWidth = inspector.getBoundingClientRect().width || 264;
    return attach('timeline',root,[
      native('timeline-tracks','Tracks',browser),
      native('timeline-editor','Timeline',editor),
      native('timeline-properties','Properties',inspector)
    ],{axis:'row',ratio:usableRatio(leftWidth,total,.17),children:['timeline-tracks',{
      axis:'row',ratio:usableRatio(Math.max(1,total-leftWidth-rightWidth),total-leftWidth,.75),
      children:['timeline-editor','timeline-properties']
    }]});
  }
  function installForge() {
    const existing = areas.get('forge'); if (existing) return existing;
    const root = doc.querySelector('#wireRoot .w-main');
    const library = root && root.querySelector(':scope > .w-lib');
    const editor = root && root.querySelector(':scope > #canvasWrap');
    const inspector = root && root.querySelector(':scope > .w-side');
    if (!library || !editor || !inspector) return null;
    const total = root.getBoundingClientRect().width;
    const leftWidth = library.getBoundingClientRect().width || 210;
    const rightWidth = inspector.getBoundingClientRect().width || 290;
    const monitor = inspector.querySelector(':scope > .w-mon');
    const types = [native('forge-library','Node Library',library),native('forge-editor','Nodes',editor),native('forge-properties','Properties',inspector)];
    let rightTree = 'forge-properties';
    if (monitor) {
      const monitorHeight = monitor.getBoundingClientRect().height || 176;
      const totalHeight = root.getBoundingClientRect().height;
      monitor.classList.add('ol-tool-preview');
      types.push(native('forge-monitor','Monitor',monitor));
      rightTree = {axis:'column',ratio:usableRatio(Math.max(1,totalHeight-monitorHeight),totalHeight,.70),children:['forge-properties','forge-monitor']};
    }
    return attach('forge',root,types,{axis:'row',ratio:usableRatio(leftWidth,total,.17),children:['forge-library',{
      axis:'row',ratio:usableRatio(Math.max(1,total-leftWidth-rightWidth),total-leftWidth,.72),children:['forge-editor',rightTree]
    }]});
  }
  function installMap() {
    const existing = areas.get('map'); if (existing) return existing;
    const root = doc.querySelector('#aoHost > .ao-main');
    const screens = root && root.querySelector(':scope > .ao-tree');
    const stage = root && root.querySelector(':scope > .oo-split');
    const inspector = root && root.querySelector(':scope > .ao-side');
    if (!screens || !stage || !inspector) return null;
    const total = root.getBoundingClientRect().width;
    const leftWidth = screens.getBoundingClientRect().width || 214;
    const rightWidth = inspector.getBoundingClientRect().width || 216;
    return attach('map',root,[
      native('map-screens','Screens & Slices',screens),
      native('map-stage','Mapping Stage',stage),
      native('map-properties','Properties',inspector)
    ],{axis:'row',ratio:usableRatio(leftWidth,total,.17),children:['map-screens',{
      axis:'row',ratio:usableRatio(Math.max(1,total-leftWidth-rightWidth),total-leftWidth,.78),children:['map-stage','map-properties']
    }]});
  }
  function installEncode() {
    const existing = areas.get('encode'); if (existing) return existing;
    const root = doc.querySelector('#alleyRoot .a-main');
    const files = root && root.querySelector(':scope > #aList');
    const inspector = root && root.querySelector(':scope > .a-side');
    if (!files || !inspector) return null;
    const total = root.getBoundingClientRect().width;
    const sideWidth = inspector.getBoundingClientRect().width || 332;
    const monitor = inspector.querySelector(':scope > #monWrap');
    const trim = inspector.querySelector(':scope > #trim');
    const types = [native('encode-files','Files & Queue',files),native('encode-properties','Conversion Settings',inspector)];
    let sideTree = 'encode-properties';
    if (monitor) {
      /* Preserve the a-side ancestor used by Encode's monitor CSS. All native
       * references (prevCanvas, monWrap, trim) still point to the same nodes. */
      const preview = element('div','a-side ol-tool-encode-preview');
      preview.append(monitor); if (trim) preview.append(trim);
      types.push(native('encode-monitor','Source Monitor',preview));
      sideTree = {axis:'column',ratio:.36,children:['encode-monitor','encode-properties']};
    }
    return attach('encode',root,types,{axis:'row',ratio:usableRatio(Math.max(1,total-sideWidth),total,.74),children:['encode-files',sideTree]});
  }
  function installOther() {
    return [installTimeline(),installForge(),installMap(),installEncode()].filter(Boolean);
  }
  global.OpenLiveToolAreas = Object.freeze({installOther,installTimeline,installForge,installMap,installEncode});
  const route = String(global.location && global.location.pathname || '').split('/').pop().toLowerCase();
  const expected = {'timeline.html':'timeline','wire.html':'forge','advanced-output.html':'map','alley.html':'encode'}[route];
  let pendingObserver = null;
  function ready() {
    installOther();
    if (!expected || areas.get(expected)) {
      if (pendingObserver) pendingObserver.disconnect(); pendingObserver = null; return;
    }
    /* Map mounts its native regions from its own startup script. Observe only
     * while this route's editor is absent, then stop as soon as it is attached. */
    if (!pendingObserver) {
      pendingObserver = new global.MutationObserver(ready);
      pendingObserver.observe(doc.documentElement,{childList:true,subtree:true});
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded',ready,{once:true});
  else ready();
  global.addEventListener('pagehide',() => { if (pendingObserver) pendingObserver.disconnect(); pendingObserver = null; },{once:true});
})(window);
