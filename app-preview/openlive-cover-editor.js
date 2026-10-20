/* A local cover chooser and crop preview. Only Save changes the preference. */
(function installCoverEditor(global) {
  'use strict';
  if (global.OpenLiveCoverEditor) return;
  let session = null, draft = null, request = null, generation = 0, saving = false;
  let pose = { zoom: 1, x: .5, y: .5, rotation: 0 }, geometry = null, drag = null;
  const backdrop = document.createElement('div');
  backdrop.id = 'showave-cover-editor-backdrop';
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section id="showave-cover-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="showave-cover-editor-title">
      <header><div><h2 id="showave-cover-editor-title">Cover image</h2><p>Select a picture, then adjust how it fills your cover.</p></div><button id="showave-cover-editor-close" type="button" title="Close cover editor" aria-label="Close cover editor">×</button></header>
      <div id="showave-cover-editor-choices">
        <button id="showave-cover-editor-upload" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v14H4zM7 16l4-4 3 3 2-2 4 4M12 3v7M9 6l3-3 3 3"/></svg><span>Upload from device</span><small>JPEG, PNG, WebP or GIF · up to 25 MB</small></button>
        <h3>Default images</h3><div class="showave-cover-choices">
          <button id="showave-cover-choice-1" type="button"><img alt="First default cover"><span>Original colours</span><small>Adjust this image</small></button>
          <button id="showave-cover-choice-2" type="button"><img alt="Second default cover"><span>Muted colours</span><small>Adjust this image</small></button>
          <button id="showave-cover-choice-current" type="button" hidden><img alt="Your current cover"><span>Current cover</span><small>Adjust your saved image</small></button>
        </div>
        <button id="showave-cover-choice-defaults" type="button">Use the default slideshow</button>
      </div>
      <div id="showave-cover-editor-adjust" hidden>
        <button id="showave-cover-editor-back" type="button">‹ Choose another image</button>
        <div class="showave-cover-crop"><canvas id="showave-cover-editor-canvas" width="640" height="320" tabindex="0" aria-label="Cover crop preview. Drag to position the image or use the position sliders."></canvas><div class="showave-cover-crop-guides" aria-hidden="true"></div><div class="showave-cover-crop-identity" aria-hidden="true"><strong>SHOWAVE</strong><small class="showave-cover-crop-version">0.1.0-preview.6</small><span>Godrick Sakonfa<small>Afro Unity Ground</small></span></div></div>
        <p id="showave-cover-editor-name"></p><p class="showave-cover-hint">Drag the image to frame it. Your cover keeps its SHOWAVE identity overlay.</p>
        <div class="showave-cover-adjustments">
          <label for="showave-cover-editor-zoom">Zoom <output id="showave-cover-editor-zoom-value">100%</output></label><input id="showave-cover-editor-zoom" type="range" min="1" max="5" step=".01" value="1">
          <label for="showave-cover-editor-x">Horizontal position</label><input id="showave-cover-editor-x" type="range" min="0" max="100" step="1" value="50">
          <label for="showave-cover-editor-y">Vertical position</label><input id="showave-cover-editor-y" type="range" min="0" max="100" step="1" value="50">
        </div>
        <div class="showave-cover-adjust-actions"><button id="showave-cover-editor-rotate" type="button">Rotate 90°</button><button id="showave-cover-editor-adjust-reset" type="button">Reset adjustments</button></div>
      </div>
      <p id="showave-cover-editor-status" role="status" aria-live="polite"></p>
      <footer><button id="showave-cover-editor-cancel" type="button">Cancel</button><button id="showave-cover-editor-save" type="button" disabled>Save cover</button></footer>
    </section>`;
  document.body.append(backdrop);
  const $ = suffix => document.getElementById('showave-cover-' + suffix);
  const canvas = $('editor-canvas');
  function message(value, error) { $('editor-status').textContent = value || ''; $('editor-status').classList.toggle('is-error', !!error); }
  function discard() {
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    request?.abort(); request = null; generation++; draft?.dispose(); draft = null; geometry = null; drag = null;
  }
  function buttons() {
    for (const button of backdrop.querySelectorAll('button')) button.disabled = saving;
    $('editor-save').disabled = saving || !draft;
    for (const slider of backdrop.querySelectorAll('input[type="range"]')) slider.disabled = saving || !draft;
  }
  function paint() {
    if (!draft) return;
    geometry = draft.draw(canvas, pose);
    $('editor-zoom').value = pose.zoom; $('editor-x').value = Math.round(pose.x * 100); $('editor-y').value = Math.round(pose.y * 100);
    $('editor-zoom-value').textContent = Math.round(pose.zoom * 100) + '%';
    canvas.setAttribute('aria-valuetext', 'Zoom ' + Math.round(pose.zoom * 100) + ' percent, rotation ' + pose.rotation + ' degrees');
  }
  function choices() {
    if (saving) return;
    discard(); $('editor-adjust').hidden = true; $('editor-choices').hidden = false;
    message(''); buttons();
    if (!backdrop.hidden) $('editor-upload').focus();
  }
  function restoreFocus() {
    if (!session || backdrop.hidden) return;
    const previous = session.lastFocus;
    const target = previous?.isConnected && !previous.disabled && previous.getClientRects().length ? previous :
      [...backdrop.querySelectorAll('button:not([disabled]), input:not([disabled]), canvas')].find(item => item.getClientRects().length);
    target?.focus({ preventScroll: true });
  }
  let homeMount = null;
  function enterHomeEditMode() {
    const panel = document.getElementById('showave-start-panel');
    if (!panel || panel.closest('[hidden]')) return;
    const dialog = $('editor-dialog');
    const upload = document.getElementById('showave-start-cover-input');
    homeMount = { panel, height: panel.style.height, overflow: panel.style.overflow,
      label: panel.getAttribute('aria-labelledby'), scrollTop: panel.scrollTop,
      role: dialog.getAttribute('role'), modal: dialog.getAttribute('aria-modal'),
      upload: upload && { node: upload, parent: upload.parentNode, next: upload.nextSibling }, outside: [],
      children: [...panel.children].filter(node => node !== backdrop).map(node =>
        ({ node, inert: node.inert, hidden: node.getAttribute('aria-hidden') })) };
    panel.style.height = getComputedStyle(panel).height;
    panel.style.overflow = 'hidden'; panel.scrollTop = 0;
    panel.dataset.coverEditing = 'true';
    panel.setAttribute('aria-labelledby', 'showave-cover-editor-title');
    homeMount.children.forEach(({ node }) => { node.inert = true; node.setAttribute('aria-hidden', 'true'); });
    panel.append(backdrop);
    if (upload) backdrop.append(upload);
    for (let branch = panel; branch.parentElement; branch = branch.parentElement) {
      for (const node of branch.parentElement.children) if (node !== branch) {
        homeMount.outside.push({ node, inert: node.inert, hidden: node.getAttribute('aria-hidden') });
        node.inert = true; node.setAttribute('aria-hidden', 'true');
      }
      if (branch.parentElement === document.body) break;
    }
    dialog.removeAttribute('role'); dialog.removeAttribute('aria-modal');
  }
  function leaveHomeEditMode() {
    if (!homeMount) return;
    const state = homeMount; homeMount = null;
    const restore = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
    [...state.children, ...state.outside].forEach(({ node, inert, hidden }) => { node.inert = inert; restore(node, 'aria-hidden', hidden); });
    if (state.upload) state.upload.parent.insertBefore(state.upload.node,
      state.upload.next?.parentNode === state.upload.parent ? state.upload.next : null);
    state.panel.style.height = state.height; state.panel.style.overflow = state.overflow;
    delete state.panel.dataset.coverEditing;
    restore(state.panel, 'aria-labelledby', state.label);
    restore($('editor-dialog'), 'role', state.role); restore($('editor-dialog'), 'aria-modal', state.modal);
    state.panel.scrollTop = state.scrollTop;
  }
  function close() {
    if (!session || saving) return false;
    const ended = session; session = null; discard(); backdrop.hidden = true;
    $('choice-current').querySelector('img').removeAttribute('src');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    leaveHomeEditMode();
    ended.onClose?.();
    if (ended.focus?.isConnected) ended.focus.focus({ preventScroll: true });
    return true;
  }
  function open(options) {
    if (session) return;
    if (!options?.cover?.openDraft) throw new Error('The cover editor is still starting. Please try again.');
    session = { ...options, focus: document.activeElement };
    enterHomeEditMode();
    backdrop.querySelector('.showave-cover-crop-version').textContent = global.OpenLiveDesktop?.version || document.getElementById('showave-start-version')?.textContent?.trim() || '0.1.0-preview.6';
    const defaults = options.cover.defaultUrls;
    $('choice-1').querySelector('img').src = defaults[0]; $('choice-2').querySelector('img').src = defaults[1];
    const current = options.cover.get(); $('choice-current').hidden = !current.custom;
    if (current.custom) $('choice-current').querySelector('img').src = current.posterUrl || current.url;
    choices(); backdrop.hidden = false;
    requestAnimationFrame(() => { if (session) $('editor-upload').focus(); });
  }
  async function prepare(file, token, controller) {
    const owner = session;
    const value = await owner.cover.openDraft(file, { signal: controller.signal });
    if (!session || owner !== session || generation !== token) { value.dispose(); return; }
    draft = value; pose = { zoom: 1, x: .5, y: .5, rotation: 0 };
    $('editor-name').textContent = value.name; paint();
    message(value.animated ? 'Animation is paused while you adjust. Save preserves all frames and timing.' : ''); buttons(); canvas.focus();
  }
  function begin() {
    discard(); request = new AbortController();
    $('editor-adjust').hidden = false; $('editor-choices').hidden = true;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    $('editor-name').textContent = ''; message('Preparing your image…'); buttons();
    $('editor-back').focus();
    return { token: generation, controller: request };
  }
  async function editFile(file) {
    if (!session || saving) return;
    const { token, controller } = begin();
    try { await prepare(file, token, controller); }
    catch (error) { if (session && generation === token && error.name !== 'AbortError') message(error.message || 'This image could not be opened.', true); }
  }
  async function editURL(url, name) {
    if (!session || saving) return;
    const { token, controller } = begin();
    try {
      // URLs come only from the bundled pair or the service's saved Blob URL.
      const current = session.cover.get();
      if (!session.cover.defaultUrls.includes(url) && !(current.custom && current.url === url)) throw new Error('Choose a local cover image.');
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('This cover could not be opened. Try uploading the image.');
      const blob = await response.blob();
      const file = new File([blob], name, { type: blob.type });
      if (session && generation === token) await prepare(file, token, controller);
    } catch (error) { if (session && generation === token && error.name !== 'AbortError') message(error.message || 'This image could not be opened.', true); }
  }
  $('editor-upload').addEventListener('click', () => { if (!saving) session?.onUpload?.(); });
  $('choice-1').addEventListener('click', () => editURL(session.cover.defaultUrls[0], 'Default cover (original)'));
  $('choice-2').addEventListener('click', () => editURL(session.cover.defaultUrls[1], 'Default cover (muted)'));
  $('choice-current').addEventListener('click', () => editURL(session.cover.get().url, session.cover.get().name));
  $('choice-defaults').addEventListener('click', async () => {
    if (!session || saving) return;
    saving = true; buttons(); message('Restoring the default images…');
    try { const value = await session.cover.reset(); session.onSaved?.(value); saving = false; close(); }
    catch (error) { saving = false; buttons(); message(error.message || 'The defaults could not be restored.', true); }
  });
  $('editor-save').addEventListener('click', async () => {
    if (!draft || saving || !session) return;
    saving = true; buttons(); message('Saving your cover…');
    try { const value = await session.cover.commitDraft(draft, pose); session.onSaved?.(value); saving = false; close(); }
    catch (error) { saving = false; buttons(); message(error.message || 'Your cover could not be saved. Try again.', true); }
  });
  for (const name of ['close', 'cancel']) $('editor-' + name).addEventListener('click', close);
  $('editor-back').addEventListener('click', choices);
  for (const [id, key, factor] of [['zoom','zoom',1],['x','x',.01],['y','y',.01]]) $('editor-' + id).addEventListener('input', event => {
    if (!draft || saving) return; pose[key] = Number(event.target.value) * factor; paint();
  });
  $('editor-rotate').addEventListener('click', () => { if (draft && !saving) { pose.rotation = (pose.rotation + 90) % 360; paint(); } });
  $('editor-adjust-reset').addEventListener('click', () => { if (draft && !saving) { pose = { zoom: 1, x: .5, y: .5, rotation: 0 }; paint(); } });
  const clamp = number => Math.max(0, Math.min(1, number));
  canvas.addEventListener('pointerdown', event => {
    if (!draft || saving || event.button !== 0) return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pose: { ...pose }, geometry };
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId || !draft || saving) return;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    if (drag.geometry.overflowX > .01) pose.x = clamp(drag.pose.x - (event.clientX - drag.x) * scale / drag.geometry.overflowX);
    if (drag.geometry.overflowY > .01) pose.y = clamp(drag.pose.y - (event.clientY - drag.y) * scale / drag.geometry.overflowY);
    paint();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { drag = null; });
  canvas.addEventListener('keydown', event => {
    if (!draft || saving || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const step = event.shiftKey ? .1 : .01;
    if (event.key === 'ArrowLeft') pose.x = clamp(pose.x + step);
    if (event.key === 'ArrowRight') pose.x = clamp(pose.x - step);
    if (event.key === 'ArrowUp') pose.y = clamp(pose.y + step);
    if (event.key === 'ArrowDown') pose.y = clamp(pose.y - step);
    paint();
  });
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('focusin', event => { if (session) session.lastFocus = event.target; });
  backdrop.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...backdrop.querySelectorAll('button:not([disabled]), input:not([disabled]), canvas')].filter(item => item.getClientRects().length);
    const first = items[0], last = items[items.length - 1];
    if (!items.includes(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  global.addEventListener('pagehide', () => { if (!close()) discard(); });
  global.addEventListener('pageshow', event => { if (event.persisted && session && !saving) close(); });
  global.OpenLiveCoverEditor = Object.freeze({ open, editFile, close, restoreFocus, isOpen: () => !!session });
})(window);
