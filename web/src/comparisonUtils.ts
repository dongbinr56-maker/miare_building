import type { Listing, NearbyFacilityEvidence, PremiumStatus } from './types'

export const MAX_COMPARISON_LISTINGS = 3 as const

export type ComparisonSelectionOutcome = 'added' | 'removed' | 'limit' | 'invalid'

export interface ComparisonSelectionResult {
  selectedIds: string[]
  outcome: ComparisonSelectionOutcome
}

export interface FacilityComparisonSummary {
  schoolCount: number
  apartmentCount: number
  nearestSchoolM: number | null
  nearestApartmentM: number | null
}

export interface PremiumComparisonSummary {
  status: PremiumStatus
  label: string
  evidence: string
}

const SCHOOL_KINDS = new Set<NearbyFacilityEvidence['kind']>([
  'elementary_school',
  'middle_school',
  'high_school',
  'school',
  'university',
])

const APARTMENT_KINDS = new Set<NearbyFacilityEvidence['kind']>([
  'apartment',
  'apartment_complex',
])

function uniqueValidIds(values: readonly string[]): string[] {
  const ids: string[] = []
  for (const value of values) {
    const id = value.trim()
    if (id && !ids.includes(id)) ids.push(id)
    if (ids.length === MAX_COMPARISON_LISTINGS) break
  }
  return ids
}

/**
 * 비교 선택은 순서를 보존하고 중복을 제거하며 최대 3개만 허용한다.
 * 이미 선택한 ID를 다시 전달하면 선택 해제로 처리한다.
 */
