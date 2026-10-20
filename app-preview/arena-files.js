/* ===========================================================================
   arena-files.js — the user's own media, from anywhere on the machine.
   ---------------------------------------------------------------------------
   This is the user-owned media path: Files, folders and Explorer drops enter the
   same Clip library without being copied into a demo catalogue or converted.

   THE ONE THING A BROWSER WILL NOT GIVE YOU is an absolute path. `File` has a
   name and nothing else, and a FileSystemHandle is an opaque capability, not
   `C:\...`. So a composition cannot silently re-resolve
   "C:\media\Foo.mov" the way Arena does (arena-avc.js resolvePath).

   The local file picker gives the helper the original filesystem path. Media
   remains there: browser playback reads that path through a session URL, and
   native codecs open it directly. Browser-only drops retain File capabilities.
   Folder handles, selected files, masks and LUTs are held in memory only. A new
   page starts empty, without restoring a browser database or duplicating media.

   Browser-native Files become blob: URLs. URL.createObjectURL on a File is O(1)
   and decoding begins only when a <video> fetches one. Unsupported browser
   formats retain the exact File capability and open through the native decoder
   at source dimensions instead.

   Requires arena-media.js (registers into its index) and is optional: nothing
   else fails if this file is absent.
   =========================================================================== */
(() => {
'use strict';

const MEDIA = window.ArenaMedia;
const DOCUMENTS = window.OpenLiveDocuments || null;
const POWERPOINT_PLAYER_EXT=new Set(['pptx','ppsx','pptm','ppsm']);
const LEGACY_POWERPOINT_EXT=new Set(['ppt','pps']);
if(!MEDIA || !MEDIA.register){
  console.warn('arena-files: ArenaMedia.register missing. User media disabled');
  return;
}

/* --------------------------------------------------------------------------
   Video routing
   --------------------------------------------------------------------------
   The extension is discovery, never the decoder decision. Browser-native files
   stay on <video>; formats Chromium rejects are opened byte-for-byte by the
   local FFmpeg tier. This deliberately includes broadcast, camera and VJ
   containers which do not advertise a useful browser MIME type.
   -------------------------------------------------------------------------- */
const VIDEO_EXT = [
  'mp4','m4v','mov','qt','webm','mkv','ogv','ogg','gif',
  'avi','mxf','ts','mts','m2ts','m2v','mpg','mpeg','vob',
  'wmv','asf','flv','f4v','3gp','3g2','rm','rmvb','divx','amv','ivf','y4m',
  'hevc','h265','265','h264','264','avc','nut','dv','mod','tod','m1v',
  'mjpeg','mjpg','ogm','bik','bik2','smk','roq','gxf','lxf','wtv','dvr-ms','dav',
  'dxv','hap','prores','notch','r3d','braw'
];
/* stills.htm explicitly supports PNG, JPEG and TIFF. Animated GIF is routed as
   moving media through the native video tier instead of being frozen as a
   still. Browser-decodable WebP/AVIF/BMP/SVG remain useful additional inputs. */
const IMAGE_EXT = ['png','jpg','jpeg','tif','tiff','webp','avif','bmp','svg'];
const AUDIO_EXT = ['wav','mp3','m4a','aac','oga','flac','opus'];
/* These suffixes are not useful browser probes. Route them directly to native
   decoding; MOV/MP4 versions of the same codecs reach it after the real browser
   probe rejects their codec track. */
const NATIVE_FIRST_EXT = new Set([
  'dxv','hap','mxf','r3d','braw','avi','prores','notch','gif',
  'ts','mts','m2ts','m2v','vob','wmv','asf','flv','f4v','rm','rmvb','divx','amv','ivf','y4m',
  'hevc','h265','265','h264','264','avc','nut','dv','mod','tod','m1v','mjpeg','mjpg','ogm',
  'bik','bik2','smk','roq','gxf','lxf','wtv','dvr-ms','dav'
]);
const DXV_TAGS  = new Set(['DXD3','DXDI','DXV3','DXVA']);
const H264_TAGS = new Set(['avc1','avc3']);
const PRORES_TAGS = new Set(['apco','apcs','apcn','apch','ap4h','ap4x']);
const HAP_TAGS = new Set(['Hap1','Hap5','HapY','HapA','HapM']);
const NOTCHLC_TAGS = new Set(['nclc','NCLC','nlc1','NLC1']);
const NATIVE_QT_TAGS = new Set([...DXV_TAGS,...PRORES_TAGS,...HAP_TAGS,...NOTCHLC_TAGS]);

const extOf  = n => { const m = /\.([^.]+)$/.exec(String(n)); return m ? m[1].toLowerCase() : ''; };
const kindOf = input => { const n=input&&typeof input==='object'?input.name:input, e = extOf(n);
  return VIDEO_EXT.includes(e) ? 'video' : IMAGE_EXT.includes(e) ? 'image'
       : AUDIO_EXT.includes(e) ? 'audio'
       : input&&typeof input.type==='string'&&input.type.startsWith('video/') ? 'video'
       : input&&typeof input.type==='string'&&input.type.startsWith('image/') ? 'image'
       : input&&typeof input.type==='string'&&input.type.startsWith('audio/') ? 'audio' : null; };
const stripExt = s => String(s||'').replace(/\.[^.]+$/, '');

/* A .mov may be H.264 or DXV. The QuickTime sample-description tag, not the
   extension, decides whether it stays direct or enters native preparation. */

const state = {
  roots: [],            // [{key, name, handle, count, status}]
  loose: [],            // individually picked files, grouped under one folder
  images: new Map(),    // session image-parameter capabilities
  luts: new Map(),      // session .cube capabilities
  sourceFiles: new Map(), // runtime-only File capabilities for native fallback, keyed by media id
  scanning: false,
  posterQueue: [],
  posterBusy: 0,
  posterRequests: new Map(),
  fileFingerprints: new WeakMap(),
  originalFiles: new WeakMap(), // verified native capabilities for external File drops
  originalRefreshes: new WeakMap(), // one capability refresh per retained original
  listeners: []
};

const MAX_DEPTH = 8;             // deep enough for real libraries, shallow enough to end
const MAX_FILES = 6000;          // a guard, not a policy — reported when hit
const POSTER_PARALLEL = 2;       // frame grabs are decodes; do not flood the GPU
const FINGERPRINT_SAMPLE_BYTES = 512 * 1024;
const FINGERPRINT_CHUNK_BYTES = 64 * 1024;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const IDENTITY_SAMPLE_BYTES = 64 * 1024;
const IDENTITY_SAMPLE_COUNT = 5;
/* DOCUMENTED: stills have a Timeline duration in seconds (or beats in BPM
   Sync), which drives Autopilot and Clip Position even though their pixels are
   visually infinite. UNDOCUMENTED — inferred default: the docs publish no
   factory duration, so retain OpenLive's established 8-second load fallback
   rather than collapsing to zero and looping every 50 ms. */
const STILL_TIMELINE_SECONDS = 8;
const MAX_MEDIA_DIMENSION = 32768;
const MAX_MEDIA_FRAME_BYTES = 1024 * 1024 * 1024;
let runtimeSerial = 0;

function validateMediaGeometry(width,height,label){
  width=Math.round(Number(width)||0); height=Math.round(Number(height)||0);
  if(width<=0||height<=0) throw new Error((label||'Media')+' reported invalid geometry.');
  if(width>MAX_MEDIA_DIMENSION||height>MAX_MEDIA_DIMENSION)
    throw new Error(`${label||'Media'} is ${width}x${height}; the safe dimension limit is ${MAX_MEDIA_DIMENSION}.`);
  if(width*height*4>MAX_MEDIA_FRAME_BYTES)
    throw new Error(`${label||'Media'} needs more than ${MAX_MEDIA_FRAME_BYTES} bytes for one RGBA frame.`);
  return {width,height};
}

const supported = () => localMediaAvailable() || typeof window.showDirectoryPicker === 'function';

function localMediaAvailable(){
  return typeof fetch==='function' && window.location &&
    /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);
}

function originalFile(record,proof=record.originalProof||null){
  const file={name:record.name,size:record.size,lastModified:record.lastModified,type:record.type,
    _openlivePath:record.path,_openliveURL:record.url,
    _openliveSourceToken:record.sourceToken||sourceTokenOf(record.url),_openliveDropMatch:record.dropMatch||null,
    _openliveOriginalProof:proof ? Object.freeze({...proof}) : null};
  const read=async(start,end)=>{
    if(end<=start) return new ArrayBuffer(0);
    const response=await fetch(file._openliveURL,{cache:'no-store',headers:{Range:`bytes=${start}-${end-1}`}});
    if(!response.ok) throw new Error('The selected file is no longer available.');
    return response.arrayBuffer();
  };
  file.slice=(start=0,end=file.size)=>{
    const from=Math.max(0,start<0 ? file.size+start : Math.min(file.size,start));
    const to=Math.max(0,end<0 ? file.size+end : Math.min(file.size,end));
    return {arrayBuffer:()=>read(from,to)};
  };
  file.arrayBuffer=()=>read(0,file.size);
  file.text=async()=>new TextDecoder().decode(await file.arrayBuffer());
  return file;
}

function sourceTokenOf(url){
  const match=/\/api\/media\/source\/([A-Za-z0-9_-]+)(?:[?#]|$)/.exec(String(url||''));
  return match ? match[1] : null;
}

function originalResolutionError(message,status,code){
  const error=new Error(message||'The original file could not be verified on this computer.');
  error.status=Number(status)||409;
  error.code=code||'ORIGINAL_NOT_VERIFIED';
  error.originalUnverified=true;
  return error;
}

/* Browser drops cannot distinguish identical originals in different folders.
   Present only verified matches and require an explicit original selection;
   the helper rechecks that file before granting a new RAM capability. */
function chooseOriginalMatch(file,candidates){
  const matches=Array.isArray(candidates)&&candidates.length<=16 ? candidates.filter(record=>
    record&&record.path&&record.name===file.name&&Number(record.size)===Number(file.size)&&
    Math.abs(Number(record.lastModified)-Number(file.lastModified))<=2&&record.originalProof&&
    /^[0-9a-f]{64}$/.test(record.originalProof.fingerprint||'')) : [];
  if(!matches.length)return Promise.reject(originalResolutionError('Select only the intended original in Explorer, then drop it again.'));
  return new Promise((resolve,reject)=>{
    const dialog=document.createElement('dialog');dialog.className='original-file-dialog';
    dialog.setAttribute('aria-label','Choose original PowerPoint');
    const header=document.createElement('header');header.textContent='Choose original PowerPoint';dialog.appendChild(header);
    const detail=document.createElement('p');detail.textContent='Matching files are open or selected. Choose the original for this Clip.';dialog.appendChild(detail);
    const list=document.createElement('div');list.className='original-file-matches';dialog.appendChild(list);
    const status=document.createElement('p');status.className='original-file-status';status.setAttribute('role','status');dialog.appendChild(status);
    const footer=document.createElement('footer');dialog.appendChild(footer);
    const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.textContent='Cancel';footer.appendChild(cancel);
    let settled=false,busy=false;
    const finish=(value,error)=>{
      if(settled)return;settled=true;
      if(dialog.open)dialog.close();dialog.remove();
      if(error)reject(error);else resolve(value);
    };
    const cancelMatch=()=>finish(null,originalResolutionError('Original selection cancelled. The file was not loaded.',409,'ORIGINAL_SELECTION_CANCELLED'));
    dialog.addEventListener('cancel',event=>{event.preventDefault();cancelMatch();});
    dialog.addEventListener('close',()=>{if(!settled)cancelMatch();});cancel.addEventListener('click',cancelMatch);
    const buttons=[];
    for(const record of matches){
      const button=document.createElement('button');button.type='button';button.className='btn original-file-match';
      button.title=record.path;button.setAttribute('aria-label','Use original '+record.path);
      const name=document.createElement('span');name.className='original-file-name';name.textContent=record.name;button.appendChild(name);
      const path=document.createElement('span');path.className='original-file-path';path.textContent=record.path;button.appendChild(path);
      buttons.push(button);list.appendChild(button);
      button.addEventListener('click',async()=>{
        if(busy||settled)return;busy=true;buttons.forEach(item=>item.disabled=true);dialog.setAttribute('aria-busy','true');
        status.textContent='Verifying selected original…';
        try{const original=await refreshOriginal(originalFile(record));if(!settled)finish(original);}
        catch(error){if(!settled){status.textContent=error.message||String(error);buttons.forEach(item=>item.disabled=false);}}
        finally{busy=false;if(!settled)dialog.removeAttribute('aria-busy');}
      });
    }
    document.body.appendChild(dialog);
    try{dialog.showModal();}
    catch(error){finish(null,originalResolutionError('This browser cannot show the original selector. Select only the intended file in Explorer and drop it again.'));}
  });
}

/* External browser Files hide their original path. Match a bounded, five-region
   SHA-256 fingerprint through the local helper instead of guessing by name or
   copying bytes to a substitute file. A successful match returns a read-only
   capability for the original; native playback still opens only on demand. */
async function resolveOriginal(file,onProgress){
  if(file && file._openlivePath) return file;
  if(!file || typeof file!=='object' || typeof file.slice!=='function')
    throw originalResolutionError('This drop did not include a readable file capability.');
  const desktop=window.OpenLiveDesktop;
  const desktopResolver=desktop&&typeof desktop.resolveOriginal==='function';
  if(!desktopResolver&&!localMediaAvailable())
    throw originalResolutionError('This file needs the local SHOWAVE helper to verify its original location.');
  const cached=state.originalFiles.get(file);
  if(cached) return cached;
  const task=(async()=>{
    if(desktopResolver){
      if(onProgress) onProgress({stage:'reference',loaded:0,total:0,unit:'files',
        percent:null,message:'Linking original file'});
      // The isolated desktop preload receives the real dropped File capability.
      // Main registers its exact original path; page code never guesses a path,
      // copies the source, or asks Explorer/Office to rediscover this drop.
      const result=await desktop.resolveOriginal(file);
      if(!result||result.error)
        throw originalResolutionError(result&&result.error||'The desktop could not link the original file.',
          result&&result.status,result&&result.code);
      const record=result.file||result.record||result;
      const token=record&&(record.sourceToken||sourceTokenOf(record.url));
      const proof=record&&record.originalProof;
      if(!record||!record.path||!token||!record.url||record.name!==file.name||
        Number(record.size)!==Number(file.size)||
        !Number.isFinite(Number(record.lastModified))||
        Math.abs(Number(record.lastModified)-(Number(file.lastModified)||0))>2||
        sourceTokenOf(record.url)!==token||!proof||proof.name!==file.name||
        Number(proof.size)!==Number(file.size)||
        !Number.isFinite(Number(proof.lastModified))||
        Math.abs(Number(proof.lastModified)-(Number(file.lastModified)||0))>2||
        !/^[0-9a-f]{64}$/.test(proof.fingerprint)||proof.sampleBytes!==IDENTITY_SAMPLE_BYTES)
        throw originalResolutionError('The desktop did not return a verified original file.');
      return originalFile(record);
    }
    if(typeof crypto==='undefined' || !crypto.subtle || typeof crypto.subtle.digest!=='function')
      throw originalResolutionError('The browser cannot verify the original file without SHA-256 support.');
    const size=Number(file.size);
    if(!Number.isSafeInteger(size) || size<0)
      throw originalResolutionError('The dropped file reported an invalid size.');
    const chunk=Math.min(IDENTITY_SAMPLE_BYTES,size), offsets=[];
    for(let i=0;i<IDENTITY_SAMPLE_COUNT;i++){
      const offset=Math.floor((size-chunk)*i/(IDENTITY_SAMPLE_COUNT-1));
      if(!offsets.includes(offset)) offsets.push(offset);
    }
    const samples=[];
    const sampleTotal=offsets.length*chunk;
    let sampled=0;
    if(onProgress) onProgress({stage:'reference',loaded:0,total:sampleTotal,unit:'bytes',
      percent:sampleTotal ? 0 : null,message:'Verifying original file'});
    for(const offset of offsets){
      const bytes=new Uint8Array(await file.slice(offset,offset+chunk).arrayBuffer());
      if(bytes.byteLength!==chunk)
        throw originalResolutionError('The dropped file changed while its original location was being verified.');
      samples.push(bytes);
      sampled+=bytes.byteLength;
      if(onProgress) onProgress({stage:'reference',loaded:sampled,total:sampleTotal,unit:'bytes',
        percent:sampleTotal ? sampled/sampleTotal*100 : null,message:'Verifying original file'});
    }
    const sample=new Uint8Array(samples.reduce((sum,bytes)=>sum+bytes.byteLength,0));
    let write=0;
    for(const bytes of samples){ sample.set(bytes,write); write+=bytes.byteLength; }
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',sample));
    const fingerprint=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
    if(onProgress) onProgress({stage:'reference',loaded:sampleTotal,total:sampleTotal,unit:'bytes',
      percent:null,message:'Confirming original file'});
    const response=await fetch('/api/media/resolve-drop',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({
        name:file.name,size,lastModified:Number(file.lastModified)||0,
        fingerprint,sampleBytes:IDENTITY_SAMPLE_BYTES
      })});
    let result;
    try { result=await response.json(); }
    catch(error){ throw originalResolutionError('The local helper did not return a verified original file.',response.status); }
    if(!response.ok && result.code==='ORIGINAL_AMBIGUOUS')
      return chooseOriginalMatch(file,result.candidates);
    if(!response.ok || result.error)
      throw originalResolutionError(result.error||result.reason,
        response.status===404 ? 409 : response.status,result.code);
    const record=result.file||result.record||result;
    if(!record || !record.path || !record.url || record.name!==file.name || Number(record.size)!==size)
      throw originalResolutionError('The local helper did not return a verified original file.');
    return originalFile(record,{name:file.name,size,lastModified:Number(file.lastModified)||0,
      fingerprint,sampleBytes:IDENTITY_SAMPLE_BYTES});
  })();
  state.originalFiles.set(file,task);
  try { return await task; }
  catch(error){
    state.originalFiles.delete(file);
    throw error&&error.status ? error : originalResolutionError(String(error&&error.message||error));
  }
}

/* A helper restart retires RAM tokens, not the user's file. Reconnect only an
   exact original still selected/registered/open on the native side; the path
   itself never authorizes arbitrary file access. Keep the same File object so
   every Clip and pinned presenter retains its original ownership. */
async function refreshOriginal(file){
  if(!file||typeof file!=='object'||!file._openlivePath||!localMediaAvailable())
    throw originalResolutionError('Select the same original with Files > Add Files before reconnecting.');
  const pending=state.originalRefreshes.get(file);if(pending)return pending;
  const path=file._openlivePath,name=file.name,size=Number(file.size),lastModified=Number(file.lastModified)||0;
  const proof=file._openliveOriginalProof;
  if(proof&&(proof.name!==name||Number(proof.size)!==size||Number(proof.lastModified)!==lastModified))
    throw originalResolutionError('The original reference changed. Select the same file again.');
  const task=(async()=>{
    const response=await fetch('/api/media/refresh-original',{method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({path,name,size,lastModified,
        fingerprint:proof?.fingerprint||null,sampleBytes:IDENTITY_SAMPLE_BYTES})});
    let result;
    try{result=await response.json();}
    catch(error){throw originalResolutionError('The local helper did not return the original reference.',response.status);}
    if(!response.ok||result.error)
      throw originalResolutionError(result.error||'The original could not be reconnected.',response.status,result.code);
    const record=result.file,token=record&&(record.sourceToken||sourceTokenOf(record.url));
    const refreshedProof=record&&record.originalProof;
    if(!record||record.path!==path||record.name!==name||Number(record.size)!==size||
      Math.abs(Number(record.lastModified)-lastModified)>2||!record.url||!token||
      !refreshedProof||refreshedProof.name!==name||Number(refreshedProof.size)!==size||
      Math.abs(Number(refreshedProof.lastModified)-lastModified)>2||
      !/^[0-9a-f]{64}$/.test(refreshedProof.fingerprint)||refreshedProof.sampleBytes!==IDENTITY_SAMPLE_BYTES||
      proof&&(refreshedProof?.fingerprint!==proof.fingerprint))
      throw originalResolutionError('The helper returned a different original. Select the same file again.');
    if(file._openlivePath!==path||file.name!==name||Number(file.size)!==size||
       (Number(file.lastModified)||0)!==lastModified||file._openliveOriginalProof!==proof)
      throw originalResolutionError('The original reference changed while reconnecting. Select it again.');
    file._openliveURL=record.url;file._openliveSourceToken=token;
    file._openliveOriginalProof=Object.freeze({...refreshedProof,lastModified});
    if(file.sourceReference?.path===path)file.sourceReference.url=record.url;
    for(const [id,original] of state.sourceFiles){
      if(original!==file)continue;
      const media=MEDIA.find(id);
      if(media?.sourceReference?.path===path)media.sourceReference.url=record.url;
    }
    return file;
  })();
  state.originalRefreshes.set(file,task);
  try{return await task;}finally{if(state.originalRefreshes.get(file)===task)state.originalRefreshes.delete(file);}
}

/* A browser File is a capability for the user's original, not a saved copy.
   Its path is deliberately unavailable unless the read-only helper verifies it.
   Keep that distinction explicit instead of inventing a filesystem location. */
function sourceReferenceOf(file,reason){
  if(file && file.sourceReference) return file.sourceReference;
  const verified=!!(file && file._openlivePath);
  const match=file&&file._openliveDropMatch;
  return {kind:verified?'original-path':'browser-file',
    path:verified?file._openlivePath:null,url:verified?file._openliveURL||null:null,
    verified,sessionOnly:true,copies:false,reason:verified?null:reason||null,
    ...(match?{matchOrigin:match.method,droppedPathVerified:match.droppedPathVerified,
      matchedExistingPath:match.matchedExistingPath,refPath:match.refPath}: {})};
}

async function selectLocalMedia(kind){
  const desktop=window.OpenLiveDesktop;
  if(desktop&&typeof desktop.selectOriginalFiles==='function'){
    const result=await desktop.selectOriginalFiles({kind});
    if(!result||result.error||!Array.isArray(result.files))
      throw new Error(result&&result.error||'The desktop file picker did not return original files.');
    return result;
  }
  if(!localMediaAvailable()) return null;
  let available;
  try {
    const response=await fetch('/api/media/status',{cache:'no-store'});
    available=response.ok && (await response.json()).available;
  } catch(error){ return null; }
  if(!available) return null;
  const response=await fetch('/api/media/select',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})});
  const result=await response.json();
  if(!response.ok || result.error) throw new Error(result.error||'The local file picker could not open.');
  return result;
}

