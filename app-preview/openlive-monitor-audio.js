/* Local listening and measured stereo levels for the two Studio monitors.
   Speakers and their faders never change source gains or the encoder track.
   UNDOCUMENTED — inferring: always-visible controls and listening defaults
   are operator-requested extensions of manual/preferences.htm. */
window.OpenLiveMonitorAudio = (() => {
  'use strict';
  function mount(root, studio, report = () => {}) {
    const buses = [
      {name:'Preview', prefix:'preview', status:'previewAudioStatus', meter:'previewAudioMeter',
        monitor:'previewAudioMonitoringStatus', set:'setPreviewAudioMonitoring', volume:'setPreviewAudioMonitorVolume', defaultVolume:.5},
      {name:'Programme', prefix:'programme', status:'audioStatus', meter:'audioMeter',
        monitor:'audioMonitoringStatus', set:'setAudioMonitoring', volume:'setAudioMonitorVolume', defaultVolume:1}
    ].map(bus => ({...bus, host:root.querySelector('[data-monitor-audio="' + bus.prefix + '"]')}))
      .filter(bus => bus.host);
    const listeners = [];
    const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
    function paint(bus) {
      const {host, name} = bus;
      const status = studio?.[bus.status]?.() || {state:'unavailable',liveSources:0};
      const hasAudio = (status.knownSources || status.liveSources || status.contributors || 0) > 0;
      // Keep the volume available before intake and when sources are removed.
      // Empty meters are explicit; rendering never creates an audio route.
      host.hidden = !studio;
      if (!studio) return;
      const level = studio?.[bus.meter]?.();
      const listening = studio?.[bus.monitor]?.() || {enabled:false,state:'unavailable'};
      const volume = Math.max(0,Math.min(1,Number.isFinite(listening.volume)?listening.volume:bus.defaultVolume));
      const percentVolume = Math.round(volume*100);
      const button = host.querySelector('button');
      const ready = typeof studio?.[bus.set] === 'function';
      button.disabled = !ready;
      button.setAttribute('aria-pressed', String(!!listening.enabled));
      button.setAttribute('aria-label', (listening.enabled ? 'Mute ' + name + ' listening' : 'Listen to ' + name));
      button.title = (listening.enabled ? 'Mute ' : 'Listen to ') + name + ' on this device. ' +
        (name === 'Preview' ? 'Preview stays off air; audio follows Cut/Fade even with listening muted.' :
          'Listening mute does not mute the stream. Use Source audio to change the mix.') +
        (listening.enabled && listening.state !== 'running' ? ' ' + (listening.reason || '') : '');
      host.dataset.listening = listening.enabled ? listening.state : 'off';
      host.dataset.volume = volume===0?'zero':volume<.5?'low':'high';
      const monitoring = host.querySelector('.bc-listen-state');
      const listenState=listening.enabled ? (listening.state === 'running' ? volume===0?'Volume at zero':'Listening' : listening.state) : 'Listening muted';
      text(monitoring,listenState+' · '+percentVolume+'%');
      const fader=host.querySelector('.bc-listen-fader'),value=host.querySelector('.bc-volume-value');
      if(fader){
        if(fader.value!==String(percentVolume))fader.value=String(percentVolume);
        fader.disabled=typeof studio?.[bus.volume]!=='function';
        fader.style.setProperty('--monitor-volume',percentVolume+'%');
        fader.setAttribute('aria-valuetext',percentVolume+'% · '+listenState.toLowerCase());
        fader.title=name+' listening on this device · '+percentVolume+'%. Raise to listen; zero mutes listening. Source levels follow Cut/Fade. Double-click to reset to '+Math.round(bus.defaultVolume*100)+'%.';
      }
      text(value,percentVolume+'%');
      const caption = host.querySelector('.bc-audio-reading');
      const unavailable = ['suspended','unavailable','waiting'].includes(status.state) || (status.state === 'ready' && !level);
      const db = level?.db;
      text(caption,!hasAudio ? 'No audio' : unavailable ? (status.state === 'suspended' ? 'Enable audio' : !level && status.state === 'ready' ? 'Unavailable' : status.label || 'Unavailable')
        : status.state === 'muted' ? 'Muted' : status.state === 'paused' ? 'Paused' : status.state === 'ended' ? 'Ended' : Number.isFinite(db) && db > -60 ? db.toFixed(1) + ' dB' : 'Silent');
      caption.title = status.reason || '';
      host.dataset.state = !hasAudio?'empty':unavailable ? (!level && status.state === 'ready' ? 'unavailable' : status.state) : status.state === 'muted' ? 'muted' : level?.peak >= .98 ? 'clip' : 'ready';
      const identity=host.querySelector('.bc-console-bus-name');
      if(identity)identity.title=name+' audio: '+caption.textContent;
      host.querySelectorAll('[data-channel]').forEach(channel => {
        const sample = hasAudio&&!unavailable && level ? level[channel.dataset.channel] : null;
        const measured = sample && Number.isFinite(sample.db) ? sample.db : -60;
        const peak = sample && Number.isFinite(sample.peakDb) ? sample.peakDb : -60;
        const percent = value => Math.max(0, Math.min(100, (value + 60) / 60 * 100));
        channel.style.setProperty('--audio-level', percent(measured).toFixed(1) + '%');
        channel.style.setProperty('--audio-peak', percent(peak).toFixed(1) + '%');
        channel.setAttribute('aria-valuenow', String(Math.max(-60, Math.min(0, measured)).toFixed(1)));
        channel.setAttribute('aria-valuetext', !hasAudio||unavailable ? caption.textContent : measured <= -60 ? 'Silent' : measured.toFixed(1) + ' dBFS');
        channel.dataset.clip = sample?.peak >= .98 ? 'true' : 'false';
      });
    }
    for (const bus of buses) {
      const button = bus.host.querySelector('button');
      const click = async () => {
        if (typeof studio?.[bus.set] !== 'function') return;
        try {
          // Invoke synchronously within the gesture so AudioContext may resume.
          const pending = studio[bus.set](!studio[bus.monitor]().enabled);
          paint(bus);
          await pending;
        } catch (error) { report(error.message || String(error)); }
        finally { paint(bus); }
      };
      button.addEventListener('click', click);
      listeners.push(() => button.removeEventListener('click', click));
      const fader=bus.host.querySelector('.bc-listen-fader');
      if(fader){
        const change=async(activate)=>{
          if(typeof studio?.[bus.volume]!=='function')return;
          try{
            studio[bus.volume](Number(fader.value)/100);
            const listening=studio?.[bus.monitor]?.();
            let pending;
            // A deliberate fader gesture is also a request to listen. Invoke
            // the existing route before awaiting so browser audio can resume.
            // Reset only restores the level, retaining the speaker mute.
            if(activate&&listening&&typeof studio?.[bus.set]==='function'){
              const enabled=listening.volume>0;
              if(enabled!==listening.enabled||(enabled&&listening.state!=='running'))pending=studio[bus.set](enabled);
            }
            paint(bus);
            await pending;
          }catch(error){report(error.message||String(error));}
          finally{paint(bus);}
        };
        const input=()=>change(true);
        const reset=()=>{fader.value=String(Math.round(bus.defaultVolume*100));return change(false);};
        fader.addEventListener('input',input);fader.addEventListener('dblclick',reset);
        listeners.push(()=>{fader.removeEventListener('input',input);fader.removeEventListener('dblclick',reset);});
      }
    }
    return {render:() => buses.forEach(paint), destroy:() => listeners.forEach(remove => remove())};
  }
  return {mount};
})();
