# SHOWAVE website

The complete saved SHOWAVE website from before hosting: the official logo, Afro Unity Group identity, Kampala globe, native animation sequence, software family and authored information pages. This export preserves the saved homepage and all 35 authored routes. The original local project and private application source are not included in this repository.

The homepage retains its native 3D globe. If WebGL, map workers, or the drawing buffer fail, an animated Canvas2D globe uses locally bundled land points and the same Kampala routes. Graphics-context restoration returns to the native renderer after a successful frame check. The fallback follows the existing reveal, scroll, resize, and cleanup lifecycle.

Static hosting adaptations are limited to a same-origin content policy, the publication hostname, three ocean texture aliases, directory-route handling, legacy redirects, and the existing public Windows preview.14 download configuration. Scene imagery remains as it was in the saved SHOWAVE project.

GitHub Pages serves https://showave.afrounity.club/. Preview locally with `python -m http.server 8182 --bind 127.0.0.1` from this directory. Downloads are hosted at https://github.com/dvicreateow-prog/showave-releases.
