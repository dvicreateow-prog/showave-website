/* Per-channel stream details. Pure data: no platform requests, DOM, credentials
   or persistence. Broadcast saves the returned document before applying it.
   A missing override inherits; an explicit empty value suppresses the common
   value. Empty values do not mean "erase remote platform metadata". */
window.OpenLiveChannelDetails = (() => {
'use strict';

const FIELDS = Object.freeze(['title', 'description', 'tags', 'privacy', 'language']);
const own = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => value == null ? '' : String(value);
const copy = value => JSON.parse(JSON.stringify(value));
const normal = (field, value) => field === 'tags'
  ? (Array.isArray(value) ? value.map(text).map(tag => tag.trim()).filter(Boolean) : [])
  : text(value);
const put = (target, key, value) => Object.defineProperty(target, key, {
  value, enumerable: true, writable: true, configurable: true
});

function effective(infoDoc, key) {
  const doc = object(infoDoc), details = object(doc.channelDetails);
  const overrides = own(details, key) ? object(details[key]) : {};
  const out = {};
  FIELDS.forEach(field => {
    out[field] = normal(field, own(overrides, field) ? overrides[field] : doc[field]);
  });
  const categories = object(doc.categories);
  out.category = own(categories, key) ? text(categories[key]) : '';
  return out;
}

function update(infoDoc, key, changes) {
  const doc = copy(object(infoDoc));
  const patch = object(changes), values = object(patch.values);
  const inherit = new Set(Array.isArray(patch.inherit) ? patch.inherit : []);
  const details = object(doc.channelDetails);
  const previous = own(details, key) ? object(details[key]) : {};
  const next = Object.assign({}, previous);
  FIELDS.forEach(field => {
    if (inherit.has(field)) delete next[field];
    else if (own(values, field)) next[field] = normal(field, values[field]);
  });
  if (Object.keys(next).length) put(details, key, next);
  else delete details[key];
  doc.channelDetails = details;
  if (own(patch, 'category')) {
    const categories = object(doc.categories), category = text(patch.category).trim();
    if (category) put(categories, key, category);
    else delete categories[key];
    doc.categories = categories;
  }
  return doc;
}

/* A reconnect changes the helper's account identity, not the platform channel.
   Move that channel's saved settings only when both route snapshots prove the
   stable destination/channel identity. Inputs and returned documents never
   share mutable data. Existing values at the new route are authoritative. */
function migrateRoutes(infoDoc, beforeDestinations, afterDestinations) {
  const source = object(infoDoc), doc = copy(source);
  const before = Array.isArray(beforeDestinations) ? beforeDestinations : [];
  const after = Array.isArray(afterDestinations) ? afterDestinations : [];
  const route = dest => text(dest && dest.accountId) + '\n' + text(dest && dest.channelId);
  const existingRoutes = new Set(after.filter(Boolean).map(route));
  const pairs = [];
  after.filter(Boolean).forEach(dest => {
    const id = text(dest.id);
    if (!id || !text(dest.accountId) || !text(dest.channelId)) return;
    const matches = before.filter(old => old && text(old.id) === id);
    if (matches.length !== 1 || after.filter(row => row && text(row.id) === id).length !== 1) return;
    const old = matches[0];
    if (!text(old.accountId) || text(old.accountId) === text(dest.accountId) ||
        !text(old.channelId) || text(old.channelId) !== text(dest.channelId)) return;
    const oldProvider = text(old.provider).trim().toLowerCase();
    const nextProvider = text(dest.provider).trim().toLowerCase();
    const providerKnown = !!oldProvider && !!nextProvider;
    const platformKnown = old.platformId != null && dest.platformId != null &&
      text(old.platformId).trim() !== '' && text(dest.platformId).trim() !== '';
    // Conflicting explicit identities cannot be resolved by the other field.
    if (providerKnown && oldProvider !== nextProvider) return;
    if (platformKnown && text(old.platformId) !== text(dest.platformId)) return;
    if (!providerKnown && !platformKnown) return;
    pairs.push({ from: route(old), to: route(dest) });
  });
  const oldDetails = object(source.channelDetails), details = object(doc.channelDetails);
  const oldCategories = object(source.categories), categories = object(doc.categories);
  pairs.forEach(({ from, to }) => {
    if (own(oldDetails, from)) {
      const merged = {};
      [object(oldDetails[from]), own(details, to) ? object(details[to]) : {}].forEach(values => {
        Object.keys(values).forEach(field => put(merged, field, copy(values[field])));
      });
      put(details, to, merged);
      doc.channelDetails = details;
    }
    if (own(oldCategories, from) && !own(categories, to)) {
      put(categories, to, copy(oldCategories[from]));
      doc.categories = categories;
    }
  });
  pairs.forEach(({ from }) => {
    if (existingRoutes.has(from)) return;
    if (own(details, from)) delete details[from];
    if (own(categories, from)) delete categories[from];
  });
  return doc;
}

/* Limits and enumerations come from /api/accounts/metadata-capability. Skip
   unavailable fields: their disabled controls must not prevent saving fields
   that the provider does support. The helper remains authoritative. */
function validate(values, capability) {
  const fields = object(capability && capability.fields), source = object(values);
  const platform = text(capability && capability.label) || 'This platform';
  for (const field of [...FIELDS, 'category']) {
    if (!own(source, field)) continue;
    const spec = object(fields[field]);
    if (spec.state !== 'supported') continue;
    const value = normal(field, source[field]), limit = object(spec.limit);
    const label = field === 'tags' ? 'tags/topics' : field;
    if (field === 'tags') {
      if (!Array.isArray(source[field])) return 'Supply tags/topics as a list.';
      if (Number.isFinite(limit.maxItems) && value.length > limit.maxItems)
        return platform + ' allows at most ' + limit.maxItems + ' tags/topics.';
      if (Number.isFinite(limit.maxCharsEach) && value.some(tag => [...tag].length > limit.maxCharsEach))
        return platform + ' allows at most ' + limit.maxCharsEach + ' characters in each tag/topic.';
      // The helper validates this provider rule; it is also described in its
      // capability note, but prose is never parsed as executable instructions.
      if (platform.toLowerCase() === 'twitch' && value.some(tag => !/^[A-Za-z0-9]+$/.test(tag)))
        return 'Twitch tags may contain only letters and numbers, without spaces.';
      continue;
    }
    const trimmed = value.trim();
    // Unset local values are not sent by the helper. Go Live supplies a fallback
    // title only when creating a new platform object requires one.
    if (!trimmed) continue;
    const length = [...trimmed].length;
    if (Number.isFinite(limit.maxChars) && length > limit.maxChars)
      return platform + ' allows at most ' + limit.maxChars + ' ' + label + ' characters.';
    if (Number.isFinite(limit.minChars) && length < limit.minChars)
      return platform + ' requires at least ' + limit.minChars + ' ' + label + ' characters.';
    if (Array.isArray(spec.values) && !spec.values.includes(trimmed))
      return 'Choose a supported ' + label + ': ' + spec.values.join(', ') + '.';
    if (spec.input === 'iso-639-1' && !/^[a-z]{2}$/i.test(trimmed))
      return 'Language must be a two-letter code, for example en.';
    if (spec.input === 'id' && field === 'category' && !/^\d+$/.test(trimmed))
      return platform + ' requires a numeric category ID.';
  }
  return '';
}

return Object.freeze({ FIELDS, effective, update, migrateRoutes, validate });
})();
