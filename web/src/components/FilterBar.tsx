import type { RegionCount } from '../types'

export type LevelFilter = 'full' | 'nearUp' | 'all'
export type SortKey = 'reco' | 'rentAsc' | 'depositAsc' | 'pyeongAsc' | 'recent'

export interface Filters {
  dongs: string[]
  level: LevelFilter
  firstFloorOnly: boolean
  noPremiumOnly: boolean
  newOnly: boolean
  query: string
  sort: SortKey
}

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
      className={`h-8 shrink-0 rounded-full border px-3.5 text-[13px] font-medium transition-all duration-150 ${
        active
          ? 'border-mint/50 bg-mint/12 text-mint'
          : 'border-line bg-surface text-dim hover:border-line hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

export function FilterBar({
  regions,
  filters,
  onChange,
}: {
  regions: RegionCount[]
  filters: Filters
  onChange: (f: Filters) => void
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })

  const toggleDong = (name: string) => {
    const has = filters.dongs.includes(name)
    set({ dongs: has ? filters.dongs.filter((d) => d !== name) : [...filters.dongs, name] })
  }

  return (
    <div className="glass sticky top-0 z-20 -mx-4 border-b border-line-soft px-4 py-3 md:-mx-6 md:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-2.5">
        {/* 1행: 동 선택 + 검색 */}
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={filters.dongs.length === 0} onClick={() => set({ dongs: [] })}>
            전체 동
          </Chip>
          {regions.map((r) => (
            <Chip key={r.name} active={filters.dongs.includes(r.name)} onClick={() => toggleDong(r.name)}>
              {r.name}
              <span className="ml-1 font-mono text-[11px] opacity-60">{r.count}</span>
            </Chip>
          ))}
          <div className="ml-auto min-w-[140px] flex-1 md:max-w-[240px]">
            <input
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="설명·건물명 검색"
              className="h-8 w-full rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink placeholder-faint outline-none transition-colors focus:border-mint/40"
            />
          </div>
        </div>

        {/* 2행: 매치 레벨 + 토글 + 정렬 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-full border border-line">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => set({ level: l.key })}
                className={`h-8 px-3.5 text-[13px] font-medium transition-colors ${
                  filters.level === l.key ? 'bg-mint/15 text-mint' : 'bg-surface text-dim hover:text-ink'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>

          <Chip active={filters.firstFloorOnly} onClick={() => set({ firstFloorOnly: !filters.firstFloorOnly })}>
            1층만
          </Chip>
          <Chip active={filters.noPremiumOnly} onClick={() => set({ noPremiumOnly: !filters.noPremiumOnly })}>
            무권리 표기
          </Chip>
          <Chip active={filters.newOnly} onClick={() => set({ newOnly: !filters.newOnly })}>
            신규만
          </Chip>

          <select
            value={filters.sort}
            onChange={(e) => set({ sort: e.target.value as SortKey })}
            className="ml-auto h-8 rounded-full border border-line bg-surface px-3 text-[13px] font-medium text-dim outline-none transition-colors hover:text-ink focus:border-mint/40"
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