const sourceURL = file => file && file._openliveURL || URL.createObjectURL(file);
/* Library structure and per-Clip runtime state have very different repaint
   costs. Import/register/remove changes the Files tree, while native upload
   progress and poster metadata only change rows which are already mounted.
   Carry that distinction to subscribers so a large external Drop cannot
   rebuild the complete Browser tree once per upload progress event. */
const emit = change => {
  const event=change&&typeof change==='object' ? change : {kind:String(change||'update')};
  for(const fn of state.listeners) { try { fn(event); } catch(e){} }
};

const runtimeKey = prefix => {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + (++runtimeSerial).toString(36) + '-' + Math.random().toString(36).slice(2);
  return prefix + ':' + id;
};

function looseIdentityKey(file,kind){
  return [kind||kindOf(file)||'',file&&file._openlivePath||'',file&&file.name||'',Number(file&&file.size)||0,
    Number(file&&file.lastModified)||0,file&&file.type||''].join('|');
}
async function boundedFileFingerprint(file){
  if(!file || typeof file!=='object' || typeof file.slice!=='function') return null;
  const cached=state.fileFingerprints.get(file);
  if(cached) return cached;
  const task=(async()=>{
    const size=Math.max(0,Number(file.size)||0), chunk=Math.min(IDENTITY_SAMPLE_BYTES,size);
    const offsets=[];
    for(let i=0;i<IDENTITY_SAMPLE_COUNT;i++){
      const ratio=IDENTITY_SAMPLE_COUNT===1?0:i/(IDENTITY_SAMPLE_COUNT-1);
      const offset=Math.max(0,Math.round((size-chunk)*ratio));
      if(!offsets.includes(offset)) offsets.push(offset);
    }
    let a=0x811c9dc5,b=0x9e3779b9;
    for(const offset of offsets){
      const bytes=new Uint8Array(await file.slice(offset,offset+chunk).arrayBuffer());
      for(let base=0;base<bytes.length;base+=FINGERPRINT_CHUNK_BYTES){
        const end=Math.min(bytes.length,base+FINGERPRINT_CHUNK_BYTES);
        for(let i=base;i<end;i++){
          const absolute=offset+i,value=bytes[i];
          a=Math.imul(a^value,0x01000193)>>>0;
          b=Math.imul(b^(value+(absolute&255)),0x85ebca6b)>>>0;
        }
        if(end<bytes.length) await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
  })();
  state.fileFingerprints.set(file,task);
  return task;
}

async function reusableLooseClip(file,kind,pending){
  const key=looseIdentityKey(file,kind);
  const candidates=[];
  const indexed=typeof MEDIA.inFolder==='function'?MEDIA.inFolder(LOOSE):[];
  for(const clip of indexed) if(clip.looseIdentityKey===key)
    candidates.push({clip,file:state.sourceFiles.get(clip.id)});
  for(const record of pending||[]) if(record.clip.looseIdentityKey===key) candidates.push(record);
  for(const candidate of candidates){
    if(!candidate.file) continue;
    if(candidate.file===file) return candidate.clip;
    if(file._openlivePath && candidate.file._openlivePath===file._openlivePath)
      return candidate.clip;
    /* Browsers deliberately hide absolute paths for loose Files. Reuse across
       separate picker/drop File objects therefore requires both the complete
       stable metadata tuple and a bounded five-region content fingerprint.
       Same-name/same-size files with different sampled bytes remain distinct. */
    const [left,right]=await Promise.all([
      boundedFileFingerprint(candidate.file),boundedFileFingerprint(file)]);
    if(left && right && left===right) return candidate.clip;
  }
  return null;
}

/* --------------------------------------------------------------------------
   QuickTime/MOV routing

   Resolume writes `mdat` before `moov`, and `mdat` may be gigabytes. Walk only
   the top-level atom headers with File.slice(), then read the one `moov` atom.
   Import therefore costs the size of the metadata, not the size of the video.
   -------------------------------------------------------------------------- */
const QT_CONTAINERS = new Set(['moov','trak','mdia','minf','stbl','edts','dinf']);
const ascii4 = (bytes, off) => String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
const u32 = (view, off) => view.getUint32(off, false);
const u64 = (view, off) => u32(view,off) * 0x100000000 + u32(view,off+4);
const fixed16 = (view, off) => view.getInt32(off,false)/65536;

function qtAtom(bytes, off, end){
  if(off + 8 > end) return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let size=u32(view,off), header=8;
  const type=ascii4(bytes,off+4);
  if(size===1){ if(off+16>end) return null; size=u64(view,off+8); header=16; }
  else if(size===0) size=end-off;
  if(!Number.isSafeInteger(size) || size<header || off+size>end) return null;
  return {type,off,size,header,end:off+size};
}

function walkQt(bytes, start, end, out){
  for(let off=start; off+8<=end;){
    const atom=qtAtom(bytes,off,end); if(!atom) break;
    out.push(atom);
    if(QT_CONTAINERS.has(atom.type)) walkQt(bytes,atom.off+atom.header,atom.end,out);
    off=atom.end;
  }
  return out;
}

async function readMoov(file){
  for(let off=0; off+8<=file.size;){
    const head=new Uint8Array(await file.slice(off,Math.min(file.size,off+16)).arrayBuffer());
    if(head.length<8) break;
    const view=new DataView(head.buffer,head.byteOffset,head.byteLength);
    let size=u32(view,0), header=8;
    const type=ascii4(head,4);
    if(size===1){ if(head.length<16) break; size=u64(view,8); header=16; }
    else if(size===0) size=file.size-off;
    if(!Number.isSafeInteger(size) || size<header || off+size>file.size) break;
    if(type==='moov'){
      if(size>MAX_MOOV_BYTES) throw new Error((file.name||'MOV')+
        ' has an unusually large moov atom; using browser/native probing instead.');
      return new Uint8Array(await file.slice(off,off+size).arrayBuffer());
    }
    off+=size;
  }
  throw new Error((file.name||'MOV') + ' has no readable moov atom.');
}

async function contentFingerprint(bytes, file){
  /* Native cache identity must not turn a large QuickTime `moov` atom into one
     uninterruptible main-thread hash. Size/mtime plus evenly distributed
     metadata samples retain content sensitivity; hashing in 64 KiB tasks gives
     pointer/render work a chance between chunks. */
  const length=bytes.length;
  if(!length) return '0000000000000000-'+Number(file.size||0).toString(16)+'-'+
    Number(file.lastModified||0).toString(16);
  const limit=Math.min(length,FINGERPRINT_SAMPLE_BYTES);
  const step=limit<length ? Math.max(1,Math.floor(length/limit)) : 1;
  let a=0x811c9dc5, b=0x9e3779b9;
  for(let base=0;base<limit;base+=FINGERPRINT_CHUNK_BYTES){
    const end=Math.min(limit,base+FINGERPRINT_CHUNK_BYTES);
    for(let sample=base;sample<end;sample++){
      const i=Math.min(length-1,sample*step), value=bytes[i];
      a=Math.imul(a^value,0x01000193)>>>0;
      b=Math.imul(b^(value+(i&255)),0x85ebca6b)>>>0;
    }
    if(end<limit) await new Promise(resolve=>setTimeout(resolve,0));
  }
  return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0')+
    '-' + Number(file.size||0).toString(16) + '-' + Number(file.lastModified||0).toString(16);
}

function handlerType(bytes, atoms){
  const h=atoms.find(a=>a.type==='hdlr');
  return h && h.off+h.header+12<=h.end ? ascii4(bytes,h.off+h.header+8) : null;
}

/* QuickTime keeps three different geometries which must not be collapsed:
   the coded raster in stsd, clean aperture / pixel aspect ratio in the sample
   entry, and the presentation transform in tkhd. Programme Width/Height use
   the final display geometry; native decoders still receive codedWidth/Height
   so their RGBA byte count is exact. */
function quickTimeDisplayGeometry(bytes, chosen, sample, stsd, codedWidth, codedHeight){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let pixelAspectRatio=1, cleanWidth=codedWidth, cleanHeight=codedHeight,
    cleanOffsetX=0,cleanOffsetY=0;
  const sampleSize=sample+4<=stsd.end ? u32(view,sample) : 0;
  const sampleEnd=sampleSize>=86&&sample+sampleSize<=stsd.end ? sample+sampleSize : stsd.end;
  for(let off=sample+86;off+8<=sampleEnd;){
    const atom=qtAtom(bytes,off,sampleEnd); if(!atom) break;
    if(atom.type==='pasp'&&atom.off+atom.header+8<=atom.end){
      const horizontal=u32(view,atom.off+atom.header), vertical=u32(view,atom.off+atom.header+4);
      if(horizontal>0&&vertical>0) pixelAspectRatio=horizontal/vertical;
    } else if(atom.type==='clap'&&atom.off+atom.header+32<=atom.end){
      const p=atom.off+atom.header;
      const widthN=u32(view,p),widthD=u32(view,p+4),heightN=u32(view,p+8),heightD=u32(view,p+12);
      if(widthN&&widthD) cleanWidth=widthN/widthD;
      if(heightN&&heightD) cleanHeight=heightN/heightD;
      const offsetXN=u32(view,p+16),offsetXD=u32(view,p+20),offsetYN=u32(view,p+24),offsetYD=u32(view,p+28);
      if(offsetXD) cleanOffsetX=(offsetXN|0)/offsetXD;
      if(offsetYD) cleanOffsetY=(offsetYN|0)/offsetYD;
    }
    off=atom.end;
  }

  let rotation=0,trackWidth=0,trackHeight=0;
  const tkhd=chosen.atoms.find(a=>a.type==='tkhd');
  if(tkhd){
    const body=tkhd.off+tkhd.header, version=bytes[body], matrix=body+(version===1?52:40);
    const dimensions=body+(version===1?88:76);
    if(matrix+36<=tkhd.end){
      const a=fixed16(view,matrix),b=fixed16(view,matrix+4);
      if(Math.abs(a)>1e-6||Math.abs(b)>1e-6){
        /* Match ffprobe/QuickTime's public rotation convention. The stored
           display matrix applies the inverse mapping to source coordinates. */
        rotation=Math.round(-Math.atan2(b,a)*180/Math.PI/90)*90;
        rotation=((rotation%360)+360)%360;
        if(rotation===270) rotation=-90;
      }
    }
    if(dimensions+8<=tkhd.end){
      trackWidth=fixed16(view,dimensions); trackHeight=fixed16(view,dimensions+4);
    }
  }
  const sampleWidth=cleanWidth*pixelAspectRatio, sampleHeight=cleanHeight;
  /* Some writers leave tkhd at the coded raster while pasp/clap carries the
     real presentation size. A genuinely scaled tkhd remains authoritative. */
  const hasTrackBounds=trackWidth>0&&trackHeight>0;
  let displayWidth=hasTrackBounds ? trackWidth : sampleWidth;
  let displayHeight=hasTrackBounds ? trackHeight : sampleHeight;
  if(Math.abs(rotation)===90){
    /* Writers disagree whether tkhd width/height are pre- or post-rotation.
       Compare aspect ratios so an already-swapped bounding box is never
       swapped twice. Arbitrary scaled pre-rotation bounds retain their scale. */
    const unrotatedRatio=sampleWidth/sampleHeight, trackRatio=displayWidth/displayHeight;
    const alreadyRotated=Math.abs(trackRatio-(1/unrotatedRatio))<Math.abs(trackRatio-unrotatedRatio);
    if(!alreadyRotated) [displayWidth,displayHeight]=[displayHeight,displayWidth];
  }
  return {
    codedWidth,codedHeight,
    cleanApertureWidth:cleanWidth,cleanApertureHeight:cleanHeight,
    cleanApertureOffsetX:cleanOffsetX,cleanApertureOffsetY:cleanOffsetY,
    pixelAspectRatio,
    rotation,
    displayWidth:Math.max(1,Math.round(displayWidth)),
    displayHeight:Math.max(1,Math.round(displayHeight))
  };
}

async function probeQuickTimeFile(file, options){
  options=options||{};
  const bytes=await readMoov(file);
  const root=qtAtom(bytes,0,bytes.length);
  if(!root || root.type!=='moov') throw new Error('Invalid moov atom.');
  const direct=[];
  for(let off=root.off+root.header;off+8<=root.end;){
    const atom=qtAtom(bytes,off,root.end); if(!atom) break;
    direct.push(atom); off=atom.end;
  }
  const tracks=direct.filter(a=>a.type==='trak').map(trak=>{
    const atoms=walkQt(bytes,trak.off+trak.header,trak.end,[]);
    return {trak,atoms,handler:handlerType(bytes,atoms)};
  });
  let chosen=tracks.find(t=>t.handler==='vide');
  if(!chosen) chosen=tracks.find(t=>{
    const s=t.atoms.find(a=>a.type==='stsd');
    return !!(s && s.off+s.header+16<=s.end &&
      (NATIVE_QT_TAGS.has(ascii4(bytes,s.off+s.header+12)) || H264_TAGS.has(ascii4(bytes,s.off+s.header+12))));
  });
  if(!chosen) throw new Error((file.name||'MOV') + ' has no video track.');
  const first=type=>chosen.atoms.find(a=>a.type===type);
  const stsd=first('stsd'), stsz=first('stsz'), mdhd=first('mdhd'), stts=first('stts');
  if(!stsd || !mdhd) throw new Error((file.name||'MOV') + ' is missing video metadata.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const sample=stsd.off+stsd.header+8;
  if(sample+36>stsd.end) throw new Error('Truncated video sample description.');
  const codecTag=ascii4(bytes,sample+4);
  const width=view.getUint16(sample+32,false), height=view.getUint16(sample+34,false);
  const mp=mdhd.off+mdhd.header, version=bytes[mp];
  const timescale=version===1 ? u32(view,mp+20) : u32(view,mp+12);
  const ticks=version===1 ? u64(view,mp+24) : u32(view,mp+16);
  let frames=null, delta=0;
  if(stsz && stsz.off+stsz.header+12<=stsz.end) frames=u32(view,stsz.off+stsz.header+8);
  if(stts && stts.off+stts.header+16<=stts.end) delta=u32(view,stts.off+stts.header+12);
  const geometry=quickTimeDisplayGeometry(bytes,chosen,sample,stsd,width,height);
  const info={
    codecTag,width:geometry.displayWidth,height:geometry.displayHeight,frames,
    ...geometry,
    fps:timescale&&delta ? timescale/delta : null,
    duration:timescale ? ticks/timescale : null,
    hasAudio:tracks.some(t=>t.handler==='soun'),
    isDXV:DXV_TAGS.has(codecTag), isH264:H264_TAGS.has(codecTag),
    isNativeFirst:NATIVE_QT_TAGS.has(codecTag)
  };
  /* Native cache identity is needed only when the bytes will be handed to the
     local decoder. Slot metadata discovery deliberately stops after the small
     moov atom, so a browser-native Explorer drop never performs poster or
     fingerprint work before it can be placed. */
  if(options.fingerprint!==false && !file._openlivePath)
    info.fingerprint=await contentFingerprint(bytes,file);
  return info;
}

function directVideoURL(file, info){
  if(file && file._openliveURL) return file._openliveURL;
  /* Chromium routes an avc1 QuickTime file more reliably when its Blob advertises
     the codec family (`video/mp4`) instead of the generic QuickTime MIME. Blob
     composition is zero-copy; the footage is not duplicated in JS memory. */
  const body=info && info.isH264 && typeof Blob==='function'
    ? new Blob([file],{type:'video/mp4'}) : file;
  return URL.createObjectURL(body);
}

function applyQuickTimeInfo(clip, info){
  validateMediaGeometry(info.codedWidth||info.width,info.codedHeight||info.height,clip.name);
  validateMediaGeometry(info.displayWidth||info.width,info.displayHeight||info.height,clip.name);
  clip.codecTag=info.codecTag;
  clip.sourceCodec=info.isDXV ? 'dxv' : info.isH264 ? 'h264'
    : PRORES_TAGS.has(info.codecTag) ? 'prores'
    : HAP_TAGS.has(info.codecTag) ? 'hap'
    : NOTCHLC_TAGS.has(info.codecTag) ? 'notchlc' : 'mov';
  clip.sourceTag=info.isDXV ? 'DXV3' : info.isH264 ? 'H.264' : info.codecTag;
  clip.codedWidth=info.codedWidth||info.width||null;
  clip.codedHeight=info.codedHeight||info.height||null;
  clip.displayWidth=info.displayWidth||info.width||null;
  clip.displayHeight=info.displayHeight||info.height||null;
  clip.width=clip.displayWidth; clip.height=clip.displayHeight;
  clip.rotation=Number(info.rotation)||0;
  clip.pixelAspectRatio=Number(info.pixelAspectRatio)||1;
  clip.cleanApertureWidth=info.cleanApertureWidth||clip.codedWidth;
  clip.cleanApertureHeight=info.cleanApertureHeight||clip.codedHeight;
  clip.cleanApertureOffsetX=Number(info.cleanApertureOffsetX)||0;
  clip.cleanApertureOffsetY=Number(info.cleanApertureOffsetY)||0;
  clip.containerDisplayGeometry=true;
  const alphaCapable=info.codecTag==='ap4h'||info.codecTag==='ap4x'||
    info.codecTag==='HapA'||info.codecTag==='HapM';
  if(alphaCapable){ clip.hasAlpha=true; clip.keyed=true; }
  clip.fps=info.fps||null; clip.duration=info.duration||null;
  clip.hasAudio=!!info.hasAudio;
  deriveClipBeats(clip);
  clip.metadataState='ready'; clip.metadataError=null;
}

function applyBrowserDecodedGeometry(clip, video){
  const width=Number(video&&video.videoWidth)||0,height=Number(video&&video.videoHeight)||0;
  if(!width||!height) return false;
  validateMediaGeometry(width,height,clip&&clip.name);
  clip.decodedWidth=width; clip.decodedHeight=height;
  /* Chromium reports the presentation dimensions for rotated MP4/MOV. The
     container parser is retained as authority because poster probing must not
     overwrite its pasp/clap/display-matrix geometry with a coded raster. */
  if(!clip.containerDisplayGeometry){
    clip.codedWidth=width; clip.codedHeight=height;
    clip.displayWidth=width; clip.displayHeight=height;
    clip.width=width; clip.height=height;
    clip.pixelAspectRatio=clip.pixelAspectRatio||1;
  }
  return true;
}

/* Metadata and poster extraction are separate capabilities. A Slot needs the
   former before it can inherit the source duration, dimensions and embedded
   Audio track; it does not need to seek/decode a frame or encode a JPEG. */
function browserVideoMetadata(clip){
  return new Promise((resolve,reject)=>{
    const v=document.createElement('video');
    v.muted=true; v.playsInline=true; v.preload='metadata';
    let done=false;
    const finish=(ok,error)=>{
      if(done) return; done=true; clearTimeout(timer);
      v.onloadedmetadata=v.onerror=null;
      v.removeAttribute('src'); try { v.load(); } catch(e){}
      ok ? resolve(clip) : reject(error instanceof Error ? error : new Error(String(error||
        'The video did not expose decodable metadata.')));
    };
    const timer=setTimeout(()=>finish(false,new Error(
      'The video did not expose decodable metadata within 8 seconds.')),8000);
    v.onloadedmetadata=()=>{
      if(!registeredClip(clip)){ finish(false,new Error('The media was removed while metadata was loading.')); return; }
      try {
        clip.duration=isFinite(v.duration)?v.duration:null;
        applyBrowserDecodedGeometry(clip,v);
      } catch(error){ finish(false,error); return; }
      noteEmbeddedAudio(clip,v);
      deriveClipBeats(clip);
      finish(true);
    };
    v.onerror=()=>finish(false,new Error('The browser refused this video metadata.'));
    v.src=clip.video;
  });
}

async function discoverMetadata(clip){
  if(clip.mediaKind==='image'){
    if(clip.requiresPrepare){ await clip.ensurePlayable(); applyStillMetadata(clip); return clip; }
    return probeImageMetadata(clip,false);
  }
  if(clip.mediaKind==='audio') return probeAudio(clip);
  if(clip.requiresPrepare){
    if(typeof clip.ensurePlayable!=='function') throw new Error('Native media preparation is unavailable.');
    await clip.ensurePlayable();
    return clip;
  }
  const file=state.sourceFiles.get(clip.id), ext=extOf(clip.source||file&&file.name);
  if(file && (ext==='mp4'||ext==='m4v'||ext==='mov'||ext==='qt')){
    try {
      const info=await probeQuickTimeFile(file,{fingerprint:false});
      if(!registeredClip(clip)) throw new Error('The media was removed while metadata was loading.');
      applyQuickTimeInfo(clip,info);
      return clip;
    } catch(error){
      /* A valid browser-native variant can have metadata outside the subset of
         QuickTime atoms parsed above. Let Chromium answer before rejecting it. */
      if(!clip.video) throw error;
    }
  }
  if(!clip.video) throw new Error('The media has no browser metadata source.');
  return browserVideoMetadata(clip);
}

function ensureMetadata(ref){
  const clip=ref&&typeof ref==='object'?ref:MEDIA.find(ref);
  if(!clip || !registeredClip(clip))
    return Promise.reject(new Error('The media was removed before metadata could be read.'));
  if(clip.nativePresentation || clip.presentation?.player) return Promise.resolve(clip);
  const sourceFile=state.sourceFiles.get(clip.id), extension=extOf(clip.source||sourceFile&&sourceFile.name);
  const boundedContainer=!!(sourceFile && clip.mediaKind==='video' &&
    (extension==='mp4'||extension==='m4v'||extension==='mov'||extension==='qt'));
  /* The poster path can learn duration/dimensions from HTMLMediaElement but it
     cannot learn frame rate. A fast +Files -> Slot drag must still parse the
     small QuickTime atom when fps is absent instead of accepting partial
     metadata as complete. */
  if(clip.metadataState==='ready' && (!boundedContainer || Number(clip.fps)>0))
    return Promise.resolve(clip);
  if(clip.metadataPromise) return clip.metadataPromise;
  /* Native preparation already publishes authoritative source metadata. Direct
     browser files still need an explicit pass even if a placeholder dimension
     happened to be present on a restored Clip. */
  if(clip.requiresPrepare && clip.prepareState==='ready'){
    clip.metadataState='ready'; return Promise.resolve(clip);
  }
  clip.metadataState='loading';
  clip.metadataPromise=Promise.resolve().then(()=>discoverMetadata(clip)).then(()=>{
    if(!registeredClip(clip)) throw new Error('The media was removed while metadata was loading.');
    clip.metadataState='ready'; clip.metadataError=null;
    emit({kind:'clip',id:clip.id});
    return clip;
  }).catch(error=>{
    if(registeredClip(clip)){
      clip.metadataState='error'; clip.metadataError=String(error&&error.message||error);
      emit({kind:'clip',id:clip.id});
    }
    throw error;
  }).finally(()=>{ clip.metadataPromise=null; });
  return clip.metadataPromise;
}

function nativePrepareKey(clip,file,info){
  return [clip.id,file.name||clip.source,file.size||0,file.lastModified||0,
    info&&info.fingerprint||'native'].join('|');
}

function routeNativeClip(clip,file,info,reason){
  if(!clip || !file) return clip;
  const replacingBrowser=!!clip.video;
  clip.video=null;
  clip.requiresPrepare=true;
  if(clip.prepareState!=='ready') clip.prepareState='idle';
  clip.prepareKey=nativePrepareKey(clip,file,info);
  clip.ensurePlayable=()=>ensureNativeClip(clip);
  clip.nativeFallbackReason=reason||null;
  clip.playable=true;
  clip.unplayableReason=reason ? reason+' Opening with the native decoder.' : null;
  state.sourceFiles.set(clip.id,file);
  if(replacingBrowser) clip.sourceRevision=(clip.sourceRevision||0)+1;
  /* During ingest the record is not indexed yet, so there is no mounted row to
     repaint. Suppress that useless notification; registered fallback routes do
     need one because an existing browser source has just changed transport. */
  if(MEDIA.find(clip.id)===clip){ MEDIA.touch(); emit({kind:'clip',id:clip.id}); }
  return clip;
}

/* A successful container/poster probe does not guarantee that the actual
   playback decoder can open the same codec/profile. Keep one recovery path
   for both probes and attached Slots, retaining the exact original capability.
   expectedURL prevents a late error from replacing a newer browser source. */
function fallbackToNative(ref,reason,options={}){
  const clip=ref&&typeof ref==='object'?ref:MEDIA.find(ref);
  if(!clip || !registeredClip(clip) || clip.mediaKind!=='video')
    return Promise.reject(new Error('The video was removed before native playback could open.'));
  if(clip.requiresPrepare && !clip.video){
    if(clip.prepareState==='error' && clip.playable===false)
      return Promise.reject(new Error(clip.unplayableReason||'The native decoder rejected this file.'));
    return ensureNativeClip(clip);
  }
  if(options.expectedURL!==undefined && clip.video!==options.expectedURL){
    const error=new Error('The video source changed before native playback could open.');
    error.name='AbortError';
    return Promise.reject(error);
  }
  const file=state.sourceFiles.get(clip.id);
  if(!file){
    clip.playable=false;
    clip.unplayableReason=(reason||'The browser could not decode this video.')+
      ' The original file is no longer available. Select it again with Add Files.';
    MEDIA.touch(); emit({kind:'clip',id:clip.id});
    return Promise.reject(new Error(clip.unplayableReason));
  }
  const failedURL=clip.video;
  routeNativeClip(clip,file,null,reason||'The browser could not decode this video.');
  if(typeof failedURL==='string' && failedURL.startsWith('blob:')){
    try { URL.revokeObjectURL(failedURL); } catch(error){}
  }
  return ensureNativeClip(clip);
}

async function ensureNativeClip(clip){
  if(!clip || !clip.requiresPrepare) return clip;
  if(MEDIA.find(clip.id)!==clip)
    return Promise.reject(new Error('The media was removed before native playback opened.'));
  if(clip.prepareState==='ready') return clip;
  if(clip.preparePromise) return clip.preparePromise;
  const tier=window.OpenLiveDXV;
  const file=state.sourceFiles.get(clip.id);
  if(!tier || !tier.prepareFile || !file){
    clip.playable=false; clip.prepareState='error';
    clip.unplayableReason=!file ? 'The selected media file is no longer available.'
      : 'This format needs the SHOWAVE native decoder in devserver.py.';
    MEDIA.touch(); emit({kind:'clip',id:clip.id});
    return Promise.reject(new Error(clip.unplayableReason));
  }
  clip.prepareState='preparing'; clip.prepareProgress={phase:'open',done:0,total:0};
  /* Upload progress changes only the Files-row label. The media dirty counter
     is the poster/content revision signal; incrementing it here repainted every
     mounted Clip canvas on every XHR progress event. */
  emit({kind:'clip',id:clip.id});
  clip.preparePromise=Promise.resolve().then(async()=>{
    const original=file._openlivePath ? file : await resolveOriginal(file);
    if(MEDIA.find(clip.id)!==clip)
      throw new Error('The media was removed while its original location was being verified.');
    state.sourceFiles.set(clip.id,original);
    clip.originalSource=original;
    clip.sourceReference=sourceReferenceOf(original);
    clip.sourceReferences=[clip.sourceReference,...(clip.sourceReferences||[]).slice(1)];
    clip.source=original._openlivePath||original.name;
    return tier.prepareFile(original,clip.prepareKey,(done,total,phase)=>{
      if(MEDIA.find(clip.id)!==clip) return;
      clip.prepareProgress={phase:phase||'open',done:done||0,total:total||0};
      emit({kind:'clip',id:clip.id});
    });
  }).then(rec=>{
    if(MEDIA.find(clip.id)!==clip){
      /* A removed folder must not be resurrected by a late upload/open result,
         nor may its retained File capability stay pinned in the native client. */
      if(tier.releaseFile) tier.releaseFile(clip.prepareKey);
      throw new Error('The media was removed while native playback was opening.');
    }
    clip.nativeRecord=rec;
    /* `dxvRecord` is retained as a compatibility alias for ArenaMedia and saved
       sessions created before the decoder became format-neutral. */
    clip.dxvRecord=rec;
    /* Native playback is a source-resolution RGBA session, not a converted
       browser video. Keep the original media transport distinct from <video>. */
    clip.video=null;
    clip.duration=rec.duration||clip.duration;
    clip.decodedWidth=rec.width||clip.decodedWidth; clip.decodedHeight=rec.height||clip.decodedHeight;
    clip.codedWidth=rec.codedWidth||rec.width||clip.codedWidth;
    clip.codedHeight=rec.codedHeight||rec.height||clip.codedHeight;
    clip.displayWidth=rec.displayWidth||rec.width||clip.displayWidth;
    clip.displayHeight=rec.displayHeight||rec.height||clip.displayHeight;
    clip.cleanApertureWidth=rec.cleanApertureWidth||clip.codedWidth;
    clip.cleanApertureHeight=rec.cleanApertureHeight||clip.codedHeight;
    clip.cleanApertureOffsetX=Number(rec.cleanApertureOffsetX)||0;
    clip.cleanApertureOffsetY=Number(rec.cleanApertureOffsetY)||0;
    clip.width=clip.displayWidth||clip.width; clip.height=clip.displayHeight||clip.height;
    clip.rotation=Number(rec.rotation)||0;
    clip.pixelAspectRatio=Number(rec.pixelAspectRatio)||1;
    clip.fps=rec.fps||clip.fps;
    clip.hasAlpha=!!rec.hasAlpha; clip.keyed=!!rec.hasAlpha;
    if(clip.mediaKind==='image') applyStillMetadata(clip);
    if(rec.codecName){
      clip.sourceCodec=String(rec.codecName).toLowerCase();
      clip.sourceTag=String(rec.codecName).toUpperCase();
    }
    /* The generic frame endpoint currently transports video pixels only. Keep
       source metadata, but never create an Audio track which cannot make sound.
       A separately imported sidecar remains fully playable and wins here. */
    clip.nativeEmbeddedAudio=rec.embeddedAudio===true || rec.hasAudio===true;
    clip.hasEmbeddedAudio=clip.nativeEmbeddedAudio;
    if(clip.audio) clip.hasAudio=true;
    else {
      clip.hasAudio=false;
      clip.nativeAudioWarning=clip.nativeEmbeddedAudio
        ? rec.audioUnsupportedReason ||
          'This source contains embedded audio, but native audio transport is not available yet.' : null;
    }
    clip.prepareState='ready'; clip.prepareProgress=null; clip.playable=true;
    clip.unplayableReason=null; clip.sourceRevision=(clip.sourceRevision||0)+1;
    deriveClipBeats(clip); MEDIA.touch(); emit({kind:'clip',id:clip.id});
    return clip;
  }).catch(err=>{
    if(MEDIA.find(clip.id)!==clip) throw err;
    /* An unsupported/corrupt source is terminal and must not trigger to black.
       A stopped/restarting loopback tier remains retryable on the next gesture. */
    const terminal=err&&(err.status===409 || err.status===415 || err.status===422);
    clip.prepareState='error'; clip.prepareProgress=null; clip.playable=!terminal;
    clip.unplayableReason=err&&err.originalUnverified
      ? String(err.message)
      : (terminal?'Native decoder rejected this file (unsupported or corrupt): '
        :'Native media open failed: ')+String(err&&err.message||err);
    MEDIA.touch(); emit({kind:'clip',id:clip.id}); throw err;
  }).finally(()=>{
    clip.preparePromise=null;
  });
  return clip.preparePromise;
}

async function configureVisualClip(clip,file){
  clip.sourceReference=clip.sourceReference||sourceReferenceOf(file);
  clip.originalSource=clip.originalSource||file.originalSource||file;
  if(clip.mediaKind!=='video'){
    state.sourceFiles.set(clip.id,file);
    if(clip.mediaKind==='image' && /^(?:tif|tiff)$/.test(extOf(file.name))){
      routeNativeClip(clip,file,null,'TIFF stills use the source-resolution native decoder.');
      return clip;
    }
    clip.video=clip.playable ? directVideoURL(file,null) : null;
    return clip;
  }
  /* Retain the capability even for files expected to be browser-native. Codec
     support varies between Chromium builds; a later real probe failure must be
     able to hand these exact bytes to native decoding automatically. */
  state.sourceFiles.set(clip.id,file);
  if(NATIVE_FIRST_EXT.has(extOf(file.name))){
    routeNativeClip(clip,file,null,'This container is not browser-native.');
    return clip;
  }
  if(extOf(file.name)!=='mov'){
    clip.video=directVideoURL(file,null);
    return clip;
  }
  try {
    const info=await probeQuickTimeFile(file);
    applyQuickTimeInfo(clip,info);
    if(info.isNativeFirst){
      routeNativeClip(clip,file,info,null);
    } else clip.video=directVideoURL(file,info);
  } catch(err){
    /* Non-QuickTime .mov variants still get the browser's real decoder probe.
       Refusing them from an atom-parser guess would hide files Chromium can in
       fact play. */
    clip.video=directVideoURL(file,null);
    clip.containerProbeError=String(err&&err.message||err);
  }
  return clip;
}

/* Session-only capabilities. Existing browser databases are neither read nor
   changed. Files, folder handles, masks and LUTs live only in this page. */
const dbPut = async () => {};
const dbDel = async () => {};
const dbImagePut = async () => {};
const dbImageDel = async () => {};

/* Image-valued effects keep a runtime identity and the selected File capability
   for this page only. ArenaFX owns the decoded runtime resource. */
const newImageId = file => {
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  return 'image-file:' + uuid + ':' + String(file && file.name || 'image');
};
const newLutId = file => {
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  return 'lut-file:' + uuid + ':' + String(file && file.name || 'lookup.cube');
};
function installImageRecord(rec){
  if(!rec || !rec.key || !rec.file) return null;
  state.images.set(String(rec.key), rec);
  if(window.ArenaFX && ArenaFX.registerImage)
    ArenaFX.registerImage(String(rec.key), rec.file);
  return rec;
}
async function persistImage(file){
  if(!file || kindOf(file.name) !== 'image') throw new Error('Image parameters accept still images.');
  const same = [...state.images.values()].find(rec => rec && rec.name === file.name &&
    Number(rec.size) === Number(file.size) && Number(rec.lastModified) === Number(file.lastModified));
  const rec = {
    key: same ? same.key : newImageId(file),
    name: String(file.name || 'Image'),
    size: Number(file.size || 0),
    lastModified: Number(file.lastModified || 0),
    file
  };
  await dbImagePut(rec);              // compatibility hook; no persistent write
  installImageRecord(rec);
  emit({kind:'library'});
  return { id:rec.key, name:rec.name, file:rec.file };
}
async function forgetImage(id){
  const key = String(id || '');
  if(!key || !state.images.has(key)) return false;
  state.images.delete(key);
  await dbImageDel(key);
  emit({kind:'library'});
  return true;
}
async function installLUTRecord(rec,text){
  if(!rec || !rec.key || !rec.file) return null;
  if(window.ArenaFX && ArenaFX.registerLUT){
    const result=ArenaFX.registerLUT(String(rec.key),text == null ? await rec.file.text() : text);
    if(result && result.error){
      /* Do not advertise a corrupt resource as installed. In particular, a
         failed first decode must not block a corrected file with the same
         durable identity from being registered later in this session. */
      rec.error=result.error;
      return null;
    }
  }
  state.luts.set(String(rec.key),rec);
  return rec;
}
async function persistLUT(file){
  if(!file || extOf(file.name)!=='cube') throw new Error('LUT 3D accepts .cube files.');
  const text=await file.text();
  /* File metadata alone is not an identity. Different touring folders commonly
     contain same-named LUTs with the same generated size and timestamp. Reuse a
     durable key only after the bytes also match; otherwise keep the selections
     independent, just like the session fallback in app.js. */
  let same=null;
  for(const candidate of state.luts.values()){
    if(!candidate || candidate.name!==file.name || Number(candidate.size)!==Number(file.size) ||
       Number(candidate.lastModified)!==Number(file.lastModified)) continue;
    try {
      if(String(await candidate.file.text())===String(text)){ same=candidate; break; }
    } catch(error){}
  }
  const rec={key:same ? same.key : newLutId(file),kind:'lut3d',
    name:String(file.name || 'Lookup.cube'),size:Number(file.size || 0),
    lastModified:Number(file.lastModified || 0),file};
  if(window.ArenaFX && ArenaFX.parseCube){
    const parsed=ArenaFX.parseCube(text);
    if(parsed && parsed.error) throw new Error(parsed.error);
  }
  /* This compatibility hook is session-only. Validate before installing the
     resource so a failed decode does not retain an unreachable LUT. */
  await dbImagePut(rec);
  let installed=null;
  try { installed=await installLUTRecord(rec,text); }
  catch(error){
    try { await dbImageDel(rec.key); } catch(cleanupError){}
    throw error;
  }
  if(!installed){
    try { await dbImageDel(rec.key); } catch(cleanupError){}
    throw new Error(rec.error || 'Invalid .cube LUT.');
  }
  emit({kind:'library'});
  return {id:rec.key,name:rec.name,file:rec.file};
}

/* --------------------------------------------------------------------------
   Scanning
   -------------------------------------------------------------------------- */
async function walk(dirHandle, rootName, relPath, out, depth){
  if(depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  for await (const entry of dirHandle.values()){
    if(out.length >= MAX_FILES) return;
    if(entry.kind === 'directory'){
      if(entry.name.startsWith('.')) continue;                 // .git, .DS_Store dirs
      await walk(entry, rootName, relPath ? relPath + '/' + entry.name : entry.name, out, depth + 1);
      continue;
    }
    if(entry.name.startsWith('.')) continue;
    let kind = intakeKindOf(entry.name), file=null;
    /* FileSystem handles expose no MIME until getFile(). Inspect metadata for an
       unfamiliar suffix so extensionless/camera-specific video inside a chosen
       folder receives the same content-first routing as a loose drop. */
    if(!kind){
      try { file=await entry.getFile(); kind=intakeKindOf(file); } catch(e){}
    }
    if(!kind) continue;
    out.push({ handle: entry, file, rel: relPath ? relPath + '/' + entry.name : entry.name, kind });
  }
}

/* Build the clip records. Shape is arena-media's, field for field, so the Files
   panel, the grid, find() and attach() all treat these identically to bundled
   media. Sizes and durations arrive later from probe(). */
function pairAudioSidecars(entries, pathOf){
  const audioByStem = new Map(), pairs = new Map(), paired = new Set();
  for(const entry of entries){
    if(entry.kind !== 'audio') continue;
    const stem=stripExt(pathOf(entry)).toLowerCase();
    if(!audioByStem.has(stem)) audioByStem.set(stem,[]);
    audioByStem.get(stem).push(entry);
  }
  /* One sidecar belongs to one Video Clip. Extra same-stem Audio files remain
     independently importable instead of disappearing behind that pairing. */
  for(const entry of entries){
    if(entry.kind !== 'video') continue;
    const candidates=audioByStem.get(stripExt(pathOf(entry)).toLowerCase()) || [];
    const sidecar=candidates.find(candidate=>!paired.has(candidate));
    if(sidecar){ pairs.set(entry,sidecar); paired.add(sidecar); }
  }
  return {pairs,paired};
}

function intakeKindOf(input){
  const extension=extOf(typeof input==='string'?input:input?.name);
  return extension==='pdf'||POWERPOINT_PLAYER_EXT.has(extension)||LEGACY_POWERPOINT_EXT.has(extension)
    ?'presentation':kindOf(input);
}
function originalDocumentRenderer(file){
  const extension=extOf(file?.name),powerpoint=POWERPOINT_PLAYER_EXT.has(extension);
  if(LEGACY_POWERPOINT_EXT.has(extension))throw Object.assign(new Error(
    'This binary PowerPoint format is not supported by the independent player. Choose an OOXML PowerPoint file (.pptx, .ppsx, .pptm, or .ppsm).'),
    {code:'POWERPOINT_LEGACY_FORMAT'});
  const renderer=powerpoint?window.OpenLivePowerPoint:DOCUMENTS;
  if(typeof renderer?.openPlayer!=='function')throw new Error(
    powerpoint?'The independent PowerPoint player is unavailable in this build.':'The original PDF player is unavailable in this build.');
  return {renderer,format:powerpoint?'PowerPoint':'PDF'};
}
function configurePresentationClip(clip,file,player,format){
  const frame=player?.frame?.(),count=Number(player?.count);
  if(!Number.isSafeInteger(count)||count<1||!(frame?.width>0&&frame?.height>0))
    throw new Error('The original presentation has not produced its first complete slide.');
  Object.assign(clip,{originalSource:file,video:null,poster:null,audio:null,
    sourceReference:clip.sourceReference||sourceReferenceOf(file),
    documentId:[file.name,file.size,file.lastModified].join(':'),documentSourceName:file.name,
    documentPageCount:count,documentFormat:format,nativePresentation:null,
    metadataState:'ready',duration:STILL_TIMELINE_SECONDS,fps:0,hasAudio:false,
    width:frame.width,height:frame.height,mediaKind:'presentation',
    presentation:{title:stripExt(file.name),format,pageCount:count,current:0,player,
      unsupported:player.unsupported||[],
      pages:Array.from({length:count},(_,index)=>({index,name:(format==='PowerPoint'?'Slide ':'Page ')+(index+1),
        title:player.slides?.[index]?.title||(format==='PowerPoint'?'Slide ':'Page ')+(index+1),
        notes:player.slides?.[index]?.notes||'',links:player.slides?.[index]?.links||[],media:player.slides?.[index]?.media||[]}))}});
  clip.sourceReferences=[clip.sourceReference];
  state.sourceFiles.set(clip.id,file);deriveClipBeats(clip);bindPresentationPlayer(clip);
}

async function toClips(found, root, options={}){
  const clips = [], matched=pairAudioSidecars(found,f=>f.rel), pairedLoaded=new Set();
  const rootName=root.name, rootId=root.key;

  /* Build visual Clips first. A sidecar is considered consumed only after it
     was actually readable; if it vanished during the scan it is not allowed to
     make a separate readable Audio file disappear too. */
  for(const f of found){
    if(f.kind === 'audio') continue;
    let file=f.file;
    try { if(!file) file = await f.handle.getFile(); }
    catch(e){ continue; }                                      // vanished or unreadable between walk and now

    const id   = rootId + '/' + f.rel;
    const existing=MEDIA.find(id);
    if(f.kind==='presentation'&&existing?.presentation?.player){clips.push(existing);continue;}
    const name = stripExt(f.rel.split('/').pop());
    const sub  = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
    const playable = true; // final support is decided by browser/native decode, not suffix

    const clip = {
      id, name,
      folder: rootName,
      subfolder: sub,
      source: f.rel,
      poster: null,                                            // filled by the poster queue
      video:  null,
      audio:  null,
      duration: null, beats: null,
      width: null, height: null, fps: null,
      sourceCodec: extOf(f.rel), sourceTag: null,
      /* Video container audio is still being probed. `null` is deliberately
         different from false: a Clip loaded before canplay must stay
         inferable, so a later positive captureStream/audioTracks signal can
         open its Audio branch without reloading the Slot. Images are known
         silent immediately. */
      hasAlpha: false, keyed: false, hasAudio: f.kind === 'image' ? false : null,
      hasVideo: true,
      /* clone-only bookkeeping, ignored by everything in arena-media */
      userMedia: true, rootKey: rootId, aliases: [rootName + '/' + f.rel],
      mediaKind: f.kind,
      bytes: file.size,
      playable,
      unplayableReason: null
    };

    /* clips.htm — an AV clip is a video and an audio file loaded into one slot.
       Same stem, same folder, exactly the pairing rule the bundled AV set uses. */
    if(f.kind==='presentation'){
      let player;
      try{
        const {renderer,format}=originalDocumentRenderer(file);
        player=await renderer.openPlayer(file,{signal:options.signal,onProgress:value=>{
          try{options.onImportProgress?.({...value,file,name:file.name});}catch(_){}
        }});
        if(options.signal?.aborted)throw Object.assign(new Error('Presentation preparation cancelled.'),{name:'AbortError'});
        configurePresentationClip(clip,file,player,format);
      }catch(error){
        player?.release?.();
        options.errors?.push({name:file.name,error,message:String(error?.message||error),code:error?.code||null});
        continue;
      }
    }else await configureVisualClip(clip,file);
    const pair = matched.pairs.get(f);
    if(pair){
      try {
        clip.audio = sourceURL(await pair.handle.getFile());
        clip.hasAudio = true; pairedLoaded.add(pair);
      } catch(e){}
    }
    clips.push(clip);
  }

  /* Resolume accepts Audio as Clip content in its own right. Only the exact
     file successfully consumed as a Video sidecar is omitted here. */
  for(const f of found){
    if(f.kind !== 'audio' || pairedLoaded.has(f)) continue;
    let file=f.file;
    try { if(!file) file=await f.handle.getFile(); } catch(e){ continue; }
    const name=stripExt(f.rel.split('/').pop());
    const sub=f.rel.includes('/') ? f.rel.slice(0,f.rel.lastIndexOf('/')) : '';
    clips.push({
      id:rootId+'/'+f.rel, name, folder:rootName, subfolder:sub, source:f.rel,
      poster:null, video:null, audio:sourceURL(file),
      duration:null, beats:null, width:null, height:null, fps:null,
      sourceCodec:extOf(f.rel), sourceTag:null,
      hasAlpha:false, keyed:false, hasAudio:true, hasVideo:false,
      userMedia:true, rootKey:rootId, aliases:[rootName+'/'+f.rel],
      mediaKind:'audio', bytes:file.size, playable:true,
      unplayableReason:null
    });
  }
  return clips;
}

/* --------------------------------------------------------------------------
   Probe and poster
   --------------------------------------------------------------------------
   One pass per clip gets duration, dimensions and the poster frame together,
   because they all need the same decode. Queued and throttled: kicking off 800
   simultaneous video decodes wedges the tab.
   -------------------------------------------------------------------------- */
function queuePosters(clips){
  for(const c of clips) if(c.playable && !c.nativePresentation && !c.presentation?.player && !c.poster && !c.requiresPrepare && !c.posterCancelled)
    ensurePoster(c);
  /* A Drop handler is a latency-sensitive user gesture. Let the browser paint
     the accepted Slot and return control to pointer input before starting even
     the two bounded metadata decodes. File picker imports use this path too. */
  schedulePosterPump();
}
function settlePosterRequest(clip,value){
  const request=clip&&state.posterRequests.get(clip.id);
  if(!request || request.media!==clip) return;
  state.posterRequests.delete(clip.id);
  request.resolve(value||clip.poster||null);
}
function ensurePoster(ref){
  const clip=ref&&typeof ref==='object'?ref:MEDIA.find(ref);
  if(!clip || !registeredClip(clip) || clip.posterCancelled) return Promise.resolve(null);
  if(clip.presentation?.player) return Promise.resolve(clip.presentation.player.frame());
  if(clip.nativePresentation) return Promise.resolve(clip.poster||null);
  if(clip.poster) return Promise.resolve(clip.poster);
  const pending=state.posterRequests.get(clip.id);
  if(pending && pending.media===clip) return pending.promise;
  let resolve;
  const promise=new Promise(done=>{ resolve=done; });
  state.posterRequests.set(clip.id,{media:clip,promise,resolve});
  if(clip.requiresPrepare && clip.prepareState==='ready' && MEDIA.ensurePoster){
    /* Prepared formats have no browser URL to probe. ArenaMedia performs the
       one source-resolution native frame request and is itself identity-safe. */
    Promise.resolve().then(()=>MEDIA.ensurePoster(clip)).then(value=>{
      if(registeredClip(clip)){ MEDIA.touch(); emit({kind:'clip',id:clip.id}); }
      settlePosterRequest(clip,value);
    },()=>{
      if(registeredClip(clip)){ MEDIA.touch(); emit({kind:'clip',id:clip.id}); }
      settlePosterRequest(clip,null);
    });
    return promise;
  }
  if(clip.requiresPrepare){
    /* loadMediaIntoSlot requests again once ensurePlayable resolves. */
    settlePosterRequest(clip,null);
    return promise;
  }
  state.posterQueue.push(clip);
  /* This rAF -> idle boundary is part of the external-Drop contract: the Slot
     is committed and paintable before its one chosen poster decoder starts. */
  schedulePosterPump();
  return promise;
}
let posterPumpScheduled=false;
function schedulePosterPump(){
  if(posterPumpScheduled) return;
  posterPumpScheduled=true;
  const run=()=>{ posterPumpScheduled=false; pumpPosters(); };
  if(typeof requestAnimationFrame==='function') requestAnimationFrame(()=>{
    if(typeof requestIdleCallback==='function') requestIdleCallback(run,{timeout:120});
    else setTimeout(run,0);
  });
  else if(typeof requestIdleCallback==='function') requestIdleCallback(run,{timeout:120});
  else queueMicrotask(run);
}
function pumpPosters(){
  while(state.posterBusy < POSTER_PARALLEL && state.posterQueue.length){
    const c = state.posterQueue.shift();
    if(c.posterCancelled || !registeredClip(c)){ settlePosterRequest(c,null); continue; }
    state.posterBusy++;
    const run=()=>c.posterCancelled || !registeredClip(c) ? Promise.resolve(null) : probe(c);
    const work=MEDIA.schedulePosterTask ? MEDIA.schedulePosterTask(run) : Promise.resolve().then(run);
    work.then(async()=>{
      /* A browser probe may discover that the container needs the native tier.
         The targeted request then obtains one native frame through ArenaMedia;
         bulk queues never include native-first records. */
      if(!c.poster && c.requiresPrepare && c.prepareState==='ready' && MEDIA.ensurePoster)
        await MEDIA.ensurePoster(c);
      return c.poster||null;
    }).then(value=>{
      state.posterBusy--;
      if(registeredClip(c)){ MEDIA.touch(); emit({kind:'clip',id:c.id}); }
      settlePosterRequest(c,value); pumpPosters();
    },()=>{
      state.posterBusy--;
      if(registeredClip(c)){ MEDIA.touch(); emit({kind:'clip',id:c.id}); }
      settlePosterRequest(c,null); pumpPosters();
    });
  }
}

function probe(clip){
  return clip.mediaKind === 'image' ? probeImage(clip) :
    clip.mediaKind === 'audio' ? probeAudio(clip) : probeVideo(clip);
}
function registeredClip(clip){ return !!clip && MEDIA.find(clip.id)===clip; }

function deriveClipBeats(clip){
  const bpm=(window.ArenaEngine && window.ArenaEngine.bpm && window.ArenaEngine.bpm()) || 120;
  if(clip.duration) clip.beats=Math.max(1,Math.round(clip.duration/(60/bpm)));
}

function applyStillMetadata(clip){
  if(!clip) return clip;
  clip.isStill=true;
  if(!Object.prototype.hasOwnProperty.call(clip,'sourceDuration'))
    clip.sourceDuration=Number.isFinite(+clip.duration) ? +clip.duration : null;
  clip.duration=STILL_TIMELINE_SECONDS;
  clip.hasAudio=false;
  deriveClipBeats(clip);
  return clip;
}

async function imageAlphaCapability(file){
  if(!file || typeof file.slice!=='function') return null;
  const ext=extOf(file.name);
  if(ext==='jpg'||ext==='jpeg') return false;
  if(ext!=='png') return null;
  try {
    const bytes=new Uint8Array(await file.slice(0,Math.min(Number(file.size)||0,256*1024)).arrayBuffer());
    if(bytes.length<29 || bytes[0]!==137 || ascii4(bytes,1)!=='PNG\r') return null;
    const colourType=bytes[25];
    if(colourType===4 || colourType===6) return true;
    /* Palette/RGB PNG can carry transparency in a tRNS chunk. The bounded
       prefix covers normal headers without scanning an arbitrarily large file. */
    for(let off=8;off+12<=bytes.length;){
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const size=view.getUint32(off,false), type=ascii4(bytes,off+4);
      if(type==='tRNS') return true;
      if(!Number.isSafeInteger(size)||size<0||off+12+size>bytes.length) break;
      off+=12+size;
    }
    return false;
  } catch(error){ return null; }
}

/* HTMLMediaElement has no cross-browser `hasAudio` flag. Use only positive,
   browser-supplied evidence and never infer audio from a video extension: that
   would make video-only imports grow a fake Audio track. Firefox exposes
   mozHasAudio; Safari exposes audioTracks; some Chromium builds expose decoded
   byte count after the metadata/seek decode. Unknown remains unknown/false. */
function noteEmbeddedAudio(clip, media){
  let present = false;
  try {
    present = !!(media.audioTracks && media.audioTracks.length) ||
      media.mozHasAudio === true ||
      (typeof media.webkitAudioDecodedByteCount === 'number' &&
       media.webkitAudioDecodedByteCount > 0);
    /* captureStream() is the useful Chromium-shaped signal when audioTracks is
       absent. Merely having the method proves nothing; only a real captured
       audio MediaStreamTrack is accepted. */
    if(!present && typeof media.captureStream === 'function'){
      const stream=media.captureStream();
      present=!!(stream && typeof stream.getAudioTracks === 'function' &&
                 stream.getAudioTracks().length);
    }
  } catch(error){ /* metadata access is optional */ }
  if(present) clip.hasAudio = true;
  return present;
}

function probeImageMetadata(clip, makePoster){
  return new Promise((res, rej) => {
    const img = new Image();
    const release=()=>{
      img.onload=img.onerror=null;
      try { img.src=''; } catch(error){}
    };
    img.onload = async() => {
      if(!registeredClip(clip)){ release(); res(); return; }
      try { validateMediaGeometry(img.naturalWidth,img.naturalHeight,clip.name); }
      catch(error){
        clip.playable=false; clip.unplayableReason=error.message; release(); rej(error); return;
      }
      clip.width = img.naturalWidth; clip.height = img.naturalHeight;
      applyStillMetadata(clip);
      const alpha=await imageAlphaCapability(state.sourceFiles.get(clip.id));
      if(typeof alpha==='boolean'){ clip.hasAlpha=alpha; clip.keyed=alpha; }
      clip.metadataState='ready'; clip.metadataError=null;
      if(!makePoster){ release(); res(clip); return; }
      /* The full-resolution Image is transient here. Retain only a small PNG
         thumbnail; ArenaMedia separately decodes the original on attachment. */
      const w=img.naturalWidth,h=img.naturalHeight,scale=Math.min(1,320/Math.max(w,h));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(w*scale));
      canvas.height=Math.max(1,Math.round(h*scale));
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      canvas.toBlob(blob=>{
        if(registeredClip(clip)&&blob){
          if(typeof clip.poster==='string'&&clip.poster.startsWith('blob:')&&clip.poster!==clip.video)
            try { URL.revokeObjectURL(clip.poster); } catch(error){}
          clip.poster=URL.createObjectURL(blob);
        }
        release(); res(clip);
      },'image/png');
    };
    img.onerror = () => {
      if(!registeredClip(clip)){ release(); res(); return; }
      clip.playable = false; clip.unplayableReason = 'The image could not be decoded.';
      release(); rej();
    };
    img.src = clip.video;
  });
}
function probeImage(clip){ return probeImageMetadata(clip,true); }

function probeAudio(clip){
  return new Promise((res,rej)=>{
    const a=document.createElement('audio');
    a.preload='metadata';
    let done=false;
    const finish=ok=>{
      if(done) return; done=true; clearTimeout(timer);
      a.removeAttribute('src'); try { a.load(); } catch(e){}
      ok ? res() : rej();
    };
    const timer=setTimeout(()=>{
      if(!registeredClip(clip)){ finish(true); return; }
      clip.playable=false;
      clip.unplayableReason='The audio file did not expose decodable metadata.';
      finish(false);
    },8000);
    a.onloadedmetadata=()=>{
      if(!registeredClip(clip)){ finish(true); return; }
      clip.duration=isFinite(a.duration) ? a.duration : null;
      deriveClipBeats(clip);
      clip.metadataState='ready'; clip.metadataError=null;
      /* Audio-only Clips deliberately have no decorative poster. The Audio
         card renders verified waveform data when one exists, otherwise its
         honest empty-waveform state. */
      clip.poster=null;
      finish(true);
    };
    a.onerror=()=>{
      if(!registeredClip(clip)){ finish(true); return; }
      clip.playable=false;
      clip.unplayableReason='The browser refused this audio file: unsupported codec or container.';
      finish(false);
    };
    a.src=clip.audio;
  });
}

function probeVideo(clip){
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    const probeURL=clip.video;
    const current=()=>registeredClip(clip) && clip.video===probeURL && !clip.requiresPrepare;
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    let done = false;
    const finish = ok => {
      if(done) return; done = true;
      clearTimeout(timer);
      v.onloadedmetadata=v.oncanplay=v.onseeked=v.onerror=null;
      v.removeAttribute('src'); try { v.load(); } catch(e){}
      if(!current()){ res(); return; }
      if(ok){
        if(clip.hasAudio == null) clip.hasAudio = false;
        clip.metadataState='ready'; clip.metadataError=null;
      }
      ok ? res() : rej();
    };
    const nativeFallback = reason => {
      if(done) return;
      /* Stop the failed browser decoder before switching the registered record.
         A playing layer observes the source revision on its next frame and
         automatically attaches the native source when preparation completes. */
      done=true; clearTimeout(timer);
      v.onloadedmetadata=v.oncanplay=v.onseeked=v.onerror=null;
      v.removeAttribute('src'); try { v.load(); } catch(e){}
      if(!registeredClip(clip)){ res(); return; }
      if(!current() && !clip.requiresPrepare){ res(); return; }
      fallbackToNative(clip,reason,{expectedURL:probeURL}).then(()=>res(),err=>rej(err));
    };
    /* Metadata can arrive for an unsupported codec without a decoded frame.
       Codec-routed DXV never enters this probe; the timeout catches remaining
       unsupported containers instead of letting them trigger to black. */
    const timer = setTimeout(() => {
      /* Metadata dimensions do not prove that a decoder produced a frame. */
      nativeFallback('The browser opened the container but decoded no video frame.');
    }, 8000);

    v.onloadedmetadata = () => {
      if(!current()){ finish(true); return; }
      noteEmbeddedAudio(clip,v);
      clip.duration = isFinite(v.duration) ? v.duration : null;
      try { applyBrowserDecodedGeometry(clip,v); }
      catch(error){ nativeFallback(error.message); return; }
      /* bpm.htm — Arena stores a beat length per clip. Nothing on disk carries
         one, so derive it from the composition tempo the user is actually
         running rather than inventing 120. */
      deriveClipBeats(clip);
      /* Seek a little way in: frame 0 of a lot of footage is black. */
      try { v.currentTime = Math.min(1, (clip.duration || 1) * 0.1); }
      catch(e){ nativeFallback('The browser could not seek or decode this video.'); }
    };
    /* Some engines populate captureStream/audioTracks only after decoders are
       ready. A late positive updates the same registered media record; it does
       not delay video poster generation or invent a negative result. */
    v.oncanplay = () => { if(current()) noteEmbeddedAudio(clip,v); };
    v.onseeked = () => {
      try {
        if(!current()){ finish(true); return; }
        noteEmbeddedAudio(clip,v);
        const w = v.videoWidth, h = v.videoHeight;
        if(!w || !h) return nativeFallback('The browser produced no video dimensions.');
        const scale = Math.min(1, 320 / w);
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * scale));
        cv.height = Math.max(1, Math.round(h * scale));
        const cx=cv.getContext('2d');
        cx.drawImage(v, 0, 0, cv.width, cv.height);
        /* A browser-decoded frame is the authoritative alpha truth for formats
           such as VP9 WebM where HTMLMediaElement exposes no codec descriptor.
           This bounded thumbnail read happens once during poster work, never
           in the render loop or while a direct external Drop is mounting. */
        try {
          const pixels=cx.getImageData(0,0,cv.width,cv.height).data;
          for(let i=3;i<pixels.length;i+=4) if(pixels[i]!==255){
            clip.hasAlpha=true; clip.keyed=true; break;
          }
        } catch(error){ /* local Blob media is readable; preserve unknown if not */ }
        cv.toBlob(b => {
          if(!current()){ finish(true); return; }
          if(b) clip.poster = URL.createObjectURL(b);
          finish(true);
        }, 'image/jpeg', 0.72);
      } catch(e){ nativeFallback('The browser failed while decoding a video frame.'); }
    };
    v.onerror = () => {
      nativeFallback('The browser does not support this codec or container.');
    };
    v.src = probeURL;
  });
}

