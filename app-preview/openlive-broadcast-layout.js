/* Shared Programme geometry. News is a SHOWAVE adaptation of the DW name-strap
   reference: a common safe-area grid, a wide lower stack, and a separate QR bay.
   The percentages and QR bay are our responsive choices, not DW specifications.
   Pure geometry only: no storage, DOM, media decoding or per-frame readbacks. */
window.OpenLiveBroadcastLayout = (() => {
  'use strict';
  // Geometry and visual treatments, not station identities or camera routing.
  // The supplied DW/NBS screenshots inform these SHOWAVE-owned adaptations.
  const templateDefaults = {family:'World news',lowerStyle:'floating',lowerHeight:.13,
    width:1,anchor:'left',qrAnchor:'top-right',logoCorner:'top-left',logoScale:.12,
    tickerHeight:.055,tickerStyle:'dark',safeX:.062,safeY:.04,gap:.015};
  const TEMPLATES = Object.freeze([
    {id:'classic',label:'Classic stack',family:'Classic',description:'Light headline and dark subtitle beside a lower-right QR.',
      lowerStyle:'classic',lowerHeight:.145,qrAnchor:'bottom-right',safeX:.055,safeY:.055,gap:.018},
    {id:'world-headline',label:'World headline',description:'DW-reference white headline over video, slim news ticker and upper-left logo.',lowerHeight:.155},
    {id:'world-interview',label:'World interview',description:'Floating interview title and role with a shorter left-aligned strap.',width:.78,lowerHeight:.15},
    {id:'world-report',label:'World report',description:'Tall floating headline area with clear subtitle and QR above the story.',lowerHeight:.18,tickerHeight:.05},
    {id:'world-compact',label:'World compact',description:'Compact floating headline with a lower-right QR companion.',width:.65,lowerHeight:.105,qrAnchor:'bottom-right',tickerHeight:.045},
    {id:'name-white',label:'Name · white',family:'Name straps',description:'A crisp light identification card with an accent rail.',lowerStyle:'white',width:.56,lowerHeight:.14},
    {id:'name-dark',label:'Name · dark',family:'Name straps',description:'A dark identification card anchored beneath the upper-left logo.',lowerStyle:'dark',width:.56,lowerHeight:.14},
    {id:'name-accent',label:'Name · accent',family:'Name straps',description:'Brand-colour title with a contrasting role band and companion QR.',lowerStyle:'accent',width:.62,lowerHeight:.145,qrAnchor:'bottom-right'},
    {id:'name-outline',label:'Name · outline',family:'Name straps',description:'Right-aligned outlined identification card balanced by a left QR.',lowerStyle:'outline',width:.7,anchor:'right',lowerHeight:.14,qrAnchor:'bottom-left',logoCorner:'top-right'},
    {id:'desk-banner',label:'Desk banner',family:'Framed desk',description:'NBS-reference section tab above a full light headline banner.',lowerStyle:'framed',lowerHeight:.19,qrAnchor:'bottom-right',tickerStyle:'light',safeX:.048},
    {id:'desk-interview',label:'Desk interview',family:'Framed desk',description:'A shorter framed section-and-headline strap for interviews.',lowerStyle:'framed',width:.7,lowerHeight:.17,tickerStyle:'light'},
    {id:'desk-sidebar',label:'Desk sidebar',family:'Framed desk',description:'Right-side station mark above a framed headline and QR companion.',lowerStyle:'framed',width:.76,lowerHeight:.19,qrAnchor:'bottom-right',logoCorner:'top-right',tickerHeight:.065},
    {id:'desk-briefing',label:'Desk briefing',family:'Framed desk',description:'Full-width light briefing strip with a left QR and right station mark.',lowerStyle:'stripe',lowerHeight:.16,qrAnchor:'top-left',logoCorner:'top-right',tickerStyle:'light'},
    {id:'compact-left',label:'Compact left',family:'Compact',description:'Small dark lower-left card and a clear upper-right QR area.',lowerStyle:'dark',width:.48,lowerHeight:.115,tickerHeight:.045,logoScale:.10},
    {id:'compact-right',label:'Compact right',family:'Compact',description:'Small lower-right card with the station mark above and QR opposite.',lowerStyle:'dark',width:.48,anchor:'right',lowerHeight:.115,qrAnchor:'top-left',logoCorner:'top-right',tickerHeight:.045,logoScale:.10},
    {id:'social-card',label:'Social card',family:'Compact',description:'Centred two-line card with a generous safe inset for portrait outputs.',lowerStyle:'centered',width:.7,anchor:'center',lowerHeight:.20,safeX:.07,safeY:.065,tickerHeight:.06}
    ,{id:'studio-chevron',label:'Studio chevron',family:'Imported references',description:'Editable section badge and light headline with an angled brand accent. Adapted from references 1–4.',lowerStyle:'chevron',lowerHeight:.14,tickerHeight:.045,safeX:.035,safeY:.035,qrAnchor:'top-right'}
  ].map(item => Object.freeze(Object.assign({},templateDefaults,item))));
  function template(id) { return TEMPLATES.find(item => item.id === id) || TEMPLATES[0]; }
  function templateFor(options) { return template(options && options.theme && options.theme.broadcastTemplate); }
  function safeArea(cv, options) {
    const unit = Math.min(cv.width, cv.height);
    const news = !!(options && options.theme && options.theme.id === 'news');
    const selected = templateFor(options);
    const x = news ? cv.width * selected.safeX : unit * .035;
    const y = news ? cv.height * selected.safeY : unit * .035;
    return {unit, news, x, y, width:cv.width - x * 2, height:cv.height - y * 2,
      right:cv.width - x, bottom:cv.height - y, gap:unit * (news ? selected.gap : .018)};
  }
  const overlaps = (a, b, gap = 0) => a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
  function place(rect, safe, obstacles) {
    const blocked = (obstacles || []).filter(Boolean);
    const xs = [rect.x, safe.x, safe.right - rect.width];
    const ys = [rect.y, safe.y, safe.bottom - rect.height];
    blocked.forEach(item => {
      xs.push(item.x - rect.width - safe.gap, item.x + item.width + safe.gap);
      ys.push(item.y - rect.height - safe.gap, item.y + item.height + safe.gap);
    });
    let best = null, distance = Infinity;
    for (const x of xs) for (const y of ys) {
      const next = {x, y, width:rect.width, height:rect.height};
      if (x < safe.x - .001 || y < safe.y - .001 ||
          x + rect.width > safe.right + .001 || y + rect.height > safe.bottom + .001 ||
          blocked.some(item => overlaps(next, item, safe.gap * .99))) continue;
      const score = Math.abs(x - rect.x) + Math.abs(y - rect.y);
      if (score < distance) { best = next; distance = score; }
    }
    return best;
  }
  function plan(cv, options = {}) {
    const safe = safeArea(cv, options), u = safe.unit, logo = options.logoRect || null;
    const selected = templateFor(options);
    // Bottom-corner logos reserve their real height, not an assumed logo size.
    let bottom = safe.bottom;
    if (logo && logo.y + logo.height > cv.height * .65) bottom = Math.min(bottom, logo.y - safe.gap);
    const tickerHeight = options.hasTicker ? u * selected.tickerHeight : 0;
    const ticker = tickerHeight ? {x:safe.x, y:bottom - tickerHeight, width:safe.width, height:tickerHeight} : null;
    if (ticker) bottom = ticker.y - safe.gap;
    const kind = options.commerceKind;
    const qr = kind === 'qr' || kind === 'qr-image';
    let commerce = qr ? {x:safe.right - u * (kind === 'qr-image' ? .44 : .23),
      y:bottom - u * .28, width:u * (kind === 'qr-image' ? .44 : .23), height:u * .28} : null;
    if (commerce && selected.qrAnchor.endsWith('left')) commerce.x = safe.x;
    if (commerce && selected.qrAnchor.startsWith('top')) commerce.y = safe.y;
    const lower = options.hasLower ? {x:safe.x, y:bottom - u * selected.lowerHeight,
      width:safe.width * selected.width, height:u * selected.lowerHeight} : null;
    if (lower && commerce && selected.qrAnchor.startsWith('bottom')) {
      const remaining = safe.width - commerce.width - safe.gap;
      if (remaining >= u * .46) {
        lower.width = Math.min(lower.width,remaining);
        if (selected.qrAnchor.endsWith('left')) lower.x = safe.x + commerce.width + safe.gap;
      }
      else commerce.y = lower.y - safe.gap - commerce.height;
    }
    if (lower) {
      const regionLeft = lower.x;
      const regionRight = commerce && selected.qrAnchor === 'bottom-right' && commerce.y + commerce.height > lower.y
        ? commerce.x - safe.gap : safe.right;
      if (selected.anchor === 'right') lower.x = Math.max(regionLeft,regionRight - lower.width);
      if (selected.anchor === 'center') lower.x = Math.max(regionLeft,regionLeft + (regionRight - regionLeft - lower.width) / 2);
    }
    if (commerce) {
      const preferred = commerce, obstacles = [logo, lower, ticker];
      commerce = place(preferred, safe, obstacles);
      // An explicitly oversized bottom logo can leave no full-size QR bay on
      // a square output. Fit the complete card proportionally into a free bay;
      // never crop its code or change the saved logo size to make it fit.
      for (const scale of [.9, .8, .7, .6]) {
        if (commerce) break;
        const width = preferred.width * scale, height = preferred.height * scale;
        commerce = place({x:selected.qrAnchor.endsWith('left') ? safe.x : safe.right - width,
          y:selected.qrAnchor.startsWith('top') ? safe.y : preferred.y + preferred.height - height,
          width, height}, safe, obstacles);
      }
    }
    return {safe, logo, lower, ticker, commerce, template:selected};
  }
  return {TEMPLATES, template, safeArea, overlaps, place, plan};
})();
