/* ===========================================================================
   openlive-screen-render.js — the WebGL2 renderer for Advanced Output.
   ---------------------------------------------------------------------------
   This is the stage that actually puts a warped, edge-blended slice on a
   physical-ish output. Everything it does is transcribed from two verbatim
   sources, not invented:

     - the per-slice vertex + fragment program compiled into Arena.exe
       (0x22a7a98-0x22a9900 soft-edge variant, 0x2ee8d20-0x2ee9200 simple),
     - the soft-edge blend shader at 0x22aa39x, reproduced exactly below.

   THE GEOMETRY CHAIN, per slice, per vertex (contract order, and the reason
   this file exists at all):

       (u,v) in [0,1]^2
         -> S(u,v)        piecewise-cubic Bezier patch, output-rect space
         -> H * S(u,v)    3x3 projective, perspective divide, screen space
         -> gl_Position

       (u,v) -> flip -> InputRect (AFFINE, never projective) -> /texSize -> uv

   Both warp stages COMPOSE. They are not alternatives. The manual's headline
   workflow — "use the big corner points for perspective warping and their baby
   brothers for additional bezier warping" — is only expressible if H is applied
   to the bezier result, so that is what happens here. advanced-output.js picks
   one stage or the other and never evaluates the stored homography at all;
   that is the defect this file exists to not repeat.

   WHY A MESH AND NOT A TRANSFORM. A CSS matrix / single drawImage can express
   at most a homography, and only a homography. It cannot express S(u,v), which
   is a curved surface. It also cannot give the blend a per-fragment ramp. So
   each slice is tessellated into an (N+1)^2 vertex grid and drawn as 2N^2
   indexed triangles. The control net rides in an RGBA32F texture and is fetched
   per vertex, so the grid size is not capped by uniform-array packing limits.

   PERSPECTIVE CORRECTNESS. Arena carries no q/w to the fragment stage either
   (see the verbatim vertex program: gl_Position = WorldViewProj * vec4(vPosition,1)
   and uv is a plain varying), so under a strong homography the texture is
   correct only to the density of the mesh. Raise meshDensity for a hard keystone.

   MASK AND SCREEN PASSES
     - An Input/Slice Mask clips only its owning Slice in composition space. The
       Slice's own OutputRect + warp still place the surviving pixels, exactly as
       input-selection.htm requires. A standalone <SliceMask> is associated with
       the nearest preceding pixel Slice because the current clone model stores
       both as flat siblings; an ordinary Slice carrying `maskshape` needs no
       inference and clips itself directly.
     - An Output <Mask> is destructive at its position in <layers>: it removes
       pixels from slices already drawn underneath it, while later slices remain
       untouched. That is the manual's explicit stack contract.
     - Slices and masks render into one per-Screen RGBA FBO. Screen-level
       Brightness/Contrast/RGB/Opacity are then applied exactly once in a final
       full-screen shader, preserving the documented Screen-stage order and
       avoiding per-Slice quantisation. In particular, Screen Opacity must scale
       the already composited alpha only once where slices overlap. None of these
       passes performs a GPU-to-CPU readback.

   WHAT THIS FILE DELIBERATELY DOES NOT DO
     - It never calls WEBGL_lose_context.loseContext(). See dispose().
     - The flat clone model cannot preserve BOTH an ordinary Slice's independent
       rectangular InputRect and an intrinsic `maskshape` contour in the same
       record. For the shipped preset shapes, the contour bounds reconstruct the
       rectangle exactly. A separately stored <SliceMask> keeps both geometries
       and is therefore the lossless path.

   COLOUR COMPENSATION, an open disagreement stated rather than papered over.
   Arena's slice shader has a SCALAR brightness and a per-channel `rgbAdjust`
   that is ADDED right after the sample (c = texture*blacken + rgbAdjust), which
   makes its Red/Green/Blue an OFFSET. This file treats Red/Green/Blue as a
   per-channel GAIN folded into brightness, defaulting to 1 over a 0..2 slider.
   The manual is no help — "each slice can have its brightness, contrast and
   red, green and blue channels adjusted" fits either reading — and the live
   AdvancedOutput.xml stores none of them because they are all at default. So
   the operation stays as it is: flipping it would change the meaning of every
   stored value and the range of a shipped control on the strength of one line
   of a transcribed shader. u_rgbAdjust is wired and held at zero, ready.

   HOW SLICES STACK. In <layers> order, index 0 first and therefore back-most,
   with plain premultiplied source-over and nothing else. A slice has no blend
   mode and no opacity of its own — no field in the XML, no mixer in either of
   Arena's two slice shaders, no SliceBlend symbol in the binary — so the one
   thing this file must not do is invent one. slice-routing.htm: "the slice will
   simply render all content with straight alpha on top of the other slices."

   Public: window.OpenLiveScreenRender.create(canvas[, opts]) -> renderer
       renderer.setSetup(setup)
       renderer.renderScreen(screenId, sourceCanvasOrTexture[, opts])
       renderer.renderFinalScreen(screenId, composedCanvasOrTexture[, opts])
       renderer.renderEditor(ctx2d, screenId[, opts])
       renderer.pick(screenId, {x,y}[, opts]) -> {sliceId, handle, ...} | null
       renderer.dispose()
   Classic script. No modules, no libraries, no network.
   =========================================================================== */
(() => {
'use strict';

/* Uint16 indices stay valid while (N+1)^2 < 65536, i.e. N <= 254. 128 is well
   inside that and is already absurd for a projector-sized slice. */
const MAX_MESH = 128;
const MIN_MESH = 1;

const DEFAULTS = {
  meshDensity: 24,      /* cells per axis; 2*24^2 = 1152 triangles per slice */
  /* No configured overlap means no fade. Edge blending is derived from real
     neighbouring Slice overlap; inventing a band on a lone widthless Slice
     vignettes the programme and contradicts OpenLiveScreens.softEdgeAlpha. */
  softEdgeWidth: 0,
  softEdgePower: 2,     /* <ParamRange name="Power" default="2"> */
  softEdgeLuminance: 0.5,  /* shader uniform luminanceCtrl "// default 0.5" */
  softEdgeGamma: 2.2,      /* shader uniform gamma "// default 2.2" */
  handleRadius: 8,      /* homographyDragger.png hit radius, in ctx px */
  controlRadius: 5      /* warpCtrlDragger.png hit radius, in ctx px */
};

/* The editor overlay's palette. Module scope, not create() scope: it is a plain
   constant with no per-renderer state, and keeping it out here means it is
   already initialised on the no-WebGL paths, where a create()-scope `const`
   declared after an early return would stay in its temporal dead zone and make
   the first renderEditor() call throw. Callers override per-key via opts.colors. */
const COLORS = {
  slice: 'rgba(120,190,255,0.85)', sliceFill: 'rgba(120,190,255,0.10)',
  selected: 'rgba(255,190,60,1)', selectedFill: 'rgba(255,190,60,0.16)',
  mask: 'rgba(255,90,90,0.9)', net: 'rgba(255,255,255,0.28)',
  ctrl: 'rgba(255,255,255,0.9)', corner: 'rgba(255,235,120,1)',
  guide: 'rgba(0,220,180,0.55)', label: 'rgba(255,255,255,0.85)',
  softEdge: 'rgba(255,120,255,0.55)'
};

/* ---------------------------------------------------------------------------
   value coercion. Every number in a decoded AdvancedOutput.xml arrives as a
   STRING ("1920", "1.999999999999999778"), so nothing may be trusted as numeric.
   --------------------------------------------------------------------------- */
const isNum = v => typeof v === 'number' && isFinite(v);
function num(v, d) {
  if (typeof v === 'string') { const n = parseFloat(v); return isNum(n) ? n : d; }
  return isNum(v) ? v : d;
}
function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'string') return v !== '0' && v.toLowerCase() !== 'false';
  return !!v;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const P = (x, y) => ({ x: x, y: y });

/* a vertex may be {x,y}, [x,y] or a stringly-typed pair */
function pt(v) {
  if (!v) return P(0, 0);
  if (Array.isArray(v)) return P(num(v[0], 0), num(v[1], 0));
  return P(num(v.x, 0), num(v.y, 0));
}

/* ---------------------------------------------------------------------------
   model normalisation.

   Three shapes have to be read by the same code and there is no way around it:
     1. openlive-screens.js  — setup.screens(), screen.slices(), slice.inputRect
     2. extracted/arena-advanced-output.json — screen.layers, slice.InputRect,
        params nested as params.Common.Name.value
     3. advanced-output.js's editor model — flat slice.softEdgeEnable, .opacity
   Every accessor below therefore tries the callable form, then the array form,
   then the flat property, then the named Params block.
   --------------------------------------------------------------------------- */
function callOrValue(owner, key) {
  if (!owner) return undefined;
  const v = owner[key];
  if (typeof v === 'function') { try { return v.call(owner); } catch (e) { return undefined; } }
  return v;
}
function listOf(owner, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = callOrValue(owner, keys[i]);
    if (Array.isArray(v)) return v;
  }
  return [];
}
const screensOf = setup => listOf(setup, ['screens', 'Screens', 'screenList']);
const slicesOf  = screen => listOf(screen, ['slices', 'layers', 'Layers', 'sliceList']);

/* unwrap {tag,type,default,value} -> value */
const unwrap = v => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v;

/* Look a parameter up by any of its spellings, first as a flat property, then
   inside any named Params block. Arena's block names (Common/Input/Output/
   Warping/Black Level Compensation/...) are not stable enough across the three
   model shapes to key on, so every block is searched. */
function prop(node, names) {
  if (!node) return undefined;
  for (let i = 0; i < names.length; i++) {
    const v = node[names[i]];
    if (v !== undefined && v !== null) return unwrap(v);
  }
  const blocks = node.params || node.Params;
  if (blocks && typeof blocks === 'object') {
    const keys = Object.keys(blocks);
    for (let b = 0; b < keys.length; b++) {
      const blk = blocks[keys[b]];
      if (!blk || typeof blk !== 'object') continue;
      for (let i = 0; i < names.length; i++) {
        const v = blk[names[i]];
        if (v !== undefined && v !== null) return unwrap(v);
      }
    }
  }
  return undefined;
}
const propNum  = (node, names, d) => num(prop(node, names), d);
const propBool = (node, names, d) => bool(prop(node, names), d);

/* InputRect / OutputRect -> 4 (or N) vertices in their own space */
function rectVerts(slice, which) {
  const keys = which === 'input'
    ? ['inputRect', 'InputRect', 'inputContour', 'InputContour']
    : ['outputRect', 'OutputRect', 'outputContour', 'OutputContour'];
  for (let i = 0; i < keys.length; i++) {
    let r = callOrValue(slice, keys[i]);
    if (!r) continue;
    if (Array.isArray(r)) return r.map(pt);
    const v = r.vertices || r.points || r.Vertices;
    if (Array.isArray(v)) return v.map(pt);
  }
  return [];
}

/* <Warper><BezierWarper controlWidth controlHeight><vertices>...  */
function warperOf(slice) {
  const w = callOrValue(slice, 'warper') || callOrValue(slice, 'Warper') || {};
  const b = w.bezier || w.BezierWarper || w.bezierWarper || null;
  const h = w.homography || w.Homography || null;
  let ctrl = [], cw = 0, ch = 0;
  if (b) {
    const raw = Array.isArray(b) ? b : (b.vertices || b.points || b.Vertices);
    if (Array.isArray(raw)) ctrl = raw.map(pt);
    cw = num(b.controlWidth, 0) || num(b.cw, 0);
    ch = num(b.controlHeight, 0) || num(b.ch, 0);
    /* a square net with no declared dimensions is the common hand-built case */
    if (!cw && ctrl.length) { const s = Math.round(Math.sqrt(ctrl.length)); if (s * s === ctrl.length) cw = ch = s; }
    if (cw && !ch) ch = Math.floor(ctrl.length / cw);
    if (ctrl.length < cw * ch) { cw = 0; ch = 0; ctrl = []; }
  }
  return {
    ctrl: ctrl, cw: cw, ch: ch,
    src: h && Array.isArray(h.src) ? h.src.map(pt) : null,
    dst: h && Array.isArray(h.dst) ? h.dst.map(pt) : null
  };
}

/* Screen device size. OutputDeviceDmx carries no width/height at all, so the
   composition texture size is the last resort rather than a hardcoded 1920. */
