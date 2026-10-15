/* Symbolic creative connections, not office locations or live user telemetry. */
export const ORIGIN = Object.freeze({
  id: 'KLA', city: 'Kampala', country: 'Uganda', lat: 0.3476, lng: 32.5825,
  label: 'KAMPALA · UGANDA'
});

// Representative city coordinates keep the artwork geographically meaningful.
export const DESTINATIONS = Object.freeze([
  { id: 'NBO', country: 'KENYA', city: 'Nairobi', lat: -1.2921, lng: 36.8219 },
  { id: 'LOS', country: 'NIGERIA', city: 'Lagos', lat: 6.5244, lng: 3.3792 },
  { id: 'JNB', country: 'SOUTH AFRICA', city: 'Johannesburg', lat: -26.2041, lng: 28.0473 },
  { id: 'CAI', country: 'EGYPT', city: 'Cairo', lat: 30.0444, lng: 31.2357 },
  { id: 'LON', country: 'UK', city: 'London', lat: 51.5074, lng: -0.1278 },
  { id: 'BER', country: 'GERMANY', city: 'Berlin', lat: 52.52, lng: 13.405 },
  { id: 'DXB', country: 'UAE', city: 'Dubai', lat: 25.2048, lng: 55.2708 },
  { id: 'BOM', country: 'INDIA', city: 'Mumbai', lat: 19.076, lng: 72.8777 },
  { id: 'SIN', country: 'SINGAPORE', city: 'Singapore', lat: 1.3521, lng: 103.8198 },
  { id: 'TYO', country: 'JAPAN', city: 'Tokyo', lat: 35.6762, lng: 139.6503 },
  { id: 'SYD', country: 'AUSTRALIA', city: 'Sydney', lat: -33.8688, lng: 151.2093 },
  { id: 'NYC', country: 'USA', city: 'New York', lat: 40.7128, lng: -74.006 },
  { id: 'YYZ', country: 'CANADA', city: 'Toronto', lat: 43.6532, lng: -79.3832 },
  { id: 'SAO', country: 'BRAZIL', city: 'São Paulo', lat: -23.5505, lng: -46.6333 }
].map(point => Object.freeze(point)));

export const airportsData = Object.freeze({
  type: 'AirportsCollection',
  airports: Object.freeze([
    Object.freeze({ text: ORIGIN.id, size: 2.6, country: ORIGIN.label, city: ORIGIN.city, lat: String(ORIGIN.lat), lng: String(ORIGIN.lng) }),
    ...DESTINATIONS.map(point => Object.freeze({ text: point.id, size: 0.9, country: point.country, city: point.city, lat: String(point.lat), lng: String(point.lng) }))
  ])
});

export const flightsData = Object.freeze({
  type: 'FlightsCollection',
  flights: Object.freeze(DESTINATIONS.map((point, index) => Object.freeze({
    type: 'connection', order: index, from: ORIGIN.id, to: point.id,
    flightCode: `${ORIGIN.id}-${point.id}`, status: true,
    startLat: ORIGIN.lat, startLng: ORIGIN.lng, endLat: point.lat, endLng: point.lng
  })))
});

// The native renderer puts longitude on X/Z and applies a positive Y rotation.
// A slightly left-of-centre origin makes the hub visible in the cropped hero.
export const AFRICA_PHI = -(Math.PI / 2 + ORIGIN.lng * Math.PI / 180) - 0.32;
