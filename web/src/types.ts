export type MatchLevel = 'full' | 'near' | 'low'

export interface Checks {
  deposit: boolean
  rent: boolean
  floor: boolean
  pyeong: boolean
}

export interface Listing {
  id: string
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
  direction: string | null
  confirmedAt: string | null
  realtor: string | null
  cpName: string | null
  lat: string | null
  lon: string | null
  sameAddrCnt: number | null
  link: string
  mobileLink: string
  checks: Checks
  matchLevel: MatchLevel
  firstSeen: string
  isNew: boolean
}

export interface Criteria {
  depositMax: number
  rentMax: number
  pyeongMin: number
  pyeongMax: number
  requireFirstFloor: boolean
}

export interface RegionCount {
  name: string
  cortarNo: string
  count: number
}

export interface ListingData {
  updatedAt: string
  criteria: Criteria
  tradeType: string
  realEstateTypes: string[]
  regions: RegionCount[]
  stats: { total: number; full: number; near: number; new: number }
  listings: Listing[]
}
