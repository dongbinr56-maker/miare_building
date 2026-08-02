import { useEffect, useMemo } from 'react'
import type { Criteria, RegionCount } from '../types'

export type LevelFilter = 'full' | 'nearUp' | 'all'
export type SortKey = 'reco' | 'rentAsc' | 'depositAsc' | 'pyeongAsc' | 'recent'

export interface Filters {
  dongs: string[]
  sources: string[]
  level: LevelFilter
  targetFloorOnly: boolean
  noPremiumOnly: boolean
  newOnly: boolean
  favOnly: boolean
  query: string
  sort: SortKey
}

const SOURCES: { key: string; label: string }[] = [
  { key: 'naver', label: '네이버' },
  { key: 'daangn', label: '당근' },
]

const LEVELS: { key: LevelFilter; label: string }[] = [
  { key: 'full', label: '충족만' },
  { key: 'nearUp', label: '근접 이상' },
  { key: 'all', label: '전체' },
]

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'reco', label: '추천순' },
  { key: 'rentAsc', label: '월세 낮은순' },
  { key: 'depositAsc', label: '보증금 낮은순' },
  { key: 'pyeongAsc', label: '평수 작은순' },
  { key: 'recent', label: '최근 확인순' },
]

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`h-9 shrink-0 rounded-full px-3.5 text-[13px] font-semibold transition-all duration-150 ${
        active
          ? 'bg-blue text-white shadow-toss'
          : 'bg-surface text-dim shadow-toss hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

export function FilterBar({
  regions,
  criteria,
  filters,
  onChange,
  favCount,
}: {
  regions: RegionCount[]
  criteria: Criteria
  filters: Filters
  onChange: (f: Filters) => void
  favCount: number
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const availableRegions = useMemo(
    () => regions.filter((region) => region.count > 0),
    [regions],
  )
  const selectedDong = filters.dongs[0] ?? ''
  const selectedDongExists = !selectedDong || availableRegions.some((region) => region.name === selectedDong)
  const safeSelectedDong = selectedDongExists ? selectedDong : ''

  // 새 수집에서 현재 선택한 동의 적합 매물이 0건이 되면
  // 옵션과 필터 상태를 함께 '광산구 전체'로 복구한다.
  useEffect(() => {
    if (!selectedDong || selectedDongExists) return
    onChange({ ...filters, dongs: [] })
  }, [filters, onChange, selectedDong, selectedDongExists])

  return (
    <div className="glass sticky top-0 z-20 -mx-4 border-b border-line-soft px-4 py-3.5 md:-mx-6 md:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-2.5">
        {/* 1행: 광산구 전체 법정동 선택 + 검색 */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="dong-filter">법정동 선택</label>
          <select
            id="dong-filter"
            value={safeSelectedDong}
            onChange={(event) => set({ dongs: event.target.value ? [event.target.value] : [] })}
            className="h-9 min-w-[170px] rounded-full bg-surface px-3.5 text-[13px] font-semibold text-dim shadow-toss outline-none transition-all hover:text-ink focus:ring-2 focus:ring-blue/40"
          >
            <option value="">광산구 전체 · {regions.reduce((sum, region) => sum + region.count, 0)}</option>
            {availableRegions.map((region) => (
              <option key={region.name} value={region.name}>
                {region.name} · {region.count}
              </option>
            ))}
          </select>
          <div className="ml-auto min-w-[140px] flex-1 md:max-w-[240px]">
            <input
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="설명·건물명 검색"
              className="h-9 w-full rounded-full bg-surface px-4 text-[13px] font-medium text-ink placeholder-faint shadow-toss outline-none transition-all focus:ring-2 focus:ring-blue/40"
            />
          </div>
        </div>

        {/* 2행: 매치 레벨 + 토글 + 정렬 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-full bg-surface-2 p-1">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => set({ level: l.key })}
                className={`h-7 rounded-full px-3 text-[13px] font-semibold transition-all ${
                  filters.level === l.key
                    ? 'bg-surface text-blue shadow-toss'
                    : 'text-faint hover:text-dim'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>

          {SOURCES.map((s) => (
            <Chip
              key={s.key}
              active={filters.sources.includes(s.key)}
              onClick={() => {
                const has = filters.sources.includes(s.key)
                set({ sources: has ? filters.sources.filter((x) => x !== s.key) : [...filters.sources, s.key] })
              }}
            >
              {s.label}
            </Chip>
          ))}

          <Chip active={filters.targetFloorOnly} onClick={() => set({ targetFloorOnly: !filters.targetFloorOnly })}>
            {criteria.floorMin === -1 && criteria.floorMax === 2
              ? 'B1~2층만'
              : '대상 층수만'}
          </Chip>
          <Chip active={filters.noPremiumOnly} onClick={() => set({ noPremiumOnly: !filters.noPremiumOnly })}>
            무권리만
          </Chip>
          <Chip active={filters.newOnly} onClick={() => set({ newOnly: !filters.newOnly })}>
            신규만
          </Chip>
          <button
            onClick={() => set({ favOnly: !filters.favOnly })}
            className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3.5 text-[13px] font-semibold transition-all duration-150 ${
              filters.favOnly
                ? 'bg-rose text-white shadow-toss'
                : 'bg-surface text-dim shadow-toss hover:text-ink'
            }`}
          >
            {filters.favOnly ? '♥' : '♡'} 즐겨찾기
            {favCount > 0 && <span className="tnum text-[11px] opacity-70">{favCount}</span>}
          </button>

          <select
            value={filters.sort}
            onChange={(e) => set({ sort: e.target.value as SortKey })}
            className="ml-auto h-9 rounded-full bg-surface px-3.5 text-[13px] font-semibold text-dim shadow-toss outline-none transition-all hover:text-ink focus:ring-2 focus:ring-blue/40"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
