import type { Listing, Source } from '../types'

function fmtMan(v: number | null): string {
  if (v === null) return '—'
  return v.toLocaleString()
}

function fmtConfirmed(ymd: string | null): string {
  if (!ymd || ymd.length !== 8) return ''
  return `${ymd.slice(4, 6)}.${ymd.slice(6, 8)} 확인`
}

function hasCoord(item: Listing): boolean {
  const lat = Number(item.lat)
  const lon = Number(item.lon)
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.001 && Math.abs(lon) > 0.001
}

function kakaoMapUrl(item: Listing): string {
  const name = `${item.dong} ${item.pyeong ?? ''}평 상가`.trim()
  return `https://map.kakao.com/link/map/${encodeURIComponent(name)},${item.lat},${item.lon}`
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

const SOURCE_BADGE: Record<Source, { cls: string; label: string }> = {
  naver: { cls: 'bg-[#03c75a]/12 text-[#03a94d]', label: 'N 네이버' },
  daangn: { cls: 'bg-[#ff7e36]/12 text-[#f96f1e]', label: '당근' },
}

const SOURCE_SHORT: Record<Source, string> = { naver: '네이버', daangn: '당근' }

export function ListingCard({
  item,
  i,
  isFav,
  onToggleFav,
}: {
  item: Listing
  i: number
  isFav: boolean
  onToggleFav: (item: Listing) => void
}) {
  const badge = LEVEL_BADGE[item.matchLevel]
  const cardCls =
    item.matchLevel === 'full' ? 'card-full' : item.matchLevel === 'near' ? 'card-near' : 'shadow-toss'
  const dup = (item.dupCount ?? 1) > 1
  const showMap = hasCoord(item)

  return (
    <article
      className={`rise group flex flex-col gap-3 rounded-3xl bg-surface p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-toss-hover ${cardCls}`}
      style={{ '--i': i } as React.CSSProperties}
    >
      {/* 상단: 뱃지 라인 + 하트 */}
      <div className="flex items-center gap-1.5">
        <span className={`inline-flex h-6 items-center rounded-lg px-2 text-[11.5px] font-bold ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="inline-flex h-6 items-center rounded-lg bg-surface-2 px-2 text-[11.5px] font-bold text-dim">
          {item.dong}
        </span>
        {!dup && (
          <span
            className={`inline-flex h-6 items-center rounded-lg px-2 text-[11px] font-bold ${SOURCE_BADGE[item.source]?.cls ?? 'bg-surface-2 text-dim'}`}
          >
            {SOURCE_BADGE[item.source]?.label ?? item.source}
          </span>
        )}
        {item.isNew && (
          <span className="inline-flex h-6 items-center rounded-lg bg-green-bg px-2 text-[11.5px] font-bold text-green">
            NEW
          </span>
        )}
        <button
          onClick={() => onToggleFav(item)}
          aria-label={isFav ? '즐겨찾기 해제' : '즐겨찾기'}
          className={`ml-auto grid h-8 w-8 place-items-center rounded-full text-[18px] transition-all active:scale-90 ${
            isFav ? 'text-rose' : 'text-line hover:bg-surface-2 hover:text-faint'
          }`}
        >
          {isFav ? '♥' : '♡'}
        </button>
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

      {/* 중복 표기 */}
      {dup && (
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-faint">
          <span className="inline-flex h-5 items-center rounded-md bg-surface-2 px-1.5 text-[11px] font-bold text-dim">
            중복 {item.dupCount}
          </span>
          같은 매물이 {(item.sources ?? [item.source]).map((s) => SOURCE_SHORT[s]).join('·')}에 등록됨
        </div>
      )}

      {/* 푸터 */}
      <div className="mt-auto flex items-center gap-2 border-t border-line-soft pt-3.5">
        <span className="truncate text-[12px] font-medium text-faint">
          {item.realtor}
          {item.confirmedAt && <span className="tnum"> · {fmtConfirmed(item.confirmedAt)}</span>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {showMap && (
            <a
              href={kakaoMapUrl(item)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-9 items-center gap-1 rounded-xl bg-surface-2 px-3 text-[12.5px] font-bold text-dim transition-colors hover:text-blue"
            >
              📍 지도
            </a>
          )}
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center gap-1 rounded-xl bg-blue px-3.5 text-[12.5px] font-bold text-white transition-colors hover:bg-blue-deep"
          >
            {item.source === 'daangn' ? '당근' : '네이버'} ↗
          </a>
        </div>
      </div>

      {/* 교차중복: 다른 출처 링크 */}
      {item.altLinks && item.altLinks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.altLinks.map((a) => (
            <a
              key={a.link}
              href={a.link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-7 items-center rounded-lg bg-surface-2 px-2.5 text-[11.5px] font-semibold text-dim transition-colors hover:text-blue"
            >
              {SOURCE_SHORT[a.source]}에서도 보기 ↗
            </a>
          ))}
        </div>
      )}
    </article>
  )
}
