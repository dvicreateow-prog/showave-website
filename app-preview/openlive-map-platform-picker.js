/* Compact platform workflow browser for the SHOWAVE Map inspector. Reading a
   guide never authenticates, creates a destination, updates metadata or goes live. */
(function (root) {
  'use strict';
  function mount(container, options) {
    const opts = options || {};
    const doc = container.ownerDocument;
    const workflows = root.OpenLivePlatformWorkflows;
    const rows = Array.isArray(opts.rows) ? opts.rows : [];
    const make = (tag, className, parent, text) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text != null) node.textContent = String(text);
      parent.appendChild(node);
      return node;
    };
    const panel = make('div', 'oo-platform-picker', container);
    if (!workflows) {
      make('p', '', panel, 'Platform guidance could not be loaded. Reload SHOWAVE Map.');
      return panel;
    }
    const ids = [...new Set(rows.filter(r => r && r.platformId != null)
      .map(r => String(r.platformId)))];
    const rank = item => item.kind === 'account' ? (item.target.ready ? 0 : 1) : 2;
    const platforms = ids.map(id => ({ id, ...workflows.resolve(rows, id) }))
      .sort((a, b) => rank(a) - rank(b) ||
        a.label.localeCompare(b.label));
    const label = make('label', '', panel, 'Platform');
    const select = make('select', '', label);
    select.setAttribute('aria-label', 'Platform workflow');
    const status = item => item.kind === 'account'
      ? (item.target.kind === 'connect' && item.target.ready ? 'Account login'
        : item.channels.length ? 'Account connected'
        : item.target.configured === true ? 'Sign-in unavailable' : 'Publisher setup needed')
      : item.kind === 'key' ? (workflows.forPlatform(item.id).unverified ? 'Manual · unverified' : 'Manual output')
      : item.kind === 'whip' ? 'WHIP output'
      : item.kind === 'blocked' ? 'Unavailable' : 'Unverified';
    platforms.forEach(item => {
      const option = make('option', '', select, item.label + ': ' + status(item));
      option.value = item.id;
    });
    select.value = ids.includes(String(opts.selectedId)) ? String(opts.selectedId)
      : platforms.length ? platforms[0].id : '';
    const details = make('div', 'oo-platform-details', panel);
    function render() {
      details.replaceChildren();
      const item = platforms.find(p => p.id === select.value);
      if (!item) {
        make('p', '', details, 'No platform catalogue is available. Check the local accounts helper.');
        return;
      }
      if (opts.onSelect) opts.onSelect(item.id);
      make('strong', '', details, item.label);
      make('p', 'oo-platform-status', details, 'In SHOWAVE: ' + status(item) +
        (item.channels.length ? ' · ' + item.channels.length + ' channel(s) connected' : ''));
      // Older catalogue notes mix login and manual-key instructions. Account
      // guides must not imply the manual fallback is part of signing in.
      if (item.note && (item.kind !== 'account' || !item.target.ready))
        make('p', '', details, item.note);
      if (item.kind === 'account') {
        make('p', '', details, 'Connected channels appear automatically. Choose On or Off, then Go. ' +
          'Supported settings and ingest details are handled by the account connector; no stream key is entered.');
      } else if (item.kind === 'key') {
        make('p', '', details, 'This build has no automatic login on this path. Custom Output sends media; ' +
          'set stream details and any final publish action on the platform. Key lifetime is platform-specific.');
      }
      const guide = workflows.forPlatform(item.id);
      [['Connection', guide.connection], ['Stream details', guide.details], ['Going live', guide.start]]
        .forEach(([title, text]) => {
          make('h4', '', details, title);
          make('p', '', details, text);
        });
      if (guide.url && /^https:\/\//.test(guide.url)) {
        const source = make('a', '', details, guide.source || 'Platform documentation');
        source.href = guide.url;
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
      }
      make('p', 'oo-platform-caveat', details,
        'Reference workflows do not prove this SHOWAVE connector has passed a live-stream test.');
      const account = item.kind === 'account';
      const custom = item.kind === 'key' || item.kind === 'whip';
      const canLogin = account && item.target.kind === 'connect' && item.target.ready;
      const action = make('button', 'ao-btn', details,
        account ? canLogin ? (item.channels.length ? 'Add another account' : 'Connect account')
          : item.channels.length ? 'Already connected'
          : item.target.configured === true ? 'Sign-in unavailable' : 'Setup needed'
        : custom ? 'Add Custom Output' : 'Unavailable');
      action.type = 'button';
      action.disabled = !!opts.locked || (!canLogin && !custom);
      if (opts.locked) action.title = 'Stop active outputs before changing connections.';
      else if (account && !canLogin && !item.channels.length)
        action.title = item.note || 'This connection is not ready. End users are not asked for developer credentials.';
      action.addEventListener('click', () => {
        if (action.disabled) return;
        if (canLogin && opts.onConnect) opts.onConnect(item.target);
        else if (custom && opts.onCustom) opts.onCustom(item.target);
      });
    }
    select.addEventListener('change', render);
    render();
    return panel;
  }
  root.OpenLiveMapPlatformPicker = Object.freeze({ mount });
})(typeof window === 'undefined' ? globalThis : window);
