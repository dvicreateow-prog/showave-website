/* Saved browser-Studio chooser. This module creates local draft documents only;
   capture permission, account connection, metadata delivery and Go Live remain
   explicit actions inside Broadcast. */
window.OpenLiveStudioLauncher = (() => {
'use strict';

const CARDS = Object.freeze([
  Object.freeze({ id:'studio', title:'SHOWAVE Studio', mode:'live', supported:true,
    mark:'◉', summary:'Go live or record from your browser with scenes, guests and graphics.' }),
  Object.freeze({ id:'webinar', title:'Webinar', supported:false, mark:'▣',
    summary:'A closed attendee room needs a public identity, attendee access and webinar backend that this build does not have.' }),
  Object.freeze({ id:'encoder', title:'Encoder stream', supported:false, mark:'⇢',
    summary:'Incoming RTMP/SRT encoder ingest is not implemented. Custom Output sends media out; it is not an encoder input.' }),
  Object.freeze({ id:'prerecorded', title:'Prerecorded event', supported:false, mark:'▷',
    summary:'Unattended playback needs durable upload storage and a scheduler, neither of which is implemented.' })
]);

const cleanError = error => String(error && error.message || error || 'The Studio could not be opened.');

function lockReason(check) {
  let value;
  try { value = typeof check === 'function' ? check() : check; }
  catch (error) { return cleanError(error); }
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value === true) return 'End the current programme run before changing Studio drafts.';
  return value.locked === false ? '' : String(value.reason ||
    'End the current programme run before changing Studio drafts.');
}

function createController(options) {
  const opts = options || {}, store = opts.store;
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function' ||
      typeof store.create !== 'function') throw new Error('A Studio draft store is required.');
  if (typeof opts.navigate !== 'function') throw new Error('A Studio navigation function is required.');
  const listeners = new Set();
  // These values belong only to the uncommitted new-Studio form. Reopening a
  // saved Studio reads its document; temporary entries never patch that owner.
  let state = { step:'choose', mode:'live', title:'', description:'', message:'' };

  const emit = () => {
    const snapshot = getState();
    listeners.forEach(listener => { try { listener(snapshot); } catch (_) {} });
    return snapshot;
  };
  const set = patch => { state = Object.assign({}, state, patch || {}); return emit(); };
  const route = id => 'broadcast.html?studio=' + encodeURIComponent(id);

  function getState() {
    let drafts = [], error = '';
    try { drafts = store.list(); }
    catch (failure) { error = cleanError(failure); }
    return {
      step:state.step, mode:state.mode, title:state.title, description:state.description,
      message:state.message || error,
      cards:CARDS, drafts, currentId:String(opts.currentId || '')
    };
  }

  function choose(id) {
    const card = CARDS.find(item => item.id === id);
    if (!card) return { ok:false, error:'That stream type is not available.' };
    if (!card.supported) {
      set({ message:card.summary });
      return { ok:false, error:card.summary, unsupported:true };
    }
    set({ step:'details', message:'' });
    return { ok:true, mode:state.mode };
  }

  function setMode(mode) {
    if (!['live', 'record'].includes(mode)) return false;
    set({ mode, message:'' }); return true;
  }

  function setDraftDetails(input) {
    const value = input || {}, patch = {};
    ['title','description'].forEach(key => {
      if (Object.hasOwn(value, key)) patch[key] = String(value[key] == null ? '' : value[key]);
    });
    set(patch);
  }

  function back() { set({ step:'choose', message:'' }); }

  function allowed() {
    const reason = lockReason(opts.locked);
    if (!reason) return true;
    set({ message:reason }); return false;
  }

  function submit(input) {
    const value = input || {};
    setDraftDetails(value);
    if (['live','record'].includes(value.mode)) setMode(value.mode);
    if (!allowed()) return { ok:false, error:state.message, locked:true };
    try {
      const draft = store.create({
        title:state.title, description:state.description, mode:value.mode || state.mode
      });
      opts.navigate(route(draft.id), draft);
      set({ step:'choose', mode:'live', title:'', description:'', message:'' });
      return { ok:true, draft };
    } catch (error) {
      const message = cleanError(error); set({ message }); return { ok:false, error:message };
    }
  }

  function reopen(id) {
    if (!allowed()) return { ok:false, error:state.message, locked:true };
    try {
      const draft = store.get(id);
      if (!draft) throw new Error('That saved Studio is missing or damaged.');
      opts.navigate(route(draft.id), draft);
      return { ok:true, draft };
    } catch (error) {
      const message = cleanError(error); set({ message }); return { ok:false, error:message };
    }
  }

  function reopenLegacy() {
    if (!allowed()) return { ok:false, error:state.message, locked:true };
    try {
      opts.navigate('broadcast.html', { id:'', title:'Original Studio', mode:'live', legacy:true });
      return { ok:true, legacy:true };
    } catch (error) {
      const message = cleanError(error); set({ message }); return { ok:false, error:message };
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener); return () => listeners.delete(listener);
  }

  return { getState, choose, setMode, setDraftDetails, back, submit, reopen, reopenLegacy, subscribe };
}