function screenSize(screen, setup) {
  const dev = callOrValue(screen, 'outputDevice') || callOrValue(screen, 'OutputDevice') || {};
  const inner = dev.kind ? dev : (dev.device || dev);
  let w = num(inner.width, 0), h = num(inner.height, 0);
  if (!w) w = propNum(screen, ['width', 'Width'], 0);
  if (!h) h = propNum(screen, ['height', 'Height'], 0);
  if (!w || !h) { const c = compSize(setup); if (!w) w = c.w; if (!h) h = c.h; }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}
function compSize(setup) {
  const c = (setup && (callOrValue(setup, 'compositionTexture') ||
                       callOrValue(setup, 'CurrentCompositionTextureSize'))) || {};
  return { w: Math.max(1, num(c.width, 1920)), h: Math.max(1, num(c.height, 1080)) };
}
const idOf = (o, i) => String(prop(o, ['uniqueId', 'id', 'Id']) !== undefined
  ? prop(o, ['uniqueId', 'id', 'Id']) : ('#' + i));
const nameOf = (o, d) => { const n = prop(o, ['name', 'Name']); return n === undefined || n === '' ? d : String(n); };

/* ---------------------------------------------------------------------------
   math. These are CPU mirrors of the shader code below — the editor overlay and
   pick() must land on exactly the pixels the GPU drew, so there is one formula
   written twice rather than two formulas. openlive-screens.js owns the public
   versions of solveHomography/evalBezier; we call them where we can, but the
   GPU needs raw mat3 numbers, so the local solve stays authoritative and the
   sibling's is used as a CROSS-CHECK (see probeInterop).
   --------------------------------------------------------------------------- */

/* 4-point DLT, h33 fixed to 1: 8 unknowns, 8 equations, Gaussian elimination
   with partial pivoting. Hartley normalisation first — the inputs are raw
   pixels up to 1920, which conditions the system badly enough to matter. */
function solveHomography(src, dst) {
  if (!src || !dst || src.length < 4 || dst.length < 4) return null;
  const ns = normalise(src), nd = normalise(dst);
  if (!ns || !nd) return null;
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const s = ns.pts[i], d = nd.pts[i];
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]); b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]); b.push(d.y);
  }
  const h = gauss(A, b);
  if (!h) return null;
  /* Hn = T_dst * H * T_src^-1, un-normalised back into pixel space */
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const H = mul3(mul3(inv3(nd.T), Hn), ns.T);
  if (!H) return null;
  /* scale so h33 == 1 when it can be; keeps the numbers readable and matches
     the DLT convention the contract specifies */
  if (Math.abs(H[8]) > 1e-12) for (let i = 0; i < 9; i++) H[i] /= H[8];
  for (let i = 0; i < 9; i++) if (!isFinite(H[i])) return null;
  /* Degeneracy guard, and it has to be a RESIDUAL check rather than a pivot
     check. With three collinear src points the system is rank-deficient, but
     Hartley normalisation plus floating point still hands back a pivot around
     1e-13 — large enough to clear any absolute epsilon, and the "solution"
     then collapses three of the four corners onto (0,0). The only reliable
     test is whether H actually does what it was asked to do. Tolerance scales
     with the dst diagonal; a real solve lands within ~1e-13 px of it. */
  const bb = polyBounds(dst.slice(0, 4));
  const tol = Math.max(1e-6, Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) * 1e-6);
  for (let i = 0; i < 4; i++) {
    const g = applyH(H, src[i]);
    if (!isFinite(g.x) || !isFinite(g.y) ||
        Math.hypot(g.x - dst[i].x, g.y - dst[i].y) > tol) return null;
  }
  return H;
}
function normalise(p) {
  let cx = 0, cy = 0;
  for (let i = 0; i < 4; i++) { cx += p[i].x; cy += p[i].y; }
  cx /= 4; cy /= 4;
  let d = 0;
  for (let i = 0; i < 4; i++) d += Math.hypot(p[i].x - cx, p[i].y - cy);
  d /= 4;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  const out = [];
  for (let i = 0; i < 4; i++) out.push(P((p[i].x - cx) * s, (p[i].y - cy) * s));
  return { pts: out, T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] };
}
function gauss(A, b) {
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;     /* three collinear points */
    if (piv !== c) { const t = M[piv]; M[piv] = M[c]; M[c] = t; }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = [];
  for (let i = 0; i < n; i++) { x.push(M[i][n] / M[i][i]); if (!isFinite(x[i])) return null; }
  return x;
}
const IDENT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function mul3(a, b) {
  if (!a || !b) return null;
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
function inv3(m) {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
          (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
          (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k];
}
function applyH(H, p) {
  if (!H) return P(p.x, p.y);
  let w = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(w) < 1e-9) w = w < 0 ? -1e-9 : 1e-9;   /* sign-preserving guard */
  return P((H[0] * p.x + H[1] * p.y + H[2]) / w, (H[3] * p.x + H[4] * p.y + H[5]) / w);
}

/* Piecewise CUBIC, always — never a degree-(cw-1) Bernstein over the whole net.
   controlWidth = 3*nPatchesX + 1, so a 7x7 net is four bicubic patches sharing
   boundary rows/columns, not one sextic surface. Getting this wrong changes the
   shape of every subdivided warp. */
function bern3(t) {
  const m = 1 - t;
  return [m * m * m, 3 * t * m * m, 3 * t * t * m, t * t * t];
}
function evalPatch(ctrl, cw, ch, u, v) {
  const nx = Math.max(1, (cw - 1) / 3 | 0), ny = Math.max(1, (ch - 1) / 3 | 0);
  const fu = clamp(u, 0, 1) * nx, fv = clamp(v, 0, 1) * ny;
  const pu = Math.min(Math.floor(fu), nx - 1), pv = Math.min(Math.floor(fv), ny - 1);
  const bu = bern3(fu - pu), bv = bern3(fv - pv);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) {
    const wj = bv[j], row = Math.min(3 * pv + j, ch - 1) * cw;
    for (let i = 0; i < 4; i++) {
      const p = ctrl[row + Math.min(3 * pu + i, cw - 1)];
      if (!p) continue;
      const w = bu[i] * wj;
      x += p.x * w; y += p.y * w;
    }
  }
  return P(x, y);
}
/* Linear point mode: the same 16 slots read as a bilinear mesh */
function evalGrid(ctrl, cw, ch, u, v) {
  const gx = clamp(u, 0, 0.999999) * (cw - 1), gy = clamp(v, 0, 0.999999) * (ch - 1);
  const i = Math.floor(gx), j = Math.floor(gy), fu = gx - i, fv = gy - j;
  const at = (a, b) => ctrl[clamp(b, 0, ch - 1) * cw + clamp(a, 0, cw - 1)] || P(0, 0);
  const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
  return P((a.x + (b.x - a.x) * fu) + ((c.x + (d.x - c.x) * fu) - (a.x + (b.x - a.x) * fu)) * fv,
           (a.y + (b.y - a.y) * fu) + ((c.y + (d.y - c.y) * fu) - (a.y + (b.y - a.y) * fu)) * fv);
}
/* v[0] v[1] top edge, v[3] v[2] bottom — matches Arena's stored corner order.
   On a parallelogram (which a rotated InputRect always is) this IS the affine
   sliceMatrix; bilinear is the graceful superset for hand-edited quads. */
