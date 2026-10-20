/* ===========================================================================
   arena-shortcuts.js — the shipped shortcut presets and the DMX fixture,
   read as data rather than retyped as data.
   ---------------------------------------------------------------------------
   Resolume keeps external control in one place: a Shortcut is a target path
   plus a physical trigger plus a handful of modes. Keyboard, MIDI, OSC and DMX
   all use THE SAME schema — only the root element, the manager name and the
   contents of RawInputMessage/@key change. That is why this file has one core
   reader and four thin wrappers rather than four parsers.

   Two things make the shortcut format worth reading at all:

     1. A SHORTCUT PATH IS AN OSC ADDRESS. osc.htm: "The addresses are all
        fixed and set up already... Unlike MIDI and keyboard shortcuts, that
        require you to first link a control to a specific shortcut." The path
        grammar in the preset files is the same address space, which means
        arena-engine.js — whose every parameter already carries an OSC-style
        `home` — is one lookup away from being drivable by these files.
        resolveTarget() below is that lookup, and section 4 is where the two
        addressings are reconciled, difference by difference.

     2. THE PRESETS ARE FOUR SCHEMA VINTAGES. The five files that ship were
        written by Arena 6.0, Avenue 7.0, Arena 7.0, Arena 7.10 and Arena 7.24.
        uniqueId is absent in the v6 file; Subtarget is type 0 there and type 5
        everywhere else; NamedValues is <namedValues> in v6; ValueRange is
        named "range" in v6 and unnamed after; paramNodeName / inputDeviceName /
        outputDeviceName only exist from 7.24. The reader tolerates all of it
        and records what it saw, so a row never silently loses information.

   Nothing here is inferred beyond what section 2 explicitly marks as inferred.
   Where the shipped data cannot decide a question — Piano, Value, Velocity,
   Button, Fake Relative, Loop, the fixture's Distribution ids, the 0x20 (32)
   translation form — this file says so instead of guessing.

   Manual source: C:\Program Files\Resolume User Manual HTML files —
   keyboard-shortcuts.htm, midi-shortcuts.htm, dmx-shortcuts.htm, osc.htm,
   dmx.htm, fixture-editor.htm, bpm.htm.
   =========================================================================== */
(() => {
'use strict';

/* =========================================================================
   1. XML
   A reader instead of DOMParser, because this file has to give the same
   answer in the page and in a plain script runner used to check it against
   the real presets. That is only safe because the files are machine written:
   no CDATA, no comments, every attribute double quoted, and — verified across
   all five presets — &amp; is the one entity that ever appears.
   ========================================================================= */
const ENT = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'"};
const unesc = s => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+);/g,
  (m, e) => e[0] === '#' ? String.fromCharCode(+e.slice(1)) : ENT[e]);

function attrsOf(src){
  const out = {}; if(!src) return out;
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g; let m;
  while((m = re.exec(src))) out[m[1]] = unesc(m[2]);
  return out;
}
function readXML(text){
  const TAG = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const root = {tag:'#document', attr:{}, kids:[]}, stack = [root];
  let m;
  while((m = TAG.exec(text))){
    if(m[0][1] === '?' || m[0][1] === '!') continue;      // declaration / comment
    if(m[1]){ if(stack.length > 1) stack.pop(); continue; }
    const node = {tag:m[2], attr:attrsOf(m[3]), kids:[]};
    stack[stack.length - 1].kids.push(node);
    if(!m[4]) stack.push(node);
  }
  return root.kids[0] || root;
}
const kidsOf = (n, tag) => !n ? [] : n.kids.filter(k => !tag || k.tag === tag);
const kidOf  = (n, tag) => kidsOf(n, tag)[0] || null;
const num    = (v, d) => (v == null || v === '' || isNaN(+v)) ? d : +v;

/* =========================================================================
   2. behaviour — the bitfield on every <Shortcut>
   ---------------------------------------------------------------------------
   Every value that occurs across the 270 shipped shortcuts:

       0        keyboard, a plain toggle on a bool             (4 rows)
       1024     keyboard, an event/trigger                    (32 rows)
       4098     keyboard, Mouse mode horizontal                (2 rows)
       12290    keyboard, Mouse mode vertical                  (1 row)
       14338    keyboard, Mouse vertical + invert              (3 rows)
       4        MIDI Note driving a value                     (17 rows)
       8        MIDI CC driving a value                       (43 rows)
       1028     MIDI Note driving an event                   (156 rows)
       1032     MIDI CC driving an event                      (10 rows)
       16392    MIDI CC, Relative rotary -> tempo              (1 row)
       2113544  MIDI CC, Relative rotary -> clip playhead      (1 row)

   PROVEN:
     0x400  = the target is a ParamEvent, a trigger rather than a value.
              APC MINI MK II.xml (7.24) is the only preset that writes
              paramNodeName, and its 72 ParamEvent rows are exactly its 72
              rows carrying 0x400. The 18 rows without it are its 9
              RangedParam[bool] and 9 ParamRange rows.
     0x4    = MIDI Note. 0x8 = MIDI CC. Checked row by row against the status
              nibble packed into the key: every 0x4 row is 0x9n, every 0x8 row
              is 0xBn, no exceptions in 228 MIDI rows. This is the situation
              midi-shortcuts.htm warns about — "some controllers, like for
              instance the Korg NanoKontrol series, can send out CCs when you
              press a button" — and Nano Kontrol 2.xml is 25 CC rows, 10 of
              them events, exactly as described.
     0x4000 = Relative rotary. Set on precisely the two rows whose
              numSteps x value = ±1, which is midi-shortcuts.htm's pair of
              interdependent controls: "you can change the responsiveness of
              the rotary by changing the amount of Steps... or its Step Size".

   INFERRED — flagged as such at runtime, never presented as fact:
     0x1002 = Mouse mode. keyboard-shortcuts.htm > Mouse Mode uses this file's
              own example: "you can assign the P key to a clip's Position X...
              Assign the P key to Position Y also. Switch to Mouse mode, but
              now switch to Vertical." Default.xml binds P twice, positionx at
              0x1002 and positiony at 0x3002. 0x2 and 0x1000 are set together
              on all six mouse rows and on nothing else, so they cannot be
              separated; treat the pair as one marker.
     0x2000 = Vertical (the bit that separates the two P rows).
     0x800  = Invert. Set on exactly three rows — layer volume, layer master,
              layer opacity — all vertical mouse faders where mouse-up must
              raise the value. positiony is also vertical and does NOT carry
              it, because dragging down should move the clip down.

   UNDECIDED: 0x200000, the single extra bit on the relative clip-playhead
   scratch. midi-shortcuts.htm offers two candidates that both apply to a
   Relative rotary — Loop ("loop back to the beginning when it reaches the
   end") and Fake Relative. Loop is the better fit for scratching a playhead
   and nonsense for BPM, but the files do not decide it.

   NOT PRESENT ANYWHERE: Piano, Value, Velocity, Button, Fake Relative, Loop
   as an explicit flag. Their bit positions are unknown and are not guessed.
   ========================================================================= */
