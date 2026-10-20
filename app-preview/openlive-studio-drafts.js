/* Independent browser Studio drafts. Local documents only: creation never
   connects accounts, writes platform metadata, captures media, or starts outputs.
   The manifest is written last, so the picker cannot list a half-created draft. */
window.OpenLiveStudioDrafts = (() => {
'use strict';

const PREFIX = 'openlive.studio-draft.v1:';
const SCHEMA = 'openlive.studio-draft/1';
const ID = /^[a-zA-Z0-9_-]{8,80}$/;
const BASES = Object.freeze({
  info: 'openlive.broadcast.stream-info.v1',
  run: 'openlive.broadcast.run-settings.v1',
  routes: 'openlive.broadcast.v1',
  studio: 'openlive.studio.v1',
  captionsActive: 'showave.studio.captions.programme.v1',
  commerceActive: 'showave.studio.commerce.programme.v1',
  theme: 'showave.studio.theme.v1'
});
const scopedBases = new Set(Object.values(BASES));
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const text = value => typeof value === 'string' ? value : '';
const validId = id => typeof id === 'string' && ID.test(id);

function keys(id) {
  if (!validId(id)) throw new Error('The Studio draft id is invalid.');
  const out = { manifest: PREFIX + id };
  Object.keys(BASES).forEach(name => { out[name] = BASES[name] + ':' + id; });
  return out;
}

function json(storage, key) {
  const value = storage.getItem(key);
  if (value === null) return null;
  try { return object(JSON.parse(value)); } catch (_) { return null; }
}

function manifest(storage, id) {
  if (!validId(id)) return null;
  const saved = json(storage, PREFIX + id);
  if (!saved || saved.schema !== SCHEMA || saved.id !== id ||
      !['live', 'record'].includes(saved.mode) || !Number.isFinite(saved.createdAt)) return null;
  return saved;
}

function randomId() {
  const crypto = window.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function')
    throw new Error('Secure Studio draft ids are unavailable in this browser.');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'studio-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function createStore(storage, options) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' ||
      typeof storage.removeItem !== 'function' || typeof storage.key !== 'function')
    throw new Error('Browser storage is unavailable for Studio drafts.');
  const opts = options || {}, newId = opts.newId || randomId, now = opts.now || Date.now;

  function get(id) {
    const saved = manifest(storage, id);
    if (!saved) return null;
    const names = keys(id), info = json(storage, names.info), run = json(storage, names.run);
    // Deliberately project only public draft summary fields. Do not return
    // arbitrary saved data, account routes, endpoint references, or credentials.
    return {
      id,
      title: text(info && info.title !== undefined ? info.title : saved.title).trim().slice(0, 200),
      description: text(info && info.description !== undefined ? info.description : saved.description).trim().slice(0, 5000),
      mode: run && ['live', 'record'].includes(run.mode) ? run.mode : saved.mode,
      createdAt: saved.createdAt
    };
  }

  function list() {
    const ids = new Set();
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key === 'string' && key.startsWith(PREFIX)) {
        const id = key.slice(PREFIX.length);
        if (validId(id)) ids.add(id);
      }
    }
    return [...ids].map(get).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  function create(input) {
    const value = object(input) || {};
    if (value.title !== undefined && typeof value.title !== 'string')
      throw new Error('The Studio title must be text.');
    if (value.description !== undefined && typeof value.description !== 'string')
      throw new Error('The Studio description must be text.');
    let title = text(value.title).trim();
    const description = text(value.description).trim();
    if (title.length > 200) throw new Error('The Studio title must be 200 characters or fewer.');
    if (description.length > 5000) throw new Error('The Studio description must be 5000 characters or fewer.');
    if (value.mode !== undefined && !['live', 'record'].includes(value.mode))
      throw new Error('Choose Live Stream or Record Only.');
    const mode = value.mode || 'live';
    const date = new Date(now());
    if (!Number.isFinite(date.getTime())) throw new Error('The Studio creation time is invalid.');
    if (!title) title = 'Live with SHOWAVE, ' + new Intl.DateTimeFormat(undefined, {
      month: 'long', day: '2-digit'
    }).format(date);
    const id = newId(), names = keys(id);
    if (Object.values(names).some(key => storage.getItem(key) !== null))
      throw new Error('This Studio draft id is already in use. Try creating the studio again.');
    const summary = { id, title, description, mode, createdAt: date.getTime() };
    const writes = [
      [names.info, {
        cardId: id, title, description, tags: [], privacy: '', language: '',
        thumbnail: '', thumbnailName: '', thumbnailWidth: 0, thumbnailHeight: 0,
        thumbnailBytes: 0, categories: {}, channelDetails: {},
        uniqueDetails: false, titleCleared: false
      }],
      [names.run, { mode, profile: '1080p30', cloud: false, local: mode === 'record', clipping: false }],
      [names.routes, []],
      [names.manifest, Object.assign({ schema: SCHEMA }, summary)]
    ];
    const written = [];
    try {
      for (const [key, value] of writes) {
        // The initial check covers every owned namespace (including Studio's
        // future scene document); recheck each actual write before claiming it.
        if (storage.getItem(key) !== null) throw new Error('This Studio draft id is already in use.');
        const encoded = JSON.stringify(value);
        storage.setItem(key, encoded);
        written.push([key, encoded]);
      }
      return summary;
    } catch (error) {
      let cleanupFailed = false;
      for (const [key, encoded] of written.reverse()) {
        try {
          // Do not delete a value another context replaced after our write.
          if (storage.getItem(key) === encoded) storage.removeItem(key);
        } catch (_) { cleanupFailed = true; }
      }
      throw new Error('The Studio draft could not be saved: ' + (error && error.message || error) +
        (cleanupFailed ? ' Some temporary draft data could not be removed.' : ''));
    }
  }

  return { list, get, create, keys };
}

function context(search, storage) {
  let id = '', error = '', independent = false;
  try {
    const params = new URLSearchParams(search || '');
    const requested = params.getAll('studio');
    independent = requested.length > 0;
    if (independent) {
      if (requested.length !== 1 || !validId(requested[0]))
        throw new Error('The Studio draft link is invalid. Return to Create stream and choose a saved studio.');
      id = requested[0];
      if (!manifest(storage, id))
        throw new Error('This Studio draft is missing or damaged. Return to Create stream and choose a saved studio.');
      const names = keys(id), info = json(storage, names.info), run = json(storage, names.run);
      let routes;
      try { routes = JSON.parse(storage.getItem(names.routes) || 'null'); } catch (_) { routes = null; }
      if (!info || info.cardId !== id || !run || !['live', 'record'].includes(run.mode) || !Array.isArray(routes))
        throw new Error('This Studio draft has missing or damaged settings. Its saved data was left unchanged.');
    }
  } catch (failure) {
    error = failure && failure.message || String(failure);
  }
  return {
    id, error, independent,
    key(base) {
      if (error) throw new Error(error); // never write a bad draft into legacy storage
      return independent && scopedBases.has(base) ? base + ':' + id : base;
    }
  };
}

return { createStore, context };
})();
