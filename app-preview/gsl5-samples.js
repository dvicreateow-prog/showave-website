/* SHOWAVE GSL5 built-in local fixture samples
   -------------------------------------------------------------------------
   Original, vendor-neutral training and previsualisation profiles. These are
   useful starting points, not claims about any manufacturer's exact channel
   map. Verify the selected mode against the fixture manual before arming DMX.
   ------------------------------------------------------------------------- */
(function installShowaveGSL5Samples(global) {
  'use strict';

  if (global.ShowaveGSL5Samples) return;

  const VERSION = '5.0.0';
  const COPYRIGHT = '© SHOWAVE. Original generic GSL5 sample; verify against the fixture manual.';
  const SAMPLE_SOURCE_ID = 'showave:gsl5-local-samples:v5';

  const clone = value => JSON.parse(JSON.stringify(value));
  const freeze = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(key => freeze(value[key]));
    return Object.freeze(value);
  };
  const slug = value => String(value || 'sample').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const baseSemantic = attribute => String(attribute || 'control').replace(/-\d+$/, '');
  const familyFor = semantic => {
    if (['dimmer','intensity','shutter'].includes(semantic)) return 'intensity';
    if (['pan','tilt','mirror-pan','mirror-tilt'].includes(semantic)) return 'position';
    if (['red','green','blue','white','amber','uv','lime','cyan','magenta','yellow','cct','cold-white','warm-white','color-wheel'].includes(semantic)) return 'color';
    if (['zoom','focus','iris','gobo','gobo-rotation','prism','prism-rotation','frost','animation-wheel'].includes(semantic)) return 'beam';
    return 'control';
  };
  const title = value => String(value || '').split('-').map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ');

  function channel(attribute, offset, options) {
    const config = options && typeof options === 'object' ? options : {};
    const semantic = config.semantic || baseSemantic(attribute);
    const bits = config.bits === 16 ? 16 : 8;
    const result = {
      attribute, semantic, family:config.family || familyFor(semantic),
      label:config.label || title(attribute), offset, bits,
      fineOffset:bits === 16 ? (config.fineOffset == null ? offset + 1 : config.fineOffset) : null,
      default:config.default == null ? (semantic === 'pan' || semantic === 'tilt' ? 0.5 : 0) : config.default,
      locate:config.locate == null ? (semantic === 'dimmer' || semantic === 'intensity' ? 1 : null) : config.locate,
      powerOn:config.powerOn == null ? 0 : config.powerOn,
      highlight:config.highlight == null ? null : config.highlight,
      lowlight:config.lowlight == null ? null : config.lowlight,
      mix:config.mix || (semantic === 'dimmer' || semantic === 'intensity' ? 'htp' : 'ltp'),
      functions:Array.isArray(config.functions) ? clone(config.functions) : [],
      cell:config.cell ? clone(config.cell) : null
    };
    return result;
  }

  function cells(count, components, start, columns) {
    const output = [], width = Math.max(1, Number(columns) || count), first = Number(start) || 0;
    for (let cellIndex = 0; cellIndex < count; cellIndex++) {
      const cell = {id:`cell-${cellIndex + 1}`, name:`Cell ${cellIndex + 1}`,
        x:cellIndex % width, y:Math.floor(cellIndex / width)};
      components.forEach((semantic, componentIndex) => output.push(channel(
        `${semantic}-${cellIndex + 1}`, first + cellIndex * components.length + componentIndex,
        {semantic, label:`${title(semantic)}: Cell ${cellIndex + 1}`, cell}
      )));
    }
    return output;
  }

  function repeated(attribute, count, start, columns) {
    const output = [], width = Math.max(1, Number(columns) || count), first = Number(start) || 0;
    for (let index = 0; index < count; index++) output.push(channel(`${attribute}-${index + 1}`, first + index, {
      semantic:attribute, label:`${title(attribute)}: Circuit ${index + 1}`,
      cell:{id:`circuit-${index + 1}`, name:`Circuit ${index + 1}`, x:index % width, y:Math.floor(index / width)}
    }));
    return output;
  }

  function raw(count) {
    return Array.from({length:count}, (_, index) => channel(`raw-${index + 1}`, index, {
      semantic:'raw-control', family:'control', label:`Raw DMX ${index + 1}`
    }));
  }

  const definitions = [];
  function add(key, name, category, mode, channels, options) {
    const config = options && typeof options === 'object' ? options : {};
    const footprint = config.footprint || Math.max(1, ...channels.map(item => Math.max(item.offset, item.fineOffset == null ? item.offset : item.fineOffset) + 1));
    definitions.push({
      id:`showave:sample:${slug(key)}`,
      name,
      manufacturer:'GSL5 Local',
      mode,
      footprint,
      channels,
      virtualControls:[],
      source:{
        provider:'SHOWAVE', format:'GSL5 Sample', origin:'sample', filename:'Built-in local sample', relativePath:'',
        fixtureVersion:VERSION, copyright:COPYRIGHT, sourceId:SAMPLE_SOURCE_ID,
        digest:`gsl5-sample-${VERSION}`, importedAt:0, officialLibrary:'', modeIndex:definitions.length,
        modeId:slug(key), macroCount:0, paletteCount:0, unknownElements:[], sample:true,
        category, subcategory:config.subcategory || '',
        tags:[category, name, mode].concat(config.tags || []),
        safety:config.safety || 'verify-fixture-manual',
        description:config.description || 'Vendor-neutral local sample for programming and previsualisation.'
      }
    });
  }

  const shutterFunctions = [
    {id:'closed', name:'Closed', dmxStart:0, dmxEnd:7, displayStart:0, displayEnd:0},
    {id:'open', name:'Open', dmxStart:8, dmxEnd:15, displayStart:100, displayEnd:100},
    {id:'strobe', name:'Strobe slow to fast', dmxStart:16, dmxEnd:255, displayStart:1, displayEnd:25, unit:'hz'}
  ];
  /* A shutter must REST in its Open band, not at DMX 255. Every sample
     shutter took the channel() defaults - no Locate, default 0 - so the FULL
     preset, whose fallback was 1, drove all 18 to their fastest strobe the
     moment a clip fired, and HOME closed them. 11.5/255 is the centre of the
     Open band above. */
  const SHUTTER_OPEN = 11.5 / 255;
  const shutter = offset => channel('shutter', offset, {functions:shutterFunctions, default:SHUTTER_OPEN, locate:SHUTTER_OPEN});
  const relayFunctions = [
    {id:'off', name:'Off', dmxStart:0, dmxEnd:127, displayStart:0, displayEnd:0},
    {id:'on', name:'On', dmxStart:128, dmxEnd:255, displayStart:1, displayEnd:1}
  ];

  /* Dimmers & power */
  add('dimmer-1ch','Generic Dimmer','Dimmers & Power','1 channel',[channel('dimmer',0)]);
  add('dimmer-16bit','Generic Dimmer 16-bit','Dimmers & Power','2 channel: 16-bit',[channel('dimmer',0,{bits:16,fineOffset:1})]);
  add('dimmer-strobe','Dimmer + Strobe','Dimmers & Power','2 channel',[channel('dimmer',0),shutter(1)]);
  add('dimmer-pack-4','Four-Circuit Dimmer Pack','Dimmers & Power','4 channel',repeated('dimmer',4,0,4));
  add('relay-pack-4','Four-Circuit Relay Template','Dimmers & Power','4 channel',Array.from({length:4},(_,index)=>channel(`relay-${index+1}`,index,{semantic:'relay',family:'control',functions:relayFunctions})),{safety:'manual-verification-required',tags:['switch pack','relay']});

  /* LED PARs, washes and uplights */
  add('led-par-rgb','LED PAR RGB','LED PAR & Wash','RGB · 3 channel',cells(1,['red','green','blue'],0,1));
  add('led-par-dim-rgb','LED PAR Dim + RGB','LED PAR & Wash','Dim + RGB · 4 channel',[channel('dimmer',0),...cells(1,['red','green','blue'],1,1)]);
  add('led-par-dim-rgbw','LED PAR Dim + RGBW','LED PAR & Wash','Dim + RGBW · 5 channel',[channel('dimmer',0),...cells(1,['red','green','blue','white'],1,1)]);
  add('led-par-dim-rgba','LED PAR Dim + RGBA','LED PAR & Wash','Dim + RGBA · 5 channel',[channel('dimmer',0),...cells(1,['red','green','blue','amber'],1,1)]);
  add('led-par-dim-rgbwa','LED PAR Dim + RGBWA','LED PAR & Wash','Dim + RGBWA · 6 channel',[channel('dimmer',0),...cells(1,['red','green','blue','white','amber'],1,1)]);
  add('led-par-dim-rgbwauv','LED PAR Dim + RGBWAUV','LED PAR & Wash','Dim + RGBWAUV · 7 channel',[channel('dimmer',0),...cells(1,['red','green','blue','white','amber','uv'],1,1)]);
  add('led-par-dim-rgbl','LED PAR Dim + RGBL','LED PAR & Wash','Dim + RGBL · 5 channel',[channel('dimmer',0),...cells(1,['red','green','blue','lime'],1,1)]);
  add('led-par-dim-rgbal','LED PAR Dim + RGBAL','LED PAR & Wash','Dim + RGBAL · 6 channel',[channel('dimmer',0),...cells(1,['red','green','blue','amber','lime'],1,1)]);
  add('led-tunable-white','Tunable White Wash','LED PAR & Wash','Dim + CW + WW · 3 channel',[channel('dimmer',0),channel('cold-white',1),channel('warm-white',2)]);
  add('battery-uplight','Battery Uplight RGBWAUV','LED PAR & Wash','Extended · 8 channel',[channel('dimmer',0),...cells(1,['red','green','blue','white','amber','uv'],1,1),shutter(7)],{tags:['wireless','uplight','battery']});

  /* Moving lights */
  add('moving-wash-compact','Moving Wash RGBW','Moving Heads','Compact · 10 channel',[
    channel('pan',0),channel('tilt',1),channel('dimmer',2),shutter(3),
    channel('red',4),channel('green',5),channel('blue',6),channel('white',7),channel('zoom',8,{default:.5}),channel('movement-speed',9)
  ],{tags:['moving head','wash']});
  add('moving-wash-extended','Moving Wash RGBW 16-bit','Moving Heads','Extended · 14 channel',[
    channel('pan',0,{bits:16,fineOffset:1}),channel('tilt',2,{bits:16,fineOffset:3}),channel('movement-speed',4),
    channel('dimmer',5),shutter(6),channel('red',7),channel('green',8),channel('blue',9),channel('white',10),
    channel('zoom',11,{bits:16,fineOffset:12,default:.5}),channel('frost',13)
  ],{tags:['moving head','wash','16 bit']});
  add('moving-wash-cmy','Moving Wash CMY 16-bit','Moving Heads','CMY · 14 channel',[
    channel('pan',0,{bits:16,fineOffset:1}),channel('tilt',2,{bits:16,fineOffset:3}),channel('movement-speed',4),
    channel('dimmer',5),shutter(6),channel('cyan',7),channel('magenta',8),channel('yellow',9),
    channel('cct',10),channel('zoom',11,{bits:16,fineOffset:12,default:.5}),channel('frost',13)
  ],{tags:['moving head','wash','cmy']});
  add('moving-spot-compact','Moving Spot','Moving Heads','Compact · 13 channel',[
    channel('pan',0),channel('tilt',1),channel('movement-speed',2),channel('dimmer',3),shutter(4),
    channel('color-wheel',5),channel('gobo',6),channel('gobo-rotation',7),channel('focus',8,{default:.5}),channel('prism',9),
    channel('prism-rotation',10),channel('iris',11),channel('frost',12)
  ],{tags:['moving head','spot','gobo']});
  add('moving-spot-extended','Moving Spot 16-bit','Moving Heads','Extended · 19 channel',[
    channel('pan',0,{bits:16,fineOffset:1}),channel('tilt',2,{bits:16,fineOffset:3}),channel('movement-speed',4),
    channel('dimmer',5),shutter(6),channel('color-wheel',7),channel('gobo',8),channel('gobo-rotation',9),
    channel('focus',10,{bits:16,fineOffset:11,default:.5}),channel('prism',12),channel('prism-rotation',13),channel('iris',14),
    channel('zoom',15,{bits:16,fineOffset:16,default:.5}),channel('frost',17),channel('animation-wheel',18)
  ],{tags:['moving head','spot','gobo','16 bit']});
  add('moving-beam','Moving Beam 16-bit','Moving Heads','Beam · 12 channel',[
    channel('pan',0,{bits:16,fineOffset:1}),channel('tilt',2,{bits:16,fineOffset:3}),channel('dimmer',4),
    shutter(5),channel('color-wheel',6),channel('gobo',7),channel('prism',8),
    channel('prism-rotation',9),channel('focus',10,{default:.5}),channel('frost',11)
  ],{tags:['moving head','beam']});
  add('moving-hybrid','Moving Hybrid BSW 16-bit','Moving Heads','Beam / Spot / Wash · 20 channel',[
    channel('pan',0,{bits:16,fineOffset:1}),channel('tilt',2,{bits:16,fineOffset:3}),channel('movement-speed',4),
    channel('dimmer',5),shutter(6),channel('color-wheel',7),channel('gobo',8),channel('gobo-rotation',9),
    channel('prism',10),channel('prism-rotation',11),channel('focus',12,{bits:16,fineOffset:13,default:.5}),channel('iris',14),
    channel('zoom',15,{bits:16,fineOffset:16,default:.5}),channel('frost',17),channel('animation-wheel',18),channel('beam-shaper',19)
  ],{tags:['moving head','beam spot wash','hybrid']});
  add('scanner','DMX Scanner / Mirror','Moving Heads','10 channel',[
    channel('mirror-pan',0,{semantic:'pan'}),channel('mirror-tilt',1,{semantic:'tilt'}),channel('dimmer',2),
    shutter(3),channel('color-wheel',4),channel('gobo',5),channel('focus',6,{default:.5}),
    channel('prism',7),channel('prism-rotation',8),channel('movement-speed',9)
  ],{tags:['scanner','mirror','moving effect']});

  /* Pixel bars, tubes and panels */
  add('pixel-bar-rgb-4','RGB Pixel Bar: 4 Cell','Pixels & Battens','4 cell · 12 channel',cells(4,['red','green','blue'],0,4));
  add('pixel-bar-rgb-8','RGB Pixel Bar: 8 Cell','Pixels & Battens','8 cell · 24 channel',cells(8,['red','green','blue'],0,8));
  add('pixel-bar-rgb-16','RGB Pixel Bar: 16 Cell','Pixels & Battens','16 cell · 48 channel',cells(16,['red','green','blue'],0,16));
  add('pixel-bar-rgbw-8','RGBW Pixel Bar: 8 Cell','Pixels & Battens','8 cell · 32 channel',cells(8,['red','green','blue','white'],0,8));
  add('pixel-tube-rgbw-16','RGBW Pixel Tube: 16 Cell','Pixels & Battens','16 cell · 64 channel',cells(16,['red','green','blue','white'],0,16));
  add('pixel-bar-master-rgb-8','RGB Pixel Bar: Master + 8 Cell','Pixels & Battens','Master + 8 cell · 26 channel',[channel('dimmer',0),shutter(1),...cells(8,['red','green','blue'],2,8)]);
  add('matrix-rgb-4x4','RGB Matrix Panel: 4 × 4','Pixels & Battens','16 pixel · 48 channel',cells(16,['red','green','blue'],0,4),{tags:['matrix','panel','pixel map']});
  add('matrix-rgbw-4x4','RGBW Matrix Panel: 4 × 4','Pixels & Battens','16 pixel · 64 channel',cells(16,['red','green','blue','white'],0,4),{tags:['matrix','panel','pixel map']});
  add('matrix-rgb-8x8','RGB Matrix Panel: 8 × 8','Pixels & Battens','64 pixel · 192 channel',cells(64,['red','green','blue'],0,8),{tags:['matrix','panel','pixel map']});

  /* Strobes and blinders */
  add('strobe','White Strobe','Strobes & Blinders','2 channel',[channel('dimmer',0),shutter(1)]);
  add('strobe-rgb','RGB Strobe','Strobes & Blinders','6 channel',[channel('dimmer',0),shutter(1),channel('red',2),channel('green',3),channel('blue',4),channel('macro',5)]);
  add('blinder-2','Two-Lite Blinder','Strobes & Blinders','2 channel',repeated('dimmer',2,0,2));
  add('blinder-4','Four-Lite Blinder','Strobes & Blinders','4 channel',repeated('dimmer',4,0,2));
  add('blinder-8','Eight-Segment Blinder','Strobes & Blinders','8 channel',repeated('dimmer',8,0,4));
  add('pixel-strobe-16','Sixteen-Segment Pixel Strobe','Strobes & Blinders','Master + 16 segment · 18 channel',[channel('dimmer',0),shutter(1),...cells(16,['white'],2,16)]);

  /* White-light, studio and theatre */
  add('fresnel','LED Fresnel','White Light & Theatre','Dimmer · 1 channel',[channel('dimmer',0)]);
  add('fresnel-16bit','LED Fresnel 16-bit','White Light & Theatre','16-bit dimmer · 2 channel',[channel('dimmer',0,{bits:16,fineOffset:1})]);
  add('fresnel-variable-white','Variable White Fresnel','White Light & Theatre','Dim + CW + WW · 3 channel',[channel('dimmer',0),channel('cold-white',1),channel('warm-white',2)]);
  add('studio-panel-cct','Studio CCT Panel','White Light & Theatre','Dim + CCT + tint + strobe · 4 channel',[channel('dimmer',0),channel('cct',1),channel('green-magenta',2),shutter(3)]);
  add('profile-rgbal','RGBAL Profile / Ellipsoidal','White Light & Theatre','RGBAL + dim + strobe · 7 channel',[channel('dimmer',0),channel('red',1),channel('green',2),channel('blue',3),channel('amber',4),channel('lime',5),shutter(6)]);
  add('followspot','Followspot Template','White Light & Theatre','4 channel',[channel('dimmer',0),channel('cct',1),channel('iris',2),shutter(3)],{tags:['follow spot','theatre']});

  /* Architectural and installation */
  add('architectural-rgbw-4zone','Architectural RGBW: 4 Zone','Architectural','4 zone · 16 channel',cells(4,['red','green','blue','white'],0,4));
  add('architectural-rgb-8zone','Architectural RGB: 8 Zone','Architectural','8 zone · 24 channel',cells(8,['red','green','blue'],0,8));
  add('architectural-cct-8zone','Architectural CCT: 8 Zone','Architectural','8 zone · 16 channel',cells(8,['cold-white','warm-white'],0,8));

  /* Atmospherics and special effects: intentionally marked for manual verification. */
  add('fogger','Fog Machine Template','Atmospherics & Special FX','Output + fan · 2 channel',[channel('fog-output',0,{semantic:'fog-output'}),channel('fan',1)],{safety:'manual-verification-required',tags:['fog','smoke']});
  add('hazer','Hazer Template','Atmospherics & Special FX','Haze + fan + timer · 3 channel',[channel('haze-output',0,{semantic:'haze-output'}),channel('fan',1),channel('timer',2)],{safety:'manual-verification-required',tags:['haze','atmosphere']});
  add('dmx-fan','DMX Fan Template','Atmospherics & Special FX','Speed + mode · 2 channel',[channel('fan',0),channel('fan-mode',1)],{safety:'manual-verification-required',tags:['fan','wind']});
  add('co2-jet','CO₂ Jet Template','Atmospherics & Special FX','Output + enable · 2 channel',[channel('co2-output',0,{semantic:'co2-output'}),channel('safety-enable',1)],{safety:'hazardous-manual-verification-required',tags:['co2','jet','hazard']});
  add('cold-spark','Cold Spark Template','Atmospherics & Special FX','Intensity + height + enable · 3 channel',[channel('spark-output',0,{semantic:'spark-output'}),channel('spark-height',1),channel('safety-enable',2)],{safety:'hazardous-manual-verification-required',tags:['spark','hazard']});
  add('laser','Laser Template','Atmospherics & Special FX','10 channel',[channel('dimmer',0),shutter(1),channel('red',2),channel('green',3),channel('blue',4),channel('pattern',5),channel('position-x',6),channel('position-y',7),channel('scan-speed',8),channel('safety-enable',9)],{safety:'hazardous-manual-verification-required',tags:['laser','hazard']});

  /* Raw diagnostic profiles */
  add('raw-8','Raw DMX Diagnostic: 8 Channel','Control & Test','8 raw channels',raw(8),{safety:'diagnostic-only',tags:['test','diagnostic']});
  add('raw-16','Raw DMX Diagnostic: 16 Channel','Control & Test','16 raw channels',raw(16),{safety:'diagnostic-only',tags:['test','diagnostic']});
  add('raw-32','Raw DMX Diagnostic: 32 Channel','Control & Test','32 raw channels',raw(32),{safety:'diagnostic-only',tags:['test','diagnostic']});

  const profiles = definitions.map(profile => freeze(profile));
  const categories = [...new Set(profiles.map(profile => profile.source.category))];
  const api = Object.freeze({
    version:VERSION,
    profiles:Object.freeze(profiles),
    categories:Object.freeze(categories),
    getProfile(id) {
      const profile = profiles.find(item => item.id === String(id || ''));
      return profile ? clone(profile) : null;
    }
  });

  global.ShowaveGSL5Samples = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
