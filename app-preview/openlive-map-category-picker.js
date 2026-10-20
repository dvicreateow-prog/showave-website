/* Per-channel draft categories for SHOWAVE Map. Provider reads require an
   explicit click. Names stay in memory; only a selected category value is saved.
   Sources: https://developers.google.com/youtube/v3/docs/videoCategories/list
   https://developers.google.com/youtube/v3/docs/videoCategories */
(function (root) {
  'use strict';
  const cache = new Map();
  const mounts = new WeakMap();
  function regionFor(language) {
    const match = /-([A-Za-z]{2})$/.exec(String(language || ''));
    return match ? match[1].toUpperCase() : 'US';
  }
  function mount(container, options) {
    const opts = options || {};
    const doc = container.ownerDocument;
    const token = {};
    mounts.set(container, token);
    const provider = String(opts.provider || '').toLowerCase();
    const accountId = String(opts.accountId || '');
    const region = /^[A-Z]{2}$/.test(String(opts.region || '')) ? opts.region : 'US';
    const key = JSON.stringify([provider, accountId, region]);
    const current = () => mounts.get(container) === token && container.isConnected !== false &&
      (!opts.isCurrent || opts.isCurrent());
    const value = () => String(opts.getValue ? opts.getValue() : opts.value || '');
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text != null) node.textContent = String(text);
      container.appendChild(node);
      return node;
    };
    const input = make(provider === 'youtube' ? 'select' : 'input', 'oo-dest-cat');
    input.setAttribute('aria-label', opts.label || 'Category');
    input.style.flex = '1 1 0'; input.style.minWidth = '70px'; input.style.order = '3';
    const status = make('span', 'oo-dest-info');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const commit = next => {
      if (!current() || opts.blocked || next === value()) return;
      if (opts.onChange) opts.onChange(next);
    };
    if (provider !== 'youtube') {
      input.type = 'text'; input.value = value();
      input.disabled = !!opts.blocked;
      input.placeholder = opts.blocked ? 'Not settable here' : 'Category name or id';
      input.title = opts.note || '';
      status.textContent = opts.note || 'Category belongs to this channel only.';
      if (opts.compact) { status.hidden = !opts.blocked; status.title = status.textContent;
        if (opts.blocked) status.textContent = 'Category unavailable'; }
      input.addEventListener('change', () => commit(input.value));
      return { input, status };
    }

    const load = make('button', 'ao-btn', 'Load categories');
    load.type = 'button'; load.style.order = '4';
    load.setAttribute('aria-label', 'Load YouTube categories for ' + (opts.channelLabel || 'this channel'));
    const clear = make('button', 'ao-btn', 'Clear');
    clear.type = 'button'; clear.style.order = '5';
    clear.setAttribute('aria-label', 'Clear category for ' + (opts.channelLabel || 'this channel'));
    function paint() {
      if (!current()) return;
      const saved = value(), entry = cache.get(key);
      const choices = entry && entry.state === 'ready' ? entry.choices : [];
      input.replaceChildren();
      const option = (id, name) => {
        const node = doc.createElement('option'); node.value = id; node.textContent = name;
        input.appendChild(node);
      };
      option('', 'No category override');
      choices.forEach(choice => option(choice.id, choice.name));
      const unknown = saved && !choices.some(choice => choice.id === saved);
      if (unknown) option(saved, 'Saved category (' + saved + '): unchanged');
      input.value = saved;
      input.disabled = !!opts.blocked || !entry || entry.state !== 'ready';
      load.disabled = !!opts.blocked || !!(entry && entry.state === 'loading');
      clear.disabled = !!opts.blocked || !saved;
      load.textContent = !entry ? 'Load categories' : entry.state === 'loading' ? 'Loading…'
        : entry.state === 'error' ? 'Retry' : 'Reload categories';
      status.textContent = opts.blocked ? opts.note || 'Category is not settable here.'
        : !entry ? 'Load category names from YouTube. This does not change stream details.'
        : entry.state === 'loading' ? 'Loading category names from YouTube… Saved category is unchanged.'
        : entry.state === 'error' ? 'Category names could not be loaded. Check this account connection and retry. Saved category is unchanged.'
        : !choices.length ? 'YouTube returned no assignable categories for ' + region + '. Saved category is unchanged.'
        : unknown ? 'The saved category is not in this region’s list. It remains unchanged until you choose or clear it.'
        : 'Choose a category by name. Its YouTube ID is saved for this channel only.';
      status.className = 'oo-dest-info' + (entry && entry.state === 'error' ? ' bad' : '');
      if (opts.compact) {
        status.title = status.textContent;
        status.hidden = !opts.blocked && (!entry || entry.state === 'ready' && choices.length > 0 && !unknown);
        status.textContent = opts.blocked ? 'Category unavailable'
          : entry && entry.state === 'error' ? 'Could not load categories'
          : entry && entry.state === 'loading' ? 'Loading…'
          : unknown ? 'Saved category unchanged' : 'No categories returned';
      }
    }
    async function request() {
      if (!current() || opts.blocked) return;
      let entry = cache.get(key);
      if (!entry || entry.state !== 'loading') {
        entry = { state: 'loading' };
        // Bound account-scoped memory without writing a cache to localStorage.
        if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
        entry.promise = Promise.resolve().then(() => {
          if (typeof opts.loadCategories !== 'function') throw new Error('Category reader unavailable');
          return opts.loadCategories(accountId, region);
        }).then(response => {
          if (!response || response.error || response.provider !== 'youtube' ||
              response.region !== region || !Array.isArray(response.categories))
            throw new Error('Invalid category response');
          const seen = new Set();
          entry.choices = response.categories.filter(choice => {
            if (!choice || typeof choice.id !== 'string' || !/^\d{1,20}$/.test(choice.id) ||
                typeof choice.name !== 'string' || !choice.name.trim() || seen.has(choice.id)) return false;
            seen.add(choice.id); return true;
          }).map(choice => ({ id: choice.id, name: choice.name.trim().slice(0, 256) }));
          entry.state = 'ready';
        }).catch(error => {
          entry.state = 'error';
          entry.error = error && error.message || 'Check the account connection and retry.';
        });
      }
      paint();
      await entry.promise;
      paint();
      if (current() && entry.state === 'error' && opts.notify)
        opts.notify('Categories for ' + (opts.channelLabel || 'this channel') + ': ' +
          'could not load category names. ' + entry.error + ' Your saved category is unchanged.');
    }
    load.addEventListener('click', request);
    clear.addEventListener('click', () => commit(''));
    input.addEventListener('change', () => {
      const entry = cache.get(key), next = input.value;
      if (!entry || entry.state !== 'ready' || input.disabled) return;
      if (next && !entry.choices.some(choice => choice.id === next)) return;
      commit(next);
    });
    // A rebuilt row may join a request explicitly initiated by its prior view.
    const pending = cache.get(key);
    if (pending && pending.state === 'loading') pending.promise.then(paint);
    paint();
    return { input, status, load, clear };
  }
  root.OpenLiveMapCategoryPicker = { mount, regionFor };
})(typeof window === 'object' ? window : globalThis);
