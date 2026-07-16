import { useCountUp } from '../useCountUp'
import type { ListingData } from '../types'

function StatTile({
  label,
  value,
  tone,
  hint,
  i,
}: {
  label: string
  value: number
  tone: 'mint' | 'amber' | 'ink' | 'blue'
  hint?: string
  i: number
}) {
  const n = useCountUp(value)
  const toneCls =
    tone === 'mint'
      ? 'text-mint'
      : tone === 'amber'
        ? 'text-amber'
        : tone === 'blue'
          ? 'text-sky-400'
          : 'text-ink'
  return (
    <div
      className="rise relative overflow-hidden rounded-2xl border border-line bg-surface px-5 py-4"
      style={{ '--i': i } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-dim">
        {tone === 'mint' && <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-mint" />}
        {label}
      </div>
      <div className={`mt-1.5 font-mono text-[34px] leading-none font-bold tracking-tight ${toneCls}`}>
        {n.toLocaleString()}
        <span className="ml-1 text-[15px] font-semibold text-faint">건</span>
      </div>
      {hint && <div className="mt-1.5 text-[12px] text-faint">{hint}</div>}
    </div>
  )
}

export function StatsRow({ data }: { data: ListingData }) {
  const { stats } = data
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatTile i={0} label="조건 충족" value={stats.full} tone="mint" hint="4개 조건 모두 만족" />
      <StatTile i={1} label="아쉽게 근접" value={stats.near} tone="amber" hint="조건 3개 만족" />
      <StatTile i={2} label="오늘 신규" value={stats.new} tone="blue" hint="이번 수집에서 처음 발견" />
      <StatTile i={3} label="전체 매물" value={stats.total} tone="ink" hint="상가 · 월세 기준" />
    </div>
  )
}