function append(document, tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function create(options) {
  const opts = options || {}, document = opts.document || window.document;
  const controller = createController(opts);
  let dialog = null, body = null, status = null, returnFocus = null, renderedStep = '';

  function rememberDetails() {
    if (!body || renderedStep !== 'details') return;
    const title = body.querySelector('#studioDraftTitle'), description = body.querySelector('[name="description"]');
    if (title && description) controller.setDraftDetails({title:title.value,description:description.value});
  }

  function focusFirst(selector) {
    setTimeout(() => {
      const target = dialog && dialog.querySelector(selector || 'button:not([disabled]),input,textarea');
      if (target) target.focus();
    }, 0);
  }

  function renderChoose(snapshot) {
    const intro = append(document, 'p', 'studio-launcher-intro', body,
      'Choose a workflow. Creating a draft does not request a camera, contact a platform, or start a broadcast.');
    intro.id = 'studioLauncherDescription';
    const grid = append(document, 'div', 'studio-launcher-grid', body);
    snapshot.cards.forEach((card, index) => {
      const button = append(document, 'button', 'studio-launcher-card' +
        (card.supported ? '' : ' is-unavailable') + (index === 0 ? ' is-featured' : ''), grid);
      button.type = 'button'; button.dataset.workflow = card.id;
      if (!card.supported) button.setAttribute('aria-disabled', 'true');
      append(document, 'span', 'studio-launcher-mark', button, card.mark);
      const copy = append(document, 'span', 'studio-launcher-cardcopy', button);
      append(document, 'strong', '', copy, card.title);
      append(document, 'small', '', copy, card.summary);
      append(document, 'span', 'studio-launcher-state', button, card.supported ? 'Create' : 'Unavailable');
      button.addEventListener('click', () => {
        const result = controller.choose(card.id);
        if (result.ok) focusFirst('#studioDraftTitle');
      });
    });

    append(document, 'h3', 'studio-launcher-subhead', body, 'Your studios');
    const saved = append(document, 'div', 'studio-launcher-saved', body);
    const legacy = append(document, 'button', 'studio-launcher-savedcard', saved);
    legacy.type = 'button'; legacy.dataset.studioId = 'legacy';
    if (!snapshot.currentId) legacy.dataset.current = 'true';
    const legacyCopy = append(document, 'span', '', legacy);
    append(document, 'strong', '', legacyCopy, 'Original Studio');
    append(document, 'small', '', legacyCopy, 'Existing unscoped Studio workspace');
    append(document, 'span', 'studio-launcher-open', legacy, snapshot.currentId ? 'Open' : 'Current');
    legacy.addEventListener('click', () => controller.reopenLegacy());
    if (!snapshot.drafts.length) append(document, 'p', 'studio-launcher-empty', saved,
      'No independently saved browser Studios yet. Create one above.');
    snapshot.drafts.forEach(draft => {
      const button = append(document, 'button', 'studio-launcher-savedcard', saved);
      button.type = 'button'; button.dataset.studioId = draft.id;
      if (draft.id === snapshot.currentId) button.dataset.current = 'true';
      const copy = append(document, 'span', '', button);
      append(document, 'strong', '', copy, draft.title || 'Untitled Studio');
      append(document, 'small', '', copy, (draft.mode === 'record' ? 'Record Only' : 'Live Stream') +
        (draft.description ? ' · ' + draft.description : ''));
      append(document, 'span', 'studio-launcher-open', button,
        draft.id === snapshot.currentId ? 'Current' : 'Open');
      button.addEventListener('click', () => controller.reopen(draft.id));
    });
  }

  function renderDetails(snapshot) {
    const back = append(document, 'button', 'studio-launcher-back', body, '← Back');
    back.type = 'button'; back.addEventListener('click', () => { rememberDetails(); controller.back(); focusFirst('[data-workflow="studio"]'); });
    const heading = append(document, 'h3', 'studio-launcher-formtitle', body,
      snapshot.mode === 'record' ? 'Create a recording Studio' : 'Create a live Studio');
    heading.dataset.role = 'mode-heading';
    const form = append(document, 'form', 'studio-launcher-form', body);
    const titleLabel = append(document, 'label', '', form, 'Title');
    const title = append(document, 'input', '', titleLabel); title.id = 'studioDraftTitle';
    title.name = 'title'; title.type = 'text'; title.maxLength = 200;
    title.placeholder = 'Live with SHOWAVE'; title.value = snapshot.title;
    const descriptionLabel = append(document, 'label', '', form, 'Description');
    const description = append(document, 'textarea', '', descriptionLabel);
    description.name = 'description'; description.maxLength = 5000; description.rows = 4;
    description.placeholder = 'What is this stream about?'; description.value = snapshot.description;
    [title,description].forEach(input => input.addEventListener('input', () => rememberDetails()));
    const modes = append(document, 'fieldset', 'studio-launcher-modes', form);
    append(document, 'legend', '', modes, 'Mode');
    [['live','Live Stream'],['record','Record Only']].forEach(([value, label]) => {
      const wrapper = append(document, 'label', '', modes);
      const radio = append(document, 'input', '', wrapper); radio.type = 'radio'; radio.name = 'mode';
      radio.value = value; radio.checked = snapshot.mode === value;
      radio.addEventListener('change', () => controller.setMode(value));
      wrapper.appendChild(document.createTextNode(label));
    });
    const disclosure = append(document, 'p', 'studio-launcher-disclosure', form,
      snapshot.mode === 'record'
        ? 'Record Only keeps every destination off. You still press Record after preparing the programme.'
        : 'The draft opens off air. Connect channels and press Go Live only when ready.');
    const actions = append(document, 'div', 'studio-launcher-actions', form);
    const cancel = append(document, 'button', '', actions, 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    const submit = append(document, 'button', 'primary', actions,
      snapshot.mode === 'record' ? 'Create recording Studio' : 'Create Studio');
    submit.type = 'submit'; submit.dataset.role = 'create-studio';
    disclosure.dataset.role = 'mode-disclosure';
    append(document, 'p', 'studio-launcher-disclosure', form,
      'Back or Close keeps these entries on this page. Create Studio saves a reusable draft.');
    form.addEventListener('submit', event => {
      event.preventDefault();
      const selected = form.querySelector('input[name="mode"]:checked');
      controller.submit({ title:title.value, description:description.value,
        mode:selected ? selected.value : snapshot.mode });
    });
  }

  function sync(snapshot) {
    if (!body) return;
    if (renderedStep !== snapshot.step) { render(snapshot); return; }
    status.textContent = snapshot.message || '';
    if (snapshot.step !== 'details') return;
    body.querySelectorAll('input[name="mode"]').forEach(radio => {
      radio.checked = radio.value === snapshot.mode;
    });
    const heading = body.querySelector('[data-role="mode-heading"]');
    if (heading) heading.textContent = snapshot.mode === 'record' ? 'Create a recording Studio' : 'Create a live Studio';
    const disclosure = body.querySelector('[data-role="mode-disclosure"]');
    if (disclosure) disclosure.textContent = snapshot.mode === 'record'
      ? 'Record Only keeps every destination off. You still press Record after preparing the programme.'
      : 'The draft opens off air. Connect channels and press Go Live only when ready.';
    const submit = body.querySelector('[data-role="create-studio"]');
    if (submit) submit.textContent = snapshot.mode === 'record' ? 'Create recording Studio' : 'Create Studio';
  }

  function render(snapshot) {
    if (!body) return;
    body.textContent = '';
    snapshot = snapshot || controller.getState();
    renderedStep = snapshot.step;
    if (snapshot.step === 'choose') dialog.setAttribute('aria-describedby', 'studioLauncherDescription');
    else dialog.removeAttribute('aria-describedby');
    if (snapshot.step === 'details') renderDetails(snapshot); else renderChoose(snapshot);
    status.textContent = snapshot.message || '';
  }

  function build() {
    if (dialog) return dialog;
    dialog = append(document, 'dialog', 'studio-launcher-dialog', document.body);
    dialog.id = 'studioLauncherDialog'; dialog.setAttribute('aria-labelledby', 'studioLauncherTitle');
    dialog.setAttribute('aria-describedby', 'studioLauncherDescription');
    const header = append(document, 'header', 'studio-launcher-head', dialog);
    const titles = append(document, 'span', '', header);
    const eyebrow = append(document, 'small', '', titles, 'SHOWAVE Broadcast');
    eyebrow.setAttribute('aria-hidden', 'true');
    const title = append(document, 'h2', '', titles, 'Create a new stream'); title.id = 'studioLauncherTitle';
    const closeButton = append(document, 'button', 'studio-launcher-close', header, '×');
    closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close Create stream');
    closeButton.addEventListener('click', close);
    body = append(document, 'div', 'studio-launcher-body', dialog);
    status = append(document, 'p', 'studio-launcher-status', dialog); status.setAttribute('role', 'status');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    controller.subscribe(sync);
    render(); return dialog;
  }

  function open(opener) {
    build(); returnFocus = opener || document.activeElement;
    rememberDetails();
    controller.back(); render();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    focusFirst('[data-workflow="studio"]');
  }

  function close() {
    if (!dialog) return;
    rememberDetails();
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  function mount(trigger) {
    build();
    if (trigger) trigger.addEventListener('click', () => open(trigger));
    return api;
  }

  const api = { controller, mount, open, close, get element() { return dialog; } };
  return api;
}

function showFatal(document, message) {
  const existing = document.getElementById('studioLauncherFatal');
  if (existing) return existing;
  const dialog = append(document, 'dialog', 'studio-launcher-dialog studio-launcher-fatal', document.body);
  dialog.id = 'studioLauncherFatal'; dialog.setAttribute('aria-labelledby', 'studioLauncherFatalTitle');
  const title = append(document, 'h2', '', dialog, 'Studio draft cannot open');
  title.id = 'studioLauncherFatalTitle';
  append(document, 'p', '', dialog, cleanError(message));
  const link = append(document, 'a', 'studio-launcher-return', dialog, 'Return to Create stream');
  link.href = 'broadcast.html';
  dialog.addEventListener('cancel', event => event.preventDefault());
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  setTimeout(() => link.focus(), 0);
  return dialog;
}

return { CARDS, createController, create, showFatal };
})();
