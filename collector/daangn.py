# -*- coding: utf-8 -*-
"""
당근 부동산(realty.daangn.com) 상가 매물 수집 모듈 — GraphQL 방식

수집 흐름 (브라우저 자동화 불필요, 순수 HTTP):
  1. 네이버에서 동적으로 조회한 광산구 전체 법정동 목록을 입력받고,
     지역 해석 API로 각 동 이름 -> region id를 얻는다.
     GET https://www.daangn.com/kr/api/v1/regions/keyword?keyword=<동>
     -> {"locations": [{"id": 1084, "name2": "광산구", "name3": "신가동", ...}]}
  2. GraphQL(APQ)로 해당 지역 클러스터의 매물을 커서 페이지네이션으로 수집한다.
     POST https://realty.kr.karrotmarket.com/graphql
     variables: {first, after, input:{clusterId:"REGION:<id>",
                 propertyFilter:{salesTypes:["STORE"]}}}
     extensions.persistedQuery.sha256Hash = <config의 articleHash>
     -> data.articleByClusterId.{edges[].node.article, pageInfo}

응답의 article은 originalId / trades(보증금·월세) / area(㎡) / floor / premiumMoney(권리금)
등 구조화된 필드를 제공하므로 네이버와 동일 스키마로 정규화한다.

주의: APQ 해시는 당근 프론트엔드 배포 시 바뀔 수 있다. 그 경우 GraphQL이
      PersistedQueryNotFound를 반환하며, config.json의 daangn.articleHash를
      갱신해야 한다(브라우저 개발자도구 Network에서 graphql 요청의 sha256Hash 확인).
"""
import json
import math
import os
import re
import time
from datetime import datetime, timezone

import requests

from rules import (
    PREMIUM_NONE,
    PREMIUM_PRESENT,
    PREMIUM_UNKNOWN,
    evaluate,
    explicit_no_premium_evidence,
    explicit_premium_amount_evidence,
    has_valid_no_premium_evidence,
    is_no_premium_amount,
    normalize_premium_amount,
    premium_status_from_amount,
)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
REGION_API = "https://www.daangn.com/kr/api/v1/regions/keyword"
GRAPHQL = "https://realty.kr.karrotmarket.com/graphql"
ARTICLE_URL = "https://realty.daangn.com/articles/{article_id}"
COMPLEX_URL = "https://realty.daangn.com/complexes/{complex_id}"
CACHE_PATH = os.path.join(os.path.dirname(__file__), ".cache", "daangn_locations.json")

# articleByClusterId persisted query 해시 (2026-07 기준). config로 덮어쓸 수 있음.
DEFAULT_ARTICLE_HASH = "e0cdf7eab9f342cf735fb8951d9dc0b771418964e241bd59ed4bec84d43e019a"

