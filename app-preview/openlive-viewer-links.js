/* Audience links are read-only views of the current output attempt. Never
   derive them from an ingest URL, which can contain a private stream key. */
(function () {
  'use strict';
  const states = new Set(['connecting','live','reconnecting','stopping','stop-failed','finish-failed','failed']);
  const labels = {connecting:'Preparing',live:'Open viewer page',reconnecting:'Reconnecting',
    stopping:'Ending', 'stop-failed':'End needs attention','finish-failed':'End needs attention',failed:'Output needs attention'};
  function currentRecord(destination, record) {
    if (!record || record.finalized || !states.has(record.state)) return null;
    const receiver = record.destination;
    if (receiver && ['id','accountId','channelId','platformId','transport'].some(key =>
      String(receiver[key] ?? '') !== String(destination[key] ?? ''))) return null;
    return record;
  }
  function viewerUrl(destination, record) {
    if (!destination?.accountId || !currentRecord(destination, record)) return '';
    const value = record.watchUrl;
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      if (['youtube.com','www.youtube.com'].includes(url.hostname)) {
        const id = url.searchParams.get('v');
        if (url.pathname !== '/watch' || !id || record.broadcastId && id !== String(record.broadcastId)) return '';
      }
      if (['twitch.tv','www.twitch.tv'].includes(url.hostname) && !/^\/[a-z0-9_]+\/?$/i.test(url.pathname)) return '';
      return url.href;
    } catch (_) { return ''; }
  }
  function entries(destinations, live) {
    const rows = [...destinations], ids = new Set(rows.map(destination => String(destination.id)));
    // Failed End can retain an output whose saved route has since disappeared.
    // Its immutable receiver snapshot still belongs to this current attempt.
    for (const [id, record] of live) {
      const receiver = record?.destination;
      if (!ids.has(String(id)) && receiver && String(receiver.id) === String(id) && currentRecord(receiver, record)) rows.push(receiver);
    }
    return rows.filter(destination => destination.enabled || currentRecord(destination, live.get(destination.id)))
      .map(destination => {
        const record = currentRecord(destination, live.get(destination.id));
        const url = viewerUrl(destination, record);
        const detail = url ? labels[record.state]
          : record?.finalizing || record?.state === 'stopping' ? 'Ending · viewer link unavailable'
          : record?.state === 'connecting' ? 'Preparing · waiting for viewer link'
          : record ? 'Viewer link unavailable'
          : destination.accountId ? 'Link appears when this channel is prepared'
          : 'This destination does not provide a viewer link';
        return {id:String(destination.id),name:String(destination.name || 'Destination'),url,detail};
      });
  }
  function mount(root) {
    const group = root.getElementById('viewerControl'), link = root.getElementById('viewerLink');
    const button = root.getElementById('viewerButton'), menu = root.getElementById('viewerMenu');
    const list = root.getElementById('viewerLinks'), empty = root.getElementById('viewerEmpty');
    const hint = root.getElementById('viewerHint');
    if (!group || !link || !button || !menu || !list || !empty || !hint) return null;
    let signature = '', model = [];
    function close({focus = false} = {}) {
      menu.hidden = true; button.setAttribute('aria-expanded', 'false');
      if (focus) (button.hidden ? link : button).focus();
    }
    function toggle() {
      const open = menu.hidden;
      menu.hidden = !open; button.setAttribute('aria-expanded', String(open));
      if (open) (list.querySelector('a') || menu).focus();
    }
    function outside(event) { if (!group.contains(event.target)) close(); }
    function keyboard(event) {
      if (!menu.hidden && event.key === 'Escape') { event.preventDefault(); close({focus:true}); }
    }
    function focusout(event) { if (event.relatedTarget && !group.contains(event.relatedTarget)) close(); }
    function follow() { close(); }
    button.addEventListener('click', toggle);
    root.addEventListener('click', outside);
    group.addEventListener('keydown', keyboard);
    group.addEventListener('focusout', focusout);
    list.addEventListener('click', follow);
    function render({entries: next = [], recordMode = false} = {}) {
      const nextSignature = JSON.stringify([next,recordMode]);
      if (signature === nextSignature) return;
      signature = nextSignature; model = next;
      const direct = !recordMode && model.length === 1 && !!model[0].url;
      const focusWasLink = root.activeElement === link, focusWasButton = root.activeElement === button;
      const focusedId = list.contains(root.activeElement) ? root.activeElement?.dataset?.destinationId : null;
      link.hidden = !direct; button.hidden = recordMode || direct;
      group.classList.toggle('has-viewer', !recordMode);
      const available = model.filter(item => item.url).length;
      button.classList.toggle('is-unavailable', !available);
      button.title = available ? 'Choose a destination viewer page (opens in a new tab)'
        : 'Viewer link not available yet · show details';
      button.setAttribute('aria-label', available ? 'Choose a destination viewer page' : 'Viewer link unavailable · show details');
      link.removeAttribute('href');
      if (direct) {
        link.href = model[0].url;
        link.title = 'Open ' + model[0].name + ' viewer page in a new tab';
        link.setAttribute('aria-label', link.title);
      }
      // Avoid replacing focused links every time Broadcast paints its telemetry.
      list.replaceChildren();
      for (const item of model) {
        const row = root.createElement('li');
        const content = root.createElement(item.url ? 'a' : 'div');
        content.className = 'bc-viewer-row' + (item.url ? '' : ' unavailable');
        if (item.url) {
          content.href = item.url; content.target = '_blank'; content.rel = 'noopener noreferrer';
          content.dataset.destinationId = item.id;
          content.setAttribute('aria-label', 'Open ' + item.name + ' viewer page in a new tab');
        }
        const name = root.createElement('strong'); name.textContent = item.name;
        const detail = root.createElement('span'); detail.textContent = item.detail;
        content.append(name, detail);
        if (item.url) { const icon = root.createElement('span'); icon.className = 'bc-viewer-arrow'; icon.textContent = '↗'; icon.setAttribute('aria-hidden','true'); content.append(icon); }
        row.append(content); list.append(row);
      }
      empty.hidden = model.length > 0;
      empty.textContent = 'Turn on a destination to see its viewer link here.';
      hint.textContent = available ? 'Opens in a new tab. Check picture and sound on the viewer page.'
        : 'Connected channels can provide a link during Go Live setup. Custom ingest destinations do not supply a viewing page.';
      if (recordMode || direct) close();
      if (recordMode && (focusWasLink || focusWasButton || focusedId)) root.getElementById('goLive')?.focus();
      else if (focusWasLink && !direct) button.focus();
      else if (focusWasButton && direct) link.focus();
      else if (focusedId && !menu.hidden) {
        const target = Array.from(list.querySelectorAll('a')).find(node => node.dataset.destinationId === focusedId);
        (target || menu).focus();
      } else if (focusedId && direct) link.focus();
    }
    return {render,close,destroy() {
      close(); button.removeEventListener('click',toggle); root.removeEventListener('click',outside);
      group.removeEventListener('keydown',keyboard); group.removeEventListener('focusout',focusout);
      list.removeEventListener('click',follow);
    }};
  }
  window.OpenLiveViewerLinks = {viewerUrl,entries,mount};
})();
