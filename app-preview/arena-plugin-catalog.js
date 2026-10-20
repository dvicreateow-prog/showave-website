/* ===========================================================================
   Native plug-in evidence catalog
   ---------------------------------------------------------------------------
   This is metadata, not a native plug-in loader. A browser cannot dlopen an
   FFGL/VST binary, compile a Wire patch, or run an ISF resource through Wire.
   The catalog keeps those native identities separate from OpenLive's own
   Canvas/WebAudio equivalents so the Browser can say exactly which one works.

   Authorities captured in this workspace:
     - ArenaCatalog: Arena 7.27.1 REST Effect/Source ids and descriptions
     - ArenaWiredParams: the 15 shipped .wired headers and exposed inputs
     - ArenaPresetParams: shipped source/effect preset parameter declarations
     - default/Presets/Video Effects: ten explicit <FFGLPlugin> records
     - extracted/arena-tree.json: six plugins/afx DLLs, no plugins/vfx files
     - reference/user/arena/Preferences/extensions.xml: no user extensions
     - extracted Arena components: VST/FFGL directory controls
     - Wire node docs: ISF and ISF Resource are Wire nodes/resources
   =========================================================================== */
(function(root){
  'use strict';

  const live=root.ArenaCatalog||{};
  const wired=root.ArenaWiredParams||{};
  const presetRegistry=root.ArenaPresetParams||{};

  /* One shipped preset is retained as a witness for each distinct native
     FFGL identity. All presets for the same Effect serialize the same exact
     uniqueId/fileName pair; the regression test checks the complete tree. */
  const FFGL_PRESET_EVIDENCE=[
    ['Goo','sy06','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_Goo.bundle/Contents/MacOS/SyzGL_Goo','default/Presets/Video Effects/Goo/Shimmer.xml'],
    ['Iterate','sy13','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_Iterate.bundle/Contents/MacOS/SyzGL_Iterate','default/Presets/Video Effects/Iterate/Swirly.xml'],
    ['Kaleidoscope','sy02','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_Kaleidoscope.bundle/Contents/MacOS/SyzGL_Kaleidoscope','default/Presets/Video Effects/Kaleidoscope/Moving.xml'],
    ['RadialBlur','sy03','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_RadialBlur.bundle/Contents/MacOS/SyzGL_RadialBlur','default/Presets/Video Effects/RadialBlur/Spiral.xml'],
    ['Ripples','sy05','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_Ripples.bundle/Contents/MacOS/SyzGL_Ripples','default/Presets/Video Effects/Ripples/Spikes.xml'],
    ['Shift Glitch','MBSH','/Applications/Resolume Arena 6/plugins/vfx/FFGLBarshift.bundle/Contents/MacOS/FFGLBarshift','default/Presets/Video Effects/Shift Glitch/Kapot.xml'],
    ['Stripper','sy69','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_Stripper.bundle/Contents/MacOS/SyzGL_Stripper','default/Presets/Video Effects/Stripper/Rotating Strips.xml'],
    ['Tunnel','sy04','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_Tunnel.bundle/Contents/MacOS/SyzGL_Tunnel','default/Presets/Video Effects/Tunnel/Basic.xml'],
    ['VideoWall','sy88','/Applications/Resolume Arena 6/plugins/vfx/SyzGL_VideoWall.bundle/Contents/MacOS/SyzGL_VideoWall','default/Presets/Video Effects/VideoWall/BouncingSquares.xml'],
    ['Wave Warp','MWWP','/Applications/Resolume Arena 6/plugins/vfx/FFGLWaveWarp.bundle/Contents/MacOS/FFGLWaveWarp','default/Presets/Video Effects/Wave Warp/Twitch.xml']
  ];

  /* plugins/afx is Arena's shipped native audio-module directory. A DLL is not
     enough evidence to call something VST, so these six remain AFX records.
     The captured user extension registry contains zero VST plug-ins. */
  const AFX_INSTALL_EVIDENCE=[
    ['Bitcrusher','plugins\\afx\\Bitcrusher.dll',8262496],
    ['Distortion','plugins\\afx\\Distortion.dll',8254304],
    ['EQ-3','plugins\\afx\\EQ-3.dll',8255840],
    ['Flanger','plugins\\afx\\Flanger.dll',8272224],
    ['HighPass','plugins\\afx\\HighPass.dll',8257376],
    ['LowPass','plugins\\afx\\LowPass.dll',8257376]
  ];

  const hostConfiguration={
    ffgl:['FFGL Plugin Directories','Add a plug-in directory','Remove the selected plug-in directory'],
    vst:['VST Plugin Directories','Add a VST Directory','Remove the selected VST Directory','Open the custom UI for this VST plugin'],
    wire:['Create a new source, mixer or effect in SHOWAVE Forge','Edit this patch in SHOWAVE Forge','Create a copy of this patch and edit it in SHOWAVE Forge'],
    isf:['Create or import a shader in the Wire node panel','Assign an ISF resource to the main inlet','Vertex shaders are not supported by Wire']
  };

  const records=[];
  const byRoleName=new Map();
  const byId=new Map();
  const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const roleMap=(role,track)=>role==='source' ? live.videoSources||{}
    : track==='audio' ? live.audioEffects||{} : live.videoEffects||{};
  const nativeDescription=(role,track,name)=>roleMap(role,track)[name]||null;
  const exactPresetSpec=name=>{
    const entries=Object.values(presetRegistry.effects||{});
    return entries.find(entry=>entry && entry.label===name)||null;
  };
  const audioSpecs=typeof AUDIO_EFFECT_PARAMS!=='undefined' ? AUDIO_EFFECT_PARAMS : {};

  function add(record){
    const frozen=Object.freeze(record);
    records.push(frozen);
    if(record.role && record.name){
      byRoleName.set([record.role,record.track||'video',record.name].join('\u0000'),frozen);
    }
    [record.id,record.nativeId].filter(Boolean).forEach(id=>byId.set(String(id),frozen));
    return frozen;
  }

  FFGL_PRESET_EVIDENCE.forEach(([name,nativeId,file,presetFile])=>{
    const native=nativeDescription('effect','video',name)||{};
    const spec=exactPresetSpec(name);
    add({
      technology:'ffgl', badge:'FFGL', role:'effect', track:'video', name,
      id:native.id||nativeId, nativeId, description:native.d||'',
      file, presetFile, platformEvidence:'macOS path serialized by an Arena 6 preset',
      host:'Arena FFGL host', browserNativeHost:false,
      blockedReason:'Native FFGL execution needs Arena or another FFGL host; this browser runtime cannot load the serialized plug-in binary.',
      configuration:copy(spec&&spec.params||{}),
      configurationSurface:hostConfiguration.ffgl.slice()
    });
  });

  Object.keys(wired).sort().forEach(name=>{
    const patch=wired[name]||{};
    const role=patch.category;
    const native=(role==='effect'||role==='source')
      ? nativeDescription(role,'video',name)||{} : {};
    add({
      technology:'wire', badge:'WIRE', role, track:'video', name,
      id:native.id||null, nativeId:patch.identifier||null,
      description:native.d||patch.description||'', file:patch.file||null,
      bytes:Number.isFinite(patch.bytes)?patch.bytes:null,
      author:patch.author||'', vendor:patch.vendor||'', url:patch.url||'',
      resolution:copy(patch.resolution||null),
      deploymentTarget:copy(patch.deploymentTarget||null),
      originalTarget:copy(patch.originalTarget||null),
      saveTarget:copy(patch.saveTarget||null),
      platformEvidence:'shipped Wire patch captured from Arena 7.27.1 for Windows',
      host:'Resolume Wire/Arena host', browserNativeHost:false,
      blockedReason:'Native Wire execution needs the Wire/Arena patch runtime; this browser cannot compile or execute a .wired bundle.',
      configuration:copy(patch.params||[]),
      configurationSurface:hostConfiguration.wire.slice()
    });
  });

  AFX_INSTALL_EVIDENCE.forEach(([name,file,bytes])=>{
    const native=nativeDescription('effect','audio',name)||{};
    add({
      technology:'arena-afx', badge:'AFX', role:'effect', track:'audio', name,
      id:native.id||name, description:native.d||'', file, bytes,
      platformEvidence:'Windows DLL in the captured Arena 7.27.1 plugins/afx directory',
      host:'Arena native audio-effect host', browserNativeHost:false,
      blockedReason:'This native Arena audio module cannot be loaded by a browser; SHOWAVE may provide an independent WebAudio equivalent.',
      configuration:copy(audioSpecs[name]||[]), configurationSurface:[]
    });
  });

  const VST_HOST=Object.freeze({
    technology:'vst', badge:'VST', role:'effect', browserRole:'effect', track:'audio',
    name:'VST Plugin Directories', browserLabel:'VST plug-ins: none discovered',
    catalogOnly:true, discoveredCount:0, host:'Arena VST host', browserNativeHost:false,
    platformEvidence:'captured Arena 7.27.1 Windows user extension registry',
    description:'The captured user extension registry contains no VST Effect or Source entries.',
    blockedReason:'No local VST plug-in identity was discovered, and this browser runtime has no native VST host.',
    configuration:{}, configurationSurface:hostConfiguration.vst.slice()
  });
  const FFGL_SOURCE_HOST=Object.freeze({
    technology:'ffgl', badge:'FFGL', role:'source', browserRole:'source', track:'video',
    name:'FFGL Plugin Directories', browserLabel:'FFGL Sources: none discovered',
    catalogOnly:true, discoveredCount:0, host:'Arena FFGL host', browserNativeHost:false,
    platformEvidence:'captured Arena 7.27.1 Windows user extension registry',
    description:'Arena can list generative FFGL plug-ins as Sources, but no local FFGL Source identity was present in the captured extension registry.',
    blockedReason:'No local FFGL Source plug-in identity was discovered, and this browser runtime has no native FFGL host.',
    configuration:{}, configurationSurface:hostConfiguration.ffgl.slice()
  });
  const ISF_RESOURCE=Object.freeze({
    technology:'isf', badge:'ISF', role:'resource', browserRole:'effect', track:'video',
    name:'ISF Resource', browserLabel:'ISF Resource: Wire node, not an Effect/Source',
    catalogOnly:true, host:'Resolume Wire resource/node runtime', browserNativeHost:false,
    platformEvidence:'shipped Wire node documentation and ISF_Example.isf resource',
    description:'Interactive Shader Format is exposed here as a Wire shader node/resource. It is not a clip Source or Effect by itself.',
    blockedReason:'ISF execution needs Wire\'s shader/resource runtime; this browser has no compatible ISF compiler or host.',
    configuration:{resourceType:'resourceIsf',vertexShaders:false},
    configurationSurface:hostConfiguration.isf.slice()
  });
  const informationRecords=Object.freeze([VST_HOST,FFGL_SOURCE_HOST,ISF_RESOURCE]);

  function lookup(role,track,name){
    return byRoleName.get([role,track==='audio'?'audio':'video',name].join('\u0000'))||null;
  }
  function findById(id){ return byId.get(String(id))||null; }
  function all(){ return records.slice(); }
  function byTechnology(technology){ return records.filter(record=>record.technology===technology); }
  function information(role){ return informationRecords.filter(record=>record.browserRole===role); }
  function browserGroups(role){
    const info=information(role);
    return info.length ? [{
      group:'Plugin Host Status', kind:role, track:role==='effect'?'video':'video',
      catalogOnly:true, items:info.map(record=>record.browserLabel), raw:info.slice()
    }] : [];
  }
  function describe(record){
    if(!record) return '';
    const lines=[];
    if(record.description) lines.push(record.description);
    lines.push('Technology: '+String(record.technology||'unknown').toUpperCase()
      +' · role: '+record.role+(record.track?' · '+record.track:''));
    if(record.id) lines.push('Arena runtime ID: '+record.id);
    if(record.nativeId && record.nativeId!==record.id) lines.push('Native ID: '+record.nativeId);
    if(record.file) lines.push('File evidence: '+record.file+(record.bytes?' ('+record.bytes+' bytes)':''));
    if(record.author||record.vendor) lines.push('Author/vendor: '+[record.author,record.vendor].filter(Boolean).join(' · '));
    if(record.resolution) lines.push('Patch resolution: '+record.resolution.width+'×'+record.resolution.height);
    if(record.deploymentTarget&&record.deploymentTarget.version){
      const version=record.deploymentTarget.version;
      lines.push('Wire target: '+record.deploymentTarget.name+' '
        +[version.major,version.minor,version.patch].join('.'));
    }
    if(record.host) lines.push('Native host: '+record.host);
    if(record.platformEvidence) lines.push('Platform evidence: '+record.platformEvidence);
    const config=record.configuration||{};
    const count=Array.isArray(config) ? config.length : Object.keys(config).length;
    if(count){
      const names=Array.isArray(config)
        ? config.map(item=>item&&item.n).filter(Boolean) : Object.keys(config);
      lines.push('Authoritative configuration: '+count+' parameter'+(count===1?'':'s')
        +(names.length?' · '+names.join(', '):''));
    }
    if(record.configurationSurface&&record.configurationSurface.length)
      lines.push('Configuration surface: '+record.configurationSurface.join(' · '));
    if(record.blockedReason) lines.push('Native host blocked: '+record.blockedReason);
    return lines.join('\n');
  }

  root.ArenaPluginCatalog=Object.freeze({
    all,lookup,findById,byTechnology,information,browserGroups,describe,
    hostConfiguration:Object.freeze(copy(hostConfiguration)),
    summary:Object.freeze({
      ffglEffects:FFGL_PRESET_EVIDENCE.length,
      ffglSources:0,
      vstPlugins:0,
      wireSources:records.filter(record=>record.technology==='wire'&&record.role==='source').length,
      wireEffects:records.filter(record=>record.technology==='wire'&&record.role==='effect').length,
      wireMixers:records.filter(record=>record.technology==='wire'&&record.role==='mixer').length,
      isfResources:1,
      arenaAudioModules:AFX_INSTALL_EVIDENCE.length
    })
  });
})(window);
