import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Listing, NearbyFacilityEvidence } from '../types'
import {
  buildFacilityOverlays,
  listingRadiusCircle,
  NEARBY_MAP_RADIUS_M,
} from '../mapUtils'

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

type FacilityCategory = 'school' | 'university' | 'apartment'

const FACILITY_STYLE: Record<FacilityCategory, { color: string; fill: string; label: string }> = {
  school: { color: '#16a34a', fill: '#22c55e', label: '학교' },
  university: { color: '#7c3aed', fill: '#8b5cf6', label: '대학교' },
  apartment: { color: '#d97706', fill: '#f59e0b', label: '아파트 단지' },
}

function facilityCategory(kind: NearbyFacilityEvidence['kind']): FacilityCategory {
  if (kind === 'university') return 'university'
  if (kind === 'apartment' || kind === 'apartment_complex') return 'apartment'
  return 'school'
}

function facilityPopup(facility: NearbyFacilityEvidence): HTMLElement {
  const category = facilityCategory(facility.kind)
  const style = FACILITY_STYLE[category]
  const wrapper = document.createElement('div')
  wrapper.style.minWidth = '150px'

  const title = document.createElement('strong')
  title.textContent = facility.name
  title.style.display = 'block'
  title.style.marginBottom = '4px'
  title.style.color = '#191f28'
  wrapper.appendChild(title)

  const detail = document.createElement('span')
  detail.textContent = `${style.label} · 매물에서 ${facility.distanceM.toLocaleString()}m`
  detail.style.display = 'block'
  detail.style.color = '#6b7684'
  detail.style.fontSize = '12px'
  wrapper.appendChild(detail)

  const link = document.createElement('a')
  link.href = `https://www.openstreetmap.org/${facility.osmType}/${facility.osmId}`
  link.target = '_blank'
  link.rel = 'noreferrer noopener'
  link.textContent = 'OpenStreetMap에서 보기 ↗'
  link.style.display = 'inline-block'
  link.style.marginTop = '7px'
  link.style.color = '#3182f6'
  link.style.fontSize = '12px'
  link.style.fontWeight = '700'
  wrapper.appendChild(link)
  return wrapper
}

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
    const listingCircle = listingRadiusCircle(item.lat, item.lon)
    if (!listingCircle) return
    const [lat, lon] = listingCircle.center

    const map = L.map(mapRef.current, {
      center: [lat, lon],
      zoom: 15,
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
    })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 20,
    }).addTo(map)

    // 매물을 중심으로 생활권 기준 반경 800m를 항상 표시한다.
    const radiusCircle = L.circle([lat, lon], {
      radius: listingCircle.radiusM,
      color: '#3182f6',
      fillColor: '#3182f6',
      fillOpacity: 0.045,
      opacity: 0.8,
      weight: 2,
      dashArray: '7 6',
      interactive: false,
    }).addTo(map)

    const facilityLayer = L.layerGroup().addTo(map)
    for (const facility of item.nearbyFacilities ?? []) {
      const [overlay] = buildFacilityOverlays([facility])
      if (!overlay) continue
      const category = facilityCategory(facility.kind)
      const style = FACILITY_STYLE[category]

      if (overlay.type === 'polygon') {
        const rings: L.LatLngTuple[][] = overlay.rings.map((ring) => (
          ring.map(([ringLat, ringLon]) => [ringLat, ringLon])
        ))
        // 한 시설의 outer/inner ring을 한 번에 전달해야 inner ring의 hole이 보존된다.
        L.polygon(rings, {
          color: style.color,
          fillColor: style.fill,
          fillOpacity: 0.2,
          opacity: 0.9,
          weight: 2,
        })
          .bindPopup(() => facilityPopup(facility), { maxWidth: 260 })
          .addTo(facilityLayer)
        continue
      }

      L.circleMarker([overlay.position[0], overlay.position[1]], {
        radius: 7,
        color: style.color,
        fillColor: style.fill,
        fillOpacity: 0.8,
        opacity: 1,
        weight: 2,
      })
        .bindPopup(() => facilityPopup(facility), { maxWidth: 260 })
        .addTo(facilityLayer)
    }

    const tooltip = document.createElement('span')
    tooltip.textContent = item.roadAddress || item.jibunAddress || `${item.dong} 매물 위치`
    L.marker([lat, lon], { icon: pinIcon, zIndexOffset: 1000 }).bindTooltip(tooltip).addTo(map)
    map.fitBounds(radiusCircle.getBounds(), { padding: [24, 24], maxZoom: 16 })

    return () => {
      map.remove()
    }
  }, [item])

  if (!item) return null

  const mapLabel = item.roadAddress || item.jibunAddress || `${item.dong} ${item.pyeong ?? ''}평 상가`.trim()
  const kakaoUrl = `https://map.kakao.com/link/map/${encodeURIComponent(
    mapLabel,
  )},${item.lat},${item.lon}`
  const locationText = item.locationPrecision === 'building'
    ? `${item.roadAddress || item.jibunAddress} · 공개 구조화 데이터의 연결 건물 위치`
    : item.locationPrecision === 'complex'
      ? `${item.roadAddress || item.jibunAddress || item.dong} · 연결 단지 중심 위치`
      : '위치는 대략적일 수 있어요 · 정확한 주소는 중개사무소에 확인'
  const facilityCount = buildFacilityOverlays(item.nearbyFacilities).length

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

        {/* 지도 + 범례 */}
        <div className="relative">
          <div
            ref={mapRef}
            role="img"
            aria-label={`매물 중심 ${NEARBY_MAP_RADIUS_M}m 반경과 주변 시설 ${facilityCount}곳 지도`}
            className="h-[46vh] min-h-[280px] w-full"
          />
          <div className="pointer-events-none absolute right-2 bottom-2 z-[500] rounded-xl bg-white/94 px-3 py-2 text-[10.5px] font-semibold text-dim shadow-toss backdrop-blur-sm">
            <div className="mb-1.5 font-bold text-ink">지도 범례 · 시설 {facilityCount}곳</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-full border-2 border-blue bg-blue/15" />
                800m 반경
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-sm border-2 border-[#16a34a] bg-[#22c55e]/25" />
                학교
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-sm border-2 border-[#7c3aed] bg-[#8b5cf6]/25" />
                대학교
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-sm border-2 border-[#d97706] bg-[#f59e0b]/25" />
                아파트
              </span>
            </div>
          </div>
        </div>

        {/* 푸터 액션 */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <span className="mr-auto text-[12px] font-medium text-faint">
            {locationText}
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
