'use strict';
/* =========================================================================
   HOVER BLOOM — THE POINTER LIGHTS ONE SLOT
   Pairs with the "HOVER BLOOM" block at the end of arena.css. That block owns
   the look; this file owns the two numbers it reads, --pointer-x and
   --pointer-y, normalised to -1..1 about the hovered box's centre.

   ITS OWN FILE, not a section of app.js. app.js is 16,700 lines and four of its
   spans are extracted verbatim by tools/test-main-thread-recurring-work.js and
   executed in a bare vm with fakes for EN/$/$$/document; a module that needs
   addEventListener, requestAnimationFrame and matchMedia at load time has no
   business anywhere near them. Nothing here reaches into app.js, so the two
   files can be read, moved or removed independently.

   THE DONOR STUDY LOOPS EVERY CARD ON EVERY POINTERMOVE and measures each one.
   Measured on this app that is 2.10ms for 36 Slots, which projects to ~91ms for
   the 1,568-Clip shows in reference/compositions/ - five frames of work inside
   one 16.7ms frame, several times per frame. So nothing in here is per-Slot:

     - ONE delegated listener per container. #gridCol and #layers are static
       markup that buildGrid/buildLayers never replace - they only replace their
       children - so the listeners survive every rebuild for free. A listener
       bound per Slot would have to be re-bound from seventeen call sites and
       would multiply its own cost by the Clip count.
     - THE RECT IS MEASURED ONCE PER HOVER, never per move. That is the whole
       point: a layout read inside pointermove forces a synchronous style and
       layout flush in the same frame the monitors are rastering, competing with
       the main-thread yield paintMonitorsScheduled already negotiates.
     - Any number of moves collapse into ONE write per animation frame.
     - NO STANDING LOOP. A frame is requested only while a Slot is hovered and
       the pointer is actually moving, and cancelled the moment it is not, so an
       idle window owns nothing. Joining the shared everyFrame clock would have
       run a hover write on every frame forever, including with the pointer
       parked over the transport.
     - THE ARTWORK COSTS NOTHING UNTIL THE POINTER SETTLES. Entry, not steady
       state, is where an artwork bloom is expensive - a URL resolve, a blurred
       3.4x raster and, live, an HTTP GET to Arena on the same connection pool as
       the monitor polls. One 120ms one-shot per entry, cancelled by the next
       entry, means a sweep across a row pays for none of it. See ART_DWELL.
   ========================================================================= */
