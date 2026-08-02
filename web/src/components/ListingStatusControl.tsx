import { useId } from 'react'
import type { ListingWorkflowStatus } from '../listingWorkspaceStore'
import type { ListingWorkspaceSyncStatus } from '../useListingWorkspace'

const STATUS_OPTIONS: { value: ListingWorkflowStatus; label: string }[] = [
  { value: 'review', label: '검토 중' },
  { value: 'call', label: '전화 예정' },
  { value: 'visit', label: '방문 예약' },
  { value: 'hold', label: '보류' },
  { value: 'finalist', label: '최종 후보' },
  { value: 'rejected', label: '탈락' },
]

export function ListingStatusControl({
  status,
  compared,
  compareCount,
  ready,
  syncStatus,
  onStatusChange,
  onToggleCompare,
}: {
  status: ListingWorkflowStatus | null
  compared: boolean
  compareCount: number
  ready: boolean
  syncStatus: ListingWorkspaceSyncStatus
  onStatusChange: (status: ListingWorkflowStatus | null) => void
  onToggleCompare: () => void
}) {
  const selectId = useId()
  const compareLimitReached = !compared && compareCount >= 3
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="매물 검토 상태">
      <label className="sr-only" htmlFor={selectId}>매물 진행 상태</label>
      <select
        id={selectId}
        value={status ?? ''}
        disabled={!ready}
        onChange={(event) => onStatusChange(
          event.target.value === '' ? null : event.target.value as ListingWorkflowStatus,
        )}
        className="h-9 rounded-xl border border-line bg-surface px-3 text-[12.5px] font-bold text-dim disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="매물 진행 상태"
      >
        <option value="">상태 미지정</option>
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        type="button"
        disabled={!ready || compareLimitReached}
        onClick={onToggleCompare}
        className={`inline-flex h-9 items-center rounded-xl px-3 text-[12.5px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          compared ? 'bg-blue text-white' : 'bg-surface-2 text-dim hover:text-blue'
        }`}
        title={compareLimitReached ? '비교는 최대 3개까지 선택할 수 있습니다.' : undefined}
        aria-pressed={compared}
      >
        {compared ? '비교 해제' : '비교 담기'}
      </button>
      {syncStatus === 'saving' && <span className="text-[11px] text-faint">저장 중…</span>}
      {syncStatus === 'error' && <span className="text-[11px] font-semibold text-rose">동기화 실패</span>}
    </div>
  )
}