/* --------------------------------------------------------------------------
   Roots
   -------------------------------------------------------------------------- */
function rootKey(){ return runtimeKey('media-root'); }

function captureClips(clips, capture){
  if(!capture) return;
  for(const clip of clips){
    const registered=MEDIA.find(clip.id);
    if(registered && !capture.some(item=>item.id===registered.id)) capture.push(registered);
  }
}

async function scanInto(root, capture, options={}){
  root.status = 'scanning';
  emit({kind:'library'});
  const found = root.nativeFiles ? root.nativeFiles.slice() : [];
  try { if(!root.nativeFiles) await walk(root.handle, root.name, '', found, 0); }
  catch(e){ root.status = 'error'; root.error = String(e && e.message || e); emit({kind:'library'}); return 0; }

  const errors=[],clips = await toClips(found, root,{...options,errors});
  options.errors?.push(...errors);
  const added = MEDIA.register(clips, root.name);
  captureClips(clips,capture);
  root.count = clips.length;
  root.truncated = root.truncated || found.length >= MAX_FILES;
  root.status = errors.length?'error':'ready';
  root.error=errors.length?errors.map(value=>value.message).join('\n'):null;
  queuePosters(clips);
  emit({kind:'library'});
  return added;
}

async function addRoot(){
  const selected=await selectLocalMedia('folder');
  if(selected){
    if(!selected.folder) return null;
    const previous=state.roots.find(root=>root.nativePath===selected.folder);
    const root=previous||{key:rootKey(),name:selected.name||'Media',count:0,status:'new'};
    root.nativePath=selected.folder;
    root.nativeFiles=selected.files.map(record=>{
      const file=originalFile(record);
      return {file,handle:{getFile:async()=>file},rel:record.relativePath,kind:intakeKindOf(file)};
    }).filter(entry=>entry.kind);
    root.truncated=!!selected.truncated;
    if(!previous) state.roots.push(root);
    await scanInto(root);
    return root;
  }
  if(!supported()) throw new Error('This browser has no directory picker.');
  const handle = await window.showDirectoryPicker({ mode: 'read', id: 'openlive-media' });
  const name = handle.name || 'Media';
  if(state.roots.some(r => r.name === name)) {
    /* Same display name, possibly a different folder. isSameEntry is the only
       honest test, and it is async. */
    for(const r of state.roots) if(await r.handle.isSameEntry(handle)) { await scanInto(r); return r; }
  }
  const root = { key: rootKey(), name, handle, count: 0, status: 'new' };
  state.roots.push(root);
  /* Retain the readable folder capability for this page only. */
  try { await dbPut({ key: root.key, name, handle }); }
  catch(e){ root.persistenceError=String(e&&e.message||e); }
  await scanInto(root);
  return root;
}