const BEHAVIOUR = {
  MIDI_NOTE: 0x4,        // proven
  MIDI_CC:   0x8,        // proven
  EVENT:     0x400,      // proven
  INVERT:    0x800,      // inferred
  MOUSE:     0x1002,     // inferred, 0x2 and 0x1000 inseparable
  VERTICAL:  0x2000,     // inferred
  RELATIVE:  0x4000,     // proven
  RELATIVE_EXTRA: 0x200000  // undecided: Loop or Fake Relative
};
const KNOWN_BITS = 0x4 | 0x8 | 0x400 | 0x800 | 0x1002 | 0x2000 | 0x4000 | 0x200000;

function decodeBehaviour(raw){
  const b = num(raw, 0), has = m => (b & m) === m;
  const mouse = has(BEHAVIOUR.MOUSE), relative = has(BEHAVIOUR.RELATIVE);
  return {
    raw: b,
    event:    has(BEHAVIOUR.EVENT),        // proven
    note:     has(BEHAVIOUR.MIDI_NOTE),    // proven
    cc:       has(BEHAVIOUR.MIDI_CC),      // proven
    relative,                              // proven
    mouse,                                 // inferred
    axis:     mouse ? (has(BEHAVIOUR.VERTICAL) ? 'vertical' : 'horizontal') : null, // inferred
    invert:   has(BEHAVIOUR.INVERT),       // inferred
    relativeExtra: has(BEHAVIOUR.RELATIVE_EXTRA),  // undecided
    /* anything we cannot name is surfaced, not swallowed */
    unknownBits: b & ~KNOWN_BITS,
    inferred: ['mouse', 'axis', 'invert'],
    undecided: has(BEHAVIOUR.RELATIVE_EXTRA)
      ? ['0x200000: Loop or Fake Relative; the files do not decide it'] : []
  };
}

/* Subtarget — how the shortcut addresses a Shortcut Group or a slider
   (keyboard-shortcuts.htm > Shortcut Groups). Only three combinations occur;
   the manual's Select Next / Select Previous / Random Item are never used by a
   shipped preset, so their numeric codes are unknown and are not invented. */
const SUBTARGET = {
  0: 'none (v6; Arena.exe carries V6Tov7::fixSubtarget for this)',
  1: 'direct item: pick option optionIndex of the control group',
  5: "the parameter's own value: the ordinary slider case"
};

/* The clip feedback states, spelled exactly as the files spell them.
   midi-shortcuts.htm > MIDI Out: "a clip in Resolume can have a whopping 5
   states." The 7.0-era presets write six entries, adding `Off`; the 7.24
   preset writes exactly the five the manual names. */
const FEEDBACK_STATES = ['Off', 'Empty', 'Disconnected', 'Previewing',
                         'Connected', 'Connected & previewing'];

/* =========================================================================
   3. RawInputMessage/@key — the packed 64-bit trigger
   ---------------------------------------------------------------------------
   Both protocols use the same shape: the low half is the message, the high
   half is what kind it is and where it came from.

   KEYBOARD  key = (juceKeyCode << 32) | modifierMask
     The high word is JUCE's KeyPress::getKeyCode(), which for printable keys
     is the ASCII code of the UPPERCASE character — not a Windows virtual key.
     Default.xml's codes are 32 44 46 47 49-57 65 66 69 71 73 77 80-89, i.e.
     Space , . / 1-9 A B E G I M P Q R S T U V W X Y. Special keys are
     winVK | 0x10000 (JUCE's extendedKeyModifier); the shipped file uses two,
     0x10025 and 0x10027 = Left and Right.
     The low word is JUCE ModifierKeys: 1 shift, 2 ctrl, 4 alt, 8 cmd. Only
     0 (26 rows), 1 (14 rows) and 3 (2 rows) occur.

   MIDI      key = (msgClass << 56) | (deviceId << 16) | (data1 << 8) | status
     bits 0-7   MIDI status byte — 0x90/0x91/0x92 Note On ch1-3, 0xB0-0xB2 CC
     bits 8-15  note number / CC number
     bits 16-55 40-bit device id; 0 is Any Device. midi-shortcuts.htm:
                "Resolume is able to discern which device a MIDI message came
                from." Only APC MINI MK II.xml names a device
                (0xEB6C21CA00 = "APC mini mk2 Control"); the other three
                presets are Any Device throughout.
     bits 56-63 message class — 1 Note, 2 CC. Redundant with the status
                nibble, and consistent with it on all 228 MIDI rows.

   BigInt is not optional here: the MIDI keys reach 1.44e17, well past 2^53.
   ========================================================================= */
const MOD_BITS = [[1,'Shift'], [2,'Ctrl'], [4,'Alt'], [8,'Cmd']];
/* Documented Windows virtual-key constants for the extended keys. Only Left
   and Right are exercised by the shipped preset; Up and Down are listed
   because they are the same constant block, and anything else falls back to
   its hex code rather than being named. */
const VK = {0x25:'Left', 0x26:'Up', 0x27:'Right', 0x28:'Down'};

function decodeKeyboardKey(key){
  const k = BigInt(key);
  const code = Number(k >> 32n), mask = Number(k & 0xFFFFFFFFn);
  const extended = !!(code & 0x10000), vk = code & 0xFFFF;
  const name = extended
    ? (VK[vk] || 'VK 0x' + vk.toString(16))
    : (code >= 32 && code < 127 ? String.fromCharCode(code) : 'code ' + code);
  const mods = {};
  MOD_BITS.forEach(([bit, n]) => mods[n.toLowerCase()] = !!(mask & bit));
  const label = MOD_BITS.filter(([bit]) => mask & bit).map(([, n]) => n)
                  .concat(name === ' ' ? 'Space' : name).join('+');
  return {type:'key', raw:String(key), code, vk, extended, key:name,
          mods, modifierMask:mask, label};
}

function decodeMidiKey(key){
  const k = BigInt(key);
  const cls    = Number(k >> 56n);
  const device = (k >> 16n) & 0xFFFFFFFFFFn;
  const data1  = Number((k >> 8n) & 0xFFn);
  const status = Number(k & 0xFFn);
  const kind   = (status >> 4) === 0x9 ? 'note' : (status >> 4) === 0xB ? 'cc' : 'status 0x' + status.toString(16);
  const channel = (status & 0x0F) + 1;
  return {
    type: kind, raw:String(key), messageClass:cls, status, channel, data1,
    device: Number(device), deviceHex:'0x' + device.toString(16).toUpperCase(),
    anyDevice: device === 0n,
    label: (kind === 'note' ? 'Note ' : kind === 'cc' ? 'CC ' : '') + data1 + ' ch' + channel
  };
}

/* RawInputMessage/@value carries two different things depending on 0x4000.
   Absolute: the cached last MIDI data byte over 127 — every one of the 226
   absolute rows in the shipped presets multiplies back to an exact integer.
   Relative: the step size, with numSteps x value = ±1 exactly. The APC40 MkII
   tempo rotary is 480 steps of -1/480, and the BPM range is 20-500, so that is
   one BPM per detent, inverted. */
function decodeValue(valueAttr, stepsAttr, relative){
  const v = num(valueAttr, 0), steps = num(stepsAttr, null);
  if(relative) return {mode:'relative', step:v, steps, product: steps == null ? null : steps * v};
  const data = v * 127;
  return {mode:'absolute', normalised:v, data:Math.round(data),
          exact: Math.abs(data - Math.round(data)) < 1e-6, steps};
}

