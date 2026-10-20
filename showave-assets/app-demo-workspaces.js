/* Embed the verified SHOWAVE frontend itself. No reconstructed workspace UI. */
const info = (id,name,description,accent,guide) => Object.freeze({id,name,description,accent,guide:'/manuals?article='+guide,steps:['Explore the actual interface with sample content.']});
export const supportsWalkthrough = false;
export const demoTools = Object.freeze([
 info('live','SHOWAVE Live','The actual Live workspace, prepared for a website preview.','#ff895f','media-present#load'),
 info('broadcast','SHOWAVE Broadcast','The actual Broadcast workspace, with local sample scenes.','#ff7294','broadcast-guide#start-with-an-empty-canvas'),
 info('map','SHOWAVE Map','The actual mapping interface and its sample output.','#f28bcc','mapping-output#map'),
 info('grid','SHOWAVE Grid Tool','The actual LED grid planning interface.','#61d5ed','mapping-output#grid'),
 info('gsl5','GSL5 Lighting Library','The actual fixture library and lighting controls.','#c1a0ff','creative-control#lighting'),
 info('timeline','SHOWAVE Timeline','The actual Timeline workspace and transport.','#52d5bd','creative-control#timeline'),
 info('forge','SHOWAVE Forge','The actual Forge canvas and node controls.','#7babff','creative-control#forge'),
 info('chaser','SHOWAVE Chaser','The actual Chaser patterns and slice sequencer.','#b9e365','mapping-output#chaser'),
 info('encode','SHOWAVE Encode','The actual Encode media preparation interface.','#f3c76b','creative-control#encode')
]);

export function mountWorkspace(host,id,{onStep,onClose,onWorkspace}={}) {
 const tool=demoTools.find(t=>t.id===id);if(!tool)throw new TypeError('Unknown SHOWAVE preview.');
 const root=document.createElement('div');root.className='sw-real-demo';root.dataset.workspace=id;
 root.innerHTML='<div class="sw-real-demo-bar"><span>SHOWAVE web interface <span data-real-version></span></span><button type="button" data-real-zoom aria-pressed="false">Zoom interface</button></div><div class="sw-real-demo-viewport"><div class="sw-real-demo-canvas"></div></div><p class="sw-real-demo-note">Website preview · Sample session · Live outputs and account connections are unavailable.</p>';
 host.append(root);
 const viewport=root.querySelector('.sw-real-demo-viewport'),canvas=root.querySelector('.sw-real-demo-canvas');
 const frame=document.createElement('iframe');
 frame.title=tool.name+' actual interface preview';frame.setAttribute('sandbox','allow-scripts allow-forms');
 frame.setAttribute('allow',"camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'; midi 'none'; usb 'none'; serial 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'");
 frame.referrerPolicy='no-referrer';frame.width='1440';frame.height='900';
 const url=new URL('/app-preview/index.html',location.origin);url.searchParams.set('workspace',id);
 let destroyed=false,zoom=false,suspended=false,previewToken='',resizeFrame=0;
 function source(){previewToken=crypto.randomUUID();url.searchParams.set('previewToken',previewToken);return url.href;}
 frame.src=source();canvas.append(frame);
 const resize=()=>{
  if(destroyed)return;
  const scale=zoom?1:Math.min(1,viewport.clientWidth/1440);
  const transform='scale('+scale+')',height=zoom?'min(65vh,900px)':(900*scale)+'px';
  if(canvas.style.transform!==transform)canvas.style.transform=transform;
  if(viewport.style.height!==height)viewport.style.height=height;
 };
 const observer=new ResizeObserver(()=>{
  if(!destroyed&&!resizeFrame)resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;resize();});
 });observer.observe(viewport);
 const zoomButton=root.querySelector('[data-real-zoom]');
 zoomButton.addEventListener('click',()=>{
  zoom=!zoom;viewport.classList.toggle('is-zoomed',zoom);zoomButton.setAttribute('aria-pressed',String(zoom));
  zoomButton.textContent=zoom?'Fit window':'Zoom interface';resize();
  onStep?.(zoom?'The original interface is full size. Scroll inside the window to reach its controls.':'The full interface fits inside the preview window.');
 });
 function message(event) {
  if(destroyed||suspended||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.previewToken!==previewToken)return;
  if(event.data.type==='showave-preview-close'){onClose?.();return;}
  if(event.data.type==='showave-preview-workspace'&&demoTools.some(t=>t.id===event.data.workspace)){onWorkspace?.(event.data.workspace);return;}
  if(event.data.type==='showave-preview-action-limited'&&typeof event.data.text==='string'){onStep?.(event.data.text.slice(0,350));return;}
  if(event.data.type!=='showave-preview-ready')return;
  if(event.data.workspace!==id)return;
  if(/^0\.1\.0-preview\.\d+$/.test(event.data.version||''))root.querySelector('[data-real-version]').textContent=event.data.version;
  root.dataset.ready='true';onStep?.('The real '+tool.name+' interface is ready. Try its sample controls.');
 }
 window.addEventListener('message',message);
 resize();
 return {
  reset(){if(!destroyed){root.dataset.ready='false';frame.src=source();onStep?.('Resetting the sample session…');}},
  suspend(){if(!destroyed&&!suspended){suspended=true;root.dataset.ready='false';frame.src='about:blank';frame.remove();}},
  resume(){if(!destroyed&&suspended){suspended=false;frame.src=source();canvas.append(frame);resize();}},
  setTourPlaying(){},
  destroy(){if(destroyed)return;destroyed=true;observer.disconnect();cancelAnimationFrame(resizeFrame);window.removeEventListener('message',message);frame.src='about:blank';root.remove();}
 };
}
