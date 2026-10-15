/* Pure contribution model, shared by the browser and its validation checks. */
export const CONTRIBUTION_TYPES = Object.freeze({ code: 'Code', docs: 'Documentation', testing: 'Testing', design: 'Design', translation: 'Translation', community: 'Community' });
export const EARLIEST_DATE = '2000-01-01';
export const MAX_DRAFTS = 100;
const DAY = 86400000;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max + 1) : '';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function todayISO(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('A valid date is required.');
  // Calendar days follow the visitor's local date; UTC is used only for arithmetic.
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function dateError(value, today) {
  if (!isCalendarDate(value)) return 'Use a valid calendar date.';
  if (value < EARLIEST_DATE) return 'Use a date on or after 1 January 2000.';
  if (value > today) return 'Future contributions cannot be recorded.';
  return '';
}

export function publicSource(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const localHost = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)|(?:^localhost$|\.localhost$|\.local$)/i.test(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || localHost) return null;
    return url.href;
  } catch { return null; }
}

export function navigationLink(value) {
  const external = publicSource(value);
  if (external) return external;
  // Local navigation is deliberately separate from public evidence validation.
  return typeof value === 'string' && /^\/(?:manuals|software|downloads|community|foundation|blog|plugins|api|mcp|donate|developers|contributors)(?:\?[a-z0-9_=&%-]+)?(?:#[a-z0-9-]+)?$/i.test(value) ? value : null;
}

export function publicIdentity(profile) {
  const name = cleanText(profile?.name, 60);
  const named = profile?.visibility === 'named' && profile?.consent === true && name.length > 0 && name.length <= 60;
  return { name: named ? name : 'Anonymous contributor', anonymous: !named };
}

export function validateContribution(input, { today = todayISO(), verified = false } = {}) {
  if (!isCalendarDate(today)) throw new TypeError('A valid today boundary is required.');
  const errors = {};
  if (!object(input)) return { ok: false, errors: { record: 'A contribution record is required.' } };
  if (!identifier(input.id)) errors.id = 'Use a valid record identifier.';
  if (!Object.hasOwn(CONTRIBUTION_TYPES, input.type)) errors.type = 'Choose a contribution type.';
  const issue = dateError(input.date, today);
  if (issue) errors.date = issue;
  const description = cleanText(input.description, 500);
  if (description.length < 10 || description.length > 500) errors.description = 'Describe the contribution in 10–500 characters.';
  let sourceUrl;
  if (verified) {
    if (!identifier(input.contributorId)) errors.contributorId = 'A contributor identifier is required.';
    sourceUrl = publicSource(input.sourceUrl);
    if (!sourceUrl) errors.sourceUrl = 'A public HTTPS evidence link is required.';
    if (input.verified !== true) errors.verified = 'The record has not been verified.';
    const checkedIssue = dateError(input.verifiedAt, today);
    if (checkedIssue || input.verifiedAt < input.date) errors.verifiedAt = 'Verification must be dated on or after the contribution and no later than today.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const value = { id: input.id, type: input.type, date: input.date, description };
  if (verified) Object.assign(value, { contributorId: input.contributorId, sourceUrl, verified: true, verifiedAt: input.verifiedAt });
  return { ok: true, errors, value };
}

export function validateDraft(input, { today = todayISO() } = {}) {
  const result = validateContribution(input, { today });
  if (!result.ok) return result;
  const profile = object(input.profile) ? input.profile : {};
  const name = cleanText(profile.name, 60);
  if (profile.visibility === 'named' && name.length > 60) return { ok: false, errors: { name: 'Use 60 characters or fewer for your display name.' } };
  const named = profile.visibility === 'named' && name.length > 0;
  return {
    ok: true, errors: {},
    value: { ...result.value, status: 'unverified', profile: { visibility: named ? 'named' : 'anonymous', name: named ? name : '' } }
  };
}

export function readDraftStore(serialized, { today = todayISO() } = {}) {
  if (serialized === null || serialized === undefined || serialized === '') return { drafts: [], rejected: 0 };
  if (typeof serialized !== 'string' || serialized.length > 200000) return { drafts: [], rejected: 1 };
  try {
    const stored = JSON.parse(serialized);
    if (!object(stored) || stored.version !== 1 || !Array.isArray(stored.drafts)) return { drafts: [], rejected: 1 };
    const drafts = [], seen = new Set();
    let rejected = Math.max(0, stored.drafts.length - MAX_DRAFTS);
    for (const record of stored.drafts.slice(0, MAX_DRAFTS)) {
      const result = validateDraft(record, { today });
      if (!result.ok || seen.has(record.id)) { rejected++; continue; }
      seen.add(record.id); drafts.push(result.value);
    }
    return { drafts, rejected };
  } catch { return { drafts: [], rejected: 1 }; }
}

export function normalizeRegistry(config, { today = todayISO() } = {}) {
  const source = object(config?.records) ? config.records : {};
  const profiles = new Map(), records = [], sponsors = [], seen = new Set(), issues = [];
  for (const profile of Array.isArray(source.contributors) ? source.contributors : []) {
    if (!object(profile) || !identifier(profile.id) || profiles.has(profile.id)) { issues.push('Invalid or repeated contributor profile.'); continue; }
    profiles.set(profile.id, { id: profile.id, ...publicIdentity(profile) });
  }
  for (const item of Array.isArray(source.contributions) ? source.contributions : []) {
    const result = validateContribution(item, { today, verified: true });
    if (!result.ok || seen.has(item.id)) { issues.push('Invalid, unverified or repeated contribution omitted.'); continue; }
    seen.add(item.id);
    const identity = profiles.get(item.contributorId) || publicIdentity(null);
    records.push({ ...result.value, name: identity.name, anonymous: identity.anonymous });
  }
  const sponsorIds = new Set();
  const tierIds = new Set((Array.isArray(config?.tiers) ? config.tiers : []).filter(object).map(tier => tier.id));
  for (const sponsor of Array.isArray(source.sponsors) ? source.sponsors : []) {
    const sourceUrl = publicSource(sponsor?.sourceUrl);
    if (!object(sponsor) || !identifier(sponsor.id) || sponsorIds.has(sponsor.id) || sponsor.verified !== true || !sourceUrl || !tierIds.has(sponsor.tierId) || dateError(sponsor.date, today) || dateError(sponsor.verifiedAt, today) || sponsor.verifiedAt < sponsor.date) {
      issues.push('Invalid, unverified or repeated sponsorship omitted.'); continue;
    }
    sponsorIds.add(sponsor.id);
    const identity = publicIdentity(sponsor);
    sponsors.push({ id: sponsor.id, name: identity.anonymous ? 'Anonymous supporter' : identity.name, anonymous: identity.anonymous, tierId: sponsor.tierId, date: sponsor.date, sourceUrl });
  }
  records.sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id));
  return { records, sponsors, issues };
}

