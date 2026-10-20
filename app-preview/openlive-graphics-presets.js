/* Original SHOWAVE graphics. No remote assets, render loops, or uploaded SVGs.
 * The programme compositor supplies the clock; thumbnails use the same shapes.
 * Manual references: vocabulary, parameters, composition, advanced-output,
 * stills and video. These are SHOWAVE designs, not copied Restream assets.
 */
window.OpenLiveGraphicsPresets = (() => {
  'use strict';

  const definitions = [
    ['bg', 'studio-dusk', 'Studio dusk', false],
    ['bg', 'aurora-drift', 'Aurora drift', true],
    ['bg', 'satin-ribbons', 'Satin ribbons', true],
    ['bg', 'cobalt-glow', 'Cobalt glow', true],
    ['bg', 'amber-horizon', 'Amber horizon', false],
    ['bg', 'rose-mesh', 'Rose mesh', true],
    ['bg', 'midnight-grid', 'Midnight grid', false],
    ['bg', 'violet-orbit', 'Violet orbit', true],
    ['bg', 'quiet-paper', 'Quiet paper', false],
    ['bg', 'ocean-depth', 'Ocean depth', true],
    ['bg', 'sunset-ridge', 'Sunset ridge', false],
    ['bg', 'graphite-folds', 'Graphite folds', false],
    ['bg', 'forest-light', 'Forest light', true],
    ['bg', 'coral-bloom', 'Coral bloom', true],
    ['bg', 'night-constellation', 'Night constellation', false],
    ['bg', 'teal-arch', 'Teal arch', false],
    ['bg', 'template-blue-angular', 'Template · Blue angular', false],
    ['bg', 'template-cyan-curtain', 'Template · Cyan curtain', false],
    ['overlay', 'prism-corners', 'Prism corners', false],
    ['overlay', 'quiet-frame', 'Quiet frame', false],
    ['overlay', 'wave-footer', 'Wave footer', true],
    ['overlay', 'broadcast-brackets', 'Broadcast brackets', false]
  ];
  const records = definitions.map(([category, slug, name, animated]) => Object.freeze({
    id: `builtin:${category}:${slug}`, type: category === 'bg' ? 'background' : 'overlay',
    name, width: 1920, height: 1080, builtin: true, animated, corner: '', scale: 0
  }));
  const catalog = new Map(records.map((record) => [record.id, record]));
  const thumbnails = new Map();
  const copy = (record) => record ? { ...record } : null;
  const list = (type) => records.filter((record) => !type || record.type === type).map(copy);
  const get = (id) => copy(catalog.get(id));

  function scene(id, w, h, seconds) {
    const result = [];
    const unit = Math.min(w, h);
    const wave = Math.sin(seconds * .22);
    const drift = Math.cos(seconds * .17);
    const linear = (colors, x1 = 0, y1 = 0, x2 = w, y2 = h) => ({
      kind: 'linear', x1, y1, x2, y2,
      stops: colors.map((color, i) => [i / (colors.length - 1), color])
    });
    const radial = (x, y, radius, colors) => ({
      kind: 'radial', x, y, radius,
      stops: colors.map((color, i) => [i / (colors.length - 1), color])
    });
    const rect = (x, y, width, height, fill, stroke, lineWidth = 1) =>
      result.push({ kind: 'rect', x, y, width, height, fill, stroke, lineWidth });
    const path = (commands, fill, stroke, lineWidth = 1) =>
      result.push({ kind: 'path', commands, fill, stroke, lineWidth });
    const ellipse = (x, y, rx, ry, fill, stroke, lineWidth = 1) =>
      result.push({ kind: 'ellipse', x, y, rx, ry, fill, stroke, lineWidth });
    const base = (colors) => rect(0, 0, w, h, linear(colors));
    const glow = (x, y, radius, color) => rect(0, 0, w, h, radial(x, y, radius, [color, 'rgba(0,0,0,0)']));
    const ridge = (height, color, offset = 0) => path([
      ['M', 0, h], ['L', 0, h * height], ['L', w * .18, h * (height - .16 + offset)],
      ['L', w * .32, h * (height - .03)], ['L', w * .55, h * (height - .23 - offset)],
      ['L', w * .76, h * (height - .07)], ['L', w, h * (height - .18)], ['L', w, h], ['Z']
    ], color);
    const ribbon = (y, color, bend = 0, thickness = .18) => path([
      ['M', -w * .1, h * y],
      ['C', w * .25, h * (y - .34 + bend), w * .52, h * (y + .36), w * 1.1, h * (y - .12)],
      ['L', w * 1.1, h * (y - .12 + thickness)],
      ['C', w * .52, h * (y + .36 + thickness), w * .25, h * (y - .34 + bend + thickness), -w * .1, h * (y + thickness)],
      ['Z']
    ], color);

    switch (id) {
      case 'builtin:bg:studio-dusk':
        base(['#111629', '#263a70']);
        path([['M', 0, h * .72], ['L', w, h * .18], ['L', w, h * .6], ['L', 0, h * .96], ['Z']], '#34487f');
        path([['M', 0, h * .72], ['L', w, h * .9], ['L', w, h], ['L', 0, h], ['Z']], '#141b31');
        break;
      case 'builtin:bg:aurora-drift':
        base(['#030e23', '#0d2445']);
        glow(w * (.3 + wave * .12), h * .15, w * .68, '#235b8070');
        ribbon(.38 + wave * .04, linear(['#54ffd510', '#34d6b590', '#6075f510']), drift * .08, .17);
        ribbon(.52 + drift * .04, linear(['#629bff08', '#7a72ee80', '#8cdcf410']), wave * .07, .11);
        break;
      case 'builtin:bg:satin-ribbons':
        base(['#05080d', '#192231']);
        ribbon(.31 + wave * .04, linear(['#202c3c', '#9baabc', '#16202e']), drift * .12, .11);
        ribbon(.49 + drift * .04, linear(['#0b1522', '#e2ecf0', '#37485d']), wave * .1, .06);
        ribbon(.65 + wave * .025, linear(['#132239', '#738cb0', '#0d1524']), drift * .07, .09);
        break;
      case 'builtin:bg:cobalt-glow':
        base(['#090826', '#061228']);
        glow(w * (.34 + wave * .15), h * (.36 + drift * .12), w * .55, '#5034f5');
        glow(w * (.77 + drift * .06), h * .66, w * .42, '#0b8aa7b0');
        break;
      case 'builtin:bg:amber-horizon':
        base(['#f6c482', '#d77855', '#572f55']);
        ellipse(w * .73, h * .3, unit * .12, unit * .12, '#ffddb5');
        ridge(.64, '#af5b61', .06); ridge(.85, '#683d5a', -.04); ridge(1.05, '#332c4b', .03);
        break;
      case 'builtin:bg:rose-mesh':
        base(['#35214a', '#bd547c']);
        glow(w * (.18 + wave * .12), h * .3, w * .55, '#ffc1a2c0');
        glow(w * (.8 + drift * .08), h * .75, w * .6, '#5d63dad0');
        ribbon(.55 + wave * .035, '#dc80a622', drift * .08, .35);
        break;
      case 'builtin:bg:midnight-grid':
        base(['#071325', '#102d3a']);
        for (let i = 1; i < 12; i++) {
          path([['M', w * i / 12, 0], ['L', w * i / 12, h]], null, '#6cafa315', unit * .001);
          path([['M', 0, h * i / 12], ['L', w, h * i / 12]], null, '#6cafa315', unit * .001);
        }
        glow(w * .76, h * .18, w * .65, '#45ac9728');
        break;
      case 'builtin:bg:violet-orbit':
        base(['#0f0c23', '#29294c']);
        glow(w * .63, h * .43, w * .58, '#7652a75c');
        for (let i = 0; i < 5; i++) ellipse(w * (.57 + wave * .05), h * (.44 + drift * .04),
          unit * (.23 + i * .075), unit * (.12 + i * .045), null,
          ['#e3cdff60', '#b8a4e650', '#9baee33e', '#778bc92c', '#7ba5ce20'][i], unit * .002);
        break;
      case 'builtin:bg:quiet-paper':
        base(['#eff1f2', '#d7e1e5']);
        path([['M', w * .5, 0], ['L', w, 0], ['L', w, h], ['L', w * .78, h], ['Z']], '#ffffff55');
        path([['M', 0, h * .77], ['L', w, h * .42], ['L', w, h], ['L', 0, h], ['Z']], '#b1c2ca22');
        break;
      case 'builtin:bg:ocean-depth':
        base(['#03243d', '#065164']);
        for (let i = 0; i < 4; i++) ribbon(.24 + i * .2 + Math.sin(seconds * .18 + i) * .04,
          ['#53c7bc38', '#107b9145', '#56a9b238', '#053c6355'][i], drift * .08, .16);
        break;
      case 'builtin:bg:sunset-ridge':
        base(['#512c6d', '#e56a88', '#f5bb7b']);
        ridge(.69, '#9c5b92', -.01); ridge(.87, '#5d4a88', .05); ridge(1.07, '#2e3d68', -.07);
        break;
      case 'builtin:bg:graphite-folds':
        base(['#101317', '#2c353f']);
        path([['M', 0, 0], ['L', w * .36, 0], ['L', w * .72, h], ['L', w * .46, h], ['Z']], linear(['#626d77', '#11171f']));
        path([['M', w * .68, 0], ['L', w, 0], ['L', w * .42, h], ['L', w * .29, h], ['Z']], linear(['#121923', '#434e5b']));
        break;
      case 'builtin:bg:forest-light':
        base(['#071c18', '#173b2f']);
        glow(w * (.74 + wave * .06), h * .22, w * .62, '#c5d87960');
        for (let i = 0; i < 12; i++) {
          const x = ((i * .173 + .09) % 1) * w;
          const y = ((i * .281 + .12) % 1) * h + Math.sin(seconds * .25 + i) * h * .025;
          const r = unit * (.012 + (i % 4) * .006);
          ellipse(x, y, r, r, ['#ddeda52a', '#aeddae18', '#d5e8bc38'][i % 3]);
        }
        break;
      case 'builtin:bg:coral-bloom':
        base(['#68285e', '#db6368']);
        glow(w * (.35 + wave * .09), h * (.35 + drift * .08), w * .52, '#ffbd6ddd');
        glow(w * (.86 + drift * .06), h * .85, w * .62, '#9a53cbd0');
        break;
      case 'builtin:bg:night-constellation':
        base(['#070e20', '#1d2a48']);
        for (let i = 0; i < 30; i++) {
          const r = unit * (i % 5 === 0 ? .0019 : .0011);
          ellipse(((i * .618 + .07) % 1) * w, ((i * .381 + .13) % 1) * h, r, r, '#ccd9f38c');
        }
        path([['M', w * .16, h * .72], ['L', w * .29, h * .48], ['L', w * .55, h * .62], ['L', w * .81, h * .28]], null, '#9abada28', unit * .001);
        break;
      case 'builtin:bg:teal-arch':
        base(['#073836', '#17605b']);
        ellipse(w * .76, h * .94, unit * .73, unit * .91, '#318478');
        ellipse(w * .76, h * .94, unit * .56, unit * .73, '#0e4e4b');
        ellipse(w * .76, h * .94, unit * .4, unit * .56, '#093b3d');
        break;
      // Lightweight geometry inspired by user-supplied reference 5. The source
      // file's LIVE bug is deliberately absent: status belongs to real state.
      case 'builtin:bg:template-blue-angular':
        base(['#032354', '#0754ce']);
        path([['M', 0, 0], ['L', w * .4, 0], ['L', w * .035, h], ['L', 0, h], ['Z']], '#04367b');
        path([['M', w * .4, 0], ['L', w * .43, 0], ['L', w * .17, h * .8], ['L', w * .14, h * .73], ['Z']], '#042b64');
        path([['M', 0, 0], ['L', w * .33, h], ['L', w * .29, h], ['Z']], '#07316d88');
        path([['M', w * .81, 0], ['L', w, 0], ['L', w * .66, h], ['L', w * .56, h], ['Z']], '#032c7177');
        path([['M', w * .98, 0], ['L', w, 0], ['L', w, h * .17], ['L', w * .71, h], ['L', w * .67, h], ['Z']], '#012860a8');
        path([['M', 0, h * .03], ['L', w * .32, h]], null, '#1174d155', unit * .003);
        path([['M', w * .69, 0], ['L', w, h * .98]], null, '#138bea40', unit * .004);
        break;
      // References 6–9 share a cyan/violet ribbed backdrop. Their placeholder
      // video panels are not baked in: layout cells remain real media surfaces.
      case 'builtin:bg:template-cyan-curtain':
        base(['#24143d', '#252775', '#4b2497']);
        glow(w * .31, -h * .03, w * .46, '#db68c288');
        glow(w * .34, h * .9, w * .5, '#04cbeddb');
        glow(w * .88, h * .46, w * .38, '#8159efa0');
        for (let i = 0; i < 28; i++) {
          const left = w * i / 28, right = w * (i + 1) / 28;
          rect(left, 0, right - left, h,
            linear(['#00000072', '#ffffff16', '#00000054'], left, 0, right, 0));
        }
        break;
      case 'builtin:overlay:prism-corners': {
        const edge = unit * .018;
        path([['M', edge, h * .27], ['L', edge, edge], ['L', w * .24, edge]], null,
          linear(['#51d3e2', '#8a72ed']), unit * .009);
        path([['M', w - edge, h * .73], ['L', w - edge, h - edge], ['L', w * .76, h - edge]], null,
          linear(['#8a72ed', '#f090b9']), unit * .009);
        break;
      }
      case 'builtin:overlay:quiet-frame': {
        const inset = unit * .018;
        rect(inset, inset, w - inset * 2, h - inset * 2, null, '#e9eef5a0', unit * .0015);
        rect(inset, h * .15, unit * .007, h * .1, '#f1c89d');
        rect(w - inset - unit * .007, h * .75, unit * .007, h * .1, '#f1c89d');
        break;
      }
      case 'builtin:overlay:wave-footer':
        path([['M', 0, h], ['L', 0, h * .967],
          ['C', w * .28, h * (.9 + wave * .015), w * .64, h * 1.045, w, h * .946],
          ['L', w, h], ['Z']], linear(['#55d8d7c0', '#6962d6a0', '#d47eaec0']));
        break;
      case 'builtin:overlay:broadcast-brackets': {
        const inset = unit * .025, length = unit * .075;
        for (const [x, y, dx, dy] of [[inset, inset, 1, 1], [w - inset, inset, -1, 1],
          [inset, h - inset, 1, -1], [w - inset, h - inset, -1, -1]]) {
          path([['M', x, y + dy * length], ['L', x, y], ['L', x + dx * length, y]], null, '#f5f8ffd9', unit * .004);
        }
        break;
      }
    }
    return result;
  }

  function canvasPaint(ctx, paint) {
    if (!paint || typeof paint === 'string') return paint;
    const gradient = paint.kind === 'linear'
      ? ctx.createLinearGradient(paint.x1, paint.y1, paint.x2, paint.y2)
      : ctx.createRadialGradient(paint.x, paint.y, 0, paint.x, paint.y, paint.radius);
    paint.stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    return gradient;
  }

  function draw(id, ctx, canvas, timeMs) {
    const asset = catalog.get(id);
    const w = Number(canvas?.width), h = Number(canvas?.height);
    if (!asset || !ctx || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
    let clock = Number(timeMs);
    if (timeMs == null || !Number.isFinite(clock)) clock = typeof performance !== 'undefined' ? performance.now() : Date.now();
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      for (const shape of scene(id, w, h, asset.animated ? clock / 1000 : 0)) {
        ctx.beginPath();
        if (shape.kind === 'rect') ctx.rect(shape.x, shape.y, shape.width, shape.height);
        else if (shape.kind === 'ellipse') ctx.ellipse(shape.x, shape.y, shape.rx, shape.ry, 0, 0, Math.PI * 2);
        else for (const [command, ...args] of shape.commands) {
          if (command === 'M') ctx.moveTo(...args);
          else if (command === 'L') ctx.lineTo(...args);
          else if (command === 'C') ctx.bezierCurveTo(...args);
          else ctx.closePath();
        }
        if (shape.fill) { ctx.fillStyle = canvasPaint(ctx, shape.fill); ctx.fill(); }
        if (shape.stroke) { ctx.strokeStyle = canvasPaint(ctx, shape.stroke); ctx.lineWidth = shape.lineWidth; ctx.stroke(); }
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      ctx.restore();
    }
  }

  // SVG is serialized from trusted constants and finite geometry only, never user text.
  // It remains a thumbnail resource, not part of the uploaded-image security boundary.
  function thumbnail(id) {
    if (!catalog.has(id)) return '';
    if (thumbnails.has(id)) return thumbnails.get(id);
    const gradients = [];
    function svgPaint(paint) {
      if (!paint) return 'none';
      if (typeof paint === 'string') return paint;
      const gradientId = `g${gradients.length}`;
      const stops = paint.stops.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join('');
      gradients.push(paint.kind === 'linear'
        ? `<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${paint.x1}" y1="${paint.y1}" x2="${paint.x2}" y2="${paint.y2}">${stops}</linearGradient>`
        : `<radialGradient id="${gradientId}" gradientUnits="userSpaceOnUse" cx="${paint.x}" cy="${paint.y}" r="${paint.radius}">${stops}</radialGradient>`);
      return `url(#${gradientId})`;
    }
    const shapes = scene(id, 320, 180, 0).map((shape) => {
      const style = `fill="${svgPaint(shape.fill)}" stroke="${svgPaint(shape.stroke)}" stroke-width="${shape.lineWidth}" stroke-linejoin="round"`;
      if (shape.kind === 'rect') return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ${style}/>`;
      if (shape.kind === 'ellipse') return `<ellipse cx="${shape.x}" cy="${shape.y}" rx="${shape.rx}" ry="${shape.ry}" ${style}/>`;
      return `<path d="${shape.commands.map((command) => command.join(' ')).join(' ')}" ${style}/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs>${gradients.join('')}</defs>${shapes}</svg>`;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    thumbnails.set(id, url);
    return url;
  }

  return Object.freeze({ list, get, draw, thumbnail });
})();
