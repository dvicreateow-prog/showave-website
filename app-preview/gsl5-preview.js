/* SHOWAVE GSL5 fixture preview renderer
   ==========================================================================
   WHAT THIS REPLACED, AND WHY IT HAD TO GO
   --------------------------------------------------------------------------
   The previous renderer drew a cartoon. Its moving head swung by
   `Math.sin(time*.7)*.14` whatever the fixture's pan/tilt channels said, its
   colour came from `dynamicColor(palette,index,time)` cycling the palette on a
   timer, and its "controls" were `Math.sin(time*.8+index*.67)` bars. It looked
   identical no matter what the rig was doing, because it never read a value.

   THE ONE RULE HERE: every rendered quantity comes from an attribute value.
   The only clock in this file is the strobe flash phase, and even its RATE is
   read out of the profile's own function table. There is a falsifiable test
   for this: with no effects and no programmer, THE IMAGE IS COMPLETELY STATIC.
   Nothing breathes, nothing cycles, nothing sweeps. tools/test-gsl5-preview.js
   asserts exactly that by rendering two frames 5 seconds apart and comparing
   them byte for byte.

   WHAT THE DATA ACTUALLY IS, measured across all 56 built-in samples:
     26 of 56 profiles have CELLS - pixel bars, tubes, matrices, zones,
        blinders and dimmer packs. Multi-emitter is the majority case.
     21 of 56 have NO dimmer and NO intensity channel at all; their level IS
        their emitter drive. Folding those through a missing dimmer renders
        every pixel bar and matrix black, so level falls back to emitter energy.
      8 of 56 pan/tilt. 5 zoom. 18 shutter.
   A beam-first renderer would therefore be wrong about most of the library.
   Every fixture is drawn as its real EMITTER SET; the eight that aim also get
   a real beam.

   COLOUR IS PHYSICAL, CHROME IS THEMED. Emitter chromaticities are properties
   of LEDs, not of the user's colour scheme - a red emitter is red in every
   theme - so they are fixed here. Chrome resolves from SHOWAVE Appearance
   tokens, but each one is contrast-checked against the room first: this canvas
   is dark in every theme, and under the light theme `--txt-hi` is near-black
   against a `--content-black` that is black in BOTH themes, which drew the
   fixture name black on black. Tokens are consumed; an illegible one falls
   back to another token, never to a private palette.

   HONESTY. The profile data carries no beam angle in degrees, no pan/tilt
   travel, no photometrics. Anything derived from a quantity the profile does
   not state is recorded in the look's `gaps` set and marked in the render,
   rather than being quietly invented.
   ========================================================================== */
