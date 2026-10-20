/* ===========================================================================
   Arena UI clone — shared data layer
   ---------------------------------------------------------------------------
   Every list below was DECODED from the shipped binary, not guessed:
     Resolume_Arena_7_27_1_rev_15990_Installer.exe
       -> Inno Setup 6.1.0 (Unicode) container
       -> setup header block  (LZMA1, 4 KB CRC-blocked)   = file table
       -> payload chunks      ('zlb'1A + LZMA2)           = program files
       -> carved Arena.exe    (x64 PE, 58,909,184 bytes)  = UI string tables
   Menu labels, blend modes, effect/source names, DMX colour spaces,
   preference labels and panel names are the application's own strings.
   Layout/CSS/behaviour in this clone is original work.
   =========================================================================== */

const BUILD = { product:'Arena', version:'7.27.1', rev:15990, engine:'Inno Setup 6.1.0 (u)' };

/* ---- colour coding: Arena offers five swatches plus "none" ----------------
   Sampled from the official Jan-2024 Layouts documentation screenshot. Keep
   this shared palette as the single token source; menu and grid components
   consume indices and never invent their own near-duplicate colours. */
const COLOR_SWATCHES = ['none','#c35839','#81b035','#00b285','#0077af','#c22596'];

/* ---- blend modes / mixers — read from the live Arena blend reference ----
   Grouped exactly as Arena groups them, with the compositing formula it reports.
   a = base (layer below), b = source (layer above), per channel 0–1.          */
const BLEND_CATEGORIES = [
  {group:'Brightening', note:'black disappears, colors accumulate toward white', items:[
    ['Add','min(a+b, 1)'], ['Screen','1-(1-a)(1-b)'], ['Lighten','max(a,b)'], ['Dodge','min(a/(1-b), 1)']]},
  {group:'Darkening', note:'white disappears, colors accumulate toward black', items:[
    ['Multiply','a×b'], ['Darken','min(a,b)'], ['Burn','clamp(1-(1-a)/b, 0, 1)'], ['Subtract','max(a-b, 0)']]},
  {group:'Contrast', note:'both layers visible, mid-tones shift', items:[
    ['Overlay','a<0.5: 2ab | a≥0.5: 1-2(1-a)(1-b): branches on BASE'],
    ['Hard Light','b<0.5: 2ab | b≥0.5: 1-2(1-a)(1-b): branches on SOURCE'],
    ['Soft Light','b>0.5: 1-(1-a)(1-(b-0.5)) | b≤0.5: a(b+0.5)']]},
  {group:'Comparative', note:'identical pixels cancel, different pixels highlight', items:[
    ['Difference','|a-b|'], ['Difference I','1-|a-b|'], ['Exclusion','a+b-2ab']]},
  {group:'Keying', note:'', items:[
    ['Luma Key','threshold(1-lum(b), opacity)'],
    ['Luma Key I','1-threshold(1-lum(b), 1-opacity)'],
    ['Luma Is Alpha','b * clamp(lum(b) + (opacity-0.5)*2, 0, 1) over a']]},
  {group:'Transparency', note:'', items:[
    ['Alpha','a(1-b_alpha)+b'], ['Cut','opacity > 0.5 ? b : a']]},
  {group:'Special', note:'', items:[
    ['B&W','desaturate((a+b)/2)'], ['Displace','sample(a, uv + mix(lum(a), lum(b), opacity))']]}
];
/* 50-variants scale the blend maths directly at any opacity position.
   Note the prefix: Arena names these "50 Add", not "Add 50". */
const BLEND_50 = ['50 Add','50 Burn','50 Difference','50 Distance','50 Dodge','50 Lighten',
  '50 Mask','50 Multiply','50 Overlay','50 Subtract'];
const BLEND_TRANSITIONS = ['Dissolve','to Black','to White','to Color','Push Down','Push Left',
  'Push Right','Push Up','Wipe Ellipse','Zoom In','Zoom Out','Cube','Rotate X','Rotate Y',
  'Side by Side','Tile'];
const BLEND_CREATIVE = ['LoRez','Noisy','Static','JitterBug','Twitch','Parts','Shift RGB','RGB',
  'Multi Task','Meta Mix','TimeSwitcher'];
/* flat list for pickers */
const BLEND_MODES = BLEND_CATEGORIES.flatMap(c => c.items.map(i => i[0]));
/* Random is limited to concrete local transition renderers. Do not include the
   whole ordinary/50 catalog here: several native blend formulas have no exact
   Canvas operator, and resolving Random to one of those would falsely present
   a source-over approximation as Resolume's mixer. */
const LOCAL_TRANSITION_MODES = Object.freeze([
  'Alpha','Cut','Dissolve','to Black','to White',
  'Push Down','Push Left','Push Right','Push Up','Wipe Ellipse',
  'Zoom In','Zoom Out','Rotate X','Rotate Y','Side by Side','Tile'
]);
const TRANSITION_EXTRAS = ['Random'];

/* ---- video effects — the exact 106 the running Arena reports ---- */
const VIDEO_EFFECTS = [
  'Acuarela','Add Subtract','Auto Mask','Bendoscope','Bloom','Blow','Blur','Bright.Contrast','CRT',
  'ChromaKey','Circles','Color Pass','Colorize','Crop','Cube Tiles','Delay RGB','Dilate','Displace',
  'Distortion','Dither','Dot Screen','Drop Shadow','Edge Detection','Exposure','Fish Eye','Flip',
  'Fragment','Freeze','Goo','Grid','Grid Cloner','Hatched','Heat','Hue Rotate','Infinite Zoom',
  'Invert RGB','Iterate','Kaleidoscope','Keystone','Keystone Crop','Keystone Mask','Kuwahara','LUT',
  'Levels','Linear Cloner','LoRez','Mask','Meta Shape','Mirror','Mirror Quad','Noisy',
  'Particle System','Pixel Blur','Pixel High Pass','Point Grid','PolarKaleido','Polkadot','Posterize',
  'Radar','Radial Cloner','RadialBlur','Raster','Recolor','Reveal','Ripples','Saturation',
  'SearchLight','Shape Mask','Shaper','Sharpen','Shift Glitch','Shift RGB','Slice Delay',
  'Slice Transform','Slide','Snow','Snowy','Solid Color','Sparkles','Sphere','Static',
  'Stingy Sphere','Stop Motion','Stripper','Strobe','Strokes','Suckr','Terrain','Text Animator',
  'Text Block','Threshold','Tile','Tilt Shift','Tint','Trails','Transform','Triangulate','Tunnel',
  'Twisted','Twitch','UV Map','Vibrance','VideoWall','Vignette','WarpSpeed','Wave Warp'
];

