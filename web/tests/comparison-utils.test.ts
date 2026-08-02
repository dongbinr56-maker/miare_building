import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatAddress,
  formatArea,
  formatFacilitySummary,
  formatFloor,
  formatLocationConfidence,
  formatManwon,
  premiumComparisonSummary,
  summarizeNearbyFacilities,
  toggleComparisonSelection,
} from '../src/comparisonUtils.ts'
import type { Listing, NearbyFacilityEvidence } from '../src/types.ts'

test('비교 선택은 중복 없이 최대 3개이며 재선택하면 해제한다', () => {
  assert.deepEqual(toggleComparisonSelection([], 'naver:1'), {
    selectedIds: ['naver:1'],
    outcome: 'added',
  })
  assert.deepEqual(toggleComparisonSelection(['naver:1', 'naver:1'], 'daangn:2'), {
    selectedIds: ['naver:1', 'daangn:2'],
    outcome: 'added',
  })
  assert.deepEqual(toggleComparisonSelection(['naver:1', 'daangn:2', 'naver:3'], 'daangn:4'), {
    selectedIds: ['naver:1', 'daangn:2', 'naver:3'],
    outcome: 'limit',
  })
  assert.deepEqual(toggleComparisonSelection(['naver:1', 'daangn:2'], 'naver:1'), {
    selectedIds: ['daangn:2'],
    outcome: 'removed',
  })
  assert.equal(toggleComparisonSelection(['naver:1'], '  ').outcome, 'invalid')
})

function facility(overrides: Partial<NearbyFacilityEvidence>): NearbyFacilityEvidence {
  return {
    kind: 'school',
    name: '시설',
    distanceM: 100,
    source: 'openstreetmap',
    osmType: 'way',
    osmId: 1,
    osmUrl: 'https://www.openstreetmap.org/way/1',
    lat: 35.1,
    lon: 126.8,
    tags: {},
    ...overrides,
  }
}

test('500m 학교·아파트를 OSM ID 기준으로 중복 제거하고 최단거리를 계산한다', () => {
  const summary = summarizeNearbyFacilities([
    facility({ kind: 'elementary_school', osmId: 1, distanceM: 180 }),
    facility({ kind: 'elementary_school', osmId: 1, distanceM: 170 }),
    facility({ kind: 'university', osmId: 2, distanceM: 500 }),
    facility({ kind: 'apartment_complex', osmType: 'relation', osmId: 3, distanceM: 90 }),
    facility({ kind: 'apartment', osmId: 4, distanceM: 501 }),
    facility({ kind: 'school', osmId: 5, distanceM: -1 }),
  ])

  assert.deepEqual(summary, {
    schoolCount: 2,
    apartmentCount: 1,
    nearestSchoolM: 170,
    nearestApartmentM: 90,
  })
  assert.equal(formatFacilitySummary(summary.schoolCount, summary.nearestSchoolM), '2곳 · 최단 170m')
  assert.equal(formatFacilitySummary(0, null), '없음')
})

test('가격·층·면적·주소·위치 신뢰도를 안전하게 표시한다', () => {
  assert.equal(formatManwon(1_000), '1,000만원')
  assert.equal(formatManwon(Number.NaN), '확인 필요')
  assert.equal(formatFloor({ floor: -1, totalFloor: 4, floorRaw: 'B1/4' }), '지하 1층 / 총 4층')
  assert.equal(formatFloor({ floor: null, totalFloor: null, floorRaw: ' 2/3 ' }), '2/3')
  assert.equal(formatArea({ areaM2: 82.5, pyeong: 25 }), '82.5㎡ · 25평')
  assert.equal(formatArea({ areaM2: null, pyeong: null }), '확인 필요')
  assert.equal(formatAddress({ roadAddress: '광산로 1', jibunAddress: '신가동 1', dong: '신가동' }), '도로명 광산로 1\n지번 신가동 1')
  assert.equal(formatLocationConfidence({ locationConfidence: 'high', locationPrecision: 'building', locationSource: 'daangn_prop_complex' }), '높음 · 건물 위치')
})

test('권리금 양수 금액을 무권리보다 우선하고 근거를 함께 표시한다', () => {
  const positive = premiumComparisonSummary({
    premiumStatus: 'none',
    premiumMoney: 1,
    premiumEvidence: {
      source: 'daangn_structured_data',
      field: 'premiumMoney',
      value: 1,
    },
    noPremium: true,
    checks: { deposit: true, rent: true, floor: true, premium: true },
  })
  assert.equal(positive.status, 'present')
  assert.equal(positive.label, '권리금 있음 · 1만원')
  assert.match(positive.evidence, /premiumMoney/)

  const unknown = premiumComparisonSummary({
    premiumMoney: null,
    noPremium: false,
    checks: { deposit: true, rent: true, floor: true },
  })
  assert.deepEqual(unknown, {
    status: 'unknown',
    label: '확인 필요',
    evidence: '확인된 근거 없음',
  })
})

// Listing 타입 변경 시 비교 유틸의 Pick 기반 입력도 컴파일 단계에서 함께 검증한다.
void ({} as Listing)
