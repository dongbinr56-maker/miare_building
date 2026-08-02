import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Listing, Source } from './types'
import { loadAccountPreference, saveAccountPreference } from './accountPreferences'

export const HIDDEN_LISTINGS_STORAGE_KEY = 'miare:hidden-listings:v1'
const OWNER_KEY = 'miare:preferences-owner:hidden:v1'
const CACHE_PREFIX = 'miare:hidden-listings:v2:'
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

function loadLegacyEntries(): HiddenListingEntry[] {
  try {
    return parseHiddenListingStore(localStorage.getItem(HIDDEN_LISTINGS_STORAGE_KEY))
  } catch {
    return []
  }
}

function loadAccountEntries(accountId: string): HiddenListingEntry[] | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${accountId}`)
    return raw === null ? null : parseHiddenListingStore(raw)
  } catch {
    return null
  }
}

function saveAccountEntries(accountId: string, entries: HiddenListingEntry[]): void {
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${accountId}`,
      JSON.stringify(hiddenStoreFromEntries(entries)),
    )
  } catch {
    // 원격 계정 저장이 기본이며 로컬 캐시는 보조 수단이다.
  }
}

function hiddenStoreFromEntries(entries: HiddenListingEntry[]): PersistedHiddenListingStore {
  return {
    version: STORE_VERSION,
    blockedIds: uniqueListingIds(entries.flatMap((entry) => entry.listingIds)),
    entries,
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
  // 인증 계정 확인 전에는 공용 구버전 캐시를 읽지 않는다.
  const [entries, setEntries] = useState<HiddenListingEntry[]>([])
  const [accountId, setAccountId] = useState<string | null>(null)
  const [accountReady, setAccountReady] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const remote = await loadAccountPreference('hidden')
        if (!active) return
        let owner: string | null = null
        try { owner = localStorage.getItem(OWNER_KEY) } catch { /* local cache unavailable */ }

        let next: HiddenListingEntry[]
        if (remote.exists) {
          next = parseHiddenListingStore(JSON.stringify(remote.data))
        } else if (loadAccountEntries(remote.accountId) !== null) {
          next = loadAccountEntries(remote.accountId) ?? []
        } else if (!owner || owner === remote.accountId) {
          // 기존 브라우저 차단 목록을 현재 인증 이메일 계정으로 1회 이관한다.
          next = loadLegacyEntries()
          await saveAccountPreference('hidden', hiddenStoreFromEntries(next), remote.accountId)
          if (!active) return
        } else {
          next = []
        }
        try { localStorage.setItem(OWNER_KEY, remote.accountId) } catch { /* ignore */ }
        saveAccountEntries(remote.accountId, next)
        setEntries(next)
        setAccountId(remote.accountId)
        setAccountReady(true)
      } catch {
        // 서버 동기화 실패 시에도 기존 브라우저 차단 목록은 계속 동작한다.
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!accountReady || !accountId) return
    saveAccountEntries(accountId, entries)
    const timeout = window.setTimeout(() => {
      void saveAccountPreference('hidden', hiddenStoreFromEntries(entries), accountId).catch(() => undefined)
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [accountId, accountReady, entries])

  const blockedIds = useMemo(
    () => new Set(entries.flatMap((entry) => entry.listingIds)),
    [entries],
  )

  const isHidden = useCallback(
    (item: Listing) => listingIdsFor(item).some((id) => blockedIds.has(id)),
    [blockedIds],
  )

  const hide = useCallback((item: Listing) => {
    if (!accountId) return
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
  }, [accountId])

  const restore = useCallback((entryId: string) => {
    if (!accountId) return
    setEntries((previous) => previous.filter((entry) => entry.entryId !== entryId))
  }, [accountId])

  const restoreAll = useCallback(() => {
    if (!accountId) return
    setEntries([])
  }, [accountId])

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
