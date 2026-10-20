/* Wire UI clone — behaviour. Original code. */
(() => {
'use strict';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const S = { chk:{}, radio:{}, zoom:1, pan:{x:0,y:0}, sel:null, pinned:false, nextId:100 };

/* The node library: the decoded 391 classes when wire-nodes.js is loaded,
   otherwise the hand-written subset in wire-data.js. Same shape either way. */
const CATS    = window.NODE_CATEGORIES_REAL || NODE_CATEGORIES;
const CLASSES = window.NODE_CLASSES_REAL    || NODE_CLASSES;
(function seed(list){ list.forEach(i=>{ if(i.chk&&i.on) S.chk[i.chk]=true;
  if(i.radio&&i.on) S.radio[i.radio]=i.l; if(i.sub) seed(i.sub); }); })(WIRE_MENUS.flatMap(m=>m.items));

/* ---------- dropdowns ---------- */
let dd=[];
function closeDD(n=0){
  while(dd.length>n) dd.pop().remove();
  if(!n) $$('.menu-top.open').forEach(m=>{
    m.classList.remove('open'); m.setAttribute('aria-expanded','false');
  });
}
function buildDD(items,x,y,lvl){
  closeDD(lvl);
  const d=document.createElement('div'); d.className='dropdown'; d.setAttribute('role','menu');
  items.forEach(it=>{
    if(it.sep){ d.appendChild(Object.assign(document.createElement('div'),{className:'dd-sep'})); return; }
    if(it.colors){
      const r=document.createElement('div'); r.className='dd-colors'; r.setAttribute('role','group');
      WIRE_COLORS.forEach(c=>{ const s=document.createElement('span');
        s.className='swatch'+(c==='none'?' none':''); if(c!=='none') s.style.background=c;
        s.setAttribute('role','menuitem'); s.tabIndex=0;
        s.setAttribute('aria-label',c==='none'?'No node colour':`Node colour ${c}`);
        s.onclick=()=>{ if(S.sel){ S.sel.el.querySelector('.stripe').style.background = c==='none'?'transparent':c; } closeDD(); };
        s.addEventListener('keydown',event=>{
          if(event.key==='Enter'||event.key===' '){ event.preventDefault(); s.click(); }
        });
        r.appendChild(s); });
      d.appendChild(r); return;
    }
    const e=document.createElement('div');
    e.className='dd-item'+(it.dis?' disabled':'');
    e.setAttribute('role','menuitem'); e.tabIndex=it.dis?-1:0;
    if(it.dis) e.setAttribute('aria-disabled','true');
    const on=(it.chk&&S.chk[it.chk])||(it.radio&&S.radio[it.radio]===it.l);
    e.innerHTML=`<span class="chk">${on?'✓':''}</span><span>${it.uiLabel??it.l}</span>`+
      (it.k?`<span class="kbd">${it.k}</span>`:'')+(it.sub?`<span class="arrow">▸</span>`:'');
    const openSubmenu=()=>{ const r=e.getBoundingClientRect(); return buildDD(it.sub,r.right-2,r.top-3,lvl+1); };
    if(it.sub){
      e.setAttribute('aria-haspopup','menu');
      e.addEventListener('mouseenter',openSubmenu);
      e.addEventListener('click',()=>openSubmenu());
    }
    else{
      e.addEventListener('mouseenter',()=>closeDD(lvl+1));
      e.addEventListener('click',()=>{
        if(it.dis) return;
        if(it.chk){ S.chk[it.chk]=!S.chk[it.chk]; applyView(it.chk); }
        if(it.radio) S.radio[it.radio]=it.l;
        if(it.act==='welcome')  $('#welcome').classList.add('show');
        if(it.act==='settings') window.open('wire-settings.html','_blank');
        if(it.act==='isf')      window.open('wire-settings.html#isf','_blank');
        if(it.act==='compile')  window.open('wire-settings.html#compile','_blank');
        closeDD();
      });
    }
    e.addEventListener('keydown',event=>{
      if(it.dis) return;
      if(it.sub&&(event.key==='Enter'||event.key===' '||event.key==='ArrowRight')){
        event.preventDefault(); openSubmenu().querySelector('.dd-item:not(.disabled),.swatch')?.focus();
      } else if(event.key==='Enter'||event.key===' '){ event.preventDefault(); e.click(); }
    });
    d.appendChild(e);
  });
  document.body.appendChild(d);
  const r=d.getBoundingClientRect();
  d.style.left=Math.min(x, innerWidth-r.width-4)+'px';
  d.style.top =Math.min(y, innerHeight-r.height-4)+'px';
  dd.push(d); return d;
}
addEventListener('mousedown',e=>{ if(!e.target.closest('.dropdown')&&!e.target.closest('.menu-top')) closeDD(); });
addEventListener('keydown',e=>{ if(e.key==='Escape'){
  const trigger=$('.menu-top.open'); closeDD(); trigger&&trigger.focus();
  $$('.overlay.show').forEach(o=>o.classList.remove('show'));
}});

WIRE_MENUS.forEach(m=>{
  const t=document.createElement('div'); t.className='menu-top'; t.textContent=m.uiLabel??m.label;
  t.setAttribute('role','menuitem'); t.setAttribute('aria-haspopup','menu');
  t.setAttribute('aria-expanded','false'); t.tabIndex=0;
  const open=()=>{ closeDD(); t.classList.add('open'); t.setAttribute('aria-expanded','true');
    const r=t.getBoundingClientRect(); return buildDD(m.items,r.left,r.bottom+1,0); };
  t.addEventListener('mousedown',e=>{ e.stopPropagation(); t.focus({preventScroll:true});
    t.classList.contains('open')?closeDD():open(); });
  t.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===' '||e.key==='ArrowDown'){
      e.preventDefault(); const menu=t.classList.contains('open')?dd[0]:open();
      menu&&menu.querySelector('.dd-item:not(.disabled)')?.focus();
    }
  });
  t.addEventListener('mouseenter',()=>{ if(dd.length&&$$('.menu-top.open').length&&!t.classList.contains('open')) open(); });
  $('#menubarMenus').appendChild(t);
});
function applyView(key){
  const map={ vLib:'.w-lib', vMon:'.w-mon' };
  if(map[key]) $(map[key]).style.display = S.chk[key] ? '' : 'none';
  const tabs={ vNode:'pNode', vPatch:'pPatch', vDash:'pDash', vStats:'pStats',
    vRes:'pRes', vNotes:'pNotes', vLog:'pLog' };
  if(tabs[key]){ const t=$(`#sideTabs [data-pane="${tabs[key]}"]`); if(t) t.style.display=S.chk[key]?'':'none'; }
}

