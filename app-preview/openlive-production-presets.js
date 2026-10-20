/* Editable SHOWAVE starters using procedural backgrounds and editable captions.
 * No supplied artwork, third-party logos, checkout URLs or hard-coded LIVE flags. */
window.OpenLiveProductionPresets = (() => {
  'use strict';
  const freeze = rows => Object.freeze(rows.map(row => Object.freeze(row)));
  const brands = freeze([
    {id:'newsroom',name:'Newsroom',description:'Blue angular background · red section badge',primaryColor:'#E51C38',fontId:'franklin-gothic',templateId:'studio-chevron',tickerLabel:'UPDATES',background:'builtin:bg:template-blue-angular'},
    {id:'curtain',name:'Studio curtain',description:'Cyan identity · violet curtain · presenter card',primaryColor:'#80F2D1',fontId:'segoe-ui',templateId:'name-dark',tickerLabel:'ON THE SHOW',background:'builtin:bg:template-cyan-curtain'},
    {id:'showcase',name:'Product showcase',description:'Violet accent · compact card · room for a QR',primaryColor:'#7C3AED',fontId:'arial',templateId:'name-accent',tickerLabel:'DISCOVER',background:'builtin:bg:studio-dusk'},
    {id:'minimal',name:'Clean interview',description:'Blue accent · white card · quiet background',primaryColor:'#2563EB',fontId:'segoe-ui',templateId:'name-white',tickerLabel:'CONVERSATION',background:'builtin:bg:quiet-paper'}
  ]);
  const captions = freeze([
    {id:'speaker',name:'Speaker introduction',type:'lower-third',line1:'Speaker name',line2:'Role · Organisation'},
    {id:'headline',name:'News headline',type:'lower-third',line1:'Your programme headline',line2:'COMMUNITY UPDATE'},
    {id:'chapter',name:'Segment title',type:'lower-third',line1:'Coming up next',line2:'Your next topic'},
    {id:'welcome',name:'Welcome ticker',type:'ticker',text:'Welcome to the programme • Join the conversation'},
    {id:'schedule',name:'Programme ticker',type:'ticker',text:'On this programme • Opening remarks • Conversation • Questions'},
    {id:'action',name:'Call-to-action ticker',type:'ticker',text:'Scan the on-screen code to learn more • Thank you for watching'}
  ]);
  const commerce = freeze([
    {id:'watch',name:'Watch this stream',type:'qr',title:'Watch this stream',targetMode:'broadcast',target:'',callToAction:'Scan to watch',price:''},
    {id:'website',name:'Visit a website',type:'qr',title:'Find out more',targetMode:'custom',target:'',callToAction:'Scan to explore',price:''},
    {id:'support',name:'Support / donate',type:'qr-image',title:'Support our work',targetMode:'custom',target:'',callToAction:'Scan to support',price:''},
    {id:'product',name:'Featured product',type:'product',title:'Your product name',targetMode:'custom',target:'',callToAction:'Shop now',price:''}
  ]);
  const placements = freeze([
    {id:'full',name:'Full frame',x:0,y:0,w:1,h:1},
    {id:'sidebar',name:'Right sidebar',x:.72,y:.08,w:.25,h:.66},
    {id:'lower',name:'Lower band',x:.04,y:.72,w:.92,h:.20},
    {id:'corner',name:'Upper corner',x:.67,y:.04,w:.29,h:.29}
  ]);
  return Object.freeze({brands,captions,commerce,placements});
})();