/* ---- audio effects (plugins\afx) ---- */
const AUDIO_EFFECTS = ['Bitcrusher','Distortion','EQ-3','Flanger','HighPass','LowPass'];
/* Sampled from the delayed live REST object in Arena 7.27.1. Dry Wet is common
   to all six and is modelled by arena-engine.js as the audio mixer parameter;
   these are the plugin-specific rows that follow it. */
const AUDIO_EFFECT_PARAMS = {
  Bitcrusher: [
    {n:'Gain',min:0,max:1,d:1}, {n:'Sample Rate',min:0,max:1,d:1},
    {n:'Bit Depth',min:0,max:1,d:1}, {n:'Dither',kind:'bool',d:false},
    {n:'Jitter',kind:'bool',d:false}
  ],
  Distortion: [
    {n:'Pre Gain',min:0,max:1,d:0.1}, {n:'Drive',min:0,max:1,d:0},
    {n:'Tone',min:0,max:1,d:1}, {n:'Post Gain',min:0,max:1,d:0.1}
  ],
  'EQ-3': [
    {n:'Low',min:0,max:1,d:0.5}, {n:'Mid',min:0,max:1,d:0.5},
    {n:'High',min:0,max:1,d:0.5}
  ],
  Flanger: [
    {n:'Depth',min:0,max:1,d:0}, {n:'Rate',min:0,max:1,d:0.05},
    {n:'Feedback',min:0,max:1,d:0.7}, {n:'Invert',kind:'bool',d:false},
    {n:'Width',min:0,max:1,d:0.0003}
  ],
  HighPass: [
    {n:'Frequency',min:0,max:1,d:0}, {n:'Resonance',min:0,max:1,d:0}
  ],
  LowPass: [
    {n:'Frequency',min:0,max:1,d:1}, {n:'Resonance',min:0,max:1,d:0}
  ]
};

/* ---- historic FFGL class aliases recovered from Arena/preset metadata ----
   These are implementation aliases, not proof that a matching binary exists
   in this Windows install: extracted/arena-tree.json contains no plugins/vfx
   payloads. The role-safe, user-facing FFGL evidence lives in
   arena-plugin-catalog.js and is limited to presets that explicitly serialize
   a <FFGLPlugin> record. */
const FFGL_PLUGINS = [
  'ChromaKey','FFGLBarShift','FFGLEdgeDetection','FFGLStopMotion','FFGLWaveWarp','SyzGL_Fragment',
  'SyzGL_Goo','SyzGL_Iterate','SyzGL_Kaleidoscope','SyzGL_RadialBlur','SyzGL_Ripples',
  'SyzGL_Stripper','SyzGL_Tunnel','SyzGL_VideoWall'
];

/* ---- Wire patches shipped in plugins\wire (*.wired) ----
   A Wire patch declares what it IS. Every one of the fifteen files in
   reference/wired/ carries a JSON header with
   "meta":{"category":"...", "displayName":"...", "description":"..."} and the
   category is one of source / effect / mixer — PiP's own description spells
   the rule out: "A Wire video mixer patch needs to have at least two texture
   input nodes".

   This list used to be one flat array of fifteen names fed to BOTH the "Wire
   Sources" group in the browser AND the "Wire Effects" group in app.js, so
   every patch appeared twice and twelve of the fifteen "sources" were things
   that cannot generate anything — LUT, Shape Mask, Slice Delay and Tilt Shift
   all need an input. Read from the files, the real split is 3 / 10 / 2.

   The descriptions are Resolume's own, verbatim from the same headers. */
const WIRE_SOURCES = [
  ['Abstract Field', "Abstract Noise Texture based on Wire's Fractal Noise node."],
  ['Slice Outline',  'The most basic slice outliner.'],
  ['Tunnelines',     'Generates a fluid circular tunnel.']
];
const WIRE_EFFECTS = [
  ['Acuarela',    'Turns your content into watery smoke.'],
  ['CRT',         'Mimics old Cathode Ray Tube screens.'],
  ['Grid Cloner', 'Clones the content into an adjustable grid with distortion and randomisation.'],
  ['LUT',         'Applies a LUT (Lookup Table) to the content.'],
  ['SearchLight', 'Creates a moving spotlight that highlights only part of the content.'],
  ['Shape Mask',  'Mask your content with the most common geometric shapes.'],
  ['Slice Delay', "Slice'n Delay"],
  ['Strokes',     'Van Gogh in a box. Left ear sold separately.'],
  ['Tilt Shift',  'Keeps part of the content focused while blurring others.'],
  ['WarpSpeed',   'Helm, Warp One, Engage!']
];
/* mixer patches are transitions/blends, not clip content — two texture inputs */
const WIRE_MIXERS = [['Video Bumper', ''], ['PiP', 'A Wire video mixer patch.']];
const wireNames = list => list.map(x => x[0]);
/* Arena's catalog has one identity per effect even though the panel separates
   native and Wire entries visually. Do not show the same plugin twice, and do
   not expose internal FFGL class aliases as extra user-facing effects. */
const WIRE_EFFECT_NAMES = new Set(wireNames(WIRE_EFFECTS));
const OFFLINE_EFFECT_GROUPS = [
  {group:'Video Effects', items:VIDEO_EFFECTS.filter(n => !WIRE_EFFECT_NAMES.has(n))},
  {group:'Wire Effects', items:wireNames(WIRE_EFFECTS)}
];
const WIRE_NOTES = {};
[].concat(WIRE_SOURCES, WIRE_EFFECTS, WIRE_MIXERS).forEach(([n, d]) => { if(d) WIRE_NOTES[n] = d; });
/* kept for anything still asking for "every shipped patch" */
const WIRE_PATCHES = wireNames(WIRE_SOURCES.concat(WIRE_EFFECTS, WIRE_MIXERS)).sort();

/* ---- sources / generators (Arena.exe generator registry) ---- */
/* Reconciled against Arena's own /api/v1/sources: the stable software subset
   is exactly 21 Sources. Capture devices and network senders are dynamic,
   machine-specific extras, so no fixed total is valid; when connected the
   browser shows the current machine's live list instead of inventing names. */
