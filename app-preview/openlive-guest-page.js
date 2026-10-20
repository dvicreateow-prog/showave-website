/* Guest-only surface. It never imports platform accounts, destinations or the
   egress API. Camera mirroring is local CSS; outgoing tracks are unmodified. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const invitation = new URLSearchParams(location.hash.slice(1));
  let client = null, media = null, snapshot = null, leaving = false;
  let lastCameraSignature = '', lastScreenSignature = '', publishing = Promise.resolve();
  let metadataRevision = 0, metadataRetryTimer = null, metadataRetryDelay = 2000;
  const ownedControls = ['mic','micSettings','camera','cameraSettings','screen','addSource','settings','self','privateChat','leave'];
  const show = id => { if (!$(id).open) $(id).showModal(); };
  const say = error => { $('connectionNote').textContent = error && error.message || String(error); };
  const run = fn => Promise.resolve().then(fn).catch(say);
  const terminalSnapshot = value => !!(value &&
    (value.connection === 'closed' || value.room && value.room.closed));
  const mediaState = state => ({camera:!!state.camera, mic:!!state.mic, screen:!!state.screen});
  function cancelMetadataRetry(reset = true) {
    if (metadataRetryTimer !== null) clearTimeout(metadataRetryTimer);
    metadataRetryTimer = null;
    if (reset) metadataRetryDelay = 2000;
  }
  function transientMetadataError(error) {
    if (!client || client.closed) return false;
    const status = Number(error && error.status);
    return !Number.isFinite(status) || status <= 0 || status === 408 ||
      status === 425 || status === 429 || status >= 500;
  }
  function metadataFailed(revision, error) {
    if (revision !== metadataRevision || leaving || !client) return;
    say(error);
    if (!transientMetadataError(error) || metadataRetryTimer !== null) return;
    const delay = metadataRetryDelay;
    metadataRetryDelay = Math.min(15000, metadataRetryDelay * 2);
    metadataRetryTimer = setTimeout(() => {
      metadataRetryTimer = null;
      publishing = publishing.then(async () => {
        if (revision !== metadataRevision || leaving || !client || client.closed || !media) return;
        try {
          await client.setMediaState(mediaState(media.state));
          if (revision === metadataRevision) cancelMetadataRetry();
        } catch (retryError) { metadataFailed(revision, retryError); }
      }).catch(say);
    }, delay);
  }
  function bindVideo(video, stream) {
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) video.play().catch(() => { if (video === $('programme')) $('enablePlayback').hidden = false; });
  }
  function paint(snapshotValue) {
    if (snapshotValue) snapshot = snapshotValue;
    if (!snapshot) return;
    const room = snapshot.room, self = snapshot.self;
    $('eventTitle').textContent = room.title; $('waitingTitle').textContent = room.title;
    $('hostName').textContent = room.hostName || 'Host';
    $('selfName').textContent = self.name;
    const label = leaving ? 'Left studio' : room.closed ? 'Studio closed' : !room.hostPresent
      ? 'Waiting for the host to join…' : self.onStage ? 'On Programme' : 'Backstage';
    $('selfState').textContent = label; $('stageStatus').textContent = label;
    $('waiting').hidden = !leaving && !room.closed && room.hostPresent && !!$('programme').srcObject;
    $('previewStatus').textContent = label + '. The host controls when the broadcast goes live.';
    const messages = snapshot.messages || [];
    const signature = messages.map(m => m.id).join('|');
    if ($('chatLog').dataset.signature !== signature) {
      $('chatLog').replaceChildren();
      for (const message of messages) {
        const p = document.createElement('p'), name = document.createElement('strong');
        name.textContent = message.name + ': '; p.append(name, document.createTextNode(message.text)); $('chatLog').append(p);
      }
      $('chatLog').dataset.signature = signature; $('chatLog').scrollTop = $('chatLog').scrollHeight;
    }
    /* createGuest may publish its first terminal snapshot before its Promise
       gives us the client. The submit path below owns cleanup in that case. */
    if (terminalSnapshot(snapshot) && !leaving && (client || media)) run(leave);
    else if (snapshot.connection === 'retrying') say('Connection interrupted. Reconnecting to this studio…');
  }
  function mediaChanged() {
    if (!media) return;
    const state = media.state;
    bindVideo($('selfVideo'), media.stream); bindVideo($('sourcePreview'), media.screen || media.stream);
    for (const [id,key,name] of [['camera','camera','Camera'],['mic','mic','Mic'],['screen','screen','Screen']]) {
      $(id).textContent = name + (state[key] ? ' on' : ' off');
      $(id).setAttribute('aria-pressed', String(!!state[key]));
      $(id).setAttribute('aria-label', (state[key] ? 'Disable ' : 'Enable ') + name.toLowerCase());
    }
    $('deviceError').textContent = state.error || '';
    if (!client || leaving) return;
    const cameraTracks = [...media.stream.getTracks()];
    const activeScreen = media.screen;
    const screenTracks = activeScreen ? [...activeScreen.getTracks()] : [];
    const cameraSignature = cameraTracks.map(t => t.id).join('|');
    const screenSignature = screenTracks.map(t => t.id).join('|');
    const changedCamera = cameraSignature !== lastCameraSignature;
    const changedScreen = screenSignature !== lastScreenSignature;
    lastCameraSignature = cameraSignature; lastScreenSignature = screenSignature;
    /* Publish immutable track-list snapshots. The participant controller keeps
       one combined MediaStream object and mutates its tracks on replacement;
       retaining that object in this queue could publish a later device under
       an earlier media-change event. Tracks themselves remain unmodified. */
    const cameraStream = cameraSignature ? new MediaStream([...cameraTracks]) : null;
    const screenStream = screenSignature ? new MediaStream([...screenTracks]) : null;
    const metadata = mediaState(state), revision = ++metadataRevision;
    cancelMetadataRetry(false);
    publishing = publishing.then(async () => {
      if (!client || leaving) return;
      const labels = [], operations = [];
      const add = (label, operation) => {
        labels.push(label); operations.push(Promise.resolve().then(operation));
      };
      if (changedCamera) add('camera', () => client.setMedia(cameraStream, 'camera'));
      if (changedScreen) add('screen', () => client.setMedia(screenStream, 'screen'));
      /* A newer media event makes this metadata snapshot stale. Its queued job
         owns the latest state write, while camera/screen replacements retain
         their event-time track lists and the transport's own retry lifecycle. */
      if (revision === metadataRevision) add('metadata', () => client.setMediaState(metadata));
      const results = await Promise.allSettled(operations);
      if (leaving || !client) return;
      results.forEach((result, index) => {
        const label = labels[index];
        if (label === 'metadata') {
          if (result.status === 'fulfilled') {
            if (revision === metadataRevision) cancelMetadataRetry();
          } else metadataFailed(revision, result.reason);
        } else if (result.status === 'rejected') say(result.reason);
      });
    }).catch(say);
  }
  async function refreshDevices() {
    try {
      const devices = await media.devices();
      for (const [id,key,label] of [['cameraDevice','cameras','camera'],['micDevice','microphones','microphone'],['speakerDevice','speakers','speakers']]) {
        const chosen = $(id).value; $(id).replaceChildren(new Option('Default ' + label, ''));
        (devices[key] || []).forEach((device,index) => $(id).add(new Option(device.label || label + ' ' + (index + 1),device.deviceId)));
        if ([...$(id).options].some(o => o.value === chosen)) $(id).value = chosen;
      }
      $('speakerDevice').disabled = typeof $('programme').setSinkId !== 'function';
    } catch (error) { $('deviceError').textContent = error.message; }
  }
  async function leave() {
    if (leaving) return; leaving = true;
    ++metadataRevision; cancelMetadataRetry();
    ownedControls.forEach(id => { $(id).disabled = true; });
    if (media) media.leave();
    bindVideo($('programme'), null); bindVideo($('selfVideo'), null);
    bindVideo($('sourcePreview'), null); $('waiting').hidden = false;
    $('stageStatus').textContent = 'You left the studio';
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    try {
      if (client) await client.leave();
      say('You left. Your devices are off. Reopen the invitation to join again.');
    } catch (error) {
      say('Your devices are off locally, but the server disconnect was not confirmed. ' +
        'The guest session expires after missed polls. ' + (error && error.message || error));
    } finally { client = null; }
  }
  for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
  $('joinForm').onsubmit = async event => {
    event.preventDefault(); $('join').disabled = true; $('joinStatus').textContent = 'Joining…';
    try {
      const joinedClient = await window.OpenLiveGuests.createGuest({
        roomId:invitation.get('room'), inviteToken:invitation.get('invite'), name:$('guestName').value.trim(),
        onSnapshot:paint, onError:say,
        onStream:event => { if (event.kind === 'programme') { bindVideo($('programme'), event.stream); paint(); } }
      });
      /* A terminal poll may notify onSnapshot before createGuest resolves. Do
         not construct fresh device ownership after that close/expiry signal. */
      if (leaving || joinedClient.closed || terminalSnapshot(joinedClient.snapshot)) {
        try { await joinedClient.leave(); } catch (_) {}
        throw new Error('This guest invitation has closed or expired.');
      }
      client = joinedClient;
      media = window.OpenLiveParticipantMedia.create({onChange:mediaChanged,onError:say});
      ownedControls.forEach(id => { $(id).disabled = false; });
      $('joinDialog').close(); paint(client.snapshot); mediaChanged();
      say('Joined backstage. Enable your devices when ready. Only the host can put you on Programme.');
    } catch (error) { $('joinStatus').textContent = error.message; }
    finally { $('join').disabled = false; }
  };
  $('camera').onclick = () => run(() => media.stream.getVideoTracks().some(t => t.readyState === 'live') ? media.toggleCamera() : media.camera());
  $('mic').onclick = () => run(() => media.stream.getAudioTracks().some(t => t.readyState === 'live') ? media.toggleMicrophone() : media.microphone());
  $('screen').onclick = () => run(() => media.screen ? media.stopScreen() : media.shareScreen());
  for (const id of ['settings','micSettings','cameraSettings']) $(id).onclick = () => { show('settingsDialog'); run(refreshDevices); };
  $('useCamera').onclick = () => run(async () => { await media.camera({deviceId:$('cameraDevice').value}); await refreshDevices(); });
  $('useMic').onclick = () => run(async () => { await media.microphone({deviceId:$('micDevice').value}); await refreshDevices(); });
  $('speakerDevice').onchange = () => run(() => $('programme').setSinkId($('speakerDevice').value));
  $('mirror').onchange = () => $('selfVideo').classList.toggle('mirror',$('mirror').checked);
  $('addSource').onclick = () => show('sourcesDialog');
  $('shareFromMenu').onclick = () => { $('sourcesDialog').close(); run(() => media.screen ? media.stopScreen() : media.shareScreen()); };
  $('self').onclick = () => show('previewDialog');
  $('privateChat').onclick = () => show('chatDialog');
  $('chatForm').onsubmit = async event => {
    event.preventDefault(); const input = $('chatText'), button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { await client.sendChat(input.value); input.value = ''; $('chatError').textContent = ''; }
    catch (error) { $('chatError').textContent = error.message; } finally { button.disabled = false; }
  };
  $('help').onclick = () => show('helpDialog'); $('leave').onclick = () => show('leaveDialog');
  $('confirmLeave').onclick = () => run(leave);
  $('enablePlayback').onclick = () => run(async () => { await $('programme').play(); $('enablePlayback').hidden = true; });
  window.addEventListener('pagehide', () => {
    leaving = true; ++metadataRevision; cancelMetadataRetry();
    if (media) media.leave(); if (client) client.leave().catch(() => {});
  });
  if (!invitation.get('room') || !invitation.get('invite')) say('Open a guest invitation from SHOWAVE Broadcast → Guests. This page cannot join without an invitation.');
  else show('joinDialog');
})();
