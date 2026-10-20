/* ===========================================================================
   openlive-tools.js — the free-tools suite, for Alley

   Modelled on restream.io/tools. OpenLive can genuinely run nine workflows
   locally; the third-party Clips handoff is intentionally not presented as a
   local tool.
   The three file-transcription cards need a speech model and are
   listed with the reason rather than omitted — an operator who came looking for
   "Audio Transcription" deserves to be told why it is not here, not to wonder
   whether they missed a button.

   WHAT IS REAL, AND HOW
     Audio Extractor   decode the file's audio with WebAudio, encode RIFF/WAV.
     Audio Converter   same path; WAV out. MP3 is NOT offered - see below.
     Audio Remover     re-encode the video with only its video track attached.
     Video Converter   play + captureStream + MediaRecorder. This is a RE-ENCODE,
                       not a remux, so it costs a generation of quality and runs
                       in real time. Said plainly in the UI, because a tool that
                       silently transcodes when you expected a container swap is
                       a tool that ruins footage.
     Camera Test       getUserMedia + live preview + resolution readout.
     Mic Test          getUserMedia + WebAudio level meter.
     Script Builders   deterministic local TikTok, YouTube and sales outlines;
                       explicitly not represented as language-model output.

   WHAT IS NOT, AND WHY
     MP3 encoding      no browser ships an MP3 encoder. MediaRecorder will not
                       produce MP3 in any Chromium build. Offering "Convert to
                       MP3" and quietly handing back WAV or WebM would be the
                       exact failure this codebase refuses.
     Transcription     needs a speech model. The Web Speech API transcribes the
                       LIVE microphone only - it cannot be pointed at a file -
                       so it cannot implement file transcription at all.
     The three transcription workflows need a file-capable speech model.

   Publishes window.OpenLiveTools. Classic script, no libraries.
   =========================================================================== */
