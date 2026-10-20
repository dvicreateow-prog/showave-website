/* openlive-clock.js — a frame clock that does not stop when the window is not
   in front.

   WHY THIS EXISTS
   requestAnimationFrame is tied to the compositor: the moment a window is
   backgrounded, occluded, or minimised, the browser stops calling it entirely.
   For a document that is fine. For a VJ output it is not — clicking another
   window would freeze the projector mid-show, and the Advanced Output display
   panes would stop showing the live mix exactly when the operator looks away to
   do something else.

   setTimeout is not a fix on its own: Chrome clamps background timers to 1 Hz,
   and after ~5 minutes of a hidden tab to roughly once a minute.

   THE TRICK THAT ACTUALLY WORKS
   A running AudioContext keeps the tab out of the browser's "background idle"
   bucket, because audio must keep flowing. With one alive, background timers run
   at close to their requested rate. So:

       visible  -> requestAnimationFrame, exactly as before
       hidden   -> a timer, with a silent AudioContext keeping it un-throttled

   The AudioContext is created ONLY when first needed and is silent (a gain of
   zero). It is not started at load, because browsers require a user gesture to
   start audio and we must not print a console warning on every page load.

   HONESTY
   A hidden-tab rate is best-effort. Browsers may still throttle, and some
   platforms suspend everything. rate() reports what is ACTUALLY being achieved
   so a caller can display it rather than assume 60. Nothing here pretends the
   feed is live when it is not. */
(function () {
  'use strict';
  if (window.OpenLiveClock) return;

  var subs = [];
  var running = false;
  var rafId = 0;
  var timerId = 0;
  var mode = 'idle';          /* 'raf' | 'timer' | 'idle' */
  var audio = null;
  var audioNode = null;
  var audioOwned = true;      /* false once another module donates its context */
  var targetFps = 60;

  /* Measured, not assumed: an EMA over real inter-frame gaps. */
  var lastT = 0;
  var emaDt = 1000 / 60;
  var frames = 0;

  function measure(now) {
    if (lastT) {
      var dt = now - lastT;
      /* A tab that was suspended returns one enormous gap. Folding it into the
         average would make the reported rate lie for the next several seconds,
         so it is dropped rather than smoothed. */
      if (dt > 0 && dt < 1000) emaDt += (dt - emaDt) * 0.1;
    }
    lastT = now;
    frames++;
  }

  function fire(now) {
    measure(now);
    for (var i = 0; i < subs.length; i++) {
      /* One subscriber throwing must not take the clock down with it — that
         would silently freeze every other pane on the page. */
      try { subs[i](now); } catch (err) {
        if (window.console && console.error) console.error('OpenLiveClock subscriber failed', err);
      }
    }
  }

  function rafLoop() {
    if (!running || mode !== 'raf') return;
    fire(performance.now());
    rafId = requestAnimationFrame(rafLoop);
  }

  /* Silent, zero-gain, and only ever created on demand. The oscillator is what
     keeps the context genuinely "running" — a context with no source can be
     suspended by the browser. */
  function keepAudioAlive() {
    if (!audio) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try { audio = new Ctx(); } catch (err) { audio = null; return; }
      audioOwned = true;
    }
    if (audio.state === 'suspended') { try { audio.resume(); } catch (e) {} }
    /* The oscillator is what keeps the context genuinely "running" — a context
       with no source can be suspended by the browser. Built once per context,
       including on a context donated through useContext(), which arrives with
       no guarantee that anything is playing through it. */
    if (audioNode) return;
    try {
      var gain = audio.createGain();
      gain.gain.value = 0;
      audioNode = audio.createOscillator();
      audioNode.frequency.value = 20;
      audioNode.connect(gain);
      gain.connect(audio.destination);
      audioNode.start();
    } catch (err) { audioNode = null; }
  }

  function timerLoop() {
    if (!running || mode !== 'timer') return;
    fire(performance.now());
  }

  function startRaf() {
    stopTimer();
    mode = 'raf';
    rafId = requestAnimationFrame(rafLoop);
  }
  function startTimer() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    mode = 'timer';
    keepAudioAlive();
    timerId = setInterval(timerLoop, Math.max(4, Math.round(1000 / targetFps)));
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = 0; } }

  function apply() {
    if (!running) return;
    if (document.hidden) { if (mode !== 'timer') startTimer(); }
    else { if (mode !== 'raf') startRaf(); }
  }

  document.addEventListener('visibilitychange', apply);
  /* A window can be fully occluded by another without ever going "hidden", and
     some platforms only report it on blur. Re-evaluating on both is cheap. */
  window.addEventListener('blur', apply);
  window.addEventListener('focus', apply);

  window.OpenLiveClock = {
    version: 1,

    /* Register a per-frame callback. Returns an unsubscribe function. The clock
       starts on the first subscriber and stops when the last one leaves, so a
       page that never subscribes pays nothing. */
    onFrame: function (cb) {
      if (typeof cb !== 'function') return function () {};
      subs.push(cb);
      if (!running) { running = true; lastT = 0; apply(); }
      return function () {
        var i = subs.indexOf(cb);
        if (i >= 0) subs.splice(i, 1);
        if (!subs.length) window.OpenLiveClock.stop();
      };
    },

    stop: function () {
      running = false; mode = 'idle';
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      stopTimer();
    },

    /* Best-effort target for the HIDDEN path. The visible path always follows
       the display's own refresh rate, which is not ours to choose. */
    setTargetFps: function (v) {
      targetFps = Math.max(1, Math.min(120, +v || 60));
      if (mode === 'timer') { stopTimer(); startTimer(); }
      return targetFps;
    },

    /* What is ACTUALLY being achieved right now, measured. Callers should show
       this rather than claim 60. */
    rate: function () { return emaDt > 0 ? 1000 / emaDt : 0; },
    mode: function () { return mode; },
    hidden: function () { return !!document.hidden; },
    frames: function () { return frames; },

    /* True when the clock is delivering frames at a rate worth calling live.
       The threshold is deliberately low: 20fps is still a usable feed, and
       claiming "live" at 2fps would be the kind of lie this module exists to
       avoid. */
    isLive: function () { return running && this.rate() >= 20; },

    /* Audio needs a user gesture on most browsers. Call this from a real click
       so the hidden-window path is armed BEFORE the window is hidden — arming
       it afterwards is exactly when the gesture is unavailable. */
    arm: function () { keepAudioAlive(); return !!audio && audio.state === 'running'; },

    /* Adopt someone else's AudioContext instead of making a second one.
       openlive-audio.js owns THE context for the app — it has to, because a
       context's sample rate is fixed for its life and the Audio preferences
       choose that rate — and two live contexts would mean two output sinks to
       route and two things to resume from one gesture. The keep-alive
       oscillator is rebuilt on the donated context; the silent one this module
       may already have made is closed, because leaving it open is precisely the
       duplication this exists to avoid. The donated context is never closed
       here: we did not open it. */
    useContext: function (ctx) {
      if (!ctx || ctx === audio) return !!audio;
      if (audio && audioOwned) {
        try { if (audioNode) audioNode.stop(); } catch (e) {}
        try { audio.close(); } catch (e) {}
      }
      audio = ctx; audioNode = null; audioOwned = false;
      if (mode === 'timer') keepAudioAlive();
      return true;
    },
    context: function () { return audio; }
  };
})();
