/* OBS assets are attributed in assets/obs-icons/NOTICE.md; source-controls are local vectors. */
window.OpenLiveSourceIcons=(()=>{
  'use strict';
  const base=new URL('assets/obs-icons/',document.currentScript.src);
  const names={camera:'sources/camera',screen:'sources/window',window:'sources/window',image:'sources/image',
    media:'sources/media',video:'sources/media',present:'../presenter-icons/presenter',presentation:'../presenter-icons/presenter',slideshow:'sources/slideshow',text:'sources/text',color:'sources/brush',
    'audio-input':'sources/microphone',audio:'sources/microphone','audio-output':'sources/microphone',
    'application-audio':'sources/windowaudio',browser:'sources/globe',game:'sources/gamepad',scene:'sources/scene',
    live:'sources/scene',showave:'sources/scene',ndi:'sources/default',artwork:'sources/image',audience:'../source-controls/audience',chart:'../source-controls/audience',grip:'../source-controls/grip',edit:'../source-controls/pencil',remove:'../source-controls/trash',playback:'../source-controls/playback',autosize:'../source-controls/autosize'};
  const controls=new Set(['plus','minus','up','down','cogs','visible','invisible','locked','unlocked','dots']);
  function prepend(node,type){
    const icon=node.ownerDocument.createElement('span');icon.className='bc-source-icon';icon.setAttribute('aria-hidden','true');
    const vectors=window.OpenLiveControlIcons;
    const sourceNames={camera:'camera',screen:'screen',window:'screen',image:'image',media:'playback',video:'playback',present:'presentation',presentation:'presentation',slideshow:'slideshow',text:'text',color:'brush','audio-input':'microphone',audio:'audio','audio-output':'volume','application-audio':'audio',browser:'globe',game:'gamepad',scene:'layers',live:'layers',showave:'layers',ndi:'video',artwork:'image',chart:'audience'};
    const control=controls.has(type)||Object.hasOwn(sourceNames,type)||['grip','edit','remove','playback','autosize','audience'].includes(type);
    const polished=sourceNames[type]||type;
    icon.style.setProperty('--source-icon',control&&vectors?.has(polished)?vectors.mask(polished):'url("'+new URL((names[type]||(controls.has(type)?type:'sources/default'))+'.svg',base).href+'")');
    node.prepend(icon);return icon;
  }
  return Object.freeze({prepend});
})();
