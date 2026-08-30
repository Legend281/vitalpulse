/**
 * geohash.js — Scaled Base32 Geohash & Spatial Indexing
 * 
 * Provides high-performance spatial indexing for donor-to-hospital matching.
 * Converts 2D GPS coordinates into compact hierarchical string keys.
 * 
 * Precision Reference:
 *   Precision 4: ~39 km x ~19 km (Regional coverage)
 *   Precision 5: ~4.9 km x ~4.9 km (Metropolitan / City District)
 *   Precision 6: ~1.2 km x ~0.6 km (Neighborhood / Ward level)
 *   Precision 7: ~152 m x ~152 m (Street level)
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const BITS = [16, 8, 4, 2, 1];

/**
 * Encodes latitude and longitude into a geohash string
 * 
 * @param {number} latitude - Latitude in degrees [-90, 90]
 * @param {number} longitude - Longitude in degrees [-180, 180]
 * @param {number} [precision=6] - Desired character length
 * @returns {string}
 */
export function encodeGeohash(latitude, longitude, precision = 6) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || isNaN(latitude) || isNaN(longitude)) {
    throw new Error('Invalid latitude or longitude coordinates');
  }

  let latMin = -90.0;
  let latMax = 90.0;
  let lonMin = -180.0;
  let lonMax = 180.0;

  let geohash = '';
  let isEven = true;
  let bit = 0;
  let ch = 0;

  while (geohash.length < precision) {
    if (isEven) {
      const mid = (lonMin + lonMax) / 2;
      if (longitude >= mid) {
        ch |= BITS[bit];
        lonMin = mid;
      } else {
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) {
        ch |= BITS[bit];
        latMin = mid;
      } else {
        latMax = mid;
      }
    }

    isEven = !isEven;
    if (bit < 4) {
      bit++;
    } else {
      geohash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return geohash;
}

/**
 * Decodes a geohash string into latitude and longitude bounds and center point
 * 
 * @param {string} geohash - The geohash string
 * @returns {{ latitude: number, longitude: number, bounds: { latMin: number, latMax: number, lonMin: number, lonMax: number } }}
 */
export function decodeGeohash(geohash) {
  if (!geohash || typeof geohash !== 'string') {
    throw new Error('Invalid geohash string');
  }

  const clean = geohash.toLowerCase().trim();
  let isEven = true;
  let latMin = -90.0;
  let latMax = 90.0;
  let lonMin = -180.0;
  let lonMax = 180.0;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    const cd = BASE32.indexOf(c);
    if (cd === -1) {
      throw new Error(`Invalid geohash character '${c}'`);
    }

    for (let j = 0; j < 5; j++) {
      const mask = BITS[j];
      if (isEven) {
        const mid = (lonMin + lonMax) / 2;
        if ((cd & mask) !== 0) {
          lonMin = mid;
        } else {
          lonMax = mid;
        }
      } else {
        const mid = (latMin + latMax) / 2;
        if ((cd & mask) !== 0) {
          latMin = mid;
        } else {
          latMax = mid;
        }
      }
      isEven = !isEven;
    }
  }

  const latitude = (latMin + latMax) / 2;
  const longitude = (lonMin + lonMax) / 2;

  return {
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
    bounds: { latMin, latMax, lonMin, lonMax }
  };
}

/**
 * Calculates the adjacent neighbor in a cardinal direction (n, s, e, w)
 */
export function getGeohashAdjacent(geohash, direction) {
  const dir = direction.toLowerCase();
  const decoded = decodeGeohash(geohash);
  const latDelta = (decoded.bounds.latMax - decoded.bounds.latMin);
  const lonDelta = (decoded.bounds.lonMax - decoded.bounds.lonMin);

  let lat = decoded.latitude;
  let lon = decoded.longitude;

  if (dir === 'n') lat += latDelta;
  else if (dir === 's') lat -= latDelta;
  else if (dir === 'e') lon += lonDelta;
  else if (dir === 'w') lon -= lonDelta;
  else throw new Error(`Invalid direction '${direction}' — must be 'n', 's', 'e', or 'w'`);

  // Wrap longitude [-180, 180]
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;

  // Clamp latitude [-90, 90]
  if (lat > 90) lat = 90;
  if (lat < -90) lat = -90;

  return encodeGeohash(lat, lon, geohash.length);
}

/**
 * Returns all 8 surrounding neighbor cells + center cell
 * 
 * @param {string} geohash - Center geohash
 * @returns {string[]} Array of 9 geohash strings (center + 8 neighbors)
 */
export function getGeohashNeighbors(geohash) {
  const n = getGeohashAdjacent(geohash, 'n');
  const s = getGeohashAdjacent(geohash, 's');
  const e = getGeohashAdjacent(geohash, 'e');
  const w = getGeohashAdjacent(geohash, 'w');

  const ne = getGeohashAdjacent(n, 'e');
  const nw = getGeohashAdjacent(n, 'w');
  const se = getGeohashAdjacent(s, 'e');
  const sw = getGeohashAdjacent(s, 'w');

  return [geohash, n, ne, e, se, s, sw, w, nw];
}

/**
 * Computes bounding geohash query prefixes for a search radius
 * 
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} radiusKm
 * @returns {string[]} Unique geohash prefixes to query
 */
export function getGeohashesForRadius(latitude, longitude, radiusKm = 15) {
  let precision = 5; // Default ~5km
  if (radiusKm <= 2) precision = 6; // ~1.2km
  else if (radiusKm <= 10) precision = 5; // ~5km
  else if (radiusKm <= 40) precision = 4; // ~39km
  else precision = 3; // ~150km

  const centerGeohash = encodeGeohash(latitude, longitude, precision);
  return getGeohashNeighbors(centerGeohash);
}