async function removeRoot(name){
  const i = state.roots.findIndex(r => r.name === name);
  if(i < 0) return false;
  const root = state.roots[i];
  state.roots.splice(i, 1);
  /* Cancel queued poster work before unregistering. An in-flight browser probe
     already checks registeredClip() before committing; queued work should not
     open a decoder at all after its root is gone. */
  for(const clip of MEDIA.inFolder(name)){
    clip.posterCancelled=true;
    settlePosterRequest(clip,null);
  }
  state.posterQueue=state.posterQueue.filter(clip=>clip.folder!==name);
  const tier=window.OpenLiveDXV;
  if(tier && typeof tier.releaseFile==='function')
    MEDIA.inFolder(name).forEach(clip=>{ if(clip.prepareKey) tier.releaseFile(clip.prepareKey); });
  MEDIA.unregister(name);
  for(const id of state.sourceFiles.keys()) if(id.startsWith(root.key+'/')) state.sourceFiles.delete(id);
  try { await dbDel(root.key); } catch(e){}
  emit({kind:'library'});
  return true;
}

/* A fresh page always starts with an empty media library. */
async function restore(){ return state.roots.slice(); }

/* Must be called from inside a user gesture. */
async function reconnect(){
  let n = 0;
  for(const root of state.roots){
    if(root.status !== 'needs-permission' && root.status !== 'error') continue;
    try {
      const p = await root.handle.requestPermission({ mode: 'read' });
      if(p === 'granted'){ await scanInto(root); n++; }
    } catch(e){ root.status = 'error'; root.error = String(e && e.message || e); }
  }
  emit({kind:'library'});
  return n;
}

