/* Host UI and Programme bridge. Backstage transport != Programme membership.
   The host owns placement; private chat and invitation credentials never enter
   a compositor source. Every guest return excludes that guest's own audio. */
window.OpenLiveGuestHost = (() => {
  'use strict';
  let nextDialogId = 0;
  function create(options) {
    const ST = options.studio, root = options.container;
    let client = null, snapshot = null, busy = false, timer = null, closing = false;
    let returnVideo = null, audioContext = null;
    let lifecycle = 0, closePromise = null, pendingLeave = null;
    const inputs = new Map(), returns = new Map(), cards = new Map(), stageRequests = new Map();
    const element = (tag,text,parent,cls) => {
      const node = document.createElement(tag); if (text) node.textContent = text;
      if (cls) node.className = cls; if (parent) parent.append(node); return node;
    };
    const button = (text,parent,action) => {
      const node = element('button',text,parent,'tb-btn small'); node.type = 'button';
      node.onclick = () => run(action); return node;
    };
    const status = element('p','Open a local guest room to invite a participant.',root,'bc-note');
    const actions = element('div','',root,'guest-host-actions');
    const startButton = button('Open guest room',actions,start);
    const manageButton = button('Guests & private chat',actions,() => dialog.showModal()); manageButton.hidden = true;
    const dialog = element('dialog','',document.body,'guest-host-dialog');
    const heading = element('h2','Guests & backstage',dialog);
    const description = element('p','Local session only: this invitation works on this computer. Remote guests need an authenticated HTTPS service with network media traversal.','', '');
    dialog.append(description);
    const dialogId = 'guest-host-' + (++nextDialogId);
    heading.id = dialogId + '-title'; description.id = dialogId + '-description';
    dialog.setAttribute('aria-labelledby',heading.id); dialog.setAttribute('aria-describedby',description.id);
    const inviteRow = element('div','',dialog,'guest-host-actions');
    const openGuest = element('a','Open guest view',inviteRow,'tb-btn small'); openGuest.target = '_blank'; openGuest.rel = 'noopener noreferrer';
    const copyButton = button('Copy local invitation',inviteRow,async () => {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw Error('Clipboard is unavailable. Use Open guest view on this computer.');
      await navigator.clipboard.writeText(openGuest.href); status.textContent = 'Local guest invitation copied.';
    });
    const guestList = element('div','',dialog,'guest-host-list');
    const empty = element('p','No guests have joined.',guestList);
    const chatHeading = element('h3','Private Chat',dialog);
    element('p','Only the host and guests see these messages. They are never posted to platforms or drawn onto Programme.',dialog);
    const chatLog = element('div','',dialog,'guest-host-chat'); chatLog.setAttribute('role','log'); chatLog.setAttribute('aria-live','polite');
    const chatForm = element('form','',dialog,'guest-host-actions');
    const chatInput = element('input','',chatForm); chatInput.maxLength = 2000; chatInput.required = true; chatInput.placeholder = 'Message the studio'; chatInput.setAttribute('aria-label','Private message');
    const send = element('button','Send',chatForm,'tb-btn small'); send.type = 'submit';
    const result = element('p','',dialog,'bc-note'); result.setAttribute('role','status');
    const foot = element('div','',dialog,'guest-host-actions');
    button('Close panel',foot,() => dialog.close());
    const endRoom = button('Close guest room…',foot,() => confirm.showModal());
    const confirm = element('dialog','',document.body,'guest-host-dialog');
    const confirmHeading = element('h2','Close guest room?',confirm);
    const confirmDescription = element('p','This removes guest sources from all scenes and disconnects their returns. Your destination streams and recordings continue with the remaining Programme sources.',confirm);
    confirmHeading.id = dialogId + '-close-title'; confirmDescription.id = dialogId + '-close-description';
    confirm.setAttribute('aria-labelledby',confirmHeading.id); confirm.setAttribute('aria-describedby',confirmDescription.id);
    const confirmActions = element('div','',confirm,'guest-host-actions');
    button('Cancel',confirmActions,() => confirm.close()); button('Close guest room',confirmActions,async () => { confirm.close(); await close(); });
    async function run(action) {
      try { return await action(); } catch (error) { result.textContent = error.message || String(error); options.note(result.textContent); }
    }
    chatForm.onsubmit = event => {
      event.preventDefault(); send.disabled = true;
      run(async () => { await client.sendChat(chatInput.value); chatInput.value = ''; result.textContent = ''; })
        .finally(() => { send.disabled = false; });
    };
    function avatar(name) {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#18243b'; ctx.fillRect(0,0,960,540);
      ctx.fillStyle = '#e1ecff'; ctx.textAlign = 'center'; ctx.font = '600 90px system-ui';
      ctx.fillText(String(name || 'Guest').slice(0,2).toUpperCase(),480,270);
      ctx.font = '28px system-ui'; ctx.fillText(String(name || 'Guest').slice(0,45),480,345); return canvas;
    }
    function removeInput(key) {
      const record = inputs.get(key); if (!record) return;
      try { ST.removeSource(record.source.id); }
      finally {
        stopTracks(record.source.stream); record.video.srcObject = null; inputs.delete(key);
        ST.syncMix(); options.changed();
      }
    }
    function stopTracks(stream) {
      if (stream) stream.getTracks().forEach(track => { try { if (track.readyState !== 'ended') track.stop(); } catch (_) {} });
    }
    function streamChanged(event) {
      if (closing || !['camera','screen'].includes(event.kind)) return;
      const key = event.participantId + ':' + event.kind;
      if (!event.stream) { removeInput(key); refresh(); return; }
      const old = inputs.get(key), bindings = [];
      if (old) ST.scenes().forEach(scene => scene.slots.forEach((slot,index) => {
        if (slot.sourceId === old.source.id) bindings.push([scene.id,index]);
      }));
      const participant = snapshot && snapshot.participants.find(p => p.id === event.participantId);
      const name = participant && participant.name || 'Guest';
      const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
      video.srcObject = event.stream; video.play().catch(() => {});
      const cloned = []; let owned, placeholder, source;
      try {
        event.stream.getTracks().forEach(track => cloned.push(track.clone()));
        owned = new MediaStream(cloned); placeholder = avatar(name);
        source = ST.addSource({kind:'guest',label:name + (event.kind === 'screen' ? ' · screen' : ''),
          el:event.kind === 'camera' && (!participant || !participant.camera) ? placeholder : video,
          stream:owned,mirror:false,_guestId:event.participantId,_guestKind:event.kind});
      } catch (error) {
        cloned.forEach(track => { try { track.stop(); } catch (_) {} }); video.srcObject = null; throw error;
      }
      if (old) removeInput(key);
      inputs.set(key,{source,video,avatar:placeholder,stream:event.stream,participantId:event.participantId,kind:event.kind});
      bindings.forEach(([scene,index]) => ST.bind(scene,index,source.id));
      ST.syncMix(); options.changed(); refresh();
    }
    function place(key) {
      const record = inputs.get(key); if (!record) throw Error('This source has disconnected.');
      const scene = options.scene ? options.scene() : ST.active();
      if (!scene) throw Error('Select a scene first.');
      if (scene.slots.some(slot => slot.sourceId === record.source.id)) return;
      const index = scene.slots.findIndex(slot => !slot.sourceId);
      if (index < 0) throw Error('This scene has no empty slot. Select a larger layout or clear a slot first.');
      ST.bind(scene.id,index,record.source.id); ST.syncMix(); options.changed(); refresh();
    }
    function backstage(id) {
      ST.scenes().forEach(scene => scene.slots.forEach((slot,index) => {
        const source = ST.sources.get(slot.sourceId);
        if (source && source._guestId === id) ST.bind(scene.id,index,null);
      }));
      ST.syncMix(); options.changed(); refresh();
    }
    function updateSnapshot(value) {
      snapshot = value;
      if (client && (value.connection === 'closed' || value.room && value.room.closed)) { run(close); return; }
      if (client) refresh();
    }
    function makeReturn(id) {
      if (!returnVideo) returnVideo = ST.canvas('16x9').captureStream(30);
      const video = []; let destination, stream;
      try {
        returnVideo.getVideoTracks().forEach(track => video.push(track.clone()));
        destination = audioContext ? audioContext.createMediaStreamDestination() : null;
        stream = new MediaStream([...video,...(destination ? destination.stream.getAudioTracks() : [])]);
      } catch (error) {
        video.forEach(track => { try { track.stop(); } catch (_) {} });
        if (destination) { stopTracks(destination.stream); try { destination.disconnect(); } catch (_) {} }
        throw error;
      }
      const record = {stream,destination,nodes:new Map()}; returns.set(id,record);
      Promise.resolve().then(() => client && !closing && client.setReturnMedia(id,stream))
        .catch(error => { if (returns.get(id) === record) result.textContent = 'Guest return failed: ' + error.message; });
      return record;
    }
    function stopReturn(id) {
      const record = returns.get(id); if (!record) return;
      record.nodes.forEach(value => { try { value.node.disconnect(); } catch (_) {} try { value.gain.disconnect(); } catch (_) {} });
      if (record.destination) try { record.destination.disconnect(); } catch (_) {}
      stopTracks(record.stream); returns.delete(id);
      if (client && !closing) client.setReturnMedia(id,null).catch(() => {});
    }
    function syncReturns(participants) {
      const ids = new Set(participants.filter(p => p.present !== false).map(p => p.id));
      [...returns.keys()].forEach(id => { if (!ids.has(id)) stopReturn(id); });
      const scene = ST.active();
      for (const id of ids) {
        const record = returns.get(id) || makeReturn(id);
        if (!record.destination) continue;
        const wanted = new Set();
        for (const slot of scene ? scene.slots : []) {
          const source = ST.sources.get(slot.sourceId);
          if (!source || source._guestId === id || !source.stream || !source.audio || !source.audio.included || !source.stream.getAudioTracks().length) continue;
          wanted.add(source.id); let node = record.nodes.get(source.id);
          if (!node) {
            try {
              const gain = audioContext.createGain(), input = audioContext.createMediaStreamSource(source.stream);
              input.connect(gain); gain.connect(record.destination); node = {node:input,gain}; record.nodes.set(source.id,node);
            } catch (_) { continue; }
          }
          node.gain.gain.value = slot.mute ? 0 : Math.max(0,Math.min(2,Number.isFinite(slot.gain) ? slot.gain : 1));
        }
        for (const [sourceId,node] of record.nodes) if (!wanted.has(sourceId)) {
          node.node.disconnect(); node.gain.disconnect(); record.nodes.delete(sourceId);
        }
      }
    }
    function refresh() {
      if (!client || !snapshot || closing) return;
      const participants = (snapshot.participants || []).filter(p => p.role !== 'host' && p.id !== 'host');
      const ids = new Set(participants.map(p => p.id));
      for (const [key,record] of inputs) if (!ids.has(record.participantId)) removeInput(key);
      for (const [id,card] of cards) if (!ids.has(id)) { card.root.remove(); cards.delete(id); }
      empty.hidden = participants.length > 0;
      status.textContent = participants.length + ' guest' + (participants.length === 1 ? '' : 's') + ' · local room';
      for (const participant of participants) {
        let card = cards.get(participant.id);
        if (!card) {
          const row = element('section','',guestList,'guest-host-person');
          const name = element('strong','',row), state = element('p','',row);
          const previews = element('div','',row,'guest-host-previews');
          const camera = element('video','',previews), screen = element('video','',previews);
          for (const video of [camera,screen]) { video.muted = true; video.autoplay = true; video.playsInline = true; }
          const actions = element('div','',row,'guest-host-actions');
          const addCamera = button('Add camera / audio to scene',actions,() => place(participant.id + ':camera'));
          const addScreen = button('Add screen to scene',actions,() => place(participant.id + ':screen'));
          button('Backstage',actions,() => backstage(participant.id));
          card = {root:row,name,state,camera,screen,addCamera,addScreen}; cards.set(participant.id,card);
        }
        card.name.textContent = participant.name;
        const active = ST.active();
        const onStage = !!(active && active.slots.some(slot => {
          const source = ST.sources.get(slot.sourceId);
          // The studio mixer includes hidden slots: hidden video can still be
          // audible on Programme. Preview membership alone is never on-stage.
          const audible = source && source.audio && source.audio.included && source.stream && source.stream.getAudioTracks().some(track => track.readyState !== 'ended') &&
            !slot.mute && (!Number.isFinite(slot.gain) || slot.gain > 0);
          return source && source._guestId === participant.id && (!slot.hidden || audible);
        }));
        card.state.textContent = participant.present === false ? 'Disconnected' : onStage ? 'On Programme' : 'Backstage';
        for (const kind of ['camera','screen']) {
          const record = inputs.get(participant.id + ':' + kind), video = card[kind];
          const input = record ? record.stream : null;
          if (video.srcObject !== input) { video.srcObject = input; if (input) video.play().catch(() => {}); }
          video.hidden = !input;
          card[kind === 'camera' ? 'addCamera' : 'addScreen'].disabled = !record;
          if (record && kind === 'camera') record.source.el = participant.camera ? record.video : record.avatar;
        }
        if (onStage !== !!participant.onStage && !stageRequests.has(participant.id)) {
          const owner = client;
          const request = Promise.resolve().then(() => owner === client && !closing && owner.setStage(participant.id,onStage))
            .catch(error => { if (owner === client) result.textContent = error.message; })
            .finally(() => { if (stageRequests.get(participant.id) === request) stageRequests.delete(participant.id); });
          stageRequests.set(participant.id,request);
        }
      }
      const messages = snapshot.messages || [], signature = messages.map(m => m.id).join('|');
      if (chatLog.dataset.signature !== signature) {
        chatLog.replaceChildren(); messages.forEach(message => element('p',message.name + ': ' + message.text,chatLog));
        chatLog.dataset.signature = signature; chatLog.scrollTop = chatLog.scrollHeight;
      }
      if (snapshot.connection === 'retrying') result.textContent = 'Guest service connection interrupted; retrying…';
      try { syncReturns(participants); } catch (error) { result.textContent = 'Guest programme return is unavailable: ' + error.message; }
    }
    async function start() {
      if (busy || client || closing) return;
      if (pendingLeave) { await close(); return; }
      busy = true; startButton.disabled = true; const attempt = ++lifecycle;
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (Context) { audioContext = new Context(); await audioContext.resume(); }
        if (attempt !== lifecycle) return;
        const created = await window.OpenLiveGuests.createHost({title:options.title(),hostName:'SHOWAVE Host',
          onSnapshot:value => { if (attempt === lifecycle) updateSnapshot(value); },
          onStream:value => { if (attempt === lifecycle) streamChanged(value); },
          onError:error => { if (attempt === lifecycle) result.textContent = error.message; }});
        if (attempt !== lifecycle) {
          if (closePromise) await closePromise.catch(() => {});
          pendingLeave = created; await close(); return;
        }
        client = created;
        snapshot = client.snapshot;
        if (!snapshot || snapshot.connection === 'closed' || snapshot.room.closed) throw Error('The guest room closed before it was ready.');
        const invite = new URL('guest.html',location.href);
        invite.hash = new URLSearchParams({room:client.roomId,invite:client.inviteToken}).toString();
        openGuest.href = invite.href;
        startButton.hidden = true; manageButton.hidden = false; timer = setInterval(refresh,500);
        dialog.showModal(); refresh();
      } catch (error) {
        if (attempt === lifecycle) await close().catch(cleanupError => options.note(cleanupError.message));
        throw error;
      }
      finally { busy = false; startButton.disabled = false; }
    }
    function close() {
      if (closePromise) return closePromise;
      closing = true; ++lifecycle; clearInterval(timer); timer = null;
      const current = client || pendingLeave, context = audioContext;
      client = null; snapshot = null; audioContext = null;
      closePromise = Promise.resolve().then(async () => {
        const errors = [];
        const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
        for (const key of [...inputs.keys()]) await attempt(() => removeInput(key));
        for (const id of [...returns.keys()]) await attempt(() => stopReturn(id));
        stopTracks(returnVideo); returnVideo = null;
        if (context) await attempt(() => context.close());
        if (current) await attempt(async () => {
          pendingLeave = current; await current.leave(); pendingLeave = null;
        });
        if (errors.length) throw Error('Guest room cleanup needs attention: ' + errors.map(error => error.message || String(error)).join('; '));
      }).finally(() => {
        cards.forEach(card => { card.camera.srcObject = null; card.screen.srcObject = null; card.root.remove(); });
        cards.clear(); stageRequests.clear(); empty.hidden = false;
        chatLog.replaceChildren(); chatLog.dataset.signature = ''; chatInput.value = '';
        openGuest.removeAttribute('href'); confirm.close(); dialog.close(); startButton.hidden = false; manageButton.hidden = true;
        startButton.textContent = pendingLeave ? 'Retry closing guest room' : 'Open guest room';
        status.textContent = pendingLeave ? 'Guest media disconnected locally. Room closure is unconfirmed; retry closing.' :
          'Guest room closed. Destination streams and recordings were not stopped.';
        closing = false; closePromise = null;
      });
      return closePromise;
    }
    return Object.freeze({close,get active(){return !!client;}});
  }
  return Object.freeze({create});
})();
