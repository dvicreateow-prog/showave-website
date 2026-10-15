/* Website welcome preferences and recent guide links. No desktop file history. */
export const STORAGE_KEY = 'showave.welcome.v1';
export const MAX_RECENTS = 8;
export const DRAFT_LINK = '/community#community-dashboard';
const MAX_STORED_BYTES = 32768;
const freeze = value => Object.freeze(value);

export const TOOLS = freeze([
  { id: 'live', name: 'SHOWAVE Live', short: 'Live', code: 'Lv', color: '#ff744d', role: 'Layers, clips & cues', description: 'Build the live picture with layers, media clips, cues and creative controls.', note: 'Begin with one original media file and a small rehearsal.', keywords: 'show visuals events conferences video live layers clips cue playback', roles: ['general', 'live', 'broadcast', 'media'] },
  { id: 'broadcast', name: 'SHOWAVE Broadcast', short: 'Broadcast', code: 'Bc', color: '#47c7f1', role: 'Preview to Programme', description: 'Arrange scenes and sources in Preview. Use Cut or Fade to take the prepared picture to Programme.', note: 'Streaming destinations, accounts and capture devices have their own controls and platform requirements.', keywords: 'stream streaming youtube conference camera screen sources scenes audio programme preview broadcast', roles: ['general', 'broadcast', 'live'] },
  { id: 'map', name: 'SHOWAVE Map', short: 'Map', code: 'Mp', color: '#ca98ff', role: 'Shape your outputs', description: 'Explore output mapping and prepare how the show picture fits your surfaces.', note: 'Rehearse with the screens, resolutions and output devices you plan to use.', keywords: 'mapping output projection surfaces screens warp map', roles: ['general', 'mapping', 'live'] },
  { id: 'grid', name: 'SHOWAVE Grid Tool', short: 'Grid Tool', code: 'Gr', color: '#f4cd65', role: 'Plan the LED wall', description: 'Organize LED wall planning and signal mapping for your output layout.', note: 'Check the plan against the real panels and signal path during setup.', keywords: 'led wall grid panels planning mapping signal', roles: ['general', 'mapping'] },
  { id: 'gsl5', name: 'GSL5 Lighting Library', short: 'GSL5 Lighting', code: 'G5', color: '#68d6c6', role: 'Fixtures, cues & light', description: 'A linked, independent lighting workspace with personalities, patch, programmer, cues and output controls.', note: 'Starter personalities are vendor-neutral samples. Verify real fixture profiles; physical output is explicitly armed inside GSL5.', keywords: 'lighting dmx artnet sacn fixtures personality patch lights gsl5', roles: ['general', 'lighting', 'live'] },
  { id: 'encode', name: 'SHOWAVE Encode', short: 'Encode', code: 'En', color: '#f2a769', role: 'Prepare your media', description: 'Preview clips, explore trim and conversion settings, and organize the preparation queue.', note: 'The current session-only preview does not save or export converted files. Native encoding adapters remain required.', keywords: 'media preparation audio music dj conversion encode alley trim queue', roles: ['general', 'media'] },
  { id: 'forge', name: 'SHOWAVE Forge', short: 'Forge', code: 'Fg', color: '#f287bd', role: 'Create with nodes', description: 'Explore nodes and visual patch layouts in the family’s creation workspace.', note: 'The monitor currently shows a demonstration. Native plug-in compilation is not implemented in this preview.', keywords: 'nodes patch generator effects plugin plug-in forge wire creation', roles: ['general', 'media', 'sequencing'] },
  { id: 'chaser', name: 'SHOWAVE Chaser', short: 'Chaser', code: 'Ch', color: '#a9d86c', role: 'Give slices a rhythm', description: 'Sequence slices and pixel maps as a focused part of the visual show workflow.', note: 'Start with a small sequence and review its targets before extending the show.', keywords: 'chaser sequencing slices rhythm pixel maps video sequence', roles: ['general', 'sequencing', 'mapping', 'live'] },
  { id: 'timeline', name: 'SHOWAVE Timeline', short: 'Timeline', code: 'Tl', color: '#85a9fa', role: 'Organize show time', description: 'Explore timecoded show automation and organize the order of your creative work.', note: 'Available tools and native integrations vary by preview build and platform.', keywords: 'timeline sequencing automation timecode show cue control', roles: ['general', 'sequencing', 'live'] }
].map(tool => freeze({ ...tool, icon: `/showave-assets/assets/app-icons/${tool.id}.svg`, roles: freeze(tool.roles) })));

