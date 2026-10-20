/* openlive-displays.js — the real displays attached to this machine.

   WHY THIS EXISTS
   arena-data.js hardcoded three displays ("Display 1 — 1920 x 1080",
   "Display 2 — 1920 x 1080", "Display 3 — 3840 x 2160"). None of them are real.
   On a machine with one 1920x1200 panel the Output menu still offered three
   fictional projectors, and picking one did nothing — the worst kind of clone
   detail, because it looks finished and lies.

   WHAT A BROWSER CAN ACTUALLY SEE
   - window.screen           the CURRENT display only. Always available.
   - window.getScreenDetails() the Window Management API: every attached screen,
                             with position, size, scale, colour depth, which is
                             primary and which is internal. Chromium only, needs
                             the "window-management" permission, and the
                             permission prompt needs a user gesture.
   So the honest model is: report one real display immediately, and report all of
   them once the user has granted permission. Never invent a display.

   Resolume does not create outputs either — the operating system does, and
   screens.htm says exactly that. A display appears here because Windows says it
   exists, which is the same contract Arena has. */
(function () {
  'use strict';
  if (window.OpenLiveDisplays) return;

  var cached = null;          /* ScreenDetails once granted */
  var listeners = [];
  var lastList = null;
  var permission = 'unknown'; /* unknown | granted | denied | unsupported */
  var detailedScreens = [];   /* ScreenDetailed objects carrying `change` */

  function supported() { return typeof window.getScreenDetails === 'function'; }

  /* screen.isExtended is readable WITHOUT any permission. It does not say how
     many displays there are or where they sit, but it does say whether there is
     more than one — which is exactly the difference between "you have one
     monitor" and "I am not allowed to look". Reporting one display while the
     desktop is extended is the lie this guards against. */
  function extended() { return ('isExtended' in screen) ? !!screen.isExtended : false; }

  /* The Window Management API exposes no hardware serial number. Resolution is
     still the one thing that must NEVER be used as identity: changing a Windows
     display mode would make the same projector look newly attached, leave its
     Screen on the old raster and keep Output Transformation at the wrong size.

     Prefer Chromium's display label when it is present. Otherwise use the
     stable role exposed by ScreenDetailed and disambiguate equal peers by their
     desktop order. Position is deliberately only the tie-breaker, not part of
     the id, so changing resolution/DPI does not change identity. If two
     completely indistinguishable displays are physically rearranged, the web
     platform supplies no fact that can identify which chassis moved. */
  function displayIdentity(sc) {
    var label = String(sc && sc.label || '').trim().toLowerCase();
    if (label) return 'label:' + encodeURIComponent(label);
    var primary = sc && sc.isPrimary ? 'primary' : 'secondary';
    var internal = sc && sc.isInternal === true ? 'internal'
                 : sc && sc.isInternal === false ? 'external' : 'unknown';
    return 'role:' + primary + ':' + internal;
  }

  function displayId(sc, all) {
    var identity = displayIdentity(sc);
    var peers = (all || [sc]).filter(function (candidate) {
      return displayIdentity(candidate) === identity;
    }).slice().sort(function (a, b) {
      return (Number(a.left) || 0) - (Number(b.left) || 0) ||
             (Number(a.top) || 0) - (Number(b.top) || 0);
    });
    var ordinal = Math.max(0, peers.indexOf(sc));
    return 'screen:' + identity + ':' + ordinal;
  }

  /* 'denied' is materially different from 'prompt': a denied permission cannot
     be re-prompted from script, so offering a "detect" button that silently does
     nothing is worse than saying it is blocked. Resolved live because the user
     can change it in site settings while the page is open. */
  function permissionState() {
    if (!supported()) return Promise.resolve('unsupported');
    if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve(permission);
    return navigator.permissions.query({ name: 'window-management' })
      .then(function (p) { permission = p.state; return p.state; })
      .catch(function () { return permission; });
  }

  /* The single display we can always see, with no permission at all. It is
     labelled "Display 1" rather than "Primary" because we genuinely cannot tell
     whether it is the primary one until getScreenDetails resolves.

     complete is NOT unconditionally false. screen.isExtended is specified as
     "the device has more than one screen", and it is readable without any
     permission — so when it reads false, one display is not a partial answer,
     it is the whole answer, and callers may say so. Reporting "there may be
     more" on a single-monitor laptop is its own small lie. */
  function fallbackList() {
    var s = window.screen || {};
    var more = extended();
    var scale = window.devicePixelRatio || 1;
    var pixelWidth = Math.round((s.width || 0) * scale);
    var pixelHeight = Math.round((s.height || 0) * scale);
    var list = [{
      index: 0,
      id: displayId({ width:s.width || 0, height:s.height || 0,
                      scale:scale, colorDepth:s.colorDepth || 24,
                      isPrimary:true, isInternal:null, left:0, top:0 }),
      label: 'Display 1: ' + pixelWidth + ' x ' + pixelHeight,
      width: s.width || 0,
      height: s.height || 0,
      pixelWidth: pixelWidth,
      pixelHeight: pixelHeight,
      left: 0, top: 0,
      scale: scale,
      colorDepth: s.colorDepth || 24,
      primary: true,
      internal: null,
      current: true,
      complete: !more
    }];
    /* The desktop IS extended but enumeration is blocked. Say so, and make the
       entry unselectable rather than pretending it is a display we could target:
       we know it exists, we do not know its size or where it starts, and
       guessing an offset would put the output window somewhere arbitrary. */
    if (more) {
      list.push({
        index: 1,
        id: 'screen:unknown',
        label: 'Additional display detected; enumeration blocked',
        width: 0, height: 0, left: 0, top: 0,
        scale: 1, colorDepth: 24,
        primary: false, internal: false, current: false,
        complete: false,
        blocked: true,
        permission: permission,
        reason: 'The desktop is extended, but the window-management permission ' +
                'is ' + permission + ', so the size and position of the other ' +
                'display cannot be read. Allow window management for this site, ' +
                'or use Output > Windowed and drag that window across manually.'
      });
    }
    return list;
  }

  function fromDetails(details) {
    var screens = details && details.screens ? details.screens : [];
    var current = details && details.currentScreen;
    return screens.map(function (sc, i) {
      var scale = sc.devicePixelRatio || 1;
      var pixelWidth = Math.round(sc.width * scale);
      var pixelHeight = Math.round(sc.height * scale);
      return {
        index: i,
        id: displayId(sc, screens),
        label: 'Display ' + (i + 1) + ': ' + pixelWidth + ' x ' + pixelHeight +
               (sc.isPrimary ? ' (primary)' : '') +
               (sc.isInternal ? ' · internal' : ''),
        width: sc.width, height: sc.height,
        pixelWidth: pixelWidth, pixelHeight: pixelHeight,
        left: sc.left, top: sc.top,
        scale: scale,
        colorDepth: sc.colorDepth || 24,
        primary: !!sc.isPrimary,
        internal: !!sc.isInternal,
        current: sc === current,
        complete: true
      };
    });
  }

  /* `ScreenDetails.screenschange` only means a display was added or removed.
     Resolution, scale and position changes are fired on the individual
     ScreenDetailed object instead. In particular, `currentscreenchange` cannot
     see a mode change on a projector that is not hosting this control window.
     Rebind after topology changes so newly attached Screens are observed too. */
  function publishDetailedChange() {
    if (cached) publish(fromDetails(cached));
  }

  function bindDetailedScreens(details) {
    detailedScreens.forEach(function (sc) {
      try { if (sc && sc.removeEventListener) sc.removeEventListener('change', publishDetailedChange); }
      catch (err) {}
    });
    detailedScreens = [];
    var list = details && details.screens ? details.screens : [];
    list.forEach(function (sc) {
      if (!sc || !sc.addEventListener) return;
      try { sc.addEventListener('change', publishDetailedChange); detailedScreens.push(sc); }
      catch (err) {}
    });
  }

  function publish(list) {
    lastList = list;
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](list); } catch (err) {
        if (window.console && console.error) console.error('OpenLiveDisplays listener failed', err);
      }
    }
    return list;
  }

  /* Without Window Management permission the legacy Screen is still live and
     its `change` event is the only signal for a single-display mode/DPI change. */
  try {
    if (window.screen && window.screen.addEventListener)
      window.screen.addEventListener('change', function () {
        publish(cached ? fromDetails(cached) : fallbackList());
      });
  } catch (err) {}

  window.OpenLiveDisplays = {
    version: 1,
    supported: supported,
    permission: function () { return permission; },
    // A granted permission alone does not prove enumeration succeeded. After
    // a failed request list() may still be the current-screen fallback, whose
    // left/top are not measured desktop coordinates.
    enumerated: function () { return !!cached && permission === 'granted'; },

    /* Synchronous, always safe, never empty. Returns the full set once granted,
       otherwise the one display we can see. complete:false on an entry is the
       signal that this list may be short — surface that rather than implying it
       is the whole truth. */
    list: function () {
      if (cached) return fromDetails(cached);
      return lastList || fallbackList();
    },

    /* Ask for the full set. MUST be called from a user gesture the first time,
       or the permission prompt is suppressed and this resolves to the fallback.
       Wire it to opening the Output menu, not to page load. */
    extended: extended,
    permissionState: permissionState,

    /* One sentence a UI can print beside a display list without having to
       re-derive the three cases. Every caller that shows displays owes the user
       an answer to "is this all of them?", and they were each inventing their
       own wording. */
    describe: function () {
      var n = this.list().filter(function (d) { return !d.blocked; }).length;
      var many = n === 1 ? '1 display' : n + ' displays';
      if (cached) return many + '. Enumerated by the operating system.';
      if (!extended()) return many + '. The desktop is not extended, so this is all of them.';
      if (permission === 'denied')
        return many + ' of an unknown number. The desktop IS extended, but the ' +
               'window-management permission is denied, so the others cannot be ' +
               'measured. Allow it in the site settings for this page.';
      if (!supported())
        return many + '. This browser has no Window Management API, so only the ' +
               'current display can be seen.';
      return many + ' so far. Open this menu again to let the browser ask for ' +
             'permission to see the rest.';
    },

    /* A window positioned on a specific display needs enumeration. A window the
       user DRAGS to the projector does not — and that path works with the
       permission denied, which is the situation on this machine. Opened at a
       modest size so it is easy to grab and move; the opened page requests
       fullscreen on its own first click, because requestFullscreen from the
       opener is refused by every browser. */
    openWindow: function (url, opts) {
      var o = opts || {};
      var w = null;
      try {
        w = window.open(url || 'about:blank', o.name || 'openlive-output',
          'width=' + (o.width || 1280) + ',height=' + (o.height || 720) +
          ',menubar=no,toolbar=no,location=no,status=no,resizable=yes');
      } catch (err) { this.lastError = String(err && err.message || err); return null; }
      if (!w) { this.lastError = 'popup blocked'; return null; }
      this.lastError = null;
      return w;
    },

    request: function () {
      if (!supported()) { permission = 'unsupported'; return Promise.resolve(publish(fallbackList())); }
      if (cached) return Promise.resolve(publish(fromDetails(cached)));
      return window.getScreenDetails().then(function (details) {
        cached = details; permission = 'granted';
        bindDetailedScreens(details);
        /* Screens can be plugged in, unplugged or rearranged mid-show. */
        try {
          details.addEventListener('screenschange', function () {
            bindDetailedScreens(details);
            publish(fromDetails(details));
          });
          details.addEventListener('currentscreenchange', function () { publish(fromDetails(details)); });
        } catch (err) {}
        return publish(fromDetails(details));
      }).catch(function (err) {
        /* A failed call is not automatically a permanent denial. Chromium also
           rejects getScreenDetails when it was not reached from a live user
           gesture, while the permission remains `prompt`. Re-query so the UI
           keeps offering the one action that can still succeed. */
        window.OpenLiveDisplays.lastError = String(err && err.message || err || 'display enumeration failed');
        return permissionState().then(function (state) {
          permission = state === 'denied' ? 'denied'
                     : state === 'prompt' ? 'prompt'
                     : (state || 'unknown');
          return publish(fallbackList());
        }, function () {
          permission = 'unknown';
          return publish(fallbackList());
        });
      });
    },

    onChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },

    /* 'granted' means getScreenDetails will resolve without a prompt, so the
       full list can be fetched at load with no gesture and no dialog. Only the
       'prompt' case has to wait for a click. Without this a page that already
       had permission still showed one display until the user happened to open
       the right menu. */
    prime: function () {
      var self = this;
      return permissionState().then(function (state) {
        if (state === 'granted') return self.request();
        return self.list();
      });
    },

    /* Open a borderless window placed on a specific display. This is what makes
       a second monitor an OUTPUT rather than a place to drag a window to.
       Returns the window, or null with .lastError set. Requires the same
       permission as request(), and a user gesture. */
    lastError: null,

    /* Like openOn, but a window of a GIVEN SIZE placed on the chosen display
       rather than one filling it. This is what Windowed output needs: the
       manual calls it "a rectangle exactly the size of your composition", and
       the composition is rarely the size of the display. Without this the
       caller has to fall back to openWindow(), which passes no left/top at all
       and therefore silently discards the display the user picked.
       Centred on the display, and clamped so a composition larger than the
       screen still opens with its origin on that screen. */
    openAt: function (index, url, opts) {
      var list = this.list();
      var o = opts || {};
      var d = o.display || list[index] || list[0];
      var w = Math.max(1, o.width || 1280), h = Math.max(1, o.height || 720);
      if (!d) return this.openWindow(url, o);
      if (d.blocked || !Number(d.width) || !Number(d.height)) {
        this.lastError = d.reason || 'display geometry is unavailable';
        return null;
      }
      var left = Math.round((d.left || 0) + Math.max(0, ((d.width || w) - w) / 2));
      var top = Math.round((d.top || 0) + Math.max(0, ((d.height || h) - h) / 2));
      var feat = 'left=' + left + ',top=' + top + ',width=' + w + ',height=' + h +
                 ',menubar=no,toolbar=no,location=no,status=no,resizable=yes';
      var win = null;
      try { win = window.open(url || 'about:blank', o.name || ('openlive-output-w' + index), feat); }
      catch (err) { this.lastError = String(err && err.message || err); return null; }
      if (!win) { this.lastError = 'popup blocked'; return null; }
      this.lastError = null;
      return win;
    },

    openOn: function (index, url, opts) {
      var list = this.list();
      var o = opts || {};
      var d = o.display || list[index] || list[0];
      if (!d) { this.lastError = 'no display'; return null; }
      if (d.blocked || !Number(d.width) || !Number(d.height)) {
        this.lastError = d.reason || 'display geometry is unavailable';
        return null;
      }
      var feat = 'left=' + (d.left || 0) + ',top=' + (d.top || 0) +
                 ',width=' + d.width + ',height=' + d.height +
                 ',menubar=no,toolbar=no,location=no,status=no,resizable=yes';
      var w = null;
      try { w = window.open(url || 'about:blank', o.name || ('openlive-output-' + index), feat); }
      catch (err) { this.lastError = String(err && err.message || err); return null; }
      if (!w) { this.lastError = 'popup blocked'; return null; }
      this.lastError = null;
      /* Fullscreen needs its own gesture inside the new window; a caller that
         wants it should do so from a click there. Attempting it here fails
         silently on every browser, so it is deliberately not attempted. */
      return w;
    }
  };

  /* Resolve the permission state once at load. It needs no gesture, and without
     it the first fallbackList() built before any query says "the permission is
     unknown" — which reads as evasion when the real answer is "denied". */
  permissionState().then(function (state) {
    if (state === 'granted') window.OpenLiveDisplays.request();
  }).catch(function () {});
})();
