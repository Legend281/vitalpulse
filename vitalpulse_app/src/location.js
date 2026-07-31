import { CITY_COORDINATES, calculateDistanceKm } from './db';

export function findNearestCity(lat, lng) {
  if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;
  let nearest = null;
  let minDist = Infinity;
  for (const [name, coord] of Object.entries(CITY_COORDINATES)) {
    const dist = calculateDistanceKm(lat, lng, coord.lat, coord.lon || coord.lng);
    if (dist !== null && dist < minDist) {
      minDist = dist;
      nearest = { name, dist: Math.round(dist * 10) / 10 };
    }
  }
  return nearest && minDist <= 100 ? nearest : null;
}

export async function captureUserLocation(fallbackCity = 'Yaoundé') {
    return new Promise((resolve) => {
        const safeFallback = fallbackCity || 'Yaoundé';
        const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const key = safeFallback.trim().toLowerCase();
        const coords = CITY_COORDINATES[key] || CITY_COORDINATES['yaoundé'];

        if (!isSecure || !navigator.geolocation) {
            const reason = !isSecure
                ? 'HTTP non-secure origin (browser requires HTTPS or localhost for GPS)'
                : 'Browser Geolocation API unavailable';
            console.info(`Location fallback active (${reason}). Using city: ${safeFallback}`);
            resolve({
                lat: coords.lat,
                lng: coords.lon || coords.lng,
                source: 'city',
                city: safeFallback,
                reason
            });
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const nearest = findNearestCity(pos.coords.latitude, pos.coords.longitude);
                resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    source: 'gps',
                    accuracyKm: Math.round((pos.coords.accuracy || 0) / 1000 * 10) / 10,
                    city: nearest ? nearest.name.charAt(0).toUpperCase() + nearest.name.slice(1) : safeFallback,
                    nearestDistKm: nearest?.dist || null
                });
            },
            (err) => {
                console.warn('GPS permission denied or unavailable:', err.message);
                resolve({
                    lat: coords.lat,
                    lng: coords.lon || coords.lng,
                    source: 'city',
                    city: safeFallback,
                    reason: err.message
                });
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
        );
    });
}
