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
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
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
