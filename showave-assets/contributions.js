import { communityConfig, githubLink } from './community-config.js';
import { CONTRIBUTION_TYPES, EARLIEST_DATE, MAX_DRAFTS, todayISO, normalizeRegistry, contributionYear, rankContributors, validateDraft, readDraftStore, navigationLink } from './contribution-model.js';

const mount = document.getElementById('community-dashboard');
const STORAGE_KEY = 'showave.community.drafts.v1';
const dateLabel = date => new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
const button = (text, className = '') => {
  const element = node('button', `community-button ${className}`, text);
  element.type = 'button'; return element;
};
const panel = (title, id, note) => {
  const element = node('section', 'community-panel');
  element.setAttribute('aria-labelledby', id);
  const heading = node('h2', 'community-heading', title); heading.id = id;
  element.append(heading);
  if (note) element.append(node('p', 'community-note', note));
  return element;
};
const evidenceLink = url => {
  const link = node('a', 'community-source', 'View evidence ↗');
  link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', 'View public evidence (opens in a new tab)'); return link;
};
const navigation = (url, label) => {
  const link = node('a', 'community-source', label); link.href = url;
  if (url.startsWith('https://')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', `${label} (opens in a new tab)`); }
  return link;
};

function start() {
  const today = todayISO(), currentYear = Number(today.slice(0, 4));
  const registry = normalizeRegistry(communityConfig, { today });
  const guideUrl = navigationLink(communityConfig.links.contributionGuide);
  let year = currentYear, selectedDate = today, drafts = [], storageAvailable = true, rejectedDrafts = 0;
  try {
    const stored = readDraftStore(localStorage.getItem(STORAGE_KEY), { today });
    drafts = stored.drafts; rejectedDrafts = stored.rejected;
  } catch { storageAvailable = false; }

  const dashboard = node('div', 'community-dashboard');
  const intro = node('div', 'community-dashboard-intro');
  const scope = node('span', 'community-tag community-tag-verified', 'Verified registry');
  intro.append(scope, node('p', '', 'A shared record of work, with recognition on your terms. The calendar and contributor list include maintainer-verified contributions. Every kind of contribution matters.'));
  dashboard.append(intro);
  if (registry.issues.length) {
    const warning = node('p', 'community-notice', 'Some registry records could not be validated and have been excluded. The published totals include only valid records.');
    warning.setAttribute('role', 'status'); dashboard.append(warning);
  }

  const buildPanel = panel('Find the work. Join the review.', 'community-build-title', 'Use the contribution guide to prepare a focused change. Contributors with access can discuss it in the current repository and request a review.');
  buildPanel.id = 'build-with-us'; buildPanel.classList.add('community-build');
  const buildGrid = node('div', 'community-build-grid');
  const repositoryCard = node('div', 'community-repository-card');
  const repositoryHeading = node('div', 'community-repository-heading');
  repositoryHeading.append(node('span', 'community-tag community-tag-draft', 'Access required'), node('span', 'community-build-kicker', 'CURRENT DEVELOPMENT HOME'));
  repositoryCard.append(repositoryHeading, node('h3', '', 'Build in the open.'), node('p', 'community-repository-path', 'dvicreateow-prog / openlive'), node('p', 'community-note', 'Free and open source is our commitment. The current GitHub links require repository access. The contribution guide explains source publication and licensing status.'));
  const repositoryUrl = githubLink(communityConfig.links.repository);
  if (repositoryUrl) {
    const link = navigation(repositoryUrl, 'Open repository ↗'); link.className = 'community-button community-button-primary'; repositoryCard.append(link);
  }
  const workLinks = node('nav', 'community-work-links'); workLinks.setAttribute('aria-label', 'Current project on GitHub');
  [
    { key: 'issues', title: 'Issues', description: 'Issue tracker · access required' },
    { key: 'pullRequests', title: 'Pull requests', description: 'Code reviews · access required' }
  ].forEach(item => {
    const url = githubLink(communityConfig.links[item.key]); if (!url) return;
    const link = navigation(url, `${item.title} on GitHub`); link.className = 'community-work-link';
    const label = node('span'); label.append(node('strong', '', item.title), node('span', 'community-note', item.description));
    const arrow = node('span', 'community-link-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true');
    link.replaceChildren(label, arrow); workLinks.append(link);
  });
  repositoryCard.append(workLinks);
  const futureCard = node('div', 'community-future-card');
  futureCard.append(node('span', 'community-tag community-tag-verified', 'A useful first step'), node('h3', '', 'Start small.'), node('p', 'community-note', 'Choose a contribution track above. Describe one problem, gather a reproducible example and agree the scope before a larger change. Code, artwork, translations and documentation all benefit from review.'));
  if (guideUrl) { const link = navigation(guideUrl, 'Read the contribution guide ↗'); link.className = 'community-button community-button-outline'; futureCard.append(link); }
  buildGrid.append(repositoryCard, futureCard); buildPanel.append(buildGrid);
  const buildFooter = node('div', 'community-build-footer');
  if (guideUrl) buildFooter.append(navigation(guideUrl, 'Start with the contribution guide ↗'));
  buildFooter.append(node('p', 'community-note', 'GitHub links open in a new tab. Your local drafts stay in this browser and are not submitted by opening these links.'));
  buildPanel.append(buildFooter); dashboard.append(buildPanel);

  const activity = panel('Contribution activity', 'community-activity-title');
  activity.classList.add('community-activity');
  const toolbar = node('div', 'community-toolbar');
  const yearLabel = node('label', 'community-year-label', 'Year'); yearLabel.htmlFor = 'community-year';
  const yearSelect = node('select', 'community-select'); yearSelect.id = 'community-year';
  for (let candidate = currentYear; candidate >= 2000; candidate--) {
    const option = node('option', '', candidate); option.value = String(candidate); yearSelect.append(option);
  }
  toolbar.append(node('p', 'community-note', 'Code, design, testing, documentation, translation and community work.'), yearLabel, yearSelect);
  activity.append(toolbar);
  const dateControls = node('div', 'community-date-controls');
  const inspectLabel = node('label', '', 'Inspect a day'); inspectLabel.htmlFor = 'community-inspect-day';
  const datePicker = node('input', 'community-select'); datePicker.type = 'date'; datePicker.id = 'community-inspect-day'; datePicker.value = today;
  dateControls.append(inspectLabel, datePicker);
  const metrics = node('dl', 'community-metrics');
  const calendarHost = node('div', 'community-calendar-host');
  const calendarStatus = node('p', 'community-empty-summary');
  const instructions = node('p', 'community-note community-calendar-help', 'Use arrow keys to move between days; Home and End jump to the first and last available day. The calendar scrolls horizontally on smaller screens.');
  instructions.id = 'community-calendar-help';
  const legend = node('div', 'community-legend');
  legend.setAttribute('aria-label', 'Calendar legend: 0, 1, 2, 3, or 4 or more verified contributions per day.');
  legend.append(node('span', '', 'Contributions per day'));
  [0, 1, 2, 3, 4].forEach(level => {
    const item = node('span', 'community-legend-item');
    const swatch = node('i', `community-cell-swatch level-${level}`); swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, node('span', '', level === 4 ? '4+' : level)); legend.append(item);
  });
  const dayDetail = node('div', 'community-day-detail'); dayDetail.setAttribute('aria-live', 'polite'); dayDetail.setAttribute('aria-atomic', 'true');
  activity.append(metrics, calendarStatus, calendarHost, legend, instructions, dateControls, dayDetail);
  dashboard.append(activity);

  const rankings = panel('People behind the progress', 'community-rankings-title', 'Recognition for verified work in the selected year. Counts describe recorded activity; they do not measure a person’s value or give them decision-making authority.');
  const rankingsBody = node('div', 'community-rankings-body'); rankings.append(rankingsBody);
  dashboard.append(rankings);

  function showDay(day) {
    selectedDate = day.date;
    datePicker.value = day.date;
    const title = node('h3', '', dateLabel(day.date));
    const detail = document.createDocumentFragment(); detail.append(title);
    if (!day.count) detail.append(node('p', 'community-note', 'No verified contributions recorded for this day.'));
    else {
      const list = node('ul', 'community-evidence-list');
      day.records.forEach(record => {
        const item = node('li');
        item.append(node('p', '', record.description), node('span', 'community-note', `${CONTRIBUTION_TYPES[record.type]} · ${record.name}`), evidenceLink(record.sourceUrl));
        list.append(item);
      });
      detail.append(list);
    }
    dayDetail.replaceChildren(detail);
  }

  function renderActivity() {
    const summary = contributionYear(registry.records, year, { today });
    datePicker.min = `${year}-01-01`; datePicker.max = year === currentYear ? today : `${year}-12-31`;
    const labels = { contributions: 'Verified contributions', contributors: 'Contributors', activeDays: 'Active days', types: 'Contribution types' };
    metrics.replaceChildren(...Object.entries(labels).map(([key, label]) => {
      const item = node('div', 'community-metric');
      item.append(node('dt', '', label), node('dd', '', summary.metrics[key])); return item;
    }));
    calendarStatus.textContent = summary.metrics.contributions ? `${summary.metrics.contributions} verified contributions recorded in ${year}.` : `No verified contributions recorded for ${year} yet. This graph will grow when checked records are added.`;
    const available = summary.days.filter(day => !day.future);
    let activeIndex = summary.days.findIndex(day => day.date === selectedDate && !day.future);
    if (activeIndex < 0) activeIndex = available.length - 1;
    const scroller = node('div', 'community-calendar-scroller');
    const months = node('div', 'community-calendar-months'); months.setAttribute('aria-hidden', 'true');
    months.style.setProperty('--community-weeks', String(summary.weeks));
    summary.days.forEach((day, index) => {
      if (!day.date.endsWith('-01')) return;
      const month = node('span', '', new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${day.date}T00:00:00Z`)));
      month.style.gridColumn = String(Math.floor((summary.offset + index) / 7) + 2); months.append(month);
    });
    const grid = node('div', 'community-calendar');
    grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', `Verified contributions in ${year}`);
    grid.setAttribute('aria-describedby', instructions.id); grid.setAttribute('aria-rowcount', '7'); grid.setAttribute('aria-colcount', String(summary.weeks + 1));
    grid.style.setProperty('--community-weeks', String(summary.weeks));
    const dayButtons = new Map();
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    function selectDay(index, focus) {
      if (index < 0 || index >= available.length) return;
      dayButtons.get(activeIndex)?.setAttribute('tabindex', '-1');
      dayButtons.get(activeIndex)?.removeAttribute('aria-current');
      activeIndex = index;
      const target = dayButtons.get(index); target.tabIndex = 0; target.setAttribute('aria-current', 'date');
      showDay(summary.days[index]);
      if (focus) target.focus({ preventScroll: false });
    }
    weekdays.forEach((weekday, rowIndex) => {
      const row = node('div', 'community-calendar-row'); row.setAttribute('role', 'row'); row.setAttribute('aria-rowindex', String(rowIndex + 1));
      const label = node('span', 'community-weekday', weekday); label.setAttribute('role', 'rowheader'); label.setAttribute('aria-colindex', '1'); row.append(label);
      for (let week = 0; week < summary.weeks; week++) {
        const index = week * 7 + rowIndex - summary.offset, day = summary.days[index];
        const cell = node('div', 'community-calendar-cell'); cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(week + 2));
        if (day) {
          const dayButton = node('button', `community-day level-${Math.min(day.count, 4)}`); dayButton.type = 'button';
          const text = `${dateLabel(day.date)}: ${day.future ? 'future date' : `${day.count} verified contribution${day.count === 1 ? '' : 's'}`}`;
          dayButton.setAttribute('aria-label', text); dayButton.title = text; dayButton.disabled = day.future;
          dayButton.tabIndex = index === activeIndex ? 0 : -1;
          if (index === activeIndex) dayButton.setAttribute('aria-current', 'date');
          if (day.future) dayButton.classList.add('is-future');
          dayButton.addEventListener('focus', () => selectDay(index, false));
          dayButton.addEventListener('click', () => selectDay(index, false));
          dayButton.addEventListener('keydown', event => {
            const moves = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
            let next;
            if (Object.hasOwn(moves, event.key)) next = Math.max(0, Math.min(available.length - 1, index + moves[event.key]));
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = available.length - 1;
            else return;
            event.preventDefault(); selectDay(next, true);
          });
          dayButtons.set(index, dayButton); cell.append(dayButton);
        } else cell.setAttribute('aria-hidden', 'true');
        row.append(cell);
      }
      grid.append(row);
    });
    scroller.append(months, grid); calendarHost.replaceChildren(scroller);
    if (activeIndex >= 0) showDay(summary.days[activeIndex]);
    const rows = rankContributors(registry.records, year, { today });
    if (!rows.length) {
      const empty = node('div', 'community-empty-state');
      empty.append(node('span', 'community-empty-number', '—'), node('h3', '', 'Room for your contribution.'), node('p', 'community-note', 'Verified contributions will appear here. Names are published only with consent, and anonymous recognition is welcome. Local drafts stay separate from this public record.'));
      rankingsBody.replaceChildren(empty);
    } else {
      const table = node('table', 'community-ranking-table');
      const caption = node('caption', 'community-sr-only', `Contributors with verified work in ${year}`);
      const head = node('thead'), header = node('tr');
      ['Contributor', 'Verified contributions', 'Active days'].forEach(text => { const th = node('th', '', text); th.scope = 'col'; header.append(th); }); head.append(header);
      const body = node('tbody');
      rows.forEach(person => {
        const row = node('tr');
        const identity = node('th', '', person.name); identity.scope = 'row';
        if (person.anonymous) identity.append(node('span', 'community-tag', 'Anonymous'));
        row.append(identity, node('td', '', person.count), node('td', '', person.activeDays)); body.append(row);
      });
      table.append(caption, head, body);
      const wrap = node('div', 'community-table-scroller'); wrap.append(table); rankingsBody.replaceChildren(wrap);
    }
  }
  yearSelect.addEventListener('change', () => { year = Number(yearSelect.value); renderActivity(); });
  datePicker.addEventListener('change', () => {
    if (!datePicker.value || !datePicker.validity.valid) { datePicker.value = selectedDate; return; }
    selectedDate = datePicker.value; renderActivity();
  });

  const localArea = node('div', 'community-local-grid');
  const draftPanel = panel('Keep a contribution draft', 'community-draft-title', 'Record work you would like to share later. Drafts stay in this browser and never change the verified graph or rankings.');
  draftPanel.append(node('span', 'community-tag community-tag-draft', 'Local · Unverified'));
  const form = node('form', 'community-draft-form'); form.noValidate = true;
  const fields = {}, errorNodes = {};
  function addField(key, labelText, input, hint) {
    const field = node('div', 'community-field');
    input.id = `community-draft-${key}`; input.name = key;
    const label = node('label', '', labelText); label.htmlFor = input.id;
    const error = node('span', 'community-error'); error.id = `${input.id}-error`; error.hidden = true;
    field.append(label, input);
    const describedBy = [error.id];
    if (hint) { const note = node('span', 'community-field-hint', hint); note.id = `${input.id}-hint`; field.append(note); describedBy.push(note.id); }
    input.setAttribute('aria-describedby', describedBy.join(' '));
    field.append(error); form.append(field); fields[key] = input; errorNodes[key] = error; return field;
  }
  const anonymousWrap = node('label', 'community-checkbox');
  const anonymous = node('input'); anonymous.type = 'checkbox'; anonymous.checked = true; anonymous.name = 'anonymous';
  anonymousWrap.append(anonymous, node('span', '', 'Keep this draft anonymous')); form.append(anonymousWrap);
  const nameInput = node('input'); nameInput.type = 'text'; nameInput.maxLength = 60; nameInput.autocomplete = 'off'; nameInput.disabled = true;
  addField('name', 'Display name (optional)', nameInput, 'Used only in this local draft and its export. A blank name stays anonymous.');
  anonymous.addEventListener('change', () => { nameInput.disabled = anonymous.checked; if (anonymous.checked) nameInput.value = ''; });
  const typeInput = node('select');
  Object.entries(CONTRIBUTION_TYPES).forEach(([value, text]) => { const option = node('option', '', text); option.value = value; typeInput.append(option); });
  typeInput.required = true; addField('type', 'Contribution type', typeInput);
  document.querySelectorAll('[data-contribution-type]').forEach(link => {
    link.addEventListener('click', event => {
      const type = link.dataset.contributionType;
      if (!Object.hasOwn(CONTRIBUTION_TYPES, type)) return;
      event.preventDefault();
      typeInput.value = type;
      draftPanel.scrollIntoView({ block: 'start', behavior: 'instant' });
      typeInput.focus({ preventScroll: true });
    });
  });
  const dateInput = node('input'); dateInput.type = 'date'; dateInput.min = EARLIEST_DATE; dateInput.max = today; dateInput.value = today; dateInput.required = true;
  addField('date', 'Contribution or proposal date', dateInput);
  const description = node('textarea'); description.rows = 4; description.minLength = 10; description.maxLength = 500; description.required = true;
  addField('description', 'Describe your contribution or proposal', description, '10–500 characters. Keep private links, credentials and personal contact details out of your draft.');
  const supportHint = node('p', 'community-field-hint', 'Support proposal: include your organization if relevant, the offer, duration, preferred recognition and any conditions. This is a local draft; saving it does not submit a proposal or confirm an arrangement.');
  supportHint.id = 'community-support-proposal-hint'; supportHint.hidden = true;
  form.append(supportHint);
  description.setAttribute('aria-describedby', `${description.getAttribute('aria-describedby')} ${supportHint.id}`);
  function prepareSupportProposal() {
    typeInput.value = 'community';
    supportHint.hidden = false;
    draftPanel.scrollIntoView({ block: 'start', behavior: 'instant' });
    description.focus({ preventScroll: true });
  }
  const submit = button('Save local draft', 'community-button-primary'); submit.type = 'submit';
  const formStatus = node('p', 'community-form-status'); formStatus.setAttribute('role', 'status'); formStatus.setAttribute('aria-live', 'polite');
  const formActions = node('div', 'community-form-actions'); formActions.append(submit);
  if (guideUrl) formActions.append(navigation(guideUrl, 'Read the contribution guide ↗'));
  form.append(formActions, formStatus); draftPanel.append(form);
  const draftListPanel = panel('Your browser drafts', 'community-local-title');
  const storageNotice = node('p', 'community-note');
  const draftList = node('div', 'community-draft-list');
  const exportButton = button('Export drafts as JSON', 'community-button-outline');
  draftListPanel.append(storageNotice, draftList, exportButton);
  localArea.append(draftPanel, draftListPanel); dashboard.append(localArea);

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, drafts })); storageAvailable = true; }
    catch { storageAvailable = false; }
  }
  function renderDrafts() {
    storageNotice.textContent = storageAvailable ? 'Stored only on this browser and device. Clearing browser storage removes these drafts; export a copy to keep them.' : 'Browser storage is unavailable. These drafts last only for this open tab; export a copy before leaving.';
    if (rejectedDrafts) storageNotice.textContent += ' Invalid stored entries were excluded.';
    exportButton.disabled = drafts.length === 0;
    if (!drafts.length) {
      const empty = node('div', 'community-empty-state'); empty.append(node('h3', '', 'A place for work in progress.'), node('p', 'community-note', 'Save your first local draft using the form. Nothing is submitted to SHOWAVE.')); draftList.replaceChildren(empty); return;
    }
    const list = node('ul', 'community-drafts');
    [...drafts].reverse().forEach(draft => {
      const item = node('li', 'community-draft');
      const top = node('div', 'community-draft-meta');
      top.append(node('span', 'community-tag community-tag-draft', 'Unverified draft'), node('time', '', draft.date)); top.lastElementChild.dateTime = draft.date;
      const remove = button('Remove', 'community-button-text'); remove.setAttribute('aria-label', `Remove ${CONTRIBUTION_TYPES[draft.type]} draft dated ${draft.date}`);
      remove.addEventListener('click', () => {
        drafts = drafts.filter(item => item.id !== draft.id); persist(); renderDrafts();
        formStatus.textContent = storageAvailable ? 'Local draft removed.' : 'Draft removed from this tab. Browser storage could not be updated.';
        draftList.querySelector('button')?.focus();
        if (!drafts.length) submit.focus();
      });
      item.append(top, node('p', 'community-draft-description', draft.description), node('p', 'community-note', `${CONTRIBUTION_TYPES[draft.type]} · ${draft.profile.visibility === 'named' ? draft.profile.name : 'Anonymous contributor'}`), remove); list.append(item);
    });
    draftList.replaceChildren(node('p', 'community-draft-count', `${drafts.length} of ${MAX_DRAFTS} local drafts`), list);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    Object.keys(errorNodes).forEach(key => { errorNodes[key].hidden = true; errorNodes[key].textContent = ''; fields[key].removeAttribute('aria-invalid'); });
    if (drafts.length >= MAX_DRAFTS) { formStatus.textContent = `This browser has reached the ${MAX_DRAFTS}-draft limit. Export your drafts and remove one before adding more.`; return; }
    const id = globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = validateDraft({ id, type: typeInput.value, date: dateInput.value, description: description.value, profile: { visibility: anonymous.checked ? 'anonymous' : 'named', name: nameInput.value } }, { today: todayISO() });
    if (!result.ok) {
      for (const [key, error] of Object.entries(result.errors)) {
        if (!fields[key]) continue;
        errorNodes[key].hidden = false; errorNodes[key].textContent = error; fields[key].setAttribute('aria-invalid', 'true');
      }
      formStatus.textContent = 'Please correct the highlighted fields.';
      fields[Object.keys(result.errors)[0]]?.focus(); return;
    }
    drafts.push(result.value); persist(); rejectedDrafts = 0; renderDrafts(); description.value = '';
    formStatus.textContent = storageAvailable ? 'Draft saved in this browser. It is unverified and has not been submitted.' : 'Draft saved for this tab only. Export it before leaving because browser storage is unavailable.';
  });
  exportButton.addEventListener('click', () => {
    if (!drafts.length) return;
    const exportData = { version: 1, status: 'unverified-local-drafts', exportedAt: new Date().toISOString(), note: 'Created locally. Not submitted, reviewed or included in the verified SHOWAVE contribution record.', drafts };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }));
    const link = node('a'); link.href = url; link.download = `showave-contribution-drafts-${todayISO()}.json`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    formStatus.textContent = 'Draft export prepared. It contains only your unverified local drafts; nothing was submitted.';
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || !storageAvailable) return;
    const result = readDraftStore(event.newValue, { today: todayISO() }); drafts = result.drafts; rejectedDrafts = result.rejected; renderDrafts();
  });

  const sponsorship = panel('Support the next chapter', 'community-sponsors-title', 'Sponsorship badge concepts are shown below. Tiers, benefits and payment arrangements have not been launched.');
  sponsorship.id = 'sponsorship';
  const tiers = node('div', 'community-tiers');
  communityConfig.tiers.forEach(tier => {
    const card = node('div', `community-tier community-tier-${tier.id}`);
    const badge = node('div', 'community-sponsor-badge'); badge.setAttribute('aria-hidden', 'true');
    const mark = node('img'); mark.src = '/showave-assets/assets/showave-mark.svg'; mark.alt = ''; mark.width = 36; mark.height = 36; badge.append(mark);
    card.append(badge, node('span', 'community-tag', 'Badge preview'), node('h3', '', tier.name), node('p', 'community-note', tier.description)); tiers.append(card);
  });
  sponsorship.append(tiers);
  if (!registry.sponsors.length) sponsorship.append(node('p', 'community-empty-summary', 'No verified sponsors are listed. Preview badges do not represent existing sponsorships.'));
  else {
    const list = node('ul', 'community-sponsor-list');
    registry.sponsors.forEach(sponsor => {
      const item = node('li'); const tier = communityConfig.tiers.find(tier => tier.id === sponsor.tierId);
      item.append(node('strong', '', sponsor.name), node('span', 'community-tag', tier.name), evidenceLink(sponsor.sourceUrl)); list.append(item);
    }); sponsorship.append(list);
  }
  const sponsorshipUrl = navigationLink(communityConfig.links.sponsorship);
  if (sponsorshipUrl) sponsorship.append(navigation(sponsorshipUrl, 'Explore support options ↗'));
  const supportProposal = navigation('/community?draft=support#community-dashboard', 'Prepare a local support proposal ↗');
  supportProposal.className = 'community-button community-button-outline';
  supportProposal.addEventListener('click', event => { event.preventDefault(); prepareSupportProposal(); });
  const supportActions = node('div', 'community-form-actions'); supportActions.append(supportProposal);
  sponsorship.append(supportActions, node('p', 'community-note', 'No proposal is sent from this page. Export a draft to share through an agreed project channel.'));
  if (guideUrl) intro.append(navigation(guideUrl, 'Contribution guide ↗'));
  dashboard.append(sponsorship);
  renderActivity(); renderDrafts(); mount.replaceChildren(dashboard);
  const initialSection = location.hash === '#sponsorship' ? sponsorship : location.hash === '#build-with-us' ? buildPanel : location.hash === '#community-draft-title' ? draftPanel : null;
  if (new URLSearchParams(location.search).get('draft') === 'support') requestAnimationFrame(prepareSupportProposal);
  else if (initialSection) requestAnimationFrame(() => initialSection.scrollIntoView({ block: 'start', behavior: 'instant' }));
}

if (mount) start();
