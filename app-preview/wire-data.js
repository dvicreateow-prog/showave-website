/* ===========================================================================
   Wire UI clone — data layer
   Data model taken from the Wire MCP server's own specification; patch,
   example, template and interface-preset names taken from the installer file
   table. The exact node class list is filled from a running Wire instance via
   class { action: "list" } — until then the categories below are the documented
   set and NODE_CLASSES holds the representative subset.
   =========================================================================== */

const WIRE_BUILD = { product:'Wire', version:'7.27.1' };

/* ---- bundle data types, coloured by family ---- */
const DATA_TYPES = [
  {family:'Primitive', color:'#c9c9c9', items:['Trigger','Float','Int','Bool','String']},
  {family:'Vector',    color:'#e0c36a', items:['Float2','Float3','Float4','Color']},
  {family:'GPU',       color:'#6fbf5f', items:['Texture2dR','Texture2dRgba','Material','Procedural']},
  {family:'Geometry',  color:'#6fa8dc', items:['Geometry2d','Transformation2d','Mesh2d','Camera2d','Box2d','Slice']},
  {family:'Protocol',  color:'#c2559b', items:['MIDI','OSC']},
  {family:'Resource',  color:'#e07a3c', items:['ResourceImage','ResourceVideo','ResourceIsf','ResourceLut3d']},
  {family:'Meta',      color:'#8a8a8a', items:['DataType','Flow']}
];
const TYPE_COLOR = {};
DATA_TYPES.forEach(f => f.items.forEach(t => TYPE_COLOR[t] = f.color));

/* ---- flows ----
   Signal    continuous, every frame, realtime
   Event     one-shot trigger, realtime
   Attribute static configuration, non-realtime                              */
const FLOWS = ['Signal','Event','Attribute'];

/* ---- node categories ---- */
const NODE_CATEGORIES = [
  {cat:'Input',        color:'#6fbf5f', items:['Float In','Int In','Bool In','Color In','Texture In','String In','Trigger In','Float2 In','Point In']},
  {cat:'Output',       color:'#cf4a3f', items:['Texture Out','Float Out','Material Out']},
  {cat:'Info',         color:'#8a8a8a', items:['Patch Info','Host Info','Transport Info']},
  {cat:'Generator',    color:'#7d5ab5', items:['Value Noise','Fractal Noise','Simplex Noise','Random','Gradient','Solid Color','Checkerboard']},
  {cat:'Shape',        color:'#6fa8dc', items:['Circle','Rectangle','Hexagon','Triangle','Star','Cross','Chevron','Asterisk','Shape Merge','Shape Outline']},
  {cat:'Mesh',         color:'#5b9bd5', items:['Mesh2d','Grid Mesh','Rasterize','UV Map','Instance Transform']},
  {cat:'Texture',      color:'#4ecdc4', items:['Texture Mix','Channel Pack','Channel Unpack','Texture Math','Resize','Bit Depth','Sample']},
  {cat:'Math',         color:'#c9c9c9', items:['Add','Subtract','Multiply','Divide','Modulo','Power','Clamp','Map Range','Abs','Min','Max','Round','Sin','Cos','Atan2','Mix','Smoothstep']},
  {cat:'Control Flow', color:'#e0c36a', items:['Gate','Switch','If','Hold','Selector','Event Router','Circulate','MIDI Voices']},
  {cat:'Animation',    color:'#ff9505', items:['Sine Oscillator','Saw Oscillator','Triangle Oscillator','Square Oscillator','Timeline','Transport','Easing','Envelope','Delay']},
  {cat:'Collection',   color:'#a29bfe', items:['Collect','Access','Reorder','Compose','Split','Count']},
  {cat:'String',       color:'#f4c780', items:['Format','Concat','Search','Replace','Substring','To String']},
  {cat:'Protocol',     color:'#c2559b', items:['MIDI In','MIDI Out','OSC In','OSC Out','Spectrum In']},
  {cat:'Resource',     color:'#e07a3c', items:['Image','Video','ISF','LUT 3D']},
  {cat:'Slice',        color:'#74b9ff', items:['Slice In','Slice Info','Slice Transform']},
  {cat:'Utility',      color:'#8a8a8a', items:['Comment','Print','Bypass','Null']}
];
const NODE_CLASSES = NODE_CATEGORIES.flatMap(c => c.items.map(n => ({name:n, cat:c.cat, color:c.color})));