/* ---------- tabs ---------- */
function activatePanelTab(tabs,t,focus){
  tabs.querySelectorAll('.ptab').forEach(x=>{
    const on=x===t; x.classList.toggle('active',on);
    x.setAttribute('aria-selected',String(on)); x.tabIndex=on?0:-1;
  });
  const scope=tabs.parentElement;
  scope.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active',p.id===t.dataset.pane));
  if(focus) t.focus({preventScroll:true});
}
$$('.ptabs').forEach(tabs=>{
  tabs.setAttribute('role','tablist');
  const items=[...tabs.querySelectorAll('.ptab')];
  items.forEach(t=>{
    t.setAttribute('role','tab'); t.setAttribute('aria-controls',t.dataset.pane);
    const on=t.classList.contains('active'); t.setAttribute('aria-selected',String(on)); t.tabIndex=on?0:-1;
  });
  tabs.addEventListener('click',e=>{ const t=e.target.closest('.ptab'); if(t) activatePanelTab(tabs,t,false); });
  tabs.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(e.key)) return;
    const current=e.target.closest('.ptab'); if(!current) return;
    e.preventDefault();
    if(e.key==='Enter'||e.key===' '){ activatePanelTab(tabs,current,false); return; }
    const visible=items.filter(item=>item.style.display!=='none');
    const at=visible.indexOf(current);
    const next=e.key==='Home'?visible[0]:e.key==='End'?visible[visible.length-1]:
      visible[(at+(e.key==='ArrowRight'?1:-1)+visible.length)%visible.length];
    if(next) activatePanelTab(tabs,next,true);
  });
});

