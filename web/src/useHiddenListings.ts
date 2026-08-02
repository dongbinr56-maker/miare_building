import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Listing, Source } from './types'

export const HIDDEN_LISTINGS_STORAGE_KEY = 'miare:hidden-listings:v1'
const STORE_VERSION = 1 as const

type ListingWithMergedIds = Listing & { mergedListingIds?: unknown }

export interface HiddenListingEntry {
  entryId: string
  listingIds: string[]
  listing: Listing
  hiddenAt: string
}

interface PersistedHiddenListingStore {
  version: typeof STORE_VERSION
  blockedIds: string[]
  entries: HiddenListingEntry[]
}

export interface HiddenListingsStore {
  entries: HiddenListingEntry[]
  blockedIds: ReadonlySet<string>
  isHidden: (item: Listing) => boolean
  hide: (item: Listing) => void
  restore: (entryId: string) => void
  restoreAll: () => void
  count: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isListingId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:naver|daangn):\d+$/.test(value.trim())
}

function uniqueListingIds(values: unknown[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isListingId(value)) continue
    const id = value.trim()
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

function listingIdFromLink(source: Source, link: string): string | null {
  try {
    const url = new URL(link, 'https://local.invalid')
    if (source === 'naver') {
      const articleNo = url.searchParams.get('articleNo')
      return articleNo && /^\d+$/.test(articleNo) ? `naver:${articleNo}` : null
    }
    const match = url.pathname.match(/\/articles\/(\d+)/)
    return match ? `daangn:${match[1]}` : null
  } catch {
    return null
  }
}

/**
 * 카드 하나를 숨길 때 함께 차단해야 할 원본 플랫폼 ID를 반환한다.
 * 새 수집 데이터는 mergedListingIds를 사용하고, 이전 스냅샷은 altLinks에서
 * 원본 번호를 복구해 하위 호환한다.
 */
export function listingIdsFor(item: Listing): string[] {
  const merged = (item as ListingWithMergedIds).mergedListingIds
  const ids: unknown[] = [item.id]
  if (Array.isArray(merged)) ids.push(...merged)
  const alternateLinks: unknown = item.altLinks
  if (Array.isArray(alternateLinks)) {
    for (const alternate of alternateLinks) {
      if (!isRecord(alternate)) continue
      if (alternate.source !== 'naver' && alternate.source !== 'daangn') continue
      if (typeof alternate.link !== 'string') continue
      ids.push(listingIdFromLink(alternate.source, alternate.link))
    }
  }
  return uniqueListingIds(ids)
}

function isListingSnapshot(value: unknown): value is Listing {
  if (!isRecord(value)) return false
  return (
    isListingId(value.id) &&
    (value.source === 'naver' || value.source === 'daangn') &&
    typeof value.name === 'string' &&
    typeof value.dong === 'string' &&
    (value.deposit === null || (typeof value.deposit === 'number' && Number.isFinite(value.deposit))) &&
    (value.rent === null || (typeof value.rent === 'number' && Number.isFinite(value.rent)))
  )
}

function entriesOverlap(a: HiddenListingEntry, b: HiddenListingEntry): boolean {
  const aIds = new Set(a.listingIds)
  return b.listingIds.some((id) => aIds.has(id))
}

/** 손상되거나 중복된 저장 항목을 버리고, 겹치는 차단 항목은 하나로 합친다. */
function normalizeEntries(value: unknown): HiddenListingEntry[] {
  if (!Array.isArray(value)) return []
  const normalized: HiddenListingEntry[] = []

  for (const rawEntry of value) {
    if (!isRecord(rawEntry) || !isListingSnapshot(rawEntry.listing)) continue
    if (typeof rawEntry.entryId !== 'string' || !rawEntry.entryId.trim()) continue
    if (typeof rawEntry.hiddenAt !== 'string' || Number.isNaN(Date.parse(rawEntry.hiddenAt))) continue

    const storedIds = Array.isArray(rawEntry.listingIds) ? rawEntry.listingIds : []
    const listingIds = uniqueListingIds([...storedIds, ...listingIdsFor(rawEntry.listing)])
    if (listingIds.length === 0) continue

    let candidate: HiddenListingEntry = {
      entryId: rawEntry.entryId,
      listingIds,
      listing: rawEntry.listing,
      hiddenAt: rawEntry.hiddenAt,
    }

    // 하나의 원본 ID라도 겹치면 동일 차단 항목이다. 겹침이 연쇄되는 손상 데이터도
    // 모두 흡수하도록 더 이상 겹치는 항목이 없을 때까지 반복한다.
    let overlapIndex = normalized.findIndex((entry) => entriesOverlap(entry, candidate))
    while (overlapIndex >= 0) {
      const [existing] = normalized.splice(overlapIndex, 1)
      candidate = {
        ...candidate,
        entryId: existing.entryId,
        listingIds: uniqueListingIds([...existing.listingIds, ...candidate.listingIds]),
        listing: existing.listing,
        hiddenAt: existing.hiddenAt,
      }
      overlapIndex = normalized.findIndex((entry) => entriesOverlap(entry, candidate))
    }
    normalized.push(candidate)
  }

  return normalized
}

export function parseHiddenListingStore(raw: string | null): HiddenListingEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION) return []
    return normalizeEntries(parsed.entries)
  } catch {
    return []
  }
}

