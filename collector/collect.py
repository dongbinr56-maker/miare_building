# -*- coding: utf-8 -*-
"""
네이버 부동산(new.land.naver.com) 상가 매물 수집기

동작 방식:
  1. Playwright 헤드리스 브라우저로 부동산 지도 페이지를 열어 앱이 쓰는
     Authorization 토큰을 캡처한다.
  2. 같은 브라우저 컨텍스트 안에서(page.evaluate + fetch) API를 호출한다.
     - 외부 HTTP 클라이언트(requests 등)는 네이버 WAF의 TLS 핑거프린팅에
       걸려 429가 반환되므로 반드시 브라우저 내부에서 호출해야 한다.
  3. 검색 API로 동 이름 -> cortarNo(네이버 지역코드)를 해석한다.
  4. 동별 매물 목록을 전 페이지 수집하고 조건 충족 여부를 평가해
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

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "collector", "config.json")

KST = timezone(timedelta(hours=9))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

ENTRY_URL = "https://new.land.naver.com/offices?ms=35.1915,126.8210,15&a=SG&b=B2"

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

NO_PREMIUM_RE = re.compile(r"무권리|권리금\s*(없|무|x|X)|노\s*권리")


def log(msg):
    print(f"[collect] {msg}", flush=True)


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


def resolve_region(sess, prefix, name):
    """검색 API로 동 이름 -> {cortarNo, centerLat, centerLon} 해석."""
    from urllib.parse import quote
    body = sess.get(f"https://new.land.naver.com/api/search?keyword={quote(prefix + ' ' + name)}")
    for r in (body or {}).get("regions", []):
        cortar_name = r.get("cortarName", "")
        if r.get("cortarType") == "sec" and prefix in cortar_name and cortar_name.endswith(name):
            return {"name": name, "cortarNo": r["cortarNo"],
                    "centerLat": r.get("centerLat"), "centerLon": r.get("centerLon")}
    return None


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
    no_premium = bool(NO_PREMIUM_RE.search(desc))

    checks = {
        "deposit": deposit is not None and deposit <= criteria["depositMax"],
        "rent": rent is not None and rent <= criteria["rentMax"],
        "floor": floor == 1 if criteria.get("requireFirstFloor") else True,
        "pyeong": (pyeong is not None
                   and criteria["pyeongMin"] <= pyeong <= criteria["pyeongMax"]),
    }
    passed = sum(checks.values())
    match_level = "full" if passed == 4 else ("near" if passed == 3 else "low")

    article_no = str(raw.get("articleNo"))
    return {
        "id": article_no,
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
        "desc": desc,
        "tags": raw.get("tagList") or [],
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

    # 이전 데이터의 firstSeen 맵 (신규 매물 감지용)
    prev_first_seen = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                prev = json.load(f)
            for it in prev.get("listings", []):
                if it.get("firstSeen"):
                    prev_first_seen[it["id"]] = it["firstSeen"]
        except Exception as e:
            log(f"이전 데이터 로드 실패(무시): {e!r}")

    today = datetime.now(KST).strftime("%Y-%m-%d")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--lang=ko-KR"],
        )
        ctx = browser.new_context(user_agent=UA, locale="ko-KR",
                                  viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

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

        # 1) 동 코드 해석
        regions = []
        for name in cfg["regions"]:
            r = resolve_region(sess, cfg["regionSearchPrefix"], name)
            if r:
                regions.append(r)
                log(f"지역 해석: {name} -> {r['cortarNo']}")
            else:
                log(f"지역 해석 실패: {name} (건너뜀)")
            sess.sleep()

        if not regions:
            log("해석된 지역이 없음 - 종료")
            sys.exit(1)

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
            log(f"{r['name']}: {count}건")

        browser.close()

    if not listings and prev_first_seen:
        log("수집 결과 0건 + 이전 데이터 존재 -> 기존 파일 유지, 실패로 종료")
        sys.exit(1)

    # 정렬: 충족 우선 -> 월세 낮은순 -> 보증금 낮은순
    level_order = {"full": 0, "near": 1, "low": 2}
    listings.sort(key=lambda x: (level_order[x["matchLevel"]],
                                 x["rent"] if x["rent"] is not None else 10**9,
                                 x["deposit"] if x["deposit"] is not None else 10**9))

    out = {
        "updatedAt": datetime.now(KST).isoformat(timespec="seconds"),
        "criteria": criteria,
        "tradeType": cfg["tradeType"],
        "realEstateTypes": cfg["realEstateTypes"],
        "regions": region_counts,
        "stats": {
            "total": len(listings),
            "full": sum(1 for x in listings if x["matchLevel"] == "full"),
            "near": sum(1 for x in listings if x["matchLevel"] == "near"),
            "new": sum(1 for x in listings if x.get("isNew")),
        },
        "listings": listings,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    log(f"저장 완료: {cfg['output']} (총 {len(listings)}건, "
        f"충족 {out['stats']['full']}건, 근접 {out['stats']['near']}건)")


if __name__ == "__main__":
    main()