/* ---------- library ---------- */
function buildTree(el, groups, onPick){
  el.innerHTML='';
  groups.forEach(g=>{
    const h=document.createElement('div'); h.className='tgroup'; h.textContent=g.cat||g.group;
    el.appendChild(h);
    const kids=[];
    (g.items||[]).forEach(n=>{
      const i=document.createElement('div'); i.className='titem';
      i.innerHTML=`<span class="dot" style="background:${g.color||'#666'};margin-right:6px"></span><span>${n}</span>`;
      i.addEventListener('dblclick',()=>onPick&&onPick(n,g));
      i.addEventListener('click',()=>{ el.querySelectorAll('.titem').forEach(x=>x.classList.remove('selected')); i.classList.add('selected'); });
      el.appendChild(i); kids.push(i);
    });
    h.addEventListener('click',()=>kids.forEach(k=>k.style.display=k.style.display==='none'?'':'none'));
  });
}
buildTree($('#library'), CATS, (n,g)=>addNode(n,g.cat,g.color,200,150));
$('#libSearch').addEventListener('input',e=>{
  const q=e.target.value.toLowerCase();
  $$('#library .titem').forEach(i=>i.style.display=i.textContent.toLowerCase().includes(q)?'':'none');
});
buildTree($('#wPatches'),   WIRE_PATCHES_RECENT);
buildTree($('#wTutorials'), WIRE_TUTORIALS);
buildTree($('#wExamples'),  WIRE_EXAMPLES);
buildTree($('#wTemplates'), WIRE_TEMPLATES);
$$('[data-wclose]').forEach(b=>b.addEventListener('click',()=>$('#welcome').classList.remove('show')));
$$('[data-qclose]').forEach(b=>b.addEventListener('click',()=>$('#quickSearch').classList.remove('show')));

/* ---------- patch graph ---------- */
const layer=$('#nodes'), svg=$('#wires');
const graph={ nodes:[], wires:[] };

function catColor(cat){ const c=CATS.find(c=>c.cat===cat); return c?c.color:'#8a8a8a'; }