/* --------------------------------------------------------------------------
   Loose files — the picker and the drop target
   -------------------------------------------------------------------------- */
const LOOSE = 'Imported';

/* Return original capabilities without indexing or opening their media. Clip
   Slot pickers use this to retain native PowerPoint paths at selection time. */
async function selectOriginalFiles(){
  const selected=await selectLocalMedia('files');
  return selected ? (selected.files||[]).map(record=>originalFile(record)) : null;
}

async function addFiles(){
  const selected=await selectLocalMedia('files');
  if(selected) return ingestFiles(selected.files.map(record=>originalFile(record)));
  /* Individual file handles do not provide persistence or an absolute path,
     so the native File System picker adds no capability here. A real input is
     supported by every browser and keeps automated/local accessibility paths
     identical to the operator's click path. */
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.accept = ['video/*','audio/*','image/*','application/pdf',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'].concat(
      ['pdf','ppt','pptx','pps','ppsx','pptm','ppsm'].map(e=>'.'+e),
      VIDEO_EXT.concat(IMAGE_EXT,AUDIO_EXT).map(e=>'.'+e)).join(',');
    inp.style.position='fixed'; inp.style.left='-10000px';
    document.body.appendChild(inp);
    const finish=value=>{ inp.remove(); res(value); };
    inp.onchange = () => finish(ingestFiles([...inp.files]));
    inp.oncancel = () => finish(0);
    inp.click();
  });
}

