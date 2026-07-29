import { CITY_COORDINATES } from './db';

/**
 * Prompts user for browser Geolocation API access.
 * Returns { lat, lng, source: 'gps' } if granted,
 * or falls back to { lat, lng, source: 'city' } using city string.
 */
export async function captureUserLocation(fallbackCity = 'Yaoundé') {
    return new Promise((resolve) => {
        const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const key = (fallbackCity || 'Yaoundé').trim().toLowerCase();
        const coords = CITY_COORDINATES[key] || CITY_COORDINATES['yaoundé'];

        if (!isSecure || !navigator.geolocation) {
            const reason = !isSecure
                ? 'HTTP non-secure origin (browser requires HTTPS or localhost for GPS)'
                : 'Browser Geolocation API unavailable';
            console.info(`Location fallback active (${reason}). Using city: ${fallbackCity}`);
            resolve({
                lat: coords.lat,
                lng: coords.lon || coords.lng,
                source: 'city',
                city: fallbackCity,
                reason
            });
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                resolve({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    source: 'gps',
                    accuracyKm: Math.round((pos.coords.accuracy || 0) / 1000 * 10) / 10,
                    city: fallbackCity
                });
            },
            (err) => {
                console.warn('GPS permission denied or unavailable:', err.message);
                resolve({
                    lat: coords.lat,
                    lng: coords.lon || coords.lng,
                    source: 'city',
                    city: fallbackCity,
                    reason: err.message
                });
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
        );
    });
}