function addNode(cls, cat, color, x, y, ins, outs, id){
  const def = CLASSES.find(n=>n.name===cls);
  cat = cat || (def?def.cat:'Utility'); color = color || catColor(cat);
  ins  = ins  || defaultPorts(cat,'in');
  outs = outs || defaultPorts(cat,'out');
  const n={ id:id||S.nextId++, cls, cat, color, x, y, ins, outs };
  const el=document.createElement('div'); el.className='node'; el.style.left=x+'px'; el.style.top=y+'px';
  el.innerHTML=`<div class="stripe" style="background:${color}"></div>
    <h4><span>${cls}</span><span class="cat">${cat}</span></h4>
    <div class="ports">
      <div class="col">${ins.map((t,i)=>`<div class="port" data-in="${i}"><span class="dot" style="background:${TYPE_COLOR[t]||'#888'}"></span>${t}</div>`).join('')}</div>
      <div class="col">${outs.map((t,i)=>`<div class="port out" data-out="${i}"><span class="dot" style="background:${TYPE_COLOR[t]||'#888'}"></span>${t}</div>`).join('')}</div>
    </div>`;
  n.el=el; layer.appendChild(el); graph.nodes.push(n);
  el.addEventListener('mousedown',e=>{
    if(e.target.closest('.port')) return;
    select(n);
    const sx=e.clientX, sy=e.clientY, ox=n.x, oy=n.y;
    const mv=ev=>{ n.x=ox+(ev.clientX-sx)/S.zoom; n.y=oy+(ev.clientY-sy)/S.zoom;
      el.style.left=n.x+'px'; el.style.top=n.y+'px'; drawWires(); };
    const up=()=>{ removeEventListener('mousemove',mv); removeEventListener('mouseup',up); };
    addEventListener('mousemove',mv); addEventListener('mouseup',up);
  });
  el.addEventListener('contextmenu',e=>{ e.preventDefault(); select(n); buildDD(WIRE_MENUS[3].items,e.clientX,e.clientY,0); });
  updateCount();
  return n;
}
function defaultPorts(cat,dir){
  const M={ Input:{in:[],out:['Float']}, Output:{in:['Texture2dRgba'],out:[]},
    Info:{in:[],out:['Float','Float']}, Generator:{in:['Float'],out:['Texture2dR']},
    Shape:{in:['Float','Float2'],out:['Geometry2d']}, Mesh:{in:['Texture2dRgba'],out:['Mesh2d']},
    Texture:{in:['Texture2dRgba','Float'],out:['Texture2dRgba']},
    Math:{in:['Float','Float'],out:['Float']},
    'Control Flow':{in:['Float','Bool'],out:['Float']},
    Animation:{in:['Float','Float'],out:['Float']},
    Collection:{in:['Float'],out:['Float']}, String:{in:['String'],out:['String']},
    Protocol:{in:[],out:['MIDI']}, Resource:{in:[],out:['ResourceImage']},
    Slice:{in:[],out:['Slice']}, Utility:{in:['Float'],out:['Float']} };
  return (M[cat]||M.Utility)[dir];
}
function select(n){
  S.sel=n;
  graph.nodes.forEach(x=>x.el.classList.toggle('sel',x===n));
  $('#nName').value=n?n.cls:'N/A';
  $('#nClass').textContent=n?n.cls:'N/A';
  $('#selInfo').textContent=n?`${n.cls} · ${n.cat}`:'No selection';
  if(!S.pinned && n) $('#monName').textContent=n.cls;
  const box=$('#nInputs');
  box.innerHTML = n && n.ins.length
    ? n.ins.map((t,i)=>`<div class="prow"><label>${t} ${i+1}</label>
        <input type="range" min="0" max="100" value="${30+i*20}" data-out><output>${30+i*20}</output></div>`).join('')
    : '<div class="hint">This node has no editable inlets.</div>';
  box.querySelectorAll('input[type=range]').forEach(r=>r.addEventListener('input',()=>{
    r.parentElement.querySelector('output').value=r.value; }));
}
function drawWires(){
  const w=svg.clientWidth, h=svg.clientHeight;
  svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  svg.innerHTML = graph.wires.map(wire=>{
    const a=graph.nodes.find(n=>n.id===wire.from), b=graph.nodes.find(n=>n.id===wire.to);
    if(!a||!b) return '';
    const ap=a.el.querySelector(`[data-out="${wire.fo}"] .dot`);
    const bp=b.el.querySelector(`[data-in="${wire.ti}"] .dot`);
    if(!ap||!bp) return '';
    const wr=svg.getBoundingClientRect(), ar=ap.getBoundingClientRect(), br=bp.getBoundingClientRect();
    const x1=ar.left-wr.left+ar.width/2, y1=ar.top-wr.top+ar.height/2;
    const x2=br.left-wr.left+br.width/2, y2=br.top-wr.top+br.height/2;
    const dx=Math.max(30,Math.abs(x2-x1)*0.5);
    const col=TYPE_COLOR[a.outs[wire.fo]]||'#7a7a7a';
    return `<path d="M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}"
      fill="none" stroke="${col}" stroke-width="1.6" opacity="0.85"/>`;
  }).join('');
}
function updateCount(){ $('#nodeCount').textContent = graph.nodes.length+' nodes'; buildStats(); }

/* load demo patch */
DEMO_PATCH.nodes.forEach(n=>addNode(n.cls,n.cat,null,n.x,n.y,n.ins,n.outs,n.id));
graph.wires = DEMO_PATCH.wires.slice();
requestAnimationFrame(()=>{ drawWires(); });
addEventListener('resize',drawWires);

/* pan + zoom */
const wrap=$('#canvasWrap');
let panning=false, space=false;
addEventListener('keydown',e=>{ if(e.code==='Space'){ space=true; wrap.style.cursor='grab'; }});
addEventListener('keyup',  e=>{ if(e.code==='Space'){ space=false; wrap.style.cursor=''; }});
wrap.addEventListener('mousedown',e=>{
  if(!(space||e.button===1)) return;
  e.preventDefault(); panning=true; const sx=e.clientX, sy=e.clientY, p={...S.pan};
  const mv=ev=>{ S.pan.x=p.x+(ev.clientX-sx); S.pan.y=p.y+(ev.clientY-sy); applyTransform(); };
  const up=()=>{ panning=false; removeEventListener('mousemove',mv); removeEventListener('mouseup',up); };
  addEventListener('mousemove',mv); addEventListener('mouseup',up);
});
wrap.addEventListener('wheel',e=>{ e.preventDefault();
  S.zoom=Math.max(0.25,Math.min(4,S.zoom*(e.deltaY<0?1.1:0.9))); syncZoom(); },{passive:false});
