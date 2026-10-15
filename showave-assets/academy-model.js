/* Browser-local Academy data. No account, publication or learner telemetry. */
export const STORAGE_KEY = 'showave.academy.drafts.v1';
export const MAX_DRAFTS = 100;
export const MAX_STORAGE_BYTES = 300000;
export const ACTIVITY_TYPES = Object.freeze({ practice: 'Practice session', 'lesson-note': 'Lesson notes', 'training-video': 'Training video draft' });

export const TRACKS = Object.freeze([
  {
    id: 'live', title: 'Live visuals', tool: 'live', label: '01 / LIVE', color: '#ff6038',
    intro: 'Prepare a small show, check the media and make each cue deliberate.',
    guide: '/manuals?article=getting-started',
    boundary: 'Loading prepares media; it does not trigger Show. Rehearse your actual media and output before a production.',
    lessons: [
      { id: 'live-first-file', title: 'Start with one familiar file', minutes: 10, steps: ['Choose an original image, video or audio file you know well.', 'Load it into Live and inspect the prepared media.', 'Record what you expect to see or hear before triggering the clip.'], note: 'Desktop preview accepts original-file media. Android is an offline interface and player review with different limits.' },
      { id: 'live-cues', title: 'Build a three-cue rehearsal', minutes: 15, steps: ['Prepare three clips or layers for a short opening, main moment and closing.', 'Write down their intended order and check each cue separately.', 'Run the sequence and note the cue that needs attention.'], note: 'Chaser handles slice sequencing; Timeline concerns timecoded automation. Check the current workspace and actual integration rather than assuming every output is ready.' },
      { id: 'live-presenter', title: 'Prepare before you take', minutes: 15, steps: ['Review a supported modern presentation in Presenter Preview.', 'Prepare a slide, then use Take to commit the pinned feed.', 'Use Send to Show intentionally and record the observed result.'], note: 'Modern PowerPoint support does not cover legacy PPT/PPS or macros. Rehearse advanced slide features on the actual desktop preview.' }
    ]
  },
  {
    id: 'broadcast', title: 'Broadcast', tool: 'broadcast', label: '02 / BROADCAST', color: '#20bed4',
    intro: 'Compose in Preview, check the picture and make a controlled Take.',
    guide: '/manuals?article=broadcast-guide',
    boundary: 'Taking a scene to Programme does not start an online broadcast. Capture devices, audio and destinations require their own checks.',
    lessons: [
      { id: 'broadcast-first-scene', title: 'Compose your first scene', minutes: 15, steps: ['Create New → Blank and add an available source.', 'Move, resize or rotate its picture; compare Fit, Fill and Stretch.', 'Use Input Selection for cropping and Output Transformation for placement.'], note: 'Camera, screen and other source availability depends on the platform and permissions. Start with a local media source if a device is unavailable.' },
      { id: 'broadcast-preview', title: 'Practice Preview to Programme', minutes: 15, steps: ['Prepare two simple scenes and apply the next scene to Preview.', 'Check the prepared picture while Programme retains the last taken scene.', 'Use Cut or Fade deliberately, then repeat in the reverse order.'], note: 'Editing or selecting a scene does not take it automatically. Treat the Take as its own operator action.' },
      { id: 'broadcast-check', title: 'Rehearse picture and sound', minutes: 15, steps: ['Check the mixer and each intended input at a sensible rehearsal level.', 'Compare a Solo, Split, PiP or Grid arrangement in Preview.', 'Record which actual output or destination you tested and what still needs a check.'], note: 'This Academy page does not connect to a camera, mixer or streaming account. Test those inside the installed preview and your production setup.' }
    ]
  },
  {
    id: 'mapping', title: 'Mapping & LED planning', tool: 'map', label: '03 / MAPPING', color: '#a795ff',
    intro: 'Turn the physical surfaces into a clear signal and rehearsal plan.',
    guide: '/manuals?article=product-family#map',
    boundary: 'Map, Grid Tool and Chaser have distinct workspace roles. A workspace preview is not proof that every physical output path is supported.',
    lessons: [
      { id: 'mapping-surfaces', title: 'Draw the surfaces and signal path', minutes: 15, steps: ['List the stage surfaces and their intended content.', 'Record the dimensions, resolution and the planned input-to-output path.', 'Identify the surface you can safely test first.'], note: 'Map is the output-mapping workspace. Begin with a small known surface and check the actual display setup.' },
      { id: 'mapping-grid', title: 'Plan one LED grid', minutes: 15, steps: ['Use Grid Tool to describe a small LED layout.', 'Compare the layout with the real panel order and signal plan.', 'Save a written checklist of mismatches to resolve before a show.'], note: 'Grid Tool covers LED planning and signal mapping. Confirm exact panel specifications and hardware behavior in your own setup.' },
      { id: 'mapping-chaser', title: 'Give slices a rhythm', minutes: 15, steps: ['Prepare a simple slice or pixel-map arrangement for Chaser.', 'Review a short sequence and compare it with your intended timing.', 'Record where Live content, Chaser sequencing and Timeline automation meet.'], note: 'Use documented current controls and rehearse timing locally. Do not assume unfinished native integrations are production-ready.' }
    ]
  },
  {
    id: 'lighting', title: 'Lighting preparation', tool: 'gsl5', label: '04 / LIGHTING', color: '#ffd15b',
    intro: 'Prepare an accurate patch and a rehearsal checklist for a real rig.',
    guide: '/manuals?article=product-family#gsl5',
    boundary: 'GSL5 Lighting Library is a linked product. Starter personalities are examples; use profiles for the exact fixtures. Physical output is explicitly armed in the application.',
    lessons: [
      { id: 'lighting-inventory', title: 'Know the fixture before the patch', minutes: 15, steps: ['Write down the fixture model, mode and intended DMX footprint.', 'Find the personality that matches the actual unit and mode.', 'Review the patch for address conflicts before preparing cues.'], note: 'A vendor-neutral starter personality is not a substitute for a verified fixture profile. This website does not send DMX.' },
      { id: 'lighting-cue', title: 'Prepare a restrained first cue', minutes: 15, steps: ['Review the programmer and the patched fixture parameters.', 'Prepare a simple cue using documented current controls.', 'Write down the intended playback order and how to stop or reset the rehearsal.'], note: 'Confirm control behavior in the linked Lighting Library and your physical rig. Keep the rehearsal supervised by the responsible operator.' },
      { id: 'lighting-handoff', title: 'Make the handoff clear', minutes: 10, steps: ['List the cues that should align with Live visuals or a presentation.', 'Record timing, responsible operator and the intended output check.', 'Document the actual rehearsal result and the remaining work.'], note: 'Preparing a timing plan does not imply a finished cross-application or hardware integration. Confirm each real connection separately.' }
    ]
  }
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max + 1) : '';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export function todayISO(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('A valid date is required.');
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function videoLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    const local = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)|(?:^localhost$|\.localhost$|\.local$)/i.test(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || local || !url.hostname.includes('.')) return null;
    return url.href;
  } catch { return null; }
}

