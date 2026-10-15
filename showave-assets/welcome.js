import { STORAGE_KEY, DRAFT_LINK, ROLES, toolFor, guideFor, filterTools, readWelcomeStore, serializeWelcomeStore, recordRecent } from './welcome-model.js';

const page = document.querySelector('[data-welcome-page]');
if (page) {
  const find = selector => page.querySelector(selector);
  const all = selector => [...page.querySelectorAll(selector)];
  const search = find('[data-welcome-search]');
  const startup = find('[data-welcome-startup]');
  const storageStatus = find('[data-welcome-storage]');
  let state = readWelcomeStore(null);
  let storageAvailable = true;
  try { state = readWelcomeStore(localStorage.getItem(STORAGE_KEY)); }
  catch { storageAvailable = false; }

  function storageMessage() {
    storageStatus.textContent = storageAvailable ? '' : 'Browser storage is unavailable. Preferences and activity last for this visit.';
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, serializeWelcomeStore(state)); storageAvailable = true; }
    catch { storageAvailable = false; }
    storageMessage();
  }

  function renderSelection() {
    const tool = toolFor(state.preferences.selectedId);
    if (!tool) return;
    const panel = find('#welcome-selection');
    panel.style.setProperty('--instrument-color', tool.color);
    find('[data-welcome-selected-icon]').src = tool.icon;
    find('[data-welcome-selected-code]').textContent = `${tool.code} / ${tool.role.toUpperCase()}`;
    find('[data-welcome-selected-name]').textContent = tool.name;
    find('[data-welcome-selected-description]').textContent = tool.description;
    find('[data-welcome-selected-note]').textContent = tool.note;
    const guide = find('[data-welcome-guide]');
    guide.href = guideFor(tool.id);
    guide.setAttribute('aria-label', `Open ${tool.name} guide`);
    all('[data-welcome-tool]').forEach(button => {
      const selected = button.dataset.welcomeTool === tool.id;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('.welcome-choice').textContent = selected ? '●' : '○';
    });
  }

  function renderFilter() {
    const matches = filterTools(state.preferences.role, search.value);
    const visible = new Set(matches.map(tool => tool.id));
    all('[data-welcome-tool]').forEach(button => { button.hidden = !visible.has(button.dataset.welcomeTool); });
    all('[data-welcome-role]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.welcomeRole === state.preferences.role));
    });
    find('[data-welcome-count]').textContent = `${matches.length} instrument${matches.length === 1 ? '' : 's'}`;
    find('[data-welcome-empty]').hidden = matches.length > 0;
    find('#welcome-selection').hidden = matches.length === 0;
    if (matches.length && !visible.has(state.preferences.selectedId)) state.preferences.selectedId = matches[0].id;
    renderSelection();
  }

  function renderRecents() {
    const list = find('[data-welcome-recents]');
    const children = state.recents.map(recent => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = recent.href;
      link.dataset.welcomeRecent = recent.href;
      link.setAttribute('data-barba-prevent', 'all');
      const name = document.createElement('span');
      name.textContent = recent.title;
      const date = document.createElement('time');
      date.dateTime = new Date(recent.visitedAt).toISOString();
      date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(recent.visitedAt);
      link.append(name, date);
      item.append(link);
      return item;
    });
    if (!children.length) {
      const empty = document.createElement('li');
      empty.className = 'welcome-recent-empty';
      empty.textContent = 'Your first guide will appear here.';
      children.push(empty);
    }
    list.replaceChildren(...children);
    find('[data-welcome-clear]').hidden = state.recents.length === 0;
  }

  function remember(href) {
    state = recordRecent(state, href);
    save();
    renderRecents();
  }

  all('[data-welcome-tool]').forEach(button => button.addEventListener('click', () => {
    if (!toolFor(button.dataset.welcomeTool)) return;
    state.preferences.selectedId = button.dataset.welcomeTool;
    renderSelection();
    save();
  }));

  all('[data-welcome-role]').forEach(button => button.addEventListener('click', () => {
    if (!ROLES.some(role => role.id === button.dataset.welcomeRole)) return;
    state.preferences.role = button.dataset.welcomeRole;
    renderFilter();
    save();
  }));
  search.addEventListener('input', renderFilter);
  find('[data-welcome-reset]').addEventListener('click', () => {
    search.value = '';
    state.preferences.role = 'general';
    renderFilter();
    save();
    search.focus();
  });
  startup.addEventListener('change', () => {
    state.preferences.welcomeOnStart = startup.checked;
    save();
  });
  find('[data-welcome-clear]').addEventListener('click', () => {
    state.recents = [];
    save();
    renderRecents();
    find('[data-welcome-drafts]').focus();
    if (storageAvailable) storageStatus.textContent = 'Recent activity cleared.';
  });
  find('[data-welcome-guide]').addEventListener('click', () => remember(guideFor(state.preferences.selectedId)));
  find('[data-welcome-drafts]').addEventListener('click', () => remember(DRAFT_LINK));
  find('[data-welcome-recents]').addEventListener('click', event => {
    const link = event.target.closest('a[data-welcome-recent]');
    if (link) remember(link.dataset.welcomeRecent);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (event.target.closest?.('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    search.focus();
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    state = readWelcomeStore(event.key === null ? null : event.newValue);
    startup.checked = state.preferences.welcomeOnStart;
    renderFilter();
    renderRecents();
  });

  // An optional host can use this API; this page never redirects on its own.
  window.SHOWAVEWelcome = Object.freeze({
    route: '/start',
    startupEnabled: () => state.preferences.welcomeOnStart,
    setStartup(enabled) { state.preferences.welcomeOnStart = enabled === true; startup.checked = state.preferences.welcomeOnStart; save(); },
    open() { window.location.assign('/start'); }
  });
  startup.checked = state.preferences.welcomeOnStart;
  renderFilter();
  renderRecents();
  storageMessage();
}
