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
  - mergedListingIds: 병합된 모든 원본 매물 ID
가 추가된다.
"""
import math
import re

from rules import (
    PREMIUM_NONE,
    PREMIUM_PRESENT,
    PREMIUM_UNKNOWN,
    has_valid_no_premium_evidence,
    normalize_premium_amount,
    premium_status_from_amount,
)


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
    """대표 선택 점수(높을수록 우선). 권리금 충돌은 보수적 근거를 우선."""
    s = 0
    status = _premium_status(item)
    if status == PREMIUM_PRESENT:
        s += 8
    elif status == PREMIUM_NONE:
        s += 4
    if _coord(item):
        s += 2
    if item.get("desc"):
        s += 1
    if item.get("source") == "naver":
        s += 1  # 검증(중개) 비율이 높은 편이라 소폭 우선
    return s


def _premium_status(item):
    """신·구 레코드를 보수적으로 해석한 권리금 상태."""
    amount_status = premium_status_from_amount(item.get("premiumMoney"))
    if amount_status != PREMIUM_UNKNOWN:
        return amount_status
    declared = item.get("premiumStatus")
    if declared == PREMIUM_NONE and has_valid_no_premium_evidence(item):
        return PREMIUM_NONE
    # 양수 구조화 금액 없는 declared present와 구버전 False는 확인 불가다.
    return PREMIUM_UNKNOWN


def _resolve_premium(cluster):
    """권리금 있음 > 무권리 근거 > 확인 불가 우선순위로 병합한다."""
    present = [item for item in cluster if _premium_status(item) == PREMIUM_PRESENT]
    if present:
        chosen = max(
            present,
            key=lambda item: normalize_premium_amount(item.get("premiumMoney")) or 0,
        )
        amount = normalize_premium_amount(chosen.get("premiumMoney"))
        evidence = chosen.get("premiumEvidence") or {
            "source": f"{chosen.get('source') or 'listing'}_structured_data",
            "field": "premiumMoney",
            "value": amount,
            "articleUrl": chosen.get("link"),
        }
        return PREMIUM_PRESENT, amount, evidence

    none = [
        item for item in cluster
        if _premium_status(item) == PREMIUM_NONE and has_valid_no_premium_evidence(item)
    ]
    if none:
        # 구조화된 0원 근거가 설명 근거보다 강하므로 대표 근거로 우선한다.
        chosen = next(
            (
                item for item in none
                if premium_status_from_amount(item.get("premiumMoney")) == PREMIUM_NONE
            ),
            none[0],
        )
        amount = (
            0
            if premium_status_from_amount(chosen.get("premiumMoney")) == PREMIUM_NONE
            else None
        )
        return PREMIUM_NONE, amount, chosen.get("premiumEvidence")

    return PREMIUM_UNKNOWN, None, None


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
    # 양수 권리금이 한 출처에라도 있으면 설명상의 무권리보다 우선한다.
    premium_status, premium_money, premium_evidence = _resolve_premium(cluster)
    rep["premiumStatus"] = premium_status
    rep["premiumMoney"] = premium_money
    rep["noPremium"] = premium_status == PREMIUM_NONE
    if premium_evidence:
        rep["premiumEvidence"] = premium_evidence
    else:
        rep.pop("premiumEvidence", None)
    # 구버전 스냅샷에 premium 키가 없어도 4개 현재 기준으로 항상 재계산한다.
    checks = dict(rep.get("checks") or {})
    checks["premium"] = rep["noPremium"]
    passed = sum(
        bool(checks.get(key)) for key in ("deposit", "rent", "floor", "premium")
    )
    rep["matchLevel"] = "full" if passed == 4 else ("near" if passed == 3 else "low")
    rep["checks"] = checks
    rep["dupCount"] = len(cluster)
    rep["sources"] = sources
    rep["altLinks"] = alt[:6]
    # 개인 차단 목록은 대표 ID만이 아니라 병합된 모든 원본 ID를
    # 기준으로 한다. 이전에 병합된 레코드가 입력으로 오는 경우도 재병합 시
    # ID가 유실되지 않도록 mergedListingIds를 함께 펼쳐서 저장한다.
    merged_ids = []
    seen_ids = set()
    for it in cluster:
        candidates = [it.get("id")]
        previous_ids = it.get("mergedListingIds")
        if isinstance(previous_ids, (list, tuple, set)):
            candidates.extend(previous_ids)
        for candidate in candidates:
            if not isinstance(candidate, str):
                continue
            candidate = candidate.strip()
            if not candidate or candidate in seen_ids:
                continue
            if not (candidate.startswith("naver:") or candidate.startswith("daangn:")):
                continue
            source, original_id = candidate.split(":", 1)
            if source not in ("naver", "daangn") or not original_id.isdigit():
                continue
            seen_ids.add(candidate)
            merged_ids.append(candidate)
    rep["mergedListingIds"] = merged_ids
    # 대표 출처의 자동 문구가 병합된 권리금 상태와 충돌하지 않게 확정 상태
    # 하나만 표시한다. 실제 원문 근거는 premiumEvidence.contextText에 남는다.
    desc_parts = [
        part.strip()
        for part in str(rep.get("desc") or "").split(" · ")
        if part.strip() and not re.search(r"무\s*권리|권리금", part, re.IGNORECASE)
    ]
    if premium_status == PREMIUM_PRESENT:
        label = (
            f"권리금 {premium_money:,}만원"
            if premium_money is not None else "권리금 있음"
        )
        desc_parts.insert(0, label)
    elif premium_status == PREMIUM_NONE:
        desc_parts.insert(0, "무권리")
    rep["desc"] = " · ".join(desc_parts)
    return rep
