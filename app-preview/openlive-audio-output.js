/* Shared local output routing. Each player keeps its own source clock and
   encoder bus; device mute is a separate speaker branch. Preferences never
   close a running context or replace a live MediaStream track. */
(function () {
  'use strict';
  if (window.OpenLiveAudioOutput) return;
  const routes = new Set();
  const hub = window.OpenLiveHub;
  const defaults = {deviceId:'output:default',active:true,masterChannels:'1 / 2',delayMs:0,sampleRate:48000};
  const settings = () => Object.assign({}, defaults, hub?.get?.('preferences.audio.output', {}) || {});
  const sinkFor = id => String(id || '').startsWith('media:output:') ? String(id).slice(13) : 'default';
  const provenance = '__openliveMasterDelayOwned';
  const hasMasterDelay = stream => stream?.[provenance] === true;
  function markMasterDelay(stream) { try { Object.defineProperty(stream,provenance,{value:true,configurable:true}); } catch (_) {} return stream; }
  function inheritMasterDelay(target,source) { if(hasMasterDelay(source))markMasterDelay(target); }
  const safeDisconnect = node => { try { node?.disconnect(); } catch (_) {} };
  function contextOptions() {
    const rate = Number(settings().sampleRate);
    return Object.assign({latencyHint:'interactive'}, [44100,48000].includes(rate) ? {sampleRate:rate} : {});
  }
  function create(ctx, options = {}) {
    const speaker = ctx.createGain(); speaker.gain.value = 0; speaker.connect(ctx.destination);
    const programme = options.masterDelay && typeof ctx.createDelay === 'function' ? ctx.createDelay(.5) : null;
    const inputs = new Set();
    let desired, generation = 0, processing = false, disposed = false, applied = 'default';
    let result = {ok:true,applied:true,supported:typeof ctx.setSinkId === 'function',sinkId:applied,requested:'output:default',reason:''};
    const waiters = new Map();
    const status = () => Object.assign({},result,processing ? {ok:false,requested:desired?.deviceId || result.requested,reason:'The output device is being selected. Local listening is muted until selection finishes.'} : {},{pending:processing,enabled:!disposed && speaker.gain.value > 0,
      contextState:ctx.state, sampleRate:ctx.sampleRate, requestedSampleRate:Number(desired?.sampleRate)||0,
      restartRequired:!!desired?.sampleRate && Number(desired.sampleRate)!==ctx.sampleRate,
      delayMs:programme ? programme.delayTime.value*1000 : inputs.size ? Math.max(0,Math.min(500,Number(desired?.delayMs)||0)) : 0,
      delaySupported:!!programme || typeof ctx.createDelay === 'function' || !Number(desired?.delayMs)});
    function gate() {
      const enabled = !disposed && !processing && result.applied !== false && desired?.active !== false && desired?.deviceId !== 'none' && desired?.masterChannels !== 'None';
      speaker.gain.value = enabled ? 1 : 0;
    }
    function settle(version, value) {
      for (const [key, waiter] of waiters) if (key <= version) {
        clearTimeout(waiter.timer); waiter.resolve(key === version ? value : Object.assign({},value,{superseded:true})); waiters.delete(key);
      }
    }
    async function pump() {
      if (processing || disposed) return;
      processing = true; gate();
      while (!disposed) {
        const version = generation, target = desired.deviceId || 'output:default', sink = sinkFor(target);
        let next = {ok:true,applied:true,supported:typeof ctx.setSinkId === 'function',sinkId:applied,requested:target,reason:''};
        if(target === 'none') {
          next.sinkId = applied;
        } else if (typeof ctx.setSinkId !== 'function') {
          next = {ok:sink === 'default',applied:true,supported:false,sinkId:'default',requested:target,
            reason:sink === 'default' ? '' : 'This player cannot select an output device. Using the system default output.'};
        } else {
          try { await ctx.setSinkId(sink); applied = sink; next.sinkId = sink; }
          catch (error) {
            if (disposed || version !== generation) continue;
            next.ok = false; next.applied = false; next.reason = String(error?.message || 'The audio output could not be selected.');
            if (sink !== 'default') {
              try { await ctx.setSinkId('default'); applied = 'default'; next.applied = true; next.sinkId = applied;
                next.reason += ' Using the system default output.'; }
              catch (_) { next.sinkId = applied; }
            }
          }
        }
        if (disposed) break;
        if (version !== generation) continue;
        result = next; processing = false; gate(); settle(version,status()); return;
      }
      processing = false;
    }
    function configure(value = settings(), {retry = false} = {}) {
      if (disposed) return Promise.resolve({ok:false,disposed:true,reason:'This audio output was released.'});
      const next = Object.assign({},defaults,value), previous = desired;
      desired = next;
      if (programme) programme.delayTime.value = Math.max(0,Math.min(500,Number(next.delayMs)||0))/1000;
      for(const input of inputs) if(input.delayTime) input.delayTime.value = Math.max(0,Math.min(500,Number(next.delayMs)||0))/1000;
      // Meter/status publication also updates the preferences.audio parent.
      // Keep a confirmed fallback stable across those notifications. Only an
      // explicit device choice retries a rejected sink and mutes listening.
      if (previous && previous.deviceId === next.deviceId && (!retry || processing)) {
        gate();return processing && waiters.get(generation)?.promise || Promise.resolve(status());
      }
      const version = ++generation;
      const promise = new Promise(resolve => {
        const timer = setTimeout(() => { waiters.delete(version); resolve(Object.assign({},status(),{ok:false,pending:true,
          reason:'The output device is still being selected. Local listening is muted until selection finishes.'})); },5000);
        waiters.set(version,{resolve,timer});
      });
      waiters.get(version).promise = promise;
      pump(); return promise;
    }
    const route = {speaker,programme,status,configure,
      ready:()=>processing && waiters.get(generation)?.promise || Promise.resolve(status()),
      programmeInput(stream) {
        const node = !hasMasterDelay(stream) && typeof ctx.createDelay === 'function' ? ctx.createDelay(.5) : ctx.createGain();
        if(node.delayTime)node.delayTime.value=Math.max(0,Math.min(500,Number(desired?.delayMs)||0))/1000;
        inputs.add(node);return node;
      },
      releaseInput(node) {inputs.delete(node);safeDisconnect(node);},
      destroy() {
      if (disposed) return; disposed = true; speaker.gain.value = 0;
      safeDisconnect(speaker); safeDisconnect(programme); routes.delete(route);
      for(const input of inputs)safeDisconnect(input);inputs.clear();
      settle(generation,{ok:false,disposed:true,reason:'This audio output was released.'});
    }};
    routes.add(route); configure(); return route;
  }
  hub?.subscribe?.('preferences.audio.output', () => { for (const route of routes) route.configure(); },{immediate:false});
  window.addEventListener?.('pagehide',event=>{if(!event.persisted)for(const route of [...routes])route.destroy();});
  window.OpenLiveAudioOutput = {create,contextOptions,settings,hasMasterDelay,markMasterDelay,inheritMasterDelay};
})();