(function installShowaveGSL5Preview(global) {
  'use strict';

  if (global.ShowaveGSL5Preview) return;

  const text = value => String(value == null ? '' : value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const level = value => clamp(value, 0, 1);

  /* ---------------------------------------------------------------- theme
     THE PREVIEW IS A DARK ROOM IN EVERY THEME. Emitted light can only be shown
     against darkness - a white field cannot depict a lit lamp - and
     `--content-black` is black in light and dark alike, because it is the
     background behind video content rather than a UI surface.

     Every value here is still a live Appearance token. Each is contrast-checked
     against the room, and one that would be illegible there falls back to
     ANOTHER token that is legible. Taken at face value, `--txt-hi` under the
     light theme rendered the fixture name black on black. Measured, not
     guessed. */
  let themeCache = null;
  const themeValue = (style, names, fallback) => {
    for (const name of names) {
      const value = style && typeof style.getPropertyValue === 'function'
        ? style.getPropertyValue(name).trim() : '';
      if (value) return value;
    }
    return fallback;
  };
  /* Relative luminance of a #rgb/#rrggbb token. Anything this cannot parse
     (a named colour, a color-mix()) is treated as legible, so an unparseable
     token is used as authored rather than silently overridden. */
  const luminance = value => {
    const hex = text(value).trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
    if (!hex) return null;
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split('').map(c => c + c).join('');
    const channel = at => {
      const srgb = parseInt(digits.slice(at, at + 2), 16) / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const legibleOn = (background, candidate) => {
    const a = luminance(background), b = luminance(candidate);
    if (a == null || b == null) return true;
    const light = Math.max(a, b) + 0.05, dark = Math.min(a, b) + 0.05;
    return light / dark >= 2.2;
  };

  const resolveTheme = () => {
    if (themeCache) return themeCache;
    const document = global.document, root = document && document.documentElement;
    const style = root && typeof global.getComputedStyle === 'function'
      ? global.getComputedStyle(root) : null;
    const bg = themeValue(style, ['--content-black', '--inset'], 'Canvas');
    /* Every value is a live Appearance token; none is a private palette.
       But this canvas is a DARK ROOM in every theme - `--content-black`
       is black in both - and under the light theme `--txt-hi` is near-black,
       which drew the fixture name black on black. So where a token would be
       illegible against the room, the guard falls back to ANOTHER TOKEN that
       is legible there. Under the dark theme the text tokens are already light
       and it never fires. This is a contrast guard, not a second skin. */
    const readable = (first, second, fallback) => {
      const primary = themeValue(style, first, fallback);
      if (legibleOn(bg, primary)) return primary;
      const alternate = themeValue(style, second, fallback);
      return legibleOn(bg, alternate) ? alternate : primary;
    };
    themeCache = Object.freeze({
      bg,
      panel: themeValue(style, ['--panel'], 'Canvas'),
      panel2: themeValue(style, ['--panel2', '--panel'], 'Canvas'),
      line: readable(['--line2', '--line'], ['--panel'], 'GrayText'),
      text: readable(['--txt-hi', '--txt'], ['--panel', '--inset'], 'CanvasText'),
      dim: readable(['--txt-dim', '--txt'], ['--line2', '--inset'], 'GrayText'),
      accent: themeValue(style, ['--color-accent', '--mint'], 'Highlight'),
      good: themeValue(style, ['--audio-meter-nominal', '--mint'], 'Highlight'),
      warn: themeValue(style, ['--state-warn'], 'Highlight'),
      bad: themeValue(style, ['--red'], 'Highlight')
    });
    return themeCache;
  };
  const invalidateTheme = () => { themeCache = null; };
  if (typeof global.addEventListener === 'function')
    global.addEventListener('openlive:appearancechange',invalidateTheme);

  /* ------------------------------------------------------ emitter physics
     Linear-light chromaticities. Red+Green+Blue at full sums to (1,1,1) - a
     neutral white - which a hand-tuned table does not do; the previous file's
     palette drifted blue at full RGB, and open white is the single most
     looked-at state in any preview. */
  const emitterColors = {red:'#ff3157', green:'#2fffa0', blue:'#3b82ff', white:'#f7fbff',
    amber:'#ffae32', uv:'#9b5cff', lime:'#b9ff3f', 'cold-white':'#dff5ff', 'warm-white':'#ffd8a6'};
  /* The physical hues above are the auditable block. Mixing has to happen in
     linear light or red+green+blue does not sum to a neutral white, so each is
     converted ONCE at load into a normalised triple. No second palette: these
     are the same nine colours, in the form the fold needs. */
  const EMITTERS = Object.freeze(Object.keys(emitterColors).reduce((out, key) => {
    const hex = emitterColors[key].slice(1);
    const raw = [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
    const peak = Math.max(...raw) || 1;
    out[key] = raw.map(component => component / peak);
    return out;
  }, {}));
  const SUBTRACTIVE = Object.freeze({ cyan: 0, magenta: 1, yellow: 2 });
  const ADDITIVE_KEYS = Object.freeze(Object.keys(EMITTERS));

  /* Per-profile channel index. Built once and cached on profile identity - a
     WeakMap, so a discarded profile does not pin its index in memory. */
  const indexCache = new WeakMap();
  function channelIndex(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const cached = indexCache.get(profile);
    if (cached) return cached;
    const channels = (profile && profile.channels) || [];
    const index = {
      dimmer: [], shutter: [], additive: [], subtractive: [], cct: [],
      pan: null, tilt: null, zoom: null, iris: null, frost: null,
      gobo: [], prism: [], cells: new Map(), all: channels
    };
    channels.forEach(channel => {
      const semantic = text(channel.semantic || channel.attribute);
      /* CELL MEMBERSHIP IS `channel.cell != null`, NEVER AN ID PREFIX.
         repeated() mints `circuit-N` while cells() mints `cell-N`, so prefix
         matching silently drops every blinder and dimmer pack. */
      if (channel.cell && channel.cell.id) {
        if (!index.cells.has(channel.cell.id)) index.cells.set(channel.cell.id, { cell: channel.cell, channels: [] });
        index.cells.get(channel.cell.id).channels.push(channel);
      }
      if (semantic === 'dimmer' || semantic === 'intensity') index.dimmer.push(channel);
      else if (semantic === 'shutter') index.shutter.push(channel);
      else if (EMITTERS[semantic]) index.additive.push(channel);
      else if (semantic in SUBTRACTIVE) index.subtractive.push(channel);
      else if (semantic === 'cct') index.cct.push(channel);
      else if (semantic === 'pan' && !index.pan) index.pan = channel;
      else if (semantic === 'tilt' && !index.tilt) index.tilt = channel;
      else if (semantic === 'zoom' && !index.zoom) index.zoom = channel;
      else if (semantic === 'iris' && !index.iris) index.iris = channel;
      else if (semantic === 'frost' && !index.frost) index.frost = channel;
      else if (semantic === 'gobo' || semantic === 'gobo-rotation') index.gobo.push(channel);
      else if (semantic === 'prism' || semantic === 'prism-rotation') index.prism.push(channel);
    });
    indexCache.set(profile, index);
    return index;
  }

  /* --------------------------------------------------------- preset values
     MIRRORS gsl5-engine.js fixtureSourceLook(). The engine is NOT loaded in
     the SHOWAVE window - index.html loads samples, personalities and this
     file only - so the fold is reproduced here rather than reaching for an
     engine that is not there. tools/test-gsl5-preview.js asserts the two
     agree attribute for attribute across all 56 samples, so the duplication
     cannot drift silently.

     Callers that DO have real evaluated values pass them in as options.values
     and this is never consulted. */
  function presetValues(profile, rawPreset) {
    const preset = ['full', 'blackout', 'white', 'home'].includes(rawPreset) ? rawPreset : 'full';
    const channels = (profile && profile.channels) || [], values = {};
    channels.forEach(channel => {
      if (!Object.prototype.hasOwnProperty.call(values, channel.attribute))
        values[channel.attribute] = channel.default;
    });
    if (preset === 'home') return values;
    const bySemantic = semantic => channels.filter(c => (c.semantic || c.attribute) === semantic);
    if (preset === 'full') channels.forEach(channel => {
      if (channel.locate != null) values[channel.attribute] = channel.locate;
    });
    if (preset === 'blackout') {
      bySemantic('dimmer').forEach(c => { values[c.attribute] = 0; });
      bySemantic('intensity').forEach(c => { values[c.attribute] = 0; });
      return values;
    }
    bySemantic('dimmer').forEach(c => { values[c.attribute] = 1; });
    bySemantic('intensity').forEach(c => { values[c.attribute] = 1; });
    if (bySemantic('red').length && bySemantic('green').length && bySemantic('blue').length)
      ['red', 'green', 'blue'].forEach(s => bySemantic(s).forEach(c => { values[c.attribute] = 1; }));
    if (bySemantic('cyan').length && bySemantic('magenta').length && bySemantic('yellow').length)
      ['cyan', 'magenta', 'yellow'].forEach(s => bySemantic(s).forEach(c => { values[c.attribute] = 0; }));
    bySemantic('white').forEach(c => { values[c.attribute] = 1; });
    /* Mirrors the engine: a tuneable-white fixture makes white from its
       cold/warm pair or a CCT control, not from a `white` channel. */
    ['cold-white','warm-white'].forEach(semantic =>
      bySemantic(semantic).forEach(c => { values[c.attribute] = 1; }));
    bySemantic('cct').forEach(c => { values[c.attribute] = 0.5; });
    /* Mirrors gsl5-engine.js shutterRestFraction(): Locate, else the middle
       of a band named Open, else full. The bare fallback of 1 sent every
       shutter without a Locate to its fastest strobe. */
    bySemantic('shutter').forEach(c => { values[c.attribute] = shutterRest(c); });
    return values;
  }

  function shutterRest(channel) {
    if (!channel) return 1;
    if (channel.locate != null) return clamp(channel.locate, 0, 1);
    const fn = ((channel.functions) || []).find(f => /^open$|^open |^open-|shutter open/i.test(`${f.id || ''} ${f.name || ''}`));
    if (!fn) return 1;
    const start = Number(fn.dmxStart) || 0, end = Math.max(start, Number(fn.dmxEnd) || start);
    return clamp((start + (end - start) * 0.5) / 255, 0, 1);
  }

  /* ------------------------------------------------------------- shutter
     Read from the function table, not from a name regex. A sloped range
     (displayStart !== displayEnd) is a RATE in Hz; a flat range is a STATE.
     That distinction is in the data and needs no English word matching, so a
     vendor row labelled "Blitz" behaves correctly. */
  function shutterState(channel, value) {
    const functions = (channel && channel.functions) || [];
    const dmx = clamp(value, 0, 1) * 255;
    for (const fn of functions) {
      const start = Number(fn.dmxStart) || 0, end = Number(fn.dmxEnd) || 0;
      if (dmx < start || dmx > end) continue;
      const from = Number(fn.displayStart) || 0, to = Number(fn.displayEnd) || 0;
      if (from === to) return { gate: from > 0 ? 1 : 0, rate: 0, name: text(fn.name) };
      /* A SWEEP IS ONLY A RATE IF THE PROFILE SAYS IT IS ONE. The built-in
         samples state their strobe range in Hz, so there the sweep IS the
         rate. Avolites R20 states it as a PERCENTAGE of the span and never
         gives Hz at all, so an imported ACME fixture reading 0..100 would
         have rendered as '100Hz' - a number nobody wrote down. Percentage
         sweeps come back as a strobing gate with an unstated rate. */
      const span = end - start || 1;
      const swept = from + (to - from) * ((dmx - start) / span);
      /* A 0..100 span with no stated unit is a percentage by convention (a
         D4 Display="0~100"); the engine's functionIsRate() agrees. */
      if (text(fn.unit) === 'percent' || (from === 0 && to === 100 && !text(fn.unit)))
        return { gate: 1, rate: 0, strobing: true, percent: swept, name: text(fn.name) };
      return { gate: 1, rate: swept, name: text(fn.name) };
    }
    /* No table at all: the channel is an open/closed level, which is what an
       imported D4 without <Function> rows amounts to. */
    return { gate: clamp(value, 0, 1) > 0.03 ? 1 : 0, rate: 0, name: '' };
  }

  /* ------------------------------------------------------------ the fold
     values (0..1 per attribute) + profile -> a Look the renderer can draw.
     No clock is consulted here at all. */
  function evaluateLook(profile, options) {
    const config = options && typeof options === 'object' ? options : {};
    const index = channelIndex(profile);
    const gaps = new Set();
    if (!index || !index.all.length) {
      return { emitters: [], master: 0, beam: null, strobe: null, gaps, empty: true };
    }
    const values = config.values && typeof config.values === 'object'
      ? config.values : presetValues(profile, config.preset);
    const provenance = config.values ? 'live' : 'preset';
    const at = channel => level(values[channel.attribute]);

    /* Master intensity. HTP across every dimmer/intensity channel. */
    let master = index.dimmer.length ? 0 : null;
    index.dimmer.forEach(c => { master = Math.max(master, at(c)); });

    /* Shutter gates the whole fixture and may be strobing. */
    let strobe = null, gate = 1;
    index.shutter.forEach(c => {
      const state = shutterState(c, at(c));
      gate = Math.min(gate, state.gate);
      if (state.rate > 0) strobe = { rate: state.rate, name: state.name };
      else if (state.strobing) {
        /* Strobing, at a rate this profile does not state. */
        strobe = { rate: 0, percent: state.percent, name: state.name };
        gaps.add('strobe rate not in profile');
      }
    });

    /* Emitters: one per cell where the profile has cells, otherwise one for
       the whole fixture. 26 of 56 samples are multi-cell, so this is the
       common path, not a special case. */
    const groups = index.cells.size
      ? [...index.cells.values()].map(entry => ({ cell: entry.cell, channels: entry.channels }))
      : [{ cell: null, channels: index.all }];

    const emitters = groups.map((group, order) => {
      let r = 0, g = 0, b = 0, drive = 0, additive = 0;
      const contributing = [];
      group.channels.forEach(channel => {
        const semantic = text(channel.semantic || channel.attribute);
        const chroma = EMITTERS[semantic];
        if (!chroma) return;
        const amount = at(channel);
        if (amount > 0.004 && contributing.indexOf(semantic) < 0) contributing.push(semantic);
        r += chroma[0] * amount; g += chroma[1] * amount; b += chroma[2] * amount;
        drive = Math.max(drive, amount); additive++;
      });
      /* CCT blends the two white points rather than adding a third colour. */
      index.cct.forEach(channel => {
        if (group.cell && channel.cell !== group.cell) return;
        const warmth = 1 - at(channel), cold = EMITTERS['cold-white'], warm = EMITTERS['warm-white'];
        r += cold[0] * (1 - warmth) + warm[0] * warmth;
        g += cold[1] * (1 - warmth) + warm[1] * warmth;
        b += cold[2] * (1 - warmth) + warm[2] * warmth;
        drive = Math.max(drive, 1); additive++;
      });
      if (!additive) {
        /* A level is known but the profile never says what colour it makes.
           Neutral and flagged is more truthful than picking a colour. */
        r = g = b = 1; drive = 1;
        gaps.add('colour not in profile');
      }
      /* Subtractive flags multiply the complement, matching the engine's own
         open-white convention where CMY at 0 is clear. */
      index.subtractive.forEach(channel => {
        if (group.cell && channel.cell && channel.cell !== group.cell) return;
        const amount = at(channel), slot = SUBTRACTIVE[text(channel.semantic || channel.attribute)];
        if (slot === 0) r *= 1 - amount; else if (slot === 1) g *= 1 - amount; else b *= 1 - amount;
      });
      /* Normalise hue, keep energy separate. */
      const peak = Math.max(r, g, b);
      if (peak > 1) { r /= peak; g /= peak; b /= peak; }
      /* 21 of 56 profiles have no dimmer at all - every pixel bar, matrix and
         zone device. Folding those through a missing dimmer renders them
         black, so their emitter drive IS their level. */
      const intensity = (master == null ? drive : master * (drive > 0 ? 1 : 0) * (additive ? drive : 1)) * gate;
      return {
        r, g, b,
        /* A fixture running on ONE emitter is shown in that emitter's own
           catalogue hue, not in a mix round-tripped through linear light. It is
           the more faithful answer to "what colour is this light making", and
           it keeps the physical palette visible in the output rather than only
           in the source. */
        hex: contributing.length === 1 ? emitterColors[contributing[0]] : '',
        level: clamp(master == null ? drive * gate : master * gate * (additive ? Math.max(drive, 0) : 1), 0, 1),
        x: group.cell && Number.isFinite(Number(group.cell.x)) ? Number(group.cell.x) : order,
        y: group.cell && Number.isFinite(Number(group.cell.y)) ? Number(group.cell.y) : 0,
        id: group.cell ? group.cell.id : 'fixture',
        name: group.cell ? group.cell.name : '',
        raw: intensity
      };
    });

    /* Aiming. Only 8 of 56 samples pan/tilt; the rest have no beam and must
       not be drawn as if they did. 0.5 is the documented mechanical centre. */
    let beam = null;
    if (index.pan || index.tilt) {
      beam = {
        pan: index.pan ? at(index.pan) : 0.5,
        tilt: index.tilt ? at(index.tilt) : 0.5,
        zoom: index.zoom ? at(index.zoom) : null,
        iris: index.iris ? at(index.iris) : null,
        frost: index.frost ? at(index.frost) : null,
        gobo: index.gobo.length ? at(index.gobo[0]) : null
      };
      /* Travel in degrees, when the personality states it (an R20 MIRROR
         line). The engine used to strip this on normalisation and this file
         never read it, so a mover that declared 540/270 was drawn as "travel
         not in profile". Beam angle is still absent from every source. */
      const physical = profile.source && profile.source.physical;
      const panDeg = physical && Number(physical.panDegrees) > 0 ? Number(physical.panDegrees) : null;
      const tiltDeg = physical && Number(physical.tiltDegrees) > 0 ? Number(physical.tiltDegrees) : null;
      beam.travel = panDeg || tiltDeg ? { pan: panDeg, tilt: tiltDeg, movement: text(physical.movement) } : null;
      if (!beam.travel) gaps.add('pan/tilt travel not in profile');
      if (index.zoom) gaps.add('beam angle not in profile');
    }

    return {
      emitters, master, gate, beam, strobe, gaps, provenance,
      cells: index.cells.size, empty: false
    };
  }

  /* ------------------------------------------------------ tinted sprites
     shadowBlur inside a loop was the single most expensive thing in the old
     file, and createRadialGradient per fixture per frame is the other classic
     killer. One alpha sprite is rendered once; tinted copies are cached by a
     quantised colour bucket, so 512 fixtures in a chase reuse a handful. */
  const SPRITE = 64;
  let alphaSprite = null;
  const tintCache = new Map();
  /* The renderer must draw into ANY supplied 2D context, including one from a
     harness with no document at all - tools/test-showave-lighting-p2-guards-preview.js
     supplies exactly that and reaching for document.createElement threw. When
     there is no document there is no sprite cache, and the emitter falls back
     to a flat fill: less pretty, still correct, never a crash. */
  let spritesUnavailable = false;
  const canDrawSprites = () => !spritesUnavailable &&
    !!(global.document && typeof global.document.createElement === 'function');
  function baseSprite() {
    if (alphaSprite) return alphaSprite;
    const canvas = global.document.createElement('canvas');
    canvas.width = canvas.height = SPRITE;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    grad.addColorStop(0, 'white');
    grad.addColorStop(0.35, 'color-mix(in srgb, white 55%, transparent)');
    grad.addColorStop(0.72, 'color-mix(in srgb, white 14%, transparent)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, SPRITE, SPRITE);
    alphaSprite = canvas;
    return canvas;
  }
  function tinted(r, g, b) {
    if (!canDrawSprites()) return null;
    try { if (!baseSprite()) return null; }
    catch (error) { spritesUnavailable = true; alphaSprite = null; return null; }
    const key = (Math.round(r * 15) << 8) | (Math.round(g * 15) << 4) | Math.round(b * 15);
    const hit = tintCache.get(key);
    if (hit) return hit;
    const canvas = global.document.createElement('canvas');
    canvas.width = canvas.height = SPRITE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(baseSprite(), 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = `rgb(${Math.round(clamp(r, 0, 1) * 255)},${Math.round(clamp(g, 0, 1) * 255)},${Math.round(clamp(b, 0, 1) * 255)})`;
    ctx.fillRect(0, 0, SPRITE, SPRITE);
    if (tintCache.size > 96) tintCache.delete(tintCache.keys().next().value);
    tintCache.set(key, canvas);
    return canvas;
  }

  /* Resolume-style rule applied to GSL5's own vocabulary: these are Lighting
     Source presets, so the badge says SOURCE, not PRESET. */
  const sourcePresetLabel = preset => ({
    full: 'FULL BEAM', white: 'OPEN WHITE', blackout: 'BLACKOUT', home: 'HOME / DEFAULTS'
  })[preset] || 'FULL BEAM';

  const css = (r, g, b, a) =>
    `rgba(${Math.round(clamp(r, 0, 1) * 255)},${Math.round(clamp(g, 0, 1) * 255)},${Math.round(clamp(b, 0, 1) * 255)},${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;

  function fitText(ctx, value, x, y, maxWidth) {
    let label = text(value);
    if (ctx.measureText(label).width <= maxWidth) { ctx.fillText(label, x, y); return; }
    while (label.length > 4 && ctx.measureText(label + '…').width > maxWidth) label = label.slice(0, -1);
    ctx.fillText(label + '…', x, y);
  }

  /* --------------------------------------------------------------- render */
  function drawEmitterArray(ctx, look, box, theme) {
    const emitters = look.emitters;
    const columns = Math.max(1, Math.max(...emitters.map(e => e.x)) + 1);
    const rows = Math.max(1, Math.max(...emitters.map(e => e.y)) + 1);
    /* THE LENS IS NOT THE FIXTURE, AND THE FIXTURE IS NOT THE STAGE.
       Sizing each emitter to its full grid cell and then spreading the glow to
       twice that blew every tile out to flat white: colour, cells and level all
       became unreadable, and blackout looked lit because the body plate filled
       the frame. The emitter now occupies a bounded fraction of its cell and the
       glow is capped to the SHORT side, so a lit fixture reads as a light
       source in a space rather than as a full-frame wash. Measured on the
       contact sheet: >85% of pixels blown out before, single figures after. */
    const gap = Math.max(1, Math.min(6, box.w / (columns * 12)));
    const cw = (box.w - gap * (columns - 1)) / columns;
    const ch = (box.h - gap * (rows - 1)) / rows;
    const single = emitters.length === 1;
    /* A lone emitter is a fixture body, not a panel: cap it so a PAR does not
       become a 320px rectangle. A cell grid fills its cell as it should. */
    const bodyW = single ? Math.min(cw, box.w * 0.30, box.h * 0.52) : cw;
    const bodyH = single ? Math.min(ch, box.h * 0.34) : ch;
    emitters.forEach(emitter => {
      const x = single ? box.x + (box.w - bodyW) / 2 : box.x + emitter.x * (cw + gap);
      const y = single ? box.y + (box.h - bodyH) / 2 : box.y + emitter.y * (ch + gap);
      /* THE BODY IS ALWAYS DRAWN. A dark fixture is a fixture, not an absence,
         and at blackout an operator still needs to see the rig. It is the
         shared surface tokens, held well back in alpha so that a light theme's
         near-white panel reads as an unlit body rather than as a lit one - the
         blackout tile measured 0% blown-out white after this change. */
      ctx.globalAlpha = 0.30; ctx.fillStyle = theme.panel;
      ctx.fillRect(x, y, bodyW, bodyH);
      ctx.globalAlpha = 0.55; ctx.fillStyle = theme.panel2;
      ctx.fillRect(x + bodyW * 0.12, y + bodyH * 0.12, bodyW * 0.76, bodyH * 0.76);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.line; ctx.lineWidth = 1;
      ctx.strokeRect(x + .5, y + .5, bodyW - 1, bodyH - 1);
      if (emitter.level <= 1 / 512) return;
      const sprite = tinted(emitter.r, emitter.g, emitter.b);
      const spread = Math.min(bodyW, bodyH) * (1.6 + emitter.level * 1.5);
      ctx.globalAlpha = clamp(emitter.level * 0.62, 0, 1);
      ctx.globalCompositeOperation = 'lighter';
      if (sprite) ctx.drawImage(sprite, x + bodyW / 2 - spread / 2, y + bodyH / 2 - spread / 2, spread, spread);
      else {
        ctx.fillStyle = css(emitter.r, emitter.g, emitter.b, 0.5);
        ctx.fillRect(x + bodyW / 2 - spread / 2, y + bodyH / 2 - spread / 2, spread, spread);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      /* The lens itself carries the true colour at full saturation. It is the
         one place the operator reads hue, so it is never washed by the glow. */
      const lensW = bodyW * 0.62, lensH = bodyH * 0.62;
      if (emitter.hex && emitter.level > 0.92) ctx.fillStyle = emitter.hex;
      else ctx.fillStyle = css(emitter.r * emitter.level, emitter.g * emitter.level, emitter.b * emitter.level, 1);
      ctx.fillRect(x + (bodyW - lensW) / 2, y + (bodyH - lensH) / 2, lensW, lensH);
    });
  }

  function drawBeamFixture(ctx, look, box, theme, indicative) {
    const emitter = look.emitters[0] || { r: 1, g: 1, b: 1, level: 0 };
    const beam = look.beam;
    /* Pan and tilt are normalised 0..1 about a mechanical centre of 0.5. The
       profile states no travel in degrees, so this is an indicative sweep
       across the box, marked as such - not a claim about real angles. */
    /* With stated travel the sweep is the real angle: pan yaws the head and
       displaces the aim by sin(yaw); tilt sets the throw from its own angle.
       Both are clamped to a quarter turn for the plate, because a 540° pan
       cannot be drawn side-on. Without stated travel the old fixed-fraction
       sweep stands and is marked indicative. */
    const travel = beam.travel, quarter = Math.PI / 2;
    const yaw = travel && travel.pan ? clamp((beam.pan - 0.5) * travel.pan * Math.PI / 180, -quarter, quarter) : null;
    const pitch = travel && travel.tilt ? clamp((beam.tilt - 0.5) * travel.tilt * Math.PI / 180, -quarter, quarter) : null;
    const headX = box.x + box.w * (0.5 + (yaw == null ? (beam.pan - 0.5) * 0.52 : Math.sin(yaw) * 0.26));
    const headY = box.y + box.h * 0.24;
    const throwLen = box.h * (pitch == null ? 0.42 + (1 - beam.tilt) * 0.5 : clamp(0.67 - 0.5 * Math.sin(pitch), 0.15, 0.95));
    const aimX = headX + (yaw == null ? (beam.pan - 0.5) * box.w * 0.5 : Math.sin(yaw) * box.w * 0.3);
    const aimY = headY + throwLen;
    const spread = box.w * (beam.zoom == null ? 0.13 : 0.05 + beam.zoom * 0.22)
      * (beam.iris == null ? 1 : 0.35 + beam.iris * 0.65);

    if (emitter.level > 1 / 512) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      /* The cone IS the scatter integral - falloff lives in the two stops,
         so there is no separate haze pass and no per-pixel work. */
      ctx.globalAlpha = clamp(emitter.level * 0.5, 0, 1);
      ctx.beginPath();
      ctx.moveTo(headX, headY);
      ctx.lineTo(aimX - spread, aimY);
      ctx.lineTo(aimX + spread, aimY);
      ctx.closePath();
      ctx.fillStyle = css(emitter.r, emitter.g, emitter.b, 0.5);
      ctx.fill();
      ctx.globalAlpha = 1;
      const pool = tinted(emitter.r, emitter.g, emitter.b);
      const poolW = spread * 2.4, poolH = poolW * 0.42;
      ctx.globalAlpha = clamp(emitter.level, 0, 1);
      if (pool) ctx.drawImage(pool, aimX - poolW / 2, aimY - poolH / 2, poolW, poolH);
      else {
        ctx.fillStyle = css(emitter.r, emitter.g, emitter.b, 0.55);
        ctx.beginPath(); ctx.ellipse(aimX, aimY, poolW / 2, poolH / 2, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    if (indicative) {
      /* Dashed rim = the geometry is indicative because the profile does not
         carry a beam angle. A solid rim would assert a number nobody has. */
      ctx.save();
      ctx.setLineDash([3, 3]); ctx.strokeStyle = theme.dim; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(aimX, aimY, spread * 1.2, spread * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    /* Yoke and head, drawn from the real aim. */
    ctx.strokeStyle = theme.line; ctx.lineWidth = Math.max(2, box.w * 0.018);
    ctx.beginPath();
    ctx.moveTo(box.x + box.w * 0.5, box.y + box.h * 0.06);
    ctx.lineTo(headX, headY - box.h * 0.07);
    ctx.stroke();
    ctx.fillStyle = theme.panel2; ctx.strokeStyle = theme.line; ctx.lineWidth = 1;
    const hw = Math.max(6, box.w * 0.11), hh = Math.max(5, box.h * 0.09);
    ctx.fillRect(headX - hw / 2, headY - hh, hw, hh);
    ctx.strokeRect(headX - hw / 2 + .5, headY - hh + .5, hw - 1, hh - 1);
    ctx.fillStyle = css(emitter.r, emitter.g, emitter.b, clamp(0.3 + emitter.level * 0.7, 0, 1));
    ctx.fillRect(headX - hw / 2 + 2, headY - 3, hw - 4, 3);
  }

  function drawFixture(ctx, look, box, theme) {
    if (look.empty) return;
    if (look.beam) drawBeamFixture(ctx, look, box, theme, look.gaps.has('beam angle not in profile') || look.beam.zoom == null);
    else drawEmitterArray(ctx, look, box, theme);
  }

  function drawContext(ctx, profile, width, height, seconds, options) {
    const w = Math.max(1, Number(width) || ctx.canvas.width || 1);
    const h = Math.max(1, Number(height) || ctx.canvas.height || 1);
    const theme = resolveTheme();
    const config = options && typeof options === 'object' ? options : {};
    const quantity = Math.max(1, Math.min(512, Math.round(Number(config.quantity) || 1)));
    const effectCount = Math.max(0, Math.min(99, Math.round(Number(config.effectCount) || 0)));
    const preset = ['full', 'white', 'blackout', 'home'].includes(config.sourcePreset) ? config.sourcePreset : 'full';

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, w, h);

    if (!profile || !((profile.channels || []).length)) {
      ctx.fillStyle = theme.dim;
      ctx.font = `600 ${Math.max(10, h * 0.055)}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(profile ? 'This binding carries no profile. Nothing to preview'
        : 'Select a fixture personality', w / 2, h / 2);
      ctx.restore();
      return;
    }

    const look = evaluateLook(profile, { preset, values: config.values });

    /* THE ONLY CLOCK IN THIS FILE. A strobing shutter is a real, timed thing
       and the rate comes from the profile's own function table. Above a third
       of the display rate the plate is HELD STEADY and the number is read out
       instead, because a 25 Hz strobe sampled at 60 Hz is a lie about the
       beat the operator would see. */
    let strobeGate = 1, strobeNote = '';
    if (look.strobe && look.strobe.rate > 0) {
      const rate = look.strobe.rate;
      if (rate * 3 >= 60) strobeNote = `STROBE ${Math.round(rate)}Hz · faster than display`;
      else {
        strobeGate = ((Number(seconds) || 0) * rate) % 1 < 0.42 ? 1 : 0.06;
        strobeNote = `STROBE ${Math.round(rate)}Hz`;
      }
    } else if (look.strobe) {
      /* Strobing at a rate the profile never states. The plate is held
         steady and the readout names the figure that is missing; picking a
         plausible Hz would be the fabrication this renderer exists to
         remove. */
      strobeNote = `STROBE ${Math.round(clamp(look.strobe.percent, 0, 100))}% · rate unavailable`;
    }
    if (strobeGate !== 1) look.emitters.forEach(e => { e.level *= strobeGate; });

    const top = Math.max(16, h * 0.13), bottom = Math.max(20, h * 0.19);
    const stage = { x: w * 0.04, y: top, w: w * 0.92, h: Math.max(14, h - top - bottom) };

    /* Quantity ledger: draw real fixtures up to a legible count, then say
       plainly how many more there are rather than pretending to draw 512. */
    const drawn = Math.min(quantity, 24);
    if (drawn === 1) drawFixture(ctx, look, stage, theme);
    else {
      const aspect = stage.w / Math.max(1, stage.h);
      const columns = Math.max(1, Math.ceil(Math.sqrt(drawn * aspect)));
      const rows = Math.ceil(drawn / columns);
      const gap = Math.max(2, Math.min(8, stage.w * 0.014));
      const tw = (stage.w - gap * (columns - 1)) / columns;
      const th = (stage.h - gap * (rows - 1)) / rows;
      for (let i = 0; i < drawn; i++) {
        const box = {
          x: stage.x + (i % columns) * (tw + gap),
          y: stage.y + Math.floor(i / columns) * (th + gap),
          w: tw, h: th
        };
        drawFixture(ctx, look, box, theme);
      }
    }

    /* A dark stage and a stage that is merely at defaults look alike, and
       neither is distinguishable from "the preview is broken". Both states say
       their own name over the render rather than leaving the operator to infer
       it from an absence of light. */
    if (preset === 'blackout' && look.provenance !== 'live') {
      /* BELOW the fixture, not across it. Centred over the body, the word ran
         onto the unlit plate at both ends and the middle letters were the only
         ones with contrast behind them - it read "LACKOU". */
      ctx.fillStyle = theme.text;
      ctx.font = `800 ${Math.max(12, h * 0.085)}px ui-monospace,monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('BLACKOUT', w / 2, stage.y + stage.h * 0.94);
    } else if (preset === 'home' && look.provenance !== 'live') {
      ctx.strokeStyle = theme.accent; ctx.lineWidth = Math.max(1, w * 0.004);
      ctx.beginPath();
      ctx.moveTo(w * 0.44, stage.y + stage.h * 0.44); ctx.lineTo(w * 0.56, stage.y + stage.h * 0.44);
      ctx.moveTo(w * 0.5, stage.y + stage.h * 0.38); ctx.lineTo(w * 0.5, stage.y + stage.h * 0.50);
      ctx.stroke();
      ctx.fillStyle = theme.accent;
      ctx.font = `800 ${Math.max(10, h * 0.065)}px ui-monospace,monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('HOME', w / 2, stage.y + stage.h * 0.94);
    }

    /* ------------------------------------------------------------ chrome */
    const chip = (label, x, y, fg, filled) => {
      ctx.font = `700 ${Math.max(7, Math.min(11, h * 0.05))}px ui-monospace,monospace`;
      const tw = ctx.measureText(label).width + 10, th = Math.max(13, h * 0.085);
      ctx.fillStyle = filled || 'transparent';
      if (filled) ctx.fillRect(x, y, tw, th);
      ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, tw - 1, th - 1);
      ctx.fillStyle = fg; ctx.textAlign = 'center';
      ctx.fillText(label, x + tw / 2, y + th * 0.7);
      return tw + 4;
    };

    /* The right-hand safety badge is measured FIRST and its edge becomes a
       hard wall for the left chip run. Growing the run blindly rightwards
       printed "STROBE 25Hz · faster than display" straight through
       "PREVIEW ONLY · NO DMX" - two claims occupying the same pixels, which is
       worse than dropping one. A chip that will not fit is not drawn, and the
       row that owns the fixture's name carries the overflow instead. */
    const hazardous = /hazardous/.test(text(profile.source && profile.source.safety));
    const badge = hazardous ? 'VERIFY HAZARD' : 'PREVIEW ONLY · NO DMX';
    ctx.font = `700 ${Math.max(7, Math.min(11, h * 0.05))}px ui-monospace,monospace`;
    const bw = ctx.measureText(badge).width + 12, bh = Math.max(13, h * 0.085);
    ctx.strokeStyle = hazardous ? theme.bad : theme.good; ctx.lineWidth = 1;
    ctx.strokeRect(w - bw - 6.5, 5.5, bw - 1, bh - 1);
    ctx.fillStyle = hazardous ? theme.bad : theme.good; ctx.textAlign = 'center';
    ctx.fillText(badge, w - bw / 2 - 6, 5 + bh * 0.7);

    /* One gutter, not two: reserving 12px on both sides of the wall cost the
       most important chip its place by two pixels, so "SOURCE · OPEN WHITE"
       vanished while the shorter "×2" and "FX STACK · 3" beside it survived.

       AND ONCE ONE CHIP IS DROPPED, NO LATER ONE IS DRAWN. Chips are added in
       priority order, so back-filling the gap with a shorter, less important
       chip would show the operator the secondary fact while hiding the primary
       one - a worse failure than an empty strip. */
    /* One gutter, not two: reserving 12px on both sides cost the most important
       chip its place by two pixels, so "SOURCE · OPEN WHITE" vanished while the
       shorter "×2" beside it survived.

       AND THE SOURCE LABEL WRAPS RATHER THAN DISAPPEARING. "SOURCE · HOME /
       DEFAULTS" simply does not fit beside the safety badge on a 320px canvas,
       and both facts matter: one is the state, the other is the promise that no
       DMX is leaving. So a chip that will not fit on the badge row moves to a
       second row, which has the full width to itself. Only when that row is
       also full does the run stop - and it stops for good, because back-filling
       with a shorter, lower-priority chip would hide the primary fact behind
       the secondary one. */
    const rowH = Math.max(13, h * 0.085) + 3;
    let cursor = 4, row = 0, full = false;
    const add = (label, fg) => {
      if (!label || full) return;
      ctx.font = `700 ${Math.max(7, Math.min(11, h * 0.05))}px ui-monospace,monospace`;
      const width = ctx.measureText(label).width + 10;
      const wall = row === 0 ? w - bw - 5 : w - 4;
      if (cursor + width > wall) {
        if (row > 0 || 4 + width > w - 4 || h < 96) { full = true; return; }
        row = 1; cursor = 4;
      }
      cursor += chip(label, cursor, 5 + row * rowH, fg);
    };
    add(look.provenance === 'live' ? 'LIVE VALUES' : `SOURCE · ${sourcePresetLabel(preset)}`,
      look.provenance === 'live' ? theme.good : theme.accent);
    if (quantity > 1) add(`×${quantity}${quantity > drawn ? ` · ${drawn} shown` : ''}`, theme.text);
    if (effectCount) add(`FX STACK · ${effectCount}`, theme.accent);
    if (strobeNote) add(strobeNote, theme.warn);

    /* What the profile does not say is stated, not invented. */
    if (look.gaps.size && h > 90) {
      ctx.textAlign = 'right'; ctx.fillStyle = theme.dim;
      ctx.font = `500 ${Math.max(7, h * 0.038)}px system-ui,sans-serif`;
      ctx.fillText('indicative: ' + [...look.gaps][0], w - 8, h - bottom * 0.15);
    }

    ctx.textAlign = 'left'; ctx.fillStyle = theme.text;
    ctx.font = `700 ${Math.max(9, h * 0.058)}px system-ui,sans-serif`;
    fitText(ctx, profile.name || profile.id, 8, h - bottom + Math.max(11, bottom * 0.44), w * 0.6);
    ctx.fillStyle = theme.dim;
    ctx.font = `500 ${Math.max(7, h * 0.04)}px system-ui,sans-serif`;
    fitText(ctx, `${text(profile.source && profile.source.category || 'Fixture')} · ${profile.mode || ''}`
      + (look.cells ? ` · ${look.cells} cells` : ''), 8, h - 7, w * 0.7);
    ctx.textAlign = 'right'; ctx.fillStyle = theme.accent;
    ctx.font = `700 ${Math.max(8, h * 0.048)}px ui-monospace,monospace`;
    ctx.fillText(`${Number(profile.footprint) || 1} CH`, w - 8, h - 7);
    ctx.restore();
  }

  function draw(canvas, profile, seconds, options) {
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width || canvas.clientWidth || 320);
    const height = Math.max(1, rect.height || canvas.clientHeight || 180);
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const pw = Math.round(width * dpr), ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    drawContext(canvas.getContext('2d'), profile, pw, ph, seconds, options);
    return true;
  }

  const semantics = profile => [...new Set(((profile && profile.channels) || [])
    .map(channel => channel.semantic || channel.attribute).filter(Boolean))];
  const cells = profile => {
    const found = new Map();
    ((profile && profile.channels) || []).forEach(channel => {
      const cell = channel && channel.cell;
      if (cell && cell.id && !found.has(cell.id)) found.set(cell.id, cell);
    });
    return [...found.values()];
  };

  const api = Object.freeze({ draw, drawContext, semantics, cells, evaluateLook, presetValues, shutterState });
  global.ShowaveGSL5Preview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