async function ingestFiles(files, capture, options){
  options=options||{};
  files=Array.from(files||[]);
  const expanded=[], errors=Array.isArray(options.errors)?options.errors:[];
  const preparedClips=new Set(),preparedPlayers=new Set();
  const checkCancelled=()=>{if(options.signal?.aborted)throw Object.assign(new Error('File import cancelled. Nothing pending was added.'),{name:'AbortError'});};
  const releasePlayer=player=>{if(!player)return;preparedPlayers.delete(player);try{player.release?.();}catch(error){}};
  // Cancellation owns only this intake's unregistered records. Existing loose
  // clips, reused source capabilities and successfully registered media retain
  // their URLs and players; unregistering the whole Imported folder is unsafe.
  const releasePending=()=>{
    const admittedPlayers=new Set(),urls=new Set();
    for(const clip of preparedClips){
      if(MEDIA.find(clip.id)===clip){if(clip.presentation?.player)admittedPlayers.add(clip.presentation.player);continue;}
      try{clip._presentationUnsubscribe?.();}catch(error){}clip._presentationUnsubscribe=null;
      state.sourceFiles.delete(clip.id);
      for(const value of [clip.video,clip.audio,clip.poster])if(typeof value==='string'&&value.startsWith('blob:'))urls.add(value);
    }
    for(const url of urls)try{URL.revokeObjectURL(url);}catch(error){}
    for(const player of preparedPlayers)if(!admittedPlayers.has(player))releasePlayer(player);
  };
  const progress=(file,index,value)=>{
    if(typeof options.onImportProgress!=='function') return;
    const loaded=Number(value.loaded), total=Number(value.total);
    const percent=value.percent===null ? null : Number.isFinite(Number(value.percent))
      ? Math.max(0,Math.min(100,Number(value.percent)))
      : Number.isFinite(loaded)&&Number.isFinite(total)&&total>0 ? Math.max(0,Math.min(100,loaded/total*100)) : null;
    try { options.onImportProgress({...value,name:String(file&&file.name||'File'),file,index,
      totalFiles:files.length,percent}); } catch(error) {}
  };
  const failed=(file,error)=>{
    errors.push({name:String(file&&file.name||'File'),error,
      message:String(error&&error.message||error),status:Number(error&&error.status)||null,
      code:error&&error.code||null});
    progress(file,files.indexOf(file),{stage:'error',loaded:0,total:0,unit:'files',percent:null,
      message:String(error&&error.message||error)});
  };
  try{
  checkCancelled();
  for(let index=0;index<files.length;index++){
    const input=files[index];
    try {
      checkCancelled();
      let file=input, reason=null;
      const extension=extOf(file.name),powerpoint=POWERPOINT_PLAYER_EXT.has(extension);
      if(LEGACY_POWERPOINT_EXT.has(extension))throw Object.assign(new Error(
        'This binary PowerPoint format is not supported by the independent player. Choose an OOXML PowerPoint file (.pptx, .ppsx, .pptm, or .ppsm).'),
        {code:'POWERPOINT_LEGACY_FORMAT'});
      const isDocument=powerpoint || DOCUMENTS && DOCUMENTS.isDocument(file);
      const kind=powerpoint?'presentation':kindOf(file);
      if(!isDocument&&!kind) continue;
      progress(input,index,{stage:'reference',loaded:0,total:0,unit:'bytes',percent:null,
        message:file._openlivePath?'Linking original file':'Linking source file'});
      if((!powerpoint||typeof window.OpenLiveDesktop?.resolveOriginal==='function') &&
         options.resolveOriginal===true && !file.presentationPages){
        try { file=await resolveOriginal(file,value=>progress(input,index,value)); }
        catch(error){
          // The browser's File still reads the original without a saved copy.
          // Keep healthy browser media usable when Explorer cannot expose a path.
          reason=String(error&&error.message||error);
        }
      }
      checkCancelled();
      const reference=sourceReferenceOf(file,reason);
      progress(input,index,{stage:'linked',loaded:1,total:1,unit:'files',percent:100,
        reference,message:reference.matchedExistingPath?'Matching existing file linked':reference.verified?'Original file linked':'Session file linked'});
      if(isDocument){
          const documentProgress=typeof options.onDocumentProgress==='function'
            ? value=>options.onDocumentProgress({...value,name:input.name,file:input}) : null;
          const {renderer,format}=originalDocumentRenderer(file);
          const reused=await reusableLooseClip(file,'presentation',expanded.map(entry=>({clip:entry.reused,file:entry.file})).filter(entry=>entry.clip));
          checkCancelled();
          if(reused)expanded.push({file,kind:'presentation',input,index,reference,reused});
          else{
            const player=await renderer.openPlayer(file,{signal:options.signal,
              onProgress:value=>progress(input,index,value)});
            preparedPlayers.add(player);checkCancelled();
            documentProgress?.({page:1,total:player.count});
            expanded.push({file,kind:'presentation',input,index,reference,player,format});
          }
      } else expanded.push({file,kind,input,index,reference});
    } catch(error){if(options.signal?.aborted)throw error;failed(input,error);}
  }
  const entries=expanded.filter(entry=>entry.kind);
  const matched=pairAudioSidecars(entries,entry=>entry.file.name), clips=[], accepted=[], pending=[], loadedSidecars=new Set();
  const isSidecar=entry=>entry.kind==='audio'&&matched.paired.has(entry);
  /* Defer only paired Audio: preserve the external drop's ordinary file order,
     and retain a sidecar as its own Clip if the corresponding Video failed. */
  for(const entry of entries.filter(item=>!isSidecar(item)).concat(entries.filter(isSidecar))){
    const {file,kind,input,index,reference,player,format}=entry;
    if(kind==='audio' && loadedSidecars.has(entry)) continue;
    try {
      checkCancelled();
      const playable = true; // browser/native probing supplies the real answer
      const audioOnly=kind==='audio', pair=matched.pairs.get(entry);
      /* Sidecar identity is a two-file contract and is intentionally not folded
         by the single-source reuse key. Standalone and embedded-Audio media can
         reuse the exact retained File without allocating a second blob/row. */
      const reused=entry.reused||(!pair ? await reusableLooseClip(file,kind,pending) : null);
      checkCancelled();
      if(reused){
        releasePlayer(player);
        accepted.push(reused);
        progress(input,index,{stage:'indexed',loaded:1,total:1,unit:'files',percent:100,
          reference:reused.sourceReference,message:'Source linked'});
        continue;
      }
      const original=file.originalSource||file;
      const clip={
        id: runtimeKey('imported-media'), name: stripExt(file.documentSourceName||file.name),
        folder: LOOSE, subfolder: '', source:original._openlivePath||original.name,
        sourceReference:reference,originalSource:original,
        sourceReferences:pair?[reference,pair.reference]:[reference],
        poster: null, video: null,
        audio: audioOnly ? sourceURL(file) : pair ? sourceURL(pair.file) : null,
        duration: null, beats: null, width: null, height: null, fps: null,
        sourceCodec: extOf(file.name), sourceTag: null,
        hasAlpha: false, keyed: false,
        hasAudio: audioOnly || !!pair ? true : (kind==='image'||player) ? false : null,
        hasVideo: !audioOnly,
        userMedia: true, mediaKind: kind, bytes: file.size, playable,
        looseIdentityKey:looseIdentityKey(file,kind),
        documentId:file.documentId||(player?[file.name,file.size,file.lastModified].join(':'):null),
        documentSourceName:file.documentSourceName||(player?file.name:null),
        documentPage:Number(file.documentPage)||null,
        documentPageCount:Number(file.documentPageCount)||(player?player.count:null),
        documentFormat:file.documentFormat||(player?format:null),
        nativePresentation:null,
        metadataState:player?'ready':null,
        presentation:player?{
          title:stripExt(file.name),format,pageCount:player.count,current:0,player,
          unsupported:player.unsupported||[],
          pages:Array.from({length:player.count},(_,index)=>({index,name:(format==='PowerPoint'?'Slide ':'Page ')+(index+1),
            title:player.slides?.[index]?.title||(format==='PowerPoint'?'Slide ':'Page ')+(index+1),
            notes:player.slides?.[index]?.notes||'',links:player.slides?.[index]?.links||[],media:player.slides?.[index]?.media||[]}))
        }:Array.isArray(file.presentationPages)&&file.presentationPages.length ? {
          title:stripExt(file.documentSourceName||file.name),
          format:file.documentFormat||'Presentation',
          pageCount:file.presentationPages.length,
          current:0,
          pages:file.presentationPages.map((page,index)=>({index,name:page.name,file:page,url:null}))
        } : null,
        unplayableReason: null
      };
      preparedClips.add(clip);checkCancelled();
      if(player){
        if(options.signal?.aborted)throw Object.assign(new Error('Presentation preparation cancelled.'),{name:'AbortError'});
        configurePresentationClip(clip,file,player,format);
      }
      else if(!audioOnly) await configureVisualClip(clip,file);
      else state.sourceFiles.set(clip.id,file);
      checkCancelled();
      clips.push(clip); accepted.push(clip); pending.push({clip,file});
      if(pair){
        loadedSidecars.add(pair);
        progress(pair.input,pair.index,{stage:'indexed',loaded:1,total:1,unit:'files',percent:100,
          reference:pair.reference,message:'Audio source linked'});
      }
      progress(input,index,{stage:'indexed',loaded:1,total:1,unit:'files',percent:100,
        reference,message:'Source linked'});
    } catch(error){if(options.signal?.aborted)throw error;releasePlayer(player);failed(input,error);}
  }
  checkCancelled();
  const added = MEDIA.register(clips, LOOSE);
  captureClips(accepted,capture);
  /* A Slot-targeted OS drop needs one record immediately, not a decode storm.
     Its mounted Clip asks ArenaMedia.ensurePoster on demand. Picker/folder
     imports keep background poster generation for their Files rows. */
  if(options.posters!==false) queuePosters([...new Set(accepted)]);
  if(added) emit({kind:'library'});
  const count=new Set(accepted).size;
  return options.details ? {count,clips:[...new Set(accepted)],errors} : count;
  }finally{releasePending();}
}

