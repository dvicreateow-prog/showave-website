/* Adapt only the globe data and view. All other native scene modules stay intact. */
import { r as createNativeGlobe, i as preloadLand } from '/mirror/united-carriers.netlify.app/chunks/my-flights-DRrlP7HY.js?showave-native=1';
import { ORIGIN, AFRICA_PHI, airportsData, flightsData } from './globe-routes.js';

export { airportsData as n, flightsData as t, preloadLand as i };

export function r(canvas, options = {}) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const globe = createNativeGlobe(canvas, {
    ...options, airportsData, flightsData, showArcs: true,
    pinDotColor: '#ff8a45', arcColor: '#ff783c', arcThickness: 0.0016,
    arcAltBase: 0.035, arcAltMultiplier: 0.09
  });
  canvas.setAttribute('aria-label', 'SHOWAVE connections from Kampala, Uganda, to the world. Illustrative routes.');
  let originBranded = false;
  function identifyOrigin() {
    if (originBranded) return;
    // CSS2D attaches labels on the first native render, after construction.
    const labels = canvas.parentElement?.querySelectorAll('.globe-label-text') || [];
    const originLabel = [...labels].find(label => label.textContent === ORIGIN.label);
    if (!originLabel) return;
    originLabel.parentElement.classList.add('showave-origin-label');
    originLabel.setAttribute('title', 'SHOWAVE · Powered by Afro Unity Group. From Africa to the world.');
    const caption = document.createElement('span');
    caption.className = 'showave-origin-caption';
    caption.textContent = 'AFRO UNITY GROUP';
    originLabel.appendChild(caption);
    originBranded = true;
  }
  const updateNative = globe.update;
  let elapsed = 0;
  globe.update = ({ deltaTime = 0 } = {}) => {
    // Keep Africa in view as outbound waves travel around the whole globe.
    // When dragged, the native orbit controls keep their normal behaviour.
    if (!motion.matches && !globe.isInteracting()) elapsed += Math.min(100, Math.max(0, Number.isFinite(deltaTime) ? deltaTime : 0));
    const yaw = AFRICA_PHI + (motion.matches ? 0 : Math.sin(elapsed / 24000) * 0.22);
    updateNative({ phi: yaw, deltaTime: motion.matches ? 0 : deltaTime });
    identifyOrigin();
  };
  return globe;
}
