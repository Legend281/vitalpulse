import { describe, it, expect } from 'vitest';
import {
  encodeGeohash,
  decodeGeohash,
  getGeohashAdjacent,
  getGeohashNeighbors,
  getGeohashesForRadius
} from './geohash.js';

describe('Geohash Spatial Indexing', () => {
  const DOUALA = { lat: 4.0511, lng: 9.7679 };
  const YAOUNDE = { lat: 3.8480, lng: 11.5021 };
  const BAFOUSSAM = { lat: 5.4778, lng: 10.4176 };
  const GAROUA = { lat: 9.3000, lng: 13.4000 };

  it('correctly encodes coordinates into precision-length base32 geohashes', () => {
    const hashDouala = encodeGeohash(DOUALA.lat, DOUALA.lng, 6);
    expect(hashDouala).toHaveLength(6);
    expect(typeof hashDouala).toBe('string');
    expect(hashDouala.startsWith('s0w')).toBe(true);

    const hashYaounde = encodeGeohash(YAOUNDE.lat, YAOUNDE.lng, 6);
    expect(hashYaounde).toHaveLength(6);
    expect(hashYaounde.startsWith('s2')).toBe(true);

    const hashBafoussam = encodeGeohash(BAFOUSSAM.lat, BAFOUSSAM.lng, 6);
    expect(hashBafoussam).toHaveLength(6);
    expect(hashBafoussam.startsWith('s0')).toBe(true);

    const hashGaroua = encodeGeohash(GAROUA.lat, GAROUA.lng, 6);
    expect(hashGaroua).toHaveLength(6);
    expect(hashGaroua.startsWith('s3')).toBe(true);

    // Verify roundtrip fidelity across all 4 regions
    [DOUALA, YAOUNDE, BAFOUSSAM, GAROUA].forEach(city => {
      const h = encodeGeohash(city.lat, city.lng, 7);
      const dec = decodeGeohash(h);
      expect(dec.latitude).toBeCloseTo(city.lat, 2);
      expect(dec.longitude).toBeCloseTo(city.lng, 2);
    });
  });

  it('correctly decodes geohashes back into latitude and longitude bounds', () => {
    const hash = encodeGeohash(DOUALA.lat, DOUALA.lng, 7);
    const decoded = decodeGeohash(hash);

    expect(decoded.latitude).toBeCloseTo(DOUALA.lat, 2);
    expect(decoded.longitude).toBeCloseTo(DOUALA.lng, 2);
    expect(decoded.bounds.latMin).toBeLessThanOrEqual(DOUALA.lat);
    expect(decoded.bounds.latMax).toBeGreaterThanOrEqual(DOUALA.lat);
    expect(decoded.bounds.lonMin).toBeLessThanOrEqual(DOUALA.lng);
    expect(decoded.bounds.lonMax).toBeGreaterThanOrEqual(DOUALA.lng);
  });

  it('computes adjacent cardinal neighbors correctly', () => {
    const hash = encodeGeohash(YAOUNDE.lat, YAOUNDE.lng, 5);
    const north = getGeohashAdjacent(hash, 'n');
    const south = getGeohashAdjacent(hash, 's');
    const east = getGeohashAdjacent(hash, 'e');
    const west = getGeohashAdjacent(hash, 'w');

    expect(north).not.toEqual(hash);
    expect(south).not.toEqual(hash);
    expect(east).not.toEqual(hash);
    expect(west).not.toEqual(hash);

    const decodedNorth = decodeGeohash(north);
    const decodedCenter = decodeGeohash(hash);
    expect(decodedNorth.latitude).toBeGreaterThan(decodedCenter.latitude);
  });

  it('generates 9 cells (center + 8 surrounding neighbors) for radius coverage', () => {
    const hash = encodeGeohash(DOUALA.lat, DOUALA.lng, 5);
    const neighbors = getGeohashNeighbors(hash);

    expect(neighbors).toHaveLength(9);
    expect(neighbors[0]).toBe(hash); // First element is center cell
    const unique = new Set(neighbors);
    expect(unique.size).toBe(9); // All 9 cells are unique
  });

  it('adapts precision appropriately in getGeohashesForRadius', () => {
    const nearCells = getGeohashesForRadius(DOUALA.lat, DOUALA.lng, 2); // 2km -> precision 6
    expect(nearCells[0]).toHaveLength(6);
    expect(nearCells).toHaveLength(9);

    const cityCells = getGeohashesForRadius(DOUALA.lat, DOUALA.lng, 10); // 10km -> precision 5
    expect(cityCells[0]).toHaveLength(5);
    expect(cityCells).toHaveLength(9);

    const regionCells = getGeohashesForRadius(DOUALA.lat, DOUALA.lng, 35); // 35km -> precision 4
    expect(regionCells[0]).toHaveLength(4);
    expect(regionCells).toHaveLength(9);
  });
});