function presentationInstance(source){
  if(!source||!source.presentation) return source;
  const instance={...source,id:runtimeKey('presentation-clip'),libraryId:source.id,
    sourceRevision:0,presentation:{...source.presentation,current:0,
      pages:source.presentation.pages.map(page=>({...page}))}};
  if(source.presentation.player){
    instance.presentation.player=source.presentation.player.fork();
    instance.presentation.current=instance.presentation.player.state().index;
    bindPresentationPlayer(instance);
  }else{
    instance.presentation.pages[0].url=instance.video;
    instance.poster=instance.video;
  }
  return instance;
}
function bindPresentationPlayer(clip){
  const player=clip.presentation?.player;if(!player)return;
  clip._presentationUnsubscribe=player.subscribe(()=>{
    const frame=player.frame(),value=player.state();
    if(frame){clip.width=frame.width;clip.height=frame.height;}
    clip.presentation.current=Math.max(0,value.index);
    clip.sourceRevision=(Number(clip.sourceRevision)||0)+1;
    MEDIA.touch();emit({kind:'clip',id:clip.id,presentation:true});
  });
}
function presentationFrame(ref,index,options={}){
  const clip=ref&&typeof ref==='object'?ref:MEDIA.find(ref),player=clip?.presentation?.player;
  if(!player)return Promise.resolve(null);
  return index===undefined?Promise.resolve(player.frame()):player.render(index,options);
}
function releasePresentation(ref){
  const clip=ref&&typeof ref==='object'?ref:MEDIA.find(ref);
  clip?._presentationUnsubscribe?.();
  if(clip)clip._presentationUnsubscribe=null;
  return clip?.presentation?.player?.release?.();
}
function presentationSet(ref,index,options={}){
  const clip=ref&&typeof ref==='object'?ref:MEDIA.find(ref);
  const deck=clip&&clip.presentation;
  if(!deck||!Array.isArray(deck.pages)||!deck.pages.length) return false;
  const next=Math.max(0,Math.min(deck.pages.length-1,Math.round(Number(index)||0)));
  if(deck.player)return deck.player.go(next,options).then(()=>true);
  const page=deck.pages[next];
  if(!page.url) page.url=URL.createObjectURL(page.file);
  deck.current=next; clip.video=page.url; clip.poster=page.url;
  clip.sourceRevision=(Number(clip.sourceRevision)||0)+1;
  MEDIA.touch(); emit({kind:'clip',id:clip.id,presentation:true});
  return true;
}

