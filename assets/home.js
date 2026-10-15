/* Original SHOWAVE homepage. The globe is a decorative Canvas2D drawing with
   hand-authored approximate continent silhouettes. Routes are illustrative;
   no locations, audience activity, accounts, or visitor data are fetched. */
(() => {
  'use strict';
  const nav = document.querySelector('.main-navigation');
  const menu = document.querySelector('.menu-toggle');
  function closeMenu() { menu?.setAttribute('aria-expanded', 'false'); nav?.classList.remove('is-open'); }
  menu?.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open)); nav?.classList.toggle('is-open', open);
  });
  nav?.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
  const canvas = document.getElementById('showave-globe');
  const context = canvas?.getContext('2d', { alpha: true });
  if (!context) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const motionButton = document.querySelector('.motion-control');
  let paused = motion.matches, frame = 0, visible = true, width = 1, height = 1;
  let rotation = 16, drag = null, elapsed = 0, lastStamp = 0;
  const RAD = Math.PI / 180, TWO_PI = Math.PI * 2;
  // Longitude/latitude control points are deliberately approximate original
  // drawing data, rather than a map service or copied third-party geography.
  const land = [
    [[-17,15],[-16,21],[-12,28],[-6,35],[10,37],[24,32],[33,31],[35,24],[44,12],[51,11],[49,3],[42,-1],[39,-10],[35,-16],[33,-26],[26,-35],[18,-35],[12,-24],[9,-12],[8,3],[1,5],[-3,5],[-8,6],[-13,9]],
    [[-10,36],[-9,44],[-1,44],[-5,49],[-5,58],[6,59],[6,70],[18,72],[29,70],[34,60],[44,58],[57,54],[68,55],[81,72],[102,77],[130,70],[151,61],[176,64],[178,52],[158,50],[146,44],[140,36],[129,35],[123,25],[110,20],[107,9],[100,1],[96,5],[95,20],[87,21],[79,7],[73,13],[68,24],[58,26],[51,16],[43,12],[35,29],[26,36],[21,39],[15,37],[8,42],[2,41]],
    [[-166,67],[-154,71],[-139,68],[-130,56],[-125,48],[-123,40],[-116,30],[-107,23],[-99,17],[-89,16],[-83,8],[-77,9],[-81,19],[-87,22],[-82,26],[-81,31],[-73,41],[-61,47],[-57,54],[-66,60],[-81,62],[-91,70],[-112,75],[-136,69]],
    [[-81,12],[-73,11],[-63,10],[-52,4],[-49,-2],[-35,-6],[-39,-15],[-43,-23],[-51,-31],[-58,-38],[-68,-55],[-74,-51],[-74,-40],[-71,-29],[-76,-13],[-81,-5]],
    [[112,-22],[115,-15],[127,-11],[137,-12],[142,-10],[145,-18],[153,-25],[151,-34],[141,-39],[133,-33],[118,-35],[114,-28]],
    [[-53,60],[-45,60],[-23,69],[-17,77],[-31,83],[-49,82],[-63,75]],
    [[47,-13],[50,-16],[49,-23],[44,-26],[43,-21]],
    [[130,32],[135,35],[142,40],[145,44],[141,43],[137,37]],
    [[-10,50],[-5,50],[1,54],[-3,59],[-7,58]],
    [[166,-35],[176,-39],[174,-42],[168,-47],[166,-44]]
  ];
  function inside(lon, lat, polygon) {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [a, b] = polygon[i], [c, d] = polygon[j];
      if ((b > lat) !== (d > lat) && lon < (c - a) * (lat - b) / (d - b) + a) result = !result;
    }
    return result;
  }
  function vector(lat, lon) { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; }
  const dots = [];
  for (let lat = -57; lat <= 81; lat += 2.05) {
    const step = 2.05 / Math.max(.3, Math.cos(lat * RAD));
    for (let lon = -180; lon < 180; lon += step) if (land.some(polygon => inside(lon, lat, polygon))) dots.push(vector(lat, lon));
  }
  const origin = vector(.3476, 32.5825);
  // Fourteen examples of creative connections. These are not SHOWAVE offices.
  const destinations = [[51.5,-.12],[52.37,4.9],[52.52,13.4],[40.71,-74.01],[34.05,-118.24],[43.65,-79.38],[-23.55,-46.63],[25.2,55.27],[19.08,72.88],[1.35,103.82],[35.68,139.69],[-33.87,151.21],[-33.92,18.42],[-1.29,36.82]];
  function routeTo(point, index) {
    const end = vector(...point), angle = Math.acos(Math.max(-1, Math.min(1, origin.reduce((sum, value, i) => sum + value * end[i], 0))));
    const points = [];
    for (let step = 0; step <= 60; step++) {
      const t = step / 60, a = Math.sin((1 - t) * angle) / Math.sin(angle), b = Math.sin(t * angle) / Math.sin(angle);
      const lift = 1 + Math.sin(t * Math.PI) * (.12 + index % 4 * .024);
      points.push(origin.map((value, i) => (value * a + end[i] * b) * lift));
    }
    return { points, end, phase: index / destinations.length };
  }
  const routes = destinations.map(routeTo);
  function project(point) {
    const turn = (rotation + (!paused && !drag ? Math.sin(elapsed * .065) * 8 : 0)) * RAD;
    const x = point[0] * Math.cos(turn) - point[2] * Math.sin(turn);
    const z = point[0] * Math.sin(turn) + point[2] * Math.cos(turn);
    const tilt = 10 * RAD;
    return { x, y: point[1] * Math.cos(tilt) - z * Math.sin(tilt), z: point[1] * Math.sin(tilt) + z * Math.cos(tilt) };
  }
  function paint() {
    context.clearRect(0, 0, width, height);
    const radius = Math.min(width * .345, height * .365), cx = width * .52, cy = height * .47;
    const glow = context.createRadialGradient(cx + radius * .2, cy - radius * .1, radius * .4, cx, cy, radius * 1.48);
    glow.addColorStop(0, '#20445b00'); glow.addColorStop(.62, '#1a40561a'); glow.addColorStop(.76, '#23455d11'); glow.addColorStop(1, '#17395000');
    context.fillStyle = glow; context.fillRect(0, 0, width, height);
    const face = context.createRadialGradient(cx - radius * .3, cy - radius * .4, 0, cx, cy, radius);
    face.addColorStop(0, '#17222d'); face.addColorStop(.68, '#101923'); face.addColorStop(1, '#0a111a');
    context.beginPath(); context.arc(cx, cy, radius, 0, TWO_PI); context.fillStyle = face; context.fill();
    context.strokeStyle = '#5a9abb24'; context.lineWidth = .7; context.stroke();
    function line(points, color, lineWidth = .5) {
      context.beginPath(); let active = false;
      for (const point of points) { const p = project(point); if (p.z < -.025) { active = false; continue; } const x = cx + p.x * radius, y = cy - p.y * radius; if (!active) context.moveTo(x, y); else context.lineTo(x, y); active = true; }
      context.strokeStyle = color; context.lineWidth = lineWidth; context.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) { const points = []; for (let lon = -180; lon <= 180; lon += 3) points.push(vector(lat, lon)); line(points, '#6fa3bc16'); }
    for (let lon = 0; lon < 360; lon += 30) { const points = []; for (let lat = -90; lat <= 90; lat += 3) points.push(vector(lat, lon)); line(points, '#6fa3bc13'); }
    for (const point of dots) {
      const p = project(point); if (p.z <= .015) continue;
      const alpha = .13 + Math.pow(p.z, .65) * .75;
      context.fillStyle = `rgba(156,184,200,${alpha.toFixed(3)})`;
      context.beginPath(); context.arc(cx + p.x * radius, cy - p.y * radius, Math.max(.5, radius / 240) * (.65 + p.z * .5), 0, TWO_PI); context.fill();
    }
    routes.forEach((route, index) => {
      const blue = index % 3 === 0;
      line(route.points, blue ? '#5ac1e160' : '#f6784d79', blue ? .8 : .85);
      const endpoint = project(route.end);
      if (endpoint.z > .015) { context.fillStyle = blue ? '#7ed7f1' : '#ffb17f'; context.beginPath(); context.arc(cx + endpoint.x * radius, cy - endpoint.y * radius, 1.6, 0, TWO_PI); context.fill(); }
      if (!paused) {
        const at = (elapsed * .065 + route.phase) % 1, p = project(route.points[Math.floor(at * 60)]);
        if (p.z > .04) { context.fillStyle = blue ? '#9be4fc' : '#ffd3a7'; context.shadowBlur = 9; context.shadowColor = blue ? '#62c9f7' : '#ff7a3d'; context.beginPath(); context.arc(cx + p.x * radius, cy - p.y * radius, 1.6, 0, TWO_PI); context.fill(); context.shadowBlur = 0; }
      }
    });
    const hub = project(origin);
    if (hub.z > 0) {
      const x = cx + hub.x * radius, y = cy - hub.y * radius;
      const aura = context.createRadialGradient(x,y,1,x,y,16); aura.addColorStop(0,'#ffb986b0'); aura.addColorStop(1,'#ff633d00');
      context.fillStyle = aura; context.beginPath(); context.arc(x,y,16,0,TWO_PI); context.fill();
      context.fillStyle = '#fff2db'; context.beginPath(); context.arc(x,y,2.5,0,TWO_PI); context.fill();
      context.strokeStyle = '#ffa97080'; context.lineWidth = .8; context.beginPath(); context.arc(x,y,6.5,0,TWO_PI); context.stroke();
    }
  }
  function animate(stamp) {
    frame = 0;
    if (!visible || document.hidden) { lastStamp = 0; return; }
    if (!paused) elapsed += lastStamp ? Math.min(60, stamp - lastStamp) / 1000 : 0;
    lastStamp = stamp; paint();
    if (!paused) frame = requestAnimationFrame(animate);
  }
  function requestPaint() { if (!frame && visible && !document.hidden) frame = requestAnimationFrame(animate); }
  function resize() {
    const bounds = canvas.getBoundingClientRect(); width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
    const dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    context.setTransform(dpr,0,0,dpr,0,0); requestPaint();
  }
  function setPaused(value) {
    paused = value; lastStamp = 0;
    document.body.classList.toggle('motion-paused', value);
    motionButton?.setAttribute('aria-pressed', String(value));
    const label = motionButton?.querySelector('.motion-label'), icon = motionButton?.querySelector('.motion-icon');
    if (label) label.textContent = value ? 'Play motion' : 'Pause motion';
    if (icon) icon.textContent = value ? '▷' : 'Ⅱ';
    requestPaint();
  }
  motionButton?.addEventListener('click', () => setPaused(!paused));
  motion.addEventListener('change', () => setPaused(motion.matches));
  canvas.addEventListener('pointerdown', event => { if (event.button !== 0) return; drag = {x:event.clientX,rotation}; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => { if (!drag) return; const distance = event.clientX - drag.x; rotation = drag.rotation - distance * .24; requestPaint(); });
  function stopDrag() { if (!drag) return; drag = null; lastStamp = 0; requestPaint(); }
  canvas.addEventListener('pointerup', stopDrag); canvas.addEventListener('pointercancel', stopDrag);
  canvas.addEventListener('lostpointercapture', stopDrag);
  canvas.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','Home'].includes(event.key)) return; event.preventDefault(); rotation = event.key === 'Home' ? 16 : rotation + (event.key === 'ArrowLeft' ? -10 : 10); requestPaint(); });
  document.addEventListener('visibilitychange', () => { lastStamp = 0; if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; } else requestPaint(); });
  if ('IntersectionObserver' in window) new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; lastStamp=0; if (!visible&&frame) { cancelAnimationFrame(frame);frame=0; } else requestPaint(); }, {rootMargin:'120px'}).observe(canvas);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas); else addEventListener('resize',resize,{passive:true});
  setPaused(paused); resize();
})();