(function installHoverBloom(){
  /* The host is the box that PAINTS, which is .clip in the grid and .lthumb
     .box in the strip - not the .lthumb wrapper. Writing one level lower keeps
     the custom-property invalidation off the thumbnail canvas, sixty times a
     second, for nothing. */
  /* The third field is whether the zone's host has ARTWORK to bloom. Only the
     grid does, and that is a finding rather than a convenience. A LAYER
     THUMBNAIL IS NOT A LAYER COMPOSITE: paintLayerThumb draws the Layer's
     ACTIVE CLIP and nothing else - no layer opacity, blend, transform or
     effects - and under Mask Mode it deliberately greyscales the result, so a
     saturated copy of that Clip's colour picture would sit under a thumbnail
     that exists to say the Layer has no colour. There is no layer-only
     thumbnail URL in either mode either: AL.thumbUrl is (l,c) and has no
     overload, and the one genuine per-Layer pixel source - AL.snapshotUrl
     behind an async monitors() lookup, Date.now()-cache-busted, live only - is
     an uncacheable HTTP GET that is not synchronously available at pointerover.
     The strip keeps the ColorId bloom, which is what the strip's --cc means. */
  const zones = [['#gridCol', '.clip', true], ['#layers', '.lthumb .box', false]]
    .map(pair => ({root: document.querySelector(pair[0]), pick: pair[1], art: pair[2]}))
    .filter(zone => zone.root);
  if(!zones.length) return;
  /* Read live off the MediaQueryList rather than once at load, so changing the
     OS setting takes effect without a reload. The defensive fallback object
     matches the one alley.html already uses. */
  const calmer = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion:reduce)') : {matches:false};

  let host = null, rect = null, frame = 0, px = 0, py = 0, artTimer = 0;

  /* HOVER INTENT, AND IT IS A COST BOUND RATHER THAN A TASTE. The colour bloom
     costs a gradient, so crossing forty Slots on the way to the transport cost
     forty cheap paints and nothing worth counting. The artwork bloom does not:
     each ENTRY resolves a URL, writes a class and a property onto an
     in-document node, creates a background-image and rasters a blurred,
     3.4x-magnified box - and in LIVE mode issues an HTTP GET to Arena, on the
     same origin and the same six-connection pool as pollArenaFrame and
     pollLiveMonitor. A 90px Slot swept at a normal flick is ~90ms, so an
     un-delayed entry turns one gesture across a row into a burst of requests
     queued in front of the frame-critical polls - and those polls give up at
     2000ms and then sit out 800ms, so hover decoration could visibly stall the
     monitor feed it is decorating.
     120ms is above a sweep and below the ~200ms where a delay starts to read as
     lag. What it buys is exact: a Slot the pointer merely crossed costs the
     colour bloom and NOTHING else - no resolve, no fetch, no blur raster. Only
     a Slot the pointer settled on pays, and only one can be settled on at a
     time, so the artwork path is single-flight by construction.
     ONE one-shot, cleared in release(), never rearmed from the move path: this
     is a debounce, not a clock, and the contract now pins that distinction
     (exactly one setTimeout call site, assigned and cleared) instead of banning
     the word - a strictly narrower ban than the one it replaces, since a bare
     timer anywhere in the module now fails on the count. */
  const ART_DWELL = 120;

  /* THE ARTWORK URL IS READ WHEN THE POINTER SETTLES, never at build time and
     never per move.
     Both sources are volatile by construction: a live thumbnail URL carries
     Arena's thumbnail.last_update as a cache-buster and a playing Clip's stamp
     moves on every reconcile, and an offline poster can be a blob: that
     arena-media revokes on rescan. Written into 1,568 inline styles both go
     stale as dead strings that render nothing and never repaint to say so. Read
     at hover they cannot, and no image is fetched or decoded at idle - the
     pseudo-element has no `content` until :hover, so it issues no request.
     app.js PUBLISHES the resolver; this file still imports no model symbol. The
     lookup happens at CALL time, so load order does not matter - this module is
     last in index.html - and app.js going away leaves the colour bloom whole
     rather than throwing on the hover path. */
  const artUrl = (l, c) => {
    const resolve = window.OpenLiveClipArtUrl;
    if(typeof resolve !== 'function') return '';
    try { return resolve(l, c) || ''; } catch(_){ return ''; }
  };
  /* url() cannot contain a var(), so the property carries the whole token, and
     the characters that could close the quoted string early are escaped - the
     bundled posters are real filenames with spaces in them. A `#` in a poster
     path is left alone deliberately: it is already broken one level up at
     arena-media.js's encodeURI, and escaping it only here would put the CSS
     request and the <img> request on two different URLs.
     SET AND REMOVED TOGETHER WITH .has-art, NEVER SET TO ''. An empty var()
     substitution makes the background shorthand invalid at computed-value time,
     which would take the ColorId floor down with it. */
  const wearArt = node => {
    const url = artUrl(node.dataset.l, node.dataset.c);
    if(!url) return;
    node.style.setProperty('--art', 'url("' + url.replace(/["\\\s]/g, encodeURIComponent) + '")');
    node.classList.add('has-art');
  };

  const release = () => {
    if(frame){ cancelAnimationFrame(frame); frame = 0; }
    /* The dwell is cancelled, not left to fire on a node the pointer has
       already left. That is what makes a sweep cost nothing: the timer armed on
       entry is torn down by the very next entry. */
    if(artTimer){ clearTimeout(artTimer); artTimer = 0; }
    /* Clear the properties, not just the reference. :hover re-creates the
       pseudo-element from whatever inline style is still on the node, so a
       stale --pointer-x would show one frame at the last pointer position
       before the first write lands. Cleared, it falls back to the CSS -10 and
       starts parked off-box, which is what the donor's default is for. */
    if(host){
      host.style.removeProperty('--pointer-x');
      host.style.removeProperty('--pointer-y');
      /* The artwork goes with them, for the same reason and as one operation.
         A Slot re-entered after its Clip was replaced would otherwise light
         with the previous Clip's picture until the resolver answered, and a
         .has-art left behind without its --art would make the shorthand
         invalid at computed-value time. */
      host.style.removeProperty('--art');
      host.classList.remove('has-art');
    }
    host = null; rect = null;
  };

  const write = () => {
    frame = 0;
    /* buildGrid and buildLayers both rebuild by innerHTML and fire no
       pointerout, so a deck or bank switch can rip the hovered node out from
       under a cached rect - render.grid() and render.layers() run together on
       exactly that path. paintPending watches #gridTable.firstElementChild
       because it retains a whole collection; this retains one node, and
       isConnected answers the same question in one property read and covers the
       layer strip as well. */
    if(!host || !host.isConnected) return release();
    if(!rect) rect = host.getBoundingClientRect();
    /* A zero-size box is a transient - a row mid-collapse, a deck being hidden -
       so DROP the measurement rather than keeping it. Retained, it would pin the
       cache at zero and every later move would schedule a frame that only
       re-entered here and bailed, for the rest of the hover. Dropped, the next
       move re-measures once and the hover heals itself. */
    if(!rect.width || !rect.height){ rect = null; return; }
    host.style.setProperty('--pointer-x', ((px - rect.left) / rect.width * 2 - 1).toFixed(3));
    host.style.setProperty('--pointer-y', ((py - rect.top) / rect.height * 2 - 1).toFixed(3));
  };

  for(const zone of zones){
    /* pointerover/pointerout, not pointerenter/pointerleave: only the bubbling
       pair can be delegated to the persistent container, and the container is
       the only attachment point that outlives a rebuild. */
    zone.root.addEventListener('pointerover', event => {
      const found = event.target && event.target.closest ? event.target.closest(zone.pick) : null;
      if(found === host) return;
      release();
      host = found;
      /* ONE resolve, ONE setProperty and ONE classList write per SETTLED hover -
         nothing here runs per move, so the measured pointermove cost is
         untouched, and nothing runs at all for a Slot the pointer merely crossed.
         The single setProperty on an in-document node invalidates that Slot's
         three children, the same cost class as the rect this hover is about to
         measure anyway. The captured node is re-checked at fire time because a
         rebuild between entry and dwell fires no pointerout. */
      if(host && zone.art){
        const settled = host;
        artTimer = setTimeout(() => {
          artTimer = 0;
          if(host === settled && settled.isConnected) wearArt(settled);
        }, ART_DWELL);
      }
    });
    zone.root.addEventListener('pointerout', event => {
      /* .thumb to .name inside the same Slot, or canvas to box inside the same
         thumbnail, is a pointerout too. Only a crossing that actually leaves
         the hovered box ends the hover. relatedTarget is null when the pointer
         leaves the window, which contains() correctly refuses. */
      if(host && !host.contains(event.relatedTarget)) release();
    });
    zone.root.addEventListener('pointermove', event => {
      /* The reduced-motion gate sits HERE and not on pointerover, so the hover
         is still tracked and the Slot still lights - only the tracking stops.
         Gating the entry point instead would silently drop the ColorId tint for
         reduced-motion users, which is a colour, not a motion. */
      if(!host || calmer.matches) return;
      px = event.clientX; py = event.clientY;
      if(!frame) frame = requestAnimationFrame(write);
    }, {passive:true});
    /* The two columns mirror each other's scrollTop, so a wheel over the layer
       strip slides the grid under a stationary cursor with no pointer event on
       any Slot at all - a rect cached on enter is stale immediately and nothing
       would ever say so. DROP the rect rather than re-measuring: the next move
       pays for one measurement, and a scroll that never moves the pointer pays
       for none. Re-measuring here would put a layout read on the scroll path,
       which is the thing this module exists to avoid. */
    zone.root.addEventListener('scroll', () => { rect = null; }, {passive:true});
  }

  addEventListener('resize', () => { rect = null; }, {passive:true});
  /* A native Clip drag suppresses pointer events for the whole gesture, so
     pointerout can simply never arrive. The same three cancellation seams
     clearClipDragPresentation already joins in app.js. The CSS stands the
     effect down on .dragging independently; this releases the tracking. */
  addEventListener('dragend', release, true);
  addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if(document.hidden) release(); });
})();
