import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAccountPreference, saveAccountPreference } from './accountPreferences'
import {
  deleteNotesForListingIds,
  listingNotesData,
  type ListingNoteEntries,
  type ListingNoteRecord,
  noteForListingIds,
  parseListingNotes,
  upsertNoteForListingIds,
} from './listingNotesStore'
import type { Listing } from './types'
import { listingIdsFor } from './useHiddenListings'

const CACHE_PREFIX = 'miare:listing-notes:v1:'

export type ListingNoteSyncStatus = 'loading' | 'saved' | 'saving' | 'error'

export interface ListingNotesStore {
  getNote: (item: Listing) => ListingNoteRecord | null
  saveNote: (item: Listing, text: string) => void
  deleteNote: (item: Listing) => void
  ready: boolean
  syncStatus: ListingNoteSyncStatus
}

function cacheKey(accountId: string): string {
  return `${CACHE_PREFIX}${accountId}`
}

function loadAccountCache(accountId: string): ListingNoteEntries {
  try {
    const raw = localStorage.getItem(cacheKey(accountId))
    return parseListingNotes(raw ? JSON.parse(raw) : null)
  } catch {
    return {}
  }
}

function saveAccountCache(accountId: string, entries: ListingNoteEntries): void {
  try {
    localStorage.setItem(cacheKey(accountId), JSON.stringify(listingNotesData(entries)))
  } catch {
    // 로컬 캐시 실패는 계정 KV 저장을 막지 않는다.
  }
}

function createNoteId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export function useListingNotes(): ListingNotesStore {
  // 인증 계정 해시를 확인하기 전에는 다른 계정의 로컬 메모를 절대 읽지 않는다.
  const [entries, setEntries] = useState<ListingNoteEntries>({})
  const [accountId, setAccountId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [syncStatus, setSyncStatus] = useState<ListingNoteSyncStatus>('loading')
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const skipHydrationSaveRef = useRef(true)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const remote = await loadAccountPreference('notes')
        if (!active) return
        const next = remote.exists
          ? parseListingNotes(remote.data)
          : loadAccountCache(remote.accountId)

        if (!remote.exists) {
          await saveAccountPreference('notes', listingNotesData(next), remote.accountId)
          if (!active) return
        }
        saveAccountCache(remote.accountId, next)
        setEntries(next)
        setAccountId(remote.accountId)
        setSyncStatus('saved')
      } catch {
        // 인증 계정을 확인하지 못한 경우 계정 혼선을 막기 위해 편집을 비활성화한다.
        if (active) setSyncStatus('error')
      } finally {
        if (active) setReady(true)
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!accountId || !ready) return
    // 원격 GET 직후 같은 스냅샷을 다시 PUT하면 다른 기기의 직후 변경을
    // 덮을 수 있으므로, 실제 사용자 편집이 생길 때부터 저장한다.
    if (skipHydrationSaveRef.current) {
      skipHydrationSaveRef.current = false
      return
    }
    let active = true
    saveAccountCache(accountId, entries)
    setSyncStatus('saving')
    const timeout = window.setTimeout(() => {
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await saveAccountPreference('notes', listingNotesData(entries), accountId)
        })
      saveQueueRef.current = save
      void save
        .then(() => { if (active) setSyncStatus('saved') })
        .catch(() => { if (active) setSyncStatus('error') })
    }, 350)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [accountId, entries, ready])

  const getNote = useCallback(
    (item: Listing) => noteForListingIds(entries, listingIdsFor(item)),
    [entries],
  )

  const saveNote = useCallback((item: Listing, text: string) => {
    if (!accountId) return
    const ids = listingIdsFor(item)
    setEntries((previous) => upsertNoteForListingIds(
      previous,
      ids,
      text,
      createNoteId(),
      new Date().toISOString(),
    ))
  }, [accountId])

  const deleteNote = useCallback((item: Listing) => {
    if (!accountId) return
    setEntries((previous) => deleteNotesForListingIds(previous, listingIdsFor(item)))
  }, [accountId])

  return { getNote, saveNote, deleteNote, ready: ready && accountId !== null, syncStatus }
}
