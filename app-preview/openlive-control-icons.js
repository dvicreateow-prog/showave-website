/* Local interface vectors. One geometry and stroke scale for editor, panel,
 * source and window actions; source artwork keeps its existing attribution. */
(function installControlIcons(global) {
  'use strict';
  if (global.OpenLiveControlIcons) return;
  const shapes = {
    plus:'<path d="M8 3v10M3 8h10"/>',
    menu:'<path d="M3 4h10M3 8h10M3 12h10"/>',
    loop:'<path d="M12 3.5H5a3 3 0 0 0-3 3V8m2 4.5h7a3 3 0 0 0 3-3V8M10 1.5l2 2-2 2M6 10.5l-2 2 2 2"/>',
    globe:'<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/>',
    text:'<path d="M3 4V2.5h10V4M8 2.5v11M5.5 13.5h5"/>',
    gamepad:'<path d="M5 4h6c2 0 3 3 3.5 6.5.4 3-2 3-3.5.5H5c-1.5 2.5-4 2.5-3.5-.5C2 7 3 4 5 4ZM4 6v4M2 8h4M10 7h.01M12 9h.01"/>',
    audio:'<path d="M2 6v4M5 3v10M8 5v6M11 2v12M14 6v4"/>',
    slideshow:'<rect x="2" y="2" width="9" height="9" rx="1"/><path d="m2 9 3-3 3 3 3-2M5 14h9V5"/>',
    minus:'<path d="M3 8h10"/>',
    close:'<path d="m4 4 8 8M12 4l-8 8"/>',
    options:'<circle cx="8" cy="3" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="8" cy="13" r=".8"/>',
    dock:'<path d="M7 2.5H2.5v11h11V9M13.5 2.5l-7 7M6.5 5.5v4h4"/>',
    undock:'<path d="M7 2.5H2.5v11h11V9M9.5 2.5h4v4M13.5 2.5l-7 7"/>',
    'split-vertical':'<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M8 2.5v11"/>',
    'split-horizontal':'<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 8h11"/>',
    join:'<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M8 2.5v3M8 10.5v3M10.5 8h-5m2-2-2 2 2 2"/>',
    swap:'<path d="M2.5 5h11m-3-3 3 3-3 3M13.5 11h-11m3-3-3 3 3 3"/>',
    duplicate:'<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-3h-8v8h3"/>',
    minimize:'<path d="M3 11.5h10"/>',
    maximize:'<rect x="3" y="3" width="10" height="10" rx=".5"/>',
    restore:'<rect x="2.5" y="5.5" width="8" height="8" rx=".5"/><path d="M5.5 5.5v-3h8v8h-3"/>',
    reset:'<path d="M3 5.5A5.5 5.5 0 1 1 2.5 9M2.5 2.5v3.5H6"/>',
    panels:'<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M7 2v12M7 7h7"/>',
    sidebar:'<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 2v12"/>',
    grid:'<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M8 2.5v11M2.5 8h11"/>',
    gear:'<path d="m6.5 2 .3-1h2.4l.3 1 1 .5 1.2-.2 1.7 1.7-.2 1.2.5 1 1 .3v2.4l-1 .3-.5 1 .2 1.2-1.7 1.7-1.2-.2-1 .5-.3 1H6.8l-.3-1-1-.5-1.2.2-1.7-1.7.2-1.2-.5-1-1-.3V6.8l1-.3.5-1-.2-1.2 1.7-1.7 1.2.2z"/><circle cx="8" cy="8" r="2.2"/>',
    visible:'<path d="M1.5 8c1.5-3 3.7-4.5 6.5-4.5s5 1.5 6.5 4.5c-1.5 3-3.7 4.5-6.5 4.5S3 11 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
    invisible:'<path d="m2 2 12 12M6 3.8A7 7 0 0 1 8 3.5c2.8 0 5 1.5 6.5 4.5a10 10 0 0 1-2 2.7M9.7 12.3a7 7 0 0 1-1.7.2c-2.8 0-5-1.5-6.5-4.5a10 10 0 0 1 2-2.7"/>',
    locked:'<rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1"/>',
    unlocked:'<rect x="3.5" y="7" width="9" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 5.7-1.3M8 10v1"/>',
    up:'<path d="m4 10 4-4 4 4"/>',
    down:'<path d="m4 6 4 4 4-4"/>',
    left:'<path d="m10 4-4 4 4 4"/>',
    right:'<path d="m6 4 4 4-4 4"/>',
    play:'<path d="m5 3 8 5-8 5Z"/>',
    'play-back':'<path d="m11 3-8 5 8 5Z"/>',
    pause:'<path d="M5 3v10M11 3v10"/>',
    stop:'<rect x="3.5" y="3.5" width="9" height="9" rx=".5"/>',
    previous:'<path d="M3 3v10m10-10-7 5 7 5Z"/>',
    next:'<path d="M13 3v10M3 3l7 5-7 5Z"/>',
    first:'<path d="M2 3v10m6-10L3.5 8 8 13V3Zm6 0L9.5 8 14 13V3Z"/>',
    last:'<path d="M14 3v10M8 3l4.5 5L8 13V3ZM2 3l4.5 5L2 13V3Z"/>',
    'nudge-left':'<path d="M2.5 3v10M13.5 8H5m3-3-3 3 3 3"/>',
    'nudge-right':'<path d="M13.5 3v10M2.5 8H11m-3-3 3 3-3 3"/>',
    metronome:'<path d="M5 2.5h6l2.5 11h-11L5 2.5ZM8 5v6m0-3 4-5M5.5 11h5"/>',
    heart:'<path d="M8 13.5 2.5 8a3.2 3.2 0 0 1 4.5-4.5L8 4.5l1-1A3.2 3.2 0 0 1 13.5 8L8 13.5Z"/>',
    record:'<circle cx="8" cy="8" r="4.5"/>',
    performance:'<path d="M2.5 12.5a6 6 0 1 1 11 0M8 3v1M3.7 5.3l.8.8m7-0.8-.8.8M8 10l3-3"/><circle cx="8" cy="10" r="1"/>',
    undo:'<path d="M5 2.5 2 5.5l3 3M2 5.5h7a4 4 0 0 1 0 8H6"/>',
    redo:'<path d="m11 2.5 3 3-3 3M14 5.5H7a4 4 0 0 0 0 8h3"/>',
    folder:'<path d="M2 4h4l2 2h6v7H2Z"/>',
    file:'<path d="M9.5 1.5h-6v13h9V5l-3-3.5Zm0 0V5h3"/>',
    save:'<path d="M12 2.5h-9.5v11h11V4L12 2.5ZM5 2.5v4h6v-4M5 13.5v-4h6v4"/>',
    import:'<path d="M8 1.5v8m-3-3 3 3 3-3M2.5 10v3.5h11V10"/>',
    export:'<path d="M8 9.5v-8m-3 3 3-3 3 3M2.5 10v3.5h11V10"/>',
    edit:'<path d="m10.5 2.5 3 3-8 8-3 .5.5-3 8-8ZM8.5 4.5l3 3"/>',
    remove:'<path d="M2.5 4h11M6 4V2h4v2M4 4l.5 10h7L12 4M6.5 7v4M9.5 7v4"/>',
    grip:'<path d="M6 3h.01M10 3h.01M6 8h.01M10 8h.01M6 13h.01M10 13h.01"/>',
    autosize:'<path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/><rect x="5" y="5.5" width="6" height="5" rx=".5"/>',
    audience:'<path d="M2.5 11V7m3.5 4V3m3.5 8V5m3.5 6V2M2 14h12"/>',
    playback:'<rect x="2" y="2" width="12" height="9" rx="1"/><path d="m6.5 4.5 4 2-4 2ZM2 14h12M6 12.5v3"/>',
    home:'<path d="m1.5 7 6.5-5 6.5 5M3 6v8h10V6M6.5 14V9h3v5"/>',
    moon:'<path d="M13.4 9.4A5.7 5.7 0 0 1 6.6 2.6a5.7 5.7 0 1 0 6.8 6.8Z"/>',
    sun:'<circle cx="8" cy="8" r="3"/><path d="M8 1v1m0 12v1M1 8h1m12 0h1M3 3l.7.7m8.6 8.6.7.7M3 13l.7-.7m8.6-8.6L13 3"/>',
    check:'<path d="m3 8 3 3 7-7"/>',
    help:'<circle cx="8" cy="8" r="6"/><path d="M6 5.5a2 2 0 0 1 4 0c0 1.5-2 1.5-2 3M8 11.5h.01"/>',
    search:'<circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4 4"/>',
    camera:'<path d="M2 5h3l1-2h4l1 2h3v8H2Z"/><circle cx="8" cy="9" r="2.5"/>',
    microphone:'<rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7v.5a5 5 0 0 0 10 0V7M8 12.5v2M5.5 14.5h5"/>',
    screen:'<rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M8 11.5v3M5 14.5h6"/>',
    phone:'<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 3.5h2M8 12.5h.01"/>',
    mirror:'<rect x="1" y="2.5" width="10" height="8" rx="1"/><path d="M5.5 10.5v3M3.5 13.5h4"/><rect x="10" y="6.5" width="5" height="8" rx="1"/>',
    brush:'<path d="m7 9 5-7a1.4 1.4 0 0 1 2 2L8 10M7 9c-2-1-4 0-4 2 0 1-1 2-2 2 4 2 7 0 7-3Z"/>',
    image:'<rect x="2" y="2" width="12" height="12" rx="1"/><circle cx="5.5" cy="5.5" r="1"/><path d="m2 12 4-4 3 3 2-2 3 3"/>',
    video:'<rect x="1.5" y="4" width="9" height="8" rx="1"/><path d="m10.5 6 4-2v8l-4-2"/>',
    layers:'<path d="m1.5 5 6.5-3 6.5 3L8 8 1.5 5Zm0 4L8 12l6.5-3m-13 4L8 16l6.5-3" transform="translate(0 -1)"/>',
    timeline:'<path d="M2 2v12M5 4h8M5 8h5M5 12h8"/>',
    nodes:'<rect x="1.5" y="6" width="4" height="4" rx=".5"/><rect x="10.5" y="1.5" width="4" height="4" rx=".5"/><rect x="10.5" y="10.5" width="4" height="4" rx=".5"/><path d="M5.5 8H8V3.5h2.5M8 8v4.5h2.5"/>',
    snap:'<path d="M3 2.5v6.5a5 5 0 0 0 10 0V2.5h-3V9a2 2 0 0 1-4 0V2.5H3ZM3 6h3m4 0h3"/>',
    select:'<path d="m3 1.5 10 7-5 .5-2.5 4.5-2.5-12ZM8 9l3 5.5"/>',
    pan:'<path d="M5 7V4a1 1 0 0 1 2 0v3-4a1 1 0 0 1 2 0v4-3a1 1 0 0 1 2 0v4-2a1 1 0 0 1 2 0v4c0 2.5-1.5 4-4 4H8c-1.5 0-2.5-.5-3.5-2L2 8.5a1.2 1.2 0 0 1 2-1L5 9V7Z"/>',
    fullscreen:'<path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/>',
    headphones:'<path d="M2.5 9V7a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="8" width="3" height="6" rx="1"/><rect x="11" y="8" width="3" height="6" rx="1"/>',
    map:'<path d="m2 3 4-1 4 1 4-1v11l-4 1-4-1-4 1V3ZM6 2v11m4-10v11"/>',
    link:'<path d="m6 10 4-4M6 4.5l1.5-1.5a3.2 3.2 0 0 1 4.5 4.5L10.5 9M5.5 7 4 8.5A3.2 3.2 0 0 0 8.5 13l1.5-1.5"/>',
    pin:'<path d="m6 2 6 6-3 1-2 3-3-3 3-2 1-3-2-2ZM4 12l-2 2"/>',
    volume:'<path d="M2 6h3l4-3v10l-4-3H2ZM11.5 5a4.5 4.5 0 0 1 0 6"/>',
    muted:'<path d="M2 6h3l4-3v10l-4-3H2Zm9.5 0 3 4m0-4-3 4"/>'
  };
  const aliases = {add:'plus',hide:'close',dots:'options',cogs:'gear',show:'visible','always-on-top':'pin',media:'video',presentation:'playback',effects:'gear',copy:'duplicate',trash:'remove',download:'import',upload:'export',mute:'muted',rotate:'reset',generator:'brush','chevron-down':'down','chevron-up':'up','chevron-left':'left','chevron-right':'right'};
  const resolve = name => aliases[name] || name;
  const has = name => Object.prototype.hasOwnProperty.call(shapes,resolve(name));
  function markup(name) {
    const key = resolve(name);
    if (!has(key)) throw new RangeError('Unknown control icon: ' + name);
    return '<svg xmlns="http://www.w3.org/2000/svg" class="showave-control-icon" data-control-icon="' + key + '" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + shapes[key] + '</svg>';
  }
  function create(name,d=global.document) {
    const container = d.createElement('template');
    container.innerHTML = markup(name);
    return container.content.firstElementChild;
  }
  function mask(name) {
    return 'url("data:image/svg+xml,' + encodeURIComponent(markup(name)) + '")';
  }
  global.OpenLiveControlIcons = Object.freeze({create,markup,mask,has,names:Object.freeze(Object.keys(shapes))});
})(window);
