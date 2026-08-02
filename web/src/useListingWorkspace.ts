import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAccountPreference, saveAccountPreference } from './accountPreferences'
import {
  clearCompareEntries,
  compareEntryForListingIds,
  emptyListingWorkspace,
  parseListingWorkspace,
  reconcileCompareEntries,
  setStatusForListingIds,
  statusForListingIds,
  toggleCompareForListingIds,
  type CompareEntry,
  type ListingWorkflowStatus,
  type ListingWorkspaceData,
} from './listingWorkspaceStore'
import type { Listing } from './types'
import { listingIdsFor } from './useHiddenListings'

const CACHE_PREFIX = 'miare:listing-workspace:v1:'

export type ListingWorkspaceSyncStatus = 'loading' | 'saved' | 'saving' | 'error'

export interface ListingWorkspaceStore {
  getStatus: (item: Listing) => ListingWorkflowStatus | null
  setStatus: (item: Listing, status: ListingWorkflowStatus | null) => void
  isCompared: (item: Listing) => boolean
  toggleCompare: (item: Listing) => void
  clearCompare: () => void
  reconcileComparisons: (items: readonly Listing[]) => void
  compareEntries: CompareEntry[]
  ready: boolean
  syncStatus: ListingWorkspaceSyncStatus
}

function cacheKey(accountId: string): string {
  return `${CACHE_PREFIX}${accountId}`
}

function loadAccountCache(accountId: string): ListingWorkspaceData {
  try {
    const raw = localStorage.getItem(cacheKey(accountId))
    return parseListingWorkspace(raw ? JSON.parse(raw) : null)
  } catch {
    return emptyListingWorkspace()
  }
}

function saveAccountCache(accountId: string, workspace: ListingWorkspaceData): void {
  try {
    localStorage.setItem(cacheKey(accountId), JSON.stringify(workspace))
  } catch {
    // 로컬 캐시는 계정 KV 동기화를 보조할 뿐이다.
  }
}

function createRecordId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export function useListingWorkspace(): ListingWorkspaceStore {
  const [workspace, setWorkspace] = useState<ListingWorkspaceData>(emptyListingWorkspace)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [syncStatus, setSyncStatus] = useState<ListingWorkspaceSyncStatus>('loading')
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const skipHydrationSaveRef = useRef(true)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const remote = await loadAccountPreference('workspace')
        if (!active) return
        const next = remote.exists
          ? parseListingWorkspace(remote.data)
          : loadAccountCache(remote.accountId)

        if (!remote.exists) {
          await saveAccountPreference('workspace', next, remote.accountId)
          if (!active) return
        }
        saveAccountCache(remote.accountId, next)
        setWorkspace(next)
        setAccountId(remote.accountId)
        setSyncStatus('saved')
      } catch {
        if (active) setSyncStatus('error')
      } finally {
        if (active) setReady(true)
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!accountId || !ready) return
    if (skipHydrationSaveRef.current) {
      skipHydrationSaveRef.current = false
      return
    }
    let active = true
    saveAccountCache(accountId, workspace)
    setSyncStatus('saving')
    const timeout = window.setTimeout(() => {
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await saveAccountPreference('workspace', workspace, accountId)
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
  }, [accountId, ready, workspace])

  const getStatus = useCallback((item: Listing) => (
    statusForListingIds(workspace, listingIdsFor(item))
  ), [workspace])

  const setStatus = useCallback((item: Listing, status: ListingWorkflowStatus | null) => {
    if (!accountId) return
    setWorkspace((previous) => setStatusForListingIds(
      previous,
      listingIdsFor(item),
      status,
      createRecordId(),
      new Date().toISOString(),
    ))
  }, [accountId])

  const isCompared = useCallback((item: Listing) => (
    compareEntryForListingIds(workspace, listingIdsFor(item)) !== null
  ), [workspace])

  const toggleCompare = useCallback((item: Listing) => {
    if (!accountId) return
    setWorkspace((previous) => toggleCompareForListingIds(
      previous,
      listingIdsFor(item),
      createRecordId(),
      new Date().toISOString(),
    ))
  }, [accountId])

  const clearCompare = useCallback(() => {
    if (!accountId) return
    setWorkspace(clearCompareEntries)
  }, [accountId])

  const reconcileComparisons = useCallback((items: readonly Listing[]) => {
    if (!accountId) return
    setWorkspace((previous) => reconcileCompareEntries(
      previous,
      items.map((item) => listingIdsFor(item)),
    ))
  }, [accountId])

  return {
    getStatus,
    setStatus,
    isCompared,
    toggleCompare,
    clearCompare,
    reconcileComparisons,
    compareEntries: workspace.compareEntries,
    ready: ready && accountId !== null,
    syncStatus,
  }
}