WRITER_LABEL = {"BROKER": "중개", "DIRECT_USER": "직거래"}
def _valid_coord(lat, lon):
    """대한민국 영역 안의 실제 좌표인지 확인한다."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (33.0 <= lat <= 39.5 and 124.0 <= lon <= 132.0):
        return None
    return str(lat), str(lon)


def _parse_relay_store(html):
    """공개 페이지의 window.RELAY_STORE JSON을 파싱한다.

    RELAY_STORE는 HTML 안의 JSON 문자열 리터럴이다. 정규식으로 중첩된
    이스케이프를 추측하지 않고 JSON decoder가 문자열의 끝을 찾게 한다.
    """
    marker = "window.RELAY_STORE ="
    start = html.find(marker)
    if start < 0:
        return None
    source = html[start + len(marker):].lstrip()
    try:
        encoded, _ = json.JSONDecoder().raw_decode(source)
        if not isinstance(encoded, str):
            return None
        store = json.loads(encoded)
        return store if isinstance(store, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _deref(store, value):
    if isinstance(value, dict) and value.get("__ref"):
        return store.get(value["__ref"])
    return value if isinstance(value, dict) else None


def _ref_list(store, value):
    if isinstance(value, dict) and isinstance(value.get("__refs"), list):
        return [store.get(ref) for ref in value["__refs"] if store.get(ref)]
    if isinstance(value, list):
        return [_deref(store, item) for item in value if _deref(store, item)]
    return []


def _complex_buildings(store, complex_obj):
    """해당 PropComplex의 buildings connection만 따라가 PropBuilding을 얻는다."""
    buildings = []
    seen = set()
    for field, value in complex_obj.items():
        if field != "buildings" and not field.startswith("buildings("):
            continue
        connection = _deref(store, value)
        if not connection:
            continue
        for edge in _ref_list(store, connection.get("edges")):
            building = _deref(store, edge.get("node")) if edge else None
            if not building or building.get("__typename") != "PropBuilding":
                continue
            building_id = str(building.get("id") or building.get("__id") or "")
            if building_id and building_id not in seen:
                seen.add(building_id)
                buildings.append(building)
    return buildings


def _find_typed(store, typename, original_id=None):
    for value in store.values():
        if not isinstance(value, dict) or value.get("__typename") != typename:
            continue
        if original_id is None or str(value.get("originalId")) == str(original_id):
            return value
    return None


def _explicit_no_premium_evidence(article):
    """상세 설명에서 명시적인 무권리 근거만 반환한다.

    premiumMoney가 None이라는 사실만으로는 절대 통과시키지 않는다. 설명 뒤에
    '아님/아니...'가 붙은 부정 표현도 보수적으로 제외한다.
    """
    for field in ("premiumMoneyDescription", "content"):
        text = article.get(field)
        matched_text = explicit_no_premium_evidence(text)
        if matched_text:
            start = max(0, text.find(matched_text) - 48)
            end = min(len(text), text.find(matched_text) + len(matched_text) + 48)
            return {
                "field": field,
                "matchedText": matched_text,
                "contextText": text[start:end],
            }
    return None


def _explicit_premium_amount_evidence(article):
    """상세 설명에 명시된 가장 큰 양수 권리금과 문맥을 반환한다."""
    found = []
    for field in ("premiumMoneyDescription", "content"):
        text = article.get(field)
        evidence = explicit_premium_amount_evidence(text)
        if evidence:
            start = max(0, text.find(evidence["matchedText"]) - 48)
            end = min(
                len(text),
                text.find(evidence["matchedText"]) + len(evidence["matchedText"]) + 48,
            )
            found.append(
                {
                    **evidence,
                    "field": field,
                    "contextText": text[start:end],
                }
            )
    return max(found, key=lambda evidence: evidence["amount"]) if found else None


def _extract_article_location(store, article_id):
    """공개 Article 상세의 권리금 근거와 연결 건물 정보를 추출."""
    article = _find_typed(store, "Article", article_id)
    if not article:
        return None
    base = {
        "articleVersion": article.get("updatedAt"),
        "premiumMoney": article.get("premiumMoney"),
        "premiumEvidence": _explicit_no_premium_evidence(article),
        "premiumAmountEvidence": _explicit_premium_amount_evidence(article),
    }
    complex_obj = _deref(store, article.get("complex"))
    if not complex_obj or complex_obj.get("__typename") != "PropComplex":
        return {**base, "status": "no-complex"}

    buildings = _complex_buildings(store, complex_obj)
    # 단일 건물인 경우에만 주소를 특정 건물 주소로 확정한다.
    building = buildings[0] if len(buildings) == 1 else None
    parking = article.get("availableTotalParkingSpots")
    return {
        **base,
        "status": "linked",
        "complexId": str(complex_obj.get("originalId") or ""),
        "complexRelayId": str(complex_obj.get("id") or complex_obj.get("__id") or ""),
        "complexName": complex_obj.get("name"),
        "buildingCount": len(buildings),
        "buildingId": str(building.get("id") or building.get("__id") or "") if building else None,
        "roadAddress": building.get("roadAddress") if building else None,
        "jibunAddress": building.get("jibunAddress") if building else None,
        "articleBuilding": {
            "floor": article.get("floor"),
            "topFloor": article.get("topFloor"),
            "approvalDate": article.get("buildingApprovalDate"),
            "usage": article.get("buildingUsage"),
            "parkingSpots": parking,
        },
    }


def _extract_complex_location(store, complex_id):
    """공개 단지 페이지에서 PropComplex 좌표와 연결 건물을 추출."""
    complex_obj = _find_typed(store, "PropComplex", complex_id)
    if not complex_obj:
        return None
    coord_obj = _deref(store, complex_obj.get("coordinate"))
    coord = _valid_coord(
        coord_obj.get("lat") if coord_obj else None,
        coord_obj.get("lon") if coord_obj else None,
    )
    buildings = _complex_buildings(store, complex_obj)
    return {
        "complexId": str(complex_obj.get("originalId") or ""),
        "lat": coord[0] if coord else None,
        "lon": coord[1] if coord else None,
        "buildings": [
            {
                "buildingId": str(b.get("id") or b.get("__id") or ""),
                "roadAddress": b.get("roadAddress"),
                "jibunAddress": b.get("jibunAddress"),
            }
            for b in buildings
        ],
    }


def _load_location_cache():
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
        # v4부터 명시된 양수 권리금도 상세 문맥에 결합한다. 이전 캐시는
        # 해당 금액 근거가 없어 충돌 판정에 재사용하지 않는다.
        if cache.get("version") == 4:
            cache.setdefault("articles", {})
            cache.setdefault("complexes", {})
            return cache
    except (OSError, ValueError, TypeError):
        pass
    return {"version": 4, "articles": {}, "complexes": {}}


def _save_location_cache(cache):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp_path = f"{CACHE_PATH}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1)
    os.replace(tmp_path, CACHE_PATH)


def _fetch_public_store(session, url, log):
    try:
        response = session.get(
            url,
            headers={"Accept": "text/html,application/xhtml+xml"},
            timeout=20,
        )
        if response.status_code != 200:
            log(f"  당근 공개 페이지 HTTP {response.status_code}: {url}")
            return None
        return _parse_relay_store(response.text)
    except requests.RequestException as exc:
        log(f"  당근 공개 페이지 요청 실패: {exc!r}")
        return None


def _same_text(a, b):
    return bool(a and b and " ".join(str(a).split()) == " ".join(str(b).split()))


def _distance_m(a_lat, a_lon, b_lat, b_lon):
    try:
        a_lat, a_lon, b_lat, b_lon = map(float, (a_lat, a_lon, b_lat, b_lon))
    except (TypeError, ValueError):
        return None
    radius = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * radius * math.asin(math.sqrt(h)))


def _apply_linked_location(item, article_location, complex_location):
    """연결 검증 결과를 매물에 적용. 좌표가 없으면 흐림 좌표를 유지한다."""
    item["roadAddress"] = article_location.get("roadAddress")
    item["jibunAddress"] = article_location.get("jibunAddress")

    complex_buildings = (complex_location or {}).get("buildings") or []
    matching_building = next(
        (
            b for b in complex_buildings
            if article_location.get("buildingId")
            and b.get("buildingId") == article_location.get("buildingId")
        ),
        None,
    )
    building_id_matched = matching_building is not None
    address_matched = bool(matching_building) and (
        _same_text(article_location.get("roadAddress"), matching_building.get("roadAddress"))
        or _same_text(article_location.get("jibunAddress"), matching_building.get("jibunAddress"))
    )
    exact_single_building = (
        article_location.get("buildingCount") == 1
        and len(complex_buildings) == 1
        and building_id_matched
        and address_matched
    )

    exact_coord = _valid_coord(
        (complex_location or {}).get("lat"),
        (complex_location or {}).get("lon"),
    )
    public_lat, public_lon = item.get("lat"), item.get("lon")
    if exact_coord:
        item["lat"], item["lon"] = exact_coord
        item["locationSource"] = "daangn_prop_complex"
        item["locationPrecision"] = "building" if exact_single_building else "complex"
        item["locationConfidence"] = "high" if exact_single_building else "medium"

    item["locationEvidence"] = {
        "articleId": item["id"].split(":", 1)[-1],
        "articleUrl": item["link"],
        "complexId": article_location.get("complexId"),
        "complexUrl": COMPLEX_URL.format(complex_id=article_location.get("complexId")),
        "buildingId": article_location.get("buildingId"),
        "articleToComplexLinked": True,
        "buildingIdMatched": building_id_matched,
        "addressMatched": address_matched,
        "buildingCount": article_location.get("buildingCount"),
        "publicCoordinateDistanceM": _distance_m(
            public_lat, public_lon, item.get("lat"), item.get("lon")
        ) if exact_coord else None,
        "articleBuilding": article_location.get("articleBuilding"),
    }


def _apply_detail_premium(item, article_detail):
    """상세 페이지 근거를 반영해 권리금 조건과 등급을 재계산한다.

    목록/상세 중 어느 한 구조화 데이터에라도 양수 금액이 있으면 설명의
    ``무권리`` 문구보다 우선한다. 금액이 모두 미기재인 경우에만 상세 설명의
    명시적인 무권리 문구를 예외 근거로 사용한다.
    """
    article_detail = article_detail or {}
    evidence = article_detail.get("premiumEvidence")
    amount_evidence = article_detail.get("premiumAmountEvidence")
    current_raw_amount = item.get("premiumMoney")
    detail_raw_amount = article_detail.get("premiumMoney")
    current_amount = normalize_premium_amount(current_raw_amount)
    detail_amount = normalize_premium_amount(detail_raw_amount)
    current_status = premium_status_from_amount(current_amount)
    detail_status = premium_status_from_amount(detail_amount)
    malformed_amount = any(
        raw is not None and normalize_premium_amount(raw) is None
        for raw in (current_raw_amount, detail_raw_amount)
    ) or item.get("_daangnPremiumMalformed") is True

    # 이전 단계에서 상세 설명 근거로 분류된 레코드도 하위 호환한다.
    if current_status == PREMIUM_UNKNOWN:
        declared_status = item.get("premiumStatus")
        if declared_status in (PREMIUM_PRESENT, PREMIUM_NONE, PREMIUM_UNKNOWN):
            current_status = declared_status
        elif item.get("noPremium"):
            current_status = PREMIUM_NONE

    was_no_premium = bool(item.get("noPremium"))

    positive_amounts = [
        amount for amount in (current_amount, detail_amount)
        if amount is not None and amount > 0
    ]
    text_amount = normalize_premium_amount(
        amount_evidence.get("amount") if isinstance(amount_evidence, dict) else None
    )
    if text_amount is not None and text_amount > 0:
        positive_amounts.append(text_amount)
    if positive_amounts:
        # 충돌 시 보수적으로 더 큰 양수 금액을 보존한다.
        amount = max(positive_amounts)
        status = PREMIUM_PRESENT
        if text_amount == amount:
            premium_evidence = {
                "source": "daangn_public_detail",
                "field": amount_evidence.get("field"),
                "matchedText": amount_evidence.get("matchedText"),
                "contextText": amount_evidence.get("contextText"),
                "value": amount,
                "articleUrl": item.get("link"),
            }
        else:
            premium_evidence = {
                "source": "daangn_structured_data",
                "field": "premiumMoney",
                "value": amount,
                "articleUrl": item.get("link"),
            }
    elif not malformed_amount and (
        premium_status_from_amount(current_amount) == PREMIUM_NONE
        or detail_status == PREMIUM_NONE
    ):
        amount = 0
        status = PREMIUM_NONE
        premium_evidence = {
            "source": "daangn_structured_data",
            "field": "premiumMoney",
            "value": 0,
            "articleUrl": item.get("link"),
        }
    elif current_status == PREMIUM_NONE and has_valid_no_premium_evidence(item):
        # 구버전/선행 상세 설명 근거를 구조화된 0원으로 둔갑시키지 않는다.
        amount = None
        status = PREMIUM_NONE
        premium_evidence = item.get("premiumEvidence")
    elif not malformed_amount and current_raw_amount is None and detail_raw_amount is None and evidence:
        amount = None
        status = PREMIUM_NONE
        premium_evidence = {
            "source": "daangn_public_detail",
            "field": evidence.get("field"),
            "matchedText": evidence.get("matchedText"),
            "contextText": evidence.get("contextText"),
            "articleUrl": item.get("link"),
        }
    else:
        amount = None
        status = PREMIUM_UNKNOWN
        premium_evidence = None

    item["premiumMoney"] = amount
    item["premiumStatus"] = status
    item["noPremium"] = status == PREMIUM_NONE
    checks = item.setdefault("checks", {})
    checks["premium"] = item["noPremium"]
    passed = sum(bool(checks.get(key)) for key in ("deposit", "rent", "floor", "premium"))
    item["matchLevel"] = "full" if passed == 4 else ("near" if passed == 3 else "low")
    if premium_evidence:
        item["premiumEvidence"] = premium_evidence
    else:
        item.pop("premiumEvidence", None)

    # 목록과 상세가 충돌한 경우 이전 자동 문구를 제거하고 확정 상태 하나만 표시한다.
    desc_parts = [
        part.strip()
        for part in str(item.get("desc") or "").split(" · ")
        if part.strip() and not re.search(r"무\s*권리|권리금", part, re.IGNORECASE)
    ]
    if status == PREMIUM_PRESENT:
        desc_parts.insert(0, f"권리금 {amount:,}만원")
    elif status == PREMIUM_NONE:
        desc_parts.insert(0, "무권리")
    item["desc"] = " · ".join(desc_parts)

    # 호출부의 카운터는 '무권리 조건을 새로 통과한 건수'를 의미한다.
    return item["noPremium"] and not was_no_premium


def _is_potential_premium_candidate(item):
    """상세 근거가 생기면 최소 near가 될 수 있는 미기재 매물인지 판별."""
    if not item.get("_daangnPremiumMissing"):
        return False
    checks = item.get("checks") or {}
    return sum(bool(checks.get(key)) for key in ("deposit", "rent", "floor")) >= 2


def _strip_internal_fields(listings):
    for item in listings:
        item.pop("_daangnUpdatedAt", None)
        item.pop("_daangnPremiumMissing", None)
        item.pop("_daangnPremiumMalformed", None)


def _enrich_locations(listings, session, dcfg, log):
    """검색 후보의 공개 상세 페이지를 제한적으로 조회해 위치를 보강한다."""
    if not dcfg.get("exactLocationEnabled", True):
        _strip_internal_fields(listings)
        return

    levels = set(dcfg.get("exactLocationLevels", ["full", "near"]))
    candidates = [
        item for item in listings
        if item.get("matchLevel") in levels or _is_potential_premium_candidate(item)
    ]
    candidates.sort(key=lambda item: (
        0 if item.get("matchLevel") == "full"
        else 1 if item.get("matchLevel") == "near"
        else 2
    ))

    max_article_fetches = int(dcfg.get("maxArticleDetailRequestsPerRun", 120))
    max_complex_fetches = int(dcfg.get("maxComplexDetailRequestsPerRun", 80))
    delay = max(0.0, float(dcfg.get("detailRequestDelaySeconds", 0.3)))
    cache = _load_location_cache()
    article_fetches = complex_fetches = cache_hits = 0
    enriched = 0
    premium_upgrades = 0

    try:
        for item in candidates:
            article_id = item["id"].split(":", 1)[-1]
            raw_version = item.pop("_daangnUpdatedAt", None)
            article_location = cache["articles"].get(article_id)
            cache_valid = article_location and (
                not raw_version or article_location.get("articleVersion") == raw_version
            )
            if cache_valid:
                cache_hits += 1
            elif article_fetches < max_article_fetches:
                store = _fetch_public_store(
                    session, ARTICLE_URL.format(article_id=article_id), log
                )
                article_fetches += 1
                time.sleep(delay)
                article_location = _extract_article_location(store, article_id) if store else None
                if article_location:
                    # 목록 응답의 updatedAt이 상세 페이지보다 최신 캐시 키다.
                    article_location["articleVersion"] = raw_version or article_location.get("articleVersion")
                    article_location["cachedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    cache["articles"][article_id] = article_location
            else:
                article_location = None

            if not article_location:
                continue
            if _apply_detail_premium(item, article_location):
                premium_upgrades += 1
            if article_location.get("status") != "linked":
                continue
            complex_id = article_location.get("complexId")
            complex_location = cache["complexes"].get(complex_id) if complex_id else None
            if complex_location:
                cache_hits += 1
            elif complex_id and complex_fetches < max_complex_fetches:
                store = _fetch_public_store(
                    session, COMPLEX_URL.format(complex_id=complex_id), log
                )
                complex_fetches += 1
                time.sleep(delay)
                complex_location = _extract_complex_location(store, complex_id) if store else None
                if complex_location:
                    complex_location["cachedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    cache["complexes"][complex_id] = complex_location

            _apply_linked_location(item, article_location, complex_location)
            if item.get("locationSource") == "daangn_prop_complex":
                enriched += 1
    finally:
        # low 매물 등 비대상 레코드에 붙인 내부 캐시 키도 출력에서 제거한다.
        _strip_internal_fields(listings)
        try:
            _save_location_cache(cache)
        except OSError as exc:
            # 캐시는 최적화일 뿐이다. 저장 실패가 매물 수집 전체를 막으면 안 된다.
            log(f"  당근 위치 캐시 저장 실패(수집 결과는 유지): {exc!r}")

    log(
        "당근 위치 보강: "
        f"연결 좌표 {enriched}/{len(candidates)}건, "
        f"상세 무권리 확인 {premium_upgrades}건, "
        f"상세 요청 {article_fetches}건, 단지 요청 {complex_fetches}건, 캐시 적중 {cache_hits}건"
    )


def _session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Content-Type": "application/json",
        "Referer": "https://realty.daangn.com/",
        "Origin": "https://realty.daangn.com",
        "x-realty-platform": "WEB",
    })
    return s


def resolve_region_id(session, gu, dong):
    """동 이름 -> region id. 같은 이름이 여러 시·군에 있으므로 gu(구)로 좁힌다."""
    r = session.get(REGION_API, params={"keyword": f"{gu} {dong}"}, timeout=15)
    r.raise_for_status()
    locs = r.json().get("locations", [])
    for loc in locs:
        if loc.get("name2") == gu and loc.get("name3") == dong:
            return loc["id"]
    # 폴백: 동 이름만으로 재시도
    r = session.get(REGION_API, params={"keyword": dong}, timeout=15)
    for loc in r.json().get("locations", []):
        if loc.get("name2") == gu and loc.get("name3") == dong:
            return loc["id"]
    return None


def _fetch_articles(session, region_id, article_hash, max_pages, log):
    """한 지역의 상가 매물 전량을 커서 페이지네이션으로 수집."""
    articles = []
    after = None
    for page_no in range(max_pages):
        payload = {
            "variables": {
                "first": 50,
                "after": after,
                "input": {
                    "clusterId": f"REGION:{region_id}",
                    "propertyFilter": {"salesTypes": ["STORE"]},
                },
            },
            "extensions": {"persistedQuery": {"version": 1, "sha256Hash": article_hash}},
        }
        resp = session.post(GRAPHQL, json=payload, timeout=20)
        if resp.status_code != 200:
            log(f"  당근 GraphQL HTTP {resp.status_code} (region {region_id}, page {page_no + 1})")
            break
        body = resp.json()
        if body.get("errors"):
            msg = body["errors"][0].get("message", "")
            if "PersistedQuery" in msg:
                log("  ⚠ 당근 APQ 해시 만료로 보임 — config.json의 daangn.articleHash 갱신 필요")
            else:
                log(f"  당근 GraphQL 오류: {msg[:120]}")
            break
        node = (body.get("data") or {}).get("articleByClusterId")
        if not node:
            break
        articles.extend(e["node"]["article"] for e in node.get("edges", []))
        pi = node.get("pageInfo", {})
        if not pi.get("hasNextPage"):
            break
        after = pi.get("endCursor")
        time.sleep(0.5)
    return articles


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _month_trade(article):
    for t in article.get("trades", []):
        if t.get("type") == "MONTH":
            return t
    return None


def _normalize(article, dong, criteria):
    trade = _month_trade(article)
    if not trade:
        return None  # 월세 매물만 대상

    deposit = trade.get("deposit")      # 만원
    rent = trade.get("monthlyPay")      # 만원

    area_m2 = _to_float(article.get("area"))
    pyeong = round(area_m2 * 0.3025, 1) if area_m2 else None

    floor_val = _to_float(article.get("floor"))
    floor = int(round(floor_val)) if floor_val is not None else None
    top = article.get("topFloor")
    total_floor = int(top) if str(top).isdigit() else None
    if article.get("isAmbiguousFloor"):
        floor_raw = article.get("ambiguousFloor") or "복수"
    elif floor is not None:
        floor_raw = f"{floor}/{total_floor}" if total_floor else str(floor)
    else:
        floor_raw = None

    premium = article.get("premiumMoney")   # 만원, None이면 미표기
    premium_amount = normalize_premium_amount(premium)
    premium_status = premium_status_from_amount(premium)
    no_premium = is_no_premium_amount(premium)

    writer = article.get("writerTypeV2")
    tags = []
    if writer in WRITER_LABEL:
        tags.append(WRITER_LABEL[writer])

    manage = article.get("totalManageCost")
    desc_parts = []
    if premium_status == PREMIUM_NONE:
        desc_parts.append("무권리")
    elif premium_status == PREMIUM_PRESENT:
        desc_parts.append(f"권리금 {premium_amount:,}만원")
    if manage:
        desc_parts.append(f"관리비 {manage}만원")
    if writer in WRITER_LABEL:
        desc_parts.append(WRITER_LABEL[writer])

    checks, match_level = evaluate(deposit, rent, floor, no_premium, criteria)

    coord = article.get("publicCoordinate") or {}
    biz = article.get("bizProfile") or {}
    published = article.get("publishedAt") or ""
    confirmed = published[:10].replace("-", "") if published else None
    original_id = str(article.get("originalId"))

    return {
        "id": f"daangn:{original_id}",
        "source": "daangn",
        "dong": dong,
        "name": article.get("buildingName") or "당근 상가",
        "typeName": "상가",
        "tradeTypeName": "월세",
        "deposit": deposit,
        "rent": rent,
        "floor": floor,
        "totalFloor": total_floor,
        "floorRaw": floor_raw,
        "areaM2": round(area_m2, 1) if area_m2 else None,
        "pyeong": pyeong,
        "desc": " · ".join(desc_parts),
        "tags": tags,
        "premiumMoney": premium_amount,
        "premiumStatus": premium_status,
        "premiumEvidence": (
            {
                "source": "daangn_structured_data",
                "field": "premiumMoney",
                "value": premium_amount,
                "articleUrl": f"https://realty.daangn.com/articles/{original_id}",
            }
            if premium_status != PREMIUM_UNKNOWN else None
        ),
        "noPremium": no_premium,
        "direction": None,
        "confirmedAt": confirmed,
        "realtor": biz.get("name"),
        "cpName": "당근부동산",
        "lat": str(coord.get("lat")) if coord.get("lat") else None,
        "lon": str(coord.get("lon")) if coord.get("lon") else None,
        "roadAddress": None,
        "jibunAddress": None,
        "locationSource": "daangn_public_coordinate",
        "locationPrecision": "approximate",
        "locationConfidence": "low",
        "locationEvidence": None,
        "sameAddrCnt": None,
        "link": f"https://realty.daangn.com/articles/{original_id}",
        "mobileLink": f"https://realty.daangn.com/articles/{original_id}",
        "checks": checks,
        "matchLevel": match_level,
        "_daangnUpdatedAt": article.get("updatedAt"),
        "_daangnPremiumMissing": premium is None,
        "_daangnPremiumMalformed": premium is not None and premium_amount is None,
    }


def collect_daangn(cfg, criteria, regions, log):
    """당근 상가 월세 매물 수집 (순수 HTTP). 정규화된 레코드 리스트를 반환."""
    dcfg = cfg.get("daangn", {})
    gu = cfg.get("regionSearchPrefix", "광산구")
    article_hash = dcfg.get("articleHash", DEFAULT_ARTICLE_HASH)
    max_pages = dcfg.get("maxPagesPerRegion", 30)

    session = _session()
    listings = []
    seen = set()

    for region in regions:
        dong = region.get("name") if isinstance(region, dict) else str(region)
        if not dong:
            continue
        try:
            region_id = resolve_region_id(session, gu, dong)
            if not region_id:
                log(f"당근 {dong}: region id 해석 실패 (건너뜀)")
                continue
            raws = _fetch_articles(session, region_id, article_hash, max_pages, log)
            count = 0
            for raw in raws:
                item = _normalize(raw, dong, criteria)
                if not item or item["id"] in seen:
                    continue
                seen.add(item["id"])
                listings.append(item)
                count += 1
            log(f"당근 {dong}: {count}건 (region {region_id})")
            time.sleep(0.6)
        except Exception as e:
            log(f"당근 {dong} 수집 실패: {e!r}")

    _enrich_locations(listings, session, dcfg, log)
    return listings
