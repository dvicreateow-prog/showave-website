# SHOWAVE website

The complete saved SHOWAVE website from before hosting: the official logo, Afro Unity Group identity, Kampala globe, native animation sequence, software family and authored information pages. This export preserves the saved homepage and all 35 authored routes. The original local project and private application source are not included in this repository.

The homepage retains its native 3D globe. If WebGL, map workers, or the drawing buffer fail, an animated Canvas2D globe uses locally bundled land points and the same Kampala routes. Graphics-context restoration returns to the native renderer after a successful frame check. The fallback follows the existing reveal, scroll, resize, and cleanup lifecycle.

Drag the globe with a mouse, swipe horizontally on touch screens, or focus it and use the arrow keys. Home resets the manual orientation. Automatic rotation pauses while the globe is held; vertical touch swipes and pinch gestures remain available to the browser.

The ocean uses the original live water shader and cloud transitions on compact screens as well as desktop. A lighter simulation and disabled ocean camera gestures keep compact views scrollable. While graphics initialize or are unavailable, a Canvas2D surface animates the saved ocean photograph; the existing mobile wake video accompanies it. Compatibility animation pauses offscreen and in hidden tabs, and respects reduced-motion settings.

Graphics preparation warms compressed upcoming assets in the browser's HTTP cache using two low-priority requests at a time. It yields during input, pauses in hidden tabs, and skips speculative downloads on data-saving connections. Image sequences asynchronously decode a small directional frame window, share at most two decode jobs, and cap decoded storage at 64 MiB on desktop / 32 MiB on compact screens. Their buffers use layout dimensions with a one-million-pixel cap rather than transformed dimensions. All original frames remain available; distant decoded frames are released and can be restored from HTTP cache.

Ocean GPU setup starts after the hero reveal and yields between preparation stages, while near-viewport loading still handles fast scrolling. Ocean drawing is capped at 60 fps, offscreen/hidden simulation and ship bobbing pause, and camera calculations reuse cached dimensions. Native globe buffers are capped at 1.5 million pixels and fallback buffers at one million; routes and interaction remain unchanged.

The ocean loads a prepared half-float reflection map instead of filtering the environment image during page startup. It was generated from the original environment with the bundled renderer and verified against the original reflected pixels at three roughness levels. The original generator remains available if the prepared asset cannot load. Wake shaders compile before the first simulation step. Sustained slow rendering gently reduces the ocean backing resolution, with gradual recovery when frame timing improves; the wave simulation and visual effects stay intact.

Both globe and ocean scheduling tolerate callback jitter while targeting 60 fps. The native globe skips completely invisible arrival rings and reuses parent transforms. Globe backing resolution adapts within bounded limits during sustained rendering pressure, while native text labels stay at full CSS resolution. The compatibility globe caches text measurements and avoids repainting unchanged reduced-motion frames. Ocean support reacts to readiness changes instead of repeating GPU and layout checks on every animated transform.

Static hosting adaptations include a same-origin content policy, the publication hostname, three ocean texture aliases, directory-route handling, legacy redirects, and the existing public Windows preview.14 download configuration. Scene imagery remains as it was in the saved SHOWAVE project.

GitHub Pages serves https://showave.afrounity.club/. Preview locally with `python -m http.server 8182 --bind 127.0.0.1` from this directory. Downloads are hosted at https://github.com/dvicreateow-prog/showave-releases.
