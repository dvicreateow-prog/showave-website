import { OPTIONS, SURVEYS, normalizeResponse, normalizeResponses } from './feedback-model.js';
const KEY = 'showave.feedback.drafts.v1';
const status = document.querySelector('[data-feedback-status]');
const summaries = document.querySelector('[data-feedback-responses]');
let responses = [];
try { responses = normalizeResponses(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch {}
const say = value => { status.textContent = value; };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(responses)); return true; } catch { return false; } };
function render() {
  summaries.replaceChildren();
  const title = document.createElement('p');
  title.textContent = responses.length ? `${responses.length} response drafts on this browser. These are not public survey results.` : 'No response drafts yet. Your answers stay on this browser.';
  summaries.append(title);
  for (const response of responses.slice().reverse()) {
    const item = document.createElement('article'); item.className = 'hub-response';
    const heading = document.createElement('h3'); heading.textContent = SURVEYS[response.survey].name;
    const detail = document.createElement('p'); detail.textContent = `${response.date} · ${response.workspace} · ${response.platform} · ${response.survey === 'needs' ? response.role : `Experience ${response.rating} / 5`} · ${response.priority}`;
    const note = document.createElement('p'); note.textContent = response.notes || 'No extra notes.';
    item.append(heading, detail, note); summaries.append(item);
  }
  document.querySelector('[data-feedback-export]').disabled = !responses.length;
  document.querySelector('[data-feedback-clear]').disabled = !responses.length;
}
document.querySelectorAll('[data-survey-form]').forEach(form => {
  form.querySelectorAll('select').forEach(select => OPTIONS[select.name]?.forEach(value => { const option = document.createElement('option'); option.value = value; option.textContent = select.name === 'rating' ? `${value} / 5` : value; select.append(option); }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const response = normalizeResponse({ ...Object.fromEntries(new FormData(form)), survey: form.dataset.surveyForm, date: new Date().toISOString().slice(0, 10) });
    if (!response) { say('Complete the choices before saving your response draft.'); return; }
    responses = normalizeResponses([...responses, response]);
    const stored = save(); render(); form.reset();
    say(stored ? 'Response draft saved on this browser. Nothing was submitted to SHOWAVE.' : 'Draft is available for this session. Browser storage is unavailable; export a copy to keep it.');
  });
});
document.querySelector('[data-feedback-clear]').addEventListener('click', () => { responses = []; const stored = save(); render(); say(stored ? 'Local response drafts cleared.' : 'Drafts cleared for this session. Browser storage could not be updated; saved drafts may return after reloading.'); });
document.querySelector('[data-feedback-export]').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, status: 'unsubmitted-local-drafts', responses }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'showave-survey-drafts.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  say('Exported your response drafts. Share them only with a destination you choose.');
});
render();