export function authorIdentity(author) {
  const name = cleanText(author?.name, 60);
  const named = author?.visibility === 'named' && author?.consent === true && name.length > 0 && name.length <= 60;
  return { name: named ? name : 'Anonymous learner', anonymous: !named };
}

export function validateDraft(input, { today = todayISO() } = {}) {
  if (!isCalendarDate(today)) throw new TypeError('A valid today boundary is required.');
  if (!isObject(input)) return { ok: false, errors: { record: 'An activity draft is required.' } };
  const errors = {};
  if (!validId(input.id)) errors.id = 'A valid draft identifier is required.';
  if (!TRACKS.some(track => track.id === input.track)) errors.track = 'Choose an Academy track.';
  if (!Object.hasOwn(ACTIVITY_TYPES, input.kind)) errors.kind = 'Choose an activity type.';
  const title = cleanText(input.title, 100);
  const summary = cleanText(input.summary, 1200);
  if (title.length < 3 || title.length > 100) errors.title = 'Use a title of 3–100 characters.';
  if (summary.length < 10 || summary.length > 1200) errors.summary = 'Write notes of 10–1,200 characters.';
  if (!isCalendarDate(input.date) || input.date < '2000-01-01' || input.date > today) errors.date = 'Use a real date from 1 January 2000 through today.';
  const rawLink = typeof input.videoUrl === 'string' ? input.videoUrl.trim() : '';
  const normalizedLink = rawLink ? videoLink(rawLink) : '';
  if (rawLink && !normalizedLink) errors.videoUrl = 'Use a public HTTPS video link without account credentials.';
  if (input.videoUrl !== undefined && typeof input.videoUrl !== 'string') errors.videoUrl = 'Use a text video link.';
  const visibility = input.author?.visibility;
  if (visibility !== 'named' && visibility !== 'anonymous') errors.visibility = 'Choose named or anonymous authorship.';
  const name = cleanText(input.author?.name, 60);
  if (visibility === 'named' && (!name || name.length > 60)) errors.name = 'Enter a display name of 1–60 characters.';
  if (visibility === 'named' && input.author?.consent !== true) errors.consent = 'Confirm consent to named recognition, or choose anonymous.';
  if (Object.keys(errors).length) return { ok: false, errors };
  // Build an allowlisted object: files, object URLs, injected metadata and hidden
  // profile fields never enter storage or the explicit JSON export.
  return { ok: true, errors: {}, value: {
    id: input.id, title, summary, track: input.track, kind: input.kind,
    date: input.date, videoUrl: normalizedLink,
    author: visibility === 'named' ? { visibility: 'named', name, consent: true } : { visibility: 'anonymous', name: '', consent: false },
    status: 'local-draft'
  } };
}

