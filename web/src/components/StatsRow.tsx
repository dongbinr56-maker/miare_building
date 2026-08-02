import CountUp from './reactbits/CountUp'
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
  tone: 'blue' | 'amber' | 'ink' | 'green'
  hint?: string
  i: number
}) {
  const toneCls =
    tone === 'blue'
      ? 'text-blue'
      : tone === 'amber'
        ? 'text-amber'
        : tone === 'green'
          ? 'text-green'
          : 'text-ink'
  return (
    <div
      className="rise rounded-3xl bg-surface px-5 py-4.5 shadow-toss"
      style={{ '--i': i } as React.CSSProperties}
    >
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-faint">
        {tone === 'blue' && <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-blue" />}
        {label}
      </div>
      <div className={`tnum mt-1.5 text-[34px] leading-none font-bold ${toneCls}`}>
        <CountUp to={value} duration={1.2} separator="," />
        <span className="ml-1 text-[15px] font-bold text-faint">건</span>
      </div>
      {hint && <div className="mt-2 text-[12px] font-medium text-faint">{hint}</div>}
    </div>
  )
}

export function StatsRow({ data }: { data: ListingData }) {
  const { stats } = data
  const activeRegions = data.regions.filter((region) => region.count > 0).length
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatTile i={0} label="최종 선별" value={stats.total} tone="blue" hint="모든 조건·생활권 확인 완료" />
      <StatTile i={1} label="생활권 확인" value={stats.nearby?.kept ?? stats.total} tone="amber" hint={`학교·아파트 ${stats.nearby?.radiusM ?? 800}m 이내`} />
      <StatTile i={2} label="오늘 신규" value={stats.new} tone="green" hint="이번 수집에서 처음 발견" />
      <StatTile i={3} label="매물 있는 동" value={activeRegions} tone="ink" hint="광산구 전체 법정동 검색" />
    </div>
  )
}
