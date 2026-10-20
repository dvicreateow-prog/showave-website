/* Native playback for video Chromium cannot decode. Browser-supported files
   remain on <video>; this module opens a verified original path through the
   local FFmpeg decoder and displays source-size runtime frames.
   DXV can use guarded BC3 GPU blocks, with straight RGBA fallback; other native
   codecs use straight RGBA8. No replacement media is encoded or resized, and
   each preview/layer owns an independent decoder session and playhead. */
(() => {
'use strict';

const API = '/api/dxv';
/* Loopback requests normally finish inside one frame interval. A hard ceiling
   prevents a retired Clip/Column from retaining a multi-megabyte response (or
   a server decoder worker) indefinitely when the local tier is overloaded. */
const DIRECT_REQUEST_TIMEOUT_MS = 8000;
/* Original-file preparation includes one native metadata/frame probe. It is
   longer than an individual frame request, but still finite so a retired
   import cannot retain its request and original capability indefinitely. */
const DIRECT_PREPARE_TIMEOUT_MS = 60000;

/* --------------------------------------------------------------------------
   Tier
   -------------------------------------------------------------------------- */
const state = {
  status: null,          // null until asked; {available, reason?} after
  statusPromise: null,
  sources: new Map(),    // absolute path -> opened native source record
  fileRecords: new Map(), // stable browser media key -> opened source record
  filePromises: new Map(),
  fileRequests: new Map(), // key -> the one cancellable original-path request
  fileEpochs: new Map(),   // invalidates a late result after releaseFile(key)
  fileInputs: new Map(), // key -> retained browser File used to recover after a server restart
  decoders: new Map()    // ArenaMedia slot video -> native RGBA decoder canvas
};

async function json(url, init){
  const res = await fetch(url, init);
  let body = null;
  try { body = await res.json(); } catch(e){ /* non-JSON error page */ }
  if(!body || !res.ok || body.error){
    const err=new Error(body && (body.error||body.reason) || `${url} -> ${res.status} ${res.statusText}`);
    err.status=res.status; err.body=body;
    throw err;
  }
  return body;
}

/* The decode tier needs Resolume installed for its FFmpeg libraries. When it
   is absent the honest answer is the reason, not a silent fallback — the same
   contract MENU_CANNOT uses for Spout and NDI. */
function status(){
  if(state.statusPromise) return state.statusPromise;
  const task = json(API + '/status')
    .then(s => (state.status = s))
    .catch(err => (state.status = {available:false, reason:
      'The decode tier did not answer: ' + err.message +
      '. It lives in devserver.py, so the app must be served by it rather than opened from disk.'}));
  state.statusPromise=task;
  task.then(s=>{ if(!s.available && state.statusPromise===task) state.statusPromise=null; });
  return task;
}

const browse  = path => json(API + '/list?path=' + encodeURIComponent(path));
const probe   = path => json(API + '/probe?path=' + encodeURIComponent(path));
const fileState = mediaKey => json(API + '/file-status?mediaKey=' + encodeURIComponent(mediaKey));
const cacheStats = () => json(API + '/cache');

/* --------------------------------------------------------------------------
   Open a byte-identical source for native frame decoding.
   -------------------------------------------------------------------------- */
async function prepare(path, onProgress, force, signal){
  if(signal?.aborted) throw abortError();
  const cached = state.sources.get(path);
  if(!force && cached && cached.state === 'ready') return cached;

  const rec = await json(API + '/prepare?path=' + encodeURIComponent(path), signal ? {signal} : undefined);
  if(signal?.aborted) throw abortError();
  if(rec.state === 'error') throw new Error(rec.error || 'preparation failed');
  rec.sourcePath=path;
  state.sources.set(path, rec);
  return rec;
}

function abortError(message){
  const error=new Error(message||'Native media open was cancelled.');
  error.name='AbortError';
  return error;
}

/* Native codecs must use the original path selected by the local picker.
   Browser-only Files cannot disclose that path and are never uploaded. */
function prepareFile(file, mediaKey, onProgress, force){
  const key=String(mediaKey||'');
  if(!file || !file._openlivePath){
    const error=new Error('This codec needs its original path. Use Add Files or Add Folder to select the existing file; media copying is disabled.');
    error.status=409;
    return Promise.reject(error);
  }
  const epoch=state.fileEpochs.get(key)||0;
  const requireCurrent=()=>{
    if((state.fileEpochs.get(key)||0)!==epoch) throw abortError();
  };
  state.fileInputs.set(key,{file,onProgress});
  const hit=state.fileRecords.get(key);
  if(!force && hit && hit.state==='ready') return Promise.resolve(hit);
  if(state.filePromises.has(key)) return state.filePromises.get(key);
  const controller=new AbortController();
  let rejectCancellation;
  const cancellation=new Promise((_resolve,reject)=>{rejectCancellation=reject;});
  const request={controller,timer:0,cancel(error){rejectCancellation(error);controller.abort();}};
  request.timer=setTimeout(()=>{
    if(state.fileRequests.get(key)!==request) return;
    const error=new Error(`Native media open timed out after ${DIRECT_PREPARE_TIMEOUT_MS}ms`);
    error.name='TimeoutError';request.cancel(error);
  },DIRECT_PREPARE_TIMEOUT_MS);
  state.fileRequests.set(key,request);
  const work=status().then(cap=>{
    requireCurrent();
    if(controller.signal.aborted) throw abortError();
    if(!cap || !cap.available) throw new Error(cap&&cap.reason || 'Native media decode is unavailable.');
    if(onProgress) onProgress(0,0,'open');
    return prepare(file._openlivePath,onProgress,force,controller.signal);
  });
  const task=Promise.race([work,cancellation]).then(rec=>{
    requireCurrent();
    if(!rec || rec.state!=='ready' || rec.transport!=='raw-rgba')
      throw new Error('The native decoder did not return a source-resolution RGBA source.');
    rec.mediaKey=key;
    state.fileRecords.set(key,rec);
    return rec;
  }).catch(err=>{
    /* A released request may reject after a replacement has already opened.
       Never let that retired promise erase the replacement's live record. */
    if((state.fileEpochs.get(key)||0)===epoch) state.fileRecords.delete(key);
    throw err;
  }).finally(()=>{
    clearTimeout(request.timer);
    if(state.fileRequests.get(key)===request) state.fileRequests.delete(key);
    if(state.filePromises.get(key)===task) state.filePromises.delete(key);
    if(!state.filePromises.has(key) && !state.fileRequests.has(key) &&
       !state.fileInputs.has(key) && !state.fileRecords.has(key)) state.fileEpochs.delete(key);
  });
  state.filePromises.set(key,task);
  return task;
}

async function reopenSourceRecord(record){
  const key=record && record.mediaKey;
  const input=key && state.fileInputs.get(key);
  let fresh;
  if(input){
    state.fileRecords.delete(key);
    fresh=await prepareFile(input.file,key,input.onProgress,true);
    Object.assign(record,fresh,{mediaKey:key});
    return record;
  }
  const path=record && record.sourcePath;
  if(!path) throw new Error('The selected media file is no longer available for recovery.');
  state.sources.delete(path);
  fresh=await prepare(path,null,true);
  Object.assign(record,fresh,{sourcePath:path});
  return record;
}

function releaseFile(mediaKey){
  const key=String(mediaKey||'');
  state.fileEpochs.set(key,(state.fileEpochs.get(key)||0)+1);
  const request=state.fileRequests.get(key);
  if(request){
    state.fileRequests.delete(key);
    clearTimeout(request.timer);
    request.cancel(abortError());
  }
  state.filePromises.delete(key);
  state.fileInputs.delete(key); state.fileRecords.delete(key);
}

/* --------------------------------------------------------------------------
   Recombining the two halves.

   One WebGL2 context per packed source. The packed frame is uploaded straight
   from the <video> element — texImage2D takes a video as a source and keeps
   the copy on the GPU, so no frame ever round trips through the CPU. That
   matters: this project's 60 fps target dies on a GPU->CPU readback.
   -------------------------------------------------------------------------- */
/* The fullscreen triangle spans clip space -1..3, so uv must be derived from p
   directly. Negating y flips into texture space, where row 0 is the top of the
   video; writing the flip as `1.0 - p.y` instead puts uv.y in 0.5..1.5, which
   CLAMP_TO_EDGE then pins — the frame looks plausible and never changes. */
const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main(){
  uv = vec2(p.x, -p.y) * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/* Colour occupies the top half (v in 0..0.5), alpha the bottom (0.5..1.0).
   The alpha half is grey, so any channel will do; red is taken.

   Colour is NOT premultiplied here. arena-media.js composites through a 2D
   canvas whose drawImage expects straight alpha, and premultiplying would
   darken every edge pixel against the layer beneath it. */
const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D packed;
out vec4 fragColour;
void main(){
  vec2 top = vec2(uv.x, uv.y * 0.5);
  vec2 bot = vec2(uv.x, uv.y * 0.5 + 0.5);
  vec3 rgb = texture(packed, top).rgb;
  float a  = texture(packed, bot).r;
  fragColour = vec4(rgb, a);
}`;

function compile(gl, type, src){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('DXV alpha shader failed to compile: ' + log);
  }
  return sh;
}

class Compositor {
  /* `video` plays the packed clip; `width`/`height` are the CLIP's real size,
     i.e. half the video's height. */
  constructor(video, width, height){
    this.video = video;
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.failed = null;
    this.lastTime = -1;

    const gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: false, antialias: false,
      preserveDrawingBuffer: true   // drawImage reads this canvas afterwards
    });
    if(!gl){
      this.failed = 'WebGL2 is unavailable, so packed alpha cannot be recombined.';
      return;
    }
    this.gl = gl;
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
        throw new Error(gl.getProgramInfoLog(prog));
      }
      this.prog = prog;
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      /* NEAREST, not LINEAR. The canvas is exactly half the packed video's
         height, so this is a 1:1 texel mapping and interpolation can only do
         harm: LINEAR averages adjacent rows of the alpha half, which on a
         hard-edged mask drags partial values down to zero. Measured on
         AncientMexico_03 at t=2.0 — LINEAR reported 96.318% transparent and
         1.073% partial against the packed frame's true 93.505% / 2.407%,
         quietly eating more than half the soft edge. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, 'packed'), 0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.viewport(0, 0, width, height);
    } catch(err){
      this.failed = err.message;
    }
  }

  /* Pull the current video frame through the shader. Returns true when the
     canvas holds a usable frame. Skips the upload when the element has not
     advanced, so a paused layer costs nothing. */
  update(force){
    if(this.failed || !this.gl) return false;
    const v = this.video;
    if(v.readyState < 2 || !v.videoWidth) return false;
    if(!force && v.currentTime === this.lastTime) return true;
    this.lastTime = v.currentTime;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  dispose(){
    const gl = this.gl;
    if(!gl) return;
    /* Deliberately NOT calling WEBGL_lose_context.loseContext(): a lost
       context is permanent for the element and getContext hands back the same
       dead context forever after. openlive-screen-render.js carries the same
       warning for the same reason. */
    if(this.tex) gl.deleteTexture(this.tex);
    if(this.prog) gl.deleteProgram(this.prog);
    this.gl = null;
  }
}

/* --------------------------------------------------------------------------
   Direct native-frame playback
   --------------------------------------------------------------------------
   Each ArenaMedia slot gets its own server decoder/playhead. Frames arrive as
   straight RGBA bytes at the MOV's exact width and height and are copied into
   a same-size canvas. There is no replacement video, resize or alpha packing.
   -------------------------------------------------------------------------- */
const BC3_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D blocks;
uniform int sourceHeight;
out vec4 fragColour;

uint blockByte(uvec4 a,uvec4 b,uvec4 c,uvec4 d,int index){
  if(index<4) return a[index];
  if(index<8) return b[index-4];
  if(index<12) return c[index-8];
  return d[index-12];
}

uvec3 rgb565(uint value){
  uint t=(value>>11u)*255u+16u;
  uint r=(t/32u+t)/32u;
  t=((value&0x07e0u)>>5u)*255u+32u;
  uint g=(t/64u+t)/64u;
  t=(value&0x001fu)*255u+16u;
  uint b=(t/32u+t)/32u;
  return uvec3(r,g,b);
}

void main(){
  ivec2 pixel=ivec2(gl_FragCoord.xy);
  int sourceY=sourceHeight-1-pixel.y;
  ivec2 block=ivec2(pixel.x/4,sourceY/4);
  int local=(sourceY&3)*4+(pixel.x&3);
  int texelX=block.x*4;
  uvec4 q0=texelFetch(blocks,ivec2(texelX,block.y),0);
  uvec4 q1=texelFetch(blocks,ivec2(texelX+1,block.y),0);
  uvec4 q2=texelFetch(blocks,ivec2(texelX+2,block.y),0);
  uvec4 q3=texelFetch(blocks,ivec2(texelX+3,block.y),0);

  uint alpha0=blockByte(q0,q1,q2,q3,0);
  uint alpha1=blockByte(q0,q1,q2,q3,1);
  uint alphaBit=uint(local*3), alphaByte=2u+alphaBit/8u;
  uint alphaBits=blockByte(q0,q1,q2,q3,int(alphaByte)) |
    (blockByte(q0,q1,q2,q3,int(alphaByte+1u))<<8u);
  uint alphaCode=(alphaBits>>(alphaBit&7u))&7u;
  uint alpha;
  if(alphaCode==0u) alpha=alpha0;
  else if(alphaCode==1u) alpha=alpha1;
  else if(alpha0>alpha1)
    alpha=((8u-alphaCode)*alpha0+(alphaCode-1u)*alpha1)/7u;
  else if(alphaCode==6u) alpha=0u;
  else if(alphaCode==7u) alpha=255u;
  else alpha=((6u-alphaCode)*alpha0+(alphaCode-1u)*alpha1)/5u;

  uint color0=blockByte(q0,q1,q2,q3,8) |
    (blockByte(q0,q1,q2,q3,9)<<8u);
  uint color1=blockByte(q0,q1,q2,q3,10) |
    (blockByte(q0,q1,q2,q3,11)<<8u);
  uvec3 rgb0=rgb565(color0),rgb1=rgb565(color1);
  uint colorBits=blockByte(q0,q1,q2,q3,12) |
    (blockByte(q0,q1,q2,q3,13)<<8u) |
    (blockByte(q0,q1,q2,q3,14)<<16u) |
    (blockByte(q0,q1,q2,q3,15)<<24u);
  uint colorCode=(colorBits>>uint(local*2))&3u;
  uvec3 rgb=colorCode==0u?rgb0:colorCode==1u?rgb1:
    colorCode==2u?(2u*rgb0+rgb1)/3u:(2u*rgb1+rgb0)/3u;
  if(alpha>0u) rgb=min(rgb*255u/alpha,uvec3(255u));
  fragColour=vec4(vec3(rgb),float(alpha))/255.0;
}`;

/* DXV calls this texture DXT5, but its RGB is premultiplied (the DXT4
   convention). Hardware S3TC expansion permits small implementation-specific
   rounding differences, including alpha. This WebGL2 shader therefore reads
   the 16 BC3 bytes as an RGBA8UI block table and mirrors FFmpeg 7.1.1's integer
   BC3 + premultiplied-to-straight operations exactly. The S3TC extension is
   detected for diagnostics, but correctness does not depend on it. No pixel
   or source dimension is resampled. */
class BC3Renderer {
  constructor(width,height){
    this.width=width|0; this.height=height|0;
    this.expected=Math.ceil(this.width/4)*Math.ceil(this.height/4)*16;
    this.canvas=document.createElement('canvas');
    this.canvas.width=this.width; this.canvas.height=this.height;
    this.failed=null; this.allocated=false;
    if(!(this.width>0 && this.height>0 && this.width%4===0 && this.height%4===0)){
      this.failed='BC3 needs source dimensions divisible by four.'; return;
    }
    const gl=this.canvas.getContext('webgl2',{
      alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true
    });
    if(!gl){ this.failed='WebGL2 is unavailable.'; return; }
    this.gl=gl;
    this.ext=gl.getExtension('WEBGL_compressed_texture_s3tc');
    try {
      const prog=gl.createProgram();
      gl.attachShader(prog,compile(gl,gl.VERTEX_SHADER,VERT));
      gl.attachShader(prog,compile(gl,gl.FRAGMENT_SHADER,BC3_FRAG));
      gl.linkProgram(prog);
      if(!gl.getProgramParameter(prog,gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(prog));
      this.prog=prog; gl.useProgram(prog);
      const buf=gl.createBuffer(); this.buf=buf;
      gl.bindBuffer(gl.ARRAY_BUFFER,buf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
      const loc=gl.getAttribLocation(prog,'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      this.tex=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,this.tex);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog,'blocks'),0);
      gl.uniform1i(gl.getUniformLocation(prog,'sourceHeight'),this.height);
      gl.disable(gl.BLEND);
      gl.viewport(0,0,this.width,this.height);
    } catch(err){ this.failed=String(err&&err.message||err); }
  }

  upload(buffer){
    if(this.failed || !this.gl) throw new Error(this.failed||'BC3 renderer is unavailable.');
    const bytes=buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if(bytes.byteLength!==this.expected)
      throw new Error(`DXV BC3 frame is ${bytes.byteLength} bytes; expected ${this.expected}`);
    const gl=this.gl;
    gl.bindTexture(gl.TEXTURE_2D,this.tex);
    if(!this.allocated){
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8UI,this.width,this.height/4,0,
        gl.RGBA_INTEGER,gl.UNSIGNED_BYTE,bytes);
      this.allocated=true;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,this.width,this.height/4,
        gl.RGBA_INTEGER,gl.UNSIGNED_BYTE,bytes);
    }
    const error=gl.getError();
    if(error!==gl.NO_ERROR) throw new Error(`WebGL BC3 upload failed (0x${error.toString(16)}).`);
    gl.drawArrays(gl.TRIANGLES,0,3);
    return true;
  }

  dispose(){
    const gl=this.gl; if(!gl) return;
    if(this.tex) gl.deleteTexture(this.tex);
    if(this.buf) gl.deleteBuffer(this.buf);
    if(this.prog) gl.deleteProgram(this.prog);
    this.gl=null;
  }
}

class DirectDecoder {
  constructor(record, free, onError, onReady){
    this.record=record;
    this.width=record.width|0; this.height=record.height|0;
    this.fps=+record.fps||30; this.frames=Math.max(1,record.frames|0);
    this.canvas=null; this.ctx=null; this.renderer=null; this.transport='raw-rgba';
    const transports=Array.isArray(record.transports)?record.transports:[];
    if(transports.includes('bc3-dxt5')){
      const renderer=new BC3Renderer(this.width,this.height);
      if(!renderer.failed){
        this.renderer=renderer; this.canvas=renderer.canvas; this.transport='bc3-dxt5';
      } else renderer.dispose();
    }
    if(!this.canvas) this.useRGBA();
    this.presentation=null; this.presentationCtx=null;
    this.configurePresentation();
    this.free=!!free; this.started=performance.now();
    this.source=record.source; this.session=null;
    this.lastFrame=-1; this.desiredFrame=0; this.pending=false;
    this.disposed=false; this.failed=null; this.generation=0;
    this.onError=typeof onError==='function' ? onError : null;
    this.onReady=typeof onReady==='function' ? onReady : null;
    this.needsReadyNotice=false;
    this.retryTimer=0; this.retryDelay=250;
    this.frameRetryTimer=0; this.frameRetryDelay=250;
    this.openRequest=null; this.frameRequest=null;
    this.openPromise=this.open(true);
  }

  startRequest(slot,label){
    this.cancelRequest(slot);
    const controller=new AbortController();
    const lease={controller,timer:0,timedOut:false,label};
    lease.timer=setTimeout(()=>{
      if(this[slot]!==lease || this.disposed) return;
      lease.timedOut=true;
      controller.abort();
    },DIRECT_REQUEST_TIMEOUT_MS);
    this[slot]=lease;
    return lease;
  }

  finishRequest(slot,lease){
    if(lease&&lease.timer){ clearTimeout(lease.timer); lease.timer=0; }
    if(this[slot]===lease) this[slot]=null;
  }

  cancelRequest(slot){
    const lease=this[slot];
    if(!lease) return;
    this[slot]=null;
    if(lease.timer){ clearTimeout(lease.timer); lease.timer=0; }
    try { lease.controller.abort(); } catch(err){}
  }

  cancelInflight(){
    this.generation++;
    this.cancelRequest('frameRequest');
    this.cancelRequest('openRequest');
    this.pending=false;
  }

  requestError(err,lease){
    if(!err || err.name!=='AbortError') return err;
    if(!lease || !lease.timedOut) return null;
    const timeout=new Error(`${lease.label} timed out after ${DIRECT_REQUEST_TIMEOUT_MS}ms`);
    timeout.name='TimeoutError';
    return timeout;
  }

  deferBusyFrame(err){
    if(this.disposed) return false;
    const suggested=+(err&&err.body&&err.body.retryAfterMs)||0;
    const delay=Math.max(100,Math.min(2000,Math.max(suggested,this.frameRetryDelay)));
    this.frameRetryDelay=Math.min(2000,delay*2);
    if(!this.frameRetryTimer){
      this.frameRetryTimer=setTimeout(()=>{
        this.frameRetryTimer=0;
        if(!this.disposed && !this.failed) this.request(this.desiredFrame);
      },delay);
    }
    return true;
  }

  deferBusyOpen(err){
    if(this.disposed) return false;
    const suggested=+(err&&err.body&&err.body.retryAfterMs)||0;
    const delay=Math.max(100,Math.min(5000,Math.max(suggested,this.retryDelay)));
    this.retryDelay=Math.min(5000,delay*2);
    if(!this.retryTimer){
      this.retryTimer=setTimeout(()=>{
        this.retryTimer=0;
        if(this.disposed) return;
        this.openPromise=this.open(true);
      },delay);
    }
    return true;
  }

  useRGBA(){
    if(this.renderer){ this.renderer.dispose(); this.renderer=null; }
    const canvas=document.createElement('canvas');
    canvas.width=this.width; canvas.height=this.height;
    this.canvas=canvas;
    this.ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:false});
    this.transport='raw-rgba';
    this.lastFrame=-1;
  }

  configurePresentation(){
    const displayWidth=Math.max(1,Math.round(+this.record.displayWidth||this.width));
    const displayHeight=Math.max(1,Math.round(+this.record.displayHeight||this.height));
    const rotation=+this.record.rotation||0;
    const apertureWidth=+this.record.cleanApertureWidth||this.width;
    const apertureHeight=+this.record.cleanApertureHeight||this.height;
    const needs=displayWidth!==this.width||displayHeight!==this.height||rotation!==0||
      apertureWidth!==this.width||apertureHeight!==this.height;
    if(!needs){ this.presentation=null; this.presentationCtx=null; return; }
    const canvas=document.createElement('canvas');
    canvas.width=displayWidth; canvas.height=displayHeight;
    const ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:false});
    if(!ctx) throw new Error('The browser cannot allocate the native presentation canvas.');
    this.presentation=canvas; this.presentationCtx=ctx;
  }

  present(){
    if(!this.presentationCtx) return this.canvas;
    const ctx=this.presentationCtx,out=this.presentation,rotation=+this.record.rotation||0;
    const apertureWidth=Math.max(1,Math.min(this.width,+this.record.cleanApertureWidth||this.width));
    const apertureHeight=Math.max(1,Math.min(this.height,+this.record.cleanApertureHeight||this.height));
    const sx=Math.max(0,Math.min(this.width-apertureWidth,
      (this.width-apertureWidth)/2+(+this.record.cleanApertureOffsetX||0)));
    const sy=Math.max(0,Math.min(this.height-apertureHeight,
      (this.height-apertureHeight)/2+(+this.record.cleanApertureOffsetY||0)));
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,out.width,out.height);
    ctx.save();
    if(rotation===90){
      ctx.translate(out.width,0); ctx.rotate(Math.PI/2);
      ctx.drawImage(this.canvas,sx,sy,apertureWidth,apertureHeight,0,0,out.height,out.width);
    } else if(rotation===-90||rotation===270){
      ctx.translate(0,out.height); ctx.rotate(-Math.PI/2);
      ctx.drawImage(this.canvas,sx,sy,apertureWidth,apertureHeight,0,0,out.height,out.width);
    } else if(Math.abs(rotation)===180){
      ctx.translate(out.width,out.height); ctx.rotate(Math.PI);
      ctx.drawImage(this.canvas,sx,sy,apertureWidth,apertureHeight,0,0,out.width,out.height);
    } else {
      ctx.drawImage(this.canvas,sx,sy,apertureWidth,apertureHeight,0,0,out.width,out.height);
    }
    ctx.restore();
    return out;
  }

  fail(err){
    if(this.disposed) return;
    this.failed=String(err&&err.message||err);
    this.needsReadyNotice=true;
    if(this.onError) this.onError(this.failed);
  }

  ready(){
    const notify=this.needsReadyNotice;
    this.failed=null; this.retryDelay=250; this.frameRetryDelay=250;
    this.needsReadyNotice=false;
    if(notify && this.onReady) this.onReady();
  }

  retry(err){
    if(this.disposed) return;
    this.cancelInflight();
    if(this.frameRetryTimer){ clearTimeout(this.frameRetryTimer); this.frameRetryTimer=0; }
    this.fail(err);
    const session=this.session; this.session=null;
    if(session) fetch(API+'/close?session='+encodeURIComponent(session),{method:'POST'}).catch(()=>{});
    if(this.retryTimer) return;
    const delay=this.retryDelay;
    this.retryDelay=Math.min(5000,Math.max(250,this.retryDelay*2));
    this.retryTimer=setTimeout(()=>{
      this.retryTimer=0;
      if(this.disposed) return;
      this.failed=null;
      this.openPromise=this.open(true);
    },delay);
  }

  async open(allowSourceRecovery){
    const lease=this.startRequest('openRequest','Native playback open');
    try {
      const rec=await json(API+'/playback?source='+encodeURIComponent(this.source),{
        method:'POST',signal:lease.controller.signal
      });
      if(this.disposed || this.openRequest!==lease){
        if(rec.session) fetch(API+'/close?session='+encodeURIComponent(rec.session),{method:'POST'}).catch(()=>{});
        return;
      }
      this.session=rec.session;
      this.request(this.desiredFrame);
    } catch(err){
      if(this.disposed || this.openRequest!==lease) return;
      err=this.requestError(err,lease);
      if(!err) return;
      /* Session capacity is temporary pressure, not a broken Clip. Keep the
         honest loading state and retry without invoking ArenaMedia's error
         callback or churning a session which was never opened. */
      if(err.status===503){ this.deferBusyOpen(err); return; }
      if(!this.disposed && allowSourceRecovery && err && err.status===404 &&
         (this.record.mediaKey || this.record.sourcePath)){
        try {
          await reopenSourceRecord(this.record);
          if(this.disposed || this.openRequest!==lease) return;
          this.source=this.record.source;
          return this.open(false);
        } catch(recoveryError){ err=recoveryError; }
      }
      this.retry(err);
    } finally {
      this.finishRequest('openRequest',lease);
    }
  }

  target(frame){
    frame=Math.max(0,Math.min(this.frames-1,Math.round(+frame||0)));
    this.desiredFrame=frame;
    this.request(frame);
  }

  sync(position){
    this.free=false;
    const p=Math.max(0,Math.min(1,+position||0));
    this.target(Math.min(this.frames-1,Math.floor(p*this.frames)));
  }

  tick(){
    if(this.free){
      const elapsed=(performance.now()-this.started)/1000;
      this.target(Math.floor(elapsed*this.fps)%this.frames);
    }
    return this.lastFrame>=0 ? this.present() : null;
  }

  request(frame){
    if(this.disposed || this.failed || !this.session || this.pending ||
       this.frameRetryTimer || frame===this.lastFrame) return;
    this.pending=true;
    const generation=++this.generation, requested=frame;
    const requestedTransport=this.transport;
    const format=requestedTransport==='bc3-dxt5'?'bc3':'rgba';
    const lease=this.startRequest('frameRequest','Native frame request');
    let deferred=false;
    fetch(API+'/frame?session='+encodeURIComponent(this.session)+'&frame='+requested+'&format='+format,
      {cache:'no-store',signal:lease.controller.signal}).then(async res=>{
        if(!res.ok){ let body=null; try{ body=await res.json(); }catch(e){};
          const err=new Error(body&&(body.error||body.reason)||`Native media frame -> ${res.status}`);
          err.status=res.status; err.body=body; throw err; }
        const actual=+(res.headers.get('X-OpenLive-Frame-Index')||requested);
        const bytes=await res.arrayBuffer();
        if(this.disposed || generation!==this.generation) return;
        const responseTransport=res.headers.get('X-OpenLive-Transport');
        if(requestedTransport==='bc3-dxt5'){
          if(responseTransport && responseTransport!=='bc3-dxt5'){
            const err=new Error('The server did not return BC3.'); err.transportFallback=true; throw err;
          }
          try { this.renderer.upload(bytes); }
          catch(cause){ const err=new Error(cause.message); err.transportFallback=true; throw err; }
        } else {
          const expected=this.width*this.height*4;
          if(bytes.byteLength!==expected)
            throw new Error(`Native RGBA frame is ${bytes.byteLength} bytes; expected ${expected}`);
          const pixels=new Uint8ClampedArray(bytes);
          let image;
          if(typeof ImageData==='function') image=new ImageData(pixels,this.width,this.height);
          else { image=this.ctx.createImageData(this.width,this.height); image.data.set(pixels); }
          this.ctx.putImageData(image,0,0);
        }
        this.lastFrame=actual;
        this.ready();
      }).catch(async err=>{
        if(this.disposed || generation!==this.generation || this.frameRequest!==lease) return;
        err=this.requestError(err,lease);
        if(!err) return;
        if(err.status===503){ deferred=this.deferBusyFrame(err); return; }
        if(requestedTransport==='bc3-dxt5' &&
           (err&&err.status===415 || err&&err.transportFallback)){
          this.useRGBA();
          return;
        }
        if(err && err.status===404){
          this.session=null;
          await this.open(true);
          return;
        }
        this.retry(err);
      })
      .finally(()=>{
        if(this.frameRequest!==lease) return;
        this.finishRequest('frameRequest',lease);
        this.pending=false;
        if(!deferred && !this.disposed && !this.failed && this.desiredFrame!==this.lastFrame)
          this.request(this.desiredFrame);
      });
  }

  dispose(){
    if(this.disposed) return;
    this.disposed=true; this.cancelInflight();
    if(this.retryTimer){ clearTimeout(this.retryTimer); this.retryTimer=0; }
    if(this.frameRetryTimer){ clearTimeout(this.frameRetryTimer); this.frameRetryTimer=0; }
    if(this.renderer){ this.renderer.dispose(); this.renderer=null; }
    const session=this.session; this.session=null;
    if(session) fetch(API+'/close?session='+encodeURIComponent(session),{method:'POST'}).catch(()=>{});
  }
}