/* =========================================================================
   4. TARGETS — the bridge between Resolume addressing and ours
   ---------------------------------------------------------------------------
   A shortcut path is an OSC address (osc.htm), and every parameter in
   arena-engine.js already carries an OSC-style `home`, so most of this table
   is the identity. resolveTarget() exists for the places where it is NOT, and
   those places are worth naming one by one, because each is a real difference
   in the two models rather than a naming accident:

   IDENTICAL — the engine home is the Resolume path, character for character
     /composition/master                       /composition/bypassed
     /composition/layers/N/master              /composition/layers/N/bypassed
     /composition/layers/N/solo                /composition/layers/N/video/opacity
     /composition/layers/N/audio/volume        /composition/columns/N/connected
     ...and in general anything under layers/N/{video,audio}/ or groups/N/.

   RENAMED — same idea, different spelling
     /composition/tempocontroller/tempo   ->  /composition/tempo/bpm
        Resolume normalises this into 0..1 over its BPM range; the engine keeps
        BPM as a number with min 20 and max 500, which are the same bounds, so
        EN.applyNormalised does the conversion with nothing left over.
     /composition/dashboard/linkN         ->  /composition/dashboard/N
     /composition/layers/N/dashboard/link1->  /composition/layers/N/dashboard/1
        dashboard.htm's eight dials. Resolume's `link` prefix is dropped
        because dashboardBlock() indexes the dials directly.
     .../video/effects/transform/positionx ->  .../transform/x
     .../video/effects/transform/positiony ->  .../transform/y
        In Resolume the Transform is the fixed first entry of the video effect
        chain and is addressed through it; transform.htm says it is
        "automatically applied to each clip, layer and group as well as to the
        entire composition", so the engine models it as a sibling block, not as
        an effect. Only positionx and positiony occur in the shipped data —
        the Resolume names for the engine's scale/rot/anchor keys are NOT in
        these files and are not guessed at here.

   RESHAPED — the engine needs more of the path than Resolume gives
     /composition/layers/N/clips/C/...    ->  /composition/decks/D/layers/N/clips/C/...
        clips.htm's decks are a real axis in the engine: a clip lives in a
        deck. Resolume's shortcut address is deck-relative and always means the
        current deck, so the engine home carries a {deck} placeholder that
        homeFor() fills from EN.deck(). (Persistent clips are the reason this
        cannot simply be assumed: EN.clip() may hand back a clip that lives in
        a different deck entirely.)

   VERBS, NOT PARAMETERS — Resolume exposes these as ParamEvents at an address;
   the engine exposes them as API calls, so there is no home to bind to
     /composition/disconnectall            EN.ejectAll()
     /composition/layers/N/clear           EN.eject(N)
     /composition/layers/N/clips/C/connect EN.triggerClip(N, C)
     /composition/columns/N/connect        EN.triggerColumn(N)
     /composition/tempocontroller/tempotap EN.tap()
     /composition/tempocontroller/resync   EN.resync()
     /composition/selectnextdeck           EN.selectDeck(EN.deck() + 1)
     /composition/connectnextcolumn        EN.triggerColumn(next column)
     /composition/layers/N/connectnextclip EN.triggerClip(N, next column)
        The engine has no next/prev helpers; the caller derives the index from
        EN.selection.column / EN.columns().length. Stated rather than faked.

   SELECTION, NOT PARAMETERS
     /composition/select, /composition/layers/N/select
        The engine keeps selection in EN.selection (layer and clip are objects,
        column is a number), not as parameters, so these bind to an assignment.

   READ-BACKS — the sibling paths that drive MIDI pad colour
     .../connected, .../selected, .../soloed. Resolume splits the write verb
     from the state mirror (connect/connected, select/selected, solo/soloed).
     The engine only splits one of them: columns really do have a `connected`
     event parameter, so /composition/columns/N/connected is identity. Layer
     `soloed` is the engine's own /composition/layers/N/solo — one parameter
     serving both roles. Clip `connected` is not a parameter at all; it is
     EN.layer(N).playing && EN.layer(N).playing.clip.column === C.

   NOT MAPPABLE
     /composition/objects/<uniqueId>/...
        keyboard-shortcuts.htm's "This Clip, Layer or Group" target. The engine
        has no object-id index — nothing assigns or stores those ids — so this
        form resolves to kind 'unmapped'. The one shipped example (the G key,
        object 1505384963468) is dangling anyway: that id appears in no shipped
        composition, Example.avc's ids are all in the 16xxxxxxxxxxx range.
     .../video/effects/<key>/effect/<param>
        Resolume addresses an effect by its key and puts the parameter behind
        an /effect/ segment; the engine addresses it positionally,
        <scope>/effects/video/<slot>/<Display Name>. Binding one to the other
        needs an effect key -> slot lookup that does not exist yet, so this
        resolves to 'unmapped' with the key and parameter parsed out.
   ========================================================================= */

/* Leaf tables. Keys are the remainder of the path after the scope prefix, so
   multi-segment leaves like 'video/opacity' match whole. */
const IDENT = home => ({kind:'param', home});
const ACT   = (action, args, note) => ({kind:'action', action, args, note});

const COMP_LEAF = {
  'master':            IDENT('/composition/master'),
  'bypassed':          IDENT('/composition/bypassed'),
  'speed':             IDENT('/composition/speed'),
  'select':            {kind:'selection', target:'composition',
                        note:'EN.selection has no composition slot; this sets the panel focus'},
  'disconnectall':     ACT('ejectAll', '()'),
  'connectnextcolumn': ACT('triggerColumn', '(EN.selection.column + 1)',
                           'engine has no next/prev column helper'),
  'connectprevcolumn': ACT('triggerColumn', '(EN.selection.column - 1)',
                           'engine has no next/prev column helper'),
  'selectnextdeck':    ACT('selectDeck', '(EN.deck() + 1)'),
  'selectprevdeck':    ACT('selectDeck', '(EN.deck() - 1)')
};
const TEMPO_LEAF = {
  'tempo':    {kind:'param', home:'/composition/tempo/bpm',
               note:'renamed; engine keeps BPM as 20..500, the same bounds Resolume normalises over'},
  'tempotap': ACT('tap', '()', 'bpm.htm > Tap'),
  'resync':   ACT('resync', '()', 'refused while Ableton Link is on, per link.htm')
};
const LAYER_LEAF = {
  'master':          IDENT('{layer}/master'),
  'bypassed':        IDENT('{layer}/bypassed'),
  'solo':            IDENT('{layer}/solo'),
  'soloed':          {kind:'param', home:'{layer}/solo',
                      note:'read-back; the engine has one parameter for both roles'},
  'lock':            IDENT('{layer}/lock'),
  'video/opacity':   IDENT('{layer}/video/opacity'),
  'video/blend':     IDENT('{layer}/video/blend'),
  'audio/volume':    IDENT('{layer}/audio/volume'),
  'audio/pan':       IDENT('{layer}/audio/pan'),
  'crossfadergroup': IDENT('{layer}/crossfadergroup'),
  'maskmode':        IDENT('{layer}/maskmode'),
  'select':          {kind:'selection', target:'layer', note:'EN.selection.layer = EN.layer(N)'},
  'selected':        {kind:'selection', target:'layer', note:'read-back: EN.selection.layer === EN.layer(N)'},
  'clear':           ACT('eject', '(N)', 'layers.htm > Eject'),
  'connectnextclip': ACT('triggerClip', '(N, next column)', 'engine has no next/prev clip helper'),
  'connectprevclip': ACT('triggerClip', '(N, previous column)', 'engine has no next/prev clip helper')
};
const CLIP_LEAF = {
  'connect':   ACT('triggerClip', '(N, C)', 'clips.htm > triggering'),
  'connected': {kind:'derived',
                note:'not a parameter: EN.layer(N).playing && EN.layer(N).playing.clip.column === C'},
  'video/effects/transform/positionx': {kind:'param', home:'{clip}/transform/x',
      note:'Resolume addresses Transform through the effect chain; the engine keeps it as a sibling block'},
  'video/effects/transform/positiony': {kind:'param', home:'{clip}/transform/y',
      note:'Resolume addresses Transform through the effect chain; the engine keeps it as a sibling block'}
};
const COLUMN_LEAF = {
  'connect':   ACT('triggerColumn', '(N)'),
  'connected': IDENT('/composition/columns/{N}/connected'),
  'selected':  {kind:'selection', target:'column', note:'read-back: EN.selection.column === N'},
  'name':      IDENT('/composition/columns/{N}/name')
};

