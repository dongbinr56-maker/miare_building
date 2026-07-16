import { useMemo, useState } from 'react'
import { useListings } from './useListings'
import { useFavorites } from './useFavorites'
import { StatsRow } from './components/StatsRow'
import { FilterBar, type Filters } from './components/FilterBar'
import { ListingCard } from './components/ListingCard'
import DotGrid from './components/DotGrid'
import type { Listing } from './types'

const PAGE_SIZE = 60

const DEFAULT_FILTERS: Filters = {
  dongs: [],
  sources: [],
  level: 'nearUp',
  firstFloorOnly: false,
  noPremiumOnly: false,
  newOnly: false,
  favOnly: false,
  query: '',
  sort: 'reco',
}

function applyFilters(listings: Listing[], f: Filters): Listing[] {
  let out = listings

  // 즐겨찾기 보기에서는 매치 레벨 필터를 건너뛴다(찜한 건 다 보여줌)
  if (!f.favOnly) {
    if (f.level === 'full') out = out.filter((x) => x.matchLevel === 'full')
    else if (f.level === 'nearUp') out = out.filter((x) => x.matchLevel !== 'low')
  }

  if (f.dongs.length > 0) out = out.filter((x) => f.dongs.includes(x.dong))
  if (f.sources.length > 0) out = out.filter((x) => f.sources.includes(x.source))
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
        <div key={i} className="skeleton h-[260px] rounded-3xl" />
      ))}
    </div>
  )
}

export default function App() {
  const { data, error, loading } = useListings()
  const fav = useFavorites()
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [visible, setVisible] = useState(PAGE_SIZE)

  const filtered = useMemo(() => {
    if (!data) return []
    // 즐겨찾기 보기: 저장된 스냅샷을 소스로(매물이 내려가도 유지)
    const source = filters.favOnly ? Object.values(fav.snapshots) : data.listings
    return applyFilters(source, filters)
  }, [data, filters, fav.snapshots])

  const setFiltersReset = (f: Filters) => {
    setFilters(f)
    setVisible(PAGE_SIZE)
  }

  return (
    <div className="relative min-h-screen">
      {/* 인터랙티브 도트 그리드 배경 (React Bits) — 라이트 톤 */}
      <div className="pointer-events-none fixed inset-0 z-0 opacity-90">
        <DotGrid
          dotSize={3}
          gap={28}
          baseColor="#dbe2ea"
          activeColor="#3182f6"
          proximity={120}
          shockRadius={230}
          shockStrength={4}
          returnDuration={1.4}
        />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-4 md:px-6">
        {/* 헤더 */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3 pt-8 pb-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-[#4593fc] to-[#1b64da] shadow-toss">
                <svg width="23" height="23" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d="M12 2.2c-4.1 0-7.4 3.2-7.4 7.2 0 4.9 5.7 10.3 7 11.4.2.2.6.2.8 0 1.3-1.1 7-6.5 7-11.4 0-4-3.3-7.2-7.4-7.2Z"
                    fill="white"
                  />
                  <circle cx="12" cy="9.3" r="3.4" fill="#1b64da" />
                  <circle cx="12" cy="9.3" r="1.35" fill="white" />
                  <circle cx="14.1" cy="7.2" r="0.7" fill="white" opacity="0.9" />
                </svg>
              </span>
              <h1 className="text-[23px] font-bold tracking-tight text-ink">
                스냅스팟 <span className="text-blue">매물 레이더</span>
              </h1>
            </div>
            <p className="mt-2 text-[14px] font-medium text-dim">
              광주 광산구 · 증명사진관 자리 찾기 · 상가 월세
            </p>
          </div>
          {data && (
            <div className="ml-auto text-right">
              <div className="tnum text-[12.5px] font-medium text-faint">{fmtUpdated(data.updatedAt)}</div>
              <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                {[
                  `보증금 ≤ ${data.criteria.depositMax}만`,
                  `월세 ≤ ${data.criteria.rentMax}만`,
                  '1층',
                  `${data.criteria.pyeongMin}~${data.criteria.pyeongMax}평`,
                ].map((c) => (
                  <span
                    key={c}
                    className="rounded-lg bg-blue-bg px-2.5 py-1 text-[11.5px] font-semibold text-blue"
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
        <div className="relative z-10 mx-auto max-w-6xl px-4 md:px-6">
          <FilterBar regions={data.regions} filters={filters} onChange={setFiltersReset} favCount={fav.count} />
        </div>
      )}

      {/* 본문 */}
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-5 md:px-6">
        {loading && <SkeletonGrid />}

        {error && (
          <div className="rounded-3xl bg-rose-bg p-6 text-center shadow-toss">
            <p className="font-bold text-rose">데이터를 불러오지 못했어요</p>
            <p className="mt-1 text-[13px] text-dim">{error}</p>
          </div>
        )}

        {data && (
          <>
            <div className="mb-3.5 text-[13px] font-medium text-faint">
              <span className="tnum font-bold text-dim">{filtered.length.toLocaleString()}</span>건 표시 중
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-3xl bg-surface p-10 text-center shadow-toss">
                {filters.favOnly ? (
                  <>
                    <p className="text-[16px] font-bold text-ink">아직 즐겨찾기한 매물이 없어요</p>
                    <p className="mt-2 text-[13.5px] text-dim">
                      마음에 드는 매물의 ♡를 눌러 저장하면 여기 모여요.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[16px] font-bold text-ink">조건에 맞는 매물이 없어요</p>
                    <p className="mt-2 text-[13.5px] text-dim">
                      필터를 넓혀보세요 — 매물은 주기적으로 자동 수집돼요.
                    </p>
                  </>
                )}
                <button
                  onClick={() => setFiltersReset(DEFAULT_FILTERS)}
                  className="mt-4 h-10 rounded-xl bg-blue px-4 text-[13.5px] font-bold text-white transition-colors hover:bg-blue-deep"
                >
                  필터 초기화
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.slice(0, visible).map((item, i) => (
                  <ListingCard
                    key={item.id}
                    item={item}
                    i={i}
                    isFav={fav.isFav(item.id)}
                    onToggleFav={fav.toggle}
                  />
                ))}
              </div>
            )}

            {filtered.length > visible && (
              <div className="mt-6 text-center">
                <button
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="h-11 rounded-xl bg-surface px-5 text-[13.5px] font-bold text-dim shadow-toss transition-all hover:text-blue hover:shadow-toss-hover"
                >
                  더 보기 ({(filtered.length - visible).toLocaleString()}건 남음)
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="relative z-10 mx-auto max-w-6xl px-4 pt-4 pb-10 md:px-6">
        <div className="border-t border-line-soft pt-5 text-center text-[12px] leading-relaxed text-faint">
          개인용 비공식 도구 · 데이터 출처: 네이버 부동산 · 당근부동산 (자동 수집) · 가격/권리금은 반드시 중개사에 직접 확인하세요
        </div>
      </footer>
    </div>
  )
}
