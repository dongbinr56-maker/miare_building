export type MatchLevel = 'full' | 'near' | 'low'

export interface Checks {
  deposit: boolean
  rent: boolean
  floor: boolean
  premium?: boolean
  /** 이전 JSON 스냅샷 호환용. 현재 매칭 판정에는 사용하지 않음. */
  pyeong?: boolean
}

export type Source = 'naver' | 'daangn'
export type PremiumStatus = 'present' | 'none' | 'unknown'

export type LocationSource = 'daangn_prop_complex' | 'daangn_public_coordinate'
export type LocationPrecision = 'building' | 'complex' | 'approximate'
export type LocationConfidence = 'high' | 'medium' | 'low'

export interface LocationEvidence {
  articleId: string
  articleUrl: string
  complexId: string | null
  complexUrl: string
  buildingId: string | null
  articleToComplexLinked: boolean
  buildingIdMatched: boolean
  addressMatched: boolean
  buildingCount: number
  publicCoordinateDistanceM: number | null
  articleBuilding: {
    floor: string | number | null
    topFloor: string | number | null
    approvalDate: string | null
    usage: string | null
    parkingSpots: number | null
  } | null
}

export interface PremiumEvidence {
  source:
    | 'daangn_structured_data'
    | 'daangn_public_detail'
    | 'naver_list_description'
    | `${Source}_structured_data`
  field: 'premiumMoney' | 'premiumMoneyDescription' | 'content' | 'articleFeatureDesc'
  value?: number | null
  matchedText?: string
  contextText?: string
  articleUrl?: string
}

export interface NearbyFacilityEvidence {
  kind: 'elementary_school' | 'middle_school' | 'high_school' | 'school' | 'university' | 'apartment' | 'apartment_complex'
  name: string
  distanceM: number
  source: 'openstreetmap'
  osmType: 'node' | 'way' | 'relation'
  osmId: number
  osmUrl: string
  lat: number
  lon: number
  /** OSM way/relation 도형. 각 ring은 [lat, lon] 순서다. */
  geometry?: [number, number][][]
  /** [south, west, north, east]. geometry가 없는 구버전 데이터 호환용. */
  bbox?: [number, number, number, number]
  tags: Record<string, string>
}

export interface NearbyFacilityCheck {
  withinRadius: true
  radiusM: 500
  source: 'openstreetmap_overpass'
  dataStatus: 'network' | 'cache' | 'stale_cache'
  checkedAt: string
}

export interface Listing {
  id: string
  source: Source
  dong: string
  name: string
  typeName: string | null
  tradeTypeName: string | null
  deposit: number | null
  rent: number | null
  floor: number | null
  totalFloor: number | null
  floorRaw: string | null
  areaM2: number | null
  pyeong: number | null
  desc: string
  tags: string[]
  noPremium: boolean
  premiumMoney?: number | null
  premiumStatus?: PremiumStatus
  premiumEvidence?: PremiumEvidence
  direction: string | null
  confirmedAt: string | null
  realtor: string | null
  cpName: string | null
  lat: string | null
  lon: string | null
  roadAddress?: string | null
  jibunAddress?: string | null
  locationSource?: LocationSource
  locationPrecision?: LocationPrecision
  locationConfidence?: LocationConfidence
  locationEvidence?: LocationEvidence | null
  nearbyFacilities?: NearbyFacilityEvidence[]
  nearbyFacilityCheck?: NearbyFacilityCheck
  sameAddrCnt: number | null
  link: string
  mobileLink: string
  checks: Checks
  matchLevel: MatchLevel
  firstSeen: string
  isNew: boolean
  dupCount?: number
  /** 중복 병합된 카드에 포함된 모든 플랫폼 원본 매물 ID. */
  mergedListingIds?: string[]
  sources?: Source[]
  altLinks?: { source: Source; link: string }[]
}

export interface Criteria {
  depositMin?: number
  depositMax: number
  rentMaxExclusive?: number
  floorMin?: number
  floorMax?: number
  requireNoPremium?: boolean
  /** 이전 JSON 스냅샷 호환용 필드. */
  rentMax?: number
  pyeongMin?: number
  pyeongMax?: number
  requireFirstFloor?: boolean
}

export interface RegionCount {
  name: string
  cortarNo: string
  count: number
}

export type ListingChangeType =
  | 'new'
  | 'price_changed'
  | 'description_changed'
  | 'deleted'
  | 'relisted'

export interface ListingChangeSummary {
  id: string
  source: Source
  dong: string
  name: string
  deposit: number | null
  rent: number | null
  floor: number | null
  areaM2: number | null
  link: string | null
}

export interface ListingChangeEvent {
  eventId: string
  type: ListingChangeType
  listingId: string
  current: ListingChangeSummary | null
  previous: ListingChangeSummary | null
  changes?: Partial<Record<'deposit' | 'rent', { before: number | null; after: number | null }>>
  confidence?: 'high'
}

export interface ListingChangeHistory {
  version: 1
  baseline: boolean
  comparedAt: string | null
  currentAt: string
  counts: {
    new: number
    priceChanged: number
    descriptionChanged: number
    deleted: number
    relisted: number
  }
  events: ListingChangeEvent[]
  truncated?: boolean
}

export interface ListingData {
  updatedAt: string
  criteria: Criteria
  tradeType: string
  realEstateTypes: string[]
  regions: RegionCount[]
  stats: {
    total: number
    full: number
    near: number
    new: number
    naver?: number
    daangn?: number
    merged?: number
    crossListed?: number
    excludedByCriteria?: number
    premiumAudit?: {
      positiveMisclassified: number
      noPremiumWithoutEvidence: number
      regressionListingSelected: number
      classificationInconsistent: number
      selectedWithoutNoPremiumProof: number
      totalViolations: number
    }
    nearby?: {
      input: number
      kept: number
      excludedMissingCoordinate: number
      excludedUnreliableCoordinate: number
      excludedNoFacility: number
      excludedUnavailable: number
      radiusM: 500
      source: 'openstreetmap_overpass'
      dataStatus?: 'network' | 'cache' | 'stale_cache' | 'unavailable'
    }
  }
  changeHistory?: ListingChangeHistory
  listings: Listing[]
}
