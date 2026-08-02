# -*- coding: utf-8 -*-
"""
네이버 부동산(new.land.naver.com) 상가 매물 수집기

동작 방식:
  1. Playwright 헤드리스 브라우저로 부동산 지도 페이지를 열어 앱이 쓰는
     Authorization 토큰을 캡처한다.
  2. 같은 브라우저 컨텍스트 안에서(page.evaluate + fetch) API를 호출한다.
     - 외부 HTTP 클라이언트(requests 등)는 네이버 WAF의 TLS 핑거프린팅에
       걸려 429가 반환되므로 반드시 브라우저 내부에서 호출해야 한다.
  3. 광산구 cortarNo의 하위 법정동(sec) 목록을 동적으로 조회한다.
  4. 법정동별 매물 목록을 전 페이지 수집하고 조건 충족 여부를 평가해
     web/public/data/listings.json 으로 저장한다.

실행: python collector/collect.py  (저장소 루트 기준 상대경로 처리됨)
"""
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone, timedelta

from playwright.sync_api import Error as PlaywrightError, sync_playwright

from rules import (
    audit_premium_classifications,
    evaluate,
    explicit_no_premium_evidence,
    explicit_premium_amount_evidence,
)
from daangn import collect_daangn
from dedupe import merge_duplicates
from change_history import build_change_history
from nearby import (
    NEARBY_RADIUS_M,
    filter_by_nearby_facilities,
    prefetch_nearby_facilities,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "collector", "config.json")

KST = timezone(timedelta(hours=9))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

ENTRY_URL = "https://new.land.naver.com/offices?ms=35.1915,126.8210,15&a=SG&b=B2"
REGION_LIST_URL = "https://new.land.naver.com/api/regions/list?cortarNo={cortar_no}"

FETCH_JS = """
async ({ url, token }) => {
  const r = await fetch(url, {
    headers: { "accept": "application/json, text/plain, */*", "authorization": token },
    credentials: "include",
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
}
"""

CLOUDFLARE_ACCOUNT_ID_RE = re.compile(r"^[0-9a-fA-F]{32}$")
BROWSER_RUN_RETRY_DELAYS = (5, 15, 30, 60)


def log(msg):
    print(f"[collect] {msg}", flush=True)


def launch_naver_browser(playwright):
    """Launch locally, or explicitly use Cloudflare Browser Run with a token.

    CLOUDFLARE_ACCOUNT_ID is also required for KV publishing, so its presence
    alone must not opt the collector into the quota-limited Browser Rendering
    service. Only CLOUDFLARE_BROWSER_TOKEN explicitly selects remote CDP.
    """
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    browser_token = os.environ.get("CLOUDFLARE_BROWSER_TOKEN", "").strip()
    if browser_token and not account_id:
        raise RuntimeError("Cloudflare Browser Run 토큰에 대응하는 계정 ID가 없습니다.")
    if browser_token:
        if not CLOUDFLARE_ACCOUNT_ID_RE.fullmatch(account_id):
            raise RuntimeError("Cloudflare 계정 ID 형식이 올바르지 않습니다.")
        endpoint = (
            "wss://api.cloudflare.com/client/v4/accounts/"
            f"{account_id}/browser-rendering/devtools/browser?keep_alive=600000"
        )
        browser = None
        for attempt in range(len(BROWSER_RUN_RETRY_DELAYS) + 1):
            log(
                "Cloudflare Browser Run 원격 Chromium 연결 중..."
                f" ({attempt + 1}/{len(BROWSER_RUN_RETRY_DELAYS) + 1})"
            )
            try:
                browser = playwright.chromium.connect_over_cdp(
                    endpoint,
                    headers={"Authorization": f"Bearer {browser_token}"},
                    timeout=60_000,
                )
                break
            except PlaywrightError as error:
                message = str(error).lower()
                retryable = (
                    "429" in message
                    or "rate limit" in message
                    or "too many requests" in message
                    or "502" in message
                    or "503" in message
                    or "504" in message
                )
                if not retryable or attempt >= len(BROWSER_RUN_RETRY_DELAYS):
                    raise
                delay = BROWSER_RUN_RETRY_DELAYS[attempt]
                log(f"Browser Run 일시 오류, {delay}초 후 재시도합니다.")
                time.sleep(delay)

        if browser is None:  # pragma: no cover - loop either connects or raises
            raise RuntimeError("Cloudflare Browser Run 연결 결과가 없습니다.")
        # Browser Run의 기본 컨텍스트는 일반 네이버 홈으로 리디렉션될 수 있다.
        # 로컬 수집기와 동일한 UA/locale을 가진 격리 컨텍스트를 명시적으로 만들어
        # new.land가 사용하는 API Authorization 요청을 안정적으로 포착한다.
        context = browser.new_context(
            user_agent=UA,
            locale="ko-KR",
            viewport={"width": 1400, "height": 900},
        )
        page = context.new_page()
        return browser, context, page

    log("GitHub/로컬 실행 환경의 Chromium을 직접 시작합니다.")
    browser = playwright.chromium.launch(
        headless=True,
        args=["--disable-blink-features=AutomationControlled", "--lang=ko-KR"],
    )
    context = browser.new_context(
        user_agent=UA,
        locale="ko-KR",
        viewport={"width": 1400, "height": 900},
    )
    return browser, context, context.new_page()


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def parse_price(v):
    """'3,000' -> 3000 (만원). 파싱 불가 시 None."""
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_floor(floor_info):
    """floorInfo '1/2' -> (1, 2). 'B1/3' -> (-1, 3). '고/3' 등 비수치 -> (None, 3)."""
    if not floor_info or "/" not in str(floor_info):
        return None, None
    a, b = str(floor_info).split("/", 1)
    a = a.strip().upper()
    floor = None
    if a.startswith("B") and a[1:].isdigit():
        floor = -int(a[1:])
    elif a.lstrip("-").isdigit():
        floor = int(a)
    total = int(b) if str(b).strip().isdigit() else None
    return floor, total


