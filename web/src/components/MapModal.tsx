import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Listing } from '../types'

// 로고와 같은 핀+렌즈 모양의 커스텀 마커
const PIN_SVG = `
<svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 3px 6px rgba(27,100,218,0.45))">
  <path d="M12 2.2c-4.1 0-7.4 3.2-7.4 7.2 0 4.9 5.7 10.3 7 11.4.2.2.6.2.8 0 1.3-1.1 7-6.5 7-11.4 0-4-3.3-7.2-7.4-7.2Z" fill="#3182f6"/>
  <circle cx="12" cy="9.3" r="3.4" fill="white"/>
  <circle cx="12" cy="9.3" r="1.5" fill="#3182f6"/>
</svg>`

const pinIcon = L.divIcon({
  html: PIN_SVG,
  className: '', // 기본 사각 배경 제거
  iconSize: [40, 40],
  iconAnchor: [20, 38],
})

function fmtMan(v: number | null): string {
  return v === null ? '—' : v.toLocaleString()
}

export function MapModal({
  item,
  onClose,
  isFav,
  onToggleFav,
}: {
  item: Listing | null
  onClose: () => void
  isFav: boolean
  onToggleFav: (item: Listing) => void
}) {
  const mapRef = useRef<HTMLDivElement>(null)

  // ESC 닫기 + 배경 스크롤 잠금
  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [item, onClose])

  // Leaflet 지도 생성/정리
  useEffect(() => {
    if (!item || !mapRef.current) return
    const lat = Number(item.lat)
    const lon = Number(item.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return

    const map = L.map(mapRef.current, {
      center: [lat, lon],
      zoom: 17,
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
    })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 20,
    }).addTo(map)
    L.marker([lat, lon], { icon: pinIcon }).addTo(map)

    return () => {
      map.remove()
    }
  }, [item])

  if (!item) return null

  const kakaoUrl = `https://map.kakao.com/link/map/${encodeURIComponent(
    `${item.dong} ${item.pyeong ?? ''}평 상가`.trim(),
  )},${item.lat},${item.lon}`

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ background: 'rgba(25, 31, 40, 0.45)', backdropFilter: 'blur(6px)' }}
    >
      <div className="modal-pop flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-surface shadow-toss-hover">
        {/* 헤더 */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <span className="inline-flex h-6 items-center rounded-lg bg-blue-bg px-2 text-[11.5px] font-bold text-blue">
            {item.dong}
          </span>
          <span className="text-[14px] font-bold text-ink">
            {fmtMan(item.deposit)} / {fmtMan(item.rent)}
            <span className="ml-1 text-[12px] font-medium text-faint">만원</span>
          </span>
          <span className="text-[12.5px] font-medium text-dim">
            {item.pyeong !== null ? `${item.pyeong}평` : ''} {item.floorRaw ? `· ${item.floorRaw}층` : ''}
          </span>
          <button
            onClick={() => onToggleFav(item)}
            aria-label="즐겨찾기"
            className={`ml-auto grid h-9 w-9 place-items-center rounded-full text-[18px] transition-all active:scale-90 ${
              isFav ? 'text-rose' : 'text-line hover:bg-surface-2 hover:text-faint'
            }`}
          >
            {isFav ? '♥' : '♡'}
          </button>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="grid h-9 w-9 place-items-center rounded-full text-[16px] font-bold text-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* 지도 */}
        <div ref={mapRef} className="h-[46vh] min-h-[280px] w-full" />

        {/* 푸터 액션 */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <span className="mr-auto text-[12px] font-medium text-faint">
            위치는 대략적일 수 있어요 · 정확한 주소는 중개사무소에 확인
          </span>
          <a
            href={kakaoUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-10 items-center gap-1 rounded-xl bg-[#FEE500] px-4 text-[13px] font-bold text-[#191f28] transition-transform hover:scale-[1.03]"
          >
            카카오맵 ↗
          </a>
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-10 items-center gap-1 rounded-xl bg-blue px-4 text-[13px] font-bold text-white transition-colors hover:bg-blue-deep"
          >
            {item.source === 'daangn' ? '당근 매물' : '네이버 매물'} ↗
          </a>
        </div>
      </div>
    </div>
  )
}
