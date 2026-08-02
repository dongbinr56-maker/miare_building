import { useCallback, useEffect, useState } from 'react'
import type { ListingData } from './types'

interface State {
  data: ListingData | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

export function useListings(): State {
  const [data, setData] = useState<ListingData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      let response = await fetch(`${import.meta.env.BASE_URL}api/listings`, {
        cache: 'no-store',
      })
      const isJson = response.headers.get('Content-Type')?.includes('application/json')
      if (!response.ok || !isJson) {
        // Git/Pages에는 정확 주소가 포함된 생성 데이터를 두지 않는다.
        // KV가 비어 있는 초기 상태에서만 빈 안전 fallback을 사용한다.
        response = await fetch(`${import.meta.env.BASE_URL}data/listings.fallback.json`, {
          cache: 'no-store',
        })
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const next = (await response.json()) as ListingData
      setData(next)
    } catch (caught) {
      setError(String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { data, error, loading, reload: load }
}
