import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFacilityOverlays,
  geometryToLeafletRings,
  listingRadiusCircle,
  NEARBY_MAP_RADIUS_M,
  toLeafletLatLon,
} from '../src/mapUtils.ts'

test('Leaflet 좌표 순서와 500m 원을 고정한다', () => {
  assert.deepEqual(toLeafletLatLon([35.19, 126.82]), [35.19, 126.82])
  assert.equal(toLeafletLatLon([126.82, 35.19]), null)
  assert.equal(toLeafletLatLon([null, null]), null)
  assert.equal(toLeafletLatLon(['', '']), null)
  assert.deepEqual(listingRadiusCircle(35.19, 126.82), {
    center: [35.19, 126.82],
    radiusM: NEARBY_MAP_RADIUS_M,
  })
  assert.equal(NEARBY_MAP_RADIUS_M, 500)
})

test('relation/multipolygon의 중첩 링을 Leaflet [lat, lon] 링으로 펼친다', () => {
  const outer = [
    [35.19, 126.82],
    [35.19, 126.83],
    [35.2, 126.83],
    [35.19, 126.82],
  ]
  const inner = [
    { lat: 35.192, lon: 126.822 },
    { lat: 35.192, lon: 126.823 },
    { lat: 35.193, lon: 126.823 },
    { lat: 35.192, lon: 126.822 },
  ]

  assert.deepEqual(geometryToLeafletRings([[[outer]], [[inner]]]), [
    outer,
    inner.map(({ lat, lon }) => [lat, lon]),
  ])
})

test('geometry가 없거나 잘못된 경우 시설 중심 좌표로 fallback한다', () => {
  const [overlay] = buildFacilityOverlays([{
    kind: 'elementary_school',
    name: '테스트초등학교',
    distanceM: 120,
    lat: 35.18,
    lon: 126.81,
    geometry: [[[126.81, 35.18], [126.82, 35.18], [126.82, 35.19]]],
  }])

  assert.deepEqual(overlay, {
    type: 'point',
    kind: 'elementary_school',
    name: '테스트초등학교',
    distanceM: 120,
    position: [35.18, 126.81],
  })
})

test('500m 경계는 포함하고 500m 밖 시설은 표시하지 않는다', () => {
  const overlays = buildFacilityOverlays([
    {
      kind: 'apartment_complex',
      name: '경계 아파트',
      distanceM: 500,
      lat: 35.18,
      lon: 126.81,
    },
    {
      kind: 'university',
      name: '반경 밖 대학교',
      distanceM: 500.01,
      lat: 35.2,
      lon: 126.84,
    },
    {
      kind: 'school',
      name: '잘못된 음수 거리 학교',
      distanceM: -1,
      lat: 35.19,
      lon: 126.82,
    },
  ])

  assert.equal(overlays.length, 1)
  assert.equal(overlays[0]?.name, '경계 아파트')
})
