/* ===========================================================================
   openlive-screens.js — the Advanced Output screen/slice model and the geometry
   engine that maps composition pixels onto a projector.
   ---------------------------------------------------------------------------
   MODEL AND MATHS ONLY. No DOM, no canvas, no WebGL, not even DOMParser — the
   XML reader below is 90 lines of hand-rolled tokeniser precisely so this file
   runs unchanged in a page, in a Worker and in a node harness, and so the one
   thing that must never drift (the file format) has exactly one implementation.
   A sibling file owns the renderer and the inspector UI.

   WHY THIS FILE EXISTS. advanced-output.js already tessellates and texture-maps
   slices competently, but it sits on an XML layer that is fiction and on two
   projector-critical maths stages that are decorative:
     - its <BezierWarper> emits bare <v> children with no <vertices> wrapper, so
       a real reader gets ZERO control points;
     - `homography` appears six times in 4243 lines, all constructor or
       serialiser — outAt() never evaluates it, and the warp stages are an
       exclusive if/if/if instead of the composed chain;
     - the soft-edge curve is 1-(2d/0.5)^(1/P), which saturates to 1.0 by t=0.25
       where Arena's compiled shader is still at 0.3886.
   Everything here is written against the evidence, and where the evidence runs
   out that is said out loud rather than papered over.

   WHAT IS MEASURED AND WHAT IS READ (the difference matters):

     measured   The soft-edge blend curve. The whole fragment program is
                compiled into Arena.exe as plain text; softEdgeCurve() below is
                a line-by-line transcription, and it reproduces 0.1689 / 0.3886
                / 0.7297 at t = 0.10 / 0.25 / 0.50 with P=2, L=0.5, G=2.2.

     measured   The Bezier basis. The 16 stored control points of both real
                screens are the 1/3-spaced identity net (0,640,1280,1920 over a
                1920-wide rect; 0,533.33,1066.67,1600 over a 1600-wide one).
                Because SUM_j Bj(t)*(j/3) === t, only a cubic BERNSTEIN basis
                evaluates that net back to the identity — a uniform B-spline
                would contract off the corners, Catmull-Rom would need phantom
                points, a Coons patch would store boundaries not 16 points.

     measured   The input side is AFFINE. The vertex shader computes
                sliceUniforms.sliceMatrix * vec4(coords,0,1) and never divides
                by w, so InputRect is always a rotated rectangle and its fourth
                vertex is redundant. inputIsAffine() reports a file that
                disagrees rather than silently misdrawing it.

     read       The warp ORDER, vPosition = H * S(u,v). Every warper in the one
                real file is at identity, where both orders are indistinguishable.
                It is inferred from three things that all point the same way:
                homography.src is byte-identical to OutputRect and the Bezier net
                spans that same rect (so the patch's output IS H's input space);
                the manual puts the small bezier handles INSIDE the big
                perspective corners; and the perspective stage has to be last or
                it could not correct the projector's own off-axis throw.
                It is behind setWarpOrder() for that reason.

     read       The multi-patch net, controlWidth = 3*(SubdivisionsX+1)+1. It is
                the only formula consistent with 4 at zero subdivisions and with
                two handles per user point, but no file with subdivisions > 0
                exists on this machine to confirm it. A net that is not 3n+1 is
                read as a plain point grid instead of throwing — see SURFACES.

     unknown    Whether the 4 interior control points (5,6,9,10) are user-free or
                Coons-derived. Does not affect evaluation: all 16 are serialised,
                so we read them and evaluate.

     unknown    What a populated <Items> looks like. slices.xml on this machine
                is empty. serialize() regenerates that list from the slices and
                deserialize() ignores it, so a wrong guess costs nothing.

   ROOT ELEMENT. The task asks for a ScreenSetupInspector document; Arena's own
   screen setup lives under <ScreenSetup> inside AdvancedOutput.xml. Both are
   real and they are not the same file, so serialize() writes the Inspector as
   the root and nests a strictly Arena-shaped <ScreenSetup> subtree inside it,
   and deserialize() accepts either root. Clone-only state that Arena has no
   param name for goes in a <OpenLive> sidecar, NEVER as invented attributes on
   Arena's own elements — inventing WarpMode/FilterMode/InputSource is exactly
   how the previous attempt produced a file Arena will not load.

   LOSSLESS means lossless: fromDecoded(arena-advanced-output.json) ->
   serialize() -> deserialize() -> toDecoded() is byte-identical under
   JSON.stringify, down to Power = "1.999999999999999778" (a string, because
   parsing it to a double and printing it back gives "2") and to the keys the
   Python extractor omits rather than nulls.

   NO NaN ESCAPES. Every public function is total: degenerate homographies
   return null, a collapsed InputRect returns u=v=0, a point on the horizon
   returns itself un-warped. A still frame is a better answer than a black one.

   Plain classic script. Publishes window.OpenLiveScreens. Depends on nothing;
   uses window.RESOLUME.arena.advanced_output as a bootstrap if it is loaded.
   =========================================================================== */
