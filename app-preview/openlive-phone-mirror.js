/* Phone screen viewer for SHOWAVE editor areas. Capture is deliberately opt-in:
 * the user selects the Windows window containing their mirrored phone. The
 * existing MobileHost controller serves SHOWAVE controls in the other direction.
 * See manual/live-inputs.htm and https://www.w3.org/TR/screen-capture/.
 */
(function installPhoneMirror(root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.OpenLivePhoneMirror = api;
  if (root.Workspace && typeof root.Workspace.register === 'function') {
    root.Workspace.register('PhoneMirror', {
      title:'Phone Mirror',
      build:api.build,
      destroy:api.destroy
    });
  }
})(typeof window !== 'undefined' ? window : null, function phoneMirrorModule(root) {
  'use strict';
  let localController = null;
  const mounts = new WeakMap();

  function tracks(stream) {
    try { return stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []; }
    catch (_) { return []; }
  }
  function videoTrack(stream) {
    return tracks(stream).find(track => track && track.kind === 'video' && track.readyState !== 'ended') || null;
  }
  function stopTracks(stream) {
    tracks(stream).forEach(track => { try { track.stop(); } catch (_) {} });
  }
  function captureError(error) {
    if (error && ['NotAllowedError','AbortError'].includes(error.name))
      return 'Capture was canceled or not allowed. Select phone screen to try again.';
    if (error && error.name === 'InvalidStateError')
      return 'Select phone screen from the active window to open the capture picker.';
    if (error && error.name === 'NotReadableError')
      return 'This window cannot be captured. Keep the phone mirror window open, then try again.';
    return error && error.message || 'The phone screen could not be captured. Try again.';
  }

  /* DOM-free owner, also used by duplicate areas and same-origin popout windows.
   * A generation invalidates a capture picker that resolves after Stop. Failed
   * replacement captures keep the previous live feed and report the failure.
   */
  function createController(options) {
    const config = options || {};
    let stream = null, pending = null, generation = 0, closed = false, releaseTimer = null;
    let error = '', notice = 'No phone screen selected.';
    const listeners = new Set();
    const schedule = config.setTimeout || (root && root.setTimeout ? root.setTimeout.bind(root) : setTimeout);
    const cancel = config.clearTimeout || (root && root.clearTimeout ? root.clearTimeout.bind(root) : clearTimeout);
    let removeTrackListeners = () => {};
    function snapshot() {
      const track = videoTrack(stream);
      let settings = {};
      try { if (track && typeof track.getSettings === 'function') settings = track.getSettings(); } catch (_) {}
      return Object.freeze({
        stream:track ? stream : null, live:!!track, pending:!!pending, closed,
        error, notice, label:track && track.label || 'Phone screen',
        width:Number(settings.width) || 0, height:Number(settings.height) || 0,
        frameRate:Number(settings.frameRate) || 0, muted:!!(track && track.muted)
      });
    }
    function emit() {
      const state = snapshot();
      listeners.forEach(listener => { try { listener(state); } catch (_) {} });
    }
    function release() {
      removeTrackListeners(); removeTrackListeners = () => {};
      const previous = stream; stream = null; stopTracks(previous);
    }
    function watch(capture) {
      const removers = [];
      tracks(capture).forEach(track => {
        if (!track || typeof track.addEventListener !== 'function') return;
        const ended = () => {
          if (stream !== capture || videoTrack(capture)) return;
          release(); notice = 'The phone screen disconnected. Select it again to reconnect.'; emit();
        };
        const changed = () => { if (stream === capture) emit(); };
        for (const [type, listener] of [['ended',ended],['mute',changed],['unmute',changed]]) {
          track.addEventListener(type, listener);
          removers.push(() => track.removeEventListener && track.removeEventListener(type, listener));
        }
      });
      removeTrackListeners = () => removers.forEach(remove => { try { remove(); } catch (_) {} });
    }
    function start(mediaDevices) {
      if (closed) return Promise.reject(new Error('The phone mirror has closed.'));
      if (pending) return pending.promise;
      const devices = mediaDevices || config.mediaDevices || root && root.navigator && root.navigator.mediaDevices;
      if (!devices || typeof devices.getDisplayMedia !== 'function') {
        error = 'Screen capture is unavailable. Open SHOWAVE Desktop or a browser with screen sharing on HTTPS or localhost.';
        notice = ''; emit(); return Promise.reject(new Error(error));
      }
      const token = ++generation;
      error = ''; notice = 'Choose your mirrored phone window in the screen picker.';
      /* Call before an await so the initiating window retains user activation. */
      let request;
      try {
        request = devices.getDisplayMedia({
          video:{displaySurface:'window',frameRate:{ideal:30}},
          audio:false, selfBrowserSurface:'exclude'
        });
      } catch (failure) { request = Promise.reject(failure); }
      const job = {promise:null}; pending = job;
      job.promise = Promise.resolve(request).then(capture => {
        if (closed || token !== generation) { stopTracks(capture); return null; }
        if (!videoTrack(capture)) {
          stopTracks(capture); throw new Error('The selected window did not provide a live video track. Select another window.');
        }
        release(); stream = capture; watch(capture);
        notice = 'Phone screen connected.';
        return capture;
      }).catch(failure => {
        if (token !== generation || closed) return null;
        error = captureError(failure); notice = '';
        throw failure;
      }).finally(() => {
        if (pending === job) { pending = null; emit(); }
      });
      emit();
      return job.promise;
    }
    function stop() {
      ++generation; pending = null; error = '';
      release(); notice = 'Phone screen stopped.'; emit();
    }
    function subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      if (releaseTimer !== null) { cancel(releaseTimer); releaseTimer = null; }
      listeners.add(listener); listener(snapshot());
      return () => {
        if (!listeners.delete(listener) || listeners.size || closed) return;
        /* Area rebuilds and redocking replace a mount. Give the replacement
         * time to attach before ending the last viewer's capture. */
        releaseTimer = schedule(() => {
          releaseTimer = null;
          if (!listeners.size && !closed) stop();
        }, 1500);
      };
    }
    function close() {
      if (closed) return;
      if (releaseTimer !== null) { cancel(releaseTimer); releaseTimer = null; }
      stop(); closed = true; emit(); listeners.clear();
    }
    return Object.freeze({start,stop,subscribe,close,get state(){return snapshot();}});
  }

  function getController() {
    if (!root) return createController();
    /* Keep one stream for duplicate areas, embedded editors and popouts. Passing
     * the calling panel's mediaDevices to start preserves its user activation. */
    for (const candidate of [() => root.top, () => root.opener]) {
      try {
        const owner = candidate();
        if (owner && owner !== root && !owner.closed && owner.OpenLivePhoneMirror)
          return owner.OpenLivePhoneMirror.getController();
      } catch (_) { /* A different-origin window cannot own this panel. */ }
    }
    if (!localController || localController.state.closed) {
      localController = createController();
      root.addEventListener('pagehide', () => { if (localController) localController.close(); }, {once:true});
    }
    return localController;
  }

  function mobileHost(view) {
    for (const candidate of [() => view.top, () => view.opener, () => view]) {
      try { const owner = candidate(); if (owner && !owner.closed && owner.ShowaveMobileHost) return owner.ShowaveMobileHost; }
      catch (_) {}
    }
    return null;
  }
  function build(host) {
    if (!host || !host.ownerDocument) throw new Error('Phone Mirror needs a mount element.');
    destroy(host);
    const doc = host.ownerDocument, view = doc.defaultView || root;
    const controller = getController();
    const panel = doc.createElement('section'); panel.className = 'sw-phone-mirror';
    panel.setAttribute('aria-label','Phone screen mirror');
    panel.setAttribute('data-sw-mobile-private','');
    const make = (tag, cls, text, parent) => {
      const element = doc.createElement(tag); if (cls) element.className = cls;
      if (text) element.textContent = text; if (parent) parent.appendChild(element); return element;
    };
    const toolbar = make('div','sw-phone-toolbar','',panel);
    const select = make('button','','Select phone screen',toolbar); select.type = 'button';
    const stop = make('button','','Stop',toolbar); stop.type = 'button';
    const fit = make('button','','Fit',toolbar); fit.type = 'button';
    fit.setAttribute('aria-pressed','true'); fit.title = 'Fit the complete phone screen inside this area';
    const stage = make('div','sw-phone-stage','',panel);
    const video = make('video','sw-phone-video','',stage);
    video.autoplay = true; video.muted = true; video.playsInline = true; video.hidden = true;
    video.setAttribute('aria-label','Selected phone screen');
    const welcome = make('div','sw-phone-welcome','',stage);
    make('div','sw-phone-symbol','▯',welcome).setAttribute('aria-hidden','true');
    make('strong','','Mirror your phone here',welcome);
    make('p','','Open your phone’s screen mirror on this computer, then choose its window with Select phone screen.',welcome);
    const instructions = make('details','sw-phone-setup','',welcome);
    make('summary','','Connection instructions',instructions);
    make('p','','Use the phone mirroring software already installed on your computer. Keep its phone window open. SHOWAVE captures the window you choose and fits it to this editor area.',instructions);
    make('p','','A browser cannot directly pair with a phone or capture its screen over USB. Connect the phone with your mirroring software first.',instructions);
    const play = make('button','sw-phone-play','Show captured screen',stage); play.type = 'button'; play.hidden = true;
    const status = make('div','sw-phone-status','No phone screen selected.',panel);
    status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const remote = make('details','sw-phone-controller','',panel);
    make('summary','','Control SHOWAVE from your phone',remote);
    make('p','','The remote controller displays SHOWAVE’s desktop controls on your phone. Scan its QR code with both devices on the same network.',remote);
    const pair = make('button','','Open controller QR code',remote); pair.type = 'button';
    if (!mobileHost(view)) {
      pair.disabled = true;
      make('p','','Remote controller pairing is available from Preferences → Remote Controller in the main SHOWAVE window.',remote);
    }
    host.appendChild(panel);
    let disposed = false, lastStream = null, fill = false;
    const playback = () => {
      if (!video.srcObject) return;
      try {
        const promise = video.play();
        if (promise && promise.catch) promise.then(() => { if (!disposed) play.hidden = true; }).catch(() => { if (!disposed && video.srcObject) play.hidden = false; });
      } catch (_) { play.hidden = false; }
    };
    const unsubscribe = controller.subscribe(state => {
      if (disposed) return;
      select.disabled = state.pending; select.textContent = state.pending ? 'Selecting…' : state.live ? 'Change phone screen' : 'Select phone screen';
      stop.disabled = !state.live && !state.pending; fit.disabled = !state.live;
      video.hidden = !state.live; welcome.hidden = state.live;
      if (lastStream !== state.stream) {
        lastStream = state.stream; video.srcObject = state.stream; play.hidden = true;
        if (state.stream) playback();
      }
      panel.dataset.state = state.pending ? 'selecting' : state.live ? 'live' : state.error ? 'error' : 'disconnected';
      const dimensions = state.width && state.height ? ' · ' + state.width + ' × ' + state.height : '';
      status.textContent = state.error || (state.pending ? state.notice : state.live ? (state.muted ? 'Phone window paused' : 'Live') + ' · ' + state.label + dimensions : state.notice);
      status.title = status.textContent;
    });
    select.onclick = () => { controller.start(view.navigator && view.navigator.mediaDevices).catch(() => {}); };
    stop.onclick = () => controller.stop();
    fit.onclick = () => {
      fill = !fill; video.style.objectFit = fill ? 'cover' : 'contain'; fit.textContent = fill ? 'Fill' : 'Fit';
      fit.setAttribute('aria-pressed',String(!fill));
      fit.title = fill ? 'Fill this area, cropping the edges; click to fit the complete screen' : 'Fit the complete phone screen inside this area';
    };
    play.onclick = playback;
    pair.onclick = () => {
      const remoteHost = mobileHost(view);
      if (!remoteHost) return;
      Promise.resolve(remoteHost.openPairing()).catch(error => { status.textContent = error && error.message || 'Controller pairing could not open.'; });
    };
    const handle = Object.freeze({destroy() {
      if (disposed) return;
      disposed = true; unsubscribe(); video.srcObject = null; panel.remove(); mounts.delete(host);
      view.removeEventListener('pagehide',handle.destroy);
    }});
    view.addEventListener('pagehide',handle.destroy,{once:true});
    mounts.set(host, handle);
    return handle;
  }
  function destroy(host) {
    const handle = host && mounts.get(host); if (handle) handle.destroy();
  }
  return Object.freeze({build,destroy,createController,getController});
});
