/* Scoped channel controls. Actual selection, start and confirmed cleanup belong
   to Broadcast; this boundary reads their current state before every action. */
window.OpenLiveProviderControls = (() => {
  'use strict';
  const activeStates = new Set(['connecting', 'starting', 'live', 'reconnecting', 'stop-failed']);
  const cleanupStates = new Set(['failed', 'finish-failed', 'cleanup', 'cleanup-pending']);
  const idKey = id => (typeof id === 'string' && id.trim() ||
    typeof id === 'number' && Number.isFinite(id)) ? String(id) : null;
  const blocked = reason => ({ disabled:!!reason, reason:reason || '' });
  const ending = row => !!(row.record && (row.record.finalizing || row.record.state === 'stopping'));
  const active = row => !!(row.record && activeStates.has(String(row.record.state || '')));
  const needsEnd = row => !!(row.record && (active(row) || ending(row) ||
    cleanupStates.has(String(row.record.state || '')) || row.record.session ||
    row.record.provisionCleanupPending || !row.record.finalized &&
    (row.record.broadcastId || row.record.streamId)));

  function create(options) {
    function snapshot(ids) {
      const keys = [], seen = new Set();
      let scopeError = '';
      if (!Array.isArray(ids)) scopeError = 'Choose a channel to control.';
      else ids.forEach(id => {
        const key = idKey(id);
        if (key === null) scopeError = 'The channel selection is invalid.';
        else if (!seen.has(key)) { seen.add(key); keys.push(key); }
      });
      let state;
      try { state = options.read(); }
      catch (_) { scopeError = 'Channel status is unavailable. Refresh before continuing.'; }
      if (!state || !Array.isArray(state.rows)) {
        state = {rows:[]};
        scopeError = scopeError || 'Channel status is unavailable. Refresh before continuing.';
      }
      const current = new Map();
      state.rows.forEach(row => {
        if (!row) return;
        const key = idKey(row.id);
        if (key !== null && !current.has(key)) current.set(key, row);
      });
      const rows = keys.map(key => current.get(key)).filter(Boolean);
      if (rows.length !== keys.length)
        scopeError = scopeError || 'A channel is no longer connected. Review the current channels.';
      if (!rows.length) scopeError = scopeError || 'No channels are connected.';
      return {state, rows, scopeError};
    }

    function describeSnapshot({state, rows, scopeError}) {
      const count = rows.length, selectedCount = rows.filter(row => row.enabled === true).length;
      const allOn = count > 0 && count === selectedCount;
      const unavailable = rows.find(row => row.enabled !== true && (!row.selection || row.selection.ok !== true));
      const selectionReason = scopeError || state.selectionBlock || (!allOn && unavailable &&
        (unavailable.selection && unavailable.selection.why || 'This channel cannot be selected.')) || '';
      const unready = rows.find(row => !row.preflight || row.preflight.ok !== true);
      const outstanding = rows.some(row => !!row.record);
      const goReason = scopeError || (outstanding && 'End the current output or finish its cleanup before starting again.') ||
        state.startBlock || (!allOn && 'Turn every selected channel On before Go Live.') ||
        (unready && (unready.preflight && unready.preflight.why || 'Channel readiness has not been confirmed.')) || '';
      const endingReason = rows.some(ending) ? 'Ending is already in progress.' : '';
      return {
        count, selectedCount,
        selection:{enabled:allOn, mixed:selectedCount > 0 && !allOn, ...blocked(selectionReason)},
        go:blocked(goReason),
        stop:blocked(scopeError || state.endBlock || endingReason || (!rows.some(active) && 'No active outputs to stop.') || ''),
        end:blocked(scopeError || state.endBlock || endingReason || (!rows.some(needsEnd) && 'No active outputs or pending cleanup to end.') || ''),
        rows
      };
    }

    function describe(ids) { return describeSnapshot(snapshot(ids)); }
    function act(ids, action) {
      // Never trust disabled attributes or state captured when a row was drawn.
      const fresh = snapshot(ids), view = describeSnapshot(fresh);
      try {
        if (action === 'toggle') {
          return !view.selection.disabled && options.select(view.rows.map(row => row.id), !view.selection.enabled) === true;
        }
        if (action === 'go') {
          return !view.go.disabled && options.start(view.rows.map(row => row.id)) === true;
        }
        if (action === 'stop' || action === 'end') {
          if (view[action].disabled) return false;
          const targets = view.rows.filter(action === 'stop' ? active : needsEnd).map(row => row.id);
          // Stop and End both open Broadcast's existing confirmation. Neither
          // pretends to pause media while leaving the platform broadcast open.
          return options.end(targets, action === 'stop' ? 'Stop' : 'End') === true;
        }
      } catch (_) { return false; }
      return false;
    }
    return Object.freeze({ describe, act });
  }
  return Object.freeze({ create });
})();