class NaverLandSession:
    """Playwright 브라우저 컨텍스트를 통해 new.land API를 호출하는 세션."""

    def __init__(self, page, token):
        self.page = page
        self.token = token

    def get(self, url, retries=2):
        for attempt in range(retries + 1):
            res = self.page.evaluate(FETCH_JS, {"url": url, "token": self.token})
            status = res.get("status")
            if status == 200:
                return res.get("body")
            log(f"  HTTP {status} (attempt {attempt + 1}) {url[:100]}")
            time.sleep(2.5 * (attempt + 1))
        return None

    def sleep(self):
        time.sleep(random.uniform(0.8, 1.6))


def discover_child_regions(sess, parent_cortar_no):
    """구 cortarNo 아래의 모든 법정동(sec)을 네이버 지역 API에서 조회한다.

    일부 동만 수집하는 정적 폴백은 두지 않는다. API가 실패하거나 응답 스키마가
    바뀌면 빈 목록을 반환해 호출자가 전체 수집을 중단하도록 한다.
    """
    body = sess.get(REGION_LIST_URL.format(cortar_no=parent_cortar_no))
    if not isinstance(body, dict):
        return []

    # 현재 API 키는 regionList다. regions는 과거/테스트 응답과의 호환용이다.
    raw_regions = body.get("regionList")
    if not isinstance(raw_regions, list):
        raw_regions = body.get("regions")
    if not isinstance(raw_regions, list):
        return []

    regions = []
    seen = set()
    for raw in raw_regions:
        if not isinstance(raw, dict) or raw.get("cortarType") != "sec":
            continue
        cortar_no = str(raw.get("cortarNo") or "").strip()
        name = str(raw.get("cortarName") or "").strip()
        if not cortar_no or not name or cortar_no in seen:
            continue
        seen.add(cortar_no)
        regions.append({
            "name": name,
            "cortarNo": cortar_no,
            "centerLat": raw.get("centerLat"),
            "centerLon": raw.get("centerLon"),
        })
    return regions


def fetch_region_articles(sess, cortar_no, real_estate_type, trade_type, max_pages):
    """한 동의 매물을 전 페이지 수집."""
    articles = []
    page_no = 1
    while page_no <= max_pages:
        url = ("https://new.land.naver.com/api/articles?"
               f"cortarNo={cortar_no}&order=rank&realEstateType={real_estate_type}"
               f"&tradeType={trade_type}&tag=%3A%3A%3A%3A%3A%3A%3A%3A"
               "&rentPriceMin=0&rentPriceMax=900000000&priceMin=0&priceMax=900000000"
               "&areaMin=0&areaMax=900000000&showArticle=false&sameAddressGroup=false"
               f"&priceType=RETAIL&page={page_no}")
        body = sess.get(url)
        if body is None:
            log(f"  page {page_no}: 응답 실패, 해당 동 수집 중단")
            break
        batch = body.get("articleList", []) or []
        articles.extend(batch)
        if not body.get("isMoreData"):
            break
        page_no += 1
        sess.sleep()
    return articles


