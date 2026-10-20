/* ===========================================================================
   openlive-channel-routing.js — shared connected-channel destination model.

   A platform login is account-level. Once the accounts helper reports a
   channel, every Broadcast must show that channel as a destination row without
   asking the operator to copy an ingest URL or assign it to a generic slot.

   This file is deliberately transport-only data plumbing: no OAuth, no keys,
   no DOM, and no persistence. Both SHOWAVE Map and the standalone Broadcast
   window call it after reading /api/accounts/destinations, then save through
   their own document model.
   =========================================================================== */
window.OpenLiveChannelRouting = (() => {
'use strict';

const text = v => v == null ? '' : String(v);
const label = (value, fallback) => {
  const out = text(value).trim();
  return out && !/^(undefined|null|nan)$/i.test(out) ? out : fallback;
};
const firstLabel = (values, fallback) => {
  for (const value of values) {
    const out = label(value, '');
    if (out) return out;
  }
  return fallback;
};
const same = (a, b) => text(a) === text(b);
const channelRows = catalogue => {
  const rows = Array.isArray(catalogue)
    ? catalogue
    : (catalogue && Array.isArray(catalogue.destinations) ? catalogue.destinations : []);
  const seen = new Set();
  return rows.filter(row => {
    if (!row || row.kind !== 'channel' || !row.accountId) return false;
    /* A stored grant or failed discovery is not a routable channel. Do not
       adopt a blank slot or auto-enable a destination with no stable identity. */
    if (!(typeof row.channelId === 'string' && row.channelId.trim()) &&
        !(Number.isSafeInteger(row.channelId) && row.channelId >= 0)) return false;
    const key = text(row.accountId) + '\n' + text(row.channelId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const channelName = row => {
  const platform = firstLabel([row.platform, row.provider], 'Channel');
  const name = firstLabel([row.displayName, row.channelName, row.channelId], platform);
  return platform + ': ' + name;
};

const channelKey = row => 'ch:' + text(row.accountId) + ':' + text(row.channelId);

/* A default slot has never been routed or named by the operator. It is safe to
   adopt for the first connected channel, and safe to remove when another
   connected-channel row already replaced its purpose. Custom outputs, files,
   OBS hand-offs and saved ingests never satisfy this predicate. */
function isPristine(dest) {
  if (!dest || dest.accountId || dest.endpointRef || dest.url) return false;
  const transport = text(dest.transport || 'ST_DISABLED');
  const service = text(dest.serviceKey || '');
  return transport === 'ST_DISABLED' && (!service || service === 'ST_DISABLED') &&
         /^Destination\s+\d+$/i.test(text(dest.name).trim());
}

function rowMatches(dest, row) {
  if (!dest || !dest.accountId) return false;
  if (same(dest.accountId, row.accountId) && same(dest.channelId, row.channelId)) return true;

  /* OAuth reconnects can mint a new local account id for the same platform
     channel. Match that stable platform/channel pair and update the account id
     instead of duplicating the row. */
  return !!text(row.channelId) && same(dest.channelId, row.channelId) &&
    (row.platformId != null && dest.platformId != null
      ? same(dest.platformId, row.platformId)
      : !!text(dest.provider) && same(dest.provider, row.provider));
}

function put(dest, key, value) {
  if (dest[key] === value) return false;
  dest[key] = value;
  return true;
}

function applyChannel(dest, row) {
  let changed = false;
  changed = put(dest, 'name', channelName(row)) || changed;
  changed = put(dest, 'transport', text(row.transport || 'ST_HELPER_RTMP')) || changed;
  changed = put(dest, 'serviceKey', channelKey(row)) || changed;
  changed = put(dest, 'platformId', row.platformId == null ? null : row.platformId) || changed;
  changed = put(dest, 'accountId', text(row.accountId)) || changed;
  changed = put(dest, 'channelId', text(row.channelId) || null) || changed;
  changed = put(dest, 'provider', text(row.provider) || null) || changed;
  if (dest.orientation !== 'landscape' && dest.orientation !== 'portrait') {
    changed = put(dest, 'orientation', 'landscape') || changed;
  }
  /* A connected channel is provisioned by its platform API at Go. A former
     custom-ingest reference on the adopted row must never be used by mistake. */
  changed = put(dest, 'endpointRef', '') || changed;
  return changed;
}

/* Reconcile is additive for real channel rows and conservative for everything
   else. It never removes a stale account row merely because a helper on this
   machine did not list it; imported documents may legitimately refer to an
   account connected elsewhere. Explicit sign-out calls removeAccount(). */
function reconcile(destinations, catalogue, options) {
  const list = Array.isArray(destinations) ? destinations : [];
  const opts = options || {};
  const rows = channelRows(catalogue);
  const used = new Set();
  const added = [];
  const adopted = [];
  const updated = [];
  const removed = [];
  let changed = false;

  rows.forEach(row => {
    let dest = list.find(d => !used.has(d) && rowMatches(d, row)) || null;
    let created = false;
    let wasAdopted = false;

    if (!dest) {
      dest = list.find(d => !used.has(d) && isPristine(d)) || null;
      if (dest) {
        wasAdopted = true;
        adopted.push(dest);
      }
    }

    if (!dest) {
      const enable = typeof opts.enableNew === 'function'
        ? !!opts.enableNew(row)
        : !!opts.enableNew;
      const init = {
        name: channelName(row),
        transport: text(row.transport || 'ST_HELPER_RTMP'),
        endpointRef: '',
        enabled: enable,
        serviceKey: channelKey(row),
        platformId: row.platformId == null ? null : row.platformId,
        accountId: text(row.accountId),
        channelId: text(row.channelId) || null,
        provider: text(row.provider) || null,
        orientation: 'landscape'
      };
      dest = typeof opts.create === 'function' ? opts.create(init, row) : Object.assign({}, init);
      if (!list.includes(dest)) list.push(dest);
      created = true;
      added.push(dest);
      changed = true;
    }

    used.add(dest);
    if (applyChannel(dest, row)) {
      changed = true;
      if (!created && !wasAdopted) updated.push(dest);
    }
    /* An adopted slot keeps its old On/Off value. A newly made row got its
       explicit safe default in init above. */
  });

  if (rows.length && opts.dropPlaceholders !== false) {
    for (let i = list.length - 1; i >= 0; i--) {
      const dest = list[i];
      if (!used.has(dest) && isPristine(dest)) {
        list.splice(i, 1);
        removed.push(dest);
        changed = true;
      }
    }
  }

  return { changed, added, adopted, updated, removed, channels: rows.length };
}

function removeAccount(destinations, accountId) {
  const list = Array.isArray(destinations) ? destinations : [];
  const removed = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (same(list[i] && list[i].accountId, accountId)) {
      removed.unshift(list[i]);
      list.splice(i, 1);
    }
  }
  return removed;
}

return { channelRows, channelName, channelKey, isPristine, reconcile, removeAccount };
})();