window.OpenLiveTools = (() => {
  'use strict';

  const has = {
    webaudio:      typeof (window.AudioContext || window.webkitAudioContext) === 'function',
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    gum:           !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    capture:       typeof HTMLCanvasElement !== 'undefined' &&
                   typeof HTMLCanvasElement.prototype.captureStream === 'function',
    saveFile:      typeof window.showSaveFilePicker === 'function',
    documents:     typeof window.OpenLiveDocuments?.openPlayer === 'function'
  };

  /* The catalogue. `state` is computed, never written by hand, so a browser
     without MediaRecorder greys the right rows automatically. */
  const TOOLS = [
    { id:'document-deck', name:'PDF / PowerPoint Deck', blurb:'Play an original presentation in one Clip',
      category:'media', mark:'DOC',
      kind:'document', needs:['documents'], accept:'.pdf,.ppt,.pptx,.pps,.ppsx,.pptm,.ppsm', out:'Original presentation',
      note:'PDF pages and PowerPoint slides play directly inside OpenLive. Original files stay in place; no installed Office application, converted Clips or page files are required.' },
    { id:'audio-extract',  name:'Audio Extractor',   blurb:'Separate audio from your video',
      category:'media', mark:'WAV',
      needs:['webaudio'], accept:'video/*,audio/*', out:'WAV',
      note:'Restream\'s tool returns MP3. This one returns uncompressed WAV, because no browser ships an MP3 encoder. The difference is stated rather than silently substituted, and WAV is what the surrounding app wants anyway.' },
    { id:'audio-convert',  name:'Audio Converter',   blurb:'Convert to WAV',
      category:'media', mark:'WAV',
      needs:['webaudio'], accept:'audio/*,video/*', out:'WAV',
      note:'MP3 is not offered: no browser ships an MP3 encoder.' },
    { id:'audio-remove',   name:'Audio Remover',     blurb:'Mute your video',
      category:'media', mark:'MUTE',
      needs:['mediaRecorder','capture'], accept:'video/*', out:'WebM / MP4' },
    { id:'video-convert',  name:'Video Converter',   blurb:'Convert to MP4 or WebM',
      category:'media', mark:'VID',
      needs:['mediaRecorder','capture'], accept:'video/*', out:'MP4 / WebM',
      note:'A real-time RE-ENCODE, not a remux. Expect one generation of quality loss.' },
    { id:'camera-test',    name:'Camera Test',       blurb:'Test your webcam',
      category:'capture', mark:'CAM', needs:['gum'] },
    { id:'mic-test',       name:'Mic Test',          blurb:'Test your microphone',
      category:'capture', mark:'MIC', needs:['gum','webaudio'] },
    { id:'audio-transcribe', name:'Audio Transcription', blurb:'Transcribe audio to text', blocked:
      'A file-capable speech model is not bundled. Browser SpeechRecognition only accepts the live microphone; it cannot receive an uploaded file.',
      category:'adapter', mark:'TXT' },
    { id:'video-transcribe', name:'Video Transcription', blurb:'Transcribe video to text', blocked:
      'A file-capable speech model is not bundled. SHOWAVE will not play the file at a microphone and label that a reliable transcript.',
      category:'adapter', mark:'TXT' },
    { id:'podcast-transcribe', name:'Podcast Transcription', blurb:'Transcribe podcast to text', blocked:
      'A file-capable speech model is not bundled. Add a local transcription adapter before enabling this card.',
      category:'adapter', mark:'TXT' },
    { id:'ai-tiktok',  name:'TikTok Script Builder',  blurb:'Build a TikTok script outline', kind:'script', scriptType:'tiktok',
      category:'script', mark:'TK',
      note:'SHOWAVE local script builder: deterministic and private; it does not claim a language model wrote the result.' },
    { id:'ai-youtube', name:'YouTube Script Builder', blurb:'Build a YouTube script outline', kind:'script', scriptType:'youtube',
      category:'script', mark:'YT',
      note:'SHOWAVE local script builder: deterministic and private; it does not claim a language model wrote the result.' },
    { id:'ai-sales',   name:'Sales Script Builder',   blurb:'Build an evidence-safe sales outline', kind:'script', scriptType:'sales',
      category:'script', mark:'SALE',
      note:'SHOWAVE local script builder: deterministic and private; it does not claim a language model wrote the result.' }
  ];

  function stateOf(t) {
    if (t.blocked) return { ok:false, why:t.blocked };
    const missing = (t.needs || []).filter(n => !has[n]);
    if (missing.length) return { ok:false, why:'This browser is missing: ' + missing.join(', ') + '.' };
    return { ok:true, why:'' };
  }

  function generateScript(type, options) {
    options = options || {};
    const topic = String(options.topic || '').trim();
    if (!topic) throw new Error('Give the script a topic first.');
    const audience = String(options.audience || 'your audience').trim();
    const goal = String(options.goal || 'take the next step').trim();
    const tone = String(options.tone || 'clear').trim();
    const product = String(options.product || topic).trim();
    if (type === 'tiktok') return [
      `[HOOK: first 2 seconds] Stop scrolling if ${topic} matters to ${audience}.`,
      `[PAYOFF] Here is the part most people miss: state the single surprising fact about ${topic}.`,
      `[BEAT 1] Show the problem in one visual sentence.`,
      `[BEAT 2] Demonstrate the change, result, or before/after.`,
      `[PROOF] Add one measured result, example, or source; never invent one.`,
      `[CTA] If you want to ${goal}, do this next: ________.`,
      `[DELIVERY] ${tone} tone · short clauses · captions safe inside the vertical frame.`
    ].join('\n\n');
    if (type === 'youtube') return [
      `[COLD OPEN] In this video, ${audience} will learn ${topic} without ________.`,
      `[PROMISE] By the end, you will be able to ${goal}.`,
      `[CONTEXT] Explain why ${topic} matters now and define the outcome.`,
      `[SECTION 1: Foundation] The minimum the viewer must know.`,
      `[SECTION 2: Demonstration] Walk through the method with a real example.`,
      `[SECTION 3: Failure modes] Show the three mistakes most likely to undo the result.`,
      `[RECAP] Restate the method in three short steps.`,
      `[CTA] Invite one specific next action: ${goal}.`,
      `[EDITOR NOTE] ${tone} tone · replace every claim placeholder with verified evidence.`
    ].join('\n\n');
    if (type === 'sales') return [
      `[OPEN] For ${audience}: if ${topic} is costing you time, money, or reliability, this is for you.`,
      `[PROBLEM] Describe the current pain in the buyer's words; quantify it only with a real number.`,
      `[OUTCOME] ${product} helps the buyer ${goal}.`,
      `[MECHANISM] Explain how it works in one concrete, non-technical paragraph.`,
      `[PROOF] Insert a verified customer result, demonstration, or guarantee: ________.`,
      `[OBJECTION] Address the strongest reason a serious buyer would say no.`,
      `[OFFER] State scope, price or next-step expectations plainly.`,
      `[CTA] Ask for one action: ${goal}.`,
      `[DELIVERY] ${tone} tone · no invented urgency, scarcity, testimonials, or performance claims.`
    ].join('\n\n');
    throw new Error('Unknown script type.');
  }

  const ctx = () => new (window.AudioContext || window.webkitAudioContext)();

  /* ---- WAV encoding ------------------------------------------------------
     16-bit PCM RIFF. preparing-media.htm is emphatic that audio for live work
     should be uncompressed linear PCM, so WAV is not a fallback here — it is
     the format the surrounding application actually wants. */
  function encodeWav(buffer) {
    const chans = buffer.numberOfChannels, rate = buffer.sampleRate, frames = buffer.length;
    const data = new ArrayBuffer(44 + frames * chans * 2);
    const v = new DataView(data);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + frames * chans * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, chans, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * chans * 2, true); v.setUint16(32, chans * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, frames * chans * 2, true);
    const ch = [];
    for (let c = 0; c < chans; c++) ch.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < chans; c++) {
        const s = Math.max(-1, Math.min(1, ch[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([data], { type: 'audio/wav' });
  }

  function extractAudio(file, onProgress) {
    if (!has.webaudio) return Promise.reject(new Error('This browser has no Web Audio API.'));
    if (onProgress) onProgress('reading');
    return file.arrayBuffer().then(buf => {
      if (onProgress) onProgress('decoding');
      const c = ctx();
      return c.decodeAudioData(buf).then(audio => {
        c.close();
        if (onProgress) onProgress('encoding');
        return {
          blob: encodeWav(audio),
          name: file.name.replace(/\.[^.]+$/, '') + '.wav',
          info: `${audio.numberOfChannels} ch · ${audio.sampleRate} Hz · ${audio.duration.toFixed(2)} s`
        };
      });
    }).catch(err => {
      throw new Error('Could not decode audio from "' + file.name + '". ' +
        'The browser decodes only what it can play; a professional codec needs the native tier. (' + err.message + ')');
    });
  }

  /* ---- video re-encode ---------------------------------------------------
     Real time by construction: the frames come from playback. A ten minute clip
     takes ten minutes, and the UI must say so rather than look hung. */
  function reencodeVideo(file, opts, onProgress) {
    opts = opts || {};
    if (!has.mediaRecorder || !has.capture) return Promise.reject(new Error('This browser cannot re-encode video.'));
    const wantMp4 = (opts.container || 'mp4') === 'mp4';
    /* The MP4 list used to end in a WebM entry. On a Chromium build without an
       MP4 muxer that silently produced a .webm while the UI said "MP4" — asking
       for one container and getting another is precisely the substitution this
       project refuses. Each container now only tries its own muxes, and an
       unavailable one is reported rather than swapped. */
    const cands = wantMp4
      ? ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4']
      : ['video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm'];
    const mime = cands.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
    if (!mime) return Promise.reject(new Error(wantMp4
      ? 'This browser\'s MediaRecorder cannot mux MP4. SHOWAVE will not hand back a WebM labelled MP4. Choose WebM, or use a native encoder.'
      : 'This browser\'s MediaRecorder cannot mux WebM.'));

    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = !!opts.dropAudio;      // muted still decodes audio unless we drop the track
      v.playsInline = true;
      v.src = URL.createObjectURL(file);
      v.onerror = () => reject(new Error('The browser cannot play "' + file.name + '", so it cannot re-encode it.'));
      v.onloadedmetadata = () => {
        const cv = document.createElement('canvas');
        cv.width = opts.width || v.videoWidth; cv.height = opts.height || v.videoHeight;
        const cx = cv.getContext('2d', { alpha: false });
        const stream = cv.captureStream(opts.fps || 30);
        const sourceDuration = Number.isFinite(v.duration) ? v.duration : 0;
        const startTime = Math.max(0, Math.min(Number(opts.startTime) || 0, Math.max(0, sourceDuration - 0.01)));
        const requestedEnd = Number(opts.endTime);
        const endTime = sourceDuration
          ? Math.max(startTime + 0.01, Math.min(Number.isFinite(requestedEnd) ? requestedEnd : sourceDuration, sourceDuration))
          : 0;
        const outputDuration = Math.max(0.01, endTime - startTime);

        if (!opts.dropAudio) {
          try {
            const src = v.captureStream ? v.captureStream() : null;
            if (src) src.getAudioTracks().forEach(t => stream.addTrack(t));
          } catch (e) { /* no audio track: the output is simply silent */ }
        }

        const parts = [];
        let drawnFrames = 0;
        let stopping = false;
        const rec = new MediaRecorder(stream, {
          mimeType: mime,
          videoBitsPerSecond: opts.bitrate || 8_000_000
        });
        rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
        rec.onstop = () => {
          URL.revokeObjectURL(v.src);
          const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
          const blob = new Blob(parts, { type: mime.split(';')[0] });
          /* A re-encode that captured nothing must not resolve. It used to:
             MediaRecorder happily stops with zero chunks, so the caller got a
             0-byte Blob, saved it, and reported success — a file that does not
             play, announced as converted. Measured on a background tab, where
             the old requestAnimationFrame draw loop never ran: 8.0 s elapsed,
             1 progress callback, 0 bytes out. */
          if (!blob.size) {
            /* Two different failures, and the operator can only act on one of
               them. A near-zero frame count over a clip of real duration means
               the browser stopped decoding for this tab, not that the encoder
               is broken — Chromium throttles both rAF and rVFC when the tab is
               hidden, so the fix is "bring the window forward", which the
               message has to actually say. */
            const starved = drawnFrames < Math.max(2, (v.duration || 0));
            reject(new Error('The encoder produced no data for "' + file.name + '". ' +
              (starved
                ? 'Only ' + drawnFrames + ' frame(s) were decoded in ' + (v.duration || 0).toFixed(1) +
                  ' s. The browser throttles a hidden or backgrounded tab. Keep this window ' +
                  'visible and in the foreground while converting.'
                : 'MediaRecorder returned no chunks despite ' + drawnFrames + ' decoded frames.')));
            return;
          }
          resolve({ blob: blob,
                    name: file.name.replace(/\.[^.]+$/, '') + '.' + ext,
                    info: `${cv.width}×${cv.height} · ${mime.split(';')[0]} · ${outputDuration.toFixed(1)} s · ` +
                          `${drawnFrames} frames · ${(blob.size/1048576).toFixed(1)} MB` });
        };
        rec.onerror = e => reject((e && e.error) || new Error('MediaRecorder failed.'));

        const stop = () => {
          if (stopping) return;
          stopping = true;
          try { v.pause(); } catch (e) {}
          try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { reject(e); }
        };

        const paintFrame = () => {
          const sourceWidth = v.videoWidth || cv.width;
          const sourceHeight = v.videoHeight || cv.height;
          const mode = String(opts.scale || 'fit').toLowerCase();
          cx.fillStyle = 'rgb(0 0 0)';
          cx.fillRect(0, 0, cv.width, cv.height);
          if (mode === 'stretch') {
            cx.drawImage(v, 0, 0, cv.width, cv.height);
            return;
          }
          const factor = mode === 'fill'
            ? Math.max(cv.width / sourceWidth, cv.height / sourceHeight)
            : Math.min(cv.width / sourceWidth, cv.height / sourceHeight);
          const width = sourceWidth * factor;
          const height = sourceHeight * factor;
          cx.drawImage(v, (cv.width - width) / 2, (cv.height - height) / 2, width, height);
        };

        /* requestVideoFrameCallback fires once per DECODED video frame and is
           not tied to the compositor, so a conversion keeps running when the
           window is behind another one. requestAnimationFrame is: on a
           background tab it stops entirely, which is how this produced a
           0-byte file and still resolved. rAF stays as the fallback for
           builds without rVFC. */
        const hasRVFC = typeof v.requestVideoFrameCallback === 'function';
        const draw = () => {
          if (stopping || v.ended || v.paused) return;
          if (endTime && v.currentTime >= endTime) { stop(); return; }
          paintFrame();
          drawnFrames++;
          if (onProgress) onProgress(Math.max(0, Math.min(1, (v.currentTime - startTime) / outputDuration)));
          if (hasRVFC) v.requestVideoFrameCallback(draw);
          else requestAnimationFrame(draw);
        };
        v.onended = stop;
        const begin = () => {
          rec.start(1000);
          v.play().then(draw).catch(reject);
        };
        if (startTime > 0) {
          v.addEventListener('seeked', begin, { once:true });
          v.currentTime = startTime;
        } else begin();
      };
    });
  }

  const removeAudio = (file, onProgress) =>
    reencodeVideo(file, { dropAudio: true }, onProgress);

  /* ---- device tests ------------------------------------------------------ */
  function cameraTest(constraints) {
    if (!has.gum) return Promise.reject(new Error('navigator.mediaDevices.getUserMedia is unavailable.'));
    return navigator.mediaDevices.getUserMedia(constraints || { video: true })
      .catch(err => {
        throw new Error(err.name === 'NotAllowedError'
          ? 'Camera permission was refused. Note that an embedded preview pane blocks getUserMedia outright. ' +
            'This test needs a real browser window.'
          : 'Camera unavailable: ' + err.name + '. Another application may hold it.');
      });
  }

  function micTest() {
    if (!has.gum || !has.webaudio) return Promise.reject(new Error('Microphone testing needs getUserMedia and Web Audio.'));
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const c = ctx();
      const src = c.createMediaStreamSource(stream);
      const an = c.createAnalyser(); an.fftSize = 1024;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      return {
        stream,
        /* RMS in dBFS. A peak meter that only moves on clipping tells you
           nothing about a quiet mic, which is the actual failure being tested. */
        level() {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
          const rms = Math.sqrt(sum / buf.length);
          return { rms, db: rms > 0 ? 20 * Math.log10(rms) : -Infinity };
        },
        stop() { try { stream.getTracks().forEach(t => t.stop()); c.close(); } catch (e) {} }
      };
    }).catch(err => {
      throw new Error(err.name === 'NotAllowedError'
        ? 'Microphone permission was refused. An embedded preview pane blocks getUserMedia. Use a real browser window.'
        : 'Microphone unavailable: ' + err.name + '.');
    });
  }

  /* ---- saving ------------------------------------------------------------ */
  function save(blob, name, options) {
    try { window.OpenLiveSessionPolicy?.assertCanWrite('Saving'); }
    catch (error) { return Promise.reject(error); }
    options = options || {};
    /* A utility action should finish on one click. The old default always
       opened showSaveFilePicker when Chromium exposed it, leaving the card at
       "encoding…" while an OS dialog waited behind the SHOWAVE window. Direct
       download is now the predictable default; an explicit Browse destination
       can still request the native picker. */
    if (options.picker && has.saveFile) {
      return window.showSaveFilePicker({ suggestedName: name })
        .then(h => h.createWritable())
        .then(w => w.write(blob).then(() => w.close()))
        .then(() => 'disk')
        .catch(err => { if (err && err.name === 'AbortError') throw new Error('Cancelled.'); return download(blob, name); });
    }
    return Promise.resolve(download(blob, name));
  }
  function download(blob, name) {
    window.OpenLiveSessionPolicy?.assertCanWrite('Downloading');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'download';
  }

  return {
    version: 1, has, TOOLS, stateOf,
    extractAudio, reencodeVideo, removeAudio, cameraTest, micTest, encodeWav,
    generateScript, save
  };
})();
