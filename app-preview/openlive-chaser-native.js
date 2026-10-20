/* Chaser 3.1.3 interchange. The native project schema is verified against the
 * user's installed application and its NewChaserDocument.xml. Advanced Output
 * reads the Arena ScreenSetup dialect; it never writes Arena preferences. */
(function installChaserNative(global) {
  'use strict';
  if (global.OpenLiveChaserNative) return;
  const MAX_BYTES = 8 * 1024 * 1024, MAX_SLICES = 4096, MAX_STEPS = 1024;
  const C = global.OpenLiveChaser;
  if (!C) throw new Error('Load the Chaser project module before native interchange.');
  const children = (node, tag) => Array.from(node && node.childNodes || [])
    .filter(item => item.nodeType === 1 && (!tag || item.tagName === tag));
  const child = (node, tag) => children(node, tag)[0] || null;
  const attr = (node, name, fallback) => node && node.hasAttribute(name)
    ? node.getAttribute(name) : fallback;
  const clone = value => JSON.parse(JSON.stringify(value));
  const nameOf = file => String(file || 'Native Chaser').split(/[\\/]/).pop()
    .replace(/\.xml$/i, '') || 'Native Chaser';

  function documentFrom(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('The XML file is empty.');
    const bytes = global.TextEncoder ? new global.TextEncoder().encode(text).byteLength : text.length * 3;
    if (bytes > MAX_BYTES) throw new Error('The XML file exceeds the 8 MiB project limit.');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML document types and external entities are unsupported.');
    if (typeof global.DOMParser !== 'function') throw new Error('This browser cannot read XML projects.');
    const errors = [];
    const parser = new global.DOMParser({onError:(_level, message) => errors.push(message)});
    let doc;
    try { doc = parser.parseFromString(text, 'application/xml'); }
    catch (_) { throw new Error('The XML file is malformed.'); }
    if (errors.length || !doc || !doc.documentElement ||
        doc.getElementsByTagName('parsererror').length) throw new Error('The XML file is malformed.');
    return doc;
  }

  function integer(value, fallback, min, max, label) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new Error(`${label || 'XML index'} is outside the supported range.`);
    return number;
  }

  function pointsOf(node, tags) {
    return children(node).filter(item => (tags || ['point', 'v']).includes(item.tagName)).map(item => {
      const x = Number(attr(item, 'x', NaN)), y = Number(attr(item, 'y', NaN));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('A slice contains invalid point coordinates.');
      return {x,y};
    });
  }

  function validGeometry(points, label) {
    if (points.length < 3 || points.length > 128) throw new Error(`${label || 'Slice'} has unsupported geometry.`);
    return {vertices:points};
  }

  function nodeId(node, fallback, used) {
    const id = String(attr(node, 'uniqueId', fallback));
    if (!id || id.length > 256 || used.has(id)) throw new Error('The XML file contains missing or duplicate slice identities.');
    used.add(id); return id;
  }

  function nativeMap(root) {
    const screensNode = child(root, 'screens');
    if (!screensNode) throw new Error('This Chaser project has no screen map.');
    const width = integer(attr(screensNode, 'x'), 1920, 1, 32768, 'Map width');
    const height = integer(attr(screensNode, 'y'), 1080, 1, 32768, 'Map height');
    const sliceIds = new Set(), screenIds = new Set(), visible = [], warnings = [];
    const screens = children(screensNode, 'screen').map((node,index) => {
      const id = nodeId(node, `native-screen:${index}`, screenIds);
      const screenVisible = attr(node, 'enabled', '1') !== '0';
      const slices = children(node, 'slice').map((sliceNode,sliceIndex) => {
        if (sliceIds.size >= MAX_SLICES) throw new Error('The XML map exceeds 4096 video slices.');
        const sliceId = nodeId(sliceNode, `${id}:slice:${sliceIndex}`, sliceIds);
        const rectPoints = pointsOf(child(sliceNode, 'inputRect'));
        const mask = pointsOf(child(sliceNode, 'mask'));
        // A preserved native mask is the visible polygon. Its original rectangle
        // and any extra mask fields remain in the reference XML for roundtrip.
        const input = validGeometry(mask.length >= 3 ? mask : rectPoints, 'Native slice');
        if (mask.length && mask.length < 3) warnings.push(`The mask on ${attr(sliceNode,'name',sliceId)} has fewer than three points.`);
        if (screenVisible && attr(sliceNode, 'enabled', '1') !== '0') visible.push(sliceId);
        return {id:sliceId,name:attr(sliceNode,'name',`Slice ${sliceIndex + 1}`),kind:'slice',input,output:clone(input)};
      });
      return {id,name:attr(node,'name',`Screen ${index + 1}`),raster:{width,height},slices};
    });
    if (!screens.length || !sliceIds.size) throw new Error('This Chaser project contains no supported video slices.');
    return {map:C.normaliseMap({composition:{width,height},screens}),visible,warnings};
  }

  function parseDocument(text, filename) {
    const doc = documentFrom(text), root = doc.documentElement;
    if (root.tagName !== 'Chaser' || !/^3\./.test(attr(root,'version','')))
      throw new Error('Choose a native Chaser 3 XML project.');
    const parsedMap = nativeMap(root), sequencesNode = child(root,'sequences');
    if (!sequencesNode) throw new Error('This Chaser project contains no sequence list.');
    const nodes = children(sequencesNode,'sequence'), indexed = new Map();
    nodes.forEach((node,index) => {
      const number = integer(attr(node,'index'), index, 0, 127, 'Sequence index');
      if (indexed.has(number)) throw new Error('The XML file has duplicate sequence indexes.');
      indexed.set(number,node);
    });
    const declared = integer(attr(sequencesNode,'last'), 15, 0, 127, 'Last sequence index');
    const count = Math.max(declared + 1, ...Array.from(indexed.keys()).map(index => index + 1));
    const valid = new Set(C.flatSlices(parsedMap.map).map(slice => slice.id));
    const warnings = parsedMap.warnings.slice();
    const sequences = Array.from({length:count}, (_,index) => {
      const node = indexed.get(index), stepsNode = child(node,'steps'), stepNodes = children(stepsNode,'step');
      const byStep = new Map();
      stepNodes.forEach((step,stepIndex) => {
        const number = integer(attr(step,'index'), stepIndex, 0, MAX_STEPS - 1, 'Step index');
        if (byStep.has(number)) throw new Error('The XML file has duplicate step indexes.');
        byStep.set(number,step);
      });
      const declaredLast = integer(attr(stepsNode,'last'), 15, 0, MAX_STEPS - 1, 'Last step index');
      const stepCount = Math.max(declaredLast + 1, ...Array.from(byStep.keys()).map(number => number + 1));
      const steps = Array.from({length:stepCount}, (_,stepIndex) => ({sliceIds:
        Array.from(new Set(children(byStep.get(stepIndex),'slice').map(slice => attr(slice,'uniqueId',''))))
          .filter(id => { if (valid.has(id)) return true; warnings.push(`Step ${stepIndex + 1} references an unavailable slice ${id}.`); return false; })
      }));
      return {id:`native-sequence:${index}`,name:attr(node,'name',`Sequence ${index + 1}`),steps,viewId:'view:all'};
    });
    const reference = {format:'chaser-3',version:attr(root,'version','3.1.3'),xml:text,
      filename:String(filename || 'Chaser.xml'),assFile:attr(child(root,'screens'),'assFile',''),
      sequenceIds:sequences.map(sequence => sequence.id),
      screenIds:parsedMap.map.screens.map(screen => screen.id),sliceIds:Array.from(valid),
      nativeIdMap:{sequences:{},screens:{},slices:{}}};
    const project = C.normaliseProject({name:nameOf(filename),map:parsedMap.map,sequences,
      activeSequenceId:sequences[0].id,activeStep:0,
      views:[{id:'view:all',name:'All',visibleSliceIds:parsedMap.visible}],nativeReference:reference});
    return {project,reference,warnings:Array.from(new Set(warnings))};
  }

  function parameter(node, block, name, fallback) {
    const params = children(node,'Params').find(item => attr(item,'name','') === block);
    const param = children(params).find(item => attr(item,'name','') === name);
    return attr(param,'value',fallback);
  }

  function parseAdvancedOutput(text, filename) {
    const doc = documentFrom(text), root = doc.documentElement;
    const setup = root.tagName === 'ScreenSetup' ? root : child(root,'ScreenSetup');
    if (!setup) throw new Error('Choose a Resolume AdvancedOutput.xml or Advanced Output preset.');
    const composition = child(setup,'CurrentCompositionTextureSize');
    const width = integer(attr(composition,'width'), 1920, 1, 32768, 'Composition width');
    const height = integer(attr(composition,'height'), 1080, 1, 32768, 'Composition height');
    const usedScreens = new Set(), usedSlices = new Set();
    const screens = children(child(setup,'screens')).filter(node => node.tagName === 'Screen').map((node,index) => {
      const id = nodeId(node,`arena-screen:${index}`,usedScreens);
      const device = children(child(node,'OutputDevice'))[0];
      const raster = {width:integer(attr(device,'width'),width,1,32768,'Output width'),
        height:integer(attr(device,'height'),height,1,32768,'Output height')};
      const layers = children(child(node,'layers'));
      // Arena's XML mask transforms are not established by the available
      // fixtures. The Map renderer's flat JS mask model is a clone convention,
      // so importing these tags as their bounding rectangle would lose shape.
      if (layers.some(layer => layer.tagName === 'SliceMask'))
        throw new Error('This preset uses SliceMask input masks that Chaser cannot import yet. Use a native Chaser 3 XML project or an unmasked preset.');
      const slices = layers.filter(layer => layer.tagName === 'Slice' || layer.tagName === 'Polygon').map((layer,sliceIndex) => {
        if (usedSlices.size >= MAX_SLICES) throw new Error('The XML map exceeds 4096 video slices.');
        const sliceId = nodeId(layer,`${id}:slice:${sliceIndex}`,usedSlices);
        if (['SliceMask','ShapeObject','InputContour','OutputContour'].some(tag => layer.getElementsByTagName(tag).length))
          throw new Error('This preset uses masked or contour geometry that Chaser cannot import yet. Use a native Chaser 3 XML project or an unmasked preset.');
        const inputPoints = pointsOf(child(layer,'InputRect'));
        const outputPoints = pointsOf(child(layer,'OutputRect'));
        return {id:sliceId,name:parameter(layer,'Common','Name',attr(layer,'name',`Slice ${sliceIndex + 1}`)),
          kind:'slice',input:validGeometry(inputPoints,'Arena slice'),
          output:validGeometry(outputPoints.length ? outputPoints : inputPoints,'Arena output')};
      });
      return {id,name:parameter(node,'Params','Name',attr(node,'name',`Screen ${index + 1}`)),
        device:attr(device,'name',''),raster,slices};
    });
    if (!screens.length || !usedSlices.size) throw new Error('This preset contains no supported video slices.');
    return C.normaliseMap({composition:{width,height},screens,
      source:String(filename || 'Resolume Advanced Output')});
  }

  function ensureChild(doc,node,tag) {
    let value = child(node,tag);
    if (!value) { value = doc.createElement(tag); node.appendChild(value); }
    return value;
  }

  function replaceKnownChildren(parent,tag,nodes) {
    const existing = children(parent,tag), before = existing[0] || null;
    nodes.forEach(node => parent.insertBefore(node,before));
    existing.forEach(node => parent.removeChild(node));
  }

  function writePoints(doc,node,points,tag) {
    const entries = points.map(point => { const entry = doc.createElement(tag);
      entry.setAttribute('x',String(point.x)); entry.setAttribute('y',String(point.y)); return entry; });
    replaceKnownChildren(node,tag,entries);
  }

  function samePoints(a,b) {
    return a.length === b.length && a.every((point,index) => point.x === b[index].x && point.y === b[index].y);
  }

  function hashId(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i),16777619) >>> 0;
    return hash;
  }

  function serializeDocument(raw, suppliedReference) {
    const project = C.normaliseProject(raw), reference = suppliedReference || raw.nativeReference || null;
    if (project.sequences.length > 16) throw new Error('Chaser 3 supports 16 sequence slots. Save a SHOWAVE project to keep all sequences.');
    const doc = reference && reference.format === 'chaser-3' && reference.xml
      ? documentFrom(reference.xml) : documentFrom('<Chaser version="3.1.3"><sequences last="15"/><screens/></Chaser>');
    const root = doc.documentElement;
    if (root.tagName !== 'Chaser') throw new Error('The native project reference is invalid.');
    root.setAttribute('version',reference && /^3\./.test(reference.version || '') ? reference.version : '3.1.3');
    const used = new Set(), idMaps = reference && reference.nativeIdMap
      ? clone(reference.nativeIdMap) : {screens:{},slices:{},sequences:{}};
    const nativeIds = new Map();
    // Reserve existing numeric IDs first so generated identities never displace
    // a real Arena slice identity, regardless of screen order.
    project.map.screens.forEach(screen => { if (/^\d+$/.test(screen.id)) used.add(screen.id);
      screen.slices.forEach(slice => { if (/^\d+$/.test(slice.id)) used.add(slice.id); }); });
    function nativeId(kind,id) {
      if (/^\d+$/.test(id)) return id;
      const key = `${kind}:${id}`;
      if (nativeIds.has(key)) return nativeIds.get(key);
      const map = idMaps[kind] || (idMaps[kind] = {});
      let result = map[id];
      if (!/^\d+$/.test(result || '') || used.has(result)) {
        let number = 1700000000000 + hashId(key);
        while (used.has(String(number))) number++;
        result = String(number); map[id] = result;
      }
      used.add(result); nativeIds.set(key,result); return result;
    }
    const sequencesNode = ensureChild(doc,root,'sequences');
    const originals = new Map(children(sequencesNode,'sequence').map(node => [Number(attr(node,'index',0)),node.cloneNode(true)]));
    const originalIds = reference && reference.sequenceIds || [];
    const sequenceNodes = project.sequences.map((sequence,index) => {
      const originalIndex = originalIds.indexOf(sequence.id);
      const node = originals.get(originalIndex) || doc.createElement('sequence');
      node.setAttribute('index',String(index)); node.setAttribute('name',sequence.name);
      const stepsNode = ensureChild(doc,node,'steps'); stepsNode.setAttribute('last',String(sequence.steps.length - 1));
      const originalSteps = new Map(children(stepsNode,'step').map(step => [Number(attr(step,'index',0)),step.cloneNode(true)]));
      const steps = sequence.steps.map((step,stepIndex) => {
        const stepNode = originalSteps.get(stepIndex) || doc.createElement('step');
        stepNode.setAttribute('index',String(stepIndex));
        const originalMembers = new Map(children(stepNode,'slice').map(slice => [attr(slice,'uniqueId',''),slice.cloneNode(true)]));
        const slices = step.sliceIds.map(coreId => {
          const id = nativeId('slices',coreId), originalId = idMaps.slices && idMaps.slices[coreId];
          const sliceNode = originalMembers.get(id) || originalMembers.get(originalId) || doc.createElement('slice');
          sliceNode.setAttribute('uniqueId',id); return sliceNode;
        });
        replaceKnownChildren(stepNode,'slice',slices);
        return stepNode;
      });
      replaceKnownChildren(stepsNode,'step',steps); return node;
    });
    sequencesNode.setAttribute('last','15'); replaceKnownChildren(sequencesNode,'sequence',sequenceNodes);
    const screensNode = ensureChild(doc,root,'screens');
    screensNode.setAttribute('x',String(project.map.composition.width)); screensNode.setAttribute('y',String(project.map.composition.height));
    if (reference && reference.assFile) screensNode.setAttribute('assFile',reference.assFile);
    else if (!screensNode.hasAttribute('assFile')) screensNode.setAttribute('assFile','');
    const originalScreens = new Map(children(screensNode,'screen').map(node => [attr(node,'uniqueId',''),node.cloneNode(true)]));
    const all = C.activeView(project,'view:all'), visible = new Set(all && all.visibleSliceIds || []);
    const screenNodes = project.map.screens.map(screen => {
      const screenId = nativeId('screens',screen.id), sourceScreenId = idMaps.screens && idMaps.screens[screen.id];
      const node = originalScreens.get(screenId) || originalScreens.get(sourceScreenId) || doc.createElement('screen');
      const originalSlices = new Map(children(node,'slice').map(slice => [attr(slice,'uniqueId',''),slice.cloneNode(true)]));
      const screenWasHidden = attr(node,'enabled','1') === '0';
      const stillHidden = screenWasHidden && screen.slices.every(slice => !visible.has(slice.id));
      node.setAttribute('uniqueId',screenId); node.setAttribute('name',screen.name); node.setAttribute('enabled',stillHidden ? '0' : '1');
      const slices = screen.slices.map(slice => {
        const sliceId = nativeId('slices',slice.id), sourceSliceId = idMaps.slices && idMaps.slices[slice.id];
        const sliceNode = originalSlices.get(sliceId) || originalSlices.get(sourceSliceId) || doc.createElement('slice');
        sliceNode.setAttribute('uniqueId',sliceId); sliceNode.setAttribute('name',slice.name);
        if (!stillHidden) sliceNode.setAttribute('enabled',visible.has(slice.id) ? '1' : '0');
        else if (!sliceNode.hasAttribute('enabled')) sliceNode.setAttribute('enabled','1');
        const rect = ensureChild(doc,sliceNode,'inputRect'), mask = ensureChild(doc,sliceNode,'mask');
        const maskPoints = pointsOf(mask), sourcePoints = maskPoints.length >= 3 ? maskPoints : pointsOf(rect);
        if (!samePoints(sourcePoints,slice.input.vertices)) {
          if (slice.input.vertices.length !== 4)
            throw new Error('A new polygon requires a native Chaser mask reference. Save a SHOWAVE project to preserve this map.');
          writePoints(doc,rect,slice.input.vertices,'point');
          if (!rect.hasAttribute('orientation')) rect.setAttribute('orientation','0.0');
          if (maskPoints.length) replaceKnownChildren(mask,'point',[]);
        }
        return sliceNode;
      });
      replaceKnownChildren(node,'slice',slices); return node;
    });
    replaceKnownChildren(screensNode,'screen',screenNodes);
    if (typeof global.XMLSerializer !== 'function') throw new Error('This browser cannot write XML projects.');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new global.XMLSerializer().serializeToString(root) + '\n';
    if (reference) reference.nativeIdMap = idMaps;
    return xml;
  }

  global.OpenLiveChaserNative = Object.freeze({parseDocument,parseAdvancedOutput,serializeDocument});
})(window);
