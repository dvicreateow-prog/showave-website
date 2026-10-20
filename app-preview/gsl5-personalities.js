/* SHOWAVE GSL5 local fixture-personality provider
   -------------------------------------------------------------------------
   Original SHOWAVE samples are always available offline. Optional user-chosen
   D4 files remain local to this browser and are never uploaded or harvested
   from a third-party catalogue. Only a profile the operator patches is copied
   into the compact GSL5 show document.
   ------------------------------------------------------------------------- */
(function installGSL5Personalities(global) {
  'use strict';

  if (global.ShowaveGSL5Personalities) return;

  const DB_NAME = 'showave-gsl5-personalities-v1';
  const STORE = 'profiles';
  const SUMMARY_STORE = 'summaries';
  const CHANNEL_LIMIT = 512;
  const MODE_LIMIT = 512;
  const FILE_LIMIT = 50000;
  const FILE_BYTE_LIMIT = 8 * 1024 * 1024;
  const XML_NODE_LIMIT = 120000;
  const SEARCH_LIMIT = 200;
  const AUTHORED_PREFIX = 'showave:authored:';
  const AUTHORED_SOURCE_PREFIX = 'showave:authored-source:';
  const AUTHOR_VERSION = '5.0';
  const OFFICIAL_LIBRARY = 'https://personalities.avolites.com/';
  const sessionOnly = global.OpenLiveSessionPolicy && global.OpenLiveSessionPolicy.sessionOnly === true;
  const sessionLibrary = sessionOnly ? global.OpenLiveSessionPolicy.shared('gsl5-personalities',
    () => ({profiles:new Map(),summaries:new Map()})) : null;
  const profileMemory = sessionLibrary ? sessionLibrary.profiles : new Map();
  const summaryMemory = sessionLibrary ? sessionLibrary.summaries : new Map();
  const listeners = new Set();
  let dbPromise = null;
  let channel = null;

  let sampleProvider = global.ShowaveGSL5Samples || null;
  try {
    if (!sampleProvider && typeof module !== 'undefined' && module.exports && typeof require === 'function')
      sampleProvider = require('./gsl5-samples.js');
  } catch (_) { sampleProvider = null; }
  const SAMPLE_PROFILES = Object.freeze((sampleProvider && Array.isArray(sampleProvider.profiles)
    ? sampleProvider.profiles : []).map(profile => JSON.parse(JSON.stringify(profile))));
  const SAMPLE_CATEGORIES = Object.freeze(sampleProvider && Array.isArray(sampleProvider.categories)
    ? [...sampleProvider.categories] : []);

  const text = (value, fallback) => {
    const result = String(value == null ? '' : value).trim();
    return result || String(fallback == null ? '' : fallback);
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const tag = node => String(node && (node.localName || node.tagName || node.nodeName) || '').replace(/^.*:/, '');
  const children = (node, name) => Array.from(node && node.children || [])
    .filter(child => !name || tag(child).toLowerCase() === String(name).toLowerCase());
  const child = (node, name) => children(node, name)[0] || null;
  const attr = (node, name, fallback) => {
    const value = node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
    return value == null ? fallback : value;
  };
  const slug = value => text(value, 'control').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'control';
  const hash = value => {
    let result = 0x811c9dc5;
    const source = String(value == null ? '' : value);
    for (let index = 0; index < source.length; index++) {
      result ^= source.charCodeAt(index);
      result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result.toString(36).padStart(7, '0');
  };
  const range = value => {
    const match = String(value == null ? '' : value).match(/(-?\d+(?:\.\d+)?)\s*~\s*(-?\d+(?:\.\d+)?)/);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const truthy = value => /^(?:1|true|yes)$/i.test(String(value == null ? '' : value).trim());
  const shortText = (value, fallback, limit) => text(value, fallback).slice(0, Math.max(1, Number(limit) || 96));
  const integer = (value, fallback) => {
    const result = Number(value);
    return Number.isFinite(result) ? Math.round(result) : Number(fallback) || 0;
  };
  const level = (value, fallback) => {
    if (value == null || value === '') return fallback == null ? null : clamp(fallback, 0, 1);
    if (typeof value === 'string' && /%\s*$/.test(value)) return clamp(Number(value.replace('%', '')) / 100, 0, 1);
    return clamp(value, 0, 1);
  };
  const FAMILY_NAMES = new Set(['intensity','position','color','beam','control']);
  const HAZARDOUS_SEMANTICS = new Set(['laser','pyro','co2-output','spark-output','flame-output','safety-enable']);

  function descendants(node, wanted) {
    const output = [], target = String(wanted || '').toLowerCase();
    (function walk(current) {
      children(current).forEach(item => {
        if (!target || tag(item).toLowerCase() === target) output.push(item);
        if (output.length <= XML_NODE_LIMIT) walk(item);
      });
    })(node);
    return output;
  }

  function canonicalAttribute(id, name) {
    const raw = `${id || ''} ${name || ''}`.toLowerCase().replace(/[_-]+/g, ' ');
    const numbered = /(?:^|\s)(\d+)(?:\s|$)/.exec(raw) || /(\d+)$/.exec(String(id || ''));
    let semantic;
    if (/master\s*(?:dimmer|intensity)|\bdimmer\b|\bintensity\b/.test(raw)) semantic = 'dimmer';
    else if (/\bred\b|^red\d*/.test(raw)) semantic = 'red';
    else if (/\bgreen\b|^green\d*/.test(raw)) semantic = 'green';
    else if (/\bblue\b|^blue\d*/.test(raw)) semantic = 'blue';
    else if (/cold\s*white|cool\s*white/.test(raw)) semantic = 'cold-white';
    else if (/warm\s*white/.test(raw)) semantic = 'warm-white';
    else if (/\bwhite\b|^white\d*/.test(raw)) semantic = 'white';
    else if (/\bamber\b|^amber\d*/.test(raw)) semantic = 'amber';
    else if (/ultra\s*violet|\buv\b/.test(raw)) semantic = 'uv';
    else if (/\blime\b/.test(raw)) semantic = 'lime';
    else if (/\bcyan\b/.test(raw)) semantic = 'cyan';
    else if (/\bmagenta\b/.test(raw)) semantic = 'magenta';
    else if (/\byellow\b/.test(raw)) semantic = 'yellow';
    /* CTO / CTB / CTC are colour-temperature correction channels, which is
       what real fixtures call them. ACME's SANDANE names its channel "CTO"
       and it fell through to an uncategorised control. */
    else if (/colour\s*temperature|color\s*temperature|\bcct\b|\bct[obc]\b/.test(raw)) semantic = 'cct';
    /* A channel named simply "Colour" IS the colour wheel; requiring the
       word "wheel" missed every fixture that does not spell it out. Every
       specific emitter is matched above, so this cannot swallow Red or Cyan. */
    else if (/\bcolou?r\b/.test(raw)) semantic = 'color-wheel';
    else if (/\bpan\b/.test(raw)) semantic = 'pan';
    else if (/\btilt\b/.test(raw)) semantic = 'tilt';
    else if (/\bzoom\b/.test(raw)) semantic = 'zoom';
    else if (/\bfocus\b/.test(raw)) semantic = 'focus';
    else if (/\biris\b/.test(raw)) semantic = 'iris';
    else if (/gobo/.test(raw) && /rot|spin|index/.test(raw)) semantic = 'gobo-rotation';
    else if (/gobo/.test(raw)) semantic = 'gobo';
    else if (/prism/.test(raw) && /rot|spin|index/.test(raw)) semantic = 'prism-rotation';
    else if (/prism/.test(raw)) semantic = 'prism';
    else if (/frost/.test(raw)) semantic = 'frost';
    else if (/shutter|strobe/.test(raw)) semantic = 'shutter';
    else semantic = slug(id || name || 'control');
    return {semantic, key:semantic + (numbered ? `-${numbered[1]}` : '')};
  }

  function familyFor(semantic, group) {
    if (['dimmer', 'intensity', 'shutter'].includes(semantic)) return 'intensity';
    if (['pan', 'tilt', 'position-x', 'position-y', 'position-z'].includes(semantic)) return 'position';
    if (['red', 'green', 'blue', 'white', 'cold-white', 'warm-white', 'amber', 'uv', 'lime',
      'cyan', 'magenta', 'yellow', 'cct', 'color-wheel'].includes(semantic)) return 'color';
    const compact = String(group || '').trim().toUpperCase();
    if (compact === 'I') return 'intensity';
    if (compact === 'P') return 'position';
    if (compact === 'C') return 'color';
    if (compact === 'B') return 'beam';
    return 'control';
  }

  function functionRecords(attributeNode) {
    return children(attributeNode, 'Function').slice(0, 256).map(node => {
      const dmx = range(attr(node, 'Dmx', ''));
      const display = range(attr(node, 'Display', ''));
      return {
        id:text(attr(node, 'ID', ''), ''), name:text(attr(node, 'Name', ''), 'Function'),
        dmxStart:dmx ? dmx[0] : 0, dmxEnd:dmx ? dmx[1] : 255,
        displayStart:display ? display[0] : 0, displayEnd:display ? display[1] : 100
      };
    });
  }

  function referenceLevel(reference, functions) {
    const value = String(reference == null ? '' : reference).trim();
    if (!value) return null;
    const parts = value.split(':'), amount = Number(parts[parts.length - 1]);
    if (!Number.isFinite(amount)) return null;
    if (parts.length > 1) return clamp(amount / 100, 0, 1);
    const fn = (functions || []).find(item => item.id === parts[0]);
    if (fn && fn.dmxStart !== fn.dmxEnd) return clamp((amount - fn.dmxStart) / (fn.dmxEnd - fn.dmxStart), 0, 1);
    return clamp(amount > 100 ? amount / 255 : amount / 100, 0, 1);
  }

  function attributeDefinitions(root) {
    const control = child(root, 'Control'), output = new Map();
    children(control, 'Attribute').slice(0, 4096).forEach(node => {
      const id = text(attr(node, 'ID', ''), attr(node, 'Name', 'Control'));
      const name = text(attr(node, 'Name', ''), id);
      const group = text(attr(node, 'Group', ''), '');
      const functions = functionRecords(node), locateNode = child(node, 'Locate');
      const canonical = canonicalAttribute(id, name);
      output.set(id, {
        id, name, group, size:Number(attr(node, 'Size', 1)) === 2 ? 2 : 1,
        semantic:canonical.semantic, suggestedKey:canonical.key,
        family:familyFor(canonical.semantic, group), functions,
        locate:referenceLevel(attr(locateNode, 'Locate', ''), functions),
        powerOn:referenceLevel(attr(locateNode, 'PowerOn', ''), functions),
        highlight:referenceLevel(attr(locateNode, 'Highlight', ''), functions),
        lowlight:referenceLevel(attr(locateNode, 'Lowlight', ''), functions)
      });
    });
    return output;
  }

  function uniqueKey(wanted, used) {
    const base = slug(wanted), seen = used.get(base) || 0;
    used.set(base, seen + 1);
    return seen ? `${base}-${seen + 1}` : base;
  }

  function channelFromInclude(includeNode, definitions, used, cell) {
    const sourceId = text(attr(includeNode, 'ID', ''), 'Control');
    const definition = definitions.get(sourceId) || (() => {
      const canonical = canonicalAttribute(sourceId, sourceId);
      return {id:sourceId, name:sourceId, group:'', size:1, semantic:canonical.semantic,
        suggestedKey:canonical.key, family:familyFor(canonical.semantic, ''), functions:[],
        locate:null, powerOn:null, highlight:null, lowlight:null};
    })();
    const rawOffsets = String(attr(includeNode, 'ChannelOffset', '')).split(',')
      .map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    if (!rawOffsets.length) return {virtual:{sourceAttributeId:sourceId, semantic:definition.semantic,
      family:definition.family, label:definition.name, virtual:true,
      virtualControl:text(attr(includeNode, 'VirtualControl', ''), '')}};
    const offset = Math.round(rawOffsets[0]) - 1;
    if (offset < 0 || offset >= CHANNEL_LIMIT) return {warning:`${sourceId} has an out-of-range channel offset.`};
    const fine = rawOffsets.length > 1 ? Math.round(rawOffsets[1]) - 1 : null;
    const bits = fine != null && fine >= 0 && fine < CHANNEL_LIMIT ? 16 : 8;
    const key = uniqueKey(definition.suggestedKey, used);
    return {channel:{
      attribute:key, semantic:definition.semantic, family:definition.family,
      label:cell ? `${definition.name}: ${cell.name}` : definition.name,
      offset, bits, fineOffset:bits === 16 ? fine : null,
      default:definition.powerOn == null ? 0 : definition.powerOn,
      locate:definition.locate == null ? (definition.powerOn == null ? 0 : definition.powerOn) : definition.locate,
      powerOn:definition.powerOn == null ? 0 : definition.powerOn,
      highlight:definition.highlight, lowlight:definition.lowlight,
      mix:definition.semantic === 'dimmer' || definition.semantic === 'intensity' ? 'htp' : 'ltp',
      virtual:false, virtualControl:text(attr(includeNode, 'VirtualControl', ''), ''),
      sourceAttributeId:sourceId, functions:definition.functions,
      cell:cell ? {id:cell.id, name:cell.name, x:cell.x, y:cell.y} : null
    }};
  }

  function parseDocument(xml, Parser) {
    const source = String(xml == null ? '' : xml);
    if (!source.trim()) throw new TypeError('The selected D4 file is empty.');
    if (source.length > FILE_BYTE_LIMIT) throw new RangeError('A D4 file is limited to 8 MB.');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
      throw new TypeError('D4 files containing DOCTYPE or ENTITY declarations are not accepted.');
    const DOMParserCtor = Parser || global.DOMParser;
    if (typeof DOMParserCtor !== 'function') throw new Error('This browser has no XML parser.');
    const document = new DOMParserCtor().parseFromString(source, 'application/xml');
    const parserErrors = document && typeof document.getElementsByTagName === 'function'
      ? document.getElementsByTagName('parsererror') : [];
    if (!document || !document.documentElement || parserErrors && parserErrors.length)
      throw new TypeError('The selected file is not valid D4 XML.');
    const root = document.documentElement;
    if (tag(root).toLowerCase() !== 'fixture') throw new TypeError('A D4 personality must have a Fixture root element.');
    if (descendants(root).length > XML_NODE_LIMIT) throw new RangeError('The D4 file contains too many XML elements.');
    return {document, root, source};
  }

  function parseD4(xml, metadata, Parser) {
    const parsed = parseDocument(xml, Parser), root = parsed.root;
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const filename = text(meta.filename || meta.name, 'personality.d4');
    const relativePath = text(meta.relativePath || meta.webkitRelativePath, filename);
    const manufacturer = text(attr(root, 'Company', ''), 'Unknown manufacturer');
    const fixtureName = text(attr(root, 'Name', ''), 'Unnamed fixture');
    const fixtureVersion = text(attr(root, 'Version', ''), '');
    const copyrightNode = child(root, 'Copyright');
    const copyright = text(attr(copyrightNode, 'Notice', ''), '');
    const sourceHash = hash(parsed.source);
    const sourceId = `avolites:d4-source:${hash(`${filename.toLowerCase()}\0${manufacturer}\0${fixtureName}`)}`;
    const importedAt = Number(meta.importedAt) || Date.now();
    const definitions = attributeDefinitions(root);
    const modes = children(root, 'Mode').slice(0, MODE_LIMIT);
    const warnings = [];
    if (children(root, 'Mode').length > MODE_LIMIT) warnings.push(`Only the first ${MODE_LIMIT} modes were imported.`);
    const knownTags = new Set(['Fixture','Copyright','History','Manual','AtlaBase','Control','Attribute','Locate',
      'Condition','Else','Function','Mode','Import','Physical','Bulb','Lens','Weight','Size','Focus','Include',
      'Cells','Master','Cell','AttributeLink','Macro','Macros','Set','Palettes','Group','Palette']);
    const unknownElements = [...new Set(descendants(root).map(tag).filter(name => name && !knownTags.has(name)))].slice(0, 64);
    const macroCount = descendants(root, 'Macro').length;
    const paletteCount = descendants(root, 'Palette').length;
    const source = {provider:'Avolites', format:'D4', origin:'d4', filename, relativePath, fixtureVersion, copyright,
      sourceId, digest:sourceHash, importedAt, officialLibrary:OFFICIAL_LIBRARY,
      macroCount, paletteCount, unknownElements};

    const profiles = [];
    modes.forEach((modeNode, modeIndex) => {
      if (truthy(attr(modeNode, 'Hidden', '')) || /^(?:hidden|cell only)$/i.test(text(attr(modeNode, 'Display', ''), ''))) return;
      const modeName = text(attr(modeNode, 'Name', ''), `Mode ${modeIndex + 1}`);
      const declared = Math.round(Number(attr(modeNode, 'Channels', 0)) || 0);
      if (declared > CHANNEL_LIMIT) {
        warnings.push(`${fixtureName} · ${modeName} uses ${declared} channels and exceeds one DMX universe.`);
        return;
      }
      const include = child(modeNode, 'Include'), used = new Map(), channels = [], virtualControls = [];
      children(include, 'Attribute').forEach(includeNode => {
        const converted = channelFromInclude(includeNode, definitions, used, null);
        if (converted.channel) channels.push(converted.channel);
        if (converted.virtual) virtualControls.push(converted.virtual);
        if (converted.warning) warnings.push(`${modeName}: ${converted.warning}`);
      });

      /* Some cell personalities describe physical channels only through a
         linked hidden mode. Expand those links only into currently unused DMX
         offsets so personalities that already provide a flattened Include do
         not get duplicate channels. */
      const occupied = new Set(channels.flatMap(item => [item.offset, item.fineOffset]).filter(value => value != null));
      const cellsNode = child(modeNode, 'Cells');
      children(cellsNode, 'Cell').slice(0, CHANNEL_LIMIT).forEach((cellNode, cellIndex) => {
        const base = Math.max(0, Math.round(Number(attr(cellNode, 'ChannelOffset', 1)) || 1) - 1);
        const linkedName = text(attr(cellNode, 'ModeLink', ''), '');
        const linked = modes.find(item => text(attr(item, 'Name', ''), '') === linkedName);
        const linkedInclude = child(linked, 'Include');
        if (!linkedInclude) return;
        const links = new Map(children(cellNode, 'AttributeLink').map(item => [
          text(attr(item, 'SourceId', ''), ''), text(attr(item, 'TargetId', ''), '')]));
        const cellInfo = {id:text(attr(cellNode, 'ID', ''), `cell-${cellIndex + 1}`),
          name:text(attr(cellNode, 'Name', ''), `Cell ${cellIndex + 1}`),
          x:Number(attr(cellNode, 'X', 0)) || 0, y:Number(attr(cellNode, 'Y', 0)) || 0};
        children(linkedInclude, 'Attribute').forEach(linkedAttribute => {
          const offsets = String(attr(linkedAttribute, 'ChannelOffset', '')).split(',')
            .map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
          if (!offsets.length) return;
          const rebased = offsets.map(value => base + value).join(',');
          const adapter = {children:[], getAttribute(name) {
            if (name === 'ID') return links.get(text(attr(linkedAttribute, 'ID', ''), '')) || attr(linkedAttribute, 'ID', '');
            if (name === 'ChannelOffset') return rebased;
            return attr(linkedAttribute, name, null);
          }};
          const converted = channelFromInclude(adapter, definitions, used, cellInfo);
          if (!converted.channel) return;
          const slots = [converted.channel.offset, converted.channel.fineOffset].filter(value => value != null);
          if (slots.some(slot => occupied.has(slot))) return;
          slots.forEach(slot => occupied.add(slot)); channels.push(converted.channel);
        });
      });

      channels.sort((left, right) => left.offset - right.offset || left.attribute.localeCompare(right.attribute));
      const highest = channels.reduce((maximum, item) => Math.max(maximum, item.offset,
        item.fineOffset == null ? item.offset : item.fineOffset), -1) + 1;
      const footprint = Math.max(1, declared, highest);
      if (!channels.length && !declared) {
        warnings.push(`${fixtureName} · ${modeName} has no physical DMX channels.`);
        return;
      }
      const modeIdentity = text(attr(modeNode, 'Id', ''), text(attr(modeNode, 'ID', ''), String(modeIndex)));
      const identity = `${filename.toLowerCase()}\0${manufacturer}\0${fixtureName}\0${modeName}\0${modeIdentity}`;
      profiles.push({
        id:`avolites:d4:${slug(manufacturer)}:${slug(fixtureName)}:${hash(identity)}`,
        name:fixtureName, manufacturer, mode:modeName, footprint, channels,
        virtualControls, source:Object.assign({}, source, {modeIndex, modeId:modeIdentity})
      });
    });
    if (!profiles.length) throw new RangeError('No GSL5-compatible physical modes were found in this D4 file.');
    return {fixture:{name:fixtureName, manufacturer, version:fixtureVersion}, source, profiles, warnings};
  }

  function openDatabase() {
    if (sessionOnly) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
      if (!global.indexedDB || typeof global.indexedDB.open !== 'function') return resolve(null);
      let request;
      try { request = global.indexedDB.open(DB_NAME, 2); }
      catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const profiles = db.createObjectStore(STORE, {keyPath:'id'});
          profiles.createIndex('sourceId', 'source.sourceId', {unique:false});
          profiles.createIndex('importedAt', 'source.importedAt', {unique:false});
        }
        if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
          const summaries = db.createObjectStore(SUMMARY_STORE, {keyPath:'id'});
          summaries.createIndex('sourceId', 'source.sourceId', {unique:false});
          summaries.createIndex('importedAt', 'source.importedAt', {unique:false});
          if (request.transaction.objectStoreNames.contains(STORE)) {
            const cursor = request.transaction.objectStore(STORE).openCursor();
            cursor.onsuccess = () => {
              const item = cursor.result;
              if (item) { summaries.put(compactSummary(item.value)); item.continue(); }
            };
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function searchParts(record) {
    const source = record && record.source || {};
    return [record && record.id, record && record.manufacturer, record && record.name, record && record.mode,
      record && record.footprint, source.filename, source.relativePath, source.category,
      source.subcategory, source.safety, ...(Array.isArray(source.tags) ? source.tags : [])]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function compactRecord(profile) {
    const record = JSON.parse(JSON.stringify(profile));
    record.searchText = searchParts(record);
    return record;
  }

  function compactSummary(record) {
    return {
      id:record.id, name:record.name, manufacturer:record.manufacturer, mode:record.mode,
      footprint:record.footprint, source:record.source,
      searchText:record.searchText || searchParts(record)
    };
  }

  const sampleRecords = SAMPLE_PROFILES.map(compactRecord);
  const sampleProfilesById = new Map(sampleRecords.map(record => [record.id, record]));
  const sampleSummaries = Object.freeze(sampleRecords.map(compactSummary));

  function publicProfile(record) {
    if (!record) return null;
    const copy = JSON.parse(JSON.stringify(record));
    delete copy.searchText;
    return copy;
  }

  function validateAuthoredProfile(raw, options) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const config = options && typeof options === 'object' ? options : {};
    const errors = [], warnings = [], usedAttributes = new Set(), occupied = new Map(), cellDefinitions = new Map(), cellCoordinates = new Map();
    const requestedManufacturer = text(input.manufacturer, '');
    const manufacturer = shortText(input.manufacturer, 'GSL5 User', 80);
    const name = shortText(input.name, '', 96);
    const mode = shortText(input.mode, '', 96);
    const category = shortText(input.category || input.source && input.source.category, 'User Personalities', 64);
    if (!requestedManufacturer) errors.push('Manufacturer is required.');
    if (!name) errors.push('Fixture name is required.');
    if (!mode) errors.push('Mode name is required.');

    const rawChannels = Array.isArray(input.channels) ? input.channels : [];
    if (!rawChannels.length) errors.push('Add at least one physical DMX channel.');
    if (rawChannels.length > CHANNEL_LIMIT) errors.push(`A personality can contain at most ${CHANNEL_LIMIT} attributes.`);
    const channels = rawChannels.slice(0, CHANNEL_LIMIT).map((entry, index) => {
      const source = entry && typeof entry === 'object' ? entry : {};
      const requestedAttribute = source.attribute || source.semantic || source.label || `control-${index + 1}`;
      const attribute = slug(requestedAttribute);
      const semantic = slug(source.semantic || attribute);
      if (usedAttributes.has(attribute)) errors.push(`Attribute “${attribute}” is used more than once.`);
      usedAttributes.add(attribute);
      const rawOffset = Number(source.offset);
      const offset = integer(source.offset, index);
      if (!Number.isFinite(rawOffset) || offset < 0 || offset >= CHANNEL_LIMIT)
        errors.push(`${shortText(source.label, attribute, 64)} needs a coarse address from 1 to ${CHANNEL_LIMIT}.`);
      const safeOffset = Math.max(0, Math.min(CHANNEL_LIMIT - 1, offset));
      const suppliedBits = Number(source.bits == null ? 8 : source.bits);
      if (suppliedBits !== 8 && suppliedBits !== 16)
        errors.push(`${shortText(source.label, attribute, 64)} resolution must be exactly 8 or 16 bit.`);
      const bits = suppliedBits === 16 ? 16 : 8;
      const rawFine = bits === 16 ? Number(source.fineOffset) : null;
      const fineOffset = bits === 16 ? integer(source.fineOffset, safeOffset + 1) : null;
      if (bits === 16 && (!Number.isFinite(rawFine) || fineOffset < 0 || fineOffset >= CHANNEL_LIMIT))
        errors.push(`${shortText(source.label, attribute, 64)} needs a fine address from 1 to ${CHANNEL_LIMIT}.`);
      if (bits === 16 && fineOffset === safeOffset)
        errors.push(`${shortText(source.label, attribute, 64)} cannot use the same coarse and fine address.`);
      const safeFine = bits === 16 ? Math.max(0, Math.min(CHANNEL_LIMIT - 1, fineOffset)) : null;
      [[safeOffset,'coarse'],[safeFine,'fine']].forEach(([slot,part]) => {
        if (slot == null) return;
        const existing = occupied.get(slot);
        if (existing) errors.push(`DMX ${slot + 1} overlaps ${existing}.`);
        else occupied.set(slot, `${shortText(source.label, attribute, 64)} ${part}`);
      });
      if (bits === 16 && safeFine !== safeOffset + 1)
        warnings.push(`${shortText(source.label, attribute, 64)} uses a non-adjacent fine channel.`);
      const family = FAMILY_NAMES.has(String(source.family || '').toLowerCase())
        ? String(source.family).toLowerCase() : familyFor(semantic, '');
      const mix = String(source.mix || '').toLowerCase() === 'htp' || ['dimmer','intensity'].includes(semantic) ? 'htp' : 'ltp';
      const cellSource = source.cell && typeof source.cell === 'object' ? source.cell : null;
      const cellId = cellSource ? shortText(cellSource.id, '', 64) : '';
      const cell = cellSource && cellId ? {
        id:cellId, name:shortText(cellSource.name, cellId, 64),
        x:integer(cellSource.x, 0), y:integer(cellSource.y, 0)
      } : null;
      if (cell) {
        if (!Number.isFinite(Number(cellSource.x)) || !Number.isFinite(Number(cellSource.y)) || cell.x < 0 || cell.y < 0)
          errors.push(`${shortText(source.label, attribute, 64)} needs non-negative numeric cell coordinates.`);
        const signature=`${cell.name}\0${cell.x}\0${cell.y}`, previous=cellDefinitions.get(cell.id);
        if (previous && previous !== signature) errors.push(`Cell “${cell.id}” has conflicting name or coordinates.`);
        else cellDefinitions.set(cell.id,signature);
        const coordinate=`${cell.x},${cell.y}`, other=cellCoordinates.get(coordinate);
        if (other && other !== cell.id) errors.push(`Cells “${other}” and “${cell.id}” share coordinate ${coordinate}.`);
        else cellCoordinates.set(coordinate,cell.id);
      }
      const maximum = bits === 16 ? 65535 : 255;
      const functions = (Array.isArray(source.functions) ? source.functions : []).slice(0, 256).map((fn, functionIndex) => ({
        id:shortText(fn && fn.id, String(functionIndex + 1), 64),
        name:shortText(fn && fn.name, `Function ${functionIndex + 1}`, 96),
        dmxStart:clamp(integer(fn && fn.dmxStart, 0), 0, maximum),
        dmxEnd:clamp(integer(fn && fn.dmxEnd, maximum), 0, maximum),
        displayStart:Number(fn && fn.displayStart) || 0,
        displayEnd:Number(fn && fn.displayEnd) || 0
      }));
      ['default','locate','powerOn','highlight','lowlight'].forEach(field => {
        if (source[field] == null || source[field] === '') return;
        const amount=typeof source[field]==='string'&&/%\s*$/.test(source[field])?Number(source[field].replace('%',''))/100:Number(source[field]);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1)
          errors.push(`${shortText(source.label, attribute, 64)} ${field} must be from 0 to 100%.`);
      });
      return {
        attribute, semantic, family, label:shortText(source.label, attribute, 96),
        offset:safeOffset, bits, fineOffset:safeFine,
        default:level(source.default, ['pan','tilt'].includes(semantic) ? .5 : 0),
        locate:level(source.locate, ['dimmer','intensity'].includes(semantic) ? 1 : null),
        powerOn:level(source.powerOn, 0), highlight:level(source.highlight, null), lowlight:level(source.lowlight, null),
        mix, functions, cell
      };
    });
    const usedFootprint = channels.reduce((maximum, channel) => Math.max(maximum, channel.offset + 1,
      channel.fineOffset == null ? 0 : channel.fineOffset + 1), 1);
    const rawFootprint = Number(input.footprint);
    const footprint = integer(input.footprint, usedFootprint);
    if (!Number.isFinite(rawFootprint) || footprint < 1 || footprint > CHANNEL_LIMIT)
      errors.push(`Footprint must be from 1 to ${CHANNEL_LIMIT} DMX slots.`);
    const safeFootprint = Math.max(1, Math.min(CHANNEL_LIMIT, footprint));
    if (usedFootprint > safeFootprint)
      errors.push(`Footprint ends at DMX ${safeFootprint}, but an attribute uses DMX ${usedFootprint}.`);
    else if (safeFootprint > usedFootprint)
      warnings.push(`${safeFootprint - usedFootprint} trailing DMX slot${safeFootprint-usedFootprint===1?' is':'s are'} reserved.`);
    if (channels.length && !channels.some(channel => ['dimmer','intensity'].includes(channel.semantic)))
      warnings.push('No master intensity attribute is defined; emitter levels will be direct.');
    const hazardous = channels.some(channel => HAZARDOUS_SEMANTICS.has(channel.semantic));
    if (hazardous) warnings.push('Hazardous control detected. Verify the fixture manual and safety interlocks before output.');

    const existingId = String(input.id || '');
    const authoredId = existingId.startsWith(AUTHORED_PREFIX) ? existingId.slice(0, 180)
      : `${AUTHORED_PREFIX}${slug(manufacturer)}:${slug(name || 'fixture')}:${hash(mode || 'mode')}`;
    const priorSource = input.source && typeof input.source === 'object' ? input.source : {};
    const createdAt = Number(priorSource.createdAt || input.createdAt) || Date.now();
    const updatedAt = Number(config.updatedAt) || Date.now();
    const safety = hazardous ? 'hazardous-manual-verification-required'
      : shortText(input.safety || priorSource.safety, 'verify-fixture-manual', 64);
    const description = shortText(input.description || priorSource.description,
      'Locally authored in the GSL5 Personality Builder. Verify against the fixture manual before arming output.', 280);
    const virtualControls=(Array.isArray(input.virtualControls)?input.virtualControls:[]).slice(0,CHANNEL_LIMIT).map((control,index)=>({
      sourceAttributeId:shortText(control&&control.sourceAttributeId,`virtual-${index+1}`,72),
      semantic:slug(control&&control.semantic||control&&control.sourceAttributeId||`virtual-${index+1}`),
      family:FAMILY_NAMES.has(String(control&&control.family||'').toLowerCase())?String(control.family).toLowerCase():'control',
      label:shortText(control&&control.label,`Virtual ${index+1}`,96),virtual:true,
      virtualControl:shortText(control&&control.virtualControl,'',96)
    }));
    const profile = {
      id:authoredId, name, manufacturer, mode, footprint:safeFootprint, channels, virtualControls,
      source:{
        provider:'SHOWAVE', format:'GSL5 Authored', origin:'authored', filename:'Local Personality Builder', relativePath:'',
        fixtureVersion:AUTHOR_VERSION, copyright:'Original local operator-authored personality',
        sourceId:`${AUTHORED_SOURCE_PREFIX}${authoredId.slice(AUTHORED_PREFIX.length)}`,
        digest:`gsl5-authored-${hash(JSON.stringify({manufacturer,name,mode,footprint:safeFootprint,channels}))}`,
        importedAt:updatedAt, createdAt, updatedAt, revision:(Number(priorSource.revision)||0)+(config.updatedAt?1:0), officialLibrary:'', modeIndex:0, modeId:slug(mode || 'mode'),
        macroCount:0, paletteCount:0, unknownElements:[], sample:false, authored:true,
        category, subcategory:'Local authoring', tags:[category,manufacturer,name,mode,'personality builder'],
        safety, description
      }
    };
    return {valid:errors.length === 0, errors:[...new Set(errors)], warnings:[...new Set(warnings)], profile};
  }

  async function putProfiles(profiles, replaceSourceId) {
    const records = profiles.map(compactRecord);
    const summaries = records.map(compactSummary);
    const sourceKey = text(replaceSourceId, '');
    const updateMemory = () => {
      if (sourceKey) {
        [...profileMemory].forEach(([id,record]) => { if (record.source && record.source.sourceId === sourceKey) profileMemory.delete(id); });
        [...summaryMemory].forEach(([id,record]) => { if (record.source && record.source.sourceId === sourceKey) summaryMemory.delete(id); });
      }
      records.forEach(record => profileMemory.set(record.id, record));
      summaries.forEach(record => summaryMemory.set(record.id, record));
    };
    const db = await openDatabase();
    if (!db) { updateMemory(); return records.length; }
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE,SUMMARY_STORE], 'readwrite');
      const store = transaction.objectStore(STORE), summaryStore = transaction.objectStore(SUMMARY_STORE);
      const insert = () => {
        records.forEach(record => store.put(record)); summaries.forEach(record => summaryStore.put(record));
      };
      if (sourceKey) {
        let pending = 2;
        const finished = () => { pending--; if (!pending) insert(); };
        [[store,'sourceId'],[summaryStore,'sourceId']].forEach(([target,indexName]) => {
          const request = target.index(indexName).openCursor(sourceKey);
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) { cursor.delete(); cursor.continue(); } else finished();
          };
          request.onerror = () => transaction.abort();
        });
      } else insert();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the personality library.'));
      transaction.onabort = () => reject(transaction.error || new Error('Personality import was cancelled.'));
    });
    updateMemory();
    return records.length;
  }

  function emit(detail) {
    const event = Object.assign({type:'changed', at:Date.now()}, detail || {});
    listeners.forEach(listener => { try { listener(event); } catch (_) {} });
    try { if (channel) channel.postMessage(sessionOnly
      ? Object.assign({}, event, {sessionProfiles:[...profileMemory.values()]}) : event); } catch (_) {}
  }

  async function allSummaries() {
    const db = await openDatabase();
    if (!db) return [...summaryMemory.values()];
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction(SUMMARY_STORE, 'readonly').objectStore(SUMMARY_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Could not read the personality library.'));
    });
    records.forEach(record => summaryMemory.set(record.id, record));
    return records;
  }

  /* ==========================================================================
     AVOLITES R20 PERSONALITIES
     --------------------------------------------------------------------------
     R20 is what Titan and Pearl actually read, and it is what manufacturers
     ship on their own download pages - ACME publishes a per-fixture zip whose
     "Avolites" build is a set of .R20 files, one per DMX mode. parseD4 cannot
     read them: D4 is XML, R20 is a plain-text, line-oriented format whose own
     comments are its specification.

     WHAT R20 CARRIES THAT D4 DOES NOT:
       MIRROR <kind> <pan> <tilt>  - real pan and tilt travel IN DEGREES, and
         whether the fixture is a moving mirror or a moving head. That is
         exactly the quantity the preview currently has to mark "travel not in
         profile", so an imported R20 moving head can be drawn truthfully.
       Per-channel HTP/LTP, ON (locate), Highlight and Lowlight levels.
       RANGE tables with real function names - Closed / Open / Strobe / colour
         wheel slots - with their exact DMX spans.

     TWO TRAPS, both found in the ACME SANDANE files:
       1. THE ATTRIBUTE-TYPE LETTER IS NOT RELIABLE. In the 4 DMX mode Red is
          "T"; in the 8 and 10 DMX modes of the SAME fixture Red is "B" and "T"
          is Dimmer. The quoted attribute NAME is the trustworthy field, so the
          name is what drives the semantic and the letter is only a fallback
          hint for the family.
       2. Names carry trailing spaces ("Red ", "Green "). Trim before matching.
     ========================================================================== */
  const R20_GROUP_BY_LETTER = Object.freeze({
    A:'C', B:'C', C:'C', D:'C', N:'C',      /* colour wheels and colour mix */
    E:'P', F:'P',                            /* pan, tilt */
    G:'B', I:'B', J:'B', K:'B', L:'B', M:'B', P:'B', Q:'B', R:'B', S:'B',
    H:'I', O:'I'                             /* dimmer, shutter */
  });

  /* The type column is ONE letter: H is HTP, L and I are LTP, S and s mark the
     coarse byte of a 16-bit pair. This class was written `[HLIS s]` - with a
     literal space inside it - so a row whose type letter was simply MISSING
     matched anyway and imported as an 8-bit LTP channel with no warning at
     all. A real HTP dimmer silently became LTP. Vendors also ship letters this
     list never enumerated, and one unlisted letter threw the whole file away.
     Accept any single letter, then classify it and say so when it is a letter
     this parser does not know. */
  const R20_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Za-z])\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+"([^"]*)"\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/;
  const R20_MIX_BY_TYPE = Object.freeze({H:'htp', L:'ltp', I:'ltp', S:'ltp', s:'ltp'});
  const R20_RANGE_ROW = /^\s*(\d+)\s+(\d+)\s+"([^"]*)"\s*(.*)$/;

  function r20Sections(source) {
    /* Comment lines start with ';'. Blocks are NAME ... / DMX ... END /
       RANGE n ... REND, and everything else is ignored rather than guessed at. */
    const lines = String(source || '').split(/\r?\n/);
    const out = {head:[], dmx:[], ranges:new Map()};
    let mode = '', rangeIndex = 0;
    for (const raw of lines) {
      const line = raw.replace(/;.*$/, '').trimEnd();
      if (!line.trim()) continue;
      if (/^DMX\s*$/.test(line)) { mode = 'dmx'; continue; }
      if (/^END\s*$/.test(line)) { mode = ''; continue; }
      const rangeStart = /^RANGE\s+(\d+)/.exec(line);
      if (rangeStart) { mode = 'range'; rangeIndex = Number(rangeStart[1]); out.ranges.set(rangeIndex, []); continue; }
      if (/^REND\s*$/.test(line)) { mode = ''; continue; }
      if (mode === 'dmx') out.dmx.push(line);
      else if (mode === 'range') out.ranges.get(rangeIndex).push(line);
      else out.head.push(line);
    }
    return out;
  }

  function r20Functions(rows) {
    const functions = [];
    (rows || []).slice(0, 256).forEach(line => {
      const match = R20_RANGE_ROW.exec(line);
      if (!match) return;
      const dmxStart = Number(match[1]), dmxEnd = Number(match[2]);
      const label = text(match[3], '').trim(), formula = text(match[4], '').trim();
      if (!Number.isFinite(dmxStart) || !Number.isFinite(dmxEnd) || dmxEnd < dmxStart) return;
      /* A row whose text is a printf template is a SWEPT range; a plain label
         is a discrete state. R20 states the sweep as a percentage of the span
         and never in Hz, so `unit` records that rather than letting a consumer
         read 0..100 as a strobe rate. */
      const swept = /%/.test(label) || !!formula;
      const name = label.replace(/%[-+ #0-9.]*[a-z%]/gi, '').replace(/[\s.,:%-]+/g, ' ').trim();
      /* A row whose entire text is a printf percentage template is not a
         function - it is R20's way of saying "show this channel as a
         percentage". Emitting it produced a range literally named ".". */
      if (!name) return;
      functions.push(swept
        ? {id:`r20-${dmxStart}-${dmxEnd}`, name, dmxStart, dmxEnd, displayStart:0, displayEnd:100, unit:'percent'}
        : {id:`r20-${dmxStart}-${dmxEnd}`, name, dmxStart, dmxEnd, displayStart:0, displayEnd:0, unit:'state'});
    });
    return functions;
  }

  function parseR20(source, metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const filename = text(meta.filename || meta.name, 'personality.R20');
    const relativePath = text(meta.relativePath || meta.webkitRelativePath, filename);
    const importedAt = Number(meta.importedAt) || Date.now();
    const raw = String(source == null ? '' : source);
    const parts = r20Sections(raw);
    const warnings = [];
    const head = parts.head.join('\n');

    if (!parts.dmx.length) throw new TypeError(`${filename} has no DMX channel block; it is not an R20 personality.`);

    const nameLine = /^NAME\s+"([^"]*)"\s+"([^"]*)"/m.exec(head);
    const manufacturer = nameLine ? text(nameLine[1], '').trim() || 'Unknown manufacturer' : 'Unknown manufacturer';
    const titled = nameLine ? text(nameLine[2], '').trim() : filename.replace(/\.r20$/i, '');
    /* "SANDANE(PAR 54 IP) ,10 DMX" - the mode follows the last comma, and the
       spacing around it is inconsistent between files from the same vendor. */
    const comma = titled.lastIndexOf(',');
    const fixtureName = (comma > 0 ? titled.slice(0, comma) : titled).trim() || 'Unnamed fixture';
    const modeName = (comma > 0 ? titled.slice(comma + 1) : '').trim() || 'Default mode';

    const typeLine = /^TYPE\s+(\d+)\s+(\d+)/m.exec(head);
    const declared = typeLine ? Number(typeLine[2]) : 0;

    /* MIRROR is the reason this format is worth parsing: real travel, in
       degrees, for a fixture that moves. Zeroes mean a static fixture. */
    const mirrorLine = /^MIRROR\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(head);
    const movementCode = mirrorLine ? Number(mirrorLine[1]) : 0;
    const panDegrees = mirrorLine ? Number(mirrorLine[2]) : 0;
    const tiltDegrees = mirrorLine ? Number(mirrorLine[3]) : 0;
    const physical = movementCode || panDegrees || tiltDegrees ? Object.freeze({
      movement: movementCode === 1 ? 'mirror' : movementCode === 2 ? 'head' : '',
      panDegrees: panDegrees || null,
      tiltDegrees: tiltDegrees || null
    }) : null;

    const channels = [], used = new Set();
    parts.dmx.forEach(line => {
      const match = R20_ROW.exec(line);
      if (!match) { warnings.push(`${filename}: unreadable DMX row skipped - ${line.trim().slice(0, 60)}`); return; }
      const type = match[3];
      const dmxOffset = Number(match[4]);
      const letter = text(match[7], '').trim().toUpperCase();
      const label = text(match[9], '').trim();
      const onValue = Number(match[10]), highlight = Number(match[11]), lowlight = Number(match[12]);
      if (!Number.isFinite(dmxOffset) || dmxOffset < 1 || dmxOffset > CHANNEL_LIMIT) {
        warnings.push(`${filename}: channel "${label}" has DMX offset ${match[4]}, outside 1-${CHANNEL_LIMIT}.`);
        return;
      }
      const offset = dmxOffset - 1;
      const bits = type === 'S' || type === 's' ? 16 : 8;
      /* A 16-bit channel owns TWO slots. `used` tracked only the coarse one,
         so the next channel could be patched straight on top of the fine byte
         and the import reported no warning whatsoever - two attributes writing
         one slot, the later write winning silently. Reserve both. */
      const fineOffset = bits === 16 ? offset + 1 : null;
      if (used.has(offset)) {
        warnings.push(`${filename}: DMX offset ${dmxOffset} is declared twice; the later "${label}" was skipped.`);
        return;
      }
      if (fineOffset != null && fineOffset > CHANNEL_LIMIT - 1) {
        warnings.push(`${filename}: 16-bit channel "${label}" at DMX ${dmxOffset} needs a fine byte at ` +
          `${dmxOffset + 1}, past the ${CHANNEL_LIMIT}-slot universe; skipped.`);
        return;
      }
      if (fineOffset != null && used.has(fineOffset)) {
        warnings.push(`${filename}: 16-bit channel "${label}" needs DMX ${dmxOffset + 1} for its fine byte, ` +
          `but that slot is already declared; skipped.`);
        return;
      }
      used.add(offset);
      if (fineOffset != null) used.add(fineOffset);
      const mix = R20_MIX_BY_TYPE[type];
      if (!mix) warnings.push(`${filename}: channel "${label}" declares DMX type "${type}", which this parser ` +
        `does not know; imported as an 8-bit LTP channel.`);
      const canonical = canonicalAttribute(label, label);
      const key = canonical.key || slug(label);
      const rangeRows = parts.ranges.get(dmxOffset);
      channels.push({
        attribute: channels.some(c => c.attribute === key) ? `${key}-${dmxOffset}` : key,
        semantic: canonical.semantic,
        family: familyFor(canonical.semantic, R20_GROUP_BY_LETTER[letter] || ''),
        label: label || canonical.semantic,
        offset,
        bits,
        fineOffset,
        default: 0,
        /* R20's ON column is the value Locate puts on this channel. */
        locate: Number.isFinite(onValue) ? clamp(onValue, 0, 255) / 255 : null,
        powerOn: 0,
        highlight: Number.isFinite(highlight) ? clamp(highlight, 0, 255) / 255 : null,
        lowlight: Number.isFinite(lowlight) ? clamp(lowlight, 0, 255) / 255 : null,
        /* H is HTP; L, I, S and s are all LTP variants. An unrecognised letter
           was warned about above and is treated as LTP. */
        mix: mix || 'ltp',
        functions: r20Functions(rangeRows),
        cell: null
      });
    });

    if (!channels.length) throw new TypeError(`${filename} declared no readable DMX channels.`);

    const footprint = Math.max(1, ...channels.map(c => Math.max(c.offset, c.fineOffset == null ? c.offset : c.fineOffset) + 1));
    if (declared && declared !== footprint)
      warnings.push(`${filename}: TYPE declares ${declared} channels but the DMX block spans ${footprint}.`);

    /* A coarse/fine pair written as two 8-bit channels is left EXACTLY as the
       file declares it. R20 has explicit 16-bit types (S and s) and this vendor
       did not use them, so merging would be this parser inventing a footprint
       the personality does not state. It is reported instead. */
    channels.forEach(channel => {
      if (!/\b(low|fine|lsb)\b/i.test(channel.label)) return;
      warnings.push(`${filename}: "${channel.label}" looks like the fine byte of a 16-bit pair, ` +
        `but the file declares it as an 8-bit channel; imported as declared.`);
    });

    const sourceHash = hash(raw);
    const sourceId = `avolites:r20-source:${hash(`${filename.toLowerCase()}\0${manufacturer}\0${fixtureName}\0${modeName}`)}`;
    const copyrightLine = /^;\s*(copyright[^\n]*)$/im.exec(raw);

    const source_ = {
      provider:'Avolites', format:'R20', origin:'r20', filename, relativePath,
      fixtureVersion:'', copyright: copyrightLine ? text(copyrightLine[1], '').trim() : '',
      sourceId, digest:sourceHash, importedAt, officialLibrary:OFFICIAL_LIBRARY,
      macroCount:0, paletteCount:0, unknownElements:[],
      physical, declaredChannels: declared || null
    };

    const profile = {
      id:`avolites:r20:${hash(`${sourceId}\0${modeName}`)}`,
      name:fixtureName,
      manufacturer,
      mode:modeName,
      footprint,
      channels,
      virtualControls:[],
      source:source_
    };

    return {profiles:[profile], source:source_, warnings};
  }

  async function importFiles(fileList, options) {
    const files = Array.from(fileList || []).filter(file => /\.(?:d4|r20)$/i.test(String(file && file.name || '')));
    if (!files.length) throw new TypeError('Choose one or more Avolites .d4 or .R20 personality files.');
    if (files.length > FILE_LIMIT) throw new RangeError(`At most ${FILE_LIMIT} D4 files may be imported at once.`);
    const config = options && typeof options === 'object' ? options : {}, errors = [], warnings = [];
    let profiles = 0, completed = 0;
    for (const file of files) {
      const filename = text(file && file.name, 'personality.d4');
      try {
        if (Number(file && file.size) > FILE_BYTE_LIMIT) throw new RangeError(`${filename} exceeds the 8 MB D4 limit.`);
        const body = await file.text();
        const meta = {filename, relativePath:text(file.webkitRelativePath, filename), importedAt:Date.now()};
        /* Two Avolites formats, chosen by extension rather than by sniffing:
           .d4 is XML, .R20 is the plain-text Titan/Pearl personality. */
        const parsed = /\.r20$/i.test(filename)
          ? parseR20(body, meta)
          : parseD4(body, meta, config.DOMParser);
        await putProfiles(parsed.profiles, parsed.source.sourceId); profiles += parsed.profiles.length;
        parsed.warnings.forEach(message => warnings.push(`${filename}: ${message}`));
      } catch (error) { errors.push({filename, error:String(error && error.message || error)}); }
      completed++;
      if (typeof config.onProgress === 'function') config.onProgress({completed, total:files.length, profiles, errors:errors.length});
      if (completed % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const result = {files:files.length, completed, profiles, errors, warnings};
    if (profiles) emit({type:'import', profiles, files:files.length});
    return result;
  }

  async function search(query, options) {
    const config = options && typeof options === 'object' ? options : {};
    const limit = Math.round(clamp(config.limit == null ? 60 : config.limit, 1, SEARCH_LIMIT));
    const tokens = String(query == null ? '' : query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const imported = await allSummaries();
    const merged = new Map(sampleSummaries.map(record => [record.id, record]));
    imported.forEach(record => merged.set(record.id, record));
    const category = text(config.category, '').toLowerCase();
    const kind = text(config.kind, '').toLowerCase();
    const records = [...merged.values()].filter(record => {
      const isSample = !!(record.source && record.source.sample);
      if (kind === 'samples' && !isSample || kind === 'custom' && isSample) return false;
      if (category && String(record.source && record.source.category || '').toLowerCase() !== category) return false;
      return tokens.every(token => String(record.searchText || '').includes(token));
    });
    records.sort((left, right) => {
      const leftSample = !!(left.source && left.source.sample), rightSample = !!(right.source && right.source.sample);
      if (leftSample !== rightSample) return leftSample ? -1 : 1;
      if (leftSample && rightSample) return Number(left.source && left.source.modeIndex || 0) - Number(right.source && right.source.modeIndex || 0);
      if (!leftSample && !tokens.length) return Number(right.source && right.source.importedAt || 0) - Number(left.source && left.source.importedAt || 0);
      return `${left.source && left.source.category || ''}\0${left.name}\0${left.mode}`
        .localeCompare(`${right.source && right.source.category || ''}\0${right.name}\0${right.mode}`);
    });
    return records.slice(0, limit).map(record => ({
      id:record.id, name:record.name, manufacturer:record.manufacturer, mode:record.mode,
      footprint:record.footprint, source:record.source,
      category:record.source && record.source.category || '', sample:!!(record.source && record.source.sample),
      authored:!!(record.source && record.source.authored),
      safety:record.source && record.source.safety || ''
    }));
  }

  async function getProfile(id) {
    const key = text(id, '');
    if (!key) return null;
    if (sampleProfilesById.has(key)) return publicProfile(sampleProfilesById.get(key));
    if (profileMemory.has(key)) return publicProfile(profileMemory.get(key));
    const db = await openDatabase();
    if (!db) return null;
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not load that personality mode.'));
    });
    if (record) profileMemory.set(record.id, record);
    return publicProfile(record);
  }

  async function saveAuthoredProfile(raw) {
    const input = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {};
    const requestedId = String(input.id || '').startsWith(AUTHORED_PREFIX) ? String(input.id) : '';
    let existing = requestedId ? await getProfile(requestedId) : null;
    if (existing && !(existing.source && existing.source.authored))
      throw new TypeError('Only a locally authored personality can be replaced by the Personality Builder.');
    if (existing && Number(input.source && input.source.revision || 0) !== Number(existing.source && existing.source.revision || 0))
      throw new Error('This personality changed in another GSL5 window. Reopen it before saving your edits.');
    /* Validation returns a deterministic preview ID, but creation allocates a
       permanent unpredictable identity only once. Caller-chosen absent IDs are
       never inserted directly. */
    if (requestedId && !existing) input.id = '';
    if (!String(input.id || '').startsWith(AUTHORED_PREFIX)) {
      const seed = `${Date.now()}\0${Math.random()}\0${input.manufacturer || ''}\0${input.name || ''}\0${input.mode || ''}`;
      const uuid = global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID()
        : `${hash(seed)}-${hash(seed.split('').reverse().join(''))}-${Date.now().toString(36)}`;
      input.id = `${AUTHORED_PREFIX}${uuid}`;
    }
    if (existing && existing.source) input.source = Object.assign({}, input.source || {}, {
      sourceId:existing.source.sourceId, createdAt:existing.source.createdAt || existing.source.importedAt || Date.now(),
      revision:Number(existing.source.revision)||0
    });
    else input.source = Object.assign({}, input.source || {}, {createdAt:Date.now(),revision:0});
    const validation = validateAuthoredProfile(input, {updatedAt:Date.now()});
    if (!validation.valid) {
      const error = new TypeError(validation.errors[0] || 'The personality is not valid.');
      error.validation = validation; throw error;
    }
    await putProfiles([validation.profile], validation.profile.source.sourceId);
    emit({type:'authored-save', id:validation.profile.id, profileId:validation.profile.id});
    return publicProfile(compactRecord(validation.profile));
  }

  async function deleteIds(ids) {
    const keys = [...new Set(Array.from(ids || []).map(value => text(value, '')).filter(Boolean))];
    if (!keys.length) return 0;
    const db = await openDatabase();
    if (db) await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE,SUMMARY_STORE], 'readwrite');
      const profiles = transaction.objectStore(STORE), summaries = transaction.objectStore(SUMMARY_STORE);
      keys.forEach(id => { profiles.delete(id); summaries.delete(id); });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not update the personality library.'));
      transaction.onabort = () => reject(transaction.error || new Error('Personality library update was cancelled.'));
    });
    keys.forEach(id => { profileMemory.delete(id); summaryMemory.delete(id); });
    return keys.length;
  }

  async function deleteAuthoredProfile(id) {
    const profile = await getProfile(id);
    if (!profile || !(profile.source && profile.source.authored)) return false;
    await deleteIds([profile.id]);
    emit({type:'authored-delete', id:profile.id, profileId:profile.id});
    return true;
  }

  async function exportAuthoredProfiles(ids) {
    const wanted=ids==null?null:new Set(Array.from(Array.isArray(ids)?ids:[ids]).map(value=>text(value,'')));
    const summaries=await allSummaries(), authored=summaries.filter(record=>record.source&&record.source.authored&&(!wanted||wanted.has(record.id)));
    const profiles=(await Promise.all(authored.map(record=>getProfile(record.id)))).filter(Boolean)
      .sort((left,right)=>left.id.localeCompare(right.id));
    return {schema:'showave.gsl5.profile-library/1',version:1,exportedAt:Date.now(),profiles};
  }

  async function clearImports() {
    const records = await allSummaries();
    const ids = records.filter(record => !(record.source && record.source.authored)).map(record => record.id);
    await deleteIds(ids); emit({type:'clear-imports', profiles:ids.length}); return ids.length;
  }

  async function stats() {
    const records = await allSummaries();
    const authored = records.filter(record => !!(record.source && record.source.authored));
    const imported = records.filter(record => !(record.source && record.source.authored));
    const sources = new Set(imported.map(record => record.source && record.source.sourceId).filter(Boolean));
    return {profiles:sampleSummaries.length + records.length, samples:sampleSummaries.length,
      authored:authored.length, imported:imported.length, sources:sources.size, categories:SAMPLE_CATEGORIES.length,
      storage:await openDatabase() ? 'IndexedDB' : 'memory'};
  }

  async function clear() {
    await clearImports(); return true;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener); return () => listeners.delete(listener);
  }

  try {
    if (global.document && typeof global.BroadcastChannel === 'function') {
      channel = new global.BroadcastChannel('showave-gsl5-personalities-v1');
      channel.onmessage = event => {
        const detail=event.data||{type:'changed'};
        if (sessionOnly) {
          if (detail.type === 'session-hello') {
            channel.postMessage({type:'session-snapshot',sessionProfiles:[...profileMemory.values()]});
            return;
          }
          if (!Array.isArray(detail.sessionProfiles)) return;
          profileMemory.clear(); summaryMemory.clear();
          detail.sessionProfiles.forEach(record => {
            if (!record || typeof record.id !== 'string') return;
            profileMemory.set(record.id,record); summaryMemory.set(record.id,compactSummary(record));
          });
          listeners.forEach(listener => { try { listener(detail); } catch (_) {} });
          return;
        }
        /* Another GSL5/SHOWAVE window may have replaced or deleted a record.
           IndexedDB is authoritative across windows; invalidate local caches
           before listeners repaint or preview the changed mode. */
        if(detail.id||detail.profileId){profileMemory.delete(detail.id||detail.profileId);summaryMemory.delete(detail.id||detail.profileId);}
        else {profileMemory.clear();summaryMemory.clear();}
        listeners.forEach(listener => { try { listener(detail); } catch (_) {} });
      };
      if (sessionOnly) channel.postMessage({type:'session-hello'});
    }
  } catch (_) { channel = null; }

  const api = Object.freeze({
    database:DB_NAME, officialLibrary:OFFICIAL_LIBRARY, limits:Object.freeze({
      channels:CHANNEL_LIMIT, modes:MODE_LIMIT, files:FILE_LIMIT, fileBytes:FILE_BYTE_LIMIT, search:SEARCH_LIMIT
    }), sampleCount:sampleSummaries.length, sampleCategories:SAMPLE_CATEGORIES,
    parseD4, parseR20, importFiles, search, getProfile, stats, clear, clearImports,
    validateAuthoredProfile, saveAuthoredProfile, deleteAuthoredProfile, exportAuthoredProfiles, subscribe
  });
  global.ShowaveGSL5Personalities = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
