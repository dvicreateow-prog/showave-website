/* OpenLive original document players.
   PDF.js renders requested pages directly to runtime canvases with a bounded
   cache. OOXML PowerPoint is read by the independent browser player directly.
   No playback route saves document copies or creates converted page Clips.
   The older prepared-page helpers remain for compatibility with legacy callers;
   new Show, Broadcast and document-tool intake uses openPlayer. */
window.OpenLiveDocuments = (() => {
  'use strict';

  const PDF_EXT = new Set(['pdf']);
  const POWERPOINT_EXT = new Set(['ppt','pptx','pps','ppsx','pptm','ppsm']);
  const POWERPOINT_PLAYER_EXT = new Set(['pptx','ppsx','pptm','ppsm']);
  const MAX_PAGES = 200;
  const TARGET_LONG_EDGE = 1920;
  const PLAYER_CACHE_LIMIT = 3;
  let pdfjsPromise = null;

  const extOf = name => {
    const match = /\.([^.]+)$/.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
  };
  const stemOf = name => String(name || 'Document').replace(/\.[^.]+$/, '');
  const isDocument = input => {
    const ext = extOf(input && typeof input === 'object' ? input.name : input);
    return PDF_EXT.has(ext) || POWERPOINT_EXT.has(ext);
  };
  const isPowerPoint = input => POWERPOINT_EXT.has(extOf(
    input && typeof input === 'object' ? input.name : input));
  const documentId = file => [file.name, file.size, file.lastModified].join(':');

  function tagPage(file, source, page, total, format) {
    const facts = {
      documentId: documentId(source), documentSourceName: source.name,
      documentPage: page, documentPageCount: total, documentFormat: format
    };
    for (const [key, value] of Object.entries(facts))
      Object.defineProperty(file, key, {value, enumerable:true, configurable:true});
    return file;
  }

  function pdfAssetUrl(path) {
    // PDF.js fetches auxiliary assets from its worker. Relative options would
    // resolve against pdf.worker.mjs, duplicating the vendor/pdfjs directory.
    return new URL(`./vendor/pdfjs/${path}`, document.baseURI).href;
  }

  function pdfjs() {
    if (!pdfjsPromise) pdfjsPromise = import(pdfAssetUrl('pdf.mjs')).then(mod => {
      mod.GlobalWorkerOptions.workerSrc = pdfAssetUrl('pdf.worker.mjs');
      return mod;
    }).catch(error => {
      pdfjsPromise=null;
      throw error;
    });
    return pdfjsPromise;
  }

  /* A PDF stays a PDF. The renderer retains its original read capability and
     prepares only a requested page; it never makes page Files or a cover Clip.
     Independent views share one PDF.js document and a bounded canvas cache. */
  async function openPlayer(file, options={}) {
    const extension=extOf(file&&file.name);
    if(extension==='ppt'||extension==='pps')throw Object.assign(new Error(
      'This binary PowerPoint format is not supported by the independent player. Choose an OOXML PowerPoint file (.pptx, .ppsx, .pptm, or .ppsm).'),
      {code:'POWERPOINT_LEGACY_FORMAT'});
    if(POWERPOINT_PLAYER_EXT.has(extension)){
      if(typeof window.OpenLivePowerPoint?.openPlayer!=='function')throw new Error('The independent PowerPoint player is unavailable in this build.');
      return window.OpenLivePowerPoint.openPlayer(file,options);
    }
    if(!file || extOf(file.name)!=='pdf') throw new Error('Choose an original PDF.');
    const signal=options.signal, pageDocument=options.document||document;
    const cancelled=()=>Object.assign(new Error('PDF player preparation cancelled.'),{name:'AbortError'});
    const check=()=>{if(signal?.aborted)throw cancelled();};
    const report=value=>{try{options.onProgress?.(value);}catch(_){}};
    check();
    const size=Number(file.size);
    if(!Number.isSafeInteger(size)||size<0)throw new Error('The original PDF reported an invalid size.');
    if(size>256*1024*1024)throw Object.assign(new Error(
      'Choose a PDF up to 256 MB. Split or reduce this PDF before importing it.'),{code:'PDF_SIZE_LIMIT'});
    const lib=options.pdfjs||await pdfjs();check();
    report({stage:'read',loaded:0,total:size,unit:'bytes',percent:0,message:'Reading original PDF'});
    check();
    const data=new Uint8Array(size),chunkBytes=1024*1024;
    for(let offset=0;offset<size;offset+=chunkBytes){
      check();const end=Math.min(size,offset+chunkBytes);
      const chunk=new Uint8Array(await file.slice(offset,end).arrayBuffer());check();
      if(chunk.byteLength!==end-offset)throw new Error('The PDF changed while it was being read.');
      data.set(chunk,offset);
      report({stage:'read',loaded:end,total:size,unit:'bytes',percent:size?end/size*100:null,message:'Reading original PDF'});
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    check();
    report({stage:'document',loaded:0,total:0,unit:'pages',percent:null,message:'Opening PDF player'});
    check();
    const task=lib.getDocument({data,useSystemFonts:true,
      cMapUrl:pdfAssetUrl('cmaps/'),cMapPacked:true,
      standardFontDataUrl:pdfAssetUrl('standard_fonts/'),wasmUrl:pdfAssetUrl('wasm/')});
    let pdf=null,closed=false,refs=0,tail=Promise.resolve(),renderTask=null,destroyPromise=null;
    const cache=new Map();
    const destroy=()=>{
      if(closed)return destroyPromise;closed=true;
      try{renderTask?.cancel?.();}catch(_){}
      for(const canvas of cache.values())canvas.width=canvas.height=1;cache.clear();
      destroyPromise=Promise.resolve().then(async()=>{
        try{await pdf?.cleanup?.();}catch(_){}
        try{await task.destroy?.();}catch(_){}
      });return destroyPromise;
    };
    const abort=()=>destroy();signal?.addEventListener('abort',abort,{once:true});
    try{
      pdf=await task.promise;check();
      if(closed)throw cancelled();
      if(!Number.isInteger(pdf.numPages)||pdf.numPages<1)throw new Error('This PDF contains no pages.');
      if(pdf.numPages>MAX_PAGES)throw new Error(`This PDF has ${pdf.numPages} pages; the live player limit is ${MAX_PAGES}. Split it before importing.`);
      const asset={
        count:pdf.numPages,originalSource:file,
        retain(){if(closed)throw cancelled();refs++;},
        release(){if(refs>0)refs--;if(!refs)return destroy();},
        render(index,settings={}){
          if(!Number.isInteger(index)||index<0||index>=asset.count)return Promise.reject(new Error('Choose a page in this PDF.'));
          const current=()=>!closed&&!settings.signal?.aborted&&(!settings.isCurrent||settings.isCurrent());
          const work=tail.catch(()=>{}).then(async()=>{
            if(!current())throw cancelled();
            if(cache.has(index)){const hit=cache.get(index);cache.delete(index);cache.set(index,hit);return hit;}
            const page=await pdf.getPage(index+1);if(!current()){try{page.cleanup?.();}catch(_){}throw cancelled();}
            const canvas=pageDocument.createElement('canvas');let cached=false;
            try{
              const unit=page.getViewport({scale:1});
              const scale=Math.min(3,TARGET_LONG_EDGE/Math.max(unit.width,unit.height));
              const viewport=page.getViewport({scale});
              canvas.width=Math.max(1,Math.round(viewport.width));canvas.height=Math.max(1,Math.round(viewport.height));
              const context=canvas.getContext('2d',{alpha:false});
              if(!context)throw new Error('PDF playback needs a browser canvas.');
              context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
              renderTask=page.render({canvasContext:context,viewport,background:'#fff'});
              const cancelRender=()=>{try{renderTask?.cancel?.();}catch(_){}};
              settings.signal?.addEventListener('abort',cancelRender,{once:true});
              try{await renderTask.promise;}finally{settings.signal?.removeEventListener('abort',cancelRender);renderTask=null;}
              if(!current())throw cancelled();
              cache.set(index,canvas);cached=true;
              while(cache.size>PLAYER_CACHE_LIMIT){const key=cache.keys().next().value;const old=cache.get(key);cache.delete(key);old.width=old.height=1;}
              return canvas;
            }finally{
              if(!cached)canvas.width=canvas.height=1;
              try{page.cleanup?.();}catch(_){}
            }
          });tail=work;return work;
        },
        diagnostics:()=>({closed,refs,cacheSize:cache.size,cacheLimit:PLAYER_CACHE_LIMIT})
      };
      function view(seed){
        asset.retain();
        let released=false,holds=1,index=seed?.index??-1,busy=false,error='',revision=0,serial=0,ready=!!seed?.frame;
        const listeners=new Set(),el=pageDocument.createElement('canvas');el.width=el.height=1;
        const draw=frame=>{
          const context=el.getContext('2d',{alpha:false});if(!context)throw new Error('PDF playback needs a browser canvas.');
          el.width=frame.width;el.height=frame.height;context.drawImage(frame,0,0,frame.width,frame.height);
        };
        try{if(seed?.frame)draw(seed.frame);}catch(reason){asset.release();throw reason;}
        const emit=()=>{for(const callback of listeners)try{callback();}catch(_){}};
        const state=()=>({index,count:asset.count,busy,error,revision,disposed:released,ready,kind:'pdf'});
        const release=()=>{
          if(released)return;holds--;if(holds>0)return;
          released=true;serial++;busy=false;ready=false;revision++;emit();listeners.clear();el.width=el.height=1;return asset.release();
        };
        const player={kind:'pdf',originalSource:file,el,count:asset.count,
          state,frame:()=>!released&&ready?el:null,
          async go(target,settings={}){
            if(released)throw cancelled();
            if(!Number.isInteger(target)||target<0||target>=asset.count)throw new Error('Choose a page in this PDF.');
            if(settings.signal?.aborted||settings.isCurrent&&!settings.isCurrent())throw cancelled();
            const operation=++serial;busy=true;error='';revision++;emit();
            const owns=()=>!released&&serial===operation;
            const current=()=>owns()&&!settings.signal?.aborted&&(!settings.isCurrent||settings.isCurrent());
            try{
              const frame=await asset.render(target,{isCurrent:current,signal:settings.signal});
              if(!current())throw cancelled();draw(frame);index=target;ready=true;return state();
            }catch(reason){if(owns())error=reason.message||String(reason);throw reason;}
            finally{if(owns()){busy=false;revision++;emit();}}
          },
          render:(target,settings={})=>asset.render(target,{...settings,
            isCurrent:()=>!released&&(!settings.isCurrent||settings.isCurrent())}),
          step:delta=>player.go(Math.max(0,Math.min(asset.count-1,Math.max(0,index)+Number(delta)))),
          first:()=>player.go(0),last:()=>player.go(asset.count-1),
          subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);},
          fork(){if(released)throw cancelled();return view({index,frame:player.frame()});},
          retain(){if(released)throw cancelled();holds++;return player;},release,dispose:release,
          diagnostics:()=>({...asset.diagnostics(),holds}),
          get revision(){return revision;}
        };return player;
      }
      const player=view();
      report({stage:'frame',loaded:0,total:1,unit:'frames',percent:null,message:'Preparing the first PDF page'});
      try{await player.go(0);check();if(closed)throw cancelled();}
      catch(reason){await player.release();throw reason;}
      report({stage:'ready',loaded:1,total:1,unit:'frames',percent:100,message:'PDF player ready'});
      return player;
    }catch(reason){await destroy();if(signal?.aborted)throw cancelled();throw reason;}
    finally{signal?.removeEventListener('abort',abort);}
  }

  async function renderPdf(file, onProgress, onImportProgress, options={}) {
    const signal=options.signal, pageDocument=options.document||document;
    const cancelled=()=>Object.assign(new Error('PDF preparation cancelled.'),{name:'AbortError'});
    const check=()=>{if(signal?.aborted)throw cancelled();};
    const report=value=>{
      if(typeof onImportProgress==='function') {
        try { onImportProgress(value); } catch(error) {}
      }
    };
    check();
    const size=Number(file.size);
    if(!Number.isSafeInteger(size)||size<0)throw new Error('The original PDF reported an invalid size.');
    if(size>256*1024*1024)throw Object.assign(new Error(
      'Choose a PDF up to 256 MB. Split or reduce this PDF before importing it.'),{code:'PDF_SIZE_LIMIT'});
    report({stage:'read',loaded:0,total:size,unit:'bytes',percent:0,
      message:'Reading PDF'});
    check();const lib = await pdfjs();check();
    let data;
    if(typeof file.slice==='function'){
      // PDF.js needs document bytes. Read the original in measured chunks into
      // one runtime buffer; never write a PDF copy or intermediate image files.
      data=new Uint8Array(size);
      const chunkBytes=1024*1024;
      for(let offset=0;offset<size;offset+=chunkBytes){
        check();
        const end=Math.min(size,offset+chunkBytes);
        const chunk=new Uint8Array(await file.slice(offset,end).arrayBuffer());
        check();
        if(chunk.byteLength!==end-offset) throw new Error('The PDF changed while it was being read.');
        data.set(chunk,offset);
        report({stage:'read',loaded:end,total:size,unit:'bytes',percent:size?end/size*100:null,
          message:'Reading PDF'});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }else{
      const buffer=await file.arrayBuffer();
      check();
      if(buffer.byteLength!==size)throw new Error('The PDF changed while it was being read.');
      data=new Uint8Array(buffer);
      report({stage:'read',loaded:data.byteLength,total:data.byteLength,unit:'bytes',percent:100,
        message:'PDF read'});
    }
    check();
    report({stage:'document',loaded:0,total:0,unit:'pages',percent:null,
      message:'Opening PDF'});
    check();const task = lib.getDocument({
      data, useSystemFonts:true,
      cMapUrl:pdfAssetUrl('cmaps/'), cMapPacked:true,
      standardFontDataUrl:pdfAssetUrl('standard_fonts/'),
      wasmUrl:pdfAssetUrl('wasm/')
    });
    let doc=null,renderTask=null,destroyPromise=null;
    const destroy=()=>{
      if(!destroyPromise&&typeof task.destroy==='function')
        destroyPromise=Promise.resolve().then(()=>task.destroy()).catch(()=>{});
      return destroyPromise;
    };
    const abort=()=>{try{renderTask?.cancel?.();}catch(_){}destroy();};
    signal?.addEventListener('abort',abort,{once:true});
    try {
      check();
      doc=await task.promise;
      check();
      if (doc.numPages > MAX_PAGES)
        throw new Error(`This PDF has ${doc.numPages} pages; the live preparation limit is ${MAX_PAGES}. Split it before importing.`);
      if (!doc.numPages) throw new Error('This PDF contains no pages.');
      const pages = [];
      if (onProgress) onProgress({page:0, total:doc.numPages});
      report({stage:'render',loaded:0,total:doc.numPages,unit:'pages',percent:0,
        message:'Preparing PDF pages'});
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        check();
        const page = await doc.getPage(pageNumber);
        check();const canvas = pageDocument.createElement('canvas');
        try {
          const unit = page.getViewport({scale:1});
          const scale = Math.min(3, TARGET_LONG_EDGE / Math.max(unit.width, unit.height));
          const viewport = page.getViewport({scale});
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext('2d', {alpha:false});
          if (!context) throw new Error('PDF page rendering needs a browser canvas.');
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          renderTask=page.render({canvasContext:context, viewport, background:'#fff'});
          await renderTask.promise;renderTask=null;check();
          const blob = await new Promise((resolve, reject) => canvas.toBlob(
            value => value ? resolve(value) : reject(new Error('PDF page encoding failed.')), 'image/png'));
          check();
          const suffix = String(pageNumber).padStart(String(doc.numPages).length, '0');
          pages.push(tagPage(new File([blob], `${stemOf(file.name)} - Page ${suffix}.png`, {
            type:'image/png', lastModified:file.lastModified
          }), file, pageNumber, doc.numPages, 'PDF'));
        } finally {
          renderTask=null;
          if (typeof page.cleanup === 'function') {
            try { page.cleanup(); } catch(error) {}
          }
          canvas.width = canvas.height = 1;
        }
        if (onProgress) onProgress({page:pageNumber, total:doc.numPages});
        report({stage:'render',loaded:pageNumber,total:doc.numPages,unit:'pages',
          percent:pageNumber/doc.numPages*100,message:`Preparing PDF page ${pageNumber} of ${doc.numPages}`});
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      check();
      return pages;
    } catch(error) {
      if(signal?.aborted)throw cancelled();
      throw error;
    } finally {
      signal?.removeEventListener('abort',abort);
      /* Always release the PDF worker, including malformed documents, page
         limits and render failures. Teardown must not replace the useful
         preparation error or discard slides which were already completed. */
      if (doc && typeof doc.cleanup === 'function') {
        try { await doc.cleanup(); } catch(error) {}
      }
      await destroy();
    }
  }

  async function renderPowerPoint(file, onProgress) {
    if(['ppt','pps'].includes(extOf(file&&file.name)))throw Object.assign(new Error(
      'This binary PowerPoint format is not supported by the independent player. Choose an OOXML PowerPoint file (.pptx, .ppsx, .pptm, or .ppsm).'),
      {code:'POWERPOINT_LEGACY_FORMAT'});
    throw Object.assign(new Error('PowerPoint plays from its original file. Use OpenLiveDocuments.openPlayer; converting it into page Files is disabled.'),
      {code:'POWERPOINT_PLAYER_REQUIRED'});
  }

  async function prepare(file, onProgress, onImportProgress, options={}) {
    const ext = extOf(file && file.name);
    if (PDF_EXT.has(ext)) return renderPdf(file, onProgress, onImportProgress, options);
    if (POWERPOINT_EXT.has(ext)) return renderPowerPoint(file, onProgress);
    throw new Error('SHOWAVE Documents accepts PDF, PPT, PPTX, PPS, PPSX, PPTM, and PPSM files.');
  }

  function asClipFile(source, pages, reference) {
    if(!source || !Array.isArray(pages) || !pages.length)
      throw new Error('A presentation Clip needs at least one prepared page.');
    const cover=new File([pages[0]], `${stemOf(source.name)}.presentation.png`, {
      type:'image/png', lastModified:source.lastModified||Date.now()
    });
    const facts={
      documentId:documentId(source), documentSourceName:source.name,
      documentPage:1, documentPageCount:pages.length,
      documentFormat:pages[0].documentFormat||extOf(source.name).toUpperCase(),
      presentationPages:pages.slice(),
      originalSource:source,
      sourceReference:reference||source.sourceReference||{
        kind:source._openlivePath?'original-path':'browser-file',
        path:source._openlivePath||null,url:source._openliveURL||null,
        verified:!!source._openlivePath,sessionOnly:true,copies:false,reason:null
      },
      renderedInMemory:true
    };
    for(const [key,value] of Object.entries(facts))
      Object.defineProperty(cover,key,{value,enumerable:true,configurable:true});
    return cover;
  }

  return {isDocument, isPowerPoint, openPlayer, prepare, asClipFile, PDF_EXT:[...PDF_EXT], POWERPOINT_EXT:[...POWERPOINT_EXT]};
})();
