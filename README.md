# SHOWAVE website

The complete saved SHOWAVE website from before hosting: the official logo, Afro Unity Group identity, Kampala globe, native animation sequence, software family and authored information pages. This export preserves the saved homepage and all 35 authored routes. The original local project and private application source are not included in this repository.

The homepage retains its native 3D globe. If WebGL, map workers, or the drawing buffer fail, an animated Canvas2D globe uses locally bundled land points and the same Kampala routes. Graphics-context restoration returns to the native renderer after a successful frame check. The fallback follows the existing reveal, scroll, resize, and cleanup lifecycle.

Drag the globe with a mouse, swipe horizontally on touch screens, or focus it and use the arrow keys. Home resets the manual orientation. Automatic rotation pauses while the globe is held; vertical touch swipes and pinch gestures remain available to the browser.

The ocean uses the original live water shader and cloud transitions on compact screens as well as desktop. A lighter simulation and disabled ocean camera gestures keep compact views scrollable. While graphics initialize or are unavailable, a Canvas2D surface animates the saved ocean photograph; the existing mobile wake video accompanies it. Compatibility animation pauses offscreen and in hidden tabs, and respects reduced-motion settings.

Static hosting adaptations include a same-origin content policy, the publication hostname, three ocean texture aliases, directory-route handling, legacy redirects, and the existing public Windows preview.14 download configuration. Scene imagery remains as it was in the saved SHOWAVE project.

GitHub Pages serves https://showave.afrounity.club/. Preview locally with `python -m http.server 8182 --bind 127.0.0.1` from this directory. Downloads are hosted at https://github.com/dvicreateow-prog/showave-releases.