function attach(video, record, opts){
  if(!record || record.transport!=='raw-rgba') return null;
  let decoder=state.decoders.get(video);
  if(decoder && decoder.source===record.source){
    if(opts&&opts.free) decoder.free=true;
    if(opts&&typeof opts.onError==='function') decoder.onError=opts.onError;
    if(opts&&typeof opts.onReady==='function') decoder.onReady=opts.onReady;
    return decoder;
  }
  if(decoder) decoder.dispose();
  decoder=new DirectDecoder(record,opts&&opts.free,opts&&opts.onError,opts&&opts.onReady);
  state.decoders.set(video,decoder);
  return decoder;
}

function detach(video){
  const decoder=state.decoders.get(video);
  if(decoder){ decoder.dispose(); state.decoders.delete(video); }
}

function sync(video, position){
  const decoder=state.decoders.get(video);
  if(decoder) decoder.sync(position);
}

function drawable(video){
  const decoder=state.decoders.get(video);
  return decoder ? decoder.tick() : video;
}

window.OpenLiveDXV = {
  status, browse, probe, prepare, prepareFile, releaseFile, cacheStats,
  attach, detach, sync, drawable,
  isDirect: video => state.decoders.has(video),
  compositorFor: v => state.decoders.get(v) || null,
  recordFor: p => state.sources.get(p) || null,
  get tier(){ return state.status; },
  DirectDecoder, BC3Renderer
};

})();
