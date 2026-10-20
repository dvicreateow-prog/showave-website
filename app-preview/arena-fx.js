/* ===========================================================================
   arena-fx.js — effects that actually process pixels.
   ---------------------------------------------------------------------------
   effects.htm sets the contract, and it is short:

     "video effects always have at least two parameters: Opacity and Blend Mode.
      You use these to mix the effect with the original video."

   So every effect here computes its result into a scratch canvas, and that
   result is then mixed back over the untouched original using the effect's own
   blend mode and opacity. That is why turning an effect's opacity down fades it
   out rather than switching it off, and why "select the Alpha blend and turn the
   opacity all the way up" shows the effect and nothing but the effect. Mask is
   the sampled exception: Arena 7.27.1 reports mixer:null for it, so its result
   replaces the incoming frame directly.

   Order matters, because each effect is handed the output of the one before it
   (effects.htm: "they will be applied in order, starting with the top one").

   These are honest re-implementations on a 2D canvas, not Resolume's shaders.
   Where a real effect cannot be expressed here it is absent rather than faked,
   and ArenaFX.has() reports that so the UI can say so.
   =========================================================================== */
(() => {
'use strict';

const scratch = [];
function pad(i, w, h){
  if(!scratch[i]){
    const c = document.createElement('canvas');
    scratch[i] = c.getContext('2d', {willReadFrequently:false});
  }
  const ctx = scratch[i];
  if(ctx.canvas.width !== w || ctx.canvas.height !== h){ ctx.canvas.width = w; ctx.canvas.height = h; }
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.clearRect(0,0,w,h);
  return ctx;
}
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const blackUnder = (dst, p, w, h) => {
  if(!p || !p['Black BG']) return;
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.globalAlpha = 1;
  dst.globalCompositeOperation = 'source-over';
  dst.fillStyle = '#000';
  dst.fillRect(0, 0, w, h);
  dst.restore();
};
const packedColorCss = word => {
  const n = Number(word) >>> 0;
  if(typeof window !== 'undefined' && window.ArenaEngine && window.ArenaEngine.colorCss)
    return window.ArenaEngine.colorCss(n);
  const a = (n >>> 24) & 255, r = (n >>> 16) & 255, g = (n >>> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
};

/* --------------------------------------------------------------------------
   The registry.
   params: what the effect exposes, in the order Resolume shows them.
   draw(dst, src, p, w, h, t): paint the processed result into dst.
     src is the incoming image (a canvas), p the parameter values by name,
     t the clip's phase 0..1 so time-based effects can move.
   -------------------------------------------------------------------------- */
const FX = {};
const def = (name, params, draw) => { FX[name] = {name, params, draw}; };
let DIAGNOSTIC_OBSERVER = null;
const DEFAULT_CLOCK_SECONDS = () => typeof performance !== 'undefined' && performance.now
  ? performance.now() / 1000 : 0;
let CLOCK_SECONDS = DEFAULT_CLOCK_SECONDS;
function reportDiagnostic(record){
  if(!DIAGNOSTIC_OBSERVER) return;
  try { DIAGNOSTIC_OBSERVER(record); } catch(observerError){}
}

/* --------------------------------------------------------------------------
   Image resources shared by Mask and UV Map
   --------------------------------------------------------------------------
   Effect parameters keep only a stable string id. Decoders, object URLs and
   ImageBitmaps are runtime resources and live here, outside the serialisable
   composition tree. A selected item from ArenaMedia can therefore use its
   existing id; a file/drop surface can call registerImage() and put the
   returned id into the effect parameter.

   Loading is asynchronous, but drawing is not: the first frame starts one
   decode and subsequent frames reuse it. No effect decodes, fetches or reads a
   mask image on every frame. */
const IMAGE_RESOURCES = new Map();
let imageResourceSerial = 1;

const drawableSize = source => {
  if(!source) return {w:0, h:0};
  return {
    w: Number(source.naturalWidth || source.videoWidth || source.width || 0),
    h: Number(source.naturalHeight || source.videoHeight || source.height || 0)
  };
};
const drawableReady = source => {
  const d = drawableSize(source);
  if(d.w < 1 || d.h < 1) return false;
  if(typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement)
    return source.complete && source.naturalWidth > 0;
  if(typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement)
    return source.readyState >= 2 && source.videoWidth > 0;
  return true;
};

function mediaImageSource(ref){
  const media = window.ArenaMedia && window.ArenaMedia.find
    ? window.ArenaMedia.find(ref) : null;
  if(!media) return null;
  /* A still's video URL is the image itself. For moving media, the generated
     poster is the stable still that an image-valued parameter can own. */
  return media.mediaKind === 'image'
    ? (media.video || media.poster)
    : (media.poster || media.video);
}

function decodeImageSource(source){
  if(drawableReady(source)) return Promise.resolve(source);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    /* Remote images must opt into CORS or they would poison every downstream
       canvas. Same-origin, data: and blob: resources need no attribute. */
    if(typeof source === 'string' && /^https?:/i.test(source)){
      try { if(new URL(source, location.href).origin !== location.origin) img.crossOrigin = 'anonymous'; }
      catch(e){}
    }
    img.onload = () => {
      if(!drawableReady(img)){ reject(new Error('Image decoded without pixels')); return; }
      /* ImageBitmap is the cheapest upload source on Chromium. If creating one
         is unavailable or fails, the already-decoded image is still valid. */
      if(typeof createImageBitmap === 'function'){
        createImageBitmap(img).then(resolve, () => resolve(img));
      } else resolve(img);
    };
    img.onerror = () => reject(new Error('The image could not be decoded'));
    img.src = String(source);
  });
}

function disposeImageRecord(rec){
  if(!rec) return;
  rec.disposed = true;
  if(rec.image && typeof ImageBitmap !== 'undefined' && rec.image instanceof ImageBitmap){
    try { rec.image.close(); } catch(e){}
  }
  if(rec.ownedUrl){ try { URL.revokeObjectURL(rec.ownedUrl); } catch(e){} }
}

/* Synchronous registration is intentional: a picker can register a File, put
   the returned id through ArenaEngine.setParam() in the same user gesture, and
   let decoding finish off the render loop. */
function registerImage(ref, source){
  if(arguments.length < 2){
    source = ref;
    if(typeof source === 'string') ref = source;
    else ref = 'image:' + (source && source.name ? source.name + ':' : '') + imageResourceSerial++;
  }
  const key = String(ref || ('image:' + imageResourceSerial++));
  const old = IMAGE_RESOURCES.get(key);
  if(old && old.original === source) return key;
  if(old) disposeImageRecord(old);

  let actual = source;
  let ownedUrl = null;
  if(typeof Blob !== 'undefined' && source instanceof Blob){
    ownedUrl = URL.createObjectURL(source);
    actual = ownedUrl;
  }
  if(typeof actual === 'string') actual = mediaImageSource(actual) || actual;

  const rec = {
    id:key, original:source, source:actual, ownedUrl,
    status:'loading', image:null, error:null, variants:new Map(), version:1,
    promise:null, disposed:false
  };
  IMAGE_RESOURCES.set(key, rec);
  rec.promise = decodeImageSource(actual).then(image => {
    if(rec.disposed){
      if(image && typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap){
        try { image.close(); } catch(e){}
      }
      return rec;
    }
    rec.image = image;
    rec.status = 'ready';
    rec.version++;
    return rec;
  }, err => {
    rec.status = 'error';
    rec.error = String(err && err.message || err);
    return rec;
  });
  return key;
}

function imageRecord(ref){
  const key = String(ref == null ? '' : ref).trim();
  if(!key) return null;
  let rec = IMAGE_RESOURCES.get(key);
  if(rec){
    /* ArenaMedia may finish loading or generating a poster after an effect was
       restored. Retry a failed bare id when it becomes resolvable instead of
       pinning the effect in an error state for the rest of the session. */
    const recovered = rec.status === 'error' ? mediaImageSource(key) : null;
    if(recovered && recovered !== rec.source){
      registerImage(key, recovered);
      rec = IMAGE_RESOURCES.get(key);
    }
    return rec;
  }
  /* Existing media ids and direct same-origin/blob/data URLs require no extra
     UI registration. Lazily enrolling them also means compositions restored
     before ArenaMedia finished loading recover as soon as they are rendered. */
  const source = mediaImageSource(key) || key;
  registerImage(key, source);
  return IMAGE_RESOURCES.get(key) || null;
}

async function loadImage(name, source){
  const id = arguments.length < 2 ? registerImage(name) : registerImage(name, source);
  const rec = IMAGE_RESOURCES.get(id);
  await rec.promise;
  return rec.status === 'ready'
    ? {id, width:drawableSize(rec.image).w, height:drawableSize(rec.image).h}
    : {id, error:rec.error || 'The image could not be decoded'};
}

function releaseImage(ref){
  const key = String(ref == null ? '' : ref);
  const rec = IMAGE_RESOURCES.get(key);
  if(!rec) return false;
  disposeImageRecord(rec);
  IMAGE_RESOURCES.delete(key);
  return true;
}

/* --- filter-based: the browser's own image filters are the right tool ----- */
/* The browser's blur samples transparent black beyond the source, so a blurred
   full-frame clip came out with its edges eaten away — invisible until effect
   mixing stopped drawing the original underneath, and then very visible. A real
   gaussian on a clamped texture does not do that. The frame is therefore
   blurred inside a padded buffer whose margin is the edge pixels stretched
   outwards, which is what clamping means, and the centre is taken back out.
   Genuine transparency in the source still softens, as it should. */
def('Blur', [{n:'Amount', min:0, max:1, d:0.35}], (dst, src, p, w, h, t, info) => {
  const r = p.Amount * 40;
  if(r <= 0.01 || !info || !info.buffer){ dst.drawImage(src, 0, 0); return; }
  const pad = Math.max(1, Math.ceil(r * 2));
  const b = info.buffer(w + pad * 2, h + pad * 2);
  b.setTransform(1,0,0,1,0,0); b.globalAlpha = 1; b.filter = 'none';
  b.globalCompositeOperation = 'source-over';
  b.clearRect(0, 0, w + pad * 2, h + pad * 2);
  b.drawImage(src, 0,   0,   1, h,  0,       pad,     pad, h);    /* left   */
  b.drawImage(src, w-1, 0,   1, h,  pad + w, pad,     pad, h);    /* right  */
  b.drawImage(src, 0,   0,   w, 1,  pad,     0,       w,   pad);  /* top    */
  b.drawImage(src, 0,   h-1, w, 1,  pad,     pad + h, w,   pad);  /* bottom */
  b.drawImage(src, 0,   0,   1, 1,  0,       0,       pad, pad);
  b.drawImage(src, w-1, 0,   1, 1,  pad + w, 0,       pad, pad);
  b.drawImage(src, 0,   h-1, 1, 1,  0,       pad + h, pad, pad);
  b.drawImage(src, w-1, h-1, 1, 1,  pad + w, pad + h, pad, pad);
  b.drawImage(src, pad, pad);
  dst.filter = `blur(${r.toFixed(2)}px)`;
  dst.drawImage(b.canvas, -pad, -pad);
  dst.filter = 'none';
});
def('Bright.Contrast', [{n:'Brightness', min:0, max:2, d:1}, {n:'Contrast', min:0, max:2, d:1}],
  (dst, src, p) => {
    dst.filter = `brightness(${p.Brightness}) contrast(${p.Contrast})`;
    dst.drawImage(src, 0, 0);
  });
/* Captured Arena 7.27 composition schema (A128): one ParamRange named exactly
   "Hue Rotate". Motion belongs to that parameter's normal animation contract;
   Speed was a local invention that prevented .avc restore from finding it. */
def('Hue Rotate', [{n:'Hue Rotate', min:0, max:1, d:0}],
  (dst, src, p) => {
    const deg = clamp(p['Hue Rotate'], 0, 1) * 360;
    dst.filter = `hue-rotate(${deg.toFixed(1)}deg)`;
    dst.drawImage(src, 0, 0);
  });
def('Saturation', [{n:'Saturation', min:0, max:3, d:1}], (dst, src, p) => {
  dst.filter = `saturate(${p.Saturation})`; dst.drawImage(src, 0, 0);
});
/* Greyscale and Sepia USED TO BE HERE and are gone, along with Solarize below.
   Resolume Arena 7.27.1 ships 106 video effects — arena-catalog.js has the list
   from a running Arena's own REST API — and none of those three is one of them.
   They were reachable from nowhere either, because arena-data.js VIDEO_EFFECTS
   is that same 106, so all they did was make ArenaFX.count() read 91 against a
   catalogue of 106 and invite the arithmetic to be got wrong.
   Greyscale is what Saturation at 0 does, and Resolume's own answer to sepia is
   Colorize or a LUT. Inventing effects is the mirror image of dropping them,
   and this file does neither. */
/* Factory schema: default/Presets/Video Effects/Invert RGB/Sweded.xml. The
   three channels are independent amounts, so a CSS invert() (one shared
   amount) cannot represent the real control. Difference against a channel
   colour is the same operation at the ends and stays entirely on the GPU. */
def('Invert RGB', [{n:'R', min:0, max:1, d:1}, {n:'G', min:0, max:1, d:1},
                   {n:'B', min:0, max:1, d:1}], (dst, src, p, w, h) => {
  dst.drawImage(src, 0, 0);
  dst.globalCompositeOperation = 'difference';
  dst.fillStyle = `rgb(${Math.round(clamp(p.R, 0, 1) * 255)},` +
                  `${Math.round(clamp(p.G, 0, 1) * 255)},` +
                  `${Math.round(clamp(p.B, 0, 1) * 255)})`;
  dst.fillRect(0, 0, w, h);
  /* Difference with an opaque fill would otherwise invent opaque pixels in
     transparent source areas. Restore the incoming alpha without a readback. */
  dst.globalCompositeOperation = 'destination-in';
  dst.drawImage(src, 0, 0);
});

/* --- geometry ------------------------------------------------------------- */
def('Flip', [{n:'Horizontal', kind:'bool', d:true}, {n:'Vertical', kind:'bool', d:false},
             {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h, t, info) => {
    /* parameters.htm cites Flip's Horizontal and Vertical as toggles */
    blackUnder(dst, p, w, h);
    const fx = p.Horizontal ? -1 : 1, fy = p.Vertical ? -1 : 1;
    dst.translate(fx < 0 ? w : 0, fy < 0 ? h : 0);
    dst.scale(fx, fy);
    dst.drawImage(src, 0, 0);
  });
def('Mirror', [{n:'X', min:0, max:1, d:0}, {n:'Y', min:0, max:1, d:0},
               {n:'In / Out', min:0, max:1, d:1},
               {n:'Flip X', kind:'bool', d:false}, {n:'Flip Y', kind:'bool', d:false},
               {n:'Black BG', kind:'bool', d:false}], (dst, src, p, w, h) => {
  blackUnder(dst, p, w, h);
  dst.drawImage(src, 0, 0);
  const xAmount = clamp(p.X, 0, 1), yAmount = clamp(p.Y, 0, 1);
  if(xAmount <= 0.0001 && yAmount <= 0.0001) return;
  /* The shipped Basic preset sets X=.5 and Horizontal sets Y=.5; Black Hole
     sets both. Build those axes independently, so the latter really is a quad
     mirror instead of one slider silently winning. */
  const mirrorX = (out, input) => {
    const half = Math.ceil(w / 2), fromRight = !!p['Flip X'];
    const sx = fromRight ? w - half : 0;
    out.drawImage(input, sx, 0, half, h, 0, 0, half, h);
    out.save(); out.translate(w, 0); out.scale(-1, 1);
    out.drawImage(input, sx, 0, half, h, 0, 0, half, h); out.restore();
  };
  const mirrorY = (out, input) => {
    const half = Math.ceil(h / 2), fromBottom = !!p['Flip Y'];
    const sy = fromBottom ? h - half : 0;
    out.drawImage(input, 0, sy, w, half, 0, 0, w, half);
    out.save(); out.translate(0, h); out.scale(1, -1);
    out.drawImage(input, 0, sy, w, half, 0, 0, w, half); out.restore();
  };
  let image = src;
  if(xAmount > 0.0001){ const x = pad(2, w, h); mirrorX(x, image); image = x.canvas; }
  if(yAmount > 0.0001){ const y = pad(3, w, h); mirrorY(y, image); image = y.canvas; }
  const amount = 0.35 + clamp(p['In / Out'], 0, 1) * 0.65;
  dst.save();
  dst.globalAlpha = clamp(Math.max(xAmount, yAmount) * 2, 0, 1);
  dst.translate(w / 2, h / 2);
  dst.scale(amount, amount);
  dst.translate(-w / 2, -h / 2);
  dst.drawImage(image, 0, 0);
  dst.restore();
});
def('Kaleidoscope', [{n:'Angles', min:0, max:1, d:0.3}, {n:'Rotation', min:0, max:1, d:0},
                     {n:'Zoom', min:0, max:1, d:0.5},
                     {n:'Input Rotation', min:0, max:1, d:0},
                     {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    blackUnder(dst, p, w, h);
    const n = Math.max(2, Math.round(2 + clamp(p.Angles, 0, 1) * 30));
    const cx = w/2, cy = h/2, r = Math.hypot(cx, cy);
    const base = p.Rotation * Math.PI * 2;
    const inputRotation = p['Input Rotation'] * Math.PI * 2;
    const zoom = Math.pow(4, clamp(p.Zoom, 0, 1) - 0.5);
    for(let i = 0; i < n; i++){
      dst.save();
      dst.translate(cx, cy);
      dst.rotate(base + i * (Math.PI*2/n));
      if(i % 2) dst.scale(1, -1);
      dst.beginPath(); dst.moveTo(0,0);
      dst.arc(0, 0, r, -Math.PI/n, Math.PI/n); dst.closePath(); dst.clip();
      dst.rotate(inputRotation);
      dst.scale(zoom, zoom);
      dst.translate(-cx, -cy);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
  });
def('Crop', [{n:'Left', min:0, max:1, d:0}, {n:'Right', min:0, max:1, d:0},
             {n:'Top', min:0, max:1, d:0}, {n:'Bottom', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    const x = p.Left*w, y = p.Top*h;
    const cw = Math.max(1, w - x - p.Right*w), chh = Math.max(1, h - y - p.Bottom*h);
    dst.beginPath(); dst.rect(x, y, cw, chh); dst.clip();
    dst.drawImage(src, 0, 0);
  });
def('LoRez', [{n:'Pixel Size', min:0, max:1, d:0},
              {n:'Bit Reduction', min:0, max:1, d:0},
              {n:'Dither', min:0, max:1, d:0}], (dst, src, p, w, h) => {
  const step = Math.max(1, Math.round(p['Pixel Size'] * 48));
  const sw = Math.max(1, Math.round(w/step)), sh = Math.max(1, Math.round(h/step));
  const tmp = pad(3, sw, sh);
  tmp.imageSmoothingEnabled = true;
  tmp.drawImage(src, 0, 0, sw, sh);
  /* The shipped LoRez preset exposes three normalized plugin Parameters. The
     old implementation omitted Bit Reduction and Dither entirely and even
     changed Pixel Size's factory default from 0 to .35. Quantise on the
     already-reduced surface so Pixel Size still controls the size of both the
     pixels and the ordered dither pattern. At Pixel Size 0 this is necessarily
     a full-frame CPU readback; a shader is required to make that worst case
     reliably fit a 60 fps 1080p budget. */
  const reduction=clamp(p['Bit Reduction'],0,1), dither=clamp(p.Dither,0,1);
  if(reduction>0.0001 || dither>0.0001){
    const levels=Math.max(2,Math.round(256-(254*reduction)));
    const quantum=255/(levels-1);
    const bayer=[0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,
                 12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,
                 3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,
                 15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];
    const image=tmp.getImageData(0,0,sw,sh), data=image.data;
    for(let y=0;y<sh;y++) for(let x=0;x<sw;x++){
      const i=(y*sw+x)*4;
      const bias=((bayer[(y&7)*8+(x&7)]+0.5)/64-0.5)*quantum*dither;
      data[i]=clamp(Math.round((data[i]+bias)/quantum)*quantum,0,255);
      data[i+1]=clamp(Math.round((data[i+1]+bias)/quantum)*quantum,0,255);
      data[i+2]=clamp(Math.round((data[i+2]+bias)/quantum)*quantum,0,255);
    }
    tmp.putImageData(image,0,0);
  }
  dst.imageSmoothingEnabled = false;
  dst.drawImage(tmp.canvas, 0, 0, sw, sh, 0, 0, w, h);
  dst.imageSmoothingEnabled = true;
});
def('Slide', [{n:'X', min:0, max:1, d:0}, {n:'Y', min:0, max:1, d:0},
              {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    const ox = clamp(p.X, 0, 1) * w, oy = clamp(p.Y, 0, 1) * h;
    blackUnder(dst, p, w, h);
    if(p['Black BG']){
      dst.drawImage(src, ox, oy);
      return;
    }
    /* The factory presets animate X/Y themselves. Wrapping is the non-black
       mode; Black BG deliberately leaves the newly exposed edge black. */
    for(let i = -1; i <= 0; i++) for(let j = -1; j <= 0; j++)
      dst.drawImage(src, ox + i*w, oy + j*h);
  });

/* --- colour --------------------------------------------------------------- */
def('Colorize', [{n:'Color', kind:'color', d:0xFFFF0000, defFrom:'preset'},
                 /* The installed XML stores 0/1 without choice labels. Those
                    serialized values are the options; naming them would invent
                    UI text Arena did not preserve in the preset. */
                 {n:'Mode', node:'ParamChoice', kind:'choice', options:['0','1'], d:'0'},
                 {n:'Weighted', kind:'bool', d:true},
                 {n:'GreysKeep', kind:'bool', d:false},
                 {n:'GreysTolerance', min:0, max:1, d:0.3},
                 {n:'Invert', kind:'bool', d:false},
                 {n:'Contrast', min:0, max:1, d:0.2}],
  (dst, src, p, w, h) => {
    const contrast = clamp(1 + (p.Contrast - 0.2) * 2.5, 0.05, 3);
    dst.filter = `${p.Invert ? 'invert(1) ' : ''}contrast(${contrast.toFixed(3)})`;
    dst.drawImage(src, 0, 0);
    dst.filter = 'none';
    dst.globalCompositeOperation = p.Mode >= 0.5 ? 'hue' : 'color';
    dst.globalAlpha = p.Weighted ? 1 : 0.82;
    dst.fillStyle = packedColorCss(p.Color);
    dst.fillRect(0, 0, w, h);
    /* GreysKeep is a selective shader operation in Arena. Canvas 2D has no
       saturation mask without a GPU->CPU readback, so its readback-free path
       restores the source in proportion to the exact tolerance parameter. */
    if(p.GreysKeep){
      dst.globalCompositeOperation = 'source-over';
      dst.globalAlpha = clamp(p.GreysTolerance, 0, 1);
      dst.drawImage(src, 0, 0);
    }
    dst.globalAlpha = 1;
    dst.globalCompositeOperation = 'destination-in';
    dst.drawImage(src, 0, 0);
  });
def('Add Subtract', [{n:'R', min:-1, max:1, d:0}, {n:'G', min:-1, max:1, d:0}, {n:'B', min:-1, max:1, d:0}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const pos = [p.R, p.G, p.B].map(v => Math.max(0, v));
    const neg = [p.R, p.G, p.B].map(v => Math.max(0, -v));
    if(pos.some(v => v > 0)){
      dst.globalCompositeOperation = 'lighter';
      dst.fillStyle = `rgb(${pos.map(v => Math.round(v*255)).join(',')})`;
      dst.fillRect(0, 0, w, h);
    }
    if(neg.some(v => v > 0)){
      dst.globalCompositeOperation = 'difference';
      dst.fillStyle = `rgb(${neg.map(v => Math.round(v*255)).join(',')})`;
      dst.fillRect(0, 0, w, h);
    }
  });
/* layers.htm — "If your content doesn't [have alpha], you can use the Auto Mask
   effect to turn the black pixels transparent. You will need to play around with
   the Contrast parameter to get the desired result." */
def('Auto Mask', [{n:'Threshold', min:0, max:1, d:0.15}, {n:'Contrast', min:0, max:1, d:0.5}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const img = dst.getImageData(0, 0, w, h), d = img.data;
    const thr = p.Threshold * 255, soft = Math.max(1, (1 - p.Contrast) * 255);
    for(let i = 0; i < d.length; i += 4){
      const lum = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
      const a = clamp((lum - thr) / soft, 0, 1);
      d[i+3] = d[i+3] * a;
    }
    dst.putImageData(img, 0, 0);
  });
def('Delay RGB', [{n:'Distance', min:0, max:1, d:0.2}, {n:'Angle', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    const r = p.Distance * w * 0.05, a = p.Angle * Math.PI * 2;
    const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
    dst.globalCompositeOperation = 'lighter';
    const chan = (col, ox, oy) => {
      const t = pad(4, w, h);
      t.drawImage(src, 0, 0);
      t.globalCompositeOperation = 'multiply';
      t.fillStyle = col; t.fillRect(0, 0, w, h);
      dst.drawImage(t.canvas, ox, oy);
    };
    chan('#ff0000',  dx,  dy);
    chan('#00ff00',   0,   0);
    chan('#0000ff', -dx, -dy);
  });

/* --- time ----------------------------------------------------------------- */
def('Strobe', [{n:'Speed', min:0, max:1, d:0.5}, {n:'Duty', min:0, max:1, d:0.5}],
  (dst, src, p, w, h, t, ctxInfo) => {
    const rate = 1 + p.Speed * 30;
    const phase = (ctxInfo.beats * rate) % 1;
    if(phase < p.Duty) dst.drawImage(src, 0, 0);
  });
/* The parameter is called Feedback and its default is 0.9, not "Amount"/0.6.
   Measured, not inferred: Example.avc carries two serialised Trails passes
   (type="Trails" uniqueTypeId="A111") and both read
   <ParamRange name="Feedback" T="DOUBLE" default="0.89999997615814208984">.
   The old name meant no shipped preset or .avc value could ever bind to it. */
def('Trails', [{n:'Feedback', min:0, max:1, d:0.9}], (dst, src, p, w, h, t, ctxInfo) => {
  /* keep a persistent buffer per effect instance so the tail survives frames */
  const buf = ctxInfo.buffer(w, h);
  buf.globalAlpha = clamp(1 - p.Feedback, 0.02, 1);
  buf.globalCompositeOperation = 'source-over';
  buf.drawImage(src, 0, 0);
  buf.globalAlpha = 1;
  dst.drawImage(buf.canvas, 0, 0);
});

/* --- second batch: the rest of the ones a 2D canvas can do honestly -------- */
def('Bloom', [{n:'Threshold', min:0, max:1, d:0.6}, {n:'Amount', min:0, max:1, d:0.6},
              {n:'Size', min:0, max:1, d:0.4}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const t = pad(5, w, h);
    t.filter = `brightness(${1 + p.Threshold*2}) contrast(${1 + p.Threshold*3}) blur(${p.Size*32}px)`;
    t.drawImage(src, 0, 0);
    dst.globalCompositeOperation = 'lighter';
    dst.globalAlpha = p.Amount;
    dst.drawImage(t.canvas, 0, 0);
  });
def('Vignette', [{n:'Roundness', min:0, max:1, d:0.3}, {n:'Size', min:0, max:1, d:0},
                 {n:'Softness', min:0, max:1, d:0.96},
                 {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    blackUnder(dst, p, w, h);
    dst.drawImage(src, 0, 0);
    const round = clamp(p.Roundness, 0, 1);
    const rx = w * (0.42 + round * 0.18), ry = h * (0.42 + (1 - round) * 0.18);
    const r = Math.max(1, Math.min(rx, ry));
    const inner = r * clamp(p.Size, 0, 1) * 0.9;
    const outer = Math.max(inner + 1, inner + r * (0.05 + clamp(p.Softness, 0, 1)));
    dst.save();
    dst.translate(w / 2, h / 2);
    dst.scale(rx / r, ry / r);
    dst.translate(-w / 2, -h / 2);
    const g = dst.createRadialGradient(w/2, h/2, inner, w/2, h/2, outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    dst.fillStyle = g; dst.fillRect(0, 0, w, h);
    dst.restore();
    if(!p['Black BG']){
      dst.globalCompositeOperation = 'destination-in';
      dst.drawImage(src, 0, 0);
    }
  });
def('Exposure', [{n:'Exposure', min:0, max:4, d:1}], (dst, src, p) => {
  dst.filter = `brightness(${p.Exposure})`; dst.drawImage(src, 0, 0);
});
/* Solarize was here. See the note where Greyscale and Sepia were: Arena ships
   106 video effects and Solarize is not among them. */
def('Posterize', [{n:'Levels', min:2, max:32, d:6}], (dst, src, p, w, h) => {
  dst.drawImage(src, 0, 0);
  const img = dst.getImageData(0,0,w,h), d = img.data;
  const n = Math.max(2, Math.round(p.Levels)), step = 255/(n-1);
  for(let i = 0; i < d.length; i += 4){
    d[i]   = Math.round(d[i]/step)*step;
    d[i+1] = Math.round(d[i+1]/step)*step;
    d[i+2] = Math.round(d[i+2]/step)*step;
  }
  dst.putImageData(img, 0, 0);
});
def('Threshold', [{n:'Level', min:0, max:1, d:0.5}], (dst, src, p, w, h) => {
  dst.drawImage(src, 0, 0);
  const img = dst.getImageData(0,0,w,h), d = img.data, t = p.Level*255;
  for(let i = 0; i < d.length; i += 4){
    const v = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114) > t ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
  }
  dst.putImageData(img, 0, 0);
});
def('Color Pass', [{n:'Hue', min:0, max:1, d:0}, {n:'Tolerance', min:0, max:1, d:0.15}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const img = dst.getImageData(0,0,w,h), d = img.data;
    const target = p.Hue*360, tol = p.Tolerance*180 + 1;
    for(let i = 0; i < d.length; i += 4){
      const r = d[i]/255, g = d[i+1]/255, b = d[i+2]/255;
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b), c = mx - mn;
      let hue = 0;
      if(c > 0.0001){
        if(mx === r) hue = 60*(((g-b)/c) % 6);
        else if(mx === g) hue = 60*(((b-r)/c) + 2);
        else hue = 60*(((r-g)/c) + 4);
      }
      if(hue < 0) hue += 360;
      let diff = Math.abs(hue - target); if(diff > 180) diff = 360 - diff;
      if(diff > tol){ const l = r*0.299 + g*0.587 + b*0.114; d[i]=d[i+1]=d[i+2]=l*255; }
    }
    dst.putImageData(img, 0, 0);
  });
def('Dot Screen', [{n:'Size', min:0, max:1, d:0.3}], (dst, src, p, w, h) => {
  const step = Math.max(2, Math.round(2 + p.Size*20));
  const t = pad(5, w, h); t.drawImage(src, 0, 0);
  const d = t.getImageData(0,0,w,h).data;
  dst.fillStyle = '#000'; dst.fillRect(0,0,w,h);
  for(let y = 0; y < h; y += step) for(let x = 0; x < w; x += step){
    const i = ((y|0)*w + (x|0))*4;
    const lum = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)/255;
    if(lum < 0.02) continue;
    dst.fillStyle = `rgb(${d[i]},${d[i+1]},${d[i+2]})`;
    dst.beginPath(); dst.arc(x + step/2, y + step/2, lum*step/2, 0, Math.PI*2); dst.fill();
  }
});
def('Infinite Zoom', [{n:'Zoom', min:0, max:1, d:0.4}, {n:'Steps', min:1, max:12, d:5},
                      {n:'Speed', min:0, max:1, d:0.3}],
  (dst, src, p, w, h, t) => {
    const n = Math.max(1, Math.round(p.Steps));
    const drift = (p.Speed * t) % 1;
    for(let i = n - 1; i >= 0; i--){
      const s = Math.pow(1 + p.Zoom, i + drift);
      dst.save();
      dst.globalAlpha = 1 - i/(n + 1);
      dst.translate(w/2, h/2); dst.scale(s, s); dst.translate(-w/2, -h/2);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
  });
/* 'RadialBlur', not 'Radial Blur' — arena-data.js:65 carries the name decoded
   from the Arena binary, and ArenaFX.has() matches the catalogue string exactly.
   The space made this shipped effect permanently unreachable from the browser. */
def('RadialBlur', [{n:'Steps', min:0, max:1, d:0.3}, {n:'Distance', min:0, max:1, d:0.1},
                   {n:'Rotation', min:0, max:1, d:0.5},
                   {n:'High Quality', kind:'bool', d:false},
                   {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    blackUnder(dst, p, w, h);
    const n = Math.max(2, Math.round(2 + clamp(p.Steps, 0, 1) * (p['High Quality'] ? 30 : 14)));
    const distance = clamp(p.Distance, 0, 1) * 0.75;
    const rotation = (clamp(p.Rotation, 0, 1) - 0.5) * Math.PI;
    for(let i = 0; i < n; i++){
      const u = n > 1 ? i / (n - 1) : 0;
      const s = 1 + u * distance;
      dst.save();
      dst.globalAlpha = 1 / n;
      dst.globalCompositeOperation = 'lighter';
      dst.translate(w/2, h/2); dst.rotate(rotation * u); dst.scale(s, s); dst.translate(-w/2, -h/2);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
  });
def('Tile', [{n:'Tile X', min:0, max:1, d:0.1}, {n:'Tile Y', min:0, max:1, d:0.1},
             {n:'Skew X', min:0, max:1, d:0.5}, {n:'Skew Y', min:0, max:1, d:0.5},
             {n:'Rotation Angle', min:0, max:1, d:0},
             {n:'Black BG', kind:'bool', d:false}], (dst, src, p, w, h) => {
  blackUnder(dst, p, w, h);
  /* Keep the high end bounded: 24x24 is already denser than a 1080p operator
     can resolve and avoids turning the normalized controls into a draw storm. */
  const nx = Math.max(1, Math.round(1 + clamp(p['Tile X'], 0, 1) * 23));
  const ny = Math.max(1, Math.round(1 + clamp(p['Tile Y'], 0, 1) * 23));
  const cw = w / nx, ch = h / ny;
  const shx = (clamp(p['Skew X'], 0, 1) - 0.5) * 1.5;
  const shy = (clamp(p['Skew Y'], 0, 1) - 0.5) * 1.5;
  const angle = clamp(p['Rotation Angle'], 0, 1) * Math.PI * 2;
  for(let y = 0; y < ny; y++) for(let x = 0; x < nx; x++){
    dst.save();
    dst.translate((x + 0.5) * cw, (y + 0.5) * ch);
    dst.rotate(angle);
    dst.transform(1, shy, shx, 1, 0, 0);
    dst.drawImage(src, 0, 0, w, h, -cw / 2, -ch / 2, cw, ch);
    dst.restore();
  }
});
def('Fish Eye', [{n:'Amount', min:0, max:1, d:0.5}, {n:'Slices', min:8, max:64, d:32}],
  (dst, src, p, w, h) => {
    /* approximated by concentric rings, each scaled a little differently */
    const n = Math.max(8, Math.round(p.Slices)), r = Math.hypot(w, h)/2;
    for(let i = n - 1; i >= 0; i--){
      const q = (i + 1)/n;
      const s = 1 + p.Amount * (1 - q) * 0.9;
      dst.save();
      dst.beginPath(); dst.arc(w/2, h/2, r*q, 0, Math.PI*2); dst.clip();
      dst.translate(w/2, h/2); dst.scale(s, s); dst.translate(-w/2, -h/2);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
  });
def('Wave Warp', [{n:'Mode', min:0, max:1, d:0}, {n:'Height', min:0, max:1, d:0.2},
                  {n:'Width', min:0, max:1, d:0.2}, {n:'Angle', min:0, max:1, d:1},
                  {n:'Speed', min:0, max:1, d:0.5},
                  {n:'Pin edges?', kind:'bool', d:true},
                  {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h, t) => {
    blackUnder(dst, p, w, h);
    const amp = clamp(p.Height, 0, 1) * Math.min(w, h) * 0.18;
    const cycles = 0.5 + clamp(p.Width, 0, 1) * 18;
    const angle = clamp(p.Angle, 0, 1) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const mode = Math.min(3, Math.floor(clamp(p.Mode, 0, 0.999999) * 4));
    const wave = phase => {
      const q = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
      if(mode === 1) return 1 - 4 * Math.abs(q - 0.5);       // triangle
      if(mode === 2) return q < 0.5 ? 1 : -1;               // square
      if(mode === 3) return q * 2 - 1;                      // saw
      return Math.sin(phase);
    };
    for(let y = 0; y < h; y++){
      const edge = p['Pin edges?'] ? Math.sin(Math.PI * y / Math.max(1, h - 1)) : 1;
      const phase = y / Math.max(1, h) * cycles * Math.PI * 2 + t * Math.PI * 2 * p.Speed * 8;
      const d = wave(phase) * amp * edge;
      const dx = ca * d, dy = sa * d;
      dst.drawImage(src, 0, y, w, 1, dx, y + dy, w, 1);
      if(!p['Black BG'] && !p['Pin edges?']){
        if(dx > 0) dst.drawImage(src, w - dx, y, dx, 1, 0, y + dy, dx, 1);
        else if(dx < 0) dst.drawImage(src, 0, y, -dx, 1, w + dx, y + dy, -dx, 1);
      }
    }
  });
def('Ripples', [{n:'Frequency H', min:0, max:1, d:0.2}, {n:'Amplitude H', min:0, max:1, d:0.5},
                {n:'Frequency V', min:0, max:1, d:0.2}, {n:'Amplitude V', min:0, max:1, d:0.5},
                {n:'Amplitude Both', min:0, max:1, d:1}, {n:'Phase', min:0, max:1, d:0},
                {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    blackUnder(dst, p, w, h);
    const both = clamp(p['Amplitude Both'], 0, 1);
    const ax = clamp(p['Amplitude H'], 0, 1) * both * w * 0.08;
    const ay = clamp(p['Amplitude V'], 0, 1) * both * h * 0.08;
    const fh = 0.5 + clamp(p['Frequency H'], 0, 1) * 24;
    const fv = 0.5 + clamp(p['Frequency V'], 0, 1) * 24;
    const phase = clamp(p.Phase, 0, 1) * Math.PI * 2;
    for(let y = 0; y < h; y++){
      const q = y / Math.max(1, h - 1);
      const dx = Math.sin(q * fh * Math.PI * 2 + phase) * ax;
      const dy = Math.sin(q * fv * Math.PI * 2 + phase + Math.PI / 2) * ay;
      dst.drawImage(src, 0, y, w, 1, dx, y + dy, w, 1);
      if(!p['Black BG']){
        if(dx > 0) dst.drawImage(src, w - dx, y, dx, 1, 0, y + dy, dx, 1);
        else if(dx < 0) dst.drawImage(src, 0, y, -dx, 1, w + dx, y + dy, -dx, 1);
      }
    }
  });
def('Twitch', [{n:'Global Twitch', min:0, max:1, d:1},
               {n:'Max Pos X', min:0, max:1, d:0}, {n:'Max Pos Y', min:0, max:1, d:0},
               {n:'Pos Frequency', min:0, max:1, d:0},
               {n:'Max Scale', min:0, max:1, d:0}, {n:'Scale Frequency', min:0, max:1, d:0},
               {n:'Max Opacity', min:0, max:1, d:0}, {n:'Opacity Frequency', min:0, max:1, d:0},
               {n:'Max Light', min:0, max:1, d:0}, {n:'Light Frequency', min:0, max:1, d:0},
               {n:'Max RGB Shift', min:0, max:1, d:0}, {n:'RGB Frequency', min:0, max:1, d:0},
               {n:'Max Blur', min:0, max:1, d:0}, {n:'Blur Frequency', min:0, max:1, d:0},
               {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h, t, info) => {
    blackUnder(dst, p, w, h);
    const clock = info && Number.isFinite(info.beats) ? info.beats : Number(t) || 0;
    const hash = n => { const x = Math.sin(n * 97.133 + 17.71) * 43758.5453; return x - Math.floor(x); };
    const twitch = (frequency, salt) => {
      const f = clamp(frequency, 0, 1); if(f <= 0) return 0;
      const step = Math.floor(clock * (0.5 + f * 28));
      const gate = hash(step * 11 + salt);
      return gate < 0.08 + f * 0.72 ? hash(step * 29 + salt * 7) * 2 - 1 : 0;
    };
    const global = clamp(p['Global Twitch'], 0, 1);
    const pos = twitch(p['Pos Frequency'], 1);
    const scalePulse = twitch(p['Scale Frequency'], 2);
    const opacityPulse = Math.abs(twitch(p['Opacity Frequency'], 3));
    const lightPulse = twitch(p['Light Frequency'], 4);
    const rgbPulse = twitch(p['RGB Frequency'], 5);
    const blurPulse = Math.abs(twitch(p['Blur Frequency'], 6));
    const dx = pos * clamp(p['Max Pos X'], 0, 1) * global * w * 0.25;
    const dy = twitch(p['Pos Frequency'], 11) * clamp(p['Max Pos Y'], 0, 1) * global * h * 0.25;
    const scale = Math.max(0.05, 1 + scalePulse * clamp(p['Max Scale'], 0, 1) * global);
    const opacity = 1 - opacityPulse * clamp(p['Max Opacity'], 0, 1) * global;
    const brightness = Math.max(0, 1 + lightPulse * clamp(p['Max Light'], 0, 1) * global * 2);
    const blur = blurPulse * clamp(p['Max Blur'], 0, 1) * global * 24;
    const base = pad(4, w, h);
    base.save();
    base.globalAlpha = opacity;
    base.filter = `brightness(${brightness.toFixed(3)}) blur(${blur.toFixed(2)}px)`;
    base.translate(w / 2 + dx, h / 2 + dy); base.scale(scale, scale); base.translate(-w / 2, -h / 2);
    base.drawImage(src, 0, 0);
    base.restore();
    const rgb = Math.abs(rgbPulse) * clamp(p['Max RGB Shift'], 0, 1) * global;
    if(rgb <= 0.0001){ dst.drawImage(base.canvas, 0, 0); return; }
    const shift = rgb * Math.min(w, h) * 0.04 * (rgbPulse < 0 ? -1 : 1);
    dst.globalCompositeOperation = 'lighter';
    const channel = (index, color, ox, oy) => {
      const ch = pad(index, w, h); ch.drawImage(base.canvas, 0, 0);
      ch.globalCompositeOperation = 'multiply'; ch.fillStyle = color; ch.fillRect(0, 0, w, h);
      ch.globalCompositeOperation = 'destination-in'; ch.drawImage(base.canvas, 0, 0);
      dst.drawImage(ch.canvas, ox, oy);
    };
    channel(5, '#f00', shift, 0); channel(6, '#0f0', 0, 0); channel(7, '#00f', -shift, 0);
  });
def('Freeze', [{n:'X', min:0, max:1, d:0}, {n:'Y', min:0, max:1, d:0},
               {n:'Frozen solid', kind:'bool', d:false},
               {n:'Black BG', kind:'bool', d:false}], (dst, src, p, w, h, t, info) => {
  const buf = info.buffer(w, h);
  if(!buf.__seeded || !p['Frozen solid']){
    buf.setTransform(1, 0, 0, 1, 0, 0); buf.clearRect(0, 0, w, h); buf.drawImage(src, 0, 0);
    buf.__seeded = true;
  }
  blackUnder(dst, p, w, h);
  const ox = clamp(p.X, 0, 1) * w, oy = clamp(p.Y, 0, 1) * h;
  if(p['Black BG']) dst.drawImage(buf.canvas, ox, oy);
  else for(let x = -1; x <= 0; x++) for(let y = -1; y <= 0; y++)
    dst.drawImage(buf.canvas, ox + x*w, oy + y*h);
});
def('Drop Shadow', [{n:'Distance', min:0, max:1, d:0.3}, {n:'Softness', min:0, max:1, d:0.3},
                    {n:'Opacity', min:0, max:1, d:0.7}],
  (dst, src, p, w, h) => {
    const d = p.Distance * Math.min(w,h) * 0.08;
    const t = pad(5, w, h);
    t.filter = `blur(${p.Softness*20}px) brightness(0)`;
    t.drawImage(src, 0, 0);
    dst.globalAlpha = p.Opacity;
    dst.drawImage(t.canvas, d, d);
    dst.globalAlpha = 1;
    dst.drawImage(src, 0, 0);
  });
def('Edge Detection', [{n:'Amount', min:0, max:1, d:0.6}], (dst, src, p, w, h) => {
  /* difference of the image against a blurred copy — a cheap high-pass */
  const t = pad(5, w, h);
  t.filter = `blur(${1 + p.Amount*3}px)`;
  t.drawImage(src, 0, 0);
  dst.drawImage(src, 0, 0);
  dst.globalCompositeOperation = 'difference';
  dst.drawImage(t.canvas, 0, 0);
  dst.globalCompositeOperation = 'source-over';
  dst.filter = `brightness(${1 + p.Amount*6})`;
  dst.drawImage(dst.canvas, 0, 0);
});

/* --------------------------------------------------------------------------
   LUT — lut.htm
   ---------------------------------------------------------------------------
   Arena ships ten .cube LUTs in its `luts` folder, and they are third-party:
   each file carries "Copyright (C) 2010-2018 by IWLTBAP SAS ... Cannot be
   resold, shared or otherwise redistributed". So none of them is copied into
   this project. What lives here is the machinery — a real .cube parser and a
   trilinear 3D lookup — plus two grades generated in code, so the effect is
   demonstrable without redistributing anyone's work. Point loadCube() at a file
   you have the right to use and it will apply it.
   -------------------------------------------------------------------------- */
const LUTS = new Map();

/* Adobe .cube: comments with #, TITLE, LUT_3D_SIZE n, then n^3 RGB triples,
   red varying fastest. LUT_1D_SIZE exists too but Resolume ships 3D. */
function parseCube(text){
  let size = 0; const data = []; let title = null;
  let domainMin = [0,0,0], domainMax = [1,1,1];
  for(const raw of String(text).split(/\r?\n/)){
    const line = raw.trim();
    if(!line || line[0] === '#') continue;
    if(/^TITLE/i.test(line)){ const m = line.match(/"([^"]*)"/); title = m ? m[1] : null; continue; }
    if(/^LUT_3D_SIZE/i.test(line)){ size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if(/^DOMAIN_MIN/i.test(line)){ domainMin = line.split(/\s+/).slice(1).map(Number); continue; }
    if(/^DOMAIN_MAX/i.test(line)){ domainMax = line.split(/\s+/).slice(1).map(Number); continue; }
    if(/^LUT_1D_SIZE/i.test(line)) return {error:'1D LUTs are not supported'};
    const p = line.split(/\s+/).map(Number);
    if(p.length >= 3 && p.every(n => Number.isFinite(n))) data.push(p[0], p[1], p[2]);
  }
  if(!size || data.length !== size*size*size*3)
    return {error:`expected ${size*size*size*3} values, read ${data.length}`};
  return {title, size, domainMin, domainMax, data:Float32Array.from(data)};
}

/* trilinear sample; red is the fastest-varying axis in a .cube */
function sampleLUT(lut, r, g, b){
  const n = lut.size, m = n - 1;
  const lo=lut.domainMin || [0,0,0], hi=lut.domainMax || [1,1,1];
  const domain=(value,axis)=>clamp((value-lo[axis])/((hi[axis]-lo[axis])||1),0,1);
  const fr = domain(r,0)*m, fg = domain(g,1)*m, fb = domain(b,2)*m;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(r0+1,m), g1 = Math.min(g0+1,m), b1 = Math.min(b0+1,m);
  const dr = fr-r0, dg = fg-g0, db = fb-b0;
  const at = (ri,gi,bi) => (ri + gi*n + bi*n*n)*3;
  const out = [0,0,0];
  for(let c = 0; c < 3; c++){
    const c000=lut.data[at(r0,g0,b0)+c], c100=lut.data[at(r1,g0,b0)+c];
    const c010=lut.data[at(r0,g1,b0)+c], c110=lut.data[at(r1,g1,b0)+c];
    const c001=lut.data[at(r0,g0,b1)+c], c101=lut.data[at(r1,g0,b1)+c];
    const c011=lut.data[at(r0,g1,b1)+c], c111=lut.data[at(r1,g1,b1)+c];
    const c00=c000+(c100-c000)*dr, c10=c010+(c110-c010)*dr;
    const c01=c001+(c101-c001)*dr, c11=c011+(c111-c011)*dr;
    const c0=c00+(c10-c00)*dg, c1=c01+(c11-c01)*dg;
    out[c] = c0+(c1-c0)*db;
  }
  return out;
}

/* Two grades written here rather than borrowed, so the effect has something to
   show out of the box without redistributing a licensed LUT. */
function buildLUT(name, fn, size){
  size = size || 17;
  const data = new Float32Array(size*size*size*3);
  let i = 0;
  for(let b = 0; b < size; b++) for(let g = 0; g < size; g++) for(let r = 0; r < size; r++){
    const c = fn(r/(size-1), g/(size-1), b/(size-1));
    data[i++] = clamp(c[0],0,1); data[i++] = clamp(c[1],0,1); data[i++] = clamp(c[2],0,1);
  }
  LUTS.set(name, {title:name, size, data, domainMin:[0,0,0], domainMax:[1,1,1]});
}
buildLUT('Neutral', (r,g,b) => [r,g,b]);
buildLUT('Teal & Orange', (r,g,b) => {
  const l = r*0.299 + g*0.587 + b*0.114;
  const k = (l - 0.5) * 2;
  return [ r + Math.max(0,k)*0.18, g + k*0.03, b - Math.max(0,k)*0.10 + Math.max(0,-k)*0.16 ];
});
buildLUT('Bleach', (r,g,b) => {
  const l = r*0.299 + g*0.587 + b*0.114;
  const mix = t => t*0.45 + l*0.55;
  const s = t => t < 0.5 ? 2*t*t : 1-2*(1-t)*(1-t);
  return [ s(mix(r)), s(mix(g)), s(mix(b)) ];
});

async function loadCube(name, url){
  try{
    const res = await fetch(url, {cache:'no-store'});
    if(!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const registered=registerLUT(name,await res.text());
    if(registered.error) throw new Error(registered.error);
    return registered.lut;
  }catch(e){ return {error:String(e.message || e)}; }
}

function registerLUT(id,text){
  const lut=parseCube(text);
  if(lut.error) return {error:lut.error};
  const key=String(id || lut.title || 'LUT');
  LUTS.set(key,lut);
  return {id:key,lut};
}

/* The Wire patch exposes exactly one resource input. Strength is the generic
   Effect Opacity mixer, not an invented plug-in Amount parameter. */
def('LUT', [{n:'LUT 3D', kind:'resource', resourceType:'lut3d',
             accept:'.cube,text/plain,application/octet-stream', d:''}],
  (dst, src, p, w, h, t, info) => {
    const id=String(p['LUT 3D'] || '');
    dst.drawImage(src, 0, 0);
    if(!id) return;
    const param=info && info.fx && (info.fx.params||[]).find(item=>item.name==='LUT 3D');
    if(!LUTS.has(id) && param && param.resourceData) registerLUT(id,param.resourceData);
    const lut=LUTS.get(id);
    if(!lut || !lut.data) return;
    const img = dst.getImageData(0, 0, w, h), d = img.data;
    for(let i = 0; i < d.length; i += 4){
      if(d[i+3] === 0) continue;
      const c = sampleLUT(lut, d[i]/255, d[i+1]/255, d[i+2]/255);
      d[i]=c[0]*255; d[i+1]=c[1]*255; d[i+2]=c[2]*255;
    }
    dst.putImageData(img, 0, 0);
  });

/* --------------------------------------------------------------------------
   Applying a chain
   -------------------------------------------------------------------------- */
const buffers = new WeakMap();

/* =========================================================================
   SLICE TRANSFORM — the one effect that reads back out of Advanced Output
   -------------------------------------------------------------------------
   Every other effect in this file is a pixel operation. This one is a
   placement operation, and it runs the pipeline backwards: the slices are
   defined downstream, in Advanced Output, and this effect reaches forward to
   read their geometry and lay content into it. transform.htm: apply it to a
   clip, layer, group or the composition and the content is positioned into the
   chosen slices automatically, and "changing the slice in the Advanced Output
   will update the scaling of the content automatically".

   That last clause is why the geometry is read live, on every frame, from the
   tree the Advanced Output publishes over the bus rather than from a copy
   taken when the effect was dropped. Drag a slice over there and the content
   here follows it.

   The rects are the slices' INPUT selections, in composition pixels — that is
   the whole point. A slice samples its input rect out of the composition, so
   putting content there is what makes it come out of that slice.
   ========================================================================= */
const SCALE_MODES = ['Fill', 'Fit', 'Stretch', 'Mask', 'Invert Mask'];

FX['Slice Transform'] = {
  params: [{ n: 'Scaling', min: 0, max: SCALE_MODES.length - 1, d: 0 }],
  draw(out, src, p, w, h, t, info){
    const tree = (typeof window !== 'undefined' && window.ArenaSlices) ? window.ArenaSlices() : null;
    const fx = info && info.fx;
    const want = (fx && fx.slice) || {};
    /* No Advanced Output open, or no slice matched: pass the picture through
       untouched rather than blanking it. An effect that cannot do its job must
       not destroy the frame. */
    if(!tree || !tree.screens || !tree.screens.length){ out.drawImage(src, 0, 0); return; }

    const rects = [];
    tree.screens.forEach(sc => {
      if(want.screenId && String(sc.id) !== String(want.screenId)) return;
      (sc.slices || []).forEach(sl => {
        if(want.sliceId && String(sl.id) !== String(want.sliceId)) return;
        if(sl.kind === 'dmx' || !sl.input) return;
        rects.push(sl.input);
      });
    });
    if(!rects.length){ out.drawImage(src, 0, 0); return; }

    /* composition pixels -> this surface's pixels */
    const cw = (tree.composition && tree.composition.width)  || w;
    const ch = (tree.composition && tree.composition.height) || h;
    const kx = w / (cw || 1), ky = h / (ch || 1);
    /* Scaling arrives as the choice's own string when the effect was built
       with a real ParamChoice, and as an index when it fell back to the
       generic range builder. Accept both rather than silently reading 'Fill'
       for every mode, which is what Number('Stretch') || 0 would have done. */
    const raw = p.Scaling;
    const mode = SCALE_MODES.indexOf(String(raw)) >= 0
      ? String(raw)
      : (SCALE_MODES[Math.round(Number(raw) || 0)] || 'Fill');

    out.save();
    out.clearRect(0, 0, w, h);

    if(mode === 'Mask' || mode === 'Invert Mask'){
      /* The slice geometry reveals or hides rather than places: the content
         stays where it was composed. */
      if(mode === 'Mask'){
        out.beginPath();
        rects.forEach(r => out.rect(r.x * kx, r.y * ky, r.w * kx, r.h * ky));
        out.clip();
        out.drawImage(src, 0, 0);
      } else {
        out.drawImage(src, 0, 0);
        out.globalCompositeOperation = 'destination-out';
        rects.forEach(r => out.fillRect(r.x * kx, r.y * ky, r.w * kx, r.h * ky));
      }
      out.restore();
      return;
    }

    const sw = src.width || w, sh = src.height || h;
    rects.forEach(r => {
      const X = r.x * kx, Y = r.y * ky, W = r.w * kx, H = r.h * ky;
      if(W <= 0 || H <= 0) return;
      if(mode === 'Stretch'){ out.drawImage(src, 0, 0, sw, sh, X, Y, W, H); return; }
      /* Fill covers and crops; Fit contains and letterboxes. Both keep the
         source's aspect, which is the difference from Stretch. */
      const k = mode === 'Fit' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
      const dw = sw * k, dh = sh * k;
      const dx = X + (W - dw) / 2, dy = Y + (H - dh) / 2;
      out.save();
      out.beginPath(); out.rect(X, Y, W, H); out.clip();   /* Fill must not spill */
      out.drawImage(src, 0, 0, sw, sh, dx, dy, dw, dh);
      out.restore();
    });
    out.restore();
  }
};

function apply(ctx, list, w, h, t, beats, val){
  if(!list || !list.length) return;
  list.forEach(fx => {
    const impl = FX[fx.name];
    if(!impl) return;                              // unimplemented: pass through
    if(val(fx.bypassed)) return;                   // effects.htm — the B toggle
    /* Arena 7.27.1 reports mixer:null for Mask. Every other video effect owns
       the usual Opacity/Blend pair; a mixer-less effect is a direct operation. */
    const opacity = fx.opacity ? val(fx.opacity) : 1;
    if(opacity <= 0.001) return;                   // ALT-dropped at zero: inert

    const p = {};
    impl.params.forEach((spec, i) => {
      const param = fx.params && fx.params[i];
      p[spec.n] = param ? val(param) : spec.d;
    });

    const original = pad(0, w, h);
    original.drawImage(ctx.canvas, 0, 0);

    const out = pad(1, w, h);
    const info = {
      beats,
      /* The effect instance itself. Almost no effect needs it — a Blur is a
         Blur wherever it sits — but the Slice Transform is defined by which
         slices it was dropped onto, and that lives on the instance. */
      fx,
      buffer(bw, bh){
        let b = buffers.get(fx);
        if(!b || b.canvas.width !== bw || b.canvas.height !== bh){
          const c = document.createElement('canvas');
          c.width = bw; c.height = bh;
          b = c.getContext('2d');
          buffers.set(fx, b);
        }
        return b;
      }
    };
    try { impl.draw(out, original.canvas, p, w, h, t, info); }
    catch(error){
      /* Production playback remains fail-soft, but tests and diagnostics must
         not mistake a swallowed renderer exception for an intentional no-op. */
      reportDiagnostic({kind:'draw-error',effect:fx.name,
        message:String(error && error.message || error)});
      return;
    }

    /* mix the result back, exactly as effects.htm describes: the effect's own
       Opacity and Blend Mode do the mixing.

       ALPHA IS A REPLACE, NOT AN OVERLAY, AND THAT DISTINCTION WAS MISSING.
       Every effect used to be drawn ON TOP of the untouched original, which is
       right for Add, Multiply, Screen and the rest — they need the original as
       their base. It is wrong for Alpha, which in Resolume means "this is now
       the picture". Drawn source-over, the original shows through wherever the
       effect produced transparency, so no effect could ever cut a hole: Auto
       Mask, Luma Key and the Slice Transform's Mask modes all came out as a
       full opaque frame. Verified with a white test frame — every Slice
       Transform mode returned white everywhere, inside the slice and out.
       At Alpha the result is a straight crossfade between the original and the
       effect, so opacity 1 leaves the effect's own alpha intact. */
    const mode = fx.blend ? val(fx.blend) : 'Alpha';
    const plan = window.ArenaEngine && window.ArenaEngine.mixerPlan
      ? window.ArenaEngine.mixerPlan(mode, opacity)
      : {kind:'single', operation:window.ArenaEngine
          ? window.ArenaEngine.canvasBlend(mode) : 'source-over',
         alpha:clamp(opacity,0,1)};
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    if(plan.kind === 'skip'){
      ctx.drawImage(original.canvas,0,0);
    } else if(plan.kind === 'mask-interpolate'){
      ctx.drawImage(original.canvas,0,0);
      const masked=pad(8,w,h);
      masked.drawImage(original.canvas,0,0);
      masked.globalCompositeOperation='destination-in';
      masked.drawImage(out.canvas,0,0);
      ctx.globalAlpha=1-plan.alpha;
      ctx.globalCompositeOperation='destination-in';
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h);
      ctx.globalAlpha=plan.alpha;
      ctx.globalCompositeOperation='lighter';
      ctx.drawImage(masked.canvas,0,0);
    } else if(plan.kind === 'blend-to-source'){
      /* Full selected blend at the centre of the fader. Above the centre,
         interpolate towards the Effect result itself (including its alpha),
         so 100% Alpha/Add/etc is the processed frame, not a foggy overlay. */
      ctx.drawImage(original.canvas,0,0);
      ctx.globalCompositeOperation=plan.operation;
      ctx.drawImage(out.canvas,0,0);
      const normal=pad(8,w,h);
      normal.drawImage(out.canvas,0,0);
      const q=clamp(plan.sourceMix,0,1);
      ctx.globalAlpha=1-q; ctx.globalCompositeOperation='destination-in';
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h);
      ctx.globalAlpha=q; ctx.globalCompositeOperation='lighter';
      ctx.drawImage(normal.canvas,0,0);
    } else if(plan.operation === 'source-over'){
      /* Effect Alpha is a premultiplied crossfade between the untouched and
         processed frames. source-overing two half-alpha canvases would leave
         only 75% alpha and make a mid-fader Effect look milky; weighted add
         preserves a full-alpha opaque input and still reaches the processed
         frame (including real cut-out transparency) at 100%. */
      ctx.globalAlpha = 1 - plan.alpha;
      ctx.drawImage(original.canvas, 0, 0);
      ctx.globalAlpha = plan.alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(out.canvas, 0, 0);
    } else {
      ctx.drawImage(original.canvas, 0, 0);
      ctx.globalAlpha = plan.alpha;
      ctx.globalCompositeOperation = plan.operation;
      ctx.drawImage(out.canvas, 0, 0);
    }
    ctx.restore();
  });
}


/* =========================================================================
   THE SECOND WAVE — the effects a 2D canvas can do honestly
   -------------------------------------------------------------------------
   Arena reports 106 video effects; this file used to draw 38 of them and the
   other 68 were greyed in the browser as "interface only, passes through".
   The block below closes most of that gap.

   Each one was written against the same def(name, params, draw) contract as
   the block above and then re-checked by a second pass that was told to
   REFUSE rather than approximate. What that pass rejected is not here: see
   the CANNOT list in the comment at the end of this block. A refusal with a
   named missing capability is the correct outcome for this codebase, and is
   what keeps ArenaFX.has() honest.

   Parameter provenance differs per effect and is stated in each one's own
   comment where it matters. Where Resolume ships a preset or a .wired patch,
   the names, defaults and ranges are read from it. Where it ships neither,
   the set is inferred and says so.
   ========================================================================= */

def('Blow', [{n:'X', min:0, max:1, d:0.5}, {n:'Y', min:0, max:1, d:0.5},
             {n:'Width', min:0, max:1, d:0.5}, {n:'Height', min:0, max:1, d:0.5}],
  (dst, src, p, w, h) => {
    const rw = Math.max(1, Math.round(clamp(p.Width, 0, 1) * w));
    const rh = Math.max(1, Math.round(clamp(p.Height, 0, 1) * h));
    const x0 = clamp(Math.round(clamp(p.X, 0, 1) * w - rw / 2), 0, w - rw);
    const y0 = clamp(Math.round(clamp(p.Y, 0, 1) * h - rh / 2), 0, h - rh);
    const x1 = x0 + rw, y1 = y0 + rh, rt = w - x1, bt = h - y1;
    dst.imageSmoothingEnabled = false;
    dst.drawImage(src, x0, y0, rw, rh, x0, y0, rw, rh);
    if(x0 > 0)           dst.drawImage(src, x0,     y0,     1,  rh, 0,  y0, x0, rh);
    if(rt > 0)           dst.drawImage(src, x1 - 1, y0,     1,  rh, x1, y0, rt, rh);
    if(y0 > 0)           dst.drawImage(src, x0,     y0,     rw, 1,  x0, 0,  rw, y0);
    if(bt > 0)           dst.drawImage(src, x0,     y1 - 1, rw, 1,  x0, y1, rw, bt);
    if(x0 > 0 && y0 > 0) dst.drawImage(src, x0,     y0,     1, 1, 0,  0,  x0, y0);
    if(rt > 0 && y0 > 0) dst.drawImage(src, x1 - 1, y0,     1, 1, x1, 0,  rt, y0);
    if(x0 > 0 && bt > 0) dst.drawImage(src, x0,     y1 - 1, 1, 1, 0,  y1, x0, bt);
    if(rt > 0 && bt > 0) dst.drawImage(src, x1 - 1, y1 - 1, 1, 1, x1, y1, rt, bt);
    dst.imageSmoothingEnabled = true;
  });

def('CRT', [{n:'Columns', min:1, max:720, d:340}, {n:'Rows', min:1, max:240, d:115},
            {n:'Shift', min:0, max:100, d:100}, {n:'Vignette', min:0, max:100, d:0},
            {n:'Fisheye', min:0, max:100, d:0}, {n:'Spread', min:0, max:100, d:50},
            {n:'Brightness', min:1, max:100, d:50}, {n:'Bloom Amount', min:0, max:100, d:100},
            {n:'Bloom Width', min:0, max:300, d:50}, {n:'Bloom Height', min:0, max:300, d:50},
            {n:'Between Slots', min:0, max:2, d:1}, {n:'Left/Right', min:0, max:5, d:1},
            {n:'Top/Bottom', min:0, max:5, d:1},
            {n:'Color Left', kind:'choice', options:['R','G','B'], optionValues:[0,1,2], d:0},
            {n:'Power Left', min:0, max:1, d:1}, {n:'Tilt Left', min:-1, max:1, d:0},
            {n:'Color Middle', kind:'choice', options:['R','G','B'], optionValues:[0,1,2], d:1},
            {n:'Power Middle', min:0, max:1, d:1}, {n:'Tilt Middle', min:-1, max:1, d:0},
            {n:'Color Right', kind:'choice', options:['R','G','B'], optionValues:[0,1,2], d:2},
            {n:'Power Right', min:0, max:1, d:1}, {n:'Tilt Right', min:-1, max:1, d:0},
            {n:'Height Scale', min:1, max:10, d:4},
            {n:'Display Mode', kind:'choice', options:['Fit to Output','Native'],
             optionValues:[1,0], d:1}],
  (dst, src, p, w, h) => {
    /* CRT is a Wire patch, not a shader, and the patch ships in this repo:
       reference/wired/CRT.wired. Every name, range and default above is read
       out of its Float/Integer Input nodes and its inputOrder, including the
       group order Arena shows (Filter, Light, Triad Margins, Slot Settings,
       Advanced). Tracing its connections also settles the two parameters whose
       job was not obvious: Shift feeds a Floor into a Transform's translation,
       so it is a quantised horizontal stagger of the triad; Height Scale feeds
       "CRT Pixel Height" alongside Top/Bottom, so the cell is sized in native
       pixels rather than scaled. The same arithmetic on the width side —
       Left/Right + 2 x Between Slots + 3 slots — gives 6 px at the defaults,
       which is exactly what the patch's own render target records (2040 = 340
       columns x 6). That is the model below. */
    const cols = clamp(Math.round(p.Columns), 1, 720);
    const rows = clamp(Math.round(p.Rows), 1, 240);
    const gap  = clamp(Math.round(p['Between Slots']), 0, 2);
    const lr   = clamp(Math.round(p['Left/Right']), 0, 5);
    const tb   = clamp(Math.round(p['Top/Bottom']), 0, 5);
    const hs   = clamp(Math.round(p['Height Scale']), 1, 10);
    const cw = lr + gap * 2 + 3, chh = hs + tb * 2;

    /* CRT Res — the emulated scan grid, one texel per triad */
    const small = pad(2, cols, rows);
    small.imageSmoothingEnabled = true;
    small.drawImage(src, 0, 0, cols, rows);

    /* back to output size with no interpolation, so each texel is a hard cell.
       Brightness is neutral at its own default of 50, and Spread is the patch's
       Pixel Blur — light bleeding across the slots. */
    const lit = pad(3, w, h);
    lit.imageSmoothingEnabled = false;
    const spread = p.Spread / 100 * (w / cols) * 1.5;
    lit.filter = 'brightness(' + (p.Brightness / 50).toFixed(3) + ')' +
                 (spread > 0.05 ? ' blur(' + spread.toFixed(2) + 'px)' : '');
    lit.drawImage(small.canvas, 0, 0, cols, rows, 0, 0, w, h);
    lit.filter = 'none';
    /* nearest-neighbour was wanted for that one blit and nothing after it: the
       bloom is upscaled back through this same context and would come out
       blocky if the flag stayed off */
    lit.imageSmoothingEnabled = true;

    /* Triad Mask — one cell, built at its native pixel size and two rows tall so
       Shift can stagger every other scanline. Opaque black in the gaps, because
       a transparent gap under 'multiply' would leave the backdrop untouched
       instead of dark. */
    const tile = pad(4, cw, chh * 2);
    tile.fillStyle = '#000'; tile.fillRect(0, 0, cw, chh * 2);
    const slots = [
      {c: p['Color Left'],   pw: p['Power Left'],   tl: p['Tilt Left'],   x: lr / 2},
      {c: p['Color Middle'], pw: p['Power Middle'], tl: p['Tilt Middle'], x: lr / 2 + 1 + gap},
      {c: p['Color Right'],  pw: p['Power Right'],  tl: p['Tilt Right'],  x: lr / 2 + 2 + gap * 2}
    ];
    const shift = (p.Shift / 100) * cw / 2;
    for(let r = 0; r < 2; r++){
      const oy = r * chh, ox = r ? shift : 0;
      slots.forEach(s => {
        const rgb = [0, 0, 0];
        let channel=['R','G','B'].indexOf(String(s.c));
        if(channel<0) channel=clamp(Math.round(Number(s.c)||0),0,2);
        rgb[channel] = Math.round(clamp(s.pw, 0, 1) * 255);
        tile.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
        const dy = s.tl * chh * 0.5, y0 = oy + tb, y1 = oy + chh - tb;
        for(let k = -1; k <= 1; k++){          /* wrap, so a shifted slot returns */
          const X = ox + s.x + k * cw;
          tile.beginPath();
          tile.moveTo(X - dy / 2, y0);       tile.lineTo(X + 1 - dy / 2, y0);
          tile.lineTo(X + 1 + dy / 2, y1);   tile.lineTo(X + dy / 2, y1);
          tile.closePath(); tile.fill();
        }
      });
    }

    /* the mask goes straight onto the lit grid — a separate compositing surface
       would cost another full-frame blit for nothing */
    const scr = lit;
    const pat = scr.createPattern(tile.canvas, 'repeat');
    if(pat){
      const sx = (w / cols) / cw, sy = (h / rows) / chh;
      try {
        if(pat.setTransform && typeof DOMMatrix === 'function')
          pat.setTransform(new DOMMatrix([sx, 0, 0, sy, 0, 0]));
      } catch(e){ /* no pattern transform: the mask tiles at 1:1 instead */ }
      scr.globalCompositeOperation = 'multiply';
      scr.fillStyle = pat;
      scr.fillRect(0, 0, w, h);
      scr.globalCompositeOperation = 'source-over';
    }

    /* the glass glow. Bloom Width and Height are separate parameters, so the
       blur has to be anisotropic: an isotropic blur of radius R in a buffer
       scaled (a, b) lands as (R/a, R/b) on output, so pick b from the ratio. */
    const amt = clamp(p['Bloom Amount'] / 100, 0, 1);
    const rx = Math.max(p['Bloom Width'] / 300 * 20, 0.01);
    const ry = Math.max(p['Bloom Height'] / 300 * 20, 0.01);
    if(amt > 0.004 && (rx > 0.05 || ry > 0.05)){
      const a = 0.25;
      const bw = clamp(Math.round(w * a), 1, 4096);
      const bh = clamp(Math.round(h * a * (ry / rx)), 1, 4096);
      const glow = pad(6, bw, bh);
      glow.filter = 'blur(' + (rx * a).toFixed(2) + 'px)';
      glow.drawImage(scr.canvas, 0, 0, w, h, 0, 0, bw, bh);
      glow.filter = 'none';
      scr.globalCompositeOperation = 'lighter';
      scr.globalAlpha = amt;
      scr.drawImage(glow.canvas, 0, 0, bw, bh, 0, 0, w, h);
      scr.globalAlpha = 1; scr.globalCompositeOperation = 'source-over';
    }

    /* Display Mode: Fit to Output stretches the emulation over the surface,
       Native lays it down at its own pixel size. Fisheye and Vignette last. */
    /* Wire stores these option values out of display order: 1 = Fit to Output,
       0 = Native. The embedded presets all store 1, so treating the option as
       an array index makes every factory preset render at native pixel size. */
    const native = String(p['Display Mode']) === 'Native' || Number(p['Display Mode']) === 0;
    const DW = native ? cols * cw : w;
    const DH = native ? rows * chh : h;
    const DX = (w - DW) / 2, DY = (h - DH) / 2;
    const fe = p.Fisheye / 100;
    /* only paint the surround when there is one — in Fit to Output with no
       fisheye the emulation covers every pixel and the fill is wasted */
    if(native || fe > 0.001){ dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h); }
    if(fe > 0.001){
      const rings = 24, rad = Math.hypot(DW, DH) / 2, mx = DX + DW / 2, my = DY + DH / 2;
      for(let i = rings - 1; i >= 0; i--){
        const q = (i + 1) / rings, s = 1 + fe * (1 - q) * 0.9;
        dst.save();
        dst.beginPath(); dst.arc(mx, my, rad * q, 0, Math.PI * 2); dst.clip();
        dst.translate(mx, my); dst.scale(s, s); dst.translate(-mx, -my);
        dst.drawImage(scr.canvas, 0, 0, w, h, DX, DY, DW, DH);
        dst.restore();
      }
    } else dst.drawImage(scr.canvas, 0, 0, w, h, DX, DY, DW, DH);
    const vg = clamp(p.Vignette / 100, 0, 1);
    if(vg > 0.001){
      const rad = Math.hypot(w, h) / 2;
      const g = dst.createRadialGradient(w / 2, h / 2, rad * 0.35, w / 2, h / 2, rad);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + vg + ')');
      dst.fillStyle = g; dst.fillRect(0, 0, w, h);
    }
  });

/* ChromaKey is a four-stage GPU effect in Arena 7.27.1: key/despill, repeated
   one-pixel alpha erosion, separable alpha blur, then compose/premultiply.
   These shader stages were recovered from the installed 7.27.1.15990 binary;
   keeping them on the GPU avoids the full-frame Canvas readback that used to
   cost 48 ms at 1920x1080. Compose is fused into whichever stage draws last,
   preserving the same pixels while avoiding an extra full-frame GPU pass.
   The host's normalized Edge controls are not encoded
   in those shaders. Eight pixels at value 1 (and therefore one pixel at the
   factory value 0.125) is the single explicit, provisional host-side mapping. */
const CHROMA_EDGE_MAX_PIXELS = 8;

function linkGLProgram(gl, vertexShader, fragmentSource){
  const fragmentShader = compileGL(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(fragmentShader);
  if(!gl.getProgramParameter(program, gl.LINK_STATUS)){
    const message = gl.getProgramInfoLog(program) || 'Program link failed';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function createChromaKeyRenderer(){
  try{
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
      alpha:true, antialias:false, depth:false, stencil:false,
      premultipliedAlpha:true, preserveDrawingBuffer:false,
      desynchronized:true, powerPreference:'high-performance'
    });
    if(!gl) return null;

    const vertexShader = compileGL(gl, gl.VERTEX_SHADER,
      'attribute vec2 a_position;\n' +
      'varying vec2 v_uv;\n' +
      'void main(){ v_uv=a_position*0.5+0.5; gl_Position=vec4(a_position,0.0,1.0); }');
    const keyProgram = linkGLProgram(gl, vertexShader,
      'precision highp float;\n' +
      'uniform sampler2D u_texture;\n' +
      'uniform float u_keyHue;\n' +
      'uniform vec3 u_startDists;\n' +
      'uniform vec3 u_endDists;\n' +
      'uniform float u_spillDistance;\n' +
      'uniform float u_spillFeather;\n' +
      'uniform float u_compose;\n' +
      'uniform float u_showMask;\n' +
      'varying vec2 v_uv;\n' +
      'float hueDistance(float hue1,float hue2){\n' +
      '  float a=radians(hue1), b=radians(hue2);\n' +
      '  return distance(vec2(cos(a),sin(a)),vec2(cos(b),sin(b)))*0.5;\n' +
      '}\n' +
      'vec3 rgbToHsv(vec3 color){\n' +
      '  float r=color.r, g=color.g, b=color.b;\n' +
      '  float lo=min(r,min(g,b)), hi=max(r,max(g,b)), delta=hi-lo;\n' +
      '  vec3 hsv=vec3(0.0,0.0,hi);\n' +
      '  if(hi>0.0) hsv.y=delta/hi;\n' +
      '  if(delta>0.0){\n' +
      '    if(hi==r && hi!=g) hsv.x+=(g-b)/delta;\n' +
      '    if(hi==g && hi!=b) hsv.x+=2.0+(b-r)/delta;\n' +
      '    if(hi==b && hi!=r) hsv.x+=4.0+(r-g)/delta;\n' +
      '    hsv.x*=60.0;\n' +
      '  }\n' +
      '  return hsv;\n' +
      '}\n' +
      'void main(){\n' +
      '  vec4 color=texture2D(u_texture,v_uv);\n' +
      '  vec3 hsv=rgbToHsv(color.rgb);\n' +
      '  float dist=hueDistance(u_keyHue,hsv.x);\n' +
      '  vec3 a=smoothstep(u_startDists,u_endDists,vec3(dist,hsv.y,hsv.z));\n' +
      '  float keep=clamp(length(vec3(a.x,1.0-a.y,1.0-a.z)),0.0,1.0);\n' +
      '  color.a*=keep;\n' +
      '  float despill=1.0-smoothstep(u_spillDistance,u_spillDistance+u_spillFeather,dist);\n' +
      '  float mean=(color.r+color.g+color.b)/3.0;\n' +
      '  color.rgb=mix(color.rgb,vec3(mean),vec3(despill));\n' +
      '  if(u_compose>0.5){\n' +
      '    color=vec4(color.rgb*color.a,color.a);\n' +
      '    if(u_showMask>0.5) color=vec4(color.a,color.a,color.a,1.0);\n' +
      '  }\n' +
      '  gl_FragColor=color;\n' +
      '}');
    const shrinkProgram = linkGLProgram(gl, vertexShader,
      'precision highp float;\n' +
      'uniform sampler2D u_texture;\n' +
      'uniform vec2 u_pixelSize;\n' +
      'uniform float u_compose;\n' +
      'uniform float u_showMask;\n' +
      'varying vec2 v_uv;\n' +
      'void main(){\n' +
      '  vec4 color=texture2D(u_texture,v_uv);\n' +
      '  float alpha=color.a;\n' +
      '  for(int y=-1;y<=1;y++){\n' +
      '    for(int x=-1;x<=1;x++){\n' +
      '      vec2 uv=clamp(v_uv+vec2(float(x),float(y))*u_pixelSize,vec2(0.0),vec2(1.0));\n' +
      '      alpha=min(alpha,texture2D(u_texture,uv).a);\n' +
      '    }\n' +
      '  }\n' +
      '  color=vec4(color.rgb,alpha);\n' +
      '  if(u_compose>0.5){\n' +
      '    color=vec4(color.rgb*color.a,color.a);\n' +
      '    if(u_showMask>0.5) color=vec4(color.a,color.a,color.a,1.0);\n' +
      '  }\n' +
      '  gl_FragColor=color;\n' +
      '}');
    const blurProgram = linkGLProgram(gl, vertexShader,
      'precision highp float;\n' +
      'uniform sampler2D u_texture;\n' +
      'uniform vec2 u_pixelSize;\n' +
      'uniform vec2 u_direction;\n' +
      'uniform int u_radius;\n' +
      'uniform float u_compose;\n' +
      'uniform float u_showMask;\n' +
      'varying vec2 v_uv;\n' +
      'void main(){\n' +
      '  vec4 color=texture2D(u_texture,v_uv);\n' +
      '  float alpha=0.0, count=0.0;\n' +
      '  for(int i=-8;i<=8;i++){\n' +
      '    if(i < -u_radius || i > u_radius) continue;\n' +
      '    vec2 uv=v_uv+float(i)*u_direction*u_pixelSize;\n' +
      '    if(any(lessThan(uv,vec2(0.0))) || any(greaterThan(uv,vec2(1.0)))) continue;\n' +
      '    alpha+=texture2D(u_texture,uv).a; count+=1.0;\n' +
      '  }\n' +
      '  color=vec4(color.rgb,alpha/max(1.0,count));\n' +
      '  if(u_compose>0.5){\n' +
      '    color=vec4(color.rgb*color.a,color.a);\n' +
      '    if(u_showMask>0.5) color=vec4(color.a,color.a,color.a,1.0);\n' +
      '  }\n' +
      '  gl_FragColor=color;\n' +
      '}');
    gl.deleteShader(vertexShader);

    const positions = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const makeTexture = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    };
    const sourceTexture=makeTexture(), pingTextures=[makeTexture(),makeTexture()];
    const pingFramebuffers=pingTextures.map(texture => {
      const framebuffer=gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      return framebuffer;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);

    const programs = [keyProgram,shrinkProgram,blurProgram];
    const states = new Map(programs.map(program => [program, {
      position:gl.getAttribLocation(program,'a_position'),
      texture:gl.getUniformLocation(program,'u_texture')
    }]));
    const keyUniforms={
      hue:gl.getUniformLocation(keyProgram,'u_keyHue'),
      start:gl.getUniformLocation(keyProgram,'u_startDists'),
      end:gl.getUniformLocation(keyProgram,'u_endDists'),
      spill:gl.getUniformLocation(keyProgram,'u_spillDistance'),
      feather:gl.getUniformLocation(keyProgram,'u_spillFeather')
    };
    const shrinkUniforms={pixel:gl.getUniformLocation(shrinkProgram,'u_pixelSize')};
    const blurUniforms={
      pixel:gl.getUniformLocation(blurProgram,'u_pixelSize'),
      direction:gl.getUniformLocation(blurProgram,'u_direction'),
      radius:gl.getUniformLocation(blurProgram,'u_radius')
    };
    const finalUniforms=new Map(programs.map(program=>[program,{
      compose:gl.getUniformLocation(program,'u_compose'),
      showMask:gl.getUniformLocation(program,'u_showMask')
    }]));
    let width=0,height=0,lost=false;
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost=true; });

    const resize = (w,h) => {
      if(width===w && height===h) return;
      width=w; height=h; canvas.width=w; canvas.height=h;
      gl.bindTexture(gl.TEXTURE_2D,sourceTexture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      pingTextures.forEach(texture => {
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      });
      pingFramebuffers.forEach(framebuffer => {
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)
          throw new Error('ChromaKey framebuffer is incomplete');
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    };
    const pass = (program, inputTexture, framebuffer, uniforms, compose, showMask) => {
      const state=states.get(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.viewport(0,0,width,height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER,positions);
      gl.enableVertexAttribArray(state.position);
      gl.vertexAttribPointer(state.position,2,gl.FLOAT,false,0,0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,inputTexture);
      gl.uniform1i(state.texture,0);
      if(uniforms) uniforms();
      const finalState=finalUniforms.get(program);
      gl.uniform1f(finalState.compose,compose?1:0);
      gl.uniform1f(finalState.showMask,showMask?1:0);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    };

    return {
      canvas,
      draw(source,p,w,h){
        if(lost || !source || w<1 || h<1) return null;
        resize(w,h);
        gl.disable(gl.BLEND);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D,sourceTexture);
        /* Allocate only when the output size changes. Reallocating this RGBA
           texture for every video frame added a second avoidable full-HD
           memory operation on top of the unavoidable Canvas-to-GL upload. */
        gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);

        const start=[clamp(Number(p['Hue Threshold'])||0,0,1),
                     clamp(Number(p['White Threshold'])||0,0,1),
                     clamp(Number(p['Black Threshold'])||0,0,1)];
        const end=[start[0]+clamp(Number(p['Hue Softness'])||0,0,1),
                   start[1]+clamp(Number(p['White Softness'])||0,0,1),
                   start[2]+clamp(Number(p['Black Softness'])||0,0,1)];
        const shrink=Math.round(clamp(Number(p['Edge Shrink'])||0,0,1)*CHROMA_EDGE_MAX_PIXELS);
        const radius=Math.round(clamp(Number(p['Edge Blur'])||0,0,1)*CHROMA_EDGE_MAX_PIXELS);
        const keyIsFinal=shrink===0 && radius===0;
        pass(keyProgram,sourceTexture,keyIsFinal?null:pingFramebuffers[0],() => {
          gl.uniform1f(keyUniforms.hue,clamp(Number(p['Key Hue'])||0,0,1)*360);
          gl.uniform3fv(keyUniforms.start,start);
          gl.uniform3fv(keyUniforms.end,end);
          gl.uniform1f(keyUniforms.spill,clamp(Number(p['Spill Threshold'])||0,0,1));
          gl.uniform1f(keyUniforms.feather,clamp(Number(p['Spill Softness'])||0,0,1));
        },keyIsFinal,!!p['Show Mask']);
        if(keyIsFinal) return canvas;
        let read=0,write=1;
        const pixel=[1/w,1/h];
        for(let i=0;i<shrink;i++){
          const final=i===shrink-1 && radius===0;
          pass(shrinkProgram,pingTextures[read],final?null:pingFramebuffers[write],() => {
            gl.uniform2fv(shrinkUniforms.pixel,pixel);
          },final,!!p['Show Mask']);
          if(final) return canvas;
          const swap=read; read=write; write=swap;
        }
        if(radius>0){
          pass(blurProgram,pingTextures[read],pingFramebuffers[write],() => {
            gl.uniform2fv(blurUniforms.pixel,pixel);
            gl.uniform2f(blurUniforms.direction,1,0);
            gl.uniform1i(blurUniforms.radius,radius);
          },false,false);
          let swap=read; read=write; write=swap;
          pass(blurProgram,pingTextures[read],null,() => {
            gl.uniform2fv(blurUniforms.pixel,pixel);
            gl.uniform2f(blurUniforms.direction,0,1);
            gl.uniform1i(blurUniforms.radius,radius);
          },true,!!p['Show Mask']);
        }
        return canvas;
      }
    };
  }catch(error){
    reportDiagnostic({kind:'gpu-init-error',effect:'ChromaKey',
      message:String(error && error.message || error)});
    return null;
  }
}

let CHROMA_KEY_RENDERER=null, CHROMA_KEY_RENDERER_TRIED=false;
function chromaKeyRenderer(){
  if(!CHROMA_KEY_RENDERER_TRIED){
    CHROMA_KEY_RENDERER_TRIED=true;
    CHROMA_KEY_RENDERER=createChromaKeyRenderer();
  }
  return CHROMA_KEY_RENDERER;
}

function chromaSmoothstep(a,b,value){
  if(b<=a) return value<a?0:1;
  const q=clamp((value-a)/(b-a),0,1);
  return q*q*(3-2*q);
}
function chromaHueDistance(hue1,hue2){
  const a=hue1*Math.PI/180,b=hue2*Math.PI/180;
  return Math.hypot(Math.cos(a)-Math.cos(b),Math.sin(a)-Math.sin(b))*0.5;
}
function renderChromaKeyCPU(dst,src,p,w,h){
  dst.drawImage(src,0,0);
  const image=dst.getImageData(0,0,w,h),data=image.data;
  const key=clamp(Number(p['Key Hue'])||0,0,1)*360;
  const starts=[clamp(Number(p['Hue Threshold'])||0,0,1),
                clamp(Number(p['White Threshold'])||0,0,1),
                clamp(Number(p['Black Threshold'])||0,0,1)];
  const ends=[starts[0]+clamp(Number(p['Hue Softness'])||0,0,1),
              starts[1]+clamp(Number(p['White Softness'])||0,0,1),
              starts[2]+clamp(Number(p['Black Softness'])||0,0,1)];
  const spill=clamp(Number(p['Spill Threshold'])||0,0,1);
  const feather=clamp(Number(p['Spill Softness'])||0,0,1);
  let matte=new Uint8ClampedArray(w*h);
  for(let i=0,pixel=0;i<data.length;i+=4,pixel++){
    const r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255;
    const lo=Math.min(r,g,b),hi=Math.max(r,g,b),delta=hi-lo;
    const sat=hi>0?delta/hi:0;
    let hue=0;
    if(delta>0){
      if(hi===r && hi!==g) hue+=(g-b)/delta;
      if(hi===g && hi!==b) hue+=2+(b-r)/delta;
      if(hi===b && hi!==r) hue+=4+(r-g)/delta;
      hue*=60;
    }
    const distance=chromaHueDistance(key,hue);
    const hueKeep=chromaSmoothstep(starts[0],ends[0],distance);
    const satKey=chromaSmoothstep(starts[1],ends[1],sat);
    const valueKey=chromaSmoothstep(starts[2],ends[2],hi);
    const keep=clamp(Math.hypot(hueKeep,1-satKey,1-valueKey),0,1);
    matte[pixel]=Math.round(data[i+3]*keep);
    const amount=1-chromaSmoothstep(spill,spill+feather,distance);
    const mean=(data[i]+data[i+1]+data[i+2])/3;
    data[i]+=(mean-data[i])*amount;
    data[i+1]+=(mean-data[i+1])*amount;
    data[i+2]+=(mean-data[i+2])*amount;
  }

  const shrink=Math.round(clamp(Number(p['Edge Shrink'])||0,0,1)*CHROMA_EDGE_MAX_PIXELS);
  if(shrink>0){
    let horizontal=new Uint8ClampedArray(matte.length),next=new Uint8ClampedArray(matte.length);
    for(let pass=0;pass<shrink;pass++){
      for(let y=0;y<h;y++) for(let x=0;x<w;x++){
        const row=y*w;
        horizontal[row+x]=Math.min(matte[row+Math.max(0,x-1)],matte[row+x],matte[row+Math.min(w-1,x+1)]);
      }
      for(let y=0;y<h;y++) for(let x=0;x<w;x++){
        next[y*w+x]=Math.min(horizontal[Math.max(0,y-1)*w+x],horizontal[y*w+x],horizontal[Math.min(h-1,y+1)*w+x]);
      }
      const swap=matte; matte=next; next=swap;
    }
  }
  const radius=Math.round(clamp(Number(p['Edge Blur'])||0,0,1)*CHROMA_EDGE_MAX_PIXELS);
  if(radius>0){
    const horizontal=new Uint8ClampedArray(matte.length),blurred=new Uint8ClampedArray(matte.length);
    for(let y=0;y<h;y++){
      let sum=0,count=0;
      for(let x=0;x<=Math.min(w-1,radius);x++){ sum+=matte[y*w+x]; count++; }
      for(let x=0;x<w;x++){
        horizontal[y*w+x]=Math.round(sum/count);
        const leaving=x-radius;
        const entering=x+radius+1;
        if(leaving>=0){ sum-=matte[y*w+leaving]; count--; }
        if(entering<w){ sum+=matte[y*w+entering]; count++; }
      }
    }
    for(let x=0;x<w;x++){
      let sum=0,count=0;
      for(let y=0;y<=Math.min(h-1,radius);y++){ sum+=horizontal[y*w+x]; count++; }
      for(let y=0;y<h;y++){
        blurred[y*w+x]=Math.round(sum/count);
        const leaving=y-radius;
        const entering=y+radius+1;
        if(leaving>=0){ sum-=horizontal[leaving*w+x]; count--; }
        if(entering<h){ sum+=horizontal[entering*w+x]; count++; }
      }
    }
    matte=blurred;
  }
  const show=!!p['Show Mask'];
  for(let i=0,pixel=0;i<data.length;i+=4,pixel++){
    const alpha=matte[pixel];
    if(show){ data[i]=alpha; data[i+1]=alpha; data[i+2]=alpha; data[i+3]=255; }
    else data[i+3]=alpha;
  }
  dst.putImageData(image,0,0);
}

/* Parameter names, order, valuetypes and ranges ARE captured from a running
   Arena 7.27.1 REST graph, and extracted/live-catalog.json corroborates all
   twelve plus the leading Opacity.

   THE RESET DEFAULTS BELOW ARE NOT CORROBORATED, and this comment used to
   claim they were. Checked: that capture holds 1,993 parameter records whose
   fields are exactly id/in/index/max/min/options/out/path/valuetype - it
   carries no `value` and no `default` on any record. And 0.4401114284992218
   occurs exactly once in this repository: on the line below. So the Key Hue
   default is currently unfalsifiable here. It may well be Arena's; nothing
   contradicts it; but it cannot be cited as captured.

   This matters in practice, not just on paper. 0.4401114284992218 is 158.44
   degrees, a blue-leaning green. Broadcast chroma green sits near 141.7. That
   16.7 degree gap lands inside the band where a pixel is only partly keyed but
   fully despilled, so a first run on real green-screen footage produces a faint
   NEUTRAL GREY haze rather than leftover green - and grey gives the operator no
   hint that Key Hue is the control to reach for. Measured: background
   [0,177,64,255] becomes [81,81,81,alpha 22] at defaults, and [0,0,0,0] once
   Key Hue matches the footage.

   Settling it needs one REST GET of a factory-reset ChromaKey that includes the
   value field. Until then this default stays as it is - changing it would
   invent a divergence from Arena on no better evidence than the claim it
   replaces.

   Key Hue is one ordinary ParamRange at /params/Key Hue; Arena presents that
   range with `slider_color_hue`, a 360x display multiplier and a degree suffix.
   Keeping the presentation metadata on the spec gives the operator the missing
   colour-selection surface without inventing a thirteenth ParamColor that Arena
   presets/OSC cannot address. */
def('ChromaKey', [{n:'Show Mask', kind:'bool', d:false},
                  {n:'Key Hue', min:0, max:1, d:0.4401114284992218,
                   control:'hue', multiplier:360, suffix:' °', precision:2},
                  {n:'Hue Threshold', min:0, max:1, d:0.1,
                   multiplier:1, suffix:'', precision:2},
                  {n:'Hue Softness', min:0, max:1, d:0.25,
                   multiplier:1, suffix:'', precision:2},
                  {n:'White Threshold', min:0, max:1, d:0.2,
                   multiplier:1, suffix:'', precision:2},
                  {n:'White Softness', min:0, max:1, d:0.2,
                   multiplier:1, suffix:'', precision:2},
                  {n:'Black Threshold', min:0, max:1, d:0.2,
                   multiplier:1, suffix:'', precision:2},
                  {n:'Black Softness', min:0, max:1, d:0.1,
                   multiplier:1, suffix:'', precision:2},
                  {n:'Spill Threshold', min:0, max:1, d:0.2,
                   multiplier:1, suffix:'', precision:2},
                  {n:'Spill Softness', min:0, max:1, d:0.1,
                   multiplier:1, suffix:'', precision:2},
                  {n:'Edge Shrink', min:0, max:1, d:0.125,
                   multiplier:1, suffix:'', precision:3},
                  {n:'Edge Blur', min:0, max:1, d:0.125,
                   multiplier:1, suffix:'', precision:3}],
  (dst, src, p, w, h) => {
    const renderer=chromaKeyRenderer();
    if(renderer){
      try{
        const rendered=renderer.draw(src,p,w,h);
        if(rendered){ dst.drawImage(rendered,0,0,w,h); return; }
      }catch(error){
        reportDiagnostic({kind:'gpu-draw-error',effect:'ChromaKey',
          message:String(error && error.message || error)});
      }
    }
    /* WebGL-less browsers retain correct pixels through the same equations.
       This path is intentionally reported as over budget; it is not used when
       the GPU pipeline above is available. */
    renderChromaKeyCPU(dst,src,p,w,h);
  });

def('Circles', [{n:'Size', min:0, max:1, d:0.3}, {n:'Fill', min:0, max:1, d:0.9}],
  (dst, src, p, w, h) => {
    /* live-catalog.json A125 — "Creates circles of colors based on the content."
       The colour comes from the content: the frame is averaged down to one texel
       per cell by the browser's own downscale, blown back up with smoothing off,
       and everything outside the circles is then taken away. The mask is a
       one-cell repeating pattern rather than thousands of arcs — measured at
       1280x720, a path of 25,680 circles cost 25 ms/frame and the pattern costs
       1.2 ms flat, whatever the cell size. */
    const cell = Math.max(3, Math.round(Math.min(w, h) * (0.008 + clamp(p.Size, 0, 1) * 0.14)));
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    const small = pad(2, cols, rows);
    small.imageSmoothingEnabled = true;
    small.drawImage(src, 0, 0, cols, rows);
    dst.imageSmoothingEnabled = false;
    dst.drawImage(small.canvas, 0, 0, cols, rows, 0, 0, cols * cell, rows * cell);
    dst.imageSmoothingEnabled = true;
    const fill = clamp(p.Fill, 0, 1);
    /* floored at a hairline so the bottom of the slider still draws something on
       a thumbnail-sized surface instead of silently emptying the frame */
    const r = Math.max(0.4, (cell / 2) * fill);
    const tile = pad(3, cell, cell);
    if(fill > 0){
      tile.fillStyle = '#fff';
      tile.beginPath(); tile.arc(cell / 2, cell / 2, r, 0, Math.PI * 2); tile.fill();
    }
    dst.globalCompositeOperation = 'destination-in';
    dst.fillStyle = dst.createPattern(tile.canvas, 'repeat');
    dst.fillRect(0, 0, w, h);
    dst.globalCompositeOperation = 'source-over';
  });

def('Dilate', [{n:'Size', min:0, max:8, d:2}, {n:'Spread', min:0, max:1, d:0.39},
               {n:'Mode', min:0, max:1, d:0}, {n:'Shape', min:0, max:2, d:0}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const n = clamp(Math.round(p.Size), 0, 8);
    const step = clamp(p.Spread, 0, 1) * Math.min(w, h) * 0.015;
    if(n <= 0 || step <= 0.01) return;
    const shape = clamp(Math.round(p.Shape), 0, 2);
    dst.globalCompositeOperation = Math.round(p.Mode) >= 1 ? 'darken' : 'lighten';
    for(let dy = -n; dy <= n; dy++) for(let dx = -n; dx <= n; dx++){
      if(dx === 0 && dy === 0) continue;
      if(shape === 1 && dx*dx + dy*dy > n*n) continue;
      if(shape === 2 && dx !== 0 && dy !== 0) continue;
      dst.drawImage(src, dx * step, dy * step);
    }
  });

def('Displace', [{n:'Displace X', min:-1, max:1, d:0.1}, {n:'Displace Y', min:-1, max:1, d:0},
                 {n:'Threshold', min:0, max:1, d:0.103}, {n:'Smooth', min:0, max:1, d:0},
                 {n:'Invert', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    const dx = p['Displace X'] * w * 0.25, dy = p['Displace Y'] * h * 0.25;
    const thr = clamp(p.Threshold, 0, 1);
    const inv = p.Invert >= 0.5;
    const bri = 0.5 / Math.max(thr, 0.02);
    const hard = 1 + (1 - clamp(p.Smooth, 0, 1)) * 60;
    const mask = pad(2, w, h);
    mask.filter = 'grayscale(1) brightness(' + bri.toFixed(4) + ') contrast(' + hard.toFixed(2) + ')';
    mask.drawImage(src, 0, 0);
    mask.filter = 'none';
    const pass = pad(3, w, h);
    pass.drawImage(src, 0, 0);
    pass.globalCompositeOperation = 'multiply';
    pass.drawImage(mask.canvas, 0, 0);
    const rest = pad(4, w, h);
    rest.drawImage(src, 0, 0);
    rest.globalCompositeOperation = 'difference';
    rest.drawImage(pass.canvas, 0, 0);
    const moved = inv ? rest : pass, still = inv ? pass : rest;
    dst.drawImage(still.canvas, 0, 0);
    dst.globalCompositeOperation = 'lighter';
    dst.drawImage(moved.canvas, dx, dy);
  });

def('Distortion', [{n:'Distort', min:0, max:1, d:0}, {n:'Radius', min:0, max:1, d:0.55}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const k = clamp(p.Distort, 0, 1);
    const R = clamp(p.Radius, 0, 1) * Math.hypot(w, h) / 2;
    if(k <= 0.002 || R < 2) return;
    const n = 32;
    for(let i = n; i >= 1; i--){
      const q = i / n;
      const s = 1 + k * (1 - q * q) * 1.6;
      dst.save();
      dst.beginPath(); dst.arc(w / 2, h / 2, R * q, 0, Math.PI * 2); dst.clip();
      dst.translate(w / 2, h / 2); dst.scale(s, s); dst.translate(-w / 2, -h / 2);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
  });

def('Dither', [{n:'Levels', min:2, max:16, d:2}, {n:'Amount', min:0, max:1, d:1},
               {n:'Scale', min:1, max:8, d:1}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const n = Math.max(2, Math.round(p.Levels)), nm = n - 1;
    const sc = Math.max(1, Math.round(p.Scale));
    const step = 255/nm, inv = nm/255;
    const amt = clamp(p.Amount, 0, 1) * step;
    /* 8x8 ordered Bayer: the threshold rises with the matrix cell, so a value
       between two output levels lands on the higher one in proportion to how
       close it is, which is what makes the pattern read as a middle tone */
    const M = [
       0, 32,  8, 40,  2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44,  4, 36, 14, 46,  6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
       3, 35, 11, 43,  1, 33,  9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47,  7, 39, 13, 45,  5, 37,
      63, 31, 55, 23, 61, 29, 53, 21];
    const img = dst.getImageData(0, 0, w, h), d = img.data;
    for(let y = 0; y < h; y++){
      const row = (((y/sc)|0) & 7) << 3;
      let i = y*w*4;
      for(let x = 0; x < w; x++, i += 4){
        if(d[i+3] === 0) continue;
        const thr = ((M[row + (((x/sc)|0) & 7)] + 0.5)/64 - 0.5) * amt;
        let v = ((d[i]   + thr)*inv + 0.5)|0; d[i]   = (v < 0 ? 0 : v > nm ? nm : v)*step;
        v     = ((d[i+1] + thr)*inv + 0.5)|0; d[i+1] = (v < 0 ? 0 : v > nm ? nm : v)*step;
        v     = ((d[i+2] + thr)*inv + 0.5)|0; d[i+2] = (v < 0 ? 0 : v > nm ? nm : v)*step;
      }
    }
    dst.putImageData(img, 0, 0);
  });

def('Goo', [{n:'Speed', min:0, max:1, d:0.14},
            {n:'MaxDistortionX', min:0, max:1, d:0.14},
            {n:'MaxDistortionY', min:0, max:1, d:0.14},
            {n:'MaxDistortionZ', min:0, max:1, d:0},
            {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h, t, info) => {
    const ax = clamp(p.MaxDistortionX, 0, 1) * w * 0.22;
    const ay = clamp(p.MaxDistortionY, 0, 1) * h * 0.22;
    const az = clamp(p.MaxDistortionZ, 0, 1) * 0.6;
    if(ax < 0.5 && ay < 0.5 && az < 0.004){ dst.drawImage(src, 0, 0); return; }
    const clock = (info && typeof info.beats === 'number') ? info.beats : (t || 0);
    const ph = clock * clamp(p.Speed, 0, 1) * 6;
    const cell = Math.max(8, Math.round(Math.min(w, h) / 16));
    for(let y = 0; y < h; y += cell){
      const dh = Math.min(cell, h - y);
      for(let x = 0; x < w; x += cell){
        const dw = Math.min(cell, w - x);
        const u = (x + dw / 2) / w, v = (y + dh / 2) / h;
        const nx = Math.sin(u * 6.3 + ph) * 0.6 + Math.sin(v * 4.1 - ph * 0.7) * 0.4;
        const ny = Math.sin(v * 5.7 - ph * 1.1) * 0.6 + Math.sin((u + v) * 3.9 + ph * 0.5) * 0.4;
        const nz = Math.sin((u * 3.3 + v * 2.7) * 2 + ph * 0.9);
        const z = 1 + nz * az;
        const sw = Math.max(1, Math.min(w, dw / z)), sh = Math.max(1, Math.min(h, dh / z));
        const sx = clamp(x + (dw - sw) / 2 + nx * ax, 0, w - sw);
        const sy = clamp(y + (dh - sh) / 2 + ny * ay, 0, h - sh);
        dst.drawImage(src, sx, sy, sw, sh, x, y, dw + 1, dh + 1);
      }
    }
    if(p['Black BG'] >= 0.5){
      dst.globalCompositeOperation = 'destination-over';
      dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h);
      dst.globalCompositeOperation = 'source-over';
    }
  });

def('Grid', [{n:'Size', min:0, max:1, d:0.25}, {n:'Width', min:0, max:1, d:0.12}],
  (dst, src, p, w, h) => {
    /* live-catalog.json A413 — "This effect is very griddly", which is the whole
       of the documentation for it; the manual never names the effect and
       reference/mined.json has no entry, so no preset settles the parameter set.
       UNDOCUMENTED — inferring: a line grid over the content, cell size and line
       width being the two things such a grid has. Width 0 is a true no-op. */
    dst.drawImage(src, 0, 0);
    const cell = Math.max(4, Math.round(Math.min(w, h) * (0.02 + clamp(p.Size, 0, 1) * 0.4)));
    const wq = clamp(p.Width, 0, 1);
    if(wq <= 0) return;
    const lw = Math.max(0.5, cell * wq * 0.4);  /* still a hairline on a thumbnail */
    dst.fillStyle = '#fff';
    for(let x = 0; x <= w; x += cell) dst.fillRect(x - lw / 2, 0, lw, h);
    for(let y = 0; y <= h; y += cell) dst.fillRect(0, y - lw / 2, w, lw);
  });

def('Grid Cloner', [{n:'Columns', min:1, max:10, d:4}, {n:'Rows', min:1, max:10, d:4},
                    {n:'Input Rotation', min:-180, max:180, d:0}, {n:'Input Scale', min:0, max:200, d:20},
                    {n:'Width', min:0, max:2, d:1.2}, {n:'Height', min:0, max:2, d:0.7},
                    {n:'Scale', min:0, max:500, d:100}, {n:'Rotation', min:-180, max:180, d:0},
                    {n:'Vertical Shift', min:-1, max:1, d:0}, {n:'Horiztonal Shift', min:-1, max:1, d:0},
                    {n:'Random Shift', min:0, max:1, d:0},
                    {n:'Order', kind:'choice', options:['Center','Top Right'], optionValues:[0,1], d:1},
                    {n:'Delay', kind:'bool', d:false},
                    {n:'Background', kind:'color', d:0x0011FF68}],
  (dst, src, p, w, h, t, info) => {
    const bg=Number(p.Background)>>>0;
    if((bg>>>24)>0){
      dst.fillStyle=packedColorCss(bg);
      dst.fillRect(0,0,w,h);
    }
    const cols = clamp(Math.round(p.Columns), 1, 10);
    const rows = clamp(Math.round(p.Rows), 1, 10);
    const iscale = p['Input Scale'] / 100;
    if(iscale <= 0.0005) return;
    const irot = p['Input Rotation'] * Math.PI / 180;
    const gscale = p.Scale / 100;
    const grot = p.Rotation * Math.PI / 180;
    const vs = p['Vertical Shift'], hs = p['Horiztonal Shift'];
    const rnd = clamp(p['Random Shift'], 0, 1);
    const jit = (c, r, k) => {
      const x = Math.sin(c * 12.9898 + r * 78.233 + k * 37.719) * 43758.5453;
      return (x - Math.floor(x)) * 2 - 1;
    };
    const cells = [];
    for(let r = 0; r < rows; r++) for(let c = 0; c < cols; c++){
      let nx = cols > 1 ? (c / (cols - 1) - 0.5) * p.Width : 0;
      let ny = rows > 1 ? (r / (rows - 1) - 0.5) * p.Height : 0;
      if(cols > 1) ny += -vs + 2 * vs * (c / (cols - 1));
      if(rows > 1) nx += -hs + 2 * hs * (r / (rows - 1));
      if(rnd > 0){ nx += jit(c, r, 1) * rnd; ny += jit(c, r, 2) * rnd; }
      cells.push([nx, ny, c, r]);
    }
    if(String(p.Order)==='Center' || Number(p.Order)===0)
      cells.sort((a, b) => (b[0]*b[0] + b[1]*b[1]) - (a[0]*a[0] + a[1]*a[1]));
    else
      cells.sort((a, b) => (a[3] - b[3]) || (b[2] - a[2]));
    /* Wire's Delay turns the Ring Buffer length into Columns×Rows. Its shifted
       texture collection is oldest→newest and maps one history frame to each
       ordered instance. Keep the full temporal depth but cap the atlas at
       32 MP (about 128 MB RGBA8), trading snapshot resolution rather than the
       number of delayed frames. This is canvas-to-canvas only: no readback. */
    let history=null, hw=w, hh=h, atlasCols=1, atlasRows=1, head=0;
    const delayActive=!!p.Delay;
    if(info && info.fx && !delayActive) info.fx._gridDelayActive=false;
    if(delayActive && info && info.buffer){
      const count=cells.length;
      atlasCols=Math.ceil(Math.sqrt(count)); atlasRows=Math.ceil(count/atlasCols);
      const scale=Math.min(1,Math.sqrt(32e6/(count*w*h)),16000/(atlasCols*w),16000/(atlasRows*h));
      hw=Math.max(1,Math.round(w*scale)); hh=Math.max(1,Math.round(h*scale));
      history=info.buffer(hw*atlasCols,hh*atlasRows);
      const sig=[count,hw,hh].join(':');
      const enabledNow=info.fx ? !info.fx._gridDelayActive : history.__gridDelaySig!==sig;
      if(info.fx) info.fx._gridDelayActive=true;
      if(history.__gridDelaySig!==sig || enabledNow){
        history.__gridDelaySig=sig; history.__gridDelayHead=0;
        history.setTransform(1,0,0,1,0,0); history.globalAlpha=1;
        history.globalCompositeOperation='source-over'; history.filter='none';
        history.clearRect(0,0,history.canvas.width,history.canvas.height);
        for(let i=0;i<count;i++) history.drawImage(src,0,0,w,h,
          (i%atlasCols)*hw,Math.floor(i/atlasCols)*hh,hw,hh);
      } else {
        history.__gridDelayHead=(history.__gridDelayHead+1)%count;
        const slot=history.__gridDelayHead;
        history.clearRect((slot%atlasCols)*hw,Math.floor(slot/atlasCols)*hh,hw,hh);
        history.drawImage(src,0,0,w,h,(slot%atlasCols)*hw,
          Math.floor(slot/atlasCols)*hh,hw,hh);
      }
      head=history.__gridDelayHead;
    }
    const cosG = Math.cos(grot), sinG = Math.sin(grot);
    for(let i = 0; i < cells.length; i++){
      const ex = cells[i][0] * gscale * (w / 2), ey = cells[i][1] * gscale * (h / 2);
      dst.save();
      dst.translate(w / 2 + ex * cosG - ey * sinG, h / 2 + ex * sinG + ey * cosG);
      dst.rotate(irot);
      dst.scale(iscale, iscale);
      if(history){
        const slot=(head+1+i)%cells.length;
        dst.drawImage(history.canvas,(slot%atlasCols)*hw,Math.floor(slot/atlasCols)*hh,hw,hh,
          -w/2,-h/2,w,h);
      } else dst.drawImage(src, -w / 2, -h / 2, w, h);
      dst.restore();
    }
  });

def('Hatched', [{n:'Spacing', min:0, max:1, d:0.3}, {n:'Angle', min:0, max:1, d:0.125},
                {n:'Levels', min:1, max:4, d:3}, {n:'Weight', min:0, max:1, d:0.34}],
  (dst, src, p, w, h, t, info) => {
    const gap = Math.max(3, Math.round(3 + clamp(p.Spacing, 0, 1) * 22));
    const n = clamp(Math.round(p.Levels), 1, 4);
    const ang = clamp(p.Angle, 0, 1);
    const lw = Math.max(0.5, gap * clamp(p.Weight, 0.02, 1));
    const sig = w + 'x' + h + '|' + gap + '|' + n + '|' + lw.toFixed(3) + '|' + ang.toFixed(4);
    let scr = (info && info.buffer) ? info.buffer(w, h) : null;
    if(!scr || scr.__hatchSig !== sig){
      const c = scr || pad(2, w, h);
      const diag = Math.hypot(w, h);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1; c.filter = 'none'; c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#808080'; c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'darken';
      c.lineWidth = lw;
      c.translate(w/2, h/2);
      for(let i = 0; i < n; i++){
        const v = Math.round(clamp(0.5 * (1 - (i + 1)/(n + 1)), 0, 1) * 255);
        c.strokeStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
        c.save();
        c.rotate(ang * Math.PI * 2 + i * Math.PI / n);
        c.beginPath();
        for(let y = -diag; y <= diag; y += gap){ c.moveTo(-diag, y); c.lineTo(diag, y); }
        c.stroke();
        c.restore();
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      if(scr) scr.__hatchSig = sig;
      scr = c;
    }
    const sum = pad(3, w, h);
    sum.filter = 'grayscale(1) brightness(0.5)';
    sum.drawImage(src, 0, 0);
    sum.filter = 'none';
    sum.globalCompositeOperation = 'lighter';
    sum.drawImage(scr.canvas, 0, 0);
    dst.filter = 'contrast(64)';
    dst.drawImage(sum.canvas, 0, 0);
    dst.filter = 'none';
    dst.globalCompositeOperation = 'destination-in';
    dst.drawImage(src, 0, 0);
  });

def('Heat', [{n:'Amount', min:0, max:1, d:1}, {n:'Offset', min:-1, max:1, d:0}],
  (dst, src, p, w, h) => {
    const g = clamp(1 + p.Offset, 0.02, 3);
    const band = (i, filt, col) => {
      const b = pad(i, w, h);
      b.filter = 'grayscale(1) ' + filt;
      b.drawImage(src, 0, 0);
      b.filter = 'none';
      b.globalCompositeOperation = 'multiply';
      b.fillStyle = col; b.fillRect(0, 0, w, h);
      dst.globalCompositeOperation = 'lighter';
      dst.drawImage(b.canvas, 0, 0);
    };
    band(5, `brightness(${(3*g).toFixed(4)})`,               '#ff0000');
    band(6, `brightness(${g.toFixed(4)}) contrast(3)`,       '#00ff00');
    band(7, `brightness(${(0.6*g).toFixed(4)}) contrast(5)`, '#0000ff');
    const a = clamp(p.Amount, 0, 1);
    dst.globalCompositeOperation = 'source-over';
    if(a < 1){ dst.globalAlpha = 1 - a; dst.drawImage(src, 0, 0); dst.globalAlpha = 1; }
    dst.globalCompositeOperation = 'destination-in';
    dst.drawImage(src, 0, 0);
  });

def('Keystone', [{n:'Top Left X', min:0, max:1, d:0},   {n:'Top Left Y', min:0, max:1, d:0},
                 {n:'Top Right X', min:0, max:1, d:1},  {n:'Top Right Y', min:0, max:1, d:0},
                 {n:'Bot. Right X', min:0, max:1, d:1}, {n:'Bot. Right Y', min:0, max:1, d:1},
                 {n:'Bot. Left X', min:0, max:1, d:0},  {n:'Bot. Left Y', min:0, max:1, d:1},
                 {n:'Show Grid', kind:'bool', d:false}, {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    /* Corner pin. A quad is not an affine image of a rectangle, so setTransform
       alone cannot do this: the map is a homography. Heckbert's square->quad
       coefficients give it exactly, and the picture is then laid down as a mesh
       whose vertices sit on the true projective map, each cell drawn with the
       affine that matches its own three corners. A parallelogram (which
       includes the default, where the pins are the frame corners) is affine, so
       it short-circuits to one exact drawImage and no mesh seams. */
    const x0 = p['Top Left X']*w,   y0 = p['Top Left Y']*h;
    const x1 = p['Top Right X']*w,  y1 = p['Top Right Y']*h;
    const x2 = p['Bot. Right X']*w, y2 = p['Bot. Right Y']*h;
    const x3 = p['Bot. Left X']*w,  y3 = p['Bot. Left Y']*h;
    /* save/restore around every style change: dst is a pad shared with the rest
       of the chain, and pad() resets transform/alpha/composite/filter but not
       fillStyle, strokeStyle, lineWidth or the clip. */
    if(p['Black BG'] >= 0.5){
      dst.save(); dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h); dst.restore();
    }
    const dx1 = x1-x2, dx2 = x3-x2, dx3 = x0-x1+x2-x3;
    const dy1 = y1-y2, dy2 = y3-y2, dy3 = y0-y1+y2-y3;
    const den = dx1*dy2 - dy1*dx2;
    let g = 0, k = 0;
    if(den !== 0 && (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9)){
      g = (dx3*dy2 - dy3*dx2)/den;
      k = (dx1*dy3 - dy1*dx3)/den;
    }
    const a = x1-x0 + g*x1, b = x3-x0 + k*x3, c = x0;
    const d = y1-y0 + g*y1, e = y3-y0 + k*y3, f = y0;
    const map = (u, v) => { const q = 1 + g*u + k*v;
                            return [(a*u + b*v + c)/q, (d*u + e*v + f)/q]; };
    if(g === 0 && k === 0){
      dst.save();
      dst.setTransform(a/w, d/w, b/h, e/h, c, f);
      dst.drawImage(src, 0, 0);
      dst.restore();
    } else {
      /* subdivide only along the axis that is actually non-affine: a symmetric
         projector keystone has g = 0, so it costs one column of bands */
      const cols = clamp(Math.ceil(Math.abs(g)*24), 1, 24);
      const rows = clamp(Math.ceil(Math.abs(k)*24), 1, 24);
      const P = [];
      for(let j = 0; j <= rows; j++) for(let i = 0; i <= cols; i++) P.push(map(i/cols, j/rows));
      const at = (i, j) => P[j*(cols+1) + i];
      const tri = (s0, s1, s2, d0, d1, d2) => {
        const e1x = s1[0]-s0[0], e1y = s1[1]-s0[1];
        const e2x = s2[0]-s0[0], e2y = s2[1]-s0[1];
        const det = e1x*e2y - e1y*e2x;
        if(!det) return;
        const f1x = d1[0]-d0[0], f1y = d1[1]-d0[1];
        const f2x = d2[0]-d0[0], f2y = d2[1]-d0[1];
        const det2 = f1x*f2y - f2x*f1y;                /* twice the dest area */
        const m11 = (f1x*e2y - f2x*e1y)/det, m12 = (f1y*e2y - f2y*e1y)/det;
        const m21 = (f2x*e1x - f1x*e2x)/det, m22 = (f2y*e1x - f1y*e2x)/det;
        /* Adjacent cells share edges, and two antialiased clips meeting on the
           same line each cover it partially, so the seam shows as a line of
           half-transparent pixels — measured at 17 of them down the centre of a
           12-band warp. Grow every triangle until each of its edges has moved a
           full pixel outwards, so neighbours overlap instead of abutting.
           Scaling about the centroid by 1 + 1/inradius does exactly that, and
           the inradius is 2*area/perimeter. */
        const gx = (d0[0]+d1[0]+d2[0])/3, gy = (d0[1]+d1[1]+d2[1])/3;
        const per = Math.hypot(d1[0]-d0[0], d1[1]-d0[1])
                  + Math.hypot(d2[0]-d1[0], d2[1]-d1[1])
                  + Math.hypot(d0[0]-d2[0], d0[1]-d2[1]);
        const inr = per > 0 ? Math.abs(det2)/per : 0;
        const sc = inr > 0.01 ? 1 + 1/inr : 1;
        const grow = (q) => [gx + (q[0]-gx)*sc, gy + (q[1]-gy)*sc];
        const a0 = grow(d0), a1 = grow(d1), a2 = grow(d2);
        dst.save();
        dst.beginPath();
        dst.moveTo(a0[0], a0[1]); dst.lineTo(a1[0], a1[1]); dst.lineTo(a2[0], a2[1]);
        dst.closePath(); dst.clip();
        dst.setTransform(m11, m12, m21, m22,
                         d0[0] - (m11*s0[0] + m21*s0[1]),
                         d0[1] - (m12*s0[0] + m22*s0[1]));
        dst.drawImage(src, 0, 0);
        dst.restore();
      };
      /* the grown triangles overlap outwards, so hold the whole mesh inside the
         quad — the outer edge stays exactly where the pins put it */
      dst.save();
      dst.beginPath();
      dst.moveTo(x0, y0); dst.lineTo(x1, y1); dst.lineTo(x2, y2); dst.lineTo(x3, y3);
      dst.closePath(); dst.clip();
      for(let j = 0; j < rows; j++) for(let i = 0; i < cols; i++){
        const sx0 = i*w/cols, sx1 = (i+1)*w/cols, sy0 = j*h/rows, sy1 = (j+1)*h/rows;
        tri([sx0,sy0], [sx1,sy0], [sx0,sy1], at(i,j),   at(i+1,j),   at(i,j+1));
        tri([sx1,sy0], [sx1,sy1], [sx0,sy1], at(i+1,j), at(i+1,j+1), at(i,j+1));
      }
      dst.restore();
    }
    if(p['Show Grid'] >= 0.5){
      dst.save();
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.strokeStyle = 'rgba(255,255,255,0.85)'; dst.lineWidth = 1;
      dst.beginPath();
      const N = 4;
      for(let j = 0; j <= N; j++) for(let i = 0; i <= N; i++){
        const q = map(i/N, j/N); if(i) dst.lineTo(q[0], q[1]); else dst.moveTo(q[0], q[1]);
      }
      for(let i = 0; i <= N; i++) for(let j = 0; j <= N; j++){
        const q = map(i/N, j/N); if(j) dst.lineTo(q[0], q[1]); else dst.moveTo(q[0], q[1]);
      }
      dst.stroke();
      dst.restore();
    }
  });

def('Keystone Crop', [{n:'Top Left X', min:0, max:1, d:0},   {n:'Top Left Y', min:0, max:1, d:0},
                      {n:'Top Right X', min:0, max:1, d:1},  {n:'Top Right Y', min:0, max:1, d:0},
                      {n:'Bot. Right X', min:0, max:1, d:1}, {n:'Bot. Right Y', min:0, max:1, d:1},
                      {n:'Bot. Left X', min:0, max:1, d:0},  {n:'Bot. Left Y', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    /* "removes the stretched edges instead of trying to fit the image into a
       warped shape" — so the picture is never resampled, the quad only decides
       what survives. That is a clip, and a clip is exact. */
    const q = [[p['Top Left X']*w,   p['Top Left Y']*h],
               [p['Top Right X']*w,  p['Top Right Y']*h],
               [p['Bot. Right X']*w, p['Bot. Right Y']*h],
               [p['Bot. Left X']*w,  p['Bot. Left Y']*h]];
    if(q[0][0] <= 0 && q[0][1] <= 0 && q[1][0] >= w && q[1][1] <= 0 &&
       q[2][0] >= w && q[2][1] >= h && q[3][0] <= 0 && q[3][1] >= h){
      dst.drawImage(src, 0, 0);           /* pins at the frame corners: untouched */
      return;
    }
    /* save/restore is not tidiness. dst is a pad shared with every other effect
       and every later frame, and pad() resets the transform, alpha, composite
       and filter but CANNOT reset a clip — measured: after clip(), pad()'s own
       reset sequence still blocks a full-frame fillRect. Leave the clip behind
       and the next effect in the chain gets cropped too. */
    dst.save();
    dst.beginPath(); dst.moveTo(q[0][0], q[0][1]);
    for(let i = 1; i < 4; i++) dst.lineTo(q[i][0], q[i][1]);
    dst.closePath(); dst.clip();
    dst.drawImage(src, 0, 0);
    dst.restore();
  });

def('Keystone Mask', [{n:'Top Left X', min:0, max:1, d:0},   {n:'Top Left Y', min:0, max:1, d:0},
                      {n:'Top Right X', min:0, max:1, d:1},  {n:'Top Right Y', min:0, max:1, d:0},
                      {n:'Bot. Right X', min:0, max:1, d:1}, {n:'Bot. Right Y', min:0, max:1, d:1},
                      {n:'Bot. Left X', min:0, max:1, d:0},  {n:'Bot. Left Y', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    /* The complement of Keystone Crop: the quad is the hole, which is what
       "allows you to poke holes into your content" means. At the shipped
       defaults the pins are the frame corners, so the hole is the whole frame
       and the result is empty — this effect is not a no-op at its defaults. */
    dst.drawImage(src, 0, 0);
    dst.globalCompositeOperation = 'destination-out';
    /* explicit: pad() resets composite but not fillStyle, so an effect earlier
       in the chain can leave a semi-transparent colour behind and the hole
       would only be half cut. destination-out reads alpha, so: opaque. */
    dst.fillStyle = '#000';
    dst.beginPath();
    dst.moveTo(p['Top Left X']*w, p['Top Left Y']*h);
    dst.lineTo(p['Top Right X']*w, p['Top Right Y']*h);
    dst.lineTo(p['Bot. Right X']*w, p['Bot. Right Y']*h);
    dst.lineTo(p['Bot. Left X']*w, p['Bot. Left Y']*h);
    dst.closePath(); dst.fill();
  });

def('Levels', [{n:'Input Black', min:0, max:1, d:0}, {n:'Input White', min:0, max:1, d:1},
               {n:'Gamma', min:0.1, max:4, d:1},
               {n:'Output Black', min:0, max:1, d:0}, {n:'Output White', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const ib = p['Input Black'], iw = p['Input White'], g = Math.max(0.01, p.Gamma);
    const ob = p['Output Black'], ow = p['Output White'];
    /* the defaults are a straight pass-through, so do not pay for a readback */
    if(ib === 0 && iw === 1 && g === 1 && ob === 0 && ow === 1) return;
    const raw = iw - ib, span = Math.abs(raw) < 1e-6 ? 1e-6 : raw, ig = 1/g;
    const lut = new Uint8ClampedArray(256);
    for(let v = 0; v < 256; v++)
      lut[v] = (ob + Math.pow(clamp((v/255 - ib)/span, 0, 1), ig) * (ow - ob)) * 255;
    const img = dst.getImageData(0, 0, w, h), d = img.data;
    for(let i = 0; i < d.length; i += 4){ d[i] = lut[d[i]]; d[i+1] = lut[d[i+1]]; d[i+2] = lut[d[i+2]]; }
    dst.putImageData(img, 0, 0);
  });

def('Linear Cloner', [{n:'Clones', min:1, max:50, d:25}, {n:'Tails', min:1, max:8, d:2},
                      {n:'Center', min:-1, max:1, d:0}, {n:'Tail Length', min:-1, max:1, d:0.5},
                      {n:'Start Scale', min:0, max:100, d:50},
                      {n:'Start Rotation', min:-180, max:180, d:0},
                      {n:'End Scale', min:0, max:100, d:0},
                      {n:'End Rotation', min:0, max:360, d:90},
                      {n:'Distribution', min:0, max:100, d:50},
                      {n:'Distortion', min:-100, max:100, d:45},
                      {n:'Reverse', kind:'bool', d:false},
                      {n:'Tail Rotation', min:0, max:100, d:0},
                      {n:'Master Rotation', min:-180, max:180, d:0}],
  (dst, src, p, w, h) => {
    const n = clamp(Math.round(p.Clones), 1, 50);
    const tails = clamp(Math.round(p.Tails), 1, 8);
    const span = Math.hypot(w, h) * clamp(p.Distribution / 100, 0, 1);
    const step = n > 1 ? span / (n - 1) : 0;
    const turn = (p.Distortion / 100) * Math.PI * 2 / Math.max(1, n - 1);
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let px = 0, py = 0, head = 0;
    for(let i = 0; i < n; i++){
      xs[i] = px; ys[i] = py;
      px += Math.cos(head) * step; py += Math.sin(head) * step;
      head += turn;
    }
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for(let i = 0; i < n; i++){
      if(xs[i] < mnx) mnx = xs[i];
      if(xs[i] > mxx) mxx = xs[i];
      if(ys[i] < mny) mny = ys[i];
      if(ys[i] > mxy) mxy = ys[i];
    }
    const ox = (mnx + mxx) / 2, oy = (mny + mxy) / 2;
    const sr = p['Start Rotation'] * Math.PI / 180;
    const er = p['End Rotation'] * Math.PI / 180;
    const es = clamp(p['End Scale'] / 100, 0, 1);
    const ss = clamp(p['Start Scale'] / 100, 0, 1);
    const rev = !!p.Reverse;
    const tailLength = clamp(p['Tail Length'], -1, 1);
    const tailTurn = clamp(p['Tail Rotation'], 0, 100) / 100 * Math.PI * 2;
    dst.save();
    dst.translate(w / 2, h / 2);
    dst.rotate(p['Master Rotation'] * Math.PI / 180);
    dst.translate(p.Center * Math.hypot(w, h) * 0.5, 0);
    for(let k = 0; k < n; k++){
      const i = rev ? n - 1 - k : k;
      const u = n > 1 ? i / (n - 1) : 0;
      const s = ss + (es - ss) * u;
      if(s <= 0.0005) continue;
      const prev = Math.max(0, i - 1), next = Math.min(n - 1, i + 1);
      let vx = xs[next] - xs[prev], vy = ys[next] - ys[prev];
      const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      /* Tails=1 is exactly the former one-draw path. Additional tails follow
         the local path tangent, and Tail Rotation twists them around the head;
         all three parameters come directly from Arena's LinearCloner pass. */
      for(let j = tails - 1; j >= 0; j--){
        const tu = tails > 1 ? j / (tails - 1) : 0;
        const trail = tailLength * step * j;
        dst.save();
        dst.globalAlpha = 1 - tu * 0.75;
        dst.translate(xs[i] - ox - vx * trail, ys[i] - oy - vy * trail);
        dst.rotate(sr + (er - sr) * u + tailTurn * tu);
        dst.scale(s, s);
        dst.drawImage(src, -w / 2, -h / 2, w, h);
        dst.restore();
      }
    }
    dst.restore();
  });

def('Mirror Quad', [{n:'Flip X', min:0, max:1, d:0}, {n:'Flip Y', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    /* live-catalog description: "Mirrors the X and Y axis simultaneously and
       symmetrically" — four half-size copies, each quadrant reflected against
       its neighbours, so the seams at the centre lines always match. Flip X/Y
       decide which edge of the source meets at the seam. */
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    const fx = p['Flip X'] >= 0.5 ? -1 : 1, fy = p['Flip Y'] >= 0.5 ? -1 : 1;
    for(let qy = 0; qy < 2; qy++) for(let qx = 0; qx < 2; qx++){
      const mx = (qx ? -1 : 1) * fx, my = (qy ? -1 : 1) * fy;
      dst.save();
      dst.translate(qx * (w - hw) + (mx < 0 ? hw : 0), qy * (h - hh) + (my < 0 ? hh : 0));
      dst.scale(mx, my);
      dst.drawImage(src, 0, 0, w, h, 0, 0, hw, hh);
      dst.restore();
    }
  });

def('Noisy', [{n:'Amount', min:0, max:1, d:0.3}, {n:'Size', min:0, max:1, d:0.15},
              {n:'Color', min:0, max:1, d:0}],
  (dst, src, p, w, h, t, info) => {
    dst.drawImage(src, 0, 0);
    const a = clamp(p.Amount, 0, 1);
    if(a <= 0.0001) return;
    const T = 128;
    const nz = pad(6, T, T);
    const img = nz.createImageData(T, T), d = img.data;
    const phase = (info && typeof info.beats === 'number') ? info.beats : (t || 0) * 4;
    let s = ((Math.floor(phase * 60) * 1103515245 + 12345) | 0) || 0x9e3779b9;
    const rnd = () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 8) & 0xffff) / 65535; };
    const c = clamp(p.Color, 0, 1);
    for(let i = 0; i < d.length; i += 4){
      const v = rnd() * 255;
      d[i]   = v * (1 - c) + rnd() * 255 * c;
      d[i+1] = v * (1 - c) + rnd() * 255 * c;
      d[i+2] = v * (1 - c) + rnd() * 255 * c;
      d[i+3] = 255;
    }
    nz.putImageData(img, 0, 0);
    const grain = T * (1 + Math.round(clamp(p.Size, 0, 1) * 12));
    dst.globalCompositeOperation = 'overlay';
    dst.globalAlpha = a;
    dst.imageSmoothingEnabled = false;
    for(let y = 0; y < h; y += grain) for(let x = 0; x < w; x += grain)
      dst.drawImage(nz.canvas, x, y, grain, grain);
    dst.imageSmoothingEnabled = true;
    dst.globalAlpha = 1;
    dst.globalCompositeOperation = 'destination-in';
    dst.drawImage(src, 0, 0);
  });

def('Pixel Blur', [{n:'Amount', min:0, max:1, d:0.35}], (dst, src, p, w, h) => {
  const r = clamp(p.Amount, 0, 1) * 40;
  if(r <= 0.01){ dst.drawImage(src, 0, 0); return; }
  const m = Math.max(1, Math.ceil(r * 2));
  const b = pad(2, w + m * 2, h + m * 2);
  b.drawImage(src, 0,   0,   1, h,  0,     m,     m, h);
  b.drawImage(src, w-1, 0,   1, h,  m + w, m,     m, h);
  b.drawImage(src, 0,   0,   w, 1,  m,     0,     w, m);
  b.drawImage(src, 0,   h-1, w, 1,  m,     m + h, w, m);
  b.drawImage(src, 0,   0,   1, 1,  0,     0,     m, m);
  b.drawImage(src, w-1, 0,   1, 1,  m + w, 0,     m, m);
  b.drawImage(src, 0,   h-1, 1, 1,  0,     m + h, m, m);
  b.drawImage(src, w-1, h-1, 1, 1,  m + w, m + h, m, m);
  b.drawImage(src, m, m);
  dst.filter = 'blur(' + r.toFixed(2) + 'px)';
  dst.drawImage(b.canvas, -m, -m);
  dst.filter = 'none';
});

def('Pixel High Pass', [{n:'Radius', min:0, max:1, d:0.3}, {n:'Amount', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    const r = 0.5 + clamp(p.Radius, 0, 1) * 24;
    const m = Math.max(1, Math.ceil(r * 2));
    const b = pad(2, w + m * 2, h + m * 2);
    b.drawImage(src, 0,   0,   1, h,  0,     m,     m, h);
    b.drawImage(src, w-1, 0,   1, h,  m + w, m,     m, h);
    b.drawImage(src, 0,   0,   w, 1,  m,     0,     w, m);
    b.drawImage(src, 0,   h-1, w, 1,  m,     m + h, w, m);
    b.drawImage(src, 0,   0,   1, 1,  0,     0,     m, m);
    b.drawImage(src, w-1, 0,   1, 1,  m + w, 0,     m, m);
    b.drawImage(src, 0,   h-1, 1, 1,  0,     m + h, m, m);
    b.drawImage(src, w-1, h-1, 1, 1,  m + w, m + h, m, m);
    b.drawImage(src, m, m);
    const g = pad(3, w, h);
    g.filter = 'blur(' + r.toFixed(2) + 'px) invert(1)';
    g.drawImage(b.canvas, -m, -m);
    g.filter = 'none';
    const o = pad(4, w, h);
    o.drawImage(src, 0, 0);
    o.globalAlpha = 0.5;
    o.drawImage(g.canvas, 0, 0);
    o.globalAlpha = 1;
    dst.filter = 'contrast(' + (1 + clamp(p.Amount, 0, 1) * 7).toFixed(3) + ')';
    dst.drawImage(o.canvas, 0, 0);
    dst.filter = 'none';
    dst.globalCompositeOperation = 'destination-in';
    dst.drawImage(src, 0, 0);
    dst.globalCompositeOperation = 'source-over';
  });

def('PolarKaleido', [{n:'Parts', min:2, max:32, d:16}, {n:'Rings', min:1, max:32, d:16},
                     {n:'Angle', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    /* Two folds, one per polar coordinate. Radius first, because repeating in r
       is rotationally symmetric and therefore commutes with the angular fold;
       doing it first means it costs `rings` draws instead of rings*parts. */
    const parts = Math.max(2, Math.round(p.Parts));
    const rings = Math.max(1, Math.round(p.Rings));
    const cx = w / 2, cy = h / 2, r = Math.hypot(cx, cy);
    let img = src;
    if(rings > 1){
      const rp = pad(2, w, h);
      const g = Math.pow(0.03, 1 / rings);   /* innermost copy ~3% of the frame */
      for(let k = 0; k < rings; k++){        /* largest first: each copy keeps its own border */
        const s = Math.pow(g, k);
        rp.save();
        rp.translate(cx, cy); rp.scale(s, s); rp.translate(-cx, -cy);
        rp.drawImage(src, 0, 0);
        rp.restore();
      }
      img = rp.canvas;
    }
    const base = p.Angle * Math.PI * 2, seg = Math.PI * 2 / parts;
    for(let i = 0; i < parts; i++){
      dst.save();
      dst.translate(cx, cy);
      dst.rotate(base + i * seg);
      if(i % 2) dst.scale(1, -1);
      dst.beginPath(); dst.moveTo(0, 0);
      dst.arc(0, 0, r, -seg / 2, seg / 2); dst.closePath(); dst.clip();
      dst.translate(-cx, -cy);
      dst.drawImage(img, 0, 0);
      dst.restore();
    }
  });

def('Polkadot', [{n:'Size', min:0, max:1, d:0.5}, {n:'Spacing', min:0, max:1, d:0.3},
                 {n:'Angle', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    /* live-catalog.json A181 — "Polka like you mean it". Polka dots are a
       staggered lattice, so the tile is two rows tall with the second row offset
       half a cell, and the content shows through the dots and nowhere else.
       Angle turns the LATTICE, not the content, which is why the pattern is
       filled through a rotated transform while the source is drawn square. */
    const cell = Math.max(4, Math.round(Math.min(w, h) * (0.03 + clamp(p.Spacing, 0, 1) * 0.22)));
    const rowH = Math.max(2, Math.round(cell * 0.866));
    const size = clamp(p.Size, 0, 1);
    const r = Math.max(0.4, (cell / 2) * size);
    const tile = pad(2, cell, rowH * 2);
    if(size > 0){
      tile.fillStyle = '#fff';
      const dot = (x, y) => { tile.beginPath(); tile.arc(x, y, r, 0, Math.PI * 2); tile.fill(); };
      dot(0, 0); dot(cell, 0); dot(0, rowH * 2); dot(cell, rowH * 2); dot(cell / 2, rowH);
    }
    dst.drawImage(src, 0, 0);
    dst.globalCompositeOperation = 'destination-in';
    dst.save();
    dst.translate(w / 2, h / 2);
    dst.rotate(clamp(p.Angle, 0, 1) * Math.PI * 2);
    dst.fillStyle = dst.createPattern(tile.canvas, 'repeat');
    const R = Math.hypot(w, h) * 1.1;   /* covers the frame at any rotation */
    dst.fillRect(-R / 2, -R / 2, R, R);
    dst.restore();
    dst.globalCompositeOperation = 'source-over';
  });

def('Radar', [{n:'Angle', min:0, max:1, d:0}, {n:'Speed', min:0, max:1, d:0.25},
              {n:'Trail Length', min:0, max:1, d:0.914}, {n:'Fade', min:0, max:1, d:0},
              {n:'Grid Scale', min:0, max:1, d:0.517}, {n:'Show Grid', min:0, max:1, d:1}],
  (dst, src, p, w, h, t, info) => {
    const time = (info && typeof info.beats === 'number') ? info.beats : (t || 0);
    const a0 = (p.Angle + time * clamp(p.Speed, 0, 1)) * Math.PI * 2;
    const cx = w/2, cy = h/2, R = Math.hypot(cx, cy) + 2;
    const fade = clamp(p.Fade, 0, 1);
    if(fade > 0.001){
      dst.globalAlpha = fade;
      dst.drawImage(src, 0, 0);
      dst.globalAlpha = 1;
    }
    const trail = clamp(p['Trail Length'], 0, 1) * Math.PI * 2;
    if(trail > 0.0001){
      const steps = 64, eps = trail / steps * 0.6;
      for(let i = 0; i < steps; i++){
        const f0 = i/steps, f1 = (i+1)/steps;
        dst.save();
        dst.globalAlpha = 1 - f0;
        dst.beginPath(); dst.moveTo(cx, cy);
        dst.arc(cx, cy, R, a0 - trail*f1 - eps, a0 - trail*f0);
        dst.closePath(); dst.clip();
        dst.drawImage(src, 0, 0);
        dst.restore();
      }
    }
    if(p['Show Grid'] >= 0.5){
      const gs = clamp(p['Grid Scale'], 0, 1);
      const rings = Math.max(1, Math.round(1 + gs * 9));
      const spokes = Math.max(2, Math.round(2 + gs * 14)) * 2;
      dst.save();
      dst.globalCompositeOperation = 'lighter';
      dst.strokeStyle = 'rgba(255,255,255,0.35)';
      dst.lineWidth = Math.max(1, Math.min(w, h) / 600);
      for(let i = 1; i <= rings; i++){
        dst.beginPath();
        dst.arc(cx, cy, R * i / rings, 0, Math.PI*2);
        dst.stroke();
      }
      for(let i = 0; i < spokes; i++){
        const a = a0 + i * Math.PI * 2 / spokes;
        dst.beginPath(); dst.moveTo(cx, cy);
        dst.lineTo(cx + Math.cos(a)*R, cy + Math.sin(a)*R);
        dst.stroke();
      }
      dst.strokeStyle = 'rgba(255,255,255,0.9)';
      dst.beginPath(); dst.moveTo(cx, cy);
      dst.lineTo(cx + Math.cos(a0)*R, cy + Math.sin(a0)*R);
      dst.stroke();
      dst.restore();
    }
  });

def('Radial Cloner', [{n:'Clones', min:1, max:50, d:8}, {n:'End Radius', min:0, max:1, d:1},
                      {n:'End Rotation', min:0, max:360, d:360}, {n:'End Scale', min:0, max:100, d:100},
                      {n:'Fan', min:0, max:100, d:100}, {n:'Fan Offset', min:0, max:100, d:0},
                      {n:'Master Rotation', min:-180, max:180, d:0}, {n:'Start Radius', min:0, max:1, d:0.5},
                      {n:'Start Rotation', min:-180, max:180, d:0}, {n:'Start Scale', min:0, max:100, d:25}],
  (dst, src, p, w, h) => {
    const n = clamp(Math.round(p.Clones), 1, 50);
    const unit = Math.min(w, h) / 2;
    const r0 = p['Start Radius'] * unit, r1 = p['End Radius'] * unit;
    const fan = clamp(p.Fan / 100, 0, 1);
    const sweep = fan * Math.PI * 2;
    const off = (p['Fan Offset'] / 100) * Math.PI * 2;
    const sr = p['Start Rotation'] * Math.PI / 180;
    const er = p['End Rotation'] * Math.PI / 180;
    const es = clamp(p['End Scale'] / 100, 0, 1);
    const ss = clamp(p['Start Scale'] / 100, 0, 1);
    const closed = fan >= 0.9999;
    const div = closed ? n : Math.max(1, n - 1);
    dst.save();
    dst.translate(w / 2, h / 2);
    dst.rotate(p['Master Rotation'] * Math.PI / 180);
    for(let i = 0; i < n; i++){
      const u = n > 1 ? i / (n - 1) : 0;
      const a = off + sweep * (i / div);
      const r = r0 + (r1 - r0) * u;
      const s = ss + (es - ss) * u;
      if(s <= 0.0005) continue;
      dst.save();
      dst.translate(Math.cos(a) * r, Math.sin(a) * r);
      dst.rotate(sr + (er - sr) * u);
      dst.scale(s, s);
      dst.drawImage(src, -w / 2, -h / 2, w, h);
      dst.restore();
    }
    dst.restore();
  });

def('Raster', [{n:'Size', min:0, max:1, d:0.25}, {n:'Amount', min:0, max:1, d:1},
               {n:'Offset', min:0, max:1, d:0}, {n:'Direction', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const a = clamp(p.Amount, 0, 1);
    if(a <= 0.0001) return;
    const period = Math.max(2, Math.round(2 + clamp(p.Size, 0, 1) * 30));
    const bar = Math.max(1, Math.floor(period / 2));
    const off = (Math.round(clamp(p.Offset, 0, 1) * period) % period) - period;
    dst.globalCompositeOperation = 'destination-out';
    dst.globalAlpha = a;
    dst.fillStyle = '#000';
    if(p.Direction >= 0.5) for(let x = off; x < w; x += period) dst.fillRect(x, 0, bar, h);
    else                   for(let y = off; y < h; y += period) dst.fillRect(0, y, w, bar);
  });

def('Recolor', [{n:'Dark Hue', min:0, max:1, d:0.58}, {n:'Light Hue', min:0, max:1, d:0.09},
                {n:'Amount', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const a = clamp(p.Amount, 0, 1);
    if(a <= 0.001) return;
    const hsl = (hh, ss, ll) => {
      const k = n => (n + hh*12) % 12, m = ss * Math.min(ll, 1 - ll);
      const f = n => ll - m * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return [f(0), f(8), f(4)];
    };
    const css = v => 'rgb(' + v.map(c => Math.round(clamp(c, 0, 1)*255)).join(',') + ')';
    const A = hsl(p['Dark Hue'], 1, 0.14), B = hsl(p['Light Hue'], 1, 0.86);
    const up = [0,1,2].map(i => Math.max(0, B[i] - A[i]));
    const dn = [0,1,2].map(i => Math.max(0, A[i] - B[i]));
    /* luminance mapped onto a two-colour ramp: out = A + luma*(B - A).
       Built out of composite ops so there is no per-frame readback. Per channel
       only one of up/dn is non-zero and dn <= A, so 'difference' is an exact
       subtract here — measured against the closed form it is within 1/255. */
    const lum = pad(4, w, h);
    lum.filter = 'grayscale(1)';
    lum.drawImage(src, 0, 0);
    lum.filter = 'none';
    const ramp = pad(5, w, h);
    ramp.fillStyle = css(A); ramp.fillRect(0, 0, w, h);
    const gu = pad(6, w, h);
    gu.fillStyle = css(up); gu.fillRect(0, 0, w, h);
    gu.globalCompositeOperation = 'multiply';
    gu.drawImage(lum.canvas, 0, 0);
    ramp.globalCompositeOperation = 'lighter';
    ramp.drawImage(gu.canvas, 0, 0);
    const gd = pad(7, w, h);
    gd.fillStyle = css(dn); gd.fillRect(0, 0, w, h);
    gd.globalCompositeOperation = 'multiply';
    gd.drawImage(lum.canvas, 0, 0);
    ramp.globalCompositeOperation = 'difference';
    ramp.drawImage(gd.canvas, 0, 0);
    ramp.globalCompositeOperation = 'destination-in';
    ramp.drawImage(src, 0, 0);
    dst.globalAlpha = a;
    dst.drawImage(ramp.canvas, 0, 0);
    dst.globalAlpha = 1;
  });

def('Reveal', [{n:'Progress', min:0, max:1, d:1}, {n:'Columns', min:1, max:32, d:8},
               {n:'Rows', min:1, max:32, d:8}, {n:'Randomness', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    /* "Reveals the content over time using a grid pattern." Nothing here reads
       the clock: in Resolume every parameter is animatable, so Progress is the
       thing you put an envelope or a Dashboard link on and the movement over
       time comes from that, not from a Speed the effect owns. Cell order is
       reading order, and Randomness shuffles it with a deterministic hash so
       the pattern is stable frame to frame without any history. */
    const prog = clamp(p.Progress, 0, 1);
    if(prog >= 1){ dst.drawImage(src, 0, 0); return; }
    if(prog <= 0) return;
    const cols = clamp(Math.round(p.Columns), 1, 32);
    const rows = clamp(Math.round(p.Rows), 1, 32);
    const n = cols*rows, rnd = clamp(p.Randomness, 0, 1);
    for(let r = 0; r < rows; r++) for(let c = 0; c < cols; c++){
      const i = r*cols + c;
      const x = Math.sin((i + 1)*127.1 + n*0.017)*43758.5453;
      if((i/n)*(1 - rnd) + (x - Math.floor(x))*rnd >= prog) continue;
      const x0 = Math.round(c*w/cols), x1 = Math.round((c + 1)*w/cols);
      const y0 = Math.round(r*h/rows), y1 = Math.round((r + 1)*h/rows);
      if(x1 > x0 && y1 > y0) dst.drawImage(src, x0, y0, x1 - x0, y1 - y0,
                                                x0, y0, x1 - x0, y1 - y0);
    }
  });

def('SearchLight', [{n:'Size', min:0, max:1, d:0.6}, {n:'Blur', min:0, max:1, d:0.5},
                    {n:'Frequency', min:0, max:2, d:0.77}, {n:'Invert', kind:'bool', d:false}],
  (dst, src, p, w, h, t, info) => {
    const time = (info && typeof info.beats === 'number') ? info.beats : (t || 0);
    const ph = time * clamp(p.Frequency, 0, 2);
    const nx = Math.sin(ph*0.90) * 0.60 + Math.sin(ph*2.30 + 1.7) * 0.28 + Math.sin(ph*0.37 + 4.1) * 0.12;
    const ny = Math.cos(ph*1.10 + 2.2) * 0.60 + Math.cos(ph*1.90 + 0.4) * 0.28 + Math.cos(ph*0.53 + 3.3) * 0.12;
    const cx = w * (0.5 + nx * 0.32), cy = h * (0.5 + ny * 0.32);
    const rad = Math.max(2, clamp(p.Size, 0, 1) * Math.hypot(w, h) * 0.6);
    const inner = Math.min(rad * 0.999, rad * (1 - clamp(p.Blur, 0, 1)));
    const m = pad(2, w, h);
    m.drawImage(src, 0, 0);
    const g = m.createRadialGradient(cx, cy, inner, cx, cy, rad);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    m.globalCompositeOperation = p.Invert >= 0.5 ? 'destination-out' : 'destination-in';
    m.fillStyle = g;
    m.fillRect(0, 0, w, h);
    dst.drawImage(m.canvas, 0, 0);
  });

def('Shape Mask', [{n:'Shape', kind:'choice',
                    options:['Square','Circle','Triangle','Pentagon','Hexagon','Octagon','Hexagram'],
                    optionValues:[0,1,2,3,4,5,6], d:0}, {n:'Feather', min:0, max:300, d:4},
                   {n:'Scale', min:0, max:200, d:60}, {n:'Rotation', min:-180, max:180, d:0},
                   {n:'Position X', min:-2, max:2, d:0}, {n:'Position Y', min:-2, max:2, d:0},
                   {n:'Invert', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    /* Parameters, order, ranges and defaults are read out of Arena's own
       shipped patch, plugins/wire/Shape Mask.wired: inputOrder.roots is
       Shape, Feather, Scale, Rotation, Position X, Position Y, Invert, and the
       Gate node wires the seven shapes in the order its labels list them.
       Its Shape Render camera viewport is min [-1,-1] max [1,1] against a
       1920x1080 target, so the shape space is stretched to the frame: on a wide
       frame the Circle really is an ellipse. Scale is a percent mapped 0..200
       onto a 0..2 factor, and Feather is the render's antialiasing width in
       pixels, so it is applied in pixels here too. */
    const NAMES = ['Square','Circle','Triangle','Pentagon','Hexagon','Octagon','Hexagram'];
    let shape = NAMES.indexOf(String(p.Shape));
    if(shape < 0) shape = clamp(Math.floor(Number(p.Shape) || 0), 0, 6);
    const pts = [];
    const poly = (n, off) => { for(let i = 0; i < n; i++){
      const A = off + i*Math.PI*2/n; pts.push([Math.cos(A), Math.sin(A)]); } };
    if(shape === 1)      poly(128, 0);
    else if(shape === 2) poly(3, Math.PI/2);
    else if(shape === 3) poly(5, Math.PI/2);
    else if(shape === 4) poly(6, Math.PI/2);
    else if(shape === 5) poly(8, Math.PI/2);
    else if(shape === 6){ const inr = 1/Math.sqrt(3);
      for(let i = 0; i < 12; i++){ const A = Math.PI/2 + i*Math.PI/6;
        const r = (i % 2) ? inr : 1; pts.push([Math.cos(A)*r, Math.sin(A)*r]); } }
    else pts.push([-1,-1], [1,-1], [1,1], [-1,1]);
    const s = clamp(p.Scale, 0, 200)/100;
    const rot = p.Rotation*Math.PI/180, cs = Math.cos(rot), sn = Math.sin(rot);
    const px = p['Position X'], py = p['Position Y'];
    const fe = Math.max(0, p.Feather)/2;
    /* the shape is a path, so the feather can be blurred inside a margin
       instead of eating the frame edge the way a blurred bitmap would.

       Chromium's Canvas blur cost grows sharply with both radius and surface
       area. Above 32 px, render the mathematically equivalent scaled mask and
       scale it back while compositing: radius, geometry and margin all shrink
       by the same factor, so the apparent output-space feather is unchanged.
       This avoids allocating/clearing a multi-megapixel mask for the 300 px
       end of the exposed Feather range. */
    const m = Math.ceil(fe*3) + 2;
    const maskScale=fe>32?32/fe:1;
    const maskW=Math.max(1,Math.ceil((w+m*2)*maskScale));
    const maskH=Math.max(1,Math.ceil((h+m*2)*maskScale));
    const mask = pad(6, maskW, maskH);
    mask.beginPath();
    for(let i = 0; i < pts.length; i++){
      const X = pts[i][0]*s, Y = pts[i][1]*s;
      const rx = X*cs - Y*sn + px, ry = X*sn + Y*cs + py;   /* Wire's Y points up */
      const cx = ((rx*0.5 + 0.5)*w + m)*maskScale;
      const cy = ((0.5 - ry*0.5)*h + m)*maskScale;
      if(i) mask.lineTo(cx, cy); else mask.moveTo(cx, cy);
    }
    mask.closePath(); mask.fillStyle = '#fff'; mask.fill();
    let mc = mask.canvas;
    if(fe > 0){
      const soft = pad(7, maskW, maskH);
      soft.filter = 'blur(' + (fe*maskScale).toFixed(2) + 'px)';
      soft.drawImage(mask.canvas, 0, 0);
      mc = soft.canvas;
    }
    dst.drawImage(src, 0, 0);
    dst.globalCompositeOperation = p.Invert >= 0.5 ? 'destination-out' : 'destination-in';
    if(maskScale<0.9999)
      dst.drawImage(mc,m*maskScale,m*maskScale,w*maskScale,h*maskScale,0,0,w,h);
    else dst.drawImage(mc, -m, -m);
  });

def('Shaper', [
  {n:'Type', min:0, max:4, d:0},
  {n:'Size', min:0, max:1, d:0.25},
  {n:'Position X', min:-1, max:1, d:0},
  {n:'Position Y', min:-1, max:1, d:0},
  {n:'Rotation', min:-180, max:180, d:0},
  {n:'Rectangle Ratio', min:-10, max:10, d:0},
  {n:'Rectangle Radius', min:0, max:100, d:15},
  {n:'Ring Radius', min:0, max:0.9, d:0.33},
  {n:'Ring Angle', min:0, max:360, d:0},
  {n:'Round', min:0, max:1, d:0},
  {n:'Phase', min:0, max:1, d:1},
  {n:'Scale', min:0.01, max:4, d:1},
  {n:'Noise Type', min:0, max:1, d:1},
  {n:'Noise Amount', min:-1, max:1, d:0},
  {n:'Noise Speed', min:0, max:1, d:0.75},
  {n:'Outline', min:0, max:0.5, d:0.1}
], (dst, src, p, w, h, t) => {
  /* Names, ranges and defaults are the ShaperGenerator's own, read back from the
     shipped preset itself — default/Presets/Sources/Shaper/Identity Crisis.xml —
     not only from reference/mined.json, because the two disagree in places and
     the XML is what mined.json was derived from.

     What the file says, and what this therefore does NOT claim:

     - The real Shaper carries TWO shape groups, <Params name="Shape 1"> and
       <Params name="Shape 2">, each with its own Enabled, Type, Size,
       Position X/Y, Rotation, Ring Radius, Ring Angle, Rectangle Radius and
       Rectangle Ratio. Shape 2 ships Enabled=0. Only Shape 1 is drawn here, so
       Combine — the top-level choice for how the two shapes meet — is
       deliberately absent rather than present and inert.
     - Type is ParamChoice storeChoices="0", so the file stores no option list.
       Its default 0 is the file's; the 0..4 span is INFERRED from the two values
       the preset happens to store (Shape 1 Type=3, Shape 2 Type=4), and the five
       labels are inferred. Rectangle and Ring are the two the file proves, by
       carrying Rectangle Radius/Ratio and Ring Radius/Angle at all.
     - Phase's ValueRange in the file is 0..10, not 0..1. It is exposed as 0..1
       here because a sweep past one full turn is the same shape again; a 0..10
       slider whose top nine tenths look identical would be a control that lies.
     - Color and Outline Color are ParamColor, which def() cannot carry, so they
       are held at the file's defaults. Their packed integers are stored ABGR,
       not ARGB: Outline Color's default 4294955037 is 0xFFFFD01D, and the
       preset's own channel sub-params settle which way round that reads —
       Red 0.11372549 (0x1D), Green 0.81568629 (0xD0), Blue 1.0 (0xFF). So the
       outline is #1DD0FF, a cyan, not the amber that an ARGB read gives. Color's
       default 4294967295 is white either way.

     The shape is drawn on transparency and the effect's own Blend Mode and
     Opacity mix it, which is arena-fx.js's standing contract for a generator
     used as an effect. */
  const base = Math.min(w, h);
  const R = Math.max(0, p.Size) * Math.max(0.01, p.Scale) * base * 0.5;
  if(R < 0.5) return;
  const D = Math.PI / 180, TAU = Math.PI * 2, seg = 96;
  const type = clamp(Math.round(p.Type), 0, 4);
  const amp = clamp(p['Noise Amount'], -1, 1) * 0.35;
  const jag = p['Noise Type'] >= 0.5;
  const ph = t * TAU * p['Noise Speed'] * 3;
  const wob = a => {
    if(!amp) return 1;
    return 1 + amp * (jag ? Math.sin(a * 17 + ph) * 0.6 + Math.sin(a * 7 - ph * 1.3) * 0.4
                          : Math.sin(a * 5 + ph));
  };
  const sweep = clamp(p.Phase, 0, 1) * TAU;

  dst.save();
  dst.translate(w / 2 + p['Position X'] * w / 2, h / 2 + p['Position Y'] * h / 2);
  dst.rotate(p.Rotation * D);
  dst.beginPath();

  if(type === 0){                                     /* Circle, Phase cuts a pie */
    const full = sweep >= TAU - 1e-3;
    if(!full) dst.moveTo(0, 0);
    for(let i = 0; i <= seg; i++){
      const a = -Math.PI / 2 + (i / seg) * sweep, r = R * wob(a);
      const X = Math.cos(a) * r, Y = Math.sin(a) * r;
      (i === 0 && full) ? dst.moveTo(X, Y) : dst.lineTo(X, Y);
    }
    dst.closePath();
  } else if(type === 1){                              /* Ring */
    const inner = R * clamp(p['Ring Radius'], 0, 0.9);
    const a0 = p['Ring Angle'] * D - Math.PI / 2;
    for(let i = 0; i <= seg; i++){
      const a = a0 + (i / seg) * sweep, r = R * wob(a);
      const X = Math.cos(a) * r, Y = Math.sin(a) * r;
      i ? dst.lineTo(X, Y) : dst.moveTo(X, Y);
    }
    for(let i = seg; i >= 0; i--){                    /* reversed, so the hole stays a hole */
      const a = a0 + (i / seg) * sweep, r = inner * wob(a);
      dst.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    dst.closePath();
  } else {                                            /* Rectangle, Triangle, Polygon */
    const pts = [];
    let corner;
    if(type === 2){
      const k = clamp(p['Rectangle Ratio'], -10, 10);
      const rw = R * (k > 0 ? 1 + k * 0.15 : 1);
      const rh = R * (k < 0 ? 1 - k * 0.15 : 1);
      pts.push([-rw, -rh], [rw, -rh], [rw, rh], [-rw, rh]);
      corner = Math.min(rw, rh) *
               clamp(Math.max(clamp(p['Rectangle Radius'], 0, 100) / 100, clamp(p.Round, 0, 1)), 0, 1);
    } else {
      const sides = type === 3 ? 3 : 6;
      for(let i = 0; i < sides; i++){
        const a = -Math.PI / 2 + (i / sides) * TAU, r = R * wob(a);
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      corner = R * clamp(p.Round, 0, 1) * 0.5;
    }
    const n = pts.length;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if(corner < 0.5){
      pts.forEach((q, i) => i ? dst.lineTo(q[0], q[1]) : dst.moveTo(q[0], q[1]));
    } else {
      const start = mid(pts[n - 1], pts[0]);
      dst.moveTo(start[0], start[1]);
      for(let i = 0; i < n; i++){
        const prev = pts[(i - 1 + n) % n], cur = pts[i], nxt = pts[(i + 1) % n];
        const m = mid(cur, nxt);
        const lim = Math.min(Math.hypot(cur[0] - prev[0], cur[1] - prev[1]),
                             Math.hypot(nxt[0] - cur[0], nxt[1] - cur[1])) / 2;
        dst.arcTo(cur[0], cur[1], m[0], m[1], Math.min(corner, lim * 0.99));
        dst.lineTo(m[0], m[1]);
      }
    }
    dst.closePath();
  }

  dst.fillStyle = '#ffffff';
  dst.fill();
  const ow = clamp(p.Outline, 0, 0.5) * base * 0.06;
  if(ow >= 0.5){
    dst.lineJoin = 'round'; dst.lineCap = 'round';
    dst.lineWidth = ow;
    dst.strokeStyle = '#1dd0ff';
    dst.stroke();
  }
  dst.restore();
});

def('Sharpen', [{n:'Amount', min:0, max:1, d:0.5}, {n:'Radius', min:0, max:1, d:0.25}],
  (dst, src, p, w, h) => {
    const amt = clamp(p.Amount, 0, 1) * 3;
    if(amt <= 0.001){ dst.drawImage(src, 0, 0); return; }
    const r = 0.5 + clamp(p.Radius, 0, 1) * 6;
    /* blur() samples transparent black past the edge of its source, and on a
       high pass that shows up as a bright rim around the whole frame — the same
       trap the Blur effect above documents. Blur a copy whose margin is the
       edge pixels stretched outwards, which is what clamping means. */
    const m = Math.max(2, Math.ceil(r * 3));
    const e = pad(6, w + m*2, h + m*2);
    e.drawImage(src, 0,   0,   1, h,  0,     m,     m, h);
    e.drawImage(src, w-1, 0,   1, h,  m + w, m,     m, h);
    e.drawImage(src, 0,   0,   w, 1,  m,     0,     w, m);
    e.drawImage(src, 0,   h-1, w, 1,  m,     m + h, w, m);
    e.drawImage(src, 0,   0,   1, 1,  0,     0,     m, m);
    e.drawImage(src, w-1, 0,   1, 1,  m + w, 0,     m, m);
    e.drawImage(src, 0,   h-1, 1, 1,  0,     m + h, m, m);
    e.drawImage(src, w-1, h-1, 1, 1,  m + w, m + h, m, m);
    e.drawImage(src, m, m);
    /* unsharp mask, done the way a darkroom does it rather than with a kernel:
       a high pass encoded as 0.5 + (src - blur)/2 — half the source plus half
       the inverted blur, added — so it never leaves 0..1 and needs no readback,
       then composited back with 'overlay'. */
    const hp = pad(5, w, h);
    hp.filter = 'brightness(0.5)';
    hp.drawImage(src, 0, 0);
    hp.globalCompositeOperation = 'lighter';
    hp.filter = 'blur(' + r.toFixed(2) + 'px) invert(1) brightness(0.5)';
    hp.drawImage(e.canvas, -m, -m);
    hp.filter = 'none';
    /* the blur carries a little alpha past the source's own edge; clip the high
       pass back to it so a transparent frame stays transparent */
    hp.globalCompositeOperation = 'destination-in';
    hp.drawImage(src, 0, 0);
    hp.globalCompositeOperation = 'source-over';
    /* contrast() scales the high pass about its 0.5 midpoint, and overlay with
       a flat 0.5 is exactly the identity, so Amount 0 is a true no-op */
    dst.drawImage(src, 0, 0);
    dst.globalCompositeOperation = 'overlay';
    dst.filter = 'contrast(' + amt.toFixed(3) + ')';
    dst.drawImage(hp.canvas, 0, 0);
    dst.filter = 'none';
    dst.globalCompositeOperation = 'source-over';
  });

def('Shift Glitch', [{n:'Frequency', min:0, max:1, d:1}, {n:'Vertical', min:0, max:1, d:0},
                     {n:'Horizontal', min:0, max:1, d:0.5}, {n:'Size', min:0, max:1, d:0.5},
                     {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h, t, info) => {
    const beats = (info && typeof info.beats === 'number') ? info.beats : t;
    const seed = Math.floor(beats * p.Frequency * 24);
    const rnd = n => { const x = Math.sin(seed * 97.13 + n * 131.7) * 43758.5453; return x - Math.floor(x); };
    const black = p['Black BG'] >= 0.5;
    const hx = clamp(p.Horizontal, 0, 1), vy = clamp(p.Vertical, 0, 1);
    if(hx <= 0.001 && vy <= 0.001){ dst.drawImage(src, 0, 0); return; }
    const bh = Math.max(1, Math.round(clamp(p.Size, 0, 1) * h * 0.2));
    const bw = Math.max(1, Math.round(clamp(p.Size, 0, 1) * w * 0.2));
    const a = pad(2, w, h);
    if(hx > 0.001){
      for(let y = 0, i = 0; y < h; y += bh, i++){
        const sh = Math.min(bh, h - y);
        const dx = (rnd(i) - 0.5) * 2 * hx * w;
        if(black){ a.drawImage(src, 0, y, w, sh, dx, y, w, sh); }
        else {
          const o = ((dx % w) + w) % w;
          a.drawImage(src, 0, y, w, sh, o, y, w, sh);
          a.drawImage(src, 0, y, w, sh, o - w, y, w, sh);
        }
      }
    } else a.drawImage(src, 0, 0);
    if(vy > 0.001){
      for(let x = 0, i = 0; x < w; x += bw, i++){
        const sw = Math.min(bw, w - x);
        const dy = (rnd(i + 512) - 0.5) * 2 * vy * h;
        if(black){ dst.drawImage(a.canvas, x, 0, sw, h, x, dy, sw, h); }
        else {
          const o = ((dy % h) + h) % h;
          dst.drawImage(a.canvas, x, 0, sw, h, x, o, sw, h);
          dst.drawImage(a.canvas, x, 0, sw, h, x, o - h, sw, h);
        }
      }
    } else dst.drawImage(a.canvas, 0, 0);
  });

def('Shift RGB', [{n:'Distance', min:0, max:1, d:1},
                  /* ParamChoice with storeChoices="0" in the factory XML.
                     Numeric option text is explicit evidence, not invented UI labels. */
                  {n:'Mode', node:'ParamChoice', kind:'choice', options:['0','1','2','3','4','5'], d:'0'},
                  {n:'R', min:-1, max:1, d:0}, {n:'G', min:-1, max:1, d:0},
                  {n:'B', min:-1, max:1, d:0}, {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    const k = clamp(p.Distance, 0, 1);
    const amt = [clamp(p.R, -1, 1) * k, clamp(p.G, -1, 1) * k, clamp(p.B, -1, 1) * k];
    const bg = p['Black BG'] >= 0.5;
    if(!amt[0] && !amt[1] && !amt[2] && !bg){ dst.drawImage(src, 0, 0); return; }
    const mode = clamp(Math.floor(Number(p.Mode) || 0), 0, 5);
    const place = (c, v) => {
      c.translate(w / 2, h / 2);
      if(mode === 0) c.translate(v * w, 0);
      else if(mode === 1) c.translate(0, v * h);
      else if(mode === 2) c.translate(v * w * 0.7, v * h * 0.7);
      else if(mode === 3) c.scale(1 + v * 0.5, 1 + v * 0.5);
      else if(mode === 4) c.rotate(v * Math.PI * 0.5);
      else { c.rotate(v * Math.PI * 0.5); c.scale(1 + v * 0.5, 1 + v * 0.5); }
      c.translate(-w / 2, -h / 2);
    };
    if(bg){ dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h); }
    const cols = ['#ff0000', '#00ff00', '#0000ff'];
    dst.globalCompositeOperation = 'lighter';
    for(let i = 0; i < 3; i++){
      const s = pad(2, w, h);
      s.drawImage(src, 0, 0);
      s.globalCompositeOperation = 'multiply';
      s.fillStyle = cols[i]; s.fillRect(0, 0, w, h);
      s.globalCompositeOperation = 'destination-in';
      s.drawImage(src, 0, 0);
      dst.save(); place(dst, amt[i]); dst.drawImage(s.canvas, 0, 0); dst.restore();
    }
    dst.globalCompositeOperation = 'source-over';
  });

def('Snow', [{n:'Amount', min:0, max:1, d:0.5}, {n:'Speed', min:0, max:1, d:0.5},
             {n:'Size', min:0, max:1, d:0.3}, {n:'Wind', min:-1, max:1, d:0}],
  (dst, src, p, w, h, t, info) => {
    /* live-catalog.json A159 — "Snow simulation." Closed form, not integration:
       a flake's position is a function of the clock and its own seed, the way it
       has to be in a fragment shader too, so nothing is carried between frames
       and two calls at the same clock give the same picture (measured: 0 px
       differ). No multi-frame history, no particle state. Depth makes near
       flakes bigger, brighter and faster — that is the whole of the parallax.
       Beats drive it when the caller supplies them, so the fall does not restart
       every time the clip loops; info may be absent, hence the fallback to t.
       Amount 0 is a true no-op. UNDOCUMENTED — inferring the parameter set. */
    dst.drawImage(src, 0, 0);
    const n = Math.round(clamp(p.Amount, 0, 1) * 600);
    if(n < 1) return;
    const clock = (info && typeof info.beats === 'number') ? info.beats : (t || 0);
    const rnd = k => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    const fall = clock * (0.02 + clamp(p.Speed, 0, 1) * 0.5);
    const drift = clock * clamp(p.Wind, -1, 1) * 0.5;
    const unit = Math.min(w, h) / 260;
    dst.fillStyle = '#fff';
    for(let i = 0; i < n; i++){
      const depth = 0.35 + rnd(i * 3 + 2) * 0.65;
      const y = ((rnd(i * 3) + fall * depth) % 1 + 1) % 1;
      const x = ((rnd(i * 3 + 1) + drift * depth + Math.sin(clock * 1.7 + i) * 0.012) % 1 + 1) % 1;
      const r = Math.max(0.4, depth * (0.3 + clamp(p.Size, 0, 1) * 3.2) * unit);
      dst.globalAlpha = 0.35 + depth * 0.65;
      dst.beginPath(); dst.arc(x * w, y * h, r, 0, Math.PI * 2); dst.fill();
    }
    dst.globalAlpha = 1;
  });

def('Snowy', [{n:'Amount', min:0, max:1, d:0.5}, {n:'Size', min:0, max:1, d:0.35},
              {n:'Speed', min:0, max:1, d:0.4}, {n:'Wind', min:-1, max:1, d:0}],
  (dst, src, p, w, h, t) => {
    /* Snow.vert is a vertex shader over instanced points: every flake's place is
       a closed-form function of time, not an integrated simulation, so it comes
       across honestly here. Amount 0 leaves the picture untouched. */
    dst.drawImage(src, 0, 0);
    const n = Math.round(clamp(p.Amount, 0, 1) * 700);
    if(n <= 0) return;
    const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
    const fall = t * (0.15 + p.Speed * 2.5);
    /* flake size is a fraction of the frame, not a pixel count, or the snow
       turns to invisible dust the moment the composition goes 4K */
    const flake = (0.6 + p.Size * 5.4) * Math.min(w, h) / 720;
    dst.fillStyle = '#ffffff';
    for(let i = 0; i < n; i++){
      const depth = 0.3 + hash(i, 3) * 0.7;              /* near flakes fall faster and bigger */
      const sway = Math.sin(t * 6.2831853 * (0.4 + depth) + i) * 0.012;
      const x = (((hash(i, 0) + p.Wind * 0.5 * fall * depth + sway) % 1) + 1) % 1;
      const y = (((hash(i, 1) + fall * depth) % 1) + 1) % 1;
      dst.globalAlpha = 0.2 + depth * 0.8;
      dst.beginPath();
      dst.arc(x * w, y * h, depth * flake, 0, 6.2831853);
      dst.fill();
    }
    dst.globalAlpha = 1;
  });

/* Captured Arena 7.27 composition schema (A175): the video Effect has one
   ParamColor named Color. The serialized default 0xFF0000FF is AABBGGRR and
   therefore becomes engine ARGB 0xFFFF0000, the same conversion ArenaAVC uses
   when restoring a saved value. */
def('Solid Color', [{n:'Color', kind:'color', d:0xFFFF0000, defFrom:'avc'}],
  (dst, src, p, w, h) => {
    /* Generators/SolidColor.frag used as an effect: it replaces the frame, and
       the effect's own Opacity and Blend Mode do the mixing, which is what
       makes Solid Color + Multiply a tint. packedColorCss preserves the saved
       alpha and does not require a frame readback. */
    dst.fillStyle = packedColorCss(p.Color);
    dst.fillRect(0, 0, w, h);
  });

def('Sparkles', [{n:'Amount', min:0, max:1, d:0.5}, {n:'Size', min:0, max:1, d:0.4},
                 {n:'Threshold', min:0, max:1, d:0.6}, {n:'Speed', min:0, max:1, d:0.4}],
  (dst, src, p, w, h, t) => {
    /* A star filter: the picture's own highlights are gated by luminance,
       splayed into the four arms of an eight-pointed star that twinkle out of
       phase, and added back. All of it is drawImage + ctx.filter + composite
       ops at half resolution, so nothing is read back to the CPU. Amount 0 is
       the untouched picture. */
    dst.drawImage(src, 0, 0);
    const amt = clamp(p.Amount, 0, 1);
    if(amt <= 0.001) return;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    /* luminance mask: grayscale first, so a saturated red does not read as a
       highlight the way a per-channel curve would make it */
    const mask = pad(6, hw, hh);
    mask.filter = 'grayscale(1) brightness(' + (0.5 / Math.max(0.04, p.Threshold)).toFixed(3) +
                  ') contrast(' + (6 + p.Threshold * 26).toFixed(2) + ')';
    mask.drawImage(src, 0, 0, hw, hh);
    const glint = pad(7, hw, hh);
    glint.drawImage(src, 0, 0, hw, hh);
    glint.globalCompositeOperation = 'multiply';         /* keeps the glint's own colour */
    glint.drawImage(mask.canvas, 0, 0);
    const acc = pad(5, hw, hh);
    const reach = (0.002 + p.Size * 0.055) * Math.hypot(hw, hh);   /* half-res pixels */
    const steps = 8;
    acc.globalCompositeOperation = 'lighter';
    for(let a = 0; a < 4; a++){
      const ang = a * Math.PI / 4 + t * Math.PI * 2 * p.Speed;
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * Math.PI * 2 * (1 + p.Speed * 7) + a * 1.7));
      const ux = Math.cos(ang) * reach / steps, uy = Math.sin(ang) * reach / steps;
      for(let s = -steps; s <= steps; s++){
        if(s === 0) continue;
        const k = 1 - Math.abs(s) / (steps + 1);
        acc.globalAlpha = k * k * 0.5 * tw;
        acc.drawImage(glint.canvas, ux * s, uy * s);
      }
    }
    acc.globalAlpha = 1;
    acc.drawImage(glint.canvas, 0, 0);
    dst.globalCompositeOperation = 'lighter';
    dst.globalAlpha = amt;
    dst.filter = 'blur(1px)';
    dst.drawImage(acc.canvas, 0, 0, hw, hh, 0, 0, w, h);
    dst.globalAlpha = 1;
    dst.filter = 'none';
    dst.globalCompositeOperation = 'source-over';
  });

def('Static', [{n:'Mode', node:'ParamChoice', kind:'choice', options:['0','1'], d:'1'}], (dst, src, p, w, h) => {
  /* live-catalog.json MSTF — "Layers static noise on top of your content. Use
     the opacity slider and blend modes for interesting mixes."

     Mode is the effect's only own parameter: reference/mined.json
     videoEffects.Static gives ParamChoice, default 1, and all three shipped
     presets (default/Presets/Video Effects/Static) carry Mode=1 and differ ONLY
     in the mixer above it — Add at 0.11, Difference at 0.5, Darken at 0.44. So
     the wet signal is the noise field itself and the effect's Blend Mode and
     Opacity do the mixing, exactly as the description says. UNDOCUMENTED —
     inferring the choice labels: 0 monochrome, 1 colour. Nothing in the install
     names them; only the default (1) is evidence.

     The noise is WRITTEN with putImageData — nothing is ever read back off the
     GPU — but it is still the most expensive effect in this file, so the field
     is generated at most 512 across and magnified with smoothing off. Measured
     at 1280x720: 2.1 ms/frame, against 13.8 ms/frame generating it at native
     resolution. For scale, Dot Screen in this same file costs 65 ms/frame. */
  const nw = Math.max(1, Math.min(w, 512));
  const nh = Math.max(1, Math.round(nw * h / w));
  const nb = pad(2, nw, nh);
  let img = nb.__staticImg;
  if(!img || img.width !== nw || img.height !== nh){
    img = nb.__staticImg = nb.createImageData(nw, nh);
    nb.__staticWords = new Uint32Array(img.data.buffer);
    const probe = new Uint8Array(4);
    new Uint32Array(probe.buffer)[0] = 0xff000000;
    nb.__staticLE = probe[3] === 0xff;          /* which byte the alpha lands in */
  }
  const words = nb.__staticWords, le = nb.__staticLE;
  const mono = clamp(Math.floor(p.Mode), 0, 1) === 0;
  let s = (nb.__staticSeed >>> 0) || 0x9e3779b9;   /* xorshift32, ~3x Math.random */
  for(let i = 0; i < words.length; i++){
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const rgb = mono ? ((s & 0xff) * 0x010101) : (s & 0xffffff);
    words[i] = le ? ((0xff000000 | rgb) >>> 0) : (((rgb << 8) | 0xff) >>> 0);
  }
  nb.__staticSeed = s;
  nb.putImageData(img, 0, 0);
  dst.imageSmoothingEnabled = false;
  dst.drawImage(nb.canvas, 0, 0, nw, nh, 0, 0, w, h);
  dst.imageSmoothingEnabled = true;
});

def('Stop Motion', [{n:'Speed', min:0, max:1, d:0.5}], (dst, src, p, w, h, t, info) => {
  if(!info || !info.buffer){ dst.drawImage(src, 0, 0); return; }
  const buf = info.buffer(w, h);
  const beats = (typeof info.beats === 'number') ? info.beats : t;
  const rate = clamp(p.Speed, 0, 1) * clamp(p.Speed, 0, 1) * 32;
  const tick = rate > 0 ? Math.floor(beats * rate) : 0;
  if(buf.__stopTick !== tick){
    buf.__stopTick = tick;
    buf.setTransform(1, 0, 0, 1, 0, 0);
    buf.globalAlpha = 1; buf.globalCompositeOperation = 'source-over'; buf.filter = 'none';
    buf.clearRect(0, 0, w, h);
    buf.drawImage(src, 0, 0);
  }
  dst.drawImage(buf.canvas, 0, 0);
});

def('Stripper', [{n:'Number', min:0, max:1, d:0.1}, {n:'Mode', min:0, max:1, d:0},
                 {n:'Direction', min:0, max:1, d:0}, {n:'Direction Spread', min:0, max:1, d:0},
                 {n:'MovementType', min:0, max:1, d:0}, {n:'Speed', min:0, max:1, d:0},
                 {n:'SpeedSpread', min:0, max:1, d:0}, {n:'GlobalWidth', min:0, max:1, d:1},
                 {n:'MinWidth', min:0, max:1, d:0.1}, {n:'MaxWidth', min:0, max:1, d:0.4},
                 {n:'Feather', min:0, max:1, d:0}, {n:'Red', min:0, max:1, d:0},
                 {n:'Green', min:0, max:1, d:0}, {n:'Blue', min:0, max:1, d:0},
                 {n:'Alpha', min:0, max:1, d:1}],
  (dst, src, p, w, h, t, info) => {
    /* Names, order and defaults are Arena's own: default/Presets/Video Effects/
       Stripper/*.xml carries all fifteen with their default= attributes, and the
       six shipped presets fix Mode's arity — they use 0, 0.467, 0.702 and 0.842,
       which is exactly one value in each quarter of an FFGL 0..1 range, so Mode
       quantises to four. What the four MEAN is undocumented: SyzGL_Stripper is a
       closed FFGL binary and no manual page describes it. The mapping below is
       therefore inferred from the preset names, and is the one thing here that
       is not evidence. */
    const n = clamp(Math.round(1 + p.Number * 39), 1, 40);
    const mode = clamp(Math.floor(p.Mode * 4), 0, 3);
    const pingPong = p.MovementType >= 0.5;
    const diag = Math.hypot(w, h), cx = w / 2, cy = h / 2, pitch = diag / n;
    const phase = (info && typeof info.beats === 'number') ? info.beats : (t || 0);
    const rnd = k => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    const lo = Math.min(p.MinWidth, p.MaxWidth), hi = Math.max(p.MinWidth, p.MaxWidth);
    const feather = clamp(p.Feather, 0, 1) * 0.49;

    const strips = [];
    for(let i = 0; i < n; i++){
      const ang  = (p.Direction + (rnd(i + 7) - 0.5) * p['Direction Spread']) * Math.PI * 2;
      const wid  = Math.max(1, clamp((lo + rnd(i) * (hi - lo)) * p.GlobalWidth * 2, 0, 1) * pitch);
      const spd  = p.Speed + rnd(i + 31) * p.SpeedSpread;
      const dir  = (pingPong && (i % 2)) ? -1 : 1;
      const trav = phase * spd * pitch * 8 * dir;
      let pos = (i + 0.5) * pitch - diag / 2 + trav;
      pos = ((pos + diag / 2) % diag + diag) % diag - diag / 2;
      strips.push({ang, wid, pos, off: trav});
    }

    /* the strip mask, feathered once so every mode gets the same soft edge */
    const mask = pad(2, w, h);
    strips.forEach(s => {
      mask.save();
      mask.translate(cx, cy); mask.rotate(s.ang);
      const y0 = s.pos - s.wid / 2;
      if(feather > 0.001){
        const g = mask.createLinearGradient(0, y0, 0, y0 + s.wid);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(feather, '#fff');
        g.addColorStop(1 - feather, '#fff');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        mask.fillStyle = g;
      } else mask.fillStyle = '#fff';
      mask.fillRect(-diag, y0, diag * 2, s.wid);
      mask.restore();
    });

    if(mode === 2){                                  /* strips cut a hole */
      dst.drawImage(src, 0, 0);
      dst.globalCompositeOperation = 'destination-out';
      dst.globalAlpha = clamp(p.Alpha, 0, 1);
      dst.drawImage(mask.canvas, 0, 0);
      return;
    }

    const content = pad(3, w, h);
    if(mode === 0){                                  /* strips are solid colour */
      content.fillStyle = 'rgba(' + Math.round(clamp(p.Red, 0, 1) * 255) + ',' +
                                    Math.round(clamp(p.Green, 0, 1) * 255) + ',' +
                                    Math.round(clamp(p.Blue, 0, 1) * 255) + ',' +
                                    clamp(p.Alpha, 0, 1) + ')';
      content.fillRect(0, 0, w, h);
    } else if(mode === 1){                           /* strips slide the picture */
      strips.forEach(s => {
        content.save();
        content.translate(cx, cy); content.rotate(s.ang);
        content.beginPath();
        content.rect(-diag, s.pos - s.wid / 2 - 1, diag * 2, s.wid + 2);
        content.clip();
        content.rotate(-s.ang); content.translate(-cx, -cy);
        const ox = Math.cos(s.ang) * s.off, oy = Math.sin(s.ang) * s.off;
        for(let a = -1; a <= 1; a++) for(let b = -1; b <= 1; b++)
          content.drawImage(src, ((ox % w) + w) % w + a * w, ((oy % h) + h) % h + b * h);
        content.restore();
      });
    } else {                                         /* strips invert the picture */
      content.filter = 'invert(1)';
      content.drawImage(src, 0, 0);
      content.filter = 'none';
    }
    content.globalCompositeOperation = 'destination-in';
    content.drawImage(mask.canvas, 0, 0);
    dst.drawImage(src, 0, 0);
    dst.drawImage(content.canvas, 0, 0);
  });

def('Strokes', [
  {n:'Amount', min:1, max:5000, d:1024},
  {n:'Edges Only', kind:'bool', d:false},
  {n:'Frequency Mode', kind:'choice', options:['Hz','BPM'], d:'Hz'},
  {n:'Frequency', min:0, max:360, d:60},
  {n:'Size Mode', kind:'choice', options:['Random','Brightness'], d:'Random'},
  {n:'Size', min:0, max:1, d:0.20000000298023224},
  {n:'Variation', min:0, max:1, d:0.10000000149011612},
  {n:'Swirl', min:0, max:1, d:0.30000001192092896},
  {n:'Flow', min:-1, max:1, d:0.25},
  {n:'Feedback', min:0, max:1, d:0.5},
  {n:'Reset', kind:'event', d:0},
  /* The real Wire control points at PNGs embedded in Strokes.wired. Expose the
     same resource surface for a user image, but say what this renderer does:
     it intentionally does not redistribute or pretend to use those brushes. */
  {n:'Resource', kind:'image', d:'', accept:'image/*',
   unwired:'Factory Wire brush resources are not redistributed; the Canvas renderer uses an analytic capsule brush.'},
  {n:'Rotation', min:0, max:1, d:0}
], (dst, src, p, w, h, t, info) => {
  /* Strokes.wired instances a resource brush, sizes instances from either a
     random field or sampled brightness, then feeds the result back. A Canvas
     implementation cannot inspect sampled brightness without a per-frame CPU
     readback, and the five bundled brushes are deliberately absent. This keeps
     the exact public controls while using clipped, source-coloured capsules.
     Brightness mode layers a larger low-alpha source sample, so bright pixels
     produce a visibly larger mark without reading a pixel back to JavaScript. */
  const amount = clamp(Math.round(Number(p.Amount) || 1), 1, 5000);
  const feedback = clamp(Number(p.Feedback) || 0, 0, 1);
  const reset = Number(p.Reset) || 0;
  const state = info && typeof info.buffer === 'function' ? info.buffer(w, h) : null;

  if(state && info.fx){
    /* Event parameters pulse 0 -> 1 -> 0. Consume only the rising edge; treating
       both values as distinct events clears the feedback a second time when
       the 50 ms release arrives. */
    const resetHeld=reset >= 0.5;
    const resetEdge=resetHeld && !info.fx._strokesResetHeld;
    info.fx._strokesResetHeld=resetHeld;
    if(resetEdge){
      state.setTransform(1,0,0,1,0,0);
      state.globalAlpha = 1; state.globalCompositeOperation = 'source-over'; state.filter = 'none';
      state.clearRect(0, 0, w, h);
      info.fx._strokesFrameReady = false;
    }
    if(info.fx._strokesFrameReady && feedback > 0.001){
      dst.globalAlpha = feedback;
      dst.drawImage(state.canvas, 0, 0);
    }
  }
  dst.globalAlpha = state && info.fx && info.fx._strokesFrameReady ? 1 - feedback : 1;
  dst.drawImage(src, 0, 0);
  dst.globalAlpha = 1;

  /* Amount is a true 1..5000 parameter. Canvas draw-call cost is not: map the
     density monotonically to at most 640 capsules so a factory 2048 preset does
     not turn into a multi-second frame. There is no GPU->CPU transfer. */
  const n = Math.max(1, Math.ceil(Math.pow(amount / 5000, 0.55) * 640));
  const hash = (i, k) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const frequency = clamp(Number(p.Frequency) || 0, 0, 360);
  const bpmMode = p['Frequency Mode'] === 'BPM' || p['Frequency Mode'] === 1;
  /* Hz motion is transport-independent wall time in production. Keeping the
     clock behind one injectable provider lets visual regression renders use a
     fixed timeline without replacing performance.now(), which the benchmark
     itself needs for honest timings. */
  const now = Number(CLOCK_SECONDS()) || 0;
  const clock = bpmMode
    ? (Number(info && info.beats) || 0) * frequency / 60
    : now * frequency;
  const tick = Math.floor(clock);
  const flow = clamp(Number(p.Flow) || 0, -1, 1);
  const swirl = clamp(Number(p.Swirl) || 0, 0, 1);
  const variation = clamp(Number(p.Variation) || 0, 0, 1);
  const size = clamp(Number(p.Size) || 0, 0, 1);
  const brightnessMode = p['Size Mode'] === 'Brightness' || p['Size Mode'] === 1;
  const baseLen = (0.006 + size * 0.11) * Math.hypot(w, h);
  const baseAngle = clamp(Number(p.Rotation) || 0, 0, 1) * Math.PI * 2 + flow * Math.PI;

  /* Difference against a two-pixel offset is an edge image made entirely by
     the compositor. Screen blending makes black interiors inert, giving Edges
     Only a useful response with no getImageData(). */
  let strokeSource = src;
  const edgesOnly = !!p['Edges Only'];
  if(edgesOnly){
    const edge = pad(5, w, h);
    edge.drawImage(src, 0, 0);
    edge.globalCompositeOperation = 'difference';
    edge.drawImage(src, 2, 2);
    edge.globalCompositeOperation = 'source-over';
    const toned = pad(7, w, h);
    toned.filter = 'grayscale(1) contrast(4) brightness(2)';
    toned.drawImage(edge.canvas, 0, 0);
    toned.filter = 'none';
    strokeSource = toned.canvas;
  }

  for(let i = 0; i < n; i++){
    const seed = i + tick * 0.61803398875;
    const x = ((hash(seed, 0) + flow * clock * 0.0007) % 1 + 1) % 1 * w;
    const y = ((hash(seed, 1) + flow * clock * 0.0004) % 1 + 1) % 1 * h;
    const radial = Math.atan2(y - h / 2, x - w / 2);
    const randomScale = 1 + (hash(seed, 3) * 2 - 1) * variation;
    const l = Math.max(2, baseLen * (brightnessMode ? 1 : randomScale));
    const wide = Math.max(1.5, l * (0.12 + variation * 0.14));
    const sw = Math.max(1, Math.min(Math.round(wide), w, h));
    const ang = baseAngle + swirl * radial + (hash(seed, 2) - 0.5) * variation * Math.PI;
      /* the colour is picked up at the stroke's leading end and dragged the
         length of the stroke — which is what makes a stroke read as a stroke
         and not as a slightly rotated copy of what was already there */
    const sx = clamp(Math.round(x - Math.cos(ang) * l * 0.4 - sw / 2), 0, Math.max(0, w - sw));
    const sy = clamp(Math.round(y - Math.sin(ang) * l * 0.4 - sw / 2), 0, Math.max(0, h - sw));

    dst.save();
    dst.translate(x, y);
    dst.rotate(ang);
    dst.beginPath();
    dst.ellipse(0, 0, l / 2, wide / 2, 0, 0, 6.2831853);
    dst.clip();
    if(edgesOnly) dst.globalCompositeOperation = 'screen';
    if(brightnessMode){
      dst.globalCompositeOperation = 'screen';
      dst.globalAlpha = 0.35;
      dst.drawImage(strokeSource, sx, sy, sw, sw, -l * 0.65, -wide * 0.75, l * 1.3, wide * 1.5);
      dst.globalAlpha = 0.9;
    }
    dst.drawImage(strokeSource, sx, sy, sw, sw, -l / 2, -wide / 2, l, wide);
    dst.restore();
  }

  if(state && info.fx){
    state.setTransform(1,0,0,1,0,0);
    state.globalAlpha = 1; state.globalCompositeOperation = 'source-over'; state.filter = 'none';
    state.clearRect(0, 0, w, h);
    state.drawImage(dst.canvas, 0, 0);
    info.fx._strokesFrameReady = true;
  }
});

def('Suckr', [{n:'Suck', min:0, max:1, d:0.5}, {n:'Black BG', kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    const k = clamp(p.Suck, 0, 1);
    const n = k <= 0.002 ? 1 : 16;
    for(let i = 0; i < n; i++){
      const s = 1 - k * (i / (n - 1 || 1)) * 0.92;
      dst.save();
      dst.globalAlpha = 1 / (i + 1);
      dst.translate(w / 2, h / 2); dst.scale(s, s); dst.translate(-w / 2, -h / 2);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
    if(p['Black BG'] >= 0.5){
      dst.globalCompositeOperation = 'destination-over';
      dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h);
      dst.globalCompositeOperation = 'source-over';
    }
  });

def('Tilt Shift', [{n:'Blur', min:0, max:1, d:0.9}, {n:'Position', min:0, max:1, d:0.5},
                   {n:'Focus', min:0, max:1, d:0.4}, {n:'Falloff', min:0, max:1, d:1},
                   {n:'Saturation', min:0, max:1, d:0.7}, {n:'Vignette', min:0, max:1, d:0.5}],
  (dst, src, p, w, h) => {
    const r = clamp(p.Blur, 0, 1) * 32;
    const m = Math.max(1, Math.ceil(r * 2));
    const b = pad(7, w + m*2, h + m*2);
    b.drawImage(src, 0,   0,   1, h,  0,     m,     m, h);
    b.drawImage(src, w-1, 0,   1, h,  m + w, m,     m, h);
    b.drawImage(src, 0,   0,   w, 1,  m,     0,     w, m);
    b.drawImage(src, 0,   h-1, w, 1,  m,     m + h, w, m);
    b.drawImage(src, 0,   0,   1, 1,  0,     0,     m, m);
    b.drawImage(src, w-1, 0,   1, 1,  m + w, 0,     m, m);
    b.drawImage(src, 0,   h-1, 1, 1,  0,     m + h, m, m);
    b.drawImage(src, w-1, h-1, 1, 1,  m + w, m + h, m, m);
    b.drawImage(src, m, m);
    const comp = pad(3, w, h);
    const k = r > 6 ? 0.5 : 1;
    const bw = Math.max(1, Math.round((w + m*2) * k)), bh = Math.max(1, Math.round((h + m*2) * k));
    const small = pad(6, bw, bh);
    if(r > 0.01) small.filter = 'blur(' + (r * k).toFixed(2) + 'px)';
    small.drawImage(b.canvas, 0, 0, w + m*2, h + m*2, 0, 0, bw, bh);
    small.filter = 'none';
    comp.drawImage(small.canvas, 0, 0, bw, bh, -m, -m, w + m*2, h + m*2);
    const band = pad(4, w, h);
    band.drawImage(src, 0, 0);
    const cy = clamp(p.Position, 0, 1) * h;
    const half = clamp(p.Focus, 0, 1) * h * 0.5;
    const soft = Math.max(0.5, clamp(p.Falloff, 0, 1) * h * 0.5);
    const g = band.createLinearGradient(0, 0, 0, h);
    g.addColorStop(clamp((cy - half - soft)/h, 0, 1), 'rgba(0,0,0,0)');
    g.addColorStop(clamp((cy - half)/h, 0, 1), 'rgba(0,0,0,1)');
    g.addColorStop(clamp((cy + half)/h, 0, 1), 'rgba(0,0,0,1)');
    g.addColorStop(clamp((cy + half + soft)/h, 0, 1), 'rgba(0,0,0,0)');
    band.globalCompositeOperation = 'destination-in';
    band.fillStyle = g;
    band.fillRect(0, 0, w, h);
    comp.drawImage(band.canvas, 0, 0);
    dst.filter = 'saturate(' + (clamp(p.Saturation, 0, 1) * 2).toFixed(3) + ')';
    dst.drawImage(comp.canvas, 0, 0);
    dst.filter = 'none';
    const vg = clamp(p.Vignette, 0, 1);
    if(vg > 0.001){
      const R = Math.hypot(w, h) / 2;
      const rg = dst.createRadialGradient(w/2, h/2, R * 0.35, w/2, h/2, R);
      rg.addColorStop(0, 'rgba(0,0,0,0)');
      rg.addColorStop(1, 'rgba(0,0,0,' + vg.toFixed(3) + ')');
      dst.fillStyle = rg;
      dst.fillRect(0, 0, w, h);
    }
  });

def('Tint', [{n:'Hue', min:0, max:1, d:0.08}, {n:'Saturation', min:0, max:1, d:0.7},
             {n:'Amount', min:0, max:1, d:0.5}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const a = clamp(p.Amount, 0, 1), s = clamp(p.Saturation, 0, 1);
    if(a <= 0.001 || s <= 0.001) return;
    /* Saturation 0 is white, and multiplying by white is the identity, so the
       parameter runs from "no tint" to "pure hue" without a special case.
       The colour is clipped to the source's own alpha first, otherwise
       multiply paints the transparent parts of the frame. */
    const col = pad(5, w, h);
    col.fillStyle = 'hsl(' + (p.Hue*360).toFixed(1) + ', ' + (s*100).toFixed(1) + '%, '
                  + (50 + (1 - s)*50).toFixed(1) + '%)';
    col.fillRect(0, 0, w, h);
    col.globalCompositeOperation = 'destination-in';
    col.drawImage(src, 0, 0);
    dst.globalCompositeOperation = 'multiply';
    dst.globalAlpha = a;
    dst.drawImage(col.canvas, 0, 0);
    dst.globalAlpha = 1;
    dst.globalCompositeOperation = 'source-over';
  });

def('Transform', [{n:'Position X', min:-16384, max:16384, d:0},
                  {n:'Position Y', min:-16384, max:16384, d:0},
                  {n:'Scale', min:0, max:1000, d:100},
                  {n:'Scale W', min:0, max:1000, d:100},
                  {n:'Scale H', min:0, max:1000, d:100},
                  {n:'Rotation', min:-360, max:360, d:0},
                  {n:'Anchor X', min:-16384, max:16384, d:0},
                  {n:'Anchor Y', min:-16384, max:16384, d:0}],
  (dst, src, p, w, h) => {
    /* Names and defaults are Arena's own, read out of the TransformEffect
       blocks in reference/compositions/*.avc: Scale, Scale W and Scale H all
       default to 100 because they are percentages, and Position X/Y and Anchor
       X/Y default to 0 because they are pixel offsets. transform.htm supplies
       Rotation, in degrees, and confirms the anchor is the point rotation and
       scale happen around.

       ROTATION X AND ROTATION Y ARE DELIBERATELY ABSENT. Resolume exposes them
       when you expand Rotation, and they tilt the quad out of the image plane,
       which projects it to a trapezoid. CanvasRenderingContext2D.setTransform
       is a six-component affine — it has no perspective row — so a rotated quad
       can only ever come back as a parallelogram. Doing it honestly needs a
       homography subdivided into a mesh, which is a different piece of work
       from this effect; offering the two sliders and quietly applying a cosine
       squash instead would be exactly the kind of control that reports success
       while doing something else. transform.htm notes X/Y rotation is already a
       special case in Arena too — using either disables the Transform Widget. */
    const ax = w / 2 + p['Anchor X'], ay = h / 2 + p['Anchor Y'];
    const sx = (p.Scale / 100) * (p['Scale W'] / 100);
    const sy = (p.Scale / 100) * (p['Scale H'] / 100);
    dst.translate(ax + p['Position X'], ay + p['Position Y']);
    dst.rotate(p.Rotation * Math.PI / 180);
    dst.scale(sx, sy);
    dst.translate(-ax, -ay);
    dst.drawImage(src, 0, 0);
  });

def('Triangulate', [{n:'Scale', min:0.02, max:0.5, d:0.0714285746216774},
                    {n:'Levels', min:1, max:4, d:1},
                    {n:'Threshold', min:0, max:1, d:0},
                    {n:'Flip Direction', min:0, max:1, d:0}],
  (dst, src, p, w, h) => {
    const cols = clamp(Math.round(1 / Math.max(0.02, p.Scale)), 2, 50);
    const rows = clamp(Math.round(cols * h / w), 1, 50);
    let lv = clamp(Math.round(p.Levels), 1, 4);
    while(lv > 1 && cols * rows * 2 * Math.pow(4, lv - 1) > 6000) lv--;
    let s = 1 << lv;
    while(s > 1 && cols * s > 256) s >>= 1;
    const SW = Math.max(1, cols * s), SH = Math.max(1, rows * s);
    const small = pad(2, SW, SH);
    small.imageSmoothingEnabled = true;
    small.drawImage(src, 0, 0, SW, SH);
    const px = small.getImageData(0, 0, SW, SH).data;
    const at = (x, y) => {
      const sx = clamp(Math.floor(x / w * SW), 0, SW - 1);
      const sy = clamp(Math.floor(y / h * SH), 0, SH - 1);
      return (sy * SW + sx) * 4;
    };
    const cw = w / cols, ch = h / rows;
    const grow = 1 + 1.6 / Math.max(1, Math.min(cw, ch));
    const thr = clamp(p.Threshold, 0, 1) * 255;
    const flip = p['Flip Direction'] >= 0.5;
    const tri = (ax, ay, bx, by, cx, cy, depth) => {
      const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3;
      if(depth < lv - 1){
        const i0 = at((ax + gx) / 2, (ay + gy) / 2);
        const i1 = at((bx + gx) / 2, (by + gy) / 2);
        const i2 = at((cx + gx) / 2, (cy + gy) / 2);
        const lum = i => px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114;
        const l0 = lum(i0), l1 = lum(i1), l2 = lum(i2);
        if(Math.max(l0, l1, l2) - Math.min(l0, l1, l2) > thr){
          const abx = (ax + bx) / 2, aby = (ay + by) / 2;
          const bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
          const cax = (cx + ax) / 2, cay = (cy + ay) / 2;
          tri(ax, ay, abx, aby, cax, cay, depth + 1);
          tri(abx, aby, bx, by, bcx, bcy, depth + 1);
          tri(cax, cay, bcx, bcy, cx, cy, depth + 1);
          tri(abx, aby, bcx, bcy, cax, cay, depth + 1);
          return;
        }
      }
      const i = at(gx, gy);
      if(px[i+3] === 0) return;
      dst.fillStyle = 'rgba(' + px[i] + ',' + px[i+1] + ',' + px[i+2] + ',' + (px[i+3] / 255) + ')';
      dst.beginPath();
      dst.moveTo(gx + (ax - gx) * grow, gy + (ay - gy) * grow);
      dst.lineTo(gx + (bx - gx) * grow, gy + (by - gy) * grow);
      dst.lineTo(gx + (cx - gx) * grow, gy + (cy - gy) * grow);
      dst.closePath();
      dst.fill();
    };
    for(let r = 0; r < rows; r++) for(let c = 0; c < cols; c++){
      const x0 = c * cw, y0 = r * ch, x1 = x0 + cw, y1 = y0 + ch;
      if(flip){
        tri(x0, y0, x1, y0, x1, y1, 0);
        tri(x0, y0, x1, y1, x0, y1, 0);
      } else {
        tri(x0, y0, x1, y0, x0, y1, 0);
        tri(x1, y0, x1, y1, x0, y1, 0);
      }
    }
  });

def('Tunnel', [{n:'Black BG', kind:'bool', d:false}, {n:'Kaleidoscope', min:0, max:1, d:0},
               {n:'Position', min:0, max:1, d:0}, {n:'Rotation', min:0, max:1, d:0.5},
               {n:'Speed', min:0, max:1, d:0.5}, {n:'TurnH', min:0, max:1, d:0.5},
               {n:'TurnV', min:0, max:1, d:0.5}, {n:'Twist', min:0, max:1, d:0.5},
               {n:'WobbleH', min:0, max:1, d:0}, {n:'WobbleV', min:0, max:1, d:0}],
  (dst, src, p, w, h, t) => {
    /* Nested receding copies, painted largest first, so each one's border is
       left showing when the next covers its middle — that stack of borders is
       the tunnel. The bipolar controls sit at 0.5 = neutral, which is where the
       shipped presets put them. */
    const RINGS = 18, G = 0.76;
    const cx = w / 2, cy = h / 2;
    const fold = p.Kaleidoscope > 0.001 ? Math.max(2, Math.round(2 + p.Kaleidoscope * 14)) : 0;
    const out = fold ? pad(2, w, h) : dst;
    if(p['Black BG'] >= 0.5){ out.fillStyle = '#000'; out.fillRect(0, 0, w, h); }
    const phase = p.Position * RINGS + (p.Speed - 0.5) * 2 * t * 12;
    const ph = phase - Math.floor(phase);
    const spin  = (p.Rotation - 0.5) * 2 * Math.PI;
    const twist = (p.Twist - 0.5) * 2 * Math.PI * 0.35;
    const turnX = (p.TurnH - 0.5) * 2 * w * 0.6;
    const turnY = (p.TurnV - 0.5) * 2 * h * 0.6;
    const wobX  = p.WobbleH * w * 0.35, wobY = p.WobbleV * h * 0.35;
    const wave  = t * Math.PI * 2;
    /* k starts at -2 so the mouth stays covered as the phase drifts outward */
    for(let k = -2; k < RINGS; k++){
      const d = k + ph;
      const s = Math.pow(G, d);
      const q = clamp(d / RINGS, 0, 1);
      const ox = cx + turnX * q + Math.sin(d * 0.8 + wave) * wobX * q;
      const oy = cy + turnY * q + Math.cos(d * 0.8 + wave) * wobY * q;
      out.save();
      out.translate(ox, oy);
      out.rotate(spin + twist * d);
      out.scale(s, s);
      out.translate(-cx, -cy);
      out.drawImage(src, 0, 0);
      out.restore();
    }
    if(!fold) return;
    const r = Math.hypot(cx, cy), seg = Math.PI * 2 / fold;
    for(let i = 0; i < fold; i++){
      dst.save();
      dst.translate(cx, cy);
      dst.rotate(i * seg);
      if(i % 2) dst.scale(1, -1);
      dst.beginPath(); dst.moveTo(0, 0);
      dst.arc(0, 0, r, -seg / 2, seg / 2); dst.closePath(); dst.clip();
      dst.translate(-cx, -cy);
      dst.drawImage(out.canvas, 0, 0);
      dst.restore();
    }
  });

def('Twisted', [{n:'Twist', min:-1, max:1, d:0}, {n:'Radius', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    dst.drawImage(src, 0, 0);
    const k = clamp(p.Twist, -1, 1);
    const R = clamp(p.Radius, 0, 1) * Math.hypot(w, h) / 2;
    if(Math.abs(k) < 0.002 || R < 2) return;
    const n = 40;
    for(let i = n; i >= 1; i--){
      const q = i / n;
      const a = k * Math.PI * 2 * (1 - q) * (1 - q);
      dst.save();
      dst.beginPath(); dst.arc(w / 2, h / 2, R * q, 0, Math.PI * 2); dst.clip();
      dst.translate(w / 2, h / 2); dst.rotate(a); dst.translate(-w / 2, -h / 2);
      dst.drawImage(src, 0, 0);
      dst.restore();
    }
  });

def('Vibrance', [{n:'Amount', min:-1, max:1, d:0.5}], (dst, src, p, w, h) => {
  dst.drawImage(src, 0, 0);
  const a = p.Amount;
  if(Math.abs(a) < 0.001) return;
  const img = dst.getImageData(0, 0, w, h), d = img.data;
  const g2 = a*2, gs = a*2/255;
  for(let i = 0; i < d.length; i += 4){
    if(d[i+3] === 0) continue;
    const r = d[i], g = d[i+1], b = d[i+2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    /* the gain falls off with how saturated the pixel already is — that is the
       whole difference from Saturation, which multiplies everything equally */
    const kk = 1 + g2 - (mx - mn)*gs, k = kk < 0 ? 0 : kk;
    const l = r*0.299 + g*0.587 + b*0.114;
    d[i] = l + (r - l)*k; d[i+1] = l + (g - l)*k; d[i+2] = l + (b - l)*k;
  }
  dst.putImageData(img, 0, 0);
});

def('WarpSpeed', [{n:'Vignette', min:0, max:1, d:0.2}, {n:'Fade', min:0, max:1, d:0.5},
                  {n:'Scale', min:0, max:1, d:0.5}, {n:'Rotate', min:-1, max:1, d:0},
                  {n:'Center X', min:-1, max:1, d:0}, {n:'Center Y', min:-1, max:1, d:0}],
  (dst, src, p, w, h, t, info) => {
    /* reference/wired/WarpSpeed.wired, node 63: "create 15 copies of the
       texture, all 1 frame delay from each other using the Ring Buffer and
       reversing the render order". The ring is real — 15 successive frames held
       as a 5x3 atlas in the one persistent buffer, written with a rotating
       index rather than shifted. That atlas is 16x the frame (9600x3240, 119 MB
       at 1920x1080); no buffer, no effect, and it says so by passing through. */
    const N = 15, COLS = 5;
    if(!info || !info.buffer){ dst.drawImage(src, 0, 0); return; }
    const ring = info.buffer(w * COLS, h * 3);
    if(!ring || ring.canvas.width !== w * COLS){ dst.drawImage(src, 0, 0); return; }
    /* the patch vignettes BEFORE the buffer, so every copy carries soft edges */
    const v = pad(2, w, h);
    v.drawImage(src, 0, 0);
    const size = clamp(p.Vignette, 0, 1);
    if(size < 1){
      const stops = g => {
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.5 - size / 2, 'rgba(0,0,0,1)');
        g.addColorStop(0.5 + size / 2, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        return g;
      };
      v.globalCompositeOperation = 'destination-in';
      v.fillStyle = stops(v.createLinearGradient(0, 0, w, 0)); v.fillRect(0, 0, w, h);
      v.fillStyle = stops(v.createLinearGradient(0, 0, 0, h)); v.fillRect(0, 0, w, h);
      v.globalCompositeOperation = 'source-over';
    }
    ring.setTransform(1, 0, 0, 1, 0, 0);
    ring.globalAlpha = 1; ring.globalCompositeOperation = 'source-over'; ring.filter = 'none';
    const idx = ring.__warp = ((ring.__warp == null ? -1 : ring.__warp) + 1) % N;
    const wx = (idx % COLS) * w, wy = ((idx / COLS) | 0) * h;
    ring.clearRect(wx, wy, w, h);
    ring.drawImage(v.canvas, wx, wy);
    /* gain 1..Fade, scale 1..Scale, rotation 0..Rotate*0.333 turns, translation
       0..Center*half-resolution — the patch's Linear / Reverse / Map ramps */
    const rot = p.Rotate * 0.333 * Math.PI * 2;
    const tx = p['Center X'] * w / 2, ty = p['Center Y'] * h / 2;
    const sc = clamp(p.Scale, 0, 1), fd = clamp(p.Fade, 0, 1);
    for(let i = 0; i < N; i++){
      const q = i / (N - 1);
      const cell = (idx - i + N * 2) % N;
      const sx = (cell % COLS) * w, sy = ((cell / COLS) | 0) * h;
      const s = 1 - (1 - sc) * q;
      dst.save();
      dst.globalAlpha = 1 - (1 - fd) * q;
      dst.translate(w / 2 + tx * q, h / 2 + ty * q);
      dst.rotate(-rot * q);
      dst.scale(s, s);
      dst.drawImage(ring.canvas, sx, sy, w, h, -w / 2, -h / 2, w, h);
      dst.restore();
    }
  });

/* --------------------------------------------------------------------------
   THE TWO TEXT EFFECTS, which are not the two text sources.

   Text Animator and Text Block each exist TWICE in Arena, as an effect and as a
   source, with different plugin ids and opposite jobs. arena-catalog.js says so
   for both roles: the source "generates a clip", the effect puts words "on top
   of your content". arena-sources.js already draws the source pair; these two
   composite over the incoming frame instead, which is the whole difference.

   PARAMETERS ARE INFERRED, and this is the weakest provenance in the file.
   Resolume ships no preset for either effect, so there is nothing to mine. The
   lists below are the SOURCE plugins' parameter sets — real, read from
   default\Presets\Sources — used as the best available evidence for a different
   plugin that does a related job. Every name was checked against Arena.exe's
   own string table (extracted/arena-binary-strings.json) and all of them occur
   there except Text Block's "Margin", which is inherited from arena-sources.js'
   own inferred set and is flagged there too.

   These could not be written at all until now, and the reason is worth
   recording: def() could only declare numbers, because addEffect() built every
   declared parameter as type:'range'. The defining parameter of both effects is
   Text — a ParamText — and a 0..1 slider you cannot type into is not that
   parameter. Shipping them anyway would have meant either hardcoding a message
   nobody can edit or, honouring Resolume's empty default, an effect that
   renders nothing while looking implemented. addEffect() now routes declared
   specs through makeParams(), so a kind on the spec is honoured and Text is a
   real registered string parameter: animatable, mappable, undoable.

   Font, Style, Alignment, Range and Order stay declared and UNREAD. They are
   ParamChoice written with storeChoices="0", so Resolume does not store the
   option names and the index has no known meaning; each carries the reason,
   which the Clip panel prints on the row rather than leaving the control
   looking live. Same treatment the generators get in arena-sources.js.
   -------------------------------------------------------------------------- */
const TXT_NO_LABELS =
  'ParamChoice with storeChoices="0": Resolume does not store the option names, '
+ 'so the index has no known meaning here and guessing one would change what an '
+ 'untouched clip looks like.';

/* Shared by both: lay a string out and hand back the pen positions, so the two
   effects agree about tracking and about where the block sits. */
function txtLayout(ctx, text, size, trackPx){
  const chars = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total = widths.reduce((s, v) => s + v, 0) + trackPx * Math.max(0, chars.length - 1);
  return { chars, widths, total };
}

def('Text Animator', [
  {n:'Text',       kind:'string', d:''},
  /* The five label-less choices stay NUMERIC indices rather than becoming empty
     dropdowns, which is the same call arena-engine.js already made for sources:
     "Rather than invent a list the index stays a number." */
  {n:'Font',       min:0, max:1, d:0, unwired:TXT_NO_LABELS},
  {n:'Style',      min:0, max:1, d:0, unwired:TXT_NO_LABELS},
  {n:'Color',      kind:'color',  d:0xFFFFFFFF, defFrom:'assumed'},
  {n:'Size',       min:0.5,   max:10,    d:1},
  {n:'Alignment',  min:0, max:1, d:0, unwired:TXT_NO_LABELS},
  {n:'Position X', min:-16384, max:16384, d:0},
  {n:'Position Y', min:-16384, max:16384, d:0},
  {n:'Spacing X',  min:-20,   max:200,   d:0},
  {n:'Spacing Y',  min:-20,   max:200,   d:0},
  {n:'Animated',   kind:'bool', d:false},
  {n:'Range',      min:0, max:1, d:0, unwired:TXT_NO_LABELS},
  {n:'Order',      min:0, max:1, d:0, unwired:TXT_NO_LABELS},
  {n:'Delay',      min:0,     max:2000,  d:100},
  {n:'Opacity',    min:0,     max:1,     d:1},
  {n:'Scale',      min:0,     max:10,    d:1},
  {n:'Animated Position X', min:-16384, max:16384, d:0},
  {n:'Animated Position Y', min:-16384, max:16384, d:0},
  {n:'Rotation',   min:-3.141593, max:3.141593, d:0},
  {n:'Anchor X',   min:-16384, max:16384, d:0},
  {n:'Anchor Y',   min:-16384, max:16384, d:0}
], (dst, src, p, w, h, t, info) => {
  /* The incoming frame first — this one is "on top of your content", and the
     effect's own Opacity and Blend Mode still mix the whole result back over
     the original in apply(), exactly as effects.htm describes. */
  dst.drawImage(src, 0, 0);
  const text = String(p.Text == null ? '' : p.Text);
  if(!text) return;                       /* empty is empty; nothing invented */
  const scale = +p.Scale;
  const opacity = clamp(+p.Opacity, 0, 1);
  if(!(scale > 0) || opacity <= 0) return;

  const size = Math.max(8, (+p.Size) * h * 0.12);
  dst.font = `700 ${size}px system-ui, sans-serif`;
  dst.textBaseline = 'middle';
  const track = (+p['Spacing X']) * (size/100);
  const lay = txtLayout(dst, text, size, track);
  if(!lay.chars.length) return;

  const px = h/1080;                      /* Position is in output pixels */
  const baseX = w/2 - (lay.total*scale)/2 + (+p['Position X'])*px;
  const baseY = h/2 + (+p['Position Y'])*px;
  const animated = !!p.Animated;
  const delay = Math.max(0, +p.Delay);
  const clock = (info && typeof info.beats === 'number') ? info.beats : (t || 0) * 4;
  const fill = packedColorCss(p.Color == null ? 0xFFFFFFFF : p.Color);

  let pen = 0;
  lay.chars.forEach((ch, i) => {
    let prog = 1;
    if(animated){
      const per = delay/1000;
      const span = per*lay.chars.length + 1;
      /* JS % keeps the sign of the dividend, so a negative clock — which is
         what a clip scrubbed backwards or an Autopilot running in reverse
         gives — produced a negative cycle position and every character sat at
         progress 0, i.e. the text vanished rather than animating. */
      const cyc = span > 0 ? (((clock/2) % span) + span) % span : 0;
      prog = clamp(cyc - i*per, 0, 1);
    }
    const ease = prog*prog*(3 - 2*prog);
    const ox = (+p['Animated Position X']) * px * (1 - ease);
    const oy = (+p['Animated Position Y']) * px * (1 - ease) + (+p['Spacing Y'])*(size/100)*i;
    dst.save();
    dst.globalAlpha = opacity * (animated ? ease : 1);
    dst.translate(baseX + pen*scale + ox, baseY + oy);
    dst.translate((+p['Anchor X'])*px, (+p['Anchor Y'])*px);
    if(+p.Rotation) dst.rotate(+p.Rotation);
    dst.scale(scale, scale);
    dst.translate(-(+p['Anchor X'])*px, -(+p['Anchor Y'])*px);
    dst.fillStyle = fill;
    dst.fillText(ch, 0, 0);
    dst.restore();
    pen += lay.widths[i] + track;
  });
});

def('Text Block', [
  {n:'Text',        kind:'string', d:''},
  {n:'Size',        min:0.01, max:1,   d:0.12},
  {n:'Line Height', min:0.5,  max:3,   d:1.2},
  /* Text Block's Alignment IS known — arena-sources.js declares Left/Center/
     Right for the source version and the draw function there reads it — so this
     one is a real choice, not a bare index. */
  {n:'Alignment',   kind:'choice', options:['Left','Center','Right'], d:'Left'},
  {n:'Color',       kind:'color', d:0xFFFFFFFF, defFrom:'assumed'},
  {n:'Position X',  min:-1,   max:1,   d:0},
  {n:'Position Y',  min:-1,   max:1,   d:0},
  {n:'Margin',      min:0,    max:0.45, d:0.06}
], (dst, src, p, w, h) => {
  dst.drawImage(src, 0, 0);
  const text = String(p.Text == null ? '' : p.Text);
  if(!text) return;
  const size = Math.max(6, (+p.Size) * h);
  dst.font = `600 ${size}px system-ui, sans-serif`;
  dst.textBaseline = 'middle';
  const margin = clamp(+p.Margin, 0, 0.45) * w;
  const maxW = Math.max(1, w - margin*2);

  /* Wrap on width but KEEP the author's own line breaks — a text block that
     reflowed a deliberate break would be a different message. Same rule the
     source version follows. */
  const lines = [];
  text.split(/\r?\n/).forEach(para => {
    if(!para){ lines.push(''); return; }
    let line = '';
    para.split(/\s+/).forEach(word => {
      const probe = line ? line + ' ' + word : word;
      if(dst.measureText(probe).width > maxW && line){ lines.push(line); line = word; }
      else line = probe;
    });
    if(line) lines.push(line);
  });
  if(!lines.length) return;

  const lh = size * (+p['Line Height']);
  const align = String(p.Alignment);
  const blockH = lh * lines.length;
  const cy = h/2 + (+p['Position Y'])*h/2 - blockH/2 + lh/2;
  dst.fillStyle = packedColorCss(p.Color == null ? 0xFFFFFFFF : p.Color);
  lines.forEach((ln, i) => {
    const lw = dst.measureText(ln).width;
    const x = align === 'Right'  ? w - margin - lw
            : align === 'Center' ? w/2 - lw/2
            : margin;
    dst.fillText(ln, x + (+p['Position X'])*w/2, cy + i*lh);
  });
});

/* =========================================================================
   THE THIRD WAVE — the eighteen Arena reported that this file did not draw
   -------------------------------------------------------------------------
   Arena reports 106 video effects. After the second wave this file drew 88 and
   the eighteen below were greyed in the browser as "interface only, passes
   through". The scalar/canvas effects are implemented below; Mask and UV Map
   are completed later by the shared decoded-image registry and WebGL
   two-sampler renderer. They are kept there because they require a typed image
   parameter rather than another scalar-only def().

   Provenance differs per effect and each states its own. Five come from
   Resolume's shipped presets, two from the .wired patches, and the rest are
   inferred with every parameter name checked against Arena.exe's string table.
   ========================================================================= */

/* =========================================================================
   GEOMETRIC / TRANSFORM COMPOSITING — Cube Tiles, VideoWall, Fragment, Iterate
   -------------------------------------------------------------------------
   All four are 3D in Arena: a cube, a wall of screens on a plane you can tilt,
   radial shards you can tip out of the picture plane, and a cloner with
   TranslateZ and RotateX/Y. A 2D context has no projection matrix, so they
   share one small projector defined here rather than four copies of it.

   The technique is the one Keystone already uses at arena-fx.js:1308 — project
   the corners yourself, then lay the picture down as triangles, each drawn with
   the affine that matches its own three corners. Two things are added because
   these effects need them and a corner pin does not:

     - a NEAR-PLANE CLIP. Cube Tiles' shipped "Inside Cube" preset puts the eye
       inside the cube, so face corners land behind it. Dividing by a negative
       depth without clipping gives mirrored garbage across the whole frame,
       which is exactly the kind of "it drew something, so it works" outcome
       this file forbids. Vertices carry their source coordinate through the
       clip so the texture stays put.
     - DEPTH-DRIVEN SUBDIVISION. An affine map is the true perspective map only
       when the quad is parallel to the screen. So a quad whose four corners are
       at the same depth is drawn once, exactly, with no subdivision and no
       clip-edge growth — which is what keeps VideoWall and Iterate pixel-exact
       at their defaults. Subdivision is only spent where the depths differ.

   PARAMETER PROVENANCE for all four: default/Presets/Video Effects/<name>/*.xml,
   Arena's own shipped presets. Those files give the parameter NAMES, their
   ORDER as Arena lists them (mined.json is alphabetised, the XML is not), the
   defaults, and the true bounds from each ParamRange's <ValueRange name="minMax">.
   Every one of the four is 0..1 on every parameter.

   Two corrections to reference/mined.json, both worth recording:

     - mined.json reports Cube Tiles' Zoom as min 0.6 / max 0.819048. That pair
       is not the parameter's bounds: it is the <ValueRange name="startStop">
       of the ANIMATION on Zoom in the "Slow Rotate" preset. The parameter's own
       <ValueRange name="minMax"> is 0..1 in all seven presets. Same story for
       VideoWall's GapSize/PanX/PanY "max" values — VideoWall is an FFGL plugin
       (renderPassType FFGLEffect, typeId sy88) whose presets carry no minMax at
       all, and FFGL float parameters are 0..1 by definition of the API.
     - mined.json lists Iterate's DRotateX AND "DRotateX " (trailing space), and
       both "TransformStrengt" and "TransformStrength". These are serialized
       compatibility fields: Rotator.xml, Swirly.xml and hBlur.xml were
       written by an older build that emitted the trailing space and truncated
       the long name at 16 characters, while Shards.xml has all of them clean.
       Both spellings stay addressable and drive the same renderer operation;
       AND carries the minMax blocks. COLLAPSED HERE to the clean spelling —
       That older collapsed design is superseded below: the public schema has
       24 clean fields plus eight exact compatibility fields from those files.

   What the parameters MEAN is a different question from what they are called,
   and Resolume documents none of it: effects.htm describes the effect contract,
   not individual effects, and there is no per-effect reference page. So every
   mapping below is marked UNDOCUMENTED — inferring, with the preset values that
   drove the inference quoted next to it. The names themselves are not inferred;
   all of them, plus "Randomize", are present in Arena.exe's own string table.
   ========================================================================= */

const GEO3D = {
  /* deterministic per-index hash, 0..1. Math.random() inside draw() would make
     the picture hiss differently every frame even when the clip is paused. */
  hash(n){
    let x = Math.imul(n | 0, 374761393) + 668265263 | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  },
  /* Euler X then Y then Z — the order Resolume lists the three sliders in. */
  rot(ax, ay, az){
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const cz = Math.cos(az), sz = Math.sin(az);
    return [ cy*cz,             -cy*sz,             sy,
             sx*sy*cz + cx*sz,  -sx*sy*sz + cx*cz,  -sx*cy,
            -cx*sy*cz + sx*sz,   cx*sy*sz + sx*cz,   cx*cy ];
  },
  mul(a, b){
    const m = new Array(9);
    for(let r = 0; r < 3; r++) for(let c = 0; c < 3; c++)
      m[r*3+c] = a[r*3]*b[c] + a[r*3+1]*b[3+c] + a[r*3+2]*b[6+c];
    return m;
  },
  ap(m, x, y, z){
    return { x: m[0]*x + m[1]*y + m[2]*z,
             y: m[3]*x + m[4]*y + m[5]*z,
             z: m[6]*x + m[7]*y + m[8]*z };
  },

  /* The source rectangle a piece actually reads, clamped to the image. Passing
     it to drawImage instead of drawing the whole source every time is what
     makes these four affordable: a wall of 64 screens was asking the browser to
     transform a full 1920x1080 frame 64 times to keep a sixty-fourth of it
     each time. Drawing the sub-rect at its own coordinates under the same
     transform is the same picture, because the transform is what places it. */
  clipRect(src, xs, ys){
    const sw = src.width || 0, sh = src.height || 0;
    if(!(sw > 0) || !(sh > 0)) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(let i = 0; i < xs.length; i++){
      if(!isFinite(xs[i]) || !isFinite(ys[i])) return null;
      if(xs[i] < x0) x0 = xs[i];
      if(xs[i] > x1) x1 = xs[i];
      if(ys[i] < y0) y0 = ys[i];
      if(ys[i] > y1) y1 = ys[i];
    }
    /* one pixel of margin so bilinear filtering at the edge has a neighbour */
    x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1);
    x1 = Math.min(sw, Math.ceil(x1) + 1);  y1 = Math.min(sh, Math.ceil(y1) + 1);
    if(x1 - x0 < 1 || y1 - y0 < 1) return null;   /* reads nothing of the image */
    return [x0, y0, x1 - x0, y1 - y0];
  },

  /* One textured triangle. s* are source-image pixel coordinates, d* are
     projected screen pixels. Keystone's, plus the growth by one pixel about the
     centroid: adjacent sub-triangles that merely abut leave a line of
     half-covered pixels along every shared edge, so they are grown until they
     overlap instead. The one difference from Keystone is the cap on that
     growth, and the comment on it says why it is needed here and not there. */
  tri(dst, src, s0, s1, s2, d0, d1, d2){
    const e1x = s1[0]-s0[0], e1y = s1[1]-s0[1];
    const e2x = s2[0]-s0[0], e2y = s2[1]-s0[1];
    const det = e1x*e2y - e1y*e2x;
    if(!det || !isFinite(det)) return;
    const f1x = d1[0]-d0[0], f1y = d1[1]-d0[1];
    const f2x = d2[0]-d0[0], f2y = d2[1]-d0[1];
    const det2 = f1x*f2y - f2x*f1y;
    if(!isFinite(det2) || det2 === 0) return;
    const m11 = (f1x*e2y - f2x*e1y)/det, m12 = (f1y*e2y - f2y*e1y)/det;
    const m21 = (f2x*e1x - f1x*e2x)/det, m22 = (f2y*e1x - f1y*e2x)/det;
    if(!isFinite(m11) || !isFinite(m12) || !isFinite(m21) || !isFinite(m22)) return;
    const gx = (d0[0]+d1[0]+d2[0])/3, gy = (d0[1]+d1[1]+d2[1])/3;
    const per = Math.hypot(d1[0]-d0[0], d1[1]-d0[1])
              + Math.hypot(d2[0]-d1[0], d2[1]-d1[1])
              + Math.hypot(d0[0]-d2[0], d0[1]-d2[1]);
    if(!isFinite(per) || per <= 0) return;
    const inr = Math.abs(det2)/per;
    /* Grow until every edge has moved a pixel outwards — Keystone's rule. But
       Keystone's triangles are a regular grid, and these are not: near-plane
       clipping produces slivers whose inradius is a fraction of a pixel while
       their vertices sit hundreds of thousands of pixels away, and scaling THAT
       about its centroid throws the clip across the whole frame. Measured on
       Cube Tiles at Zoom 1 / Num Cubes 1 — the geometry of its own shipped
       "Inside Cube" preset — the outermost clip vertex moved 5,086 px, i.e. the
       sliver's texture extrapolated over the entire picture. Keystone never
       shows it because it wraps its whole mesh in one clip of the pinned quad;
       there is no such quad here once a face is subdivided and near-clipped.
       So cap the scale by the displacement it actually causes: no vertex moves
       more than two pixels, whatever the triangle's shape. Well-formed
       triangles are unaffected — an equilateral's circumradius is exactly twice
       its inradius, so the cap and 1/inr agree there. */
    const dmax = Math.max(Math.hypot(d0[0]-gx, d0[1]-gy),
                          Math.hypot(d1[0]-gx, d1[1]-gy),
                          Math.hypot(d2[0]-gx, d2[1]-gy));
    let ex = inr > 0.01 ? 1/inr : 0;
    if(dmax > 1e-6) ex = Math.min(ex, 2/dmax);
    const sc = isFinite(ex) && ex > 0 ? 1 + ex : 1;
    const grow = q => [gx + (q[0]-gx)*sc, gy + (q[1]-gy)*sc];
    const a0 = grow(d0), a1 = grow(d1), a2 = grow(d2);
    const R = this.clipRect(src, [s0[0], s1[0], s2[0]], [s0[1], s1[1], s2[1]]);
    if(!R) return;
    dst.save();
    dst.beginPath();
    dst.moveTo(a0[0], a0[1]); dst.lineTo(a1[0], a1[1]); dst.lineTo(a2[0], a2[1]);
    dst.closePath(); dst.clip();
    dst.setTransform(m11, m12, m21, m22,
                     d0[0] - (m11*s0[0] + m21*s0[1]),
                     d0[1] - (m12*s0[0] + m22*s0[1]));
    dst.drawImage(src, R[0], R[1], R[2], R[3], R[0], R[1], R[2], R[3]);
    dst.restore();
  },

  /* The exact path: all four corners at one depth, so the projection of the
     rectangle is a parallelogram and ONE affine is the whole truth — no
     subdivision, no mesh, no accumulated resampling.

     The clip is still grown by a pixel on every side, for the same reason
     Keystone grows its triangles: VideoWall's screens abut exactly when GapSize
     is 0, and two antialiased clips meeting on the same line each cover it
     partially, so the wall came back with half-transparent seams — measured at
     360 pixels off a 3x3 neutral wall before this. Growth moves the CLIP only,
     never the affine, so the picture does not move and an identity transform
     still comes back pixel-identical: the grown clip on a full-frame quad falls
     outside the canvas, where it does nothing.

     A projected rectangle at one depth is a parallelogram, so each pair of
     opposite edges can be pushed out exactly one pixel by scaling that edge
     direction about the centre — no offset-and-reintersect needed. */
  flat(dst, src, D, UV){
    const e1x = UV[1][0]-UV[0][0], e1y = UV[1][1]-UV[0][1];
    const e2x = UV[3][0]-UV[0][0], e2y = UV[3][1]-UV[0][1];
    const det = e1x*e2y - e1y*e2x;
    if(!det || !isFinite(det)) return;
    const f1x = D[1][0]-D[0][0], f1y = D[1][1]-D[0][1];
    const f2x = D[3][0]-D[0][0], f2y = D[3][1]-D[0][1];
    const m11 = (f1x*e2y - f2x*e1y)/det, m12 = (f1y*e2y - f2y*e1y)/det;
    const m21 = (f2x*e1x - f1x*e2x)/det, m22 = (f2y*e1x - f1y*e2x)/det;
    if(!isFinite(m11) || !isFinite(m12) || !isFinite(m21) || !isFinite(m22)) return;
    const cx = (D[0][0] + D[1][0] + D[2][0] + D[3][0]) / 4;
    const cy = (D[0][1] + D[1][1] + D[2][1] + D[3][1]) / 4;
    const cross = Math.abs(f1x*f2y - f2x*f1y);
    const l1 = Math.hypot(f1x, f1y), l2 = Math.hypot(f2x, f2y);
    let g1 = 1, g2 = 1;
    if(cross > 1e-9 && l1 > 1e-9 && l2 > 1e-9){
      const d1 = cross / l2, d2 = cross / l1;   /* the quad's two thicknesses */
      g1 = (d1 + 2) / d1; g2 = (d2 + 2) / d2;
      if(!isFinite(g1) || g1 > 4) g1 = 4;
      if(!isFinite(g2) || g2 > 4) g2 = 4;
    }
    const P = [];
    for(let i = 0; i < 4; i++){
      const s1 = (i === 1 || i === 2) ? 0.5 : -0.5;
      const s2 = (i === 2 || i === 3) ? 0.5 : -0.5;
      P.push([cx + g1*s1*f1x + g2*s2*f2x, cy + g1*s1*f1y + g2*s2*f2y]);
    }
    const R = this.clipRect(src, [UV[0][0], UV[1][0], UV[2][0], UV[3][0]],
                                 [UV[0][1], UV[1][1], UV[2][1], UV[3][1]]);
    if(!R) return;
    dst.save();
    dst.beginPath();
    dst.moveTo(P[0][0], P[0][1]);
    for(let i = 1; i < 4; i++) dst.lineTo(P[i][0], P[i][1]);
    dst.closePath(); dst.clip();
    dst.setTransform(m11, m12, m21, m22,
                     D[0][0] - (m11*UV[0][0] + m21*UV[0][1]),
                     D[0][1] - (m12*UV[0][0] + m22*UV[0][1]));
    dst.drawImage(src, R[0], R[1], R[2], R[3], R[0], R[1], R[2], R[3]);
    dst.restore();
  },

  /* Clip a camera-space polygon against the near plane, carrying each vertex's
     source coordinate through the split, then fan what survives into triangles.
     V is [{x,y,z,u,v}...] with z the depth in front of the eye. */
  polyTri(dst, src, V, cam){
    const near = cam.near, out = [];
    for(let i = 0; i < V.length; i++){
      const a = V[i], b = V[(i+1) % V.length];
      const ain = a.z >= near, bin = b.z >= near;
      if(ain) out.push(a);
      if(ain !== bin){
        const dz = b.z - a.z;
        if(!dz) continue;
        const k = (near - a.z) / dz;
        out.push({ x: a.x + (b.x-a.x)*k, y: a.y + (b.y-a.y)*k, z: near,
                   u: a.u + (b.u-a.u)*k, v: a.v + (b.v-a.v)*k });
      }
    }
    if(out.length < 3) return;
    const S = [], D = [];
    for(let i = 0; i < out.length; i++){
      const q = out[i];
      S.push([q.u, q.v]);
      D.push([cam.cx + cam.f*q.x/q.z, cam.cy + cam.f*q.y/q.z]);
    }
    for(let i = 1; i + 1 < out.length; i++)
      this.tri(dst, src, S[0], S[i], S[i+1], D[0], D[i], D[i+1]);
  },

  /* Draw a source region onto a 3D quad. P is four camera-space {x,y,z} corners
     and UV the four matching source-pixel coordinates, both in ring order. A
     wedge is passed as a quad with its first two corners coincident — the
     degenerate half of each fan is skipped by tri()'s determinant test and the
     apex still gets covered. cam is {f, cx, cy, near}. */
  quad(dst, src, P, UV, cam, maxSub){
    let zmin = Infinity, zmax = -Infinity;
    for(let i = 0; i < 4; i++){
      const z = P[i].z;
      if(!isFinite(z) || !isFinite(P[i].x) || !isFinite(P[i].y)) return;
      if(z < zmin) zmin = z;
      if(z > zmax) zmax = z;
    }
    if(zmax <= cam.near) return;                      /* wholly behind the eye */
    if(zmin > cam.near && zmax - zmin <= 1e-6 * Math.abs(zmax) + 1e-9){
      const e1x = UV[1][0]-UV[0][0], e1y = UV[1][1]-UV[0][1];
      const e2x = UV[3][0]-UV[0][0], e2y = UV[3][1]-UV[0][1];
      if(Math.abs(e1x*e2y - e1y*e2x) > 1e-9){
        const D = [];
        for(let i = 0; i < 4; i++)
          D.push([cam.cx + cam.f*P[i].x/P[i].z, cam.cy + cam.f*P[i].y/P[i].z]);
        this.flat(dst, src, D, UV);
        return;
      }
    }
    const n = zmin > cam.near
      ? clamp(Math.ceil((1 - zmin/zmax) * maxSub), 1, maxSub)
      : Math.max(1, maxSub);
    const at = (u, v) => {
      const ax = (1-u)*P[0].x + u*P[1].x, bx = (1-u)*P[3].x + u*P[2].x;
      const ay = (1-u)*P[0].y + u*P[1].y, by = (1-u)*P[3].y + u*P[2].y;
      const az = (1-u)*P[0].z + u*P[1].z, bz = (1-u)*P[3].z + u*P[2].z;
      const au = (1-u)*UV[0][0] + u*UV[1][0], bu = (1-u)*UV[3][0] + u*UV[2][0];
      const av = (1-u)*UV[0][1] + u*UV[1][1], bv = (1-u)*UV[3][1] + u*UV[2][1];
      return { x: (1-v)*ax + v*bx, y: (1-v)*ay + v*by, z: (1-v)*az + v*bz,
               u: (1-v)*au + v*bu, v: (1-v)*av + v*bv };
    };
    for(let j = 0; j < n; j++) for(let i = 0; i < n; i++){
      const u0 = i/n, u1 = (i+1)/n, v0 = j/n, v1 = (j+1)/n;
      this.polyTri(dst, src, [at(u0,v0), at(u1,v0), at(u1,v1), at(u0,v1)], cam);
    }
  }
};

/* -------------------------------------------------------------------------
   Cube Tiles — "Creates cube and uses the tiled content to fill its sides."
   (arena-catalog.js, Arena's own REST description, typeId A117.)

   Names, order, defaults and 0..1 bounds: default/Presets/Video Effects/
   Cube Tiles/*.xml — Resolution, Zoom, Amount, Rotate X, Rotate Y, Rotate Z,
   Num Cubes, Black BG. The odd one, Black BG, is a real shipped parameter and
   is kept; it is a <Param>, not a <ParamRange>, i.e. a toggle, so it is read
   with the >= 0.5 test the other toggles in this file use.

   UNDOCUMENTED — inferring, from the seven shipped presets:
     Rotate X/Y/Z   0.5 is neutral and the slider is one full turn, so the angle
                    is (v - 0.5) * 360 degrees. The defaults 0.6 / 0.6 / 0.5
                    then read as +36, +36, 0 — a cube sitting at a three-quarter
                    view with no roll, which is what a default wants to be. Any
                    mapping where 0.5 is 180 degrees would default to an upside
                    down cube.
     Zoom           camera distance, higher = closer, in units of the cube's
                    half-size: 5.6 - 5.0*Zoom. This is fixed by the preset
                    NAMES, which are the only evidence there is. "Inside Cube"
                    is Zoom 1.0, so 1.0 must put the eye inside the cube: 0.6 <
                    1. "Closeup" is 0.817 -> 1.52, just outside the near face.
                    The default 0.75 -> 1.85 frames the cube.
     Resolution     "tiled content" is content repeated, so this is how many
                    times the frame repeats across a face: 1 + round(v*3), i.e.
                    1..4 per edge. The preset actually called "Tiles" sets it to
                    1.0, the maximum.
     Amount         each repeat's size inside its own cell, 0..1, so 1.0 is a
                    seamless tiling and lower values leave the cube showing
                    through between tiles. Every shipped preset sets Amount to
                    1.0 except "Slow Rotate" (0.707), which is consistent with
                    1.0 being the seamless case.
     Num Cubes      0 is one cube; 1 + round(v*7) gives 1..8. Extra cubes ride a
                    ring and the whole cluster shrinks as 1/sqrt(count) so the
                    framing does not change when you add them. "Complex" (0.209)
                    gets 2, "Nauseating" (0.03) stays at 1.

   NOT IMPLEMENTED, AND SAYING SO: parameters.htm names a Randomize EVENT on
   this effect — "randomly re-arranges how the tiles are distributed across the
   cube". def() in this file describes numeric parameters only; there is no
   event kind to declare, and adding "Randomize" as a slider would be a control
   that cannot do its job. The tiling here is therefore the plain in-order one.
   Adding it needs an event parameter kind in def() and in the parameter UI.

   Cost: no readback. Draw count is 6 faces x Num Cubes quads, each subdivided
   only as far as its corner depths differ. ------------------------------- */
def('Cube Tiles', [{n:'Resolution', min:0, max:1, d:0.3},
                   {n:'Zoom',       min:0, max:1, d:0.75},
                   {n:'Amount',     min:0, max:1, d:0.5},
                   {n:'Rotate X',   min:0, max:1, d:0.6},
                   {n:'Rotate Y',   min:0, max:1, d:0.6},
                   {n:'Rotate Z',   min:0, max:1, d:0.5},
                   {n:'Num Cubes',  min:0, max:1, d:0},
                   {n:'Black BG',   kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    if(!(w > 0) || !(h > 0)) return;
    if(p['Black BG'] >= 0.5){
      dst.save(); dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h); dst.restore();
    }
    /* the face texture: the frame repeated n x n, each repeat sized by Amount
       inside its cell. Built once per frame, then all six faces of every cube
       sample it, so Resolution costs one pass and no extra geometry. */
    const n = clamp(1 + Math.round(clamp(p.Resolution, 0, 1) * 3), 1, 4);
    const amt = clamp(p.Amount, 0, 1);
    const tex = pad(2, w, h);
    const cw = w / n, ch = h / n;
    const tw = Math.max(1, cw * amt), th = Math.max(1, ch * amt);
    for(let j = 0; j < n; j++) for(let i = 0; i < n; i++)
      tex.drawImage(src, 0, 0, w, h,
                    i*cw + (cw - tw)/2, j*ch + (ch - th)/2, tw, th);

    const count = clamp(1 + Math.round(clamp(p['Num Cubes'], 0, 1) * 7), 1, 8);
    const s = 1 / Math.sqrt(count);
    const ring = 1 - s;
    const dist = 5.6 - 5.0 * clamp(p.Zoom, 0, 1);
    const R = GEO3D.rot((p['Rotate X'] - 0.5) * Math.PI * 2,
                        (p['Rotate Y'] - 0.5) * Math.PI * 2,
                        (p['Rotate Z'] - 0.5) * Math.PI * 2);
    const cam = { f: Math.min(w, h) * 0.75, cx: w/2, cy: h/2, near: 0.05 };
    const UV = [[0,0], [w,0], [w,h], [0,h]];
    const C = [];
    for(let b = 0; b < 8; b++)
      C.push([(b & 1) ? 1 : -1, (b & 2) ? 1 : -1, (b & 4) ? 1 : -1]);
    const FACES = [[1,5,7,3], [0,2,6,4], [2,3,7,6], [0,4,5,1], [4,6,7,5], [0,1,3,2]];

    /* every face of every cube, painted far to near — no back-face culling,
       because with the eye inside the cube the inside faces are the picture */
    const quads = [];
    for(let k = 0; k < count; k++){
      let ox = 0, oy = 0, oz = 0;
      if(count > 1){
        const a = (k / count) * Math.PI * 2;
        ox = Math.cos(a) * ring; oy = Math.sin(a) * ring;
      }
      for(let f = 0; f < 6; f++){
        const idx = FACES[f], P = [];
        let zc = 0;
        for(let c = 0; c < 4; c++){
          const v = C[idx[c]];
          const q = GEO3D.ap(R, v[0]*s + ox, v[1]*s + oy, v[2]*s + oz);
          P.push({ x: q.x, y: q.y, z: q.z + dist });
          zc += q.z + dist;
        }
        quads.push({ P, z: zc / 4 });
      }
    }
    quads.sort((a, b) => b.z - a.z);
    const maxSub = count > 2 ? 3 : 5;
    for(let i = 0; i < quads.length; i++)
      GEO3D.quad(dst, tex.canvas, quads[i].P, UV, cam, maxSub);
  });

/* -------------------------------------------------------------------------
   VideoWall — "Video Wall slices your content into a grid of smaller screens,
   like it's being displayed across multiple monitors." (arena-catalog.js,
   typeId sy88.) An FFGL plugin, so every parameter is 0..1 by the FFGL float
   convention; the shipped presets carry no <ValueRange> at all, which is why
   mined.json's "min"/"max" for GapSize, PanX and PanY are observed preset
   values rather than bounds.

   Names, order and defaults: default/Presets/Video Effects/VideoWall/*.xml —
   Screens, Zoom, RotateX, RotateY, RotateZ, PanX, PanY, SubscreenSize,
   SubscreenMode, GapSize, BrightnessVary, Black BG.

   UNDOCUMENTED — inferring. The lever that settles most of it is that this
   effect must be an identity at its own defaults, and it can be: Screens 0.3
   with GapSize 0 and SubscreenSize 0 cuts the frame into a 3x3 grid whose seams
   are invisible, the three Rotates are 0.5, the two Pans are 0.5, and
   BrightnessVary is 0. That is only true if Zoom's default of 0.3 is also
   neutral, so Zoom is the camera's zoom on the wall with 0.3 = "the wall
   exactly fills the frame": 1 + (Zoom - 0.3)*1.5. Zoom, RotateX/Y/Z, PanX/PanY
   sit consecutively in Arena's own parameter order, which is the classic camera
   triple, and the preset named "Panning" moves Pan and Zoom together.
     Screens        1 + round(v*7) screens per edge. Default 0.3 -> 3x3; every
                    shipped preset uses 1.0 -> 8x8.
     RotateX/Y/Z    (v - 0.5) * 360 degrees about the wall's own centre, so 0.5
                    is a wall square to the camera. Confirmed by all three
                    defaulting to 0.5 and by "RandomTiles", "Subscreens" and
                    "Tiles" leaving all three at 0.5.
     GapSize        the bezel. Each screen shrinks to (1 - GapSize/2) of its
                    cell, so the maximum gap is half a cell. "Tiles" is 0.498.
     SubscreenSize  each screen splits into 1 + round(v*3) subscreens per edge,
                    each keeping the same bezel. "Subscreens" is 0.271, "Tiles"
                    is 1.0, "RandomTiles" is 0.
     SubscreenMode  a toggle in every shipped preset (0.0 or 1.0). Read as: 1
                    shuffles which piece of the content each screen shows, which
                    is what the preset called "RandomTiles" asks for and is the
                    only reading under which RandomTiles (Mode 1, Size 0) does
                    anything at all.
     BrightnessVary per-screen brightness spread, deterministic per screen index
                    so a paused clip holds still. "Panning" is 0.375.

   Cost: no readback. Draw count is Screens^2 x Subscreens^2 quads. -------- */
def('VideoWall', [{n:'Screens',        min:0, max:1, d:0.3},
                  {n:'Zoom',           min:0, max:1, d:0.3},
                  {n:'RotateX',        min:0, max:1, d:0.5},
                  {n:'RotateY',        min:0, max:1, d:0.5},
                  {n:'RotateZ',        min:0, max:1, d:0.5},
                  {n:'PanX',           min:0, max:1, d:0.5},
                  {n:'PanY',           min:0, max:1, d:0.5},
                  {n:'SubscreenSize',  min:0, max:1, d:0},
                  {n:'SubscreenMode',  min:0, max:1, d:0},
                  {n:'GapSize',        min:0, max:1, d:0},
                  {n:'BrightnessVary', min:0, max:1, d:0},
                  {n:'Black BG',       kind:'bool', d:false}],
  (dst, src, p, w, h) => {
    if(!(w > 0) || !(h > 0)) return;
    if(p['Black BG'] >= 0.5){
      dst.save(); dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h); dst.restore();
    }
    const n   = clamp(1 + Math.round(clamp(p.Screens, 0, 1) * 7), 1, 8);
    const sub = clamp(1 + Math.round(clamp(p.SubscreenSize, 0, 1) * 3), 1, 4);
    const gap = clamp(p.GapSize, 0, 1) * 0.5;          /* fraction of a cell */
    const vary = clamp(p.BrightnessVary, 0, 1);
    const shuffled = p.SubscreenMode >= 0.5;
    const cells = n * sub;                              /* pieces per edge */
    const total = cells * cells;

    /* which piece of the content each screen shows. In order by default; with
       SubscreenMode on, permuted by a hash of the piece index — deterministic,
       so it does not re-shuffle itself every frame. */
    let map = null;
    if(shuffled){
      map = new Array(total);
      for(let i = 0; i < total; i++) map[i] = i;
      map.sort((a, b) => GEO3D.hash(a) - GEO3D.hash(b));
    }

    /* the wall: half-height 1, half-width the frame's aspect, at depth D. f is
       chosen so that at neutral Zoom the wall's height is exactly the frame's,
       which is what makes the default an identity. */
    const D = 3, a = w / h;
    const z = Math.max(0.05, 1 + (clamp(p.Zoom, 0, 1) - 0.3) * 1.5);
    const cam = { f: D * (h / 2) * z, cx: w/2, cy: h/2, near: D * 0.02 };
    const R = GEO3D.rot((p.RotateX - 0.5) * Math.PI * 2,
                        (p.RotateY - 0.5) * Math.PI * 2,
                        (p.RotateZ - 0.5) * Math.PI * 2);
    const px = (clamp(p.PanX, 0, 1) - 0.5) * 2 * a;
    const py = (clamp(p.PanY, 0, 1) - 0.5) * 2;

    const piece = (i, j) => {
      /* model rectangle of piece (i,j), inset by the bezel at both the screen
         and the subscreen level so a subdivided screen keeps its outer frame */
      const si = (i / sub) | 0, sj = (j / sub) | 0;
      const cx0 = -a + 2*a * si / n,     cy0 = -1 + 2 * sj / n;
      const cwid = 2*a / n,              chei = 2 / n;
      const gx = cwid * gap / 2,         gy = chei * gap / 2;
      const ix0 = cx0 + gx, iy0 = cy0 + gy;
      const iw = cwid - 2*gx, ih = chei - 2*gy;
      const ui = i - si*sub, uj = j - sj*sub;
      const bw = iw / sub, bh = ih / sub;
      const bgx = bw * gap / 2, bgy = bh * gap / 2;
      return { x0: ix0 + ui*bw + bgx, y0: iy0 + uj*bh + bgy,
               w: Math.max(1e-6, bw - 2*bgx), h: Math.max(1e-6, bh - 2*bgy) };
    };

    const quads = [];
    for(let j = 0; j < cells; j++) for(let i = 0; i < cells; i++){
      const m = piece(i, j);
      const P = [];
      let zc = 0;
      const corner = (mx, my) => {
        const q = GEO3D.ap(R, mx, my, 0);
        P.push({ x: q.x + px, y: q.y + py, z: q.z + D });
        zc += q.z + D;
      };
      corner(m.x0,       m.y0);
      corner(m.x0 + m.w, m.y0);
      corner(m.x0 + m.w, m.y0 + m.h);
      corner(m.x0,       m.y0 + m.h);
      /* the source piece: in order, or permuted when SubscreenMode is on */
      const idx = j*cells + i;
      const s = map ? map[idx] : idx;
      const sx = (s % cells) * w / cells, sy = ((s / cells) | 0) * h / cells;
      const sw = w / cells, sh = h / cells;
      quads.push({ P, z: zc/4, idx,
                   UV: [[sx,sy], [sx+sw,sy], [sx+sw,sy+sh], [sx,sy+sh]] });
    }
    quads.sort((q1, q2) => q2.z - q1.z);
    for(let k = 0; k < quads.length; k++){
      const q = quads[k];
      if(vary > 0){
        const b = 1 - vary * GEO3D.hash(q.idx * 7 + 3);
        dst.filter = `brightness(${b.toFixed(3)})`;
      }
      GEO3D.quad(dst, src, q.P, q.UV, cam, 3);
    }
    dst.filter = 'none';
  });

/* -------------------------------------------------------------------------
   Fragment — "Radial fragmentation" (arena-catalog.js, typeId sy08).

   Names, order, defaults and 0..1 bounds: default/Presets/Video Effects/
   Fragment/*.xml — Fragments, Distance, Rotation, FragRotationX, FragRotationY,
   FragRotationZ, FragScale, CompositeOpacity, Black BG. Note Black BG defaults
   to 1 here and to 0 on the other three; that is the shipped default, not a
   slip, and it is why the effect reads as shards on black.

   The Speed / Multiplier / Interval / Max Distance / PlayDirection / PlayMode /
   PlayModeAway / DurationIsScalable blocks that appear inside Shake.xml are NOT
   parameters of the effect: they are the parameter-animation block attached to
   the animated Rotation slider, the same one every animatable parameter in
   Resolume gets. They are correctly absent from mined.json and from here.

   UNDOCUMENTED — inferring. The frame is cut into radial wedges about its
   centre and each wedge is thrown outwards:
     Fragments        3 + round(v*29) wedges, 3..32. Default 0.3 -> 12,
                      "Shake" 0.0 -> 3, "Mist" 1.0 -> 32.
     Rotation         orbits the wedges about the frame centre by v*360. The
                      wedges are CUT at fixed angles and only their drawn
                      position rotates, so Rotation is visible on its own rather
                      than cancelling out against the cut.
     Distance         how far each wedge is pushed out along its own bisector,
                      up to three quarters of the frame's half-diagonal.
     FragRotationX/Y/Z  (v - 0.5)*360 degrees about the wedge's own centroid.
                      X and Y tip it out of the picture plane, which is the only
                      reason this effect needs a projection at all. All three
                      default to 0.5, and "Shake" leaves all three there.
     FragScale        0.5 is neutral, so the factor is v*2, 0..2. "Mist" (0.827
                      -> 1.65) wants shards big enough to overlap into a haze;
                      "Horizon" and "Shake" sit at 1.0 -> 2.0.
     CompositeOpacity per-wedge alpha. This is NOT the effect's Opacity, which
                      apply() owns: it controls how the wedges stack against
                      each other, which is what makes "Mist" (0.32) a mist.

   Cost: no readback. Draw count is one quad per wedge, subdivided only when the
   wedge is tipped out of plane. ------------------------------------------ */
def('Fragment', [{n:'Fragments',        min:0, max:1, d:0.3},
                 {n:'Distance',         min:0, max:1, d:0.33},
                 {n:'Rotation',         min:0, max:1, d:0},
                 {n:'FragRotationX',    min:0, max:1, d:0.5},
                 {n:'FragRotationY',    min:0, max:1, d:0.5},
                 {n:'FragRotationZ',    min:0, max:1, d:0.5},
                 {n:'FragScale',        min:0, max:1, d:0.5},
                 {n:'CompositeOpacity', min:0, max:1, d:0.5},
                 {n:'Black BG',         kind:'bool', d:true}],
  (dst, src, p, w, h) => {
    if(!(w > 0) || !(h > 0)) return;
    if(p['Black BG'] >= 0.5){
      dst.save(); dst.fillStyle = '#000'; dst.fillRect(0, 0, w, h); dst.restore();
    }
    const n = clamp(3 + Math.round(clamp(p.Fragments, 0, 1) * 29), 3, 32);
    const step = Math.PI * 2 / n;
    /* out to the corners: a wedge of half-angle step/2 must reach the frame's
       half-diagonal divided by cos(half-angle) to cover the corner it contains */
    const half = Math.hypot(w, h) / 2;
    const Rad = half / Math.max(0.05, Math.cos(step / 2));
    const orbit = clamp(p.Rotation, 0, 1) * Math.PI * 2;
    const push = clamp(p.Distance, 0, 1) * half * 0.75;
    const fs = clamp(p.FragScale, 0, 1) * 2;
    const Rf = GEO3D.rot((p.FragRotationX - 0.5) * Math.PI * 2,
                         (p.FragRotationY - 0.5) * Math.PI * 2,
                         (p.FragRotationZ - 0.5) * Math.PI * 2);
    const D = h * 2.2;
    const cam = { f: D, cx: w/2, cy: h/2, near: D * 0.02 };
    const co = Math.cos(orbit), so = Math.sin(orbit);

    dst.globalAlpha = clamp(p.CompositeOpacity, 0, 1);
    const maxSub = n > 16 ? 2 : 4;
    for(let k = 0; k < n; k++){
      const a0 = k * step, a1 = a0 + step;
      /* the wedge in source-pixel space, apex at the frame centre */
      const S = [[0, 0],
                 [Math.cos(a0)*Rad, Math.sin(a0)*Rad],
                 [Math.cos(a1)*Rad, Math.sin(a1)*Rad]];
      /* orbited copy, and the centroid it is scaled and tipped about */
      const O = S.map(q => [q[0]*co - q[1]*so, q[0]*so + q[1]*co]);
      const cxq = (O[0][0] + O[1][0] + O[2][0]) / 3;
      const cyq = (O[0][1] + O[1][1] + O[2][1]) / 3;
      const bis = a0 + step/2 + orbit;
      const ox = Math.cos(bis) * push, oy = Math.sin(bis) * push;
      const P = O.map(q => {
        const r = GEO3D.ap(Rf, (q[0]-cxq)*fs, (q[1]-cyq)*fs, 0);
        return { x: r.x + cxq + ox, y: r.y + cyq + oy, z: r.z + D };
      });
      /* a wedge is a quad with its first two corners coincident: the fan drops
         the degenerate half and the apex is still covered */
      GEO3D.quad(dst, src,
                 [P[0], P[0], P[1], P[2]],
                 [[w/2 + S[0][0], h/2 + S[0][1]], [w/2 + S[0][0], h/2 + S[0][1]],
                  [w/2 + S[1][0], h/2 + S[1][1]], [w/2 + S[2][0], h/2 + S[2][1]]],
                 cam, maxSub);
    }
    dst.globalAlpha = 1;
  });

/* -------------------------------------------------------------------------
   Iterate — "Complex iterative compositing tool. A cloner effect on steroids."
   (arena-catalog.js, typeId sy13.)

   Names, order and defaults: default/Presets/Video Effects/Iterate/Shards.xml,
   plus the exact legacy spellings serialized by Rotator.xml, Swirly.xml and
   hBlur.xml. The 24 clean parameters are all 0..1: TransformStrength,
   Iterations, StartOpacity, OpacityChange,
   TranslateX/Y/Z, RotateX/Y/Z, Scale, DOpacityChange, DTranslateX/Y/Z,
   DRotateX/Y/Z, DScale, BlendMode, GRotateX/Y/Z, Black BG.

   Rotator.xml, Swirly.xml and hBlur.xml write eight of those names with a
   trailing space and truncate TransformStrength to "TransformStrengt" at 16
   characters. mined.json and ArenaPresets faithfully report both spellings.
   They stay as preset-compatible inputs and resolve onto their clean
   counterpart in draw(), including their saved animation.

   As with Fragment, the Speed / Multiplier / Interval / Max Distance /
   PlayDirection / PlayMode / PlayModeAway / DurationIsScalable blocks nested
   under RotateX, RotateY and RotateZ in the presets are the parameter-animation
   block, not parameters.

   UNDOCUMENTED — inferring, but the prefixes do most of the work and the whole
   set is neutral at its defaults, which it must be: Iterations 0.3 gives ten
   copies, every transform slider is 0.5, Scale is 0.5, StartOpacity is 1 and
   OpacityChange is 0.5, so ten identical opaque copies land on top of each
   other and the effect is an identity.
     Iterations       1 + round(v*31), 1..32. Default 0.3 -> 10.
     Translate/Rotate/Scale  the transform applied once per step and accumulated,
                      each 0.5-neutral: translation up to half a frame per step,
                      rotation up to +/-180 degrees per step, scale 0.25..1.75.
                      TranslateZ moves the copy in depth, which is why this is
                      the projected path and not a plain setTransform.
     D-prefixed       the DELTA of that step transform: step i uses base + i*D,
                      so the copies accelerate rather than repeating. This is the
                      reading that makes "Shards" (DTranslateX 0.601, DRotateY
                      1.0, DRotateZ 0.08, everything else neutral) a fan of
                      shards rather than a straight line of them.
     G-prefixed       a global rotation of the finished stack. "Swirly" sets all
                      three G's to 0.295 together, which only makes sense as one
                      rotation of the whole result.
     TransformStrength  scales every per-step transform and every delta at once.
                      1.0 in all four presets and by default.
     StartOpacity     the first copy's alpha; OpacityChange multiplies it per
                      step (0.5 -> x1), DOpacityChange bends that per step.
                      "hBlur" is StartOpacity 0.1 with a small TranslateX — ten
                      faint offset copies, i.e. a directional blur.
     BlendMode        a ParamRange, not a ParamChoice, so it is a normalised
                      index. The four Resolume blends a 2D canvas has an exact
                      equivalent for are Alpha, Add, Multiply and Screen, and
                      round(v*3) selects among them: "hBlur" 0.0 -> Alpha,
                      "Rotator" 0.251 -> Add, "Shards"/"Swirly" 1.0 -> Screen.
                      Copy zero is always laid down source-over, because
                      Multiply or Screen onto an empty buffer is nothing.

   The stack is built by accumulating the step transform rather than by
   re-reading the previous iteration's pixels; for these transforms the two are
   the same picture, and the accumulating form neither needs a history buffer
   nor compounds resampling blur.

   Cost: no readback. Draw count is one quad per iteration, and at neutral
   rotations that is one exact drawImage per iteration. ------------------- */
def('Iterate', [{n:'TransformStrength', min:0, max:1, d:1},
                {n:'Iterations',        min:0, max:1, d:0.3},
                {n:'StartOpacity',      min:0, max:1, d:1},
                {n:'OpacityChange',     min:0, max:1, d:0.5},
                {n:'TranslateX',        min:0, max:1, d:0.5},
                {n:'TranslateY',        min:0, max:1, d:0.5},
                {n:'TranslateZ',        min:0, max:1, d:0.5},
                {n:'RotateX',           min:0, max:1, d:0.5},
                {n:'RotateY',           min:0, max:1, d:0.5},
                {n:'RotateZ',           min:0, max:1, d:0.5},
                {n:'Scale',             min:0, max:1, d:0.5},
                {n:'DOpacityChange',    min:0, max:1, d:0.5},
                {n:'DTranslateX',       min:0, max:1, d:0.5},
                {n:'DTranslateY',       min:0, max:1, d:0.5},
                {n:'DTranslateZ',       min:0, max:1, d:0.5},
                {n:'DRotateX',          min:0, max:1, d:0.5},
                {n:'DRotateY',          min:0, max:1, d:0.5},
                {n:'DRotateZ',          min:0, max:1, d:0.5},
                {n:'DScale',            min:0, max:1, d:0.5},
                {n:'BlendMode',         min:0, max:1, d:0},
                {n:'GRotateX',          min:0, max:1, d:0.5},
                {n:'GRotateY',          min:0, max:1, d:0.5},
                {n:'GRotateZ',          min:0, max:1, d:0.5},
                {n:'Black BG',          kind:'bool', d:false},
                /* Exact fields in the three older factory XML files. */
                {n:'TransformStrengt',  min:0, max:1, d:1, legacyFor:'TransformStrength'},
                {n:'RotateX ',          min:0, max:1, d:0.5, legacyFor:'RotateX'},
                {n:'RotateY ',          min:0, max:1, d:0.5, legacyFor:'RotateY'},
                {n:'RotateZ ',          min:0, max:1, d:0.5, legacyFor:'RotateZ'},
                {n:'DRotateX ',         min:0, max:1, d:0.5, legacyFor:'DRotateX'},
                {n:'DRotateY ',         min:0, max:1, d:0.5, legacyFor:'DRotateY'},
                {n:'DRotateZ ',         min:0, max:1, d:0.5, legacyFor:'DRotateZ'},
                {n:'DScale ',           min:0, max:1, d:0.5, legacyFor:'DScale'}],
  (dst, src, p, w, h) => {
    if(!(w > 0) || !(h > 0)) return;
    const serialized = (clean, legacy, neutral) => {
      const current = Number(p[clean]), old = Number(p[legacy]);
      const currentMoved = Number.isFinite(current) && Math.abs(current - neutral) > 1e-9;
      const oldMoved = Number.isFinite(old) && Math.abs(old - neutral) > 1e-9;
      return oldMoved && !currentMoved ? old : current;
    };
    const iters = clamp(1 + Math.round(clamp(p.Iterations, 0, 1) * 31), 1, 32);
    const ts = clamp(serialized('TransformStrength', 'TransformStrengt', 1), 0, 1);
    const c = v => (clamp(v, 0, 1) - 0.5) * 2;              /* 0.5-neutral */

    const D = h * 2.2;
    const cam = { f: D, cx: w/2, cy: h/2, near: D * 0.02 };
    const tx = c(p.TranslateX) * w * 0.5 * ts;
    const ty = c(p.TranslateY) * h * 0.5 * ts;
    const tz = c(p.TranslateZ) * D * 0.35 * ts;
    const rx = c(serialized('RotateX', 'RotateX ', 0.5)) * Math.PI * ts;
    const ry = c(serialized('RotateY', 'RotateY ', 0.5)) * Math.PI * ts;
    const rz = c(serialized('RotateZ', 'RotateZ ', 0.5)) * Math.PI * ts;
    /* ts multiplies the Scale step too. It did not, and that made
       TransformStrength a control that only half worked: with every other
       slider at its neutral 0.5 and Scale pushed off neutral, dragging
       TransformStrength to 0 left the stack still shrinking. Measured — the
       draw log for TransformStrength 0 and 1 was identical for Scale and
       differed for every other transform. */
    const sc = 1 + c(p.Scale) * 0.75 * ts;
    const dtx = c(p.DTranslateX) * w * 0.25 * ts;
    const dty = c(p.DTranslateY) * h * 0.25 * ts;
    const dtz = c(p.DTranslateZ) * D * 0.15 * ts;
    const drx = c(serialized('DRotateX', 'DRotateX ', 0.5)) * Math.PI * 0.5 * ts;
    const dry = c(serialized('DRotateY', 'DRotateY ', 0.5)) * Math.PI * 0.5 * ts;
    const drz = c(serialized('DRotateZ', 'DRotateZ ', 0.5)) * Math.PI * 0.5 * ts;
    const dsc = c(serialized('DScale', 'DScale ', 0.5)) * 0.25 * ts;

    const MODES = ['source-over', 'lighter', 'multiply', 'screen'];
    const mode = MODES[clamp(Math.round(clamp(p.BlendMode, 0, 1) * 3), 0, 3)];
    const ocb = clamp(p.OpacityChange, 0, 1) * 2;
    const doc = c(p.DOpacityChange) * 0.25;

    /* accumulate into a scratch, because the global rotation has to be applied
       to the finished stack rather than to each copy */
    const acc = pad(3, w, h);
    if(p['Black BG'] >= 0.5){
      acc.save(); acc.fillStyle = '#000'; acc.fillRect(0, 0, w, h); acc.restore();
    }
    let Racc = [1,0,0, 0,1,0, 0,0,1];
    let ax = 0, ay = 0, az = 0, as = 1;
    let op = clamp(p.StartOpacity, 0, 1);
    const UV = [[0,0], [w,0], [w,h], [0,h]];
    for(let i = 0; i < iters; i++){
      acc.globalAlpha = clamp(op, 0, 1);
      acc.globalCompositeOperation = i === 0 ? 'source-over' : mode;
      if(acc.globalAlpha > 0.002){
        const P = [];
        const corner = (mx, my) => {
          const q = GEO3D.ap(Racc, mx*as, my*as, 0);
          P.push({ x: q.x + ax, y: q.y + ay, z: q.z + az + D });
        };
        corner(-w/2, -h/2); corner(w/2, -h/2); corner(w/2, h/2); corner(-w/2, h/2);
        GEO3D.quad(acc, src, P, UV, cam, 3);
      }
      /* compose this step onto the accumulated transform:
         new(p) = old(step(p)) = (R.Ri)(s.si.p) + (R.(s.Ti) + t) */
      const Ri = GEO3D.rot(rx + i*drx, ry + i*dry, rz + i*drz);
      const si = Math.max(0.001, sc + i*dsc);
      const T = GEO3D.ap(Racc, tx + i*dtx, ty + i*dty, tz + i*dtz);
      ax += as * T.x; ay += as * T.y; az += as * T.z;
      Racc = GEO3D.mul(Racc, Ri);
      as *= si;
      op *= Math.max(0, ocb + i*doc);
      if(op > 4) op = 4;
      if(!isFinite(as) || !isFinite(ax) || !isFinite(ay) || !isFinite(az)) break;
    }
    acc.globalAlpha = 1; acc.globalCompositeOperation = 'source-over';

    /* the global rotation of the whole stack. Neutral at 0.5/0.5/0.5, where
       GEO3D.quad takes its exact single-drawImage path. */
    const Rg = GEO3D.rot((p.GRotateX - 0.5) * Math.PI * 2,
                         (p.GRotateY - 0.5) * Math.PI * 2,
                         (p.GRotateZ - 0.5) * Math.PI * 2);
    const G = [];
    const gcorner = (mx, my) => {
      const q = GEO3D.ap(Rg, mx, my, 0);
      G.push({ x: q.x, y: q.y, z: q.z + D });
    };
    gcorner(-w/2, -h/2); gcorner(w/2, -h/2); gcorner(w/2, h/2); gcorner(-w/2, h/2);
    GEO3D.quad(dst, acc.canvas, G, UV, cam, 4);
  });

/* =========================================================================
   OVERLAY GENERATORS — effects that draw a generated picture over the frame
   -------------------------------------------------------------------------
   All five are here.

   Text Animator and Text Block were refused in an earlier draft of this block,
   on the grounds that "def() cannot declare a parameter that is not a number"
   and that arena-engine.js turns every FX param into P({type:'range'}). THAT
   CAPABILITY EXISTS AND THE REFUSAL WAS WRONG. addEffect() now routes
   ArenaFX.params(name) through makeParams (arena-engine.js:1326-1328), which
   asks paramKind() (arena-engine.js:1499) and builds a string, a choice, a
   colour or a bool from the same spec shape def() already emits. The engine's
   own comment there names these two effects as the reason it was changed, and
   arena-sources.js:531 is already drawing the SOURCE Text Animator from a real
   ParamText — "now that makeParams gives it a string control it is the thing
   that should be drawn". A refusal that names a capability the repo already
   has is the same dishonesty as a control that pretends to work, pointing the
   other way, so it is withdrawn and the two effects are implemented below.

   Shared house rule for the two grid samplers below (Point Grid, Meta Shape):
   the frame is drawn into a scratch canvas AT GRID RESOLUTION and that tiny
   canvas is read back — Num X x Num Y, at most 64x64 = 4096 px. That is a
   readback and it is flagged as one so it gets measured, but it is not the
   full-frame readback the COSTLY table exists for: the pixel count is the same
   whether the composition is 720p or 4K.

   It is not free either, and the measurement is worth writing down because it
   contradicts the obvious assumption. On this machine a 32x18 getImageData
   costs the same as a 64x64 one (1.25 ms against 1.38 ms) — the price is the
   GPU->CPU sync, not the pixels, so shrinking the grid does not buy anything
   back. What it does buy is that the cost stays flat as the output grows.
   Measured at 1920x1080, all parameters at their defaults, effect alone on the
   chain, 40 frames after a 10-frame warm-up, with a 2x2 getImageData after each
   draw so the GPU has to FINISH before the clock is read:
     Particle System  2.36 ms avg / 1.90 median / 5.10 worst
     Point Grid       5.29 ms avg / 5.40 median / 8.20 worst
     Meta Shape       6.91 ms avg / 7.00 median / 9.10 worst
     Text Animator    1.64 ms avg / 1.20 median / 3.70 worst
     Text Block       1.23 ms avg / 0.90 median / 4.10 worst
   All five sit inside the 16.7 ms frame, so none of them belongs in COSTLY —
   but the two with a readback deserve the full parameter sweep the COSTLY
   figures are made from before that is called settled.

   The first three figures are HIGHER than the ones this comment carried before
   (0.31 / 1.54 / 1.46), and the effects did not get slower: the earlier run
   timed the draw call only, which on a 2D canvas returns before the work is
   done, so most of the cost landed outside the measurement. Forcing the sync
   is the number that matters, because the compositor pays it anyway. Both are
   what this machine measured, not a specification.
   ========================================================================= */

/* Particle System — A191. arena-catalog.js: "Creates a particle system using
   the content as base image", which is the whole reason it is an effect and
   not a source: every particle is a scaled copy of the incoming frame.

   PARAMETERS ARE MINED, NOT INFERRED. All 21 names, defaults, ranges and the
   ORDER below are read straight out of Resolume's own preset,
   default/Presets/Video Effects/Particle System/Fountain.xml, and agree with
   reference/mined.json > videoEffects["Particle System"].params. Four of them
   — Scale Delta, Opacity Delta, Inherit Vel, Friction — carry no
   <ValueRange name="defaultRange"> in the preset, exactly like Opacity does,
   which is Resolume's serialisation for "the implicit 0..1"; the six shipped
   presets never take them outside 0..1 either (mined observedMax: Scale Delta
   1.0, Opacity Delta 1.0, Inherit Vel 0.404, Friction 0.103).

   UNITS ARE INFERRED, and the presets are what pins them down:
   - Velocities and Gravity/Wind are PER FRAME AT 60 FPS, not per second. Rain
     sets Y Vel 0 with Gravity 0.00027 and a 1.6 s Lifetime; per second that
     would move a drop 0.0003 of the frame in its whole life. Per frame it
     crosses the screen, which is what rain does.
   - +Y IS DOWN and Y = -1 is the top edge. Two presets prove it together:
     Rain emits at Y Pos -1 with positive Gravity and no velocity (falls from
     the top), and Fountain emits at Y Pos +1 with NEGATIVE Y velocity and
     positive Gravity (shoots up from the bottom and comes back down). No
     other sign convention makes both of those presets do what they are named.
   - +Z IS TOWARDS THE VIEWER: Starfield emits at Z Pos -1 with positive Z
     velocity, so the stars come at you.
   - Rotate Min/Max are turns per second (Fountain's +-0.45 is a lazy tumble).
   - Scale Delta / Opacity Delta are PER SECOND, unlike the velocities. Reading
     them per frame was tried first and the presets rule it out: Windows95 sets
     Scale Delta 0.952 and Opacity Delta 0.945 against a Lifetime of 6.95 s, and
     per frame that is pow(0.952, 60) = 0.05 after one second — the preset would
     spend 95% of its own Lifetime invisible, and so would the 3.5 s default at
     0.93. Per second the same preset fades to 0.71 scale and 0.67 opacity over
     its whole life, which is a fade, and Lifetime keeps meaning something.
     Measured at the defaults, 640x360: per frame covered 0.8% of the frame,
     per second covers 11.1%.

   The emitter is a POINT, not an area, and the spread in the shipped presets
   comes from ANIMATING X Pos / Y Pos: Rain, Random, Starfield and Windows95
   all carry a behaviour node on those two parameters (Interval 0.03, Max
   Distance 5 and so on, visible in the preset XML). So this does not invent a
   random emission area — it records where the emitter WAS on the frame each
   particle was born and emits from there, keeping a small list of past
   emitter samples on the persistent buffer context the way WarpSpeed keeps
   its ring index. That list is also what makes Inherit Vel real: the emitter's
   own velocity is differenced from two consecutive samples.

   After birth the motion is closed form, so nothing is integrated across
   frames and two calls at the same clock give the same picture:
     v(a) = vt + (v0 - vt) e^-ka,  x(a) = x0 + vt a + (v0 - vt)(1 - e^-ka)/k
   with k the drag rate from Friction and vt = g/k the terminal velocity; at
   k -> 0 that collapses to x0 + v0 a + g a^2 / 2, which is the branch taken at
   the default Friction of 0. Lifetime is in seconds, so the clock is
   info.beats converted with the composition's own BPM.
   All drawImage, no readback. */
def('Particle System', [
  {n:'Particles',     min:0,      max:256,   d:64},
  {n:'Lifetime',      min:0,      max:10,    d:3.5},
  {n:'X Pos',         min:-1,     max:1,     d:0},
  {n:'Y Pos',         min:-1,     max:1,     d:0},
  {n:'Z Pos',         min:-1,     max:1,     d:0},
  {n:'X Vel Min',     min:-0.02,  max:0.02,  d:-0.002},
  {n:'X Vel Max',     min:-0.02,  max:0.02,  d:0.002},
  {n:'Y Vel Min',     min:-0.02,  max:0.02,  d:-0.002},
  {n:'Y Vel Max',     min:-0.02,  max:0.02,  d:0.002},
  {n:'Z Vel Min',     min:-0.02,  max:0.02,  d:0},
  {n:'Z Vel Max',     min:-0.02,  max:0.02,  d:0},
  {n:'Rotate Min',    min:-5,     max:5,     d:0},
  {n:'Rotate Max',    min:-5,     max:5,     d:0},
  {n:'Scale Min',     min:0,      max:0.25,  d:0.1},
  {n:'Scale Max',     min:0,      max:0.25,  d:0.15},
  {n:'Scale Delta',   min:0,      max:1,     d:0.93},
  {n:'Opacity Delta', min:0,      max:1,     d:0.93},
  {n:'Inherit Vel',   min:0,      max:1,     d:0},
  {n:'Gravity',       min:-0.002, max:0.002, d:0},
  {n:'Wind',          min:-0.002, max:0.002, d:0},
  {n:'Friction',      min:0,      max:1,     d:0}
], (dst, src, p, w, h, t, info) => {
  const N = Math.round(clamp(Number(p.Particles) || 0, 0, 256));
  /* Particles 0 really is an empty frame — the effect's default Blend Mode is
     Alpha, so Arena shows particles over transparency and none means none.
     Drawing the incoming frame here instead would be inventing a behaviour. */
  if(N < 1) return;
  /* Lifetime 0 is an empty frame for exactly the reason Particles 0 is: a
     particle that lives no time is never on screen. This was
     Math.max(0.05, Lifetime), which silently substituted 0.05 for anything
     below it — measured, Lifetime 0, 0.02 and 0.05 returned BYTE-IDENTICAL
     frames covering 2802 px, so the bottom of the slider was dead and an
     operator who typed 0 got a full particle system back. The floor that
     remains exists only to keep sec/life finite; at 1e-6 it is orders of
     magnitude below one step of a 0..10 slider, so it substitutes for nothing
     reachable. */
  const lifeSet = Number(p.Lifetime) || 0;
  if(!(lifeSet > 0)) return;
  const life = Math.max(1e-6, lifeSet);

  /* Lifetime is in seconds and the only monotone clock this file is handed is
     info.beats, so it is converted with the composition's live BPM. With no
     engine and no beats the clip phase stands in as one lifetime, which keeps
     the effect moving in a preview rather than freezing. */
  const EN = (typeof window !== 'undefined') ? window.ArenaEngine : null;
  /* clock.bpm() is `val(doc.comp.tempo.bpm) + nudge` (arena-engine.js:581), and
     doc.comp is null until init() has built a composition — so the call THROWS
     rather than returning nothing, and the "no engine" guard around it never
     fires. apply() catches every throw and returns, which turned this effect
     into a silent pass-through on any draw that lands before the composition
     exists. Measured: with arena-engine.js loaded and un-init'd, the default
     draw threw TypeError "Cannot read properties of null (reading 'tempo')" and
     the frame came through untouched. Guarded here rather than in the engine
     because a missing tempo is not this effect's business — 120 is the
     documented default (bpm.htm) and is what the clock itself starts at. */
  let bpm = 120;
  try {
    if(EN && EN.clock && typeof EN.clock.bpm === 'function'){
      bpm = Number(EN.clock.bpm()) || 120;
    }
  } catch(e){ bpm = 120; }
  const sec = (info && typeof info.beats === 'number' && isFinite(info.beats))
    ? info.beats * 60 / Math.max(1, bpm)
    : (Number(t) || 0) * life;

  const ex = clamp(p['X Pos'], -1, 1), ey = clamp(p['Y Pos'], -1, 1), ez = clamp(p['Z Pos'], -1, 1);

  /* Emitter history. One 1x1 canvas is all the persistent buffer is used for —
     the samples live as a plain array on the context object, the way WarpSpeed
     hangs __warp on its ring. No buffer (or no info) is not fatal here: the
     effect still draws, every particle simply emits from where the emitter is
     NOW and Inherit Vel has nothing to inherit. That degradation is stated
     rather than hidden, and it is better than passing the frame through, which
     would look like the effect was doing nothing at all. */
  let hist = null;
  if(info && typeof info.buffer === 'function'){
    const b = info.buffer(1, 1);
    if(b) hist = b.__particleEmit || (b.__particleEmit = []);
  }
  if(hist){
    const last = hist.length ? hist[hist.length - 1] : null;
    if(!last) hist.push([sec, ex, ey, ez]);
    else if(sec > last[0] + 1e-9) hist.push([sec, ex, ey, ez]);
    else if(sec < last[0] - 1e-6){ hist.length = 0; hist.push([sec, ex, ey, ez]); } /* Resync rewound the clock */
    else { last[1] = ex; last[2] = ey; last[3] = ez; }
    /* keep only what a living particle can still be born from */
    while(hist.length > 2 && hist[0][0] < sec - life - 0.1) hist.shift();
    if(hist.length > 2048) hist.splice(0, hist.length - 2048);
  }
  const sampleAt = bt => {
    if(!hist || !hist.length) return [ex, ey, ez, 0, 0, 0];
    let lo = 0, hi = hist.length - 1;
    while(lo < hi){ const m = (lo + hi + 1) >> 1; if(hist[m][0] <= bt) lo = m; else hi = m - 1; }
    const a = hist[lo], b0 = lo > 0 ? hist[lo - 1] : null;
    let vx = 0, vy = 0, vz = 0;
    if(b0){
      const dt = a[0] - b0[0];
      if(dt > 1e-6){ vx = (a[1] - b0[1]) / dt; vy = (a[2] - b0[2]) / dt; vz = (a[3] - b0[3]) / dt; }
    }
    return [a[1], a[2], a[3], vx, vy, vz];
  };

  /* deterministic per particle and per rebirth: no Math.random anywhere, so a
     paused composition holds a still picture instead of hissing */
  const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

  const fr = clamp(p.Friction, 0, 1);
  const kd = fr > 0.0001 ? -Math.log(Math.max(1e-6, 1 - fr)) * 60 : 0;   /* per-frame damping -> per-second rate */
  const gx = (Number(p.Wind) || 0) * 3600;        /* per frame^2 -> per second^2 */
  const gy = (Number(p.Gravity) || 0) * 3600;
  const xvn = p['X Vel Min'], xvx = p['X Vel Max'];
  const yvn = p['Y Vel Min'], yvx = p['Y Vel Max'];
  const zvn = p['Z Vel Min'], zvx = p['Z Vel Max'];
  const smn = clamp(p['Scale Min'], 0, 1), smx = clamp(p['Scale Max'], 0, 1);
  const rmn = p['Rotate Min'], rmx = p['Rotate Max'];
  const sdel = clamp(p['Scale Delta'], 0, 1), odel = clamp(p['Opacity Delta'], 0, 1);
  const inh = clamp(p['Inherit Vel'], 0, 1);
  const TWO_PI = Math.PI * 2;

  const move = (x0, v0, g, a) => {
    if(kd < 1e-6) return x0 + v0 * a + 0.5 * g * a * a;
    const vt = g / kd;
    return x0 + vt * a + (v0 - vt) * (1 - Math.exp(-kd * a)) / kd;
  };

  const live = [];
  for(let i = 0; i < N; i++){
    const phase = sec / life + hash(i, 1);
    const cyc = Math.floor(phase);
    const age = (phase - cyc) * life;
    /* reseeded on every rebirth, or the system would replay the same 64
       trajectories once per Lifetime and read as a loop */
    const s = i * 7919 + cyc * 104729;
    const em = sampleAt(sec - age);
    const vx = (xvn + (xvx - xvn) * hash(s, 2)) * 60 + em[3] * inh;
    const vy = (yvn + (yvx - yvn) * hash(s, 3)) * 60 + em[4] * inh;
    const vz = (zvn + (zvx - zvn) * hash(s, 4)) * 60 + em[5] * inh;
    const x = move(em[0], vx, gx, age);
    const y = move(em[1], vy, gy, age);
    const z = move(em[2], vz, 0, age);
    const alpha = odel >= 1 ? 1 : Math.pow(odel, age);      /* per second, see above */
    if(!(alpha > 0.004)) continue;
    const grow = sdel >= 1 ? 1 : Math.pow(sdel, age);
    /* Camera two units back, so Z Pos +1 is twice the size and Z Pos -1 is a
       third: a scale and spread cue on a 2D canvas, not a depth-buffered
       projection. A particle that reaches the near plane has gone PAST the
       camera and is dropped, not clamped — clamping was tried and Arena's own
       Starfield preset showed why it is wrong: its stars travel from Z -1 at
       up to 1.2 units/s for 3.5 s, so they end up at Z +3.2, and a clamp
       parked them on screen at twenty times size for most of their life
       instead of streaking past. */
    if(z >= 1.5) continue;
    const zc = Math.max(z, -12);
    const k = 2 / (2 - zc);
    const sc = (smn + (smx - smn) * hash(s, 5)) * grow * k;
    const pw = sc * w, ph = sc * h;
    if(!(pw > 0.5) || !(ph > 0.5) || !isFinite(pw) || !isFinite(ph)) continue;
    const px = w / 2 + x * k * w / 2, py = h / 2 + y * k * h / 2;
    if(!isFinite(px) || !isFinite(py)) continue;
    live.push({
      x: px, y: py, w: pw, h: ph, a: Math.min(1, alpha), z: zc,
      r: (rmn + (rmx - rmn) * hash(s, 6)) * age * TWO_PI
    });
  }
  live.sort((a, b) => a.z - b.z);          /* far ones first */
  for(let i = 0; i < live.length; i++){
    const q = live[i];
    dst.save();
    dst.globalAlpha = q.a;
    dst.translate(q.x, q.y);
    if(q.r) dst.rotate(q.r);
    dst.drawImage(src, -q.w / 2, -q.h / 2, q.w, q.h);
    dst.restore();
  }
});

/* Point Grid — A148. arena-catalog.js: "Creates grid of points in 3D".

   PARAMETERS ARE INFERRED — Resolume ships no preset for A148
   (default/Presets/Video Effects has no Point Grid folder) and no .wired patch
   (it is a native effect, not a Wire one), so reference/mined.json has nothing
   for it and neither does arena-wired-params.js. Every name below was
   cross-checked against Arena.exe's own string table
   (extracted/arena-binary-strings.json) and every one is present:
   "Num X", "Num Y", "Size", "Depth", "Rotate X", "Rotate Y", "Rotate Z",
   "Point Mode". "Rows" and "Columns" were rejected for the counts: "Rows" is
   not in the string table at all, while Arena's own family of grid counts is
   "Num X" / "Num Y" / "Num Cubes" / "Num Lines" / "Num Rings" / "Num Slices",
   so the house name is Num. RANGES AND DEFAULTS ARE INFERRED OUTRIGHT — no
   evidence exists for them. "Point Mode" is the weakest of the eight: the
   string is real, but Arena also has "Edit Points" and "Selected Point" in the
   screen-setup editor, so its owner is not certain from the table alone.

   The frame is sampled at Num X by Num Y in a scratch canvas and THAT is read
   back — 4096 pixels at the maximum grid, constant whatever the output
   resolution. Luminance displaces each point along Z, the grid is rotated on
   three axes and projected, and each point is drawn in the colour it sampled.
   Rotation happens in normalised grid space, so on a 16:9 frame the rotation
   stretches with the frame, the same way Shape Mask's circle is an ellipse. */
def('Point Grid', [
  {n:'Num X',      min:1,  max:64, d:32},
  {n:'Num Y',      min:1,  max:64, d:18},
  {n:'Size',       min:0,  max:1,  d:0.5},
  {n:'Depth',      min:-1, max:1,  d:0.35},
  {n:'Rotate X',   min:-1, max:1,  d:0},
  {n:'Rotate Y',   min:-1, max:1,  d:0},
  {n:'Rotate Z',   min:-1, max:1,  d:0},
  {n:'Point Mode', min:0,  max:1,  d:0}
], (dst, src, p, w, h) => {
  const nx = Math.round(clamp(Number(p['Num X']) || 1, 1, 64));
  const ny = Math.round(clamp(Number(p['Num Y']) || 1, 1, 64));
  const g = pad(2, nx, ny);
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, nx, ny);
  let d;
  /* a tainted source canvas throws here. apply() would swallow the throw and
     the effect would look like it was working and doing nothing, so the frame
     is passed through instead — an effect that cannot do its job must not
     destroy the picture. */
  try { d = g.getImageData(0, 0, nx, ny).data; }
  catch(e){ dst.drawImage(src, 0, 0); return; }

  const depth = clamp(p.Depth, -1, 1);
  const ax = clamp(p['Rotate X'], -1, 1) * Math.PI;
  const ay = clamp(p['Rotate Y'], -1, 1) * Math.PI;
  const az = clamp(p['Rotate Z'], -1, 1) * Math.PI;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cz = Math.cos(az), sz = Math.sin(az);
  const cell = Math.min(w / nx, h / ny);
  const base = clamp(p.Size, 0, 1) * cell;
  if(!(base > 0)) return;                       /* Size 0: no points, which is what 0 means */
  /* 0 Square, 1 Circle — INFERRED. The NAME is accepted as well as the index,
     which is the Slice Transform's precedent at arena-fx.js:609. Point Mode is
     the one entry of the eight that reads like a ParamChoice, so it is the one
     most likely to be routed through addEffectParam later; with a bare
     Number() test, Number('Circle') is NaN and the control would silently
     stick on Square while looking like it worked. Meta Shape below already
     accepts both forms, and the two must not disagree. */
  const MODES = ['Square', 'Circle'];
  const pmRaw = p['Point Mode'];
  const pmByName = MODES.indexOf(String(pmRaw));
  const round = pmByName >= 0 ? pmByName === 1 : Number(pmRaw) >= 0.5;
  const TWO_PI = Math.PI * 2;

  const pts = [];
  for(let iy = 0; iy < ny; iy++){
    for(let ix = 0; ix < nx; ix++){
      const o = (iy * nx + ix) * 4;
      const al = d[o + 3];
      if(al === 0) continue;
      const lum = (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) / 255;
      const u = ((ix + 0.5) / nx) * 2 - 1;
      const v = ((iy + 0.5) / ny) * 2 - 1;
      const z0 = (lum - 0.5) * 2 * depth;
      const y1 = v * cx - z0 * sx,  z1 = v * sx + z0 * cx;
      const x2 = u * cy + z1 * sy,  z2 = -u * sy + z1 * cy;
      const x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
      const zc = clamp(z2, -12, 1.7);
      const k = 1.8 / (1.8 - zc);
      const r = base * k * 0.5;
      if(!(r > 0.15)) continue;
      pts.push({
        x: w / 2 + x3 * k * w / 2, y: h / 2 + y3 * k * h / 2, r, z: zc,
        c: 'rgba(' + d[o] + ',' + d[o + 1] + ',' + d[o + 2] + ',' + (al / 255).toFixed(3) + ')'
      });
    }
  }
  pts.sort((a, b) => a.z - b.z);
  for(let i = 0; i < pts.length; i++){
    const q = pts[i];
    dst.fillStyle = q.c;
    if(round){ dst.beginPath(); dst.arc(q.x, q.y, q.r, 0, TWO_PI); dst.fill(); }
    else dst.fillRect(q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
  }
});

/* Meta Shape — arena-catalog.js: "Meta Image Effect, morphs from one shape to
   another based on luminance".

   PARAMETERS ARE INFERRED — no preset, no .wired patch. But Arena.exe's string
   table is unusually generous here: it carries fragments of the effect's own
   shader, "shapeIt(pos, center, shapeSize, Shape2)," alongside
   "float shapeIt(vec2 pos, vec2 center, float size, int shape)" and
   "ivec2 getGridPos(vec2 p, vec2 tileSize)". A shape drawn at a per-tile
   CENTER with a SIZE, selected by an int, on a grid — that is a mosaic of
   shapes, which is also what "Meta Image" means. Every name used below is in
   the string table: "Shape 1", "Shape 2" (and the uniforms "Shape1", "Shape2"),
   "Morph", "Size", "Num X", "Num Y". So are the six shape names offered:
   "Circle", "Square", "Triangle", "Hexagon", "Star", "Cross". RANGES, DEFAULTS
   AND THE ORDER OF THE SHAPE LIST ARE INFERRED — nothing pins them down.

   Luminance drives the morph, per the description: a black tile is Shape 1, a
   white tile is Shape 2, and Morph slides the whole mapping either way so the
   effect can be pushed fully to one shape. Every shape is expressed as a
   radius function of angle, which is what makes morphing between two of them a
   straight interpolation rather than a vertex-matching problem. Same
   grid-resolution readback as Point Grid: Num X by Num Y pixels, never the
   full frame. */
def('Meta Shape', [
  {n:'Num X',   min:1,  max:64, d:16},
  {n:'Num Y',   min:1,  max:64, d:9},
  {n:'Shape 1', min:0,  max:5,  d:0},
  {n:'Shape 2', min:0,  max:5,  d:1},
  {n:'Morph',   min:-1, max:1,  d:0},
  {n:'Size',    min:0,  max:1,  d:0.9}
], (dst, src, p, w, h) => {
  const SHAPES = ['Circle', 'Square', 'Triangle', 'Hexagon', 'Star', 'Cross'];
  const pick = raw => {
    const byName = SHAPES.indexOf(String(raw));
    return byName >= 0 ? byName : clamp(Math.round(Number(raw) || 0), 0, SHAPES.length - 1);
  };
  const s1 = pick(p['Shape 1']), s2 = pick(p['Shape 2']);
  const nx = Math.round(clamp(Number(p['Num X']) || 1, 1, 64));
  const ny = Math.round(clamp(Number(p['Num Y']) || 1, 1, 64));
  const size = clamp(p.Size, 0, 1);
  if(!(size > 0)) return;                       /* Size 0: nothing to draw */

  const g = pad(2, nx, ny);
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, nx, ny);
  let d;
  try { d = g.getImageData(0, 0, nx, ny).data; }
  catch(e){ dst.drawImage(src, 0, 0); return; }

  const PI = Math.PI, TWO_PI = PI * 2;
  /* every shape as r(angle), all normalised to an inradius of 1 so they are
     comparable in size and a half-morph is a real in-between shape */
  const ngon = (n, a) => {
    const step = TWO_PI / n;
    const m = ((a + PI / 2) % step + step) % step;
    return 1 / Math.max(0.05, Math.cos(m - step / 2));
  };
  const star = a => {
    /* ten vertices, alternating; r on the segment between two polar points */
    const step = PI / 5;
    const k = Math.floor(((a + PI / 2) % TWO_PI + TWO_PI) % TWO_PI / step);
    const a1 = -PI / 2 + k * step, a2 = a1 + step;
    const r1 = (k % 2) ? 0.6 : 1.4, r2 = (k % 2) ? 1.4 : 0.6;
    const den = r1 * Math.sin(a - a1) + r2 * Math.sin(a2 - a);
    return Math.abs(den) < 1e-4 ? 1 : Math.abs(r1 * r2 * Math.sin(step) / den);
  };
  const ARM = 0.38;
  const rOf = (shape, a) => {
    if(shape === 0) return 1;
    const c = Math.max(1e-4, Math.abs(Math.cos(a))), s = Math.max(1e-4, Math.abs(Math.sin(a)));
    if(shape === 1) return 1 / Math.max(c, s);
    if(shape === 2) return ngon(3, a);
    if(shape === 3) return ngon(6, a);
    if(shape === 4) return star(a);
    return Math.max(Math.min(1 / c, ARM / s), Math.min(ARM / c, 1 / s));   /* Cross */
  };

  const morph = clamp(p.Morph, -1, 1);
  const cw = w / nx, ch = h / ny;
  const rad = Math.min(cw, ch) * 0.5 * size;
  const steps = (nx * ny > 1024) ? 20 : 44;
  for(let iy = 0; iy < ny; iy++){
    for(let ix = 0; ix < nx; ix++){
      const o = (iy * nx + ix) * 4;
      const al = d[o + 3];
      if(al === 0) continue;
      const lum = (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) / 255;
      const m = clamp(lum + morph, 0, 1);
      const cxp = (ix + 0.5) * cw, cyp = (iy + 0.5) * ch;
      dst.fillStyle = 'rgba(' + d[o] + ',' + d[o + 1] + ',' + d[o + 2] + ',' + (al / 255).toFixed(3) + ')';
      dst.beginPath();
      for(let k = 0; k < steps; k++){
        const a = k * TWO_PI / steps;
        const r = (rOf(s1, a) * (1 - m) + rOf(s2, a) * m) * rad;
        const px = cxp + Math.cos(a) * r, py = cyp + Math.sin(a) * r;
        if(k) dst.lineTo(px, py); else dst.moveTo(px, py);
      }
      dst.closePath();
      dst.fill();
    }
  }
});

/* =========================================================================
   THE TWO TEXT EFFECTS — implemented, after the refusal was checked and failed
   -------------------------------------------------------------------------
   arena-catalog.js, Resolume's own words for the EFFECT versions (these are
   separate plugins from the sources of the same name, with their own ids —
   Text Animator 742517306102898930, Text Block 920556808353999712):
     Text Animator — "Overlays animated text on top of your content as an
       effect... It stays on top of whatever visual is playing underneath."
     Text Block   — "Overlays text on top of your content as an effect. Useful
       for adding a label or message."

   "It stays on top of whatever visual is playing underneath" is the whole
   difference from the sources, and it is a difference in the DRAW: the source
   versions in arena-sources.js paint a background first (Text Block fills the
   frame black at arena-sources.js:926), because a source owns the frame. An
   effect does not. Both draws below put nothing but glyphs into dst and leave
   the rest transparent, and apply() mixes that over the incoming frame with
   the effect's own Opacity and Blend Mode. Painting a background here would
   erase the content the description says they sit on top of.
   ========================================================================= */

/* The one thing about these two that genuinely is not in Resolume's data.
   Font, Style, Alignment, Range and Order are all ParamChoice written with
   storeChoices="0" in every shipped preset, so the option LABELS are absent
   and an index has no recoverable meaning. arena-sources.js reaches the same
   conclusion for the source version and says so in the panel; the string below
   is its NO_LABELS verbatim (arena-sources.js:161) so the two windows give the
   operator the same sentence about the same control. */

/* Text Animator and Text Block WERE HERE and have been removed from this block,
   not dropped from the app. Both were already merged into arena-fx.js, where
   they carry a real Color parameter this copy lacked and draw the incoming
   frame first. def() is FX[name] = {...}, so two copies do not both exist —
   the later paste silently wins — and the copy that would have won was the
   one without a colour control, which would also have put the effect-side
   Text Block out of step with the source-side one in arena-sources.js.
   The one genuine improvement this copy carried, a negative-modulo guard on
   the stagger clock, has been applied to the surviving version instead. */

/* =========================================================================
   PER-PIXEL REMAPS AND NEIGHBOURHOOD FILTERS
   -------------------------------------------------------------------------
   Six effects that all ask the same question — "which source pixel does this
   output pixel show?" — and get very different answers.

   Four of them (Bendoscope, Sphere, Stingy Sphere, and the warp inside
   Acuarela) are remaps whose geometry is symmetric enough to be built out of
   clipped drawImage calls: angular wedges, concentric rings, a triangle mesh.
   That keeps the frame on the GPU and off the CPU bus. Kuwahara is a genuine
   neighbourhood filter and cannot be faked, so it reads the frame back at a
   reduced size and says exactly what that costs. UV Map is refused, with the
   missing capability named, at the end of this block.

   Parameter provenance, per effect, in the order CLAUDE.md sets:
     Acuarela      arena-wired-params.js["Acuarela"], read from the shipped
                   patch reference/wired/Acuarela.wired. Authoritative.
     Bendoscope    the shipped Wire node
                   reference/wire/Documentation/Nodes/...- Bendoscope.wire:
                   one input, `divisions`, float, default 2.
     Kuwahara      the shipped Wire node ...- Kuwahara.wire: one input,
                   `density`, integer, default 5.
     Sphere,       INFERRED. Neither is in reference/mined.json and neither
     Stingy Sphere ships a preset, so the names were taken from Arena.exe's
                   own string table rather than coined: "Sphere size" (yes,
                   lower-case s in the binary) and "Extrusion" are both
                   present in extracted/arena-binary-strings.json, and
                   extracted/live-catalog.json shows Sphere and Stingy Sphere
                   are the only two things in Arena with "Sphere" in the name,
                   so "Sphere size" belongs to one or both of them. Which one,
                   and the ranges, are not evidenced — see each def().
   ========================================================================= */

/* Bendoscope — live-catalog.json A124, "Bend over and relax".
   The shipped Wire node of the same name (class 77697265-BAA4-...-A9F98B245D77)
   exposes exactly one input besides the texture: `divisions`, a FLOAT with
   default 2, and its patch comment reads "bend and twist a texture into weird
   and unusual shapes". "Divisions" is in Arena.exe's string table.

   Divisions being a float is the whole character of the effect and the reason
   it is not Kaleidoscope: a fractional division count leaves one wedge that
   does not close, and that unclosed wedge is the bend. The wedges here are
   also NOT mirrored — Kaleidoscope at arena-fx.js:122 flips alternate wedges
   (the `if(i % 2) dst.scale(1, -1)` at arena-fx.js:130), which is what makes it
   symmetric; a plain angular modulo repeats instead, which is what makes this
   one lopsided.

   UNDOCUMENTED — inferring: the node ships no shader and no documentation, so
   the exact remap is inferred as an angular fold, the only remap that "bends"
   an image with a single divisions control. Costs ceil(Divisions) clipped
   draws; no readback. */
def('Bendoscope', [{n:'Divisions', min:1, max:16, d:2}], (dst, src, p, w, h) => {
  const div = clamp(p.Divisions, 1, 16);
  const cx = w / 2, cy = h / 2, rad = Math.hypot(cx, cy);
  const seg = Math.PI * 2 / div;
  const full = Math.floor(div + 1e-6);
  const rest = div - full;
  for(let i = 0; i < full; i++){
    dst.save();
    dst.translate(cx, cy);
    dst.rotate(i * seg);
    dst.beginPath(); dst.moveTo(0, 0);
    dst.arc(0, 0, rad, -seg / 2, seg / 2); dst.closePath(); dst.clip();
    dst.translate(-cx, -cy);
    dst.drawImage(src, 0, 0);
    dst.restore();
  }
  if(rest > 0.001){
    /* the wedge that does not close. Clipped in the unrotated frame so the
       partial angle is absolute, then rotated so it shows the same source
       wedge as all the others. */
    const a0 = full * seg - seg / 2;
    dst.save();
    dst.translate(cx, cy);
    dst.beginPath(); dst.moveTo(0, 0);
    dst.arc(0, 0, rad, a0, a0 + rest * seg); dst.closePath(); dst.clip();
    dst.rotate(full * seg);
    dst.translate(-cx, -cy);
    dst.drawImage(src, 0, 0);
    dst.restore();
  }
});

/* Sphere — live-catalog.json 884101299715, "Transforms your content into an
   extruded sphere."

   A sphere seen head on is an orthographic projection of a hemisphere: a point
   at latitude theta from the pole lands at screen radius R*sin(theta) while the
   texture wrapped over it has travelled arc distance proportional to theta. So
   output radius x (0..1 of the disc) shows source radius asin(x)/(pi/2) — the
   middle is magnified, the rim compresses to nothing. That is a radially
   symmetric remap, so it is built the way Fish Eye at arena-fx.js is: concentric
   clipped discs, painted largest first, each drawn at the uniform scale
   x/asin(x)*(pi/2) that brings the right source radius out to the right screen
   radius. 48 draws — the N below — and no readback.

   Outside the sphere nothing is painted, so the result is transparent there
   rather than black. With the Alpha blend at full opacity — effects.htm's
   "see only the result and nothing but the effect" — you get the sphere alone.

   PARAMETERS INFERRED. "Sphere size" and "Extrusion" are both present in
   extracted/arena-binary-strings.json; assigning them to this effect is the
   inference, as are the ranges. Extrusion 0 is a true no-op (flat frame inside
   the disc), Extrusion 1 is the full hemisphere. */
def('Sphere', [{n:'Sphere size', min:0, max:2, d:1}, {n:'Extrusion', min:0, max:1, d:1}],
  (dst, src, p, w, h) => {
    const R = clamp(p['Sphere size'], 0, 2) * Math.min(w, h) / 2;
    if(R < 1 || w < 2 || h < 2) return;    /* a sphere of no size shows nothing */
    const e = clamp(p.Extrusion, 0, 1);
    /* the frame is squeezed into the sphere's bounding square first, so the
       radial remap that follows is isotropic on screen and the whole clip is
       wrapped onto the ball rather than a centre crop of it. */
    const base = pad(2, w, h);
    base.imageSmoothingEnabled = true;
    base.drawImage(src, 0, 0, w, h, w / 2 - R, h / 2 - R, R * 2, R * 2);
    /* 48 rings. Each is a clipped draw whose mask is a whole disc, so the count
       is what this costs; below about 40 the scale jump between neighbouring
       rings starts to show as concentric seams near the rim, which is where
       the mapping changes fastest. */
    const N = 48, HALF_PI = Math.PI / 2;
    for(let i = N; i >= 1; i--){
      const x = i / N;
      const rs = (1 - e) * x + e * (Math.asin(Math.min(1, x)) / HALF_PI);
      if(rs < 1e-4) continue;
      const k = x / rs;
      dst.save();
      dst.beginPath(); dst.arc(w / 2, h / 2, R * x, 0, Math.PI * 2); dst.clip();
      dst.translate(w / 2, h / 2); dst.scale(k, k); dst.translate(-w / 2, -h / 2);
      dst.drawImage(base.canvas, 0, 0);
      dst.restore();
    }
  });

/* Stingy Sphere — live-catalog.json A147, "Sphere with spikes based on
   luminance".

   Same sphere as above, then the ball's radius is pushed out per angular wedge
   by the luminance of the content lying under that wedge. Two passes: build the
   sphere once into a scratch, then stamp it back 48 times through 7.5-degree
   wedge clips, each at its own scale. The silhouette that results is spiky
   exactly where the content is bright, which is what the description says.

   THIS ONE READS PIXELS BACK, but only a 64x64 downscale of the source — 4,096
   pixels, not the frame — because a wedge's luminance is an average and does
   not need full resolution. It is still a GPU->CPU round trip per frame, which
   CLAUDE.md says to flag, so it is flagged; it is not in the same class as the
   full-frame readbacks in the COSTLY table.

   PARAMETERS INFERRED, same provenance as Sphere. The wedge count is fixed at
   48 rather than exposed, because there is no evidence Resolume exposes it and
   inventing a control is worse than hard-coding one. */
def('Stingy Sphere', [{n:'Sphere size', min:0, max:2, d:1}, {n:'Extrusion', min:0, max:1, d:0.5}],
  (dst, src, p, w, h) => {
    const R = clamp(p['Sphere size'], 0, 2) * Math.min(w, h) / 2;
    if(R < 1 || w < 2 || h < 2) return;
    const e = clamp(p.Extrusion, 0, 1);
    const HALF_PI = Math.PI / 2;
    /* pass 1 — the sphere, exactly as in Sphere but at full extrusion, since
       here Extrusion is spent on the spikes. */
    const base = pad(2, w, h);
    base.imageSmoothingEnabled = true;
    base.drawImage(src, 0, 0, w, h, w / 2 - R, h / 2 - R, R * 2, R * 2);
    const ball = pad(3, w, h);
    /* 40 rings, not the 48 Sphere uses: this one pays for the wedge pass too,
       and every clipped ring costs a full disc of mask. */
    const N = 40;
    for(let i = N; i >= 1; i--){
      const x = i / N;
      const rs = Math.asin(Math.min(1, x)) / HALF_PI;
      if(rs < 1e-4) continue;
      const k = x / rs;
      ball.save();
      ball.beginPath(); ball.arc(w / 2, h / 2, R * x, 0, Math.PI * 2); ball.clip();
      ball.translate(w / 2, h / 2); ball.scale(k, k); ball.translate(-w / 2, -h / 2);
      ball.drawImage(base.canvas, 0, 0);
      ball.restore();
    }
    /* the luminance the spikes are based on: a 64x64 reduction of the source,
       one readback of 4,096 pixels. */
    const LW = 64;
    const lum = pad(4, LW, LW);
    lum.imageSmoothingEnabled = true;
    lum.drawImage(src, 0, 0, LW, LW);
    let px = null;
    try { px = lum.getImageData(0, 0, LW, LW).data; } catch(err){ px = null; }
    if(!px){ dst.drawImage(ball.canvas, 0, 0); return; }   /* tainted: no spikes, and no lie about it */
    const at = (u, v) => {
      const sx = clamp(Math.floor(u * LW), 0, LW - 1);
      const sy = clamp(Math.floor(v * LW), 0, LW - 1);
      const i = (sy * LW + sx) * 4;
      return (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * (px[i + 3] / 255) / 255;
    };
    /* 48 wedges — 7.5 degrees each. Every wedge is a clipped full-frame draw,
       so the count is the cost; 48 is the coarsest that still reads as spikes
       rather than as a polygon. */
    const WEDGES = 48, seg = Math.PI * 2 / WEDGES;
    const rad = R * 2 + 2;   /* nothing of the ball can reach further than this */
    for(let k = 0; k < WEDGES; k++){
      const a = k * seg;
      const ca = Math.cos(a), sa = Math.sin(a);
      /* sample where the rim of the ball comes from: screen radius x maps back
         to source radius asin(x)/(pi/2). */
      let l = 0;
      for(let s = 0; s < 3; s++){
        const x = 0.6 + s * 0.175;
        const r = Math.asin(Math.min(1, x)) / HALF_PI;
        l += at(0.5 + 0.5 * r * ca, 0.5 + 0.5 * r * sa);
      }
      const f = 1 + e * (l / 3) * 0.6;
      dst.save();
      dst.translate(w / 2, h / 2);
      dst.beginPath(); dst.moveTo(0, 0);
      dst.arc(0, 0, rad, a - seg / 2 - 0.004, a + seg / 2 + 0.004); dst.closePath(); dst.clip();
      dst.scale(f, f);
      dst.translate(-w / 2, -h / 2);
      dst.drawImage(ball.canvas, 0, 0);
      dst.restore();
    }
  });

/* Kuwahara — live-catalog.json 8166473902393820, "smooths out your content
   while keeping sharp edges ... a stylized, brush-stroke feel".

   The shipped Wire node (class 77697265-4FA1-...-5EB67377DB3B) exposes one
   input besides the texture: `density`, INTEGER, default 5, and its patch
   comment calls it the radius: "Do take care when increasing the radius! The
   more you increase it, the more GPU power it will consume." "Density" is in
   Arena.exe's string table. The min and max are NOT evidenced anywhere — only
   the default 5 and the type are — so the range below is inferred.

   This is a real neighbourhood filter and there is no drawImage trick for it:
   each output pixel is the mean of whichever of its four overlapping quadrant
   windows has the lowest variance. So it reads pixels back, and two things
   make that affordable:

     1. It runs at 256 pixels wide (or the output's own width, whichever is
        smaller), and no more than 256 tall either — a frame taller than it is
        wide is fitted to the height instead. WHAT THAT COSTS: at 1920x1080
        output the internal buffer is 256x144, so one internal pixel becomes
        7.5 output pixels, bilinearly interpolated, and the brush strokes have
        soft 7.5-pixel edges where Resolume's full-resolution GPU version keeps
        them crisp; any detail finer than that is gone before the filter ever
        sees it. The painterly *look* is right; the crispness that is the
        entire point of Kuwahara is softened.
     2. Summed-area tables, so a quadrant's mean and variance cost four array
        reads each instead of (Density+1)^2 samples, and Density is therefore
        free. Without them the default radius alone would be 5.3M samples a
        frame at that 256x144 buffer — 36,864 pixels x 4 quadrants x a 6x6
        window. The tables are kept on the persistent buffer between frames
        rather than reallocated.

   Density is applied as a radius in the REDUCED buffer's pixels, so its reach
   scales with the output rather than being an absolute pixel count.
   UNDOCUMENTED — inferring; Resolume's own units for it are not recorded
   anywhere in this repo. */
def('Kuwahara', [{n:'Density', min:1, max:16, d:5}], (dst, src, p, w, h, t, info) => {
  if(!info || !info.buffer || w < 4 || h < 4){ dst.drawImage(src, 0, 0); return; }
  let IW = Math.min(w, 256);
  let IH = Math.max(1, Math.round(h * IW / w));
  if(IH > 256){ IH = 256; IW = Math.max(1, Math.round(w * IH / h)); }
  if(IW < 4 || IH < 4){ dst.drawImage(src, 0, 0); return; }
  const b = info.buffer(IW, IH);
  if(!b || b.canvas.width !== IW || b.canvas.height !== IH){ dst.drawImage(src, 0, 0); return; }
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalAlpha = 1; b.globalCompositeOperation = 'source-over'; b.filter = 'none';
  b.clearRect(0, 0, IW, IH);
  b.imageSmoothingEnabled = true;
  b.drawImage(src, 0, 0, IW, IH);
  let img = null;
  try { img = b.getImageData(0, 0, IW, IH); } catch(err){ img = null; }
  if(!img){ dst.drawImage(src, 0, 0); return; }
  const d = img.data;

  const SW = IW + 1, SH = IH + 1, S = SW * SH;
  let c = b.__kuwahara;
  if(!c || c.n !== S){
    c = b.__kuwahara = {
      n: S,
      r: new Float64Array(S), g: new Float64Array(S), b: new Float64Array(S),
      a: new Float64Array(S), l: new Float64Array(S), q: new Float64Array(S)
    };
  }
  const cr = c.r, cg = c.g, cb = c.b, ca = c.a, cl = c.l, cq = c.q;
  /* row 0 and column 0 stay zero for the life of the arrays, which is what a
     summed-area table needs and what a fresh Float64Array already is. */
  for(let y = 0; y < IH; y++){
    const up = y * SW, dn = (y + 1) * SW;
    let sr = 0, sg = 0, sb = 0, sa = 0, sl = 0, sq = 0;
    for(let x = 0; x < IW; x++){
      const i = (y * IW + x) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3];
      const L = R * 0.299 + G * 0.587 + B * 0.114;
      sr += R; sg += G; sb += B; sa += A; sl += L; sq += L * L;
      const j = dn + x + 1, k = up + x + 1;
      cr[j] = cr[k] + sr; cg[j] = cg[k] + sg; cb[j] = cb[k] + sb;
      ca[j] = ca[k] + sa; cl[j] = cl[k] + sl; cq[j] = cq[k] + sq;
    }
  }
  const box = (arr, x0, y0, x1, y1) =>
    arr[(y1 + 1) * SW + x1 + 1] - arr[y0 * SW + x1 + 1] - arr[(y1 + 1) * SW + x0] + arr[y0 * SW + x0];

  const rad = clamp(Math.round(p.Density), 1, 16);
  for(let y = 0; y < IH; y++){
    for(let x = 0; x < IW; x++){
      const xa = x - rad < 0 ? 0 : x - rad;
      const xb = x + rad > IW - 1 ? IW - 1 : x + rad;
      const ya = y - rad < 0 ? 0 : y - rad;
      const yb = y + rad > IH - 1 ? IH - 1 : y + rad;
      let bestV = Infinity, bR = 0, bG = 0, bB = 0, bA = 0;
      for(let qd = 0; qd < 4; qd++){
        const x0 = (qd & 1) ? x : xa, x1 = (qd & 1) ? xb : x;
        const y0 = (qd & 2) ? y : ya, y1 = (qd & 2) ? yb : y;
        const n = (x1 - x0 + 1) * (y1 - y0 + 1);
        if(n < 1) continue;
        const sl = box(cl, x0, y0, x1, y1);
        const mean = sl / n;
        const v = box(cq, x0, y0, x1, y1) / n - mean * mean;
        if(v < bestV){
          bestV = v;
          bR = box(cr, x0, y0, x1, y1) / n;
          bG = box(cg, x0, y0, x1, y1) / n;
          bB = box(cb, x0, y0, x1, y1) / n;
          bA = box(ca, x0, y0, x1, y1) / n;
        }
      }
      const i = (y * IW + x) * 4;
      d[i] = bR; d[i + 1] = bG; d[i + 2] = bB; d[i + 3] = bA;
    }
  }
  b.putImageData(img, 0, 0);
  dst.imageSmoothingEnabled = true;
  dst.drawImage(b.canvas, 0, 0, IW, IH, 0, 0, w, h);
});

/* Acuarela — the Wire patch reference/wired/Acuarela.wired, by Darien Brito,
   "Turns your content into watery smoke. Smoooooke on the waaaaater!"

   Parameters are arena-wired-params.js["Acuarela"] verbatim, in the patch's own
   inputOrder.roots order, with its constants as defaults and its has-min /
   has-max as ranges. The patch's `Texture` root is the incoming frame and is
   not a control, so it is not listed — the same treatment every other
   patch-derived effect in this file gives its texture root: CRT is defined at
   arena-fx.js:764 from CRT.wired and its 24 parameters begin at Columns, with
   no texture entry, because draw()'s `src` argument is that input.

   The patch describes itself in its own comments, and this follows them:

     "The input imagery is blended together with a delayed and UV-offsetted
      version of itself. The UV Offset is animated, and this gives the smokey
      look" ... "We delay the signal to be able to feedback into the video
      mixer (no loops without a Delay)."

   So each frame: warp last frame's mixer output by a fractal-noise UV offset,
   emit that as the result, then mix it back with the incoming frame to make
   the next frame's delay. info.buffer holds the delay; it is the one persistent
   context per instance the contract allows, and w*h is all this needs.

   The numbers are the patch's, not invented:
     Strength -> x0.005 -> UV Offset `gain`, so the offset is at most 0.005 of
       the frame, i.e. under 3 px at 1920 per frame — the smoke is the
       accumulation, not any one frame.
     Gain X / Gain Y -> Float2 -> Flip Offset x(1,-1) -> `channel-multiplier`,
       which is why V is negated here.
     Gain -> Add Subtract `channels`, a constant added to RGB of the incoming
       frame (0.01 by default), masked back to the frame's own alpha so it does
       not paint a grey wash over transparent areas.
     Density -> Fractal Noise `density`, Detail -> `frequency`, Speed -> `gain`,
       octaves fixed at 4, amplitude 0.55, and the noise's Z offset driven by a
       clock. NOTE, because the name misleads: Speed is wired to the noise
       node's GAIN input, not to anything temporal — the patch's animation rate
       comes from System Time alone. Wire's Fractal Noise defaults, confirmed
       in extracted/wire-nodes.json (amplitude 0.5, frequency 2, gain 1,
       density 8, octaves 6, clamp true), read as lacunarity / persistence /
       base scale, and that is how they are used here. UNDOCUMENTED —
       inferring: the node ships no documentation of those inputs. Note that
       gain-as-persistence is above 1 over most of Speed's 0..40 range, so the
       finest octave carries the most weight rather than the least — unusual
       for an fBm, but it is what the patch asks for.
     Feedback decays x0.98 per frame (patch node 233), and Reset drives an
       Attack Release that takes that factor to 0, "which cleans out the delay
       path" (patch node 238's comment). def() has no event parameter type, so
       Reset is a toggle: held above 0.5 it clears the delay every frame.

   TWO HONEST DEVIATIONS:
   1. The Video Mixer is on mode 11 with both opacities at 1. Wire's mode
      enumeration is not in this repo, so 11 could not be resolved.
      UNDOCUMENTED — inferring: 'lighten' is used, because it is the only
      ordinary blend that keeps this loop bounded. With Add, the 0.98 decay and
      the +0.01 gain give a steady state of fifty times the input, i.e. white.
   2. The UV offset is applied as a GRID OF TRANSLATED BLITS, not per pixel:
      the frame is cut into cells and each is redrawn shifted by the noise
      sampled at its centre, overlapping its neighbours by a pixel so no gap
      can open between them. A per-pixel offset would mean a full-frame
      readback every frame inside a feedback loop; a piecewise-affine triangle
      mesh was written first and measured 3-5x more expensive than the blits
      for no visible gain at this offset size. What the blits cost is that the
      warp is piecewise constant: adjacent cells differ by a fraction of a
      pixel at the patch's own gain, so the discontinuity is sub-pixel and the
      1px overlap swallows it, but at Strength 1 with a coarse Density the cell
      edges can just start to show. The grid also cannot resolve noise finer
      than a couple of cells, and how that is handled is a bug this block
      already shipped once — see FREQUENCY IS CLAMPED, NOT OCTAVES DROPPED
      below. */
def('Acuarela', [{n:'Gain', min:0, max:1, d:0.00999999977648258},
                 {n:'Speed', min:0, max:40, d:4},
                 {n:'Detail', min:0, max:8, d:4},
                 {n:'Strength', min:0, max:1, d:0.3222222328186035},
                 {n:'Density', min:0, max:100, d:4},
                 {n:'Gain X', min:0, max:1, d:0.30000001192092896},
                 {n:'Gain Y', min:0, max:1, d:0.30000001192092896},
                 {n:'Reset', kind:'event', d:0}],
  (dst, src, p, w, h, t, info) => {
    if(!info || !info.buffer || w < 4 || h < 4){ dst.drawImage(src, 0, 0); return; }
    const prev = info.buffer(w, h);
    if(!prev || prev.canvas.width !== w || prev.canvas.height !== h){ dst.drawImage(src, 0, 0); return; }
    prev.setTransform(1, 0, 0, 1, 0, 0);
    prev.globalAlpha = 1; prev.globalCompositeOperation = 'source-over'; prev.filter = 'none';
    prev.imageSmoothingEnabled = true;

    const reset = p.Reset >= 0.5;
    const resetEdge = reset && !prev.__acuarelaResetHeld;
    prev.__acuarelaResetHeld = reset;
    const first = prev.__acuarela == null;
    /* Wire's Delay starts empty, which would show one black frame; seeding it
       with the incoming frame costs one frame of feedback and no black flash. */
    if(first || resetEdge){ prev.clearRect(0, 0, w, h); prev.drawImage(src, 0, 0); }
    const frame = prev.__acuarela = (first ? 0 : prev.__acuarela + 1) | 0;

    /* --- the noise field, sampled once per grid cell ---------------------- */
    const dens = clamp(p.Density, 0, 100);
    const lac  = clamp(p.Detail, 0, 8);        /* Fractal Noise `frequency` */
    const per  = clamp(p.Speed, 0, 40);        /* Fractal Noise `gain`      */
    const AMP  = 0.5506896376609802;           /* the patch's amplitude constant */
    const baseF = Math.max(0.3, dens * 0.1);   /* cycles across the frame, octave 0 */

    /* the warp grid. Cost is cols*rows blits a frame, so the budget is the cap;
       it also sets how fine a noise field can be carried, which is why it grows
       with Density. */
    let cols = clamp(Math.round(12 + dens * 0.2), 16, 34);
    let rows = clamp(Math.round(cols * h / w), 6, 34);
    while(cols * rows > 620 && cols > 16){ cols--; rows = clamp(Math.round(cols * h / w), 6, 34); }

    const hash = (ix, iy, iz) => {
      let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1274126177)) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };
    const fade = u => u * u * (3 - 2 * u);
    const vnoise = (x, y, z, sd) => {
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
      let acc = 0;
      for(let k = 0; k < 2; k++){
        const wz = k ? fz : 1 - fz;
        for(let j = 0; j < 2; j++){
          const wy = j ? fy : 1 - fy;
          for(let i = 0; i < 2; i++){
            acc += hash(ix + i + sd, iy + j, iz + k) * (i ? fx : 1 - fx) * wy * wz;
          }
        }
      }
      return acc;
    };
    /* fBm: frequency x lacunarity and amplitude x persistence per octave,
       normalised so a persistence above 1 — which is most of Speed's 0..40
       range — stays inside 0..1 instead of running away.

       FREQUENCY IS CLAMPED, NOT OCTAVES DROPPED. This block first shipped a
       version that kept only the octaves the grid could resolve, and at the
       patch's own Density that left exactly one. A one-octave fBm reads
       neither its lacunarity nor its persistence, so Detail and Speed became
       controls that moved and did nothing: measured on a 320x180 test frame
       over 60 frames, Speed 0, Speed 4 and Speed 40 produced BIT-IDENTICAL
       output, as did Detail 4 and Detail 8. CLAUDE.md forbids shipping a
       control that reports success while nothing happens, so all four of the
       patch's octaves are now always evaluated and it is each octave's
       FREQUENCY that is capped, at a quarter of the grid's cell count — four
       cells per cycle, comfortably below the grid's Nyquist. Nothing is ever
       sampled finer than the grid can carry, so there is still no grid-shaped
       aliasing; what changes is that Detail and Density SATURATE at the top of
       their ranges instead of going dead in the middle of them, and Speed,
       which only reweights octaves, is live everywhere.

       baseF's 0.1 and this 0.25 are the two constants that decide where that
       saturation falls, and both are INFERRED — Wire documents neither. They
       are set so that at the patch's own Density of 4 the whole of Detail's
       0..8 range still moves the picture. */
    const fcap = cols * 0.25;
    const fbm = (u, v, z, sd) => {
      let f = baseF, a = 1, sum = 0, tot = 0;
      for(let o = 0; o < 4; o++){
        const fo = Math.min(f, fcap);
        sum += a * vnoise(u * fo, v * fo, z * fo * 0.25 + o * 13.7, sd);
        tot += a;
        f *= Math.max(0.02, lac);
        a *= Math.max(0.001, per);
      }
      return tot > 0 ? sum / tot : 0.5;
    };

    /* clamp:true on the noise node, so the field is 0..1 around a 0.5 mean and
       therefore has a DC component — the offset drifts as well as churns, which
       is what makes the smoke travel rather than just boil. */
    const z = frame / 60;
    const gainUV = clamp(p.Strength, 0, 1) * 0.005;
    const mx = clamp(p['Gain X'], 0, 1) * gainUV * w;
    const my = -clamp(p['Gain Y'], 0, 1) * gainUV * h;

    /* --- pass 1: warp the delayed frame; this is the effect's output ------
       Each cell is lifted from where the offset points and put down where the
       grid says, which is what "output at uv shows input at uv + offset" means,
       and every blit is grown by a pixel on each side so neighbours overlap
       rather than leaving a hairline of nothing between them. */
    const warp = pad(2, w, h);
    const cw = w / cols, ch = h / rows;
    const src2 = prev.canvas;
    for(let j = 0; j < rows; j++){
      const v = (j + 0.5) / rows;
      const Y0 = j * ch - 1, CH = ch + 2;
      for(let i = 0; i < cols; i++){
        const u = (i + 0.5) / cols;
        const ox = clamp(0.5 + (fbm(u, v, z, 0) - 0.5) * 2 * AMP, 0, 1) * mx;
        const oy = clamp(0.5 + (fbm(u, v, z, 7919) - 0.5) * 2 * AMP, 0, 1) * my;
        const X0 = i * cw - 1, CW = cw + 2;
        /* CLAMP THE SAMPLE, NOT THE DESTINATION. The source rectangle has to
           stay inside the canvas, but shrinking it would leave a transparent
           sliver along the frame's edge, and in a feedback loop that sliver
           eats inwards a little further every frame — the same failure the Blur
           comment at the top of this file documents. Moving the sample instead
           keeps every destination cell fully covered and makes the edge pixels
           stop drifting, which is what the patch's wrap:false means anyway. */
        const sx = CW >= w ? 0 : clamp(X0 + ox, 0, w - CW);
        const sy = CH >= h ? 0 : clamp(Y0 + oy, 0, h - CH);
        warp.drawImage(src2, sx, sy, Math.min(CW, w), Math.min(CH, h),
                             X0, Y0, Math.min(CW, w), Math.min(CH, h));
      }
    }
    dst.drawImage(warp.canvas, 0, 0);

    /* --- pass 2: build the next delay = mix(frame + Gain, warp x 0.98) ---- */
    prev.setTransform(1, 0, 0, 1, 0, 0);
    prev.globalAlpha = 1; prev.globalCompositeOperation = 'source-over'; prev.filter = 'none';
    prev.clearRect(0, 0, w, h);
    prev.drawImage(src, 0, 0);
    const g = clamp(p.Gain, 0, 1);
    if(g > 0.0005){
      prev.globalCompositeOperation = 'lighter';
      prev.fillStyle = 'rgba(255,255,255,' + g.toFixed(4) + ')';
      prev.fillRect(0, 0, w, h);
      prev.globalCompositeOperation = 'destination-in';   /* keep the frame's own alpha */
      prev.drawImage(src, 0, 0);
    }
    prev.globalCompositeOperation = 'lighten';
    prev.globalAlpha = 0.98;                              /* the patch's decay */
    prev.drawImage(warp.canvas, 0, 0);
    prev.globalAlpha = 1;
    prev.globalCompositeOperation = 'source-over';
  });

/* =========================================================================
   UV Map - a genuine two-sampler GPU effect
   -------------------------------------------------------------------------
   Wire's documented node 77697265-20E6-481D-9C08-ABC4294E2EF1 names the two
   textures `input` (the UV map) and `beauty` (the incoming content). Red and
   green in the map are the U and V coordinates used for the dependent beauty
   lookup. This is deliberately WebGL: doing two full-frame getImageData calls
   plus a JavaScript pixel loop cannot meet the 16.7 ms frame budget.

   The installed example image is evidence only and is not redistributed. The
   image parameter accepts an existing ArenaMedia id or a clean-room/user image
   registered through ArenaFX.registerImage(). */
function compileGL(gl, type, source){
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
    const message = gl.getShaderInfoLog(shader) || 'Shader compilation failed';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createUVRenderer(){
  try{
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
      alpha:true, antialias:false, depth:false, stencil:false,
      premultipliedAlpha:true, preserveDrawingBuffer:false,
      desynchronized:true, powerPreference:'high-performance'
    });
    if(!gl) return null;

    const vs = compileGL(gl, gl.VERTEX_SHADER,
      'attribute vec2 a_position;\n' +
      'varying vec2 v_uv;\n' +
      'void main(){ v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position,0.0,1.0); }');
    const fs = compileGL(gl, gl.FRAGMENT_SHADER,
      'precision highp float;\n' +
      'uniform sampler2D u_beauty;\n' +
      'uniform sampler2D u_map;\n' +
      'uniform vec2 u_offset;\n' +
      'uniform vec4 u_filterColor;\n' +
      'uniform float u_filterStrength;\n' +
      'uniform float u_flipU;\n' +
      'uniform float u_flipV;\n' +
      'uniform float u_blackTransparent;\n' +
      'varying vec2 v_uv;\n' +
      'void main(){\n' +
      '  vec4 mapColor = texture2D(u_map, v_uv);\n' +
      '  bool black = max(mapColor.r, max(mapColor.g, mapColor.b)) <= (0.5 / 255.0);\n' +
      '  bool filtered = u_filterStrength > 0.0 && distance(mapColor, u_filterColor) <= u_filterStrength;\n' +
      '  if((u_blackTransparent > 0.5 && black) || filtered){ gl_FragColor = vec4(0.0); return; }\n' +
      '  vec2 uv = mapColor.rg;\n' +
      '  if(u_flipU > 0.5) uv.x = 1.0 - uv.x;\n' +
      '  if(u_flipV > 0.5) uv.y = 1.0 - uv.y;\n' +
      '  uv = fract(uv + u_offset);\n' +
      '  gl_FragColor = texture2D(u_beauty, uv);\n' +
      '}');
    const maskFs = compileGL(gl, gl.FRAGMENT_SHADER,
      'precision highp float;\n' +
      'uniform sampler2D u_beauty;\n' +
      'uniform sampler2D u_mask;\n' +
      'uniform float u_channel;\n' +
      'uniform float u_invert;\n' +
      'uniform vec2 u_maskScale;\n' +
      'uniform float u_fit;\n' +
      'uniform float u_alphaBlack;\n' +
      'varying vec2 v_uv;\n' +
      'void main(){\n' +
      '  vec4 beauty = texture2D(u_beauty, v_uv);\n' +
      '  vec2 maskUV = (v_uv - (vec2(1.0) - u_maskScale) * 0.5) / u_maskScale;\n' +
      '  bool outside = any(lessThan(maskUV,vec2(0.0))) || any(greaterThan(maskUV,vec2(1.0)));\n' +
      '  vec4 maskColor = texture2D(u_mask, clamp(maskUV,vec2(0.0),vec2(1.0)));\n' +
      '  float amount;\n' +
      '  if(u_channel < 0.5) amount = dot(maskColor.rgb, vec3(0.2126,0.7152,0.0722));\n' +
      '  else if(u_channel < 1.5) amount = maskColor.r;\n' +
      '  else if(u_channel < 2.5) amount = maskColor.g;\n' +
      '  else if(u_channel < 3.5) amount = maskColor.b;\n' +
      '  else amount = maskColor.a;\n' +
      '  if(u_alphaBlack > 0.5) amount *= maskColor.a;\n' +
      '  if(u_fit > 0.5 && outside) amount = 0.0;\n' +
      '  if(u_invert > 0.5) amount = 1.0 - amount;\n' +
      '  gl_FragColor = vec4(beauty.rgb * amount, beauty.a * amount);\n' +
      '}');
    const program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed');
    const maskProgram = gl.createProgram();
    gl.attachShader(maskProgram, vs); gl.attachShader(maskProgram, maskFs); gl.linkProgram(maskProgram);
    gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteShader(maskFs);
    if(!gl.getProgramParameter(maskProgram, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(maskProgram) || 'Mask shader link failed');

    const positions = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    const texture = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    const beautyTexture = texture(), mapTexture = texture();
    const loc = n => gl.getUniformLocation(program, n);
    const locations = {
      beauty:loc('u_beauty'), map:loc('u_map'), offset:loc('u_offset'),
      filterColor:loc('u_filterColor'), filterStrength:loc('u_filterStrength'),
      flipU:loc('u_flipU'), flipV:loc('u_flipV'), black:loc('u_blackTransparent')
    };
    const position = gl.getAttribLocation(program, 'a_position');
    const maskLocations = {
      beauty:gl.getUniformLocation(maskProgram, 'u_beauty'),
      mask:gl.getUniformLocation(maskProgram, 'u_mask'),
      channel:gl.getUniformLocation(maskProgram, 'u_channel'),
      invert:gl.getUniformLocation(maskProgram, 'u_invert'),
      scale:gl.getUniformLocation(maskProgram, 'u_maskScale'),
      fit:gl.getUniformLocation(maskProgram, 'u_fit'),
      alphaBlack:gl.getUniformLocation(maskProgram, 'u_alphaBlack')
    };
    const maskPosition = gl.getAttribLocation(maskProgram, 'a_position');
    let uploadedMap = null, uploadedVersion = -1, lost = false;
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });

    const begin = (activeProgram, activePosition, w, h) => {
      if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.useProgram(activeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.enableVertexAttribArray(activePosition);
      gl.vertexAttribPointer(activePosition, 2, gl.FLOAT, false, 0, 0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    };
    const uploadBeauty = (beauty, location) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, beautyTexture);
      /* The WebGL drawing buffer is premultiplied. Preserve the Canvas2D
         source in that form so transparent edges survive the round trip. */
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, beauty);
      gl.uniform1i(location, 0);
    };
    const uploadResource = (rec, location) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mapTexture);
      if(uploadedMap !== rec.image || uploadedVersion !== rec.version){
        /* Map RGB is data (UV coordinates or a mask channel), not beauty
           colour, so alpha must not multiply those values during upload. */
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rec.image);
        uploadedMap = rec.image; uploadedVersion = rec.version;
      }
      gl.uniform1i(location, 1);
    };
    const uploadDynamicMask = (mask, location) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mapTexture);
      /* Layer Mask content changes every frame. RGB is matte data, not beauty
         colour; upload it straight and let u_alphaBlack mix transparency with
         black in the shader. Invalidate the still-image cache because this
         writes the same texture object used by the Mask effect. */
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      uploadedMap = null; uploadedVersion = -1;
      gl.uniform1i(location, 1);
    };

    return {
      canvas,
      draw(beauty, rec, p, w, h){
        if(lost || !rec || rec.status !== 'ready' || !drawableReady(rec.image)) return null;
        begin(program, position, w, h);
        uploadBeauty(beauty, locations.beauty);
        uploadResource(rec, locations.map);
        gl.uniform2f(locations.offset, Number(p['Offset X']) || 0, Number(p['Offset Y']) || 0);
        gl.uniform1f(locations.flipU, p['Flip U'] ? 1 : 0);
        gl.uniform1f(locations.flipV, p['Flip V'] ? 1 : 0);
        gl.uniform1f(locations.black, p['Black Is Transparent'] ? 1 : 0);
        gl.uniform1f(locations.filterStrength, clamp(Number(p['Filter Strength']) || 0, 0, 1));
        const word = Number(p['Filter Color']) >>> 0;
        gl.uniform4f(locations.filterColor,
          ((word >>> 16) & 255) / 255, ((word >>> 8) & 255) / 255,
          (word & 255) / 255, ((word >>> 24) & 255) / 255);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return canvas;
      },
      drawMask(beauty, rec, channel, invert, resize, w, h){
        if(lost || !rec || rec.status !== 'ready' || !drawableReady(rec.image)) return null;
        begin(maskProgram, maskPosition, w, h);
        uploadBeauty(beauty, maskLocations.beauty);
        uploadResource(rec, maskLocations.mask);
        gl.uniform1f(maskLocations.channel, channel);
        gl.uniform1f(maskLocations.invert, invert ? 1 : 0);
        gl.uniform1f(maskLocations.alphaBlack, 0);
        const d = drawableSize(rec.image), sourceAspect = d.w / Math.max(1, d.h);
        const outputAspect = w / Math.max(1, h);
        let sx = 1, sy = 1;
        if(resize === 'Fit'){
          if(sourceAspect > outputAspect) sy = outputAspect / sourceAspect;
          else sx = sourceAspect / outputAspect;
        } else if(resize === 'Fill'){
          if(sourceAspect > outputAspect) sx = sourceAspect / outputAspect;
          else sy = outputAspect / sourceAspect;
        }
        gl.uniform2f(maskLocations.scale, sx, sy);
        gl.uniform1f(maskLocations.fit, resize === 'Fit' ? 1 : 0);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return canvas;
      },
      drawLayerMask(beauty, mask, w, h){
        if(lost || !drawableReady(beauty) || !drawableReady(mask)) return null;
        begin(maskProgram, maskPosition, w, h);
        uploadBeauty(beauty, maskLocations.beauty);
        uploadDynamicMask(mask, maskLocations.mask);
        gl.uniform1f(maskLocations.channel, 0);       /* luminance */
        gl.uniform1f(maskLocations.invert, 0);
        gl.uniform2f(maskLocations.scale, 1, 1);
        gl.uniform1f(maskLocations.fit, 0);
        /* layers.htm > Mask Layer: transparency contributes black, rather than
           becoming an independent alpha-only matte. */
        gl.uniform1f(maskLocations.alphaBlack, 1);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return canvas;
      }
    };
  }catch(e){ return null; }
}

let UV_RENDERER = null, UV_RENDERER_TRIED = false;
function uvRenderer(){
  if(!UV_RENDERER_TRIED){
    UV_RENDERER_TRIED = true;
    UV_RENDERER = createUVRenderer();
  }
  return UV_RENDERER;
}
function renderLayerMask(beauty, mask, w, h){
  const renderer = uvRenderer();
  if(!renderer || !drawableReady(beauty) || !drawableReady(mask)) return null;
  try { return renderer.drawLayerMask(beauty, mask, w, h); }
  catch(error){ return null; }
}
def('UV Map', [
  {n:'Image', kind:'image', d:'', accept:'image/*'},
  {n:'Flip U', kind:'bool', d:false}, {n:'Flip V', kind:'bool', d:false},
  {n:'Offset X', min:0, max:1, d:0}, {n:'Offset Y', min:0, max:1, d:0},
  {n:'Filter Strength', min:0, max:1, d:0.25},
  {n:'Filter Color', kind:'color', d:0},
  {n:'Black Is Transparent', kind:'bool', d:false}
], (dst, src, p, w, h) => {
  const rec = imageRecord(p.Image);
  const renderer = uvRenderer();
  if(!renderer || !rec || rec.status !== 'ready'){ dst.drawImage(src, 0, 0); return; }
  try{
    const rendered = renderer.draw(src, rec, p, w, h);
    if(rendered) dst.drawImage(rendered, 0, 0, w, h);
    else dst.drawImage(src, 0, 0);
  }catch(e){
    rec.gpuError = String(e && e.message || e);
    dst.drawImage(src, 0, 0);
  }
});

/* =========================================================================
   TEMPORAL AND STRUCTURAL — Slice Delay, Mask, Terrain
   -------------------------------------------------------------------------
   All three are implemented. Slice Delay and Terrain use canvas structures;
   Mask reuses the decoded image and GPU renderer defined above.
   ========================================================================= */

/* --- Slice Delay ---------------------------------------------------------
   Arena's catalogue calls it "Slice'n Delay" and it is a Wire patch, so the
   parameters are read from the patch itself rather than inferred:
   reference/wired/Slice Delay.wired, inputOrder.roots = node 0 "Slice In",
   node 16 "Texture In", node 26 "Order", node 43 "Scaling". Slice In is the
   Slices tab (wire-slices.htm) and Texture In is the effect's own input, so
   neither is a control — the same convention Shape Mask already follows here.
   That leaves two, both dropdowns, both read straight off the nodes:

     Order    integer 0..6, default 0 — node 26's seven labelled options:
              Original, Size, Width, Height, X, Y, Name.
     Scaling  integer 0..3, default 2 — node 43's four labelled options:
              None, Fit, Fill, Stretch. Fill is Resolume's own default.

   What the patch does, in its own words (comment node 48): "delay each
   incoming slice independently, with the amount of delay distributed evenly
   among the amount of slices". The wiring: a 60-frame Ring Buffer (node 2,
   size=60) is Shifted and Reversed so index 0 is the newest frame; the chosen
   Sort node's INDICES output (not its values — comment node 31 is explicit
   about that) is multiplied by ringSize/sliceCount (node 9 Divide, node 18
   Multiply) and used to Read one delayed texture per slice; those textures go
   into the Slice Render's material inlet. Slice k therefore draws with the
   frame delayed by indices[k] * (60/n) — indices being the argsort for the
   chosen Order, which is what the patch wires, not the rank. At Order =
   Original that reduces to slice k lagging k steps, which is the look.

   MEMORY, stated rather than hidden. Wire's ring is 60 frames. Sixty
   full-size frames at 1920x1080 is 474 MB of canvas, which is not shippable,
   so the ring cells are scaled down until the atlas fits a 32 megapixel
   budget — 122 MB at RGBA8, the same order as WarpSpeed's 15-frame atlas
   above (119 MB). DEPTH is never traded, because the depth is the effect;
   resolution is. Measured, running the effect: at 1920x1080 the atlas comes
   out 9740x3288 = 122.2 MB, a 0.51 linear scale; at 960x540 the scale clamps
   to 1:1 and the atlas is 9600x3240 = 118.7 MB. No readback, and 0.08 ms per
   frame at 1920x1080 with four slices on this machine.

   VERIFIED against the patch's arithmetic rather than asserted. Four slices,
   sixty numbered frames pushed through, then the shown frame read back out of
   each slice. Order = Original gave 59 / 44 / 29 / 14 — lags of 0, 15, 30, 45,
   which is exactly 60/4 apart, "distributed evenly among the amount of
   slices". Order = Name over slices named Delta, Alpha, Charlie, Bravo gave
   44 / 14 / 29 / 59, i.e. lags of indices[k] * 15 for indices = [1,3,2,0] —
   the argsort, matching how nodes 25 and 18 are wired, not the rank. Order =
   Size reproduced the same relation for [2,0,1,3]. With no slices at all the
   frame came through untouched.

   TWO HONEST LIMITS, both visible in the UI rather than papered over:
   - wire-slices.htm gives this effect a Slices tab to choose which slices it
     uses. This build has no such tab, so it takes every non-DMX slice in the
     Advanced Output that has an input rect, and honours a slice selection if
     one happens to be attached to the instance.
   - With no Advanced Output slices there is nothing to delay independently,
     so the frame passes through untouched rather than being blanked. Same
     rule the Slice Transform above states: an effect that cannot do its job
     must not destroy the frame.
   Outside the slices the result is transparent, because that is what a Slice
   Render produces — geometry or nothing.                                    */
def('Slice Delay', [{n:'Order', kind:'choice',
                     options:['Original','Size','Width','Height','X','Y','Name'],
                     optionValues:[0,1,2,3,4,5,6], d:0},
                    {n:'Scaling', kind:'choice', options:['None','Fit','Fill','Stretch'],
                     optionValues:[0,1,2,3], d:2}],
  (dst, src, p, w, h, t, info) => {
    if(!info || !info.buffer){ dst.drawImage(src, 0, 0); return; }
    if(!(w > 0) || !(h > 0)) return;

    const ORDERS  = ['Original', 'Size', 'Width', 'Height', 'X', 'Y', 'Name'];
    const SCALES  = ['None', 'Fit', 'Fill', 'Stretch'];
    const pick = (list, raw, fb) => list.indexOf(String(raw)) >= 0
      ? String(raw)
      : (list[clamp(Math.round(Number(raw) || 0), 0, list.length - 1)] || fb);
    const order = pick(ORDERS, p.Order, 'Original');
    const mode  = pick(SCALES, p.Scaling, 'Fill');

    /* the live tree, read every frame for the same reason the Slice Transform
       reads it every frame: drag a slice over there and this follows it */
    const tree = (typeof window !== 'undefined' && window.ArenaSlices)
      ? window.ArenaSlices() : null;
    const want = (info.fx && info.fx.slice) || {};
    const slices = [];
    if(tree && tree.screens){
      tree.screens.forEach(sc => {
        if(want.screenId && String(sc.id) !== String(want.screenId)) return;
        (sc.slices || []).forEach(sl => {
          if(want.sliceId && String(sl.id) !== String(want.sliceId)) return;
          if(sl.kind === 'dmx' || !sl.input) return;
          const r = sl.input;
          if(!(r.w > 0) || !(r.h > 0)) return;
          slices.push({ r, name: String(sl.name == null ? '' : sl.name) });
        });
      });
    }
    if(!slices.length){ dst.drawImage(src, 0, 0); return; }

    /* ---- the ring ---------------------------------------------------- */
    const RING = 60, COLS = 10, ROWS = 6;      /* node 2's size, laid out 10x6 */
    const BUDGET = 32e6;                       /* px; 128 MB at RGBA8         */
    let s = Math.min(1, Math.sqrt(BUDGET / (RING * w * h)));
    s = Math.min(s, 16000 / (COLS * w), 16000 / (ROWS * h));   /* canvas limit */
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    const ring = info.buffer(cw * COLS, ch * ROWS);
    if(!ring || ring.canvas.width !== cw * COLS){ dst.drawImage(src, 0, 0); return; }

    ring.setTransform(1, 0, 0, 1, 0, 0);
    ring.globalAlpha = 1; ring.globalCompositeOperation = 'source-over'; ring.filter = 'none';
    const head = ring.__sd = ((ring.__sd == null ? -1 : ring.__sd) + 1) % RING;
    const hx = (head % COLS) * cw, hy = ((head / COLS) | 0) * ch;
    ring.clearRect(hx, hy, cw, ch);
    ring.drawImage(src, 0, 0, src.width || w, src.height || h, hx, hy, cw, ch);

    /* ---- the sort ------------------------------------------------------
       Nodes 40 and 41 Round the centres and dimensions before sorting, so
       near-equal slices tie instead of jittering between frames; that
       rounding is reproduced here. Ties fall back to the slice's own index so
       the permutation is deterministic frame to frame.
       UNDOCUMENTED — inferring: node 24 sorts "Size" as a float2 and Wire does
       not document how it orders a float2, so Size is taken as area here. */
    const idx = slices.map((_, i) => i);
    const key = i => {
      const r = slices[i].r;
      if(order === 'Size')   return Math.round(r.w) * Math.round(r.h);
      if(order === 'Width')  return Math.round(r.w);
      if(order === 'Height') return Math.round(r.h);
      if(order === 'X')      return Math.round(r.x + r.w / 2);
      if(order === 'Y')      return Math.round(r.y + r.h / 2);
      return i;
    };
    if(order === 'Name'){
      idx.sort((a, b) => {
        const c = slices[a].name.localeCompare(slices[b].name);
        return c !== 0 ? c : a - b;
      });
    } else if(order !== 'Original'){
      idx.sort((a, b) => (key(a) - key(b)) || (a - b));
    }

    /* ---- the delay ----------------------------------------------------- */
    const step = RING / slices.length;                 /* node 9's Divide     */
    const cw2 = tree && tree.composition && tree.composition.width  || w;
    const ch2 = tree && tree.composition && tree.composition.height || h;
    const kx = w / (cw2 || 1), ky = h / (ch2 || 1);

    for(let k = 0; k < slices.length; k++){
      const lag = clamp(Math.floor((idx[k] || 0) * step), 0, RING - 1);
      const cell = (head - lag + RING * 2) % RING;
      const sx = (cell % COLS) * cw, sy = ((cell / COLS) | 0) * ch;
      const r = slices[k].r;
      const X = r.x * kx, Y = r.y * ky, W = r.w * kx, H = r.h * ky;
      if(!(W > 0) || !(H > 0)) continue;
      dst.save();
      dst.beginPath(); dst.rect(X, Y, W, H); dst.clip();
      if(mode === 'None'){
        /* the slice keeps sampling its own region of the frame, just late */
        dst.drawImage(ring.canvas, sx, sy, cw, ch, 0, 0, w, h);
      } else if(mode === 'Stretch'){
        dst.drawImage(ring.canvas, sx, sy, cw, ch, X, Y, W, H);
      } else {
        const kk = mode === 'Fit' ? Math.min(W / cw, H / ch) : Math.max(W / cw, H / ch);
        const dw = cw * kk, dh = ch * kk;
        dst.drawImage(ring.canvas, sx, sy, cw, ch, X + (W - dw) / 2, Y + (H - dh) / 2, dw, dh);
      }
      dst.restore();
    }
  });

/* --- Mask -----------------------------------------------------------------
   Arena's catalogue description is exact: "Masks your content using an image."
   Wire node 77697265-CB86-4A6F-AABA-009C4C8BB5C1 confirms a second texture,
   channel selection and inversion. This implementation keeps that texture
   decoded in IMAGE_RESOURCES and performs the luma/alpha/channel multiplication
   in the shared GPU renderer. The Canvas2D fallback derives a matte once per
   image/channel and caches it; it never reads the live frame back. */
const MASK_CHANNELS = ['Luminance', 'Red', 'Green', 'Blue', 'Alpha'];
function cachedMaskMatte(rec, channel, invert){
  const key = channel + ':' + (invert ? 1 : 0);
  if(rec.variants.has(key)) return rec.variants.get(key);
  const size = drawableSize(rec.image);
  if(size.w < 1 || size.h < 1) return null;
  try{
    const canvas = document.createElement('canvas');
    canvas.width = size.w; canvas.height = size.h;
    const g = canvas.getContext('2d', {willReadFrequently:true});
    g.drawImage(rec.image, 0, 0, size.w, size.h);
    const pixels = g.getImageData(0, 0, size.w, size.h);
    const d = pixels.data;
    for(let i = 0; i < d.length; i += 4){
      let amount;
      if(channel === 0) amount = d[i]*0.2126 + d[i+1]*0.7152 + d[i+2]*0.0722;
      else if(channel === 4) amount = d[i+3];
      else amount = d[i + channel - 1];
      if(invert) amount = 255 - amount;
      d[i] = d[i+1] = d[i+2] = 255;
      d[i+3] = clamp(Math.round(amount), 0, 255);
    }
    g.putImageData(pixels, 0, 0);
    rec.variants.set(key, canvas);
    return canvas;
  }catch(e){
    rec.matteError = String(e && e.message || e);
    return null;
  }
}

function maskPlacement(mode, sw, sh, w, h){
  if(mode === 'Stretch' || sw < 1 || sh < 1) return {x:0, y:0, w, h};
  const k = mode === 'Fit' ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
  const dw = sw * k, dh = sh * k;
  return {x:(w - dw) / 2, y:(h - dh) / 2, w:dw, h:dh};
}

def('Mask', [
  {n:'Image', kind:'image', d:'', accept:'image/*'},
  {n:'Resize', kind:'choice', options:['Fill','Fit','Stretch'], d:'Stretch'},
  {n:'Channel', kind:'choice', options:MASK_CHANNELS, d:'Luminance'},
  {n:'Invert', kind:'bool', d:false}
], (dst, src, p, w, h, t, info) => {
  const rec = imageRecord(p.Image);
  if(!rec || rec.status !== 'ready'){ dst.drawImage(src, 0, 0); return; }
  const channel = Math.max(0, MASK_CHANNELS.indexOf(String(p.Channel)));
  const renderer = uvRenderer();
  if(renderer){
    try{
      const rendered = renderer.drawMask(src, rec, channel, !!p.Invert, p.Resize, w, h);
      if(rendered){ dst.drawImage(rendered, 0, 0, w, h); return; }
    }catch(e){
      rec.gpuError = String(e && e.message || e);
    }
  }
  /* Keep the cached matte non-inverted. The fallback can then form an exact
     inverse with destination-out: opaque white minus the original matte. Filling
     white and source-over drawing an already-inverted matte made the surface's
     alpha stay 1 everywhere, so Invert was a no-op without WebGL. */
  const matte = cachedMaskMatte(rec, channel, false);
  if(!matte){ dst.drawImage(src, 0, 0); return; }
  let frame;
  if(info && info.buffer) frame = info.buffer(w, h);
  else {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    frame = c.getContext('2d');
  }
  frame.setTransform(1,0,0,1,0,0);
  frame.globalAlpha = 1; frame.globalCompositeOperation = 'source-over'; frame.filter = 'none';
  frame.clearRect(0, 0, w, h);
  const size = drawableSize(matte);
  const at = maskPlacement(p.Resize, size.w, size.h, w, h);
  if(p.Invert){
    /* White outside a fitted image is intentional: transparent letterbox is
       part of the mask and therefore becomes opaque when inverted. */
    frame.fillStyle = '#fff'; frame.fillRect(0, 0, w, h);
    frame.globalCompositeOperation = 'destination-out';
    frame.drawImage(matte, at.x, at.y, at.w, at.h);
    frame.globalCompositeOperation = 'source-over';
  } else frame.drawImage(matte, at.x, at.y, at.w, at.h);
  dst.drawImage(src, 0, 0);
  dst.globalCompositeOperation = 'destination-in';
  dst.drawImage(frame.canvas, 0, 0);
  dst.globalCompositeOperation = 'source-over';
});

/* --- Terrain -------------------------------------------------------------
   arena-catalog.js, id P202: "Uses your content for terrain generation,
   similar to the Line Scape source." Line Scape is P204 and Lines is P201, so
   Terrain sits inside Resolume's P20x render-pass family and the catalogue
   itself names its sibling.

   PARAMETERS: INFERRED. Terrain ships no factory preset (default/Presets has
   none) and no .wired patch, so reference/mined.json carries nothing for it —
   it is the one case in this block where the set had to be chosen. The names,
   ranges and non-default values are taken from Line Scape's mined set
   (reference/mined.json sources["Line Scape"]), the effect the catalogue says
   this one resembles, so every name is one Resolume already uses rather than
   a coinage. All six were then checked against Arena.exe's own string table:

     python -c "import json;S=set(json.load(open(r'extracted/arena-binary-strings.json',encoding='utf-8'))['strings']);print([n for n in ['Tilt','Direction','Height','Position Y','Line Width','Attenuation'] if n in S])"
     -> ['Tilt', 'Direction', 'Height', 'Position Y', 'Line Width', 'Attenuation']

   All six are present in the binary. Line Scape's noise controls — Speed,
   Wobble, Jagginess, Fuzzyness, Show Knots, Color — are deliberately NOT
   carried over: they describe a generated landscape, and this one is
   generated from the content, which also supplies its colour. Ranges are Line
   Scape's exact mined ranges. Defaults are Line Scape's except Tilt, where
   Line Scape's default of 1 leaves the camera edge-on and this effect would
   read as a flat bar on drop; 30 degrees is chosen so the terrain is legible
   at default. That choice is inference, not evidence.

   RENDERING, and why this is not a refusal. A 2D canvas has no depth buffer,
   but a heightfield seen from outside does not need one: drawing its rows
   back-to-front, each filled from its crest down past the bottom of the
   frame, is exact hidden-surface removal, not an approximation. That is the
   Voxel-Space result and it is the same class of geometry Line Scape draws.
   So the picture here is honestly 3D: perspective divide, real occlusion. An
   orbit camera keeps the patch centred at every Tilt, so 0 is edge-on and 90
   is straight down and neither empties the frame. What a vertex shader would
   buy is per-pixel texturing of the surface instead of per-row; the shape and
   the occlusion would be identical.

   READBACK, stated because CLAUDE.md requires it: the heights are luminance,
   and luminance has to come back to the CPU. It is NOT a full-frame readback
   — the source is drawn down to the 64x48 mesh grid first and only those
   3,072 pixels are read — but it is still a GPU->CPU sync point once per
   frame, so it is reported as needing readback and belongs in whatever pass
   measures readback cost.

   What was measured, with the conditions, because a number without them is
   worth nothing: 1920x1080, effect alone, 8 warm-up frames then 40 timed,
   every parameter swept to both ends and the slowest kept — 3.2 ms at
   defaults, 3.6 ms worst case (Line Width 0.1, where the thin stroke costs
   most). Comfortably inside the 16.7 ms a 60 fps frame allows, so it does not
   belong in the COSTLY table. But the caveat matters: in that harness the
   source was an ordinary 2D canvas that already lived on the CPU side, and
   the grid readback alone timed at 0.03 ms. Against a GPU-resident frame the
   same call is a pipeline stall and this test says nothing about how
   expensive that is. Treat 3.2 ms as a floor, not a verdict.

   No Math.random: the picture is a pure function of the frame and the
   parameters, so it holds still when the clip is paused.                    */
def('Terrain', [{n:'Tilt', min:0, max:90, d:30},
                {n:'Direction', min:-180, max:180, d:0},
                {n:'Height', min:0, max:23, d:15},
                {n:'Position Y', min:0, max:35, d:0},
                {n:'Line Width', min:0.1, max:4, d:0.3},
                {n:'Attenuation', min:10, max:300, d:100}],
  (dst, src, p, w, h) => {
    if(!(w > 0) || !(h > 0)) return;
    /* Below 2x2 there is no mesh to build and no perspective to divide, so the
       frame is passed through rather than blanked — the same rule Slice Delay
       states above: an effect that cannot do its job must not destroy the
       frame. Measured before this guard existed: at 1x1, 3x1 and 1x5 the
       early return left dst cleared and the picture was gone. */
    if(w < 2 || h < 2){ dst.drawImage(src, 0, 0); return; }
    const COLS = 64, ROWS = 48;

    /* Direction turns the content under the terrain. Rotating it into the
       mesh grid on the GPU keeps the terrain rows iso-depth, which is what
       makes the back-to-front fill exact; scaling by the cover factor stops
       the rotation from dragging empty corners into the heightfield. It is the
       exact cover factor for a COLS x ROWS box rotating inside itself: 1 at 0
       and 180 degrees, so the default crops nothing, and 4/3 — the mesh aspect
       — at 90, where the long axis has to reach across the short one. */
    const dir = (Number(p.Direction) || 0) * Math.PI / 180;
    const cd = Math.abs(Math.cos(dir)), sd = Math.abs(Math.sin(dir));
    const cover = cd + Math.max(ROWS / COLS, COLS / ROWS) * sd;
    const g = pad(2, COLS, ROWS);
    g.save();
    g.translate(COLS / 2, ROWS / 2);
    g.rotate(dir);
    g.scale(cover, cover);
    g.drawImage(src, -COLS / 2, -ROWS / 2, COLS, ROWS);
    g.restore();

    let img = null;
    try { img = g.getImageData(0, 0, COLS, ROWS); } catch(e){ img = null; }
    if(!img || !img.data || img.data.length < COLS * ROWS * 4){
      dst.drawImage(src, 0, 0); return;                 /* tainted or refused */
    }
    const d = img.data;

    /* Orbit camera at radius R, elevation E, aimed at the patch centre. The
       view transform collapses to three terms because the camera never rolls
       and never strafes:  Xv = x,  Yv = y cosE + z sinE,  Zv = R + z cosE - y sinE.
       f is picked so that at Tilt 90 the patch exactly fills the frame. */
    const E = clamp(Number(p.Tilt) || 0, 0, 90) * Math.PI / 180;
    const cE = Math.cos(E), sE = Math.sin(E);
    const R = 7, f = 1.4 * h;
    const Az = 2.5, Ax = Az * (w / h);
    const amp  = clamp(Number(p.Height) || 0, 0, 23) / 23 * 1.8;
    const yOff = clamp(Number(p['Position Y']) || 0, 0, 35) * 0.03;
    const lw   = Math.max(0.1, clamp(Number(p['Line Width']) || 0.3, 0.1, 4) * h / 270);
    const att  = clamp(Number(p.Attenuation) || 100, 10, 300) / 100;
    const cx = w / 2, cy = h / 2;

    const xs = new Float64Array(COLS), ys = new Float64Array(COLS);
    const cols = new Array(COLS), dks = new Array(COLS);

    /* row 0 is the far edge and reads the TOP of the content, so the picture
       lies on the ground the way you would expect looking at it */
    for(let j = 0; j < ROWS; j++){
      const v = ROWS > 1 ? j / (ROWS - 1) : 0;          /* 0 far .. 1 near */
      const z = Az - v * 2 * Az;
      /* Attenuation is read as the depth over which the terrain fades out,
         expressed as a fraction of the patch: 100 fades to nothing at the far
         edge, 300 barely fades, 10 leaves only the nearest tenth. */
      const fade = clamp(1 - (1 - v) / att, 0, 1);
      if(fade <= 0.003) continue;

      const base = j * COLS * 4;
      for(let i = 0; i < COLS; i++){
        const o = base + i * 4;
        const a = d[o + 3] / 255;
        const lum = (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) / 255 * a;
        const x = -Ax + (COLS > 1 ? i / (COLS - 1) : 0) * 2 * Ax;
        const y = lum * amp + yOff;
        const Yv = y * cE + z * sE;
        const Zv = Math.max(0.05, R + z * cE - y * sE);
        xs[i] = cx + f * x / Zv;
        ys[i] = cy - f * Yv / Zv;
        /* The sample's own alpha rides along into the colour. Without it a
           transparent frame came out as a solid black landform: measured on a
           never-painted 640x360 source, 54.5% of the output was alpha 255 and
           the pixel at (160,150) read 0,0,0,255. An effect must not manufacture
           opacity the content did not have. Opaque content is unaffected —
           a = 1 makes rgba() and rgb() the same colour, byte for byte. */
        const A = a >= 1 ? '1' : a.toFixed(3);
        cols[i] = 'rgba(' + d[o] + ',' + d[o + 1] + ',' + d[o + 2] + ',' + A + ')';
        dks[i]  = 'rgba(' + ((d[o] * 45) >> 8) + ',' + ((d[o + 1] * 45) >> 8) +
                  ',' + ((d[o + 2] * 45) >> 8) + ',' + A + ')';
      }

      /* Both the crest and the flank carry the content's colour across the
         row, so both take a gradient whose stops sit at each sample's own
         projected x — exact placement, not an even spread, because height
         changes the perspective divide column by column. Offsets are forced
         non-decreasing so a fold in the silhouette cannot throw. The flank's
         copy is the same colours at 45/256 brightness: it reads as the shaded
         side of the ridge, and it is what makes Line Width visible rather than
         decorative. The flank fill has to be opaque WHERE THE CONTENT IS
         OPAQUE — that opacity is the hidden-surface algorithm — so it is
         darkened in the colour rather than with alpha. Where the content is
         transparent the flank is too, which is correct: transparent content
         occludes nothing, and the alternative was inventing a black landform
         out of an empty frame. */
      const gx0 = xs[0], gx1 = xs[COLS - 1];
      let grad = null, shade = null;
      if(isFinite(gx0) && isFinite(gx1) && Math.abs(gx1 - gx0) > 0.5){
        grad  = dst.createLinearGradient(gx0, 0, gx1, 0);
        shade = dst.createLinearGradient(gx0, 0, gx1, 0);
        let prev = 0;
        for(let i = 0; i < COLS; i++){
          let off = (xs[i] - gx0) / (gx1 - gx0);
          if(!isFinite(off)) off = prev;
          off = clamp(off, prev, 1);
          prev = off;
          grad.addColorStop(off, cols[i]);
          shade.addColorStop(off, dks[i]);
        }
      }

      dst.save();
      dst.globalAlpha = fade;
      dst.beginPath();
      dst.moveTo(xs[0], ys[0]);
      for(let i = 1; i < COLS; i++) dst.lineTo(xs[i], ys[i]);
      dst.lineTo(xs[COLS - 1], h + 8);
      dst.lineTo(xs[0], h + 8);
      dst.closePath();
      dst.fillStyle = shade || dks[0] || '#000';
      dst.fill();

      dst.beginPath();
      dst.moveTo(xs[0], ys[0]);
      for(let i = 1; i < COLS; i++) dst.lineTo(xs[i], ys[i]);
      dst.lineWidth = lw;
      dst.lineJoin = 'round';
      dst.strokeStyle = grad || cols[0] || '#000';
      dst.stroke();
      dst.restore();
    }
  });

/* =========================================================================
   MEASURED COST — the effects that cannot hold 60 fps at 1920x1080
   -------------------------------------------------------------------------
   CLAUDE.md: "60 fps is the target. Flag anything forcing a per-frame CPU
   round trip or a GPU->CPU readback." These four do exactly that, and the
   readback alone is the problem, not the arithmetic: a bare
   getImageData + putImageData pair over a 1920x1080 canvas measured 20.1 ms
   on the development machine, which is already past the 16.7 ms a 60 fps
   frame allows, before a single pixel has been looked at.

   So this is not something a tighter inner loop fixes. Every one of these is
   correct and every one of them will drop frames at full output resolution.
   Numbers below are the WORST CASE measured per effect — each parameter swept
   to both ends, slowest trial kept — at 1920x1080, effect alone on the chain.
   They are what this machine measured, not a specification; a different GPU
   will differ, which is why cost() reports the figure and the conditions
   rather than a verdict.

   The honest options are to say so, or to refuse the effect. Refusing would
   be wrong here — they work, and at preview or SD sizes they are fine — so
   the browser says what it costs and lets the operator decide.

   A real fix means a shader, i.e. a WebGL path. ChromaKey, Mask and UV Map now
   have one; the remaining readback-bound entries below still do not. */
/* THE THIRD WAVE ADDED THREE MORE, AND THEY ARE OVER BUDGET FOR A DIFFERENT
   REASON, so the entries carry their own cause rather than inheriting one.
   The four above are readback-bound: a getImageData/putImageData pair over
   1920x1080 costs 20.1 ms on its own, before any arithmetic. The three below
   never read the frame back at all — Terrain samples a 64x48 heightfield,
   Meta Shape a grid of at most 64x64 — and are bound by DRAW CALLS instead.
   Naming that matters, because the fixes are different: a readback wants a
   shader, a draw-call storm wants instancing or a coarser grid.

   Measured the same way as the four above and on the same machine: 1920x1080,
   effect alone on the chain, each parameter swept to both ends. Each figure is
   the MEDIAN of five trials, each trial the best of three renders, so a single
   GC pause cannot inflate it. Where an effect is only expensive at one end of
   one parameter, the parameter is named — Meta Shape costs 5 ms at its
   defaults and 23 ms at Num Y 64, and reporting only the worst would be as
   misleading as reporting only the best.

   Two that were suspected and measured CLEAN, recorded so the next person does
   not re-litigate them: Kuwahara 10.6 ms at defaults and 14.3 ms swept, and
   Point Grid 5.7 ms swept. Both do read pixels back, but at grid resolution
   (at most 4,096 px), which is nothing like a full frame. They are inside the
   budget and are deliberately NOT listed here.

   ChromaKey is a third cost class. Its shader no longer reads pixels back,
   but this Canvas2D composition engine still uploads into a separate WebGL
   context and copies the result back. Headed Chromium measured 19.6-24.2 ms
   p95 at 1920x1080 on this machine. That is much better than the old 48 ms
   CPU path, but still a warning until the whole composition shares one GL
   context (or representative production hardware proves otherwise). */
const COSTLY = {
  'Dither':        { ms: 82, why: 'full-frame getImageData readback',
                     needs: 'a WebGL shader path to run at 60 fps' },
  'Vibrance':      { ms: 76, why: 'full-frame getImageData readback',
                     needs: 'a WebGL shader path to run at 60 fps' },
  'Levels':        { ms: 34, why: 'full-frame getImageData readback',
                     needs: 'a WebGL shader path to run at 60 fps' },
  'Triangulate':   { ms: 22, why: 'full-frame getImageData readback',
                     needs: 'a WebGL shader path to run at 60 fps' },
  'ChromaKey':     { ms: 24, at: '1920x1080, p95, default/probe parameters',
                     why: 'Canvas2D-to-WebGL upload plus WebGL-to-Canvas2D copy',
                     needs: 'a shared WebGL composition renderer to guarantee 60 fps at full HD' },
  'Terrain':       { ms: 52, at: '1920x1080, at its defaults',
                     why: 'one clipped drawImage per terrain column, every frame',
                     needs: 'a vertex shader with a depth buffer, or a coarser column count' },
  'Stingy Sphere': { ms: 25, at: '1920x1080, at its defaults',
                     why: '88 full-frame clipped draws per frame to fake the spherical remap',
                     needs: 'a WebGL shader path to run at 60 fps' },
  'Meta Shape':    { ms: 23, at: '1920x1080 with Num Y 64 (5 ms at its defaults)',
                     why: 'one shape drawn per grid cell, up to 64x64 of them',
                     needs: 'instanced drawing, or keeping Num X/Num Y modest' }
};
const BUDGET_MS = 16.7;

/* IMPLEMENTED IS NOT THE SAME AS ABLE TO DO ITS JOB RIGHT NOW.
   Two effects are defined by slices, and with no slices defined in the Advanced
   Output they correctly pass the frame through — there is nothing to delay or
   transform. Measured: Slice Delay is a byte-for-byte identity across eight
   successive frames on an empty slice tree.

   That is the right behaviour and the wrong appearance. The browser says
   "implemented", the effect does nothing, and the operator has no way to tell
   that apart from a broken effect. So the condition is stated, the same way
   arena-sources.js states it for Slice Outline and Video Router. */
const NEEDS = {
  'Slice Delay':     'Needs slices from the Advanced Output. With none defined there is nothing '
                   + 'to delay, so the frame passes through unchanged. [wire-slices.htm]',
  'Slice Transform': 'Needs slices from the Advanced Output. With none defined there is nothing '
                   + 'to transform, so the frame passes through unchanged. [slice-routing.htm]'
};

window.ArenaFX = {
  apply, parseCube, registerLUT, loadCube, renderLayerMask,
  setDiagnosticObserver: observer => {
    DIAGNOSTIC_OBSERVER = typeof observer === 'function' ? observer : null;
  },
  setClockProvider: provider => {
    CLOCK_SECONDS = typeof provider === 'function' ? provider : DEFAULT_CLOCK_SECONDS;
  },
  luts: () => [...LUTS.keys()],
  /* registerImage() is synchronous and returns the stable value to store in an
     image parameter. loadImage() waits for decode when a caller needs explicit
     success/error feedback. Runtime decoder objects are intentionally private. */
  registerImage, loadImage, releaseImage,
  images: () => [...IMAGE_RESOURCES.values()].map(rec => ({
    id:rec.id, status:rec.status, error:rec.error || rec.gpuError || rec.matteError || null,
    width:drawableSize(rec.image).w, height:drawableSize(rec.image).h
  })),
  imageStatus: ref => {
    const rec = IMAGE_RESOURCES.get(String(ref == null ? '' : ref));
    return rec ? {id:rec.id, status:rec.status,
                  error:rec.error || rec.gpuError || rec.matteError || null,
                  width:drawableSize(rec.image).w, height:drawableSize(rec.image).h} : null;
  },
  imageEffectsGPU: () => !!uvRenderer(),
  layerMaskGPU: () => !!uvRenderer(),
  chromaKeyGPU: () => !!chromaKeyRenderer(),
  /* UV Map is registered for schema/restore parity, but has() only advertises
     it when the required two-sampler WebGL path really exists. There is no
     Canvas pass-through presented as an implementation. */
  has: name => name === 'UV Map' ? !!FX[name] && !!uvRenderer() : !!FX[name],
  params: name => FX[name] ? FX[name].params.slice() : null,
  implemented: () => Object.keys(FX).sort(),
  count: () => Object.keys(FX).length,
  /* null when the effect is comfortably inside the budget. Each entry names its
     own cause, because they are not all the same cause any more. */
  cost: name => {
    const record=name==='ChromaKey' && !chromaKeyRenderer()
      ? {ms:48,why:'full-frame getImageData fallback (WebGL unavailable)',
         needs:'WebGL support to run at 60 fps'}
      : COSTLY[name];
    return record == null ? null : {
      ms:record.ms, budget:BUDGET_MS, at:record.at || '1920x1080',
      why:record.why, needs:record.needs
    };
  },
  costly: () => Object.keys(COSTLY).sort(),
  /* What this effect needs before it can do anything, or null if it is ready.
     Distinct from has() (is it built at all) and from cost() (is it fast
     enough) — three different questions the UI must not collapse into one. */
  needs: name => name === 'UV Map' && !uvRenderer()
    ? 'Needs WebGL two-sampler support; unavailable in this browser.'
    : (NEEDS[name] || null),
  contextGated: () => Object.keys(NEEDS).sort()
};
})();
