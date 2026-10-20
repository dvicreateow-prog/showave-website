/* One operator-owned stream setup. Provider sign-in and consent are handled
   by the existing accounts connector; output starts only on the final click. */
window.OpenLiveStreamSetup = (() => {
'use strict';
const STEPS = Object.freeze(['Channels', 'Stream details', 'Review & start']);
function readiness(snapshot) {
  const s = snapshot || {}, channels = Array.isArray(s.channels) ? s.channels : [];
  const selected = channels.filter(row => row.selected);
  const reasons = [];
  if (s.locked) reasons.push(String(s.locked));
  if (s.connecting) reasons.push('Finish platform sign-in before starting.');
  if (!selected.length) reasons.push('Select at least one channel.');
  selected.forEach(row => { if (!row.preflight || row.preflight.ok !== true)
    reasons.push(row.name + ': ' + (row.preflight && row.preflight.why || 'Channel readiness is unconfirmed.')); });
  ['programme', 'artifacts', 'capacity', 'details'].forEach(key => {
    if (!s[key] || s[key].ok !== true) reasons.push(s[key] && s[key].why || key + ' readiness is unconfirmed.');
  });
  return { ok:reasons.length === 0, selected:selected.length, reasons:[...new Set(reasons)] };
}
function startupOutcome(expected,attempts,reason = '') {
  const ids = new Set(Array.isArray(expected) ? expected.map(String) : []);
  const rows = (Array.isArray(attempts) ? attempts : []).filter(row=>row&&ids.has(String(row.id)));
  const queued = rows.filter(row=>['connecting','live','reconnecting'].includes(row.state));
  if (queued.length) return {ok:true,phase:'queued',queued:queued.length,requested:ids.size,
    why:queued.length<ids.size ? queued.length+' of '+ids.size+' outputs were queued. Review the remaining channel statuses in Studio.' : ''};
  const failures=rows.map(row=>row.error).filter(Boolean);
  return {ok:false,phase:'refused',queued:0,requested:ids.size,
    why:failures.join(' · ')||String(reason||'No live output was queued. Review setup and try again.')};
}
function mount(options) {
  const o = options || {}, doc = o.document;
  if (!doc || typeof o.read !== 'function' || typeof o.connect !== 'function' ||
      typeof o.select !== 'function' || typeof o.saveDetails !== 'function' || typeof o.start !== 'function')
    throw new Error('Stream setup needs the live Broadcast controls.');
  const node = (tag, className, parent, text) => {
    const n = doc.createElement(tag); if (className) n.className = className;
    if (text != null) n.textContent = String(text); if (parent) parent.append(n); return n;
  };
  const button = (text, parent, action, className = '') => {
    const b = node('button', 'tb-btn ' + className, parent, text); b.type = 'button';
    if (action) b.addEventListener('click', action); return b;
  };
  const overlay = node('div', 'bc-stream-setup-overlay', doc.body); overlay.id = 'streamSetup'; overlay.hidden = true;
  const dialog = node('section', 'bc-stream-setup', overlay);
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'streamSetupHeading');
  const header = node('header', '', dialog), heading = node('div', '', header);
  const title = node('h2', '', heading, 'Create stream'); title.id = 'streamSetupHeading'; title.tabIndex = -1;
  node('p', '', heading, 'Connect, choose channels, then start from one place.');
  const closeButton = button('×', header, () => close(), 'bc-stream-setup-close');
  closeButton.setAttribute('aria-label', 'Close stream setup');
  const steps = node('ol', 'bc-stream-setup-steps', dialog);
  const stepItems = STEPS.map((label, index) => {
    const item = node('li', '', steps, (index + 1) + ' · ' + label); return item;
  });
  const body = node('div', 'bc-stream-setup-body', dialog);
  const channelPane = node('section', '', body), detailsPane = node('section', '', body), reviewPane = node('section', '', body);
  node('h3', '', channelPane, 'Connect your channels');
  node('p', 'bc-stream-setup-hint', channelPane,
    'Click a platform to sign in. Review its permissions in the platform tab; available channels appear here when access is confirmed.');
  const providerSearch = node('input', 'bc-stream-setup-search', channelPane);
  providerSearch.type = 'search'; providerSearch.placeholder = 'Find a platform…';
  providerSearch.setAttribute('aria-label','Find a streaming platform');
  const providers = node('div', 'bc-stream-setup-providers', channelPane); providers.id = 'streamSetupProviders';
  const authResult = node('div', 'bc-stream-setup-status', channelPane); authResult.id = 'streamSetupConnectResult';
  authResult.setAttribute('role', 'status'); authResult.setAttribute('aria-live', 'polite');
  const prompt = node('div', 'bc-stream-setup-auth', channelPane); prompt.id = 'streamSetupAuth'; prompt.hidden = true;
  const channelHead = node('div', 'bc-stream-setup-channel-head', channelPane);
  const channelCount = node('h3', '', channelHead, 'Select channels');
  const refreshButton = button('Refresh channels', channelHead, () => refreshAccounts()); refreshButton.id = 'streamSetupRefresh';
  const channels = node('div', 'bc-stream-setup-channels', channelPane); channels.id = 'streamSetupChannels';
  const channelMessage = node('p', 'bc-stream-setup-hint', channelPane);
  node('h3', '', detailsPane, 'Name this stream');
  const fields = {};
  [['title','Title','input'],['description','Description','textarea'],['privacy','Visibility','select'],['profile','Video quality','select']].forEach(([key,label,tag]) => {
    const wrap = node('label', 'bc-stream-setup-field', detailsPane); node('span', '', wrap, label);
    const input = node(tag, '', wrap); input.id = 'streamSetup' + key[0].toUpperCase() + key.slice(1); fields[key] = input;
    if (key === 'title') { input.type = 'text'; input.maxLength = 140; input.placeholder = 'Your show title'; }
    if (key === 'description') { input.maxLength = 5000; input.rows = 3; }
    if (key === 'privacy') [['','Platform default'],['public','Public'],['unlisted','Unlisted'],['private','Private']].forEach(([value,text]) => {
      const opt = node('option', '', input, text); opt.value = value;
    });
    if (key === 'profile') [['1080p30','1080p · 30 fps'],['720p30','720p · 30 fps'],['720p60','720p · 60 fps']].forEach(([value,text]) => {
      const opt = node('option', '', input, text); opt.value = value;
    });
  });
  const audienceWrap = node('label', 'bc-stream-setup-field', detailsPane);
  node('span', '', audienceWrap, 'YouTube audience');
  fields.audience = node('select', '', audienceWrap); fields.audience.id = 'streamSetupAudience';
  [['','Choose the audience for this stream'],['false','Not made for kids'],['true','Made for kids']].forEach(([value,text]) => {
    const opt = node('option','',fields.audience,text); opt.value = value;
  });
  node('p', 'bc-stream-setup-hint', audienceWrap,
    'YouTube requires you to declare whether this stream is made for children. Choose the setting that describes the content; SHOWAVE does not choose it for you.');
  const detailNote = node('p', 'bc-stream-setup-hint', detailsPane);
  const privacyNote = node('p', 'bc-stream-setup-hint', detailsPane);
  const detailsStatus = node('div', 'bc-stream-setup-status', detailsPane); detailsStatus.setAttribute('role','status');
  node('h3', '', reviewPane, 'Ready to go live?');
  const summary = node('div', 'bc-stream-setup-summary', reviewPane);
  const checks = node('ul', 'bc-stream-setup-checks', reviewPane); checks.id = 'streamSetupChecks';
  const sourceButton = button('Set up programme', reviewPane, () => {
    close(); if (o.editProgramme) o.editProgramme();
  }); sourceButton.id = 'streamSetupProgramme';
  const settingsButton = button('Recording settings', reviewPane, () => {
    close(); if (o.editRecording) o.editRecording();
  }); settingsButton.id = 'streamSetupRecordings';
  node('p', 'bc-stream-setup-hint', reviewPane,
    'Go Live creates the platform broadcast and sends the current Programme to every selected channel. Provider confirmation and viewer playback are shown separately in Studio.');
  const result = node('div', 'bc-stream-setup-status', dialog); result.id = 'streamSetupResult';
  result.setAttribute('role','status'); result.setAttribute('aria-live','polite');
  const footer = node('footer', '', dialog);
  const backButton = button('Back', footer, () => go(Math.max(0, step - 1))); backButton.id = 'streamSetupBack';
  const nextButton = button('Continue', footer, () => next(), 'on'); nextButton.id = 'streamSetupNext';
  const startButton = button('Go Live', footer, () => start(), 'on'); startButton.id = 'streamSetupStart';
  let opened = false, step = 0, returnFocus = null, refreshing = false, starting = false, signature = '';
  let backgroundInert = false;
  const background = doc.querySelector('.win-root');
  let detailsOwner = '', pendingOwnerChange = false, startError = '';
  const detailDrafts = new Map();
  let detailsBaseline = '', detailsBaselineValues = '';
  const read = () => o.read();
  function message(text, bad = false) { result.textContent = String(text || ''); result.classList.toggle('bad',bad); }
  function valuesFromSnapshot(snapshot) {
    const details = snapshot.info || {};
    return {title:details.title || '',description:details.description || '',
      privacy:details.privacy || '',profile:details.profile || '1080p30',
      audience:typeof details.madeForKids === 'boolean' ? String(details.madeForKids) : ''};
  }
  function currentDetailValues() {
    return Object.fromEntries(Object.keys(fields).map(key => [key, fields[key].value]));
  }
  function rememberDetails() {
    if (step !== 1 || pendingOwnerChange) return;
    const values = currentDetailValues();
    if (JSON.stringify(values) === detailsBaselineValues) { detailDrafts.delete(detailsOwner); return; }
    detailDrafts.set(detailsOwner, {baseline:detailsBaseline,values});
  }
  function fillDetails(snapshot) {
    const saved = valuesFromSnapshot(snapshot), owner = String(snapshot.info?.owner || '');
    const baseline = JSON.stringify(saved), held = detailDrafts.get(owner);
    // An in-dialog buffer belongs to one Show/Studio and its exact saved values.
    // Returning after an external edit must show the current saved draft rather
    // than silently replacing it with text from an older view.
    const restore = held && held.baseline === baseline;
    const values = restore ? held.values : saved;
    if (held && !restore) detailDrafts.delete(owner);
    Object.keys(fields).forEach(key => { fields[key].value = values[key]; });
    detailsOwner = owner; detailsBaseline = baseline; detailsBaselineValues = baseline;
    pendingOwnerChange = false;
    detailsStatus.textContent = restore ? 'Your edits were kept in this setup. Continue saves them.'
      : held ? 'Saved stream details changed. Review the current values before continuing.' : '';
  }
  function renderProviders(snapshot) {
    providers.replaceChildren();
    const query = providerSearch.value.trim().toLocaleLowerCase();
    (snapshot.providers || []).filter(provider => !query || provider.name.toLocaleLowerCase().includes(query)).forEach(provider => {
      const card = button('', providers, () => {
        if (snapshot.locked) { message(snapshot.locked, true); return; }
        if (!provider.ready) { authResult.textContent = provider.note || 'This platform is unavailable in this installation.'; return; }
        // The call is synchronous within the click so the account browser can
        // reserve its tab before awaiting the helper's authorization handoff.
        Promise.resolve(o.connect(provider.target, {prompt, result:authResult, changed:refresh})).catch(() => {
          authResult.textContent = 'Connection was not confirmed. Refresh channels before trying again.';
        }); refresh();
      }, 'bc-stream-setup-provider');
      card.dataset.providerId = provider.id; card.disabled = !!snapshot.connecting || !!snapshot.locked;
      card.setAttribute('aria-label', provider.name + ': ' + (provider.ready ? provider.actionLabel || 'Sign in' : 'Setup needed'));
      card.dataset.ready = String(provider.ready === true);
      node('strong', '', card, provider.name);
      node('span', '', card, snapshot.connecting === provider.id ? 'Waiting for sign-in…' : provider.ready ? provider.actionLabel || 'Sign in' : 'Setup needed');
      card.title = provider.note || ('Connect ' + provider.name);
    });
  }
  function renderChannels(snapshot) {
    channels.replaceChildren();
    const rows = snapshot.channels || [];
    rows.forEach(row => {
      const label = node('label', 'bc-stream-setup-channel', channels);
      const input = node('input', '', label); input.type = 'checkbox'; input.checked = row.selected === true;
      input.dataset.channelId = row.id; input.setAttribute('aria-label', 'Select ' + row.name);
      input.disabled = !!snapshot.locked || !!snapshot.connecting || (!row.selected && row.selection?.ok !== true);
      input.addEventListener('change', () => {
        if (!o.select(row.id, input.checked)) message('The selection could not change. Review this channel’s readiness and try again.', true);
        else message(''); refresh(true);
      });
      const text = node('div', '', label); node('strong', '', text, row.name);
      node('span', '', text, row.platform + ' · ' + (row.selected ? 'Selected' : 'Not selected'));
      const status = row.preflight?.ok ? 'Ready for local preflight' : row.preflight?.why || row.selection?.why || 'Checking channel…';
      node('small', row.preflight?.ok ? 'ready' : '', text, status);
      const action = row.preflight?.actionUrl || row.selection?.actionUrl;
      if (action) {
        let safe; try { const u = new URL(action); if (u.protocol === 'https:' && !u.username && !u.password) safe = u.href; } catch (_) {}
        if (safe) { const link = node('a', '', text, row.preflight?.actionLabel || row.selection?.actionLabel || 'Open platform setup');
          link.href = safe; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.addEventListener('click', event => event.stopPropagation()); }
      }
    });
    const selected = rows.filter(row => row.selected).length;
    channelCount.textContent = 'Select channels · ' + selected + ' selected';
    channelMessage.textContent = snapshot.catalogueError || (!rows.length
      ? 'No channels are connected yet. Sign in above, then choose the channels for this stream.'
      : 'Every selected channel receives the same Programme. Deselection leaves the account connected.');
  }
  function renderReview(snapshot) {
    const selected = (snapshot.channels || []).filter(row => row.selected);
    summary.textContent = (snapshot.info?.title || 'Untitled stream') + ' · ' + selected.map(row => row.name).join(' + ');
    checks.replaceChildren();
    [['Programme', snapshot.programme], ['Recordings', snapshot.artifacts], ['Output capacity', snapshot.capacity], ['Stream details', snapshot.details]].forEach(([label,check]) => {
      const item = node('li', check?.ok ? 'ready' : 'blocked', checks);
      node('strong', '', item, (check?.ok ? '✓ ' : '○ ') + label);
      node('span', '', item, check?.why || (check?.ok ? 'Ready' : 'Not ready'));
    });
    selected.forEach(row => { const check = row.preflight; const item = node('li', check?.ok ? 'ready' : 'blocked', checks);
      node('strong', '', item, (check?.ok ? '✓ ' : '○ ') + row.name);
      node('span', '', item, check?.ok ? (row.visibility || 'Ready; no media is being sent yet.') : check?.why || 'Not ready'); });
    const state = readiness(snapshot); startButton.disabled = starting || !state.ok;
    startButton.title = state.ok ? 'Create the broadcasts and transmit Programme to every selected channel.' : state.reasons.join(' ');
    sourceButton.hidden = snapshot.programme?.ok === true; settingsButton.hidden = snapshot.artifacts?.ok === true;
    if (!starting) message(startError || (state.ok ? 'Ready. Nothing is streaming until you click Go Live.' : state.reasons.join('\n')), !!startError || !state.ok);
  }
  function refresh(force = false) {
    if (!opened) return;
    const snapshot = read();
    if (step === 1 && String(snapshot.info?.owner || '') !== detailsOwner) {
      pendingOwnerChange = true; detailsStatus.textContent = 'The shared Show changed. Go Back, then reopen Stream details before saving.';
    }
    const currentSignature = JSON.stringify([snapshot,step,refreshing,starting]);
    if (!force && signature === currentSignature) return; signature = currentSignature;
    const active = doc.activeElement;
    const focusId = active?.dataset?.channelId, focusProvider = active?.dataset?.providerId;
    [channelPane,detailsPane,reviewPane].forEach((pane,index) => { pane.hidden = index !== step; });
    stepItems.forEach((item,index) => { item.classList.toggle('current',index === step);
      if (index === step) item.setAttribute('aria-current','step'); else item.removeAttribute('aria-current'); });
    backButton.hidden = step === 0; backButton.disabled = starting || !!snapshot.connecting;
    nextButton.hidden = step === 2; startButton.hidden = step !== 2;
    nextButton.disabled = starting || !!snapshot.connecting || !!snapshot.locked ||
      (step === 0 && !(snapshot.channels || []).some(row => row.selected)) || (step === 1 && pendingOwnerChange);
    refreshButton.disabled = refreshing || !!snapshot.connecting || !!snapshot.locked;
    refreshButton.textContent = refreshing ? 'Checking…' : 'Refresh channels';
    if (step === 0) { renderProviders(snapshot); renderChannels(snapshot); }
    fields.title.maxLength = snapshot.info?.titleLimit || 140;
    audienceWrap.hidden = !snapshot.info?.youtubeSelected;
    detailNote.textContent = snapshot.info?.shared
      ? 'Continue saves title and description to the current Show. Back or Close keeps your edits in this setup.'
      : 'Continue saves these details to this Studio. Back or Close keeps your edits in this setup.';
    privacyNote.textContent = snapshot.visibilityNote || 'Visibility applies only where the platform supports it. Platform default keeps its existing setting.';
    if (step === 2) renderReview(snapshot);
    if (focusId || focusProvider) {
      const match = [...dialog.querySelectorAll(focusId ? '[data-channel-id]' : '[data-provider-id]')]
        .find(n => focusId ? n.dataset.channelId === focusId : n.dataset.providerId === focusProvider);
      try { if (match && !match.disabled) match.focus(); } catch (_) {}
    }
  }
  function go(index) {
    const snapshot = read(); if (snapshot.connecting || starting) return;
    rememberDetails();
    step = index; signature = ''; startError=''; message(''); if (step === 1) fillDetails(snapshot);
    refresh(true); title.focus();
  }
  function next() {
    const snapshot = read(); if (snapshot.locked || snapshot.connecting || starting) { refresh(); return; }
    if (step === 0) { if (!(snapshot.channels || []).some(row => row.selected)) return; go(1); return; }
    if (step !== 1 || pendingOwnerChange) return;
    if (String(snapshot.info?.owner || '') !== detailsOwner) { refresh(true); return; }
    const titleText = fields.title.value.trim() || String(snapshot.info?.fallbackTitle || 'Live with SHOWAVE').trim();
    const audienceVal = ['true','false'].includes(fields.audience.value) ? fields.audience.value : '';
    if (snapshot.info?.youtubeSelected && !audienceVal) {
      detailsStatus.textContent = 'Choose whether this YouTube stream is made for kids before continuing.';
      fields.audience.focus(); return;
    }
    const result = o.saveDetails({title:titleText, description:fields.description.value,
      privacy:fields.privacy.value, profile:fields.profile.value,
      ...(snapshot.info?.youtubeSelected ? {madeForKids:audienceVal === 'true'} : {})}, detailsOwner);
    if (!result || result.ok === false) { detailsStatus.textContent = result?.why || 'Details could not be saved. Previous values were kept.'; return; }
    detailDrafts.delete(detailsOwner);
    // go() remembers a details pane while leaving it. Refresh its baseline
    // after a confirmed save so the committed values are not retained as an
    // unsaved buffer and restored over a later authoritative edit.
    detailsBaselineValues = JSON.stringify(currentDetailValues());
    go(2);
  }
  async function refreshAccounts() {
    if (refreshing || read().connecting) return; refreshing = true; refresh();
    try { if (o.refreshAccounts) await o.refreshAccounts(); }
    catch (_) { authResult.textContent = 'The helper could not refresh channels. Existing selections were kept.'; }
    finally { refreshing = false; refresh(true); }
  }
  function open() {
    const snapshot = read(); if (snapshot.locked) { if (o.note) o.note(snapshot.locked); return false; }
    returnFocus = doc.activeElement; opened = true; step = 0; starting = false; signature = '';
    if (background) { backgroundInert = background.inert; background.inert = true; }
    overlay.hidden = false; startError=''; message(''); authResult.textContent = ''; refresh(true); title.focus();
    refreshAccounts(); return true;
  }
  function close() {
    if (opened) rememberDetails();
    opened = false; overlay.hidden = true; signature = '';
    if (background) background.inert = backgroundInert;
    if (o.onClose) o.onClose(); try { returnFocus?.focus(); } catch (_) {} returnFocus = null;
  }
  async function start() {
    if (starting) return;
    const snapshot = read(), state = readiness(snapshot);
    if (!state.ok) { refresh(true); return; }
    starting = true; startError=''; startButton.disabled = true; message('Preparing the selected channels…');
    try {
      // The existing master action repeats authoritative checks immediately
      // before provisioning. This dialog never calls an output transport.
      const outcome=await o.start();
      if (outcome?.ok===true && outcome.phase==='queued' && outcome.queued>0) {if(outcome.why&&o.note)o.note(outcome.why);close();return;}
      starting=false;startError=outcome?.why || 'No live output was queued. Review the current setup and try again.';refresh(true);
    } catch (_) { starting=false;startError='Stream startup failed. Check the channel status in Studio before retrying.';refresh(true); }
  }
  closeButton.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
  Object.values(fields).forEach(input => input.addEventListener('input', () => {
    if (!opened || step !== 1) return;
    rememberDetails();
    if (!pendingOwnerChange) detailsStatus.textContent = detailDrafts.has(detailsOwner)
      ? 'Changes kept in this setup. Continue saves them.' : '';
  }));
  providerSearch.addEventListener('input', () => { if (opened) renderProviders(read()); });
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  const keyHandler = event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')]
      .filter(n => !n.hidden && n.offsetParent !== null);
    const first = nodes[0], last = nodes[nodes.length - 1]; if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last || !dialog.contains(doc.activeElement)) { event.preventDefault(); first.focus(); }
    event.stopImmediatePropagation();
  };
  doc.addEventListener('keydown', keyHandler, true);
  return Object.freeze({ open, close, refresh, isOpen:() => opened, destroy:() => {
    close(); detailDrafts.clear(); doc.removeEventListener('keydown',keyHandler,true); overlay.remove();
  }});
}
return Object.freeze({ STEPS, readiness, startupOutcome, mount });
})();
