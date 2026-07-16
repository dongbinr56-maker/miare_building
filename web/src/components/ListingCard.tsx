import type { Listing } from '../types'

function fmtMan(v: number | null): string {
  if (v === null) return '—'
  return v.toLocaleString()
}

function fmtConfirmed(ymd: string | null): string {
  if (!ymd || ymd.length !== 8) return ''
  return `${ymd.slice(4, 6)}.${ymd.slice(6, 8)} 확인`
}

function CheckPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 rounded-lg px-2 text-[11.5px] font-bold ${
        ok ? 'bg-blue-bg text-blue' : 'bg-rose-bg text-rose'
      }`}
    >
      {ok ? '✓' : '✕'} {label}
    </span>
  )
}

const LEVEL_BADGE = {
  full: { cls: 'bg-blue text-white', label: '조건 충족' },
  near: { cls: 'bg-amber-bg text-amber', label: '근접' },
  low: { cls: 'bg-surface-2 text-faint', label: '조건 미달' },
} as const

const SOURCE_BADGE = {
  naver: { cls: 'bg-[#03c75a]/12 text-[#03a94d]', label: 'N 네이버' },
  daangn: { cls: 'bg-[#ff7e36]/12 text-[#f96f1e]', label: '당근' },
} as const

export function ListingCard({ item, i }: { item: Listing; i: number }) {
  const badge = LEVEL_BADGE[item.matchLevel]
  const cardCls =
    item.matchLevel === 'full' ? 'card-full' : item.matchLevel === 'near' ? 'card-near' : 'shadow-toss'

  return (
    <article
      className={`rise group flex flex-col gap-3 rounded-3xl bg-surface p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-toss-hover ${cardCls}`}
      style={{ '--i': i } as React.CSSProperties}
    >
      {/* 상단: 뱃지 라인 */}
      <div className="flex items-center gap-1.5">
        <span className={`inline-flex h-6 items-center rounded-lg px-2 text-[11.5px] font-bold ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="inline-flex h-6 items-center rounded-lg bg-surface-2 px-2 text-[11.5px] font-bold text-dim">
          {item.dong}
        </span>
        <span
          className={`inline-flex h-6 items-center rounded-lg px-2 text-[11px] font-bold ${SOURCE_BADGE[item.source]?.cls ?? 'bg-surface-2 text-dim'}`}
        >
          {SOURCE_BADGE[item.source]?.label ?? item.source}
        </span>
        {item.isNew && (
          <span className="inline-flex h-6 items-center rounded-lg bg-green-bg px-2 text-[11.5px] font-bold text-green">
            NEW
          </span>
        )}
        <span className="tnum ml-auto text-[11.5px] font-medium text-faint">{fmtConfirmed(item.confirmedAt)}</span>
      </div>

      {/* 가격 히어로 */}
      <div className="flex items-baseline gap-2">
        <div className="tnum text-[30px] leading-none font-bold text-ink">
          {fmtMan(item.deposit)}
          <span className="mx-1.5 text-[20px] font-semibold text-faint">/</span>
          {fmtMan(item.rent)}
        </div>
        <span className="text-[12.5px] font-medium text-faint">만원 · 보증금/월세</span>
      </div>

      {/* 스펙 라인 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] text-dim">
        <span className="font-bold text-ink">
          {item.pyeong !== null ? `${item.pyeong}평` : '평수 미상'}
          {item.areaM2 !== null && <span className="ml-1 font-medium text-faint">({item.areaM2}㎡)</span>}
        </span>
        <span className="text-line">·</span>
        <span className="font-medium">{item.floorRaw ? `${item.floorRaw}층` : '층 미상'}</span>
        <span className="text-line">·</span>
        <span className="font-medium">{item.typeName}</span>
        {item.direction && (
          <>
            <span className="text-line">·</span>
            <span className="font-medium">{item.direction}</span>
          </>
        )}
      </div>

      {/* 조건 체크 */}
      <div className="flex flex-wrap gap-1.5">
        <CheckPill ok={item.checks.deposit} label="보증금" />
        <CheckPill ok={item.checks.rent} label="월세" />
        <CheckPill ok={item.checks.floor} label="1층" />
        <CheckPill ok={item.checks.pyeong} label="4~10평" />
        {item.noPremium ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-lg bg-blue-bg px-2 text-[11.5px] font-bold text-blue">
            ✓ 무권리 표기
          </span>
        ) : (
          <span className="inline-flex h-6 items-center rounded-lg bg-surface-2 px-2 text-[11.5px] font-semibold text-faint">
            권리금 문의
          </span>
        )}
      </div>

      {/* 설명 */}
      {item.desc && <p className="clamp-2 text-[13px] leading-relaxed text-dim">{item.desc}</p>}

      {/* 푸터 */}
      <div className="mt-auto flex items-center gap-2 border-t border-line-soft pt-3.5">
        <span className="truncate text-[12px] font-medium text-faint">
          {item.realtor}
          {item.sameAddrCnt && item.sameAddrCnt > 1 && ` · 동일주소 ${item.sameAddrCnt}건`}
        </span>
        <a
          href={item.link}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto inline-flex h-9 shrink-0 items-center gap-1 rounded-xl bg-blue px-3.5 text-[12.5px] font-bold text-white transition-colors hover:bg-blue-deep"
        >
          {item.source === 'daangn' ? '당근에서 보기' : '네이버에서 보기'} ↗
        </a>
      </div>
    </article>
  )
}