function loadEntries(): HiddenListingEntry[] {
  try {
    return parseHiddenListingStore(localStorage.getItem(HIDDEN_LISTINGS_STORAGE_KEY))
  } catch {
    return []
  }
}

function saveEntries(entries: HiddenListingEntry[]): void {
  const blockedIds = uniqueListingIds(entries.flatMap((entry) => entry.listingIds))
  const store: PersistedHiddenListingStore = {
    version: STORE_VERSION,
    blockedIds,
    entries,
  }
  try {
    localStorage.setItem(HIDDEN_LISTINGS_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 비공개 모드·용량 제한 등으로 저장할 수 없어도 현재 세션 동작은 유지한다.
  }
}

function createEntryId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export function useHiddenListings(): HiddenListingsStore {
  const [entries, setEntries] = useState<HiddenListingEntry[]>(loadEntries)

  useEffect(() => {
    saveEntries(entries)
  }, [entries])

  const blockedIds = useMemo(
    () => new Set(entries.flatMap((entry) => entry.listingIds)),
    [entries],
  )

  const isHidden = useCallback(
    (item: Listing) => listingIdsFor(item).some((id) => blockedIds.has(id)),
    [blockedIds],
  )

  const hide = useCallback((item: Listing) => {
    const newIds = listingIdsFor(item)
    if (newIds.length === 0) return

    setEntries((previous) => {
      const newIdSet = new Set(newIds)
      const overlapping = previous.filter((entry) => entry.listingIds.some((id) => newIdSet.has(id)))
      const untouched = previous.filter((entry) => !entry.listingIds.some((id) => newIdSet.has(id)))
      const listingIds = uniqueListingIds([
        ...newIds,
        ...overlapping.flatMap((entry) => entry.listingIds),
      ])
      const entry: HiddenListingEntry = {
        entryId: overlapping[0]?.entryId ?? createEntryId(),
        listingIds,
        listing: item,
        hiddenAt: overlapping[0]?.hiddenAt ?? new Date().toISOString(),
      }
      return [...untouched, entry]
    })
  }, [])

  const restore = useCallback((entryId: string) => {
    setEntries((previous) => previous.filter((entry) => entry.entryId !== entryId))
  }, [])

  const restoreAll = useCallback(() => {
    setEntries([])
  }, [])

  return {
    entries,
    blockedIds,
    isHidden,
    hide,
    restore,
    restoreAll,
    count: entries.length,
  }
}
