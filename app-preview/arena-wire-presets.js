/* ===========================================================================
   arena-wire-presets.js - clean-room scalar snapshots for shipped Wire effects
   ---------------------------------------------------------------------------
   Authority: the preset JSON embedded in the Arena 7.27.1 installation's
   plugins/wire/CRT.wired and plugins/wire/Strokes.wired files. Those files key
   values by exposed Wire node id; this manifest maps the ids to the exact
   parameter names from each patch's inputOrder.

   No .wired file and no bundled image is copied here. Strokes presets refer to
   proprietary brush images. Their paths are retained only as unsupported
   metadata so the UI can explain why the analytic Canvas brush is not a pixel-
   identical replacement. Texture In is the effect's upstream frame, not a
   user parameter. Reset is a trigger rather than snapshot state, so neither is
   included in params.
   =========================================================================== */
(() => {
'use strict';

const CRT_SHARED = Object.freeze({
  'Color Left': 0,
  'Power Left': 1,
  'Tilt Left': 0,
  'Color Middle': 1,
  'Power Middle': 1,
  'Tilt Middle': 0,
  'Color Right': 2,
  'Power Right': 1,
  'Tilt Right': 0,
  /* Wire declares the option values out of display order: 1 is Fit to Output,
     0 is Native. Keep the numeric value because that is what its preset stores. */
  'Display Mode': 1
});

const crt = (preset, params) => ({
  plugin: 'CRT',
  preset,
  params: Object.assign({}, CRT_SHARED, params)
});

const unsupportedBrush = path => ({
  Resource: {
    type: 'resourceImage',
    path,
    reason: 'Bundled Wire brush image is not redistributed.'
  }
});

const records = [
  crt('Big Beautiful Beams', {
    Columns:310, Rows:40, Shift:0, Vignette:10, Fisheye:30,
    Spread:5, Brightness:60, 'Bloom Amount':100, 'Bloom Width':50,
    'Bloom Height':100, 'Between Slots':0, 'Left/Right':0,
    'Top/Bottom':4, 'Height Scale':4
  }),
  crt('Big Grid Energy', {
    Columns:80, Rows:40, Shift:0, Vignette:40, Fisheye:75,
    Spread:5, Brightness:75, 'Bloom Amount':45, 'Bloom Width':120,
    'Bloom Height':120, 'Between Slots':2, 'Left/Right':2,
    'Top/Bottom':1, 'Height Scale':4
  }),
  crt('Bit of a Grid', {
    Columns:225, Rows:115, Shift:0, Vignette:0, Fisheye:0,
    Spread:40, Brightness:50, 'Bloom Amount':30, 'Bloom Width':300,
    'Bloom Height':0, 'Between Slots':1, 'Left/Right':4,
    'Top/Bottom':1, 'Height Scale':4
  }),
  crt('Jagged Lines', {
    Columns:320, Rows:100, Shift:25, Vignette:0, Fisheye:0,
    Spread:100, Brightness:50, 'Bloom Amount':35, 'Bloom Width':100,
    'Bloom Height':0, 'Between Slots':1, 'Left/Right':0,
    'Top/Bottom':4, 'Height Scale':2
  }),
  crt('Mind the Gap', {
    Columns:185, Rows:120, Shift:0, Vignette:10, Fisheye:50,
    Spread:100, Brightness:60, 'Bloom Amount':30, 'Bloom Width':100,
    'Bloom Height':0, 'Between Slots':0, 'Left/Right':4,
    'Top/Bottom':1, 'Height Scale':2
  }),
  crt('Red-Green Lensch Flare', {
    Columns:305, Rows:200, Shift:100, Vignette:20, Fisheye:15,
    Spread:5, Brightness:100, 'Bloom Amount':65, 'Bloom Width':100,
    'Bloom Height':100, 'Between Slots':1, 'Left/Right':2,
    'Top/Bottom':1, 'Color Middle':2, 'Color Right':1, 'Height Scale':2
  }),
  crt('Scanlines Horizontal', {
    Columns:390, Rows:120, Shift:0, Vignette:10, Fisheye:0,
    Spread:50, Brightness:50, 'Bloom Amount':75, 'Bloom Width':100,
    'Bloom Height':40, 'Between Slots':1, 'Left/Right':1,
    'Top/Bottom':2, 'Height Scale':4
  }),
  crt('Scanlines Vertical', {
    Columns:235, Rows:160, Shift:0, Vignette:10, Fisheye:0,
    Spread:100, Brightness:50, 'Bloom Amount':60, 'Bloom Width':100,
    'Bloom Height':25, 'Between Slots':2, 'Left/Right':4,
    'Top/Bottom':0, 'Height Scale':4
  }),
  crt('Trinitron', {
    Columns:490, Rows:240, Shift:100, Vignette:25, Fisheye:0,
    Spread:40, Brightness:60, 'Bloom Amount':50, 'Bloom Width':100,
    'Bloom Height':50, 'Between Slots':1, 'Left/Right':2,
    'Top/Bottom':1, 'Height Scale':3
  }),

  {
    plugin:'Strokes', preset:'Adamantium Claws',
    params:{
      Amount:1024, 'Edges Only':true, 'Frequency Mode':'Hz', Frequency:30,
      'Size Mode':'Brightness', Size:0.5, Variation:0.6000000238418579,
      Swirl:0.30000001192092896, Flow:0, Feedback:0.30000001192092896,
      Rotation:0
    },
    unsupported:unsupportedBrush('Resource/Strokes_Etch-a-Scratch.png')
  },
  {
    plugin:'Strokes', preset:'Arrow Cloud',
    params:{
      Amount:2048, 'Edges Only':true, 'Frequency Mode':'BPM', Frequency:240,
      'Size Mode':'Brightness', Size:0.10000000149011612,
      Variation:0.6000000238418579, Swirl:0.20000000298023224,
      Flow:0.01999999955296516, Feedback:0.5, Rotation:0
    },
    unsupported:unsupportedBrush('Resource/Strokes_Arrow_Faded.png')
  },
  {
    plugin:'Strokes', preset:'Bubble Bath',
    params:{
      Amount:1024, 'Edges Only':true, 'Frequency Mode':'Hz', Frequency:30,
      'Size Mode':'Random', Size:0.2199999988079071,
      Variation:0.44999998807907104, Swirl:0.550000011920929,
      Flow:0.800000011920929, Feedback:0.20000000298023224, Rotation:0
    },
    unsupported:unsupportedBrush('Resource/Strokes_Bubble_Bath.png')
  },
  {
    plugin:'Strokes', preset:'Floating Oil',
    params:{
      Amount:1024, 'Edges Only':false, 'Frequency Mode':'Hz', Frequency:30,
      'Size Mode':'Random', Size:0.1340000033378601, Variation:0,
      Swirl:0.30000001192092896, Flow:1, Feedback:0.8700000047683716,
      Rotation:0
    },
    unsupported:unsupportedBrush('Resource/Strokes_Brush.png')
  },
  {
    plugin:'Strokes', preset:'Product Placement',
    params:{
      Amount:2048, 'Edges Only':false, 'Frequency Mode':'BPM', Frequency:120,
      'Size Mode':'Brightness', Size:0.05000000074505806, Variation:0.25,
      Swirl:0.25, Flow:0, Feedback:0.30000001192092896, Rotation:0
    },
    unsupported:unsupportedBrush('Resource/resolume_logo.png')
  },
  {
    plugin:'Strokes', preset:'Starry Night',
    params:{
      Amount:1024, 'Edges Only':true, 'Frequency Mode':'Hz', Frequency:30,
      'Size Mode':'Random', Size:0.15000000596046448, Variation:0,
      Swirl:0.6000000238418579, Flow:0.6000000238418579,
      Feedback:0.800000011920929, Rotation:0
    },
    unsupported:unsupportedBrush('Resource/Strokes_Brush.png')
  }
];

records.forEach(record => {
  Object.freeze(record.params);
  if(record.unsupported){
    Object.keys(record.unsupported).forEach(key => Object.freeze(record.unsupported[key]));
    Object.freeze(record.unsupported);
  }
  Object.freeze(record);
});
Object.freeze(records);

const byKey = new Map(records.map(record => [record.plugin + '\u0000' + record.preset, record]));
const presetsFor = plugin => records.filter(record => record.plugin === String(plugin));
const find = (plugin, preset) => byKey.get(String(plugin) + '\u0000' + String(preset)) || null;

window.ArenaWirePresets = Object.freeze({
  version:'7.27.1',
  records,
  presetsFor,
  find
});
})();
