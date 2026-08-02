/** Leaflet에 전달하기 전 지도 좌표/생활권 시설을 검증하는 순수 유틸리티. */

export const NEARBY_MAP_RADIUS_M = 800

export type LeafletLatLon = readonly [lat: number, lon: number]

export interface MapFacilityInput {
  kind: string
  name: string
  distanceM: number
  lat: number
  lon: number
  /** collector 형식([lat, lon])과 OSM 형식({lat, lon})을 모두 허용한다. */
  geometry?: unknown
}

export type MapFacilityOverlay =
  | {
      type: 'polygon'
      kind: string
      name: string
      distanceM: number
      rings: LeafletLatLon[][]
    }
  | {
      type: 'point'
      kind: string
      name: string
      distanceM: number
      position: LeafletLatLon
    }

const DISPLAYED_KINDS = new Set([
  'elementary_school',
  'middle_school',
  'high_school',
  'school',
  'university',
  'apartment',
  'apartment_complex',
])

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

/** Leaflet 순서인 [lat, lon]만 반환한다. [lon, lat] 자동 추측/교환은 하지 않는다. */
export function toLeafletLatLon(value: unknown): LeafletLatLon | null {
  let rawLat: unknown
  let rawLon: unknown
  if (Array.isArray(value) && value.length >= 2) {
    ;[rawLat, rawLon] = value
  } else if (value && typeof value === 'object') {
    rawLat = (value as { lat?: unknown }).lat
    rawLon = (value as { lon?: unknown }).lon
  } else {
    return null
  }

  const lat = finiteNumber(rawLat)
  const lon = finiteNumber(rawLon)
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null
  }
  return [lat, lon]
}

function asRing(value: unknown): LeafletLatLon[] | null {
  if (!Array.isArray(value) || value.length < 4) return null
  const points = value.map(toLeafletLatLon)
  if (points.some((point) => point === null)) return null
  const ring = points as LeafletLatLon[]
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) return null
  return ring
}

/** relation/multipolygon처럼 중첩 깊이가 다른 geometry에서도 모든 유효 링을 펼친다. */
export function geometryToLeafletRings(geometry: unknown): LeafletLatLon[][] {
  const rings: LeafletLatLon[][] = []

  function visit(value: unknown): void {
    const ring = asRing(value)
    if (ring) {
      rings.push(ring)
      return
    }
    if (Array.isArray(value)) value.forEach(visit)
  }

  visit(geometry)
  return rings
}

export function listingRadiusCircle(lat: unknown, lon: unknown): {
  center: LeafletLatLon
  radiusM: number
} | null {
  const center = toLeafletLatLon([lat, lon])
  return center ? { center, radiusM: NEARBY_MAP_RADIUS_M } : null
}

/** 반경 안의 허용 시설만 polygon 또는 좌표 fallback overlay로 변환한다. */
export function buildFacilityOverlays(
  facilities: readonly MapFacilityInput[] | null | undefined,
): MapFacilityOverlay[] {
  if (!Array.isArray(facilities)) return []

  return facilities.flatMap((facility): MapFacilityOverlay[] => {
    if (!DISPLAYED_KINDS.has(facility.kind)) return []
    const distanceM = finiteNumber(facility.distanceM)
    if (distanceM === null || distanceM < 0 || distanceM > NEARBY_MAP_RADIUS_M) return []

    const rings = geometryToLeafletRings(facility.geometry)
    if (rings.length > 0) {
      return [{
        type: 'polygon',
        kind: facility.kind,
        name: facility.name,
        distanceM,
        rings,
      }]
    }

    const position = toLeafletLatLon([facility.lat, facility.lon])
    return position
      ? [{
          type: 'point',
          kind: facility.kind,
          name: facility.name,
          distanceM,
          position,
        }]
      : []
  })
}