/* Path segments the engine mirrors verbatim under a layer, group or clip. */
const PASSTHROUGH = /^(video|audio|transport|trigger|transition|autopilot|transform)\//;

function blank(path){
  return {path, ok:false, scope:'unknown', form:null,
          layer:null, column:null, clip:null, objectId:null, effect:null, leaf:null,
          engine:{kind:'unmapped', home:null, action:null, args:null, note:null}};
}

/* resolveTarget — pure. Give it a Resolume component path, get back what the
   path names and what it becomes in arena-engine.js. `home` may carry {deck},
   {layer} or {clip} placeholders where Resolume's address is relative to
   something the engine spells out; homeFor() fills those from a live engine. */
function resolveTarget(path){
  const t = blank(path);
  if(typeof path !== 'string' || path.indexOf('/composition') !== 0) return t;
  let rest = path.slice('/composition'.length).replace(/^\//, '');
  if(!rest){ t.ok = true; t.scope = 'composition'; t.leaf = ''; return t; }

  let m;
  /* --- the three Shortcut Targets of keyboard-shortcuts.htm ------------- */
  if((m = /^objects\/(\d+)\/?(.*)$/.exec(rest))){
    t.form = 'object'; t.objectId = m[1]; t.scope = 'object'; t.leaf = m[2];
    t.ok = true;
    t.engine.note = 'engine has no objects/<uniqueId> index: "This Clip, Layer or Group" ' +
                    'cannot be resolved without one';
    const fx = /^video\/effects\/([\w-]+)\/effect\/(.+)$/.exec(m[2]);
    if(fx) t.effect = {key:fx[1], param:fx[2]};
    return t;
  }
  if(/^tempocontroller\//.test(rest)){
    const leaf = rest.slice('tempocontroller/'.length);
    t.ok = true; t.scope = 'tempo'; t.form = 'position'; t.leaf = leaf;
    if(TEMPO_LEAF[leaf]) Object.assign(t.engine, TEMPO_LEAF[leaf]);
    return t;
  }
  if((m = /^dashboard\/link(\d+)$/.exec(rest))){
    t.ok = true; t.scope = 'dashboard'; t.form = 'position'; t.leaf = rest;
    Object.assign(t.engine, {kind:'param', home:'/composition/dashboard/' + m[1],
                             note:"Resolume's link prefix dropped; the engine indexes dials directly"});
    return t;
  }

  /* layer scope, either by position or via the selected layer */
  let layerHome = null;
  if((m = /^layers\/(\d+)\/(.*)$/.exec(rest))){ t.layer = +m[1]; t.form = 'position';
    layerHome = '/composition/layers/' + m[1]; rest = m[2]; }
  else if((m = /^selectedlayer\/(.*)$/.exec(rest))){ t.form = 'selected';
    layerHome = '{layer}'; rest = m[1]; }
  else if((m = /^groups\/(\d+)\/(.*)$/.exec(rest))){ t.form = 'position'; t.scope = 'group';
    /* no shipped preset targets a group; the engine's group homes are
       /composition/groups/N/... so this is the identity, untested against data */
    t.ok = true; t.leaf = m[2];
    Object.assign(t.engine, {kind:'param', home:'/composition/groups/' + m[1] + '/' + m[2],
                             note:'identity mapping; no shipped preset exercises a group path'});
    return t;
  }
  else if((m = /^columns\/(\d+)\/(.*)$/.exec(rest))){
    t.ok = true; t.scope = 'column'; t.form = 'position'; t.column = +m[1]; t.leaf = m[2];
    const rule = COLUMN_LEAF[m[2]];
    if(rule) Object.assign(t.engine, rule, {
      home: rule.home ? rule.home.replace('{N}', m[1]) : null,
      args: rule.args ? rule.args.replace('(N)', '(' + m[1] + ')') : null});
    return t;
  }
  else if((m = /^selectedclip\/(.*)$/.exec(rest))){
    t.ok = true; t.scope = 'clip'; t.form = 'selected'; t.leaf = m[1];
    applyClipLeaf(t, m[1], '{clip}');
    return t;
  }
  else {                                              // composition-level leaf
    t.ok = true; t.scope = 'composition'; t.form = 'position'; t.leaf = rest;
    if(COMP_LEAF[rest]) Object.assign(t.engine, COMP_LEAF[rest]);
    else if(PASSTHROUGH.test(rest)) Object.assign(t.engine, IDENT('/composition/' + rest));
    else t.ok = false;
    return t;
  }

  /* inside a layer: it may still descend into a clip */
  if((m = /^clips\/(\d+)\/(.*)$/.exec(rest))){
    t.ok = true; t.scope = 'clip'; t.clip = +m[1]; t.column = +m[1];
    t.leaf = m[2];
    applyClipLeaf(t, m[2], '{clip}');
    if(t.engine.args) t.engine.args = t.engine.args
      .replace('(N, C)', '(' + (t.layer == null ? 'selected layer' : t.layer) + ', ' + m[1] + ')');
    return t;
  }
  t.ok = true; t.scope = 'layer'; t.leaf = rest;
  if((m = /^dashboard\/link(\d+)$/.exec(rest))){       // same rename as the composition dials
    Object.assign(t.engine, {kind:'param', home:layerHome + '/dashboard/' + m[1],
                             note:"Resolume's link prefix dropped; the engine indexes dials directly"});
    return t;
  }
  const rule = LAYER_LEAF[rest];
  if(rule){
    Object.assign(t.engine, rule);
    if(rule.home)  t.engine.home = rule.home.replace('{layer}', layerHome);
    if(rule.args && t.layer != null) t.engine.args = rule.args.replace('(N', '(' + t.layer);
  } else if(PASSTHROUGH.test(rest)){
    Object.assign(t.engine, IDENT(layerHome + '/' + rest));
  } else t.ok = false;
  return t;
}

/* A clip leaf, shared by /layers/N/clips/C/... and /selectedclip/... .
   `base` is the engine's clip home, which is deck qualified — the whole reason
   this needs a placeholder rather than a literal. */
function applyClipLeaf(t, leaf, base){
  const rule = CLIP_LEAF[leaf];
  if(rule){
    Object.assign(t.engine, rule);
    if(rule.home) t.engine.home = rule.home.replace('{clip}', base);
    return;
  }
  const fx = /^video\/effects\/([\w-]+)\/effect\/(.+)$/.exec(leaf);
  if(fx){
    t.effect = {key:fx[1], param:fx[2]};
    t.engine.kind = 'unmapped';
    t.engine.note = 'Resolume addresses effects by key (' + fx[1] + '); the engine addresses ' +
                    'them positionally as <scope>/effects/video/<slot>/<Display Name>. ' +
                    'A key -> slot lookup does not exist yet.';
    return;
  }
  if(PASSTHROUGH.test(leaf) || /^(name|persistent)$/.test(leaf))
    Object.assign(t.engine, IDENT(base + '/' + leaf));
  else t.ok = false;
}

/* homeFor — fill the placeholders from a live arena-engine. This is the actual
   handover: give it a resolved target and window.ArenaEngine, and it returns
   the engine `home` string you can look a parameter up by, or null when the
   target is a verb, a selection, a read-back, or something the engine has no
   address for. Selection state lives in EN.selection, where layer and clip are
   objects and column is a number. */
function homeFor(target, EN){
  if(!target || !EN || target.engine.kind !== 'param' || !target.engine.home) return null;
  let home = target.engine.home;
  if(home.indexOf('{layer}') >= 0){
    const L = EN.selection && EN.selection.layer;
    if(!L) return null;
    home = home.replace('{layer}', L.home);
  }
  if(home.indexOf('{clip}') >= 0){
    let k = null;
    if(target.form === 'selected') k = EN.selection && EN.selection.clip;
    else if(target.layer != null && target.clip != null) k = EN.clip(target.layer, target.clip);
    if(!k) return null;
    home = home.replace('{clip}', k.home);       // already /composition/decks/D/layers/N/clips/C
  }
  return home;
}

/* =========================================================================
   5. THE SHORTCUT PRESETS
   One core reader; the four protocols differ only in the root element and the
   ShortcutManager name, and in how RawInputMessage/@key is unpacked.
   ========================================================================= */
const PROTOCOLS = {
  keyboard: {root:'KeyboardShortcutPreset', manager:'KeyboardShortcutManagerShortcuts'},
  midi:     {root:'MidiShortcutPreset',     manager:'MIDIShortcutManagerShortcuts'},
  osc:      {root:'OSCShortcutPreset',      manager:'OSCShortcutManagerShortcuts'},
  dmx:      {root:'DMXShortcutPreset',      manager:'DMXShortcutManagerShortcuts'}
};
const ROOT_TO_PROTOCOL = {};
Object.keys(PROTOCOLS).forEach(k => ROOT_TO_PROTOCOL[PROTOCOLS[k].root] = k);

const SHORTCUT_ATTRS = ['name','uniqueId','paramNodeName','behaviour',
                        'inputDeviceName','outputDeviceName'];
const RIM_ATTRS      = ['name','key','value','numSteps'];

function parsePreset(xml, expected){
  const root = typeof xml === 'string' ? readXML(xml) : xml;
  const protocol = ROOT_TO_PROTOCOL[root.tag] || expected || 'unknown';
  const ver = kidOf(root, 'versionInfo');
  const mgr = kidOf(root, 'ShortcutManager');
  const rows = kidsOf(mgr, 'Shortcut');

  const list = rows.map(sc => buildRow(sc, protocol));
  /* the normalised list IS the return value; preset metadata rides along on it
     so a caller never has to unwrap anything to get at the bindings */
  list.preset = {
    protocol,
    root: root.tag,
    name: root.attr.name || '',
    presetId: root.attr.presetId != null ? +root.attr.presetId : null,
    manager: mgr ? mgr.attr.name : null,
    savedBy: ver ? {
      app: ver.attr.name || '',
      version: [ver.attr.majorVersion, ver.attr.minorVersion, ver.attr.microVersion].join('.'),
      revision: ver.attr.revision || ''
    } : null,
    /* which schema vintage this file is, decided by what it does and does not
       write — the reader has to tolerate all four, so it may as well say */
    vintage: rows.length === 0 ? null
      : rows.some(r => r.attr.paramNodeName != null && r.attr.inputDeviceName != null) ? '7.24+'
      : rows.some(r => r.attr.paramNodeName != null) ? '7.10-7.23'
      : rows.every(r => r.attr.uniqueId == null) ? 'v6'
      : '7.0-7.9',
    count: list.length,
    protocolMismatch: expected && protocol !== expected ? {expected, found:protocol} : null
  };
  return list;
}

function buildRow(sc, protocol){
  const b = decodeBehaviour(sc.attr.behaviour);
  const paths = {};
  kidsOf(sc, 'ShortcutPath').forEach(p => {
    paths[p.attr.name || 'InputPath'] = {
      path: p.attr.path || '',
      translationType: num(p.attr.translationType, null),
      allowedTranslationTypes: num(p.attr.allowedTranslationTypes, null)
    };
  });
  const input = paths.InputPath || {path:'', translationType:null, allowedTranslationTypes:null};
  const st  = kidOf(sc, 'Subtarget');
  const vr  = kidOf(sc, 'ValueRange');
  const rim = kidOf(sc, 'RawInputMessage');
  const nv  = kidOf(sc, 'NamedValues') || kidOf(sc, 'namedValues');

  const trigger = !rim ? null
    : protocol === 'keyboard' ? decodeKeyboardKey(rim.attr.key)
    : protocol === 'midi'     ? Object.assign(decodeMidiKey(rim.attr.key),
                                              {value: decodeValue(rim.attr.value, rim.attr.numSteps, b.relative)})
    : {type:protocol, raw: rim.attr.key == null ? null : String(rim.attr.key),
       note:'no preset ships for this protocol, so the key packing is unverified'};
  if(trigger && protocol === 'keyboard')
    trigger.deviceName = null;
  if(trigger && protocol === 'midi'){
    trigger.deviceName = sc.attr.inputDeviceName || null;      // 7.24+ only
    trigger.numSteps   = num(rim.attr.numSteps, null);
  }

  const row = {
    /* --- the six normalised fields --------------------------------------- */
    target:     resolveTarget(input.path),
    targetPath: input.path,
    trigger,
    /* proven: 0x400 means the target is a ParamEvent */
    kind:       b.event ? 'event' : 'value',
    /* keyboard-shortcuts.htm > Range: a button on a slider jumps to max on
       press and min on release. Absent means the whole 0..1 travel; the v6
       preset writes <ValueRange name="range" min="0" max="1"/> on every row,
       which says the same thing explicitly. */
    range:      vr ? {min:num(vr.attr.min, 0), max:num(vr.attr.max, 1), explicit:true,
                      named: vr.attr.name || null}
                   : {min:0, max:1, explicit:false, named:null},
    invert:     b.invert,          // inferred, see section 2

    /* --- everything else the file said ----------------------------------- */
    mode:       b.relative ? 'relative' : b.mouse ? 'mouse' : 'absolute',
    axis:       b.axis,
    behaviour:  b,
    uniqueId:   sc.attr.uniqueId || null,          // absent in the v6 preset
    createdAt:  sc.attr.uniqueId ? new Date(+sc.attr.uniqueId).toISOString() : null,
    paramNodeName: sc.attr.paramNodeName != null ? sc.attr.paramNodeName : null,  // 7.24 writes it
    translationType: input.translationType,
    allowedTranslationTypes: input.allowedTranslationTypes,
    targetForms: decodeTranslation(input.translationType, input.allowedTranslationTypes),
    paths,
    /* the state mirror that drives pad colour: connect->connected,
       select->selected, solo->soloed. 11 of the v6 preset's rows carry an
       empty one. */
    siblingPath: paths.InputSiblingPath ? paths.InputSiblingPath.path : null,
    subtarget:  st ? {type:num(st.attr.type, null), optionIndex:num(st.attr.optionIndex, null),
                      meaning: SUBTARGET[num(st.attr.type, -1)] || 'unknown subtarget type'} : null,
    feedback:   nv ? decodeFeedback(nv) : null,
    extra:      unknownAttrs(sc)
  };

  /* bpm.htm > Nudge: "press the 'Nudge Up' and 'Nudge Down' buttons... to
     temporarily speed the tempo up or down while you have the button
     pressed." A direct-item subtarget on the tempo is one of those two
     buttons; which of optionIndex 7 and 8 is up is NOT determinable from the
     files, so the engine call is named and the argument is left open. */
  if(row.target.scope === 'tempo' && row.target.leaf === 'tempo' &&
     row.subtarget && row.subtarget.type === 1){
    row.target.engine = {kind:'action', action:'nudge', args:'(+1 or -1)',
      note:'Subtarget optionIndex ' + row.subtarget.optionIndex +
           ' is a Nudge button; which of 7/8 is up is not determinable from the shipped files'};
  }
  return row;
}

/* keyboard-shortcuts.htm / midi-shortcuts.htm / dmx-shortcuts.htm all carry
   the same Shortcut Target section. translationType picks one form;
   allowedTranslationTypes is the bitmask of forms the target supports. */
const FORM_BITS = [
  [1,  'By Position'],                  // /composition/layers/1/...
  [2,  'This Clip, Layer or Group'],    // /composition/objects/<uniqueId>/...
  [4,  'Selected Clip'],                // /composition/selectedclip/...
  [8,  'Selected Layer'],               // /composition/selectedlayer/...
  [32, 'column scope (7.24; path form unknown)']
];
function decodeTranslation(chosen, allowed){
  if(allowed === -1) return {chosen:null, allowed:[], note:'sibling path: translation not applicable'};
  const names = FORM_BITS.filter(([bit]) => (allowed & bit) === bit).map(([, n]) => n);
  const pick  = (FORM_BITS.find(([bit]) => bit === chosen) || [])[1] || null;
  /* Bit 32 appears only on APC MINI MK II.xml's eight column rows
     (allowedTranslationTypes="35") and is never chosen by a translationType,
     so its path form cannot be read off the files. Arena.exe carries the
     matching vocabulary — "This Column Position In All Groups", "All Columns
     In Selected Group", "Selected Column" and so on — so it is a
     group-relative column target, but which one is unproven. */
  return {chosen:pick, chosenBit:chosen, allowed:names, allowedMask:allowed,
          unknownBit32: (allowed & 32) === 32};
}

/* midi-shortcuts.htm > MIDI Out: "By changing the velocity value you send to
   the controller, you change the color of the pad." second x 127 is that
   velocity. The 7.24 preset's table was typed as round fractions rather than
   captured, so 199 of its 355 entries do not land on an integer velocity —
   `exact` says which. */
function decodeFeedback(nv){
  const out = {states:{}, lowercase: nv.tag === 'namedValues', entries:0};
  kidsOf(nv).forEach(v => {
    const state = v.attr.first, n = num(v.attr.second, 0), vel = n * 127;
    out.states[state] = {normalised:n, velocity:vel,
                         exact: Math.abs(vel - Math.round(vel)) < 1e-9};
    out.entries++;
  });
  out.clipStates = FEEDBACK_STATES.filter(s => s in out.states);
  return out;
}

/* Anything a future or older vintage wrote that this reader does not name.
   Empty on all five shipped presets — it exists so an OSC or DMX preset, which
   nobody has, surfaces its own vocabulary instead of losing it. */
function unknownAttrs(sc){
  const extra = {};
  Object.keys(sc.attr).forEach(k => { if(SHORTCUT_ATTRS.indexOf(k) < 0) extra[k] = sc.attr[k]; });
  const rim = kidOf(sc, 'RawInputMessage');
  if(rim) Object.keys(rim.attr).forEach(k => {
    if(RIM_ATTRS.indexOf(k) < 0) extra['RawInputMessage@' + k] = rim.attr[k];
  });
  return Object.keys(extra).length ? extra : null;
}

const parseKeyboard = xml => parsePreset(xml, 'keyboard');
const parseMidi     = xml => parsePreset(xml, 'midi');
/* No OSC preset ships and none can be conjured. Example.avc names
   "OutputAllMessages", which has no file anywhere: it is compiled into
   Arena.exe alongside OutputAccordingToPreset and OutputNoMessages, with the
   display strings "Output All OSC Messages" / "Output No OSC Messages". That
   is osc.htm's fire hose — "everything that changes in the interface will be
   sent out... On all the addresses. Absolute and relative." parseOsc is real
   and reads the shared schema; it will simply return an empty list for the
   empty preset Arena writes at first run, which is not a fault: OSC input
   needs no shortcuts at all, since "the addresses are all fixed and set up
   already". OSC shortcuts exist only to enable output per control, to set a
   Custom Address, and to apply a wildcard scope. */
const parseOsc = xml => parsePreset(xml, 'osc');
const OSC_SYNTHETIC_PRESETS = ['OutputAccordingToPreset', 'OutputAllMessages', 'OutputNoMessages'];

/* =========================================================================
   6. THE DMX FIXTURE
   ---------------------------------------------------------------------------
   The whole shipped Fixture Library is one 797-byte file. Its <Params> holds a
   single ParamFixturePixels block and nothing else, which fixture-editor.htm
   requires: "At the moment, Resolume only supports grid based distributions.
   Also, having more than one pixel block is not supported."

   Channel count is pixels x channels-per-pixel plus any dummy channels. For
   LED 16 that is 16 x 3 = 48, and dmx.htm walks through this exact fixture to
   say so: "You'll see that the first fixture takes up 48 channels. This makes
   sense, as it has 16 pixels, each with a R, G and B value (16 * 3 = 48!)."
   That is what proves Color Space id 1 = RGB. It is the only colour-space id
   the shipped data contains; the rest of the list is not recoverable, so
   COLOUR_SPACES holds one entry rather than a made-up table.

   Distribution = 170 is NOT decodable. fixture-editor.htm says there are 16
   options; 170 is far outside 0-15, so the attribute is a choice id, not an
   index — consistent with the rest of the format, where Example.avc writes
   Beat Snap as an index and Blend Mode as a plugin id. default == value here,
   so 170 is at minimum the shipped default, which for a 16x1 strip is the
   plain left-to-right order the manual calls reading "like you would read a
   page of a book". The other fifteen ids are unknown and are not invented.

   Physical settings — start channel, dip switches, flip, brightness,
   lumiverse — are not in this file. Per dmx.htm they belong to the fixture
   INSTANCE inside a Lumiverse in Advanced Output, not to the reusable preset.
   ========================================================================= */
const COLOUR_SPACES = {
  1: {name:'RGB', channels:3,
      source:'dmx.htm walks through LED 16 and counts 16 * 3 = 48 channels'}
};
/* fixture-editor.htm names the families — "RGB (or one of its variations)",
   "RGBW and RGBWA", "CMY", plus L (weighted luminance, one channel) and A
   (alpha). Arena.exe's pooled literals list them as RGB BGR GRB RBG BRG GBR
   RGBA RGBX RGBW GRBW WRGB RGBAW RGBWA WARGB CMY. String pooling reorders
   literals, so the numeric ids of all but RGB are unknown. */
const COLOUR_SPACE_NAMES = ['RGB','BGR','GRB','RBG','BRG','GBR','RGBA','RGBX','RGBW',
                            'GRBW','WRGB','RGBAW','RGBWA','WARGB','CMY','L','A'];

function paramValue(node){
  if(!node) return null;
  const vr = kidOf(node, 'ValueRange');
  return {
    name: node.attr.name, node: node.tag,
    value: num(node.attr.value, null), default: num(node.attr.default, null),
    range: vr ? {min:num(vr.attr.min, null), max:num(vr.attr.max, null)} : null,
    storeChoices: node.attr.storeChoices != null ? node.attr.storeChoices === '1' : null
  };
}

function parseFixture(xml){
  const root = typeof xml === 'string' ? readXML(xml) : xml;
  const params = kidOf(root, 'Params');
  const block  = kidOf(params, 'ParamFixturePixels');
  const by = {};
  kidsOf(block).forEach(k => { if(k.attr.name) by[k.attr.name] = paramValue(k); });

  const width  = by['Width']  ? by['Width'].value  : null;
  const height = by['Height'] ? by['Height'].value : null;
  const csId   = by['Color Space'] ? by['Color Space'].value : null;
  const cs     = COLOUR_SPACES[csId] || null;
  const pixels = (width != null && height != null) ? width * height : null;

  /* fixture-editor.htm > Dummy channels: extra Param* siblings of the pixel
     block, each always transmitting its Default because "sending nothing is
     not a concept that exists in DMX". LED 16 has none — its <Params> holds
     the pixel block and nothing else — so it is pure pixel data. */
  const dummies = kidsOf(params).filter(k => k !== block).map(paramValue);

  return {
    name: root.attr.fixtureName || root.attr.name || '',
    uuid: root.attr.uuid || null,       // dmx.htm: editing a fixture updates every instance
    channels: (pixels != null && cs) ? pixels * cs.channels + dummies.length : null,
    colourSpace: cs
      ? {id:csId, name:cs.name, channelsPerPixel:cs.channels, source:cs.source}
      : {id:csId, name:null, channelsPerPixel:null,
         source:'unknown: only Color Space id 1 (RGB) is decidable from the shipped data'},
    pixels,
    layout: {
      width, height,
      /* one grid only, per fixture-editor.htm */
      grid: (width != null && height != null) ? width + ' x ' + height : null,
      distribution: by['Distribution'] ? by['Distribution'].value : null,
      distributionNote: 'a choice id, not an index: fixture-editor.htm names 16 options and ' +
                        'this value is 170, so the id table cannot be read off the one shipped sample',
      gamma: by['Gamma'] ? by['Gamma'].value : null,
      storage: block ? num(block.attr.storage, null) : null   // 0 in the only sample; meaning unknown
    },
    dummyChannels: dummies,
    params: by
  };
}

/* =========================================================================
   7. INDEX — what is actually on disk
   ---------------------------------------------------------------------------
   Counts below were measured against the real files at
   $SOURCE_HOME\New Openlive\Resolume Arena  Clone godrick\default\ , which are
   byte-identical to C:\Program Files\Resolume Arena\default\ . Five shortcut
   presets, 270 shortcuts, one fixture. There is no Shortcuts\OSC and no
   Shortcuts\DMX folder in the shipped tree — only Keyboard and MIDI.
   ========================================================================= */
const INDEX = {
  root: '$SOURCE_HOME\\New Openlive\\Resolume Arena  Clone godrick\\default',
  alsoAt: 'C:\\Program Files\\Resolume Arena\\default (byte identical)',

  keyboard: [{
    file:'Shortcuts\\Keyboard\\Default.xml', bytes:12826, name:'Default',
    root:'KeyboardShortcutPreset', savedBy:'Resolume Arena 7.10.0 r12509', vintage:'7.10-7.23',
    shortcuts:42, distinctTriggers:41, events:32, values:10,
    behaviour:{0:4, 1024:32, 4098:2, 12290:1, 14338:3},
    mouseRows:6, invertRows:3, valueRanges:3, subtargets:9,
    outputPaths:0, siblingPaths:0, feedbackBlocks:0, feedbackEntries:0,
    allowedTranslationTypes:{1:11, 3:12, 7:3, 11:16},
    binds:{param:9, action:29, selection:3, unmapped:1},
    notes:'P is bound twice: the Mouse-mode X/Y pair of keyboard-shortcuts.htm, which is why ' +
          '42 rows use 41 distinct triggers. paramNodeName is written but empty on all 42 rows. ' +
          'No OutputPath anywhere: the keyboard has no feedback channel. ' +
          'The G row is the only translationType 2 sample in the whole shipped set, and it is ' +
          'dangling: object 1505384963468 exists in no shipped composition, which is why it is ' +
          'the one row of 270 that resolveTarget cannot map. ' +
          "The A key's range floor 0.063095734448019330509 is 10^(-24/20): -24 dB, the bottom " +
          "of Resolume's volume fader, not an arbitrary number."
  }],

  midi: [
    {file:'Shortcuts\\MIDI\\APC 40 MK II.xml', bytes:54242, name:'APC 40 MK II',
     savedBy:'Resolume Arena 7.0.0 r64879', vintage:'7.0-7.9',
     shortcuts:71, events:48, values:23, notesMsgs:54, ccMsgs:17, distinctTriggers:71,
     behaviour:{4:6, 8:15, 1028:48, 16392:1, 2113544:1},
     relativeRows:2, valueRanges:0, subtargets:17,
     outputPaths:71, siblingPaths:34, feedbackBlocks:54, feedbackEntries:192,
     allowedTranslationTypes:{1:18, 3:12, 7:1, 11:40},
     binds:{param:23, action:44, selection:4, unmapped:0}, device:'Any',
     notes:'21 clip triggers on 3 layers x 7 columns, 7 column triggers, 15 per-track buttons ' +
       'spread over MIDI channels 1-3, 8 dashboard links, and the two Relative rotaries: ' +
       'CC13 -> tempo at 480 steps of -1/480 (one BPM per detent, inverted, over the 20-500 ' +
       'range) and CC47 -> clip playhead at 128 steps of 1/128. The playhead row is the only ' +
       'translationType 4 row in any MIDI preset and the only carrier of behaviour bit 0x200000. ' +
       'Data bug: layers/1/solo and layers/2/solo carry allowedTranslationTypes 3 while ' +
       'layers/3/solo carries 11: a half-applied v6->v7 conversion (Arena.exe has ' +
       'V6Tov7::fixLayerSoloSiblingPaths). Do not infer a rule from it.'},

    {file:'Shortcuts\\MIDI\\APC MINI MK II.xml', bytes:87843, name:'APC MINI MK II',
     savedBy:'Resolume Arena 7.24.0 r44853', vintage:'7.24+',
     shortcuts:90, events:72, values:18, notesMsgs:81, ccMsgs:9, distinctTriggers:90,
     behaviour:{4:9, 8:9, 1028:72},
     paramNodeName:{ParamEvent:72, 'RangedParam[bool]':9, ParamRange:9},
     valueRanges:0, subtargets:9,
     outputPaths:90, siblingPaths:72, feedbackBlocks:81, feedbackEntries:355,
     feedbackNonInteger:199,
     allowedTranslationTypes:{1:2, 11:80, 35:8},
     binds:{param:18, action:72, selection:0, unmapped:0},
     device:'APC mini mk2 Control (0xEB6C21CA00)',
     notes:'The only preset that writes paramNodeName, inputDeviceName and outputDeviceName, and ' +
       'the only one on a named device rather than Any Device. Its 8x8 grid is TRANSPOSED ' +
       'against the APC40: note+1 advances the layer, note+8 the column. Columns run in reverse ' +
       '(note 119 down to 112) and are the only rows anywhere with allowedTranslationTypes 35. ' +
       '199 of its 355 feedback entries are round fractions (0.25/0.5/0.75) rather than captured ' +
       'velocities, so they do not land on integer velocities; the one row that was captured ' +
       '(layers/8/clips/1) reads 32/127 where its neighbours read 0.25.'},

    {file:'Shortcuts\\MIDI\\APC MINI.xml', bytes:43135, name:'APC MINI',
     savedBy:'Resolume Arena 6.0.0 r60512', vintage:'v6',
     shortcuts:42, events:36, values:6, notesMsgs:38, ccMsgs:4, distinctTriggers:42,
     behaviour:{4:2, 8:4, 1028:36},
     valueRanges:42, subtargets:42,
     outputPaths:42, siblingPaths:42, emptySiblingPaths:11,
     feedbackBlocks:42, feedbackBlocksEmpty:4, feedbackEntries:160,
     allowedTranslationTypes:{1:3, 3:10, 11:29},
     binds:{param:6, action:32, selection:4, unmapped:0}, device:'Any',
     notes:'The v6 schema, and the reason this reader is tolerant: no uniqueId on any row, ' +
       'Subtarget type 0 everywhere, <ValueRange name="range" min="0" max="1"/> written on all ' +
       '42 rows, lower-case <namedValues> (4 of which are the empty <namedValues/> form on the ' +
       'CC faders), and 11 empty sibling paths.'},

    {file:'Shortcuts\\MIDI\\Nano Kontrol 2.xml', bytes:12210, name:'Nano Kontrol 2',
     savedBy:'Resolume Avenue 7.0.0 r64474', vintage:'7.0-7.9',
     shortcuts:25, events:10, values:15, notesMsgs:0, ccMsgs:25, distinctTriggers:25,
     behaviour:{8:15, 1032:10},
     valueRanges:0, subtargets:8,
     outputPaths:25, siblingPaths:3, feedbackBlocks:0, feedbackEntries:0,
     allowedTranslationTypes:{1:8, 3:3, 11:14},
     binds:{param:15, action:6, selection:4, unmapped:0}, device:'Any',
     notes:'Every row is CC, including the buttons: exactly what midi-shortcuts.htm warns ' +
       'about: "some controllers, like for instance the Korg NanoKontrol series, can send out ' +
       'CCs when you press a button." Saved by Avenue, not Arena. It writes OutputPath on all ' +
       '25 rows but no NamedValues at all, so it asks for MIDI out and then sends no colours.'}
  ],

  osc: {
    folder:'Shortcuts\\OSC', present:false, presets:0,
    notes:'No OSC folder ships. Example.avc names OscShortcutPreset "OutputAllMessages", which ' +
      'has no file anywhere: it is compiled into Arena.exe with OutputAccordingToPreset and ' +
      'OutputNoMessages. Arena writes an empty OSCShortcutPreset at first run in ' +
      'Documents\\Resolume Arena\\Shortcuts\\OSC\\Default.xml. An empty OSC preset is meaningful: ' +
      'osc.htm says the addresses "are all fixed and set up already", so OSC input needs no ' +
      'shortcuts: they exist only for output, Custom Address and wildcard scope.',
    synthetic: OSC_SYNTHETIC_PRESETS
  },
  dmx: {
    folder:'Shortcuts\\DMX', present:false, presets:0,
    notes:'No DMX preset ships, so the attribute names for the four DMX-only options ' +
      'dmx-shortcuts.htm describes (Invert, 16 bit, Channel, Lumiverse) are unknown. ' +
      'The schema is otherwise the shared one.'
  },

  fixtures: [{
    file:'Fixture Library\\LED 16.xml', bytes:797, fixtureName:'LED 16',
    uuid:'83d2b59141554bccb1e9632080f11aa7',
    pixels:16, grid:'16 x 1', colourSpace:'RGB (id 1)', channels:48,
    gamma:2.5, distribution:170, dummyChannels:0,
    notes:'The entire shipped Fixture Library. dmx.htm walks through this fixture and counts ' +
      'its 48 channels, which is what fixes Color Space id 1 as RGB. Distribution 170 is a ' +
      'choice id and is not decodable from one sample.'
  }],

  totals: {
    presets:5, shortcuts:270, keyboardShortcuts:42, midiShortcuts:228,
    fixtures:1, oscPresets:0, dmxPresets:0,
    events:198, values:72, noteMessages:173, ccMessages:55,
    distinctTargetPaths:42,          // after collapsing layer/clip/column indices
    /* what resolveTarget() makes of all 270: 71 rows land on an engine
       parameter, 183 on an engine API call, 15 on EN.selection, and 1 — the
       dangling objects/<uniqueId> keyboard row — on nothing, because the
       engine has no object-id index. Checked against a live ArenaEngine: all
       71 parameter rows find their parameter by home. */
    binds:{param:71, action:183, selection:15, unmapped:1}
  },

  /* Example.avc names three presets by name, not by content — two of which do
     not ship: the MIDI preset "Default" is not in default\Shortcuts\MIDI
     (only the four device presets are), and OutputAllMessages has no file. */
  referencedByExampleAvc: {KeyboardShortcutPreset:'Default', MidiShortcutPreset:'Default',
                           OscShortcutPreset:'OutputAllMessages'}
};

/* =========================================================================
   8. PUBLISHED
   ========================================================================= */
window.ArenaShortcuts = {
  parseKeyboard, parseMidi, parseOsc, parseFixture,
  resolveTarget, homeFor, INDEX,
  /* the decoders, so a shortcuts panel can label a row without re-parsing */
  decodeKeyboardKey, decodeMidiKey, decodeBehaviour, decodeTranslation,
  readXML,
  BEHAVIOUR, SUBTARGET, FEEDBACK_STATES, PROTOCOLS, FORM_BITS,
  COLOUR_SPACES, COLOUR_SPACE_NAMES, OSC_SYNTHETIC_PRESETS
};
})();
