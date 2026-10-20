/* Small, deterministic route effects. The globe's existing update owns time. */
export const ROUTE_SPARKS_PER_CONNECTION = 16;
export const ROUTE_SPARK_LIMIT = 256;
export const ROUTE_SPARK_PALETTE = ['#ffc66b', '#ff973f', '#ffd485'];
export const ROUTE_PULSE_TAIL = 0.14;
export function routePulseTiming(index) {
  const seed = ((index + 1) * 0.618033988749895) % 1;
  const travel = 4100 + ((index * 0.41421356237) % 1) * 1700;
  const cycle = travel + 2100 + seed * 1000;
  return { seed, travel, cycle, phase: seed * cycle };
}
const TRAIL_POINTS = 12;
const ARRIVAL_POINTS = 4;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const colors = ROUTE_SPARK_PALETTE.map(color => {
  const rgb = Number.parseInt(color.slice(1), 16);
  return [linear((rgb >> 16 & 255) / 255), linear((rgb >> 8 & 255) / 255), linear((rgb & 255) / 255)];
});

export function createRouteSparkField(curves) {
  const routes = curves.slice(0, ROUTE_SPARK_LIMIT / ROUTE_SPARKS_PER_CONNECTION).map((curve, index) => {
    const end = curve.length - 3;
    const x = curve[end], y = curve[end + 1], z = curve[end + 2];
    const length = Math.hypot(x, y, z);
    const normal = [x / length, y / length, z / length];
    let tx = normal[2], tz = -normal[0];
    const tangentLength = Math.hypot(tx, tz) || 1;
    tx /= tangentLength; tz /= tangentLength;
    const tangent = [tx, 0, tz];
    const bitangent = [normal[1] * tz, normal[2] * tx - normal[0] * tz, -normal[1] * tx];
    return { curve, normal, tangent, bitangent, ...routePulseTiming(index) };
  });
  const count = routes.length * ROUTE_SPARKS_PER_CONNECTION;
  const positions = new Float32Array(count * 3);
  const vertexColors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const colorIndices = new Uint8Array(count);
  // Per route: eased head progress, luminous tail fade, arrival age, cycle age.
  const pulseStates = new Float32Array(routes.length * 4);
  let activeCount = 0;

  function color(slot, alpha, palette) {
    alphas[slot] = alpha;
    colorIndices[slot] = palette;
    const offset = slot * 3, rgb = colors[palette];
    vertexColors[offset] = rgb[0] * alpha;
    vertexColors[offset + 1] = rgb[1] * alpha;
    vertexColors[offset + 2] = rgb[2] * alpha;
    if (alpha > 0.015) activeCount += 1;
  }

  function sample(curve, progress, slot) {
    const point = clamp(progress, 0, 1) * (curve.length / 3 - 1);
    const left = Math.min(curve.length / 3 - 2, Math.floor(point));
    const fraction = point - left, offset = left * 3, destination = slot * 3;
    for (let axis = 0; axis < 3; axis++) {
      positions[destination + axis] = curve[offset + axis] +
        (curve[offset + axis + 3] - curve[offset + axis]) * fraction;
    }
  }

  function update(milliseconds, enabled = true) {
    activeCount = 0;
    const time = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
    for (let index = 0; index < routes.length; index++) {
      const route = routes[index], first = index * ROUTE_SPARKS_PER_CONNECTION;
      const age = (time + route.phase) % route.cycle;
      const travelProgress = clamp(age / route.travel, 0, 1);
      pulseStates[index * 4] = travelProgress * travelProgress * (3 - 2 * travelProgress);
      pulseStates[index * 4 + 1] = enabled ? clamp(1 - Math.max(0, age - route.travel) / 450, 0, 1) : 0;
      pulseStates[index * 4 + 2] = age - route.travel;
      pulseStates[index * 4 + 3] = age;
      for (let trail = 0; trail < TRAIL_POINTS; trail++) {
        const slot = first + trail;
        const delayed = age - trail * 28;
        const progress = clamp(delayed / route.travel, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        sample(route.curve, eased, slot);
        const fadeAfterArrival = clamp(1 - Math.max(0, delayed - route.travel) / 170, 0, 1);
        const alpha = enabled && delayed >= 0 && delayed <= route.travel + 170 ?
          0.95 * (1 - trail / TRAIL_POINTS) ** 1.8 * fadeAfterArrival : 0;
        color(slot, alpha, trail < 2 ? 0 : 1);
      }
      const end = route.curve.length - 3;
      for (let spark = 0; spark < ARRIVAL_POINTS; spark++) {
        const slot = first + TRAIL_POINTS + spark, offset = slot * 3;
        const life = 480 + ((spark + index) % 4) * 75;
        const ageAfterArrival = age - route.travel - spark * 32;
        const progress = clamp(ageAfterArrival / life, 0, 1);
        const distance = 0.0025 + spark * 0.0004;
        const angle = spark * 2.3999632297 + route.seed * Math.PI * 2;
        const u = Math.cos(angle) * distance;
        const v = Math.sin(angle) * distance;
        for (let axis = 0; axis < 3; axis++) {
          positions[offset + axis] = route.curve[end + axis] +
            route.tangent[axis] * u + route.bitangent[axis] * v +
            route.normal[axis] * 0.004 * (1 - progress);
        }
        const alpha = enabled && ageAfterArrival >= 0 && ageAfterArrival <= life ?
          0.9 * (1 - progress) ** 2 : 0;
        color(slot, alpha, 2);
      }
    }
    return activeCount;
  }

  update(0, false);
  return { count, positions, vertexColors, alphas, colorIndices, pulseStates, update,
    get activeCount() { return activeCount; } };
}
