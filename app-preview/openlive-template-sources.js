/* Native template lettering is already a scene source. These read-only
 * descriptors let Captions inspect that source without creating an overlay. */
window.OpenLiveTemplateSources = (() => {
  'use strict';
  const captionTypes=new Set(['ticker','headline','text','label','lower-third']);
  function captionRows(studio,scene) {
    if(!scene||typeof studio?.sceneContents!=='function')return [];
    const rows=studio.sceneContents(scene);
    if(!Array.isArray(rows))return [];
    return rows.flatMap(row=>{
      const component=row?.component;
      if(!['part','template'].includes(row?.kind)||component?.editableText!==true||!captionTypes.has(component.type))return [];
      // QR instructions and decorative identity lettering retain their native
      // artwork/commerce editor rather than becoming show captions.
      if(component.editableQr||component.category==='qr'||component.categories?.includes('qr')||/^qr(?:-|$)/.test(component.id||''))return [];
      const style=row.kind==='part'?row.part?.style:scene.fullTemplateStyle,
        change=style?.components?.[component.id],
        nativeText=change&&Object.hasOwn(change,'text')?change.text:component.defaultText;
      return [{key:row.key,kind:row.kind,row,component,
        label:row.label||component.label||'Template caption',
        detail:component.type==='ticker'?'Template ticker':component.type==='label'?'Template label':'Template caption',
        text:typeof nativeText==='string'?nativeText:undefined,
        locked:row.kind==='part'&&!!row.part?.locked}];
    });
  }
  function selectedCaption(studio,scene,key) {
    return captionRows(studio,scene).find(row=>row.key===key)||null;
  }
  const nativeGroups=Object.freeze({
    'lower-third':{label:'Lower third / captions',primaryComponentId:'headline',componentIds:['lower-third-backplate','headline']},
    ticker:{label:'Ticker',primaryComponentId:'ticker-text',componentIds:['ticker-backplate','ticker-label-backplate','ticker-text','ticker-label']},
    qr:{label:'QR code',primaryComponentId:'qr',componentIds:['qr-frame','qr-label','qr-arrow','qr','qr-instruction']}
  });
  const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  // These two additions are authored SHOWAVE sources, not supplied SVG artwork.
  // Their geometry is shared by the picker, source renderer and template shelf.
  const extensions=freeze({
    countdown:{id:'authored-countdown',label:'Countdown · authored source',type:'countdown',authoredExtension:true,
      provenance:'Authored SHOWAVE extension; not part of the nine supplied SVG designs.',width:600,height:240,
      bounds:{x:.34,y:(1-.32*(240/600)*(16/9))/2,w:.32,h:.32*(240/600)*(16/9)},
      textBox:{x:16,y:120,w:568,h:208},defaults:{duration:300,color:'#ffffff',background:'transparent',size:150}},
    'product-card':{id:'authored-product-card',label:'Product / live sales · authored source',type:'product-card',authoredExtension:true,
      provenance:'Authored SHOWAVE extension; not part of the nine supplied SVG designs.',width:1200,height:540,
      bounds:{x:.48,y:.58,w:.50,h:.40},accentRect:{x:0,y:0,w:16,h:540},
      titleBox:{x:48,y:92,w:704,h:80,size:64},priceBox:{x:48,y:184,w:704,h:84,size:70},
      descriptionBox:{x:48,y:186,priceY:258,w:704,size:34,lineHeight:44,maxLines:5},
      qrBox:{x:784,y:92,w:368,foreground:'#111827',background:'#ffffff'},defaults:{title:'Product name',price:'',description:'',url:'https://example.com',foreground:'#ffffff',background:'#15325b',accent:'#38bdf8'}}
  });
  function creativeDefinitions(type){
    if(extensions[type])return [extensions[type]];
    const group=nativeGroups[type];if(!group)return [];
    const catalog=window.OpenLiveFullTemplates?.list?.()||window.OpenLiveFullTemplateCatalog||[];
    return catalog.flatMap(template=>{
      const components=group.componentIds.map(id=>template.components?.find(component=>component.id===id));
      if(components.some(component=>!component?.bounds))return [];
      const x=Math.min(...components.map(c=>c.bounds.x)),y=Math.min(...components.map(c=>c.bounds.y)),
        right=Math.max(...components.map(c=>c.bounds.x+c.bounds.w)),bottom=Math.max(...components.map(c=>c.bounds.y+c.bounds.h)),
        primary=components.find(c=>c.id===group.primaryComponentId),qrLabel=components.find(c=>c.id==='qr-label'),
        palette=key=>{const entry=template.palette?.find(p=>p.key===key);return entry?.defaultColor||entry?.paints?.[0];};
      const overflowDefaults={overflow:'scroll',overflowSpeed:80};
      const defaults=type==='lower-third'?{...overflowDefaults,line1:primary.defaultText||'Your name',line2:'',color:primary.defaultTextColor||'#000000',size:primary.defaultFontSize}:
        type==='ticker'?{...overflowDefaults,text:primary.defaultText||'Your ticker text',color:primary.defaultTextColor||'#ffffff',background:palette('ticker')||'#030303',size:primary.defaultFontSize}:
        {...overflowDefaults,url:'https://example.com',label:qrLabel.defaultText||'SCAN HERE',foreground:qrLabel.defaultTextColor||'#ffffff',background:palette('accent')||'#f80a10'};
      return [freeze({id:type+'-'+template.id,label:group.label+' · '+template.name,type,templateId:template.id,
        componentIds:group.componentIds.slice(),primaryComponentId:group.primaryComponentId,authoredExtension:false,
        bounds:{x,y,w:right-x,h:bottom-y},width:template.width,height:template.height,
        motion:{frameMs:33},
        defaultFontSize:primary.defaultFontSize,defaultTextColor:primary.defaultTextColor,defaults:{templateId:template.id,...defaults}})];
    });
  }
  function resolveCreative(type,templateId){
    const definitions=creativeDefinitions(type);
    if(extensions[type])return definitions[0];
    const id=templateId||'svg-4',definition=definitions.find(item=>item.templateId===id);
    if(!definition)throw Error('Choose a template that contains this native source.');return definition;
  }
  return Object.freeze({captionRows,selectedCaption,creativeDefinitions,resolveCreative});
})();