/* ---- shipped content (from the installer file table) ---- */
const WIRE_TEMPLATES = [
  {group:'2D',    items:['Basic 2D','Minimal 2D Cloner']},
  {group:'Video', items:['Video Effect','Video Mixer','Video Source']}
];
const WIRE_EXAMPLES = [
  {group:'Basic Effects',   items:['Mirror','Rainbow','Screen Shake','Smooth Transform','Splatter','VHS']},
  {group:'Complex Effects', items:['ChromaChop','Cloner','Distortion','Feedback Pro','Game Boy','Ghost',
    'MultiScreener','SilkScreenShift','Slit Scanner','Space Warper']}
];
const WIRE_TUTORIALS = [
  {group:'Tutorials', items:['Getting Started','Your First Effect','Data Types','Instancing',
    'Shapes and SDFs','Meshes and UVs','Feedback Loops','ISF Shaders','MIDI and OSC',
    'Slices and Mapping','Publishing to Arena']}
];
const WIRE_PATCHES_RECENT = [
  {group:'Recent Patches', items:['Neon Tunnel.wire','Slice Delay.wire','Chroma Bloom.wire',
    'Grid Cloner.wire','Strokes.wire']}
];
/* the .wired patches Arena ships in plugins\wire */
const WIRE_SHIPPED = ['Abstract Field','Acuarela','Bumper','CRT','Grid Cloner','LUT','PiP',
  'SearchLight','Shape Mask','Slice Delay','Slice Outline','Strokes','Tilt Shift','Tunnelines','WarpSpeed'];
const WIRE_LAYOUTS = ['Big Monitor','Dual Display','Monitor Top Right','One Column',
  'Panels Left & Right','Shader Editing','Two Monitors','Wide Patch'];

const WIRE_COLORS = ['none','#c0392b','#e67e22','#f1c40f','#27ae60','#16a0a6','#2f6db3','#7d5ab5','#c2559b'];

/* ---- menus ---- */
const WIRE_MENUS = [
 {label:'Wire', uiLabel:'File', items:[
   {l:'New Patch', k:'Ctrl+N'},
   {l:'New From Template', sub:WIRE_TEMPLATES.flatMap(g => [{l:g.group, dis:1}, ...g.items.map(i=>({l:'   '+i}))])},
   {l:'Open…', k:'Ctrl+O'},
   {l:'Open Recent', sub:WIRE_PATCHES_RECENT[0].items.map(i=>({l:i}))},
   {sep:1},
   {l:'Save', k:'Ctrl+S'},
   {l:'Save As…', k:'Ctrl+Shift+S'},
   {l:'Consolidate…', act:'compile'},
   {l:'Compile…', act:'compile'},
   {sep:1},
   {l:'Settings…', act:'settings'},
   {l:'Quit', k:'Ctrl+Q'}
 ]},
 {label:'Edit', items:[
   {l:'Undo', k:'Ctrl+Z'},
   {l:'Redo', k:'Ctrl+Shift+Z'},
   {sep:1},
   {l:'Cut', k:'Ctrl+X'},
   {l:'Copy', k:'Ctrl+C'},
   {l:'Copy For Sharing', k:'Ctrl+Shift+C'},
   {l:'Paste', k:'Ctrl+V'},
   {l:'Copy Settings'},
   {l:'Paste Settings'},
   {sep:1},
   {l:'Duplicate', k:'Ctrl+D'},
   {l:'Duplicate & Connect', k:'Shift+D'},
   {l:'Destroy', k:'Del'},
   {sep:1},
   {l:'Select All', k:'Ctrl+A'},
   {l:'Select All Unused', k:'Ctrl+Shift+A'},
   {l:'Auto Sort Selection', k:'Ctrl+L'},
   {l:'Rename', k:'Ctrl+Shift+R'},
   {sep:1},
   {l:'Find Node', k:'Ctrl+F'}
 ]},
 {label:'View', items:[
   {l:'Zoom In', k:'Ctrl++'},
   {l:'Zoom Out', k:'Ctrl+-'},
   {l:'Zoom To Fit', k:'Ctrl+0'},
   {l:'Zoom 100%', k:'Ctrl+1'},
   {sep:1},
   {l:'Show Node Panel', chk:'vNode', on:1},
   {l:'Show Patch Panel', chk:'vPatch', on:1},
   {l:'Show Library', chk:'vLib', on:1},
   {l:'Show Dashboard', uiLabel:'Show Quick Controls', chk:'vDash', on:1},
   {l:'Show Stats', chk:'vStats', on:1},
   {l:'Show Resources', chk:'vRes', on:1},
   {l:'Show Notes', chk:'vNotes', on:1},
   {l:'Show Log', chk:'vLog', on:1},
   {l:'Show Monitor', chk:'vMon', on:1},
   {sep:1},
   {l:'Welcome Screen', act:'welcome'},
   {sep:1},
   {l:'Layout', sub:[{l:'Save Preset…'},{l:'Manage Presets…'},{sep:1},
     ...WIRE_LAYOUTS.map((v,i)=>({l:v, radio:'wLayout', on:i===3?1:0}))]}
 ]},
 {label:'Node', items:[
   {l:'Add Node…', k:'Double-click canvas'},
   {sep:1},
   {l:'Bypass'},
   {l:'Pin To Monitor'},
   {l:'Align Left'},
   {l:'Align Top'},
   {sep:1},
   {l:'Open Text Editor', k:'Ctrl+E', act:'isf'},
   {l:'Show Example Patch'},
   {sep:1},
   {l:'Color', colors:1, target:'node'}
 ]},
 {label:'Help', items:[
   {l:'Wire Manual', uiLabel:'Forge Manual'},
   {l:'Tutorials'},
   {l:'Examples'},
   {sep:1},
   {l:'Check for updates…'},
   {l:'Show Log File'},
   {sep:1},
   {l:'About', act:'welcome'}
 ]}
];