window.OpenLiveScreens = (() => {
  'use strict';

  /* ================= numeric guards =================
     Everything numeric funnels through these. `num` is used on every value that
     came off disk or out of the UI, because one NaN in a control point poisons
     an entire tessellated mesh and the failure looks like a missing projector. */
  const finite = v => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
  const num = (v, dflt) => (finite(v) ? v : dflt);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  /* Coordinates off disk are strings; "1.999999999999999778" must parse but
     "" and null must not become 0 silently where a default is meaningful. */
  const toNum = (v, dflt) => {
    if (typeof v === 'number') return num(v, dflt);
    if (v == null || v === '') return dflt;
    const n = parseFloat(v);
    return finite(n) ? n : dflt;
  };
  const pt = (x, y) => ({ x: num(x, 0), y: num(y, 0) });
  const cpPt = p => pt(p && p.x, p && p.y);
  /* Shortest round-tripping repr: parseFloat(fmt(x)) === x for every double,
     which is what keeps 234.7825927734375 intact through a save/load cycle. */
  const fmt = n => (finite(n) ? String(n) : '0');
  const str = v => (v == null ? '' : String(v));

  /* ================= XML: a reader that is not the DOM =================
     Resolume's dialect is small — elements, double-quoted attributes,
     self-closing empties, no mixed content, no namespaces. Parsing it by hand
     costs 90 lines and buys the file the ability to be tested outside a
     browser, which is the only way the round-trip claim above is checkable. */
  const XENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unesc(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return finite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return Object.prototype.hasOwnProperty.call(XENT, e) ? XENT[e] : m;
    });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const NAME_END = /[\s/>=]/;
  function parseXML(text) {
    const s = String(text == null ? '' : text);
    const doc = { tag: '#doc', attrs: {}, children: [] };
    const stack = [doc];
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt < 0) break;
      i = lt + 1;
      if (s.startsWith('?', i)) { const e = s.indexOf('?>', i); i = e < 0 ? s.length : e + 2; continue; }
      if (s.startsWith('!--', i)) { const e = s.indexOf('-->', i); i = e < 0 ? s.length : e + 3; continue; }
      if (s.startsWith('![CDATA[', i)) { const e = s.indexOf(']]>', i); i = e < 0 ? s.length : e + 3; continue; }
      if (s.startsWith('!', i)) { const e = s.indexOf('>', i); i = e < 0 ? s.length : e + 1; continue; }
      if (s.startsWith('/', i)) {                                   /* close tag */
        const e = s.indexOf('>', i);
        if (stack.length > 1) stack.pop();
        i = e < 0 ? s.length : e + 1;
        continue;
      }
      let j = i;
      while (j < s.length && !NAME_END.test(s[j])) j++;
      const tag = s.slice(i, j);
      if (!tag) { i = j + 1; continue; }
      const node = { tag: tag, attrs: {}, children: [] };
      i = j;
      let selfClose = false;
      for (;;) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) break;
        if (s[i] === '/') { selfClose = true; i++; continue; }
        if (s[i] === '>') { i++; break; }
        let k = i;
        while (k < s.length && !NAME_END.test(s[k])) k++;
        const an = s.slice(i, k);
        i = k;
        while (i < s.length && /\s/.test(s[i])) i++;
        let av = '';
        if (s[i] === '=') {
          i++;
          while (i < s.length && /\s/.test(s[i])) i++;
          const q = s[i];
          if (q === '"' || q === "'") {
            const e = s.indexOf(q, i + 1);
            av = e < 0 ? s.slice(i + 1) : s.slice(i + 1, e);
            i = e < 0 ? s.length : e + 1;
          } else {
            let e = i;
            while (e < s.length && !/[\s/>]/.test(s[e])) e++;
            av = s.slice(i, e);
            i = e;
          }
        }
        if (an) node.attrs[an] = unesc(av);
      }
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
    return doc.children[0] || null;
  }

  const el = (tag, attrs, children) => ({ tag: tag, attrs: attrs || {}, children: children || [] });
  const kid = (n, tag) => (n && n.children ? n.children.find(c => c.tag === tag) || null : null);
  const kids = (n, tag) => (n && n.children ? (tag ? n.children.filter(c => c.tag === tag) : n.children.slice()) : []);
  const attr = (n, k) => (n && n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, k) ? n.attrs[k] : null);
  /* Preserved XML subtrees are plain {tag, attrs, children}, so they survive
     JSON.stringify into localStorage — but they must be copied on the way in and
     out of the decoded document, or two setups end up sharing one node and an
     edit to either mutates both. */
  const cloneNodes = ns => (Array.isArray(ns) ? ns : []).map(function copy(n) {
    return el(n.tag, Object.assign({}, n.attrs), (n.children || []).map(copy));
  });

  function writeXML(node, indent, out) {
    const tab = '\t'.repeat(indent);
    let head = tab + '<' + node.tag;
    for (const k in node.attrs) {
      const v = node.attrs[k];
      if (v == null) continue;
      head += ' ' + k + '="' + esc(v) + '"';
    }
    if (!node.children.length) { out.push(head + '/>'); return out; }
    out.push(head + '>');
    for (const c of node.children) writeXML(c, indent + 1, out);
    out.push(tab + '</' + node.tag + '>');
    return out;
  }
  const serializeXML = node => '<?xml version="1.0" encoding="utf-8"?>\n' + writeXML(node, 0, []).join('\n') + '\n';

  /* ================= linear algebra =================
     Small, dense, fixed-size. Written out rather than pulled from a library
     because the whole point of this file is that no library is allowed. */

  /* Gaussian elimination with partial pivoting on an n x (n+1) augmented row
     array. Returns the solution or null — never a vector with NaN in it, which
     is the failure mode that silently blanks a projector. */
  function gaussSolve(rows, n) {
    for (let col = 0; col < n; col++) {
      let piv = col, best = Math.abs(rows[col][col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(rows[r][col]);
        if (v > best) { best = v; piv = r; }
      }
      if (!(best > 1e-12)) return null;                 /* singular: no unique solve */
      if (piv !== col) { const t = rows[piv]; rows[piv] = rows[col]; rows[col] = t; }
      const p = rows[col][col];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = rows[r][col] / p;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) rows[r][c] -= f * rows[col][c];
      }
    }
    const x = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      const v = rows[r][n] / rows[r][r];
      if (!finite(v)) return null;
      x[r] = v;
    }
    return x;
  }

  const mat3mul = (A, B) => {
    const C = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
      }
    }
    return C;
  };
  const mat3identity = () => Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  const cross3 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

  /* Any three of four points collinear makes the 8x8 singular. Arena's UI
     prevents it by construction (you drag the corners of a convex quad); a file
     or a script can still produce it, so it is checked rather than assumed. */
  function quadOk(q) {
    if (!Array.isArray(q) || q.length < 4) return false;
    let scale = 0;
    for (let i = 0; i < 4; i++) {
      if (!q[i] || !finite(+q[i].x) || !finite(+q[i].y)) return false;
      scale = Math.max(scale, Math.abs(q[i].x), Math.abs(q[i].y));
    }
    const tol = Math.max(1e-9, scale * scale * 1e-12);
    const T = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
    for (const t of T) if (Math.abs(cross3(q[t[0]], q[t[1]], q[t[2]])) <= tol) return false;
    return true;
  }

  /* Hartley normalisation: centroid to origin, mean radius to sqrt(2). Four
     exact correspondences make the solve well determined even without it, but
     the coordinates here are raw pixels up to 1920 and conditioning is free. */
  function normaliser(q) {
    let cx = 0, cy = 0;
    for (let i = 0; i < 4; i++) { cx += q[i].x; cy += q[i].y; }
    cx /= 4; cy /= 4;
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(q[i].x - cx, q[i].y - cy);
    d /= 4;
    if (!(d > 1e-12) || !finite(d)) return null;          /* all four points coincide */
    const s = Math.SQRT2 / d;
    return {
      s: s, cx: cx, cy: cy,
      T: Float64Array.from([s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]),
      Tinv: Float64Array.from([1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1]),
      apply: p => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })
    };
  }

  /* 4-point DLT with h33 fixed to 1: 8 unknowns, 8 equations, exact, no SVD.
     Returns a row-major Float64Array(9) or null. Never returns NaN. */
  function solveHomography(src4, dst4) {
    if (!quadOk(src4) || !quadOk(dst4)) return null;
    const ns = normaliser(src4), nd = normaliser(dst4);
    if (!ns || !nd) return null;
    const S = src4.map(ns.apply), D = dst4.map(nd.apply);
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const x = S[i].x, y = S[i].y, X = D[i].x, Y = D[i].y;
      rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
      rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
    }
    const h = gaussSolve(rows, 8);
    if (!h) return null;
    const Hn = Float64Array.from([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
    let H = mat3mul(nd.Tinv, mat3mul(Hn, ns.T));
    /* Fix the scale so H is comparable and serialisable. h33 can legitimately be
       zero when the source origin maps to the horizon, so only divide when it is
       safely non-zero. */
    if (Math.abs(H[8]) > 1e-12) {
      const k = H[8];
      const N = new Float64Array(9);
      for (let i = 0; i < 9; i++) N[i] = H[i] / k;
      H = N;
    }
    for (let i = 0; i < 9; i++) if (!finite(H[i])) return null;
    /* Verify rather than trust: a solve that does not reproduce its own four
       correspondences is a degenerate quad the collinearity test let through. */
    let scale = 1;
    for (let i = 0; i < 4; i++) scale = Math.max(scale, Math.abs(dst4[i].x), Math.abs(dst4[i].y));
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(H, src4[i]);
      if (Math.hypot(p.x - dst4[i].x, p.y - dst4[i].y) > 1e-6 * scale) return null;
    }
    return H;
  }

  /* A point whose w collapses is on the horizon line and genuinely has no
     image. Returning it un-warped keeps the mesh finite and merely degenerate;
     returning Infinity would throw the whole tessellation off the canvas. */
  function applyHomography(H, p) {
    const x = num(p && p.x, 0), y = num(p && p.y, 0);
    if (!H || H.length < 9) return { x: x, y: y };
    const w = H[6] * x + H[7] * y + H[8];
    if (!finite(w) || Math.abs(w) < 1e-12) return { x: x, y: y };
    const rx = (H[0] * x + H[1] * y + H[2]) / w;
    const ry = (H[3] * x + H[4] * y + H[5]) / w;
    return finite(rx) && finite(ry) ? { x: rx, y: ry } : { x: x, y: y };
  }

  /* ================= the warp surface (swappable) =================
     The cubic Bernstein basis is measured (see the header). The MULTI-PATCH
     generalisation is not: controlWidth = 3*(SubdivisionsX+1)+1 is the only
     formula consistent with 4 control points at zero subdivisions and with the
     manual's two handles per user point, but no Arena file with Subdivisions > 0
     exists on this machine, so it stays behind SURFACES/setSurface(). One file
     saved with Subdivisions X = 1 settles it: controlWidth reads 7 if the
     formula holds, 5 if the net is a plain point grid — in which case switch to
     'grid' and nothing else in this file changes. */
  const B0 = t => (1 - t) * (1 - t) * (1 - t);
  const B1 = t => 3 * t * (1 - t) * (1 - t);
  const B2 = t => 3 * t * t * (1 - t);
  const B3 = t => t * t * t;
  const bern = t => [B0(t), B1(t), B2(t), B3(t)];

  const gridPoint = (verts, cw, col, row) => cpPt(verts[row * cw + col]);

  /* Tensor-product cubic Bezier over a 3n+1 net, row-major, corners
     interpolating. S(u,v) = SUM_i SUM_j Bi(u)Bj(v) P[j*4+i] on the located patch. */
  function bezierTensorCubic(grid, u, v) {
    const cw = grid.cw, ch = grid.ch, verts = grid.verts;
    const nx = (cw - 1) / 3, ny = (ch - 1) / 3;
    if (!(nx >= 1 && ny >= 1) || nx % 1 !== 0 || ny % 1 !== 0) return bilinearGrid(grid, u, v);
    let pu = Math.floor(u * nx); if (pu > nx - 1) pu = nx - 1; if (pu < 0) pu = 0;
    let pv = Math.floor(v * ny); if (pv > ny - 1) pv = ny - 1; if (pv < 0) pv = 0;
    const lu = clamp01(u * nx - pu), lv = clamp01(v * ny - pv);
    const Bu = bern(lu), Bv = bern(lv);
    const c0 = 3 * pu, r0 = 3 * pv;
    let x = 0, y = 0;
    for (let j = 0; j < 4; j++) {
      const wj = Bv[j];
      if (wj === 0) continue;
      for (let i = 0; i < 4; i++) {
        const w = wj * Bu[i];
        if (w === 0) continue;
        const p = gridPoint(verts, cw, c0 + i, r0 + j);
        x += w * p.x; y += w * p.y;
      }
    }
    return pt(x, y);
  }

  /* The alternate reading: the net is a plain point grid and the surface is
     piecewise bilinear. Also the fallback for any net that is not 3n+1, so a
     malformed controlWidth degrades to a visible mesh instead of NaN. */
  function bilinearGrid(grid, u, v) {
    const cw = grid.cw, ch = grid.ch, verts = grid.verts;
    if (cw < 2 || ch < 2) return cpPt(verts[0]);
    const fx = clamp01(u) * (cw - 1), fy = clamp01(v) * (ch - 1);
    let c0 = Math.floor(fx); if (c0 > cw - 2) c0 = cw - 2; if (c0 < 0) c0 = 0;
    let r0 = Math.floor(fy); if (r0 > ch - 2) r0 = ch - 2; if (r0 < 0) r0 = 0;
    const tu = clamp01(fx - c0), tv = clamp01(fy - r0);
    const p00 = gridPoint(verts, cw, c0, r0), p10 = gridPoint(verts, cw, c0 + 1, r0);
    const p01 = gridPoint(verts, cw, c0, r0 + 1), p11 = gridPoint(verts, cw, c0 + 1, r0 + 1);
    const tx = p00.x + (p10.x - p00.x) * tu, ty = p00.y + (p10.y - p00.y) * tu;
    const bx = p01.x + (p11.x - p01.x) * tu, by = p01.y + (p11.y - p01.y) * tu;
    return pt(tx + (bx - tx) * tv, ty + (by - ty) * tv);
  }

  const SURFACES = { bezier: bezierTensorCubic, grid: bilinearGrid };
  let surfaceFn = bezierTensorCubic;
  let surfaceName = 'bezier';
  function setSurface(which) {
    if (typeof which === 'function') { surfaceFn = which; surfaceName = 'custom'; return surfaceName; }
    const k = str(which);
    if (SURFACES[k]) { surfaceFn = SURFACES[k]; surfaceName = k; }
    return surfaceName;
  }

  /* Normalise whatever shape the caller has (model warper, decoded JSON, bare
     array) into {cw,ch,verts} once, so the evaluators never branch on it. */
  function coerceGrid(g) {
    if (!g) return null;
    const verts = Array.isArray(g.vertices) ? g.vertices : Array.isArray(g) ? g : null;
    if (!verts || verts.length < 4) return null;
    let cw = Math.round(toNum(g.controlWidth, 0)), ch = Math.round(toNum(g.controlHeight, 0));
    if (!(cw >= 2) || !(ch >= 2)) {                        /* a square net is the only sane guess */
      const n = Math.round(Math.sqrt(verts.length));
      cw = ch = n >= 2 ? n : 2;
    }
    if (cw * ch > verts.length) return null;
    return { cw: cw, ch: ch, verts: verts };
  }

  function evalBezier(grid, u, v) {
    const g = coerceGrid(grid);
    if (!g) return pt(0, 0);
    return surfaceFn(g, clamp01(num(u, 0)), clamp01(num(v, 0)));
  }

  /* ================= soft edge =================
     Verbatim from the fragment program compiled into Arena.exe at 0x22aa39x:

       float curve = texcoord.x;
       float blendStep = step( 0.5, curve );
       curve = luminanceCtrl * pow( 2.0*curve, blendPower ) * (1.0 - blendStep)
             + ( 1.0 - (1.0-luminanceCtrl) * pow( 2.0*(1.0-curve), blendPower ) ) * blendStep;
       fragColor0 = vec4( clamp( pow( vec3(curve), 1.0/gamma ), 0.0, 1.0 ), 1.0 );

     Two power segments meeting at t=0.5 where the value is exactly L. P raises
     the slope at the centre of the fade; L is the brightness of that centre;
     gamma is per-channel so a projector's colour response can be matched. */
  const SOFT_EDGE_DEFAULTS = { power: 2, luminance: 0.5, gamma: 2.2 };

  function softEdgeCurve(t, power, luminance, gamma) {
    const T = clamp01(num(t, 0));
    const P = num(power, SOFT_EDGE_DEFAULTS.power);
    const L = num(luminance, SOFT_EDGE_DEFAULTS.luminance);
    const G = num(gamma, SOFT_EDGE_DEFAULTS.gamma);
    let c = T < 0.5 ? L * Math.pow(2 * T, P) : 1 - (1 - L) * Math.pow(2 * (1 - T), P);
    if (!finite(c)) c = T;                                  /* P<0 at t=0 is the only way here */
    c = clamp01(c);
    const g = Math.abs(G) > 1e-6 ? G : SOFT_EDGE_DEFAULTS.gamma;
    const out = Math.pow(c, 1 / g);
    return finite(out) ? clamp01(out) : clamp01(c);
  }

  const softEdgeCurveRGB = (t, opts) => {
    const o = opts || {};
    const gr = num(o.gammaRed, num(o.gamma, SOFT_EDGE_DEFAULTS.gamma));
    const gg = num(o.gammaGreen, num(o.gamma, SOFT_EDGE_DEFAULTS.gamma));
    const gb = num(o.gammaBlue, num(o.gamma, SOFT_EDGE_DEFAULTS.gamma));
    return [softEdgeCurve(t, o.power, o.luminance, gr),
      softEdgeCurve(t, o.power, o.luminance, gg),
      softEdgeCurve(t, o.power, o.luminance, gb)];
  };

  /* ================= the setup, screens and slices ================= */

  /* Arena ids are millisecond-ish decimal strings (1785035626110). Matching the
     shape matters only so a clone-made file does not look obviously foreign;
     the counter is what actually guarantees uniqueness inside one session. */
  let idSeq = 0;
  const newId = () => String(Date.now()) + String(idSeq++).padStart(2, '0');

  /* A param record is Arena's, kept verbatim: tag/type/default/value are the
     four the extractor reads, `range` is the ValueRange, `attrs` is everything
     else on the element and `children` any nested container (ParamFixturePixels
     holds a whole Params block). Nothing is dropped, so nothing is lost. */
  function paramFromXML(node) {
    const rec = {
      tag: node.tag,
      type: attr(node, 'T'),
      default: attr(node, 'default'),
      value: attr(node, 'value'),
      attrs: {},
      children: []
    };
    for (const k in node.attrs) if (k !== 'name' && k !== 'T' && k !== 'default' && k !== 'value') rec.attrs[k] = node.attrs[k];
    const vr = kid(node, 'ValueRange');
    if (vr) rec.range = Object.assign({}, vr.attrs);
    for (const c of node.children) if (c.tag !== 'ValueRange') rec.children.push(c);
    return rec;
  }
  function paramToXML(name, rec) {
    const a = { name: name };
    if (rec.type != null) a.T = rec.type;
    if (rec.default != null) a.default = rec.default;
    if (rec.value != null) a.value = rec.value;
    for (const k in rec.attrs) a[k] = rec.attrs[k];
    const ch = [];
    if (rec.range) ch.push(el('ValueRange', Object.assign({}, rec.range)));
    for (const c of rec.children || []) ch.push(c);
    return el(rec.tag || 'Param', a, ch);
  }
  const paramRec = (tag, type, dflt, value) =>
    ({ tag: tag, type: type, default: dflt, value: value, attrs: {}, children: [] });

  /* Params blocks are an ordered map of ordered maps: {blockName: {paramName:
     rec}}. Insertion order is document order, which is what makes the decoded
     JSON compare equal key-for-key. */
  function blocksFromXML(owner) {
    const out = {};
    for (const pb of kids(owner, 'Params')) {
      const bname = attr(pb, 'name') || 'Params';
      const block = out[bname] || (out[bname] = {});
      for (const p of pb.children) {
        const pname = attr(p, 'name');
        if (!pname) continue;
        block[pname] = paramFromXML(p);
      }
    }
    return out;
  }
  function blocksToXML(blocks) {
    const out = [];
    for (const bname in blocks) {
      const ch = [];
      for (const pname in blocks[bname]) ch.push(paramToXML(pname, blocks[bname][pname]));
      out.push(el('Params', { name: bname }, ch));
    }
    return out;
  }
  const blocksToDecoded = blocks => {
    const out = {};
    for (const bname in blocks) {
      const b = out[bname] = {};
      for (const pname in blocks[bname]) {
        const r = blocks[bname][pname];
        const d = { tag: r.tag, type: r.type == null ? null : r.type, default: r.default == null ? null : r.default, value: r.value == null ? null : r.value };
        if (r.range) d.range = Object.assign({}, r.range);
        /* A param's own attributes (storeChoices) and nested elements
           (PhaseSourceStatic, BehaviourDouble) are as much of the document as
           its value is. Projecting them away here meant fromDecoded rebuilt a
           thinner param than it was handed. */
        if (r.attrs && Object.keys(r.attrs).length) d.attrs = Object.assign({}, r.attrs);
        if (r.children && r.children.length) d.children = cloneNodes(r.children);
        b[pname] = d;
      }
    }
    return out;
  };
  function blocksFromDecoded(dec) {
    const out = {};
    if (!dec || typeof dec !== 'object') return out;
    for (const bname in dec) {
      const b = out[bname] = {};
      for (const pname in dec[bname]) {
        const s = dec[bname][pname] || {};
        const r = paramRec(s.tag || 'Param', s.type == null ? null : s.type, s.default == null ? null : s.default, s.value == null ? null : s.value);
        if (s.range) r.range = Object.assign({}, s.range);
        if (s.attrs) r.attrs = Object.assign({}, s.attrs);
        if (s.children) r.children = cloneNodes(s.children);
        b[pname] = r;
      }
    }
    return out;
  }
  function blockParam(blocks, block, name) {
    const b = blocks[block];
    return b && Object.prototype.hasOwnProperty.call(b, name) ? b[name] : null;
  }
  function setBlockParam(blocks, block, name, rec) {
    const b = blocks[block] || (blocks[block] = {});
    const cur = b[name];
    if (cur) { cur.value = rec.value; return cur; }
    b[name] = rec;
    return rec;
  }

  const rectFromDecoded = r => ({
    orientation: r && r.orientation != null ? String(r.orientation) : '0',
    /* Slice rectangles normally contain four points, but Arena's Polygon and
       Input Mask shapes use the same persisted contour record with more. Do
       not truncate those points at the decoded bridge: XML already preserves
       them, and losing point five onward makes a save/reload change the mask. */
    vertices: (r && Array.isArray(r.vertices) ? r.vertices : []).map(cpPt)
  });
  const rectFromXML = node => ({
    orientation: attr(node, 'orientation') != null ? attr(node, 'orientation') : '0',
    vertices: kids(node, 'v').map(v => pt(toNum(attr(v, 'x'), 0), toNum(attr(v, 'y'), 0)))
  });
  const rectToXML = (tag, r) =>
    el(tag, { orientation: r.orientation }, r.vertices.map(v => el('v', { x: fmt(v.x), y: fmt(v.y) })));
  const rectToDecoded = r => ({ orientation: r.orientation, vertices: r.vertices.map(v => ({ x: v.x, y: v.y })) });
  const rectOf = (x, y, w, h) => ({ orientation: '0', vertices: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)] });

  /* Advanced Output's inspector describes a Slice as X/Y (its middle), Width,
     Height and Rotation. The file itself only stores the four corners, so this
     is the model-owned conversion used by non-UI callers too. Rotation is in
     degrees, matching Arena's numeric field. X/Y-as-centre is visible in the
     real UI/screenshots and is consistent with Input Selection's centre snap;
     the support article does not explicitly spell out the persisted pivot, so
     that convention is marked as an inference rather than a file-format fact. */
  function rectFrame(rectOrVertices) {
    const V = Array.isArray(rectOrVertices) ? rectOrVertices
      : rectOrVertices && Array.isArray(rectOrVertices.vertices) ? rectOrVertices.vertices : null;
    if (!V || V.length < 4) return null;
    for (let i = 0; i < 4; i++) {
      if (!V[i] || !finite(toNum(V[i].x, NaN)) || !finite(toNum(V[i].y, NaN))) return null;
    }
    const ux = toNum(V[1].x, 0) - toNum(V[0].x, 0);
    const uy = toNum(V[1].y, 0) - toNum(V[0].y, 0);
    const vx = toNum(V[3].x, 0) - toNum(V[0].x, 0);
    const vy = toNum(V[3].y, 0) - toNum(V[0].y, 0);
    return {
      x: (toNum(V[0].x, 0) + toNum(V[1].x, 0) + toNum(V[2].x, 0) + toNum(V[3].x, 0)) / 4,
      y: (toNum(V[0].y, 0) + toNum(V[1].y, 0) + toNum(V[2].y, 0) + toNum(V[3].y, 0)) / 4,
      width: Math.hypot(ux, uy),
      height: Math.hypot(vx, vy),
      rotation: Math.atan2(uy, ux) * 180 / Math.PI
    };
  }

  function frameVertices(frame) {
    const f = frame || {};
    const x = toNum(f.x, 0), y = toNum(f.y, 0);
    const width = Math.max(0, toNum(f.width, 0));
    const height = Math.max(0, toNum(f.height, 0));
    const angle = toNum(f.rotation, 0) * Math.PI / 180;
    const c = Math.cos(angle), s = Math.sin(angle);
    const hx = width / 2, hy = height / 2;
    const at = (dx, dy) => pt(x + dx * c - dy * s, y + dx * s + dy * c);
    return [at(-hx, -hy), at(hx, -hy), at(hx, hy), at(-hx, hy)];
  }

  /* Return the exact affine that maps old V0/V1/V3 to new V0/V1/V3. Using
     the two stored basis vectors instead of a rotate/scale shortcut matters
     after a non-uniform Composition resize: a rotated InputRect can then be a
     sheared parallelogram, and its next inspector edit must still land on the
     requested centre/size without accumulating pivot error. */
  function affineBetweenRects(from, to) {
    if (!from || !to || from.length < 4 || to.length < 4) return null;
    const oux = from[1].x - from[0].x, ouy = from[1].y - from[0].y;
    const ovx = from[3].x - from[0].x, ovy = from[3].y - from[0].y;
    const nux = to[1].x - to[0].x, nuy = to[1].y - to[0].y;
    const nvx = to[3].x - to[0].x, nvy = to[3].y - to[0].y;
    const det = oux * ovy - ovx * ouy;
    if (!finite(det) || Math.abs(det) < 1e-12) return null;
    const ia = ovy / det, ib = -ovx / det, ic = -ouy / det, id = oux / det;
    const a = nux * ia + nvx * ic, b = nux * ib + nvx * id;
    const c = nuy * ia + nvy * ic, d = nuy * ib + nvy * id;
    const e = to[0].x - a * from[0].x - b * from[0].y;
    const f = to[0].y - c * from[0].x - d * from[0].y;
    const m = [a, b, e, c, d, f];
    return m.every(finite) ? m : null;
  }

  const applyAffinePoint = (m, p) => pt(
    m[0] * toNum(p && p.x, 0) + m[1] * toNum(p && p.y, 0) + m[2],
    m[3] * toNum(p && p.x, 0) + m[4] * toNum(p && p.y, 0) + m[5]
  );
  function applyAffinePoints(points, m) {
    if (!Array.isArray(points) || !m) return false;
    for (let i = 0; i < points.length; i++) {
      const q = applyAffinePoint(m, points[i]);
      if (points[i]) { points[i].x = q.x; points[i].y = q.y; }
      else points[i] = q;
    }
    return true;
  }

  function sliceGeometryFrame(slice, stage) {
    if (!slice || (stage !== 'input' && stage !== 'output')) return null;
    return rectFrame(stage === 'input' ? slice.inputRect : slice.outputRect);
  }

  /* Set a Slice frame as one central-pivot operation. On Input Selection only
     InputRect moves. On Output Transformation every coordinate in the output
     chain moves by the SAME affine: OutputRect, the Bezier net, and the src and
     dst homography quads. That keeps an existing warp visually identical while
     the Slice is positioned/scaled/rotated, and leaves physical Screen size and
     Composition input geometry independent. Existing XML snapshots already
     serialize all of these fields, so the editor can keep one Undo entry per
     gesture without a second model-side history. */
  function setSliceGeometryFrame(slice, stage, patch) {
    const current = sliceGeometryFrame(slice, stage);
    if (!current) return null;
    const p = patch || {};
    const next = {
      x: toNum(p.x, current.x),
      y: toNum(p.y, current.y),
      width: Math.max(0, toNum(p.width, current.width)),
      height: Math.max(0, toNum(p.height, current.height)),
      rotation: toNum(p.rotation, current.rotation)
    };
    /* A collapsed frame has no invertible basis. Refusing it is safer than
       emitting NaN through every warp point; Arena's numeric fields likewise
       keep Width/Height positive. */
    if (!(current.width > 1e-12) || !(current.height > 1e-12) ||
        !(next.width > 1e-12) || !(next.height > 1e-12)) return null;
    const rect = stage === 'input' ? slice.inputRect : slice.outputRect;
    const target = frameVertices(next);
    const m = affineBetweenRects(rect.vertices, target);
    if (!m) return null;

    applyAffinePoints(rect.vertices, m);
    if (stage === 'output') {
      const w = slice.warper;
      if (w && w.bezier) applyAffinePoints(w.bezier.vertices, m);
      if (w && w.homography) {
        applyAffinePoints(w.homography.src, m);
        applyAffinePoints(w.homography.dst, m);
      }
      slice._h = null;
    }
    return sliceGeometryFrame(slice, stage);
  }

  /* The identity net: 16 points at 1/3 spacing across the rect. This is the
     exact arrangement both real screens store, and it is the arrangement that
     makes the Bernstein surface evaluate back to S(u,v) = (u*W, v*H). */
  function identityBezier(rect) {
    const v = rect.vertices;
    const verts = [];
    for (let r = 0; r < 4; r++) {
      const tv = r / 3;
      for (let c = 0; c < 4; c++) {
        const tu = c / 3;
        const tx = v[0].x + (v[1].x - v[0].x) * tu, ty = v[0].y + (v[1].y - v[0].y) * tu;
        const bx = v[3].x + (v[2].x - v[3].x) * tu, by = v[3].y + (v[2].y - v[3].y) * tu;
        verts.push(pt(tx + (bx - tx) * tv, ty + (by - ty) * tv));
      }
    }
    return { controlWidth: 4, controlHeight: 4, vertices: verts };
  }
  const identityHomography = rect => ({ src: rect.vertices.map(cpPt), dst: rect.vertices.map(cpPt) });

  /* ---- Slice ---- */
  function makeSlice(screen, kind, init) {
    const s = init || {};
    /* Polygon / Mask / SliceMask keep their tag even though only Slice and
       DmxSlice carry geometry this file understands — losing the tag is how the
       previous exporter turned a Circle Mask into an opaque slice. */
    const type = SHAPE_TAGS[kind] ? kind : 'Slice';
    const slice = {
      type: type,
      uniqueId: str(s.uniqueId || newId()),
      params: {},
      inputRect: null,
      outputRect: null,
      warper: null,
      softEdgeGroup: false,
      softEdgeGroupAttrs: null,
      softEdgeGroupNodes: null,                          /* <Params name="Soft Edge"> and anything else Arena nests here */
      fixture: null,
      /* Clone-only: Arena has no serialised param for the per-edge blend band
         (SoftEdgeGroup's attributes were collapsed to a boolean by the
         extractor and never recovered). Kept out of the Arena subtree and
         written to the <OpenLive> sidecar instead. Widths are in normalised
         slice units, 0 = no band. */
      /* Presence is significant: a missing edge is derived from InputRect
         overlap, while an explicitly stored zero disables that one edge. */
      softEdge: {},
      flipX: false,
      flipY: false,
      extra: [],                                       /* unknown children, preserved verbatim */
      _h: null
    };
    Object.defineProperty(slice, 'screen', { value: screen, enumerable: false, writable: true });

    Object.defineProperty(slice, 'name', {
      enumerable: true,
      get() {
        const p = blockParam(slice.params, 'Common', 'Name');
        return p && p.value != null ? p.value : '';
      },
      set(v) { setBlockParam(slice.params, 'Common', 'Name', paramRec('Param', 'STRING', 'Layer', str(v))).value = str(v); }
    });
    /* SoftEdgeEnable is a real Arena param — name, T and default all verified —
       so creating the record on first write is reproduction, not invention. */
    Object.defineProperty(slice, 'softEdgeEnable', {
      enumerable: true,
      get() {
        const p = blockParam(slice.params, 'Input', 'SoftEdgeEnable');
        return !!(p && str(p.value) === '1');
      },
      set(v) { setBlockParam(slice.params, 'Input', 'SoftEdgeEnable', paramRec('Param', 'BOOL', '0', v ? '1' : '0')).value = v ? '1' : '0'; }
    });

    slice.setInputVertex = (i, p) => setVertex(slice.inputRect, i, p);
    slice.setOutputVertex = (i, p) => {
      const ok = setVertex(slice.outputRect, i, p);
      slice._h = null;
      return ok;
    };
    slice.setBezierVertex = (i, p) => {
      const g = slice.warper && slice.warper.bezier;
      if (!g || !Array.isArray(g.vertices)) return false;
      const idx = i | 0;
      if (idx < 0 || idx >= g.vertices.length) return false;
      g.vertices[idx] = cpPt(p);
      return true;
    };
    slice.setHomographyVertex = (which, i, p) => {
      const h = slice.warper && slice.warper.homography;
      const q = h && (which === 'src' ? h.src : which === 'dst' ? h.dst : null);
      const idx = i | 0;
      if (!q || idx < 0 || idx >= q.length) return false;
      q[idx] = cpPt(p);
      slice._h = null;
      return true;
    };
    slice.resetWarp = () => {
      if (!slice.outputRect) return false;
      slice.warper = { bezier: identityBezier(slice.outputRect), homography: identityHomography(slice.outputRect) };
      slice._h = null;
      return true;
    };
    slice.homographyMatrix = () => homographyOf(slice);
    slice.inputAt = (u, v) => sliceInputAt(slice, u, v);
    slice.outputAt = (u, v, H) => sliceOutputAt(slice, u, v, H);
    slice.uvFromInput = p => uvFromInput(slice, p);
    slice.geometryFrame = stage => sliceGeometryFrame(slice, stage);
    slice.setGeometryFrame = (stage, patch) => setSliceGeometryFrame(slice, stage, patch);
    slice.tessellate = n => tessellate(slice, n);
    slice.transform = p => sliceTransform(slice, p);
    slice.remove = () => (slice.screen ? slice.screen.removeSlice(slice.uniqueId) : false);
    return slice;
  }

  function setVertex(rect, i, p) {
    if (!rect || !Array.isArray(rect.vertices)) return false;
    const idx = i | 0;
    if (idx < 0 || idx >= rect.vertices.length) return false;
    rect.vertices[idx] = cpPt(p);
    return true;
  }

  function defaultSlice(screen, kind, opts) {
    const o = opts || {};
    const sl = makeSlice(screen, kind, { uniqueId: o.uniqueId });
    const comp = screen.setup ? screen.setup.compositionSize() : { width: 1920, height: 1080 };
    const dev = screen.deviceSize();
    sl.inputRect = o.inputRect ? rectFromDecoded(o.inputRect) : rectOf(0, 0, comp.width, comp.height);
    /* A DmxSlice has no pixel canvas — the real file stores a normalised unit
       quad centred on the origin, because the output is DMX channels. */
    sl.outputRect = o.outputRect ? rectFromDecoded(o.outputRect)
      : sl.type === 'DmxSlice' ? rectOf(-0.5, -0.5, 1, 1) : rectOf(0, 0, dev.width, dev.height);
    sl.name = o.name != null ? o.name : sl.type === 'DmxSlice' ? 'Fixture' : 'Slice';
    if (sl.type !== 'DmxSlice') sl.resetWarp();
    if (sl.type === 'DmxSlice') {
      sl.fixture = { uuid: str(o.fixtureUuid || ''), fixtureName: str(o.fixtureName || '') };
      if (o.fixture) setBlockParam(sl.params, 'Input', 'Fixture', paramRec('ParamChoice', 'STRING', '', str(o.fixture)));
    }
    if (o.softEdgeEnable) sl.softEdgeEnable = true;
    return sl;
  }

  /* ================= SLICE ORDER: the one place the direction is decided ======
     NAMING TRAP, restated because everything below depends on it: the <layers>
     array inside a <Screen> holds SLICES, not composition layers. Arena's own
     C++ class for a slice is literally ScreenLayer (ScreenLayerListComponent,
     ScreenLayerInputParams, ScreenLayerTransform …), which is why the tag reads
     "layers". It has nothing to do with the composition's layer stack.

     STORAGE — VERIFIED. Array position is the only carrier of order. A slice
     element is `<Slice uniqueId="…">` and nothing else; no index, no z, no
     mixer, no opacity. Reordering is therefore a pure permutation and
     serialize() writes nothing extra, which is why the XML round-trip stays
     deep-diff 0 no matter how the list is shuffled.

     DIRECTION — INFERRED, ~85%, NOT OBSERVED. index 0 = first in <layers> =
     drawn FIRST = BACK-most, and index 0 is also the TOP row of the slice tree.
     Hence "Bring Forward" = +1 in the array = the row moves DOWN the list.
     Reasons: the batched slice shader walks a UBO with an ascending
     CurrentSliceIndex, so slices[0] is drawn first and later draws land on top;
     an output mask "is applied to all the slices underneath it", i.e. to the
     pixels already in the framebuffer, i.e. to lower indices; addSlice appends,
     and an appended slice has to be visible; the AO panel is a generic tree that
     also lists DMX fixtures, where "1 - 48" must be the top row.
     THE COUNTER-CASE, which is why this is 85% and not 99%: Arena's COMPOSITION
     layer panel does invert its array for display — Layer 1 is layerIndex 0 and
     sits at the BOTTOM. If the AO tree did the same, every direction here flips.
     The 30-second check that settles it, for whoever has Arena in front of them:
     overlap two slices in one screen, note which is visible, then note which row
     is upper. If it flips, flip FORWARD_DELTA and frontIndex/backIndex below and
     nothing else in the codebase needs to change. */
  const ORDER = {
    forwardDelta: +1,                                  /* "Bring Forward" = +1 */
    backwardDelta: -1,                                 /* "Send Backwards" = -1 */
    frontIndex: n => Math.max(0, (n | 0) - 1),         /* last drawn = front */
    backIndex: () => 0,                                /* first drawn = back */
    /* true when a comes out IN FRONT OF b, given their array indices */
    inFrontOf: (ia, ib) => ia > ib,
    /* what the tree should tell the user, so the direction is never a guess */
    topLabel: 'back',
    bottomLabel: 'front',
    verified: false,
    note: 'Top of the slice list is drawn first and is BACK-most; Bring Forward moves a slice DOWN the list. Inferred from Arena\'s shader and manual, not observed.'
  };

  /* Output raster ownership. VERIFIED where noted: screens.htm says
     Display resolution comes from the operating system, while playback-card
     video format owns Capture size; a Lumiverse has no pixel raster. Virtual,
     Spout/Syphon and Advanced-Output NDI expose editable Width/Height. INFERRED:
     Snapshot and Component are clone/runtime render targets with the same
     editable-size contract. `followComposition` itself is NOT an Arena mode:
     it is an explicit OpenLive convenience, quarantined in our sidecar below. */
  const CONFIGURABLE_OUTPUT_KINDS = Object.freeze({
    OutputDeviceVirtual: true,
    OutputDeviceSpout: true,
    OutputDeviceSyphon: true,
    OutputDeviceNDI: true,
    OutputDeviceSnapshot: true,
    OutputDeviceApiSnapshot: true,
    OutputDeviceComponent: true,
    /* A Broadcast HAS a pixel raster — that is exactly what distinguishes it
       from a Lumiverse, whose device is sizeless. Omitting it here made
       setDeviceSize return null and let advanced-output.html publish a
       fabricated 1920x1080 to the Hub and the Slices panel. */
    OutputDeviceStream: true
  });
  const outputDeviceCanFollowComposition = kind => !!CONFIGURABLE_OUTPUT_KINDS[str(kind || '')];

  /* Every screen element tag this build knows.
     This replaces `type === 'DmxScreen' ? 'DmxScreen' : 'Screen'`, which spread
     the set of legal kinds across an inline ternary. It is the single seam a
     third screen kind registers through — add the tag here and makeScreen stops
     flattening it.
     It does NOT yet refuse an unknown tag: the fallback to 'Screen' is retained
     deliberately, because screenFromXML re-asserts sc.type from the element name
     afterwards and a document written by a newer build must still open. So an
     unregistered kind is still coerced silently. Making that a reported refusal
     needs a warning channel this module does not have — recorded here rather
     than claimed as done. */
  const SCREEN_TAGS = { Screen: 1, DmxScreen: 1, StreamScreen: 1 };

  /* ---- Screen ---- */
  function makeScreen(setup, type, init) {
    const s = init || {};
    const requested = str(type || 'Screen');
    const screen = {
      type: SCREEN_TAGS[requested] ? requested : 'Screen',
      uniqueId: str(s.uniqueId || newId()),
      lumiverseId: s.lumiverseId != null ? str(s.lumiverseId) : null,
      params: {},
      guides: [],
      layers: [],
      /* StreamScreen only. ONE Broadcast fans out to MANY destinations — this is
         the direct counterpart of dmx.htm's "one Lumiverse can be routed to
         multiple universes, and a universe is how that Lumiverse gets routed
         outside Resolume". The encode is shared: one raster, one Encoder, one
         bitstream, N transport connections. "One program per connection" limits
         what a single connection may carry; it says nothing about how many
         connections may carry the same program, which is exactly why fanning out
         locally is cheap and why a second ENCODE (divergent geometry or codec)
         is not — that needs its own Broadcast, and the cost is visible there. */
      destinations: [],
      outputDevice: null,
      attrs: {},                                       /* Hidden, folded, anything else on the element */
      extra: []
    };
    Object.defineProperty(screen, 'setup', { value: setup, enumerable: false, writable: true });
    /* Clone-only and non-enumerable: generic object/decoded exports cannot
       mistake this for an Arena Screen or OutputDevice field. */
    Object.defineProperty(screen, 'followComposition', { value: false, enumerable: false, writable: true });

    /* Arena stores the screen name twice — as the element attribute and as the
       Name param — and both are read back, so both are kept in step. */
    Object.defineProperty(screen, 'name', {
      enumerable: true,
      get() {
        const p = blockParam(screen.params, 'Params', 'Name');
        if (p && p.value != null) return p.value;
        return screen.attrs.name != null ? screen.attrs.name : '';
      },
      set(v) {
        const n = str(v);
        screen.attrs.name = n;
        setBlockParam(screen.params, 'Params', 'Name', paramRec('Param', 'STRING', '', n)).value = n;
      }
    });

    screen.slices = () => screen.layers.slice();
    screen.sliceById = id => screen.layers.find(l => l.uniqueId === str(id)) || null;
    screen.addSlice = (kind, opts) => {
      const sl = defaultSlice(screen, kind || (screen.type === 'DmxScreen' ? 'DmxSlice' : 'Slice'), opts);
      screen.layers.push(sl);
      return sl;
    };
    screen.removeSlice = id => {
      const i = screen.layers.findIndex(l => l.uniqueId === str(id));
      if (i < 0) return false;
      screen.layers.splice(i, 1);
      return true;
    };
    /* ---- slice order -------------------------------------------------------
       Position in <layers> is the ONLY carrier of z order. VERIFIED: the live
       AdvancedOutput.xml has no index=/zIndex=/order=/layerIndex= anywhere on a
       Slice, while a COMPOSITION layer in Example.avc carries an explicit
       layerIndex="0". Arena indexes composition layers on purpose and does not
       index slices. So ordering here is a pure list permutation and serialize()
       has nothing extra to write — see ORDER below for the direction. */
    screen.sliceIndex = id => screen.layers.findIndex(l => l.uniqueId === str(id));

    /* One step, the way Arena's two menu items do it. delta is a SIGNED STEP,
       not a target index: moveSlice(id, +1) is "Bring Forward". Clamps at the
       ends rather than wrapping, and reports whether anything actually moved. */
    screen.moveSlice = (id, delta) => {
      const i = screen.sliceIndex(id);
      if (i < 0) return false;
      const t = clamp(i + (delta | 0), 0, screen.layers.length - 1);
      if (t === i) return false;
      screen.layers.splice(t, 0, screen.layers.splice(i, 1)[0]);
      return true;
    };
    /* The absolute-index form, which is what moveSlice used to be. Kept under
       its own name because a drag lands on a position while a menu item takes a
       step, and collapsing the two is how a drag ends up moving one row. */
    screen.moveSliceTo = (id, index) => {
      const i = screen.sliceIndex(id);
      if (i < 0) return false;
      const t = clamp(index | 0, 0, screen.layers.length - 1);
      if (t === i) return false;
      screen.layers.splice(t, 0, screen.layers.splice(i, 1)[0]);
      return true;
    };
    /* CLONE EXTENSIONS. Arena has exactly two ordering commands, "Bring Forward"
       and "Send Backwards", both single-step; no bring-to-front / send-to-back
       literal exists anywhere in Arena.exe. These are here because the clone's
       own UI offers them, and every caller that surfaces them has to say so. */
    screen.bringToFront = id => screen.moveSliceTo(id, ORDER.frontIndex(screen.layers.length));
    screen.sendToBack = id => screen.moveSliceTo(id, ORDER.backIndex(screen.layers.length));

    /* Explicit order, for a multi-selection or a drag that moves several rows.

       CONTRACT, stated in ORDER's vocabulary so it cannot drift from the code
       again: the named ids are written to indices 0..n-1 IN THE ORDER GIVEN.
       ORDER.backIndex is 0, so THE NAMED IDS END UP AT THE BACK and every id
       not named keeps its relative order and ends up IN FRONT of them.
       Measured, not assumed: with layers A B C D, reorder([D,A]) yields
       D A B C — D and A at indices 0 and 1, B and C pushed in front.
       (An earlier version of this comment said the opposite. It was wrong; the
       code was not. The code is what both callers were written against —
       openlive-output-editor.js's stack.toEnd() and stack.dropAt() each build a
       COMPLETE permutation and hand it over, so for them this is simply "apply
       this list as the order" and the partial-list rule never fires.)

       Unknown ids and duplicates are dropped rather than throwing, because this
       is fed straight from a UI selection. A call that would change the slice
       COUNT is refused outright, so a bad id can never lose a slice. */
    screen.reorder = ids => {
      const want = [];
      (Array.isArray(ids) ? ids : [ids]).forEach(id => {
        const sl = screen.sliceById(id);
        if (sl && want.indexOf(sl) < 0) want.push(sl);
      });
      if (!want.length) return false;
      const rest = screen.layers.filter(l => want.indexOf(l) < 0);
      const next = want.concat(rest);
      if (next.length !== screen.layers.length) return false;      /* never lose a slice */
      const same = next.every((l, i) => l === screen.layers[i]);
      screen.layers.splice(0, screen.layers.length, ...next);
      return !same;
    };

    /* Move a whole multi-selection one step, keeping the selection's own
       internal order and letting it travel as a block: a selected slice never
       swaps with another selected slice, so the group cannot scramble or
       collapse. UNVERIFIED against Arena — input-selection.htm documents
       multi-select for move/scale/rotate and delete only, and says nothing about
       reordering several at once. This is the behaviour a user would expect. */
    screen.moveSelection = (ids, delta) => {
      const d = delta | 0;
      if (!d) return false;
      const want = new Set();
      (Array.isArray(ids) ? ids : [ids]).forEach(id => { const sl = screen.sliceById(id); if (sl) want.add(sl); });
      if (!want.size) return false;
      const l = screen.layers;
      let moved = false;
      const step = d > 0 ? 1 : -1;
      for (let n = 0; n < Math.abs(d); n++) {
        if (step > 0) {
          for (let i = l.length - 2; i >= 0; i--)
            if (want.has(l[i]) && !want.has(l[i + 1])) { const t = l[i]; l[i] = l[i + 1]; l[i + 1] = t; moved = true; }
        } else {
          for (let i = 1; i < l.length; i++)
            if (want.has(l[i]) && !want.has(l[i - 1])) { const t = l[i]; l[i] = l[i - 1]; l[i - 1] = t; moved = true; }
        }
      }
      return moved;
    };
    screen.deviceFollowsComposition = () => !!screen.followComposition &&
      !!screen.outputDevice && outputDeviceCanFollowComposition(screen.outputDevice.kind);
    screen.deviceSize = () => {
      if (screen.deviceFollowsComposition() && screen.setup) return screen.setup.compositionSize();
      const d = screen.outputDevice;
      const w = d ? toNum(d.width, 0) : 0, h = d ? toNum(d.height, 0) : 0;
      /* Missing native dimensions are not evidence for 1920x1080. Use the
         current Composition as the renderer's one-time fallback; persisted
         Display/Capture modes with width/height remain strictly fixed. */
      const fallback = screen.setup ? screen.setup.compositionSize() : { width: 1920, height: 1080 };
      return { width: w > 0 ? w : fallback.width, height: h > 0 ? h : fallback.height };
    };
    screen.setDeviceFollowComposition = enabled => {
      if (!screen.outputDevice) {
        screen.outputDevice = { kind: 'OutputDeviceVirtual' };
      }
      const on = !!enabled && outputDeviceCanFollowComposition(screen.outputDevice.kind);
      screen.followComposition = on;
      if (on) {
        const size = screen.setup ? screen.setup.compositionSize() : { width: 1920, height: 1080 };
        screen.outputDevice.width = String(Math.max(1, Math.round(toNum(size.width, 1920))));
        screen.outputDevice.height = String(Math.max(1, Math.round(toNum(size.height, 1080))));
      }
      return on;
    };
    screen.setDeviceSize = (w, h) => {
      const d = screen.outputDevice;
      if (!d || !outputDeviceCanFollowComposition(d.kind)) return null;
      const old = screen.deviceSize();
      screen.followComposition = false;
      d.width = String(Math.max(1, Math.round(toNum(w, old.width))));
      d.height = String(Math.max(1, Math.round(toNum(h, old.height))));
      return screen.deviceSize();
    };
    screen.setOutputDevice = (kind, a, options) => {
      const k = str(kind || 'OutputDeviceVirtual');
      const attrs = Object.assign({}, a || {});
      /* Never let the clone-only policy leak into Arena's native attributes,
         even if a caller accidentally puts it in the attrs bag. */
      delete attrs.kind;
      delete attrs.followComposition;
      const previousSize = screen.deviceSize();
      const wasFollower = screen.deviceFollowsComposition();
      const opts = options || {};
      const explicitPolicy = Object.prototype.hasOwnProperty.call(opts, 'followComposition');
      const mayFollow = outputDeviceCanFollowComposition(k);
      const follow = mayFollow && (explicitPolicy ? !!opts.followComposition : wasFollower);
      const seed = follow && screen.setup ? screen.setup.compositionSize() : previousSize;
      if (mayFollow || k === 'OutputDeviceDisplay' || k === 'OutputDeviceCapture') {
        if (!(toNum(attrs.width, 0) > 0)) attrs.width = String(Math.max(1, Math.round(seed.width)));
        if (!(toNum(attrs.height, 0) > 0)) attrs.height = String(Math.max(1, Math.round(seed.height)));
      }
      attrs.kind = k;
      screen.outputDevice = attrs;
      screen.followComposition = false;
      screen.setDeviceFollowComposition(follow);          /* hardware kinds force false */
      return screen.outputDevice;
    };
    screen.addGuide = t => {
      const g = { name: 'ScreenGuide', type: str(t == null ? 0 : t) };
      screen.guides.push(g);
      return g;
    };
    screen.removeGuide = i => {
      const idx = i | 0;
      if (idx < 0 || idx >= screen.guides.length) return false;
      screen.guides.splice(idx, 1);
      return true;
    };

    /* ---- destinations (StreamScreen) ------------------------------------
       Deliberately unbounded. A Broadcast is expected to carry twenty or more:
       they all share the one encode, so the Nth costs a socket and the uplink
       bandwidth, not another encoder. No secret lives on these records —
       endpointRef names a slot resolved outside the document. */
    screen.addDestination = init => {
      const o = init || {};
      const d = {
        uniqueId: str(o.uniqueId || newId()),
        name: str(o.name || 'Destination ' + (screen.destinations.length + 1)),
        transport: str(o.transport || 'ST_DISABLED'),
        endpointRef: str(o.endpointRef || ''),
        enabled: o.enabled != null ? !!o.enabled : true,
        /* WHICH SERVICE this destination is, as opposed to which protocol
           carries it. Without these the picker's choice died on reload: the
           name persisted but the service did not, so a row could read "Twitch"
           while pointing at Custom RTMP — a control disagreeing with itself,
           which is exactly what CLAUDE.md forbids.

           accountId/channelId are set only for a connected channel. They are
           references, never credentials: the refresh token stays in the
           helper's encrypted store and the stream key is fetched at Go and
           never written here. This record IS exported and mailed. */
        serviceKey: str(o.serviceKey || ''),
        platformId: o.platformId != null && o.platformId !== '' ? +o.platformId : null,
        accountId: str(o.accountId || '') || null,
        channelId: str(o.channelId || '') || null
      };
      screen.destinations.push(d);
      return d;
    };
    screen.removeDestination = id => {
      const i = screen.destinations.findIndex(d => d.uniqueId === str(id));
      if (i < 0) return false;
      screen.destinations.splice(i, 1);
      return true;
    };
    screen.destinationById = id => screen.destinations.find(d => d.uniqueId === str(id)) || null;
    screen.moveDestination = (id, to) => {
      const i = screen.destinations.findIndex(d => d.uniqueId === str(id));
      if (i < 0) return false;
      const t = clamp(to | 0, 0, screen.destinations.length - 1);
      screen.destinations.splice(t, 0, screen.destinations.splice(i, 1)[0]);
      return true;
    };
    screen.remove = () => (screen.setup ? screen.setup.removeScreen(screen.uniqueId) : false);
    return screen;
  }

  /* ---- ScreenSetup ---- */
  function makeSetup() {
    const setup = {
      source: null,
      versionInfo: { name: 'Resolume Arena', majorVersion: '7', minorVersion: '27', microVersion: '1', revision: '15990' },
      compositionTexture: { width: '1920', height: '1080' },
      softEdging: {},                                  /* named Params blocks, verbatim */
      setupParams: {},                                 /* <Params name="ScreenSetupParams"> */
      screensList: [],
      extra: []
    };

    setup.screens = () => setup.screensList.slice();
    setup.screenById = id => setup.screensList.find(s => s.uniqueId === str(id)) || null;
    setup.addScreen = opts => {
      const o = opts || {};
      const sc = makeScreen(setup, o.type || 'Screen', { uniqueId: o.uniqueId, lumiverseId: o.lumiverseId });
      const comp = setup.compositionSize();
      const explicitSize = o.width != null || o.height != null;
      const w = Math.round(toNum(o.width, comp.width)), h = Math.round(toNum(o.height, comp.height));
      /* Ordinals count within the KIND, not across the whole list. Both of these
         used to read setup.screensList.length, so after two Screens the first
         Lumiverse was named "Lumiverse 3" and given LumiverseId "2". Arena's own
         file disagrees: sample-AdvancedOutput.xml holds Screen, Screen,
         DmxScreen — and that DmxScreen carries LumiverseId="0". */
      const ofKind = setup.screensList.filter(x => x.type === sc.type).length;
      const PREFIX = { DmxScreen: 'Lumiverse ', StreamScreen: 'Broadcast ', Screen: 'Screen ' };
      const nm = str(o.name || (PREFIX[sc.type] || 'Screen ') + (ofKind + 1));
      sc.name = nm;
      if (sc.type === 'StreamScreen') {
        /* OPENLIVE EXTENSION — no Arena counterpart. streaming.htm: "It's not
           possible to directly stream from Resolume."

           Modelled on the Lumiverse: an internal output space that is a peer of
           Screen in this tree, addressed outward through a separate target. The
           difference that drives everything else is that a Broadcast HAS a
           raster — a Lumiverse's device is sizeless because a fixture samples
           single pixels, whereas an encoder needs a frame. That is why its
           children are ordinary Slices and not a new DmxSlice-like type.

           Target and Endpoint Ref are a MODE TOKEN and a SLOT NAME, never a URL
           and never a key, so this element stays safe to export. See the
           export-scan guard before any of this reaches AdvancedOutput.xml. */
        sc.setOutputDevice('OutputDeviceStream', {
          name: nm, deviceId: 'Broadcast', idHash: idHash(nm + ':stream'),
          width: String(w), height: String(h)
        }, { followComposition: o.followComposition != null ? !!o.followComposition : !explicitSize });
        setBlockParam(sc.params, 'Params', 'Target',
          paramRec('ParamChoice', 'STRING', 'ST_DISABLED', 'ST_DISABLED'));
        setBlockParam(sc.params, 'Params', 'Endpoint Ref',
          paramRec('Param', 'STRING', '', ''));
        setBlockParam(sc.params, 'Params', 'Encoder',
          paramRec('Param', 'STRING', '', ''));
        /* Never empty, as dmx.htm's new Lumiverse arrives with one fixture. */
        sc.addDestination({ name: 'Destination 1' });
      } else if (sc.type === 'DmxScreen') {
        if (sc.lumiverseId == null) sc.lumiverseId = String(ofKind);
        setBlockParam(sc.params, 'Params', 'Auto Span', paramRec('Param', 'BOOL', '1', '1'));
        setBlockParam(sc.params, 'Params', 'Align Output', paramRec('Param', 'BOOL', '1', '1'));
        sc.setOutputDevice('OutputDeviceDmx', { name: 'Lumiverse', deviceId: 'Lumiverse', idHash: idHash(nm + ':dmx') });
      } else {
        sc.setOutputDevice(o.deviceKind || 'OutputDeviceVirtual', {
          name: nm, deviceId: 'Virtual' + nm.replace(/^Screen/, ''), idHash: idHash(nm),
          width: String(w), height: String(h)
        }, {
          /* UNDOCUMENTED OpenLive policy: a new configurable output with no
             requested raster tracks the Composition until its size is edited.
             Supplying width or height means the caller deliberately requested
             a custom Advanced Output raster, so it starts fixed. */
          followComposition: o.followComposition != null ? !!o.followComposition : !explicitSize
        });
      }
      /* Both real screens ship an Input guide and an Output guide. */
      sc.addGuide(0); sc.addGuide(1);
      setup.screensList.push(sc);
      return sc;
    };
    setup.removeScreen = id => {
      const i = setup.screensList.findIndex(s => s.uniqueId === str(id));
      if (i < 0) return false;
      setup.screensList.splice(i, 1);
      return true;
    };
    setup.moveScreen = (id, to) => {
      const i = setup.screensList.findIndex(s => s.uniqueId === str(id));
      if (i < 0) return false;
      const t = clamp(to | 0, 0, setup.screensList.length - 1);
      setup.screensList.splice(t, 0, setup.screensList.splice(i, 1)[0]);
      return true;
    };
    setup.slices = () => {
      const out = [];
      for (const sc of setup.screensList) for (const sl of sc.layers) out.push(sl);
      return out;
    };
    setup.sliceById = id => setup.slices().find(s => s.uniqueId === str(id)) || null;
    /* Move existing Slice objects between Screens without recreating them.
       The unique id, routing identity, Input Rect, Output Rect and complete warp
       net therefore survive the move byte-for-byte. Resolume documents the
       gesture and the rule that a Screen must retain one Slice, but does not
       document coordinate conversion between different output rasters. The
       lossless policy here is explicit: preserve absolute output-pixel geometry
       and let the operator reposition it on the destination Screen. */
    setup.moveSlices = (ids, fromId, toId, at, options) => {
      const from=setup.screenById(fromId), to=setup.screenById(toId);
      const fail=(code,message)=>({ok:false,code,message,moved:[]});
      if(!from || !to) return fail('missing-screen','Source or destination Screen is missing');
      if(from === to) return fail('same-screen','Use Screen.reorder() inside one Screen');
      if(from.type !== to.type)
        return fail('incompatible-screen-type','Slices cannot move between a Screen and a Lumiverse');
      const wanted=new Set((ids || []).map(str));
      const moving=from.layers.filter(slice=>wanted.has(str(slice.uniqueId)));
      if(!moving.length) return fail('missing-slice','No source Slice was selected');
      if(from.layers.length-moving.length < 1)
        return fail('last-slice','A Screen must keep at least one Slice');
      const targetIndex=clamp(at | 0,0,to.layers.length);
      const result={ok:true,code:'moved',message:'Moved '+moving.length+' Slice'+(moving.length===1?'':'s'),
        moved:moving.map(slice=>str(slice.uniqueId)),from:from.uniqueId,to:to.uniqueId,index:targetIndex};
      if(options && options.validateOnly) return result;
      const movingSet=new Set(moving);
      from.layers.splice(0,from.layers.length,...from.layers.filter(slice=>!movingSet.has(slice)));
      to.layers.splice(targetIndex,0,...moving);
      moving.forEach(slice=>{ slice.screen=to; });
      return result;
    };
    /* The raw record stays strings because that is what round-trips; maths asks
       for numbers and gets numbers. */
    setup.compositionSize = () => ({
      width: toNum(setup.compositionTexture.width, 1920) || 1920,
      height: toNum(setup.compositionTexture.height, 1080) || 1080
    });
    setup.setCompositionSize = (w, h) => {
      const old = setup.compositionSize();
      const width = Math.max(1, Math.round(toNum(w, old.width)));
      const height = Math.max(1, Math.round(toNum(h, old.height)));
      if (width === old.width && height === old.height) {
        /* Reassert the explicit follower invariant if a caller previously
           changed raw attrs instead of using setDeviceSize(). */
        for (const screen of setup.screensList)
          if (screen.deviceFollowsComposition()) screen.setDeviceFollowComposition(true);
        return old;
      }

      /* UNDOCUMENTED — inferred from Arena's separate persisted
         CurrentCompositionTextureSize, InputRect and OutputRect records.
         Input Selection is expressed in Composition pixels, so an existing
         selection follows a Composition-resolution change proportionally.
         OutputRect and the Warper deliberately stay untouched: they describe
         physical Screen/output space, not the input texture. OutputDevice also
         stays independent unless it carries the explicit clone-side follower
         policy; Arena itself does not expose such a mode. */
      const sx = width / old.width, sy = height / old.height;
      for (const slice of setup.slices()) {
        const vertices = slice && slice.inputRect && slice.inputRect.vertices;
        if (!Array.isArray(vertices)) continue;
        for (const vertex of vertices) {
          if (!vertex) continue;
          vertex.x = toNum(vertex.x, 0) * sx;
          vertex.y = toNum(vertex.y, 0) * sy;
        }
      }
      setup.compositionTexture = { width: String(width), height: String(height) };
      for (const screen of setup.screensList)
        if (screen.deviceFollowsComposition()) screen.setDeviceFollowComposition(true);
      return setup.compositionSize();
    };
    /* Only Power exists in the one real file. Luminance and Gamma are named in
       the binary and in the help XML with these defaults, but writing records
       that were never on disk would break the round trip, so absent means
       "use the shader default", not "write a zero". */
    setup.softEdgeParam = name => {
      for (const b in setup.softEdging) {
        const p = setup.softEdging[b][name];
        if (p) return p;
      }
      return null;
    };
    setup.softEdgeValue = (name, dflt) => {
      const p = setup.softEdgeParam(name);
      return p ? toNum(p.value, dflt) : dflt;
    };
    setup.setSoftEdgeValue = (name, v) => {
      const p = setup.softEdgeParam(name);
      const val = String(num(v, 0));
      if (p) { p.value = val; return p; }
      const block = setup.softEdging['Soft Edge'] || (setup.softEdging['Soft Edge'] = {});
      const dflt = name === 'Power' ? '2' : name === 'Luminance' ? '0.5' : '2.2';
      block[name] = paramRec('ParamRange', 'DOUBLE', dflt, val);
      return block[name];
    };
    setup.softEdgeOptions = () => ({
      power: setup.softEdgeValue('Power', SOFT_EDGE_DEFAULTS.power),
      luminance: setup.softEdgeValue('Luminance', SOFT_EDGE_DEFAULTS.luminance),
      gamma: setup.softEdgeValue('Gamma', SOFT_EDGE_DEFAULTS.gamma),
      gammaRed: setup.softEdgeValue('Gamma Red', setup.softEdgeValue('Gamma', SOFT_EDGE_DEFAULTS.gamma)),
      gammaGreen: setup.softEdgeValue('Gamma Green', setup.softEdgeValue('Gamma', SOFT_EDGE_DEFAULTS.gamma)),
      gammaBlue: setup.softEdgeValue('Gamma Blue', setup.softEdgeValue('Gamma', SOFT_EDGE_DEFAULTS.gamma))
    });
    setup.clear = () => {
      setup.source = null;
      setup.screensList.length = 0;
      setup.softEdging = {};
      setup.setupParams = {};
      setup.extra = [];
      setup.compositionTexture = { width: '1920', height: '1080' };
      return setup;
    };
    return setup;
  }

  /* Arena's idHash is an unsigned 64-bit decimal. The algorithm is not
     recoverable from the binary, so clone-made devices get a stable FNV-1a
     widened to 64 bits: unique and reproducible, which is all a clone needs.
     Hashes read off disk are preserved verbatim and never regenerated. */
  function idHash(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const t = str(s);
    for (let i = 0; i < t.length; i++) {
      h1 = Math.imul(h1 ^ t.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 + t.charCodeAt(i), 2654435761) >>> 0;
    }
    return String(BigInt(h1) * 4294967296n + BigInt(h2));
  }

  /* ================= the geometry chain =================
       (u,v) in [0,1]^2
         input  : flip -> affine sliceMatrix -> composition pixels      [GPU side]
         output : S(u,v) bicubic patch -> H * S(u,v) -> screen pixels   [CPU side]
     The two halves are joined only by the shared (u,v); there is no single
     matrix from input to output, and treating it as one is how a keystoned
     slice ends up drawn square. */

  const rectOfSlice = s => s.outputRect || (s.OutputRect ? rectFromDecoded(s.OutputRect) : null);
  const inRectOfSlice = s => s.inputRect || (s.InputRect ? rectFromDecoded(s.InputRect) : null);

  /* Accepts a model slice or a raw decoded record, so the renderer can hand us
     whatever it is holding without converting first. */
  function coerceSlice(s) {
    if (!s) return null;
    if (s.inputRect || s.outputRect) return s;
    return {
      type: s.type || 'Slice',
      inputRect: inRectOfSlice(s),
      outputRect: rectOfSlice(s),
      warper: s.warper || null,
      flipX: !!s.flipX, flipY: !!s.flipY,
      softEdge: s.softEdge || null,
      softEdgeEnable: !!s.softEdgeEnable,
      _h: null
    };
  }

  const flipUV = (slice, u, v) => ({ u: slice.flipX ? 1 - u : u, v: slice.flipY ? 1 - v : v });

  /* Forward input map. Affine by construction: the shader never divides in_uv
     by w, so V2 is redundant and the rect is always a rotated rectangle. */
  function sliceInputAt(slice, u, v) {
    const s = coerceSlice(slice);
    const r = s && s.inputRect;
    if (!r || r.vertices.length < 4) return pt(0, 0);
    const f = flipUV(s, clamp01(num(u, 0)), clamp01(num(v, 0)));
    const V = r.vertices;
    return pt(V[0].x + (V[1].x - V[0].x) * f.u + (V[3].x - V[0].x) * f.v,
      V[0].y + (V[1].y - V[0].y) * f.u + (V[3].y - V[0].y) * f.v);
  }

  /* Inverse input map: composition pixel -> (u,v). A collapsed rect has no
     inverse; returning (0,0) keeps the caller finite and puts the point at the
     slice origin, which is visible and debuggable. */
  function uvFromInput(slice, p) {
    const s = coerceSlice(slice);
    const r = s && s.inputRect;
    if (!r || r.vertices.length < 4) return { u: 0, v: 0 };
    const V = r.vertices;
    const ax = V[1].x - V[0].x, ay = V[1].y - V[0].y;
    const bx = V[3].x - V[0].x, by = V[3].y - V[0].y;
    const det = ax * by - ay * bx;
    if (!finite(det) || Math.abs(det) < 1e-12) return { u: 0, v: 0 };
    const dx = num(p && p.x, 0) - V[0].x, dy = num(p && p.y, 0) - V[0].y;
    const u = (dx * by - dy * bx) / det;
    const v = (ax * dy - ay * dx) / det;
    const f = flipUV(s, num(u, 0), num(v, 0));           /* flip is an involution */
    return { u: f.u, v: f.v };
  }

  /* Reports a file whose InputRect is not a parallelogram. The shader says that
     cannot happen; if it does, the fourth vertex is being ignored and the user
     deserves to know rather than wonder why the picture is off. */
  function inputIsAffine(slice, tol) {
    const s = coerceSlice(slice);
    const r = s && s.inputRect;
    if (!r || r.vertices.length < 4) return true;
    const V = r.vertices;
    const ex = V[1].x + V[3].x - V[0].x, ey = V[1].y + V[3].y - V[0].y;
    const scale = Math.max(1, Math.abs(V[0].x), Math.abs(V[0].y), Math.abs(V[2].x), Math.abs(V[2].y));
    return Math.hypot(V[2].x - ex, V[2].y - ey) <= num(tol, scale * 1e-6);
  }

  /* Cached by the eight numbers it was solved from, so direct mutation of
     warper.homography.dst[i] invalidates it without anyone having to remember
     to call a setter. */
  function homographyOf(slice) {
    const s = coerceSlice(slice);
    const h = s && s.warper && s.warper.homography;
    if (!h || !Array.isArray(h.src) || !Array.isArray(h.dst) || h.src.length < 4 || h.dst.length < 4) return null;
    let key = '';
    for (let i = 0; i < 4; i++) key += h.src[i].x + ',' + h.src[i].y + ',' + h.dst[i].x + ',' + h.dst[i].y + ';';
    const c = s._h;
    if (c && c.key === key) return c.H;
    const H = solveHomography(h.src, h.dst);
    s._h = { key: key, H: H };
    return H;
  }

  /* Base output surface: the Bezier patch when a net exists, otherwise the
     bilinear read of OutputRect — which is exactly right for a DmxSlice, whose
     output is a normalised unit quad with no warper at all. */
  function outputBase(slice, u, v) {
    const g = coerceGrid(slice.warper && slice.warper.bezier);
    if (g) return surfaceFn(g, u, v);
    const r = slice.outputRect;
    if (!r || r.vertices.length < 4) return pt(0, 0);
    const V = r.vertices;
    const tx = V[0].x + (V[1].x - V[0].x) * u, ty = V[0].y + (V[1].y - V[0].y) * u;
    const bx = V[3].x + (V[2].x - V[3].x) * u, by = V[3].y + (V[2].y - V[3].y) * u;
    return pt(tx + (bx - tx) * v, ty + (by - ty) * v);
  }

  /* The composition order. INFERRED, not measured — every warper in the one
     real file is at identity, where the two orders are indistinguishable. See
     the header for the three arguments that put H last. To settle it: in Arena
     drag one big corner AND one small corner, save, and read whether the small
     corner's stored coordinate moved. If it did, call setWarpOrder('H-first'). */
  let warpOrder = 'bezier-then-H';
  const setWarpOrder = o => (warpOrder = o === 'H-first' ? 'H-first' : 'bezier-then-H');

  function sliceOutputAt(slice, u, v, H) {
    const s = coerceSlice(slice);
    if (!s) return pt(0, 0);
    const uu = clamp01(num(u, 0)), vv = clamp01(num(v, 0));
    const M = H === undefined ? homographyOf(s) : H;
    if (warpOrder === 'H-first') {
      const r = s.outputRect;
      if (!r || r.vertices.length < 4) return pt(0, 0);
      const V = r.vertices;
      const tx = V[0].x + (V[1].x - V[0].x) * uu, ty = V[0].y + (V[1].y - V[0].y) * uu;
      const bx = V[3].x + (V[2].x - V[3].x) * uu, by = V[3].y + (V[2].y - V[3].y) * uu;
      const p = M ? applyHomography(M, pt(tx + (bx - tx) * vv, ty + (by - ty) * vv))
        : pt(tx + (bx - tx) * vv, ty + (by - ty) * vv);
      return pt(p.x, p.y);
    }
    const base = outputBase(s, uu, vv);
    const p = M ? applyHomography(M, base) : base;
    return pt(p.x, p.y);
  }

  /* The whole pipeline, composition pixel -> screen pixel. */
  function sliceTransform(slice, p) {
    const s = coerceSlice(slice);
    if (!s) return pt(0, 0);
    const uv = uvFromInput(s, p);
    return sliceOutputAt(s, uv.u, uv.v);
  }

  /* The mesh the renderer draws. Pure numbers: (n+1)^2 nodes, each carrying the
     screen-space position, the composition-space texcoord and the soft-edge
     alpha, plus the triangle indices. Density is the only defence against
     perspective error, because the vertex shader carries no q. */
  function tessellate(slice, n) {
    const s = coerceSlice(slice);
    const N = clamp(Math.round(num(n, 8)), 1, 256);
    const H = homographyOf(s);
    const nodes = [];
    for (let j = 0; j <= N; j++) {
      const v = j / N;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const o = sliceOutputAt(s, u, v, H);
        const t = sliceInputAt(s, u, v);
        nodes.push({ u: u, v: v, x: o.x, y: o.y, s: t.x, t: t.y, a: softEdgeAlpha(s, u, v) });
      }
    }
    const tris = [];
    const idx = (i, j) => j * (N + 1) + i;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        tris.push(idx(i, j), idx(i + 1, j), idx(i + 1, j + 1));
        tris.push(idx(i, j), idx(i + 1, j + 1), idx(i, j + 1));
      }
    }
    return { n: N, nodes: nodes, triangles: tris };
  }

  /* Arena draws the blend as a separate additive quad whose texcoord.x IS the
     shader's `curve`, so the CURVE below is verbatim but the mapping from (u,v)
     to t is this clone's reading of where the band sits. Bands default to zero
     width: no configured overlap means alpha 1, not an invented 25% ramp. */
  function softEdgeAlpha(slice, u, v, power) {
    const s = coerceSlice(slice);
    if (!s || !s.softEdgeEnable) return 1;
    const b = s.softEdge;
    if (!b) return 1;
    const opts = liveSetup ? liveSetup.softEdgeOptions() : Object.assign({}, SOFT_EDGE_DEFAULTS);
    const P = finite(power) ? power : num(opts.power, SOFT_EDGE_DEFAULTS.power);
    const L = num(opts.luminance, SOFT_EDGE_DEFAULTS.luminance);
    const G = num(opts.gamma, SOFT_EDGE_DEFAULTS.gamma);
    const uu = clamp01(num(u, 0)), vv = clamp01(num(v, 0));
    let a = 1;
    const edge = (d, w) => {
      const W = num(w, 0);
      if (!(W > 0)) return;
      const t = clamp01(d / W);
      const c = softEdgeCurve(t, P, L, G);
      if (c < a) a = c;
    };
    edge(uu, b.left); edge(1 - uu, b.right); edge(vv, b.top); edge(1 - vv, b.bottom);
    return clamp01(a);
  }

  /* ================= decoded-JSON bridge =================
     The extractor's whitelist is the shape of arena-advanced-output.json.
     toDecoded() reproduces it key for key IN ORDER, including the keys it omits
     rather than nulls (a Screen has lumiverseId:null but a slice with no warper
     has no `warper` key at all), because that is what makes "lossless" a
     testable claim instead of a hopeful one. */
  function fromDecoded(dec, into) {
    const setup = into || makeSetup();
    setup.clear();
    if (!dec || typeof dec !== 'object') return setup;
    setup.source = dec.source == null ? null : str(dec.source);
    if (dec.compositionTexture) {
      setup.compositionTexture = {
        width: str(dec.compositionTexture.width),
        height: str(dec.compositionTexture.height)
      };
    }
    setup.softEdging = blocksFromDecoded(dec.softEdging);
    for (const d of (Array.isArray(dec.screens) ? dec.screens : [])) {
      const sc = makeScreen(setup, d.type, { uniqueId: d.uniqueId, lumiverseId: d.lumiverseId });
      sc.attrs.name = d.name == null ? null : str(d.name);
      sc.params = blocksFromDecoded(d.params);
      sc.guides = (Array.isArray(d.guides) ? d.guides : []).map(g => Object.assign({}, g));
      for (const ld of (Array.isArray(d.layers) ? d.layers : [])) {
        const sl = makeSlice(sc, ld.type, { uniqueId: ld.uniqueId });
        sl.params = blocksFromDecoded(ld.params);
        if (ld.InputRect) sl.inputRect = rectFromDecoded(ld.InputRect);
        if (ld.OutputRect) sl.outputRect = rectFromDecoded(ld.OutputRect);
        if (ld.warper) {
          const w = {};
          if (ld.warper.bezier) {
            w.bezier = {
              controlWidth: Math.round(toNum(ld.warper.bezier.controlWidth, 0)),
              controlHeight: Math.round(toNum(ld.warper.bezier.controlHeight, 0)),
              vertices: (ld.warper.bezier.vertices || []).map(cpPt)
            };
          }
          if (ld.warper.homography) {
            w.homography = {
              src: (ld.warper.homography.src || []).map(cpPt),
              dst: (ld.warper.homography.dst || []).map(cpPt)
            };
          }
          if (ld.warper.other) w.other = ld.warper.other.slice();
          sl.warper = w;
        }
        if (ld.softEdgeGroup) sl.softEdgeGroup = true;
        if (ld.softEdgeGroupAttrs) sl.softEdgeGroupAttrs = Object.assign({}, ld.softEdgeGroupAttrs);
        if (ld.softEdgeGroupNodes) sl.softEdgeGroupNodes = cloneNodes(ld.softEdgeGroupNodes);
        if (ld.fixture) {
          sl.fixture = { uuid: ld.fixture.uuid == null ? null : str(ld.fixture.uuid), fixtureName: ld.fixture.fixtureName == null ? null : str(ld.fixture.fixtureName) };
          /* The XML subtrees ride through the decoded document too — a warp that
             survives a reload while its fixture's pixel layout does not is the
             same data loss, just deferred to the next session. */
          if (ld.fixture.instanceAttrs) sl.fixture.instanceAttrs = Object.assign({}, ld.fixture.instanceAttrs);
          if (ld.fixture.attrs) sl.fixture.attrs = Object.assign({}, ld.fixture.attrs);
          if (ld.fixture.nodes) sl.fixture.nodes = cloneNodes(ld.fixture.nodes);
          if (ld.fixture.extra) sl.fixture.extra = cloneNodes(ld.fixture.extra);
        }
        sc.layers.push(sl);
      }
      if (d.outputDevice) {
        const od = {};
        for (const k in d.outputDevice)
          if (k !== 'kind' && k !== 'followComposition') od[k] = d.outputDevice[k] == null ? null : str(d.outputDevice[k]);
        od.kind = str(d.outputDevice.kind);
        sc.outputDevice = od;
      }
      setup.screensList.push(sc);
    }
    return setup;
  }

  function toDecoded(setup) {
    const s = setup || liveSetup;
    const shapes = {}, devices = {};
    const screens = s.screensList.map(sc => {
      const out = {
        type: sc.type,
        name: sc.attrs.name == null ? (sc.name || null) : sc.attrs.name,
        uniqueId: sc.uniqueId,
        lumiverseId: sc.lumiverseId == null ? null : sc.lumiverseId,
        params: blocksToDecoded(sc.params),
        guides: sc.guides.map(g => Object.assign({}, g)),
        layers: sc.layers.map(sl => {
          shapes[sl.type] = (shapes[sl.type] || 0) + 1;
          const o = { type: sl.type, uniqueId: sl.uniqueId, params: blocksToDecoded(sl.params) };
          if (sl.inputRect) o.InputRect = rectToDecoded(sl.inputRect);
          if (sl.outputRect) o.OutputRect = rectToDecoded(sl.outputRect);
          if (sl.warper) {
            const w = {};
            if (sl.warper.bezier) {
              w.bezier = {
                controlWidth: sl.warper.bezier.controlWidth,
                controlHeight: sl.warper.bezier.controlHeight,
                vertices: sl.warper.bezier.vertices.map(v => ({ x: v.x, y: v.y }))
              };
            }
            if (sl.warper.homography) {
              w.homography = {
                src: sl.warper.homography.src.map(v => ({ x: v.x, y: v.y })),
                dst: sl.warper.homography.dst.map(v => ({ x: v.x, y: v.y }))
              };
            }
            if (sl.warper.other) w.other = sl.warper.other.slice();
            o.warper = w;
          }
          if (sl.softEdgeGroup) o.softEdgeGroup = true;
          if (sl.softEdgeGroupAttrs) o.softEdgeGroupAttrs = Object.assign({}, sl.softEdgeGroupAttrs);
          if (sl.softEdgeGroupNodes) o.softEdgeGroupNodes = cloneNodes(sl.softEdgeGroupNodes);
          if (sl.fixture) {
            o.fixture = { uuid: sl.fixture.uuid, fixtureName: sl.fixture.fixtureName };
            if (sl.fixture.instanceAttrs) o.fixture.instanceAttrs = Object.assign({}, sl.fixture.instanceAttrs);
            if (sl.fixture.attrs) o.fixture.attrs = Object.assign({}, sl.fixture.attrs);
            if (sl.fixture.nodes) o.fixture.nodes = cloneNodes(sl.fixture.nodes);
            if (sl.fixture.extra) o.fixture.extra = cloneNodes(sl.fixture.extra);
          }
          return o;
        })
      };
      if (sc.outputDevice) {
        const d = {};
        for (const k in sc.outputDevice)
          if (k !== 'kind' && k !== 'followComposition') d[k] = sc.outputDevice[k];
        d.kind = sc.outputDevice.kind;
        out.outputDevice = d;
        devices[d.kind] = (devices[d.kind] || 0) + 1;
      }
      return out;
    });
    const shapeTypes = {}, deviceTypes = {};
    for (const k in shapes) shapeTypes[k] = shapes[k];
    for (const k in devices) deviceTypes[k] = devices[k];
    return {
      source: s.source,
      screens: screens,
      softEdging: blocksToDecoded(s.softEdging),
      compositionTexture: { width: s.compositionTexture.width, height: s.compositionTexture.height },
      shapes: shapes,
      outputDevices: devices,
      summary: {
        screens: screens.length,
        slices: screens.reduce((n, x) => n + x.layers.length, 0),
        shape_types: shapeTypes,
        device_types: deviceTypes
      }
    };
  }

  /* ================= serialize / deserialize ================= */

  const SHAPE_TAGS = { Slice: 1, DmxSlice: 1, Polygon: 1, Mask: 1, SliceMask: 1, FixtureSlice: 1 };

  function sliceToXML(sl) {
    const ch = blocksToXML(sl.params);
    if (sl.inputRect) ch.push(rectToXML('InputRect', sl.inputRect));
    if (sl.outputRect) ch.push(rectToXML('OutputRect', sl.outputRect));
    if (sl.warper) {
      const w = [];
      if (sl.warper.bezier) {
        const b = sl.warper.bezier;
        /* The <vertices> wrapper is not decoration: extract-resolume.py does
           bez.find("vertices") and a real reader gets zero control points
           without it. Its absence is why the previous exporter lost every warp. */
        w.push(el('BezierWarper', { controlWidth: String(b.controlWidth), controlHeight: String(b.controlHeight) },
          [el('vertices', {}, b.vertices.map(v => el('v', { x: fmt(v.x), y: fmt(v.y) })))]));
      }
      if (sl.warper.homography) {
        const h = sl.warper.homography;
        w.push(el('Homography', {}, [
          el('src', {}, h.src.map(v => el('v', { x: fmt(v.x), y: fmt(v.y) }))),
          el('dst', {}, h.dst.map(v => el('v', { x: fmt(v.x), y: fmt(v.y) })))
        ]));
      }
      ch.push(el('Warper', {}, w));
    }
    if (sl.softEdgeGroup) {
      ch.push(el('SoftEdgeGroup', Object.assign({}, sl.softEdgeGroupAttrs || {}), (sl.softEdgeGroupNodes || []).slice()));
    }
    if (sl.fixture) {
      /* Attribute order is document order: Arena writes name, then uuid, then
         fixtureName. `attrs` holds everything the reader did not lift out, so
         seeding from it and appending the two named fields reproduces that. */
      const fa = Object.assign({ name: 'Fixture' }, sl.fixture.attrs || {});
      fa.uuid = str(sl.fixture.uuid);
      fa.fixtureName = str(sl.fixture.fixtureName);
      const fc = [el('Fixture', fa, (sl.fixture.nodes || []).slice())];
      for (const c of sl.fixture.extra || []) fc.push(c);
      ch.push(el('FixtureInstance', Object.assign({ name: 'FixtureInstance' }, sl.fixture.instanceAttrs || {}), fc));
    }
    for (const x of sl.extra) ch.push(x);
    return el(sl.type, { uniqueId: sl.uniqueId }, ch);
  }

  function screenToXML(sc) {
    const a = {};
    for (const k in sc.attrs) if (sc.attrs[k] != null) a[k] = sc.attrs[k];
    a.name = sc.attrs.name != null ? sc.attrs.name : sc.name;
    a.uniqueId = sc.uniqueId;
    if (sc.lumiverseId != null) a.LumiverseId = sc.lumiverseId;
    const ch = blocksToXML(sc.params);
    ch.push(el('guides', {}, sc.guides.map(g => el(g.name || 'ScreenGuide', gAttrs(g)))));
    ch.push(el('layers', {}, sc.layers.map(sliceToXML)));
    /* Only written when there are any, so an ordinary Screen and a Lumiverse
       serialise byte-for-byte as before. */
    if (sc.destinations && sc.destinations.length)
      ch.push(el('Destinations', {}, sc.destinations.map(d => el('Destination', {
        uniqueId: d.uniqueId, name: d.name, transport: d.transport,
        endpointRef: d.endpointRef || '', enabled: d.enabled ? '1' : '0',
        /* WHICH SERVICE, not just which protocol. These were added to the
           in-memory record and NOT to this writer, so the defect they exist to
           prevent was still live on disk: a row saved as "Twitch" reloaded
           pointing at Custom RTMP, because only `transport` survived and the
           fallback maps ST_HELPER_RTMP to Custom RTMP. A control disagreeing
           with itself is what CLAUDE.md forbids, and half a fix did not fix it.

           References only, never credentials. The stream key lives in a
           session-only Map in the editor and never reaches this document,
           which is exported and mailed. */
        serviceKey: d.serviceKey || '',
        platformId: d.platformId != null ? String(d.platformId) : '',
        accountId: d.accountId || '',
        channelId: d.channelId || ''
      }))));
    if (sc.outputDevice) {
      const d = {};
      for (const k in sc.outputDevice)
        if (k !== 'kind' && k !== 'followComposition' && sc.outputDevice[k] != null) d[k] = sc.outputDevice[k];
      ch.push(el('OutputDevice', {}, [el(sc.outputDevice.kind || 'OutputDeviceVirtual', d)]));
    }
    for (const x of sc.extra) ch.push(x);
    return el(sc.type, a, ch);
  }
  const gAttrs = g => {
    const a = {};
    for (const k in g) if (k !== 'name' && g[k] != null) a[k] = str(g[k]);
    return Object.assign({ name: g.name || 'ScreenGuide' }, a);
  };

  function screenSetupToXML(s) {
    const ch = [el('versionInfo', Object.assign({}, s.versionInfo))];
    if (Object.keys(s.setupParams).length) ch.push(...blocksToXML({ ScreenSetupParams: s.setupParams }));
    ch.push(el('CurrentCompositionTextureSize', { width: s.compositionTexture.width, height: s.compositionTexture.height }));
    ch.push(el('screens', {}, s.screensList.map(screenToXML)));
    if (Object.keys(s.softEdging).length) ch.push(el('SoftEdging', {}, blocksToXML(s.softEdging)));
    for (const x of s.extra) ch.push(x);
    return el('ScreenSetup', { name: 'ScreenSetup' }, ch);
  }

  /* Clone-only state, quarantined. Arena has no param name for a per-edge blend
     band or for the clone's flip booleans, so they live here where Arena's
     reader will ignore them, instead of being smuggled into <Params> under an
     invented name that a real Arena would reject or misread. */
  function openLiveSidecar(s) {
    const rows = [];
    for (const sc of s.screensList) {
      /* UNDOCUMENTED OpenLive extension. Native AdvancedOutput.xml has no
         follow-Composition flag, so it belongs beside our other clone state,
         keyed by the native Screen uniqueId. Fixed/custom outputs need no row:
         false is also the safe default for every imported Arena preset. */
      if (sc.deviceFollowsComposition && sc.deviceFollowsComposition())
        rows.push(el('Screen', { uniqueId: sc.uniqueId, followComposition: '1' }));
      for (const sl of sc.layers) {
        const b = sl.softEdge || {};
        const own = k => Object.prototype.hasOwnProperty.call(b, k);
        const any = own('left') || own('right') || own('top') || own('bottom') || sl.flipX || sl.flipY;
        if (!any) continue;
        const attrs = {
          uniqueId: sl.uniqueId,
          flipX: sl.flipX ? '1' : '0', flipY: sl.flipY ? '1' : '0'
        };
        if (own('left')) attrs.softEdgeLeft = fmt(toNum(b.left, 0));
        if (own('right')) attrs.softEdgeRight = fmt(toNum(b.right, 0));
        if (own('top')) attrs.softEdgeTop = fmt(toNum(b.top, 0));
        if (own('bottom')) attrs.softEdgeBottom = fmt(toNum(b.bottom, 0));
        rows.push(el('Slice', attrs));
      }
    }
    const a = { version: '1', warpOrder: warpOrder, surface: surfaceName };
    if (s.source) a.sourcePath = s.source;
    if (!rows.length && !s.source) return el('OpenLive', a);
    return el('OpenLive', a, rows);
  }

  /* The Slice Browser list. UNVERIFIED: slices.xml on this machine holds an
     empty <Items/> so a populated Item has never been seen. It is regenerated
     from the slices on every save and ignored on load, so being wrong about it
     cannot corrupt anything. */
  function inspectorItems(s) {
    const items = [];
    for (const sc of s.screensList) {
      for (const sl of sc.layers) {
        items.push(el('Item', { name: sl.name || '', uniqueId: sl.uniqueId, screenId: sc.uniqueId, type: sl.type }));
      }
    }
    return el('List', {}, [el('Items', {}, items)]);
  }

  function serialize(setup) {
    const s = setup || liveSetup;
    return serializeXML(el('ScreenSetupInspector', { name: 'ScreenSetupInspector' }, [
      el('versionInfo', Object.assign({}, s.versionInfo)),
      inspectorItems(s),
      screenSetupToXML(s),
      openLiveSidecar(s)
    ]));
  }
  /* The other half of the same document: what Arena's own AdvancedOutput.xml
     looks like, with no Inspector wrapper and no clone sidecar. */
  const serializeScreenSetup = setup => serializeXML(screenSetupToXML(setup || liveSetup));

  function sliceFromXML(screen, node) {
    const sl = makeSlice(screen, node.tag, { uniqueId: attr(node, 'uniqueId') });
    sl.type = node.tag;                                  /* forward-compatible: a shape tag Arena adds later still round-trips */
    sl.params = blocksFromXML(node);
    const ir = kid(node, 'InputRect'), or = kid(node, 'OutputRect');
    if (ir) sl.inputRect = rectFromXML(ir);
    if (or) sl.outputRect = rectFromXML(or);
    const w = kid(node, 'Warper');
    if (w) {
      const warp = {};
      const bez = kid(w, 'BezierWarper');
      if (bez) {
        const vs = kid(bez, 'vertices');
        warp.bezier = {
          controlWidth: Math.round(toNum(attr(bez, 'controlWidth'), 0)),
          controlHeight: Math.round(toNum(attr(bez, 'controlHeight'), 0)),
          vertices: (vs ? kids(vs, 'v') : []).map(v => pt(toNum(attr(v, 'x'), 0), toNum(attr(v, 'y'), 0)))
        };
      }
      const hom = kid(w, 'Homography');
      if (hom) {
        const sq = kid(hom, 'src'), dq = kid(hom, 'dst');
        warp.homography = {
          src: (sq ? kids(sq, 'v') : []).map(v => pt(toNum(attr(v, 'x'), 0), toNum(attr(v, 'y'), 0))),
          dst: (dq ? kids(dq, 'v') : []).map(v => pt(toNum(attr(v, 'x'), 0), toNum(attr(v, 'y'), 0)))
        };
      }
      for (const o of w.children) if (o.tag !== 'BezierWarper' && o.tag !== 'Homography') (warp.other || (warp.other = [])).push(o.tag);
      sl.warper = warp;
    }
    const seg = kid(node, 'SoftEdgeGroup');
    if (seg) {
      sl.softEdgeGroup = true;
      /* The extractor threw these away; whatever the group id turns out to be,
         it survives a clone round trip now. */
      if (Object.keys(seg.attrs).length) sl.softEdgeGroupAttrs = Object.assign({}, seg.attrs);
      /* Arena carries the group's real parameters in a <Params name="Soft Edge">
         block INSIDE this element — Power, and whatever else the group owns —
         while the element itself has no attributes at all. Reading only attrs
         meant every soft edge came back as a bare <SoftEdgeGroup/>. */
      if (seg.children.length) sl.softEdgeGroupNodes = seg.children.slice();
    }
    const fi = kid(node, 'FixtureInstance');
    if (fi) {
      const fx = kid(fi, 'Fixture');
      sl.fixture = { uuid: fx ? attr(fx, 'uuid') : null, fixtureName: fx ? attr(fx, 'fixtureName') : null };
      /* The real nesting is FixtureInstance > Fixture > Params > ParamFixturePixels,
         and ParamFixturePixels is itself a CONTAINER of ParamRange elements —
         Width, Height, Distribution, Gamma — not an element with those as
         attributes. The old reader looked for ParamFixturePixels as a direct
         child of FixtureInstance, where it never is, so `pixels` was always
         undefined and the writer emitted a bare <Fixture fixtureName=""/>.
         Loading and re-saving an AdvancedOutput.xml erased every LED fixture's
         pixel layout. Keep the whole subtree verbatim instead of picking fields
         out of it — the same rule `extra` already follows for unknown children. */
      if (Object.keys(fi.attrs).length) sl.fixture.instanceAttrs = Object.assign({}, fi.attrs);
      if (fx) {
        for (const k in fx.attrs) {
          if (k !== 'uuid' && k !== 'fixtureName') (sl.fixture.attrs || (sl.fixture.attrs = {}))[k] = fx.attrs[k];
        }
        if (fx.children.length) sl.fixture.nodes = fx.children.slice();
      }
      for (const c of fi.children) if (c.tag !== 'Fixture') (sl.fixture.extra || (sl.fixture.extra = [])).push(c);
    }
    const known = { Params: 1, InputRect: 1, OutputRect: 1, Warper: 1, SoftEdgeGroup: 1, FixtureInstance: 1 };
    for (const c of node.children) if (!known[c.tag]) sl.extra.push(c);
    return sl;
  }

  function screenFromXML(setup, node) {
    const sc = makeScreen(setup, node.tag, { uniqueId: attr(node, 'uniqueId'), lumiverseId: attr(node, 'LumiverseId') });
    sc.type = node.tag;
    for (const k in node.attrs) if (k !== 'uniqueId' && k !== 'LumiverseId') sc.attrs[k] = node.attrs[k];
    sc.params = blocksFromXML(node);
    const g = kid(node, 'guides');
    if (g) for (const gg of g.children) sc.guides.push(Object.assign({}, gg.attrs, { name: gg.attrs.name || gg.tag }));
    /* Everything under <layers> is a shape by construction, so read them all —
       a Polygon or a Mask that this file cannot draw must still survive a save. */
    const ly = kid(node, 'layers');
    if (ly) for (const c of ly.children) sc.layers.push(sliceFromXML(sc, c));
    /* OpenLive extension, StreamScreen only. Kept as its own element rather than
       as params so the count is unbounded — a Broadcast is expected to carry
       twenty or more of these. No secret is ever stored here: `endpointRef` is a
       slot name, and this document is exported and mailed. */
    const dst = kid(node, 'Destinations');
    if (dst) for (const d of dst.children) sc.destinations.push({
      uniqueId: str(d.attrs.uniqueId || newId()),
      name: str(d.attrs.name || 'Destination'),
      transport: str(d.attrs.transport || 'ST_DISABLED'),
      endpointRef: str(d.attrs.endpointRef || ''),
      enabled: d.attrs.enabled !== '0',
      /* Absent on a document written before these existed, which is why every
         one falls back rather than throwing: an older file simply reloads with
         the transport it always had, and the picker's own fallback maps that to
         a sensible service. */
      serviceKey: str(d.attrs.serviceKey || ''),
      platformId: d.attrs.platformId ? +d.attrs.platformId : null,
      accountId: str(d.attrs.accountId || '') || null,
      channelId: str(d.attrs.channelId || '') || null
    });
    const dev = kid(node, 'OutputDevice');
    if (dev && dev.children.length) {
      const d = dev.children[0];
      sc.outputDevice = Object.assign({}, d.attrs, { kind: d.tag });
    }
    const known = { Params: 1, guides: 1, layers: 1, OutputDevice: 1, Destinations: 1 };
    for (const c of node.children) if (!known[c.tag]) sc.extra.push(c);
    return sc;
  }

  /* Accepts: our Inspector document; a bare <ScreenSetup>; a real
     AdvancedOutput.xml under whatever root it happens to carry; and the empty
     <ScreenSetupInspector><List><Items/></List>, which is a valid setup with no
     screens and must not throw. Anything unparseable throws once, loudly. */
  function deserialize(xml, into) {
    const setup = into || liveSetup;
    const root = parseXML(xml);
    if (!root) throw new Error('OpenLiveScreens.deserialize: not XML');
    let node = null;
    if (root.tag === 'ScreenSetup') node = root;
    else {
      node = kid(root, 'ScreenSetup');
      if (!node && kid(root, 'screens')) node = root;      /* AdvancedOutput.xml under its own root */
    }
    setup.clear();
    const vi = kid(root, 'versionInfo') || (node ? kid(node, 'versionInfo') : null);
    if (vi) setup.versionInfo = Object.assign({}, vi.attrs);
    const side = kid(root, 'OpenLive');
    if (!node) {
      /* The empty inspector: a real, valid, screen-less setup. */
      if (root.tag === 'ScreenSetupInspector' || kid(root, 'List')) { applySidecar(setup, side); return setup; }
      throw new Error('OpenLiveScreens.deserialize: no <ScreenSetup> and no <screens> in <' + root.tag + '>');
    }
    const cts = kid(node, 'CurrentCompositionTextureSize');
    if (cts) setup.compositionTexture = { width: str(attr(cts, 'width')), height: str(attr(cts, 'height')) };
    const sp = node.children.find(c => c.tag === 'Params' && attr(c, 'name') === 'ScreenSetupParams');
    if (sp) setup.setupParams = blocksFromXML(el('x', {}, [sp])).ScreenSetupParams || {};
    const screens = kid(node, 'screens');
    if (screens) for (const c of screens.children) setup.screensList.push(screenFromXML(setup, c));
    const se = kid(node, 'SoftEdging');
    if (se) setup.softEdging = blocksFromXML(se);
    const known = { versionInfo: 1, CurrentCompositionTextureSize: 1, screens: 1, SoftEdging: 1, Params: 1 };
    for (const c of node.children) if (!known[c.tag]) setup.extra.push(c);
    applySidecar(setup, side);
    return setup;
  }

  function applySidecar(setup, side) {
    if (!side) return;
    if (side.attrs.sourcePath) setup.source = side.attrs.sourcePath;
    if (side.attrs.warpOrder) setWarpOrder(side.attrs.warpOrder);
    if (side.attrs.surface) setSurface(side.attrs.surface);
    for (const r of kids(side, 'Screen')) {
      const sc = setup.screenById(attr(r, 'uniqueId'));
      if (!sc) continue;
      sc.setDeviceFollowComposition(attr(r, 'followComposition') === '1');
    }
    for (const r of kids(side, 'Slice')) {
      const sl = setup.sliceById(attr(r, 'uniqueId'));
      if (!sl) continue;
      sl.softEdge = {};
      if (attr(r, 'softEdgeLeft') !== null) sl.softEdge.left = toNum(attr(r, 'softEdgeLeft'), 0);
      if (attr(r, 'softEdgeRight') !== null) sl.softEdge.right = toNum(attr(r, 'softEdgeRight'), 0);
      if (attr(r, 'softEdgeTop') !== null) sl.softEdge.top = toNum(attr(r, 'softEdgeTop'), 0);
      if (attr(r, 'softEdgeBottom') !== null) sl.softEdge.bottom = toNum(attr(r, 'softEdgeBottom'), 0);
      sl.flipX = attr(r, 'flipX') === '1';
      sl.flipY = attr(r, 'flipY') === '1';
    }
  }

  /* ================= the live setup ================= */
  let liveSetup = makeSetup();

  /* Bootstrap from the decoded real file when resolume-extracted.js is present.
     A clone that opens on an empty canvas when three real screens are sitting
     in the page is the deck-vs-workspace mistake all over again. */
  function bootstrap() {
    try {
      const R = (typeof window !== 'undefined' && window.RESOLUME) || null;
      const ao = R && R.arena && R.arena.advanced_output;
      if (ao && Array.isArray(ao.screens) && ao.screens.length) { fromDecoded(ao, liveSetup); return true; }
    } catch (e) { /* a missing bootstrap is not an error, it is an empty setup */ }
    return false;
  }
  const bootstrapped = bootstrap();

  return {
    version: 1,

    /* model */
    setup: () => liveSetup,
    createSetup: makeSetup,
    reset: () => liveSetup.clear(),
    bootstrapped: bootstrapped,

    /* maths */
    solveHomography: solveHomography,
    applyHomography: applyHomography,
    evalBezier: evalBezier,
    sliceTransform: sliceTransform,
    softEdgeAlpha: softEdgeAlpha,
    softEdgeCurve: softEdgeCurve,
    softEdgeCurveRGB: softEdgeCurveRGB,
    softEdgeDefaults: () => Object.assign({}, SOFT_EDGE_DEFAULTS),
    sliceInputAt: sliceInputAt,
    sliceOutputAt: sliceOutputAt,
    uvFromInput: uvFromInput,
    inputIsAffine: inputIsAffine,
    homographyOf: homographyOf,
    tessellate: tessellate,
    identityBezier: identityBezier,
    identityHomography: identityHomography,
    rectFrame: rectFrame,
    frameVertices: frameVertices,
    sliceGeometryFrame: sliceGeometryFrame,
    setSliceGeometryFrame: setSliceGeometryFrame,
    mat3mul: mat3mul,
    mat3identity: mat3identity,

    /* Slice stacking direction. Exported so the renderer, the tree and any test
       read the SAME answer instead of each hard-coding a guess. */
    ORDER: ORDER,

    /* Output-device raster policy. The predicate describes which device kinds
       can participate; whether one actually follows is explicit per Screen. */
    configurableOutputKinds: () => Object.keys(CONFIGURABLE_OUTPUT_KINDS),
    outputDeviceCanFollowComposition: outputDeviceCanFollowComposition,

    /* the two inferences, swappable because they are inferences */
    surfaces: () => Object.keys(SURFACES),
    setSurface: setSurface,
    get surface() { return surfaceName; },
    setWarpOrder: setWarpOrder,
    get warpOrder() { return warpOrder; },

    /* persistence */
    serialize: serialize,
    serializeScreenSetup: serializeScreenSetup,
    deserialize: deserialize,
    /* `into` was dropped, so every caller wrote into liveSetup no matter which
       setup it passed — a test harness asking to decode into its own scratch
       setup got an empty one back AND clobbered the live document. */
    fromDecoded: (dec, into) => fromDecoded(dec, into || liveSetup),
    toDecoded: setup => toDecoded(setup || liveSetup),

    /* exported because a renderer and a test harness both need to read Arena's
       XML without importing the DOM */
    parseXML: parseXML,
    serializeXML: serializeXML,
    idHash: idHash
  };
})();
