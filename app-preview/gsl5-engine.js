/* ShoWave GSL5
   -------------------------------------------------------------------------
   Dependency-free lighting show model, programmer, playback and DMX frame
   evaluator. The engine owns logical lighting data only; network transport is
   deliberately left to an Art-Net/sACN adapter.
   ------------------------------------------------------------------------- */
(function installShowaveGSL5(global) {
  'use strict';

  if (global.ShowaveGSL5) return;

  const SCHEMA = 'showave.gsl5.show/1';
  const SCHEMA_VERSION = 2;
  const COMPOSER_SCHEMA = 'showave.gsl5.composer/1';
  const SHOWAVE_CLIP_SCOPE = 'showave-lighting-clip';
  const DEFAULT_COMPOSER_LAYERS = 4;
  const DEFAULT_COMPOSER_COLUMNS = 8;
  const MAX_UNIVERSE = 63999;
  const MAX_FIXTURES = 16384;
  const MAX_PROFILES = 2048;
  const MAX_OBJECTS = 8192;
  const MAX_EFFECT_STACK = 256;
  let idCounter = 0;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const integer = (value, fallback, min, max) => clamp(Math.round(finite(value, fallback)), min, max);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const text = (value, fallback) => {
    const result = String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/g, ' ');
    return (result || fallback || '').slice(0, 256);
  };
  const attributeName = value => text(value, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const unique = values => [...new Set((values || []).map(value => text(value, '')).filter(Boolean))];
  const color = (value, fallback) => {
    const candidate = text(value, '');
    return /^#[0-9a-f]{3,8}$/i.test(candidate) ? candidate : fallback;
  };
  const deepFreeze = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.getOwnPropertyNames(value).forEach(key => deepFreeze(value[key]));
    return Object.freeze(value);
  };
  const uid = prefix => {
    const random = global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID() : `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
    return `${prefix || 'gsl5'}:${random}`;
  };
  const uniqueId = (wanted, prefix, used) => {
    const base = text(wanted, '') || uid(prefix);
    let result = base, suffix = 2;
    while (used.has(result)) result = `${base}:${suffix++}`;
    used.add(result);
    return result;
  };
  const level = value => {
    if (typeof value === 'string' && /%\s*$/.test(value)) return clamp(finite(value.replace('%', ''), 0) / 100, 0, 1);
    if (value && typeof value === 'object' && Number.isFinite(Number(value.dmx)))
      return clamp(Number(value.dmx) / (Number(value.dmx) > 255 ? 65535 : 255), 0, 1);
    return clamp(finite(value, 0), 0, 1);
  };
  const touch = show => {
    const next = Date.now();
    show.updatedAt = Math.max(next, finite(show.updatedAt, 0) + 1);
    return show;
  };

  /* An R20 RANGE table is written in 0..255 even for a 16-bit (s/S) channel.
     Left as declared, the Open band sat at 11/65535 - a coarse byte of 0,
     Closed - while the readout said Open. Scale a whole-byte table to the
     channel's real span. */
  function scaleFunctionTable(bits, functions) {
    if (bits !== 16 || !functions.length || functions.some(fn => fn.dmxEnd > 255)) return functions;
    return functions.map(fn => Object.assign({}, fn, {dmxStart:fn.dmxStart * 257, dmxEnd:Math.min(65535, fn.dmxEnd * 257 + 256)}));
  }

  function normaliseProfile(raw, fallbackId) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const id = text(source.id, fallbackId || 'generic-dimmer-8');
    let cursor = 0;
    const channels = (Array.isArray(source.channels) ? source.channels : []).slice(0, 512).map((entry, index) => {
      const channel = entry && typeof entry === 'object' ? entry : {attribute:entry};
      const attribute = attributeName(channel.attribute || channel.name || `channel-${index + 1}`);
      const semantic = attributeName(channel.semantic || attribute);
      const bits = Number(channel.bits || channel.size) === 16 ? 16 : 8;
      const offset = integer(channel.offset, cursor, 0, 511);
      const fineOffset = bits === 16 ? integer(channel.fineOffset, offset + 1, 0, 511) : null;
      cursor = Math.max(cursor, offset + 1, fineOffset == null ? 0 : fineOffset + 1);
      const suppliedMix = String(channel.mix || '').toLowerCase();
      const family = ['intensity','position','color','beam','control'].includes(channel.family)
        ? channel.family : ['dimmer','intensity','shutter'].includes(semantic) ? 'intensity'
          : ['pan','tilt','position-x','position-y','position-z'].includes(semantic) ? 'position'
            : ['red','green','blue','white','amber','uv','lime','cyan','magenta','yellow','cct','color-wheel','cold-white','warm-white'].includes(semantic)
              ? 'color' : 'beam';
      return {
        attribute,
        semantic,
        family,
        label:text(channel.label, attribute),
        offset,
        bits,
        fineOffset,
        default:level(channel.default),
        locate:channel.locate == null ? null : level(channel.locate),
        powerOn:channel.powerOn == null ? null : level(channel.powerOn),
        highlight:channel.highlight == null ? null : level(channel.highlight),
        lowlight:channel.lowlight == null ? null : level(channel.lowlight),
        mix:suppliedMix === 'htp' || suppliedMix === 'ltp' ? suppliedMix
          : semantic === 'dimmer' || semantic === 'intensity' ? 'htp' : 'ltp',
        virtual:!!channel.virtual,
        virtualControl:text(channel.virtualControl, ''),
        sourceAttributeId:text(channel.sourceAttributeId, ''),
        functions:scaleFunctionTable(bits, (Array.isArray(channel.functions) ? channel.functions : []).slice(0, 256).map((fn, fnIndex) => ({
          id:text(fn && fn.id, String(fnIndex + 1)), name:text(fn && fn.name, `Function ${fnIndex + 1}`),
          dmxStart:finite(fn && fn.dmxStart, 0), dmxEnd:finite(fn && fn.dmxEnd, bits === 16 ? 65535 : 255),
          displayStart:finite(fn && fn.displayStart, 0),
          /* A band that states no display span is a STATE, not a 0..100
             sweep. Defaulting the end to 100 turned every unlabelled band
             into a rate, so a bare "Closed" range read as a strobe. */
          displayEnd:(!fn || fn.displayEnd == null) ? finite(fn && fn.displayStart, 0) : finite(fn.displayEnd, 0),
          /* R20 states a swept range as a PERCENTAGE of its span, never in
             Hz; the built-in samples state Hz. Dropping `unit` here made a
             percentage sweep read back as a fabricated strobe rate. */
          unit:text(fn && fn.unit, '')
        }))),
        cell:channel.cell && typeof channel.cell === 'object' ? {
          id:text(channel.cell.id, ''), name:text(channel.cell.name, ''),
          x:finite(channel.cell.x, 0), y:finite(channel.cell.y, 0)
        } : null
      };
    });
    if (!channels.length) channels.push({
      attribute:'dimmer', label:'Dimmer', offset:0, bits:8, fineOffset:null, default:0, mix:'htp'
    });
    const usedFootprint = Math.max(1, ...channels.map(channel =>
      Math.max(channel.offset, channel.fineOffset == null ? channel.offset : channel.fineOffset) + 1));
    /* A D4 mode can deliberately leave trailing/reserved channels. Retaining
       the declared footprint prevents the next fixture from being patched on
       top of those slots even when no programmable attribute owns them. */
    const footprint = integer(source.footprint, usedFootprint, usedFootprint, 512);
    const provenance = source.source && typeof source.source === 'object' ? source.source : {};
    return {
      id,
      name:text(source.name, id),
      manufacturer:text(source.manufacturer, 'GSL5'),
      mode:text(source.mode, `${footprint} channel`),
      footprint,
      channels,
      virtualControls:(Array.isArray(source.virtualControls) ? source.virtualControls : []).slice(0, 512).map(control => ({
        sourceAttributeId:text(control && control.sourceAttributeId, ''),
        semantic:attributeName(control && control.semantic || control && control.sourceAttributeId || 'control'),
        family:text(control && control.family, 'control'), label:text(control && control.label, 'Virtual control'),
        virtual:true, virtualControl:text(control && control.virtualControl, '')
      })),
      source:Object.keys(provenance).length ? {
        provider:text(provenance.provider, ''), format:text(provenance.format, ''), origin:text(provenance.origin, ''),
        libraryProfileId:text(provenance.libraryProfileId, ''),
        filename:text(provenance.filename, ''), relativePath:text(provenance.relativePath, ''),
        fixtureVersion:text(provenance.fixtureVersion, ''), copyright:text(provenance.copyright, ''),
        sourceId:text(provenance.sourceId, ''), digest:text(provenance.digest, ''),
        importedAt:finite(provenance.importedAt, 0), officialLibrary:text(provenance.officialLibrary, ''),
        modeIndex:integer(provenance.modeIndex, 0, 0, 100000), modeId:text(provenance.modeId, ''),
        macroCount:integer(provenance.macroCount, 0, 0, 100000),
        paletteCount:integer(provenance.paletteCount, 0, 0, 100000),
        unknownElements:unique(Array.isArray(provenance.unknownElements) ? provenance.unknownElements : []).slice(0, 64),
        sample:!!provenance.sample, authored:!!provenance.authored,
        createdAt:finite(provenance.createdAt, 0), updatedAt:finite(provenance.updatedAt, 0),
        revision:integer(provenance.revision, 0, 0, 1000000000),
        category:text(provenance.category, ''), subcategory:text(provenance.subcategory, ''),
        tags:unique(Array.isArray(provenance.tags) ? provenance.tags : []).slice(0, 64),
        safety:text(provenance.safety, ''), description:text(provenance.description, ''),
        /* Real travel, in degrees, from an R20 MIRROR line. This whitelist
           silently discarded it, so the preview stamped "travel not in
           profile" over a personality that stated 540/270. */
        physical:provenance.physical && typeof provenance.physical === 'object' ? {
          movement:text(provenance.physical.movement, ''),
          panDegrees:provenance.physical.panDegrees == null ? null : finite(provenance.physical.panDegrees, 0),
          tiltDegrees:provenance.physical.tiltDegrees == null ? null : finite(provenance.physical.tiltDegrees, 0)
        } : null,
        declaredChannels:provenance.declaredChannels == null ? null : integer(provenance.declaredChannels, 0, 0, 512)
      } : null
    };
  }

  function profileCompatibilityShape(profile) {
    const source = profile && typeof profile === 'object' ? profile : {};
    return {
      footprint:integer(source.footprint, 1, 1, 512),
      channels:(source.channels || []).map(channel => ({
        attribute:channel.attribute,
        semantic:channel.semantic,
        family:channel.family,
        offset:channel.offset,
        bits:channel.bits,
        fineOffset:channel.fineOffset,
        default:channel.default,
        locate:channel.locate,
        powerOn:channel.powerOn,
        highlight:channel.highlight,
        lowlight:channel.lowlight,
        mix:channel.mix,
        virtual:channel.virtual,
        virtualControl:channel.virtualControl,
        sourceAttributeId:channel.sourceAttributeId,
        functions:(channel.functions || []).map(fn => ({
          dmxStart:fn.dmxStart, dmxEnd:fn.dmxEnd,
          displayStart:fn.displayStart, displayEnd:fn.displayEnd
        })),
        cell:channel.cell ? {id:channel.cell.id,x:channel.cell.x,y:channel.cell.y} : null
      })),
      virtualControls:(source.virtualControls || []).map(control => ({
        sourceAttributeId:control.sourceAttributeId,
        semantic:control.semantic,
        family:control.family,
        virtual:control.virtual,
        virtualControl:control.virtualControl
      }))
    };
  }

  function profilesCompatible(left, right) {
    return JSON.stringify(profileCompatibilityShape(left)) === JSON.stringify(profileCompatibilityShape(right));
  }

  const BUILTIN_PROFILE_LIST = [
    normaliseProfile({
      id:'generic-dimmer-8', name:'Generic Dimmer 8-bit', manufacturer:'Generic', mode:'1 channel',
      channels:[{attribute:'dimmer', label:'Dimmer', offset:0, bits:8, default:0}]
    }),
    normaliseProfile({
      id:'generic-rgb-8', name:'Generic RGB', manufacturer:'Generic', mode:'4 channel',
      channels:[
        {attribute:'dimmer', offset:0}, {attribute:'red', offset:1},
        {attribute:'green', offset:2}, {attribute:'blue', offset:3}
      ]
    }),
    normaliseProfile({
      id:'generic-rgbw-8', name:'Generic RGBW', manufacturer:'Generic', mode:'5 channel',
      channels:[
        {attribute:'dimmer', offset:0}, {attribute:'red', offset:1},
        {attribute:'green', offset:2}, {attribute:'blue', offset:3}, {attribute:'white', offset:4}
      ]
    }),
    normaliseProfile({
      id:'moving-head-rgbw-16', name:'Generic Moving Head RGBW 16-bit', manufacturer:'Generic', mode:'12 channel',
      channels:[
        {attribute:'dimmer', offset:0},
        {attribute:'pan', offset:1, bits:16, fineOffset:2, default:0.5},
        {attribute:'tilt', offset:3, bits:16, fineOffset:4, default:0.5},
        {attribute:'red', offset:5}, {attribute:'green', offset:6},
        {attribute:'blue', offset:7}, {attribute:'white', offset:8},
        {attribute:'shutter', offset:9},
        {attribute:'zoom', offset:10, bits:16, fineOffset:11, default:0.5}
      ]
    })
  ];
  const PROFILES = deepFreeze(Object.fromEntries(BUILTIN_PROFILE_LIST.map(profile => [profile.id, clone(profile)])));

  function normaliseProfiles(raw) {
    const byId = new Map(BUILTIN_PROFILE_LIST.map(profile => [profile.id, clone(profile)]));
    const supplied = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    supplied.slice(0, MAX_PROFILES).forEach((profile, index) => {
      const safe = normaliseProfile(profile, `custom-profile-${index + 1}`);
      byId.set(safe.id, safe);
    });
    return [...byId.values()];
  }

  function profileMap(show) {
    return new Map((show.profiles || []).map(profile => [profile.id, profile]));
  }

  function token(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return {
      value:level(Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value.level),
      paletteId:text(value.paletteId, '')
    };
    return {value:level(value), paletteId:''};
  }

  function normaliseValueMap(raw, validFixtureIds) {
    const out = {};
    const source = raw && typeof raw === 'object' ? raw : {};
    Object.keys(source).slice(0, MAX_FIXTURES).forEach(fixtureId => {
      if (validFixtureIds && !validFixtureIds.has(fixtureId)) return;
      const attributes = source[fixtureId];
      if (!attributes || typeof attributes !== 'object') return;
      const values = {};
      Object.keys(attributes).slice(0, 512).forEach(attribute => {
        const name = attributeName(attribute);
        if (name) values[name] = token(attributes[attribute]);
      });
      if (Object.keys(values).length) out[fixtureId] = values;
    });
    return out;
  }

  function plainValueMap(raw) {
    const out = {};
    Object.entries(raw || {}).forEach(([fixtureId, attributes]) => {
      out[fixtureId] = {};
      Object.entries(attributes || {}).forEach(([attribute, value]) => {
        out[fixtureId][attributeName(attribute)] = level(value && typeof value === 'object' ? value.value : value);
      });
    });
    return out;
  }

  function optionalQuantity(value) {
    if (value == null || value === '' || String(value).toLowerCase() === 'all') return null;
    return integer(value, 1, 1, MAX_FIXTURES);
  }

  function normaliseEffectParameters(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    const owns = key => Object.prototype.hasOwnProperty.call(source, key);
    if (owns('attribute')) {
      const attribute = attributeName(source.attribute);
      if (attribute) out.attribute = attribute;
    }
    if (owns('mode')) out.mode = source.mode === 'absolute' ? 'absolute' : 'relative';
    if (owns('waveform') && ['sine','triangle','square','saw','steps'].includes(source.waveform))
      out.waveform = source.waveform;
    if (owns('steps') && Array.isArray(source.steps)) out.steps = source.steps.slice(0, 128).map(step => ({
      value:level(step && typeof step === 'object' ? step.value : step),
      width:Math.max(0.001, finite(step && step.width, 1)),
      transition:clamp(finite(step && step.transition, 1), 0, 1)
    }));
    if (owns('base')) out.base = level(source.base);
    if (owns('size')) out.size = clamp(finite(source.size, 0), -1, 1);
    if (owns('offset')) out.offset = clamp(finite(source.offset, 0), -1, 1);
    const speedKey = owns('speedBpm') ? 'speedBpm' : owns('bpm') ? 'bpm' : owns('speed') ? 'speed' : '';
    if (speedKey) out.speedBpm = clamp(finite(source[speedKey], 60), 0.001, 9999);
    if (owns('direction')) out.direction = ['forward','reverse','bounce'].includes(source.direction) ? source.direction : 'forward';
    if (owns('rateSource')) out.rateSource = source.rateSource === 'bpm' ? 'bpm' : 'hz';
    if (owns('rateMultiplier')) out.rateMultiplier = clamp(finite(source.rateMultiplier, 1), 0.01, 8);
    if (owns('phase')) out.phase = finite(source.phase, 0);
    if (owns('spread')) out.spread = finite(source.spread, 360);
    return out;
  }

  function normaliseEffectStack(raw, validEffects, exactIds) {
    const validates = validEffects instanceof Set;
    const effects = validates ? validEffects : new Set();
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_EFFECT_STACK).map(entry => {
      const source = typeof entry === 'string' ? {effectId:entry}
        : entry && typeof entry === 'object' ? entry : {};
      const candidate = source.effectId || source.refId || source.id;
      const effectId = exactIds ? (typeof candidate === 'string' ? candidate : '') : text(candidate, '');
      if (!effectId || validates && !effects.has(effectId)) return null;
      return {
        id:(source.effectId || source.refId) && !exactIds ? text(source.id, '') : '',
        effectId,
        enabled:source.enabled !== false,
        bypassed:source.bypassed === true || source.bypass === true,
        parameters:normaliseEffectParameters(source.parameters || source.params || source.overrides)
      };
    }).filter(Boolean);
  }

  const COMPOSER_COLORS = Object.freeze([
    '#4ea1ff', '#38c997', '#ffb547', '#a980ff', '#ff6b78', '#43c7d8', '#d6d85a', '#ea7ed5'
  ]);

  function createComposerDocument(options) {
    const source = options && typeof options === 'object' ? options : {};
    const layerCount = integer(source.layerCount, DEFAULT_COMPOSER_LAYERS, 1, MAX_OBJECTS);
    const columnCount = integer(source.columnCount, DEFAULT_COMPOSER_COLUMNS, 1, MAX_OBJECTS);
    return {
      schema:COMPOSER_SCHEMA,
      layers:Array.from({length:layerCount}, (_, index) => ({
        id:`composer:layer:${index + 1}`,
        name:`Lighting ${index + 1}`,
        color:COMPOSER_COLORS[index % COMPOSER_COLORS.length],
        level:1,
        muted:false,
        solo:false,
        private:false,
        scope:'',
        target:{kind:'all', groupId:'', fixtureIds:[]},
        sequenceId:'',
        playbackId:''
      })),
      columns:Array.from({length:columnCount}, (_, index) => ({
        id:`composer:column:${index + 1}`,
        name:`Cue ${index + 1}`,
        color:COMPOSER_COLORS[index % COMPOSER_COLORS.length],
        private:false,
        scope:''
      })),
      clips:[],
      metadata:{}
    };
  }

  function legacyComposerSource(context) {
    const sequences = context.sequences || [];
    const playbacks = context.playbacks || [];
    const sequence = sequences[0] || null;
    const columnCount = Math.max(DEFAULT_COMPOSER_COLUMNS,
      Math.min(MAX_OBJECTS, sequence && sequence.cueIds.length || 0));
    const composer = createComposerDocument({columnCount});
    if (!sequence) return composer;
    composer.layers[0].name = sequence.name || composer.layers[0].name;
    composer.layers[0].sequenceId = sequence.id;
    const playback = playbacks.find(item => item.sequenceId === sequence.id);
    composer.layers[0].playbackId = playback && playback.id || '';
    sequence.cueIds.slice(0, columnCount).forEach((cueId, index) => {
      const cue = (context.cues || []).find(item => item.id === cueId);
      if (cue) composer.columns[index].name = cue.name || composer.columns[index].name;
      composer.clips.push({
        id:`composer:clip:${index + 1}`,
        layerId:composer.layers[0].id,
        columnId:composer.columns[index].id,
        name:cue && cue.name || `Cue ${index + 1}`,
        color:composer.columns[index].color,
        items:[{
          id:`composer:clip:${index + 1}:item:1`,
          kind:'cue',
          refId:cueId,
          sequenceId:sequence.id
        }]
      });
    });
    composer.metadata = {migratedFrom:'gsl5-cue-stack'};
    return composer;
  }

  function normaliseComposerTarget(raw, context, fallbackToAll) {
    if (raw == null || raw === '') return fallbackToAll
      ? {kind:'all', groupId:'', fixtureIds:[]} : null;
    const source = typeof raw === 'string' ? {kind:'group', groupId:raw}
      : raw && typeof raw === 'object' ? raw : {};
    const kindKey = String(source.kind || source.type || '').toLowerCase().replace(/[^a-z]/g, '');
    let kind = ({fixturegroup:'group', fixtures:'fixtures', fixture:'fixtures',
      fixtureprofile:'profile', profile:'profile', all:'all'})[kindKey] || kindKey;
    const groupId = text(source.groupId || (kind === 'group' ? source.id : ''), '');
    const profileId = text(source.profileId || (kind === 'profile' ? source.id : ''), '');
    const fixtureIds = unique(source.fixtureIds || source.fixtures ||
      (kindKey === 'fixture' && source.id ? [source.id] : []))
      .filter(id => context.validFixtures.has(id));
    const quantity = optionalQuantity(Object.prototype.hasOwnProperty.call(source, 'quantity')
      ? source.quantity : source.count);
    const counted = target => quantity == null ? target : Object.assign(target, {quantity});
    if (!kind) kind = profileId ? 'profile' : groupId ? 'group'
      : fixtureIds.length ? 'fixtures' : fallbackToAll ? 'all' : 'fixtures';
    if (kind === 'all') return counted({kind:'all', groupId:'', fixtureIds:[]});
    if (kind === 'group' && context.validGroups.has(groupId))
      return counted({kind:'group', groupId, fixtureIds:[]});
    if (kind === 'profile' && context.validProfiles && context.validProfiles.has(profileId))
      return counted({kind:'profile', profileId});
    /* Never broaden a broken target to every fixture. An empty explicit
       fixture target is inert until its missing source is repaired. */
    return counted({kind:'fixtures', groupId:'', fixtureIds});
  }

  function composerItemKind(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
    const aliases = {
      cue:'cue', lightingcue:'cue', look:'look', values:'look', palette:'palette', preset:'palette',
      effect:'effect', fx:'effect', sequence:'sequence', cuelist:'sequence', playback:'playback',
      executor:'playback', group:'group', fixturegroup:'group', fixture:'fixture',
      source:'source', fixturesource:'source', lightingsource:'source', light:'source'
    };
    return aliases[key] || '';
  }

  function normaliseComposerItem(raw, fallbackId, used, context) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const kind = composerItemKind(source.kind || source.type);
    if (!kind) return null;
    const aliases = {
      cue:'cueId', palette:'paletteId', effect:'effectId', sequence:'sequenceId',
      playback:'playbackId', group:'groupId', fixture:'fixtureId'
    };
    const refId = text(source.refId || source.referenceId || source[aliases[kind]], '');
    const validators = {
      cue:context.validCues, palette:context.validPalettes, effect:context.validEffects,
      sequence:context.validSequences, playback:context.validPlaybacks,
      group:context.validGroups, fixture:context.validFixtures
    };
    if (validators[kind] && !validators[kind].has(refId)) return null;
    const sequenceId = kind === 'cue' && context.validSequences.has(source.sequenceId)
      ? source.sequenceId : '';
    const item = {
      id:uniqueId(source.id, fallbackId, used),
      kind,
      refId:kind === 'look' || kind === 'source' ? '' : refId,
      sequenceId,
      values:kind === 'look' ? normaliseValueMap(source.values, context.validFixtures) : {},
      enabled:source.enabled !== false,
      level:level(source.level == null ? 1 : source.level),
      name:text(source.name || source.label, '')
    };
    if (kind === 'source') item.preset = ['full','blackout','white','home'].includes(source.preset)
      ? source.preset : 'full';
    if (kind === 'effect') {
      item.bypassed = source.bypassed === true || source.bypass === true;
      item.parameters = normaliseEffectParameters(source.parameters || source.params || source.overrides);
    }
    return item;
  }

  function normaliseComposer(raw, context) {
    const source = raw && typeof raw === 'object' ? raw : legacyComposerSource(context);
    const layerIds = new Set();
    const layers = (Array.isArray(source.layers) ? source.layers : []).slice(0, MAX_OBJECTS).map((layer, index) => {
      const item = layer && typeof layer === 'object' ? layer : {};
      const sequenceId = context.validSequences.has(item.sequenceId) ? item.sequenceId : '';
      const playbackId = context.validPlaybacks.has(item.playbackId) ? item.playbackId : '';
      return {
        id:uniqueId(item.id, `composer:layer:${index + 1}`, layerIds),
        name:text(item.name, `Lighting ${index + 1}`),
        color:color(item.color, COMPOSER_COLORS[index % COMPOSER_COLORS.length]),
        level:level(item.level == null ? 1 : item.level),
        muted:!!item.muted,
        solo:!!item.solo,
        private:item.private === true,
        scope:text(item.scope, ''),
        target:normaliseComposerTarget(item.target, context, true),
        sequenceId,
        playbackId
      };
    });
    const columnIds = new Set();
    const columns = (Array.isArray(source.columns) ? source.columns : []).slice(0, MAX_OBJECTS).map((column, index) => {
      const item = column && typeof column === 'object' ? column : {};
      return {
        id:uniqueId(item.id, `composer:column:${index + 1}`, columnIds),
        name:text(item.name, `Cue ${index + 1}`),
        color:color(item.color, COMPOSER_COLORS[index % COMPOSER_COLORS.length]),
        private:item.private === true,
        scope:text(item.scope, '')
      };
    });
    const clipIds = new Set(), itemIds = new Set(), occupied = new Set(), clips = [];
    (Array.isArray(source.clips) ? source.clips : []).slice(0, MAX_OBJECTS).forEach((clip, index) => {
      const item = clip && typeof clip === 'object' ? clip : {};
      const layerId = text(item.layerId, ''), columnId = text(item.columnId, '');
      const slotKey = `${layerId}\u0000${columnId}`;
      if (!layerIds.has(layerId) || !columnIds.has(columnId) || occupied.has(slotKey)) return;
      const suppliedItems = Array.isArray(item.items) ? item.items.slice(0, 256) : [];
      if (Array.isArray(item.effectStack) && !suppliedItems.some(entry => composerItemKind(entry && (entry.kind || entry.type)) === 'effect')) {
        normaliseEffectStack(item.effectStack, context.validEffects, false).forEach(entry => suppliedItems.push({
          id:entry.id, kind:'effect', effectId:entry.effectId, enabled:entry.enabled,
          bypassed:entry.bypassed, parameters:entry.parameters
        }));
      }
      if (!suppliedItems.length) {
        if (item.cueId) suppliedItems.push({kind:'cue', cueId:item.cueId, sequenceId:item.sequenceId});
        if (item.paletteId) suppliedItems.push({kind:'palette', paletteId:item.paletteId});
        if (item.sequenceId && !item.cueId) suppliedItems.push({kind:'sequence', sequenceId:item.sequenceId});
        if (item.playbackId) suppliedItems.push({kind:'playback', playbackId:item.playbackId});
        (Array.isArray(item.effectIds) ? item.effectIds : item.effectId ? [item.effectId] : [])
          .forEach(effectId => suppliedItems.push({kind:'effect', effectId}));
        if (item.values) suppliedItems.push({kind:'look', values:item.values});
      }
      const id = uniqueId(item.id, `composer:clip:${index + 1}`, clipIds);
      const target = normaliseComposerTarget(item.target, context, false);
      const items = suppliedItems.map((entry, itemIndex) =>
        normaliseComposerItem(entry, `${id}:item:${itemIndex + 1}`, itemIds, context)).filter(Boolean);
      const layer = layers.find(candidate => candidate.id === layerId);
      const legacyPrivate = !!(layer && /^SW · /.test(layer.name) && target && target.kind === 'profile' &&
        items.some(entry => entry.kind === 'source' && entry.name === 'Fixture Source'));
      if (legacyPrivate) {
        layer.private = true;
        layer.scope = SHOWAVE_CLIP_SCOPE;
      }
      clips.push({
        id,
        layerId,
        columnId,
        name:text(item.name, `Lighting Clip ${index + 1}`),
        color:color(item.color, columns.find(column => column.id === columnId)?.color || COMPOSER_COLORS[index % COMPOSER_COLORS.length]),
        enabled:item.enabled !== false,
        level:level(item.level == null ? 1 : item.level),
        fadeMs:integer(item.fadeMs, 0, 0, 86400000),
        private:item.private === true || legacyPrivate,
        scope:text(item.scope, legacyPrivate ? SHOWAVE_CLIP_SCOPE : ''),
        target,
        items,
        effectStack:items.filter(entry => entry.kind === 'effect').map(entry => ({
          id:entry.id,
          effectId:entry.refId,
          enabled:entry.enabled,
          bypassed:entry.bypassed,
          parameters:clone(entry.parameters)
        }))
      });
      occupied.add(slotKey);
    });
    return {
      schema:COMPOSER_SCHEMA,
      layers,
      columns,
      clips,
      metadata:source.metadata && typeof source.metadata === 'object' ? clone(source.metadata) : {}
    };
  }

  function normaliseShow(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const profiles = normaliseProfiles(source.profiles);
    const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
    const fixtureIds = new Set();
    const fixtures = (Array.isArray(source.fixtures) ? source.fixtures : []).slice(0, MAX_FIXTURES).map((fixture, index) => {
      const item = fixture && typeof fixture === 'object' ? fixture : {};
      const profileId = text(item.profileId || item.profile, 'generic-dimmer-8');
      return {
        id:uniqueId(item.id, 'fixture', fixtureIds),
        name:text(item.name, `Fixture ${index + 1}`),
        profileId,
        universe:integer(item.universe, 1, 1, MAX_UNIVERSE),
        address:integer(item.address, 1, 1, 512),
        enabled:item.enabled !== false,
        tags:unique(item.tags),
        position:{
          x:finite(item.position && item.position.x, finite(item.x, index)),
          y:finite(item.position && item.position.y, finite(item.y, 0)),
          z:finite(item.position && item.position.z, finite(item.z, 0))
        },
        note:text(item.note, '')
      };
    });
    const validFixtures = new Set(fixtures.map(fixture => fixture.id));

    const groupIds = new Set();
    const groups = (Array.isArray(source.groups) ? source.groups : []).slice(0, MAX_OBJECTS).map((group, index) => {
      const item = group && typeof group === 'object' ? group : {};
      const members = unique(item.fixtureIds || item.members).filter(id => validFixtures.has(id));
      const positions = new Map((Array.isArray(item.grid) ? item.grid : []).map(cell => [text(cell && cell.fixtureId, ''), cell]));
      return {
        id:uniqueId(item.id, 'group', groupIds),
        name:text(item.name, `Group ${index + 1}`),
        fixtureIds:members,
        grid:members.map((fixtureId, memberIndex) => {
          const cell = positions.get(fixtureId) || {};
          return {fixtureId, x:finite(cell.x, memberIndex), y:finite(cell.y, 0), z:finite(cell.z, 0)};
        })
      };
    });

    const paletteIds = new Set();
    const palettes = (Array.isArray(source.palettes) ? source.palettes : []).slice(0, MAX_OBJECTS).map((palette, index) => {
      const item = palette && typeof palette === 'object' ? palette : {};
      const profileValues = {};
      Object.entries(item.profileValues || {}).forEach(([profileId, attributes]) => {
        if (!profilesById.has(profileId) || !attributes || typeof attributes !== 'object') return;
        profileValues[profileId] = {};
        Object.entries(attributes).forEach(([attribute, value]) => {
          profileValues[profileId][attributeName(attribute)] = level(value && typeof value === 'object' ? value.value : value);
        });
      });
      const universalValues = {};
      Object.entries(item.universalValues || {}).forEach(([attribute, value]) => {
        universalValues[attributeName(attribute)] = level(value && typeof value === 'object' ? value.value : value);
      });
      const values = normaliseValueMap(item.values, validFixtures);
      return {
        id:uniqueId(item.id, 'palette', paletteIds),
        name:text(item.name, `Palette ${index + 1}`),
        mode:['selective', 'global', 'universal'].includes(item.mode) ? item.mode : 'selective',
        values:plainValueMap(values),
        profileValues,
        universalValues,
        attributes:unique(item.attributes || Object.values(values).flatMap(value => Object.keys(value))).map(attributeName)
      };
    });
    const validPalettes = new Set(palettes.map(palette => palette.id));

    const cueIds = new Set();
    const cues = (Array.isArray(source.cues) ? source.cues : []).slice(0, MAX_OBJECTS).map((cue, index) => {
      const item = cue && typeof cue === 'object' ? cue : {};
      return {
        id:uniqueId(item.id, 'cue', cueIds),
        name:text(item.name, `Cue ${index + 1}`),
        values:normaliseValueMap(item.values, validFixtures),
        fadeMs:integer(item.fadeMs, 0, 0, 86400000),
        delayMs:integer(item.delayMs, 0, 0, 86400000),
        effectIds:unique(item.effectIds),
        block:!!item.block,
        triggers:Array.isArray(item.triggers) ? clone(item.triggers).slice(0, 256) : []
      };
    });
    const validCues = new Set(cues.map(cue => cue.id));

    const sequenceIds = new Set();
    const sequences = (Array.isArray(source.sequences) ? source.sequences : []).slice(0, MAX_OBJECTS).map((sequence, index) => {
      const item = sequence && typeof sequence === 'object' ? sequence : {};
      return {
        id:uniqueId(item.id, 'sequence', sequenceIds),
        name:text(item.name, `Sequence ${index + 1}`),
        cueIds:unique(item.cueIds).filter(id => validCues.has(id)),
        tracking:item.tracking !== false,
        loop:!!item.loop,
        bpm:clamp(finite(item.bpm, 120), 1, 999),
        stepsPerBeat:clamp(finite(item.stepsPerBeat, 1), 0.03125, 64),
        direction:['forward', 'reverse', 'bounce'].includes(String(item.direction || '').toLowerCase())
          ? String(item.direction).toLowerCase() : 'forward'
      };
    });
    const validSequences = new Set(sequences.map(sequence => sequence.id));

    const playbackIds = new Set();
    const playbacks = (Array.isArray(source.playbacks) ? source.playbacks : []).slice(0, MAX_OBJECTS).map((playback, index) => {
      const item = playback && typeof playback === 'object' ? playback : {};
      return {
        id:uniqueId(item.id, 'playback', playbackIds),
        name:text(item.name, `Playback ${index + 1}`),
        sequenceId:validSequences.has(item.sequenceId) ? item.sequenceId : sequences[0] && sequences[0].id || '',
        level:level(item.level == null ? 1 : item.level),
        priority:integer(item.priority, 0, -100, 100),
        flash:!!item.flash
      };
    });
    const validPlaybacks = new Set(playbacks.map(playback => playback.id));

    const effectIds = new Set();
    const effects = (Array.isArray(source.effects) ? source.effects : []).slice(0, MAX_OBJECTS).map((effect, index) => {
      const item = effect && typeof effect === 'object' ? effect : {};
      const waveform = ['sine', 'triangle', 'square', 'saw', 'steps'].includes(item.waveform) ? item.waveform : 'sine';
      return {
        id:uniqueId(item.id, 'effect', effectIds),
        name:text(item.name, `Effect ${index + 1}`),
        fixtureIds:unique(item.fixtureIds).filter(id => validFixtures.has(id)),
        groupId:groupIds.has(item.groupId) ? item.groupId : '',
        attribute:attributeName(item.attribute || 'dimmer'),
        mode:item.mode === 'absolute' ? 'absolute' : 'relative',
        waveform,
        steps:(Array.isArray(item.steps) ? item.steps : []).slice(0, 128).map(step => ({
          value:level(step && typeof step === 'object' ? step.value : step),
          width:Math.max(0.001, finite(step && step.width, 1)),
          transition:clamp(finite(step && step.transition, 1), 0, 1)
        })),
        base:level(item.base == null ? 0.5 : item.base),
        size:clamp(finite(item.size, 0.5), -1, 1),
        offset:clamp(finite(item.offset, 0), -1, 1),
        speedBpm:clamp(finite(item.speedBpm || item.bpm || item.speed, 60), 0.001, 9999),
        direction:['forward','reverse','bounce'].includes(item.direction) ? item.direction : 'forward',
        rateSource:item.rateSource === 'bpm' ? 'bpm' : 'hz',
        rateMultiplier:clamp(finite(item.rateMultiplier, 1), 0.01, 8),
        phase:finite(item.phase, 0),
        /* Schema 1 distributed spread as index/(n-1) across the fixture list;
           schema 2 distributes index/slotCount, the console convention where
           0 and 360 coincide. A show saved under schema 1 has its spread
           rescaled by n/(n-1) so the phases the operator programmed survive.
           Per-clip spread overrides are not rescaled. */
        spread:migrateSpread(item, source.schemaVersion, groupIds.has(item.groupId)
          ? ((groups.find(group => group.id === item.groupId) || {}).fixtureIds || []).length
          : unique(item.fixtureIds).filter(id => validFixtures.has(id)).length),
        startedAt:finite(item.startedAt, 0),
        enabled:item.enabled !== false,
        autostart:item.autostart !== false
      };
    });
    const validEffects = new Set(effects.map(effect => effect.id));
    cues.forEach(cue => { cue.effectIds = cue.effectIds.filter(id => validEffects.has(id)); });

    const composerContext = {
      fixtures, groups, palettes, cues, sequences, playbacks, effects,
      validFixtures, validGroups:groupIds, validProfiles:new Set(profiles.map(profile => profile.id)), validPalettes, validCues,
      validSequences, validPlaybacks, validEffects
    };
    const composer = normaliseComposer(source.composer, composerContext);

    const programmerSource = source.programmer && typeof source.programmer === 'object' ? source.programmer : {};
    const programmer = {
      selectedFixtureIds:unique(programmerSource.selectedFixtureIds).filter(id => validFixtures.has(id)),
      values:normaliseValueMap(programmerSource.values, validFixtures),
      blind:!!programmerSource.blind,
      highlight:!!programmerSource.highlight
    };
    const runtime = normaliseRuntime(source.runtime, playbacks, composer, {profiles, fixtures, groups, effects});

    return {
      schema:SCHEMA,
      schemaVersion:SCHEMA_VERSION,
      id:text(source.id, '') || uid('show'),
      name:text(source.name, 'Untitled GSL5 Show'),
      profiles,
      fixtures,
      groups,
      palettes,
      cues,
      sequences,
      playbacks,
      effects,
      composer,
      programmer,
      runtime,
      master:level(source.master == null ? 1 : source.master),
      metadata:source.metadata && typeof source.metadata === 'object' ? clone(source.metadata) : {},
      updatedAt:finite(source.updatedAt, Date.now())
    };
  }

  function createRuntime() {
    return {order:0, playbacks:{}, effects:{}, sources:{}, composer:{activeByLayer:{}, activeColumnId:''}};
  }

  function fixtureSourceKey(assetType, assetId, instanceId) {
    const base = `${assetType}:${assetId}`;
    return instanceId ? `${base}#${encodeURIComponent(instanceId)}` : base;
  }

  function resolveFixtureSource(show, rawAssetType, rawAssetId) {
    const assetType = typeof rawAssetType === 'string' ? rawAssetType : '';
    const assetId = typeof rawAssetId === 'string' ? rawAssetId : '';
    if (assetType !== 'fixture-group' && assetType !== 'fixture-profile')
      throw new RangeError(`Unknown GSL5 fixture source type: ${assetType || '(empty)'}`);
    if (!assetId) throw new TypeError('A GSL5 fixture source requires an exact asset ID.');
    const fixtures = Array.isArray(show && show.fixtures) ? show.fixtures : [];
    let asset = null, fixtureIds = [];
    if (assetType === 'fixture-group') {
      asset = (show.groups || []).find(group => group.id === assetId);
      if (!asset) throw new RangeError(`Unknown GSL5 fixture group: ${assetId}`);
      const members = new Set(asset.fixtureIds || []);
      fixtureIds = fixtures.filter(fixture => fixture.enabled !== false && members.has(fixture.id)).map(fixture => fixture.id);
    } else {
      asset = (show.profiles || []).find(profile => profile.id === assetId);
      if (!asset) throw new RangeError(`Unknown GSL5 fixture profile: ${assetId}`);
      fixtureIds = fixtures.filter(fixture => fixture.enabled !== false && fixture.profileId === asset.id).map(fixture => fixture.id);
    }
    return {assetType, assetId, asset, fixtureIds, key:fixtureSourceKey(assetType, assetId)};
  }

  function exactSourceId(value) {
    return typeof value === 'string' && value.length ? value.slice(0, 256) : '';
  }

  function sourceFixtureFilter(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const target = source.target && typeof source.target === 'object' ? source.target : {};
    const owns = key => Object.prototype.hasOwnProperty.call(source, key);
    const targetOwns = key => Object.prototype.hasOwnProperty.call(target, key);
    if (!owns('fixtureIds') && !owns('targetFixtureIds') && !targetOwns('fixtureIds')) return null;
    const values = owns('fixtureIds') ? source.fixtureIds
      : owns('targetFixtureIds') ? source.targetFixtureIds : target.fixtureIds;
    return [...new Set((Array.isArray(values) ? values : []).filter(value =>
      typeof value === 'string' && value.length).map(value => value.slice(0, 256)))].slice(0, MAX_FIXTURES);
  }

  function resolveFixtureSourceInstance(show, rawAssetType, rawAssetId, rawOptions) {
    const resolved = resolveFixtureSource(show, rawAssetType, rawAssetId);
    const options = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? rawOptions : {};
    const requestedFixtureIds = sourceFixtureFilter(options);
    let fixtureIds = resolved.fixtureIds.slice();
    if (requestedFixtureIds !== null) {
      const requested = new Set(requestedFixtureIds);
      fixtureIds = fixtureIds.filter(fixtureId => requested.has(fixtureId));
    }
    const quantity = optionalQuantity(Object.prototype.hasOwnProperty.call(options, 'quantity')
      ? options.quantity : options.count);
    if (quantity != null) fixtureIds = fixtureIds.slice(0, quantity);
    const instanceId = exactSourceId(options.instanceId || options.sourceId || options.instanceKey);
    const explicitKey = exactSourceId(options.sourceKey || options.key);
    const sourceKey = explicitKey || fixtureSourceKey(resolved.assetType, resolved.assetId, instanceId);
    const preset = ['full','blackout','white','home'].includes(options.preset) ? options.preset : 'full';
    const validEffects = new Set((show && show.effects || []).map(effect => effect.id));
    const stackInput = Array.isArray(options.effectStack) ? options.effectStack : options.effects;
    return Object.assign({}, resolved, {
      baseKey:resolved.key,
      key:sourceKey,
      sourceKey,
      instanceId,
      preset,
      quantity,
      requestedFixtureIds,
      availableFixtureIds:resolved.fixtureIds.slice(),
      fixtureIds,
      availableCount:resolved.fixtureIds.length,
      count:fixtureIds.length,
      effectStack:normaliseEffectStack(stackInput, validEffects, true)
    });
  }

  function normaliseRuntime(raw, playbacks, composer, sourceContext) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = {order:integer(source.order, 0, 0, Number.MAX_SAFE_INTEGER), playbacks:{}, effects:{}, sources:{},
      composer:{activeByLayer:{}, activeColumnId:''}};
    const valid = new Set((playbacks || []).map(playback => playback.id));
    Object.entries(source.playbacks || {}).forEach(([playbackId, state]) => {
      if (!valid.has(playbackId)) return;
      const item = state && typeof state === 'object' ? state : {};
      out.playbacks[playbackId] = {
        active:!!item.active,
        cursor:integer(item.cursor, -1, -1, MAX_OBJECTS),
        level:level(item.level == null ? 1 : item.level),
        startedAt:finite(item.startedAt, 0),
        serial:integer(item.serial, 0, 0, Number.MAX_SAFE_INTEGER),
        fromValues:plainValueMap(item.fromValues)
      };
    });
    Object.entries(source.effects || {}).forEach(([effectId, state]) => {
      out.effects[effectId] = state && typeof state === 'object'
        ? {active:state.active !== false, startedAt:finite(state.startedAt, 0)} : {active:!!state, startedAt:0};
    });
    Object.entries(source.sources || {}).slice(0, MAX_OBJECTS).forEach(([key, state]) => {
      const item = state && typeof state === 'object' ? state : {};
      if (item.active === false) return;
      try {
        const declaredKey = exactSourceId(item.sourceKey);
        if (declaredKey && declaredKey !== key) return;
        const options = {
          sourceKey:declaredKey,
          instanceId:exactSourceId(item.instanceId),
          preset:item.preset,
          quantity:Object.prototype.hasOwnProperty.call(item, 'quantity') ? item.quantity : null,
          effectStack:item.effectStack
        };
        if (Object.prototype.hasOwnProperty.call(item, 'fixtureIds')) options.fixtureIds = item.fixtureIds;
        const resolved = resolveFixtureSourceInstance(sourceContext || {}, item.assetType, item.assetId, options);
        if ((!declaredKey && !options.instanceId && resolved.baseKey !== key) || resolved.key !== key || !resolved.fixtureIds.length) return;
        const safeState = {
          assetType:resolved.assetType,
          assetId:resolved.assetId,
          sourceKey:resolved.sourceKey,
          instanceId:resolved.instanceId,
          preset:resolved.preset,
          quantity:resolved.quantity,
          effectStack:resolved.effectStack,
          active:true,
          startedAt:finite(item.startedAt, 0),
          serial:integer(item.serial, 0, 0, Number.MAX_SAFE_INTEGER)
        };
        if (resolved.requestedFixtureIds !== null) safeState.fixtureIds = resolved.requestedFixtureIds;
        Object.defineProperty(out.sources, key, {
          value:safeState, enumerable:true, configurable:true, writable:true
        });
      } catch (_) { /* A stale/malformed runtime source never broadens its target. */ }
    });
    const composerSource = source.composer && typeof source.composer === 'object' ? source.composer : {};
    const validLayers = new Set((composer && composer.layers || []).map(layer => layer.id));
    const validColumns = new Set((composer && composer.columns || []).map(column => column.id));
    const clips = new Map((composer && composer.clips || []).map(clip => [clip.id, clip]));
    Object.entries(composerSource.activeByLayer || {}).forEach(([layerId, state]) => {
      if (!validLayers.has(layerId)) return;
      const item = typeof state === 'string' ? {clipId:state} : state && typeof state === 'object' ? state : {};
      const clip = clips.get(text(item.clipId, ''));
      if (!clip || clip.layerId !== layerId) return;
      out.composer.activeByLayer[layerId] = {
        clipId:clip.id,
        active:item.active !== false,
        level:level(item.level == null ? 1 : item.level),
        startedAt:finite(item.startedAt, 0),
        serial:integer(item.serial, 0, 0, Number.MAX_SAFE_INTEGER),
        fromValues:plainValueMap(item.fromValues)
      };
    });
    out.composer.activeColumnId = validColumns.has(composerSource.activeColumnId)
      ? composerSource.activeColumnId : '';
    return out;
  }

  function createShow(options) {
    return normaliseShow(Object.assign({
      schema:SCHEMA, id:uid('show'), name:'Untitled GSL5 Show', profiles:[], fixtures:[], groups:[],
      palettes:[], cues:[], sequences:[], playbacks:[], effects:[], composer:createComposerDocument(),
      programmer:{}, runtime:createRuntime()
    }, options && typeof options === 'object' ? clone(options) : {}));
  }

  function ensureShow(show) {
    if (!show || typeof show !== 'object' || show.schema !== SCHEMA || !Array.isArray(show.fixtures))
      throw new TypeError('Expected a GSL5 show from createShow() or normaliseShow().');
    return show;
  }

  function composerContext(show) {
    return {
      fixtures:show.fixtures, groups:show.groups, palettes:show.palettes, cues:show.cues,
      sequences:show.sequences, playbacks:show.playbacks, effects:show.effects,
      validFixtures:new Set(show.fixtures.map(item => item.id)),
      validGroups:new Set(show.groups.map(item => item.id)),
      validProfiles:new Set(show.profiles.map(item => item.id)),
      validPalettes:new Set(show.palettes.map(item => item.id)),
      validCues:new Set(show.cues.map(item => item.id)),
      validSequences:new Set(show.sequences.map(item => item.id)),
      validPlaybacks:new Set(show.playbacks.map(item => item.id)),
      validEffects:new Set(show.effects.map(item => item.id))
    };
  }

  function normaliseComposerForShow(show, raw) {
    show.composer = normaliseComposer(raw == null ? show.composer : raw, composerContext(show));
    show.runtime = normaliseRuntime(show.runtime, show.playbacks, show.composer, {
      profiles:show.profiles, fixtures:show.fixtures, groups:show.groups, effects:show.effects
    });
    return show.composer;
  }

  function upsertProfile(show, rawProfile) {
    ensureShow(show);
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile))
      throw new TypeError('A GSL5 profile must be an object.');
    const wantedId = text(rawProfile.id, '');
    if (!wantedId) throw new TypeError('A GSL5 profile requires an ID.');
    const profile = normaliseProfile(clone(rawProfile), wantedId);
    const index = show.profiles.findIndex(item => item.id === profile.id);
    if (index < 0 && show.profiles.length >= MAX_PROFILES)
      throw new RangeError(`A GSL5 show supports at most ${MAX_PROFILES} profiles.`);
    if (index < 0) show.profiles.push(profile);
    else show.profiles[index] = profile;
    normaliseComposerForShow(show);
    touch(show);
    return show.profiles.find(item => item.id === profile.id) || null;
  }

  /* Resolve an externally supplied personality without ever rewriting a
     personality already referenced by patched fixtures. Compatible profiles
     retain the existing identity; a channel-layout conflict receives its own
     deterministic sibling ID. `upsertProfile` remains the explicit editor API. */
  function ensureProfile(show, rawProfile) {
    ensureShow(show);
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile))
      throw new TypeError('A GSL5 profile must be an object.');
    const wantedId = text(rawProfile.id, '');
    if (!wantedId) throw new TypeError('A GSL5 profile requires an ID.');
    const candidate = normaliseProfile(clone(rawProfile), wantedId);
    const existing = show.profiles.find(item => item.id === candidate.id);
    const siblingBase = `${candidate.id}:showave`;
    const compatible = show.profiles.find(item =>
      (item.id === candidate.id || item.id === siblingBase || item.id.startsWith(`${siblingBase}:`)) &&
      profilesCompatible(item, candidate));
    if (compatible) return compatible;
    if (show.profiles.length >= MAX_PROFILES)
      throw new RangeError(`A GSL5 show supports at most ${MAX_PROFILES} profiles.`);
    if (existing) {
      candidate.id = uniqueId(siblingBase, 'profile', new Set(show.profiles.map(item => item.id)));
    }
    show.profiles.push(candidate);
    normaliseComposerForShow(show);
    touch(show);
    return show.profiles.find(item => item.id === candidate.id) || null;
  }

  function createComposerLayer(show, rawSpec) {
    ensureShow(show);
    const spec = rawSpec && typeof rawSpec === 'object' ? clone(rawSpec) : {name:rawSpec};
    const used = new Set(show.composer.layers.map(layer => layer.id));
    const id = uniqueId(spec.id, 'composer:layer', used);
    show.composer.layers.push(Object.assign({
      id,
      name:`Lighting ${show.composer.layers.length + 1}`,
      color:COMPOSER_COLORS[show.composer.layers.length % COMPOSER_COLORS.length],
      level:1,
      target:{kind:'all'}
    }, spec, {id}));
    normaliseComposerForShow(show);
    touch(show);
    return show.composer.layers.find(layer => layer.id === id) || null;
  }

  function createComposerColumn(show, rawSpec) {
    ensureShow(show);
    const spec = rawSpec && typeof rawSpec === 'object' ? clone(rawSpec) : {name:rawSpec};
    const used = new Set(show.composer.columns.map(column => column.id));
    const id = uniqueId(spec.id, 'composer:column', used);
    show.composer.columns.push(Object.assign({
      id,
      name:`Cue ${show.composer.columns.length + 1}`,
      color:COMPOSER_COLORS[show.composer.columns.length % COMPOSER_COLORS.length]
    }, spec, {id}));
    normaliseComposerForShow(show);
    touch(show);
    return show.composer.columns.find(column => column.id === id) || null;
  }

  function removeComposerColumn(show, columnOrId) {
    ensureShow(show);
    const id = text(columnOrId && typeof columnOrId === 'object' ? columnOrId.id : columnOrId, '');
    const column = show.composer.columns.find(item => item.id === id);
    if (!column) return null;
    if (show.composer.columns.length <= 1)
      throw new RangeError('A GSL5 Lighting Composer needs at least one cue column.');
    show.composer.columns = show.composer.columns.filter(item => item.id !== id);
    show.composer.clips = show.composer.clips.filter(clip => clip.columnId !== id);
    if (show.runtime.composer && show.runtime.composer.activeColumnId === id)
      show.runtime.composer.activeColumnId = '';
    normaliseComposerForShow(show);
    touch(show);
    return column;
  }

  function removeComposerLayer(show, layerOrId) {
    ensureShow(show);
    const id = text(layerOrId && typeof layerOrId === 'object' ? layerOrId.id : layerOrId, '');
    const layer = show.composer.layers.find(item => item.id === id);
    if (!layer) return null;
    if (show.composer.layers.length <= 1)
      throw new RangeError('A GSL5 Lighting Composer needs at least one layer.');
    show.composer.layers = show.composer.layers.filter(item => item.id !== id);
    show.composer.clips = show.composer.clips.filter(clip => clip.layerId !== id);
    if (show.runtime.composer && show.runtime.composer.activeByLayer)
      delete show.runtime.composer.activeByLayer[id];
    normaliseComposerForShow(show);
    touch(show);
    return layer;
  }

  function moveComposerColumn(show, sourceOrId, targetOrId) {
    ensureShow(show);
    const sourceId = text(sourceOrId && typeof sourceOrId === 'object' ? sourceOrId.id : sourceOrId, '');
    const targetId = text(targetOrId && typeof targetOrId === 'object' ? targetOrId.id : targetOrId, '');
    const from = show.composer.columns.findIndex(column => column.id === sourceId);
    const to = show.composer.columns.findIndex(column => column.id === targetId);
    if (from < 0) throw new RangeError(`Unknown GSL5 composer column: ${sourceId}`);
    if (to < 0) throw new RangeError(`Unknown GSL5 composer column: ${targetId}`);
    if (from === to) return {column:show.composer.columns[from], from, to, noOp:true};
    const [column] = show.composer.columns.splice(from, 1);
    /* `to` is intentionally the target's original index. This matches the
       launcher gesture: dragging right lands after the target, dragging left
       lands before it, without changing any Clip's stable columnId. */
    show.composer.columns.splice(to, 0, column);
    normaliseComposerForShow(show);
    touch(show);
    return {column:show.composer.columns.find(item => item.id === sourceId), from, to, noOp:false};
  }

  function storeComposerClip(show, rawSpec) {
    ensureShow(show);
    const spec = rawSpec && typeof rawSpec === 'object' ? clone(rawSpec) : {};
    const owns = key => Object.prototype.hasOwnProperty.call(spec, key);
    if (!show.composer.layers.some(layer => layer.id === spec.layerId))
      throw new RangeError(`Unknown GSL5 composer layer: ${spec.layerId}`);
    if (!show.composer.columns.some(column => column.id === spec.columnId))
      throw new RangeError(`Unknown GSL5 composer column: ${spec.columnId}`);
    let existing = spec.id && show.composer.clips.find(clip => clip.id === spec.id);
    if (!existing) existing = show.composer.clips.find(clip =>
      clip.layerId === spec.layerId && clip.columnId === spec.columnId);
    let id = existing && existing.id;
    if (!id) id = uniqueId(spec.id, 'composer:clip', new Set(show.composer.clips.map(clip => clip.id)));
    const next = existing ? Object.assign({}, existing, spec, {id}) : Object.assign({
      id,
      name:`Lighting Clip ${show.composer.clips.length + 1}`,
      enabled:true,
      level:1,
      fadeMs:0,
      items:[]
    }, spec, {id});
    if (owns('quantity') || owns('count')) {
      const inherited = show.composer.layers.find(layer => layer.id === next.layerId)?.target || {kind:'fixtures', fixtureIds:[]};
      next.target = Object.assign({}, clone(next.target || inherited));
      const quantity = optionalQuantity(owns('quantity') ? spec.quantity : spec.count);
      if (quantity == null) delete next.target.quantity;
      else next.target.quantity = quantity;
    }
    if (owns('effectStack') && !owns('items')) {
      const baseItems = (Array.isArray(next.items) ? next.items : []).filter(item =>
        composerItemKind(item && (item.kind || item.type)) !== 'effect');
      const stackItems = (Array.isArray(spec.effectStack) ? spec.effectStack : []).map(entry => {
        const item = typeof entry === 'string' ? {effectId:entry} : entry && typeof entry === 'object' ? entry : {};
        return Object.assign({}, item, {kind:'effect'});
      });
      next.items = baseItems.concat(stackItems).slice(0, MAX_EFFECT_STACK);
      delete next.effectStack;
    }
    show.composer.clips = show.composer.clips.filter(clip => clip.id === id ||
      clip.layerId !== next.layerId || clip.columnId !== next.columnId);
    const index = show.composer.clips.findIndex(clip => clip.id === id);
    if (index < 0) show.composer.clips.push(next);
    else show.composer.clips[index] = next;
    normaliseComposerForShow(show);
    touch(show);
    return show.composer.clips.find(clip => clip.id === id) || null;
  }

  function addComposerClipItem(show, clipOrId, rawItem) {
    ensureShow(show);
    const clip = typeof clipOrId === 'object' ? clipOrId
      : show.composer.clips.find(item => item.id === clipOrId);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${clipOrId}`);
    const item = rawItem && typeof rawItem === 'object' ? clone(rawItem) : {};
    const id = item.id || uid(`${clip.id}:item`);
    clip.items.push(Object.assign({}, item, {id}));
    normaliseComposerForShow(show);
    touch(show);
    const stored = show.composer.clips.find(candidate => candidate.id === clip.id);
    return stored && stored.items.find(candidate => candidate.id === id) || null;
  }

  function setComposerClipQuantity(show, clipOrId, rawQuantity) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const clip = show.composer.clips.find(item => item.id === id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${id}`);
    const layer = show.composer.layers.find(item => item.id === clip.layerId);
    clip.target = clone(clip.target || layer && layer.target || {kind:'fixtures', fixtureIds:[]});
    const quantity = optionalQuantity(rawQuantity);
    if (quantity == null) delete clip.target.quantity;
    else clip.target.quantity = quantity;
    normaliseComposerForShow(show);
    touch(show);
    return show.composer.clips.find(item => item.id === id) || null;
  }

  /* The per-clip intensity master and crossfade already exist on the record
     and are honoured at evaluation (clip.level scales HTP channels; fadeMs
     drives composerTransitionFrame). Nothing could SET them: every creation
     path wrote level:1 and no control anywhere wrote either field. */
  function setComposerClipLevel(show, clipOrId, rawLevel) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const clip = show.composer.clips.find(item => item.id === id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${id}`);
    clip.level = level(rawLevel == null ? 1 : rawLevel);
    /* An intensity master must move the LIGHT, not just the document.
       triggerComposerClip copies clip.level into the runtime state and the
       output fold reads the state first, so without this the fader changed
       nothing until the clip was fired again - the fader moved, the rig did
       not. */
    const running = show.runtime && show.runtime.composer && show.runtime.composer.activeByLayer
      && show.runtime.composer.activeByLayer[clip.layerId];
    if (running && running.clipId === clip.id) running.level = clip.level;
    touch(show);
    return clip;
  }

  function setComposerClipFade(show, clipOrId, rawFadeMs) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const clip = show.composer.clips.find(item => item.id === id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${id}`);
    clip.fadeMs = integer(rawFadeMs, 0, 0, 86400000);
    touch(show);
    return clip;
  }

  function setComposerClipSourcePreset(show, clipOrId, rawPreset) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const clip = show.composer.clips.find(item => item.id === id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${id}`);
    const preset = String(rawPreset || '').toLowerCase();
    if (!['full','blackout','white','home'].includes(preset))
      throw new RangeError(`Unsupported GSL5 Lighting Source preset: ${rawPreset}`);
    const source = (clip.items || []).find(item => item.kind === 'source');
    if (!source) throw new RangeError(`GSL5 composer clip has no Lighting Source: ${id}`);
    source.preset = preset;
    normaliseComposerForShow(show);
    touch(show);
    return show.composer.clips.find(item => item.id === id) || null;
  }

  function setComposerClipEffectStack(show, clipOrId, rawStack) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const clip = show.composer.clips.find(item => item.id === id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${id}`);
    const baseItems = (clip.items || []).filter(item => item.kind !== 'effect');
    const stackItems = (Array.isArray(rawStack) ? rawStack : []).slice(0, MAX_EFFECT_STACK).map(entry => {
      const source = typeof entry === 'string' ? {effectId:entry} : entry && typeof entry === 'object' ? clone(entry) : {};
      return Object.assign({}, source, {kind:'effect'});
    });
    clip.items = baseItems.concat(stackItems).slice(0, MAX_EFFECT_STACK);
    delete clip.effectStack;
    normaliseComposerForShow(show);
    touch(show);
    return show.composer.clips.find(item => item.id === id) || null;
  }

  function moveComposerClip(show, clipOrId, target, rawOptions) {
    ensureShow(show);
    const clip = typeof clipOrId === 'object' ? show.composer.clips.find(item => item.id === clipOrId.id)
      : show.composer.clips.find(item => item.id === clipOrId);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${clipOrId}`);
    const destination = target && typeof target === 'object' ? target : {};
    if (!show.composer.layers.some(layer => layer.id === destination.layerId))
      throw new RangeError(`Unknown GSL5 composer layer: ${destination.layerId}`);
    if (!show.composer.columns.some(column => column.id === destination.columnId))
      throw new RangeError(`Unknown GSL5 composer column: ${destination.columnId}`);
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const occupied = show.composer.clips.find(item => item.id !== clip.id &&
      item.layerId === destination.layerId && item.columnId === destination.columnId);
    if (clip.layerId === destination.layerId && clip.columnId === destination.columnId)
      return {clip, noOp:true, copied:false, swapped:false, replaced:false};
    if (options.copy) {
      if (occupied) show.composer.clips = show.composer.clips.filter(item => item.id !== occupied.id);
      const copy = clone(clip);
      copy.id = uid('composer:clip');
      copy.items.forEach(item => { item.id = uid(`${copy.id}:item`); });
      copy.layerId = destination.layerId;
      copy.columnId = destination.columnId;
      show.composer.clips.push(copy);
      normaliseComposerForShow(show);
      touch(show);
      return {clip:show.composer.clips.find(item => item.id === copy.id), noOp:false,
        copied:true, swapped:false, replaced:!!occupied};
    }
    const previous = {layerId:clip.layerId, columnId:clip.columnId};
    clip.layerId = destination.layerId;
    clip.columnId = destination.columnId;
    if (occupied) {
      occupied.layerId = previous.layerId;
      occupied.columnId = previous.columnId;
    }
    normaliseComposerForShow(show);
    touch(show);
    return {clip:show.composer.clips.find(item => item.id === clip.id), noOp:false,
      copied:false, swapped:!!occupied, replaced:false};
  }

  function removeComposerClip(show, clipOrId) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const before = show.composer.clips.length;
    show.composer.clips = show.composer.clips.filter(clip => clip.id !== id);
    if (show.runtime.composer) Object.keys(show.runtime.composer.activeByLayer || {}).forEach(layerId => {
      if (show.runtime.composer.activeByLayer[layerId].clipId === id)
        delete show.runtime.composer.activeByLayer[layerId];
    });
    if (show.composer.clips.length !== before) touch(show);
    return show.composer.clips.length !== before;
  }

  function resolveTargets(show, selector, fallbackToSelection) {
    const valid = new Set(show.fixtures.map(fixture => fixture.id));
    if (selector == null) return fallbackToSelection
      ? show.programmer.selectedFixtureIds.filter(id => valid.has(id)) : [];
    if (typeof selector === 'string') {
      const group = show.groups.find(item => item.id === selector);
      return group ? group.fixtureIds.slice() : valid.has(selector) ? [selector] : [];
    }
    if (Array.isArray(selector)) return unique(selector).filter(id => valid.has(id));
    if (selector && typeof selector === 'object') {
      if (selector.groupId) return resolveTargets(show, selector.groupId, false);
      if (selector.fixtureIds || selector.ids) return resolveTargets(show, selector.fixtureIds || selector.ids, false);
    }
    return [];
  }

  function addFixtures(show, spec) {
    ensureShow(show);
    if (Array.isArray(spec)) return spec.flatMap(item => addFixtures(show, item));
    const input = spec && typeof spec === 'object' ? spec : {profileId:spec};
    if (input.profile && typeof input.profile === 'object') {
      const custom = normaliseProfile(input.profile, `custom-profile-${show.profiles.length + 1}`);
      const at = show.profiles.findIndex(profile => profile.id === custom.id);
      if (at >= 0) show.profiles[at] = custom; else show.profiles.push(custom);
    }
    const profiles = profileMap(show);
    const profileId = text(input.profileId || input.profile && input.profile.id, 'generic-dimmer-8');
    const profile = profiles.get(profileId);
    if (!profile) throw new RangeError(`Unknown GSL5 profile: ${profileId}`);
    const quantity = integer(input.quantity == null ? input.count : input.quantity, 1, 1, MAX_FIXTURES);
    const used = new Set(show.fixtures.map(fixture => fixture.id));
    let universe = integer(input.universe, 1, 1, MAX_UNIVERSE);
    let address = integer(input.address, 1, 1, 512);
    const added = [];
    for (let index = 0; index < quantity && show.fixtures.length < MAX_FIXTURES; index++) {
      if (address + profile.footprint - 1 > 512) { universe = Math.min(MAX_UNIVERSE, universe + 1); address = 1; }
      const wantedId = quantity > 1 && input.id ? `${input.id}:${index + 1}` : input.id;
      const fixture = {
        id:uniqueId(wantedId, 'fixture', used),
        name:text(quantity > 1 ? `${input.name || profile.name} ${index + 1}` : input.name, `${profile.name} ${show.fixtures.length + 1}`),
        profileId,
        universe,
        address,
        enabled:input.enabled !== false,
        tags:unique(input.tags),
        position:{
          x:finite(input.position && input.position.x, finite(input.x, show.fixtures.length)),
          y:finite(input.position && input.position.y, finite(input.y, 0)),
          z:finite(input.position && input.position.z, finite(input.z, 0))
        },
        note:text(input.note, '')
      };
      show.fixtures.push(fixture); added.push(fixture);
      address += profile.footprint;
    }
    if (input.groupId || input.groupName) {
      let group = show.groups.find(item => item.id === input.groupId);
      if (!group) {
        const usedGroups = new Set(show.groups.map(item => item.id));
        group = {id:uniqueId(input.groupId, 'group', usedGroups), name:text(input.groupName, 'Fixture Group'), fixtureIds:[], grid:[]};
        show.groups.push(group);
      }
      added.forEach((fixture, index) => {
        if (!group.fixtureIds.includes(fixture.id)) group.fixtureIds.push(fixture.id);
        group.grid.push({fixtureId:fixture.id, x:finite(input.gridX, index), y:finite(input.gridY, 0), z:0});
      });
    }
    touch(show);
    return added;
  }

  function removeFixtures(show, selector) {
    ensureShow(show);
    const ids = new Set(resolveTargets(show, selector, false));
    const before = show.fixtures.length;
    show.fixtures = show.fixtures.filter(fixture => !ids.has(fixture.id));
    show.groups.forEach(group => {
      group.fixtureIds = group.fixtureIds.filter(id => !ids.has(id));
      group.grid = group.grid.filter(cell => !ids.has(cell.fixtureId));
    });
    ids.forEach(id => {
      delete show.programmer.values[id];
      show.palettes.forEach(palette => delete palette.values[id]);
      show.cues.forEach(cue => delete cue.values[id]);
    });
    show.programmer.selectedFixtureIds = show.programmer.selectedFixtureIds.filter(id => !ids.has(id));
    show.effects.forEach(effect => { effect.fixtureIds = effect.fixtureIds.filter(id => !ids.has(id)); });
    if (show.composer) {
      show.composer.layers.forEach(layer => {
        if (layer.target && layer.target.kind === 'fixtures')
          layer.target.fixtureIds = layer.target.fixtureIds.filter(id => !ids.has(id));
      });
      show.composer.clips.forEach(clip => {
        if (clip.target && clip.target.kind === 'fixtures')
          clip.target.fixtureIds = clip.target.fixtureIds.filter(id => !ids.has(id));
        clip.items = clip.items.filter(item => item.kind !== 'fixture' || !ids.has(item.refId));
        clip.items.forEach(item => {
          if (item.kind === 'look') ids.forEach(id => delete item.values[id]);
        });
      });
    }
    touch(show);
    return before - show.fixtures.length;
  }

  function validatePatch(show) {
    ensureShow(show);
    const errors = [], warnings = [], occupied = new Map(), profiles = profileMap(show), universes = {};
    show.fixtures.forEach(fixture => {
      const profile = profiles.get(fixture.profileId);
      if (!profile) {
        errors.push({code:'missing-profile', fixtureIds:[fixture.id], message:`${fixture.name} uses missing profile ${fixture.profileId}.`});
        return;
      }
      if (!fixture.enabled) warnings.push({code:'disabled-fixture', fixtureIds:[fixture.id], message:`${fixture.name} is disabled.`});
      if (fixture.address + profile.footprint - 1 > 512) {
        errors.push({code:'footprint-overflow', fixtureIds:[fixture.id], universe:fixture.universe, address:fixture.address,
          message:`${fixture.name} exceeds universe ${fixture.universe}.`});
        return;
      }
      if (!universes[fixture.universe]) universes[fixture.universe] = [];
      universes[fixture.universe].push({fixtureId:fixture.id, from:fixture.address, to:fixture.address + profile.footprint - 1});
      for (let slot = fixture.address; slot < fixture.address + profile.footprint; slot++) {
        const key = `${fixture.universe}:${slot}`, previous = occupied.get(key);
        if (previous) errors.push({code:'overlap', fixtureIds:[previous, fixture.id], universe:fixture.universe, address:slot,
          message:`Fixtures ${previous} and ${fixture.id} overlap at ${fixture.universe}.${slot}.`});
        else occupied.set(key, fixture.id);
      }
    });
    return {valid:errors.length === 0, errors, warnings, universes};
  }

  function selectFixtures(show, selector, rawOptions) {
    ensureShow(show);
    const embeddedOptions = selector && typeof selector === 'object' && !Array.isArray(selector) ? selector : {};
    const options = rawOptions && typeof rawOptions === 'object'
      ? Object.assign({}, embeddedOptions, rawOptions) : embeddedOptions;
    let selected = resolveTargets(show, selector, false);
    const pattern = String(options.pattern || options.order || '').toLowerCase();
    if (pattern === 'odd') selected = selected.filter((id, index) => index % 2 === 0);
    if (pattern === 'even') selected = selected.filter((id, index) => index % 2 === 1);
    if (pattern === 'reverse') selected.reverse();
    if (pattern === 'center-out') {
      const positions = new Map(selected.map((id, index) => [id, index]));
      const middle = (selected.length - 1) / 2;
      selected.sort((a, b) => Math.abs(positions.get(a) - middle) - Math.abs(positions.get(b) - middle)
        || positions.get(a) - positions.get(b));
    }
    const current = show.programmer.selectedFixtureIds.slice();
    const mode = String(options.mode || 'replace').toLowerCase();
    if (mode === 'add') selected = unique(current.concat(selected));
    else if (mode === 'remove') selected = current.filter(id => !selected.includes(id));
    else if (mode === 'toggle') {
      const toggled = new Set(selected);
      selected = unique(current.concat(selected)).filter(id => current.includes(id) !== toggled.has(id));
    }
    show.programmer.selectedFixtureIds = selected;
    return selected.slice();
  }

  function assignmentValues(show, raw, fixtureIds) {
    if (!raw || typeof raw !== 'object') return {};
    const valid = new Set(show.fixtures.map(fixture => fixture.id));
    const keys = Object.keys(raw);
    if (keys.some(key => valid.has(key))) return normaliseValueMap(raw, valid);
    const attributes = {};
    keys.forEach(key => { const name = attributeName(key); if (name) attributes[name] = token(raw[key]); });
    return Object.fromEntries(fixtureIds.map(fixtureId => [fixtureId, clone(attributes)]));
  }

  function setProgrammerValue(show, targetOrAttribute, attributeOrValues, rawValue) {
    ensureShow(show);
    let targets, values;
    const targetLooksExplicit = Array.isArray(targetOrAttribute) ||
      (typeof targetOrAttribute === 'string' && (show.fixtures.some(fixture => fixture.id === targetOrAttribute) || show.groups.some(group => group.id === targetOrAttribute))) ||
      (targetOrAttribute && typeof targetOrAttribute === 'object' && (targetOrAttribute.fixtureIds || targetOrAttribute.groupId));
    if (targetLooksExplicit) {
      targets = resolveTargets(show, targetOrAttribute, false);
      values = typeof attributeOrValues === 'string' ? {[attributeOrValues]:rawValue} : attributeOrValues;
    } else {
      targets = show.programmer.selectedFixtureIds.slice();
      values = typeof targetOrAttribute === 'string' ? {[targetOrAttribute]:attributeOrValues} : targetOrAttribute;
    }
    const assignments = assignmentValues(show, values, targets);
    Object.entries(assignments).forEach(([fixtureId, attributes]) => {
      if (!show.programmer.values[fixtureId]) show.programmer.values[fixtureId] = {};
      Object.entries(attributes).forEach(([attribute, value]) => {
        show.programmer.values[fixtureId][attribute] = token(value);
      });
    });
    touch(show);
    return clone(show.programmer.values);
  }

  function clearProgrammer(show, options) {
    ensureShow(show);
    const config = typeof options === 'string' ? {[options]:true} : options && typeof options === 'object' ? options : {};
    if (config.selection === true || options == null) show.programmer.selectedFixtureIds = [];
    if (config.selectionOnly) { show.programmer.selectedFixtureIds = []; return show.programmer; }
    const targets = config.fixtureIds || config.groupId ? resolveTargets(show, config, false) : Object.keys(show.programmer.values);
    const attributes = unique(config.attributes || (config.attribute ? [config.attribute] : [])).map(attributeName);
    targets.forEach(fixtureId => {
      if (!show.programmer.values[fixtureId]) return;
      if (!attributes.length) delete show.programmer.values[fixtureId];
      else {
        attributes.forEach(attribute => delete show.programmer.values[fixtureId][attribute]);
        if (!Object.keys(show.programmer.values[fixtureId]).length) delete show.programmer.values[fixtureId];
      }
    });
    if (config.selection !== false && options != null && !config.keepSelection) show.programmer.selectedFixtureIds = [];
    touch(show);
    return show.programmer;
  }

  function captureValues(show, spec) {
    const targets = resolveTargets(show, spec && (spec.fixtureIds || spec.groupId), true);
    if (spec && spec.values) return assignmentValues(show, spec.values, targets.length ? targets : show.fixtures.map(fixture => fixture.id));
    const source = show.programmer.values;
    if (!targets.length) return clone(source);
    return Object.fromEntries(targets.filter(id => source[id]).map(id => [id, clone(source[id])]));
  }

  function storePalette(show, rawSpec) {
    ensureShow(show);
    const spec = typeof rawSpec === 'string' ? {name:rawSpec} : rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
    let captured = captureValues(show, spec);
    const requestedAttributes = unique(spec.attributes).map(attributeName);
    if (requestedAttributes.length) {
      const allowed = new Set(requestedAttributes), filtered = {};
      Object.entries(captured).forEach(([fixtureId, attributes]) => {
        Object.entries(attributes || {}).forEach(([attribute, value]) => {
          if (!allowed.has(attributeName(attribute))) return;
          if (!filtered[fixtureId]) filtered[fixtureId] = {};
          filtered[fixtureId][attributeName(attribute)] = value;
        });
      });
      captured = filtered;
    }
    const plain = plainValueMap(captured);
    let palette = spec.id && show.palettes.find(item => item.id === spec.id);
    if (!palette) {
      const used = new Set(show.palettes.map(item => item.id));
      palette = {id:uniqueId(spec.id, 'palette', used)};
      show.palettes.push(palette);
    }
    const mode = ['selective', 'global', 'universal'].includes(spec.mode) ? spec.mode : palette.mode || 'selective';
    const profileValues = {}, universalValues = {};
    if (mode === 'global') Object.entries(plain).forEach(([fixtureId, attributes]) => {
      const fixture = show.fixtures.find(item => item.id === fixtureId);
      if (fixture && !profileValues[fixture.profileId]) profileValues[fixture.profileId] = clone(attributes);
    });
    if (mode === 'universal') Object.values(plain).forEach(attributes => Object.entries(attributes).forEach(([attribute, value]) => {
      if (!Object.prototype.hasOwnProperty.call(universalValues, attribute)) universalValues[attribute] = value;
    }));
    Object.assign(palette, {
      name:text(spec.name, palette.name || `Palette ${show.palettes.indexOf(palette) + 1}`),
      mode,
      values:spec.merge ? Object.assign({}, palette.values || {}, plain) : plain,
      profileValues:mode === 'global' ? profileValues : {},
      universalValues:mode === 'universal' ? universalValues : {},
      attributes:unique(Object.values(plain).flatMap(attributes => Object.keys(attributes))).map(attributeName)
    });
    touch(show);
    return palette;
  }

  function paletteValue(show, palette, fixture, attribute) {
    if (palette.values[fixture.id] && Object.prototype.hasOwnProperty.call(palette.values[fixture.id], attribute))
      return palette.values[fixture.id][attribute];
    if (palette.profileValues[fixture.profileId] && Object.prototype.hasOwnProperty.call(palette.profileValues[fixture.profileId], attribute))
      return palette.profileValues[fixture.profileId][attribute];
    if (Object.prototype.hasOwnProperty.call(palette.universalValues, attribute)) return palette.universalValues[attribute];
    return undefined;
  }

  function applyPalette(show, paletteOrId, selector) {
    ensureShow(show);
    const palette = typeof paletteOrId === 'object' ? paletteOrId : show.palettes.find(item => item.id === paletteOrId);
    if (!palette) throw new RangeError(`Unknown GSL5 palette: ${paletteOrId}`);
    let targets = resolveTargets(show, selector, true);
    if (!targets.length) targets = show.fixtures.map(fixture => fixture.id);
    const attributes = unique(palette.attributes.concat(Object.keys(palette.universalValues || {}),
      ...Object.values(palette.profileValues || {}).map(values => Object.keys(values))));
    targets.forEach(fixtureId => {
      const fixture = show.fixtures.find(item => item.id === fixtureId);
      if (!fixture) return;
      attributes.forEach(attribute => {
        const value = paletteValue(show, palette, fixture, attribute);
        if (value === undefined) return;
        if (!show.programmer.values[fixtureId]) show.programmer.values[fixtureId] = {};
        show.programmer.values[fixtureId][attribute] = {value:level(value), paletteId:palette.id};
      });
    });
    touch(show);
    return clone(show.programmer.values);
  }

  function storeCue(show, rawSpec) {
    ensureShow(show);
    const spec = typeof rawSpec === 'string' ? {name:rawSpec} : rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
    const values = captureValues(show, spec);
    let cue = spec.id && show.cues.find(item => item.id === spec.id);
    if (!cue) {
      const used = new Set(show.cues.map(item => item.id));
      cue = {id:uniqueId(spec.id, 'cue', used)};
      show.cues.push(cue);
    }
    Object.assign(cue, {
      name:text(spec.name, cue.name || `Cue ${show.cues.indexOf(cue) + 1}`),
      values:spec.merge ? Object.assign({}, cue.values || {}, values) : values,
      fadeMs:integer(spec.fadeMs, cue.fadeMs || 0, 0, 86400000),
      delayMs:integer(spec.delayMs, cue.delayMs || 0, 0, 86400000),
      effectIds:unique(spec.effectIds || cue.effectIds).filter(id => show.effects.some(effect => effect.id === id)),
      block:spec.block == null ? !!cue.block : !!spec.block,
      triggers:Array.isArray(spec.triggers) ? clone(spec.triggers).slice(0, 256) : cue.triggers || []
    });
    if (spec.sequenceId) {
      const sequence = show.sequences.find(item => item.id === spec.sequenceId);
      if (sequence && !sequence.cueIds.includes(cue.id)) sequence.cueIds.push(cue.id);
    }
    touch(show);
    return cue;
  }

  function createSequence(show, rawSpec) {
    ensureShow(show);
    const spec = typeof rawSpec === 'string' ? {name:rawSpec} : rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
    const cueIds = [];
    (Array.isArray(spec.cues) ? spec.cues : []).forEach(cue => cueIds.push(typeof cue === 'string' ? cue : storeCue(show, cue).id));
    cueIds.push(...(Array.isArray(spec.cueIds) ? spec.cueIds : []));
    const valid = new Set(show.cues.map(cue => cue.id));
    const used = new Set(show.sequences.map(sequence => sequence.id));
    const sequence = {
      id:uniqueId(spec.id, 'sequence', used),
      name:text(spec.name, `Sequence ${show.sequences.length + 1}`),
      cueIds:unique(cueIds).filter(id => valid.has(id)),
      tracking:spec.tracking !== false,
      loop:!!spec.loop,
      bpm:clamp(finite(spec.bpm, 120), 1, 999),
      stepsPerBeat:clamp(finite(spec.stepsPerBeat, 1), 0.03125, 64),
      direction:['forward', 'reverse', 'bounce'].includes(String(spec.direction || '').toLowerCase())
        ? String(spec.direction).toLowerCase() : 'forward'
    };
    show.sequences.push(sequence); touch(show);
    return sequence;
  }

  function assignPlayback(show, sequenceOrSpec, rawOptions) {
    ensureShow(show);
    const spec = typeof sequenceOrSpec === 'string'
      ? Object.assign({}, rawOptions || {}, {sequenceId:sequenceOrSpec})
      : sequenceOrSpec && typeof sequenceOrSpec === 'object' ? sequenceOrSpec : {};
    if (!show.sequences.some(sequence => sequence.id === spec.sequenceId))
      throw new RangeError(`Unknown GSL5 sequence: ${spec.sequenceId}`);
    let playback = spec.id && show.playbacks.find(item => item.id === spec.id);
    if (!playback) {
      const used = new Set(show.playbacks.map(item => item.id));
      playback = {id:uniqueId(spec.id, 'playback', used)};
      show.playbacks.push(playback);
    }
    Object.assign(playback, {
      name:text(spec.name, playback.name || `Playback ${show.playbacks.indexOf(playback) + 1}`),
      sequenceId:spec.sequenceId,
      level:level(spec.level == null ? playback.level == null ? 1 : playback.level : spec.level),
      priority:integer(spec.priority, playback.priority || 0, -100, 100),
      flash:spec.flash == null ? !!playback.flash : !!spec.flash
    });
    runtimeState(show, show.runtime, playback);
    touch(show);
    return playback;
  }

  function runtimeState(show, runtime, playback) {
    const target = runtime && typeof runtime === 'object' ? runtime : show.runtime;
    if (!target.playbacks || typeof target.playbacks !== 'object') target.playbacks = {};
    if (!Number.isFinite(Number(target.order))) target.order = 0;
    if (!target.effects || typeof target.effects !== 'object') target.effects = {};
    if (!target.playbacks[playback.id]) target.playbacks[playback.id] = {
      active:false, cursor:-1, level:playback.level, startedAt:0, serial:0, fromValues:{}
    };
    return target.playbacks[playback.id];
  }

  function playbackCall(show, first, second, third) {
    let runtime = show.runtime, playbackId = first, value = second;
    if (first && typeof first === 'object' && !Array.isArray(first) && !first.sequenceId) {
      runtime = first; playbackId = second; value = third;
    }
    const playback = typeof playbackId === 'object' ? playbackId :
      show.playbacks.find(item => item.id === playbackId) || (!playbackId ? show.playbacks[0] : null);
    if (!playback) throw new RangeError(`Unknown GSL5 playback: ${playbackId}`);
    return {runtime, playback, value};
  }

  function setPlaybackLevel(show, first, second, third, fourth) {
    ensureShow(show);
    const hasRuntime = first && typeof first === 'object' && !Array.isArray(first) && !first.sequenceId;
    const call = playbackCall(show, first, second, third);
    const amount = level(call.value);
    const nowMs = finite(hasRuntime ? fourth : third, Date.now());
    const state = runtimeState(show, call.runtime, call.playback);
    state.level = amount; call.playback.level = amount;
    const sequence = show.sequences.find(item => item.id === call.playback.sequenceId);
    if (amount > 0 && !state.active && sequence && sequence.cueIds.length) {
      state.active = true; state.cursor = 0; state.startedAt = nowMs;
      call.runtime.order = integer(call.runtime.order, 0, 0, Number.MAX_SAFE_INTEGER) + 1;
      state.serial = call.runtime.order; state.fromValues = {};
    } else if (amount <= 0) state.active = false;
    touch(show);
    return call.playback;
  }

  function resolvedToken(show, fixture, attribute, value) {
    const item = token(value);
    if (!item.paletteId) return item.value;
    const palette = show.palettes.find(candidate => candidate.id === item.paletteId);
    const current = palette && paletteValue(show, palette, fixture, attribute);
    return current === undefined ? item.value : current;
  }

  function cueFrame(show, sequence, cursor) {
    const values = {}, effects = new Set();
    if (!sequence || !sequence.cueIds.length || cursor < 0) return {values, effectIds:effects, cue:null};
    const stop = clamp(cursor, 0, sequence.cueIds.length - 1);
    const indices = sequence.tracking ? Array.from({length:stop + 1}, (_, index) => index) : [stop];
    let current = null;
    indices.forEach(index => {
      const cue = show.cues.find(item => item.id === sequence.cueIds[index]);
      if (!cue) return;
      current = index === stop ? cue : current;
      if (cue.block) Object.keys(values).forEach(key => delete values[key]);
      Object.entries(cue.values).forEach(([fixtureId, attributes]) => {
        if (!values[fixtureId]) values[fixtureId] = {};
        const fixture = show.fixtures.find(item => item.id === fixtureId);
        if (!fixture) return;
        Object.entries(attributes).forEach(([attribute, value]) => {
          values[fixtureId][attribute] = resolvedToken(show, fixture, attribute, value);
        });
      });
      cue.effectIds.forEach(id => effects.add(id));
    });
    return {values, effectIds:effects, cue:current};
  }

  function composerTargetFixtureIds(show, target) {
    const value = target && typeof target === 'object' ? target : {kind:'all'};
    let fixtureIds;
    if (value.kind === 'all') fixtureIds = show.fixtures.filter(fixture => fixture.enabled !== false).map(fixture => fixture.id);
    else if (value.kind === 'group') {
      const group = show.groups.find(item => item.id === value.groupId);
      const members = new Set(group && group.fixtureIds || []);
      fixtureIds = group ? show.fixtures.filter(fixture => fixture.enabled !== false && members.has(fixture.id)).map(fixture => fixture.id) : [];
    }
    else if (value.kind === 'profile') fixtureIds = show.fixtures.filter(fixture =>
      fixture.enabled !== false && fixture.profileId === value.profileId).map(fixture => fixture.id);
    else fixtureIds = unique(value.fixtureIds).filter(id => show.fixtures.some(fixture =>
      fixture.id === id && fixture.enabled !== false));
    const quantity = optionalQuantity(Object.prototype.hasOwnProperty.call(value, 'quantity')
      ? value.quantity : value.count);
    return quantity == null ? fixtureIds : fixtureIds.slice(0, quantity);
  }

  function resolveComposerClipTargets(show, clipOrId) {
    ensureShow(show);
    const id = text(clipOrId && typeof clipOrId === 'object' ? clipOrId.id : clipOrId, '');
    const clip = show.composer.clips.find(item => item.id === id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${id}`);
    const layer = show.composer.layers.find(item => item.id === clip.layerId);
    return composerTargetFixtureIds(show, clip.target || layer && layer.target).slice();
  }

  function composerClipFrame(show, layer, clip, runtime) {
    const values = {}, effects = [], legacyEffectIds = new Set(), profiles = profileMap(show);
    const targets = composerTargetFixtureIds(show, clip.target || layer.target);
    const allowed = new Set(targets);
    const addLegacyEffect = effectId => {
      if (!effectId || legacyEffectIds.has(effectId)) return;
      legacyEffectIds.add(effectId);
      effects.push({effectId, enabled:true, bypassed:false, parameters:{}});
    };
    const merge = (source, amount) => Object.entries(source || {}).forEach(([fixtureId, attributes]) => {
      if (!allowed.has(fixtureId)) return;
      const fixture = show.fixtures.find(item => item.id === fixtureId);
      if (!fixture) return;
      if (!values[fixtureId]) values[fixtureId] = {};
      Object.entries(attributes || {}).forEach(([attribute, raw]) => {
        values[fixtureId][attributeName(attribute)] = resolvedToken(show, fixture, attributeName(attribute), raw) * amount;
      });
    });
    (clip.items || []).forEach(item => {
      if (!item.enabled || item.level <= 0) return;
      if (item.kind === 'cue') {
        const cue = show.cues.find(candidate => candidate.id === item.refId);
        const sequence = item.sequenceId && show.sequences.find(candidate => candidate.id === item.sequenceId);
        if (cue && sequence && sequence.cueIds.includes(cue.id)) {
          const frame = cueFrame(show, sequence, sequence.cueIds.indexOf(cue.id));
          merge(frame.values, item.level); frame.effectIds.forEach(addLegacyEffect);
        } else if (cue) {
          merge(cue.values, item.level); cue.effectIds.forEach(addLegacyEffect);
        }
      } else if (item.kind === 'palette') {
        const palette = show.palettes.find(candidate => candidate.id === item.refId);
        if (!palette) return;
        targets.forEach(fixtureId => {
          const fixture = show.fixtures.find(candidate => candidate.id === fixtureId);
          if (!fixture) return;
          unique(palette.attributes.concat(Object.keys(palette.universalValues || {}),
            ...Object.values(palette.profileValues || {}).map(map => Object.keys(map)))).forEach(attribute => {
            const value = paletteValue(show, palette, fixture, attribute);
            if (value === undefined) return;
            if (!values[fixtureId]) values[fixtureId] = {};
            values[fixtureId][attribute] = level(value) * item.level;
          });
        });
      } else if (item.kind === 'look') merge(item.values, item.level);
      else if (item.kind === 'source') {
        const sourceValues = {};
        targets.forEach(fixtureId => {
          const fixture = show.fixtures.find(candidate => candidate.id === fixtureId);
          const profile = fixture && profiles.get(fixture.profileId);
          if (profile) sourceValues[fixtureId] = fixtureSourceLook(profile, item.preset);
        });
        merge(sourceValues, item.level);
      }
      else if (item.kind === 'effect') effects.push({
        effectId:item.refId,
        enabled:item.enabled,
        bypassed:item.bypassed,
        parameters:clone(item.parameters || {})
      });
      else if (item.kind === 'sequence') {
        const sequence = show.sequences.find(candidate => candidate.id === item.refId);
        const frame = sequence && cueFrame(show, sequence, 0);
        if (frame) { merge(frame.values, item.level); frame.effectIds.forEach(addLegacyEffect); }
      } else if (item.kind === 'playback') {
        const playback = show.playbacks.find(candidate => candidate.id === item.refId);
        const sequence = playback && show.sequences.find(candidate => candidate.id === playback.sequenceId);
        const state = playback && runtime && runtime.playbacks && runtime.playbacks[playback.id];
        const frame = sequence && cueFrame(show, sequence, state && state.active ? state.cursor : 0);
        if (frame) { merge(frame.values, item.level); frame.effectIds.forEach(addLegacyEffect); }
      }
    });
    return {values, effects, effectIds:new Set(effects.map(effect => effect.effectId)), targetIds:targets};
  }

  function composerTransitionFrame(show, layer, clip, state, defaults, runtime, nowMs) {
    const target = composerClipFrame(show, layer, clip, runtime);
    if (clip.fadeMs <= 0) return target;
    const progress = clamp((nowMs - state.startedAt) / clip.fadeMs, 0, 1);
    if (progress >= 1) return target;
    const values = {}, fixtureIds = unique(Object.keys(state.fromValues || {}).concat(Object.keys(target.values)));
    fixtureIds.forEach(fixtureId => {
      if (!target.targetIds.includes(fixtureId)) return;
      const fallback = defaults[fixtureId] || {}, from = state.fromValues[fixtureId] || {}, to = target.values[fixtureId] || {};
      unique(Object.keys(from).concat(Object.keys(to))).forEach(attribute => {
        if (!values[fixtureId]) values[fixtureId] = {};
        const a = Object.prototype.hasOwnProperty.call(from, attribute) ? from[attribute] : fallback[attribute] || 0;
        const b = Object.prototype.hasOwnProperty.call(to, attribute) ? to[attribute] : fallback[attribute] || 0;
        values[fixtureId][attribute] = a + (b - a) * progress;
      });
    });
    return {values, effects:target.effects, effectIds:target.effectIds, targetIds:target.targetIds};
  }

  function composerRuntimeCall(show, first, second, third) {
    const hasRuntime = first && typeof first === 'object' && !Array.isArray(first) && first.composer && first.playbacks;
    const runtime = hasRuntime ? first : show.runtime;
    if (!runtime.composer || typeof runtime.composer !== 'object')
      runtime.composer = {activeByLayer:{}, activeColumnId:''};
    if (!runtime.composer.activeByLayer || typeof runtime.composer.activeByLayer !== 'object')
      runtime.composer.activeByLayer = {};
    return {runtime, id:hasRuntime ? second : first, nowMs:finite(hasRuntime ? third : second, Date.now())};
  }

  function triggerComposerClip(show, first, second, third) {
    ensureShow(show);
    const call = composerRuntimeCall(show, first, second, third);
    const clip = typeof call.id === 'object' ? show.composer.clips.find(item => item.id === call.id.id)
      : show.composer.clips.find(item => item.id === call.id);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${call.id}`);
    if (!clip.enabled) return null;
    const layer = show.composer.layers.find(item => item.id === clip.layerId);
    if (!layer) return null;
    const previous = call.runtime.composer.activeByLayer[layer.id];
    let fromValues = {};
    if (previous && previous.active) {
      const previousClip = show.composer.clips.find(item => item.id === previous.clipId);
      if (previousClip) fromValues = composerClipFrame(show, layer, previousClip, call.runtime).values;
    }
    call.runtime.order = integer(call.runtime.order, 0, 0, Number.MAX_SAFE_INTEGER) + 1;
    call.runtime.composer.activeByLayer[layer.id] = {
      clipId:clip.id,
      active:true,
      level:clip.level,
      startedAt:call.nowMs,
      serial:call.runtime.order,
      fromValues:plainValueMap(fromValues)
    };
    call.runtime.composer.activeColumnId = '';
    touch(show);
    return clip;
  }

  function triggerComposerColumn(show, first, second, third) {
    ensureShow(show);
    const call = composerRuntimeCall(show, first, second, third);
    const column = typeof call.id === 'object' ? show.composer.columns.find(item => item.id === call.id.id)
      : show.composer.columns.find(item => item.id === call.id);
    if (!column) throw new RangeError(`Unknown GSL5 composer column: ${call.id}`);
    if (column.private || column.scope === SHOWAVE_CLIP_SCOPE)
      throw new RangeError('A private SHOWAVE Lighting Clip column can only be launched by exact Clip ID.');
    const layers = new Map(show.composer.layers.map(layer => [layer.id,layer]));
    const clips = show.composer.clips.filter(clip => {
      const layer=layers.get(clip.layerId);
      return clip.columnId === column.id && clip.enabled && !clip.private && clip.scope !== SHOWAVE_CLIP_SCOPE &&
        layer && !layer.private && layer.scope !== SHOWAVE_CLIP_SCOPE;
    });
    clips.forEach(clip => triggerComposerClip(show, call.runtime, clip.id, call.nowMs));
    /* A Cue column is one launch, not a race between the order in which its
       sparse Clips happened to be authored. Give every row the same launch
       serial so visual layer order is the deterministic LTP tiebreaker. */
    const serial = call.runtime.order;
    clips.forEach(clip => {
      const state = call.runtime.composer.activeByLayer[clip.layerId];
      if (state && state.clipId === clip.id) state.serial = serial;
    });
    call.runtime.composer.activeColumnId = column.id;
    return clips;
  }

  function releaseComposerLayer(show, first, second) {
    ensureShow(show);
    const call = composerRuntimeCall(show, first, second);
    const layerId = text(call.id && typeof call.id === 'object' ? call.id.id : call.id, '');
    if (layerId && !show.composer.layers.some(layer => layer.id === layerId))
      throw new RangeError(`Unknown GSL5 composer layer: ${layerId}`);
    if (layerId) delete call.runtime.composer.activeByLayer[layerId];
    else call.runtime.composer.activeByLayer = {};
    call.runtime.composer.activeColumnId = '';
    touch(show);
    return true;
  }

  function releaseComposerClip(show, first, second) {
    ensureShow(show);
    const call = composerRuntimeCall(show, first, second);
    const clipId = text(call.id && typeof call.id === 'object' ? call.id.id : call.id, '');
    const clip = show.composer.clips.find(item => item.id === clipId);
    if (!clip) throw new RangeError(`Unknown GSL5 composer clip: ${clipId}`);
    const state = call.runtime.composer.activeByLayer[clip.layerId];
    if (!state || state.clipId !== clip.id) return false;
    delete call.runtime.composer.activeByLayer[clip.layerId];
    call.runtime.composer.activeColumnId = '';
    touch(show);
    return true;
  }

  function movePlayback(show, first, second, third, direction) {
    ensureShow(show);
    const call = playbackCall(show, first, second, third), nowMs = finite(call.value, Date.now());
    const state = runtimeState(show, call.runtime, call.playback);
    const sequence = show.sequences.find(item => item.id === call.playback.sequenceId);
    if (!sequence || !sequence.cueIds.length) return null;
    state.fromValues = state.active ? cueFrame(show, sequence, state.cursor).values : {};
    let next = state.cursor;
    if (direction > 0) next = state.active ? state.cursor + 1 : 0;
    else next = state.active ? state.cursor - 1 : 0;
    if (sequence.loop) next = (next % sequence.cueIds.length + sequence.cueIds.length) % sequence.cueIds.length;
    else next = clamp(next, 0, sequence.cueIds.length - 1);
    state.cursor = next; state.active = true; state.startedAt = nowMs;
    call.runtime.order = integer(call.runtime.order, 0, 0, Number.MAX_SAFE_INTEGER) + 1;
    state.serial = call.runtime.order;
    touch(show);
    return show.cues.find(cue => cue.id === sequence.cueIds[next]) || null;
  }

  const go = (show, first, second, third) => movePlayback(show, first, second, third, 1);
  const back = (show, first, second, third) => movePlayback(show, first, second, third, -1);

  function release(show, first, second) {
    ensureShow(show);
    const call = playbackCall(show, first, second);
    const state = runtimeState(show, call.runtime, call.playback);
    state.active = false; state.cursor = -1; state.fromValues = {};
    touch(show);
    return call.playback;
  }

  function fixtureSourceRuntimeCall(show, args, requireTargets) {
    const values = Array.isArray(args) ? args : [];
    const first = values[0];
    const hasRuntime = first && typeof first === 'object' && !Array.isArray(first) &&
      Object.prototype.hasOwnProperty.call(first, 'sources') &&
      !Object.prototype.hasOwnProperty.call(first, 'assetType');
    const runtime = hasRuntime ? first : show.runtime;
    if (!runtime || typeof runtime !== 'object')
      throw new TypeError('Expected a GSL5 runtime object.');
    if (!runtime.sources || typeof runtime.sources !== 'object' || Array.isArray(runtime.sources))
      runtime.sources = {};
    if (!Number.isFinite(Number(runtime.order))) runtime.order = 0;
    let cursor = hasRuntime ? 1 : 0;
    const sourceArg = values[cursor++];
    let spec, nowValue;
    if (sourceArg && typeof sourceArg === 'object' && !Array.isArray(sourceArg)) {
      spec = sourceArg;
      nowValue = values[cursor];
    } else {
      const assetId = values[cursor++];
      const optionsOrNow = values[cursor++];
      if (optionsOrNow && typeof optionsOrNow === 'object' && !Array.isArray(optionsOrNow)) {
        spec = Object.assign({}, optionsOrNow, {assetType:sourceArg, assetId});
        nowValue = values[cursor];
      } else {
        spec = {assetType:sourceArg, assetId};
        nowValue = optionsOrNow;
      }
    }
    const resolved = resolveFixtureSourceInstance(show, spec.assetType, spec.assetId, spec);
    if (requireTargets && !resolved.fixtureIds.length)
      throw new RangeError(`${resolved.asset.name} has no enabled patched fixtures.`);
    return {runtime, resolved, nowMs:finite(nowValue, Date.now())};
  }

  /* Direct fixture sources are deliberately static and idempotent. SHOWAVE
     owns cross-layer reference counting; the engine owns one exact current-
     show source state, so a duplicate GO cannot toggle it off and one final
     STOP removes it. Target membership is resolved from the live patch rather
     than trusted from a drag payload. */
  function startFixtureSource(show, ...args) {
    ensureShow(show);
    const call = fixtureSourceRuntimeCall(show, args, true);
    const previous = Object.prototype.hasOwnProperty.call(call.runtime.sources, call.resolved.key)
      ? call.runtime.sources[call.resolved.key] : null;
    if (previous && previous.active !== false) {
      if (previous.assetType !== call.resolved.assetType || previous.assetId !== call.resolved.assetId)
        throw new RangeError(`GSL5 fixture Source key ${call.resolved.key} is already in use.`);
      const previousShape = JSON.stringify({preset:previous.preset || 'full', quantity:previous.quantity == null ? null : previous.quantity,
        fixtureIds:Object.prototype.hasOwnProperty.call(previous, 'fixtureIds') ? previous.fixtureIds : null,
        effectStack:previous.effectStack || []});
      const nextShape = JSON.stringify({preset:call.resolved.preset, quantity:call.resolved.quantity,
        fixtureIds:call.resolved.requestedFixtureIds, effectStack:call.resolved.effectStack});
      if (previousShape === nextShape) return call.resolved.asset;
    }
    call.runtime.order = integer(call.runtime.order, 0, 0, Number.MAX_SAFE_INTEGER) + 1;
    const state = {
      assetType:call.resolved.assetType,
      assetId:call.resolved.assetId,
      sourceKey:call.resolved.sourceKey,
      instanceId:call.resolved.instanceId,
      preset:call.resolved.preset,
      quantity:call.resolved.quantity,
      effectStack:call.resolved.effectStack,
      active:true,
      startedAt:call.nowMs,
      serial:call.runtime.order
    };
    if (call.resolved.requestedFixtureIds !== null) state.fixtureIds = call.resolved.requestedFixtureIds;
    Object.defineProperty(call.runtime.sources, call.resolved.key, {
      value:state,
      enumerable:true, configurable:true, writable:true
    });
    touch(show);
    return call.resolved.asset;
  }

  function stopFixtureSource(show, ...args) {
    ensureShow(show);
    const call = fixtureSourceRuntimeCall(show, args, false);
    if (Object.prototype.hasOwnProperty.call(call.runtime.sources, call.resolved.key)) {
      const previous = call.runtime.sources[call.resolved.key];
      if (!previous || previous.assetType !== call.resolved.assetType || previous.assetId !== call.resolved.assetId)
        throw new RangeError(`GSL5 fixture Source key ${call.resolved.key} belongs to another Source.`);
      delete call.runtime.sources[call.resolved.key];
      touch(show);
    }
    return call.resolved.asset;
  }

  function effectRuntimeCall(show, first, second, third) {
    const hasRuntime = first && typeof first === 'object' && !Array.isArray(first) &&
      (Object.prototype.hasOwnProperty.call(first, 'effects') ||
        Object.prototype.hasOwnProperty.call(first, 'playbacks') ||
        Object.prototype.hasOwnProperty.call(first, 'composer'));
    const runtime = hasRuntime ? first : show.runtime;
    const effectId = hasRuntime ? second : first;
    if (typeof effectId !== 'string' || !effectId)
      throw new TypeError('A GSL5 effect command requires an exact effect ID.');
    const effect = show.effects.find(item => item.id === effectId);
    if (!effect) throw new RangeError(`Unknown GSL5 effect: ${effectId}`);
    if (!runtime || typeof runtime !== 'object')
      throw new TypeError('Expected a GSL5 runtime object.');
    if (!runtime.effects || typeof runtime.effects !== 'object' || Array.isArray(runtime.effects))
      runtime.effects = {};
    return {runtime, effect, nowMs:finite(hasRuntime ? third : second, Date.now())};
  }

  function startEffect(show, first, second, third) {
    ensureShow(show);
    const call = effectRuntimeCall(show, first, second, third);
    if (!call.effect.enabled)
      throw new RangeError(`Cannot start disabled GSL5 effect: ${call.effect.id}`);
    Object.defineProperty(call.runtime.effects, call.effect.id, {
      value:{active:true, startedAt:call.nowMs}, enumerable:true, configurable:true, writable:true
    });
    touch(show);
    return call.effect;
  }

  function stopEffect(show, first, second) {
    ensureShow(show);
    const call = effectRuntimeCall(show, first, second);
    const previous = Object.prototype.hasOwnProperty.call(call.runtime.effects, call.effect.id)
      ? call.runtime.effects[call.effect.id] : null;
    Object.defineProperty(call.runtime.effects, call.effect.id, {
      value:{active:false, startedAt:finite(previous && previous.startedAt, call.effect.startedAt)},
      enumerable:true, configurable:true, writable:true
    });
    touch(show);
    return call.effect;
  }

  function addEffect(show, rawSpec) {
    ensureShow(show);
    const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
    const selected = resolveTargets(show, spec.fixtureIds || spec.groupId, true);
    const used = new Set(show.effects.map(effect => effect.id));
    const effect = {
      id:uniqueId(spec.id, 'effect', used),
      name:text(spec.name, `Effect ${show.effects.length + 1}`),
      fixtureIds:selected,
      groupId:show.groups.some(group => group.id === spec.groupId) ? spec.groupId : '',
      attribute:attributeName(spec.attribute || 'dimmer'),
      mode:spec.mode === 'absolute' ? 'absolute' : 'relative',
      waveform:['sine', 'triangle', 'square', 'saw', 'steps'].includes(spec.waveform) ? spec.waveform : 'sine',
      steps:(Array.isArray(spec.steps) ? spec.steps : []).slice(0, 128).map(step => ({
        value:level(step && typeof step === 'object' ? step.value : step),
        width:Math.max(0.001, finite(step && step.width, 1)),
        transition:clamp(finite(step && step.transition, 1), 0, 1)
      })),
      base:level(spec.base == null ? 0.5 : spec.base),
      size:clamp(finite(spec.size, 0.5), -1, 1),
      offset:clamp(finite(spec.offset, 0), -1, 1),
      speedBpm:clamp(finite(spec.speedBpm || spec.bpm || spec.speed, 60), 0.001, 9999),
      direction:['forward','reverse','bounce'].includes(spec.direction) ? spec.direction : 'forward',
      rateSource:spec.rateSource === 'bpm' ? 'bpm' : 'hz',
      rateMultiplier:clamp(finite(spec.rateMultiplier, 1), 0.01, 8),
      phase:finite(spec.phase, 0), spread:finite(spec.spread, 360),
      startedAt:finite(spec.startedAt, 0), enabled:spec.enabled !== false, autostart:spec.autostart !== false
    };
    show.effects.push(effect); touch(show);
    return effect;
  }

  function removeEffect(show, effectId) {
    ensureShow(show);
    const index = show.effects.findIndex(effect => effect.id === effectId);
    if (index < 0) throw new RangeError(`Unknown GSL5 effect: ${effectId}`);
    const removed = show.effects.splice(index, 1)[0];
    show.cues.forEach(cue => { cue.effectIds = cue.effectIds.filter(id => id !== effectId); });
    show.composer.clips.forEach(clip => {
      clip.items = clip.items.filter(item => !(item.kind === 'effect' && item.refId === effectId));
      clip.effectStack = (clip.effectStack || []).filter(item => item.effectId !== effectId);
    });
    delete show.runtime.effects[effectId];
    Object.values(show.runtime.sources).forEach(source => {
      source.effectStack = (source.effectStack || []).filter(item => item.effectId !== effectId);
    });
    touch(show);
    return removed;
  }

  function effectWithParameters(effect, rawParameters) {
    return Object.assign({}, effect, normaliseEffectParameters(rawParameters));
  }

  function fixtureDefaults(profile) {
    const out = {};
    (profile && profile.channels || []).forEach(channel => {
      if (!Object.prototype.hasOwnProperty.call(out, channel.attribute)) out[channel.attribute] = channel.default;
    });
    return out;
  }

  /* ---------------------------------------------------------- function ranges
     A channel's function table (Closed 0-7, Open 8-15, Strobe 16-255 ...) is
     parsed from D4/R20 and authored in the Builder, but the encoder writes a
     LINEAR fraction and nothing consulted the table. On a shutter that made
     "Open" a 3% window and every value above it a strobe - including the
     default preset, which drove 18 of 56 samples to full-rate strobe. These
     helpers make named bands addressable and readable. The encode itself
     stays linear, so no other attribute changes. */
  function channelMaxDmx(channel) { return channel && channel.bits === 16 ? 65535 : 255; }
  function channelFunctions(channel) { return channel && Array.isArray(channel.functions) ? channel.functions : []; }
  function channelFunctionAt(channel, fraction) {
    const functions = channelFunctions(channel);
    if (!functions.length) return null;
    /* Compare the byte the encoder will actually write, not the unrounded
       fraction: 3% is 7.65, which the encoder rounds to 8 - Open. */
    const dmx = Math.round(level(fraction) * channelMaxDmx(channel));
    return functions.find(fn => dmx >= finite(fn.dmxStart, 0) && dmx <= finite(fn.dmxEnd, 0)) || null;
  }
  function findChannelFunction(channel, key) {
    const functions = channelFunctions(channel);
    if (key instanceof RegExp) return functions.find(fn => key.test(String(fn.id || '')) || key.test(String(fn.name || ''))) || null;
    const wanted = String(key == null ? '' : key).toLowerCase();
    return functions.find(fn => String(fn.id || '').toLowerCase() === wanted || String(fn.name || '').toLowerCase() === wanted) || null;
  }
  /* The fraction that lands `within` (0..1) of the way through a named band;
     null when the channel has no such band. */
  function functionFraction(channel, key, within) {
    const fn = key && typeof key === 'object' && !(key instanceof RegExp) ? key : findChannelFunction(channel, key);
    if (!fn) return null;
    const start = finite(fn.dmxStart, 0), end = Math.max(start, finite(fn.dmxEnd, start));
    const dmx = start + (end - start) * clamp(finite(within, 0.5), 0, 1);
    return clamp(dmx / channelMaxDmx(channel), 0, 1);
  }
  /* A band is a RATE in Hz only when the personality SAYS so: a sloped
     display span whose unit is 'hz'. Inferring Hz from any slope printed a
     strobe speed nobody wrote down - for D4 spans, which carry no unit, for
     rpm and seconds scales, and for raw 0..255 spans. gsl5-preview.js
     shutterState() applies the same rule. */
  function functionIsRate(fn) {
    if (!fn) return false;
    return finite(fn.displayStart, 0) !== finite(fn.displayEnd, 0) && text(fn.unit, '').toLowerCase() === 'hz';
  }
  const isShutterChannel = channel => text(channel && (channel.semantic || channel.attribute), '') === 'shutter';
  /* Only a SHUTTER's stated-Hz band is a strobe. A name is not evidence: a
     fan's "Pulse 1~100" or a macro's "Strobe macro 1~10" is not a shutter. */
  function strobeFunction(channel) {
    if (!isShutterChannel(channel)) return null;
    return channelFunctions(channel).find(functionIsRate) || null;
  }
  /* The fraction that asks a shutter for `hz`; null when the personality
     states no rate, because picking one would be the fabrication this engine
     refuses to make. */
  function strobeFraction(channel, hz) {
    const fn = strobeFunction(channel);
    if (!fn) return null;
    const from = finite(fn.displayStart, 0), to = finite(fn.displayEnd, 0);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const wanted = clamp(finite(hz, lo), lo, hi);
    const within = hi === lo ? 0 : (wanted - from) / (to - from);
    return functionFraction(channel, fn, within);
  }
  /* What an operator should READ for a value: the band name, the Hz when the
     band is a rate, or a plain percentage when the channel has no table. */
  function describeChannelValue(channel, fraction) {
    const value = level(fraction), percent = Math.round(value * 100);
    const fn = channelFunctionAt(channel, value);
    if (!fn) return {name:'', text:`${percent}%`, percent, rate:null, band:null};
    const start = finite(fn.dmxStart, 0), end = Math.max(start, finite(fn.dmxEnd, start));
    const within = clamp((Math.round(value * channelMaxDmx(channel)) - start) / (end - start || 1), 0, 1);
    const from = finite(fn.displayStart, 0), to = finite(fn.displayEnd, 0);
    const name = text(fn.name, text(fn.id, ''));
    if (from === to) return {name, text:name, percent, rate:null, band:fn};
    const scale = from + (to - from) * within, shown = scale >= 10 ? Math.round(scale) : scale.toFixed(1);
    const unit = text(fn.unit, '').toLowerCase();
    /* The unit is printed only when the personality states one - a D4 span
       carries none and reads as a bare number. A stated Hz is a strobe RATE
       only on a shutter; the Programmer's Hz entry keys off `rate`. */
    const suffix = unit === 'hz' ? ' Hz' : unit === 'percent' ? '%' : unit ? ` ${text(fn.unit, '')}` : '';
    return {name, text:`${name} ${shown}${suffix}`, percent, rate:unit === 'hz' && isShutterChannel(channel) ? scale : null, scale, band:fn};
  }
  /* The fraction a shutter should REST at, in priority: its Locate; a FLAT
     band named as open - exact synonyms first, then a flat band whose name
     starts with "open"; else the lowest flat band, which on every real table
     is Closed / No function - dark, never strobing; else, only when the
     channel states no table at all, full. A rate band never qualifies, so
     "Open pulse slow to fast" cannot be mistaken for Open, and a table with
     no open-like band ("No function / Strobe") rests dark rather than at 255.
     gsl5-preview.js shutterRest() mirrors this rule word for word. */
  const OPEN_SYNONYMS = ['open', 'shutter open', 'full open', 'open full', 'on', 'full on', 'no function', 'no strobe', 'none', 'no effect'];
  const bandLabel = fn => text(fn.name, text(fn.id, '')).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/ +/g, ' ').trim();
  function shutterRestFraction(channel) {
    if (!channel) return 1;
    if (channel.locate != null) return level(channel.locate);
    const functions = channelFunctions(channel);
    if (!functions.length) return 1;
    const flat = functions.filter(fn => finite(fn.displayStart, 0) === finite(fn.displayEnd, 0));
    const exact = flat.find(fn => OPEN_SYNONYMS.includes(bandLabel(fn)) || OPEN_SYNONYMS.includes(String(fn.id || '').toLowerCase()));
    const prefixed = exact || flat.find(fn => /^open( |$)/.test(bandLabel(fn)));
    const chosen = prefixed || flat.slice().sort((a, b) => finite(a.dmxStart, 0) - finite(b.dmxStart, 0))[0] || null;
    return chosen ? functionFraction(channel, chosen, 0.5) : 0;
  }

  /* ONE attribute lookup for every value path. An exact channel key wins; a
     bare semantic addresses every channel that carries it, which is how a
     multicell fixture answers `red` while it is not unfolded. */
  function channelsFor(profile, attribute) {
    const channels = profile && profile.channels || [];
    const exact = channels.filter(channel => channel.attribute === attribute);
    return exact.length ? exact
      : channels.filter(channel => (channel.semantic || channel.attribute) === attribute);
  }

  function fixtureSourceLook(profile, rawPreset) {
    const preset = ['full','blackout','white','home'].includes(rawPreset) ? rawPreset : 'full';
    const values = fixtureDefaults(profile), channels = profile && profile.channels || [];
    const bySemantic = semantic => channels.filter(channel => (channel.semantic || channel.attribute) === semantic);
    if (preset === 'home') return values;
    if (preset === 'full') channels.forEach(channel => {
      if (channel.locate != null) values[channel.attribute] = channel.locate;
    });
    if (preset === 'blackout') {
      bySemantic('dimmer').forEach(channel => { values[channel.attribute] = 0; });
      bySemantic('intensity').forEach(channel => { values[channel.attribute] = 0; });
      return values;
    }
    bySemantic('dimmer').forEach(channel => { values[channel.attribute] = 1; });
    bySemantic('intensity').forEach(channel => { values[channel.attribute] = 1; });
    /* Neutral open white in the profile's own colour model. RGB emits white
       additively; CMY removes colour subtraction. A dedicated white emitter is
       opened too. Imported D4 shutters keep their explicit Locate value; a
       built-in profile without Locate retains the legacy open-gate fallback. */
    if (bySemantic('red').length && bySemantic('green').length && bySemantic('blue').length) {
      ['red','green','blue'].forEach(semantic => bySemantic(semantic).forEach(channel => { values[channel.attribute] = 1; }));
    }
    if (bySemantic('cyan').length && bySemantic('magenta').length && bySemantic('yellow').length) {
      ['cyan','magenta','yellow'].forEach(semantic => bySemantic(semantic).forEach(channel => { values[channel.attribute] = 0; }));
    }
    bySemantic('white').forEach(channel => { values[channel.attribute] = 1; });
    /* A tuneable-white or CCT fixture has no `white` channel: its white comes
       from the cold/warm pair, or from a colour-temperature control. Opening
       only `white` left the entire White Light & Theatre and Architectural CCT
       families dark under the one preset whose job is to make white. CCT goes
       to its mechanical midpoint, which is neutral between the two extremes. */
    ['cold-white','warm-white'].forEach(semantic =>
      bySemantic(semantic).forEach(channel => { values[channel.attribute] = 1; }));
    bySemantic('cct').forEach(channel => { values[channel.attribute] = 0.5; });
    bySemantic('shutter').forEach(channel => {
      values[channel.attribute] = shutterRestFraction(channel);
    });
    return values;
  }

  function transitionFrame(show, sequence, state, defaults, nowMs) {
    const target = cueFrame(show, sequence, state.cursor), cue = target.cue;
    if (!cue) return target;
    const elapsed = Math.max(0, nowMs - state.startedAt), progress = cue.fadeMs <= 0
      ? (elapsed >= cue.delayMs ? 1 : 0) : clamp((elapsed - cue.delayMs) / cue.fadeMs, 0, 1);
    if (progress >= 1) return target;
    const values = {}, fixtureIds = unique(Object.keys(state.fromValues || {}).concat(Object.keys(target.values)));
    fixtureIds.forEach(fixtureId => {
      const fixture = show.fixtures.find(item => item.id === fixtureId);
      if (!fixture) return;
      const fallback = defaults[fixtureId] || {};
      const from = state.fromValues[fixtureId] || {}, to = target.values[fixtureId] || {};
      unique(Object.keys(from).concat(Object.keys(to))).forEach(attribute => {
        if (!values[fixtureId]) values[fixtureId] = {};
        const a = Object.prototype.hasOwnProperty.call(from, attribute) ? from[attribute] : fallback[attribute] || 0;
        const b = Object.prototype.hasOwnProperty.call(to, attribute) ? to[attribute] : fallback[attribute] || 0;
        values[fixtureId][attribute] = a + (b - a) * progress;
      });
    });
    return {values, effectIds:target.effectIds, cue};
  }

  function effectWave(effect, cycle) {
    if (effect.direction === 'reverse') cycle = -cycle;
    else if (effect.direction === 'bounce') {
      const travel = ((cycle % 2) + 2) % 2;
      cycle = travel <= 1 ? travel : 2 - travel;
    }
    // Bounce turns at the end of a cycle. Wrapping that exact endpoint to zero
    // creates a one-frame flash in saw/step/square effects before moving back.
    const position = effect.direction === 'bounce' && cycle === 1
      ? 1 : ((cycle % 1) + 1) % 1;
    if (effect.waveform === 'triangle') return 1 - 4 * Math.abs(position - 0.5);
    if (effect.waveform === 'square') return position < 0.5 ? 1 : -1;
    if (effect.waveform === 'saw') return position * 2 - 1;
    if (effect.waveform === 'steps' && Array.isArray(effect.steps) && effect.steps.length) {
      const total = effect.steps.reduce((sum, step) => sum + step.width, 0);
      let at = position * total;
      for (let index = 0; index < effect.steps.length; index++) {
        const step = effect.steps[index];
        if (at < step.width - 1e-9 || index === effect.steps.length - 1) {
          const next = effect.steps[(index + 1) % effect.steps.length];
          const local = clamp(at / step.width, 0, 1);
          const start = 1 - step.transition;
          return local <= start || step.transition <= 0 ? step.value
            : step.value + (next.value - step.value) * ((local - start) / step.transition);
        }
        at -= step.width;
      }
    }
    return Math.sin(position * Math.PI * 2);
  }

  function applyEffectValues(show, effect, targets, startedAt, values, defaults, nowMs) {
    const profiles = profileMap(show);
    /* Resolve the attribute the way the programmer does: exact key, then
       semantic. An effect on bare `red` used to output NOTHING on a multicell
       fixture because only the exact key was accepted - the programmer path
       had been fixed and this one had not, so the two disagreed again. Each
       matched channel is a slot; cells are walked in reading order so spread
       runs along the fixture, then on to the next fixture. */
    const plan = [];
    targets.forEach(fixtureId => {
      const fixture = show.fixtures.find(item => item.id === fixtureId), profile = fixture && profiles.get(fixture.profileId);
      if (!fixture || !profile) return;
      const matched = channelsFor(profile, effect.attribute);
      if (!matched.length) return;
      /* Reading order only when every matched channel carries a cell; a mixed
         set sorts by offset alone, so the comparator stays transitive. */
      const celled = matched.every(channel => channel.cell);
      matched.slice().sort((a, b) => (celled
        ? (finite(a.cell.y, 0) - finite(b.cell.y, 0)) || (finite(a.cell.x, 0) - finite(b.cell.x, 0)) : 0)
        || a.offset - b.offset).forEach(channel => plan.push({fixtureId, channel}));
    });
    if (!plan.length) return;
    /* Spread divides by the number of slots, not slots - 1: with 360 degrees
       across four fixtures the old divisor put the first and last at the same
       phase, so a four-way chase had two fixtures in step. */
    plan.forEach((slot, index) => {
      const phase = (effect.phase + effect.spread * index / plan.length) / 360;
      const speed = effect.rateSource === 'bpm'
        ? clamp(finite(show.metadata && show.metadata.bpm, finite(show.sequences[0] && show.sequences[0].bpm, 120)), 20, 300) * clamp(finite(effect.rateMultiplier, 1), 0.01, 8)
        : effect.speedBpm;
      const cycle = (nowMs - startedAt) * speed / 60000 + phase;
      const wave = effectWave(effect, cycle);
      const fixtureId = slot.fixtureId, key = slot.channel.attribute;
      if (!values[fixtureId]) values[fixtureId] = {};
      const current = Object.prototype.hasOwnProperty.call(values[fixtureId], key)
        ? values[fixtureId][key] : defaults[fixtureId] && defaults[fixtureId][key] || 0;
      values[fixtureId][key] = effect.waveform === 'steps'
        ? clamp(effect.mode === 'absolute' ? wave : current + effect.offset + wave, 0, 1)
        : clamp(effect.mode === 'absolute' ? effect.base + effect.offset + wave * effect.size
          : current + effect.offset + wave * effect.size, 0, 1);
    });
  }

  /* VIRTUAL DIMMER.

     A colour-only fixture - 20 of the 56 built-in samples: every pixel bar,
     tube, matrix and architectural zone - states no dimmer channel. An
     intensity master with nothing HTP to scale therefore did NOTHING at all:
     the Clip Intensity fader moved, the Grand Master moved, and the bar
     stayed at full. That is a control reporting success while nothing
     happens, which this codebase does not ship.

     Every console solves it the same way and calls it the same thing - Titan
     and grandMA3 both say "virtual dimmer": when a personality has no
     intensity channel, intensity scales its colour emitters instead. Control
     channels are never scaled, so a relay pack and a laser safety enable are
     untouched. A personality that DOES state a dimmer is unaffected. */
  const virtualDimmerCache = new WeakMap();
  function usesVirtualDimmer(profile) {
    if (!profile || typeof profile !== 'object') return false;
    const cached = virtualDimmerCache.get(profile);
    if (cached !== undefined) return cached;
    const channels = profile.channels || [];
    const result = !channels.some(channel => channel.mix === 'htp')
      && channels.some(channel => channel.family === 'color');
    virtualDimmerCache.set(profile, result);
    return result;
  }
  function scalesWithIntensity(profile, channel) {
    return channel.mix === 'htp' || (channel.family === 'color' && usesVirtualDimmer(profile));
  }

  function migrateSpread(item, fromVersion, targetCount) {
    const spread = finite(item.spread, 360);
    if (finite(fromVersion, 0) !== 1 || targetCount < 2) return spread;
    return spread * targetCount / (targetCount - 1);
  }

  /* ONE value fold for every playback path - direct Sources, cue playbacks
     and composer clips.

     It resolves the attribute the way the programmer and the effects already
     do (exact channel key, then semantic), so a value RECORDED on a multicell
     fixture as a bare `red` plays back to every red cell instead of to
     nothing. Before this the programmer fold was fixed and these three were
     not, so RECORD showed a value and GO lit nothing - the same class of
     silent no-op the programmer fix set out to close. Each matched channel is
     owned by its own key, so the HTP-max and LTP-priority rules are unchanged
     per channel. */
  function foldValue(profile, fixtureId, attribute, raw, htpFactor, rank, fixtureValues, owners) {
    const matched = channelsFor(profile, attribute);
    if (!matched.length) return;
    matched.forEach(channel => {
      const key = channel.attribute;
      const value = level(raw) * (scalesWithIntensity(profile, channel) ? htpFactor : 1);
      if (channel.mix === 'htp') fixtureValues[fixtureId][key] = Math.max(fixtureValues[fixtureId][key] || 0, value);
      else {
        const previous = owners[fixtureId][key];
        if (!previous || rank[0] > previous[0] || rank[0] === previous[0] &&
          (rank[1] > previous[1] || rank[1] === previous[1] && rank[2] >= previous[2])) {
          fixtureValues[fixtureId][key] = value; owners[fixtureId][key] = rank;
        }
      }
    });
  }

  function evaluate(show, rawRuntime, rawNowMs) {
    ensureShow(show);
    let runtime = rawRuntime, nowMs = rawNowMs;
    if (typeof rawRuntime === 'number' || rawRuntime == null) { nowMs = rawRuntime; runtime = show.runtime; }
    runtime = runtime && typeof runtime === 'object' ? runtime : show.runtime;
    nowMs = finite(nowMs, Date.now());
    if (!runtime.playbacks) runtime.playbacks = {};
    if (!runtime.effects) runtime.effects = {};
    if (!runtime.sources || typeof runtime.sources !== 'object' || Array.isArray(runtime.sources)) runtime.sources = {};
    const profiles = profileMap(show), fixtureValues = {}, defaults = {}, owners = {}, activeEffects = new Set();
    show.fixtures.forEach(fixture => {
      const values = fixtureDefaults(profiles.get(fixture.profileId));
      defaults[fixture.id] = clone(values); fixtureValues[fixture.id] = values; owners[fixture.id] = {};
    });

    Object.entries(runtime.sources).slice(0, MAX_OBJECTS).forEach(([key, state], sourceIndex) => {
      if (!state || typeof state !== 'object' || state.active === false) return;
      let source;
      try {
        const declaredKey = exactSourceId(state.sourceKey);
        if (declaredKey && declaredKey !== key) return;
        const options = {
          sourceKey:declaredKey,
          instanceId:exactSourceId(state.instanceId),
          preset:state.preset,
          quantity:Object.prototype.hasOwnProperty.call(state, 'quantity') ? state.quantity : null,
          effectStack:state.effectStack
        };
        if (Object.prototype.hasOwnProperty.call(state, 'fixtureIds')) options.fixtureIds = state.fixtureIds;
        source = resolveFixtureSourceInstance(show, state.assetType, state.assetId, options);
        if ((!declaredKey && !options.instanceId && source.baseKey !== key) || source.key !== key) return;
      }
      catch (_) { return; }
      if (!source.fixtureIds.length) return;
      /* A direct source is a low-priority base look. It turns the selected
          hardware on, while normal GSL5 cues/composer clips can still replace
          its LTP attributes and effects/programmer can build on top. */
      const rank = [-101, integer(state.serial, 0, 0, Number.MAX_SAFE_INTEGER), sourceIndex];
      const sourceValues = {};
      source.fixtureIds.forEach(fixtureId => {
        const fixture = show.fixtures.find(item => item.id === fixtureId);
        const profile = fixture && profiles.get(fixture.profileId);
        if (!fixture || !profile) return;
        sourceValues[fixtureId] = fixtureSourceLook(profile, state.preset);
      });
      source.effectStack.forEach(entry => {
        if (!entry || entry.enabled === false || entry.bypassed) return;
        const effect = show.effects.find(item => item.id === entry.effectId);
        if (!effect || !effect.enabled) return;
        applyEffectValues(show, effectWithParameters(effect, entry.parameters), source.fixtureIds,
          finite(state.startedAt, 0), sourceValues, defaults, nowMs);
      });
      source.fixtureIds.forEach(fixtureId => {
        const fixture = show.fixtures.find(item => item.id === fixtureId);
        const profile = fixture && profiles.get(fixture.profileId);
        if (!fixture || !profile) return;
        Object.entries(sourceValues[fixtureId] || {}).forEach(([attribute, raw]) =>
          foldValue(profile, fixtureId, attribute, raw, show.master, rank, fixtureValues, owners));
      });
    });

    show.playbacks.forEach((playback, playbackIndex) => {
      const state = runtimeState(show, runtime, playback);
      if (!state.active || state.level <= 0) return;
      const sequence = show.sequences.find(item => item.id === playback.sequenceId);
      if (!sequence) return;
      const frame = transitionFrame(show, sequence, state, defaults, nowMs);
      frame.effectIds.forEach(id => activeEffects.add(id));
      const rank = [playback.priority, state.serial || 0, playbackIndex];
      Object.entries(frame.values).forEach(([fixtureId, attributes]) => {
        const fixture = show.fixtures.find(item => item.id === fixtureId), profile = fixture && profiles.get(fixture.profileId);
        if (!fixture || !profile) return;
        Object.entries(attributes).forEach(([attribute, raw]) =>
          foldValue(profile, fixtureId, attribute, raw, state.level * show.master, rank, fixtureValues, owners));
      });
    });

    const composerRuntime = runtime.composer && typeof runtime.composer === 'object'
      ? runtime.composer : {activeByLayer:{}, activeColumnId:''};
    const activeByLayer = composerRuntime.activeByLayer && typeof composerRuntime.activeByLayer === 'object'
      ? composerRuntime.activeByLayer : {};
    const activeLayers = show.composer && show.composer.layers || [];
    const hasSolo = activeLayers.some(layer => layer.solo && activeByLayer[layer.id] && activeByLayer[layer.id].active !== false);
    activeLayers.forEach((layer, layerIndex) => {
      const state = activeByLayer[layer.id];
      if (!state || state.active === false || layer.muted || hasSolo && !layer.solo) return;
      const clip = show.composer.clips.find(item => item.id === state.clipId && item.layerId === layer.id);
      if (!clip || !clip.enabled) return;
      const frame = composerTransitionFrame(show, layer, clip, state, defaults, runtime, nowMs);
      const effectStack = Array.isArray(frame.effects) ? frame.effects
        : [...frame.effectIds].map(effectId => ({effectId, enabled:true, bypassed:false, parameters:{}}));
      effectStack.forEach(entry => {
        if (!entry || entry.enabled === false || entry.bypassed) return;
        const effect = show.effects.find(item => item.id === entry.effectId);
        if (!effect || !effect.enabled) return;
        applyEffectValues(show, effectWithParameters(effect, entry.parameters), frame.targetIds,
          state.startedAt, frame.values, defaults, nowMs);
      });
      const rank = [0, state.serial || 0, show.playbacks.length + layerIndex];
      const amount = level(state.level == null ? clip.level : state.level) * layer.level;
      Object.entries(frame.values).forEach(([fixtureId, attributes]) => {
        const fixture = show.fixtures.find(item => item.id === fixtureId), profile = fixture && profiles.get(fixture.profileId);
        if (!fixture || !profile) return;
        Object.entries(attributes).forEach(([attribute, raw]) =>
          foldValue(profile, fixtureId, attribute, raw, amount * show.master, rank, fixtureValues, owners));
      });
    });

    show.effects.forEach(effect => {
      const runtimeEffect = runtime.effects[effect.id];
      /* A runtime state is an explicit operator override. In particular,
         `{active:false}` must be able to stop an authored autostart effect. */
      const active = effect.enabled && (runtimeEffect
        ? runtimeEffect.active !== false : effect.autostart || activeEffects.has(effect.id));
      if (!active) return;
      let targets = effect.fixtureIds.slice();
      if (effect.groupId) targets = resolveTargets(show, effect.groupId, false);
      const origin = runtimeEffect && finite(runtimeEffect.startedAt, NaN);
      const startedAt = Number.isFinite(origin) ? origin : effect.startedAt;
      applyEffectValues(show, effect, targets, startedAt, fixtureValues, defaults, nowMs);
    });

    /* BLIND WITHHOLDS THE PROGRAMMER FROM THE OUTPUT FRAME.
       This guard did not exist. gslBlind toggled show.programmer.blind, and
       the Programmer workspace printed "Blind programmer · not on output",
       but evaluate() applied the block below unconditionally - so every value
       an operator entered in Blind went straight into the universes and onto
       armed DMX. Blind exists precisely so a look can be built during a show
       without appearing on stage; a Blind that does not blind is worse than no
       Blind at all, because the operator is relying on it.

       Guarded HERE and not at the editor, because the two must stay different:
       the Programmer sheet reads show.programmer.values directly (gsl5-ui.js
       :814-834) and must keep showing the blind values it is being used to
       build. evaluate() is the OUTPUT frame - its single caller is the output
       and preview loop at gsl5-ui.js:2926 - so this is the one place where
       withholding them is both correct and complete. */
    if (!show.programmer.blind) Object.entries(show.programmer.values).forEach(([fixtureId, attributes]) => {
      const fixture = show.fixtures.find(item => item.id === fixtureId), profile = fixture && profiles.get(fixture.profileId);
      if (!fixture || !profile) return;
      Object.entries(attributes).forEach(([attribute, value]) => {
        /* Exact attribute key first, then the SEMANTIC. A multicell profile
           names its channels red-1, red-2 ... so an exact-match-only lookup
           dropped a plain `red` on the floor: the programmer stored it, the
           Fixture Sheet displayed it, and not one DMX slot moved. The Source
           path already resolved by semantic (fixtureSourceLook), so the two
           disagreed about what `red` meant on the very same fixture. */
        const matched = channelsFor(profile, attribute);
        if (!matched.length) return;
        const resolved = resolvedToken(show, fixture, attribute, value);
        matched.forEach(channel => {
          /* The Grand Master dims a colour-only fixture through the same
             virtual dimmer, so it is not silently ignored by 20 of the 56
             sample types. */
          const scaled = scalesWithIntensity(profile, channel) ? resolved * show.master : resolved;
          fixtureValues[fixtureId][channel.attribute] = channel.mix === 'htp'
            ? Math.max(fixtureValues[fixtureId][channel.attribute] || 0, scaled) : scaled;
        });
      });
    });

    /* HIGHLIGHT applies the personality's OWN per-channel highlight values to
       the selected fixtures, at output time.

       It is not programmer content: it is never recorded into a cue and never
       written to show.programmer.values - its whole job is to make the current
       selection identifiable on stage. That is also why it is not gated on
       Blind the way the block above is; Blind withholds what the operator is
       building, and Highlight is not part of it.

       A personality that declares no highlight value on any channel cannot be
       highlighted at all. Rather than silently doing nothing, the key reports
       that to the operator before engaging (gsl5-ui.js). */
    if (show.programmer.highlight) show.programmer.selectedFixtureIds.forEach(fixtureId => {
      const fixture = show.fixtures.find(item => item.id === fixtureId);
      const profile = fixture && profiles.get(fixture.profileId);
      if (!fixture || !profile || !fixtureValues[fixtureId]) return;
      profile.channels.forEach(channel => {
        if (channel.highlight == null) return;
        fixtureValues[fixtureId][channel.attribute] = channel.mix === 'htp'
          ? channel.highlight * show.master : channel.highlight;
      });
    });

    const universes = {};
    show.fixtures.forEach(fixture => {
      if (!fixture.enabled) return;
      const profile = profiles.get(fixture.profileId);
      if (!profile || fixture.address + profile.footprint - 1 > 512) return;
      const output = universes[fixture.universe] || (universes[fixture.universe] = Array(512).fill(0));
      profile.channels.forEach(channel => {
        const value = level(fixtureValues[fixture.id][channel.attribute]);
        const coarseIndex = fixture.address - 1 + channel.offset;
        if (channel.bits === 16) {
          const encoded = Math.round(value * 65535), coarse = encoded >> 8, fineValue = encoded & 255;
          output[coarseIndex] = channel.mix === 'htp' ? Math.max(output[coarseIndex], coarse) : coarse;
          const fineIndex = fixture.address - 1 + channel.fineOffset;
          output[fineIndex] = channel.mix === 'htp' ? Math.max(output[fineIndex], fineValue) : fineValue;
        } else {
          const encoded = Math.round(value * 255);
          output[coarseIndex] = channel.mix === 'htp' ? Math.max(output[coarseIndex], encoded) : encoded;
        }
      });
    });
    return {fixtureValues, universes};
  }

  function importChaserSequence(show, chaserProject, fixtureIds) {
    ensureShow(show);
    const project = chaserProject && typeof chaserProject === 'object' ? chaserProject : {};
    const targets = resolveTargets(show, fixtureIds, true);
    if (!targets.length) throw new RangeError('A Chaser import needs at least one target fixture.');
    const sequences = Array.isArray(project.sequences) ? project.sequences : [];
    const source = sequences.find(sequence => sequence.id === project.activeSequenceId) || sequences[0] || project.sequence || project;
    const steps = (Array.isArray(source.steps) ? source.steps : []).slice(0, MAX_OBJECTS);
    if (!steps.length) throw new RangeError('The Chaser project has no steps to import.');
    let sourceIds = (project.map && Array.isArray(project.map.screens) ? project.map.screens : []).flatMap(screen =>
      (Array.isArray(screen.slices) ? screen.slices : []).map(slice => text(slice && slice.id, '')).filter(Boolean));
    if (!sourceIds.length) sourceIds = unique(steps.flatMap(step => Array.isArray(step) ? step : step && (step.sliceIds || step.fixtureIds) || []));
    const mapping = new Map(sourceIds.map((sourceId, index) => [sourceId, targets[index % targets.length]]));
    const cues = steps.map((step, index) => {
      const active = unique(Array.isArray(step) ? step : step && (step.sliceIds || step.fixtureIds) || []);
      const activeTargets = new Set(active.map(id => targets.includes(id) ? id : mapping.get(id)).filter(Boolean));
      const values = {};
      targets.forEach(fixtureId => {
        const fixture = show.fixtures.find(item => item.id === fixtureId), profile = fixture && profileMap(show).get(fixture.profileId);
        const intensity = profile && (profile.channels.find(channel => channel.attribute === 'dimmer') ||
          profile.channels.find(channel => channel.attribute === 'intensity') || profile.channels[0]);
        if (intensity) values[fixtureId] = {[intensity.attribute]:activeTargets.has(fixtureId) ? 1 : 0};
      });
      return storeCue(show, {name:`${text(source.name, project.name || 'Chaser')} Step ${index + 1}`, values, fadeMs:0});
    });
    const playback = project.playback || {};
    return createSequence(show, {
      name:text(source.name, `${project.name || 'Chaser'} Lighting`),
      cueIds:cues.map(cue => cue.id), tracking:false, loop:true,
      bpm:playback.bpm || source.bpm || 120,
      stepsPerBeat:finite(playback.stepsPerBeat, finite(source.stepsPerBeat, 1)),
      direction:String(playback.direction || source.direction || 'forward').toLowerCase()
    });
  }

  function shareableShow(raw) {
    const show = normaliseShow(raw);
    show.programmer = {selectedFixtureIds:[], values:{}, blind:false, highlight:false};
    show.runtime = createRuntime();
    return show;
  }

  function importShowFile(raw) {
    const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.schema !== SCHEMA)
      throw new TypeError('Choose a GSL5 show file (.gsl5.json), not a fixture personality or another project.');
    if (!Array.isArray(source.fixtures) || !Array.isArray(source.profiles))
      throw new TypeError('This GSL5 show is missing its fixture or personality collection.');
    if (finite(source.schemaVersion, 1) > SCHEMA_VERSION)
      throw new RangeError('This show was saved by a newer GSL5 version. Update GSL5 before opening it.');
    const show = shareableShow(source);
    // A file never restores a running stage look, even when its author stored runtime data.
    show.effects.forEach(effect => { Object.defineProperty(show.runtime.effects, effect.id, {
      value:{active:false, startedAt:0}, enumerable:true, configurable:true, writable:true
    }); });
    return show;
  }

  const api = {
    schema:SCHEMA,
    schemaVersion:SCHEMA_VERSION,
    composerSchema:COMPOSER_SCHEMA,
    profiles:PROFILES,
    createShow,
    normaliseProfile,
    normaliseShow,
    channelsFor,
    usesVirtualDimmer,
    channelFunctionAt,
    functionFraction,
    strobeFraction,
    describeChannelValue,
    shutterRestFraction,
    upsertProfile,
    ensureProfile,
    createComposerDocument,
    createComposerLayer,
    createComposerColumn,
    removeComposerColumn,
    removeComposerLayer,
    moveComposerColumn,
    storeComposerClip,
    addComposerClipItem,
    setComposerClipQuantity,
    setComposerClipLevel,
    setComposerClipFade,
    setComposerClipSourcePreset,
    setComposerClipEffectStack,
    resolveComposerClipTargets,
    moveComposerClip,
    removeComposerClip,
    triggerComposerClip,
    triggerComposerColumn,
    releaseComposerClip,
    releaseComposerLayer,
    addFixtures,
    removeFixtures,
    validatePatch,
    selectFixtures,
    setProgrammerValue,
    clearProgrammer,
    storePalette,
    applyPalette,
    storeCue,
    createSequence,
    assignPlayback,
    setPlaybackLevel,
    go,
    back,
    release,
    startFixtureSource,
    stopFixtureSource,
    resolveFixtureSourceInstance,
    addEffect,
    removeEffect,
    startEffect,
    stopEffect,
    sampleEffect:effectWave,
    evaluate,
    importChaserSequence,
    shareableShow,
    importShowFile,
    createRuntime
  };

  global.ShowaveGSL5 = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
