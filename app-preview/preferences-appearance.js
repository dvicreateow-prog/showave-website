/* Preferences > Appearance
   -------------------------------------------------------------------------
   Thin UI binding over OpenLiveAppearance. The shared appearance service owns
   validation, token derivation, persistence and cross-window synchronisation;
   this controller only mirrors state into native controls.
   ------------------------------------------------------------------------- */
(function openLivePreferencesAppearance(global) {
  'use strict';

  const document = global.document;
  if (!document || !document.querySelector('[data-appearance-managed]')) return;

  const byId = id => document.getElementById(id);
  const themeInputs = [...document.querySelectorAll('input[name="appearanceTheme"]')];
  const modeInputs = [...document.querySelectorAll('input[name="appearanceMode"]')];
  const customPanel = byId('appearanceCustomControls');
  const resetButton = byId('appearanceCustomReset');
  const saveButton = byId('appearanceSave');
  const status = byId('appearanceStatus');
  const saveLabel = byId('appearanceSaveLabel');
  const saveStatus = byId('appearanceSaveStatus');
  const fontScaleReset = byId('appearanceFontScaleReset');
  const restoreDefault = byId('appearanceRestoreDefault');
  const contrastReport = byId('appearanceContrastReport');
  const fontFamily = byId('appearanceFontFamily');
  const fontSearch = byId('appearanceFontSearch');
  const fontScale = byId('appearanceFontScale');
  const fontScaleValue = byId('appearanceFontScaleValue');
  const fontWeight = byId('appearanceFontWeight');
  const fontItalic = byId('appearanceFontItalic');
  const fontReset = byId('appearanceFontReset');
  const fontRefresh = byId('appearanceFontRefresh');
  const fontInventory = byId('appearanceFontInventory');
  let installedFonts = [];
  let loadingFonts = false;
  const customFields = {
    dark: {
      accent: byId('appearanceCustomDarkAccent'),
      base: byId('appearanceCustomDarkBase')
    },
    light: {
      accent: byId('appearanceCustomLightAccent'),
      base: byId('appearanceCustomLightBase')
    }
  };
  const customSwatches = {
    dark: {
      accent: byId('appearanceCustomDarkAccentSwatch'),
      base: byId('appearanceCustomDarkBaseSwatch'),
      summary: byId('appearanceCustomDarkSummary')
    },
    light: {
      accent: byId('appearanceCustomLightAccentSwatch'),
      base: byId('appearanceCustomLightBaseSwatch'),
      summary: byId('appearanceCustomLightSummary')
    }
  };

  let appearance = global.OpenLiveAppearance || null;
  let unsubscribe = null;
  let applying = false;

  const copy = value => JSON.parse(JSON.stringify(value));
  const validHex = value => /^#[0-9a-f]{6}$/i.test(String(value || ''));
  const upperHex = (value, fallback) => validHex(value) ? String(value).toUpperCase() : fallback;

  function getState() {
    return appearance && typeof appearance.getState === 'function' ? appearance.getState() : null;
  }

  function themes() {
    const source = appearance && appearance.themes;
    if (Array.isArray(source)) return source;
    return source && typeof source === 'object' ? Object.values(source) : [];
  }

  function themeName(id) {
    const record = themes().find(theme => theme && theme.id === id);
    return record && record.name || id || 'Theme';
  }

  function customDefaults() {
    const fromApi = appearance && appearance.defaults && appearance.defaults.custom;
    const customTheme = themes().find(theme => theme && theme.id === 'custom');
    const fallback = {
      /* glassy-style-nav has no accent token; its system-blue blob is the
         intentional inferred accent for the built-in Custom defaults. */
      dark: customTheme && customTheme.dark || { accent: '#0A84FF', base: '#000000' },
      light: customTheme && customTheme.light || { accent: '#007AFF', base: '#E5E5EA' }
    };
    const source = fromApi || fallback;
    return {
      dark: {
        accent: upperHex(source.dark && source.dark.accent, fallback.dark.accent),
        base: upperHex(source.dark && source.dark.base, fallback.dark.base)
      },
      light: {
        accent: upperHex(source.light && source.light.accent, fallback.light.accent),
        base: upperHex(source.light && source.light.base, fallback.light.base)
      }
    };
  }

  function setStatus(message, state) {
    if (!status) return;
    status.textContent = message || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  function paintSaveState() {
    const saved = appearance && typeof appearance.isSaved === 'function' && appearance.isSaved();
    if (saveLabel) saveLabel.textContent = saved ? 'Appearance saved' : 'Appearance preview';
    if (saveStatus) {
      saveStatus.textContent = saved ? 'Your palette and interface fonts will return when you reopen this browser.'
        : 'Changes are visible now. Save to keep them after restarting.';
      saveStatus.dataset.state = saved ? 'saved' : 'preview';
    }
  }

  function saveDescription() {
    const saved = appearance && typeof appearance.getSaveStatus === 'function' && appearance.getSaveStatus();
    if (saved && saved.saved) return 'Saved on this PC.';
    if (saved && saved.isDefault) return 'Startup default.';
    return 'Unsaved changes. Save appearance to keep this choice after restarting.';
  }

  const validFontName = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120
    && !/[\u0000-\u001f\u007f"';{}<>\\]/.test(value);
  function paintFontList() {
    if (!fontFamily) return;
    const state = getState(), selected = state && state.typography && state.typography.family || 'system';
    const query = (fontSearch && fontSearch.value || '').trim().toLocaleLowerCase();
    const options = [new Option('SHOWAVE default', 'system')];
    if (selected !== 'system' && !installedFonts.includes(selected)) options.push(new Option(`${selected}: unavailable on this PC`, selected));
    installedFonts.forEach(family => {
      if (family === selected || family.toLocaleLowerCase().includes(query)) options.push(new Option(family, family));
    });
    fontFamily.replaceChildren(...options);
    fontFamily.value = selected;
  }
  async function loadFonts() {
    if (loadingFonts || !fontFamily) return;
    loadingFonts = true;
    if (fontRefresh) fontRefresh.disabled = true;
    if (fontInventory) fontInventory.textContent = 'Reading installed font names…';
    try {
      const response = await global.fetch('/api/fonts/families', { cache: 'no-store' });
      if (!response.ok) throw new Error('The font list is unavailable.');
      const inventory = await response.json();
      if (!inventory.available || !Array.isArray(inventory.families)) throw new Error(inventory.reason || 'This system cannot list installed fonts.');
      installedFonts = [...new Set(inventory.families.filter(validFontName))].sort((a,b) => a.localeCompare(b));
      paintFontList();
      if (fontInventory) fontInventory.textContent = `${installedFonts.length} fonts available on this PC. Names only; no files are copied.`;
    } catch (_) {
      if (fontInventory) fontInventory.textContent = 'Installed fonts could not be listed. Reopen Preferences after restarting SHOWAVE; the default font remains available.';
    } finally {
      loadingFonts = false;
      if (fontRefresh) fontRefresh.disabled = false;
    }
  }
  function paintTypography(state) {
    const typography = state.typography || { family:'system', scale:100, weight:'default', italic:false };
    if (fontFamily && fontFamily.value !== typography.family) paintFontList();
    if (fontScale) fontScale.value = String(typography.scale);
    if (fontScaleValue) fontScaleValue.value = fontScaleValue.textContent = `${typography.scale}%`;
    if (fontWeight) fontWeight.value = typography.weight;
    if (fontItalic) fontItalic.checked = typography.italic;
  }

  function setCustomVisual(mode, pair) {
    const defaults = customDefaults()[mode];
    const accent = upperHex(pair && pair.accent, defaults.accent);
    const base = upperHex(pair && pair.base, defaults.base);
    const field = customFields[mode];
    const swatch = customSwatches[mode];
    if (field.accent) field.accent.value = accent;
    if (field.base) field.base.value = base;
    [field.accent, field.base].forEach(input => {
      const output = input && input.parentElement && input.parentElement.querySelector('output');
      if (output) output.value = output.textContent = input.value.toUpperCase();
    });
    /* The Custom tile is painted with the same two properties the other fifteen
       carry in their markup, not a fill-only colour: the chip's rim is mixed
       from --ap-accent, so writing the base alone framed the user's palette in
       whichever theme happened to be active. */
    if (swatch.accent) swatch.accent.style.setProperty('--ap-accent', accent);
    if (swatch.base) {
      swatch.base.style.setProperty('--ap-base', base);
      swatch.base.style.setProperty('--ap-accent', accent);
    }
    if (swatch.summary) swatch.summary.textContent = `${accent} / ${base}`;
  }

  /* THE HONESTY READOUT.
     -------------------------------------------------------------------------
     deriveTokens solves two weights against WCAG AA 4.5:1 -- the neutral text
     ramp against --btn-hi, and the chrome ink against --menu-bar -- and publishes
     what it actually achieved on `resolved.contrast`. All fifteen fixed palettes
     reach the target and the contrast contract asserts that. Custom cannot be
     asserted, because its base is the user's: greys around #757575 cannot reach
     4.5:1 in EITHER ink direction, and a wider band solves to a weight the ramp's
     ANCHOR_CAP then has to discard to keep the remap from inverting. Both cases
     ship text below the target.

     So the value is reported, not clamped-and-forgotten. Without this reader the
     published field had no consumer anywhere in the app, which makes it exactly
     the thing CLAUDE.md forbids: something that looks like it works and does
     nothing. Silent when the target is met -- an always-on badge saying "pass"
     would be noise, and would be a claim rather than a measurement. */
  const contrastCache = new Map();

  function measureCustom(mode, pair) {
    if (!appearance || typeof appearance.resolve !== 'function') return null;
    const defaults = customDefaults()[mode];
    const accent = upperHex(pair && pair.accent, defaults.accent);
    const base = upperHex(pair && pair.base, defaults.base);
    /* Memoised on the pair itself. A <input type="color"> drag fires `input`
       continuously, and each miss costs two 257-step solves; the cache keeps a
       held-down colour picker from re-deriving the same base sixty times a
       second. Nothing here is on a paint path either way. */
    const key = `${mode}:${accent}:${base}`;
    if (contrastCache.has(key)) return contrastCache.get(key);
    let report = null;
    try {
      const resolved = appearance.resolve({ theme: 'custom', mode, custom: { [mode]: { accent, base } } });
      report = resolved && resolved.contrast ? { base, contrast: resolved.contrast } : null;
    } catch (_) { report = null; }
    contrastCache.set(key, report);
    return report;
  }

  function shortfalls(mode, pair) {
    const measured = measureCustom(mode, pair);
    if (!measured) return [];
    const label = mode === 'dark' ? 'Dark' : 'Light';
    const target = Number(measured.contrast.target).toFixed(1);
    const lines = [];
    if (measured.contrast.reachable === false) {
      lines.push(`${label} base ${measured.base}: secondary text reaches `
        + `${Number(measured.contrast.achieved).toFixed(2)}:1 against raised controls, not `
        + `${target}:1. Lighten or darken the base.`);
    }
    const chrome = measured.contrast.chrome;
    if (chrome && chrome.reachable === false) {
      lines.push(`${label} base ${measured.base}: menu bar icons reach `
        + `${Number(chrome.achieved).toFixed(2)}:1, not ${target}:1. Lighten or darken the base.`);
    }
    return lines;
  }

  function paintContrastReport(state, theme) {
    if (!contrastReport) return;
    if (theme !== 'custom') {
      contrastReport.textContent = '';
      contrastReport.hidden = true;
      return;
    }
    const custom = (state && state.custom) || customDefaults();
    const lines = shortfalls('dark', custom.dark).concat(shortfalls('light', custom.light));
    contrastReport.textContent = lines.join(' ');
    contrastReport.hidden = lines.length === 0;
  }

  function paint(state, options) {
    if (!state) return;
    applying = true;
    const theme = state.theme || state.themeId || 'custom';
    const mode = state.mode === 'dark' ? 'dark' : 'light';
    themeInputs.forEach(input => { input.checked = input.value === theme; });
    modeInputs.forEach(input => { input.checked = input.value === mode; });
    setCustomVisual('dark', state.custom && state.custom.dark);
    setCustomVisual('light', state.custom && state.custom.light);
    if (customPanel) {
      customPanel.hidden = theme !== 'custom';
      customPanel.setAttribute('aria-hidden', String(theme !== 'custom'));
    }
    const customChoice = document.querySelector('input[name="appearanceTheme"][value="custom"]');
    if (customChoice) {
      const custom = state.custom || customDefaults();
      customChoice.setAttribute('aria-label', `Custom theme. Dark accent ${custom.dark.accent}, base ${custom.dark.base}. Light accent ${custom.light.accent}, base ${custom.light.base}.`);
    }
    paintContrastReport(state, theme);
    paintTypography(state);
    paintSaveState();
    applying = false;
    if (!options || options.announce !== false) {
      setStatus(`${themeName(theme)} · ${mode === 'dark' ? 'Dark' : 'Light'} is active across SHOWAVE. ${saveDescription()}`);
    }
  }

  function commit(patch, message) {
    if (!appearance || typeof appearance.setState !== 'function') {
      setStatus('The shared Appearance service is unavailable. Reload SHOWAVE and try again.', 'error');
      return null;
    }
    try {
      /* setState updates this session and broadcasts. apply is called as the
         public immediate-application contract; the service treats the second
         identical signature as a no-op. */
      const saved = appearance.setState(patch, { source: 'preferences-appearance' });
      const active = typeof appearance.apply === 'function'
        ? appearance.apply(saved || patch, { source: 'preferences-appearance' })
        : saved;
      paint(active || getState(), { announce: false });
      if (message) setStatus(`${message} ${saveDescription()}`);
      return active;
    } catch (error) {
      setStatus(`Appearance was not changed: ${error && error.message || error}`, 'error');
      return null;
    }
  }

  function currentCustomPatch(mode, key, value) {
    const state = getState();
    const defaults = customDefaults();
    const custom = state && state.custom ? copy(state.custom) : defaults;
    if (!custom[mode]) custom[mode] = copy(defaults[mode]);
    custom[mode][key] = upperHex(value, custom[mode][key]);
    return custom;
  }

  themeInputs.forEach(input => input.addEventListener('change', () => {
    if (applying || !input.checked) return;
    commit({ theme: input.value }, `${themeName(input.value)} selected.`);
  }));

  modeInputs.forEach(input => input.addEventListener('change', () => {
    if (applying || !input.checked) return;
    commit({ mode: input.value }, `${input.value === 'dark' ? 'Dark' : 'Light'} appearance selected.`);
  }));

  Object.entries(customFields).forEach(([mode, pair]) => {
    Object.entries(pair).forEach(([key, input]) => {
      if (!input) return;
      input.addEventListener('input', () => {
        if (applying) return;
        const custom = currentCustomPatch(mode, key, input.value);
        commit({ theme: 'custom', custom }, `Custom ${mode} ${key} updated.`);
      });
    });
  });

  if (resetButton) resetButton.addEventListener('click', () => {
    const defaults = customDefaults();
    /* Names the control, so it follows the control's label. */
    commit({ theme: 'custom', custom: defaults }, 'Custom Colors reset to their defaults.');
  });

  if (fontScaleReset) fontScaleReset.addEventListener('click', () => commit({ fontScale: 100 }, 'Default text size restored.'));
  if (restoreDefault) restoreDefault.addEventListener('click', () => {
    const defaults = appearance && appearance.defaults;
    if (defaults) commit(copy(defaults), 'Default dark appearance restored. Save to keep it.');
  });
  if (fontSearch) fontSearch.addEventListener('input', paintFontList);
  if (fontRefresh) fontRefresh.addEventListener('click', loadFonts);
  if (fontFamily) fontFamily.addEventListener('change', () => {
    if (applying) return;
    if (fontFamily.value !== 'system' && !installedFonts.includes(fontFamily.value)) return;
    commit({ typography: { family: fontFamily.value } }, 'Interface font updated.');
  });
  if (fontScale) fontScale.addEventListener('input', () => {
    if (!applying) commit({ typography: { scale: Number(fontScale.value) } }, 'Interface text size updated.');
  });
  if (fontWeight) fontWeight.addEventListener('change', () => {
    if (!applying) commit({ typography: { weight: fontWeight.value } }, 'Interface font weight updated.');
  });
  if (fontItalic) fontItalic.addEventListener('change', () => {
    if (!applying) commit({ typography: { italic: fontItalic.checked } }, 'Interface font style updated.');
  });
  if (fontReset) fontReset.addEventListener('click', () => {
    commit({ typography: appearance.defaults.typography }, 'Interface fonts reset to the SHOWAVE default.');
  });

  if (saveButton) saveButton.addEventListener('click', () => {
    try {
      if (!appearance || typeof appearance.save !== 'function') throw new Error('Reload Preferences to enable appearance saving.');
      const result = appearance.save();
      if (!result || result.ok !== true) throw new Error(result && result.error || 'Browser storage is unavailable.');
      paintSaveState();
      setStatus('Appearance saved. You can close Preferences.');
    } catch (error) {
      if (saveLabel) saveLabel.textContent = 'Appearance was not saved';
      if (saveStatus) {
        saveStatus.textContent = String(error.message || error);
        saveStatus.dataset.state = 'error';
      }
    }
  });

  function connect() {
    appearance = global.OpenLiveAppearance || appearance;
    if (!appearance) {
      themeInputs.concat(modeInputs).forEach(input => { input.disabled = true; });
      if (resetButton) resetButton.disabled = true;
      [saveButton,fontFamily,fontSearch,fontScale,fontScaleReset,fontWeight,fontItalic,fontReset,fontRefresh,restoreDefault].filter(Boolean).forEach(control => { control.disabled = true; });
      setStatus('The shared Appearance service is unavailable.', 'error');
      return false;
    }
    themeInputs.concat(modeInputs).forEach(input => { input.disabled = false; });
    if (resetButton) resetButton.disabled = false;
    if (saveButton) saveButton.disabled = typeof appearance.save !== 'function';
    if (unsubscribe) unsubscribe();
    if (typeof appearance.subscribe === 'function') {
      unsubscribe = appearance.subscribe(state => paint(state), { immediate: true });
    } else paint(getState());
    loadFonts();
    return true;
  }

  /* ---- context-aware hover bloom ---------------------------------------
     The pointer half of context-aware-hover-cards-w-blur (MIT, Afro Inno,
     forked from jh3y). Its CSS parks the bloom at --pointer-x/-y = -10 and
     translates it by calc(var(--pointer-x) * 50cqi); this feeds those two
     numbers, normalised to -1..1 across each card, so the light appears to
     follow the cursor.

     One deliberate change from the pen. It calls getBoundingClientRect() for
     every card on every pointermove - sixteen forced layouts per event here.
     The rects are cached instead and refreshed on resize, scroll and theme
     repaint, and the writes are batched into one rAF. Same picture, without
     making a settings window do layout work on every mouse move. */
  function installHoverBloom() {
    const grid = document.getElementById('appearanceThemeGrid');
    if (!grid || !global.matchMedia) return;
    if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!global.matchMedia('(hover: hover)').matches) return;   // no bloom to chase on touch

    let cards = [], rects = [], queued = false, pending = null;

    const measure = () => {
      cards = [...grid.querySelectorAll('.appearance-card')];
      rects = cards.map(c => c.getBoundingClientRect());
    };
    const apply = () => {
      queued = false;
      if (!pending) return;
      const { clientX, clientY } = pending;
      for (let i = 0; i < cards.length; i++) {
        const r = rects[i];
        if (!r || !r.width || !r.height) continue;
        const x = (clientX - (r.left + r.width / 2)) / (r.width / 2);
        const y = (clientY - (r.top + r.height / 2)) / (r.height / 2);
        cards[i].style.setProperty('--pointer-x', x.toFixed(3));
        cards[i].style.setProperty('--pointer-y', y.toFixed(3));
      }
    };
    const onMove = event => {
      /* Re-measure when the cache is empty or stale. The first measure() runs
         at install time, when the Appearance section may still be hidden - every
         rect is then 0x0 and apply() skips every card, which is exactly what it
         did before this guard. Cheap: only when a rect has no area. */
      if (!rects.length || !rects[0] || !rects[0].width) measure();
      pending = { clientX: event.clientX, clientY: event.clientY };
      if (queued) return;
      queued = true;
      global.requestAnimationFrame(apply);
    };
    const park = () => cards.forEach(c => {
      c.style.setProperty('--pointer-x', '-10');
      c.style.setProperty('--pointer-y', '-10');
    });

    measure();
    grid.addEventListener('pointerenter', measure);
    grid.addEventListener('pointermove', onMove);
    grid.addEventListener('pointerleave', park);
    global.addEventListener('resize', measure);
    global.addEventListener('scroll', measure, true);
    global.addEventListener('openlive:appearancechange', measure);
  }

  global.addEventListener('openlive:appearancechange', event => {
    const state = event && event.detail && (event.detail.state || event.detail);
    paint(state || getState());
  });
  connect();
  installHoverBloom();
})(typeof globalThis !== 'undefined' ? globalThis : this);