export const ROLES = freeze([
  { id: 'general', label: 'General' }, { id: 'live', label: 'Live events' },
  { id: 'broadcast', label: 'Broadcast' }, { id: 'mapping', label: 'Mapping' },
  { id: 'lighting', label: 'Lighting' }, { id: 'media', label: 'Media' },
  { id: 'sequencing', label: 'Sequencing' }
].map(freeze));

const toolById = new Map(TOOLS.map(tool => [tool.id, tool]));
const roleIds = new Set(ROLES.map(role => role.id));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const toolFor = id => toolById.get(id) || null;
export const guideFor = id => toolById.has(id) ? `/manuals?article=product-family#${id}` : null;

export function filterTools(role = 'general', query = '') {
  const selectedRole = roleIds.has(role) ? role : 'general';
  const words = typeof query === 'string' ? query.toLowerCase().trim().slice(0, 120).split(/\s+/).filter(Boolean) : [];
  return TOOLS.filter(tool => tool.roles.includes(selectedRole) && words.every(word => `${tool.name} ${tool.role} ${tool.keywords}`.toLowerCase().includes(word)));
}

/** Strictly local, canonical guide and draft-workspace destinations. */
export function recentDestination(href) {
  if (href === DRAFT_LINK) return { kind: 'draft', title: 'Contribution drafts', href: DRAFT_LINK };
  if (typeof href !== 'string') return null;
  const tool = TOOLS.find(entry => guideFor(entry.id) === href);
  return tool ? { kind: 'guide', title: tool.name, href } : null;
}

export function defaultWelcomeStore() {
  return { version: 1, preferences: { role: 'general', selectedId: 'live', welcomeOnStart: false }, recents: [] };
}

export function sanitizeWelcomeStore(input, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('A valid current time is required.');
  const result = defaultWelcomeStore();
  if (!object(input) || input.version !== 1) return result;
  const prefs = object(input.preferences) ? input.preferences : {};
  if (roleIds.has(prefs.role)) result.preferences.role = prefs.role;
  if (toolById.has(prefs.selectedId)) result.preferences.selectedId = prefs.selectedId;
  result.preferences.welcomeOnStart = prefs.welcomeOnStart === true;
  const unique = new Map();
  if (Array.isArray(input.recents)) {
    for (const entry of input.recents.slice(0, 100)) {
      if (!object(entry) || !Number.isSafeInteger(entry.visitedAt) || entry.visitedAt < 0 || entry.visitedAt > now) continue;
      const destination = recentDestination(entry.href);
      if (!destination || entry.kind !== destination.kind) continue;
      const previous = unique.get(destination.href);
      if (!previous || previous.visitedAt < entry.visitedAt) unique.set(destination.href, { ...destination, visitedAt: entry.visitedAt });
    }
  }
  result.recents = [...unique.values()].sort((a, b) => b.visitedAt - a.visitedAt || a.href.localeCompare(b.href)).slice(0, MAX_RECENTS);
  return result;
}

export function readWelcomeStore(raw, options) {
  if (typeof raw !== 'string' || raw.length > MAX_STORED_BYTES) return defaultWelcomeStore();
  try { return sanitizeWelcomeStore(JSON.parse(raw), options); }
  catch { return defaultWelcomeStore(); }
}

export function serializeWelcomeStore(input, options) {
  return JSON.stringify(sanitizeWelcomeStore(input, options));
}

export function recordRecent(input, href, { now = Date.now() } = {}) {
  const result = sanitizeWelcomeStore(input, { now });
  const destination = recentDestination(href);
  if (!destination) return result;
  return sanitizeWelcomeStore({ ...result, recents: [{ ...destination, visitedAt: now }, ...result.recents.filter(entry => entry.href !== href)] }, { now });
}
