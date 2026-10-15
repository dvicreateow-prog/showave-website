import { TRACKS, ACTIVITY_TYPES, STORAGE_KEY, MAX_DRAFTS, todayISO, authorIdentity, readDrafts, serializeDrafts, upsertDraft, filterDrafts, exportDrafts } from './academy-model.js';

const root = document.querySelector('.academy-page');
if (root) {
  const get = id => root.querySelector(`#${id}`);
  const form = get('academy-draft-form');
  const fields = {
    title: get('academy-title'), summary: get('academy-summary'), track: get('academy-track'),
    kind: get('academy-kind'), date: get('academy-date'), name: get('academy-name'),
    consent: get('academy-consent'), videoUrl: get('academy-video-url')
  };
  const list = get('academy-activity-list');
  const status = get('academy-form-status');
  const storageStatus = get('academy-storage-status');
  const errors = get('academy-form-errors');
  let drafts = [], editingId = null, storageAvailable = true, previewUrl = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function link(text, href, external = false) {
    const node = element('a', 'academy-text-link', text);
    node.href = href;
    node.dataset.barbaPrevent = 'all';
    if (external) { node.target = '_blank'; node.rel = 'noopener noreferrer'; node.referrerPolicy = 'no-referrer'; }
    return node;
  }
  function button(text, action, id) {
    const node = element('button', 'academy-small-button', text);
    node.type = 'button'; node.dataset.academyAction = action; node.dataset.draftId = id;
    return node;
  }
  function setStorageStatus(warning = '') {
    storageStatus.textContent = !storageAvailable
      ? 'Browser storage is unavailable. Changes are kept for this page session only; export a copy before leaving.'
      : warning || 'Drafts are stored only in this browser profile. Nothing is uploaded.';
  }
  try {
    const loaded = readDrafts(localStorage.getItem(STORAGE_KEY));
    drafts = loaded.drafts; setStorageStatus(loaded.warning);
  } catch { storageAvailable = false; setStorageStatus(); }

  function persist(next) {
    // Validation and allowlisting happen even when browser storage is blocked.
    const serialized = serializeDrafts(next);
    if (storageAvailable) {
      try { localStorage.setItem(STORAGE_KEY, serialized); }
      catch { storageAvailable = false; }
    }
    drafts = next; setStorageStatus();
    return storageAvailable;
  }
  function clearPreview(message = '') {
    const player = get('academy-video-player');
    player.pause(); player.removeAttribute('src'); player.load();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    get('academy-video-file').value = '';
    get('academy-video-preview').hidden = true;
    get('academy-video-status').textContent = message;
  }
  function updateAuthorFields() {
    const named = form.elements.namedItem('visibility').value === 'named';
    get('academy-name-fields').hidden = !named;
    fields.name.disabled = !named; fields.consent.disabled = !named;
    if (!named) { fields.name.value = ''; fields.consent.checked = false; }
  }
  function clearErrors() {
    errors.replaceChildren(); errors.hidden = true;
    for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
  }
  function showErrors(messages) {
    clearErrors(); errors.hidden = false;
    errors.append(element('strong', '', 'Check this draft before saving.'));
    const items = element('ul');
    for (const [key, message] of Object.entries(messages)) {
      items.append(element('li', '', message));
      fields[key]?.setAttribute('aria-invalid', 'true');
    }
    errors.append(items); errors.focus();
  }
  function resetEditor(message = '') {
    editingId = null; form.reset(); clearErrors(); clearPreview();
    fields.date.max = todayISO(); fields.date.value = fields.date.max;
    updateAuthorFields(); get('academy-editor-title').textContent = 'Create a local draft';
    get('academy-save').textContent = 'Save local draft';
    get('academy-cancel').hidden = true; get('academy-cancel').textContent = 'Clear form';
    status.textContent = message;
  }
  function renderCollection() {
    const filtered = filterDrafts(drafts, { search: get('academy-search').value, track: get('academy-filter-track').value, kind: get('academy-filter-kind').value });
    get('academy-count').textContent = `${drafts.length} DRAFT${drafts.length === 1 ? '' : 'S'}`;
    get('academy-results-status').textContent = `${filtered.length} of ${drafts.length} local draft${drafts.length === 1 ? '' : 's'}`;
    get('academy-export').disabled = !drafts.length;
    list.replaceChildren();
    if (!filtered.length) {
      const empty = element('div', 'academy-empty');
      if (!drafts.length) {
        const icon = element('img'); icon.src = '/showave-assets/assets/app-icons/showave.svg'; icon.alt = ''; icon.width = 52; icon.height = 52; empty.append(icon);
      }
      empty.append(element('h4', '', drafts.length ? 'No drafts match these filters.' : 'Your first rehearsal starts here.'), element('p', '', drafts.length ? 'Try another search, track or activity type.' : 'No activity has been added in this browser. Save a draft to build your own collection.'));
      list.append(empty); return;
    }
    for (const draft of filtered) {
      const track = TRACKS.find(value => value.id === draft.track);
      const author = authorIdentity(draft.author);
      const card = element('article', 'academy-activity-card');
      card.style.setProperty('--academy-accent', track.color);
      const meta = element('div', 'academy-activity-meta');
      meta.append(element('span', '', `${track.title} / ${ACTIVITY_TYPES[draft.kind]}`));
      const date = element('time', '', draft.date); date.dateTime = draft.date; meta.append(date);
      card.append(meta, element('h4', '', draft.title), element('p', 'academy-activity-author', `By ${author.name} · local draft`), element('p', 'academy-activity-summary', draft.summary));
      if (draft.videoUrl) card.append(link('Open saved video link ↗', draft.videoUrl, true));
      const actions = element('div', 'academy-activity-actions');
      actions.append(button('Edit draft', 'edit', draft.id), button('Remove draft', 'remove', draft.id));
      card.append(actions); list.append(card);
    }
  }
  function editDraft(draft) {
    clearErrors(); clearPreview(); editingId = draft.id;
    for (const key of ['title', 'summary', 'track', 'kind', 'date', 'videoUrl']) fields[key].value = draft[key];
    for (const radio of form.querySelectorAll('[name="visibility"]')) radio.checked = radio.value === draft.author.visibility;
    updateAuthorFields(); fields.name.value = draft.author.name; fields.consent.checked = draft.author.consent;
    fields.date.max = todayISO(); get('academy-editor-title').textContent = 'Edit a local draft';
    get('academy-save').textContent = 'Save changes'; get('academy-cancel').hidden = false; get('academy-cancel').textContent = 'Cancel edit';
    status.textContent = 'Editing your local copy. Saving changes does not publish it.';
    fields.title.focus();
  }
  form.addEventListener('change', event => {
    if (event.target.name === 'visibility') updateAuthorFields();
  });
  form.addEventListener('input', () => { get('academy-cancel').hidden = false; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const id = editingId || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `draft_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`);
    const input = {
      id, title: fields.title.value, summary: fields.summary.value, track: fields.track.value,
      kind: fields.kind.value, date: fields.date.value, videoUrl: fields.videoUrl.value,
      author: { visibility: form.elements.namedItem('visibility').value, name: fields.name.value, consent: fields.consent.checked }
    };
    const result = upsertDraft(drafts, input);
    if (!result.ok) { showErrors(result.errors); return; }
    const wasEditing = Boolean(editingId);
    try {
      const persisted = persist(result.drafts);
      resetEditor(persisted ? `Local draft ${wasEditing ? 'updated' : 'saved'}. Nothing was published.` : 'Draft kept for this session only. Export it before leaving.');
      renderCollection();
    } catch (error) { showErrors({ collection: error.message || `Keep at most ${MAX_DRAFTS} drafts.` }); }
  });
  get('academy-cancel').addEventListener('click', () => resetEditor('The editing form was cleared. Saved drafts remain in your collection.'));
  for (const id of ['academy-search', 'academy-filter-track', 'academy-filter-kind']) get(id).addEventListener(id === 'academy-search' ? 'input' : 'change', renderCollection);
  list.addEventListener('click', event => {
    const action = event.target.closest('[data-academy-action]');
    if (!action || !list.contains(action)) return;
    const draft = drafts.find(value => value.id === action.dataset.draftId);
    if (!draft) return;
    if (action.dataset.academyAction === 'edit') { editDraft(draft); return; }
    if (action.dataset.academyAction === 'remove') {
      try {
        persist(drafts.filter(value => value.id !== draft.id));
        if (editingId === draft.id) resetEditor();
        status.textContent = 'The draft was removed from your local collection.'; renderCollection();
      } catch (error) { showErrors({ collection: error.message }); }
    }
  });
  root.addEventListener('click', event => {
    const trigger = event.target.closest('[data-academy-lesson]');
    if (!trigger) return;
    if (editingId || fields.title.value.trim() || fields.summary.value.trim()) {
      status.textContent = 'Save or clear the current form before starting another lesson draft.';
      fields.title.focus(); return;
    }
    const track = TRACKS.find(value => value.lessons.some(lesson => lesson.id === trigger.dataset.academyLesson));
    const lesson = track?.lessons.find(value => value.id === trigger.dataset.academyLesson);
    if (!lesson) return;
    fields.track.value = track.id; fields.kind.value = 'lesson-note'; fields.title.value = lesson.title;
    fields.summary.value = `My rehearsal plan:\n${lesson.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nObserved result:\n\nNext check:`;
    get('academy-cancel').hidden = false; status.textContent = 'A lesson checklist is ready. Add your own observed result, then save your local draft.';
    fields.summary.focus();
  });
  get('academy-video-file').addEventListener('change', event => {
    const file = event.target.files?.[0];
    clearPreview();
    if (!file) return;
    const supportedFile = file.type.startsWith('video/') || (!file.type && /\.(?:mp4|webm|ogv|ogg|mov|m4v)$/i.test(file.name));
    if (!supportedFile || file.size > 512 * 1024 * 1024) {
      get('academy-video-status').textContent = 'Choose a video file of 512 MB or less. It will only be previewed in this session.'; return;
    }
    try {
      previewUrl = URL.createObjectURL(file);
      get('academy-video-player').src = previewUrl;
      get('academy-video-preview').hidden = false;
      get('academy-video-status').textContent = `Session-only preview: ${file.name}. The file is not part of your saved draft.`;
    } catch { clearPreview('This browser could not create a local preview. The file was not stored.'); }
  });
  get('academy-video-player').addEventListener('error', () => {
    if (previewUrl) get('academy-video-status').textContent = 'This browser could not play that format. Your local file was not stored or uploaded.';
  });
  get('academy-clear-video').addEventListener('click', () => clearPreview('Local preview cleared.'));
  get('academy-export').addEventListener('click', () => {
    if (!drafts.length) return;
    let url;
    try {
      const blob = new Blob([exportDrafts(drafts)], { type: 'application/json;charset=utf-8' });
      url = URL.createObjectURL(blob);
      const download = document.createElement('a');
      download.href = url; download.download = `showave-academy-drafts-${todayISO()}.json`; download.hidden = true;
      document.body.append(download); download.click(); download.remove();
      // Release the export URL after the browser has accepted the explicit click.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = 'Your draft copy was exported. Review named recognition and video links before sharing the file.';
    } catch { if (url) URL.revokeObjectURL(url); status.textContent = 'The export could not be created. Your drafts remain in this page.'; }
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || !storageAvailable) return;
    const loaded = readDrafts(event.newValue);
    drafts = loaded.drafts; setStorageStatus(loaded.warning); renderCollection();
    status.textContent = 'The local collection changed in another tab. The current editing form is unchanged.';
  });
  // Keep the handler across back/forward-cache restores as well as full visits.
  window.addEventListener('pagehide', () => clearPreview());
  resetEditor(); renderCollection();
}
