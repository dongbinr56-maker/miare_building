import { MAX_COMPARISON_LISTINGS } from '../comparisonUtils'

export function ComparisonTray({
  selectedCount,
  onOpen,
  onClear,
}: {
  selectedCount: number
  onOpen: () => void
  onClear: () => void
}) {
  const safeCount = Number.isFinite(selectedCount)
    ? Math.min(Math.max(Math.trunc(selectedCount), 0), MAX_COMPARISON_LISTINGS)
    : 0
  if (safeCount === 0) return null

  return (
    <aside
      aria-label="매물 비교 선택"
      className="fixed right-3 bottom-3 left-3 z-40 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-blue/20 bg-white/95 p-3 shadow-2xl backdrop-blur-md sm:right-5 sm:bottom-5 sm:left-5 sm:px-4"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-ink">비교할 매물 {safeCount}개</p>
        <p className="text-[11.5px] text-faint">최대 {MAX_COMPARISON_LISTINGS}개까지 나란히 볼 수 있어요.</p>
      </div>
      <button
        type="button"
        onClick={onClear}
        aria-label={`선택한 비교 매물 ${safeCount}개 전체 해제`}
        className="h-10 shrink-0 rounded-xl px-2.5 text-[12.5px] font-bold text-faint transition-colors hover:bg-surface-2 hover:text-rose"
      >
        전체 해제
      </button>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`선택한 매물 ${safeCount}개 비교 열기`}
        className="h-10 shrink-0 rounded-xl bg-blue px-4 text-[13px] font-bold text-white transition-colors hover:bg-blue-deep"
      >
        비교하기
      </button>
    </aside>
  )
}
