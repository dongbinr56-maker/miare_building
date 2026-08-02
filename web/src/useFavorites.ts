import { useCallback, useEffect, useRef, useState } from 'react'
import type { Listing } from './types'
import { loadAccountPreference, saveAccountPreference } from './accountPreferences'

const KEY = 'miare:favorites:v1'
const OWNER_KEY = 'miare:preferences-owner:favorites:v1'

/**
 * 즐겨찾기 저장소 (localStorage).
 * 매물 스냅샷을 통째로 저장하므로, 다음 수집에서 매물이 내려가도
 * 즐겨찾기 목록에는 남아 계속 확인할 수 있다.
 */
export interface FavStore {
  ids: Set<string>
  snapshots: Record<string, Listing>
  isFav: (id: string) => boolean
  toggle: (item: Listing) => void
  count: number
}

function normalizeSnapshots(value: unknown): Record<string, Listing> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Listing] => Boolean(entry[1] && typeof entry[1] === 'object'))
      .map(([id, item]) => [id, migratePremiumSnapshot(item)]),
  )
}

function load(): Record<string, Listing> {
  try {
    const raw = localStorage.getItem(KEY)
    return normalizeSnapshots(raw ? JSON.parse(raw) : {})
  } catch {
    return {}
  }
}

/**
 * 구버전 즐겨찾기는 근거 없는 noPremium=true를 저장했다. 금액·상태 필드가
 * 없는 스냅샷은 무권리로 승계하지 않고 확인 필요로 보수 마이그레이션한다.
 */
function migratePremiumSnapshot(item: Listing): Listing {
  const amount = typeof item.premiumMoney === 'number' && Number.isFinite(item.premiumMoney)
    ? item.premiumMoney
    : null
  const status = item.premiumStatus === 'present' || item.premiumStatus === 'none' || item.premiumStatus === 'unknown'
    ? item.premiumStatus
    : amount !== null && amount > 0
      ? 'present'
      : amount === 0
        ? 'none'
        : 'unknown'
  const checks = { ...item.checks, premium: status === 'none' }
  const passed = ['deposit', 'rent', 'floor', 'premium']
    .filter((key) => Boolean(checks[key as keyof typeof checks])).length
  return {
    ...item,
    premiumMoney: amount,
    premiumStatus: status,
    noPremium: status === 'none',
    checks,
    matchLevel: passed === 4 ? 'full' : passed === 3 ? 'near' : 'low',
  }
}

export function useFavorites(): FavStore {
  const [snapshots, setSnapshots] = useState<Record<string, Listing>>(load)
  const [accountReady, setAccountReady] = useState(false)
  const snapshotsRef = useRef(snapshots)

  useEffect(() => {
    snapshotsRef.current = snapshots
  }, [snapshots])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const remote = await loadAccountPreference('favorites')
        if (!active) return
        let owner: string | null = null
        try { owner = localStorage.getItem(OWNER_KEY) } catch { /* local cache unavailable */ }

        let next: Record<string, Listing>
        if (remote.exists) {
          next = normalizeSnapshots(remote.data)
        } else if (!owner || owner === remote.accountId) {
          // 최초 배포에서는 기존 브라우저 즐겨찾기를 현재 인증 계정으로 1회 이관한다.
          next = snapshotsRef.current
          await saveAccountPreference('favorites', next)
          if (!active) return
        } else {
          // 같은 브라우저에서 다른 이메일로 로그인한 경우 이전 계정 데이터를 섞지 않는다.
          next = {}
        }
        try { localStorage.setItem(OWNER_KEY, remote.accountId) } catch { /* ignore */ }
        setSnapshots(next)
        setAccountReady(true)
      } catch {
        // 서버 동기화 실패 시에도 기존 브라우저 localStorage 기능은 유지한다.
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshots))
    } catch {
      /* 용량 초과 등은 무시 */
    }
    if (!accountReady) return
    const timeout = window.setTimeout(() => {
      void saveAccountPreference('favorites', snapshots).catch(() => undefined)
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [accountReady, snapshots])

  const toggle = useCallback((item: Listing) => {
    setSnapshots((prev) => {
      const next = { ...prev }
      if (next[item.id]) delete next[item.id]
      else next[item.id] = item
      return next
    })
  }, [])

  const ids = new Set(Object.keys(snapshots))
  return {
    ids,
    snapshots,
    isFav: (id: string) => ids.has(id),
    toggle,
    count: ids.size,
  }
}
