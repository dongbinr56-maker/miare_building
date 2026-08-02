import { useEffect, useId, useRef } from 'react'
import type { Listing } from '../types'
import {
  formatAddress,
  formatArea,
  formatFacilitySummary,
  formatFloor,
  formatLocationConfidence,
  formatManwon,
  MAX_COMPARISON_LISTINGS,
  premiumComparisonSummary,
  summarizeNearbyFacilities,
} from '../comparisonUtils'

export interface ComparisonModalItem {
  listing: Listing
  progressStatus?: string | null
  personalNote?: string | null
}

interface ComparisonRow {
  label: string
  render: (item: ComparisonModalItem) => React.ReactNode
}

function textOrFallback(value: string | null | undefined, fallback = '확인 필요'): string {
  return value?.trim() || fallback
}

const COMPARISON_ROWS: ComparisonRow[] = [
  { label: '보증금', render: ({ listing }) => formatManwon(listing.deposit) },
  { label: '월세', render: ({ listing }) => formatManwon(listing.rent) },
  { label: '층 / 총층', render: ({ listing }) => formatFloor(listing) },
  { label: '면적', render: ({ listing }) => formatArea(listing) },
  {
    label: '권리금',
    render: ({ listing }) => {
      const premium = premiumComparisonSummary(listing)
      return (
        <div>
          <p className={premium.status === 'none' ? 'font-bold text-green' : premium.status === 'present' ? 'font-bold text-rose' : 'font-bold text-amber'}>
            {premium.label}
          </p>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-faint">근거: {premium.evidence}</p>
        </div>
      )
    },
  },
  {
    label: '500m 학교',
    render: ({ listing }) => {
      const facilities = summarizeNearbyFacilities(listing.nearbyFacilities)
      return formatFacilitySummary(facilities.schoolCount, facilities.nearestSchoolM)
    },
  },
  {
    label: '500m 아파트 단지',
    render: ({ listing }) => {
      const facilities = summarizeNearbyFacilities(listing.nearbyFacilities)
      return formatFacilitySummary(facilities.apartmentCount, facilities.nearestApartmentM)
    },
  },
  {
    label: '도로명 / 지번주소',
    render: ({ listing }) => (
      <span className="whitespace-pre-line leading-relaxed">{formatAddress(listing)}</span>
    ),
  },
  { label: '위치 신뢰도', render: ({ listing }) => formatLocationConfidence(listing) },
  { label: '진행 상태', render: ({ progressStatus }) => textOrFallback(progressStatus, '미분류') },
  {
    label: '개인 메모',
    render: ({ personalNote }) => (
      <span className="whitespace-pre-wrap break-words leading-relaxed">
        {textOrFallback(personalNote, '메모 없음')}
      </span>
    ),
  },
]

export function ComparisonModal({
  open,
  items,
  onClose,
  onRemove,
}: {
  open: boolean
  items: readonly ComparisonModalItem[]
  onClose: () => void
  onRemove?: (listingId: string) => void
}) {
  const titleId = useId()
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const visibleItems = items.slice(0, MAX_COMPARISON_LISTINGS)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 backdrop-blur-[3px] sm:items-center sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-pop flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-3xl bg-surface shadow-2xl sm:rounded-3xl"
      >
        <header className="flex items-center gap-3 border-b border-line-soft px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[18px] font-bold text-ink">후보 매물 비교</h2>
            <p className="mt-0.5 text-[12.5px] text-faint">선택한 매물 {visibleItems.length}개를 같은 기준으로 비교합니다.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="매물 비교 닫기"
            className="ml-auto grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 text-[19px] text-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
          >
            ×
          </button>
        </header>

        {visibleItems.length === 0 ? (
          <div className="overflow-y-auto px-6 py-16 text-center">
            <p className="text-[15px] font-bold text-ink">비교할 매물이 없어요</p>
            <p className="mt-1.5 text-[13px] text-dim">매물 카드에서 최대 3개를 선택해 주세요.</p>
          </div>
        ) : (
          <div className="overflow-auto overscroll-contain p-4 sm:p-6" tabIndex={0} aria-label="매물 비교표 가로 및 세로 스크롤 영역">
            <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-left text-[13px] text-dim">
              <caption className="sr-only">
                선택한 매물의 가격, 건물 정보, 권리금, 500미터 생활권, 위치, 진행 상태와 개인 메모 비교
              </caption>
              <colgroup>
                <col className="w-36" />
                {visibleItems.map(({ listing }) => <col key={listing.id} className="min-w-52" />)}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="sticky top-0 left-0 z-20 border-r border-b border-line bg-surface-3 px-4 py-3 font-bold text-ink">
                    비교 항목
                  </th>
                  {visibleItems.map(({ listing }) => (
                    <th key={listing.id} scope="col" className="sticky top-0 z-10 border-r border-b border-line bg-surface-3 px-4 py-3 align-top last:border-r-0">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-bold text-blue">{textOrFallback(listing.dong)}</p>
                          <p className="mt-1 line-clamp-2 text-[14px] font-bold leading-snug text-ink">{textOrFallback(listing.name, '매물')}</p>
                          <a
                            href={listing.link}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-2 inline-flex text-[11.5px] font-bold text-blue hover:text-blue-deep"
                          >
                            원본 매물 보기 ↗
                          </a>
                        </div>
                        {onRemove && (
                          <button
                            type="button"
                            onClick={() => onRemove(listing.id)}
                            aria-label={`${textOrFallback(listing.name, '매물')} 비교에서 제외`}
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[16px] text-faint transition-colors hover:bg-rose-bg hover:text-rose"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row" className="sticky left-0 z-10 border-r border-b border-line-soft bg-surface-3 px-4 py-3 font-bold text-ink">
                      {row.label}
                    </th>
                    {visibleItems.map((item) => (
                      <td key={item.listing.id} className="border-r border-b border-line-soft bg-surface px-4 py-3 align-top last:border-r-0">
                        {row.render(item)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
