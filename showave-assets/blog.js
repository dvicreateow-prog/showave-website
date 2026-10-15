/* Original project stories are kept in repository-owned markup. URL values
 * select a known story; no visitor content is inserted into the page. */
(() => {
  'use strict';
  const stories = [...document.querySelectorAll('[data-blog-post]')];
  const key = new URLSearchParams(location.search).get('post');
  const selected = key === null ? null : stories.find(story => story.dataset.blogPost === key);
  const index = document.querySelector('.blog-index');
  const missing = document.querySelector('.blog-not-found');
  if (index) index.hidden = key !== null;
  for (const story of stories) story.hidden = story !== selected;
  if (missing) missing.hidden = key === null || Boolean(selected);
  if (selected) {
    const heading = selected.querySelector('h1');
    const title = heading?.textContent.replace(/\s+/g, ' ').trim() || 'Journal';
    // <br> has no text content, so use its child text nodes as separate words.
    const readableTitle = [...heading.childNodes].map(node => node.nodeName === 'BR' ? ' ' : node.textContent).join('').replace(/\s+/g, ' ').trim();
    document.title = `${readableTitle || title} — SHOWAVE Journal`;
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = selected.querySelector('.blog-deck')?.textContent || '';
  } else if (key !== null) document.title = 'Story not found — SHOWAVE Journal';
})();
