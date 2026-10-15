import { answerQuestion } from './assistant-model.js';
const normalizePath = value => value.replace(/\/+$/, '') || '/';
const pagePath = normalizePath(location.pathname);
const currentPage = ({'/feedback':'/surveys','/studio':'/academy','/welcome':'/start','/development-fund':'/fund'})[pagePath] || pagePath;
document.querySelectorAll('.hub-subnav a,.desktop-nav a').forEach(link => { if (normalizePath(new URL(link.href).pathname) === currentPage) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
const launcher = document.createElement('button'); launcher.className = 'showave-guide-launcher'; launcher.type = 'button'; launcher.textContent = 'Ask SHOWAVE'; launcher.setAttribute('aria-haspopup', 'dialog');
const dialog = document.createElement('dialog'); dialog.className = 'showave-guide-dialog'; dialog.setAttribute('aria-labelledby', 'showave-guide-title');
dialog.innerHTML = `<button class="showave-guide-close" type="button" aria-label="Close SHOWAVE guide">×</button><p class="eyebrow">YOUR NEXT STEP / SHOWAVE</p><h2 id="showave-guide-title">Ask the guide.</h2><p class="showave-guide-note">Answers from the project guides. This is a local guide assistant; no AI service is connected and your questions are not sent anywhere.</p><div class="showave-guide-topics"><button type="button" data-guide-question="How do I download the beta?">Downloads</button><button type="button" data-guide-question="How do I learn broadcast?">Broadcast</button><button type="button" data-guide-question="What lighting profiles exist?">Lighting</button><button type="button" data-guide-question="What is planned on the roadmap?">Roadmap</button></div><div class="showave-guide-chat" role="log" aria-live="polite" aria-relevant="additions"></div><form class="showave-guide-form"><label for="showave-guide-question">Ask about SHOWAVE</label><div><input id="showave-guide-question" name="question" maxlength="500" placeholder="Try: how do I prepare a scene?" required autocomplete="off"><button type="submit">Ask ↗</button></div></form>`;
document.body.append(launcher, dialog);
const log = dialog.querySelector('[role="log"]');
function answer(value) {
  const question = value.trim().slice(0, 500); if (!question) return;
  const result = answerQuestion(question), exchange = document.createElement('section'); exchange.className = 'showave-guide-exchange';
  const prompt = document.createElement('p'); prompt.className = 'showave-guide-prompt'; prompt.textContent = question;
  const title = document.createElement('h3'); title.textContent = result.title;
  const body = document.createElement('p'); body.textContent = result.answer;
  exchange.append(prompt, title, body);
  const links = document.createElement('div'); links.className = 'showave-guide-answer-links';
  result.links.forEach(item => { const link = document.createElement('a'); link.href = item.href; link.textContent = `${item.title} ↗`; link.dataset.barbaPrevent = 'all'; links.append(link); });
  exchange.append(links); log.append(exchange);
  while (log.childElementCount > 8) log.firstElementChild.remove();
  exchange.scrollIntoView({ block: 'nearest' });
}
let opener = launcher;
function open(event) { opener = event?.currentTarget || launcher; if (!dialog.open) dialog.showModal(); dialog.querySelector('input').focus(); }
launcher.addEventListener('click', open);
document.querySelectorAll('[data-open-guide]').forEach(button => button.addEventListener('click', open));
dialog.querySelector('.showave-guide-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => opener.focus());
dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); const input = dialog.querySelector('input'); answer(input.value); input.value = ''; input.focus(); });
dialog.querySelectorAll('[data-guide-question]').forEach(button => button.addEventListener('click', () => answer(button.dataset.guideQuestion)));
// Roadmap filters affect only the roadmap cards, never the landing-page scenes.
const filters = document.querySelectorAll('[data-roadmap-filter]');
filters.forEach(button => button.addEventListener('click', () => { const value = button.dataset.roadmapFilter; filters.forEach(item => item.setAttribute('aria-pressed', String(item === button))); document.querySelectorAll('[data-roadmap-stage]').forEach(card => { card.hidden = value !== 'all' && card.dataset.roadmapStage !== value; }); }));