function applyTransform(){
  layer.style.transform=`translate(${S.pan.x}px,${S.pan.y}px) scale(${S.zoom})`;
  drawWires();
}
function syncZoom(){ $('#zSel').value=Math.round(S.zoom*100)+'%'; applyTransform(); }
$('#zIn').addEventListener('click',()=>{ S.zoom=Math.min(4,S.zoom*1.25); syncZoom(); });
$('#zOut').addEventListener('click',()=>{ S.zoom=Math.max(0.25,S.zoom/1.25); syncZoom(); });
$('#zSel').addEventListener('change',e=>{
  if(e.target.value==='Fit'){ S.zoom=0.75; S.pan={x:0,y:0}; }
  else S.zoom=parseInt(e.target.value)/100;
  applyTransform();
});

/* quick search on double-click */
wrap.addEventListener('dblclick',e=>{
  if(e.target.closest('.node')) return;
  const r=wrap.getBoundingClientRect();
  S.dropAt={ x:(e.clientX-r.left-S.pan.x)/S.zoom, y:(e.clientY-r.top-S.pan.y)/S.zoom };
  $('#quickSearch').classList.add('show'); $('#qsInput').value=''; qsRender(''); $('#qsInput').focus();
});
function qsRender(q){
  const box=$('#qsResults'); box.innerHTML='';
  CLASSES.filter(n=>n.name.toLowerCase().includes(q.toLowerCase())).slice(0,40).forEach(n=>{
    const i=document.createElement('div'); i.className='titem';
    i.innerHTML=`<span class="dot" style="background:${n.color};margin-right:6px"></span><span>${n.name}</span>
      <span style="margin-left:auto;color:#777;font-size:10px">${n.cat}</span>`;
    i.addEventListener('click',()=>{
      const p=S.dropAt||{x:200,y:150};
      select(addNode(n.name,n.cat,n.color,p.x,p.y));
      $('#quickSearch').classList.remove('show'); drawWires();
    });
    box.appendChild(i);
  });
}
$('#qsInput').addEventListener('input',e=>qsRender(e.target.value));
$('#searchBtn').addEventListener('click',()=>{ $('#quickSearch').classList.add('show'); qsRender(''); $('#qsInput').focus(); });
$('#sortBtn').addEventListener('click',()=>{
  graph.nodes.forEach((n,i)=>{ n.x=60+ (i%4)*200; n.y=100+Math.floor(i/4)*140;
    n.el.style.left=n.x+'px'; n.el.style.top=n.y+'px'; });
  drawWires(); log('Auto-sorted '+graph.nodes.length+' nodes');
});
$('#textEdBtn').addEventListener('click',()=>log('ISF text editor opened (Ctrl+E)'));

/* ---------- side panels ---------- */
WIRE_COLORS.forEach(c=>{
  const s=document.createElement('span'); s.className='swatch'+(c==='none'?' none':'');
  s.style.cssText=`width:16px;height:16px;border:1px solid #000;cursor:pointer;${c!=='none'?'background:'+c:''}`;
  s.onclick=()=>{ if(S.sel) S.sel.el.querySelector('.stripe').style.background=c==='none'?'transparent':c; };
  $('#nColors').appendChild(s);
});
DATA_TYPES.forEach(f=>f.items.forEach(t=>$('#nType').appendChild(new Option(t,t))));

const dash=$('#dashList');
DASH_INPUTS.forEach(d=>{
  const row=document.createElement('div'); row.className='prow';
  row.innerHTML=`<label style="cursor:grab">≡ ${d.name}</label>
    <span class="dot" style="background:${TYPE_COLOR[d.type]||'#888'}"></span>
    <span style="font-size:10px;color:#8a8a8a;flex:1">${d.type}</span>
    <span class="pval" style="width:auto;font-size:10px">${d.node}</span>`;
  dash.appendChild(row);
});