def normalize(raw, dong, criteria):
    """네이버 응답 1건 -> 대시보드용 매물 레코드 + 조건 평가."""
    deposit = parse_price(raw.get("dealOrWarrantPrc"))
    rent = parse_price(raw.get("rentPrc"))
    floor, total_floor = parse_floor(raw.get("floorInfo"))

    area_m2 = raw.get("area2") or raw.get("area1")  # 전용 우선, 없으면 계약
    pyeong = round(area_m2 * 0.3025, 1) if area_m2 else None

    desc = raw.get("articleFeatureDesc") or ""
    premium_amount_evidence = explicit_premium_amount_evidence(desc)
    premium_match = explicit_no_premium_evidence(desc)
    premium_amount = (
        premium_amount_evidence["amount"] if premium_amount_evidence else None
    )
    if premium_amount is not None:
        premium_status = "present"
        no_premium = False
    else:
        no_premium = premium_match is not None
        premium_status = "none" if no_premium else "unknown"

    desc_parts = [
        part.strip()
        for part in desc.split(" · ")
        if part.strip() and not re.search(r"무\s*권리|권리금", part, re.IGNORECASE)
    ]
    if premium_status == "present":
        desc_parts.insert(0, f"권리금 {premium_amount:,}만원")
        display_desc = " · ".join(desc_parts)
    elif premium_status == "none":
        desc_parts.insert(0, "무권리")
        display_desc = " · ".join(desc_parts)
    else:
        display_desc = desc

    checks, match_level = evaluate(deposit, rent, floor, no_premium, criteria)

    article_no = str(raw.get("articleNo"))
    return {
        "id": f"naver:{article_no}",
        "source": "naver",
        "dong": dong,
        "name": raw.get("buildingName") or raw.get("articleName") or "상가",
        "typeName": raw.get("articleRealEstateTypeName") or raw.get("realEstateTypeName"),
        "tradeTypeName": raw.get("tradeTypeName"),
        "deposit": deposit,
        "rent": rent,
        "floor": floor,
        "totalFloor": total_floor,
        "floorRaw": raw.get("floorInfo"),
        "areaM2": area_m2,
        "pyeong": pyeong,
        "desc": display_desc,
        "tags": raw.get("tagList") or [],
        "premiumMoney": premium_amount,
        "premiumStatus": premium_status,
        "premiumEvidence": (
            {
                "source": "naver_list_description",
                "field": "articleFeatureDesc",
                "matchedText": (
                    premium_amount_evidence["matchedText"]
                    if premium_amount_evidence else premium_match
                ),
                "contextText": desc,
                "value": premium_amount,
                "articleUrl": f"https://new.land.naver.com/offices?articleNo={article_no}",
            }
            if premium_amount_evidence or no_premium else None
        ),
        "noPremium": no_premium,
        "direction": raw.get("direction"),
        "confirmedAt": raw.get("articleConfirmYmd"),
        "realtor": raw.get("realtorName"),
        "cpName": raw.get("cpName"),
        "lat": raw.get("latitude"),
        "lon": raw.get("longitude"),
        "sameAddrCnt": raw.get("sameAddrCnt"),
        "link": f"https://new.land.naver.com/offices?articleNo={article_no}",
        "mobileLink": f"https://m.land.naver.com/article/info/{article_no}",
        "checks": checks,
        "matchLevel": match_level,
    }


