/* SHOWAVE guest transport. Signaling stays on this app's origin; media uses
   separate, sender-offered WebRTC connections for camera, screen and programme.
   No device prompts, autoplay, third-party ICE servers or caller-track stops.
   Local/LAN proof only: Internet guests require deployed HTTPS + TURN support.

   Receiver grouping / negotiation follow the WebRTC addTrack,
   setRemoteDescription and addIceCandidate contracts documented by MDN.
   Generation numbers are our signaling protocol, not a WebRTC feature. */
window.OpenLiveGuests = (() => {
  'use strict';
  const KINDS = new Set(['camera', 'screen', 'programme']);
  const TYPES = new Set(['offer', 'answer', 'candidate', 'remove']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Number(value))) : fallback;

  async function create(options, host) {
    options = options || {};
    if (typeof RTCPeerConnection !== 'function' || typeof MediaStream !== 'function')
      throw new Error('This browser does not support WebRTC guest media.');
    let roomId = '', participantId = '', token = '', inviteToken = '';
    let closed = false, leaveConfirmed = false, cursor = 0, timer = null, polling = null, leaving = null;
    let snapshot = null, generation = 0, lastPollError = null;
    const slots = new Map(), desired = new Map(), returns = new Map(), requests = new Set();
    const mediaQueues = new Map();
    let knownPeers = new Set();
    const pollDelay = bounded(options.pollIntervalMs, 750, 250, 5000);
    const timeout = bounded(options.requestTimeoutMs, 8000, 100, 15000);
    const negotiationTimeout = bounded(options.negotiationTimeoutMs, 20000, 500, 60000);
    const safeError = error => {
      let message = error && error.message || String(error);
      [token, inviteToken, options.inviteToken].filter(Boolean).forEach(secret => {
        message = message.split(String(secret)).join('[redacted]');
      });
      const result = new Error(message.slice(0, 600));
      if (error && error.status) result.status = error.status;
      return result;
    };
    const report = error => { const safe = safeError(error);
      try { if (options.onError) options.onError(safe); } catch (_) {} return safe; };
    const emit = (name, payload) => {
      try { if (typeof options[name] === 'function') options[name](payload); }
      catch (error) { if (name !== 'onError') report(error); }
    };
    const notify = () => { if (snapshot) emit('onSnapshot', clone(snapshot)); };

    async function request(action, body, allowClosed) {
      if (closed && !allowClosed) throw new Error('This guest session has closed. Rejoin the studio.');
      const controller = new AbortController(); requests.add(controller);
      let timeoutId;
      const limit = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => { controller.abort(); reject(new Error('Guest ' + action + ' request timed out.')); }, timeout);
      });
      const headers = { 'Content-Type':'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      try {
        const response = await Promise.race([fetch('/api/guests/' + action, {
          method:'POST', headers, body:JSON.stringify(body), signal:controller.signal,
          cache:'no-store', credentials:'same-origin'
        }), limit]);
        const data = await Promise.race([response.json(), limit]);
        if (!response.ok) {
          const error = new Error(data && data.error || 'Guest ' + action + ' failed (HTTP ' + response.status + ').');
          error.status = response.status; throw error;
        }
        return data;
      } catch (error) { throw safeError(error); }
      finally { clearTimeout(timeoutId); requests.delete(controller); }
    }
    const post = (action, body) => request(action, Object.assign({ roomId }, body || {}));
    const keyOf = (id, kind) => id + ':' + kind;
    const sendsKind = kind => host ? kind === 'programme' : kind === 'camera' || kind === 'screen';
    const mediaFor = (id, kind) => host && kind === 'programme' && returns.has(id)
      ? returns.get(id) : desired.get(kind) || null;
    function slotFor(id, kind) {
      const key = keyOf(id, kind);
      if (!slots.has(key)) slots.set(key, { id, kind, current:null, pending:null,
        highWater:0, removed:0, candidates:new Map(), operation:Promise.resolve(), retry:null });
      return slots.get(key);
    }
    const hasLiveMedia = stream => stream && stream.getTracks().some(track =>
      track && track.readyState !== 'ended' && ['audio','video'].includes(track.kind));
    function retryState(slot, stream) {
      if (!slot.retry || slot.retry.source !== stream)
        slot.retry = { source:stream, failures:0, nextAt:0, inFlight:false };
      return slot.retry;
    }
    function deferRetry(slot, stream, rec) {
      if (rec && rec.retryScheduled) return;
      if (closed || slots.get(keyOf(slot.id,slot.kind)) !== slot || !knownPeers.has(slot.id) ||
          mediaFor(slot.id,slot.kind) !== stream || !hasLiveMedia(stream)) return;
      if (rec) rec.retryScheduled = true;
      const retry = retryState(slot,stream);
      retry.failures = Math.min(4,retry.failures + 1);
      retry.nextAt = Date.now() + Math.min(15000,2000 * 2 ** (retry.failures - 1));
    }
    function matchingSender(slot, stream) {
      return [slot.current,slot.pending].some(rec => rec && rec.sender && !rec.disposed && rec.source === stream);
    }
    function retryMissingMedia() {
      // No separate retry timer: a healthy poll establishes current membership
      // before any new offer. Per-peer backoff is 2/4/8/15 seconds after failure.
      // A lost answer/candidate eventually expires its pending negotiation;
      // only the original sender reoffers with a fresh generation.
      if (closed) return;
      for (const id of knownPeers) for (const kind of host ? ['programme'] : ['camera','screen']) {
        const stream = mediaFor(id,kind), key = keyOf(id,kind);
        if (!hasLiveMedia(stream)) { const slot = slots.get(key); if (slot) slot.retry = null; continue; }
        const slot = slotFor(id,kind);
        if (matchingSender(slot,stream)) continue;
        const retry = retryState(slot,stream);
        if (retry.inFlight || retry.nextAt > Date.now()) continue;
        retry.inFlight = true;
        offerMedia(id,kind,stream).catch(error => { if (!closed) report(error); })
          .finally(() => { retry.inFlight = false; });
      }
    }
    function peerState(rec, state) { emit('onPeerState', { participantId:rec.id, kind:rec.kind, state }); }
    function disposeRecord(rec) {
      if (!rec || rec.disposed) return;
      rec.disposed = true; clearTimeout(rec.deadline);
      rec.cancel();
      rec.pc.onicecandidate = null; rec.pc.ontrack = null; rec.pc.onconnectionstatechange = null;
      try { rec.pc.close(); } catch (_) {}
      // Only receivers belong to the transport. Never stop a camera, screen or
      // programme track supplied by the caller, even while replacing its PC.
      const tracks = new Set(rec.stream ? rec.stream.getTracks() : []);
      try { rec.pc.getReceivers().forEach(receiver => { if (receiver.track) tracks.add(receiver.track); }); } catch (_) {}
      tracks.forEach(track => { try { track.stop(); } catch (_) {} });
    }
    function dropSlot(slot) {
      const hadStream = slot.current && !slot.current.sender && slot.current.stream;
      disposeRecord(slot.pending); disposeRecord(slot.current);
      slot.pending = null; slot.current = null; slot.candidates.clear(); slot.retry = null;
      if (hadStream) emit('onStream', { participantId:slot.id, kind:slot.kind, stream:null });
    }
    function disposeLocal() {
      if (closed) return;
      closed = true; clearTimeout(timer); timer = null;
      requests.forEach(controller => controller.abort());
      slots.forEach(dropSlot); knownPeers.clear(); desired.clear(); returns.clear();
      if (snapshot) { snapshot.connection = 'closed'; notify(); }
    }
    function usable(rec) {
      return !closed && !rec.disposed && (rec.slot.pending === rec || rec.slot.current === rec);
    }
    function commitRecord(rec) {
      if (!usable(rec) || rec.pc.connectionState !== 'connected') return;
      if (rec.sender && mediaFor(rec.id,rec.kind) !== rec.source) {
        if (rec.slot.pending === rec) { rec.slot.pending = null; disposeRecord(rec); }
        return;
      }
      if (!rec.sender && (!rec.stream || !rec.stream.getTracks().length)) return;
      clearTimeout(rec.deadline);
      if (rec.sender && mediaFor(rec.id,rec.kind) === rec.source) rec.slot.retry = null;
      if (rec.slot.current !== rec) {
        const old = rec.slot.current;
        rec.slot.current = rec; rec.slot.pending = null;
        disposeRecord(old);
      }
      if (!rec.sender) emit('onStream', { participantId:rec.id, kind:rec.kind, stream:rec.stream });
    }
    function signal(id, payload) { return post('signal', { to:id, payload }); }
    function flushLocalCandidates(rec) {
      if (!rec.descriptionSent || rec.flushing || !usable(rec)) return;
      rec.flushing = true;
      rec.candidateSending = Promise.resolve().then(async () => {
        while (usable(rec) && rec.localCandidates.length) {
          const candidate = rec.localCandidates.shift();
          await signal(rec.id, { kind:rec.kind, type:'candidate', generation:rec.generation, candidate });
        }
      }).catch(error => { if (usable(rec)) { peerState(rec, 'signaling-failed'); report(error); } })
        .finally(() => { rec.flushing = false; if (rec.localCandidates.length && usable(rec)) flushLocalCandidates(rec); });
    }
    function createRecord(slot, gen, sender) {
      const pc = new RTCPeerConnection({ iceServers:[] });
      let cancel;
      const cancelled = new Promise(resolve => { cancel = resolve; });
      const rec = { pc, slot, id:slot.id, kind:slot.kind, generation:gen, sender,
        disposed:false, stream:sender ? null : new MediaStream(), localCandidates:[], descriptionSent:false, cancelled, cancel };
      rec.deadline = setTimeout(() => {
        if (!usable(rec) || rec.slot.current === rec) return;
        rec.cancelError = new Error('Guest media could not connect. This build has no Internet TURN relay.');
        rec.slot.pending = null; disposeRecord(rec);
        if (sender) deferRetry(slot,rec.source,rec);
        peerState(rec, 'failed'); report(rec.cancelError);
      }, negotiationTimeout);
      pc.onicecandidate = event => {
        if (!usable(rec) || !event.candidate) return;
        const candidate = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
        if (rec.localCandidates.length >= 64) { report(new Error('Guest ICE candidate limit reached.')); return; }
        rec.localCandidates.push(candidate); flushLocalCandidates(rec);
      };
      pc.onconnectionstatechange = () => {
        if (!usable(rec)) return;
        const state = pc.connectionState || 'connecting';
        commitRecord(rec); if (!usable(rec)) return; peerState(rec, state);
        if (state === 'failed' || state === 'closed') {
          const wasCurrent = slot.current === rec;
          if (wasCurrent) slot.current = null;
          if (slot.pending === rec) slot.pending = null;
          disposeRecord(rec);
          if (sender) deferRetry(slot,rec.source,rec);
          if (wasCurrent && !sender) emit('onStream', { participantId:slot.id, kind:slot.kind, stream:null });
          if (state === 'failed') report(new Error('Guest ' + slot.kind + ' media connection failed.'));
        }
      };
      pc.ontrack = event => {
        if (sender || !usable(rec) || !event.track) return;
        if (!rec.stream.getTracks().includes(event.track)) rec.stream.addTrack(event.track);
        if (typeof event.track.addEventListener === 'function') event.track.addEventListener('ended', () => {
          if (!usable(rec) || slot.current !== rec) return;
          if (rec.stream.getTracks().every(track => track.readyState === 'ended')) {
            slot.current = null; disposeRecord(rec);
            emit('onStream', { participantId:slot.id, kind:slot.kind, stream:null });
          }
        }, { once:true });
        commitRecord(rec);
      };
      return rec;
    }
    function enqueue(slot, work) {
      const next = slot.operation.catch(() => {}).then(() => {
        if (closed) throw new Error('This guest session has closed.');
        return work();
      });
      slot.operation = next; return next;
    }
    async function offerMedia(id, kind, stream) {
      const slot = slotFor(id, kind);
      // Removal must unblock an automatic offer which is waiting on a browser
      // WebRTC promise; it cannot wait behind that same slot operation.
      if (stream === null && mediaFor(id,kind) === null) dropSlot(slot);
      return enqueue(slot, async () => {
        if (!knownPeers.has(id) || mediaFor(id, kind) !== stream) return;
        if (stream && matchingSender(slot,stream)) {
          if (slot.current && slot.current.source === stream && slot.pending && slot.pending.source !== stream) {
            disposeRecord(slot.pending); slot.pending = null;
          }
          return;
        }
        const gen = ++generation;
        if (!stream) {
          dropSlot(slot); slot.highWater = gen;
          await signal(id, { kind, type:'remove', generation:gen });
          peerState({id,kind}, 'removed'); return;
        }
        if (!hasLiveMedia(stream)) { slot.retry = null; return; }
        retryState(slot,stream);
        const previousPending = slot.pending; let rec;
        const stillWanted = () => usable(rec) && knownPeers.has(id) && mediaFor(id,kind) === stream && hasLiveMedia(stream);
        const abandon = () => {
          if (slot.current !== rec) {
            if (slot.pending === rec) slot.pending = previousPending && !previousPending.disposed &&
              !closed && previousPending.source === mediaFor(id,kind) ? previousPending : null;
            disposeRecord(rec);
          }
          if (previousPending !== slot.pending && previousPending !== slot.current) disposeRecord(previousPending);
        };
        const abandoned = () => {
          if (stillWanted()) return false;
          abandon(); if (rec.cancelError) throw rec.cancelError; return true;
        };
        try {
          rec = createRecord(slot, gen, true); rec.source = stream; slot.pending = rec;
          stream.getTracks().forEach(track => { if (track.readyState !== 'ended') rec.pc.addTrack(track, stream); });
          // WebRTC promises cannot be aborted. Race them against record
          // disposal so a deadline/leave releases this slot's queue. A late
          // result is ignored by the wanted-source/generation guards below.
          const offer = await Promise.race([rec.pc.createOffer(),rec.cancelled]);
          if (abandoned()) return;
          await Promise.race([rec.pc.setLocalDescription(offer),rec.cancelled]);
          if (abandoned()) return;
          await Promise.race([signal(id, { kind, type:'offer', generation:gen,
            description:{ type:'offer', sdp:rec.pc.localDescription.sdp } }),rec.cancelled]);
          if (abandoned()) return;
          rec.descriptionSent = true; slot.highWater = gen;
          disposeRecord(previousPending); flushLocalCandidates(rec); peerState(rec, 'connecting');
        } catch (error) {
          if (rec && slot.current === rec && rec.pc.connectionState === 'connected') throw error;
          if (rec && slot.pending === rec) slot.pending = previousPending && !previousPending.disposed ? previousPending : null;
          disposeRecord(rec); deferRetry(slot,stream,rec); throw error;
        } finally {
          if (previousPending !== slot.pending && previousPending !== slot.current) disposeRecord(previousPending);
        }
      });
    }
    async function flushRemoteCandidates(rec) {
      const queued = rec.slot.candidates.get(rec.generation) || [];
      rec.slot.candidates.delete(rec.generation);
      for (const candidate of queued) { if (usable(rec)) await rec.pc.addIceCandidate(candidate); }
    }
    function validPayload(payload) {
      return payload && KINDS.has(payload.kind) && TYPES.has(payload.type) &&
        Number.isSafeInteger(payload.generation) && payload.generation > 0 && payload.generation < 2147483647;
    }
    async function receive(entry) {
      if (closed || !entry || !knownPeers.has(String(entry.from)) || !validPayload(entry.payload)) return;
      const id = String(entry.from), payload = entry.payload, kind = payload.kind;
      const slot = slotFor(id, kind), gen = payload.generation, outgoing = sendsKind(kind);
      if (payload.type === 'offer') {
        if (outgoing || gen <= slot.highWater || gen <= slot.removed) return;
        const description = payload.description;
        if (!description || description.type !== 'offer' || typeof description.sdp !== 'string' || description.sdp.length > 131072) return;
        slot.highWater = gen;
        const rec = createRecord(slot, gen, false);
        disposeRecord(slot.pending); slot.pending = rec;
        for (const queuedGen of slot.candidates.keys()) if (queuedGen < gen) slot.candidates.delete(queuedGen);
        try {
          await rec.pc.setRemoteDescription(description);
          if (!usable(rec)) return;
          await flushRemoteCandidates(rec);
          const answer = await rec.pc.createAnswer();
          if (!usable(rec)) return;
          await rec.pc.setLocalDescription(answer);
          if (!usable(rec)) return;
          await signal(id, { kind, type:'answer', generation:gen,
            description:{ type:'answer', sdp:rec.pc.localDescription.sdp } });
          rec.descriptionSent = true; flushLocalCandidates(rec); commitRecord(rec);
        } catch (error) {
          if (slot.current !== rec || rec.pc.connectionState !== 'connected') {
            if (slot.pending === rec) slot.pending = null; disposeRecord(rec);
          }
          throw error;
        }
      } else if (payload.type === 'answer') {
        if (!outgoing) return;
        const rec = [slot.pending, slot.current].find(item => item && item.generation === gen && !item.disposed);
        if (!rec || rec.pc.remoteDescription) return;
        const description = payload.description;
        if (!description || description.type !== 'answer' || typeof description.sdp !== 'string' || description.sdp.length > 131072) return;
        await rec.pc.setRemoteDescription(description);
        if (usable(rec)) { await flushRemoteCandidates(rec); commitRecord(rec); }
      } else if (payload.type === 'remove') {
        if (outgoing || gen < slot.highWater || gen <= slot.removed) return;
        slot.removed = gen; slot.highWater = gen; dropSlot(slot); peerState({id,kind}, 'removed');
      } else {
        if (gen <= slot.removed) return;
        const candidate = payload.candidate;
        if (candidate !== null && (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 8192)) return;
        const rec = [slot.pending, slot.current].find(item => item && item.generation === gen && !item.disposed);
        if (rec && rec.pc.remoteDescription) await rec.pc.addIceCandidate(candidate);
        else if (rec || (!outgoing && gen > slot.highWater)) {
          if (!slot.candidates.has(gen)) {
            if (slot.candidates.size >= 2) slot.candidates.delete(slot.candidates.keys().next().value);
            slot.candidates.set(gen, []);
          }
          const queue = slot.candidates.get(gen); if (queue.length < 64) queue.push(candidate);
        }
      }
    }
    function reconcile(data) {
      const nextPeers = new Set(host
        ? data.participants.filter(peer => peer.role === 'guest' && peer.present !== false).map(peer => String(peer.id))
        // A missed host heartbeat is resumable, not a new peer identity. Keep
        // the return receiver alive: an unchanged host would not reoffer it
        // merely because this guest briefly stopped seeing host presence.
        : ['host']);
      slots.forEach((slot, key) => { if (!nextPeers.has(slot.id)) {
        dropSlot(slot); slots.delete(key); returns.delete(slot.id); mediaQueues.delete('programme:' + slot.id);
      } });
      knownPeers = nextPeers;
    }
    async function pollOnce() {
      if (closed) return snapshot;
      if (polling) return polling;
      clearTimeout(timer); timer = null;
      polling = Promise.resolve().then(async () => {
        const data = await post('poll', { cursor });
        if (closed) return snapshot;
        if (!data || !data.room || data.room.id !== roomId || !data.self || data.self.id !== participantId ||
            !Array.isArray(data.participants) || !Number.isSafeInteger(data.cursor) || data.cursor < cursor)
          throw new Error('The guest helper returned an invalid room snapshot.');
        lastPollError = null;
        snapshot = { room:clone(data.room), self:clone(data.self || {}),
          participants:clone(data.participants), messages:clone(data.messages || []), cursor:data.cursor, connection:'connected' };
        if (data.room.closed) { disposeLocal(); return snapshot; }
        reconcile(data);
        const signals = Array.isArray(data.signals) ? data.signals : [];
        // Each receive installs its generation guard before awaiting WebRTC.
        // Dispatch independent peers together so slow answer delivery cannot
        // serially delay this participant's presence heartbeat for minutes.
        await Promise.all(signals.filter(entry => entry && Number.isSafeInteger(entry.seq) &&
          entry.seq > cursor && entry.seq <= data.cursor).map(entry =>
          receive(entry).catch(error => { if (!closed) report(error); })));
        if (!closed) { cursor = Math.max(cursor, data.cursor); retryMissingMedia(); notify(); }
        return snapshot;
      }).catch(error => {
        lastPollError = safeError(error);
        if (!closed) {
          report(error);
          if (snapshot) { snapshot.connection = 'retrying'; notify(); }
          if ([401,403,404,410].includes(error.status)) disposeLocal();
        }
        return snapshot;
      }).finally(() => {
        polling = null;
        if (!closed) timer = setTimeout(pollOnce, pollDelay);
      });
      return polling;
    }
    function validateStream(stream) {
      if (stream === null) return;
      if (!stream || typeof stream.getTracks !== 'function' ||
          !stream.getTracks().some(track => track && track.readyState !== 'ended' && ['audio','video'].includes(track.kind)))
        throw new Error('Guest media needs a MediaStream with a live audio or video track.');
    }
    function mediaOperation(kind, work) {
      const operation = (mediaQueues.get(kind) || Promise.resolve()).catch(() => {}).then(() => {
        if (closed) throw new Error('This guest session has closed.'); return work();
      });
      mediaQueues.set(kind, operation); return operation;
    }
    async function updatePeers(kind, peers) {
      const results = await Promise.allSettled(peers.map(id => offerMedia(id, kind, mediaFor(id, kind))));
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) {
        const error = report(new Error('Guest ' + kind + ' negotiation failed for ' + failed.length +
          ' connection(s). Previous connected media was retained where available. ' +
          (failed[0].reason && failed[0].reason.message || failed[0].reason)));
        error.partial = failed.length < results.length; throw error;
      }
      return { kind, negotiating:results.length };
    }
    function setMedia(stream, kind = 'camera') {
      return mediaOperation(kind, async () => {
        if (!KINDS.has(kind) || !sendsKind(kind)) throw new Error('This participant cannot send ' + kind + ' media.');
        validateStream(stream); desired.set(kind, stream);
        const peers = [...knownPeers].filter(id => !(host && kind === 'programme' && returns.has(id)));
        return updatePeers(kind, peers);
      });
    }
    function setReturnMedia(id, stream) {
      return mediaOperation('programme:' + id, async () => {
        if (!host || !id || id === 'host') throw new Error('Only the host can set a guest programme return.');
        validateStream(stream); id = String(id); returns.set(id, stream);
        return updatePeers('programme', knownPeers.has(id) ? [id] : []);
      });
    }
    function leave() {
      if (leaving) return leaving;
      if (leaveConfirmed || snapshot && snapshot.room.closed) return Promise.resolve({ left:true });
      disposeLocal();
      leaving = request('leave', { roomId }, true).then(result => { leaveConfirmed = true; return result; })
        .catch(error => { leaving = null; throw report(error); });
      return leaving;
    }

    const joined = await request(host ? 'create' : 'join', host
      ? { title:String(options.title || 'SHOWAVE broadcast'), hostName:String(options.hostName || 'Host') }
      : { roomId:String(options.roomId || ''), inviteToken:String(options.inviteToken || ''), name:String(options.name || 'Guest') });
    if (!joined || typeof joined.roomId !== 'string' || typeof joined.participantId !== 'string' || typeof joined.token !== 'string')
      throw new Error('The guest helper returned an invalid session.');
    roomId = joined.roomId; participantId = joined.participantId; token = joined.token;
    inviteToken = host ? String(joined.inviteToken || '') : '';
    const client = Object.freeze({
      roomId, participantId, inviteToken,
      get snapshot() { return snapshot ? clone(snapshot) : null; },
      get closed() { return closed; },
      setMedia, setReturnMedia, leave, refresh:pollOnce,
      setStage(id, onStage) { return post('set-stage', { participantId:String(id), onStage:!!onStage }); },
      sendChat(text) { return post('chat', { text:String(text || '') }); },
      setMediaState(state) {
        const body = {};
        ['camera','mic','screen'].forEach(key => { if (state && typeof state[key] === 'boolean') body[key] = state[key]; });
        return post('media', body);
      }
    });
    await pollOnce();
    if (!snapshot || snapshot.connection !== 'connected' || closed) {
      const error = lastPollError || new Error('The guest room closed before it was ready.');
      // A created room or joined slot must not survive a failed factory call.
      // Local cleanup is immediate; failed server cleanup is reported without
      // masking the original initial-poll error or returning an unusable client.
      await leave().catch(() => {});
      throw error;
    }
    return client;
  }
  return Object.freeze({ createHost:options => create(options, true), createGuest:options => create(options, false) });
})();
