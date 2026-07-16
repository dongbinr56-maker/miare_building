# -*- coding: utf-8 -*-
"""
중복 매물 병합.

같은 매물이 (1) 네이버·당근 양쪽에 올라오거나 (2) 같은 출처에 여러 번
등록되는 경우가 많다. 하지만 "보증금·월세·평·층"이 같아도 좌표가 다르면
서로 다른 매물이므로, 가격/평/층이 일치하면서 좌표까지 근접(기본 90m)한
매물만 하나로 병합한다.

병합 결과 대표 레코드에는:
  - dupCount: 병합된 원본 개수
  - sources: 병합에 참여한 출처 목록 (["naver","daangn"] 등)
  - altLinks: 대표 링크 외 나머지 출처 링크 [{source, link}]
가 추가된다.
"""
import math


def _haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _coord(item):
    """유효 좌표 (lat, lon) 또는 None. 0,0 숨김 좌표는 무효."""
    try:
        lat = float(item.get("lat"))
        lon = float(item.get("lon"))
    except (TypeError, ValueError):
        return None
    if abs(lat) < 0.001 or abs(lon) < 0.001:
        return None
    return (lat, lon)


def _rep_score(item):
    """대표 선택 점수(높을수록 우선). 무권리 확실 > 좌표 있음 > 설명 김 > 네이버."""
    s = 0
    if item.get("noPremium"):
        s += 4
    if _coord(item):
        s += 2
    if item.get("desc"):
        s += 1
    if item.get("source") == "naver":
        s += 1  # 검증(중개) 비율이 높은 편이라 소폭 우선
    return s


def merge_duplicates(listings, radius_m=90):
    """중복 병합된 새 리스트를 반환."""
    # 1) 가격·평·층 버킷으로 후보 축소
    buckets = {}
    for item in listings:
        pyeong = item.get("pyeong")
        key = (
            item.get("deposit"),
            item.get("rent"),
            round(pyeong) if pyeong is not None else None,
            item.get("floor"),
        )
        buckets.setdefault(key, []).append(item)

    merged = []
    for key, group in buckets.items():
        if len(group) == 1:
            merged.append(_finalize(group[0], [group[0]]))
            continue

        # 2) 버킷 안에서 좌표 근접 클러스터링(union-find 간이 버전)
        clusters = []  # 각 원소: list of items
        for item in group:
            c = _coord(item)
            placed = False
            for cluster in clusters:
                for other in cluster:
                    oc = _coord(other)
                    # 둘 다 좌표 있고 근접 -> 같은 매물
                    if c and oc and _haversine_m(*c, *oc) <= radius_m:
                        cluster.append(item)
                        placed = True
                        break
                    # 좌표 하나라도 없으면: 동일 출처+동일 동이면 동일로 간주(재등록)
                    if (not c or not oc) and item.get("source") == other.get("source") \
                            and item.get("dong") == other.get("dong"):
                        cluster.append(item)
                        placed = True
                        break
                if placed:
                    break
            if not placed:
                clusters.append([item])

        for cluster in clusters:
            rep = max(cluster, key=_rep_score)
            merged.append(_finalize(rep, cluster))

    return merged


def _finalize(rep, cluster):
    """대표 레코드에 병합 메타 부여."""
    rep = dict(rep)
    # 출처별 대표 링크 1개씩 수집(중복 링크 제거)
    seen_links = set()
    alt = []
    sources = []
    for it in cluster:
        src = it.get("source")
        if src not in sources:
            sources.append(src)
        link = it.get("link")
        if link and link != rep.get("link") and link not in seen_links:
            seen_links.add(link)
            alt.append({"source": src, "link": link})
    # 무권리는 클러스터 중 하나라도 표기되면 True(정보 보강)
    rep["noPremium"] = any(it.get("noPremium") for it in cluster)
    rep["dupCount"] = len(cluster)
    rep["sources"] = sources
    rep["altLinks"] = alt[:6]
    return rep