/* ---- demo patch: a small Video Effect ---- */
const DEMO_PATCH = {
  nodes: [
    {id:1, cls:'Texture In',      cat:'Input',       x:40,  y:120, ins:[],                       outs:['Texture2dRgba']},
    {id:2, cls:'Float In',        cat:'Input',       x:40,  y:230, ins:[],                       outs:['Float']},
    {id:3, cls:'Transport Info',  cat:'Info',        x:40,  y:320, ins:[],                       outs:['Float','Float']},
    {id:4, cls:'Sine Oscillator', cat:'Animation',   x:230, y:300, ins:['Float','Float'],        outs:['Float']},
    {id:5, cls:'Fractal Noise',   cat:'Generator',   x:230, y:170, ins:['Float','Float2'],       outs:['Texture2dR']},
    {id:6, cls:'Multiply',        cat:'Math',        x:420, y:250, ins:['Float','Float'],        outs:['Float']},
    {id:7, cls:'UV Map',          cat:'Mesh',        x:430, y:120, ins:['Texture2dRgba','Texture2dR','Float'], outs:['Texture2dRgba']},
    {id:8, cls:'Texture Mix',     cat:'Texture',     x:630, y:150, ins:['Texture2dRgba','Texture2dRgba','Float'], outs:['Texture2dRgba']},
    {id:9, cls:'Texture Out',     cat:'Output',      x:820, y:170, ins:['Texture2dRgba'],        outs:[]}
  ],
  wires: [
    {from:1, fo:0, to:7, ti:0}, {from:5, fo:0, to:7, ti:1}, {from:6, fo:0, to:7, ti:2},
    {from:2, fo:0, to:6, ti:0}, {from:4, fo:0, to:6, ti:1}, {from:3, fo:0, to:4, ti:0},
    {from:1, fo:0, to:8, ti:0}, {from:7, fo:0, to:8, ti:1}, {from:2, fo:0, to:8, ti:2},
    {from:8, fo:0, to:9, ti:0}
  ]
};

const DASH_INPUTS = [
  {name:'Amount',    type:'Float',           node:'Float In'},
  {name:'Speed',     type:'Float',           node:'Float In'},
  {name:'Tint',      type:'Color',           node:'Color In'},
  {name:'Source',    type:'Texture2dRgba',   node:'Texture In'}
];