const SOURCE_TEXTURE_TRANSPORT = /Mac|iPhone|iPad/i.test(
  (typeof navigator!=='undefined' &&
    ((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||navigator.userAgent))||'')
  ? {group:'Syphon Servers', items:[], live:'syphon'}
  : {group:'Spout Servers', items:[], live:'spout'};
const SOURCES_TREE = [
  {group:'Favorites', items:['Solid Color','Text Animator','Video Router']},
  {group:'Video Sources', items:[
    'Blank','Checkered','Feedback','Gradient','Line Scape','Lines','Metaballs','Rings','Shaper',
    'Sine Wave','Solid Color','Spiral','Static','Stroboscope','Test Card','Text Animator',
    'Text Block','Video Router']},
  /* only the three patches whose own header says "category":"source" */
  {group:'Wire Sources', items:wireNames(WIRE_SOURCES)},
  /* CAPTURE DEVICES, NDI SERVERS AND SPOUT/SYPHON SERVERS ARE HARDWARE AND
     OTHER RUNNING APPLICATIONS, so they cannot come from a data file. These
     groups used to ship "NDI Webcam Video 1..4", "OBS Virtual Camera",
     "ARENA-PC (Arena — Composition)", "MEDIASERVER (vMix — Output)", "Wire —
     Output" and "OBS — Spout". Nine names, none of them on any machine that has
     ever run this. live-inputs.htm is explicit that the list is "all the
     devices connected to your computer", and sources.htm the same for senders.
     app.js fills the Capture Devices group from
     OpenLiveRouting.liveInputs() (navigator.mediaDevices.enumerateDevices) and
     states plainly when it can see nothing. NDI and the platform-specific
     Spout/Syphon group stay empty — a browser has no mDNS discovery and no
     shared texture handle — so
     they render as one disabled row naming the capability that is missing,
     which is what the Advanced Output already does for the same two. */
  {group:'Capture Devices', items:[], live:'capture'},
  {group:'NDI Servers', items:[], live:'ndi'},
  SOURCE_TEXTURE_TRANSPORT
];

/* ---- factory presets shipped in default\Presets ---- */
const PRESETS = {
  'Animation':['BPM - 1 to the Floor','BPM - 4 to the Floor','BPM - On Off','BPM - Random',
    'BPM - Step 1 2 3 4','BPM - Step 1 2','Double Trouble','Ex FFT - Bass ON OFF',
    'Ex FFT - Bass with Threshold','Ex FFT - Low-Mid with Threshold','Ex FFT - Mid with Threshold',
    'Glitchy','Jittery','Jumpy','Wavey'],
  'Color Palettes':['Broadway Boogie Woogie','Clockwork Orange','Greyscale Chimpanzee','Inferno',
    'Lichtenstein','Magma','Mona Lisa','Plasma','Purple Rain','Rainbow','Shades of Salmon',
    'Viridis','Warhol'],
  'Envelopes':['4 To The Floor','ADSR','ASR','Digital','EasyEase','Jaws','LFO','Noise','Saw','Up N Down'],
  'Interface':['Big Monitor','Dual Display','Many Layers','Many Monitors Left','Many Monitors Top',
    'Minimal','Panels Left & Right','Panels On Top','Triple Display'],
  'Render and Record':['DXV 3 High Quality No Alpha','DXV 3 High Quality With Alpha',
    'DXV 3 Normal Quality No Alpha','DXV 3 Normal Quality With Alpha','H264 High Quality',
    'H264 Low Quality','H264 Medium Quality','Motion JPEG','ProRes 422 High Quality',
    'ProRes 422 Normal Quality','ProRes 4444'],
  'MIDI Shortcuts':['APC 40 MK II','APC MINI MK II','APC MINI','Nano Kontrol 2']
};

/* ---- codecs offered by the recorder / clip renderer ---- */
const CODECS = ['DXV 3 High Quality With Alpha','DXV 3 High Quality No Alpha',
  'DXV 3 Normal Quality With Alpha','DXV 3 Normal Quality No Alpha','H264 High Quality',
  'H264 Medium Quality','H264 Low Quality','Motion JPEG','Apple ProRes 422 Proxy',
  'Apple ProRes 422 LT','Apple ProRes 422','Apple ProRes 422 HQ','Apple ProRes 4444','HAP'];

const RESOLUTIONS = ['1920 x 1080','1280 x 720','2560 x 1440','3840 x 2160','1024 x 768','1200 x 1920','Custom…'];

/* ---- transport / trigger enumerations — read from the live parameter model ----
   These are the exact choice values Arena accepts, not paraphrases.          */
/* Orders below are the API's own option arrays, in the API's order — Arena
   accepts the string, and a picker that lists them in a different order than
   the application does is a bug waiting to happen. Verified against
   /api/v1/composition on Arena 7.27.1 rev 15990.                           */
const PLAY_MODES   = ['Loop','Bounce','Play Once & Hold','Play Once & Clear','Restart','Random'];
const TRANSPORTS   = ['Timeline','BPM Sync','SMPTE 1','SMPTE 2','Denon DJ','Pioneer DJ'];
const BEAT_SNAP    = ['None','8 Bars','4 Bars','2 Bars','1 Bar','1/2 Bar','1/4 Bar'];
const CLIP_TARGETS = ['Active Layer','Own Layer','Free Layer','Denon Player Determined',
  'Pioneer Player Determined'];
const TRIGGER_STYLES = ['Normal','Piano','Toggle'];
const RESIZE_MODES = ['Fill','Fit','Stretch','Original'];
const AUTO_SIZE    = ['Off','Fill','Fit','Stretch'];
const MASK_MODES   = ['Disabled','One Below','All Below'];
const CROSSFADER_GROUPS = ['None','A','B'];
const FADER_START  = ['Layer Determined','On','Off'];
const IGNORE_COL   = ['Layer Determined','On','Off'];
const DIRECTIONS   = ['Backwards','Paused','Forwards'];
const DETERMINED   = 'Composition Determined';

/* ---- named parameters per entity, with types and ranges ---- */
const PARAM_MODEL = {
  clip: 'name(str) opacity(0-1) volume(0-1) pan(-1..1) speed(0-10) position(0-1) duration(range) '
      + 'playdirection playmode playmodeaway beatloop syncmode transporttype triggerstyle beatsnap '
      + 'faderstart target colorid connected(read-only) ignorecolumntrigger '
      + 'video/width video/height resize video/r video/g video/b video/a',
  layer: 'name(str) master(0-1) video/opacity(0-1) bypassed(bool) solo(bool) volume(0-1) pan(-1..1) '
      + 'blend_mode crossfadergroup maskmode colorid ignorecolumntrigger faderstart width height autosize',
  group: 'name(str) master(0-1) speed(0-10) bypassed solo volume pan opacity blend_mode '
      + 'crossfadergroup colorid ignorecolumntrigger',
  composition: 'name(str) master(0-1) speed(0-10) bypassed volume pan opacity bpm(20-500) '
      + 'cliptarget cliptriggerstyle clipbeatsnap',
  column: 'name(str) colorid connected(read-only) beatsnap',
  deck: 'name(str) colorid'
};
/* Gotchas Arena itself flags:
   - layer "master" is the fader users call opacity; layer "video/opacity" is a different thing
   - clip "speed" 0 = paused, 1 = normal; triggering is not the same as setting speed
   - the API uses raw values: 0.5 displays as "50%"                              */
const AUTOPILOT_RANDOM = ['Other','Any','Bag'];
const AUTOPILOT_DURATION = ['Clip Transport','Longest Clip','Shortest Clip','Top Clip','Bottom Clip',
  'Seconds','Beats','No Fixed Duration','All Clips Ended'];
const AUTOPILOT_ACTIONS = ['Play Next Column','Play Previous Column','Play Random Column',
  'Play First Column','Play Last Column','Play Specific Column','Play Specific Clip'];
/* the crossfader reports four of each, not three — 'Cut' behaviour and the
   'Fast'/'Cut' curves were missing, and 'Sharp' does not exist */
/* composition.htm names the latching return mode "Jump & Return".  Keep the
   legacy value readable in ArenaEngine, but never present that private label
   as if it were Resolume vocabulary. */
const XFADER_BEHAVIOUR = ['Cut','Jump & Return','Jump','Fade (Legacy)'];
const XFADER_CURVE = ['Linear','Gentle','Fast','Cut'];
/* Documented superset. The Parameter cog filters this by its owning panel:
   Clip Position/Clip FFT are Clip-only, the matching Group/Layer FFT stays in
   that panel, and Crossfader Phase is Composition/Group/Layer only. Basic is
   retained for the Envelope/ParamText editor; Envelope and Dashboard are
   separate driver/link sections rather than phase sources in the cog. */
const PARAM_ANIMATION = ['Basic','Timeline','BPM Sync','Clip Position','Crossfader Phase',
  'Composition FFT','Group FFT','Layer FFT','Clip FFT','External FFT','Envelope','Dashboard'];
const GLOBAL_TRANSPORT = ['BPM Sync & Timeline','BPM Sync Only'];
const RECORD_STATES = ['Armed','Prerolling','Recording','Muxing','Finishing…','Pending','Cancelling…','Cancelled','Aborted'];

/* ---- monitor sources (monitor cogwheel) ---- */
const MONITOR_SOURCES = ['Composition','Preview','Groups','Layers','Crossfader Result',
  'Crossfader Bus A','Crossfader Bus B','Selected Clip','Layer Preview','Group Preview'];

/* ---- DMX ---- */
const DMX_COLOR_SPACES = ['RGB','BGR','GRB','GBR','BRG','RBG','RGBW','GRBW','WRGB','RGBA','RGBX',
  'RGBAW','RGBWA','WARGB','CMY','RGB3'];
const DMX_EXTRA_CHANNELS = ['EO1','EO2','EO3','EO4','EO5','EO6','EO7','EO8','EO9','EO10','EO11',
  'EO12','EO13','EO14','EO15','EO16'];
const LUMIVERSES = ['Lumiverse 1','Lumiverse 2','Lumiverse 3','Lumiverse 4'];

/* ---- advanced output ----
   Placement and wording follow the shipped manual's Advanced Output chapters
   (advanced-output / screens / input-selection / output-transformation /
   modifiers). Notably: the setup preset dropdown sits top-left of the window,
   the screen and slice tree runs down the left, Transform / Edit Points are
   the two tabs in the top right of the stage, and the properties are on the
   right. '-' in a menu list is a separator. */
const AO_SLICE_TOOLS = ['Transform','Edit Points','Draw'];
const AO_STAGES = ['Input Selection','Output Transformation'];
const AO_ADD_MENU = ['Slice','Triangle Slice','Polygon Slice','DMX Fixture','Input Mask',
  'Circle Mask','Square Mask','Triangle Mask','Hexagon Mask','Polygon Mask','Love Mask'];
const AO_NEW_SCREEN = ['Screen','DMX Lumiverse','Virtual Output'];
/* the slice contextual menu, in the manual's own order and grouping */
const AO_SLICE_CTX = ['Center X','Center Y','Mirror X','Mirror Y','-',
  'Left Half','Right Half','Top Half','Bottom Half','Whole Area','-',
  'Make Triangle','Make Circle','-',
  'Match Input Shape','Match Output Shape','Swap Input Output Shape','-',
  'Bring Forward','Send Backwards','-',
  'Duplicate','Delete','-','Identify Slices','Show in Output'];
/* right-clicking a screen lists every output connected to the machine */
/* Output devices, with the class Resolume actually writes for each.

   These class names are not invented: they are the OutputDevice* symbols in
   Arena.exe, and AdvancedOutput.xml stores the concrete one as the single
   child of <OutputDevice>, e.g.

     <OutputDevice><OutputDeviceVirtual name="Screen 1" deviceId="VirtualScreen 1"
       idHash="10094742552620344504" width="1600" height="1200"/></OutputDevice>

   Every entry used to be a bare label, and the class was guessed by running
   /Lumiverse|DMX/i over that label — so a Display, a Blackmagic card, Spout and
   NDI were all written out as OutputDeviceVirtual and became indistinguishable
   once saved.

   `deviceId` is the identity Resolume matches on when a file is re-opened; the
   label is only what it shows. Keep them separate.

   Note: OutputDeviceSyphon does not appear in the Windows binary — Syphon is
   macOS-only — so that one name is by analogy with Spout rather than measured. */
/* CONNECTED OUTPUTS AND PLAYBACK CARDS ARE HARDWARE, SO THEY ARE NOT LITERALS.
   These two groups used to ship three invented displays ("Display 1 — 1920 x
   1080", "Display 2 — 1920 x 1080", "Display 3 — 3840 x 2160") and three
   invented cards (Blackmagic Intensity Pro, Datapath Fx4, AJA Kona 5). Not one
   of them was attached to any machine running this. Assigning a screen to
   "Display 3" assigned it to nothing, and the Playback Cards group offered SDI
   output on a laptop with no SDI.

   screens.htm is explicit about where this list comes from: "Resolume itself
   does not create outputs. This is handled by your computer." So the groups are
   empty here and filled at runtime — displays from openlive-displays.js
   (getScreenDetails, permission-gated, honest about what it cannot see), cards
   from nothing, because a browser cannot see a playback card at all. An empty
   Playback Cards group renders as "no card detected", which is true. */
const AO_OUTPUT_DEVICES = [
  {group:'Connected Outputs', kind:'OutputDeviceDisplay', items:[]},
  {group:'Playback Cards', kind:'OutputDeviceCapture', items:[]},
  /* ONE PLATFORM, ONE PROTOCOL. syphonspout.htm: Syphon is macOS, Spout is
     Windows — Arena shows the one this machine can use, never both. Offering
     both let a Windows screen be assigned to "Syphon" and persisted as
     OutputDeviceSyphon, a device that cannot exist here.
     openlive-output-editor.js:2773 already picks with `MAC ? 'Syphon' : 'Spout'`;
     this table disagreed with it, so the two Advanced Output implementations
     described different hardware. Same test, one answer. */
  {group:'Texture Sharing', items:(
    /Mac|iPhone|iPad/i.test((typeof navigator!=='undefined' && (navigator.platform||navigator.userAgent))||'')
      ? [{label:'Syphon', kind:'OutputDeviceSyphon', deviceId:'Syphon', width:1920, height:1080}]
      : [{label:'Spout',  kind:'OutputDeviceSpout',  deviceId:'Spout',  width:1920, height:1080}])},
  {group:'Network', kind:'OutputDeviceNDI', items:[
    {label:'NDI', deviceId:'NDI', width:1920, height:1080}]},
  {group:'Virtual', items:[
    {label:'Virtual Output',  kind:'OutputDeviceVirtual', deviceId:'Virtual', width:1920, height:1080},
    {label:'DMX / Lumiverse', kind:'OutputDeviceDmx',     deviceId:'Lumiverse'}]},
];
/* label -> {kind, deviceId, width, height}, so both the menu and the inspector
   assign the same class from the same table rather than each guessing. */
const AO_DEVICE_BY_LABEL = (() => {
  const m = new Map();
  AO_OUTPUT_DEVICES.forEach(g => g.items.forEach(it =>
    m.set(it.label, {kind: it.kind || g.kind || 'OutputDeviceVirtual',
                     deviceId: it.deviceId || it.label,
                     width: it.width, height: it.height})));
  return m;
})();
const AO_SCREEN_CTX = ['Rename','Duplicate Screen','-','Fold','Show in Output','-','Remove Screen'];
/* the manual's View Options, verbatim */
const AO_VIEW_OPTIONS = ['Show Slice Grid','Show 8x8 LED Grid','Identify Slices','Show in Output'];
const AO_PRESET_MENU = ['Save','Save As…','-','Reveal in Explorer'];
const AO_FILTER_MODES = ['Nearest','Linear'];
const AO_WARP_MODES = ['Transform','Perspective','Bezier','Linear Grid'];
const VIDEO_FORMATS = ['NTSC','NTSC 23.98','PAL','HD 720p50','HD 720p59.94','HD 720p60',
  'HD 1080i50','HD 1080i59.94','HD 1080i60','HD 1080p23.98','HD 1080p24','HD 1080p25',
  'HD 1080p29.97','HD 1080p30','HD 1080p50','HD 1080p59.94','HD 1080p60'];

/* ---- panels that can be shown / hidden / undocked (View > Panels) ---- */
const PANELS = ['Composition','Group','Layer','Clip','Column','Files','Compositions','Effects',
  'Sources','Monitor','Slices','Notes','Clip Time','Recordings','Render Queue','Shortcuts','Help',
  'SMPTE','Toolbar'];

/* =========================================================================
   MENU BAR  — labels taken from Arena.exe
   l=label  k=shortcut  sub=submenu  sep=separator  chk=toggle  radio=group
   ========================================================================= */
const MENUS = [
 /* Composition menu — captured verbatim from the running application.
    Note there is no Undo/Redo here; those live on the toolbar. */
 {label:'Composition', uiLabel:'Show', items:[
   {l:'Untitled', dis:1},
   {l:'New', k:'ctrl + N', act:'compNew'},
   {l:'Open…', k:'ctrl + O', act:'compOpen'},
   {l:'Import Resolume .avc…', act:'compImportAVC'},
   /* Recent entries are runtime document history. Shipping invented show
      names here made the menu look populated while every row was inert. */
   {l:'Open Recent', recent:1},
   {l:'Save', k:'ctrl + S', act:'compSave'},
   {l:'Save As…', k:'ctrl + shift + S', act:'compSaveAs'},
   {sep:1},
   {l:'Media Manager…', act:'openMediaManager'},
   {sep:1},
   {l:'Copy Effects', act:'compCopyFx'},
   {l:'Paste Effects', act:'compPasteFx'},
   {sep:1},
   {l:'Global Transport', sub:GLOBAL_TRANSPORT.map((v,i)=>({l:v, radio:'globalTransport', on:i===0?1:0}))},
   {l:'Beat Snap', sub:BEAT_SNAP.map((v,i)=>({l:v, radio:'compSnap', on:i===0?1:0}))},
   {l:'Clip Target', sub:CLIP_TARGETS.map((v,i)=>({l:v, radio:'compTarget', on:i===0?1:0}))},
   {l:'Clip Trigger Style', sub:TRIGGER_STYLES.map((v,i)=>({l:v, radio:'compStyle', on:i===0?1:0}))},
   {l:'Trigger First Column On Play', uiLabel:'Trigger First Cue On Play', chk:'compFirstCol'},
   {sep:1},
   {l:'Settings…', k:'ctrl + shift + C', act:'compSettings'}
 ]},
 /* Deck menu — captured verbatim */
 {label:'Deck', uiLabel:'Bank', items:[
   {l:'Downloads', dis:1},
   {l:'New', k:'ctrl + K', act:'deckNew'},
   {l:'Insert Before', act:'deckInsB'},
   {l:'Insert After', act:'deckInsA'},
   {l:'Duplicate', act:'deckDup'},
   {l:'Close', act:'deckClose'},
   {l:'Rename', act:'deckRename'},
   {sep:1},
   {l:'Clear Clips', act:'deckClear'},
   {l:'Remove', act:'deckRemove'},
   {sep:1},
   {l:'Color', colors:1, target:'deck'}
 ]},
 /* Layer menu — item order captured from the running application */
 {label:'Layer', items:[
   {l:'Layer 1', dis:1},
   {l:'New', k:'ctrl + L', act:'layerNew'},
   {l:'Insert Above', act:'layerInsA'},
   {l:'Insert Below', act:'layerInsB'},
   {l:'Duplicate', act:'layerDup'},
   {l:'Rename', act:'layerRename'},
   {l:'Copy Effects'},
   {l:'Paste Effects'},
   {l:'Fold', act:'layerFold'},
   {sep:1},
   {l:'Clear Clips', act:'layerClear'},
   {l:'Remove', act:'layerRemove'},
   {sep:1},
   {l:'Group', sub:[
     {l:'New', k:'Ctrl+G'},
     {sep:1},
     {l:'Group 1', radio:'layerGroup'},
     {l:'None', radio:'layerGroup', on:1}]},
   {sep:1},
   {l:'Ignore Column Trigger', uiLabel:'Ignore Cue Trigger', chk:'layerIgnore'},
   {l:'Trigger First Clip On Play', chk:'layerFirst'},
   {l:'Fader Start', chk:'layerFader'},
   {sep:1},
   {l:'Mask Mode', sub:MASK_MODES.map((v,i)=>({l:v, radio:'layerMask', on:i===0?1:0}))},
   {sep:1},
   {l:'Lock Content', chk:'layerLock'},
   {sep:1},
   {l:'Color', colors:1, target:'layer'}
 ]},
 /* Column menu — captured verbatim */
 {label:'Column', uiLabel:'Cue', items:[
   {l:'Column 1', uiLabel:'Cue 1', dis:1},
   {l:'Beat Snap', sub:[{l:DETERMINED, radio:'colSnap', on:1},{sep:1},
     ...BEAT_SNAP.map(v=>({l:v, radio:'colSnap'}))]},
   {sep:1},
   {l:'New', k:'ctrl + T', act:'colNew'},
   {l:'Insert Before', act:'colInsB'},
   {l:'Insert After', act:'colInsA'},
   {l:'Duplicate', act:'colDup'},
   {l:'Rename', act:'colRename'},
   {sep:1},
   {l:'Clear Clips', act:'colClear'},
   {l:'Remove', act:'colRemove'},
   {l:'Remove All Before', act:'colRemoveBefore'},
   {l:'Remove All After', act:'colRemoveAfter'},
   {sep:1},
   {l:'Color', colors:1, target:'column'}
 ]},
 {label:'Clip', items:[
   {l:'Cut', k:'Ctrl+X'},
   {l:'Copy', k:'Ctrl+C'},
   {l:'Paste', k:'Ctrl+V'},
   {l:'Select All Including Empty'},
   {sep:1},
   {l:'New Source', sub:[{l:'Quick Search…'},{sep:1},{l:'Solid Color'},{l:'Text Animator'},{l:'Video Router'},{l:'Test Card'},{l:'Blank'}]},
   {l:'New Effect', sub:[{l:'Quick Search…'},{sep:1},{l:'Transform'},{l:'Blur'},{l:'Kaleidoscope'},{l:'Twitch'}]},
   {l:'Create Blank'},
   {sep:1},
   {l:'Rename', act:'clipRename'},
   {l:'Clear', act:'clipClear'},
   {l:'Strip Video'},
   {l:'Strip Audio'},
   {sep:1},
   {l:'Copy Effects', act:'clipCopyFx'},
   {l:'Paste Effects'},
   {sep:1},
   {l:'Transport', sub:TRANSPORTS.map((v,i)=>({l:v, radio:'clipTransport', on:i===0?1:0}))},
   {l:'Beat Snap', sub:[{l:'Composition Determined', radio:'clipSnap', on:1},{sep:1},
     ...BEAT_SNAP.map(v=>({l:v, radio:'clipSnap'}))]},
   {l:'Clip Target', sub:[{l:'Composition Determined', radio:'clipTarget', on:1},{sep:1},
     ...CLIP_TARGETS.map(v=>({l:v, radio:'clipTarget'}))]},
   {l:'Trigger Style', sub:[{l:'Composition Determined', radio:'clipStyle', on:1},{sep:1},
     ...TRIGGER_STYLES.map(v=>({l:v, radio:'clipStyle'}))]},
   {l:'Fader Start', sub:[{l:'Layer Determined', radio:'clipFader', on:1},{sep:1},{l:'Off', radio:'clipFader'},{l:'On', radio:'clipFader'}]},
   {l:'Ignore Column Trigger', uiLabel:'Ignore Cue Trigger', sub:[{l:'Layer Determined', radio:'clipIgnore', on:1},{sep:1},{l:'Off', radio:'clipIgnore'},{l:'On', radio:'clipIgnore'}]},
   {l:'Persistent', chk:'clipPersistent'},
   {sep:1},
   {l:'Resize', sub:RESIZE_MODES.map(v=>({l:v}))},
   {l:'Thumbnail', sub:[{l:'Update'},{l:'Load From File'},{sep:1},{l:'Revert To Default'}]},
   {l:'Copy Image'},
   {sep:1},
   {l:'Edit in Wire', uiLabel:'Edit in SHOWAVE Forge'},
   {l:'Fork with Wire', uiLabel:'Fork with SHOWAVE Forge'},
   {l:'Render To File', act:'clipRender'},
   {l:'Show In File Browser'},
   {l:'Show in Explorer'},
   {sep:1},
   {l:'Color', colors:1, target:'clip'}
 ]},
 {label:'View', items:[
   {l:'Show Crossfader', chk:'viewCrossfader', on:1},
   {l:'Show Layer Transition Controls', chk:'viewTransition'},
   {l:'Show Layer Transport Controls', chk:'viewTransport'},
   {l:'Show Clip Speed Sliders on Layers', chk:'viewSpeedSliders'},
   {l:'Show Big Column Triggers', chk:'viewBigCols'},
   {l:'Show Beat Looper', chk:'viewBeatLooper'},
   {l:'Show Cue Points', uiLabel:'Show Clip Markers', chk:'viewCuePoints'},
   {l:'Show Autopilot', uiLabel:'Show Wave', chk:'viewAutopilot', on:1},
   {l:'Show Dashboard', uiLabel:'Show Quick Controls', chk:'viewDashboard', on:1},
   {l:'Show Audio Controls', chk:'viewAudio', on:1},
   {l:'Show FFT Gain', chk:'viewFFT'},
   {l:'Show FPS & Stats', chk:'viewStats'},
   {l:'Show Undo Toolbar', chk:'viewUndo'},
   {sep:1},
   {l:'Show Composition', uiLabel:'Show Show Panel', chk:'panComposition', on:1},
   {l:'Show Group', chk:'panGroup', on:1},
   {l:'Show Layer', chk:'panLayer', on:1},
   {l:'Show Clip', chk:'panClip', on:1},
   {l:'Show Column', uiLabel:'Show Cue Panel', chk:'panColumn'},
   {l:'Show Monitor', chk:'panMonitor', on:1},
   {l:'Show Files', chk:'panFiles', on:1},
   {l:'Show Compositions', uiLabel:'Show Shows', chk:'panComps', on:1},
   {l:'Show Effects', chk:'panEffects', on:1},
   {l:'Show Sources', chk:'panSources', on:1},
   {l:'Show Slices', chk:'viewSlices'},
   /* Not an Arena menu item. Arena's equivalent lives in the Advanced Output as
      View > Show Slice Grid / Show 8x8 LED Grid (modifiers.htm); this window has
      no such view, so the alignment rulers get their own switch here. */
   {l:'Show Alignment Grid', chk:'viewAlignGrid', k:'Ctrl+Shift+G'},
   {l:'Show Notes', chk:'viewNotes'},
   {l:'Show Clip Time', chk:'viewClipTime'},
   {l:'Show Recordings', chk:'viewRecordings'},
   {l:'Show Render Queue', chk:'viewRenderQueue'},
   {l:'Show Shortcuts', chk:'viewShortcuts'},
   {l:'Show Help', chk:'viewHelp'},
   {l:'Show SMPTE', chk:'viewSMPTE'},
   {sep:1},
   {l:'Show Ableton Link', chk:'viewLink'},
   {l:'Show Pioneer DJ TCNet', chk:'viewTCNet'},
   {l:'Show Denon DJ StageLinQ', chk:'viewStageLinq'},
   {sep:1},
   {l:'Layout', sub:[{l:'Save Preset…'},{l:'Manage Presets…', act:'openPresets'},{sep:1},
     ...PRESETS['Interface'].map((v,i)=>({l:v, radio:'layoutPreset', on:i===5?1:0}))]},
   {sep:1},
   {l:'Manage Presets…', act:'openPresets'},
   {l:'Envelope Editor…', act:'openEnvelope'}
 ]},
 {label:'Output', items:[
   /* The two submenus below carried the same three invented displays, with
      Display 2 ticked as though output were already running on it. output-setup.htm:
      "The Fullscreen and Windowed options enable you to select which of your
      COMPUTER displays the main Resolume output should go to" — the computer's,
      not a list frozen into a data file. `displays:` is the marker app.js expands
      from openlive-displays.js at the moment the menu opens, so a projector
      plugged in mid-show is there the next time it is opened. */
   {l:'Fullscreen', displays:'fullscreen', sub:[]},
   {l:'Windowed', displays:'windowed', sub:[]},
   {l:'Disabled', k:'Ctrl+Shift+D', radio:'outMode'},
   {sep:1},
   {l:'Advanced…', uiLabel:'SHOWAVE Map…', k:'Ctrl+Shift+A', act:'openAdvanced'},
   {sep:1},
   /* Both entries above the separator refuse themselves and say why (app.js:1930)
      — Spout needs a shared GPU handle, NDI needs mDNS and raw UDP.
      The Stream & Record dialog that used to sit below them has been retired:
      streaming now lives in Advanced Output as a Broadcast screen, where the
      raster, the Feeds and the Destinations are one object that saves with the
      output document, and Go Live is in that window's footer. Two surfaces
      setting the same things is worse than one, even when one of them is
      familiar. streaming.htm still opens with "It's not possible to directly
      stream from Resolume", so all of it remains a clone extension. */
   {l:'Composition output sharing', uiLabel:'Show output sharing', sub:[
     {l:`Texture sharing (${SOURCE_TEXTURE_TRANSPORT.live==='syphon'?'Syphon':'Spout'})`, chk:'outSpout'},
     {l:'Network streaming (NDI)', chk:'outNDI'}]},
   /* OpenLive Broadcast is its own application, the way Wire is: it captures a
      screen or a camera and multistreams with no Arena at all. This entry is the
      hand-off between the two, not an owner relationship — opened from here it
      offers this composition's Broadcast screens as one more source. */
   {l:'OpenLive Broadcast…', uiLabel:'SHOWAVE Broadcast…', act:'openBroadcast'},
   {sep:1},
   {l:'Identify Displays', act:'identify'},
   {l:'Open System Display Preferences'},
   {sep:1},
   {l:'Show FPS', chk:'outFPS'},
   {l:'Show Test Card', k:'Ctrl+Shift+L', chk:'outTest'},
   {l:'Show Display Info', chk:'outInfo'},
   {sep:1},
   {l:'Snapshot', k:'Ctrl+Shift+P', act:'snapshot'},
   /* Was {chk:'outRecord'} - a checkbox whose flag appeared exactly once in
      the whole codebase, here. It toggled nothing. recording.htm gives this
      the Record Panel; the transport BROADCAST button is the same control,
      and two surfaces exposing one control must agree about whether it
      works, so this now drives it. */
   {l:'Record', uiLabel:'Broadcast Record', act:'broadcastRecord'}
 ]},
 {label:'Shortcuts', items:[
   {l:'Edit Application Key Map', k:'Shift+Ctrl+K', act:'shortcutKey'},
   {l:'Edit Application MIDI Map', k:'Shift+Ctrl+M', act:'shortcutMidiApp'},
   {l:'Edit Composition MIDI Map', uiLabel:'Edit Show MIDI Map', act:'shortcutMidiComp'},
   {l:'Edit OSC Map', k:'Shift+Ctrl+O', act:'shortcutOSC'},
   {l:'Edit DMX Map', k:'Shift+Ctrl+X', act:'shortcutDMX'},
   {sep:1},
   {l:'Stop Editing', k:'Esc', act:'shortcutStop'},
   {sep:1},
   {l:'Shortcuts Window…', act:'openShortcuts'},
   {sep:1},
   {l:'Clear Shortcut'},
   {l:'Clear Shortcuts'},
   {sep:1},
   {l:'Input Maps', sub:[{l:'New'},{l:'Open…'},{l:'Save as…'},{sep:1},
     ...PRESETS['MIDI Shortcuts'].map((v,i)=>({l:v, radio:'inputMap', on:i===0?1:0}))]}
 ]},
 {label:'Help', items:[
   {l:'View Manual'},
   {l:'Video Training'},
   {l:'Community Forum'},
   {sep:1},
   {l:'Check for updates…'},
   {l:'Show Log File'},
   {sep:1},
   {l:'Encoder Editor…', act:'openEncoderEditor'},
   {l:'Fixture Editor…', act:'openFixtureEditor'},
   {l:'Audio Preferences…', act:'openPrefsAudio'},
   {l:'Preferences…', act:'openPrefs'},
   {sep:1},
   {l:'Register…', act:'openPrefsReg'},
   {l:'About', act:'about'}
 ]}
];

/* ---- context menus ---- */
const CTX_CLIP   = MENUS[4].items;
/* Undock belongs to panel chrome (Layouts), not to a Layer's context menu. */
const CTX_LAYER  = MENUS[2].items;
const CTX_COLUMN = MENUS[3].items;
const CTX_DECK   = MENUS[1].items;

const CTX_PARAM = [
  ...PARAM_ANIMATION.map((v,i)=>({l:v, radio:'paramAnim', on:i===0?1:0})),
  {l:'Dashboard Dial', sub:[1,2,3,4,5,6,7,8].map(n=>({l:'Dial '+n}))},
  {sep:1},
  {l:'Apply Param Animation Preset', sub:PRESETS['Animation'].map(v=>({l:v}))},
  {sep:1},
  {l:'Reset Value', act:'paramReset'},
  {l:'Invert Value', chk:'paramInvert'},
  {sep:1},
  {l:'Create Note Shortcut'},
  {l:'Create Controller Shortcut'},
  {l:'Create PitchBend Shortcut'},
  {l:'Create OSC Output Shortcut'},
  {l:'Create DMX Shortcut'},
  {l:'Duplicate Shortcut'},
  {l:'Clear Shortcut'}
];

const CTX_MONITOR = [
  ...MONITOR_SOURCES.map((v,i)=>({l:v, radio:'monSrc', on:i===0?1:0})),
  {sep:1},
  {l:'Transform Widget', chk:'monWidget', on:1},
  {l:'Black BG', chk:'monBlack'},
  {sep:1},
  {l:'Duplicate Monitor'},
  {l:'Undock Panel'}
];

const CTX_PANEL = [
  {l:'Hide'},
  {l:'Undock'},
  {sep:1},
  {l:'Fold'},
  {l:'Unfold'}
];

/* ---- browser trees ---- */
const FILE_ROOTS = ['System','Drives','Home','Downloads','Favorites','CD/DVD Drive',
  'Snapshots','Recordings','Renders'];
const MEDIA_FILTERS = ['All Media','Video','Audio','Stills','AudioVideo','VideoOnly','AudioOnly'];

/* The compositions that ACTUALLY exist in this checkout, and their paths, so
   double-clicking one opens it. This list used to be eight invented names —
   "Summer Tour 2026", "Festival Mainstage" and friends — which is a browser
   advertising files that were never there. reference/compositions/ is the .avc
   regression corpus (real production sets, 7.25.2–7.27.1); assets/default/ is
   the demo the Composition > Open… menu item loads. */
const COMPS_TREE = []; // Release packages start without developer/demo compositions.

/* ---- demo composition ---- */
const DECKS = [
  {name:'Intro', color:'#2f6db3'},
  {name:'Build', color:'#27ae60'},
  {name:'Peak',  color:'#c0392b'},
  {name:'Chill', color:'#7d5ab5'},
  {name:'Logos', color:'none'}
];
const CLOSED_DECKS = ['Ambient','VIP Show'];

const CLIP_NAMES = [
  ['Neon Rings','Strobe Grid','Liquid Gold','Smoke Trails','Wire Tunnel','Glass Shards','Pulse Field',''],
  ['City Flyover','Particle Rain','Hex Bloom','Laser Sweep','Ink Drop','Data Storm','',''],
  ['Kinetic Type','Warp Core','Star Burst','Chrome Wave','Void Walker','','Aurora',''],
  ['VJ Loop 044','Fract Zoom','Retro Sun','Glitch Face','','Tri Field','',''],
  ['Logo Stinger','Lower Third','Countdown','White Flash','Camera 1','NDI Feed','','']
];

/* ---------------------------------------------------------------------------
   Publish to window.
   A top-level `const` in a classic script lives in the script scope, NOT on
   window. app.js and wire.js share that scope so they read these directly, but
   workspace.html's inline module reads `window.MENUS`, and the panels read
   window.CTX_* — those came back undefined, so every menu-bar dropdown and
   every context menu silently fell back to a single disabled "—" entry.
   Everything below is data this file already owns; nothing new is invented.
   --------------------------------------------------------------------------- */
Object.assign(window, {
  BUILD, COLOR_SWATCHES,
  BLEND_CATEGORIES, BLEND_50, BLEND_TRANSITIONS, BLEND_CREATIVE, BLEND_MODES,
  LOCAL_TRANSITION_MODES,
  TRANSITION_EXTRAS, VIDEO_EFFECTS, AUDIO_EFFECTS, AUDIO_EFFECT_PARAMS, FFGL_PLUGINS, WIRE_PATCHES,
  OFFLINE_EFFECT_GROUPS,
  WIRE_SOURCES, WIRE_EFFECTS, WIRE_MIXERS, WIRE_NOTES,
  SOURCES_TREE, PRESETS, CODECS, RESOLUTIONS,
  PLAY_MODES, TRANSPORTS, BEAT_SNAP, CLIP_TARGETS, TRIGGER_STYLES,
  RESIZE_MODES, AUTO_SIZE, MASK_MODES, CROSSFADER_GROUPS,
  FADER_START, IGNORE_COL, DIRECTIONS, DETERMINED, PARAM_MODEL,
  AUTOPILOT_RANDOM, AUTOPILOT_DURATION, AUTOPILOT_ACTIONS,
  XFADER_BEHAVIOUR, XFADER_CURVE, PARAM_ANIMATION, GLOBAL_TRANSPORT,
  RECORD_STATES, MONITOR_SOURCES,
  DMX_COLOR_SPACES, DMX_EXTRA_CHANNELS, LUMIVERSES,
  AO_SLICE_TOOLS, AO_ADD_MENU, AO_NEW_SCREEN, AO_SLICE_CTX, AO_STAGES,
  AO_OUTPUT_DEVICES, AO_DEVICE_BY_LABEL, AO_SCREEN_CTX, AO_VIEW_OPTIONS, AO_PRESET_MENU,
  AO_FILTER_MODES, AO_WARP_MODES, VIDEO_FORMATS,
  PANELS, MENUS,
  CTX_CLIP, CTX_LAYER, CTX_COLUMN, CTX_DECK, CTX_PARAM, CTX_MONITOR, CTX_PANEL,
  FILE_ROOTS, MEDIA_FILTERS, COMPS_TREE,
  DECKS, CLOSED_DECKS, CLIP_NAMES,
});
