/* SHOWAVE Chaser / Mapper
   -------------------------------------------------------------------------
   Shared, dependency-free project and renderer contract. The editor in
   chaser.html and the SHOWAVE Chaser Source in SHOWAVE Live both use this
   file, so the map the operator edits is the texture that programme output
   renders. Checkered remains an untouched native-compatible Source.

   The Chaser owns logical slice membership and step sequences. SHOWAVE Map
   remains the authority for physical Screens, output transforms and routing.
   This module produces a video raster; it does not claim to transmit DMX.
   ------------------------------------------------------------------------- */
(function installOpenLiveChaser(global) {
  'use strict';

  if (global.OpenLiveChaser) return;

  const SCHEMA = 2;
  const SOURCE_NAME = 'SHOWAVE Chaser';
  const MAX_SLICES = 4096;
  const MAX_STEPS = 1024;
  const MAX_VIEWS = 512;
  const MAX_ENVELOPES = 512;
  const MAX_ENVELOPE_POINTS = 1024;
  const ALL_VIEW_ID = 'view:all';
  const FACTORY_DIRECTIONS = Object.freeze([
    'Horizontal', 'Vertical', 'Row', 'Column', 'Random'
  ]);
  const DEFAULT_COLORS = Object.freeze({
    color1: 0xff101010,
    color2: 0xffe6e6e6,
    inactive: 0xff050608,
    grid: 0xff3d4652
  });
  const STEP_RATES = Object.freeze({ '1/4': 0.25, '1/2': 0.5, '1': 1, '2': 2, '4': 4 });
  const DIRECTIONS = Object.freeze(['Forward', 'Reverse', 'Bounce']);
  const NORMAL_MAPS = new WeakSet();
  const NORMAL_PROJECTS = new WeakSet();
  const NORMAL_ENVELOPES = new WeakSet();
  const NORMAL_NATIVE_REFERENCES = new WeakSet();

  const DISTRIBUTIONS = Object.freeze([
    ['Top Left, Left to Right',            {sx:0, sy:0, vert:false, snake:false}],
    ['Top Left, Left to Right, Snake',     {sx:0, sy:0, vert:false, snake:true }],
    ['Top Right, Right to Left',           {sx:1, sy:0, vert:false, snake:false}],
    ['Top Right, Right to Left, Snake',    {sx:1, sy:0, vert:false, snake:true }],
    ['Bottom Left, Left to Right',         {sx:0, sy:1, vert:false, snake:false}],
    ['Bottom Left, Left to Right, Snake',  {sx:0, sy:1, vert:false, snake:true }],
    ['Bottom Right, Right to Left',        {sx:1, sy:1, vert:false, snake:false}],
    ['Bottom Right, Right to Left, Snake', {sx:1, sy:1, vert:false, snake:true }],
    ['Top Left, Top to Bottom',            {sx:0, sy:0, vert:true,  snake:false}],
    ['Top Left, Top to Bottom, Snake',     {sx:0, sy:0, vert:true,  snake:true }],
    ['Top Right, Top to Bottom',           {sx:1, sy:0, vert:true,  snake:false}],
    ['Top Right, Top to Bottom, Snake',    {sx:1, sy:0, vert:true,  snake:true }],
    ['Bottom Left, Bottom to Top',         {sx:0, sy:1, vert:true,  snake:false}],
    ['Bottom Left, Bottom to Top, Snake',  {sx:0, sy:1, vert:true,  snake:true }],
    ['Bottom Right, Bottom to Top',        {sx:1, sy:1, vert:true,  snake:false}],
    ['Bottom Right, Bottom to Top, Snake', {sx:1, sy:1, vert:true,  snake:true }]
  ].map(entry => Object.freeze([entry[0], Object.freeze(entry[1])])));

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const integer = (value, fallback, min, max) => clamp(
    Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback, min, max);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const idText = value => String(value == null ? '' : value).slice(0, 256);
  const unique = values => [...new Set((values || []).map(idText).filter(Boolean))];
  const uid = prefix => `${prefix || 'chaser'}:${Date.now().toString(36)}:${
    global.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

  function uniqueId(value, fallback, used) {
    const base = idText(value) || fallback;
    let id = base, suffix = 2;
    while (used.has(id)) id = `${base}:${suffix++}`;
    used.add(id);
    return id;
  }

  function normalisedName(value) {
    return idText(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function idsFromCollection(value) {
    if (Array.isArray(value)) return unique(value);
    const ids = [];
    if (value && typeof value.forEach === 'function') {
      value.forEach(id => ids.push(idText(id)));
      return unique(ids);
    }
    return ids;
  }

  function pixelOrder(width, height, distribution) {
    const w = integer(width, 1, 1, 512), h = integer(height, 1, 1, 512);
    const d = typeof distribution === 'number'
      ? DISTRIBUTIONS[clamp(Math.round(distribution), 0, DISTRIBUTIONS.length - 1)][1]
      : distribution || DISTRIBUTIONS[0][1];
    const out = [];
    if (!d.vert) {
      for (let row = 0; row < h; row++) {
        const y = d.sy ? h - 1 - row : row;
        let reverse = !!d.sx;
        if (d.snake && row % 2 === 1) reverse = !reverse;
        for (let column = 0; column < w; column++)
          out.push([reverse ? w - 1 - column : column, y]);
      }
    } else {
      for (let column = 0; column < w; column++) {
        const x = d.sx ? w - 1 - column : column;
        let reverse = !!d.sy;
        if (d.snake && column % 2 === 1) reverse = !reverse;
        for (let row = 0; row < h; row++) out.push([x, reverse ? h - 1 - row : row]);
      }
    }
    return out;
  }

  function rectangleVertices(rect) {
    const x = Number(rect && rect.x) || 0, y = Number(rect && rect.y) || 0;
    const width = Math.max(1, Number(rect && (rect.w == null ? rect.width : rect.w)) || 1);
    const height = Math.max(1, Number(rect && (rect.h == null ? rect.height : rect.h)) || 1);
    return [{x, y}, {x:x + width, y}, {x:x + width, y:y + height}, {x, y:y + height}];
  }

  function normaliseVertices(input) {
    const vertices = Array.isArray(input && input.vertices) ? input.vertices : rectangleVertices(input || {});
    const safe = vertices.slice(0, 128).map(point => ({
      x: Number.isFinite(Number(point && point.x)) ? Number(point.x) : 0,
      y: Number.isFinite(Number(point && point.y)) ? Number(point.y) : 0
    }));
    return safe.length >= 3 ? safe : rectangleVertices(input || {});
  }

  function vertexBounds(vertices) {
    const xs = vertices.map(point => point.x), ys = vertices.map(point => point.y);
    const left = Math.min(...xs), top = Math.min(...ys);
    return {x:left, y:top, w:Math.max(1, Math.max(...xs) - left),
      h:Math.max(1, Math.max(...ys) - top)};
  }

  function normaliseMap(raw) {
    if (raw && typeof raw === 'object' && NORMAL_MAPS.has(raw)) return raw;
    const input = raw && typeof raw === 'object' ? raw : {};
    const composition = input.composition || {};
    const width = integer(composition.width, 1920, 1, 32768);
    const height = integer(composition.height, 1080, 1, 32768);
    const seen = new Set();
    let count = 0;
    const screens = (Array.isArray(input.screens) ? input.screens : []).slice(0, 256).map((screen, screenIndex) => {
      const screenId = idText(screen && screen.id) || `screen:${screenIndex + 1}`;
      const rasterSource = screen && screen.raster || {};
      const raster = {
        width:integer(rasterSource.width, width, 1, 32768),
        height:integer(rasterSource.height, height, 1, 32768)
      };
      const slices = (Array.isArray(screen && screen.slices) ? screen.slices : []).reduce((out, slice, sliceIndex) => {
        const kind = idText(slice && slice.kind).toLowerCase();
        const type = idText(slice && slice.type).toLowerCase();
        /* SHOWAVE Map draws masks and DMX fixtures as output-stage operators,
           not as routed video slices. Letting either into a chase creates a
           step target that can never carry the Source raster. */
        if (count >= MAX_SLICES || !slice || slice.mask || kind.includes('dmx') ||
            kind.includes('mask') || type.includes('dmx') || type.includes('mask')) return out;
        let id = idText(slice.id) || `${screenId}:slice:${sliceIndex + 1}`;
        if (seen.has(id)) id = `${screenId}:${id}:${sliceIndex + 1}`;
        seen.add(id); count++;
        const vertices = normaliseVertices(slice.input || slice);
        /* SHOWAVE Map publishes both coordinate spaces. Input geometry is in
           Composition pixels; Output geometry is in this Screen's raster.
           Older saved maps only have Input geometry, so retain their useful
           behaviour by treating it as a follow-composition Output map. */
        const outputVertices = normaliseVertices(slice.output || slice.input || slice);
        out.push({
          id, screenId,
          name: idText(slice.name) || `Slice ${sliceIndex + 1}`,
          kind: idText(slice.kind) || 'slice',
          input: Object.assign(vertexBounds(vertices), {vertices}),
          output:Object.assign(vertexBounds(outputVertices), {vertices:outputVertices})
        });
        return out;
      }, []);
      return {id:screenId, name:idText(screen && screen.name) || `Screen ${screenIndex + 1}`,
        device:idText(screen && screen.device), raster,
        followComposition:screen && screen.followComposition == null
          ? raster.width === width && raster.height === height : !!screen.followComposition,
        slices};
    }).filter(screen => screen.slices.length);
    const map = {schema:1, composition:{width, height}, screens,
      source:idText(input.source) || 'SHOWAVE Map', updatedAt:Number(input.at || input.updatedAt) || 0};
    NORMAL_MAPS.add(map);
    return map;
  }

  function checkeredMap(columns, rows) {
    const nx = integer(columns, 8, 1, 64), ny = integer(rows, 8, 1, 64);
    const width = 1600, height = 900;
    const cellWidth = width / nx, cellHeight = height / ny;
    const order = pixelOrder(nx, ny, 1);
    const indexByCell = new Map(order.map((cell, index) => [cell.join(','), index + 1]));
    const slices = [];
    for (let row = 0; row < ny; row++) for (let column = 0; column < nx; column++) {
      /* Logical panels tile the native Checkered raster exactly. Separation is
         an editor guide, not missing source pixels or black programme gutters. */
      const x = column * cellWidth, y = row * cellHeight;
      const w = cellWidth, h = cellHeight;
      slices.push({
        id:`checkered:${column}:${row}`,
        name:`Panel ${indexByCell.get(`${column},${row}`)}`,
        kind:'panel', input:{x, y, w, h, vertices:rectangleVertices({x, y, w, h})}
      });
    }
    return normaliseMap({source:'Checkered clone', composition:{width, height}, screens:[{
      id:'checkered-screen', name:`Checkered ${nx} × ${ny}`, device:'Logical Input Map', slices
    }]});
  }

  function flatSlices(map) {
    return (map && map.screens || []).flatMap(screen => (screen.slices || []).map(slice =>
      Object.assign({}, slice, {screenName:screen.name})));
  }

  function normaliseViews(rawViews, map) {
    const validIds = flatSlices(map).map(slice => slice.id);
    const valid = new Set(validIds);
    const source = Array.isArray(rawViews) ? rawViews : [];
    const suppliedAll = source.find(view => view && idText(view.id) === ALL_VIEW_ID);
    const allMembership = suppliedAll && Array.isArray(suppliedAll.visibleSliceIds)
      ? unique(suppliedAll.visibleSliceIds).filter(id => valid.has(id)) : validIds.slice();
    const views = [{
      id:ALL_VIEW_ID,
      name:'All',
      builtin:true,
      visibleSliceIds:allMembership
    }];
    const used = new Set([ALL_VIEW_ID]);
    source.slice(0, MAX_VIEWS * 2).forEach((view, index) => {
      if (!view || typeof view !== 'object' || idText(view.id) === ALL_VIEW_ID ||
          views.length >= MAX_VIEWS) return;
      const id = uniqueId(view.id, `view:${index + 1}`, used);
      views.push({
        id,
        name:idText(view.name) || `View ${views.length}`,
        builtin:false,
        visibleSliceIds:unique(Array.isArray(view.visibleSliceIds) ? view.visibleSliceIds : [])
          .filter(sliceId => valid.has(sliceId))
      });
    });
    return views;
  }

  function activeView(project, value) {
    const safe = project && NORMAL_PROJECTS.has(project) ? project : normaliseProject(project);
    const views = safe.views || [];
    const wanted = idText(value) || idText(safe.activeViewId);
    return views.find(view => view.id === wanted) ||
      views.find(view => view.id === ALL_VIEW_ID) || views[0] || null;
  }

  function visibleSliceIds(project, value) {
    const view = activeView(project, value);
    return new Set(view && view.visibleSliceIds || []);
  }

  function normaliseFactory(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const direction = FACTORY_DIRECTIONS.includes(value.direction)
      ? value.direction : 'Horizontal';
    const grid = input => [...new Set((Array.isArray(input) ? input : [])
      .slice(0, MAX_SLICES - 1)
      .map(Number).filter(Number.isFinite))]
      .sort((a, b) => a - b);
    return {
      direction,
      flipX:!!value.flipX,
      flipY:!!value.flipY,
      mirrorX:!!value.mirrorX,
      mirrorY:!!value.mirrorY,
      block:integer(value.block, 1, 1, MAX_SLICES),
      modulo:integer(value.modulo, 0, 0, MAX_STEPS),
      rows:integer(value.rows, 0, 0, MAX_SLICES),
      columns:integer(value.columns, 0, 0, MAX_SLICES),
      seed:seedNumber(value.seed),
      gridX:grid(value.gridX),
      gridY:grid(value.gridY),
      gridXEdited:!!value.gridXEdited,
      gridYEdited:!!value.gridYEdited
    };
  }

  function defaultEnvelope(index) {
    const suffix = index ? `:${index + 1}` : '';
    return {
      id:index ? `envelope:${index + 1}` : 'envelope:default',
      name:index ? `Envelope ${index + 1}` : 'S Curve',
      points:[
        {id:`envelope-point:start${suffix}`, x:0, y:0,
          inX:0, inY:0, outX:.3, outY:0, linear:false},
        {id:`envelope-point:end${suffix}`, x:1, y:1,
          inX:.7, inY:1, outX:1, outY:1, linear:false}
      ]
    };
  }

  function normaliseEnvelopePoints(rawPoints, envelopeIndex) {
    const source = (Array.isArray(rawPoints) ? rawPoints : [])
      .slice(0, MAX_ENVELOPE_POINTS)
      .map((point, index) => {
        if (!point || typeof point !== 'object' ||
            !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
        const x = clamp(Number(point.x), 0, 1), y = clamp(Number(point.y), 0, 1);
        return {
          sourceId:idText(point.id),
          sourceIndex:index,
          x, y,
          inX:clamp(Number.isFinite(Number(point.inX)) ? Number(point.inX) : x, 0, 1),
          inY:clamp(Number.isFinite(Number(point.inY)) ? Number(point.inY) : y, 0, 1),
          outX:clamp(Number.isFinite(Number(point.outX)) ? Number(point.outX) : x, 0, 1),
          outY:clamp(Number.isFinite(Number(point.outY)) ? Number(point.outY) : y, 0, 1),
          linear:!!point.linear
        };
      }).filter(Boolean)
      .sort((a, b) => a.x - b.x || a.sourceIndex - b.sourceIndex);
    const points = [];
    source.forEach(point => {
      if (!points.length || Math.abs(points[points.length - 1].x - point.x) > 0.000001)
        points.push(point);
    });
    if (!points.length) return defaultEnvelope(envelopeIndex).points;
    if (points[0].x > 0.000001) {
      points.unshift({sourceId:'', sourceIndex:-1, x:0, y:points[0].y,
        inX:0, inY:points[0].y, outX:0, outY:points[0].y, linear:true});
    } else points[0].x = 0;
    if (points[points.length - 1].x < 0.999999) {
      const last = points[points.length - 1];
      points.push({sourceId:'', sourceIndex:MAX_ENVELOPE_POINTS, x:1, y:last.y,
        inX:1, inY:last.y, outX:1, outY:last.y, linear:false});
    } else points[points.length - 1].x = 1;
    if (points.length > MAX_ENVELOPE_POINTS) {
      points.splice(MAX_ENVELOPE_POINTS - 1,
        points.length - (MAX_ENVELOPE_POINTS - 1),
        points[points.length - 1]);
    }
    const used = new Set();
    return points.map((point, index) => {
      const previous = points[index - 1], next = points[index + 1];
      const id = uniqueId(point.sourceId,
        `envelope-point:${envelopeIndex + 1}:${index + 1}`, used);
      return {
        id,
        x:point.x,
        y:point.y,
        inX:clamp(point.inX, previous ? previous.x : point.x, point.x),
        inY:clamp(point.inY, 0, 1),
        outX:clamp(point.outX, point.x, next ? next.x : point.x),
        outY:clamp(point.outY, 0, 1),
        linear:!!point.linear
      };
    });
  }

  function normaliseEnvelope(raw, index, used) {
    const source = raw && typeof raw === 'object' ? raw : defaultEnvelope(index);
    const envelope = {
      id:uniqueId(source.id, index ? `envelope:${index + 1}` : 'envelope:default', used),
      name:idText(source.name) || (index ? `Envelope ${index + 1}` : 'S Curve'),
      points:normaliseEnvelopePoints(source.points, index)
    };
    NORMAL_ENVELOPES.add(envelope);
    return envelope;
  }

  function normaliseEnvelopes(rawEnvelopes) {
    const source = Array.isArray(rawEnvelopes) && rawEnvelopes.length
      ? rawEnvelopes.slice(0, MAX_ENVELOPES) : [defaultEnvelope(0)];
    const used = new Set();
    return source.map((envelope, index) => normaliseEnvelope(envelope, index, used));
  }

  function activeEnvelope(project, value) {
    const safe = project && NORMAL_PROJECTS.has(project) ? project : normaliseProject(project);
    const envelopes = safe.envelopes || [];
    const wanted = idText(value) || idText(safe.activeEnvelopeId);
    return envelopes.find(envelope => envelope.id === wanted) || envelopes[0] || null;
  }

  function cubic(a, b, c, d, t) {
    const inverse = 1 - t;
    return inverse * inverse * inverse * a + 3 * inverse * inverse * t * b +
      3 * inverse * t * t * c + t * t * t * d;
  }

  function sampleEnvelope(envelope, value) {
    /* Editor projects already contain boundary-normalised curves. Sampling a
       dense preview or a programme frame must not clone and sort all of their
       anchors once per pixel/sample; unknown external curves still pay the
       validation cost at this public API boundary. */
    const safe = envelope && typeof envelope === 'object' && NORMAL_ENVELOPES.has(envelope)
      ? envelope : normaliseEnvelope(envelope, 0, new Set());
    const points = safe.points, t = clamp(Number(value) || 0, 0, 1);
    if (t <= points[0].x) return points[0].y;
    if (t >= points[points.length - 1].x) return points[points.length - 1].y;
    let left = points[0], right = points[points.length - 1];
    for (let index = 0; index < points.length - 1; index++) {
      if (t >= points[index].x && t <= points[index + 1].x) {
        left = points[index]; right = points[index + 1]; break;
      }
    }
    const span = Math.max(0.000001, right.x - left.x);
    if (left.linear) return clamp(left.y + (right.y - left.y) * ((t - left.x) / span), 0, 1);
    let low = 0, high = 1, phase = .5;
    for (let iteration = 0; iteration < 24; iteration++) {
      phase = (low + high) / 2;
      if (cubic(left.x, left.outX, right.inX, right.x, phase) < t) low = phase;
      else high = phase;
    }
    return clamp(cubic(left.y, left.outY, right.inY, right.y, phase), 0, 1);
  }

  function seedSteps(map, count) {
    const ids = flatSlices(map).map(slice => slice.id);
    const total = integer(count, 16, 1, MAX_STEPS);
    if (!ids.length) return Array.from({length:total}, () => ({sliceIds:[]}));
    /* One stage pass over the familiar 16-step strip. If a map has more than
       sixteen slices, contiguous groups make every slice reachable on first
       launch while remaining easy to edit into a different chase. */
    return Array.from({length:total}, (_, step) => ({
      sliceIds:ids.filter((id, index) => index % total === step)
    }));
  }

  function seedNumber(value) {
    if (value == null || value === '') return 1;
    if (Number.isFinite(Number(value))) return Number(value) >>> 0;
    const source = String(value == null ? '1' : value);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let state = seedNumber(seed) || 0x6d2b79f5;
    return () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function shuffleSteps(steps, seed) {
    const shuffled = (Array.isArray(steps) ? steps : []).map(step => clone(step));
    const random = seededRandom(seed);
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    return shuffled;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 1;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function factoryAxisBoundaries(records, centerKey, sizeKey, requested, supplied, edited, extent) {
    const centers = records.map(record => record[centerKey]).sort((a, b) => a - b);
    if (!centers.length) return [];
    const minimum = centers[0], maximum = centers[centers.length - 1];
    const explicit = [...new Set((supplied || []).filter(value =>
      Number.isFinite(value) && (edited ? value > 0 && value < extent
        : value > minimum && value < maximum)))]
      .sort((a, b) => a - b);
    // An authored empty border list means one group, rather than a request to
    // infer a new grid. Otherwise deleting the last border recreates it.
    if (explicit.length || edited) return explicit;
    if (centers.length < 2) return [];
    const wanted = integer(requested, 0, 0, records.length);
    if (wanted === 1) return [];
    if (wanted > 1) {
      const count = Math.min(wanted, records.length);
      let means = Array.from({length:count}, (_, index) =>
        centers[Math.min(centers.length - 1,
          Math.floor((index + .5) * centers.length / count))]);
      for (let iteration = 0; iteration < 20; iteration++) {
        const groups = Array.from({length:count}, () => []);
        centers.forEach(value => {
          let selected = 0, distance = Infinity;
          means.forEach((mean, index) => {
            const nextDistance = Math.abs(value - mean);
            if (nextDistance < distance) { distance = nextDistance; selected = index; }
          });
          groups[selected].push(value);
        });
        const next = means.map((mean, index) => groups[index].length
          ? groups[index].reduce((sum, value) => sum + value, 0) / groups[index].length : mean)
          .sort((a, b) => a - b);
        if (next.every((value, index) => Math.abs(value - means[index]) < .0001)) {
          means = next; break;
        }
        means = next;
      }
      return [...new Set(means.slice(0, -1).map((mean, index) =>
        (mean + means[index + 1]) / 2).filter((value, index, list) =>
        !index || Math.abs(value - list[index - 1]) > .0001))];
    }
    const tolerance = Math.max(.5, median(records.map(record => record[sizeKey])) * .35);
    const boundaries = [];
    for (let index = 1; index < centers.length; index++) {
      if (centers[index] - centers[index - 1] > tolerance)
        boundaries.push((centers[index] + centers[index - 1]) / 2);
    }
    return [...new Set(boundaries)];
  }

  function factoryBucket(value, boundaries) {
    let low = 0, high = boundaries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (value > boundaries[middle]) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function factoryPattern(map, sliceIds, rawSettings) {
    const safe = normaliseMap(map), settings = normaliseFactory(rawSettings);
    const requested = sliceIds == null ? null : new Set(idsFromCollection(sliceIds));
    const records = flatSlices(safe).filter(slice => !requested || requested.has(slice.id))
      .map((slice, order) => ({
        id:slice.id,
        order,
        cx:slice.input.x + slice.input.w / 2,
        cy:slice.input.y + slice.input.h / 2,
        width:slice.input.w,
        height:slice.input.h
      }));
    if (!records.length) {
      return {steps:[], rows:0, columns:0,
        settings:Object.assign({}, settings, {rows:0, columns:0, gridX:[], gridY:[]})};
    }
    const gridX = factoryAxisBoundaries(records, 'cx', 'width',
      settings.columns, settings.gridX, settings.gridXEdited, safe.composition.width);
    const gridY = factoryAxisBoundaries(records, 'cy', 'height',
      settings.rows, settings.gridY, settings.gridYEdited, safe.composition.height);
    const columns = gridX.length + 1, rows = gridY.length + 1;
    const byId = new Map(), byCell = new Map();
    records.forEach(record => {
      record.column = factoryBucket(record.cx, gridX);
      record.row = factoryBucket(record.cy, gridY);
      record.sortColumn = settings.flipX ? columns - 1 - record.column : record.column;
      record.sortRow = settings.flipY ? rows - 1 - record.row : record.row;
      byId.set(record.id, record);
      const key = `${record.row}:${record.column}`;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(record.id);
    });
    let units;
    if (settings.direction === 'Row' || settings.direction === 'Column') {
      const axis = settings.direction === 'Row' ? 'sortRow' : 'sortColumn';
      const groups = new Map();
      records.forEach(record => {
        if (!groups.has(record[axis])) groups.set(record[axis], []);
        groups.get(record[axis]).push(record);
      });
      units = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(entry => ({
        sliceIds:entry[1].sort((a, b) =>
          settings.direction === 'Row'
            ? a.sortColumn - b.sortColumn || a.order - b.order
            : a.sortRow - b.sortRow || a.order - b.order)
          .map(record => record.id)
      }));
    } else {
      const ordered = records.slice().sort((a, b) => settings.direction === 'Vertical'
        ? a.sortColumn - b.sortColumn || a.sortRow - b.sortRow || a.order - b.order
        : a.sortRow - b.sortRow || a.sortColumn - b.sortColumn || a.order - b.order);
      units = ordered.map(record => ({sliceIds:[record.id]}));
      if (settings.direction === 'Random') units = shuffleSteps(units, settings.seed);
    }
    const block = Math.max(settings.block, Math.ceil(units.length / MAX_STEPS));
    let steps = [];
    for (let index = 0; index < units.length; index += block) {
      steps.push({sliceIds:unique(units.slice(index, index + block)
        .flatMap(step => step.sliceIds))});
    }
    const modulo = settings.modulo > 0
      ? Math.min(settings.modulo, steps.length, MAX_STEPS) : 0;
    if (modulo) {
      const folded = Array.from({length:modulo}, () => ({sliceIds:[]}));
      steps.forEach((step, index) => {
        folded[index % modulo].sliceIds.push(...step.sliceIds);
      });
      steps = folded.map(step => ({sliceIds:unique(step.sliceIds)}));
    }
    if (settings.mirrorX || settings.mirrorY) {
      steps = steps.map(step => {
        const ids = new Set(step.sliceIds);
        step.sliceIds.forEach(id => {
          const record = byId.get(id);
          if (!record) return;
          const rowsToUse = settings.mirrorY
            ? [record.row, rows - 1 - record.row] : [record.row];
          const columnsToUse = settings.mirrorX
            ? [record.column, columns - 1 - record.column] : [record.column];
          rowsToUse.forEach(row => columnsToUse.forEach(column =>
            (byCell.get(`${row}:${column}`) || []).forEach(sliceId => ids.add(sliceId))));
        });
        return {sliceIds:[...ids]};
      });
    }
    return {
      steps,
      rows,
      columns,
      settings:Object.assign({}, settings, {
        rows, columns, block, modulo, gridX:gridX.slice(), gridY:gridY.slice()
      })
    };
  }

  function normaliseSequence(raw, map, index, viewIds) {
    const valid = new Set(flatSlices(map).map(slice => slice.id));
    const source = raw && typeof raw === 'object' ? raw : {};
    let steps = (Array.isArray(source.steps) ? source.steps : []).slice(0, MAX_STEPS).map(step => ({
      sliceIds:unique(Array.isArray(step) ? step : step && step.sliceIds).filter(id => valid.has(id))
    }));
    if (!steps.length) steps = seedSteps(map, 16);
    const wantedView = idText(source.viewId);
    return {
      id:idText(source.id) || uid('sequence'),
      name:idText(source.name) || `Sequence ${index + 1}`,
      steps,
      viewId:viewIds && viewIds.has(wantedView) ? wantedView : ALL_VIEW_ID,
      factory:normaliseFactory(source.factory)
    };
  }

  function normaliseNativeReference(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const hasNativeXml = raw.format === 'chaser-3' && typeof raw.xml === 'string';
    const hasMapLink = typeof raw.assFile === 'string' && raw.assFile.trim().length > 0;
    if (!hasNativeXml && !hasMapLink) return null;
    if (NORMAL_NATIVE_REFERENCES.has(raw)) return raw;
    // A current Arena map can be the starting point before a Chaser XML file
    // exists. Keep its association when creating that first native document.
    const xml = hasNativeXml ? raw.xml : '';
    const bytes = typeof global.TextEncoder === 'function'
      ? new global.TextEncoder().encode(xml).byteLength
      : unescape(encodeURIComponent(xml)).length;
    if (bytes > 8 * 1024 * 1024)
      throw new RangeError('The native Chaser document exceeds the 8 MiB limit.');
    const reference = {
      format:'chaser-3', version:idText(raw.version) || '3.1.3', xml,
      filename:idText(raw.filename), assFile:String(raw.assFile || '').slice(0, 4096),
      sequenceIds:unique(Array.isArray(raw.sequenceIds) ? raw.sequenceIds : []).slice(0, 128),
      screenIds:unique(Array.isArray(raw.screenIds) ? raw.screenIds : []).slice(0, 256),
      sliceIds:unique(Array.isArray(raw.sliceIds) ? raw.sliceIds : []).slice(0, MAX_SLICES),
      nativeIdMap:{}
    };
    [['sequences', 128], ['screens', 256], ['slices', MAX_SLICES]].forEach(([kind, limit]) => {
      const supplied = raw.nativeIdMap && raw.nativeIdMap[kind];
      const entries = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
        ? Object.entries(supplied).slice(0, limit) : [];
      reference.nativeIdMap[kind] = Object.fromEntries(entries
        .map(([id, value]) => [idText(id), idText(value)]).filter(([id, value]) => id && value));
    });
    NORMAL_NATIVE_REFERENCES.add(reference);
    return reference;
  }

  function createProject(map) {
    const safeMap = normaliseMap(map && map.screens && map.screens.length ? map : checkeredMap(8, 8));
    const views = normaliseViews(null, safeMap);
    const sequence = normaliseSequence(null, safeMap, 0, new Set(views.map(view => view.id)));
    const envelopes = normaliseEnvelopes(null);
    const project = {
      schema:SCHEMA,
      id:uid('chaser-project'),
      name:'Untitled Chase',
      map:safeMap,
      sequences:[sequence],
      activeSequenceId:sequence.id,
      activeStep:0,
      views,
      activeViewId:ALL_VIEW_ID,
      envelopes,
      activeEnvelopeId:envelopes[0].id,
      mode:'chase',
      playback:{playing:false, bpm:120, stepsPerBeat:'1', direction:'Forward'},
      pixelMap:{numX:8, numY:8, color1:DEFAULT_COLORS.color1,
        color2:DEFAULT_COLORS.color2, gridColor:DEFAULT_COLORS.grid,
        showLabels:true, transparent:false},
      exportSettings:{},
      updatedAt:Date.now()
    };
    NORMAL_PROJECTS.add(project);
    return project;
  }

  function normaliseProject(raw, fallbackMap) {
    if (!raw || typeof raw !== 'object') return createProject(fallbackMap);
    const map = normaliseMap(raw.map && raw.map.screens && raw.map.screens.length
      ? raw.map : (fallbackMap && fallbackMap.screens && fallbackMap.screens.length ? fallbackMap : checkeredMap(8, 8)));
    const views = normaliseViews(raw.views, map);
    const viewIds = new Set(views.map(view => view.id));
    const sequences = (Array.isArray(raw.sequences) ? raw.sequences : []).slice(0, 128)
      .map((sequence, index) => normaliseSequence(sequence, map, index, viewIds));
    if (!sequences.length) sequences.push(normaliseSequence(null, map, 0, viewIds));
    const wanted = idText(raw.activeSequenceId);
    const active = sequences.find(sequence => sequence.id === wanted) || sequences[0];
    const playback = raw.playback || {}, pixelMap = raw.pixelMap || {};
    const envelopes = normaliseEnvelopes(raw.envelopes);
    const wantedEnvelope = idText(raw.activeEnvelopeId);
    const selectedEnvelope = envelopes.find(envelope => envelope.id === wantedEnvelope) || envelopes[0];
    const wantedView = idText(raw.activeViewId);
    const selectedView = views.find(view => view.id === wantedView) ||
      views.find(view => view.id === ALL_VIEW_ID) || views[0];
    const project = {
      schema:SCHEMA,
      id:idText(raw.id) || uid('chaser-project'),
      name:idText(raw.name) || 'Untitled Chase',
      map,
      sequences,
      activeSequenceId:active.id,
      activeStep:integer(raw.activeStep, 0, 0, active.steps.length - 1),
      views,
      activeViewId:selectedView.id,
      envelopes,
      activeEnvelopeId:selectedEnvelope.id,
      mode:raw.mode === 'pixelmap' || raw.mode === 'envelope' ? raw.mode : 'chase',
      playback:{
        playing:!!playback.playing,
        bpm:clamp(Number(playback.bpm) || 120, 20, 300),
        stepsPerBeat:Object.prototype.hasOwnProperty.call(STEP_RATES, playback.stepsPerBeat)
          ? playback.stepsPerBeat : '1',
        direction:DIRECTIONS.includes(playback.direction) ? playback.direction : 'Forward'
      },
      pixelMap:{
        numX:integer(pixelMap.numX, 8, 1, 128),
        numY:integer(pixelMap.numY, 8, 1, 128),
        color1:Number.isFinite(Number(pixelMap.color1)) ? Number(pixelMap.color1) >>> 0 : DEFAULT_COLORS.color1,
        color2:Number.isFinite(Number(pixelMap.color2)) ? Number(pixelMap.color2) >>> 0 : DEFAULT_COLORS.color2,
        gridColor:Number.isFinite(Number(pixelMap.gridColor)) ? Number(pixelMap.gridColor) >>> 0 : DEFAULT_COLORS.grid,
        showLabels:pixelMap.showLabels !== false,
        transparent:!!pixelMap.transparent
      },
      /* Export presets are interpreted by openlive-chaser-export.js. Keeping
         the plain data here makes the authored layout portable without
         coupling the programme Source renderer to export-only controls. */
      exportSettings:raw.exportSettings && typeof raw.exportSettings === 'object'
        ? clone(raw.exportSettings) : {},
      updatedAt:Number(raw.updatedAt) || Date.now()
    };
    const nativeReference = normaliseNativeReference(raw.nativeReference);
    if (nativeReference) project.nativeReference = nativeReference;
    NORMAL_PROJECTS.add(project);
    return project;
  }

  /* Playback belongs to the editor window that owns its animation origin. A
     boolean without that monotonic origin cannot resume coherently in another
     window, so every Hub/runtime snapshot explicitly stores the transport
     stopped while retaining the editable BPM/rate/direction settings. */
  function shareableProject(raw, fallbackMap) {
    const project = normaliseProject(raw, fallbackMap);
    project.playback.playing = false;
    return project;
  }

  function activeSequence(project, value) {
    const sequences = project && project.sequences || [];
    if (!sequences.length) return null;
    if (typeof value === 'string' && sequences.some(sequence => sequence.id === value))
      return sequences.find(sequence => sequence.id === value);
    const index = integer(value, 1, 1, sequences.length) - 1;
    return sequences[index] || sequences.find(sequence => sequence.id === project.activeSequenceId) || sequences[0];
  }

  function mapSignature(map) {
    const safe = normaliseMap(map);
    return JSON.stringify([safe.source, safe.composition, safe.screens.map(screen => [
      screen.id, screen.name, screen.device, screen.raster, screen.followComposition,
      screen.slices.map(slice => [
        slice.id, slice.name, slice.kind, slice.input.vertices, slice.output.vertices
      ])
    ])]);
  }

  function mapSliceRecords(map) {
    return (map.screens || []).flatMap(screen => (screen.slices || []).map(slice => ({
      id:slice.id,
      name:slice.name,
      nameKey:normalisedName(slice.name),
      screenName:screen.name,
      screenKey:normalisedName(screen.name),
      kind:normalisedName(slice.kind),
      slice
    })));
  }

  function relinkGeometryCompatible(left, right) {
    if (left.kind && right.kind && left.kind !== right.kind) return false;
    const a = left.slice.input, b = right.slice.input;
    const ratio = (x, y) => Math.max(x / Math.max(.0001, y), y / Math.max(.0001, x));
    const normal = Math.max(ratio(a.w, b.w), ratio(a.h, b.h));
    const rotated = Math.max(ratio(a.w, b.h), ratio(a.h, b.w));
    const aspectA = a.w / Math.max(.0001, a.h), aspectB = b.w / Math.max(.0001, b.h);
    return Math.min(normal, rotated) <= 4 &&
      Math.max(aspectA / Math.max(.0001, aspectB), aspectB / Math.max(.0001, aspectA)) <= 4;
  }

  function remapExportSettings(raw, idMap) {
    const settings = raw && typeof raw === 'object' ? clone(raw) : {};
    const styles = settings.sliceStyles;
    if (!styles || typeof styles !== 'object') return settings;
    const remapped = {};
    Object.keys(styles).forEach(id => {
      const nextId = idMap.get(id);
      if (nextId && !Object.prototype.hasOwnProperty.call(remapped, nextId))
        remapped[nextId] = styles[id];
    });
    settings.sliceStyles = remapped;
    return settings;
  }

  function reportForMatches(matched, newIds, retiredIds, ignored) {
    const matchedIds = matched.map(item => item.toId);
    const unmatchedIds = unique(retiredIds.concat(newIds));
    const report = {
      matched,
      matchedIds,
      newIds,
      retiredIds,
      unmatchedIds,
      idMap:Object.fromEntries(matched.map(item => [item.fromId, item.toId]))
    };
    report.new = report.newIds;
    report.retired = report.retiredIds;
    report.unmatched = report.unmatchedIds;
    if (ignored) report.ignored = ignored;
    return report;
  }

  function reconcileMap(project, nextMap) {
    const before = normaliseProject(project), map = normaliseMap(nextMap);
    const oldRecords = mapSliceRecords(before.map), newRecords = mapSliceRecords(map);
    if (!map.screens.length) {
      return {project:before,
        report:reportForMatches([], [], [], 'empty-map')};
    }
    const matched = [], idMap = new Map(), usedNew = new Set();
    const register = (oldRecord, newRecord, method) => {
      if (!oldRecord || !newRecord || idMap.has(oldRecord.id) || usedNew.has(newRecord.id)) return false;
      idMap.set(oldRecord.id, newRecord.id); usedNew.add(newRecord.id);
      matched.push({
        from:oldRecord.id,
        to:newRecord.id,
        fromId:oldRecord.id,
        toId:newRecord.id,
        method
      });
      return true;
    };
    const newById = new Map(newRecords.map(record => [record.id, record]));
    oldRecords.forEach(record => register(record, newById.get(record.id), 'exact'));

    const matchUnique = (keyFor, method, compatible) => {
      const oldGroups = new Map(), nextGroups = new Map();
      oldRecords.filter(record => !idMap.has(record.id)).forEach(record => {
        const key = keyFor(record);
        if (!key) return;
        if (!oldGroups.has(key)) oldGroups.set(key, []);
        oldGroups.get(key).push(record);
      });
      newRecords.filter(record => !usedNew.has(record.id)).forEach(record => {
        const key = keyFor(record);
        if (!key) return;
        if (!nextGroups.has(key)) nextGroups.set(key, []);
        nextGroups.get(key).push(record);
      });
      oldGroups.forEach((oldGroup, key) => {
        const nextGroup = nextGroups.get(key) || [];
        if (oldGroup.length === 1 && nextGroup.length === 1 &&
            (!compatible || compatible(oldGroup[0], nextGroup[0])))
          register(oldGroup[0], nextGroup[0], method);
      });
    };
    matchUnique(record => record.screenKey && record.nameKey
      ? `${record.screenKey}\u0000${record.nameKey}` : '', 'screen-name');
    matchUnique(record => record.nameKey, 'slice-name', relinkGeometryCompatible);

    const newIds = newRecords.filter(record => !usedNew.has(record.id)).map(record => record.id);
    const retiredIds = oldRecords.filter(record => !idMap.has(record.id)).map(record => record.id);
    const report = reportForMatches(matched, newIds, retiredIds);
    if (mapSignature(before.map) === mapSignature(map))
      return {project:before, report};

    const remap = ids => unique((ids || []).map(id => idMap.get(id)).filter(Boolean));
    const sequences = before.sequences.map(sequence => Object.assign({}, clone(sequence), {
      steps:sequence.steps.map(step => ({sliceIds:remap(step.sliceIds)}))
    }));
    const views = before.views.map(view => ({
      id:view.id,
      name:view.name,
      builtin:view.id === ALL_VIEW_ID,
      visibleSliceIds:unique(remap(view.visibleSliceIds)
        .concat(view.id === ALL_VIEW_ID ? newIds : []))
    }));
    let nativeReference = before.nativeReference;
    if (nativeReference) {
      // A relink can preserve an authored slice while Arena gives it a new ID.
      // Keep the old XML identity as a metadata alias; native serialization
      // still exports the new Arena ID. Copy first so Undo keeps its reference.
      nativeReference = clone(nativeReference);
      const aliases = nativeReference.nativeIdMap || (nativeReference.nativeIdMap = {});
      aliases.slices = aliases.slices || {}; aliases.screens = aliases.screens || {};
      const originalId = (kind, id) => aliases[kind][id] || (/^\d+$/.test(id) ? id : null);
      const screenSources = new Map(), sourceTargets = new Map();
      oldRecords.forEach(record => {
        const targetId = idMap.get(record.id), target = targetId && newById.get(targetId);
        if (!target) return;
        const sliceSource = originalId('slices', record.id);
        if (sliceSource) aliases.slices[target.id] = sliceSource;
        const sourceScreenId = record.slice.screenId, targetScreenId = target.slice.screenId;
        const screenSource = originalId('screens', sourceScreenId);
        if (!screenSource) return;
        if (!screenSources.has(targetScreenId)) screenSources.set(targetScreenId, new Set());
        if (!sourceTargets.has(screenSource)) sourceTargets.set(screenSource, new Set());
        screenSources.get(targetScreenId).add(screenSource);
        sourceTargets.get(screenSource).add(targetScreenId);
      });
      screenSources.forEach((sources, targetId) => {
        const sourceId = [...sources][0];
        if (sources.size === 1 && sourceTargets.get(sourceId).size === 1)
          aliases.screens[targetId] = sourceId;
      });
    }
    const nextProject = normaliseProject(Object.assign({}, before, {
      map,
      sequences,
      views,
      nativeReference,
      exportSettings:remapExportSettings(before.exportSettings, idMap),
      updatedAt:Date.now()
    }));
    return {project:nextProject, report};
  }

  function adoptMap(project, nextMap) {
    return reconcileMap(project, nextMap).project;
  }

  function directedStep(rawIndex, count, direction) {
    const total = Math.max(1, count), raw = Math.floor(Number(rawIndex) || 0);
    if (direction === 'Reverse') return ((total - 1 - raw) % total + total) % total;
    if (direction === 'Bounce' && total > 1) {
      const period = total * 2 - 2, phase = ((raw % period) + period) % period;
      return phase < total ? phase : period - phase;
    }
    return ((raw % total) + total) % total;
  }

  function stepLevels(sequence, rawIndex, direction, echoes, headOpacity) {
    const levels = new Map();
    if (!sequence || !sequence.steps.length) return levels;
    const echoCount = integer(echoes, 1, 1, 64);
    for (let echo = 0; echo < echoCount; echo++) {
      const step = directedStep(Math.floor(rawIndex) - echo, sequence.steps.length, direction);
      const opacity = clamp(typeof headOpacity === 'function' ? headOpacity(echo, echoCount)
        : (headOpacity == null ? 1 : headOpacity) * (1 - echo / echoCount), 0, 1);
      (sequence.steps[step].sliceIds || []).forEach(id => levels.set(id,
        Math.max(levels.get(id) || 0, opacity)));
    }
    return levels;
  }

  function packedColor(value, fallback) {
    if (typeof value === 'string' && /^(#|rgb|hsl|transparent)/i.test(value)) return value;
    const number = Number.isFinite(Number(value)) ? Number(value) >>> 0 : fallback >>> 0;
    const alpha = (number >>> 24) & 255;
    return `rgba(${(number >>> 16) & 255} ${(number >>> 8) & 255} ${number & 255} / ${(alpha / 255).toFixed(3)})`;
  }

  function makePath(ctx, points) {
    if (!points || points.length < 3) return false;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
    ctx.closePath(); return true;
  }

  function layoutMap(map, width, height, padding, options) {
    const supplied = padding && typeof padding === 'object'
      ? padding : (options && typeof options === 'object' ? options : {});
    const pad = Math.max(0, Number(padding && typeof padding === 'object'
      ? supplied.padding : padding) || 0);
    const safe = normaliseMap(map);
    const fit = Math.min((width - pad * 2) / safe.composition.width,
      (height - pad * 2) / safe.composition.height);
    const baseScale = Number.isFinite(fit) && fit > 0 ? fit : 1;
    const zoom = clamp(Number(supplied.zoom) || 1, .01, 128);
    const sx = baseScale * zoom;
    const offsetX = (width - safe.composition.width * sx) / 2 +
      (Number(supplied.panX) || 0);
    const offsetY = (height - safe.composition.height * sx) / 2 +
      (Number(supplied.panY) || 0);
    const visible = supplied.visibleIds == null
      ? null : new Set(idsFromCollection(supplied.visibleIds));
    return {
      map:safe, scale:sx, baseScale, zoom, offsetX, offsetY,
      slices:flatSlices(safe).filter(slice => !visible || visible.has(slice.id)).map(slice => {
        const points = slice.input.vertices.map(point => ({
          x:offsetX + point.x * sx, y:offsetY + point.y * sx
        }));
        return Object.assign({}, slice, {points, box:vertexBounds(points)});
      })
    };
  }

  function render(ctx, project, options) {
    const opts = options || {}, canvas = ctx.canvas || {};
    const width = Math.max(1, Number(opts.width) || canvas.width || 1);
    const height = Math.max(1, Number(opts.height) || canvas.height || 1);
    /* Editor and Source frames already hold a normalised project. Revalidating
       thousands of slice vertices and up to 1024 steps on every animation
       frame is quadratic-looking work in the hottest path, so only unknown
       external objects pay that boundary cost. */
    const safe = project && NORMAL_PROJECTS.has(project) ? project : normaliseProject(project);
    const pixel = safe.pixelMap;
    const layout = layoutMap(safe.map, width, height, {
      padding:opts.padding == null ? 0 : opts.padding,
      zoom:opts.zoom,
      panX:opts.panX,
      panY:opts.panY,
      visibleIds:opts.visibleIds
    });
    const levels = opts.levels instanceof Map ? opts.levels : new Map(
      [...(opts.activeIds || [])].map(id => [id, 1]));
    const color1 = packedColor(opts.color1 == null ? pixel.color1 : opts.color1, DEFAULT_COLORS.color1);
    const color2 = packedColor(opts.color2 == null ? pixel.color2 : opts.color2, DEFAULT_COLORS.color2);
    const inactive = packedColor(opts.inactive == null ? DEFAULT_COLORS.inactive : opts.inactive, DEFAULT_COLORS.inactive);
    const grid = packedColor(opts.gridColor == null ? pixel.gridColor : opts.gridColor, DEFAULT_COLORS.grid);
    const numX = integer(opts.numX, pixel.numX, 1, 128), numY = integer(opts.numY, pixel.numY, 1, 128);
    const mapMode = opts.mapMode == null ? safe.mode === 'pixelmap' : !!opts.mapMode;
    const labels = opts.showLabels == null ? pixel.showLabels : !!opts.showLabels;
    const sliceGuides = opts.showSliceGuides !== false;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.filter = 'none';
    if (!opts.transparent && !pixel.transparent) {
      ctx.fillStyle = opts.background || '#030405'; ctx.fillRect(0, 0, width, height);
    } else ctx.clearRect(0, 0, width, height);

    const checkerWidth = Math.max(1, safe.map.composition.width / numX * layout.scale);
    const checkerHeight = Math.max(1, safe.map.composition.height / numY * layout.scale);
    /* Input slices may overlap (including exact duplicates routed to different
       Outputs). Painting in map order let a later inactive slice cover an
       earlier active one with black. Preserve layout order for interaction,
       but paint inactive geometry first and stronger chase levels last. */
    const paintSlices = layout.slices.map((slice, order) => ({
      slice, order, level:clamp(levels.get(slice.id) || 0, 0, 1)
    })).sort((a, b) => mapMode ? a.order - b.order
      : ((a.level > 0) - (b.level > 0)) || a.level - b.level || a.order - b.order);
    paintSlices.forEach(({slice, level}) => {
      if (!makePath(ctx, slice.points)) return;
      ctx.save(); ctx.clip();
      ctx.globalAlpha = mapMode ? 1 : (level > 0 ? level : (opts.inactiveOpacity == null ? 0.28 : opts.inactiveOpacity));
      if (mapMode || level > 0) {
        /* Anchor parity in Composition space, never at a slice's left edge.
           Rendering both colors as independent cells also preserves per-color
           alpha instead of compositing translucent Color 2 over Color 1. */
        const firstColumn = Math.floor((slice.box.x - layout.offsetX) / checkerWidth);
        const lastColumn = Math.ceil((slice.box.x + slice.box.w - layout.offsetX) / checkerWidth) - 1;
        const firstRow = Math.floor((slice.box.y - layout.offsetY) / checkerHeight);
        const lastRow = Math.ceil((slice.box.y + slice.box.h - layout.offsetY) / checkerHeight) - 1;
        for (let row = firstRow; row <= lastRow; row++)
          for (let column = firstColumn; column <= lastColumn; column++) {
            ctx.fillStyle = ((column + row) & 1) === 0 ? color2 : color1;
            ctx.fillRect(layout.offsetX + column * checkerWidth,
              layout.offsetY + row * checkerHeight, checkerWidth, checkerHeight);
          }
      } else {
        ctx.fillStyle = inactive;
        ctx.fillRect(slice.box.x - 1, slice.box.y - 1, slice.box.w + 2, slice.box.h + 2);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      if (sliceGuides) {
        makePath(ctx, slice.points);
        ctx.strokeStyle = level > 0 && !mapMode ? color2 : grid;
        ctx.lineWidth = level > 0 && !mapMode ? Math.max(1.5, layout.scale * 2) : Math.max(1, layout.scale);
        ctx.stroke();
      }
      if (sliceGuides && labels && slice.box.w >= 42 && slice.box.h >= 20) {
        ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = level > 0 && !mapMode ? '#ffffff' : '#aeb6c3';
        ctx.font = `${clamp(Math.round(Math.min(slice.box.h * 0.18, slice.box.w / Math.max(5, slice.name.length * 0.65))), 8, 16)}px system-ui,sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
        ctx.fillText(slice.name, slice.box.x + slice.box.w / 2, slice.box.y + slice.box.h / 2,
          Math.max(20, slice.box.w - 8)); ctx.restore();
      }
    });
    ctx.restore();
    return layout;
  }

  const sourceSpec = Object.freeze({
    'Sequence':       {node:'ParamRange', kind:'range', def:1, min:1, max:128},
    'Step':           {node:'ParamRange', kind:'range', def:0, min:0, max:1},
    'Auto Play':      {node:'Param', kind:'bool', def:1, min:0, max:1},
    'Steps / Beat':   {node:'ParamChoice', kind:'choice', options:['1/4','1/2','1','2','4'], def:'1'},
    'Direction':      {node:'ParamChoice', kind:'choice', options:DIRECTIONS.slice(), def:'Forward'},
    'Echoes':         {node:'ParamRange', kind:'range', def:1, min:1, max:16},
    'Sustain':        {node:'ParamRange', kind:'range', def:0.2, min:0, max:1},
    'Release':        {node:'ParamRange', kind:'range', def:0.8, min:0, max:1},
    /* Appended so positional value arrays authored before schema 2 retain the
       meaning of every existing control. Missing values resolve to Linear. */
    'Envelope':       {node:'ParamChoice', kind:'choice', options:['Linear'],
      optionLabels:['Linear'], def:'Linear'}
  });

  let currentProject = null;
  let currentSliceTree = null;

  function setCurrentProject(value) {
    currentProject = shareableProject(value, currentSliceTree || checkeredMap(8, 8));
    return currentProject;
  }

  function sourceEnvelope(project, value) {
    const envelopes = project && project.envelopes || [];
    if (typeof value === 'number' && Number.isInteger(value))
      return value > 0 ? envelopes[value - 1] || null : null;
    const wanted = idText(value);
    if (!wanted || normalisedName(wanted) === 'linear') return null;
    return envelopes.find(envelope => envelope.id === wanted) ||
      envelopes.find(envelope => envelope.name === wanted) || null;
  }

  function sourceLevels(project, options) {
    const safe = project && NORMAL_PROJECTS.has(project) ? project : normaliseProject(project);
    const opts = options || {};
    const sequence = activeSequence(safe, opts.sequence == null ? safe.activeSequenceId : opts.sequence);
    const raw = Number.isFinite(Number(opts.rawStep)) ? Number(opts.rawStep) : 0;
    const fraction = raw - Math.floor(raw);
    const direction = DIRECTIONS.includes(opts.direction) ? opts.direction : 'Forward';
    const echoes = integer(opts.echoes, 1, 1, 16);
    const sustain = clamp(Number.isFinite(Number(opts.sustain)) ? Number(opts.sustain) : .2, 0, 1);
    const release = clamp(Number.isFinite(Number(opts.release)) ? Number(opts.release) : .8, sustain, 1);
    const envelope = sourceEnvelope(safe, opts.envelope);
    return stepLevels(sequence, raw, direction, echoes, echo => {
      // Each step has its own age across the Echoes duration. Fading all echoes
      // with the newest step causes the entire trail to blink out together.
      const phase = (fraction + echo) / echoes;
      // Named curves are effect value against normalized animation time and
      // replace Sustain/Release; their authored peaks must remain reachable.
      if (envelope) return sampleEnvelope(envelope, phase);
      if (phase <= sustain) return 1;
      if (phase >= release) return 0;
      return 1 - (phase - sustain) / Math.max(.000001, release - sustain);
    });
  }

  function drawSource(ctx, read, width, height, time, info) {
    const project = currentProject || setCurrentProject(null);
    const sequence = activeSequence(project, read('Sequence', 1));
    const count = sequence && sequence.steps.length || 1;
    const auto = !!read('Auto Play', 1);
    const rateLabel = String(read('Steps / Beat', '1'));
    const rate = STEP_RATES[rateLabel] || Number(rateLabel) || 1;
    const direction = DIRECTIONS.includes(read('Direction', 'Forward'))
      ? read('Direction', 'Forward') : 'Forward';
    const beats = Number(info && info.beats) || 0;
    const manual = clamp(Number(read('Step', 0)) || 0, 0, 1);
    // Keep the intra-step phase when an external Timeline/BPM/FFT animation
    // drives Step. A fixed endpoint still selects the final step explicitly.
    const raw = auto ? beats * rate : manual >= 1 ? count - 1 : manual * count;
    const levels = sourceLevels(project, {
      sequence:read('Sequence', 1), rawStep:raw, direction,
      echoes:read('Echoes', 1), sustain:read('Sustain', .2),
      release:read('Release', .8), envelope:read('Envelope', 'Linear')
    });
    render(ctx, project, {
      width, height, levels, mapMode:false, background:'#000',
      inactive:project.pixelMap.transparent ? 'transparent' : '#000',
      inactiveOpacity:1, showLabels:false, showSliceGuides:false
    });
  }

  /* Sequences and the Checkered raster are authored once in Chaser. A Source
     exposes only live transport controls, matching the referenced workflow;
     newly opened clips inherit the editor's current audition settings. */
  function sourceParameters() {
    const spec = clone(sourceSpec), project = currentProject;
    if (!project) return spec;
    const sequence = activeSequence(project, project.activeSequenceId);
    const sequenceIndex = Math.max(0, project.sequences.indexOf(sequence));
    spec.Sequence.def = sequenceIndex + 1;
    spec.Step.def = sequence && sequence.steps.length > 1
      ? project.activeStep / sequence.steps.length : 0;
    spec['Steps / Beat'].def = project.playback.stepsPerBeat;
    spec.Direction.def = project.playback.direction;
    spec.Envelope.options = ['Linear', ...project.envelopes.map(envelope => envelope.id)];
    spec.Envelope.optionLabels = ['Linear', ...project.envelopes.map(envelope => envelope.name)];
    return spec;
  }

  const api = {
    schema:SCHEMA,
    sourceName:SOURCE_NAME,
    sourceGroup:Object.freeze({
      group:'SHOWAVE Sources', kind:'source', track:'video', local:true,
      items:Object.freeze([SOURCE_NAME]),
      note:'SHOWAVE extension: slice sequence and Checkered pixel-map raster. Physical output remains in SHOWAVE Map.'
    }),
    distributions:DISTRIBUTIONS,
    directions:DIRECTIONS,
    factoryDirections:FACTORY_DIRECTIONS,
    stepRates:Object.freeze(Object.assign({}, STEP_RATES)),
    sourceParameters,
    pixelOrder,
    normaliseMap,
    checkeredMap,
    flatSlices,
    createProject,
    normaliseProject,
    shareableProject,
    activeSequence,
    activeView,
    visibleSliceIds,
    activeEnvelope,
    sampleEnvelope,
    factoryPattern,
    shuffleSteps,
    reconcileMap,
    adoptMap,
    directedStep,
    stepLevels,
    sourceLevels,
    mapSignature,
    layoutMap,
    render,
    drawSource,
    get project() { return currentProject || setCurrentProject(null); },
    get liveMap() { return currentSliceTree ? normaliseMap(currentSliceTree) : null; },
    setProject:setCurrentProject
  };

  global.OpenLiveChaser = Object.freeze(api);

  const Hub = global.OpenLiveHub;
  if (Hub && typeof Hub.get === 'function') {
    const stored = Hub.get('chaser.project', null);
    if (stored) setCurrentProject(stored);
    if (typeof Hub.subscribe === 'function') Hub.subscribe('chaser.project', value => {
      if (value) setCurrentProject(value);
    }, {immediate:false});
  }
  const Bus = global.ArenaBus;
  if (Bus && typeof Bus.onSlices === 'function') Bus.onSlices(tree => {
    currentSliceTree = normaliseMap(tree);
    if (!currentProject) setCurrentProject(null);
  });
})(window);
