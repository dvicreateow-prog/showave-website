/* Read-only scene multiview. No source capture, audio routing, saves or takes.
   The caller paints Master Preview first, then shares that exact frame here. */
window.OpenLiveSceneMonitors = (() => {
  'use strict';
  function create({studio, document, root}) {
    const entries = new Map(), view = document.defaultView;
    let disposed = false;
    function attach(scene, host, status, mode) {
      let entry = entries.get(scene.id);
      if (!entry) {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        canvas.setAttribute('aria-hidden', 'true');
        entry = {canvas}; entries.set(scene.id, entry);
      }
      Object.assign(entry, {host, status, mode, checkedAt:-Infinity});
      host.prepend(entry.canvas); // Reuse the last frame through rail rebuilds.
      return entry.canvas;
    }
    function retain(ids) {
      const keep = new Set(ids);
      for (const [id, entry] of entries) if (!keep.has(id)) {
        entry.canvas.remove(); entries.delete(id);
      }
    }
    function message(entry, text, detail = text) {
      if (entry.status.textContent !== text) entry.status.textContent = text;
      entry.status.hidden = !text;
      entry.status.title = detail;
    }
    function frame(time, preview = null) {
      if (disposed) return;
      if (document.hidden || !studio.running) { studio.setSceneMonitorScenes([]); return; }
      const bounds = root.getBoundingClientRect(), scenes = new Map(studio.scenes().map(s => [s.id,s]));
      const visible = [];
      // Read geometry before painting or resizing any canvas.
      for (const [id, entry] of entries) {
        const rect = entry.host.getBoundingClientRect();
        if (!scenes.has(id) || !entry.host.isConnected || rect.width <= 0 || rect.height <= 0 ||
            rect.bottom <= Math.max(0,bounds.top) || rect.top >= Math.min(view.innerHeight,bounds.bottom) ||
            rect.right <= Math.max(0,bounds.left) || rect.left >= Math.min(view.innerWidth,bounds.right)) continue;
        visible.push({id, entry, width:rect.width});
      }
      studio.setSceneMonitorScenes(visible.map(row => row.id));
      for (const {id,entry,width} of visible) {
        const cv = entry.canvas, mirror = preview?.sceneId === id ? preview : null;
        const w = Math.min(640,Math.max(160,Math.round(width * Math.min(2,view.devicePixelRatio || 1))));
        const h = Math.round(w * 9/16);
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        const mode = mirror?.draft ? 'Preview mix' : 'Full mix';
        if (entry.mode.textContent !== mode) entry.mode.textContent = mode;
        entry.mode.title = mirror?.draft ? 'Mirrors the staged Master Preview; not saved into the scene yet.' : 'Live visual mix of this scene; monitoring is silent.';
        try {
          if (mirror?.canvas) {
            const ctx = cv.getContext('2d');
            ctx.clearRect(0,0,w,h);
            ctx.drawImage(mirror.canvas,0,0,w,h);
          } else if (mirror?.draft) {
            cv.getContext('2d').clearRect(0,0,w,h);
          } else studio.renderSceneMonitor(cv,id,time);
          if (mirror?.draft) {
            message(entry,mirror.state === 'ready' ? '' : ['failed','error','stale'].includes(mirror.state) ? 'Preview unavailable' : 'Preparing preview…',mirror.message);
            entry.checkedAt = -Infinity;
          } else if (time - entry.checkedAt >= 250) {
            const state = studio.visualStatus(scenes.get(id),'16x9');
            message(entry,state.ok ? '' : /^Nothing to encode/.test(state.why) ? 'Empty scene' :
              /^Waiting/.test(state.why) ? 'Preparing mix…' : 'Mix needs attention',state.why);
            entry.checkedAt = time;
          }
        } catch (error) {
          cv.getContext('2d').clearRect(0,0,w,h);
          message(entry,'Preview unavailable',error.message || String(error));
        }
      }
    }
    function visibility() { if (document.hidden) studio.setSceneMonitorScenes([]); }
    document.addEventListener('visibilitychange',visibility);
    function dispose() {
      disposed = true; studio.setSceneMonitorScenes([]); entries.clear();
      document.removeEventListener('visibilitychange',visibility);
    }
    return {attach,retain,frame,dispose};
  }
  return {create};
})();