def main():
    cfg = load_config()
    out_path = os.path.join(ROOT, cfg["output"])
    criteria = cfg["criteria"]

    # 매물 수집보다 먼저 광산구 전체 학교·아파트 단지 카탈로그를 확보한다.
    # 이 단계가 실패하면 비싼 브라우저 수집을 시작하지 않고 기존 데이터를 보존한다.
    nearby_settings = cfg.get("nearbyFacilities", {})
    nearby_prefetch = prefetch_nearby_facilities(nearby_settings, log)
    if nearby_settings.get("enabled", True) and nearby_prefetch.get("dataStatus") == "unavailable":
        log("광산구 생활권 사전 조회 실패 - 기존 데이터를 보존하고 종료")
        sys.exit(1)
    log(
        "광산구 생활권 사전 조회 완료: "
        f"학교·아파트 단지 {nearby_prefetch.get('facilityCount', 0)}개 "
        f"({nearby_prefetch.get('dataStatus')})"
    )

    # 이전 데이터의 firstSeen 맵 (신규 매물 감지용)
    previous_data = None
    prev_first_seen = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                prev = json.load(f)
            if isinstance(prev, dict):
                previous_data = prev
            for it in prev.get("listings", []):
                if it.get("firstSeen"):
                    key = it["id"]
                    if ":" not in key:  # 구버전 데이터(소스 접두어 없음) 마이그레이션
                        key = f"naver:{key}"
                    prev_first_seen[key] = it["firstSeen"]
        except Exception as e:
            log(f"이전 데이터 로드 실패(무시): {e!r}")

    today = datetime.now(KST).strftime("%Y-%m-%d")

    with sync_playwright() as p:
        browser = None
        try:
            browser, ctx, page = launch_naver_browser(p)

            token_box = {"v": None}

            def on_request(req):
                if token_box["v"] is None and "new.land.naver.com/api/" in req.url:
                    auth = req.headers.get("authorization")
                    if auth and auth.startswith("Bearer "):
                        token_box["v"] = auth

            page.on("request", on_request)
            log("네이버 부동산 페이지 로드 중...")
            page.goto(ENTRY_URL, wait_until="domcontentloaded", timeout=60000)
            for _ in range(40):
                if token_box["v"]:
                    break
                page.wait_for_timeout(500)
            if not token_box["v"]:
                log("토큰 캡처 실패 - 종료")
                sys.exit(1)
            log("토큰 캡처 완료")

            sess = NaverLandSession(page, token_box["v"])

            # 1) 광산구 하위 법정동 전체를 동적으로 조회한다.
            regions = discover_child_regions(sess, cfg["regionCortarNo"])

            if not regions:
                log("광산구 하위 법정동 목록 조회 실패 - 기존 데이터를 보존하고 종료")
                sys.exit(1)
            log(f"광산구 전체 지역 해석: {len(regions)}개 법정동")
            for region in regions:
                log(f"  {region['name']} -> {region['cortarNo']}")

            # 2) 동별 매물 수집
            listings = []
            seen_ids = set()
            region_counts = []
            for r in regions:
                count = 0
                for ret in cfg["realEstateTypes"]:
                    raws = fetch_region_articles(sess, r["cortarNo"], ret,
                                                 cfg["tradeType"], cfg["maxPagesPerRegion"])
                    for raw in raws:
                        item = normalize(raw, r["name"], criteria)
                        if item["id"] in seen_ids:
                            continue
                        seen_ids.add(item["id"])
                        item["firstSeen"] = prev_first_seen.get(item["id"], today)
                        # 신규 = 직전 수집 데이터에 없던 매물 (첫 수집 시에는 전부 기준선이므로 신규 아님)
                        item["isNew"] = bool(prev_first_seen) and item["id"] not in prev_first_seen
                        listings.append(item)
                        count += 1
                    sess.sleep()
                region_counts.append({"name": r["name"], "cortarNo": r["cortarNo"], "count": count})
                log(f"{r['name']}: {count}건 (네이버)")
        finally:
            # Browser Run continues consuming the daily allowance until the
            # session closes, so close even on token/API/collector failures.
            if browser is not None:
                browser.close()

    # 3) 당근 부동산 수집 (순수 HTTP, 브라우저 불필요)
    if cfg.get("daangn", {}).get("enabled", True):
        try:
            for item in collect_daangn(cfg, criteria, regions, log):
                if item["id"] in seen_ids:
                    continue
                seen_ids.add(item["id"])
                item["firstSeen"] = prev_first_seen.get(item["id"], today)
                item["isNew"] = bool(prev_first_seen) and item["id"] not in prev_first_seen
                listings.append(item)
        except Exception as e:
            log(f"당근 수집 전체 실패(네이버 데이터만 저장): {e!r}")

    if not listings and prev_first_seen:
        log("수집 결과 0건 + 이전 데이터 존재 -> 기존 파일 유지, 실패로 종료")
        sys.exit(1)

    # 중복 병합 (가격·평·층 동일 + 좌표 근접)
    raw_count = len(listings)
    listings = merge_duplicates(listings)
    deduped_count = len(listings)
    log(f"중복 병합: {raw_count}건 -> {deduped_count}건 ({raw_count - deduped_count}건 병합)")

    # 양수 권리금 오탐이나 근거 없는 무권리가 한 건이라도 있으면 fail-closed로
    # 종료해 기존 KV/JSON을 보존한다. 과거 오탐 ID는 병합 ID까지 추적한다.
    premium_audit = audit_premium_classifications(listings)
    log(
        "권리금 감사: "
        f"양수 오분류 {premium_audit['positiveMisclassified']}건, "
        f"근거 없는 무권리 {premium_audit['noPremiumWithoutEvidence']}건, "
        f"회귀 매물 선택 {premium_audit['regressionListingSelected']}건"
    )
    if premium_audit["totalViolations"]:
        log("권리금 감사 실패 - 기존 데이터를 보존하고 종료")
        sys.exit(1)

    # 가격·층·무권리 조건을 모두 만족한 매물만 생활권 검증 대상으로 삼고,
    # 반경 안에 학교/대학교/아파트 근거가 확인된 매물만 최종 출력한다.
    full_candidates = [item for item in listings if item.get("matchLevel") == "full"]
    listings, nearby_stats = filter_by_nearby_facilities(
        full_candidates,
        nearby_settings,
        log,
    )
    nearby_stats["prefetch"] = nearby_prefetch
    if full_candidates and nearby_stats.get("dataStatus") == "unavailable":
        log("생활권 데이터 조회 실패 - 기존 데이터를 보존하고 종료")
        sys.exit(1)
    log(
        "최종 선별: "
        f"조건 충족 {len(full_candidates)}건 -> 생활권 확인 {len(listings)}건 "
        f"(반경 {nearby_stats.get('radiusM', NEARBY_RADIUS_M)}m)"
    )

    # 직전 최종 스냅샷과 이번 최종 스냅샷을 비교한다. 병합 ID가 하나라도
    # 겹치면 동일 매물로 보고, 새 번호 재등록은 주소/고신뢰 좌표와 호실 성격이
    # 유일하게 일치할 때만 보수적으로 추정한다.
    updated_at = datetime.now(KST).isoformat(timespec="seconds")
    change_history, previous_identity = build_change_history(
        previous_data,
        listings,
        updated_at,
    )
    for item in listings:
        previous_item = previous_identity.get(item.get("id"))
        if previous_item and previous_item.get("firstSeen"):
            item["firstSeen"] = previous_item["firstSeen"]
        item["isNew"] = bool(
            not change_history.get("baseline") and previous_item is None
        )
    change_counts = change_history.get("counts", {})
    log(
        "변경 이력: "
        f"신규 {change_counts.get('new', 0)}건, "
        f"가격 {change_counts.get('priceChanged', 0)}건, "
        f"설명 {change_counts.get('descriptionChanged', 0)}건, "
        f"사라짐 {change_counts.get('deleted', 0)}건, "
        f"재등록 추정 {change_counts.get('relisted', 0)}건"
    )

    # UI의 지역별 건수는 네이버 원본 수가 아니라 당근 포함·중복 병합 후의
    # 최종 매물 수와 일치해야 한다.
    final_region_counts = {r["name"]: 0 for r in regions}
    for item in listings:
        dong = item.get("dong")
        if dong in final_region_counts:
            final_region_counts[dong] += 1
    for region in region_counts:
        region["count"] = final_region_counts.get(region["name"], 0)

    # 정렬: 충족 우선 -> 월세 낮은순 -> 보증금 낮은순
    level_order = {"full": 0, "near": 1, "low": 2}
    listings.sort(key=lambda x: (level_order[x["matchLevel"]],
                                 x["rent"] if x["rent"] is not None else 10**9,
                                 x["deposit"] if x["deposit"] is not None else 10**9))

    out = {
        "updatedAt": updated_at,
        "criteria": criteria,
        "tradeType": cfg["tradeType"],
        "realEstateTypes": cfg["realEstateTypes"],
        "regions": region_counts,
        "stats": {
            "total": len(listings),
            "full": sum(1 for x in listings if x["matchLevel"] == "full"),
            "near": sum(1 for x in listings if x["matchLevel"] == "near"),
            "new": sum(1 for x in listings if x.get("isNew")),
            "naver": sum(1 for x in listings if x.get("source") == "naver"),
            "daangn": sum(1 for x in listings if x.get("source") == "daangn"),
            "merged": raw_count - deduped_count,
            "crossListed": sum(1 for x in listings if len(x.get("sources", [])) > 1),
            "excludedByCriteria": deduped_count - len(full_candidates),
            "premiumAudit": premium_audit,
            "nearby": nearby_stats,
        },
        "changeHistory": change_history,
        "listings": listings,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    log(f"저장 완료: {cfg['output']} (총 {len(listings)}건, "
        f"충족 {out['stats']['full']}건, 근접 {out['stats']['near']}건)")


if __name__ == "__main__":
    main()
