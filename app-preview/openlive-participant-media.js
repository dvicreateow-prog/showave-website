/* ===========================================================================
   openlive-participant-media.js — local participant camera, microphone and
   screen-share ownership for SHOWAVE Studio.

   Camera and microphone are acquired independently and combined in one stable
   MediaStream. Display capture remains separate. This module never requests a
   device until its corresponding public method is called, never persists a
   device id, and never transforms transmitted pixels (a mirrored local preview
   belongs in CSS, not in the outgoing track).

   Classic script. Publishes window.OpenLiveParticipantMedia. No dependencies.
   =========================================================================== */
window.OpenLiveParticipantMedia = (() => {
  'use strict';

  const version = 1;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

  function namedError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function create(options) {
    const config = options && typeof options === 'object' ? options : {};
    const onChange = typeof config.onChange === 'function' ? config.onChange : () => {};
    const onError = typeof config.onError === 'function' ? config.onError : () => {};
    const mediaDevices = config.mediaDevices ||
      (window.navigator && window.navigator.mediaDevices) || null;
    if (typeof MediaStream !== 'function')
      throw namedError('NotSupportedError', 'This browser does not provide MediaStream.');

    /* This object is never replaced. Transport code can retain it while camera
       and microphone tracks are refreshed underneath. */
    const combined = new MediaStream();
    const slots = {
      camera:{ track:null, capture:null },
      mic:{ track:null, capture:null }
    };
    const generation = { camera:0, mic:0, screen:0 };
    const pending = { camera:false, mic:false, screen:false };
    const preferences = {
      cameraDeviceId:'', microphoneDeviceId:'', echoCancellation:undefined
    };
    let display = null;
    let displayRequest = null;
    let errorText = null;
    let closed = false;

    const allTracks = stream => {
      try { return stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []; }
      catch (_) { return []; }
    };
    const tracksOf = (stream, kind) => allTracks(stream).filter(track => track && track.kind === kind);
    const live = track => !!(track && track.readyState !== 'ended');
    const liveEnabled = track => !!(live(track) && track.enabled !== false);
    const displayLive = stream => tracksOf(stream, 'video').some(live);

    function state() {
      return {
        camera:liveEnabled(slots.camera.track),
        mic:liveEnabled(slots.mic.track),
        screen:displayLive(display),
        pending:pending.camera || pending.mic || pending.screen,
        error:errorText,
        closed
      };
    }

    function emit(reason) {
      try { onChange(state(), reason || 'change'); } catch (_) {}
    }

    function report(kind, error) {
      const failure = error && typeof error === 'object' && typeof error.message === 'string'
        ? error : new Error(String(error || 'Media capture failed.'));
      errorText = failure.message || String(failure);
      try { onError(failure, kind); } catch (_) {}
      emit(kind + '-error');
      return failure;
    }

    function requireOpen() {
      if (closed) throw namedError('InvalidStateError', 'Participant media has already been closed.');
    }

    function requireMethod(method, message) {
      requireOpen();
      if (!mediaDevices || typeof mediaDevices[method] !== 'function')
        throw namedError('NotSupportedError', message);
      return mediaDevices[method].bind(mediaDevices);
    }

    function stopTrack(track) {
      try { if (track && typeof track.stop === 'function') track.stop(); } catch (_) {}
    }

    function stopStream(stream, except) {
      allTracks(stream).forEach(track => { if (track !== except) stopTrack(track); });
    }

    function removeCombined(track) {
      if (!track) return;
      try { combined.removeTrack(track); } catch (_) {}
    }

    function listen(track, type, listener) {
      if (!track) return;
      if (typeof track.addEventListener === 'function') {
        try { track.addEventListener(type, listener); return; } catch (_) {}
      }
      if (type === 'ended') {
        try { track.onended = listener; } catch (_) {}
      }
    }

    function watchInput(kind, track, capture) {
      listen(track, 'ended', () => {
        const slot = slots[kind];
        if (slot.track !== track) return;
        slot.track = null; slot.capture = null;
        removeCombined(track);
        stopStream(capture, track);
        emit(kind + '-ended');
      });
      const changed = () => {
        if (slots[kind].track === track) emit(kind + '-track-state');
      };
      listen(track, 'mute', changed);
      listen(track, 'unmute', changed);
    }

    function requestedDevice(input, remembered) {
      if (own(input, 'deviceId')) return String(input.deviceId == null ? '' : input.deviceId);
      return remembered;
    }

    function userConstraints(kind, input) {
      if (kind === 'camera') {
        const deviceId = requestedDevice(input, preferences.cameraDeviceId);
        return {
          video:deviceId ? { deviceId:{ exact:deviceId } } : true,
          audio:false
        };
      }
      const deviceId = requestedDevice(input, preferences.microphoneDeviceId);
      const audio = {};
      if (deviceId) audio.deviceId = { exact:deviceId };
      const echo = own(input, 'echoCancellation')
        ? input.echoCancellation : preferences.echoCancellation;
      if (typeof echo === 'boolean') audio.echoCancellation = echo;
      return { video:false, audio:Object.keys(audio).length ? audio : true };
    }

    async function acquireInput(kind, input) {
      let getUserMedia;
      try { getUserMedia = requireMethod('getUserMedia', 'This browser cannot capture a camera or microphone.'); }
      catch (error) { throw report(kind, error); }
      const request = input && typeof input === 'object' ? input : {};
      const token = ++generation[kind];
      pending[kind] = true;
      errorText = null;
      emit(kind + '-pending');

      let capture;
      try {
        capture = await getUserMedia(userConstraints(kind, request));
      } catch (error) {
        if (closed || token !== generation[kind]) return null;
        pending[kind] = false;
        throw report(kind, error);
      }

      if (closed || token !== generation[kind]) {
        stopStream(capture);
        return null;
      }

      const trackKind = kind === 'camera' ? 'video' : 'audio';
      const track = tracksOf(capture, trackKind).find(live);
      if (!track) {
        stopStream(capture);
        pending[kind] = false;
        throw report(kind, namedError('NotFoundError',
          kind === 'camera' ? 'The selected camera returned no live video track.' :
            'The selected microphone returned no live audio track.'));
      }
      /* A video-only or audio-only request owns exactly one useful track. Stop
         anything unexpected instead of silently transmitting it. */
      stopStream(capture, track);

      try { combined.addTrack(track); }
      catch (error) {
        stopTrack(track);
        pending[kind] = false;
        throw report(kind, error);
      }

      const previous = slots[kind];
      slots[kind] = { track, capture };
      watchInput(kind, track, capture);
      if (previous.track) removeCombined(previous.track);
      if (previous.capture) stopStream(previous.capture);

      if (kind === 'camera') {
        if (own(request, 'deviceId'))
          preferences.cameraDeviceId = String(request.deviceId == null ? '' : request.deviceId);
      } else {
        if (own(request, 'deviceId'))
          preferences.microphoneDeviceId = String(request.deviceId == null ? '' : request.deviceId);
        if (typeof request.echoCancellation === 'boolean')
          preferences.echoCancellation = request.echoCancellation;
      }
      pending[kind] = false;
      errorText = null;
      emit(kind + '-ready');
      return combined;
    }

    function camera(input) { return acquireInput('camera', input); }
    function microphone(input) { return acquireInput('mic', input); }

    function watchDisplay(stream) {
      allTracks(stream).forEach(track => {
        listen(track, 'ended', () => {
          if (display !== stream) return;
          if (track.kind === 'video' && !tracksOf(stream, 'video').some(live)) {
            display = null;
            stopStream(stream, track);
            emit('screen-ended');
          } else emit('screen-track-ended');
        });
        const changed = () => { if (display === stream) emit('screen-track-state'); };
        listen(track, 'mute', changed);
        listen(track, 'unmute', changed);
      });
    }

    function shareScreen() {
      try { requireOpen(); }
      catch (error) { return Promise.reject(report('screen', error)); }
      if (displayLive(display)) return Promise.resolve(display);
      if (displayRequest) return displayRequest.promise;

      let getDisplayMedia;
      try { getDisplayMedia = requireMethod('getDisplayMedia', 'This browser cannot share a screen.'); }
      catch (error) { return Promise.reject(report('screen', error)); }
      const token = ++generation.screen;
      pending.screen = true;
      errorText = null;
      emit('screen-pending');

      const promise = (async () => {
        let capture;
        try {
          capture = await getDisplayMedia({ video:true, audio:true });
        } catch (error) {
          if (closed || token !== generation.screen) return null;
          pending.screen = false;
          throw report('screen', error);
        }
        if (closed || token !== generation.screen) {
          stopStream(capture);
          return null;
        }
        if (!tracksOf(capture, 'video').some(live)) {
          stopStream(capture);
          pending.screen = false;
          throw report('screen', namedError('NotFoundError',
            'Screen sharing returned no live video track.'));
        }
        display = capture;
        watchDisplay(capture);
        pending.screen = false;
        errorText = null;
        emit('screen-ready');
        return display;
      })();
      displayRequest = { token, promise };
      promise.finally(() => {
        if (displayRequest && displayRequest.token === token) displayRequest = null;
      }).catch(() => {});
      return promise;
    }

    function toggle(kind, value) {
      if (closed) return false;
      const track = slots[kind].track;
      if (!live(track)) return false;
      const enabled = typeof value === 'boolean' ? value : track.enabled === false;
      try { track.enabled = enabled; }
      catch (error) { report(kind, error); return false; }
      emit(kind + (enabled ? '-enabled' : '-disabled'));
      return track.enabled !== false;
    }

    function toggleCamera(value) { return toggle('camera', value); }
    function toggleMicrophone(value) { return toggle('mic', value); }

    function stopScreen() {
      if (closed) return false;
      const hadPending = pending.screen;
      const current = display;
      ++generation.screen;
      pending.screen = false;
      displayRequest = null;
      display = null;
      if (current) stopStream(current);
      if (current || hadPending) emit('screen-stopped');
      return !!(current || hadPending);
    }

    async function devices() {
      let enumerateDevices;
      try { enumerateDevices = requireMethod('enumerateDevices', 'This browser cannot list media devices.'); }
      catch (error) { throw report('devices', error); }
      try {
        const rows = await enumerateDevices();
        const list = Array.isArray(rows) ? rows : Array.from(rows || []);
        return {
          cameras:list.filter(device => device && device.kind === 'videoinput'),
          microphones:list.filter(device => device && device.kind === 'audioinput'),
          speakers:list.filter(device => device && device.kind === 'audiooutput')
        };
      } catch (error) { throw report('devices', error); }
    }

    function leave() {
      if (closed) return false;
      closed = true;
      generation.camera++; generation.mic++; generation.screen++;
      pending.camera = pending.mic = pending.screen = false;
      displayRequest = null;
      const cameraSlot = slots.camera, micSlot = slots.mic, screenStream = display;
      slots.camera = { track:null, capture:null };
      slots.mic = { track:null, capture:null };
      display = null;
      removeCombined(cameraSlot.track); removeCombined(micSlot.track);
      stopStream(cameraSlot.capture); stopStream(micSlot.capture); stopStream(screenStream);
      if (mediaDevices && typeof mediaDevices.removeEventListener === 'function') {
        try { mediaDevices.removeEventListener('devicechange', deviceChanged); } catch (_) {}
      }
      errorText = null;
      emit('leave');
      return true;
    }

    function deviceChanged() {
      if (!closed) emit('devicechange');
    }
    if (mediaDevices && typeof mediaDevices.addEventListener === 'function') {
      try { mediaDevices.addEventListener('devicechange', deviceChanged); } catch (_) {}
    }

    const controller = Object.freeze({
      devices, camera, microphone, shareScreen,
      toggleCamera, toggleMicrophone, stopScreen, leave,
      get stream() { return combined; },
      get screen() { return displayLive(display) ? display : null; },
      get state() { return state(); }
    });
    emit('initial');
    return controller;
  }

  return Object.freeze({ version, create });
})();
