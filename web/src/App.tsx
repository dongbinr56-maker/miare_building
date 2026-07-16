import { useMemo, useState } from 'react'
import { useListings } from './useListings'
import { StatsRow } from './components/StatsRow'
import { FilterBar, type Filters } from './components/FilterBar'
import { ListingCard } from './components/ListingCard'
import type { Listing } from './types'

const PAGE_SIZE = 60

const DEFAULT_FILTERS: Filters = {
  dongs: [],
  level: 'nearUp',
  firstFloorOnly: false,
  noPremiumOnly: false,
  newOnly: false,
  query: '',
  sort: 'reco',
}

function applyFilters(listings: Listing[], f: Filters): Listing[] {
  let out = listings

  if (f.level === 'full') out = out.filter((x) => x.matchLevel === 'full')
  else if (f.level === 'nearUp') out = out.filter((x) => x.matchLevel !== 'low')

  if (f.dongs.length > 0) out = out.filter((x) => f.dongs.includes(x.dong))
  if (f.firstFloorOnly) out = out.filter((x) => x.floor === 1)
  if (f.noPremiumOnly) out = out.filter((x) => x.noPremium)
  if (f.newOnly) out = out.filter((x) => x.isNew)

  const q = f.query.trim()
  if (q) {
    const lo = q.toLowerCase()
    out = out.filter(
      (x) =>
        x.desc.toLowerCase().includes(lo) ||
        x.name.toLowerCase().includes(lo) ||
        (x.realtor ?? '').toLowerCase().includes(lo) ||
        x.tags.some((t) => t.toLowerCase().includes(lo)),
    )
  }

  const nullLast = (v: number | null) => (v === null ? Number.MAX_SAFE_INTEGER : v)
  switch (f.sort) {
    case 'rentAsc':
      out = [...out].sort((a, b) => nullLast(a.rent) - nullLast(b.rent))
      break
    case 'depositAsc':
      out = [...out].sort((a, b) => nullLast(a.deposit) - nullLast(b.deposit))
      break
    case 'pyeongAsc':
      out = [...out].sort((a, b) => nullLast(a.pyeong) - nullLast(b.pyeong))
      break
    case 'recent':
      out = [...out].sort((a, b) => (b.confirmedAt ?? '').localeCompare(a.confirmedAt ?? ''))
      break
    default:
      break // reco: 수집기 정렬(충족 -> 월세 -> 보증금) 유지
  }
  return out
}

function fmtUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}.${dd} ${hh}:${mi} 업데이트`
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton h-[260px] rounded-2xl border border-line-soft" />
      ))}
    </div>
  )
}

export default function App() {
  const { data, error, loading } = useListings()
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [visible, setVisible] = useState(PAGE_SIZE)

  const filtered = useMemo(
    () => (data ? applyFilters(data.listings, filters) : []),
    [data, filters],
  )

  const setFiltersReset = (f: Filters) => {
    setFilters(f)
    setVisible(PAGE_SIZE)
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 md:px-6">
        {/* 헤더 */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-8 pb-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-mint/30 bg-mint/10 text-[17px]">
                📷
              </span>
              <h1 className="text-[22px] font-extrabold tracking-tight">
                MIARE <span className="font-semibold text-mint">매물 레이더</span>
              </h1>
            </div>
            <p className="mt-1.5 text-[13.5px] text-dim">
              광주 광산구 · 증명사진관 자리 찾기 · 상가 월세
            </p>
          </div>
          {data && (
            <div className="ml-auto text-right">
              <div className="font-mono text-[12.5px] text-faint">{fmtUpdated(data.updatedAt)}</div>
              <div className="mt-1 flex flex-wrap justify-end gap-1.5">
                {[
                  `보증금 ≤ ${data.criteria.depositMax}만`,
                  `월세 ≤ ${data.criteria.rentMax}만`,
                  '1층',
                  `${data.criteria.pyeongMin}~${data.criteria.pyeongMax}평`,
                ].map((c) => (
                  <span
                    key={c}
                    className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] font-medium text-dim"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
        </header>

        {/* KPI */}
        {data && (
          <div className="pb-5">
            <StatsRow data={data} />
          </div>
        )}
      </div>

      {/* 필터 (sticky) */}
      {data && (
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <FilterBar regions={data.regions} filters={filters} onChange={setFiltersReset} />
        </div>
      )}

      {/* 본문 */}
      <main className="mx-auto max-w-6xl px-4 py-5 md:px-6">
        {loading && <SkeletonGrid />}

        {error && (
          <div className="rounded-2xl border border-rose/30 bg-rose/5 p-6 text-center">
            <p className="font-semibold text-rose">데이터를 불러오지 못했어요</p>
            <p className="mt-1 text-[13px] text-dim">{error}</p>
          </div>
        )}

        {data && (
          <>
            <div className="mb-3 text-[13px] text-faint">
              {filtered.length.toLocaleString()}건 표시 중
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-line bg-surface p-10 text-center">
                <p className="text-[15px] font-semibold text-ink">조건에 맞는 매물이 없어요</p>
                <p className="mt-1.5 text-[13px] text-dim">
                  필터를 넓혀보세요 — 매물은 주기적으로 자동 수집돼요.
                </p>
                <button
                  onClick={() => setFiltersReset(DEFAULT_FILTERS)}
                  className="mt-4 h-9 rounded-full border border-mint/40 bg-mint/10 px-4 text-[13px] font-semibold text-mint transition-colors hover:bg-mint/20"
                >
                  필터 초기화
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.slice(0, visible).map((item, i) => (
                  <ListingCard key={item.id} item={item} i={i} />
                ))}
              </div>
            )}

            {filtered.length > visible && (
              <div className="mt-6 text-center">
                <button
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="h-10 rounded-full border border-line bg-surface px-5 text-[13.5px] font-semibold text-dim transition-colors hover:border-mint/40 hover:text-mint"
                >
                  더 보기 ({(filtered.length - visible).toLocaleString()}건 남음)
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="mx-auto max-w-6xl px-4 pt-4 pb-10 md:px-6">
        <div className="border-t border-line-soft pt-5 text-center text-[12px] leading-relaxed text-faint">
          개인용 비공식 도구 · 데이터 출처: 네이버 부동산 (자동 수집) · 가격/권리금은 반드시 중개사에 직접 확인하세요
        </div>
      </footer>
    </div>
  )
}