function quadLerp(v, u, t) {
  const ax = v[0].x + (v[1].x - v[0].x) * u, ay = v[0].y + (v[1].y - v[0].y) * u;
  const bx = v[3].x + (v[2].x - v[3].x) * u, by = v[3].y + (v[2].y - v[3].y) * u;
  return P(ax + (bx - ax) * t, ay + (by - ay) * t);
}
const polyBounds = v => v.reduce((r, p) => ({
  x0: Math.min(r.x0, p.x), y0: Math.min(r.y0, p.y),
  x1: Math.max(r.x1, p.x), y1: Math.max(r.y1, p.y)
}), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

function pointInPoly(p, v) {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const a = v[i], b = v[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

/* The blend curve, verbatim from the fragment shader at Arena.exe 0x22aa39x:
     t < 0.5 : f = L * (2t)^P
     t >= 0.5: f = 1 - (1-L) * (2(1-t))^P
     out_c   = clamp( f^(1/G_c), 0, 1 )
   Two opposed ramps sum to 1.0 at the crossover, which is the whole point and
   the reason a 1-(x/w)^(1/P) approximation shows a bright seam instead. */
function blendCurve(t, power, lum) {
  t = clamp(t, 0, 1);
  return t < 0.5 ? lum * Math.pow(2 * t, power)
                 : 1 - (1 - lum) * Math.pow(2 * (1 - t), power);
}

/* =========================================================================
   GLSL. #version must be the very first characters of the source string.
   ========================================================================= */
const VERT = `#version 300 es
precision highp float;
precision highp int;
in vec2 a_par;                 // (u,v) over the slice's own unit square
uniform sampler2D u_ctrl;      // RGBA32F, cw x ch, .xy = control point in src space
uniform ivec2 u_ctrlSize;
uniform int   u_mode;          // 0 = output quad, 1 = bicubic patch, 2 = linear net
uniform mat3  u_H;             // homography, column-major, src space -> screen px
uniform vec2  u_quad[4];       // OutputRect corners, screen px
uniform vec2  u_in[4];         // InputRect corners, composition px
uniform vec2  u_texSize;       // composition texture size, px
uniform vec2  u_screen;        // screen device size, px
uniform vec2  u_flip;          // flipXY, 0 or 1 per axis
out vec2 v_uv;                 // composition texcoord
out vec2 v_par;                // unflipped parametric coord, for the soft edge

vec4 bern3( float t ) {
  float m = 1.0 - t;
  return vec4( m*m*m, 3.0*t*m*m, 3.0*t*t*m, t*t*t );
}
vec2 fetchCtrl( int col, int row ) {
  return texelFetch( u_ctrl,
    ivec2( clamp( col, 0, u_ctrlSize.x - 1 ), clamp( row, 0, u_ctrlSize.y - 1 ) ), 0 ).xy;
}
// controlWidth = 3*nPatches + 1: locate the patch, then a plain bicubic on the
// 4x4 block that starts at column 3*pu, row 3*pv. Adjacent patches share their
// boundary column/row, so the surface is C0 by construction.
vec2 patchAt( vec2 p ) {
  int nx = max( 1, ( u_ctrlSize.x - 1 ) / 3 );
  int ny = max( 1, ( u_ctrlSize.y - 1 ) / 3 );
  float fu = clamp( p.x, 0.0, 1.0 ) * float( nx );
  float fv = clamp( p.y, 0.0, 1.0 ) * float( ny );
  int pu = min( int( floor( fu ) ), nx - 1 );
  int pv = min( int( floor( fv ) ), ny - 1 );
  vec4 bu = bern3( fu - float( pu ) );
  vec4 bv = bern3( fv - float( pv ) );
  vec2 s = vec2( 0.0 );
  for ( int j = 0; j < 4; j++ )
    for ( int i = 0; i < 4; i++ )
      s += bu[i] * bv[j] * fetchCtrl( 3 * pu + i, 3 * pv + j );
  return s;
}
vec2 gridAt( vec2 p ) {
  float gx = clamp( p.x, 0.0, 0.999999 ) * float( u_ctrlSize.x - 1 );
  float gy = clamp( p.y, 0.0, 0.999999 ) * float( u_ctrlSize.y - 1 );
  int i = int( floor( gx ) ), j = int( floor( gy ) );
  vec2 f = vec2( gx - float( i ), gy - float( j ) );
  vec2 a = fetchCtrl( i, j ),     b = fetchCtrl( i + 1, j );
  vec2 c = fetchCtrl( i, j + 1 ), d = fetchCtrl( i + 1, j + 1 );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
vec2 quadAt( vec2 q0, vec2 q1, vec2 q2, vec2 q3, vec2 p ) {
  return mix( mix( q0, q1, p.x ), mix( q3, q2, p.x ), p.y );
}
void main() {
  vec2 base = u_mode == 1 ? patchAt( a_par )
            : u_mode == 2 ? gridAt( a_par )
            : quadAt( u_quad[0], u_quad[1], u_quad[2], u_quad[3], a_par );
  vec3 hp = u_H * vec3( base, 1.0 );
  float w = hp.z;
  if ( abs( w ) < 1e-9 ) w = w < 0.0 ? -1e-9 : 1e-9;
  vec2 sp = hp.xy / w;

  // input side is AFFINE and the flip happens in UV space BEFORE the matrix,
  // exactly as in the compiled vertex program
  vec2 coords = mix( a_par, 1.0 - a_par, u_flip );
  v_uv  = quadAt( u_in[0], u_in[1], u_in[2], u_in[3], coords ) / u_texSize;
  v_par = a_par;

  gl_Position = vec4( sp.x / u_screen.x * 2.0 - 1.0,
                      1.0 - sp.y / u_screen.y * 2.0, 0.0, 1.0 );
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_par;
uniform sampler2D u_tex;
uniform sampler2D u_maskPts;   // 1xN RGBA32F points in composition pixels
uniform int   u_maskCount;     // 0 = no Slice Mask
uniform int   u_maskKeepInside;
uniform vec2  u_texSize;
uniform int   u_useSoftEdge;
uniform int   u_isKey;
uniform float u_blackBg;
uniform float u_opacity;     // textureOpacity: the ROUTED SOURCE's opacity, gated
uniform vec4  u_rgbAdjust;   // Arena's rgbAdjust, added straight after the sample
uniform vec3  u_blackLevel;  // Black Level Compensation, a FLOOR outside the blend
uniform vec3  u_brightness;  // brightness folded with the R/G/B compensation
uniform float u_contrast;
uniform vec4  u_edge;        // soft-edge widths L,R,T,B as a fraction of the axis
uniform vec3  u_gamma;       // Gamma Red / Green / Blue
uniform float u_softPower;   // Soft Edge Power
uniform float u_softLum;     // Soft Edge Luminance
out vec4 fragColor0;

bool maskContains( vec2 p ) {
  bool inside = false;
  int j = u_maskCount - 1;
  for ( int i = 0; i < u_maskCount; i++ ) {
    vec2 a = texelFetch( u_maskPts, ivec2( i, 0 ), 0 ).xy;
    vec2 b = texelFetch( u_maskPts, ivec2( j, 0 ), 0 ).xy;
    bool crosses = ( a.y > p.y ) != ( b.y > p.y );
    float den = b.y - a.y;
    if ( abs( den ) < 1e-9 ) den = den < 0.0 ? -1e-9 : 1e-9;
    if ( crosses && p.x < ( b.x - a.x ) * ( p.y - a.y ) / den + a.x ) inside = !inside;
    j = i;
  }
  return inside;
}

void main() {
  vec2 uv = v_uv;
  if ( u_maskCount >= 3 ) {
    bool inside = maskContains( uv * u_texSize );
    if ( ( u_maskKeepInside != 0 && !inside ) || ( u_maskKeepInside == 0 && inside ) ) discard;
  }
  // maxUv is (1,1) here: this renderer never atlases the composition texture
  vec2 wrapUv = u_useSoftEdge != 0 ? clamp( mod( uv, vec2( 1.0 ) ), vec2( 0.0 ), vec2( 1.0 ) ) : uv;
  float blacken = ( wrapUv.x > 1.0 || wrapUv.x < 0.0 || wrapUv.y > 1.0 || wrapUv.y < 0.0 ) ? 0.0 : 1.0;
  if ( u_useSoftEdge == 0 ) wrapUv = clamp( wrapUv, vec2( 0.0 ), vec2( 1.0 ) );

  // Arena's slice shader runs on the composition texture, which is PREMULTIPLIED
  // (the layer mask shader says so in as many words: "We're getting premultiplied
  // input and we need to output premultiplied as well"). This renderer uploads
  // with UNPACK_PREMULTIPLY_ALPHA_WEBGL false, so premultiply at the sample and
  // then follow Arena step for step. On an opaque source the two spaces are
  // identical, which is why nothing already verified moves.
  vec4 texel = texture( u_tex, wrapUv );
  texel.rgb *= texel.a;

  vec4 c = texel * blacken + u_rgbAdjust;
  // Contrast's midpoint must stay premultiplied too. Transparent pixels must
  // remain transparent black or ONE/ONE_MINUS_SRC_ALPHA adds a grey halo.
  c.rgb = mix( vec3( 0.5 * c.a ), c.rgb * u_brightness, u_contrast );

  bool hasBlackLevel = u_blackLevel.r > 0.0 || u_blackLevel.g > 0.0 || u_blackLevel.b > 0.0;

  if ( u_useSoftEdge != 0 ) {
    // t = normalised distance across the overlap band, 0 at the outer edge.
    // The narrowest active edge wins, so a corner blends on both axes.
    float t = 1.0;
    if ( u_edge.x > 0.0 ) t = min( t, v_par.x / u_edge.x );
    if ( u_edge.y > 0.0 ) t = min( t, ( 1.0 - v_par.x ) / u_edge.y );
    if ( u_edge.z > 0.0 ) t = min( t, v_par.y / u_edge.z );
    if ( u_edge.w > 0.0 ) t = min( t, ( 1.0 - v_par.y ) / u_edge.w );
    t = clamp( t, 0.0, 1.0 );
    float sw = step( 0.5, t );
    float curve = u_softLum * pow( 2.0 * t, u_softPower ) * ( 1.0 - sw )
                + ( 1.0 - ( 1.0 - u_softLum ) * pow( 2.0 * ( 1.0 - t ), u_softPower ) ) * sw;
    vec3 blend = clamp( pow( vec3( curve ), 1.0 / u_gamma ), 0.0, 1.0 );
    // Black Level Compensation goes HERE, before the ramp multiply, and only
    // where the ramp is essentially 1 — Arena gates it with
    // step(0.99, dot(sec.rgb, lumi)) under the comment "limits brightness
    // compensation to area not affected by soft edge". edge-blending.htm says
    // the same thing in words: it exists "by allowing you to make the
    // NON-OVERLAPPING areas slightly brighter". Lifting the floor inside the
    // fade would defeat the fade. It is a max(), not an add, and it forces
    // alpha to 1 because a lifted black is opaque light.
    if ( hasBlackLevel ) {
      float amt = step( 0.99, dot( blend, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      c.rgb = max( u_blackLevel * amt, c.rgb );
      c.a = 1.0;
    }
    // RGB ONLY. Arena's blend shader writes alpha 1.0 and the mask multiplies
    // the colour, which is the physics: a projector in the fade zone emits less
    // LIGHT, it does not become transparent. Attenuating alpha as well would
    // apply the curve twice once the result is composited, and two opposed
    // ramps would then sum to f^2 instead of 1.0 — a visible dark seam, the
    // mirror image of the bright seam the old code produced.
    c.rgb *= blend;
  } else if ( hasBlackLevel ) {
    // no soft edge: Arena lifts the floor across the whole slice, ungated
    c.rgb = max( u_blackLevel, c.rgb );
    c.a = 1.0;
  }

  // ---- the tail, in Arena's order: isKey -> opacity -> Black BG ----
  // "Renders alpha channels as black and white for use with broadcast mixers."
  // Arena writes c = vec4(c.a) — greyscale AND keyed, so a key slice still lets
  // what is behind it through where the alpha is zero.
  if ( u_isKey != 0 ) c = vec4( c.a );
  // textureOpacity, scaling RGB and alpha together because we are premultiplied
  c *= u_opacity;
  // Black BG LAST, which is the whole point: "Renders this slice on a solid
  // black background, EVEN WHEN ITS OPACITY IS FULLY DOWN." At opacity 0 the
  // line above has driven rgb and alpha to 0; forcing alpha to 1 here yields
  // opaque black. Run the other way round it would yield the slice at full
  // strength, which is the bug this ordering exists to prevent.
  if ( u_blackBg > 0.0 ) c.a = max( c.a, u_blackBg );
  fragColor0 = c;                                // already premultiplied
}
`;

/* Full-screen passes share one oversized triangle. v_uv spans 0..1 over the
   viewport; the portions above 1 belong to the off-screen part of the triangle.
   Keep this in WebGL/FBO orientation. DOM uploads have their top row at v=0 and
   are corrected explicitly by FINAL_FRAG; globally reversing this vertex UV
   fixes renderFinalScreen() but vertically mirrors renderScreen()'s FBO. */
const FULL_VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2( float( ( gl_VertexID & 1 ) * 4 - 1 ), float( ( gl_VertexID >> 1 ) * 4 - 1 ) );
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4( p, 0.0, 1.0 );
}
`;

/* Output Mask contours are rasterised into the Screen FBO's stencil attachment.
   Triangle-fan pieces toggle stencil parity, so concave freeform polygons work
   without an O(points*pixels) point-in-polygon loop in the fragment shader. */
const MASK_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
uniform vec2 u_modelSize;
void main() {
  gl_Position = vec4( a_pos.x / u_modelSize.x * 2.0 - 1.0,
                      1.0 - a_pos.y / u_modelSize.y * 2.0, 0.0, 1.0 );
}
`;
const MASK_STENCIL_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor0;
void main() { fragColor0 = vec4( 0.0 ); }
`;
const CLEAR_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor0;
void main() { fragColor0 = vec4( 0.0 ); }
`;

/* Screen colour correction belongs after slice compositing. In premultiplied
   space the contrast midpoint is 0.5*alpha, exactly like the Slice shader. */
const FINAL_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_screenTex;
uniform int u_flipY;
uniform vec3 u_brightness;
uniform float u_contrast;
uniform float u_opacity;
out vec4 fragColor0;
void main() {
  vec2 uv = u_flipY != 0 ? vec2( v_uv.x, 1.0 - v_uv.y ) : v_uv;
  vec4 c = texture( u_screenTex, uv );
  c.rgb = mix( vec3( 0.5 * c.a ), c.rgb * u_brightness, u_contrast );
  fragColor0 = c * u_opacity;
}
`;

/* =========================================================================
   renderer
   ========================================================================= */
function create(canvas, options) {
  const opts0 = options || {};
  const r = {
    canvas: canvas || null,
    gl: null,
    setup: null,
    lastError: null,
    lastWarning: null,
    defaults: Object.assign({}, DEFAULTS, opts0.defaults),
    stats: {
      screens: 0, slices: 0, drawn: 0, triangles: 0, ms: 0,
      outputMasks: 0, sliceMasks: 0, skippedMasks: 0, reconstructedSliceMasks: 0,
      skippedDmx: 0, finalPasses: 0
    },
    interop: { screens: false, evalBezier: null, solveHomography: null }
  };

  /* ---- CPU state, declared BEFORE the no-GL returns ---------------------
     The header promises that renderEditor and pick keep working when WebGL2 is
     missing. That promise is only true if their closure state is initialised
     before the three early `return` paths below: a `let`/`const` declared
     further down stays in its temporal dead zone FOREVER once one of those
     returns fires, so the first renderEditor() call would throw ReferenceError
     instead of drawing. `gl` is here for the same reason — dispose() reads it.
     These four declarations must stay above the first early return. */
  let gl = null;
  const cache = new WeakMap();     /* per-slice derived state, see sliceState */
  const views = new Map();         /* last view box per screen; pick() reuses it */
  const toView = (v, p) => P(v.ox + p.x * v.scale, v.oy + p.y * v.scale);

  if (!canvas || typeof canvas.getContext !== 'function') {
    r.lastError = 'no canvas';
    return finish(attachCpuSurface());
  }

  /* ---- context ------------------------------------------------------- */
  try {
    gl = canvas.getContext('webgl2', Object.assign({
      alpha: true, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: true,
      /* readPixels/toDataURL after the fact is how the DMX sampling path and
         every pixel test get at the result, so keep the buffer around */
      preserveDrawingBuffer: true
    }, opts0.contextAttributes));
  } catch (err) { gl = null; r.lastError = String((err && err.message) || err); }
  if (!gl) {
    /* Not fatal, and not empty either. renderScreen becomes a no-op — there is
       no GPU to draw with — but the 2D overlay and the hit test are pure CPU
       geometry and are attached in full, which is the header's promise. */
    if (!r.lastError) r.lastError = 'WebGL2 unavailable';
    return finish(attachCpuSurface());
  }
  r.gl = gl;

  /* ---- program ------------------------------------------------------- */
  let prog = null, U = null, meshes = new Map(), ctrlTex = null, srcTex = null, pointTex = null;
  let sampLinear = null, sampNearest = null;
  let maskProg = null, MU = null, clearProg = null, finalProg = null, FU = null, fullVao = null;
  let maskVao = null, maskVbo = null;
  let screenTex = null, screenFbo = null, screenStencil = null, screenTargetW = 0, screenTargetH = 0;
  try {
    prog = link(gl, VERT, FRAG);
    maskProg = link(gl, MASK_VERT, MASK_STENCIL_FRAG);
    clearProg = link(gl, FULL_VERT, CLEAR_FRAG);
    finalProg = link(gl, FULL_VERT, FINAL_FRAG);
    fullVao = gl.createVertexArray();
    U = uniforms(gl, prog, [
      'u_ctrl', 'u_ctrlSize', 'u_mode', 'u_H', 'u_quad', 'u_in', 'u_texSize',
      'u_screen', 'u_flip', 'u_tex', 'u_maskPts', 'u_maskCount', 'u_maskKeepInside',
      'u_useSoftEdge', 'u_isKey', 'u_blackBg',
      'u_opacity', 'u_rgbAdjust', 'u_blackLevel', 'u_brightness', 'u_contrast',
      'u_edge', 'u_gamma', 'u_softPower', 'u_softLum'
    ]);
    MU = uniforms(gl, maskProg, ['u_modelSize']);
    FU = uniforms(gl, finalProg, ['u_screenTex', 'u_flipY', 'u_brightness', 'u_contrast', 'u_opacity']);
    ctrlTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ctrlTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    pointTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pointTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    screenTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, screenTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    screenFbo = gl.createFramebuffer();
    screenStencil = gl.createRenderbuffer();
    maskVao = gl.createVertexArray();
    maskVbo = gl.createBuffer();
    gl.bindVertexArray(maskVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, maskVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    /* Filter mode is a per-SLICE parameter, so it lives in a sampler object
       rather than on the texture — a caller-supplied WebGLTexture must come
       back with its own parameters untouched. */
    sampLinear = gl.createSampler(); sampNearest = gl.createSampler();
    for (const s of [sampLinear, sampNearest]) {
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.samplerParameteri(sampLinear, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(sampLinear, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(sampNearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(sampNearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  } catch (err) {
    r.lastError = String((err && err.message) || err);
    disposeGL();
    gl = null; r.gl = null;
    return finish(attachCpuSurface());
  }

  /* ---- static parametric grids, shared by every slice at that density -- */
  function mesh(n) {
    n = Math.round(clamp(num(n, r.defaults.meshDensity), MIN_MESH, MAX_MESH));
    let m = meshes.get(n);
    if (m) return m;
    const side = n + 1, par = new Float32Array(side * side * 2);
    for (let j = 0, k = 0; j < side; j++)
      for (let i = 0; i < side; i++) { par[k++] = i / n; par[k++] = j / n; }
    const idx = new Uint16Array(n * n * 6);
    for (let j = 0, k = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, par, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    m = { vao: vao, vbo: vbo, ibo: ibo, count: idx.length, n: n };
    meshes.set(n, m);
    return m;
  }

  /* ---- per-slice derived state, cached on a signature of the numbers ----
     `cache` is declared at the top of create(), not here — see the note there. */
  function sliceState(slice) {
    const w = warperOf(slice);
    const out = rectVerts(slice, 'output');
    const sig = JSON.stringify([w.cw, w.ch, w.ctrl, w.src, w.dst, out]);
    let st = cache.get(slice);
    if (st && st.sig === sig) return st;
    st = { sig: sig, warper: w, out: out, H: IDENT3, hasH: false };
    if (w.src && w.dst && w.src.length >= 4 && w.dst.length >= 4) {
      let same = true;
      for (let i = 0; i < 4; i++)
        if (Math.abs(w.src[i].x - w.dst[i].x) > 1e-9 || Math.abs(w.src[i].y - w.dst[i].y) > 1e-9) { same = false; break; }
      if (!same) {
        const H = solveHomography(w.src, w.dst);
        if (H) { st.H = H; st.hasH = true; }
        else r.lastWarning = 'degenerate homography on slice ' + idOf(slice, 0) + '; identity used';
      }
    }
    /* mode: 1 bicubic patch, 2 linear net, 0 plain output quad. A net smaller
       than 4x4 cannot be a cubic patch (Arena only ever writes 3n+1), so it is
       demoted to the bilinear reading rather than silently mis-evaluated. */
    const pm = String(prop(slice, ['pointMode', 'Point Mode', 'warpMode', 'WarpMode']) || '');
    const hasNet = w.cw >= 2 && w.ch >= 2 && w.ctrl.length >= w.cw * w.ch;
    const cubic = w.cw >= 4 && w.ch >= 4;
    if (!hasNet) st.mode = 0;
    else if (/linear grid|^linear$/i.test(pm)) st.mode = 2;
    else if (/^(transform|perspective)$/i.test(pm)) st.mode = 0;
    else st.mode = cubic ? 1 : 2;
    cache.set(slice, st);
    return st;
  }

  /* output-space position of a parametric coord — the CPU twin of the vertex
     shader, used by the editor overlay and by pick() */
  function warpPoint(slice, u, v) {
    const st = sliceState(slice);
    const w = st.warper;
    let base;
    if (st.mode === 1) base = evalBezierVia(w, u, v);
    else if (st.mode === 2) base = evalGrid(w.ctrl, w.cw, w.ch, u, v);
    else {
      const o = st.out;
      if (o.length === 4) base = quadLerp(o, u, v);
      else if (o.length) { const b = polyBounds(o); base = P(b.x0 + (b.x1 - b.x0) * u, b.y0 + (b.y1 - b.y0) * v); }
      else base = P(u, v);
    }
    return st.hasH ? applyH(st.H, base) : base;
  }

  /* ---- interop with openlive-screens.js ------------------------------- */
  /* The sibling owns the public math. We call it, but the GPU needs raw mat3
     numbers so the local solve stays authoritative; the sibling's answers are
     used as a cross-check and the result is reported in renderer.interop.
     The bezier probe is the contract's own decisive test: a 1/3-spaced identity
     net over 1920x1080 must evaluate S(0.25,0.7) = (480,756) exactly. */
  function evalBezierVia(w, u, v) {
    if (r.interop.evalBezier === 'sibling') {
      const S = window.OpenLiveScreens;
      const got = pt(S.evalBezier({ controlWidth: w.cw, controlHeight: w.ch, vertices: w.ctrl }, u, v));
      if (isNum(got.x) && isNum(got.y)) return got;
    }
    return evalPatch(w.ctrl, w.cw, w.ch, u, v);
  }
  function probeInterop() {
    const S = window.OpenLiveScreens;
    r.interop.screens = !!S;
    if (!S) return;
    try {
      if (typeof S.evalBezier === 'function') {
        const net = [];
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) net.push(P(i / 3 * 1920, j / 3 * 1080));
        const g = pt(S.evalBezier({ controlWidth: 4, controlHeight: 4, vertices: net }, 0.25, 0.7));
        r.interop.evalBezier = (Math.abs(g.x - 480) < 1e-6 && Math.abs(g.y - 756) < 1e-6) ? 'sibling' : 'local';
        if (r.interop.evalBezier === 'local')
          r.lastWarning = 'OpenLiveScreens.evalBezier failed the identity-net check (' +
            g.x.toFixed(4) + ',' + g.y.toFixed(4) + ' != 480,756); using the local patch';
      }
    } catch (e) { r.interop.evalBezier = 'local'; }
    try {
      if (typeof S.solveHomography === 'function' && typeof S.applyHomography === 'function') {
        const src = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
        const dst = [P(10, 10), P(110, 20), P(90, 130), P(0, 100)];
        const H = S.solveHomography(src, dst);
        let ok = !!H;
        for (let i = 0; ok && i < 4; i++) {
          const g = pt(S.applyHomography(H, src[i]));
          if (Math.abs(g.x - dst[i].x) > 1e-6 || Math.abs(g.y - dst[i].y) > 1e-6) ok = false;
        }
        r.interop.solveHomography = ok ? 'agrees' : 'disagrees';
      }
    } catch (e) { r.interop.solveHomography = 'disagrees'; }
  }

  /* ---- screen lookup --------------------------------------------------- */
  function findScreen(screenId) {
    const list = screensOf(r.setup);
    /* a screen object is accepted whether or not it is currently in the setup —
       the editor drags one around before it is attached */
    if (screenId && typeof screenId === 'object') return screenId;
    if (typeof screenId === 'number') return list[screenId] || null;
    const want = String(screenId);
    for (let i = 0; i < list.length; i++)
      if (idOf(list[i], i) === want || nameOf(list[i], '') === want) return list[i];
    return null;
  }

  /* =======================================================================
     soft edge parameters
     ======================================================================= */
  function softEdgeEnabled(slice) {
    return propBool(slice, ['softEdgeEnable', 'SoftEdgeEnable', 'softEdge'], false);
  }
  function softEdgeParticipant(slice) {
    if (!slice || !softEdgeEnabled(slice)) return false;
    const type = String(prop(slice, ['type', 'Type']) || 'Slice');
    if (/mask/i.test(type) || /^Dmx/i.test(type) || prop(slice, ['mask']) === true) return false;
    /* Hidden/Bypassed are the persisted operator controls. Do not inspect the
       flat `enabled` property here: renderScreenFrame temporarily writes it to
       gate source runs, and a Slice in another run still defines the physical
       overlap band. */
    if (propBool(slice, ['hidden', 'Hidden'], false) ||
        propBool(slice, ['bypassed', 'Bypassed'], false)) return false;
    /* Plain/legacy records sometimes use enabled as their real persisted
       switch. OpenLiveScreens records always have Params; their short-lived
       enabled=false is only the editor's source-run gate and must be ignored. */
    const modelRecord = slice.params && typeof slice.params === 'object';
    if (!modelRecord && Object.prototype.hasOwnProperty.call(slice, 'enabled') &&
        !bool(slice.enabled, true)) return false;
    return true;
  }
  function clipSoftEdgePoly(poly, axis, bound, keepGreater) {
    const out = [];
    if (!poly.length) return out;
    const coord = p => axis === 0 ? p.x : p.y;
    const inside = p => keepGreater ? coord(p) >= bound - 1e-8 : coord(p) <= bound + 1e-8;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length], b = poly[i];
      const ai = inside(a), bi = inside(b);
      if (ai !== bi) {
        const da = coord(a), db = coord(b), den = db - da;
        if (Math.abs(den) > 1e-12) {
          const t = clamp((bound - da) / den, 0, 1);
          out.push(P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        }
      }
      if (bi) out.push(b);
    }
    return out;
  }
  function clipSoftEdgeUnit(poly) {
    let q = clipSoftEdgePoly(poly, 0, 0, true);
    q = clipSoftEdgePoly(q, 0, 1, false);
    q = clipSoftEdgePoly(q, 1, 0, true);
    return clipSoftEdgePoly(q, 1, 1, false);
  }
  function softEdgePolyArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) * 0.5;
  }
  function derivedSoftEdge(slice, setup) {
    const own = rectVerts(slice, 'input');
    if (own.length < 4 || !setup) return [0, 0, 0, 0];
    /* InputRect is affine by contract: V0 + u(V1-V0) + v(V3-V0).
       Resolve every peer into this Slice's local u/v frame so widths are
       normalised by the target Input extent even for rotated rectangles. */
    const o = own[0], ux = own[1].x - o.x, uy = own[1].y - o.y;
    const vx = own[3].x - o.x, vy = own[3].y - o.y;
    const det = ux * vy - uy * vx;
    if (!isNum(det) || Math.abs(det) < 1e-9) return [0, 0, 0, 0];
    const local = p => {
      const dx = p.x - o.x, dy = p.y - o.y;
      return P((dx * vy - dy * vx) / det, (ux * dy - uy * dx) / det);
    };
    const edge = [0, 0, 0, 0];                 /* L, R, T, B */
    const eps = 1e-5;

    for (const sc of screensOf(setup)) {
      const screenOn = propBool(sc, ['enabled', 'Enabled'],
        !propBool(sc, ['hidden', 'Hidden'], false));
      if (!screenOn || propBool(sc, ['bypassed', 'Bypassed'], false)) continue;
      for (const other of slicesOf(sc)) {
        if (other === slice || !softEdgeParticipant(other)) continue;
        const ov = rectVerts(other, 'input');
        if (ov.length < 4) continue;
        const raw = ov.slice(0, 4).map(local);
        if (raw.some(p => !isNum(p.x) || !isNum(p.y))) continue;
        const rb = polyBounds(raw), clipped = clipSoftEdgeUnit(raw);
        if (clipped.length < 3 || softEdgePolyArea(clipped) <= eps * eps) continue;
        const cb = polyBounds(clipped);
        const crossesLeft = rb.x0 < -eps, crossesRight = rb.x1 > 1 + eps;
        const crossesTop = rb.y0 < -eps, crossesBottom = rb.y1 > 1 + eps;
        const fullHeight = cb.y0 <= eps && cb.y1 >= 1 - eps;
        const fullWidth = cb.x0 <= eps && cb.x1 >= 1 - eps;

        /* A four-uniform-edge shader can represent strip overlap, not a wedge.
           Require the overlap to reach both ends of the orthogonal axis. A
           peer crossing both opposite boundaries is containment, not a facing
           edge, so it is deliberately suppressed. */
        if (fullHeight && crossesLeft !== crossesRight) {
          if (crossesLeft) edge[0] = Math.max(edge[0], clamp(cb.x1, 0, 0.5));
          else edge[1] = Math.max(edge[1], clamp(1 - cb.x0, 0, 0.5));
        }
        if (fullWidth && crossesTop !== crossesBottom) {
          if (crossesTop) edge[2] = Math.max(edge[2], clamp(cb.y1, 0, 0.5));
          else edge[3] = Math.max(edge[3], clamp(1 - cb.y0, 0, 0.5));
        }
      }
    }
    /* The shader applies u_flip to sampling coordinates but evaluates its
       blend band in unflipped v_par coordinates. Move auto bands to the edge
       that displays the overlapping input; explicit output-edge widths below
       remain exactly where the operator put them. */
    if (propBool(slice, ['flipH', 'flipX', 'Flip H'], false)) {
      const x = edge[0]; edge[0] = edge[1]; edge[1] = x;
    }
    if (propBool(slice, ['flipV', 'flipY', 'Flip V'], false)) {
      const y = edge[2]; edge[2] = edge[3]; edge[3] = y;
    }
    return edge;
  }
  function softEdgeOf(slice, screen, setup) {
    const on = softEdgeEnabled(slice);
    if (!on) return null;
    const out = rectVerts(slice, 'output');
    const b = out.length ? polyBounds(out) : { x0: 0, y0: 0, x1: 1, y1: 1 };
    const ew = Math.max(1e-6, b.x1 - b.x0), eh = Math.max(1e-6, b.y1 - b.y0);
    /* a stored width > 1 is read as OUTPUT PIXELS and converted to a fraction
       of that axis; <= 1 is already a fraction */
    const w = (names, extent) => {
      let v = prop(slice, names);
      if (v && typeof v === 'object' && !Array.isArray(v)) v = unwrap(v);
      let n = num(v, NaN);
      if (!isNum(n)) return null;
      if (n <= 0) return 0;
      return clamp(n > 1 ? n / extent : n, 0, 0.5);
    };
    const se = slice && (slice.softEdge || slice.SoftEdge) || null;
    const pick = (flat, names, extent) => {
      if (se && isNum(num(se[flat], NaN))) {
        const n = num(se[flat], 0);
        return n <= 0 ? 0 : clamp(n > 1 ? n / extent : n, 0, 0.5);
      }
      return w(names, extent);
    };
    let L = pick('left',  ['softEdgeLeft',  'Soft Edge Left',  'Left'],  ew);
    let R = pick('right', ['softEdgeRight', 'Soft Edge Right', 'Right'], ew);
    let T = pick('top',   ['softEdgeTop',   'Soft Edge Top',   'Top'],   eh);
    let B = pick('bottom',['softEdgeBottom','Soft Edge Bottom','Bottom'],eh);
    /* Arena derives fade bands from Input-stage overlap. Explicit OpenLive
       sidecar widths remain authoritative, including an explicit zero; only
       missing edges inherit an automatically-derived width. */
    const auto = derivedSoftEdge(slice, setup);
    if (L === null) L = auto[0];
    if (R === null) R = auto[1];
    if (T === null) T = auto[2];
    if (B === null) B = auto[3];
    const edge = [L || 0, R || 0, T || 0, B || 0];
    if (!edge[0] && !edge[1] && !edge[2] && !edge[3]) return null;
    const g = num(prop(setup, ['softEdgeGamma']) !== undefined ? prop(setup, ['softEdgeGamma'])
                : softEdgingParam(setup, ['Gamma']), r.defaults.softEdgeGamma);
    return {
      edge: edge,
      power: Math.max(0.01, num(softEdgingParam(setup, ['Power', 'softEdgePower', 'blendPower']), r.defaults.softEdgePower)),
      lum: clamp(num(softEdgingParam(setup, ['Luminance', 'softEdgeLuminance', 'luminanceCtrl']), r.defaults.softEdgeLuminance), 0, 1),
      gamma: [
        Math.max(0.01, num(softEdgingParam(setup, ['Gamma Red']), g)),
        Math.max(0.01, num(softEdgingParam(setup, ['Gamma Green']), g)),
        Math.max(0.01, num(softEdgingParam(setup, ['Gamma Blue']), g))
      ]
    };
  }
  /* <SoftEdging> is a SINGLE root-level object: soft edge params are global to
     the whole screen setup, not per slice. */
  function softEdgingParam(setup, names) {
    if (!setup) return undefined;
    const se = callOrValue(setup, 'softEdging') || callOrValue(setup, 'SoftEdging');
    let v = prop(se, names);
    if (v === undefined) v = prop(setup, names);
    if (v === undefined && se && se['Soft Edge']) v = prop({ params: { 'Soft Edge': se['Soft Edge'] } }, names);
    return unwrap(v);
  }

  /* =======================================================================
     Mask + final-Screen GPU passes
     ======================================================================= */
  function ensureScreenTarget(w, h) {
    w = Math.max(1, Math.round(num(w, 1)));
    h = Math.max(1, Math.round(num(h, 1)));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, screenTex);
    if (w !== screenTargetW || h !== screenTargetH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, screenStencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      screenTargetW = w; screenTargetH = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, screenFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, screenTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, screenStencil);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      r.lastError = 'Advanced Output screen framebuffer is incomplete';
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
    return true;
  }

  /* Slice Masks are tested in composition space inside the Slice fragment
     shader. A float-texture point list avoids a uniform-array vertex cap;
     RGBA32F is already required by the warp-control texture above. */
  function uploadMaskPoints(points) {
    const n = points && points.length ? points.length : 0;
    const data = new Float32Array(Math.max(1, n) * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = points[i].x;
      data[i * 4 + 1] = points[i].y;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pointTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, Math.max(1, n), 1, 0, gl.RGBA, gl.FLOAT, data);
    return n;
  }

  const typeOf = s => String(prop(s, ['type', 'Type']) || 'Slice');
  const isSliceMask = s => /^SliceMask$/i.test(typeOf(s));
  const isOutputMask = s => !isSliceMask(s) && (/mask/i.test(typeOf(s)) || prop(s, ['mask']) === true);
  const isPixelSlice = s => !!s && !isSliceMask(s) && !isOutputMask(s) && !/^Dmx/i.test(typeOf(s));

  /* Resolume's Invert toggle is ON by default. In that state the familiar crop
     is produced (inside survives); toggling it off produces the literal mask /
     hole (outside survives). output-transformation.htm calls out this naming
     trap explicitly. Missing records therefore default to true. */
  const maskKeepsInside = s => propBool(s, ['Invert', 'invert', 'Mask Invert'], true);

  function warpedMaskOutline(s, steps) {
    const verts = rectVerts(s, 'output');
    if (verts.length !== 4) return verts;
    const out = [], n = Math.max(2, steps | 0);
    const push = (u, v) => out.push(warpPoint(s, u, v));
    for (let i = 0; i < n; i++) push(i / n, 0);
    for (let i = 0; i < n; i++) push(1, i / n);
    for (let i = n; i > 0; i--) push(i / n, 1);
    for (let i = n; i > 0; i--) push(0, i / n);
    return out;
  }

  function applyOutputMask(s, sz) {
    const points = warpedMaskOutline(s, 24);
    const count = points.length;
    if (count < 3) {
      r.stats.skippedMasks++;
      r.lastWarning = 'Output Mask ' + idOf(s, 0) + ' has fewer than three points';
      return false;
    }

    /* A fan from point 0 may overlap itself for a concave polygon. Toggling the
       stencil bit for every covered fan triangle turns those overlaps into the
       even/odd fill rule used by the editor's Canvas contour. */
    const tris = new Float32Array((count - 2) * 6);
    for (let i = 1, k = 0; i < count - 1; i++) {
      const a = points[0], b = points[i], c = points[i + 1];
      tris[k++] = a.x; tris[k++] = a.y;
      tris[k++] = b.x; tris[k++] = b.y;
      tris[k++] = c.x; tris[k++] = c.y;
    }

    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.colorMask(false, false, false, false);
    gl.useProgram(maskProg);
    gl.bindVertexArray(maskVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, maskVbo);
    gl.bufferData(gl.ARRAY_BUFFER, tris, gl.STREAM_DRAW);
    gl.uniform2f(MU.u_modelSize, sz.w, sz.h);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, (count - 2) * 3);

    /* Invert ON is the default crop: clear stencil==0 (outside). Invert OFF is
       a hole: clear stencil!=0 (inside). */
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0x00);
    gl.stencilFunc(maskKeepsInside(s) ? gl.EQUAL : gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.useProgram(clearProg);
    gl.bindVertexArray(fullVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    gl.useProgram(prog);
    r.stats.outputMasks++;
    return true;
  }

  /* A standalone SliceMask is a flat sibling only in this clone model. The UI
     appends it after the selected Slice, so nearest preceding pixel Slice is the
     one deterministic association that retains the manual's owner-only scope.
     Intrinsic `maskshape` on a Slice remains authoritative over this fallback. */
  function associateSliceMasks(order) {
    const owned = new Map();
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      if (!m || !isSliceMask(m) || !propBool(m, ['enabled', 'Enabled'], true) ||
          propBool(m, ['bypassed', 'Bypassed'], false)) continue;
      let owner = null;
      for (let j = i - 1; j >= 0; j--) {
        if (isPixelSlice(order[j])) { owner = order[j]; break; }
      }
      if (!owner) {
        r.stats.skippedMasks++;
        r.lastWarning = 'SliceMask ' + idOf(m, i) + ' has no preceding Slice owner';
      } else if (owned.has(owner)) {
        r.stats.skippedMasks++;
        r.lastWarning = 'multiple flat SliceMasks target Slice ' + idOf(owner, i) + '; nearest one used';
        owned.set(owner, m);
      } else owned.set(owner, m);
    }
    return owned;
  }

  function screenPassValues(screen, o) {
    const noColour = o && o.ignoreScreenColor === true;
    const br = noColour ? 1 : propNum(screen, ['brightness', 'Brightness'], 1);
    return {
      opacity: o && o.ignoreScreenOpacity === true ? 1
        : clamp(propNum(screen, ['opacity', 'Opacity'], 1), 0, 1),
      contrast: noColour ? 1 : propNum(screen, ['contrast', 'Contrast'], 1),
      brightness: noColour ? [1, 1, 1] : [
        br * propNum(screen, ['red', 'Red'], 1),
        br * propNum(screen, ['green', 'Green'], 1),
        br * propNum(screen, ['blue', 'Blue'], 1)
      ]
    };
  }

  function drawFinalTexture(texture, values, flipY) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(finalProg);
    gl.bindVertexArray(fullVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindSampler(0, sampLinear);
    gl.uniform1i(FU.u_screenTex, 0);
    gl.uniform1i(FU.u_flipY, flipY ? 1 : 0);
    gl.uniform3f(FU.u_brightness, values.brightness[0], values.brightness[1], values.brightness[2]);
    gl.uniform1f(FU.u_contrast, values.contrast);
    gl.uniform1f(FU.u_opacity, values.opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    r.stats.finalPasses++;
  }

  /* =======================================================================
     renderScreen
     ======================================================================= */
  function renderScreen(screenId, source, options) {
    if (!gl) return;
    const o = options || {};
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    r.stats.drawn = r.stats.slices = r.stats.outputMasks = r.stats.sliceMasks = 0;
    r.stats.skippedMasks = r.stats.reconstructedSliceMasks = r.stats.skippedDmx = r.stats.triangles = 0;
    r.stats.finalPasses = 0;
    try {
      const screen = findScreen(screenId);
      if (!screen) { r.lastError = 'no screen "' + screenId + '"'; return; }
      const sz = screenSize(screen, r.setup);
      const comp = compSize(r.setup);

      if (o.autoSize !== false && (canvas.width !== sz.w || canvas.height !== sz.h)) {
        canvas.width = sz.w; canvas.height = sz.h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      const cc = o.clearColor || [0, 0, 0, 0];
      gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const screenOn = propBool(screen, ['enabled', 'Enabled'], !propBool(screen, ['hidden', 'Hidden'], false));
      if (!screenOn && o.ignoreHidden !== true) return;

      /* All Slice and Output Mask work lands in one Screen FBO. Screen colour
         and opacity are deliberately absent from the Slice uniforms and run
         once over this finished texture below. */
      if (!ensureScreenTarget(canvas.width, canvas.height)) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const src = bindSource(source, o);
      if (!src) {
        drawFinalTexture(screenTex, screenPassValues(screen, o));
        return;                                  /* cleared Screen is the honest no-source result */
      }

      gl.useProgram(prog);
      gl.uniform1i(U.u_tex, 0);
      gl.uniform1i(U.u_ctrl, 1);
      gl.uniform1i(U.u_maskPts, 2);
      gl.uniform2f(U.u_screen, sz.w, sz.h);
      gl.uniform2f(U.u_texSize, src.w || comp.w, src.h || comp.h);

      /* DRAW ORDER IS THE MODEL'S ORDER, FORWARDS. Array position in <layers>
         is the only carrier of z order (no index attribute exists on a slice),
         and index 0 is drawn first and therefore ends up BACK-most — the same
         direction OpenLiveScreens.ORDER states and the tree displays, so the
         picture and the list can never disagree. o.order:'desc' is a diagnostic
         for proving that overlap actually depends on the order; it is not a
         setting and nothing in the UI sets it. */
      const slices = slicesOf(screen);
      r.stats.slices = slices.length;
      const order = o.order === 'desc' ? slices.slice().reverse() : slices;
      const sliceMasks = associateSliceMasks(order);

      for (let i = 0; i < order.length; i++) {
        const s = order[i];
        if (!s) continue;
        const type = typeOf(s);
        if (isSliceMask(s)) continue;             /* consumed by its owning Slice */
        if (isOutputMask(s)) {
          if (!propBool(s, ['enabled', 'Enabled'], true) || propBool(s, ['bypassed', 'Bypassed'], false)) continue;
          applyOutputMask(s, sz);
          continue;
        }
        if (/^Dmx/i.test(type) && !o.includeDmx) { r.stats.skippedDmx++; continue; }
        if (!propBool(s, ['enabled', 'Enabled'], true)) continue;
        if (propBool(s, ['bypassed', 'Bypassed'], false)) continue;
        drawSlice(s, screen, src, sz, sliceMasks.get(s) || null, o);
      }
      drawFinalTexture(screenTex, screenPassValues(screen, o));
    } catch (err) {
      r.lastError = String((err && err.message) || err);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.bindSampler(0, null);
      gl.useProgram(null);
      r.stats.ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - t0;
    }
  }

  /* Apply only the final per-Screen stage to an already composited raster. The
     routed-source host uses this once after it has combined its source runs, so
     Screen ordering and the one-shot opacity operation survive source routing. */
  function renderFinalScreen(screenId, source, options) {
    if (!gl) return;
    const o = options || {};
    try {
      const screen = findScreen(screenId);
      if (!screen) { r.lastError = 'no screen "' + screenId + '"'; return; }
      const sz = screenSize(screen, r.setup);
      if (o.autoSize !== false && (canvas.width !== sz.w || canvas.height !== sz.h)) {
        canvas.width = sz.w; canvas.height = sz.h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const src = bindSource(source, o);
      if (!src) return;
      /* A DOM source uploaded with UNPACK_FLIP_Y_WEBGL=false has its top row at
         v=0. Internal Screen FBO textures have their top at v=1. Preserve that
         distinction here instead of flipping the shared full-screen pass. */
      drawFinalTexture(src.tex, screenPassValues(screen, o), src.topDown);
    } catch (err) {
      r.lastError = String((err && err.message) || err);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.bindSampler(0, null);
      gl.useProgram(null);
    }
  }

  /* Arena's `textureOpacity`, resolved for one slice.
       - the value is the ROUTED SOURCE's opacity, supplied by the caller, which
         is the only place that knows what a layer's fader is doing. Accepts a
         number, a {sliceId: number} map or a function(slice) -> number.
       - `Input Opacity` off means "always show it, regardless of the layer's
         opacity value" [English.xml], i.e. the shader's useInputOpacity == 0,
         i.e. opacity 1. Applying the gate here as well as in the router is
         idempotent, and it means a caller that passes the RAW layer opacity
         still gets Arena's behaviour.
       - `Input Bypass/Solo` on plus an uncomposed source forces 0
         (respectInputUncomposed && textureIsUncomposed). */
  function sourceOpacityFor(s, o) {
    const useInput = propBool(s, ['inputOpacity', 'InputOpacity', 'Input Opacity'], true);
    const respect = propBool(s, ['inputBypassSolo', 'InputBypassSolo', 'Input Bypass/Solo'], true);
    if (respect && pickPer(o.sliceUncomposed, s, false) === true) return 0;
    if (!useInput) return 1;
    return clamp(num(pickPer(o.sliceOpacity, s, 1), 1), 0, 1);
  }
  /* number | map keyed by uniqueId | function(slice) */
  function pickPer(v, s, dflt) {
    if (v === undefined || v === null) return dflt;
    if (typeof v === 'function') { const x = v(s); return x === undefined ? dflt : x; }
    if (typeof v === 'object') {
      const id = String(prop(s, ['uniqueId', 'UniqueId', 'id']) || '');
      if (typeof v.get === 'function') { const x = v.get(id); return x === undefined ? dflt : x; }
      return Object.prototype.hasOwnProperty.call(v, id) ? v[id] : dflt;
    }
    return v;
  }

  function drawSlice(s, screen, src, sz, attachedMask, o) {
    const st = sliceState(s);
    let inRect = rectVerts(s, 'input');
    const intrinsicMask = propNum(s, ['maskshape', 'Mask Shape'], 0) > 0;
    const maskNode = intrinsicMask ? s : attachedMask;
    const maskPoints = maskNode ? rectVerts(maskNode, 'input') : [];
    /* The legacy intrinsic representation overwrites InputRect with the mask
       contour. Preset contours retain the original rectangle as their bounds,
       so reconstruct that sampling quad while clipping against every point.
       A standalone SliceMask leaves the owner's InputRect untouched. */
    if (intrinsicMask && inRect.length !== 4 && inRect.length >= 3) {
      const b = polyBounds(inRect);
      inRect = [P(b.x0, b.y0), P(b.x1, b.y0), P(b.x1, b.y1), P(b.x0, b.y1)];
      r.stats.reconstructedSliceMasks++;
    }
    if (inRect.length < 4 || (st.mode === 0 && st.out.length < 4)) return;   /* a polygon slice has no quad to sample */

    const maskCount = maskPoints.length >= 3 ? uploadMaskPoints(maskPoints) : 0;
    gl.uniform1i(U.u_maskCount, maskCount);
    gl.uniform1i(U.u_maskKeepInside, maskNode && maskKeepsInside(maskNode) ? 1 : 0);
    if (maskCount) r.stats.sliceMasks++;

    /* control net -> RGBA32F. 16 floats for the usual 4x4; re-uploading it per
       draw is cheaper than tracking per-slice textures. */
    const w = st.warper;
    if (st.mode === 1 || st.mode === 2) {
      const cw = w.cw, ch = w.ch, data = new Float32Array(cw * ch * 4);
      for (let k = 0; k < cw * ch; k++) {
        const p = w.ctrl[k] || P(0, 0);
        data[k * 4] = p.x; data[k * 4 + 1] = p.y;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctrlTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cw, ch, 0, gl.RGBA, gl.FLOAT, data);
      gl.uniform2i(U.u_ctrlSize, cw, ch);
    } else {
      gl.uniform2i(U.u_ctrlSize, 1, 1);
    }
    gl.uniform1i(U.u_mode, st.mode);

    const q = st.out.length >= 4 ? st.out : [P(0, 0), P(sz.w, 0), P(sz.w, sz.h), P(0, sz.h)];
    gl.uniform2fv(U.u_quad, new Float32Array([q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]));
    gl.uniform2fv(U.u_in, new Float32Array([inRect[0].x, inRect[0].y, inRect[1].x, inRect[1].y,
                                            inRect[2].x, inRect[2].y, inRect[3].x, inRect[3].y]));
    /* GLSL mat3 uniforms are column-major; our H is row-major */
    const H = st.H;
    gl.uniformMatrix3fv(U.u_H, false, new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]));

    const fh = propBool(s, ['flipH', 'flipX', 'Flip H'], false);
    const fv = propBool(s, ['flipV', 'flipY', 'Flip V'], false);
    gl.uniform2f(U.u_flip, fh ? 1 : 0, fv ? 1 : 0);

    const se = softEdgeOf(s, screen, r.setup);
    gl.uniform1i(U.u_useSoftEdge, se ? 1 : 0);
    gl.uniform4f(U.u_edge, se ? se.edge[0] : 0, se ? se.edge[1] : 0, se ? se.edge[2] : 0, se ? se.edge[3] : 0);
    gl.uniform1f(U.u_softPower, se ? se.power : 2);
    gl.uniform1f(U.u_softLum, se ? se.lum : 0.5);
    gl.uniform3f(U.u_gamma, se ? se.gamma[0] : 2.2, se ? se.gamma[1] : 2.2, se ? se.gamma[2] : 2.2);

    /* Slice compensation only. Screen compensation is one final FBO pass so the
       two documented scopes remain distinct and Screen Opacity sees the complete
       source-over result. */
    const br = propNum(s, ['brightness', 'Brightness'], 1);
    gl.uniform3f(U.u_brightness,
      br * propNum(s, ['red', 'Red'], 1),
      br * propNum(s, ['green', 'Green'], 1),
      br * propNum(s, ['blue', 'Blue'], 1));
    gl.uniform1f(U.u_contrast, propNum(s, ['contrast', 'Contrast'], 1));
    /* Arena's per-slice rgbAdjust is ADDED straight after the sample; the
       clone's Red/Green/Blue are a GAIN and are folded into u_brightness above.
       See COLOUR COMPENSATION in the file header — the two disagree, the
       evidence is not strong enough to flip a stored control, and feeding this
       uniform the gain would be worse than leaving it neutral. */
    gl.uniform4f(U.u_rgbAdjust, 0, 0, 0, 0);
    /* Black Level Compensation: "increase the amount of red, green or blue in
       the black of this slice", and it lifts only the NON-OVERLAPPING area.
       Applied in the shader as a gated floor, not as an offset here. */
    gl.uniform3f(U.u_blackLevel,
      clamp(propNum(s, ['BRed', 'blackRed', 'bRed'], 0), 0, 1),
      clamp(propNum(s, ['BGreen', 'blackGreen', 'bGreen'], 0), 0, 1),
      clamp(propNum(s, ['BBlue', 'blackBlue', 'bBlue'], 0), 0, 1));
    gl.uniform1i(U.u_isKey, propBool(s, ['isKey', 'Is Key'], false) ? 1 : 0);
    gl.uniform1f(U.u_blackBg, propBool(s, ['blackBG', 'blackBg', 'Black BG'], false) ? 1 : 0);
    /* THE ONLY OPACITY A SLICE HAS. Arena's fragment shader exposes exactly one,
       `uniform float textureOpacity`, and it is a property of the INPUT — the
       routed layer or group's own opacity — gated by the per-slice toggles
       useInputOpacity ("follow the layer's opacity value, or always show it")
       and respectInputUncomposed. There is no per-slice opacity param anywhere:
       the file format has none, English.xml scopes Opacity to Screen and
       Lumiverse only, and neither slice shader has a mix amount. Reading an
       invented `Opacity` off the slice, which is what used to happen here, is
       exactly the field the model says does not exist. */
    gl.uniform1f(U.u_opacity, sourceOpacityFor(s, o));

    /* SLICES DO NOT BLEND. slice-routing.htm: "The slice will simply render all
       content with straight alpha on top of the other slices." There is no
       blend-mode field on a slice in the XML, no mixer in either slice shader,
       and no SliceBlend symbol in the binary — so source-over is not a default
       here, it is the only mode Arena has, and none is invented.
       The fragment stage emits premultiplied colour, hence ONE as the source
       factor: dst = src + dst*(1 - src.a), which is Arena's own doBlend.
       blend:'add' stays available as an EXPLICIT clone-only diagnostic for
       previewing what two edge-blended projectors do optically — that sum
       happens on the wall, between two physical outputs, never inside one
       screen's framebuffer. It is never selected automatically. */
    gl.blendFunc(gl.ONE, o.blend === 'add' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);

    const filt = String(prop(s, ['filterMode', 'Filter Mode']) || '');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.bindSampler(0, /nearest/i.test(filt) ? sampNearest : sampLinear);

    const m = mesh(prop(s, ['meshDensity', 'mesh']) !== undefined
      ? prop(s, ['meshDensity', 'mesh']) : (o.meshDensity !== undefined ? o.meshDensity : r.defaults.meshDensity));
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    r.stats.drawn++;
    r.stats.triangles += m.count / 3;
  }

  /* ---- source ---------------------------------------------------------- */
  /* Accepts a canvas/image/video/ImageBitmap, a raw WebGLTexture belonging to
     THIS context, or {texture,width,height}. A foreign-context texture cannot
     be detected from here, so that is the caller's contract. */
  function bindSource(source, o) {
    if (!source) return null;
    const comp = compSize(r.setup);
    const sizeOf = (w, h) => ({ w: num(w, 0) || comp.w, h: num(h, 0) || comp.h });
    if (typeof WebGLTexture !== 'undefined' && source instanceof WebGLTexture) {
      const s = o.sourceSize || {};
      return Object.assign({ tex: source, topDown: o.sourceTopDown === true }, sizeOf(s.width, s.height));
    }
    if (source.texture && typeof WebGLTexture !== 'undefined' && source.texture instanceof WebGLTexture)
      return Object.assign({
        tex: source.texture,
        topDown: source.topDown === true || o.sourceTopDown === true
      }, sizeOf(source.width, source.height));

    const w = num(source.videoWidth, 0) || num(source.naturalWidth, 0) || num(source.width, 0);
    const h = num(source.videoHeight, 0) || num(source.naturalHeight, 0) || num(source.height, 0);
    if (!w || !h) return null;
    if (source.readyState !== undefined && source.readyState < 2) return null;   /* video with no frame yet */
    if (!srcTex) {
      srcTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    /* row 0 of the image is the TOP of the composition and stays at t=0, which
       is why the shader can divide composition-Y straight into the texcoord */
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) { r.lastError = 'source upload: ' + String((err && err.message) || err); return null; }
    /* the composition texture size, not the pixel size of a scaled preview, is
       what InputRect coordinates are expressed in */
    return { tex: srcTex, w: comp.w, h: comp.h, topDown: true };
  }

  /* =======================================================================
     renderEditor — a 2D overlay, so it works even when WebGL2 is missing.

     That is a load-bearing claim, not a slogan: nothing from here down touches
     `gl`. Everything is function declarations (hoisted) over closure state that
     create() declares before its no-GL returns, and attachCpuSurface() puts all
     of it on the renderer object on EVERY path — WebGL2 present, WebGL2 absent,
     no canvas at all, or shader link failure. VERIFIED HEADLESSLY under node
     against a canvas whose getContext returns null: renderEditor issues the
     full set of drawing operations and pick() returns the slice under the
     point. `views` and `toView` live at the top of create() for that reason.
     ======================================================================= */
  function viewFor(screen, screenKey, ctx, o) {
    const mode = o.mode === 'input' ? 'input' : 'output';
    const sp = mode === 'input' ? (() => { const c = compSize(r.setup); return { w: c.w, h: c.h }; })()
                                : screenSize(screen, r.setup);
    let scale = num(o.scale, 0), ox = num(o.ox, NaN), oy = num(o.oy, NaN);
    const W = num(o.width, 0) || (ctx.canvas ? ctx.canvas.width : 0) || sp.w;
    const H = num(o.height, 0) || (ctx.canvas ? ctx.canvas.height : 0) || sp.h;
    const pad = num(o.padding, 18);
    if (!scale) scale = Math.min((W - pad * 2) / sp.w, (H - pad * 2) / sp.h) || 1;
    if (!isNum(ox)) ox = (W - sp.w * scale) / 2;
    if (!isNum(oy)) oy = (H - sp.h * scale) / 2;
    const v = { mode: mode, scale: scale, ox: ox, oy: oy, w: sp.w, h: sp.h, key: screenKey };
    views.set(screenKey, v);
    return v;
  }
  function renderEditor(ctx, screenId, options) {
    const o = options || {};
    try {
      if (!ctx || typeof ctx.beginPath !== 'function') { r.lastError = 'renderEditor needs a 2D context'; return; }
      const screen = findScreen(screenId);
      if (!screen) { r.lastError = 'no screen "' + screenId + '"'; return; }
      const key = String(screenId && typeof screenId === 'object' ? idOf(screen, 0) : screenId);
      const v = viewFor(screen, key, ctx, o);
      const C = Object.assign({}, COLORS, o.colors);
      const sel = {};
      (o.selected || []).forEach(id => { sel[String(id)] = true; });
      const steps = Math.max(2, Math.round(num(o.outlineSteps, 12)));

      ctx.save();
      ctx.lineJoin = 'round';

      if (o.showGuides !== false) drawGuides(ctx, screen, v, C);

      const slices = slicesOf(screen);
      for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        if (!s) continue;
        const id = idOf(s, i);
        const isSel = !!sel[id];
        const type = String(prop(s, ['type', 'Type']) || 'Slice');
        const isMask = /mask/i.test(type) || prop(s, ['mask']) === true;
        const poly = outline(s, v, steps);
        if (poly.length < 3) continue;

        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x, poly[k].y);
        ctx.closePath();
        /* Editor overlays are stroke-only so they cannot be mistaken for
           Screen opacity or colour processing in the underlying frame. */
        ctx.strokeStyle = isMask ? C.mask : (isSel ? C.selected : C.slice);
        ctx.lineWidth = isSel ? 2 : 1;
        if (isMask) { ctx.setLineDash([6, 4]); } else { ctx.setLineDash([]); }
        ctx.stroke();
        ctx.setLineDash([]);

        if (v.mode === 'output' && (isSel || o.showMesh)) drawWarpMesh(ctx, s, v, C);
        if (v.mode === 'output' && (isSel || o.showBezier) && o.showBezier !== false) drawNet(ctx, s, v, C);
        if (v.mode === 'output' && (isSel || o.showHandles) && o.showHandles !== false) drawCorners(ctx, s, v, C);
        if (v.mode === 'input' && (isSel || o.showHandles) && o.showHandles !== false) drawInputHandles(ctx, s, v, C);
        if (v.mode === 'output' && o.showSoftEdge !== false) drawSoftEdgeBand(ctx, s, screen, v, C);

        if (o.showLabels !== false) {
          const b = polyBounds(poly);
          ctx.fillStyle = C.label;
          ctx.font = (o.font || '11px system-ui, sans-serif');
          ctx.textBaseline = 'bottom';
          ctx.fillText(nameOf(s, type) + (isMask ? ' (mask)' : ''), b.x0 + 3, b.y0 - 3);
        }
      }
      ctx.restore();
    } catch (err) {
      r.lastError = String((err && err.message) || err);
      try { ctx.restore(); } catch (e) { /* the save may not have happened */ }
    }
  }

  /* the warped boundary, sampled along the parametric border so a curved patch
     reads as a curve and not as four straight lines between the corners */
  function outline(slice, v, steps) {
    const out = [];
    const push = (u, t) => {
      const p = v.mode === 'input' ? inputPoint(slice, u, t) : warpPoint(slice, u, t);
      out.push(toView(v, p));
    };
    /* a polygon slice has contour vertices and no unit square */
    const verts = rectVerts(slice, v.mode === 'input' ? 'input' : 'output');
    if (verts.length && verts.length !== 4 && sliceState(slice).mode === 0)
      return verts.map(p => toView(v, p));
    for (let i = 0; i < steps; i++) push(i / steps, 0);
    for (let i = 0; i < steps; i++) push(1, i / steps);
    for (let i = steps; i > 0; i--) push(i / steps, 1);
    for (let i = steps; i > 0; i--) push(0, i / steps);
    return out;
  }
  function inputPoint(slice, u, t) {
    const i = rectVerts(slice, 'input');
    if (i.length === 4) return quadLerp(i, u, t);
    if (!i.length) return P(0, 0);
    const b = polyBounds(i);
    return P(b.x0 + (b.x1 - b.x0) * u, b.y0 + (b.y1 - b.y0) * t);
  }

  function drawWarpMesh(ctx, slice, v, C) {
    const n = 4, steps = 12;
    ctx.strokeStyle = C.net; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k < n; k++) {
      const t = k / n;
      for (let i = 0; i <= steps; i++) {
        const p = toView(v, warpPoint(slice, i / steps, t));
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      for (let i = 0; i <= steps; i++) {
        const p = toView(v, warpPoint(slice, t, i / steps));
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }

  /* Control points live in SRC space (before the homography), so they are drawn
     through H — which is why the manual says the small points "travel with" the
     big ones. Editing one writes back into src space. */
  function drawNet(ctx, slice, v, C) {
    const st = sliceState(slice), w = st.warper;
    if (st.mode !== 1 && st.mode !== 2) return;
    if (!w.cw || !w.ch) return;
    const at = k => toView(v, st.hasH ? applyH(st.H, w.ctrl[k] || P(0, 0)) : (w.ctrl[k] || P(0, 0)));
    ctx.strokeStyle = C.net; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let j = 0; j < w.ch; j++)
      for (let i = 0; i < w.cw; i++) {
        const p = at(j * w.cw + i);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
    for (let i = 0; i < w.cw; i++)
      for (let j = 0; j < w.ch; j++) {
        const p = at(j * w.cw + i);
        if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
    ctx.stroke();
    ctx.setLineDash([]);
    const rr = num(r.defaults.controlRadius, 5) - 1;
    ctx.fillStyle = C.ctrl;
    for (let k = 0; k < w.cw * w.ch; k++) {
      const p = at(k);
      ctx.fillRect(p.x - rr, p.y - rr, rr * 2, rr * 2);
    }
  }

  /* The big draggers ARE the homography's dst quad (homographyDragger.png) —
     NOT the parametric corners of the warped surface. This distinction is not
     cosmetic: the bezier patch interpolates its corners, so S(0,0) is exactly
     ctrl[0] for all time. Drawing the big handle at warpPoint(0,0) would park it
     permanently on top of the small bezier corner point, and the two could never
     be told apart or dragged independently — which is the whole of the manual's
     "big corner points for perspective, their baby brothers for bezier". */
  function cornerPoints(slice) {
    const st = sliceState(slice), w = st.warper;
    if (w.dst && w.dst.length >= 4) return w.dst.slice(0, 4).map(p => P(p.x, p.y));
    if (st.out.length >= 4) return st.out.slice(0, 4).map(p => P(p.x, p.y));
    return [];
  }
  function drawCorners(ctx, slice, v, C) {
    const rr = num(r.defaults.handleRadius, 8) - 2;
    ctx.fillStyle = C.corner; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
    const cs = cornerPoints(slice);
    for (let i = 0; i < cs.length; i++) {
      const p = toView(v, cs[i]);
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  function drawInputHandles(ctx, slice, v, C) {
    const i4 = rectVerts(slice, 'input');
    const rr = num(r.defaults.handleRadius, 8) - 2;
    ctx.fillStyle = C.corner; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
    for (let i = 0; i < i4.length; i++) {
      const p = toView(v, i4[i]);
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  /* the inner boundary of each blend band, so you can see where the crossover
     sits without guessing from the gradient */
  function drawSoftEdgeBand(ctx, slice, screen, v, C) {
    const se = softEdgeOf(slice, screen, r.setup);
    if (!se) return;
    ctx.strokeStyle = C.softEdge; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    const iso = (fixed, axis) => {
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const p = toView(v, axis === 'x' ? warpPoint(slice, fixed, t) : warpPoint(slice, t, fixed));
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    };
    if (se.edge[0] > 0) iso(se.edge[0], 'x');
    if (se.edge[1] > 0) iso(1 - se.edge[1], 'x');
    if (se.edge[2] > 0) iso(se.edge[2], 'y');
    if (se.edge[3] > 0) iso(1 - se.edge[3], 'y');
    ctx.setLineDash([]);
  }

  /* type 0 = Input Guide, type 1 = Output Guide. The decoded whitelist keeps
     only the type, so a guide with no stored position is drawn at the centre. */
  function drawGuides(ctx, screen, v, C) {
    const gs = listOf(screen, ['guides', 'Guides']);
    if (!gs.length) return;
    ctx.save();
    ctx.strokeStyle = C.guide; ctx.lineWidth = 1; ctx.setLineDash([8, 6]);
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      const gx = num(prop(g, ['x', 'X', 'position']), NaN);
      const gy = num(prop(g, ['y', 'Y']), NaN);
      const a = toView(v, P(0, 0)), b = toView(v, P(v.w, v.h));
      if (isNum(gx)) { const p = toView(v, P(gx, 0)); line(ctx, p.x, a.y, p.x, b.y); }
      if (isNum(gy)) { const p = toView(v, P(0, gy)); line(ctx, a.x, p.y, b.x, p.y); }
      if (!isNum(gx) && !isNum(gy)) {
        const c = toView(v, P(v.w / 2, v.h / 2));
        line(ctx, c.x, a.y, c.x, b.y); line(ctx, a.x, c.y, b.x, c.y);
      }
    }
    ctx.restore();
  }
  function line(ctx, x0, y0, x1, y1) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }

  /* =======================================================================
     pick — hit test in the same view space renderEditor last used
     ======================================================================= */
  function pick(screenId, point, options) {
    try {
      const o = options || {};
      const screen = findScreen(screenId);
      if (!screen || !point) return null;
      const key = String(screenId && typeof screenId === 'object' ? idOf(screen, 0) : screenId);
      let v = views.get(key);
      if (o.scale || o.width || o.mode || !v) v = viewFor(screen, key, { canvas: o.canvas || null }, o);
      const x = num(point.x, 0), y = num(point.y, 0);
      const hr = num(o.handleRadius, r.defaults.handleRadius);
      const cr = num(o.controlRadius, r.defaults.controlRadius);
      const near = (p, rad) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) <= rad * rad;

      const slices = slicesOf(screen);
      /* topmost first: the last slice drawn is the one under the cursor */
      for (let i = slices.length - 1; i >= 0; i--) {
        const s = slices[i];
        if (!s) continue;
        if (!propBool(s, ['enabled', 'Enabled'], true) && !o.includeDisabled) continue;
        const id = idOf(s, i);

        if (v.mode === 'input') {
          const i4 = rectVerts(s, 'input');
          for (let k = 0; k < i4.length; k++)
            if (near(toView(v, i4[k]), hr))
              return { sliceId: id, handle: 'input-corner', index: k, screenId: key, space: 'composition' };
          continue;
        }

        /* On an un-warped slice every bezier CORNER control point sits exactly
           on top of its big perspective corner (the identity net's outer points
           ARE the OutputRect corners). Testing the small handles first would
           therefore make the perspective draggers unreachable on any slice that
           has not been warped yet — which is the default state of every slice
           there is, and would silently kill the manual's headline workflow.
           So: nearest handle wins, and an exact tie goes to the corner, because
           drawCorners runs after drawNet and the corner is what the user can
           actually see under the cursor. */
        const st = sliceState(s), w = st.warper;
        const d2 = p => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        let bz = null;
        if ((st.mode === 1 || st.mode === 2) && w.cw && w.ch) {
          for (let k = 0; k < w.cw * w.ch; k++) {
            const raw = w.ctrl[k] || P(0, 0);
            const d = d2(toView(v, st.hasH ? applyH(st.H, raw) : raw));
            if (d <= cr * cr && (!bz || d < bz.d)) bz = { d: d, k: k };
          }
        }
        let cn = null;
        const cs = cornerPoints(s);        /* the homography dst quad — see cornerPoints */
        for (let k = 0; k < cs.length; k++) {
          const d = d2(toView(v, cs[k]));
          if (d <= hr * hr && (!cn || d < cn.d)) cn = { d: d, k: k };
        }
        if (bz && (!cn || bz.d < cn.d - 1e-6))
          return { sliceId: id, handle: 'bezier', index: bz.k, screenId: key, space: 'src',
                   col: bz.k % w.cw, row: Math.floor(bz.k / w.cw) };
        if (cn)
          return { sliceId: id, handle: 'output-corner', index: cn.k, screenId: key, space: 'screen' };
      }
      /* bodies only after every handle on every slice has missed */
      for (let i = slices.length - 1; i >= 0; i--) {
        const s = slices[i];
        if (!s) continue;
        if (!propBool(s, ['enabled', 'Enabled'], true) && !o.includeDisabled) continue;
        const poly = outline(s, v, 12);
        if (poly.length >= 3 && pointInPoly(P(x, y), poly))
          return { sliceId: idOf(s, i), handle: 'body', index: -1, screenId: key,
                   space: v.mode === 'input' ? 'composition' : 'screen' };
      }
      return null;
    } catch (err) {
      r.lastError = String((err && err.message) || err);
      return null;
    }
  }

  /* =======================================================================
     teardown
     ======================================================================= */
  function disposeGL() {
    if (!gl) return;
    try {
      meshes.forEach(m => {
        if (m.vao) gl.deleteVertexArray(m.vao);
        if (m.vbo) gl.deleteBuffer(m.vbo);
        if (m.ibo) gl.deleteBuffer(m.ibo);
      });
      meshes.clear();
      if (ctrlTex) gl.deleteTexture(ctrlTex);
      if (srcTex) gl.deleteTexture(srcTex);
      if (pointTex) gl.deleteTexture(pointTex);
      if (screenTex) gl.deleteTexture(screenTex);
      if (screenFbo) gl.deleteFramebuffer(screenFbo);
      if (screenStencil) gl.deleteRenderbuffer(screenStencil);
      if (maskVbo) gl.deleteBuffer(maskVbo);
      if (maskVao) gl.deleteVertexArray(maskVao);
      if (sampLinear) gl.deleteSampler(sampLinear);
      if (sampNearest) gl.deleteSampler(sampNearest);
      if (prog) gl.deleteProgram(prog);
      if (maskProg) gl.deleteProgram(maskProg);
      if (clearProg) gl.deleteProgram(clearProg);
      if (finalProg) gl.deleteProgram(finalProg);
      if (fullVao) gl.deleteVertexArray(fullVao);
    } catch (err) { /* teardown must never throw */ }
    ctrlTex = srcTex = pointTex = screenTex = screenFbo = screenStencil = null;
    maskVbo = maskVao = null;
    sampLinear = sampNearest = prog = maskProg = clearProg = finalProg = fullVao = null;
    U = MU = FU = null;
    screenTargetW = screenTargetH = 0;
  }
  /* Frees only what this renderer allocated. It deliberately does NOT call
     WEBGL_lose_context.loseContext(): the canvas belongs to the CALLER and a
     lost context is permanent for that element — getContext hands back the same
     dead context forever afterwards. That exact call already cost this project
     once (openlive-dxv.js:722), where a layer could play one clip and every
     later load died on a null extension. The element must stay reusable. */
  function dispose() {
    disposeGL();
    gl = null; r.gl = null;
    views.clear();
    r.setup = null;
  }

  /* ---- public surface --------------------------------------------------
     GL-only members. Everything else is attached by attachCpuSurface() below,
     which the no-GL paths call as well. */
  r.renderScreen = renderScreen;
  r.renderFinalScreen = renderFinalScreen;
  attachCpuSurface();
  probeInterop();
  return r;

  /* Every member that runs entirely on the CPU. Called on ALL FOUR exits from
     create() — success, no canvas, no WebGL2, shader link failure — so a
     renderer without a context is still a working editor overlay and hit test
     rather than an object full of no-ops. Declared as a hoisted function so the
     early returns above can call it. */
  function attachCpuSurface() {
    r.setSetup = function (setup) {
      r.setup = setup || null;
      views.clear();
      probeInterop();
      r.stats.screens = screensOf(r.setup).length;
      return r;
    };
    r.renderEditor = renderEditor;
    r.pick = pick;
    r.dispose = dispose;
    /* below: not part of the required contract, but a test harness and the
       editor's drag handlers are useless without them */
    r.warpPoint = warpPoint;
    r.inputPoint = inputPoint;
    r.cornerPoints = cornerPoints;      /* where pick() puts handle:'output-corner' */
    r.outline = (slice, opts) => outline(slice, views.get(String((opts || {}).screenId)) ||
      { mode: 'output', scale: 1, ox: 0, oy: 0, w: 1, h: 1 }, ((opts || {}).steps) || 12);
    r.softEdgeParams = (slice, screen) => softEdgeOf(slice, screen, r.setup);
    r.softEdgeAlpha = function (slice, u, v, power) {
      const se = softEdgeOf(slice, null, r.setup);
      if (!se) return 1;
      const c = blendCurve(softEdgeT(se, num(u, 0), num(v, 0)), num(power, se.power), se.lum);
      return gammaed(c, se.gamma[1]);
    };
    r.softEdgeRGB = function (slice, u, v, power) {
      const se = softEdgeOf(slice, null, r.setup);
      if (!se) return [1, 1, 1];
      const c = blendCurve(softEdgeT(se, num(u, 0), num(v, 0)), num(power, se.power), se.lum);
      return [gammaed(c, se.gamma[0]), gammaed(c, se.gamma[1]), gammaed(c, se.gamma[2])];
    };
    r.homographyOf = slice => sliceState(slice).H.slice();
    r.view = screenId => views.get(String(screenId)) || null;
    r.solveHomography = solveHomography;
    r.applyHomography = applyH;
    r.evalBezier = (grid, u, v) => {
      const g = grid || {};
      const ctrl = (g.vertices || g.points || []).map(pt);
      return evalPatch(ctrl, num(g.controlWidth, 4), num(g.controlHeight, 4), num(u, 0), num(v, 0));
    };
    return r;
  }

  /* the CPU twin of the fragment shader's blend, so a test can compare the two.
     GAMMA IS APPLIED HERE because the shader applies it (blend = pow(curve,
     1/gamma)). Returning the bare curve would disagree with the GPU it claims to
     mirror and with OpenLiveScreens.softEdgeAlpha, which also gammas — at the
     contract's own reference point (t=0.25, P=2, L=0.5, G=2.2) that is 0.3886
     against 0.1250, a 3x error in the one number edge blending is judged on.
     Per-channel gamma makes the blend a colour, so the scalar form reports the
     GREEN channel — identical to the others until Gamma Red/Blue are retuned.
     softEdgeRGB returns all three. */
  function softEdgeT(se, u, v) {
    let t = 1;
    if (se.edge[0] > 0) t = Math.min(t, u / se.edge[0]);
    if (se.edge[1] > 0) t = Math.min(t, (1 - u) / se.edge[1]);
    if (se.edge[2] > 0) t = Math.min(t, v / se.edge[2]);
    if (se.edge[3] > 0) t = Math.min(t, (1 - v) / se.edge[3]);
    return clamp(t, 0, 1);
  }
  /* a function DECLARATION, not a const arrow: attachCpuSurface() closes over it
     and runs before this line on the early-return paths */
  function gammaed(c, g) {
    return clamp(Math.pow(clamp(c, 0, 1), 1 / (Math.abs(g) > 1e-6 ? g : 2.2)), 0, 1);
  }
}

/* The no-GL tail. renderScreen is the ONLY thing a missing WebGL2 context
   actually costs, so it is the only unconditional no-op here; everything else
   is filled in only if attachCpuSurface() did not already provide the real
   implementation. The `|| ` guards are what keep the header's promise honest —
   overwriting r.renderEditor with a noop here is exactly the bug this replaced,
   where the section header advertised a working 2D overlay and delivered zero
   drawing operations and a pick() that always returned null. */
function finish(r) {
  const noop = function () { };
  r.setSetup = r.setSetup || function (s) { r.setup = s || null; return r; };
  r.renderScreen = noop;
  r.renderFinalScreen = noop;
  r.renderEditor = r.renderEditor || noop;
  r.pick = r.pick || (() => null);
  r.dispose = r.dispose || noop;
  r.warpPoint = r.warpPoint || ((s, u, v) => P(u, v));
  r.solveHomography = solveHomography;
  r.applyHomography = applyH;
  r.softEdgeAlpha = r.softEdgeAlpha || (() => 1);
  r.softEdgeRGB = r.softEdgeRGB || (() => [1, 1, 1]);
  return r;
}

/* ---- GL helpers -------------------------------------------------------- */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error((type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') + ' shader: ' + log);
  }
  return s;
}
function link(gl, vs, fs) {
  const p = gl.createProgram();
  const a = compile(gl, gl.VERTEX_SHADER, vs), b = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a); gl.attachShader(p, b);
  gl.bindAttribLocation(p, 0, 'a_par');
  gl.linkProgram(p);
  gl.deleteShader(a); gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('link: ' + log);
  }
  return p;
}
function uniforms(gl, prog, names) {
  const U = {};
  for (let i = 0; i < names.length; i++) {
    U[names[i]] = gl.getUniformLocation(prog, names[i]);
    /* array uniforms report as "u_quad[0]" on some drivers */
    if (U[names[i]] === null) U[names[i]] = gl.getUniformLocation(prog, names[i] + '[0]');
  }
  return U;
}

window.OpenLiveScreenRender = {
  create: create,
  /* exported so tests and openlive-screens.js can check they agree without
     standing up a WebGL context */
  solveHomography: solveHomography,
  applyHomography: applyH,
  evalPatch: evalPatch,
  evalGrid: evalGrid,
  blendCurve: blendCurve,
  quadLerp: quadLerp,
  VERT: VERT,
  FRAG: FRAG,
  MASK_VERT: MASK_VERT,
  MASK_STENCIL_FRAG: MASK_STENCIL_FRAG,
  FINAL_FRAG: FINAL_FRAG,
  DEFAULTS: DEFAULTS
};
})();