/* Drag a folder or files from Explorer straight onto the deck. Directory
   handles and loose File capabilities remain in memory for this session. */
function entryFile(entry){
  return new Promise(resolve=>{
    try { entry.file(resolve,()=>resolve(null)); }
    catch(e){ resolve(null); }
  });
}
function directoryEntries(entry){
  return new Promise(resolve=>{
    const reader=entry.createReader(), out=[];
    const read=()=>{
      try { reader.readEntries(batch=>{
        if(!batch || !batch.length){ resolve(out); return; }
        out.push(...batch); read();
      },()=>resolve(out)); }
      catch(e){ resolve(out); }
    };
    read();
  });
}
async function filesFromEntry(entry, out){
  if(!entry || out.length>=MAX_FILES) return;
  if(entry.isFile){ const file=await entryFile(entry); if(file) out.push(file); return; }
  if(!entry.isDirectory) return;
  for(const child of await directoryEntries(entry)){
    await filesFromEntry(child,out);
    if(out.length>=MAX_FILES) break;
  }
}

async function ingestDataTransfer(dt, opts){
  opts=opts||{};
  const items = [...(dt.items || [])];
  const fallbackFiles=[...(dt.files||[])];
  const files = [], dirs = [], legacyEntries=[];
  /* Chromium only guarantees access to drag-item capabilities during the Drop
     event. Capture every handle/entry/file synchronously, then await them. The
     old sequential loop could lose item two while it was awaiting item one. */
  const captured=items.filter(it=>it.kind==='file').map(it=>{
    let handle=null, entry=null, file=null;
    try { if(typeof it.getAsFileSystemHandle==='function') handle=Promise.resolve(it.getAsFileSystemHandle()).catch(()=>null); }
    catch(e){ handle=Promise.resolve(null); }
    try { if(typeof it.webkitGetAsEntry==='function') entry=it.webkitGetAsEntry(); }
    catch(e){}
    try { file=it.getAsFile(); } catch(e){}
    return {handle,entry,file};
  });
  for(const item of captured){
    const h=item.handle ? await item.handle : null;
    if(h && h.kind==='directory'){ dirs.push(h); continue; }
    if(h && h.kind==='file'){
      // Electron's isolated preload can recover the OS path from the actual
      // drag File. Preserve it instead of creating a replacement handle File.
      if(item.file&&typeof window.OpenLiveDesktop?.resolveOriginal==='function'){
        files.push(item.file);continue;
      }
      try { files.push(await h.getFile()); } catch(e){}
      continue;
    }
    if(item.entry && item.entry.isDirectory){ legacyEntries.push(item.entry); continue; }
    if(item.file) files.push(item.file);
  }
  for(const entry of legacyEntries) await filesFromEntry(entry,files);
  /* Some WebViews expose DataTransfer.files but not DataTransfer.items. Capture
     that ordinary external-file path too, without duplicating item files. */
  const seen=new Set(files.map(file=>[file.name,file.size,file.lastModified].join('|')));
  for(const file of fallbackFiles){
    const key=[file.name,file.size,file.lastModified].join('|');
    if(!seen.has(key)){ seen.add(key); files.push(file); }
  }
  let n = 0;
  const imported=[], errors=Array.isArray(opts.errors)?opts.errors:[];
  for(const handle of dirs){
    const name = handle.name || 'Media';
    let existing=null;
    for(const root of state.roots){
      if(!root.handle || typeof root.handle.isSameEntry!=='function') continue;
      try { if(await root.handle.isSameEntry(handle)){ existing=root; break; } } catch(e){}
    }
    if(existing){ n += await scanInto(existing,imported,{...opts,errors}); continue; }
    const root = { key: rootKey(), name, handle, count: 0, status: 'new' };
    state.roots.push(root);
    try { await dbPut({ key: root.key, name, handle }); } catch(e){}
    n += await scanInto(root,imported,{...opts,errors});
  }
  if(files.length) n += await ingestFiles(files,imported,{posters:opts.posters!==false,
    resolveOriginal:true,onDocumentProgress:opts.onDocumentProgress,
    onImportProgress:opts.onImportProgress,signal:opts.signal,errors});
  return opts.details ? {count:n,clips:imported,errors} : n;
}

window.ArenaFiles = {
  supported, restore, reconnect, addRoot, removeRoot, addFiles,
  ingestFiles, ingestDataTransfer, resolveOriginal, refreshOriginal, selectOriginalFiles, ensureMetadata, ensurePoster, fallbackToNative,
  presentationInstance, presentationSet, presentationFrame, releasePresentation,
  persistImage, forgetImage, persistLUT,
  image: id => state.images.get(String(id || '')) || null,
  lut: id => state.luts.get(String(id || '')) || null,
  roots: () => state.roots.map(r => ({ name: r.name, count: r.count, status: r.status, error: r.error || null, truncated: !!r.truncated })),
  needsPermission: () => state.roots.some(r => r.status === 'needs-permission'),
  onChange: fn => { state.listeners.push(fn); },
  LOOSE,
  probeQuickTimeFile,
  _state: state
};

if(typeof BroadcastChannel==='function'){
  const documentChannel=new BroadcastChannel('openlive-documents');
  documentChannel.onmessage=event=>{
    const message=event.data||{};
    if(message.type==='original-document'){
      if(!message.file||!DOCUMENTS?.isDocument(message.file))return;
      ingestFiles([message.file],null,{resolveOriginal:true}).catch(error=>console.error('Original document transfer failed:',error));
      return;
    }
  };
}
})();
