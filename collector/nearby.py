# -*- coding: utf-8 -*-
"""매물 주변 학교·대학교·아파트 존재 여부를 검증한다.

OpenStreetMap의 학교와 아파트 단지 경계를 Overpass API로 내려받은 뒤 각
매물과의 거리를 로컬에서 계산한다. 개별 아파트 건물은 수집하지 않는다. 조회
실패, 좌표 누락, 신뢰할 수 없는 흐림 좌표는 통과시키지 않는 fail-closed 필터다.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import parse, request


SCHEMA_VERSION = 2
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENDPOINTS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
APARTMENT_NAME_RE = re.compile(r"(?:아파트|APT\.?|APARTMENT)", re.IGNORECASE)


def _as_coord(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    # 이 프로젝트의 대상은 국내 매물이므로 명백한 오류/해외 좌표를 거른다.
    if not (33.0 <= lat <= 39.5 and 124.0 <= lon <= 132.0):
        return None
    return lat, lon


def _listing_coord(item, allow_approximate):
    coord = _as_coord(item.get("lat"), item.get("lon"))
    if coord is None:
        return None, "missing_coordinate"
    if not allow_approximate and (
        item.get("locationPrecision") == "approximate"
        or item.get("locationConfidence") == "low"
    ):
        return None, "unreliable_coordinate"
    return coord, None


def _haversine_m(lat1, lon1, lat2, lon2):
    radius = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _point_in_polygon(lat, lon, points):
    """단일 닫힌 링 내부 여부. 복잡한 relation은 거리 계산으로 보완한다."""
    if len(points) < 4 or points[0] != points[-1]:
        return False
    inside = False
    j = len(points) - 1
    for i, (y_i, x_i) in enumerate(points):
        y_j, x_j = points[j]
        intersects = ((y_i > lat) != (y_j > lat)) and (
            lon < (x_j - x_i) * (lat - y_i) / ((y_j - y_i) or 1e-15) + x_i
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _segment_distance_m(lat, lon, a, b):
    """작은 생활권 거리에서 충분히 정확한 국소 평면 선분 거리."""
    cos_lat = max(0.01, math.cos(math.radians(lat)))
    ax = (a[1] - lon) * 111_320.0 * cos_lat
    ay = (a[0] - lat) * 110_540.0
    bx = (b[1] - lon) * 111_320.0 * cos_lat
    by = (b[0] - lat) * 110_540.0
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / denom))
    return math.hypot(ax + t * dx, ay + t * dy)


def _distance_to_poi_m(lat, lon, poi):
    distances = []
    for raw_ring in poi.get("geometry") or []:
        points = [tuple(point) for point in raw_ring]
        if len(points) >= 2:
            if _point_in_polygon(lat, lon, points):
                return 0.0
            distances.extend(
                _segment_distance_m(lat, lon, points[i - 1], points[i])
                for i in range(1, len(points))
            )
    if distances:
        return min(distances)
    return _haversine_m(lat, lon, poi["lat"], poi["lon"])


def _school_kind(tags):
    amenity = tags.get("amenity")
    if amenity in ("college", "university"):
        return "university"
    if amenity != "school":
        return None

    name = tags.get("name") or tags.get("name:ko") or ""
    if "초등학교" in name or "초교" in name:
        return "elementary_school"
    if "중학교" in name or "중교" in name:
        return "middle_school"
    if "고등학교" in name or "고교" in name:
        return "high_school"

    isced = str(tags.get("isced:level") or "")
    levels = {x for x in re.split(r"[^0-9]+", isced) if x}
    if levels == {"1"}:
        return "elementary_school"
    if levels == {"2"}:
        return "middle_school"
    if levels == {"3"}:
        return "high_school"
    return "school"


def _classify(tags):
    school_kind = _school_kind(tags)
    if school_kind:
        return school_kind
    name = tags.get("name") or tags.get("name:ko") or ""
    if tags.get("landuse") == "residential" and (
        tags.get("residential") == "apartments" or APARTMENT_NAME_RE.search(name)
    ):
        return "apartment_complex"
    if tags.get("place") in ("neighbourhood", "quarter") and APARTMENT_NAME_RE.search(name):
        return "apartment_complex"
    return None


def _geometry_rings(element):
    raw_rings = []
    if element.get("geometry"):
        raw_rings.append(element["geometry"])
    if element.get("type") == "relation":
        for member in element.get("members") or []:
            if member.get("geometry"):
                raw_rings.append(member["geometry"])
    rings = []
    for raw_points in raw_rings:
        points = []
        for point in raw_points:
            coord = _as_coord(point.get("lat"), point.get("lon"))
            if coord and (not points or points[-1] != coord):
                points.append(coord)
        if points:
            rings.append(points)
    return _stitch_geometry_rings(rings)


def _point_key(point):
    return round(float(point[0]), 7), round(float(point[1]), 7)


def _stitch_geometry_rings(raw_rings):
    """relation의 분할 way 조각을 끝점 기준으로 폐합 ring으로 조립한다.

    Overpass ``out geom``은 multipolygon relation을 하나의 ring이 아니라 여러
    member way로 반환할 수 있다. 서로 맞닿는 조각만 결합하므로 outer/inner가
    섞이지 않으며, 끝점이 맞지 않는 불완전 조각은 거리 계산용 선분으로 남긴다.
    """
    pending = [
        [tuple(point) for point in ring]
        for ring in raw_rings or []
        if len(ring) >= 2
    ]
    stitched = []
    while pending:
        ring = pending.pop(0)
        while pending:
            match_index = None
            merged = None
            for index, segment in enumerate(pending):
                if _point_key(ring[-1]) == _point_key(segment[0]):
                    merged = ring + segment[1:]
                elif _point_key(ring[-1]) == _point_key(segment[-1]):
                    merged = ring + list(reversed(segment))[1:]
                elif _point_key(ring[0]) == _point_key(segment[-1]):
                    merged = segment[:-1] + ring
                elif _point_key(ring[0]) == _point_key(segment[0]):
                    merged = list(reversed(segment))[:-1] + ring
                if merged is not None:
                    match_index = index
                    break
            if match_index is None:
                break
            ring = merged
            pending.pop(match_index)
        stitched.append(ring)
    return stitched


def _normalize_elements(elements):
    pois = []
    seen = set()
    for element in elements or []:
        tags = element.get("tags") or {}
        kind = _classify(tags)
        key = (element.get("type"), element.get("id"))
        if not kind or key in seen:
            continue
        seen.add(key)

        rings = _geometry_rings(element)
        points = [point for ring in rings for point in ring]
        center = _as_coord(element.get("lat"), element.get("lon"))
        if center is None:
            center_obj = element.get("center") or {}
            center = _as_coord(center_obj.get("lat"), center_obj.get("lon"))
        if center is None and points:
            center = (
                sum(point[0] for point in points) / len(points),
                sum(point[1] for point in points) / len(points),
            )
        if center is None:
            continue

        evidence_tags = {
            key: tags[key]
            for key in ("amenity", "residential", "landuse", "place", "isced:level")
            if key in tags
        }
        pois.append({
            "osmType": element.get("type"),
            "osmId": element.get("id"),
            "name": tags.get("name:ko") or tags.get("name") or (
                "아파트" if kind.startswith("apartment") else "학교"
            ),
            "kind": kind,
            "lat": round(center[0], 7),
            "lon": round(center[1], 7),
            "bbox": [
                round(min(point[0] for point in points), 7) if points else round(center[0], 7),
                round(min(point[1] for point in points), 7) if points else round(center[1], 7),
                round(max(point[0] for point in points), 7) if points else round(center[0], 7),
                round(max(point[1] for point in points), 7) if points else round(center[1], 7),
            ],
            "geometry": [
                [[round(lat, 7), round(lon, 7)] for lat, lon in ring]
                for ring in rings
            ],
            "tags": evidence_tags,
        })
    return pois


def _query_for_bbox(bbox):
    south, west, north, east = bbox
    box = f"({south:.7f},{west:.7f},{north:.7f},{east:.7f})"
    return (
        "[out:json][timeout:60][maxsize:536870912];\n"
        "(\n"
        f'  nwr["amenity"~"^(school|college|university)$"]{box};\n'
        f'  wr["landuse"="residential"]["residential"="apartments"]["name"]{box};\n'
        f'  nwr["landuse"="residential"]["name"~"아파트|APT|Apartment",i]{box};\n'
        f'  nwr["place"~"^(neighbourhood|quarter)$"]["name"~"아파트|APT|Apartment",i]{box};\n'
        ")->.boundary_features;\n"
        ".boundary_features out body geom;"
    )


def _expanded_bbox(coords, radius_m):
    south = min(lat for lat, _ in coords)
    north = max(lat for lat, _ in coords)
    west = min(lon for _, lon in coords)
    east = max(lon for _, lon in coords)
    lat_margin = radius_m / 110_540.0
    lon_margin = radius_m / (111_320.0 * max(0.01, math.cos(math.radians((south + north) / 2))))
    return south - lat_margin, west - lon_margin, north + lat_margin, east + lon_margin


def _split_bbox(bbox, max_span_degrees=0.04):
    """큰 Overpass 요청을 좌표 원점에 고정된 격자 bbox 목록으로 분할한다."""
    south, west, north, east = bbox
    span = max(0.01, min(0.1, float(max_span_degrees)))
    south_index = math.floor(south / span)
    west_index = math.floor(west / span)
    north_index = math.ceil(north / span)
    east_index = math.ceil(east / span)
    return [
        (
            row * span,
            column * span,
            (row + 1) * span,
            (column + 1) * span,
        )
        for row in range(south_index, north_index)
        for column in range(west_index, east_index)
    ]


def _merge_pois(*catalogs):
    merged = {}
    for catalog in catalogs:
        for poi in catalog or []:
            key = (poi.get("osmType"), poi.get("osmId"))
            if key[0] is not None and key[1] is not None:
                merged[key] = poi
    return list(merged.values())


def _cache_path(settings):
    path = Path(settings.get("cachePath", "collector/.cache/nearby_facilities.json"))
    return path if path.is_absolute() else ROOT / path


def _cache_covers(cache, bbox):
    coverage = cache.get("coverage") or {}
    try:
        return (
            float(coverage["south"]) <= bbox[0]
            and float(coverage["west"]) <= bbox[1]
            and float(coverage["north"]) >= bbox[2]
            and float(coverage["east"]) >= bbox[3]
        )
    except (KeyError, TypeError, ValueError):
        return False


def _read_cache(path):
    try:
        with path.open(encoding="utf-8") as handle:
            cache = json.load(handle)
        if cache.get("schemaVersion") != SCHEMA_VERSION or not isinstance(cache.get("pois"), list):
            return None
        return cache
    except (OSError, ValueError, TypeError):
        return None


def _is_fresh(cache, ttl_hours, now):
    try:
        fetched = datetime.fromisoformat(cache["fetchedAt"].replace("Z", "+00:00"))
        return (now - fetched).total_seconds() <= ttl_hours * 3600
    except (KeyError, TypeError, ValueError):
        return False


def _write_cache(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, path)


def _default_fetcher(endpoint, query, timeout):
    body = parse.urlencode({"data": query}).encode("utf-8")
    req = request.Request(
        endpoint,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "snapspot-studio-finder/1.0 (nearby facility filter)",
        },
    )
    with request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def _catalog_for_bbox(bbox, settings, log, fetcher, now):
    path = _cache_path(settings)
    cache = _read_cache(path)
    covered = bool(cache and _cache_covers(cache, bbox))
    ttl_hours = max(0, float(settings.get("cacheTtlHours", 168)))
    if covered and _is_fresh(cache, ttl_hours, now):
        return cache["pois"], "cache", cache["fetchedAt"]

    endpoints = settings.get("overpassEndpoints") or list(DEFAULT_ENDPOINTS)
    timeout = max(5, int(settings.get("requestTimeoutSeconds", 70)))
    retries = max(1, int(settings.get("requestsPerEndpoint", 1)))
    tile_span = settings.get("overpassTileSpanDegrees", 0.04)
    tiles = _split_bbox(bbox, tile_span)
    max_tiles = max(1, int(settings.get("overpassMaxTiles", 36)))
    if len(tiles) > max_tiles:
        raise ValueError(f"생활권 조회 범위가 너무 큽니다: {len(tiles)}개 타일")
    tile_delay = max(0.0, float(settings.get("overpassTileDelaySeconds", 0.25)))
    cache_fresh = bool(cache and _is_fresh(cache, ttl_hours, now))
    fetched_pois = []

    for tile_index, tile in enumerate(tiles, start=1):
        # 광산구 대부분을 덮는 최신 캐시가 있으면 새로 늘어난 가장자리만
        # 조회한다. GitHub의 빈 러너에서는 모든 작은 타일을 순서대로 조회한다.
        if cache_fresh and _cache_covers(cache, tile):
            continue

        query = _query_for_bbox(tile)
        tile_pois = None
        for endpoint in endpoints:
            for attempt in range(retries):
                try:
                    payload = fetcher(endpoint, query, timeout)
                    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
                        raise ValueError("Overpass 응답에 elements 배열이 없음")
                    # 개별 가장자리 타일에는 근거가 0개일 수 있으므로 정상 빈
                    # 응답도 허용하고, 전체 병합 카탈로그가 비었을 때만 실패한다.
                    tile_pois = _normalize_elements(payload["elements"])
                    break
                except Exception as exc:  # 실패 시 같은 타일을 다음 endpoint로 전환
                    log(
                        f"생활권 분할 조회 실패 {tile_index}/{len(tiles)} "
                        f"{endpoint} ({attempt + 1}/{retries}): {exc!r}"
                    )
                    if attempt + 1 < retries:
                        delay = (
                            float(settings.get("rateLimitRetryDelaySeconds", 30))
                            if getattr(exc, "code", None) == 429
                            else float(settings.get("retryDelaySeconds", 1.0))
                        )
                        time.sleep(max(0.0, delay))
            if tile_pois is not None:
                break

        if tile_pois is None:
            # 전체 범위를 덮는 과거 캐시만 안전한 fallback으로 인정한다.
            if covered:
                log("생활권 최신 조회 실패: 동일 범위의 기존 캐시를 사용")
                return cache["pois"], "stale_cache", cache["fetchedAt"]
            return None, "unavailable", None
        fetched_pois.extend(tile_pois)
        if tile_delay and tile_index < len(tiles):
            time.sleep(tile_delay)

    pois = _merge_pois(cache["pois"] if cache_fresh else [], fetched_pois)
    if not pois:
        if covered:
            log("생활권 최신 조회 실패: 동일 범위의 기존 캐시를 사용")
            return cache["pois"], "stale_cache", cache["fetchedAt"]
        return None, "unavailable", None

    fetched_at = now.isoformat(timespec="seconds").replace("+00:00", "Z")
    new_cache = {
        "schemaVersion": SCHEMA_VERSION,
        "fetchedAt": fetched_at,
        "coverage": {
            "south": min(tile[0] for tile in tiles),
            "west": min(tile[1] for tile in tiles),
            "north": max(tile[2] for tile in tiles),
            "east": max(tile[3] for tile in tiles),
        },
        "pois": pois,
    }
    try:
        _write_cache(path, new_cache)
    except OSError as exc:
        log(f"생활권 캐시 저장 실패(조회 결과는 사용): {exc!r}")
    return pois, "network", fetched_at

def _evidence(poi, distance_m):
    geometry = _stitch_geometry_rings(poi.get("geometry") or [])
    return {
        "kind": poi["kind"],
        "name": poi["name"],
        "distanceM": int(round(distance_m)),
        "source": "openstreetmap",
        "osmType": poi["osmType"],
        "osmId": poi["osmId"],
        "osmUrl": f"https://www.openstreetmap.org/{poi['osmType']}/{poi['osmId']}",
        "lat": poi["lat"],
        "lon": poi["lon"],
        # 카탈로그는 실행 중 불변이므로 큰 도형을 매물마다 깊은 복사하지 않는다.
        # JSON 직렬화 시에는 각 근거에 정확한 OSM 경계가 그대로 포함된다.
        "bbox": poi.get("bbox") or [poi["lat"], poi["lon"], poi["lat"], poi["lon"]],
        "geometry": [
            [[round(lat, 7), round(lon, 7)] for lat, lon in ring]
            for ring in geometry
        ],
        "tags": poi["tags"],
    }


def prefetch_nearby_facilities(settings, log=None, fetcher=None, now=None):
    """설정된 서비스 지역의 학교·아파트 단지를 매물 수집 전에 캐시한다."""
    log = log or (lambda _message: None)
    fetcher = fetcher or _default_fetcher
    now = now or datetime.now(timezone.utc)
    if not settings.get("enabled", True):
        return {"disabled": True, "dataStatus": "disabled", "facilityCount": 0}

    raw_bbox = settings.get("prefetchBbox")
    if not isinstance(raw_bbox, list) or len(raw_bbox) != 4:
        raise ValueError("nearbyFacilities.prefetchBbox는 [남,서,북,동]이어야 합니다")
    try:
        south, west, north, east = (float(value) for value in raw_bbox)
    except (TypeError, ValueError) as exc:
        raise ValueError("nearbyFacilities.prefetchBbox 좌표가 올바르지 않습니다") from exc
    if south >= north or west >= east:
        raise ValueError("nearbyFacilities.prefetchBbox 경계 순서가 올바르지 않습니다")

    radius_m = int(settings.get("nearbyRadiusM", settings.get("radiusM", 800)))
    if not 500 <= radius_m <= 800:
        raise ValueError("nearbyRadiusM는 500~800m 범위여야 합니다")
    query_bbox = _expanded_bbox([(south, west), (north, east)], radius_m)
    pois, data_status, checked_at = _catalog_for_bbox(
        query_bbox, settings, log, fetcher, now
    )
    return {
        "dataStatus": data_status,
        "facilityCount": len(pois or []),
        "checkedAt": checked_at,
        "coverageBbox": [round(value, 7) for value in query_bbox],
    }


def filter_by_nearby_facilities(listings, settings, log=None, fetcher=None, now=None):
    """반경 안에 학교/대학교/아파트 근거가 있는 매물만 반환한다.

    반환값은 ``(filtered_listings, stats)``다. 원본 항목을 변경하지 않으며 통과한
    항목에는 ``nearbyFacilities``와 ``nearbyFacilityCheck``를 추가한다.
    ``nearbyRadiusM``는 사용자 요구 범위인 500~800m만 허용한다.
    """
    log = log or (lambda _message: None)
    fetcher = fetcher or _default_fetcher
    now = now or datetime.now(timezone.utc)
    items = list(listings)

    if not settings.get("enabled", True):
        return items, {"input": len(items), "kept": len(items), "disabled": True}

    radius_m = int(settings.get("nearbyRadiusM", settings.get("radiusM", 800)))
    if not 500 <= radius_m <= 800:
        raise ValueError("nearbyRadiusM는 500~800m 범위여야 합니다")
    allow_approximate = bool(settings.get("allowApproximateCoordinates", False))
    max_evidence = max(1, int(settings.get("maxEvidencePerListing", 8)))

    usable = []
    excluded_missing = 0
    excluded_unreliable = 0
    for item in items:
        coord, reason = _listing_coord(item, allow_approximate)
        if coord:
            usable.append((item, coord))
        elif reason == "unreliable_coordinate":
            excluded_unreliable += 1
        else:
            excluded_missing += 1

    base_stats = {
        "input": len(items),
        "kept": 0,
        "excludedMissingCoordinate": excluded_missing,
        "excludedUnreliableCoordinate": excluded_unreliable,
        "excludedNoFacility": 0,
        "excludedUnavailable": 0,
        "radiusM": radius_m,
        "source": "openstreetmap_overpass",
    }
    if not usable:
        return [], base_stats

    bbox = _expanded_bbox([coord for _, coord in usable], radius_m)
    pois, data_status, checked_at = _catalog_for_bbox(bbox, settings, log, fetcher, now)
    base_stats["dataStatus"] = data_status
    if pois is None:
        base_stats["excludedUnavailable"] = len(usable)
        return [], base_stats

    kept = []
    for original, (lat, lon) in usable:
        matches = []
        for poi in pois:
            # POI 중심이 아니라 도형 경계를 기준으로 사각형 전처리한다. 넓은
            # 학교 캠퍼스/아파트 단지의 중심이 반경 밖이어도 경계가 가까우면 남는다.
            poi_bbox = poi.get("bbox") or [poi["lat"], poi["lon"], poi["lat"], poi["lon"]]
            lat_margin = radius_m / 100_000.0
            lon_margin = radius_m / 80_000.0
            if lat < float(poi_bbox[0]) - lat_margin or lat > float(poi_bbox[2]) + lat_margin:
                continue
            if lon < float(poi_bbox[1]) - lon_margin or lon > float(poi_bbox[3]) + lon_margin:
                continue
            distance = _distance_to_poi_m(lat, lon, poi)
            if distance <= radius_m:
                matches.append(_evidence(poi, distance))
        matches.sort(key=lambda evidence: evidence["distanceM"])
        if not matches:
            base_stats["excludedNoFacility"] += 1
            continue
        item = dict(original)
        item["nearbyFacilities"] = matches[:max_evidence]
        item["nearbyFacilityCheck"] = {
            "withinRadius": True,
            "radiusM": radius_m,
            "source": "openstreetmap_overpass",
            "dataStatus": data_status,
            "checkedAt": checked_at,
        }
        kept.append(item)

    base_stats["kept"] = len(kept)
    return kept, base_stats
