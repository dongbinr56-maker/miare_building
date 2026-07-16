# -*- coding: utf-8 -*-
"""
당근 부동산(realty.daangn.com) 상가 매물 수집 모듈 — GraphQL 방식

수집 흐름 (브라우저 자동화 불필요, 순수 HTTP):
  1. 지역 해석 API로 동 이름 -> region id를 얻는다.
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
import time

import requests

from rules import evaluate

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
REGION_API = "https://www.daangn.com/kr/api/v1/regions/keyword"
GRAPHQL = "https://realty.kr.karrotmarket.com/graphql"

# articleByClusterId persisted query 해시 (2026-07 기준). config로 덮어쓸 수 있음.
DEFAULT_ARTICLE_HASH = "e0cdf7eab9f342cf735fb8951d9dc0b771418964e241bd59ed4bec84d43e019a"

WRITER_LABEL = {"BROKER": "중개", "DIRECT_USER": "직거래"}


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
    no_premium = premium is None or premium <= 10  # 1만원 = 무권리 관행 표기

    writer = article.get("writerTypeV2")
    tags = []
    if writer in WRITER_LABEL:
        tags.append(WRITER_LABEL[writer])

    manage = article.get("totalManageCost")
    desc_parts = []
    if premium is not None:
        desc_parts.append("무권리" if no_premium else f"권리금 {premium:,}만원")
    if manage:
        desc_parts.append(f"관리비 {manage}만원")
    if writer in WRITER_LABEL:
        desc_parts.append(WRITER_LABEL[writer])

    checks, match_level = evaluate(deposit, rent, floor, pyeong, criteria)

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
        "noPremium": no_premium,
        "direction": None,
        "confirmedAt": confirmed,
        "realtor": biz.get("name"),
        "cpName": "당근부동산",
        "lat": str(coord.get("lat")) if coord.get("lat") else None,
        "lon": str(coord.get("lon")) if coord.get("lon") else None,
        "sameAddrCnt": None,
        "link": f"https://realty.daangn.com/articles/{original_id}",
        "mobileLink": f"https://realty.daangn.com/articles/{original_id}",
        "checks": checks,
        "matchLevel": match_level,
    }


def collect_daangn(cfg, criteria, log):
    """당근 상가 월세 매물 수집 (순수 HTTP). 정규화된 레코드 리스트를 반환."""
    dcfg = cfg.get("daangn", {})
    gu = cfg.get("regionSearchPrefix", "광산구")
    article_hash = dcfg.get("articleHash", DEFAULT_ARTICLE_HASH)
    max_pages = dcfg.get("maxPagesPerRegion", 30)

    session = _session()
    listings = []
    seen = set()

    for dong in cfg["regions"]:
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

    return listings
