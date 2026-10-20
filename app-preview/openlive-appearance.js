/* OpenLive Appearance
   -------------------------------------------------------------------------
   Global, composition-independent interface appearance. This file is designed
   to run in <head>, before the shared stylesheets: it reads the saved choice
   synchronously and installs explicit colour tokens on the root element so a
   window never paints the previous theme first.

   The 15 fixed themes are immutable product choices. The sixteenth choice is
   Custom; only the four colours stored in state.custom are mutable.
   ------------------------------------------------------------------------- */
(function openLiveAppearanceBootstrap(global) {
  'use strict';

  if (global.OpenLiveAppearance) return;

  const VERSION = 2;
  const STORAGE_KEY = 'openlive.appearance.v2';
  const LEGACY_STORAGE_KEY = 'openlive.appearance.v1';
  const SAVED_STORAGE_KEY = 'openlive.appearance.saved.v1';
  const CHANNEL_NAME = 'openlive-appearance-v2';
  const EVENT_NAME = 'openlive:appearancechange';
  const SAVED_EVENT_NAME = 'openlive:appearancesaved';
  const HEX = /^#[0-9a-f]{6}$/i;
  const DARK_INK = '#0B0C10';
  const LIGHT_INK = '#F6F7FA';

  const freezeTheme = (number, id, name, darkAccent, darkBase, lightAccent, lightBase) =>
    Object.freeze({
      number, id, name,
      dark: Object.freeze({ accent: darkAccent, base: darkBase }),
      light: Object.freeze({ accent: lightAccent, base: lightBase }),
      custom: false
    });

  /* Order and values are part of the Preferences contract. Do not alphabetise
     this list or derive a fixed theme from another fixed theme. */
  const FIXED_THEMES = Object.freeze([
    freezeTheme(1,  'gx-classic',       'GX Classic',      '#FA1E4E', '#251F33', '#FA1E4E', '#E6E3ED'),
    freezeTheme(2,  'ultraviolet',      'Ultraviolet',     '#7D46F2', '#101015', '#8635FF', '#E3E4F1'),
    freezeTheme(3,  'sub-zero',         'Sub Zero',        '#4461EE', '#0C0C0E', '#1652E9', '#D8E0E4'),
    freezeTheme(4,  'frutti-di-mare',   'Frutti Di Mare',  '#FF7070', '#181E39', '#FF5959', '#E2E1EF'),
    freezeTheme(5,  'purple-haze',      'Purple Haze',     '#AEFF3C', '#09060B', '#2CB40D', '#E8E5EB'),
    freezeTheme(6,  'vaporwave',        'Vaporwave',       '#00E5C3', '#1C121C', '#5540BF', '#EDE3EC'),
    freezeTheme(7,  'rose-quartz',      'Rose Quartz',     '#FF708D', '#271723', '#EB4E9A', '#F9ECF0'),
    freezeTheme(8,  'coming-soon',      'Coming Soon',     '#EEDE00', '#173235', '#00A4CD', '#E3ECEE'),
    freezeTheme(9,  'hackerman',        'Hackerman',       '#00ED3B', '#1B221D', '#009D5E', '#E4ECEA'),
    freezeTheme(10, 'lambda',           'Lambda',          '#FF9900', '#2D3432', '#F07C00', '#E7E9E8'),
    freezeTheme(11, 'after-eight',      'After Eight',     '#5AEDBC', '#2E2824', '#00A870', '#ECE8E4'),
    freezeTheme(12, 'pay-to-win',       'Pay-To-Win',      '#F6C955', '#201D19', '#E79F03', '#ECE9E4'),
    freezeTheme(13, 'white-wolf',       'White Wolf',      '#CCCCCC', '#292929', '#292929', '#E8E8E8'),
    freezeTheme(14, 'underwave',        'Underwave',       '#5E65CC', '#121221', '#4937E8', '#CFD1ED'),
    freezeTheme(15, 'drive-by',         'Drive-by',        '#B4F3C9', '#141F1D', '#20A732', '#31343F')
  ]);

  const CUSTOM_THEME = Object.freeze({
    number: 16, id: 'custom', name: 'Custom', custom: true,
    /* Canonical defaults come from glassy-style-nav/src/index.html. The donor
       has no separate accent token, so its system-blue ambient colour is the
       deliberate inferred accent: #0A84FF in dark and #007AFF in light. */
    dark: Object.freeze({ accent: '#0A84FF', base: '#000000' }),
    light: Object.freeze({ accent: '#007AFF', base: '#E5E5EA' })
  });
  const THEMES = Object.freeze(FIXED_THEMES.concat(CUSTOM_THEME));
  const THEME_BY_ID = new Map(THEMES.map(theme => [theme.id, theme]));

  const DEFAULT_CUSTOM = Object.freeze({
    dark: Object.freeze({ accent: CUSTOM_THEME.dark.accent, base: CUSTOM_THEME.dark.base }),
    light: Object.freeze({ accent: CUSTOM_THEME.light.accent, base: CUSTOM_THEME.light.base })
  });
  const DEFAULT_TYPOGRAPHY = Object.freeze({ family: 'system', scale: 100, weight: 'default', italic: false });
  const FONT_WEIGHTS = new Set(['default', '400', '500', '600', '700']);
  const validFontFamily = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120
    && !/[\u0000-\u001f\u007f"';{}<>\\]/.test(value);
  function normaliseTypography(value, fallback) {
    const base = fallback || DEFAULT_TYPOGRAPHY;
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { family: validFontFamily(source.family) ? source.family : base.family,
      scale: Number.isInteger(source.scale) && source.scale >= 75 && source.scale <= 150 ? source.scale : base.scale,
      weight: FONT_WEIGHTS.has(source.weight) ? source.weight : base.weight,
      italic: typeof source.italic === 'boolean' ? source.italic : base.italic };
  }
  function validSavedTypography(value) {
    return value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value)
      && validFontFamily(value.family) && Number.isInteger(value.scale) && value.scale >= 75 && value.scale <= 150
      && FONT_WEIGHTS.has(value.weight) && typeof value.italic === 'boolean');
  }
  const DEFAULT_STATE = Object.freeze({
    version: VERSION,
    theme: 'custom',
    mode: 'dark',
    custom: DEFAULT_CUSTOM,
    typography: DEFAULT_TYPOGRAPHY,
    updatedAt: 0,
    revision: 'default'
  });

  /* Exact material values sampled from glassy-style-nav/src/index.html.
     Liquid glass is a material layer, not a seventeenth palette: the selected
     palette continues to supply --color-bg/--color-accent while these values
     describe translucency, reflection and foreground chrome.

     The three ambient lights used to live here as blob1/blob2/blob3 and were
     the donor's #BF5AF2/#0A84FF/#FF375F (dark) and #FF2A5F/#007AFF/#FF9500
     (light). They have moved into deriveTokens because this table is indexed
     only by Light/Dark, so no code path existed from the palette to the mesh:
     all 16 palettes painted the same three hues over the whole viewport, and
     because every panel is translucent glass that wash reached every
     glass-painting surface above it. Same class of defect as the fixed #2b2b2b
     already banned at tools/test-wire-alley-appearance-contract.js:125-126.
     Translucency is a material; the colour of the room is the theme.

     iconColor/iconActive left for the same reason and one more. They were fixed
     ink alphas -- rgba(0,0,0,.5) light, rgba(255,255,255,.5) dark -- so they
     never consulted the surface they landed on. Measured against the composited
     menu bar they failed WCAG AA 4.5:1 on ALL 16 light palettes (3.52-3.76:1)
     and on the four dark palettes with the lightest bases (4.40-4.49:1), at
     11.5px/600 where the 3:1 large-text allowance does not apply. Worse, they
     keyed off value.mode while the surface beneath them keys off measured base
     luminance, so on Drive-by light they put black ink on a dark room: 1.95:1.
     They are now derived from the palette's own ink in deriveTokens, which is
     the only way an ink can track a surface that varies per palette. */
  const GLASS_MATERIALS = Object.freeze({
    light: Object.freeze({
      glassBg: 'rgba(255, 255, 255, 0.15)',
      glassBorder: 'rgba(255, 255, 255, 0.4)',
      glassShadow: 'rgba(0, 0, 0, 0.1)',
      glassHighlight: 'rgba(255, 255, 255, 0.8)',
      glassCaustic: 'rgba(255, 255, 255, 0.4)',
      reflectionStart: 'rgba(255, 255, 255, 0.6)',
      reflectionEnd: 'rgba(255, 255, 255, 0.0)',
      glareColor: 'rgba(255, 255, 255, 0.5)',
      pillBg: 'rgba(255, 255, 255, 0.7)',
      pillShadow: '0 4px 12px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05), inset 0 1px 1px rgba(255,255,255,0.8)',
      divider: 'rgba(0, 0, 0, 0.15)'
    }),
    dark: Object.freeze({
      glassBg: 'rgba(30, 30, 35, 0.45)',
      glassBorder: 'rgba(255, 255, 255, 0.15)',
      glassShadow: 'rgba(0, 0, 0, 0.8)',
      glassHighlight: 'rgba(255, 255, 255, 0.25)',
      glassCaustic: 'rgba(255, 255, 255, 0.05)',
      reflectionStart: 'rgba(255, 255, 255, 0.15)',
      reflectionEnd: 'rgba(255, 255, 255, 0.0)',
      glareColor: 'rgba(255, 255, 255, 0.15)',
      pillBg: 'rgba(60, 60, 65, 0.8)',
      pillShadow: '0 4px 12px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.2), inset 0 1px 1px rgba(255,255,255,0.2)',
      divider: 'rgba(255, 255, 255, 0.15)'
    })
  });

  const cleanHex = (value, fallback) => HEX.test(String(value || ''))
    ? String(value).toUpperCase() : fallback;
  const cleanTheme = (value, fallback) => THEME_BY_ID.has(String(value || ''))
    ? String(value) : fallback;
  const cleanMode = (value, fallback) => value === 'dark' || value === 'light'
    ? value : fallback;
  const cleanFontScale = (value, fallback) => {
    const number = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.max(100, Math.min(150, Math.round(number))) : fallback;
  };
  const cleanTime = value => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER - 1, Math.round(number));
  };
  const cleanRevision = (value, fallback) => {
    const revision = String(value == null ? '' : value).replace(/[^a-z0-9:._-]/gi, '').slice(0, 160);
    return revision || fallback;
  };

  function cloneCustom(custom) {
    return {
      dark: { accent: custom.dark.accent, base: custom.dark.base },
      light: { accent: custom.light.accent, base: custom.light.base }
    };
  }

  function cloneState(value) {
    return {
      version: VERSION,
      theme: value.theme,
      mode: value.mode,
      fontScale: (value.typography || DEFAULT_TYPOGRAPHY).scale,
      custom: cloneCustom(value.custom),
      typography: Object.assign({}, value.typography || DEFAULT_TYPOGRAPHY),
      updatedAt: value.updatedAt,
      revision: value.revision
    };
  }

  function frozenState(value) {
    const copy = cloneState(value);
    Object.freeze(copy.custom.dark);
    Object.freeze(copy.custom.light);
    Object.freeze(copy.custom);
    Object.freeze(copy.typography);
    return Object.freeze(copy);
  }

  function normaliseState(source, fallback) {
    const base = fallback || DEFAULT_STATE;
    const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const custom = value.custom && typeof value.custom === 'object' ? value.custom : {};
    const dark = custom.dark && typeof custom.dark === 'object' ? custom.dark : {};
    const light = custom.light && typeof custom.light === 'object' ? custom.light : {};
    return {
      version: VERSION,
      theme: cleanTheme(value.theme === undefined ? value.themeId : value.theme, base.theme),
      mode: cleanMode(value.mode, base.mode),
      custom: {
        dark: {
          accent: cleanHex(dark.accent, base.custom.dark.accent),
          base: cleanHex(dark.base, base.custom.dark.base)
        },
        light: {
          accent: cleanHex(light.accent, base.custom.light.accent),
          base: cleanHex(light.base, base.custom.light.base)
        }
      },
      typography: normaliseTypography(value.typography === undefined && value.fontScale !== undefined
        ? Object.assign({}, base.typography || DEFAULT_TYPOGRAPHY, {scale:cleanFontScale(value.fontScale, (base.typography || DEFAULT_TYPOGRAPHY).scale)})
        : value.typography, base.typography),
      updatedAt: cleanTime(value.updatedAt),
      revision: cleanRevision(value.revision, base.revision || 'default')
    };
  }

  function parseHex(value) {
    const hex = cleanHex(value, '#000000').slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  const byteHex = value => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16).padStart(2, '0').toUpperCase();
  const toHex = color => `#${byteHex(color.r)}${byteHex(color.g)}${byteHex(color.b)}`;

  /* amount is the share of `toward`, from 0 (source) to 1 (toward). */
  function mix(source, toward, amount) {
    const a = parseHex(source), b = parseHex(toward);
    const weight = Math.max(0, Math.min(1, Number(amount) || 0));
    return toHex({
      r: a.r + (b.r - a.r) * weight,
      g: a.g + (b.g - a.g) * weight,
      b: a.b + (b.b - a.b) * weight
    });
  }

  /* A NEW PRIMITIVE, and the only one this file adds beyond mix(). Declaring it
     as new rather than claiming reuse: there is no pre-existing hue maths here.
     mix() is linear sRGB interpolation, so it can lighten, darken and desaturate
     but cannot produce a relative hue, and three ambient lights that share one
     hue are one light.
     HSL rather than OKLCH or a color-mix() string because the emitted token must
     be a literal #RRGGBB: tools/test-appearance-runtime.js forbids var() and
     color-mix() in any token so canvas painters never have to resolve one.

     WHAT IT DOES NOT DO, stated because an earlier revision claimed otherwise:
     it preserves HSL *lightness*, which is (max+min)/2 of the sRGB bytes, NOT
     relative luminance. Luminance is 71.5% green, so a rotation onto yellow can
     multiply it by 3.7 (#FA1E4E luminance 0.2180 -> #FAEB1E 0.7983). Nothing in
     the ambient derivation below relies on this primitive for brightness:
     matchLuminance re-levels the rotated relatives first, and every disc's
     COMPOSITED luminance is then set explicitly. Hue is all this is asked for. */
  function rotateHue(value, degrees) {
    const color = parseHex(value);
    const r = color.r / 255, g = color.g / 255, b = color.b / 255;
    const high = Math.max(r, g, b), low = Math.min(r, g, b), chroma = high - low;
    /* A neutral has no hue to rotate, and returning it unchanged is correct
       rather than a failure: White Wolf's #CCCCCC accent must produce a
       monochrome mesh. Its three lights are kept distinct by the pull stagger in
       deriveTokens, not by a hue the palette does not have. */
    if (chroma === 0 || !degrees) return cleanHex(value, '#000000');
    let hue;
    if (high === r) hue = ((g - b) / chroma) % 6;
    else if (high === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue = (((hue * 60 + degrees) % 360) + 360) % 360;
    const second = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const floor = (high + low) / 2 - chroma / 2;
    const wheel = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second],
      [0, second, chroma], [second, 0, chroma], [chroma, 0, second]][Math.floor(hue / 60) % 6];
    return toHex({
      r: (wheel[0] + floor) * 255,
      g: (wheel[1] + floor) * 255,
      b: (wheel[2] + floor) * 255
    });
  }

  function luminance(value) {
    const color = parseHex(value);
    const channel = byte => {
      const unit = byte / 255;
      return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrast(left, right) {
    const a = luminance(left), b = luminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  const bestInk = color => contrast(color, DARK_INK) >= contrast(color, LIGHT_INK)
    ? DARK_INK : LIGHT_INK;

  /* WORK ITEM 1 -- THE CONTRAST SOLVE.
     WHAT IT FIXES. The neutral ramp used to spend nine fixed mix weights chosen
     by eye. luminance() and contrast() already existed here but were spent only
     inside bestInk, to pick the ink DIRECTION; nothing floored the ramp against
     the surfaces the ink is actually read on. Measured over all 16 palettes x 2
     modes against all nine derived surfaces, the floor was --n600 1.79:1 and
     --n500/--txt-dim 2.45:1, both on Drive-by light against --btn-hi. That is
     unreadable, not a stylistic choice.

     WHY A SOLVE AND NOT A BIGGER WEIGHT. mix() lerps sRGB BYTES. A fixed weight
     therefore buys wildly different contrast depending on which way the ink
     travels: the same rung yields ~4.1-4.9:1 moving toward LIGHT_INK from a dark
     base but only ~3.2-3.5:1 moving toward DARK_INK from a light base. Light
     mode measured about twice as many failing text nodes as dark for exactly
     that reason, so no single global weight bump can fix both directions. The
     weight has to be solved per palette, against the surface, or it is guesswork
     again the next time a surface moves.

     THE TARGET. WCAG AA 4.5:1. Recorded here because it is a deliberate
     divergence in look, not an obvious default: Resolume Arena 7.27.1 ships ONE
     fixed dark UI -- no light mode and no 16 palettes -- so there is no Arena
     appearance for this subsystem to diverge FROM. The 4.5 costs perceptual
     separation only on the two lowest text rungs; the top three do not move at
     all, because TEXT_TOP is a fixed point of the remap below.

     COST. At most 257 mix()+contrast() pairs per solve, and the solves run once
     per applyTheme -- i.e. on a theme change, never in a frame. 60 fps untouched.

     HONESTY. Returns null rather than clamping when the target is unreachable.
     A Custom base in the #727272-#797979 luminance band cannot reach 4.5:1 in
     either ink direction (best achievable 4.30:1), and reporting a pass there
     would be exactly the fabricated number CLAUDE.md forbids. deriveTokens
     publishes the shortfall on the resolved object so Preferences can say so. */
  const AA_TARGET = 4.5;
  const TEXT_FLOOR = 0.37;  /* the --n600 rung: the lowest rung used as text */
  const TEXT_TOP = 0.94;    /* the --n100 rung: fixed point, never moves */
  /* ANCHOR_CAP exists to keep the affine remap INCREASING, and that is its only
     job. The map is w' = anchor + (TEXT_TOP - anchor)(w - TEXT_FLOOR) /
     (TEXT_TOP - TEXT_FLOOR); its slope is (TEXT_TOP - anchor), so an anchor at
     or above TEXT_TOP flattens or inverts the whole text half and --n600 comes
     out inkier than --n100. Measured: with the cap lifted to 1.0 a Custom base
     of #565656 solves to 0.9922 and the ramp inverts outright. 0.86 leaves clear
     air under TEXT_TOP.

     Ordering (--n600 dimmer than --n200) is NOT what the cap buys; the map's
     monotonicity gives that for any anchor below TEXT_TOP, capped or not. An
     earlier comment here claimed otherwise and it was wrong.

     THE CAP CAN SUPPRESS THE AA GUARANTEE, and that has to be reported rather
     than papered over. When solveWeight succeeds but returns more than the cap,
     the clamp throws the answer away and the emitted ramp lands below the
     target -- 80 of the 256 grey Custom bases end up under the target this way,
     worst #565656 at 3.70:1. Raising the cap is NOT the fix; it inverts the
     ramp. Reporting is, and the report at the foot of deriveTokens measures the
     EMITTED rung rather than asking the solver whether it was happy. No shipped
     palette is affected: the highest anchor across all 32 states is 0.7695
     (Drive-by light), so the cap never binds today. */
  const ANCHOR_CAP = 0.86;
  /* Chrome ink was measured at 0.86 against the COMPOSITED menu bar (glass over
     mesh over base), which the flat --menu-bar token below understates. Keeping
     it as a floor means the solve can only ever raise the ink, never regress the
     composited measurement that is already shipping. */
  const CHROME_INK_FLOOR = 0.86;

  /* The smallest share of `ink` that clears `target` against `reference`, or
     null when no share does. 1/256 steps because the emitted token is a rounded
     #RRGGBB and a finer search would return a weight the byte grid cannot
     express. Scanning upward returns the SMALLEST passing weight, which is what
     keeps the ramp as close to its authored look as the target allows. */
  function solveWeight(source, ink, reference, target) {
    for (let step = 0; step <= 256; step += 1) {
      const weight = step / 256;
      if (contrast(mix(source, ink, weight), reference) >= target) return weight;
    }
    return null;
  }

  /* CIE L* both ways. Relative luminance is the right thing to CONSTRAIN (it is
     what WCAG contrast and every measurement in this file is expressed in) but
     the wrong thing to STEP IN: equal luminance steps are not equal perceptual
     steps, so an ambient ladder spaced in luminance bunches up in the dark. L*
     is the perceptual scale, so the ladder is spaced there and converted back. */
  const LSTAR_KNEE = 0.008856;
  const lightnessOf = y => (y > LSTAR_KNEE ? 116 * Math.cbrt(y) - 16 : 903.3 * y);
  const luminanceAt = l => (l > 8 ? Math.pow((l + 16) / 116, 3) : l / 903.3);

  /* Re-level a colour to a target relative luminance by mixing it toward the
     nearer ink anchor. Bisection rather than algebra because the emitted value
     must be a rounded #RRGGBB and the rounding is part of the answer. */
  function matchLuminance(color, target) {
    const current = luminance(color);
    if (Math.abs(current - target) < 1e-6) return cleanHex(color, '#000000');
    const rising = target > current;
    const ink = rising ? LIGHT_INK : DARK_INK;
    if (rising ? luminance(ink) <= current : luminance(ink) >= current) {
      return cleanHex(color, '#000000');
    }
    let low = 0, high = 1;
    for (let step = 0; step < 18; step += 1) {
      const mid = (low + high) / 2;
      if ((luminance(mix(color, ink, mid)) < target) === rising) low = mid;
      else high = mid;
    }
    return mix(color, ink, (low + high) / 2);
  }

  /* The ambient discs are painted at --blob-opacity over the room, so what has
     to hit a number is the COMPOSITE, not the token. CSS source-over at opacity
     a is exactly mix(room, light, a), so the same primitive models it and the
     search returns the light that lands the composite on `target`. */
  function ambientLight(tint, room, alpha, target) {
    const current = luminance(mix(room, tint, alpha));
    if (Math.abs(current - target) < 1e-9) return cleanHex(tint, '#000000');
    const rising = target > current;
    const ink = rising ? LIGHT_INK : DARK_INK;
    let low = 0, high = 1;
    for (let step = 0; step < 20; step += 1) {
      const mid = (low + high) / 2;
      if ((luminance(mix(room, mix(tint, ink, mid), alpha)) < target) === rising) low = mid;
      else high = mid;
    }
    return mix(tint, ink, (low + high) / 2);
  }

  function alphaHex(color, alpha) {
    return cleanHex(color, '#000000') + byteHex(Math.max(0, Math.min(1, Number(alpha) || 0)) * 255);
  }

  function selectedPair(value) {
    const theme = THEME_BY_ID.get(value.theme) || THEME_BY_ID.get(DEFAULT_STATE.theme);
    const pair = theme.custom ? value.custom[value.mode] : theme[value.mode];
    return {
      definition: theme,
      accent: cleanHex(pair.accent, DEFAULT_CUSTOM[value.mode].accent),
      base: cleanHex(pair.base, DEFAULT_CUSTOM[value.mode].base)
    };
  }

  function deriveTokens(value) {
    const pair = selectedPair(value);
    const accent = pair.accent, base = pair.base;
    const baseInk = bestInk(base);
    const accentInk = bestInk(accent);
    /* Text and native controls follow the actual base luminance so every fixed
       pair remains readable. The Liquid Glass material follows the explicit
       Light/Dark mode selected by the header icon, matching the donor. */
    const scheme = baseInk === DARK_INK ? 'light' : 'dark';
    const lightSurface = scheme === 'light';
    const glass = GLASS_MATERIALS[value.mode];
    /* SURFACES ARE DERIVED FIRST, and that ordering is load-bearing rather than
       cosmetic: the neutral ink ramp below is now solved AGAINST a surface, so
       the surface has to exist before the ink does. Every one of these depends
       only on `base` and `lightSurface`, so hoisting them introduces no
       circularity. The two things that did depend on the ramp -- line2 and the
       chrome ink -- move below it. */
    const surface = mix(base, lightSurface ? LIGHT_INK : LIGHT_INK, lightSurface ? 0.18 : 0.075);
    const panel2 = mix(base, lightSurface ? DARK_INK : LIGHT_INK, lightSurface ? 0.045 : 0.12);
    const strip = mix(base, lightSurface ? DARK_INK : LIGHT_INK, lightSurface ? 0.035 : 0.03);
    const head = mix(base, lightSurface ? DARK_INK : LIGHT_INK, lightSurface ? 0.06 : 0.085);
    const inset = mix(base, DARK_INK, lightSurface ? 0.08 : 0.20);
    const line = mix(base, DARK_INK, lightSurface ? 0.24 : 0.31);
    const button = mix(base, lightSurface ? DARK_INK : LIGHT_INK, lightSurface ? 0.065 : 0.105);
    const buttonHigh = mix(base, lightSurface ? DARK_INK : LIGHT_INK, lightSurface ? 0.11 : 0.17);
    const menuBar = mix(base, DARK_INK, lightSurface ? 0.07 : 0.10);

    /* WORK ITEM 1, applied. THE RULE: do not spend a fixed weight. Solve for the
       weight at which the lowest text-bearing rung clears AA_TARGET against the
       least-contrasting standard text surface, then remap the TEXT half of the
       ramp affinely onto [anchor, TEXT_TOP] and leave the chrome half alone.

       --btn-hi is the reference because it is the least-contrasting surface any
       standard text sits on, measured in 32 of 32 palette/mode states without
       exception -- which is also why the failure was systemic rather than
       per-palette. The new contract sweep re-derives that fact every run, so if
       a future surface change introduces a worse one the reference is caught
       rather than silently left behind.

       WHY AFFINE, AND WHY TEXT_TOP IS PINNED. anchor >= TEXT_FLOOR always, and
       the map fixes TEXT_TOP, so w' >= w at every rung: no token can lose
       contrast in any palette. --n100/--txt-hi comes out byte-identical in all
       32 states. Rungs 6/7/8 are untouched, which is what keeps --n700, --n800,
       --n900, --line2, --btn-line, --check-a/b, --menu-disabled and --shadow-md
       exactly where they were -- deliberately, see the note on --menu-disabled
       further down.

       THE COST, stated rather than glossed: on the palettes that bind hardest
       the six text rungs compress into a narrow weight window, so the separation
       between --txt, --txt-dim and --n600 visibly flattens there and --txt gets
       brighter. That is the price of the guarantee, and it is confined to text
       that is currently illegible -- the top three rungs do not move at all. */
    const neutralWeights = [0.94, 0.86, 0.76, 0.63, 0.49, 0.37, 0.27, 0.18, 0.10];
    const solvedAnchor = solveWeight(base, baseInk, buttonHigh, AA_TARGET);
    const anchor = Math.min(ANCHOR_CAP,
      Math.max(TEXT_FLOOR, solvedAnchor === null ? 1 : solvedAnchor));
    const neutral = neutralWeights.map((weight, index) => mix(base, baseInk,
      index <= 5
        ? anchor + (TEXT_TOP - anchor) * (weight - TEXT_FLOOR) / (TEXT_TOP - TEXT_FLOOR)
        : weight));

    const accentHighWeights = lightSurface
      ? [0.68, 0.50, 0.33, 0.16]
      : [0.90, 0.74, 0.52, 0.28];
    const accentHighTarget = lightSurface ? DARK_INK : LIGHT_INK;
    const accentRamp = accentHighWeights.map(weight => mix(accent, accentHighTarget, weight));
    accentRamp.push(accent);
    [0.12, 0.24, 0.40, 0.58].forEach(weight => accentRamp.push(mix(accent, DARK_INK, weight)));

    const line2 = neutral[7];
    const softAccent = mix(strip, accent, 0.08);
    /* WORK ITEM 2, completed. The glass FOREGROUND follows `scheme` -- the base's
       measured luminance -- while the glass MATERIAL above still follows
       value.mode, because scheme is the only thing that knows which side of the
       surface the ink lands on. That half already shipped (see GLASS_MATERIALS);
       what was still a guess was the WEIGHT: a 0.86 constant measured once. It
       is now the floor of a solve against the menu bar the ink actually sits on,
       so a surface change lifts the ink with it instead of quietly un-measuring
       it. Today the floor binds on all 32 states -- the flat --menu-bar token is
       far enough from the ink that the solve asks for less -- and that is the
       point of keeping 0.86: the composited bar is lighter than the token, and
       the floor is the value that was measured against the composite. */
    const chromeInkSolved = solveWeight(base, baseInk, menuBar, AA_TARGET);
    /* Clamped at TEXT_TOP for the same reason the ramp anchor is clamped: past
       it the ink is indistinguishable from --n100 and the resting/active pair
       collapses. And for the same reason it is REPORTED -- a clamp that cuts a
       successful solve short, or a solve that never succeeded, both ship an ink
       below the target, and a silent clamp here would be the same fabricated
       pass the ramp's `reachable` was fixed to stop telling. */
    const chromeInkWeight = Math.min(TEXT_TOP,
      Math.max(CHROME_INK_FLOOR, chromeInkSolved === null ? 1 : chromeInkSolved));
    const chromeInk = mix(base, baseInk, chromeInkWeight);
    /* BOTH REPORTS ARE MEASURED ON THE TOKENS THAT SHIP, never inferred from the
       solver's bookkeeping. That distinction is not academic. solveWeight walks a
       1/256 grid while the clamps land on 0.94 and 0.86, which are not grid
       points, and mix() rounds to bytes -- so "the solve returned null or was
       clamped" and "the emitted ink misses the target" are not the same
       statement. Measured: a Custom base of #868686 clamps to TEXT_TOP off-grid
       and the emitted ink lands at 4.514:1, i.e. a PASS that solver bookkeeping
       called a failure. Reporting the emitted value is both the honest answer
       and the one that cannot drift from what the operator sees. */
    const rampAchieved = contrast(neutral[5], buttonHigh);
    const chromeAchieved = contrast(chromeInk, menuBar);
    const shadow = lightSurface ? '#000000' : '#000000';
    const shadowLow = lightSurface ? 0.18 : 0.55;
    const shadowHigh = lightSurface ? 0.26 : 0.65;

    /* THE AMBIENT MESH. The theme breathing, not a seventeenth palette. Three
       discs derived from this palette's own accent and base: the accent's hue,
       plus one warm and one cool relative 69 degrees either side of it.
       69 is not invented. The donor's own dark triad spans 138 degrees of hue
       (210 -> 348); this keeps that span but centres it on the accent instead of
       ending at it. Replaying the donor's one-sided fan literally would walk a
       lime accent (Purple Haze #AEFF3C, hue 85) out to hues 155 and 223 and
       light a lime theme cyan and blue, which is the original bug in a subtler
       form.

       BRIGHTNESS IS NOT LEFT TO THE HUE. rotateHue holds HSL lightness, which is
       not luminance, so the rotated relatives arrive at wildly different
       brightness -- a red accent's +69 relative is yellow and carries 3.7x its
       luminance. Two steps fix that, in this order:
         1. matchLuminance re-levels both relatives to the accent's own relative
            luminance, so the fan is a hue triad and nothing else.
         2. ambientLight then places each disc's COMPOSITED luminance on an
            explicit rung. Because the composite is what the operator sees, the
            ladder is guaranteed by construction rather than hoped for: disc 1 is
            always the brightest, disc 3 always the dimmest, on all 32 states.
       Without step 1 the retarget still produces a correct ladder but reaches it
       through violently saturated colours (Vaporwave dark's second disc came out
       #1713A4, Coming Soon's third #A41637); the two steps together keep the
       triad a family.

       Order follows the geometry in openlive-appearance.css:137-148. Disc 1 is
       the 50vw disc at top-left and carries the accent's own hue on the largest
       surface, so every palette leads with itself. Disc 3 is the 35vw disc at
       top:30%/left:40%, dead over the clip grid, and sits lowest.

       WHERE THE RUNGS ARE, and why the two modes are shaped differently.
       Dark room: the discs are lights, spaced as a fraction of the L* gap
       between the room and `panel2` -- the tone the clip tiles are painted in,
       one line above. Tying the ceiling to panel2 rather than to a constant is
       what stops the mesh colliding with the tiles it sits behind; the top disc
       reaches 38% of that gap, so 62% of it is always left as separation.
       Light room: there is almost no headroom upward. Composing anything over a
       0.79 base at 0.42 opacity cannot exceed ~0.83, so a disc asked to be
       brighter than the room can only be white, and a white disc carries no hue
       -- that is the collapse this used to produce. The discs therefore sit just
       BELOW the room, 0.6/1.4/2.3 L*, which is a tint rather than a light. Said
       plainly rather than dressed up: in a light room the ambient scene shades,
       it does not glow. It stays above the panel tone (~3.5 L* below the room),
       so tiles still read as recessed.

       This keys off lightSurface -- the base's MEASURED luminance -- and so does
       the chrome ink below, because a room and the text in it have to agree
       about which way up they are. `glass` above stays on value.mode, matching
       the donor: translucency is the material the operator chose, luminance
       direction is what the palette actually is. Drive-by light is the only pair
       in the catalogue where those two disagree.

       MEASURED, over all 16 palettes x 2 modes, modelling CSS source-over in
       sRGB (mesh = one disc at --blob-opacity over the base; panel = --glass-bg
       over that). Model, not pixels -- the live figures come in lower because
       blur(90px) means few pixels see a disc at full strength:
         worst dark bare mesh 0.0474, worst dark glass panel 0.1025;
         the mesh never moves the room more than 5.13 L* from the palette's own
           declared base, in either direction, on any of the 32 states;
         worst light-room loss 6.7% of base luminance (was 9.7-26.0%);
         Vaporwave dark, the operator's configuration, composites 0.0090-0.0141
           against a 0.0076 base, where the donor's fixed purple/blue/red painted
           0.0712-0.0770;
         Purple Haze light, the worst light case under the old build, composites
           0.7392-0.7796 against a 0.7919 base, where the donor painted
           0.3050-0.5030 -- a 0.79 room dragged to near mid-grey, which is not a
           light mode;
         smallest mesh-to-panel2 separation dE76 1.52 (was 0.00 -- White Wolf
           dark's first disc used to composite to #424242, byte-identical to the
           clip tile).
       Six of the sixteen dark-treatment states still put their brightest bare
       disc above Resolume's own #2b2b2b, which is 0.0242 by the same WCAG
       formula this file uses. Named rather than summarised, base then brightest
       disc: Drive-by light 0.0347 -> 0.0474, Lambda 0.0324 -> 0.0430, Coming
       Soon 0.0272 -> 0.0385, After Eight 0.0223 -> 0.0328, White Wolf 0.0222 ->
       0.0328, GX Classic 0.0161 -> 0.0249. Three of those six are already at or
       past the reference before a disc is drawn, and none of the six is lifted
       more than the 5.13 L* bound. The bound is the guarantee; the absolute
       number is the palette's own declared base plus that bound.

       HONEST LIMIT, measured not hidden: White Wolf's accent #CCCCCC is a pure
       neutral, so rotateHue is a no-op BY CONSTRUCTION and the triad is three
       greys separated only by the rungs -- composited dE76 0.89-1.3, below the
       ~2.3 just-noticeable step. A monochrome palette gets a monochrome mesh;
       inventing a hue it does not declare would be the original bug again. */
    const ambientFan = 69;
    const ambientAlpha = lightSurface ? 0.42 : 0.30;
    const ambientPull = lightSurface ? 0.10 : 0.35;
    const ambientOpacity = lightSurface ? '0.42' : '0.30';
    const baseLightness = lightnessOf(luminance(base));
    const ambientRungs = lightSurface
      ? [-0.6, -1.4, -2.3].map(step => baseLightness + step)
      : [0.38, 0.23, 0.11].map(share =>
        baseLightness + (lightnessOf(luminance(panel2)) - baseLightness) * share);
    const ambient = [
      accent,
      rotateHue(accent, ambientFan),
      rotateHue(accent, -ambientFan)
    ].map((hue, index) => ambientLight(
      mix(matchLuminance(hue, luminance(accent)), base, ambientPull),
      base, ambientAlpha, luminanceAt(ambientRungs[index])
    ));

    const tokens = {
      '--appearance-base': base,
      '--appearance-accent': accent,
      '--appearance-on-base': baseInk,
      '--appearance-on-accent': accentInk,
      '--appearance-material': 'glass',
      /* WORK ITEM 6a. --theme-focus was referenced ten times across
         openlive-appearance.css and openlive-tools-ui.js and DEFINED NOWHERE, so
         every var(--theme-focus, var(--color-accent)) had always fallen through
         to the raw accent. Measured against the surfaces a focus ring is drawn
         on, the accent fails 3:1 in 4 of 16 dark palettes and against at least
         one reachable surface in 11 of 16 light ones, worst 1.47:1 -- which is
         not an indicator. The fix is the decision this repo already made once
         and contract-tested for the Preferences theme tile
         (tools/test-appearance-preferences-contract.js:165-167, where an accent
         outline measured 1.02:1): FOCUS IS BASE INK, NEVER THE ACCENT. baseInk
         is bestInk(base) and so clears 12:1 against every derived surface by
         construction, with no per-palette table. Cost: one token. */
      '--theme-focus': baseInk,
      '--color-bg': base,
      '--color-surface': surface,
      '--color-text': neutral[1],
      '--color-accent': accent,
      /* Compact utility/detached windows use this same selected palette.
         Emit resolved colors: dialogs alias --bg back to these tokens. */
      '--showave-window-bg': base,
      '--showave-window-surface': surface,
      '--showave-window-field': inset,
      '--showave-window-line': line,
      '--showave-window-edge': line,
      '--showave-window-control-border': line2,
      '--showave-window-text': neutral[2],
      '--showave-window-muted': neutral[4],
      '--showave-window-hover': buttonHigh,
      '--showave-window-focus': baseInk,
      '--n100': neutral[0], '--n200': neutral[1], '--n300': neutral[2],
      '--n400': neutral[3], '--n500': neutral[4], '--n600': neutral[5],
      '--n700': neutral[6], '--n800': neutral[7], '--n900': neutral[8],
      '--a100': accentRamp[0], '--a200': accentRamp[1], '--a300': accentRamp[2],
      '--a400': accentRamp[3], '--a500': accentRamp[4], '--a600': accentRamp[5],
      '--a700': accentRamp[6], '--a800': accentRamp[7], '--a900': accentRamp[8],
      '--bg': base,
      '--panel': surface,
      '--panel2': panel2,
      '--strip': strip,
      '--head': head,
      '--inset': inset,
      '--line': line,
      '--line2': line2,
      '--btn': button,
      '--btn-hi': buttonHigh,
      '--btn-line': line2,
      '--txt': neutral[2],
      '--txt-dim': neutral[4],
      '--txt-hi': neutral[0],
      '--mint': accent,
      '--mint-d': accentRamp[6],
      '--mint-t': accentInk,
      '--layer-transition-track': inset,
      '--layer-transition-fill': accent,
      '--layer-transition-border': line,
      '--menu-bar': menuBar,
      '--menu-bg': surface,
      '--menu-border': line2,
      '--menu-text': neutral[2],
      /* DELIBERATELY LEFT BELOW AA, and it must stay there. neutral[6] is
         simultaneously --check-b, the transparency checkerboard. Lifting it to
         4.5:1 would wreck the checkerboard AND make disabled menu items read as
         enabled, which is an honesty regression under CLAUDE.md rather than a
         cosmetic one. Disabled controls are exempt under WCAG 1.4.3; "greyed"
         has to keep meaning greyed. Controls that use neutral[6] as ENABLED text
         are the defect, and they move to --n600 instead. */
      '--menu-disabled': neutral[6],
      '--menu-header': neutral[5],
      '--menu-key': neutral[5],
      '--menu-arrow': neutral[4],
      '--menu-none': panel2,
      '--menu-swatch-border': line,
      '--menu-shadow': alphaHex(shadow, shadowLow),
      '--layer-menu-surface': surface,
      '--layer-menu-divider': line2,
      '--deck-tab-bg': button,
      '--deck-tab-text': neutral[1],
      '--deck-tab-selected': accent,
      '--deck-tab-selected-text': accentInk,
      '--deck-tab-separator': line,
      '--deck-tab-focus': accent,
      '--audio-meter-bg': inset,
      '--audio-meter-peak': neutral[0],
      '--audio-meter-vu': line,
      '--audio-meter-tick': neutral[4],
      '--audio-meter-tick-minor': line2,
      '--audio-mixer-surface': surface,
      '--audio-mixer-row': strip,
      '--audio-mixer-row-hover': softAccent,
      '--audio-mixer-divider': line2,
      '--audio-mixer-muted': neutral[4],
      '--audio-mixer-fader': accent,
      '--audio-mixer-handle': neutral[2],
      '--audio-mixer-handle-hover': neutral[0],
      '--audio-mixer-handle-pressed': accent,
      '--audio-mixer-handle-disabled': neutral[4],
      '--audio-mixer-monitor': accentRamp[6],
      '--content-black': '#000000',
      '--audio-status-active-bg': mix(head, accent, 0.12),
      '--audio-status-active-text': accent,
      '--audio-status-global-bg': mix(head, accent, 0.18),
      '--audio-status-global-text': neutral[0],
      '--audio-status-hidden-bg': panel2,
      '--audio-status-hidden-text': neutral[4],
      '--audio-status-inactive-bg': inset,
      '--audio-status-inactive-text': neutral[4],
      '--audio-status-preview-bg': mix(head, accent, 0.12),
      '--audio-status-preview-text': accent,
      '--net-download': accent,
      '--net-ok': accent,
      '--net-info': accent,
      '--net-surface': surface,
      '--net-inset': inset,
      '--net-raise': panel2,
      '--net-line': line2,
      '--net-line-soft': mix(surface, line2, 0.62),
      '--net-text': neutral[2],
      '--net-text-hi': neutral[0],
      '--net-text-dim': neutral[4],
      '--net-text-mid': mix(neutral[4], neutral[2], 0.70),
      /* WORK ITEM 1, follow-on. This was mix(line2, neutral[4], .78) -- a blend
         of a LINE colour with a text rung, which by construction lands BELOW the
         ramp's lowest text rung and so escapes the anchored solve entirely. It
         measured 3.68:1 after the solve (drive-by/light on --btn-hi) while every
         other neutral-derived ink cleared 4.5. It carries 9px/700 legend text at
         arena.css:1014 as well as dots and gauge strokes, so the text threshold
         is the one that governs. Blending between the two lowest TEXT rungs
         instead keeps it the faintest ink in the network UI and distinct from
         --net-text-dim, while inheriting the ramp's guarantee rather than
         sitting underneath it. Cost: none. */
      '--net-text-faint': mix(neutral[5], neutral[4], 0.78),
      '--check-a': neutral[7],
      '--check-b': neutral[6],
      '--bg-color': base,
      '--glass-bg': glass.glassBg,
      '--glass-border': glass.glassBorder,
      '--glass-shadow': glass.glassShadow,
      '--glass-highlight': glass.glassHighlight,
      '--glass-caustic': glass.glassCaustic,
      '--reflection-start': glass.reflectionStart,
      '--reflection-end': glass.reflectionEnd,
      '--glare-color': glass.glareColor,
      '--pill-bg': glass.pillBg,
      '--pill-shadow': glass.pillShadow,
      /* Chrome ink, derived rather than a fixed alpha -- see GLASS_MATERIALS.
         The weight is SOLVED against --menu-bar (above, near chromeInkWeight),
         with 0.86 as its floor rather than its value: 0.86 is what was measured
         against the COMPOSITED bar, and the flat token understates that, so the
         floor is what stops the solve asking for less than the measurement. On
         all 32 shipped states the floor is what binds; worst is Drive-by light
         at 5.02:1 against the composite, best Custom dark at 12.28:1. */
      '--icon-color': chromeInk,
      '--icon-active': neutral[0],
      '--divider': glass.divider,
      '--blob-1': ambient[0],
      '--blob-2': ambient[1],
      '--blob-3': ambient[2],
      '--blob-opacity': ambientOpacity,
      /* Namespaced aliases let page-level material rules avoid collisions with
         legacy `.divider` and icon tokens while retaining the donor names. */
      '--glass-mesh-bg': base,
      '--glass-reflection-start': glass.reflectionStart,
      '--glass-reflection-end': glass.reflectionEnd,
      '--glass-glare-color': glass.glareColor,
      '--glass-pill-bg': glass.pillBg,
      '--glass-pill-shadow': glass.pillShadow,
      '--glass-icon-color': chromeInk,
      '--glass-icon-active': neutral[0],
      '--glass-divider': glass.divider,
      /* The namespaced blob aliases are unreachable today -- applyRoot always
         sets the unnamespaced name, so the first arm of every var() in
         openlive-appearance.css:132/139/143/147 resolves. They move with the
         real tokens anyway, or the alias block keeps shipping donor colour to a
         future consumer. */
      '--glass-blob-1': ambient[0],
      '--glass-blob-2': ambient[1],
      '--glass-blob-3': ambient[2],
      '--glass-blob-opacity': ambientOpacity,
      '--shadow-sm': `0 0 0 1px ${line2}`,
      '--shadow-md': `0 0 0 1px ${neutral[6]}, 0 6px 18px ${alphaHex(shadow, shadowLow)}`,
      '--shadow-lg': `0 0 0 1px ${neutral[4]}, 0 16px 40px ${alphaHex(shadow, shadowHigh)}`
    };

    return Object.freeze({
      definition: pair.definition,
      accent,
      base,
      scheme,
      onBase: baseInk,
      onAccent: accentInk,
      /* Published so a UI can REPORT an unreachable target instead of pretending
         to have met it, and read by preferences-appearance.js next to the Custom
         swatch. Custom's base is user-editable, so both halves of this can fail
         on a base nobody shipped: greys in the #727272-#797979 band cannot reach
         4.5:1 in either ink direction, and a wider band solves to a weight the
         cap then throws away. `reachable:false` with the measured `achieved` is
         the same contract as MENU_CANNOT and the em-dash CPU/RAM readouts: name
         the shortfall, do not fabricate a pass.

         ONE RULE, arrived at by getting two weaker versions wrong first: BOTH
         fields are measured on the tokens that ship. `achieved` is the ratio
         neutral[5] -- that is --n600, and by construction mix(base, baseInk,
         anchor) -- makes against buttonHigh, and `reachable` is simply whether
         that ratio met the target.
         What it replaced, and why: `achieved` first measured the UNCLAMPED
         weight, overstating delivered contrast by up to 0.54 ratio points in the
         one branch whose entire purpose is naming the real number. `reachable`
         first read `solvedAnchor !== null`, which called ANCHOR_CAP discarding a
         successful solve a pass -- 65 of 256 grey bases, worst 3.70:1 reported
         as reaching 4.5. Consulting the cap as well fixed that but still
         answered a question about the SOLVER; because the solver walks a 1/256
         grid and the clamps do not land on it, base #868686 then ships 4.514:1
         and was reported as a failure. Measuring the emitted token answers the
         only question anyone is actually asking. */
      contrast: Object.freeze({
        target: AA_TARGET,
        anchor,
        reachable: rampAchieved >= AA_TARGET,
        achieved: rampAchieved,
        /* The chrome ink is solved separately, against the bar it sits on, so it
           can fall short independently of the ramp and needs its own report. */
        chrome: Object.freeze({
          weight: chromeInkWeight,
          reachable: chromeAchieved >= AA_TARGET,
          achieved: chromeAchieved
        })
      }),
      tokens: Object.freeze(tokens)
    });
  }

  function visualSignature(value) {
    return JSON.stringify({
      theme: value.theme,
      mode: value.mode,
      custom: value.custom,
      typography: value.typography || DEFAULT_TYPOGRAPHY
    });
  }

  function readJson(key) {
    try {
      const raw = global.localStorage && global.localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function savedAppearance() {
    const policy = global.OpenLiveSessionPolicy;
    if (policy) return typeof policy.readSavedAppearance === 'function' ? policy.readSavedAppearance() : null;
    let value = readJson(SAVED_STORAGE_KEY);
    if(value && value.version===1 && value.state!==undefined){
      const prior=value.state;
      if(!prior||prior.version!==2||!Number.isInteger(prior.fontScale)||prior.fontScale<100||prior.fontScale>150||
          !Number.isSafeInteger(prior.updatedAt)||prior.updatedAt<0||typeof prior.revision!=='string'||!/^[a-z0-9:._-]{1,160}$/i.test(prior.revision))return null;
      value=Object.assign({},prior,{version:1});
    }
    if (!value || value.version !== 1 || !THEME_BY_ID.has(value.theme) || !['dark','light'].includes(value.mode)) return null;
    if (!validSavedTypography(value.typography)) return null;
    for (const mode of ['dark','light']) {
      const pair = value.custom && value.custom[mode];
      if (!pair || !HEX.test(pair.accent) || !HEX.test(pair.base)) return null;
    }
    return value;
  }

  function getSaveStatus() {
    const saved = savedAppearance(), choice = saved || DEFAULT_STATE;
    return Object.freeze({ saved: !!saved && visualSignature(normaliseState(saved, DEFAULT_STATE)) === visualSignature(state),
      isDefault: !saved && visualSignature(state) === visualSignature(DEFAULT_STATE), theme: choice.theme, mode: choice.mode });
  }

  function saveAppearance() {
    const current=frozenState(state);
    try {
    const record = { version: 1, theme: state.theme, mode: state.mode, custom: cloneCustom(state.custom), typography: Object.assign({}, state.typography) };
    const policy = global.OpenLiveSessionPolicy;
    if (policy) {
      if (typeof policy.saveAppearance !== 'function') throw new Error('Reopen Preferences to enable saving appearance.');
      policy.saveAppearance(record);
    } else {
      const bytes = JSON.stringify(record);
      if (!global.localStorage) throw new Error('Browser storage is unavailable.');
      global.localStorage.setItem(SAVED_STORAGE_KEY, bytes);
      if (global.localStorage.getItem(SAVED_STORAGE_KEY) !== bytes) throw new Error('The browser did not retain this appearance.');
    }
    if(channel)try{channel.postMessage({type:SAVED_EVENT_NAME});}catch(_){}
    notify('appearance-saved');
    return Object.freeze({ok:true,state:current});
    }catch(error){
      notify('save-failed');
      return Object.freeze({ok:false,state:current,error:String(error.message||error)});
    }
  }

  /* Normalize only that old session bootstrap (including its Custom twin) to
     the current startup default; deliberate session choices are preserved. */
  function isLegacyDefault(value) {
    if (!value || value.version !== 1 || value.mode !== 'dark') return false;
    if (value.theme === 'drive-by') return true;
    if (value.theme !== 'custom') return false;
    const custom = value.custom && typeof value.custom === 'object' ? value.custom : {};
    const dark = custom.dark && typeof custom.dark === 'object' ? custom.dark : {};
    const light = custom.light && typeof custom.light === 'object' ? custom.light : {};
    return cleanHex(dark.accent, '') === '#B4F3C9'
      && cleanHex(dark.base, '') === '#141F1D'
      && cleanHex(light.accent, '') === '#20A732'
      && cleanHex(light.base, '') === '#31343F';
  }

  function persistMigration(value) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (_) { /* the in-memory first paint still uses the migrated value */ }
    return value;
  }

  function readStored() {
    // Only session-policy storage is a RAM store. Never read/migrate older
    // durable records or implicitly save a palette in a standalone document.
    if (!global.OpenLiveSessionPolicy) return null;
    const current = readJson(STORAGE_KEY);
    if (current && current.version === VERSION) return normaliseState(current, DEFAULT_STATE);

    const legacy = readJson(LEGACY_STORAGE_KEY);
    if (!legacy || legacy.version !== 1) return null;
    if (isLegacyDefault(legacy)) {
      return persistMigration(normaliseState(DEFAULT_STATE, DEFAULT_STATE));
    }
    return persistMigration(normaliseState(legacy, DEFAULT_STATE));
  }

  const page = global.location && global.location.pathname
    ? global.location.pathname.split('/').pop() || 'window' : 'window';
  const clientId = `${page}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  let sequence = 0;
  let state = readStored() || normaliseState(savedAppearance() || DEFAULT_STATE, DEFAULT_STATE);
  let resolved = deriveTokens(state);
  let channel = null;
  const subscribers = new Set();

  function applyRoot() {
    const document = global.document;
    const root = document && document.documentElement;
    if (!root || !root.style) return;
    Object.entries(resolved.tokens).forEach(([name, value]) => root.style.setProperty(name, value));
    root.style.colorScheme = resolved.scheme;
    root.setAttribute('data-theme', state.theme);
    root.setAttribute('data-appearance-theme', state.theme);
    root.setAttribute('data-appearance-mode', state.mode);
    root.setAttribute('data-color-scheme', resolved.scheme);
    // Compatibility metadata only: InterfaceTypography is the sole scaler.
    root.style.setProperty('--openlive-ui-font-scale', String(state.typography.scale / 100));
    root.setAttribute('data-appearance-font-scale', String(state.typography.scale));
    if (global.OpenLiveInterfaceTypography) global.OpenLiveInterfaceTypography.apply(state.typography);
    try {
      const meta = document.querySelector && document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved.base);
    } catch (_) { /* a minimal test document may not implement selectors */ }
  }

  function eventDetail(source) {
    const snapshot = frozenState(state);
    return Object.freeze({
      version: snapshot.version,
      theme: snapshot.theme,
      mode: snapshot.mode,
      fontScale: snapshot.fontScale,
      custom: snapshot.custom,
      typography: snapshot.typography,
      updatedAt: snapshot.updatedAt,
      revision: snapshot.revision,
      state: snapshot,
      savedState: getSavedState(),
      isSaved: getSaveStatus().saved,
      themeDefinition: resolved.definition,
      colors: Object.freeze({
        accent: resolved.accent,
        base: resolved.base,
        onAccent: resolved.onAccent,
        onBase: resolved.onBase
      }),
      scheme: resolved.scheme,
      /* The honesty payload travels with every notification. Without it the
         measured shortfall was reachable only from resolve(), so no subscriber
         and no openlive:appearancechange listener could ever report it -- a
         published field with no path to a consumer, which is the same defect as
         a token nothing paints. preferences-appearance.js reads it from here. */
      contrast: resolved.contrast,
      tokens: resolved.tokens,
      source: source || 'api'
    });
  }

  function notify(source) {
    const detail = eventDetail(source);
    subscribers.forEach(listener => {
      try { listener(detail.state, detail); } catch (error) {
        global.setTimeout && global.setTimeout(() => { throw error; }, 0);
      }
    });
    if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new global.CustomEvent(EVENT_NAME, { detail }));
    }
  }

  function install(next, options) {
    const settings = options || {};
    state = normaliseState(next, state || DEFAULT_STATE);
    resolved = deriveTokens(state);
    applyRoot();
    if (settings.persist && global.OpenLiveSessionPolicy) {
      try {
        if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (_) { /* private mode/quota: the live window still changes */ }
    }
    if (settings.broadcast && channel) {
      try { channel.postMessage({ type: EVENT_NAME, state: cloneState(state) }); } catch (_) { /* noop */ }
    }
    if (settings.notify !== false) notify(settings.source);
    return frozenState(state);
  }

  function mergePartial(partial) {
    const patch = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
    const next = cloneState(state);
    if (patch.theme !== undefined || patch.themeId !== undefined) {
      next.theme = patch.theme === undefined ? patch.themeId : patch.theme;
    }
    if (patch.mode !== undefined) next.mode = patch.mode;
    if (patch.fontScale !== undefined) next.typography.scale = cleanFontScale(patch.fontScale, next.typography.scale);
    if (patch.typography && typeof patch.typography === 'object' && !Array.isArray(patch.typography))
      next.typography = normaliseTypography(Object.assign({}, next.typography, patch.typography), next.typography);
    if (patch.custom && typeof patch.custom === 'object') {
      ['dark', 'light'].forEach(mode => {
        const colorPatch = patch.custom[mode];
        if (!colorPatch || typeof colorPatch !== 'object') return;
        if (colorPatch.accent !== undefined) next.custom[mode].accent = colorPatch.accent;
        if (colorPatch.base !== undefined) next.custom[mode].base = colorPatch.base;
      });
    }
    return normaliseState(next, state);
  }

  function nextRevision() {
    const at = Math.max(Date.now(), cleanTime(state.updatedAt) + 1);
    return { at, revision: `${at.toString(36)}:${clientId}:${(++sequence).toString(36)}` };
  }

  function commit(partial, options) {
    const next = mergePartial(partial);
    if (visualSignature(next) === visualSignature(state)) return frozenState(state);
    const revision = nextRevision();
    next.updatedAt = revision.at;
    next.revision = revision.revision;
    const settings = options || {};
    return install(next, {
      persist: settings.persist !== false,
      broadcast: settings.broadcast !== false,
      notify: settings.notify !== false,
      source: settings.source || 'api'
    });
  }

  function isNewer(candidate) {
    if (candidate.updatedAt !== state.updatedAt) return candidate.updatedAt > state.updatedAt;
    return candidate.revision !== state.revision && candidate.revision > state.revision;
  }

  function receive(raw, source) {
    const payload = raw && raw.state ? raw.state : raw;
    if (!payload || typeof payload !== 'object' || payload.version !== VERSION) return false;
    const incoming = normaliseState(payload, DEFAULT_STATE);
    if (!isNewer(incoming)) return false;
    install(incoming, { persist: false, broadcast: false, notify: true, source });
    return true;
  }

  function subscribe(listener, options) {
    if (typeof listener !== 'function') return () => {};
    subscribers.add(listener);
    if (!options || options.immediate !== false) {
      const detail = eventDetail('subscribe');
      listener(detail.state, detail);
    }
    return () => subscribers.delete(listener);
  }

  function resolve(candidate) {
    const value = candidate === undefined ? state : mergePartial(candidate);
    return deriveTokens(value);
  }

  function getSavedState() {
    const saved=savedAppearance();
    return saved ? frozenState(normaliseState(saved, DEFAULT_STATE)) : null;
  }

  /* -----------------------------------------------------------------------
     Liquid Glass application chrome

     Every operator document loads this file before body paint. Once its DOM is
     ready, install the donor's ambient scene and a global Light/Dark control in
     each explicitly declared chrome header. Documents without explicit chrome
     retain the historical single-primary-header fallback. The buttons never
     own state: they commit through this service and follow the same subscription
     used by Preferences, storage events and BroadcastChannel peers.
     ----------------------------------------------------------------------- */
  const controlVector = (name, classes, fallback) => global.OpenLiveControlIcons?.has(name)
    ? global.OpenLiveControlIcons.markup(name).replace('class="showave-control-icon"','class="showave-control-icon '+classes+'"') : fallback;
  const SUN_ICON = controlVector('sun','appearance-mode-icon appearance-mode-icon-sun','<svg class="appearance-mode-icon appearance-mode-icon-sun" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>');
  const MOON_ICON = controlVector('moon','appearance-mode-icon appearance-mode-icon-moon','<svg class="appearance-mode-icon appearance-mode-icon-moon" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>');
  const WINDOW_ICONS = Object.freeze({
    minimize: controlVector('minimize','openlive-window-icon','<svg class="openlive-window-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 17.5h14"></path></svg>'),
    restore: controlVector('restore','openlive-window-icon','<svg class="openlive-window-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 8h11v11H8z"></path><path d="M5 15V5h10"></path></svg>'),
    maximize: controlVector('maximize','openlive-window-icon openlive-window-icon-maximize','<svg class="openlive-window-icon openlive-window-icon-maximize" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="5.5" y="5.5" width="13" height="13" rx=".6"></rect></svg>'),
    close: controlVector('close','openlive-window-icon openlive-window-icon-close','<svg class="openlive-window-icon openlive-window-icon-close" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6L6 18"></path></svg>'),
    reopen: controlVector('reset','openlive-window-icon openlive-window-icon-reopen','<svg class="openlive-window-icon openlive-window-icon-reopen" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 10a7.5 7.5 0 1 1-.2 4"></path><path d="M5 4v6h6"></path></svg>')
  });
  let windowChromeAdapter = null;
  const windowChromeControls = new Set();
  let windowChromeListenersInstalled = false;
  let windowChromeState = 'normal';
  const SETTINGS_DOCUMENTS = ['preferences.html','preferences-legacy.html','wire-settings.html'];
  const UTILITY_DOCUMENTS = [...SETTINGS_DOCUMENTS,'shortcuts.html','presets.html','media-manager.html',
    'reference.html','encoder-editor.html','fixture-editor.html','envelope-editor.html','panel.html'];

  function isUtilityDocument() {
    return UTILITY_DOCUMENTS.includes((global.location?.pathname || '').split('/').pop());
  }

  function nativeWindowChrome() {
    return !isFramed() && global.OpenLiveDesktop && global.OpenLiveDesktop.nativeWindowFrame === true &&
      typeof global.OpenLiveDesktop.windowAction === 'function' ? global.OpenLiveDesktop : null;
  }

  function windowChromeMount(document, header) {
    if (!document || !header || typeof document.createElement !== 'function') return null;
    const existing = header.querySelector && header.querySelector('.openlive-window-controls');
    if (existing) return existing;
    const mount = header.id === 'menubar' && header.querySelector
      ? (header.querySelector('.mb-right') || header) : header;
    const controls = document.createElement('div');
    controls.className = 'openlive-window-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', nativeWindowChrome() ? 'Appearance controls' : 'Appearance and window controls');
    mount.appendChild(controls);
    return controls;
  }

  function installModeToggle(document, header, requestedMount) {
    if (!document || !header || typeof document.createElement !== 'function') return null;
    const existing = header.querySelector && header.querySelector('.appearance-mode-toggle');
    if (existing) return existing;

    const mount = requestedMount || (header.id === 'menubar' && header.querySelector
      ? (header.querySelector('.mb-right') || header) : header);
    const divider = document.createElement('span');
    divider.className = 'appearance-mode-divider';
    divider.setAttribute('aria-hidden', 'true');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'appearance-mode-toggle';
    button.setAttribute('data-openlive-appearance-toggle', '');
    button.setAttribute('aria-label', 'Switch to dark appearance');
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `<span class="appearance-mode-icon-wrapper">${SUN_ICON}${MOON_ICON}</span>`;

    const syncModeButton = next => {
      const dark = next && next.mode === 'dark';
      const label = dark ? 'Switch to light appearance' : 'Switch to dark appearance';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('data-mode', dark ? 'dark' : 'light');
    };

    button.addEventListener('click', () => {
      const current = state;
      const nextMode = current.mode === 'dark' ? 'light' : 'dark';
      commit({ mode: nextMode }, { source: 'header-mode-toggle' });
    });

    mount.appendChild(divider);
    mount.appendChild(button);
    const unsubscribeMode = subscribe(syncModeButton);
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('pagehide', () => unsubscribeMode(), { once: true });
    }
    return button;
  }

  function isFramed() {
    try { return !!(global.parent && global.parent !== global); }
    catch (_) { return true; }
  }

  function isMainDocument() {
    const path = String(global.location && global.location.pathname || '').replace(/\/+$/, '');
    return !path || path === '/' || /\/index\.html$/i.test(path);
  }

  function setWindowChromeState(next) {
    const document = global.document;
    if (!document || !document.documentElement) return;
    windowChromeState = next === 'minimized' || next === 'closed' ? next : 'normal';
    if (windowChromeState === 'normal') document.documentElement.removeAttribute('data-openlive-window-state');
    else document.documentElement.setAttribute('data-openlive-window-state', windowChromeState);
    syncWindowChromeControls(document);
  }

  function emitWindowControl(action) {
    const document = global.document;
    if (!document || typeof document.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return false;
    const detail = { action, handled: false, source: 'header-window-controls' };
    const event = new global.CustomEvent('openlive:windowcontrol', { cancelable: true, detail });
    const allowed = document.dispatchEvent(event);
    return allowed === false || detail.handled === true || event.defaultPrevented === true;
  }

  function requestWindowMinimize() {
    const desktop = nativeWindowChrome();
    if (desktop) return desktop.windowAction('minimize');
    if (windowChromeState === 'minimized' || windowChromeState === 'closed') {
      setWindowChromeState('normal');
      return;
    }
    if (emitWindowControl('minimize')) return;
    if (windowChromeAdapter && typeof windowChromeAdapter.minimize === 'function') {
      const handled = windowChromeAdapter.minimize();
      if (handled !== false) return;
    }
    /* Browsers expose no OS-window minimise primitive. Collapse only this
       application surface, keep a visible Restore button, and never pretend
       the browser or operating-system window itself was minimised. */
    setWindowChromeState('minimized');
  }

  function requestWindowMaximize() {
    const desktop = nativeWindowChrome();
    if (desktop) return desktop.windowAction('maximize');
    const document = global.document;
    if (!document || !document.documentElement) return;
    if (emitWindowControl(document.fullscreenElement ? 'restore' : 'maximize')) return;
    if (windowChromeAdapter && typeof windowChromeAdapter.toggleMaximize === 'function') {
      const handled = windowChromeAdapter.toggleMaximize(!!document.fullscreenElement);
      if (handled !== false) return;
    }
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit === 'function') Promise.resolve(exit.call(document)).catch(() => {});
      return;
    }
    if (windowChromeState !== 'normal') setWindowChromeState('normal');
    const root = document.documentElement;
    const enter = root.requestFullscreen || root.webkitRequestFullscreen;
    if (typeof enter === 'function') Promise.resolve(enter.call(root)).catch(() => syncWindowChromeControls(document));
  }

  function fallbackWindowClose() {
    const document = global.document;
    try {
      if (global.parent && global.parent !== global &&
          typeof global.parent.__openliveClosePanel === 'function') {
        global.parent.__openliveClosePanel();
        return;
      }
    } catch (_) { /* a cross-origin parent cannot host an OpenLive panel */ }
    try {
      if (global.opener && !global.opener.closed) {
        global.close();
        global.setTimeout && global.setTimeout(() => {
          if (!global.closed) setWindowChromeState('closed');
        }, 120);
        return;
      }
    } catch (_) { /* continue to the same-origin fallback */ }
    if (!isMainDocument() && global.location) {
      global.location.href = 'index.html';
      return;
    }
    /* A user-opened browser tab cannot be closed by page script. Suspend the
       main surface recoverably instead of lying, navigating away, or losing
       live state. The X becomes a Reopen control in this state. */
    setWindowChromeState('closed');
  }

  function requestWindowClose() {
    const desktop = nativeWindowChrome();
    if (desktop) return desktop.windowAction('close');
    if (windowChromeState === 'closed') {
      setWindowChromeState('normal');
      return;
    }
    if (emitWindowControl('close')) return;
    if (windowChromeAdapter && typeof windowChromeAdapter.requestClose === 'function') {
      let result;
      try { result = windowChromeAdapter.requestClose(); }
      catch (_) { result = false; }
      Promise.resolve(result).then(handled => {
        if (handled === false) fallbackWindowClose();
      }, fallbackWindowClose);
      return;
    }
    fallbackWindowClose();
  }

  function syncWindowChromeControls(document) {
    if (!document || !windowChromeControls.size) return;
    const minimized = windowChromeState === 'minimized';
    const closed = windowChromeState === 'closed';
    const fullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    windowChromeControls.forEach(controls => {
      if (!controls || !controls.querySelector) return;
      const minimize = controls.querySelector('[data-window-action="minimize"]');
      const maximize = controls.querySelector('[data-window-action="maximize"]');
      const close = controls.querySelector('[data-window-action="close"]');
      if (minimize) {
        minimize.setAttribute('aria-expanded', String(!minimized));
        minimize.setAttribute('aria-label', minimized ? 'Restore interface' : 'Minimize interface');
        minimize.setAttribute('title', minimized ? 'Restore interface' : 'Minimize interface');
        minimize.setAttribute('data-restoring', String(minimized));
      }
      if (maximize) {
        maximize.setAttribute('aria-pressed', String(fullscreen));
        maximize.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
        maximize.setAttribute('title', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
        maximize.setAttribute('data-restoring', String(fullscreen));
      }
      if (close) {
        close.setAttribute('aria-label', closed ? 'Reopen application' : 'Close application');
        close.setAttribute('title', closed ? 'Reopen application' : 'Close application');
        close.setAttribute('data-reopen', String(closed));
      }
    });
  }

  function installWindowControls(document, header, controls) {
    if (!document || !header || !controls || isFramed()) return null;
    // Desktop title bars already own these actions, including macOS traffic lights.
    if (nativeWindowChrome()) {
      const pageMaximize = header.querySelector && header.querySelector('#btnMax');
      if (pageMaximize) pageMaximize.hidden = true;
      return null;
    }
    if (controls.querySelector && controls.querySelector('[data-window-action]')) {
      windowChromeControls.add(controls);
      syncWindowChromeControls(document);
      return controls;
    }
    const divider = document.createElement('span');
    divider.className = 'openlive-window-divider';
    divider.setAttribute('aria-hidden', 'true');
    controls.appendChild(divider);

    const add = (action, icon, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `openlive-window-control openlive-window-${action}`;
      button.setAttribute('data-window-action', action);
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.innerHTML = icon;
      controls.appendChild(button);
      return button;
    };
    const minimize = add('minimize', WINDOW_ICONS.minimize + WINDOW_ICONS.restore, 'Minimize interface');
    const hasPageMaximize = !!(header.querySelector && header.querySelector('#btnMax'));
    const maximize = hasPageMaximize ? null :
      add('maximize', WINDOW_ICONS.maximize + WINDOW_ICONS.restore, 'Enter fullscreen');
    const close = add('close', WINDOW_ICONS.close + WINDOW_ICONS.reopen, 'Close application');
    minimize.addEventListener('click', requestWindowMinimize);
    if (maximize) maximize.addEventListener('click', requestWindowMaximize);
    close.addEventListener('click', requestWindowClose);
    windowChromeControls.add(controls);
    if (!windowChromeListenersInstalled && typeof document.addEventListener === 'function') {
      document.addEventListener('fullscreenchange', () => syncWindowChromeControls(document));
      document.addEventListener('webkitfullscreenchange', () => syncWindowChromeControls(document));
      windowChromeListenersInstalled = true;
    }
    syncWindowChromeControls(document);
    return controls;
  }

  function installGlassMesh(document) {
    if (!document || !document.body || typeof document.createElement !== 'function') return null;
    const existing = document.querySelector && document.querySelector('.openlive-glass-mesh');
    if (existing) return existing;
    const mesh = document.createElement('div');
    mesh.className = 'openlive-glass-mesh';
    mesh.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(mesh, document.body.firstChild || null);
    return mesh;
  }

  function updateHeaderPill(nav, item, smooth) {
    if (!nav || !item || !item.getBoundingClientRect) return;
    const pill = nav.querySelector && nav.querySelector('.openlive-active-pill');
    if (!pill) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (!itemRect.width) return;
    if (smooth === false) pill.style.transition = 'none';
    else pill.style.removeProperty('transition');
    pill.style.width = `${itemRect.width}px`;
    pill.style.transform = `translateX(${itemRect.left - navRect.left + (nav.scrollLeft || 0)}px)`;
    nav.querySelectorAll('.menu-top[data-glass-active="true"]').forEach(node => {
      if (node !== item) node.removeAttribute('data-glass-active');
    });
    item.setAttribute('data-glass-active', 'true');
    if (smooth === false) {
      void pill.offsetWidth;
      const restore = () => pill.style.removeProperty('transition');
      if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(restore);
      else global.setTimeout && global.setTimeout(restore, 0);
    }
  }

  function installHeaderPill(document, header) {
    if (!header || header.id !== 'menubar' || !header.querySelector) return null;
    const nav = header.querySelector('#menus') || header.querySelector('#menubarMenus');
    if (!nav) return null;
    nav.classList.add('openlive-nav-items');

    const ensure = smooth => {
      let pill = nav.querySelector('.openlive-active-pill');
      if (!pill) {
        pill = document.createElement('span');
        pill.className = 'openlive-active-pill';
        pill.setAttribute('aria-hidden', 'true');
        nav.insertBefore(pill, nav.firstChild || null);
      }
      const items = Array.from(nav.querySelectorAll('.menu-top'));
      const active = nav.querySelector('.menu-top.open,.menu-top[data-glass-active="true"],.menu-top[aria-current="page"]') || items[0];
      if (active) updateHeaderPill(nav, active, smooth);
      return pill;
    };

    if (!nav.hasAttribute('data-openlive-pill-ready')) {
      nav.setAttribute('data-openlive-pill-ready', 'true');
      const activateFromEvent = event => {
        const item = event.target && event.target.closest && event.target.closest('.menu-top');
        if (item && nav.contains(item)) updateHeaderPill(nav, item, true);
      };
      nav.addEventListener('pointerover', activateFromEvent);
      nav.addEventListener('focusin', activateFromEvent);
      nav.addEventListener('click', activateFromEvent);
      if (typeof global.addEventListener === 'function') {
        global.addEventListener('resize', () => {
          const active = nav.querySelector('.menu-top[data-glass-active="true"]') || nav.querySelector('.menu-top');
          if (active) updateHeaderPill(nav, active, false);
        });
      }
      /* Some embedded/browser-host DOM shims expose querySelector results that
         look element-like but are not Nodes from this window. MutationObserver
         rejects those before our callback can run, so fail closed and keep the
         static active state instead of leaking a startup exception. */
      const observableNav = typeof global.Node !== 'function' || nav instanceof global.Node;
      const staticHeader = document.documentElement &&
        document.documentElement.hasAttribute('data-openlive-static-header');
      if (!staticHeader && observableNav && typeof global.MutationObserver === 'function') {
        const observer = new global.MutationObserver(() => ensure(false));
        try { observer.observe(nav, { childList: true }); }
        catch (_) { /* a non-browser DOM shim may expose selectors without Nodes */ }
      }
    }
    global.setTimeout && global.setTimeout(() => ensure(false), 50);
    return ensure(false);
  }

  function installChrome() {
    const document = global.document;
    if (!document || !document.body || typeof document.createElement !== 'function' ||
        typeof document.querySelector !== 'function') return false;
    installGlassMesh(document);
    const explicitHeaders = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('[data-openlive-chrome]')) : [];
    const fallbackHeader = explicitHeaders.length ? null : (
      document.querySelector('#menubar') ||
      document.querySelector('.win-root > .win-title') ||
      document.querySelector('body > .win-title')
    );
    const headers = explicitHeaders.length ? explicitHeaders : (fallbackHeader ? [fallbackHeader] : []);
    if (!headers.length) return false;
    headers.forEach(header => {
      const nativeUtility = isUtilityDocument() && nativeWindowChrome();
      if (nativeUtility) consolidateUtilityHeader(document, header);
      else header.classList.add('openlive-glass-header');
      installHeaderPill(document, header);
      const controls = isFramed() ? null : windowChromeMount(document, header);
      installModeToggle(document, header, controls);
      installWindowControls(document, header, controls);
    });
    return true;
  }

  function consolidateUtilityHeader(document, header) {
    if (header.hasAttribute('data-openlive-utility-actions')) return;
    // Keep the actual elements in this document: menus and editor state still
    // find their IDs and every existing action keeps its original listeners.
    // Only the operating-system frame supplies the detached window's title.
    header.setAttribute('data-openlive-utility-actions', '');
    header.setAttribute('data-openlive-chrome', '');
    header.classList.remove('win-title', 'openlive-glass-header');
    header.classList.add('openlive-utility-actions');
    header.setAttribute('role', 'group');
    header.setAttribute('aria-label', 'Editor actions');
    document.documentElement.setAttribute('data-openlive-title-owner', 'native');
    Array.from(header.childNodes || []).forEach(node => {
      if (node.nodeType === 3) {
        const caption = document.createElement('span');
        caption.className = 'openlive-utility-caption';
        header.insertBefore(caption, node);
        caption.appendChild(node);
      } else if (node.nodeType === 1 && (node.hasAttribute('data-showave-brand') ||
          node.id === 'ptitle' || (!node.id && !node.querySelector('a,button,input,select,[role="menuitem"],.menu-top') &&
          !node.matches('a,button,input,select,[role="menuitem"],.menu-top,.sp')))) {
        node.classList.add('openlive-utility-caption');
      }
    });
    const next = header.nextElementSibling;
    if (next?.classList.contains('win-toolbar')) {
      next.setAttribute('data-openlive-utility-toolbar', '');
      next.appendChild(header);
    } else {
      header.setAttribute('data-openlive-utility-toolbar', '');
      header.setAttribute('role', 'toolbar');
    }
  }

  function scheduleChromeInstall() {
    const document = global.document;
    if (!document || typeof document.createElement !== 'function') return;
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', installChrome, { once: true });
    } else {
      installChrome();
    }
  }

  /* Install before wiring asynchronous transports so first paint is correct. */
  applyRoot();

  if (typeof global.BroadcastChannel === 'function') {
    try {
      channel = new global.BroadcastChannel(CHANNEL_NAME);
      const onMessage = event => {
        const data = event && event.data;
        if (data && data.type === EVENT_NAME) receive(data, 'broadcast');
        if (data && data.type === SAVED_EVENT_NAME) notify('appearance-saved');
      };
      if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onMessage);
      else channel.onmessage = onMessage;
    } catch (_) { channel = null; }
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', event => {
      if (event && event.key === SAVED_STORAGE_KEY) { notify('appearance-saved'); return; }
      if (!event || event.key !== STORAGE_KEY) return;
      if (event.newValue == null) {
        const reset = cloneState(DEFAULT_STATE);
        const revision = nextRevision();
        reset.updatedAt = revision.at;
        reset.revision = revision.revision;
        install(reset, { persist: false, broadcast: false, notify: true, source: 'storage-clear' });
        return;
      }
      try { receive(JSON.parse(event.newValue), 'storage'); } catch (_) { /* invalid external value */ }
    });
  }

  const api = {
    version: VERSION,
    storageKey: STORAGE_KEY,
    legacyStorageKey: LEGACY_STORAGE_KEY,
    savedStorageKey: SAVED_STORAGE_KEY,
    channelName: CHANNEL_NAME,
    eventName: EVENT_NAME,
    themes: THEMES,
    fixedThemes: FIXED_THEMES,
    materials: GLASS_MATERIALS,
    defaults: frozenState(DEFAULT_STATE),
    getState: () => frozenState(state),
    getSaveStatus,
    getSavedState,
    isSaved: () => getSaveStatus().saved,
    save: saveAppearance,
    getTheme: id => THEME_BY_ID.get(String(id || '')) || null,
    setState: (partial, options) => commit(partial, options),
    apply: (partial, options) => commit(partial, options),
    setTheme: (theme, options) => commit({ theme }, options),
    setMode: (mode, options) => commit({ mode }, options),
    setFontScale: (fontScale, options) => commit({ fontScale }, options),
    refreshFontDeclarations: () => global.OpenLiveInterfaceTypography?.refresh(),
    setCustom: (custom, options) => commit({ custom }, options),
    reset: options => commit({
      theme: DEFAULT_STATE.theme,
      mode: DEFAULT_STATE.mode,
      custom: cloneCustom(DEFAULT_CUSTOM),
      typography: Object.assign({}, DEFAULT_TYPOGRAPHY)
    }, Object.assign({ source: 'reset' }, options || {})),
    resolve,
    subscribe,
    installChrome
  };
  const windowChromeApi = {
    register(adapter) {
      windowChromeAdapter = adapter && typeof adapter === 'object' ? adapter : null;
      return () => {
        if (windowChromeAdapter === adapter) windowChromeAdapter = null;
      };
    },
    getState: () => Object.freeze({
      state: windowChromeState,
      fullscreen: !!(global.document &&
        (global.document.fullscreenElement || global.document.webkitFullscreenElement))
    }),
    minimize: requestWindowMinimize,
    toggleFullscreen: requestWindowMaximize,
    close: requestWindowClose,
    restore: () => {
      const desktop = nativeWindowChrome();
      return desktop ? desktop.windowAction('restore') : setWindowChromeState('normal');
    }
  };
  global.OpenLiveAppearance = Object.freeze(api);
  global.OpenLiveWindowChrome = Object.freeze(windowChromeApi);
  // All operator documents share the startup window's utility/dialog skin.
  // Load after their historical page sheets; dynamic native dialogs inherit
  // the same CSS without an observer in the live workspace rendering path.
  const themeDocument = global.document;
  if (themeDocument?.head && typeof themeDocument.createElement === 'function') {
    const themeSource = themeDocument.currentScript?.src;
    const themeHref = themeSource && typeof global.URL === 'function'
      ? new global.URL('openlive-window-theme.css', themeSource).href : 'openlive-window-theme.css';
    const installWindowTheme = () => {
      const filename = (global.location?.pathname || '').split('/').pop();
      if (SETTINGS_DOCUMENTS.includes(filename)) themeDocument.body?.classList.add('showave-settings-window');
      if (UTILITY_DOCUMENTS.includes(filename)) themeDocument.body?.classList.add('showave-utility-window');
      if (themeDocument.getElementById('showave-window-theme')) return;
      const link = themeDocument.createElement('link');
      link.id = 'showave-window-theme'; link.rel = 'stylesheet'; link.href = themeHref;
      link.addEventListener('load', api.refreshFontDeclarations, { once:true });
      themeDocument.head.appendChild(link);
    };
    if (themeDocument.readyState === 'loading') themeDocument.addEventListener('DOMContentLoaded', installWindowTheme, { once:true });
    else installWindowTheme();
  }
  scheduleChromeInstall();
})(typeof globalThis !== 'undefined' ? globalThis : this);
