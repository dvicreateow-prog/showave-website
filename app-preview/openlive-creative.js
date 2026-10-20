/* Scene-item creative effects. Non-destructive; never changes a shared source. */
window.OpenLiveCreative=(()=>{
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const defaults={opacity:1,flipX:false,flipY:false,radius:0,stroke:{width:0,color:'#ffffff',style:'solid'},crop:{left:0,right:0,top:0,bottom:0},brightness:1,contrast:1,saturation:1,animation:{preset:'none',seconds:3},erase:[]};
  function object(raw,keys,label){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))throw Error('Invalid '+label+'.');}
  function number(value,min,max,label){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(label+' must be between '+min+' and '+max+'.');return value;}
  function normalize(raw={}){
    object(raw,Object.keys(defaults),'creative settings');const out={...clone(defaults),...clone(raw)};
    for(const [key,max] of [['opacity',1],['radius',.5],['brightness',2],['contrast',2],['saturation',2]])number(out[key],0,max,key);
    for(const key of ['flipX','flipY'])if(typeof out[key]!=='boolean')throw Error('Invalid flip setting.');
    out.stroke={...defaults.stroke,...out.stroke};object(out.stroke,Object.keys(defaults.stroke),'stroke');number(out.stroke.width,0,64,'Stroke width');
    if(!/^#[0-9a-f]{6}$/i.test(out.stroke.color)||!['solid','dashed','dotted'].includes(out.stroke.style))throw Error('Choose a valid stroke colour/style.');
    out.crop={...defaults.crop,...out.crop};object(out.crop,Object.keys(defaults.crop),'crop');
    for(const key of Object.keys(defaults.crop))number(out.crop[key],0,.99,'Crop');
    if(out.crop.left+out.crop.right>=.99||out.crop.top+out.crop.bottom>=.99)throw Error('Crop must leave at least 1% of the layer.');
    out.animation={...defaults.animation,...out.animation};object(out.animation,['preset','seconds'],'animation');
    if(!['none','breathe','float','pulse'].includes(out.animation.preset))throw Error('Choose a supported animation.');number(out.animation.seconds,.5,20,'Animation duration');
    if(!Array.isArray(out.erase)||out.erase.length>32)throw Error('A layer supports up to 32 eraser strokes.');
    out.erase=out.erase.map(stroke=>{object(stroke,['size','points'],'eraser stroke');number(stroke.size,.002,.5,'Brush size');
      if(!Array.isArray(stroke.points)||!stroke.points.length||stroke.points.length>128)throw Error('An eraser stroke needs 1–128 points.');
      return {size:stroke.size,points:stroke.points.map(point=>{if(!Array.isArray(point)||point.length!==2)throw Error('Invalid brush point.');return point.map(n=>number(n,0,1,'Brush point'));})};});
    return out;
  }
  const merge=(previous,patch)=>normalize({...normalize(previous),...patch});
  const pool=[];let depth=0;
  function path(ctx,x,y,w,h,radius){ctx.beginPath();if(radius)ctx.roundRect(x,y,w,h,Math.min(radius,w/2,h/2));else ctx.rect(x,y,w,h);}
  function local(ctx,r){ctx.translate(r.x+r.w/2,r.y+r.h/2);ctx.rotate((r.rotation||0)*Math.PI/180);}
  function unlocal(ctx,r){ctx.rotate(-(r.rotation||0)*Math.PI/180);ctx.translate(-r.x-r.w/2,-r.y-r.h/2);}
  // Only the eraser needs a private render surface. No pixel readback or
  // per-frame CPU image processing; lower layers can never be erased by it.
  function paint(ctx,canvas,rect,raw,timeMs,draw,options={}){
    if(!raw)return draw(ctx);
    const c=raw,r={x:rect.x*canvas.width,y:rect.y*canvas.height,w:rect.w*canvas.width,h:rect.h*canvas.height,rotation:rect.rotation||0};
    if(!(r.w>0&&r.h>0))throw Error('Invalid creative layer bounds.');
    let image=null,result;
    if(c.erase?.length){
      const index=depth++;try{
        const scratch=pool[index]||(pool[index]=document.createElement('canvas'));
        if(scratch.width!==canvas.width)scratch.width=canvas.width;if(scratch.height!==canvas.height)scratch.height=canvas.height;
        const group=scratch.getContext('2d');if(!group)throw Error('The eraser canvas is unavailable.');
        group.clearRect(0,0,scratch.width,scratch.height);result=draw(group);group.save();
        try{group.globalCompositeOperation='destination-out';local(group,r);group.lineCap='round';group.lineJoin='round';group.strokeStyle='#000';group.fillStyle='#000';
          for(const stroke of c.erase){group.lineWidth=stroke.size*Math.min(r.w,r.h);group.beginPath();
            stroke.points.forEach(([x,y],i)=>{const px=(x-.5)*r.w,py=(y-.5)*r.h;if(i)group.lineTo(px,py);else group.moveTo(px,py);});
            if(stroke.points.length===1){const [x,y]=stroke.points[0];group.arc((x-.5)*r.w,(y-.5)*r.h,group.lineWidth/2,0,Math.PI*2);group.fill();}else group.stroke();
          }
        }finally{group.restore();}image=scratch;
      }finally{depth--;}
    }
    ctx.save();try{
      local(ctx,r);
      const phase=2*Math.PI*(Number(timeMs)||0)/(1000*(c.animation?.seconds||3)),preset=c.animation?.preset;
      if(preset==='breathe'){const scale=1+.04*Math.sin(phase);ctx.scale(scale,scale);}
      if(preset==='float')ctx.translate(0,.035*r.h*Math.sin(phase));
      ctx.globalAlpha*= (c.opacity??1)*(preset==='pulse'?.75+.25*Math.cos(phase):1);
      ctx.scale(c.flipX?-1:1,c.flipY?-1:1);
      const crop=c.crop||defaults.crop;let x=-r.w/2+crop.left*r.w,y=-r.h/2+crop.top*r.h,w=r.w*(1-crop.left-crop.right),h=r.h*(1-crop.top-crop.bottom);
      // Crop and eraser coordinates retain the authored output space. Only
      // the resulting picture contour follows Fit/Off, so a border never
      // surrounds letterbox space and rounded corners share that contour.
      const picture=options.pictureBounds;
      if(picture){const px=picture.x*canvas.width-r.x-r.w/2,py=picture.y*canvas.height-r.y-r.h/2,
        right=Math.min(x+w,px+picture.w*canvas.width),bottom=Math.min(y+h,py+picture.h*canvas.height);
        x=Math.max(x,px);y=Math.max(y,py);w=Math.max(0,right-x);h=Math.max(0,bottom-y);}
      if(!w||!h)return result;
      const radius=(c.radius||0)*Math.min(w,h);
      ctx.save();try{
        path(ctx,x,y,w,h,radius);ctx.clip();
        if(c.brightness!==1||c.contrast!==1||c.saturation!==1)ctx.filter=`brightness(${c.brightness??1}) contrast(${c.contrast??1}) saturate(${c.saturation??1})`;
        unlocal(ctx,r);if(image)ctx.drawImage(image,0,0);else result=draw(ctx);
      }finally{ctx.restore();}
      const stroke=c.stroke||defaults.stroke;if(stroke.width){
        // Stroke units are pixels on the 1920×1080 reference canvas.
        const width=stroke.width*Math.min(canvas.width/1920,canvas.height/1080),inset=Math.min(width/2,w/2,h/2);
        ctx.lineWidth=width;ctx.strokeStyle=stroke.color;ctx.lineCap=stroke.style==='dotted'?'round':'butt';
        ctx.setLineDash(stroke.style==='dashed'?[width*3,width*2]:stroke.style==='dotted'?[0,width*2]:[]);
        path(ctx,x+inset,y+inset,Math.max(0,w-2*inset),Math.max(0,h-2*inset),Math.max(0,radius-inset));ctx.stroke();
      }
    }finally{ctx.restore();}
    return result;
  }
  // Brush coordinates are in the unflipped, unrotated layer's local space.
  function brushPoint(rect,x,y,aspect=16/9,creative={}){
    const a=-(rect.rotation||0)*Math.PI/180,dx=(x-rect.x-rect.w/2)*aspect,dy=y-rect.y-rect.h/2;
    let px=(dx*Math.cos(a)-dy*Math.sin(a))/(rect.w*aspect)+.5,py=(dx*Math.sin(a)+dy*Math.cos(a))/rect.h+.5;
    if(creative.flipX)px=1-px;if(creative.flipY)py=1-py;
    return [Math.max(0,Math.min(1,px)),Math.max(0,Math.min(1,py))];
  }
  return Object.freeze({normalize,merge,paint,brushPoint,defaults:()=>clone(defaults)});
})();
