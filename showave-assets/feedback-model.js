export const SURVEYS = Object.freeze({
  needs: { name: 'Production needs', fields: ['role', 'workspace', 'platform', 'priority', 'notes'] },
  preview: { name: 'Preview experience', fields: ['platform', 'workspace', 'rating', 'priority', 'notes'] }
});
const OPTIONS = {
  role: ['Events / conferences', 'Streamer / YouTuber', 'Visual artist / DJ', 'Lighting operator', 'Educator / learner', 'Developer'],
  workspace: ['Live', 'Broadcast', 'Encode', 'Forge', 'Map', 'Chaser', 'GSL5 Lighting Library', 'Timeline', 'Grid Tool'],
  platform: ['Windows', 'Linux', 'Android', 'Other / not tested'],
  priority: ['Reliability and performance', 'Media conversion', 'Lighting profiles', 'Plug-ins and MCP', 'Manuals and training', 'Community and sharing'],
  rating: ['1', '2', '3', '4', '5']
};
export { OPTIONS };
export function normalizeResponse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(SURVEYS, input.survey)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const validDate = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) && Number.isFinite(Date.parse(input.date)) && new Date(input.date).toISOString().slice(0,10) === input.date;
  const result = { survey: input.survey, date: validDate ? input.date : today };
  for (const key of SURVEYS[input.survey].fields) {
    if (key === 'notes') result.notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
    else {
      if (!OPTIONS[key].includes(input[key])) return null;
      result[key] = input[key];
    }
  }
  return result;
}
export function normalizeResponses(input) {
  return (Array.isArray(input) ? input.slice(-100) : []).map(normalizeResponse).filter(Boolean).slice(-20);
}
