import { useCallback, useEffect, useRef, useState } from 'react'

type RefreshStatus = 'idle' | 'pending' | 'running' | 'succeeded' | 'failed'
type RefreshDisplayStatus = RefreshStatus | 'timed_out'

interface RefreshState {
  jobId?: string
  status: RefreshStatus
  requestedAt?: string
  claimedAt?: string
  completedAt?: string
  updatedAt?: string
  message?: string
}

interface Props {
  onUpdated: () => Promise<void>
}

const api = (path: string, init?: RequestInit) =>
  fetch(`${import.meta.env.BASE_URL}api/refresh/${path}`, {
    cache: 'no-store',
    ...init,
  })

const PENDING_TIMEOUT_MS = 30 * 60 * 1_000
const RUNNING_TIMEOUT_MS = 2 * 60 * 60 * 1_000

function hasTimedOut(state: RefreshState, now: number): boolean {
  if (state.status !== 'pending' && state.status !== 'running') return false
  const timestamp = state.status === 'running'
    ? (state.claimedAt ?? state.requestedAt)
    : state.requestedAt
  if (!timestamp) return false
  const startedAt = Date.parse(timestamp)
  if (Number.isNaN(startedAt)) return false
  const limit = state.status === 'pending' ? PENDING_TIMEOUT_MS : RUNNING_TIMEOUT_MS
  return now - startedAt >= limit
}

function displayStatus(state: RefreshState): RefreshDisplayStatus {
  return hasTimedOut(state, Date.now()) ? 'timed_out' : state.status
}

function buttonLabel(status: RefreshDisplayStatus, requesting: boolean): string {
  if (requesting) return '요청 전송 중'
  if (status === 'pending') return 'GitHub 수집기 시작 대기'
  if (status === 'running') return 'GitHub에서 매물 수집 중'
  if (status === 'succeeded') return '갱신 완료 · 다시 실행'
  if (status === 'failed' || status === 'timed_out') return '새로고침 재시도'
  return '매물 새로고침'
}

function statusMessage(state: RefreshState, status: RefreshDisplayStatus): string | null {
  if (status === 'pending') return 'GitHub 클라우드 수집기 연결을 기다리고 있습니다.'
  if (status === 'running') return 'GitHub 클라우드 수집기에서 최신 매물을 확인하고 있습니다.'
  if (status === 'succeeded') return state.message ?? '최신 매물 데이터로 갱신했습니다.'
  if (status === 'failed') return state.message ?? '매물 새로고침에 실패했습니다. 다시 시도해 주세요.'
  if (status === 'timed_out') {
    return 'GitHub 클라우드 수집기 응답 시간이 초과됐습니다. 다시 시도해 주세요.'
  }
  return null
}

export function RefreshButton({ onUpdated }: Props) {
  const [state, setState] = useState<RefreshState>({ status: 'idle' })
  const [requesting, setRequesting] = useState(false)
  const reloadedJob = useRef<string | null>(null)
  const shownStatus = displayStatus(state)
  const busy = requesting || shownStatus === 'pending' || shownStatus === 'running'
  const message = statusMessage(state, shownStatus)

  const checkStatus = useCallback(async () => {
    try {
      const response = await api('status')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState((await response.json()) as RefreshState)
    } catch {
      setState({ status: 'failed', message: '새로고침 상태를 확인하지 못했습니다.' })
    }
  }, [])

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  useEffect(() => {
    if (state.status !== 'pending' && state.status !== 'running') return
    const timer = window.setInterval(() => void checkStatus(), 3_000)
    return () => window.clearInterval(timer)
  }, [checkStatus, state.status])

  useEffect(() => {
    if (
      state.status !== 'succeeded' ||
      !state.jobId ||
      reloadedJob.current === state.jobId
    ) return
    reloadedJob.current = state.jobId
    void onUpdated()
  }, [onUpdated, state.jobId, state.status])

  const requestRefresh = async () => {
    setRequesting(true)
    try {
      const response = await api('request', {
        method: 'POST',
        headers: { 'X-Requested-With': 'miare-dashboard' },
      })
      const next = (await response.json()) as RefreshState & { error?: string }
      if (!response.ok && response.status !== 202) {
        throw new Error(next.error ?? `HTTP ${response.status}`)
      }
      setState(next)
    } catch (caught) {
      setState({
        status: 'failed',
        message: caught instanceof Error ? caught.message : '새로고침을 요청하지 못했습니다.',
      })
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={requestRefresh}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex h-9 items-center gap-2 rounded-xl bg-blue px-3.5 text-[12.5px] font-bold text-white shadow-toss transition-all hover:bg-blue-deep disabled:cursor-wait disabled:opacity-65"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className={busy ? 'animate-spin' : ''}
        >
          <path
            d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {buttonLabel(shownStatus, requesting)}
      </button>
      {message && shownStatus !== 'idle' && (
        <span
          role="status"
          aria-live="polite"
          className={`max-w-[300px] text-right text-[11px] ${
            shownStatus === 'failed' || shownStatus === 'timed_out'
              ? 'text-rose'
              : shownStatus === 'succeeded'
                ? 'text-green'
                : shownStatus === 'running'
                  ? 'text-blue'
                  : 'text-faint'
          }`}
        >
          {message}
        </span>
      )}
    </div>
  )
}
