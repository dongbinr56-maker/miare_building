import { useEffect, useState } from 'react'
import type { HiddenListingEntry } from '../useHiddenListings'

function fmtMan(value: number | null): string {
  return value === null ? '—' : value.toLocaleString()
}

function fmtHiddenAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function sourceLabel(id: string): string {
  return id.startsWith('naver:') ? `네이버 ${id.slice(6)}` : `당근 ${id.slice(7)}`
}

export function HiddenListingsManager({
  entries,
  onRestore,
  onRestoreAll,
}: {
  entries: HiddenListingEntry[]
  onRestore: (entryId: string) => void
  onRestoreAll: () => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-surface px-3 text-[12.5px] font-bold text-dim shadow-toss transition-colors hover:text-blue"
      >
        숨긴 매물
        {entries.length > 0 && (
          <span className="tnum rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-faint">
            {entries.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-5"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="hidden-listings-title"
            className="modal-pop flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-3xl bg-surface shadow-2xl sm:rounded-3xl"
          >
            <div className="flex items-center gap-3 border-b border-line-soft px-5 py-4 sm:px-6">
              <div>
                <h2 id="hidden-listings-title" className="text-[18px] font-bold text-ink">
                  숨긴 매물 관리
                </h2>
                <p className="mt-0.5 text-[12.5px] text-faint">
                  같은 원본 번호는 다음 수집에서도 계속 숨겨집니다.
                </p>
              </div>
              {entries.length > 0 && (
                <button
                  type="button"
                  onClick={onRestoreAll}
                  className="ml-auto text-[12.5px] font-bold text-blue hover:text-blue-deep"
                >
                  모두 복구
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="숨긴 매물 관리 닫기"
                className={`${entries.length > 0 ? '' : 'ml-auto'} grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-[18px] text-dim hover:text-ink`}
              >
                ×
              </button>
            </div>

            <div className="overflow-y-auto p-4 sm:p-5">
              {entries.length === 0 ? (
                <div className="py-14 text-center">
                  <p className="text-[15px] font-bold text-ink">숨긴 매물이 없어요</p>
                  <p className="mt-1.5 text-[13px] text-dim">
                    카드의 ‘다신 보지 않음’을 누른 매물이 이곳에 표시됩니다.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {entries.map((entry) => (
                    <li key={entry.entryId} className="rounded-2xl border border-line-soft bg-surface-2/60 p-4">
                      <div className="flex gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-lg bg-surface px-2 py-1 text-[11px] font-bold text-dim">
                              {entry.listing.dong}
                            </span>
                            <span className="text-[11.5px] text-faint">
                              {fmtHiddenAt(entry.hiddenAt)} 숨김
                            </span>
                          </div>
                          <p className="mt-2 truncate text-[14px] font-bold text-ink">{entry.listing.name}</p>
                          <p className="tnum mt-1 text-[13px] font-semibold text-dim">
                            보증금 {fmtMan(entry.listing.deposit)} / 월세 {fmtMan(entry.listing.rent)}만원
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {entry.listingIds.map((id) => (
                              <span
                                key={id}
                                className="rounded-md bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-faint"
                              >
                                {sourceLabel(id)}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRestore(entry.entryId)}
                          className="h-9 shrink-0 rounded-xl bg-blue-bg px-3 text-[12.5px] font-bold text-blue transition-colors hover:bg-blue hover:text-white"
                        >
                          다시 보기
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  )
}