export function readDrafts(serialized, options = {}) {
  if (serialized === null || serialized === undefined || serialized === '') return { drafts: [], skipped: 0, warning: '' };
  if (typeof serialized !== 'string' || serialized.length > MAX_STORAGE_BYTES) return { drafts: [], skipped: 0, warning: 'Stored Academy data is too large to load safely.' };
  let data;
  try { data = JSON.parse(serialized); } catch { return { drafts: [], skipped: 0, warning: 'Stored Academy data could not be read.' }; }
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.drafts)) return { drafts: [], skipped: 0, warning: 'Stored Academy data has an unsupported format.' };
  const drafts = [], seen = new Set();
  let skipped = 0;
  for (const record of data.drafts) {
    const result = validateDraft(record, options);
    if (!result.ok || seen.has(record.id) || drafts.length >= MAX_DRAFTS) { skipped++; continue; }
    seen.add(record.id);
    drafts.push(result.value);
  }
  return { drafts, skipped, warning: skipped ? `${skipped} invalid, duplicate or excess draft${skipped === 1 ? '' : 's'} skipped.` : '' };
}

export function serializeDrafts(drafts, options = {}) {
  if (!Array.isArray(drafts) || drafts.length > MAX_DRAFTS) throw new TypeError(`Keep at most ${MAX_DRAFTS} local drafts.`);
  const values = [], seen = new Set();
  for (const draft of drafts) {
    const result = validateDraft(draft, options);
    if (!result.ok || seen.has(draft.id)) throw new TypeError('Only valid, unique activity drafts can be saved.');
    seen.add(draft.id); values.push(result.value);
  }
  const serialized = JSON.stringify({ version: 1, drafts: values });
  if (serialized.length > MAX_STORAGE_BYTES) throw new TypeError('The local draft collection is too large to save.');
  return serialized;
}

export function filterDrafts(drafts, { search = '', track = 'all', kind = 'all' } = {}) {
  const query = typeof search === 'string' ? search.trim().slice(0, 160).toLocaleLowerCase() : '';
  return drafts.filter(draft => {
    if (track !== 'all' && draft.track !== track || kind !== 'all' && draft.kind !== kind) return false;
    const author = authorIdentity(draft.author);
    const text = [draft.title, draft.summary, draft.track, ACTIVITY_TYPES[draft.kind], author.name].join(' ').toLocaleLowerCase();
    return !query || text.includes(query);
  }).slice().sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function upsertDraft(drafts, input, options = {}) {
  const result = validateDraft(input, options);
  if (!result.ok) return result;
  const index = drafts.findIndex(draft => draft.id === result.value.id);
  if (index < 0 && drafts.length >= MAX_DRAFTS) return { ok: false, errors: { collection: `You can keep up to ${MAX_DRAFTS} local drafts. Remove one or export your notes first.` } };
  const next = drafts.slice();
  if (index < 0) next.push(result.value); else next[index] = result.value;
  return { ok: true, errors: {}, value: result.value, drafts: next };
}

export function exportDrafts(drafts, options = {}) {
  return JSON.stringify({ product: 'SHOWAVE Academy', poweredBy: 'Afro Unity Group', storage: 'browser-local drafts; not published or verified', ...JSON.parse(serializeDrafts(drafts, options)) }, null, 2);
}
