/* ===========================================================================
   OpenLive Transform 3D
   ---------------------------------------------------------------------------
   Resolume's Transform is a plane in 3D space: Rotation expands to X, Y and Z
   axes, and every Clip, Layer, Group and Composition owns one. Canvas2D only
   has an affine 2D transform, so pretending X/Y are extra scale controls makes
   the parameter look active while producing the wrong geometry.

   This module uploads the already-rendered scope texture once, rotates the
   four plane vertices in a WebGL vertex shader, and hands the completed GPU
   canvas straight back to Canvas2D. There is no getImageData/readPixels path.

   The support article documents the three axes and the anchor-point pivot but
   does not publish Arena's camera/focal length. We therefore use the smallest
   defensible projection: orthographic, with X then Y then Z rotation. The
   projection is explicit and testable instead of inventing an undocumented
   perspective value. [https://resolume.com/support/en/transform]
   =========================================================================== */
(() => {
'use strict';

const ROOT = typeof window !== 'undefined' ? window : globalThis;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const radians = degrees => finite(degrees, 0) * Math.PI / 180;

function resolvedSpec(spec){
  spec = spec || {};
  return {
    positionX: finite(spec.positionX, 0),
    positionY: finite(spec.positionY, 0),
    anchorX: finite(spec.anchorX, 0),
    anchorY: finite(spec.anchorY, 0),
    scaleX: finite(spec.scaleX, 1),
    scaleY: finite(spec.scaleY, 1),
    rotationX: radians(spec.rotationX),
    rotationY: radians(spec.rotationY),
    rotationZ: radians(spec.rotationZ)
  };
}

/* Pure copy of the vertex transform. Keeping this beside the shader gives the
   compositor regression tests deterministic corner geometry without standing
   up a browser or reading pixels back from the production renderer. */
function projectPlaneCorners(width, height, spec){
  const w = Math.max(1, finite(width, 1));
  const h = Math.max(1, finite(height, 1));
  const p = resolvedSpec(spec);
  const pivotX = w / 2 + p.anchorX;
  const pivotY = h / 2 + p.anchorY;
  const cx = Math.cos(p.rotationX), sx = Math.sin(p.rotationX);
  const cy = Math.cos(p.rotationY), sy = Math.sin(p.rotationY);
  const cz = Math.cos(p.rotationZ), sz = Math.sin(p.rotationZ);
  return [[0,0],[w,0],[0,h],[w,h]].map(([screenX,screenY]) => {
    let x = (screenX - pivotX) * p.scaleX;
    let y = (screenY - pivotY) * p.scaleY;
    let z = 0;
    /* X -> Y -> Z, in the same y-down coordinate system Canvas2D uses. */
    let nextY = cx * y - sx * z;
    let nextZ = sx * y + cx * z;
    y = nextY; z = nextZ;
    let nextX = cy * x + sy * z;
    nextZ = -sy * x + cy * z;
    x = nextX; z = nextZ;
    nextX = cz * x - sz * y;
    nextY = sz * x + cz * y;
    x = nextX; y = nextY;
    return {x:x + pivotX + p.positionX, y:y + pivotY + p.positionY, z};
  });
}

function compile(gl, type, source){
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
    const reason = gl.getShaderInfoLog(shader) || 'Transform 3D shader compilation failed';
    gl.deleteShader(shader);
    throw new Error(reason);
  }
  return shader;
}

function createRenderer(){
  if(typeof document === 'undefined' || !document.createElement) return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha:true, antialias:true, depth:false, stencil:false,
    premultipliedAlpha:true, preserveDrawingBuffer:false,
    desynchronized:true, powerPreference:'high-performance'
  }) || canvas.getContext('webgl', {
    alpha:true, antialias:true, depth:false, stencil:false,
    premultipliedAlpha:true, preserveDrawingBuffer:false,
    desynchronized:true, powerPreference:'high-performance'
  });
  if(!gl) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER,
    'attribute vec2 a_corner;\n' +
    'uniform vec2 u_size;\n' +
    'uniform vec2 u_pivot;\n' +
    'uniform vec2 u_position;\n' +
    'uniform vec2 u_scale;\n' +
    'uniform vec3 u_rotation;\n' +
    'uniform vec2 u_sourceScale;\n' +
    'varying vec2 v_uv;\n' +
    'void main(){\n' +
    '  vec3 p = vec3((a_corner * u_size - u_pivot) * u_scale, 0.0);\n' +
    '  float cx=cos(u_rotation.x), sx=sin(u_rotation.x);\n' +
    '  float cy=cos(u_rotation.y), sy=sin(u_rotation.y);\n' +
    '  float cz=cos(u_rotation.z), sz=sin(u_rotation.z);\n' +
    '  p = vec3(p.x, cx*p.y - sx*p.z, sx*p.y + cx*p.z);\n' +
    '  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);\n' +
    '  p = vec3(cz*p.x - sz*p.y, sz*p.x + cz*p.y, p.z);\n' +
    '  vec2 pixel = p.xy + u_pivot + u_position;\n' +
    '  vec2 clip = vec2(pixel.x/u_size.x*2.0-1.0, 1.0-pixel.y/u_size.y*2.0);\n' +
    '  gl_Position = vec4(clip, 0.0, 1.0);\n' +
    '  v_uv = vec2(a_corner.x*u_sourceScale.x, (1.0-a_corner.y)*u_sourceScale.y);\n' +
    '}');
  const fragment = compile(gl, gl.FRAGMENT_SHADER,
    'precision highp float;\n' +
    'uniform sampler2D u_texture;\n' +
    'varying vec2 v_uv;\n' +
    'void main(){ gl_FragColor = texture2D(u_texture, v_uv); }');
  const program = gl.createProgram();
  gl.attachShader(program, vertex); gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if(!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) || 'Transform 3D shader link failed');

  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uniform = name => gl.getUniformLocation(program, name);
  const locations = {
    corner:gl.getAttribLocation(program,'a_corner'),
    size:uniform('u_size'), pivot:uniform('u_pivot'), position:uniform('u_position'),
    scale:uniform('u_scale'), rotation:uniform('u_rotation'),
    sourceScale:uniform('u_sourceScale'), texture:uniform('u_texture')
  };
  let canvasWidth=0, canvasHeight=0, textureWidth=0, textureHeight=0, lost=false;
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); lost=true;
  });

  function ensureCapacity(width,height){
    if(width>canvasWidth || height>canvasHeight){
      canvasWidth=Math.max(canvasWidth,width);
      canvasHeight=Math.max(canvasHeight,height);
      canvas.width=canvasWidth; canvas.height=canvasHeight;
    }
    if(width>textureWidth || height>textureHeight){
      textureWidth=Math.max(textureWidth,width);
      textureHeight=Math.max(textureHeight,height);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,textureWidth,textureHeight,0,
                    gl.RGBA,gl.UNSIGNED_BYTE,null);
    }
  }

  return {
    get lost(){ return lost; },
    render(source,spec,width,height){
      const w=Math.max(1,Math.round(finite(width,1)));
      const h=Math.max(1,Math.round(finite(height,1)));
      if(lost || !source || !(source.width>0) || !(source.height>0)) return null;
      ensureCapacity(w,h);
      const p=resolvedSpec(spec);

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER,corners);
      gl.enableVertexAttribArray(locations.corner);
      gl.vertexAttribPointer(locations.corner,2,gl.FLOAT,false,0,0);
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST);
      /* Keep the current frame at the top-left of the grow-only drawing buffer.
         Canvas2D can then copy [0,0,w,h] without forcing the GL canvas to resize
         as differently-sized Layer textures alternate at 60 fps. */
      gl.viewport(0,canvasHeight-h,w,h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0,canvasHeight-h,w,h);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
      gl.uniform1i(locations.texture,0);
      gl.uniform2f(locations.size,w,h);
      gl.uniform2f(locations.pivot,w/2+p.anchorX,h/2+p.anchorY);
      gl.uniform2f(locations.position,p.positionX,p.positionY);
      gl.uniform2f(locations.scale,p.scaleX,p.scaleY);
      gl.uniform3f(locations.rotation,p.rotationX,p.rotationY,p.rotationZ);
      gl.uniform2f(locations.sourceScale,w/textureWidth,h/textureHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      gl.disable(gl.SCISSOR_TEST);
      return {canvas,sx:0,sy:0,width:w,height:h};
    }
  };
}

let RENDERER=null, RENDERER_TRIED=false;
function renderer(){
  if(!RENDERER_TRIED || (RENDERER && RENDERER.lost)){
    RENDERER_TRIED=true;
    try { RENDERER=createRenderer(); }
    catch(error){ RENDERER=null; }
  }
  return RENDERER;
}

ROOT.OpenLiveTransform3D = {
  projectPlaneCorners,
  render(source,spec,width,height){
    const active=renderer();
    if(!active) return null;
    try { return active.render(source,spec,width,height); }
    catch(error){ return null; }
  },
  available(){ return !!renderer(); },
  projection:'orthographic',
  rotationOrder:'X-Y-Z'
};
})();
