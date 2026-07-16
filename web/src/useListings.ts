import { useEffect, useState } from 'react'
import type { ListingData } from './types'

interface State {
  data: ListingData | null
  error: string | null
  loading: boolean
}

export function useListings(): State {
  const [state, setState] = useState<State>({ data: null, error: null, loading: true })

  useEffect(() => {
    let alive = true
    fetch(`${import.meta.env.BASE_URL}data/listings.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: ListingData) => alive && setState({ data, error: null, loading: false }))
      .catch((e) => alive && setState({ data: null, error: String(e), loading: false }))
    return () => {
      alive = false
    }
  }, [])

  return state
}
