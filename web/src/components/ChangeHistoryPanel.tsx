import { useEffect, useId, useRef, useState } from 'react'
import type {
  ListingChangeEvent,
  ListingChangeHistory,
  ListingChangeSummary,
} from '../types'

const TYPE_META = {
  new: { label: '신규', tone: 'bg-green-bg text-green' },
  price_changed: { label: '가격 변경', tone: 'bg-amber-bg text-amber' },
  description_changed: { label: '설명 변경', tone: 'bg-blue-bg text-blue' },
  deleted: { label: '사라짐', tone: 'bg-rose-bg text-rose' },
  relisted: { label: '재등록 추정', tone: 'bg-violet-50 text-violet-700' },
} as const

function fmtMan(value: number | null): string {
  return value === null ? '미확인' : `${value.toLocaleString()}만원`
}

function fmtCompared(value: string | null): string {
  if (!value) return '첫 비교 기준 생성 전'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toLocaleDateString('ko-KR')} ${date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  })} 대비`
}

function eventSummary(event: ListingChangeEvent): ListingChangeSummary | null {
  return event.current ?? event.previous
}

function PriceChanges({ event }: { event: ListingChangeEvent }) {
  const entries = Object.entries(event.changes ?? {}) as Array<[
    'deposit' | 'rent',
    { before: number | null; after: number | null },
  ]>
  if (entries.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-[12px] text-dim">
      {entries.map(([field, change]) => (
        <span key={field} className="rounded-lg bg-surface-2 px-2 py-1">
          {field === 'deposit' ? '보증금' : '월세'}{' '}
          <span className="tnum line-through opacity-65">{fmtMan(change.before)}</span>
          {' → '}
          <span className="tnum font-bold text-ink">{fmtMan(change.after)}</span>
        </span>
      ))}
    </div>
  )
}

function ChangeEventRow({ event }: { event: ListingChangeEvent }) {
  const summary = eventSummary(event)
  if (!summary) return null
  const meta = TYPE_META[event.type]
  const link = event.current?.link ?? event.previous?.link
  return (
    <li className="rounded-2xl border border-line-soft bg-white p-4">
      <div className="flex flex-wrap items-start gap-2">
        <span className={`rounded-lg px-2 py-1 text-[11px] font-bold ${meta.tone}`}>
          {meta.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-bold text-ink">{summary.name}</p>
          <p className="mt-0.5 text-[11.5px] text-faint">
            {summary.dong} · 보증금 {fmtMan(summary.deposit)} · 월세 {fmtMan(summary.rent)}
          </p>
        </div>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[11.5px] font-semibold text-blue"
            aria-label={`${summary.name} 원문 매물 열기`}
          >
            원문 ↗
          </a>
        )}
      </div>
      <PriceChanges event={event} />
      {event.type === 'description_changed' && (
        <p className="mt-2 text-[12px] text-dim">매물 설명이 직전 수집본과 달라졌습니다.</p>
      )}
      {event.type === 'relisted' && event.previous && event.current && (
        <p className="mt-2 text-[12px] text-dim">
          같은 건물·층·면적으로 확인된 {event.previous.id} → {event.current.id}
        </p>
      )}
      {event.type === 'deleted' && (
        <p className="mt-2 text-[12px] text-rose">
          현재 조건 충족 목록에서 사라졌습니다. 삭제 또는 조건 변경 여부는 원문에서 확인하세요.
        </p>
      )}
    </li>
  )
}

export function ChangeHistoryPanel({ history }: { history?: ListingChangeHistory }) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const eventCount = history?.events.length ?? 0

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
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
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      trigger?.focus()
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-surface px-3.5 text-[12.5px] font-bold text-dim shadow-toss transition-colors hover:text-blue"
      >
        변경 내역
        {eventCount > 0 && (
          <span className="tnum rounded-md bg-blue-bg px-1.5 py-0.5 text-[10.5px] text-blue">
            {eventCount.toLocaleString()}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[1100] grid place-items-center bg-slate-950/35 p-3 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-surface shadow-2xl"
          >
            <header className="flex items-start gap-4 border-b border-line-soft px-5 py-4">
              <div>
                <h2 id={titleId} className="text-[18px] font-bold text-ink">새로고침 변경 내역</h2>
                <p className="mt-1 text-[12px] text-faint">{fmtCompared(history?.comparedAt ?? null)}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="ml-auto rounded-xl bg-surface-2 px-3 py-2 text-[12px] font-bold text-dim"
                aria-label="변경 내역 닫기"
              >
                닫기
              </button>
            </header>

            <div className="overflow-y-auto p-5">
              {history?.baseline ? (
                <div className="rounded-2xl bg-blue-bg p-5 text-center">
                  <p className="font-bold text-blue">첫 비교 기준을 만들었습니다</p>
                  <p className="mt-1 text-[12.5px] text-dim">다음 새로고침부터 변경 내역이 표시됩니다.</p>
                </div>
              ) : (
                <>
                  <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {[
                      ['신규', history?.counts.new ?? 0],
                      ['가격', history?.counts.priceChanged ?? 0],
                      ['설명', history?.counts.descriptionChanged ?? 0],
                      ['사라짐', history?.counts.deleted ?? 0],
                      ['재등록', history?.counts.relisted ?? 0],
                    ].map(([label, count]) => (
                      <div key={String(label)} className="rounded-xl bg-surface-2 px-3 py-2 text-center">
                        <div className="tnum text-[16px] font-bold text-ink">{Number(count).toLocaleString()}</div>
                        <div className="text-[10.5px] font-semibold text-faint">{label}</div>
                      </div>
                    ))}
                  </div>
                  {eventCount === 0 ? (
                    <p className="rounded-2xl bg-surface-2 p-6 text-center text-[13px] text-dim">
                      직전 수집 이후 달라진 매물이 없습니다.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {history?.events.map((event) => (
                        <ChangeEventRow key={event.eventId} event={event} />
                      ))}
                    </ul>
                  )}
                  {history?.truncated && (
                    <p className="mt-3 text-center text-[11px] text-faint">최근 변경 500건까지만 표시합니다.</p>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  )
}
