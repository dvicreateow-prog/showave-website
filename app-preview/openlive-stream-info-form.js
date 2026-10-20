/* Local Stream info form controls. Suggestions are SHOWAVE conveniences, not
   platform categories. No network calls, account changes or storage here. */
window.OpenLiveStreamInfoForm = (() => {
'use strict';
const TOPICS = Object.freeze(['Arts', 'Business', 'Comedy', 'Community', 'Education',
  'Entertainment', 'Gaming', 'Music', 'News', 'Science', 'Sports', 'Technology', 'Travel']);
const normalizeTags = values => {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(String).map(value => value.trim())
    .filter(value => { const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) return false; seen.add(key); return true; });
};
function patchDocument(doc, patch, resetOverrides = []) {
  const next = JSON.parse(JSON.stringify(doc));
  Object.keys(patch).forEach(key => {
    if (!['title', 'description', 'tags', 'privacy', 'language', 'thumbnail', 'thumbnailName',
      'thumbnailWidth', 'thumbnailHeight', 'thumbnailBytes', 'titleCleared'].includes(key))
      throw new Error('Unknown Stream info field.');
    next[key] = key === 'tags' ? normalizeTags(patch[key]) : patch[key];
  });
  Object.keys(next.channelDetails || {}).forEach(key => {
    const detail = next.channelDetails[key];
    if (!detail || typeof detail !== 'object') return;
    resetOverrides.forEach(field => { delete detail[field]; });
    if (!Object.keys(detail).length) delete next.channelDetails[key];
  });
  return next;
}

function mountTopics({ document, getTags, commitTags }) {
  const find = id => document.getElementById(id);
  const root = find('infoTopics'), toggle = find('infoTagsToggle'), panel = find('infoTagsPanel');
  const search = find('infoTags'), list = find('infoTagsOptions'), add = find('infoTagAdd');
  if (!root || !toggle || !panel || !search || !list || !add) return null;
  let lastSignature = '';
  const close = (restore = false) => {
    panel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (restore) toggle.focus();
  };
  const change = next => { const ok = commitTags(normalizeTags(next)); render(true); return ok; };
  function render(force = false) {
    const tags = normalizeTags(getTags()), query = search.value.trim();
    toggle.textContent = tags.length ? tags.join(', ') + ' ▾' : 'Choose topics / tags… ▾';
    const signature = JSON.stringify([tags, query]);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    const active = document.activeElement;
    const focusedTag = active && active.dataset && active.dataset.topic;
    list.replaceChildren();
    const choices = normalizeTags([...tags, ...TOPICS]).filter(tag =>
      tag.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    choices.forEach(tag => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.topic = tag;
      input.checked = tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase());
      input.addEventListener('change', () => {
        const current = normalizeTags(getTags());
        change(input.checked ? [...current, tag] : current.filter(value => value.toLocaleLowerCase() !== tag.toLocaleLowerCase()));
      });
      label.append(input, document.createTextNode(tag)); list.append(label);
      if (focusedTag === tag) input.focus();
    });
    if (!choices.length) {
      const empty = document.createElement('div'); empty.className = 'hint';
      empty.textContent = 'No matching suggestions. Add your own tag below.'; list.append(empty);
    }
    add.hidden = !query || tags.some(tag => tag.toLocaleLowerCase() === query.toLocaleLowerCase());
    add.textContent = query ? 'Add “' + query + '”' : 'Add tag';
  }
  const addTag = () => {
    const value = search.value.trim(); if (!value) return;
    if (change([...getTags(), value])) { search.value = ''; render(true); }
    search.focus();
  };
  toggle.addEventListener('click', () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); render(); search.focus();
  });
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addTag(); }
  });
  add.addEventListener('click', addTag);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  root.addEventListener('focusout', event => { if (event.relatedTarget && !root.contains(event.relatedTarget)) close(); });
  document.addEventListener('click', event => { if (!root.contains(event.target)) close(); });
  render(); return { render, close };
}

function thumbnailLoader({ getOwner, read, commit, status }) {
  let revision = 0, pending = false, pendingOwner = null;
  const cancel = () => { revision++; pending = false; };
  async function pick(file) {
    if (!file) return false;
    const ticket = ++revision, owner = getOwner(); pending = true; pendingOwner = owner;
    const current = () => ticket === revision && owner === getOwner();
    status('Reading thumbnail…', false);
    try {
      const picked = await read(file);
      if (!current()) return false;
      pending = false;
      const ok = commit({ thumbnail: picked.dataUri, thumbnailName: picked.name,
        thumbnailWidth: picked.width, thumbnailHeight: picked.height, thumbnailBytes: picked.bytes });
      if (ok) status('Thumbnail saved locally. Update All sends it only to supported channels.', false);
      return ok;
    } catch (error) {
      if (!current()) return false;
      pending = false;
      // readThumbnailFile uses fixed, local errors; never display file contents.
      status(error && error.message || 'The thumbnail could not be read.', true);
      return false;
    }
  }
  return { pick, cancel, pending: () => pending && pendingOwner === getOwner() };
}
return Object.freeze({ TOPICS, normalizeTags, patchDocument, mountTopics, thumbnailLoader });
})();