export function toggleComparisonSelection(
  selectedIds: readonly string[],
  listingId: string,
): ComparisonSelectionResult {
  const current = uniqueValidIds(selectedIds)
  const id = listingId.trim()
  if (!id) return { selectedIds: current, outcome: 'invalid' }

  if (current.includes(id)) {
    return {
      selectedIds: current.filter((selectedId) => selectedId !== id),
      outcome: 'removed',
    }
  }
  if (current.length >= MAX_COMPARISON_LISTINGS) {
    return { selectedIds: current, outcome: 'limit' }
  }
  return { selectedIds: [...current, id], outcome: 'added' }
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function formatManwon(value: number | null | undefined): string {
  const amount = finiteNonNegative(value)
  return amount === null ? '확인 필요' : `${amount.toLocaleString('ko-KR')}만원`
}

export function formatFloor(listing: Pick<Listing, 'floor' | 'totalFloor' | 'floorRaw'>): string {
  const floor = typeof listing.floor === 'number' && Number.isFinite(listing.floor)
    ? `${listing.floor < 0 ? `지하 ${Math.abs(listing.floor)}` : listing.floor}층`
    : null
  const totalFloor = finiteNonNegative(listing.totalFloor)

  if (floor && totalFloor !== null) return `${floor} / 총 ${totalFloor}층`
  if (floor) return floor
  if (listing.floorRaw?.trim()) return listing.floorRaw.trim()
  return '확인 필요'
}

export function formatArea(listing: Pick<Listing, 'areaM2' | 'pyeong'>): string {
  const areaM2 = finiteNonNegative(listing.areaM2)
  const pyeong = finiteNonNegative(listing.pyeong)
  if (areaM2 !== null && pyeong !== null) return `${areaM2.toLocaleString('ko-KR')}㎡ · ${pyeong.toLocaleString('ko-KR')}평`
  if (areaM2 !== null) return `${areaM2.toLocaleString('ko-KR')}㎡`
  if (pyeong !== null) return `${pyeong.toLocaleString('ko-KR')}평`
  return '확인 필요'
}

function resolvedPremiumStatus(listing: Pick<Listing, 'premiumStatus' | 'premiumMoney' | 'noPremium' | 'checks'>): PremiumStatus {
  const amount = finiteNonNegative(listing.premiumMoney)
  // 구조화 데이터에 양수 금액이 있으면 다른 무권리 표기보다 항상 우선한다.
  if (amount !== null && amount > 0) return 'present'
  if (listing.premiumStatus) return listing.premiumStatus
  return (listing.checks.premium ?? listing.noPremium) ? 'none' : 'unknown'
}

export function premiumComparisonSummary(
  listing: Pick<Listing, 'premiumStatus' | 'premiumMoney' | 'premiumEvidence' | 'noPremium' | 'checks'>,
): PremiumComparisonSummary {
  const status = resolvedPremiumStatus(listing)
  const amount = finiteNonNegative(listing.premiumMoney)
  const label = status === 'present'
    ? amount !== null ? `권리금 있음 · ${amount.toLocaleString('ko-KR')}만원` : '권리금 있음'
    : status === 'none' ? '무권리' : '확인 필요'

  const evidence = listing.premiumEvidence
  if (!evidence) {
    return { status, label, evidence: status === 'unknown' ? '확인된 근거 없음' : '구조화된 판정 결과' }
  }
  const detail = evidence.matchedText?.trim()
    || (typeof evidence.value === 'number' ? `${evidence.value.toLocaleString('ko-KR')}만원` : '')
  return {
    status,
    label,
    evidence: `${evidence.source} · ${evidence.field}${detail ? ` · ${detail}` : ''}`,
  }
}

function facilityKey(facility: NearbyFacilityEvidence): string {
  return `${facility.osmType}:${facility.osmId}`
}

/** 잘못된 거리와 500m 밖 시설은 비교 통계에서 제외한다. */
export function summarizeNearbyFacilities(
  facilities: readonly NearbyFacilityEvidence[] | null | undefined,
): FacilityComparisonSummary {
  const schools = new Map<string, number>()
  const apartments = new Map<string, number>()

  for (const facility of facilities ?? []) {
    const distanceM = finiteNonNegative(facility.distanceM)
    if (distanceM === null || distanceM > 500) continue
    const target = SCHOOL_KINDS.has(facility.kind)
      ? schools
      : APARTMENT_KINDS.has(facility.kind) ? apartments : null
    if (!target) continue
    const key = facilityKey(facility)
    const previous = target.get(key)
    if (previous === undefined || distanceM < previous) target.set(key, distanceM)
  }

  const nearest = (values: Map<string, number>): number | null => {
    if (values.size === 0) return null
    return Math.min(...values.values())
  }
  return {
    schoolCount: schools.size,
    apartmentCount: apartments.size,
    nearestSchoolM: nearest(schools),
    nearestApartmentM: nearest(apartments),
  }
}

export function formatFacilitySummary(count: number, nearestM: number | null): string {
  if (count <= 0 || nearestM === null) return '없음'
  return `${count.toLocaleString('ko-KR')}곳 · 최단 ${Math.round(nearestM).toLocaleString('ko-KR')}m`
}

export function formatAddress(listing: Pick<Listing, 'roadAddress' | 'jibunAddress' | 'dong'>): string {
  const road = listing.roadAddress?.trim()
  const jibun = listing.jibunAddress?.trim()
  if (road && jibun && road !== jibun) return `도로명 ${road}\n지번 ${jibun}`
  if (road) return `도로명 ${road}`
  if (jibun) return `지번 ${jibun}`
  return listing.dong?.trim() || '확인 필요'
}

export function formatLocationConfidence(
  listing: Pick<Listing, 'locationConfidence' | 'locationPrecision' | 'locationSource'>,
): string {
  const confidence = listing.locationConfidence === 'high'
    ? '높음'
    : listing.locationConfidence === 'medium' ? '보통' : listing.locationConfidence === 'low' ? '낮음' : '확인 필요'
  const precision = listing.locationPrecision === 'building'
    ? '건물 위치'
    : listing.locationPrecision === 'complex'
      ? '단지 중심'
      : listing.locationPrecision === 'approximate' ? '대략적 위치' : null
  return precision ? `${confidence} · ${precision}` : confidence
}
