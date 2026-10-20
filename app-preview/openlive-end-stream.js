/* Confirmation boundary for ending a Broadcast run. No media, network or
   storage access: read/stop belong to the actual Broadcast lifecycle. */
window.OpenLiveEndStream = (() => {
  'use strict';
  function create(options) {
    let phase = 'closed', summary = null, targets = [], error = '', needsReconfirm = false;
    let pending = null, warnings = [];
    const state = () => ({ phase, summary, error, needsReconfirm, warnings:warnings.slice() });
    const publish = () => { if (options.change) options.change(state()); };
    function open() {
      if (pending) return false;
      const run = options.read();
      if (!run || !run.targets.length) return false;
      targets = run.targets.slice();
      summary = { title:run.title, thumbnail:run.thumbnail || '', kind:run.kind,
        channelCount:run.channelCount || 0, recordings:!!run.recordings };
      phase = 'confirm'; error = ''; warnings = []; needsReconfirm = false; publish(); return true;
    }
    function cancel() {
      if (pending || phase === 'stopping') return false;
      phase = 'closed'; summary = null; targets = []; error = ''; warnings = []; publish(); return true;
    }
    function confirm() {
      if (pending) return pending;
      if (!['confirm','failed'].includes(phase) || needsReconfirm) return Promise.resolve(false);
      const current = options.read();
      if (current && current.targets.some(target => !targets.includes(target))) {
        phase = 'failed'; needsReconfirm = true;
        error = 'The active broadcast changed. Close this dialog and review the current run before ending it.';
        publish(); return Promise.resolve(false);
      }
      if (!current || !current.targets.length) {
        phase = 'complete'; error = ''; publish(); return Promise.resolve(true);
      }
      phase = 'stopping'; error = ''; warnings = [];
      // Install the single-flight promise before notifying a potentially
      // synchronous UI callback; repeated End Now clicks cannot stop twice.
      pending = Promise.resolve().then(() => options.stop()).then(result => {
        const remaining = options.read();
        const errors = result && Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
        warnings = result && Array.isArray(result.warnings)
          ? result.warnings.filter(value => typeof value === 'string' && value.trim()) : [];
        if (remaining && remaining.targets.length && !errors.length)
          errors.push('Some outputs still need cleanup. Retry End; completion has not been confirmed.');
        error = errors.join('\n'); phase = error ? 'failed' : 'complete';
        return !error;
      }).catch(reason => {
        phase = 'failed'; error = reason && reason.message || String(reason); return false;
      }).finally(() => { pending = null; publish(); });
      publish();
      return pending;
    }
    return Object.freeze({ open, cancel, confirm, state });
  }
  return Object.freeze({ create });
})();
