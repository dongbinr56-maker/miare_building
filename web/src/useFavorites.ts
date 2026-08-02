import { useCallback, useEffect, useState } from 'react'
import type { Listing } from './types'

const KEY = 'miare:favorites:v1'

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

function load(): Record<string, Listing> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, Listing] => Boolean(entry[1] && typeof entry[1] === 'object'))
        .map(([id, item]) => [id, migratePremiumSnapshot(item)]),
    )
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

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshots))
    } catch {
      /* 용량 초과 등은 무시 */
    }
  }, [snapshots])

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
