/* One editor, two locations. Moving the existing DOM retains staged fields and
 * uses exactly the same scene transactions as the Layout library. No asset copy. */
window.OpenLiveSvgPartsPanel = (() => {
  'use strict';
  const mounts = new WeakMap();
  const labels = {all:'All pieces',backgrounds:'Backgrounds',feeds:'Feed frames',
    'lower-thirds':'Lower thirds',logos:'Logos',headlines:'Headlines',
    'live-badges':'Streaming LIVE badges',qr:'QR codes',text:'Texts'};
  function mount({document:doc, library, gallery, target, getContext, restoreFocus, beforeOpen,onOpenChange} = {}) {
    if (!doc || !library?.parentNode || !gallery) throw new Error('The SVG piece editor is unavailable.');
    if (mounts.has(library)) return mounts.get(library);
    const home = library.parentNode, anchor = doc.createElement('div'), panel = doc.createElement('aside');
    let destroyed = false, opened = false, closing = false, owner = null, opener = null, returnTo = null, ownsReturnFocus = false, focusRequest = 0;
    anchor.className = 'svg-parts-panel-anchor'; anchor.hidden = true;
    const returnButton = doc.createElement('button'); returnButton.type = 'button';
    returnButton.className = 'production-button'; returnButton.textContent = 'Return SVG editor to Layout';
    anchor.appendChild(returnButton); home.insertBefore(anchor, library);
    panel.id = 'svgPartsPanel'; panel.className = 'svg-parts-panel' + (target ? ' is-docked' : ''); panel.hidden = true;
    panel.setAttribute('role',target ? 'region' : 'dialog');
    if (!target) panel.setAttribute('aria-modal','false');
    panel.setAttribute('aria-labelledby','svgPartsPanelTitle');
    const header = doc.createElement('header'), title = doc.createElement('h2');
    title.id = 'svgPartsPanelTitle'; title.tabIndex = -1;
    const back = doc.createElement('button'), closeButton = doc.createElement('button');
    back.type = closeButton.type = 'button'; back.className = 'production-button';
    closeButton.className = 'production-button'; closeButton.textContent = '×';
    closeButton.setAttribute('aria-label','Close SVG piece editor');
    header.appendChild(back); header.appendChild(title); header.appendChild(closeButton);
    const note = doc.createElement('p'); note.className = 'production-note svg-parts-panel-help';
    const defaultHelp = target ? 'Browse → customise → Add a copy to Preview. Saved layer edits save automatically. Cut/Fade publishes Preview.' : 'Browse → customize → Add. For a saved layer, change Show piece then Apply to show or hide it. Changes target the scene named below; in Studio mode that is Preview. Closing does not apply drafts.';
    note.textContent = defaultHelp;
    const body = doc.createElement('div'); body.className = 'svg-parts-panel-body';
    panel.appendChild(header); panel.appendChild(note); panel.appendChild(body); (target || doc.body).appendChild(panel);
    const readContext = () => typeof getContext === 'function' ? getContext() : null;
    const available = value => !getContext || !!value?.scene && value.enabled !== false;
    const matches = value => available(value) && (!getContext || owner?.scene === value.scene && owner.layout === value.layout && owner.mode === value.mode);
    function refresh() {
      if (!opened || closing) return false;
      if (!matches(readContext())) { close({restore:false,focus:false}); return false; }
      return true;
    }
    function close({restore = true, focus = true} = {}) {
      ++focusRequest;
      if (!opened || closing) return;
      if (!matches(readContext())) restore = false;
      closing = true;
      gallery.cancel(); // Invalidate in-flight Apply/preview; never commit from a closed editor.
      home.insertBefore(library, anchor); anchor.hidden = true; panel.hidden = true;
      opened = false; owner = null; closing = false;
      onOpenChange?.(false);
      const callback = returnTo, previous = opener, callbackOwnsFocus = ownsReturnFocus; returnTo = null; opener = null; ownsReturnFocus = false;
      if (restore && callback) callback();
      if (focus && !(restore && callback && callbackOwnsFocus)) {
        const request = ++focusRequest;
        const restoreOpenerFocus = () => {
          if (destroyed || !panel.hidden || request !== focusRequest) return;
          if (restore && previous?.isConnected && !previous.closest?.('[hidden]')) previous.focus();
          else if (!(restore && callback)) {
            if (target && restoreFocus) restoreFocus();
            else library.focus({preventScroll:true});
          }
        };
        // Origin panels schedule their heading focus. Restore the exact launcher
        // after that frame, without stealing focus if another editor has opened.
        if (doc.defaultView?.requestAnimationFrame) doc.defaultView.requestAnimationFrame(restoreOpenerFocus);
        else restoreOpenerFocus();
      }
    }
    function open(category = 'all', context = {}) {
      if (destroyed) return false;
      refresh();
      const requested = readContext();
      if (!available(requested)) return false;
      ++focusRequest;
      const key = Object.prototype.hasOwnProperty.call(labels, category) ? category : 'all';
      if (beforeOpen?.() === false) return false;
      const current = typeof getContext === 'function' ? getContext() : null;
      if (!available(current) || getContext && (current.scene !== requested.scene || current.layout !== requested.layout || current.mode !== requested.mode)) return false;
      if (!opened || context.returnTo || (context.opener && !panel.contains(context.opener))) {
        opener = context.opener || doc.activeElement;
        returnTo = typeof context.returnTo === 'function' ? context.returnTo : null;
        ownsReturnFocus = !!returnTo && context.ownsReturnFocus === true;
        back.textContent = returnTo ? '← ' + (context.returnLabel || 'Back') : target ? '← Sources' : '← Layout';
      }
      owner = getContext ? {scene:current.scene,layout:current.layout,mode:current.mode} : null;
      gallery.setInspectorTarget?.(null);
      body.appendChild(library); anchor.hidden = false; panel.hidden = false; opened = true;
      title.textContent = typeof context.title === 'string' && context.title.trim() ? context.title.trim() : 'SVG pieces · ' + labels[key];
      note.textContent = typeof context.help === 'string' && context.help.trim() ? context.help.trim() : defaultHelp;
      gallery.refresh(); gallery.selectCategory(key, {allPages:true,showPieces:true});
      onOpenChange?.(true);
      title.focus({preventScroll:true}); body.scrollTop = 0; return true;
    }
    const onEdit = event => {
      if (!opened || closing || !refresh()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    if (getContext) for (const type of ['click','input','change','submit']) panel.addEventListener(type,onEdit,true);
    const onClose = () => close(), onReturn = () => close({restore:false});
    const onKey = event => {
      if (event.key === 'Escape' && !panel.hidden && !event.defaultPrevented) {
        event.preventDefault(); close();
      }
    };
    closeButton.addEventListener('click', onClose); back.addEventListener('click', onClose);
    returnButton.addEventListener('click', onReturn); doc.addEventListener('keydown', onKey);
    const api = {open,close,refresh,isOpen:()=>opened,destroy() {
      if (destroyed) return; close({restore:false,focus:false}); destroyed = true;
      closeButton.removeEventListener('click',onClose); back.removeEventListener('click',onClose);
      returnButton.removeEventListener('click',onReturn); doc.removeEventListener('keydown',onKey);
      if (getContext) for (const type of ['click','input','change','submit']) panel.removeEventListener(type,onEdit,true);
      anchor.remove(); panel.remove(); mounts.delete(library);
    }};
    mounts.set(library, api); return api;
  }
  return Object.freeze({mount});
})();