function buildStats(){
  const b=$('#statsBody'); if(!b) return; b.innerHTML='';
  graph.nodes.forEach(n=>{
    const tr=document.createElement('tr'); tr.className='statrow';
    const load=(Math.random()*4+0.2).toFixed(2);
    tr.innerHTML=`<td>${n.cls}</td><td>${n.cat}</td><td>${load} ms</td>`;
    tr.addEventListener('click',()=>select(n));
    b.appendChild(tr);
  });
}
function log(msg){
  const b=$('#logBody');
  b.insertAdjacentHTML('afterbegin',`<div style="color:#9a9a9a">[${new Date().toLocaleTimeString('en-GB')}] ${msg}</div>`);
}
log('Patch loaded. Category: Effect');
log('SHOWAVE Forge ready');

/* legend */
const lg=$('#legend');
DATA_TYPES.forEach(f=>{
  const s=document.createElement('span');
  s.innerHTML=`<i style="background:${f.color}"></i>${f.family}`;
  lg.appendChild(s);
});

/* monitor */
$('#pinBtn').addEventListener('click',e=>{ S.pinned=!S.pinned; e.target.style.opacity=S.pinned?1:.5; });
$('#pinBtn').style.opacity=.5;
$('#monGear').addEventListener('click',e=>{
  const r=e.target.getBoundingClientRect();
  buildDD([{l:'Copy Frame As Image'},{l:'Snapshot To Image Node'},{sep:1},
    {l:'Transparent Background', radio:'monBg', on:1},{l:'Black Background', radio:'monBg'},
    {sep:1},{l:'Duplicate Monitor'},{l:'Undock'},{l:'Hide'}], r.right-200, r.bottom+4, 0);
});
const mc=$('#monCanvas'), mx=mc.getContext('2d');
(function draw(t){
  const w=mc.width,h=mc.height;
  const g=mx.createLinearGradient(0,0,w,h);
  g.addColorStop(0,'hsl('+((t/40)%360)+',60%,14%)');
  g.addColorStop(1,'hsl('+((t/40+80)%360)+',65%,30%)');
  mx.fillStyle=g; mx.fillRect(0,0,w,h);
  mx.strokeStyle='hsl('+((t/40+40)%360)+',85%,65%)'; mx.lineWidth=1.5;
  for(let l=0;l<4;l++){
    mx.beginPath();
    for(let x=0;x<=w;x+=4){
      const y=h/2+Math.sin(x/w*6+t/500+l)*h*0.2+(l-1.5)*h*0.1;
      x?mx.lineTo(x,y):mx.moveTo(x,y);
    }
    mx.stroke();
  }
  requestAnimationFrame(draw);
})(0);

setInterval(()=>{ $('#wFps').textContent=(59+Math.random()).toFixed(0)+' fps'; },1000);

/* spectrum volume slider appears only when a Spectrum In node exists */
function checkSpectrum(){ $('#volWrap').classList.toggle('show', graph.nodes.some(n=>n.cls==='Spectrum In')); }
const _add=addNode;
setInterval(checkSpectrum, 800);

/* keyboard */
addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if((e.key==='Delete'||e.key==='Backspace')&&S.sel){
    graph.wires=graph.wires.filter(w=>w.from!==S.sel.id&&w.to!==S.sel.id);
    S.sel.el.remove(); graph.nodes=graph.nodes.filter(n=>n!==S.sel);
    log('Destroyed '+S.sel.cls); S.sel=null; select(null); drawWires(); updateCount();
  }
  if(e.ctrlKey&&e.key.toLowerCase()==='f'){ e.preventDefault(); $('#searchBtn').click(); }
  if(e.ctrlKey&&e.key==='0'){ e.preventDefault(); S.zoom=0.75; S.pan={x:0,y:0}; syncZoom(); }
  if(e.ctrlKey&&e.key==='1'){ e.preventDefault(); S.zoom=1; S.pan={x:0,y:0}; syncZoom(); }
  if(e.ctrlKey&&e.key.toLowerCase()==='l'){ e.preventDefault(); $('#sortBtn').click(); }
  if(e.ctrlKey&&e.key.toLowerCase()==='d'&&S.sel){ e.preventDefault();
    select(addNode(S.sel.cls,S.sel.cat,S.sel.color,S.sel.x+30,S.sel.y+30,S.sel.ins,S.sel.outs)); drawWires(); }
});

select(graph.nodes[graph.nodes.length-1]);
buildStats();
})();
