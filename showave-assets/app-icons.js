/* Website-only tool identity. Canonical names follow ../showave-brand.js;
 * accents retain the established website production-visual palette.
 * No app runtime, menus, shortcuts, or application files are changed.
 */
(() => {
  'use strict';
  const scriptURL = document.currentScript?.src || new URL('app-icons.js', document.baseURI).href;
  const assetRoot = new URL('/showave-assets/assets/app-icons/', scriptURL);
  const definitions = {
    live: { name: 'SHOWAVE Live', short: 'Lv', color: '#ff6436' },
    broadcast: { name: 'SHOWAVE Broadcast', short: 'Bc', color: '#50c8eb' },
    encode: { name: 'SHOWAVE Encode', short: 'En', color: '#e7ab42' },
    forge: { name: 'SHOWAVE Forge', short: 'Fg', color: '#6b9fff' },
    map: { name: 'SHOWAVE Map', short: 'Mp', color: '#f792b9' },
    chaser: { name: 'SHOWAVE Chaser', short: 'Ch', color: '#c6ef60' },
    gsl5: { name: 'GSL5 Lighting Library', short: 'G5', color: '#bd9cf9' },
    timeline: { name: 'SHOWAVE Timeline', short: 'Tl', color: '#79d5b0' },
    grid: { name: 'SHOWAVE Grid Tool', short: 'Gr', color: '#decf86' }
  };
  const normalize = key => {
    const normalized = String(key || '').toLowerCase();
    return normalized === 'lighting' ? 'gsl5' : normalized;
  };
  const products = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([key, value]) => [
    key, Object.freeze({ ...value, key, src: new URL(`${key}.svg`, assetRoot).href })
  ])));

  function decorateImage(image, key, decorative) {
    const product = products[normalize(key)];
    if (!product) return null;
    image.src = product.src;
    image.alt = decorative ? '' : `${product.name} icon`;
    image.width = 256;
    image.height = 256;
    image.decoding = 'async';
    image.loading = 'lazy';
    image.draggable = false;
    image.classList.add('showave-app-icon');
    image.dataset.appIcon = product.key;
    image.style.setProperty('--app-accent', product.color);
    if (decorative) image.setAttribute('aria-hidden', 'true');
    else image.removeAttribute('aria-hidden');
    return image;
  }

  function create(key, options = {}) {
    if (!products[normalize(key)]) return null;
    const image = decorateImage(document.createElement('img'), key, Boolean(options.decorative));
    if (options.size && Number.isFinite(Number(options.size))) {
      image.style.setProperty('--app-icon-size', `${Math.max(16, Number(options.size))}px`);
    }
    return image;
  }

  function mount(root = document) {
    root.querySelectorAll('[data-clone-product]').forEach(card => {
      const key = normalize(card.dataset.cloneProduct);
      if (!products[key]) return;
      card.querySelectorAll('.clone-product-label img').forEach(image => decorateImage(image, key, true));
      const title = card.querySelector('.home-service-item-title');
      if (title && !title.querySelector('.showave-app-icon')) {
        title.prepend(create(key, { decorative: true }));
        title.classList.add('has-app-icon');
      }
    });

    // Reusable on resource/ecosystem pages: use an <img data-app-icon="live">
    // or a dedicated empty <span data-app-icon="live">. Set aria-hidden="true"
    // when nearby text already provides the tool's accessible name.
    root.querySelectorAll('[data-app-icon]').forEach(host => {
      const key = normalize(host.dataset.appIcon);
      if (!products[key]) return;
      const decorative = host.getAttribute('aria-hidden') === 'true';
      if (host.tagName === 'IMG') decorateImage(host, key, decorative);
      else if (!host.querySelector('.showave-app-icon')) {
        const image = create(key, { decorative });
        host.classList.add('showave-app-icon');
        host.append(image);
      }
    });
  }

  window.SHOWAVE_APP_ICONS = Object.freeze({ products, create, mount });
  const init = () => mount();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  // Rebuilding the original responsive scene may introduce cloned product rows.
  // A scoped explicit hook avoids observing unrelated page mutations.
  window.addEventListener('showave:clone-ready', init);
})();