export function contributionYear(records, year, { today = todayISO() } = {}) {
  if (!Number.isInteger(year) || year < 2000 || year > Number(today.slice(0, 4)) || !isCalendarDate(today)) throw new RangeError('Choose an available contribution year.');
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  const days = [], byDate = new Map();
  for (let time = start; time < end; time += DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    const day = { date, count: 0, records: [], future: date > today };
    days.push(day); byDate.set(date, day);
  }
  const contributors = new Set(), types = new Set(), seen = new Set();
  let count = 0;
  for (const record of Array.isArray(records) ? records : []) {
    // Recheck the boundary even for callers that bypass normalizeRegistry.
    if (!validateContribution(record, { today, verified: true }).ok || seen.has(record.id) || !byDate.has(record.date)) continue;
    seen.add(record.id);
    const day = byDate.get(record.date); day.count++; day.records.push(record);
    contributors.add(record.contributorId); types.add(record.type); count++;
  }
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  return { year, days, offset, weeks: Math.ceil((offset + days.length) / 7), metrics: { contributions: count, contributors: contributors.size, activeDays: days.filter(day => day.count > 0).length, types: types.size } };
}

export function rankContributors(records, year, { today = todayISO() } = {}) {
  const groups = new Map();
  for (const day of contributionYear(records, year, { today }).days) {
    for (const record of day.records) {
      if (!groups.has(record.contributorId)) groups.set(record.contributorId, { id: record.contributorId, name: record.name, anonymous: record.anonymous, count: 0, days: new Set(), lastDate: record.date });
      const item = groups.get(record.contributorId);
      item.count++; item.days.add(record.date); if (record.date > item.lastDate) item.lastDate = record.date;
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || b.days.size - a.days.size || compare(b.lastDate, a.lastDate) || compare(a.id, b.id));
  let rank = 0, previousCount = -1;
  return sorted.map((item, index) => {
    if (item.count !== previousCount) rank = index + 1;
    previousCount = item.count;
    return { rank, name: item.anonymous === false ? item.name : 'Anonymous contributor', anonymous: item.anonymous !== false, count: item.count, activeDays: item.days.size };
  });
}
