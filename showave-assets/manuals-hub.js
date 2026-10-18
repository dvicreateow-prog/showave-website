/* SHOWAVE's task-first manuals directory. It indexes reviewed local guide copy;
   the shared site reader continues to own explicit ?article=... destinations. */
(() => {
  'use strict';
  if (!document.body.classList.contains('manuals-page')) return;
  const content = window.SHOWAVE_CONTENT || {};
  const isIndex = !new URLSearchParams(location.search).has('article');
  const slug = text => text.toLowerCase().replace(/^\d+[.)]\s*/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const urlFor = (key, anchor = '') => `/manuals?article=${encodeURIComponent(key)}${anchor ? '#' + encodeURIComponent(anchor) : ''}`;
  const escape = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const categories = [
    { id:'start', label:'Start a show', intro:'Choose your preview and make the first picture.' },
    { id:'media', label:'Clips & presentations', intro:'Prepare a file, pin your presentation, and take the right slide.' },
    { id:'broadcast', label:'Broadcast scenes', intro:'Compose in Preview. Make the move to Programme deliberate.' },
    { id:'output', label:'Mapping & output', intro:'Understand the picture, its placement, and its destination.' },
    { id:'control', label:'Control & creative tools', intro:'Find each workspace and understand the preview boundaries.' },
    { id:'help', label:'Troubleshooting', intro:'Rehearse, check the platform, and report a useful result.' }
  ];
  // Every item points to a real authored article or a section within one.
  const topics = [
    ['start','getting-started','Choose and install a preview','Find the published build for your platform and open SHOWAVE.','choose-your-preview','install windows linux android version download'],
    ['start','product-family','Find your workspace','Live, Broadcast, Map and the rest of the SHOWAVE family.','','workspace nine tools live broadcast map timeline forge encode chaser grid gsl5'],
    ['media','media-present','Load your first media file','Bring an original image, video, PDF or supported PowerPoint file.','load','media image video pdf powerpoint clip import file loading'],
    ['media','media-present','Present a deck or document','Pin a Clip, prepare a slide, then Take slide and Send to Show.','present','present presentation slides deck next previous take'],
    ['broadcast','broadcast-guide','Build a scene from sources','Begin with a blank canvas, then add the pictures your show needs.','start-with-an-empty-canvas','scene sources camera screen media presentation'],
    ['broadcast','broadcast-guide','Arrange and crop the picture','Place your sources, choose Fit, Fill or Stretch, and apply to Preview.','arrange-the-picture','resize rotate crop fit fill stretch arrange split pip grid preview'],
    ['broadcast','broadcast-guide','Take Preview to Programme','Check the picture and mixer, then use Cut/Fade when you are ready.','make-the-take-deliberate','take cut fade live programme program audio mixer'],
    ['output','mapping-output','Place and transform a source','Understand Input Selection and Output Transformation before mapping.','source-placement','output placement transform crop fit fill stretch'],
    ['output','mapping-output','Rehearse your output','Check Programme and the selected destination before a production.','rehearsal','output destination monitor broadcast streaming sound rehearsal'],
    ['output','mapping-output','Meet the mapping workspaces','Understand the roles of Map, Grid Tool and Chaser.','map','mapping map grid tool led output chaser slices'],
    ['control','plugins','Effects, generators & Forge','Explore the creative tools already inside the preview.','create-with-the-tools-already-inside','effects generators nodes forge plugins'],
    ['control','creative-control','Sequence, create & prepare','Explore Timeline, Forge and Encode with their current preview limits.','timeline','timeline timecode automation forge encode conversion nodes'],
    ['control','creative-control','Find the lighting workspace','Get to know GSL5 Lighting Library and rehearse with your actual rig.','lighting','control gsl5 lighting fixture dmx cue output'],
    ['control','api','Local integration overview','Read existing status endpoints and their current limits.','','api helper integration status development'],
    ['help','release-notes','Check platform & preview limits','Read the build notes before testing devices or native integrations.','','version windows linux android mac ios preview limitations'],
    ['help','troubleshooting','Find the next check','Work through a missing picture, Programme, audio or platform issue.','picture','picture black blank missing programme audio sound devices'],
    ['help','troubleshooting','Prepare a useful report','Describe the task, the steps and the result another person can reproduce.','report','bug crash failure issue problem troubleshooting feedback report']
  ];
  function headingsFor(article) {
    const template = document.createElement('template'); template.innerHTML = article?.body || '';
    return [...template.content.querySelectorAll('h2,h3')].map(heading => ({ text:heading.textContent, id:heading.id || slug(heading.textContent) }));
  }
  function resolvedAnchor(key, desired) {
    if (!desired) return '';
    const article = content[key];
    const template = document.createElement('template'); template.innerHTML = article?.body || '';
    if (template.content.querySelector(`[id="${CSS.escape(desired)}"]`)) return desired;
    return headingsFor(article).find(heading => heading.id === desired)?.id || '';
  }
  const articleSearchContent = new Map(Object.entries(content).map(([key,article]) => {
    const template = document.createElement('template'); template.innerHTML = article.body || '';
    return [key, template.content];
  }));
  function topicBodyText(key, anchor) {
    const article = articleSearchContent.get(key);
    if (!article) return '';
    if (!anchor) return article.textContent || '';
    // A card opens one guide section; its search text should describe that
    // destination, rather than unrelated controls elsewhere in the article.
    const target = article.getElementById(anchor) || [...article.querySelectorAll('h2,h3')]
      .find(heading => (heading.id || slug(heading.textContent)) === anchor);
    if (!target) return '';
    const text = [];
    for (let node = target; node; node = node.nextElementSibling) {
      if (node !== target && node.matches('h2')) break;
      text.push(node.textContent || '');
    }
    return text.join(' ');
  }
  if (!isIndex) {
    const article = document.querySelector('.article-content');
    if (!article) return;
    document.body.classList.add('manuals-reader-page');
    const used = new Set([...article.querySelectorAll('[id]')].map(node => node.id));
    const headings = [...article.querySelectorAll('.article-body h2,.article-body h3')];
    headings.forEach(heading => {
      if (heading.id) return;
      const base = slug(heading.textContent) || 'section'; let id = base, n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      heading.id = id; used.add(id);
    });
    const breadcrumb = document.createElement('nav'); breadcrumb.className = 'manuals-breadcrumb'; breadcrumb.setAttribute('aria-label','Breadcrumb');
    breadcrumb.innerHTML = '<a href="/manuals/" data-barba-prevent="all">Manuals</a><span aria-hidden="true">/</span><span>Guide</span>';
    article.prepend(breadcrumb);
    if (headings.length) {
      const toc = document.createElement('nav'); toc.className = 'manuals-contents'; toc.setAttribute('aria-label','On this page');
      toc.innerHTML = '<p>ON THIS PAGE</p><ol>' + headings.map(heading => `<li><a href="#${escape(heading.id)}">${escape(heading.textContent)}</a></li>`).join('') + '</ol>';
      article.querySelector('.article-intro')?.after(toc);
    }
    if (location.hash) {
      try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior:'instant' }); } catch { /* An invalid fragment does not affect reading. */ }
    }
    return;
  }
  const mount = document.getElementById('article-mount');
  if (!mount) return;
  document.body.classList.add('manuals-index-page');
  document.title = 'Manuals — SHOWAVE';
  document.querySelector('meta[name="description"]')?.setAttribute('content','Find SHOWAVE guides for your first show, clips, presentations, Broadcast scenes and preview workflows.');
  document.querySelector('.manuals-sidebar .back-link')?.setAttribute('href','/');
  const back = document.querySelector('.manuals-sidebar .back-link'); if (back) back.textContent = '← SHOWAVE home';
  const hub = document.createElement('div'); hub.className = 'manuals-hub';
  hub.innerHTML = `<section class="manuals-hero" aria-labelledby="manuals-title"><p class="eyebrow">SHOWAVE / MANUALS</p><h1 id="manuals-title">Know your tools.<br>Build your show.</h1><p class="manuals-lead">From your first Clip to the final audience picture. Find a workflow and follow it in SHOWAVE.</p><div class="manuals-search"><label for="manuals-search">What would you like to do?</label><div class="manuals-search-field"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg><input id="manuals-search" type="search" placeholder="Search media, scenes, output…" autocomplete="off" aria-controls="manuals-topics"><button type="button" class="manuals-clear" hidden>Clear</button></div></div></section><section class="manuals-start-paths" aria-labelledby="manuals-first-steps-title"><div class="manuals-section-heading"><h2 id="manuals-first-steps-title">New here? Start with one picture.</h2><span>THREE STEPS TO REHEARSE</span></div><div class="manuals-paths"><a href="${urlFor('media-present','load')}" data-barba-prevent="all"><span class="manuals-step">01 / PREPARE</span><h3>Bring your media.</h3><p>Load one original file into a Clip and wait for the first picture.</p><span class="manuals-read">Your first show <span aria-hidden="true">↗</span></span></a><a href="${urlFor('broadcast-guide','arrange-the-picture')}" data-barba-prevent="all"><span class="manuals-step">02 / COMPOSE</span><h3>Make it your scene.</h3><p>Arrange your sources in Preview while Programme holds its picture.</p><span class="manuals-read">Build a scene <span aria-hidden="true">↗</span></span></a><a href="${urlFor('broadcast-guide','make-the-take-deliberate')}" data-barba-prevent="all"><span class="manuals-step">03 / TAKE</span><h3>Check. Then Take.</h3><p>Rehearse the picture and sound. Use Cut/Fade when you are ready.</p><span class="manuals-read">Preview to Programme <span aria-hidden="true">↗</span></span></a></div></section><section class="manuals-directory" aria-labelledby="manuals-browse-title"><div class="manuals-section-heading"><h2 id="manuals-browse-title">Find your next step.</h2><p id="manuals-result-count" role="status" aria-live="polite" aria-atomic="true"></p></div><div class="manuals-filters" role="group" aria-label="Filter manual topics"><button type="button" data-manual-category="all" aria-pressed="true">All topics</button>${categories.map(category => `<button type="button" data-manual-category="${category.id}" aria-pressed="false">${category.label}</button>`).join('')}</div><div id="manuals-topics"></div><div class="manuals-empty" hidden><h3>No guides found.</h3><p>Try “media”, “Preview” or “output”, or browse all topics.</p><button type="button">Show all topics</button></div></section><aside class="manuals-preview-note" aria-label="Preview guidance"><div><span class="manuals-preview-badge">IN PREVIEW</span><h2>Check your build. Rehearse your setup.</h2><p>Features and native services vary by platform. Loading a Clip prepares it; taking a scene to Programme does not start an online broadcast.</p></div><a href="${urlFor('release-notes')}" data-barba-prevent="all">Platform & preview notes <span aria-hidden="true">↗</span></a></aside><section class="manuals-help" id="manuals-support"><div><p class="eyebrow">KEEP THE SHOW MOVING</p><h2>Still need a hand?</h2><p>Start with the task, your platform and build, then the steps that reproduce what you see.</p></div><div class="manuals-help-links"><a href="${urlFor('troubleshooting','report')}" data-barba-prevent="all">Prepare a report <span aria-hidden="true">↗</span></a><a href="/community/" data-barba-prevent="all">Find the community <span aria-hidden="true">↗</span></a></div></section>`;
  mount.replaceWith(hub);
  const directory = hub.querySelector('#manuals-topics');
  for (const category of categories) {
    const entries = topics.filter(topic => topic[0] === category.id && content[topic[1]]);
    const section = document.createElement('section'); section.id = category.id; section.className = 'manuals-topic-section'; section.dataset.manualSection = category.id; section.setAttribute('aria-labelledby',`manuals-${category.id}-title`);
    section.innerHTML = `<div class="manuals-topic-heading"><h3 id="manuals-${category.id}-title">${category.label}</h3><p>${category.intro}</p></div><ul class="manuals-topic-grid">${entries.map(topic => {
      const [, key, title, intro, anchor, keywords] = topic;
      const haystack = `${title} ${intro} ${keywords} ${content[key].title} ${content[key].intro} ${topicBodyText(key,anchor)}`.toLowerCase();
      return `<li data-manual-topic data-manual-search="${escape(haystack)}"><a href="${urlFor(key,resolvedAnchor(key,anchor))}" data-barba-prevent="all"><h4>${escape(title)} <span aria-hidden="true">↗</span></h4><p>${escape(intro)}</p></a></li>`;
    }).join('')}</ul>`;
    directory.append(section);
  }
  const search = hub.querySelector('#manuals-search');
  const clear = hub.querySelector('.manuals-clear');
  let selected = 'all';
  function filter() {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean); let visible = 0;
    for (const section of directory.children) {
      let count = 0;
      for (const item of section.querySelectorAll('[data-manual-topic]')) {
        const show = (selected === 'all' || selected === section.dataset.manualSection) && words.every(word => item.dataset.manualSearch.includes(word));
        item.hidden = !show; if (show) count++;
      }
      section.hidden = count === 0; visible += count;
    }
    hub.querySelector('.manuals-start-paths').hidden = words.length > 0;
    hub.classList.toggle('is-searching', words.length > 0);
    clear.hidden = search.value.length === 0;
    hub.querySelector('#manuals-result-count').textContent = `${visible} ${visible === 1 ? 'topic' : 'topics'}${words.length ? ' found' : ' to explore'}`;
    hub.querySelector('.manuals-empty').hidden = visible !== 0;
  }
  function reset() { selected = 'all'; search.value = ''; hub.querySelectorAll('[data-manual-category]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.manualCategory === selected))); filter(); }
  search.addEventListener('input',filter);
  clear.addEventListener('click',() => { search.value = ''; filter(); search.focus(); });
  hub.querySelector('.manuals-empty button').addEventListener('click',() => { reset(); search.focus(); });
  hub.querySelectorAll('[data-manual-category]').forEach(button => button.addEventListener('click',() => {
    selected = button.dataset.manualCategory;
    hub.querySelectorAll('[data-manual-category]').forEach(item => item.setAttribute('aria-pressed',String(item === button)));
    filter();
  }));
  document.querySelectorAll('.manuals-sidebar a[href^="/manuals/#"]').forEach(link => link.addEventListener('click',event => {
    const target = document.getElementById(new URL(link.href).hash.slice(1));
    if (!target) return;
    event.preventDefault(); reset(); history.replaceState(null,'',new URL(link.href).hash); target.scrollIntoView({behavior:'instant'});
  }));
  filter();
  if (location.hash) {
    try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior:'instant' }); } catch { /* Ignore malformed fragments. */ }
  }
})();
