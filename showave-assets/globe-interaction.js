/* One orientation controller keeps the native and compatibility globes in sync. */
const TAU = Math.PI * 2;
const PITCH_LIMIT = 1.1;
const TOUCH_INTENT = 6;
const KEY_STEP = Math.PI / 24;
const INTERACTIVE = 'a, button, input, select, textarea, form, [contenteditable="true"], [role="button"], [role="link"]';
const INSTRUCTIONS = 'SHOWAVE connections from Kampala, Uganda, to the world. Illustrative routes. Drag to rotate the globe. Use arrow keys to rotate, or Home to reset.';

function rememberStyle(element, property) {
  const value = element.style.getPropertyValue(property);
  const priority = element.style.getPropertyPriority(property);
  return () => {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  };
}

function rememberAttribute(element, name) {
  const value = element.getAttribute(name);
  return () => {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  };
}

export function createGlobeInteraction(canvas) {
  let yaw = 0;
  let pitch = 0;
  let binding = null;
  let active = null;
  let destroyed = false;
  const touches = new Set();

  function setDragging(dragging) {
    if (!binding) return;
    const cursor = dragging ? 'grabbing' : 'grab';
    binding.canvas.style.setProperty('cursor', cursor);
    binding.host.style.setProperty('cursor', cursor);
    if (dragging) binding.canvas.dataset.showaveInteracting = 'true';
    else delete binding.canvas.dataset.showaveInteracting;
  }

  function release() {
    const pointer = active;
    active = null;
    setDragging(false);
    if (!pointer || !binding) return;
    try {
      if (binding.host.hasPointerCapture(pointer.id)) binding.host.releasePointerCapture(pointer.id);
    } catch { /* The browser may already have released a cancelled pointer. */ }
  }

  function capture(pointerId) {
    try { binding.host.setPointerCapture(pointerId); } catch { /* Detached elements cannot capture. */ }
  }

  function focusCanvas() {
    try { binding.canvas.focus({ preventScroll: true }); } catch { /* A detached canvas may not focus. */ }
  }

  function rotate(dx, dy, sensitivity) {
    yaw += dx * sensitivity;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + dy * sensitivity));
  }

  function onPointerDown(event) {
    const interactive = event.target?.closest?.(INTERACTIVE);
    if (interactive && binding.host.contains(interactive)) return;
    const isTouch = event.pointerType === 'touch';
    if (isTouch) touches.add(event.pointerId);
    // A second finger belongs to the browser's pinch or page gesture.
    if (isTouch && (touches.size > 1 || event.isPrimary === false)) {
      release();
      return;
    }
    if (active || (!isTouch && (event.button !== 0 || event.isPrimary === false))) return;
    const bounds = binding.canvas.getBoundingClientRect();
    const shortestSide = Math.min(bounds.width, bounds.height);
    active = {
      id: event.pointerId,
      type: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      sensitivity: TAU / Math.max(1, shortestSide || 600)
    };
    if (!isTouch) {
      capture(event.pointerId);
      focusCanvas();
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    if (!active || active.id !== event.pointerId) return;
    if (active.type !== 'touch' && event.buttons === 0) {
      release();
      return;
    }
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (!active.dragging) {
      if (active.type === 'touch') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < TOUCH_INTENT) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          // Never cancel a vertical swipe: touch-action leaves page scrolling intact.
          release();
          return;
        }
        capture(event.pointerId);
        focusCanvas();
      } else if (dx === 0 && dy === 0) return;
      active.dragging = true;
      setDragging(true);
    }
    rotate(dx, dy, active.sensitivity);
    active.x = event.clientX;
    active.y = event.clientY;
    event.preventDefault();
  }

  function onPointerEnd(event) {
    touches.delete(event.pointerId);
    if (active?.id === event.pointerId) release();
  }

  function onLostCapture(event) {
    // Moving implicit touch capture from the child canvas to its parent also
    // emits this event on the child; only the parent's capture ends our drag.
    if (event.target === binding?.host && active?.id === event.pointerId) release();
  }

  function onKeyDown(event) {
    if (event.target !== binding.canvas || binding.canvas.ownerDocument.activeElement !== binding.canvas) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowLeft': yaw -= KEY_STEP; break;
      case 'ArrowRight': yaw += KEY_STEP; break;
      case 'ArrowUp': pitch = Math.max(-PITCH_LIMIT, pitch - KEY_STEP); break;
      case 'ArrowDown': pitch = Math.min(PITCH_LIMIT, pitch + KEY_STEP); break;
      case 'Home': yaw = 0; pitch = 0; break;
      default: return;
    }
    event.preventDefault();
  }

  function detach() {
    if (!binding) return;
    release();
    touches.clear();
    const { canvas: attachedCanvas, host, restore } = binding;
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerEnd);
    host.removeEventListener('pointercancel', onPointerEnd);
    host.removeEventListener('lostpointercapture', onLostCapture);
    attachedCanvas.removeEventListener('keydown', onKeyDown);
    for (const reset of restore) reset();
    delete attachedCanvas.dataset.showaveInteracting;
    binding = null;
  }

  function attach(nextCanvas) {
    if (destroyed || !nextCanvas) return nextCanvas;
    const host = nextCanvas.closest('.home-hero-globe') || nextCanvas.parentElement || nextCanvas;
    if (binding?.canvas === nextCanvas && binding.host === host) return nextCanvas;
    detach();
    const restore = [];
    for (const element of new Set([nextCanvas, host])) {
      restore.push(rememberStyle(element, 'touch-action'), rememberStyle(element, 'cursor'));
      element.style.setProperty('touch-action', 'pan-y pinch-zoom');
      element.style.setProperty('cursor', 'grab');
    }
    for (const name of ['tabindex', 'role', 'aria-label', 'aria-roledescription', 'aria-keyshortcuts']) {
      restore.push(rememberAttribute(nextCanvas, name));
    }
    nextCanvas.setAttribute('tabindex', '0');
    nextCanvas.setAttribute('role', 'img');
    nextCanvas.setAttribute('aria-roledescription', 'interactive globe');
    nextCanvas.setAttribute('aria-label', INSTRUCTIONS);
    nextCanvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Home');
    binding = { canvas: nextCanvas, host, restore };
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove, { passive: false });
    host.addEventListener('pointerup', onPointerEnd);
    host.addEventListener('pointercancel', onPointerEnd);
    host.addEventListener('lostpointercapture', onLostCapture);
    nextCanvas.addEventListener('keydown', onKeyDown);
    return nextCanvas;
  }

  attach(canvas);
  return {
    getState() { return { yaw, pitch, isInteracting: !!active }; },
    attach,
    detach,
    destroy() {
      detach();
      destroyed = true;
    }
  };
}
