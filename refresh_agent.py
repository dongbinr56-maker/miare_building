"""Run the collector only when the protected dashboard requests a refresh.

Cloudflare authentication is delegated to Wrangler (OAuth or API token). The
agent polls KV state; it does not collect on a timer when no request is pending.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any


ROOT = Path(__file__).resolve().parent
COLLECTOR_DIR = ROOT / "collector"
if str(COLLECTOR_DIR) not in sys.path:
    sys.path.insert(0, str(COLLECTOR_DIR))

from rules import audit_premium_classifications, evaluate  # noqa: E402

WEB_DIR = ROOT / "web"
LISTINGS_PATH = WEB_DIR / "public" / "data" / "listings.json"
LOG_PATH = ROOT / "collector" / "last_manual_refresh.log"
DEFAULT_NAMESPACE_ID = "d07c1a375af04973b68fd099f0991b9b"
STATE_KEY = "refresh:state"
LISTINGS_KEY = "listings:latest"
META_KEY = "listings:meta"
NEARBY_CACHE_KEY = "nearby:facilities:v2"
NEARBY_CACHE_PATH = COLLECTOR_DIR / ".cache" / "nearby_facilities.json"
MAX_LISTINGS_BYTES = 20 * 1024 * 1024
MAX_NEARBY_CACHE_BYTES = 20 * 1024 * 1024
MAX_NEARBY_CACHE_POIS = 100_000
MAX_NEARBY_GEOMETRY_POINTS = 1_000_000
NEARBY_CACHE_SCHEMA_VERSION = 2
STALE_RUNNING_SECONDS = 90 * 60
EXPECTED_CRITERIA = {
    "depositMin": 500,
    "depositMax": 1000,
    "rentMax": 60,
    "floorMin": -1,
    "floorMax": 2,
    "requireNoPremium": True,
}
EXPECTED_NEARBY_RADIUS_M = 500


def _wrangler_command() -> list[str]:
    executable = "wrangler.cmd" if os.name == "nt" else "wrangler"
    local = WEB_DIR / "node_modules" / ".bin" / executable
    if local.exists():
        return [str(local)]
    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not npx:
        raise RuntimeError("Node.js/npm이 필요합니다. npm install을 먼저 실행하세요.")
    return [npx, "--yes", "wrangler"]


class KvClient:
    def __init__(self, namespace_id: str) -> None:
        self.namespace_id = namespace_id
        self.command = _wrangler_command()

    def _scope(self) -> list[str]:
        return ["--namespace-id", self.namespace_id, "--remote"]

    def get_text(self, key: str, *, missing_ok: bool = False) -> str | None:
        result = subprocess.run(
            [*self.command, "kv", "key", "get", key, *self._scope(), "--text"],
            cwd=WEB_DIR,
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            output = f"{result.stdout}\n{result.stderr}".strip()
            if missing_ok and ("value not found" in output.lower() or "404" in output):
                return None
            raise RuntimeError(f"KV 읽기 실패({key}): {output[-800:]}")
        return result.stdout.strip()

    def get_json(self, key: str, *, missing_ok: bool = False) -> dict[str, Any] | None:
        raw = self.get_text(key, missing_ok=missing_ok)
        if not raw:
            return None
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise RuntimeError(f"KV 값이 객체가 아닙니다: {key}")
        return value

    def put_bytes(self, key: str, value: bytes) -> None:
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(delete=False) as temporary:
                temporary.write(value)
                temporary_path = temporary.name
            result = subprocess.run(
                [
                    *self.command,
                    "kv",
                    "key",
                    "put",
                    key,
                    *self._scope(),
                    "--path",
                    temporary_path,
                ],
                cwd=WEB_DIR,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )
            if result.returncode != 0:
                output = f"{result.stdout}\n{result.stderr}".strip()
                raise RuntimeError(f"KV 쓰기 실패({key}): {output[-800:]}")
        finally:
            if temporary_path:
                Path(temporary_path).unlink(missing_ok=True)

    def put_json(self, key: str, value: dict[str, Any]) -> None:
        self.put_bytes(key, json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _claimable(state: dict[str, Any]) -> bool:
    if state.get("status") == "pending":
        return True
    if state.get("status") != "running":
        return False
    claimed_at = _parse_time(state.get("claimedAt"))
    return claimed_at is None or time.time() - claimed_at > STALE_RUNNING_SECONDS


def _validate_listings(raw: bytes, *, require_strict_premium: bool = True) -> str:
    if not raw or len(raw) > MAX_LISTINGS_BYTES:
        raise RuntimeError("수집 데이터 크기가 허용 범위를 벗어났습니다.")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("수집 데이터가 JSON 객체가 아닙니다.")
    updated_at = value.get("updatedAt")
    listings = value.get("listings")
    if (
        not isinstance(updated_at, str)
        or _parse_time(updated_at) is None
        or not isinstance(value.get("criteria"), dict)
        or not isinstance(value.get("stats"), dict)
        or not isinstance(value.get("regions"), list)
        or not isinstance(listings, list)
        or len(listings) > 50_000
    ):
        raise RuntimeError("수집 데이터 스키마가 올바르지 않습니다.")
    for listing in listings:
        if (
            not isinstance(listing, dict)
            or not isinstance(listing.get("id"), str)
            or listing.get("source") not in {"naver", "daangn"}
            or not listing["id"].startswith(f"{listing.get('source')}:")
            or not listing["id"].split(":", 1)[1].isdigit()
        ):
            raise RuntimeError("매물 식별 정보가 올바르지 않습니다.")
    if require_strict_premium:
        criteria = value["criteria"]
        if any(criteria.get(key) != expected for key, expected in EXPECTED_CRITERIA.items()):
            raise RuntimeError("매물 검색 조건이 승인된 운영 기준과 일치하지 않습니다.")
        nearby_stats = value["stats"].get("nearby")
        if (
            not isinstance(nearby_stats, dict)
            or nearby_stats.get("radiusM") != EXPECTED_NEARBY_RADIUS_M
            or nearby_stats.get("source") != "openstreetmap_overpass"
            or nearby_stats.get("kept") != len(listings)
        ):
            raise RuntimeError("생활권 필터 결과가 승인된 500m 운영 기준과 일치하지 않습니다.")
        for listing in listings:
            merged_ids = listing.get("mergedListingIds")
            checks = listing.get("checks")
            nearby_check = listing.get("nearbyFacilityCheck")
            nearby_facilities = listing.get("nearbyFacilities")
            try:
                recalculated_checks, recalculated_level = evaluate(
                    listing.get("deposit"),
                    listing.get("rent"),
                    listing.get("floor"),
                    listing.get("noPremium"),
                    EXPECTED_CRITERIA,
                )
            except (TypeError, ValueError):
                recalculated_checks, recalculated_level = {}, "low"
            if (
                not isinstance(merged_ids, list)
                or not merged_ids
                or listing["id"] not in merged_ids
                or len(merged_ids) != len(set(merged_ids))
                or any(
                    not isinstance(listing_id, str)
                    or not (
                        listing_id.startswith("naver:")
                        or listing_id.startswith("daangn:")
                    )
                    or not listing_id.split(":", 1)[1].isdigit()
                    for listing_id in merged_ids
                )
                or listing.get("matchLevel") != "full"
                or not isinstance(checks, dict)
                or any(
                    checks.get(key) is not True
                    for key in ("deposit", "rent", "floor", "premium")
                )
                or recalculated_level != "full"
                or any(
                    recalculated_checks.get(key) is not True
                    for key in ("deposit", "rent", "floor", "premium")
                )
                or not isinstance(nearby_check, dict)
                or nearby_check.get("withinRadius") is not True
                or nearby_check.get("radiusM") != EXPECTED_NEARBY_RADIUS_M
                or nearby_check.get("source") != "openstreetmap_overpass"
                or nearby_check.get("dataStatus") not in {"network", "cache", "stale_cache"}
                or _parse_time(nearby_check.get("checkedAt")) is None
                or not isinstance(nearby_facilities, list)
                or not nearby_facilities
                or any(
                    not isinstance(facility, dict)
                    or not _is_finite_number(facility.get("distanceM"))
                    or float(facility["distanceM"]) < 0
                    or float(facility["distanceM"]) > EXPECTED_NEARBY_RADIUS_M
                    for facility in nearby_facilities
                )
            ):
                raise RuntimeError(
                    "최종 데이터에 조건 미충족·500m 생활권 미충족 또는 잘못된 ID 매물이 포함되어 있습니다."
                )
        premium_audit = value["stats"].get("premiumAudit")
        required_counters = {
            "positiveMisclassified",
            "noPremiumWithoutEvidence",
            "regressionListingSelected",
            "classificationInconsistent",
            "selectedWithoutNoPremiumProof",
            "totalViolations",
        }
        if (
            not isinstance(premium_audit, dict)
            or not required_counters.issubset(premium_audit)
            or any(premium_audit.get(key) != 0 for key in required_counters)
        ):
            raise RuntimeError("권리금 감사 결과가 없거나 안전하지 않습니다.")
        calculated_audit = audit_premium_classifications(listings)
        if calculated_audit["totalViolations"] != 0:
            raise RuntimeError(f"업로드 직전 권리금 감사 실패: {calculated_audit}")
    return updated_at


def _is_finite_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _validate_nearby_cache(raw: bytes) -> str:
    """Validate an untrusted Overpass cache before local restore or KV upload."""
    if not raw or len(raw) > MAX_NEARBY_CACHE_BYTES:
        raise RuntimeError("생활권 캐시 크기가 허용 범위를 벗어났습니다.")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("생활권 캐시가 올바른 JSON이 아닙니다.") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != NEARBY_CACHE_SCHEMA_VERSION:
        raise RuntimeError("생활권 캐시 스키마 버전이 올바르지 않습니다.")

    fetched_at = value.get("fetchedAt")
    coverage = value.get("coverage")
    pois = value.get("pois")
    if (
        not isinstance(fetched_at, str)
        or _parse_time(fetched_at) is None
        or not isinstance(coverage, dict)
        or not isinstance(pois, list)
        or len(pois) > MAX_NEARBY_CACHE_POIS
    ):
        raise RuntimeError("생활권 캐시 스키마가 올바르지 않습니다.")

    coverage_values = [coverage.get(key) for key in ("south", "west", "north", "east")]
    if (
        not all(_is_finite_number(value) for value in coverage_values)
        or not -90 <= float(coverage_values[0]) < float(coverage_values[2]) <= 90
        or not -180 <= float(coverage_values[1]) < float(coverage_values[3]) <= 180
    ):
        raise RuntimeError("생활권 캐시 조회 범위가 올바르지 않습니다.")

    geometry_points = 0
    valid_kinds = {
        "elementary_school",
        "middle_school",
        "high_school",
        "school",
        "university",
        "apartment",
        "apartment_complex",
    }
    for poi in pois:
        if (
            not isinstance(poi, dict)
            or poi.get("osmType") not in {"node", "way", "relation"}
            or not isinstance(poi.get("osmId"), int)
            or isinstance(poi.get("osmId"), bool)
            or poi["osmId"] <= 0
            or poi.get("kind") not in valid_kinds
            or not isinstance(poi.get("name"), str)
            or not _is_finite_number(poi.get("lat"))
            or not _is_finite_number(poi.get("lon"))
            or not isinstance(poi.get("tags"), dict)
            or any(
                not isinstance(key, str) or not isinstance(tag_value, str)
                for key, tag_value in poi.get("tags", {}).items()
            )
        ):
            raise RuntimeError("생활권 캐시 시설 스키마가 올바르지 않습니다.")

        bbox = poi.get("bbox")
        if (
            not isinstance(bbox, list)
            or len(bbox) != 4
            or not all(_is_finite_number(value) for value in bbox)
            or not -90 <= float(bbox[0]) <= float(bbox[2]) <= 90
            or not -180 <= float(bbox[1]) <= float(bbox[3]) <= 180
        ):
            raise RuntimeError("생활권 캐시 시설 bbox가 올바르지 않습니다.")

        geometry = poi.get("geometry")
        if not isinstance(geometry, list):
            raise RuntimeError("생활권 캐시 시설 geometry가 올바르지 않습니다.")
        for ring in geometry:
            if not isinstance(ring, list):
                raise RuntimeError("생활권 캐시 시설 geometry가 올바르지 않습니다.")
            geometry_points += len(ring)
            if geometry_points > MAX_NEARBY_GEOMETRY_POINTS:
                raise RuntimeError("생활권 캐시 도형 좌표 수가 허용 범위를 벗어났습니다.")
            for point in ring:
                if (
                    not isinstance(point, list)
                    or len(point) != 2
                    or not all(_is_finite_number(value) for value in point)
                    or not -90 <= float(point[0]) <= 90
                    or not -180 <= float(point[1]) <= 180
                ):
                    raise RuntimeError("생활권 캐시 시설 geometry가 올바르지 않습니다.")
    return fetched_at


def _write_nearby_cache(raw: bytes) -> None:
    """Atomically restore the validated cache into the ephemeral runner."""
    NEARBY_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=NEARBY_CACHE_PATH.parent,
            prefix=f".{NEARBY_CACHE_PATH.name}.",
            delete=False,
        ) as temporary:
            temporary.write(raw)
            temporary_path = temporary.name
        os.replace(temporary_path, NEARBY_CACHE_PATH)
        temporary_path = None
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


def _seed_nearby_cache(kv: KvClient) -> str | None:
    """Restore the private OSM cache that does not survive hosted runners."""
    cached = kv.get_text(NEARBY_CACHE_KEY, missing_ok=True)
    if cached is None:
        return None
    raw = cached.encode("utf-8")
    fetched_at = _validate_nearby_cache(raw)
    _write_nearby_cache(raw)
    return fetched_at


def _nearby_cache_for_upload(previous_fetched_at: str | None) -> bytes:
    try:
        raw = NEARBY_CACHE_PATH.read_bytes()
    except OSError as error:
        raise RuntimeError("수집 후 생활권 캐시를 찾을 수 없습니다.") from error
    fetched_at = _validate_nearby_cache(raw)
    if previous_fetched_at:
        previous_time = _parse_time(previous_fetched_at)
        next_time = _parse_time(fetched_at)
        if previous_time is not None and next_time is not None and next_time < previous_time:
            raise RuntimeError("KV의 생활권 캐시보다 오래된 결과입니다.")
    return raw


def _run_collection() -> tuple[bool, str]:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as log:
        log.write(f"\n[{_iso_now()}] manual refresh started\n")
        log.flush()
        result = subprocess.run(
            [sys.executable, str(ROOT / "collector" / "collect.py")],
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
        log.write(f"[{_iso_now()}] collector exited with {result.returncode}\n")
    return result.returncode == 0, f"수집기 종료 코드 {result.returncode}"


def _seed_previous_listings(kv: KvClient) -> None:
    """Restore the private previous snapshot for firstSeen/isNew comparison.

    Production listing data is intentionally not stored in the public GitHub
    repository. A hosted runner therefore restores it from KV only inside its
    ephemeral workspace before invoking the collector.
    """
    previous = kv.get_text(LISTINGS_KEY, missing_ok=True)
    if not previous:
        return
    raw = previous.encode("utf-8")
    # 이전 KV에는 마이그레이션 전 데이터가 있을 수 있다. 이 데이터는
    # firstSeen 비교용으로만 복원하며, 새 결과 업로드에는 엄격 감사가 적용된다.
    _validate_listings(raw, require_strict_premium=False)
    LISTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LISTINGS_PATH.write_bytes(raw)


def process_once(kv: KvClient, expected_job_id: str | None = None) -> bool:
    state = kv.get_json(STATE_KEY, missing_ok=True)
    if not state:
        if expected_job_id:
            raise RuntimeError("요청한 새로고침 작업을 KV에서 찾지 못했습니다.")
        return False
    job_id = state.get("jobId")
    if not isinstance(job_id, str) or not job_id:
        raise RuntimeError("새로고침 작업 ID가 없습니다.")
    if expected_job_id and job_id != expected_job_id:
        raise RuntimeError("KV의 새로고침 작업 ID가 GitHub 요청과 일치하지 않습니다.")
    if not _claimable(state):
        if expected_job_id:
            raise RuntimeError(
                f"요청한 새로고침 작업을 실행할 수 없는 상태입니다: {state.get('status')}"
            )
        return False

    claimed = {
        **state,
        "status": "running",
        "claimedAt": _iso_now(),
        "message": "GitHub 수집 서버에서 최신 매물을 확인하고 있습니다.",
    }
    kv.put_json(STATE_KEY, claimed)
    print(f"[{_iso_now()}] 새로고침 작업 시작: {job_id}", flush=True)

    previous_nearby_fetched_at: str | None = None
    try:
        _seed_previous_listings(kv)
        previous_nearby_fetched_at = _seed_nearby_cache(kv)
    except Exception as error:
        failure_message = f"이전 수집 데이터 준비에 실패했습니다. {str(error)[:300]}"
        kv.put_json(
            STATE_KEY,
            {
                **claimed,
                "status": "failed",
                "completedAt": _iso_now(),
                "message": failure_message,
            },
        )
        if expected_job_id:
            raise RuntimeError(failure_message) from error
        return True

    ok, detail = _run_collection()
    if not ok:
        failure_message = f"매물 수집에 실패했습니다. {detail}"
        kv.put_json(
            STATE_KEY,
            {
                **claimed,
                "status": "failed",
                "completedAt": _iso_now(),
                "message": failure_message,
            },
        )
        # A workflow-dispatched one-shot run must fail visibly in GitHub Actions.
        # The long-running local daemon keeps polling after recording the failure.
        if expected_job_id:
            raise RuntimeError(failure_message)
        return True

    try:
        raw = LISTINGS_PATH.read_bytes()
        updated_at = _validate_listings(raw)
        nearby_cache_raw = _nearby_cache_for_upload(previous_nearby_fetched_at)
        previous = kv.get_json(META_KEY, missing_ok=True)
        if previous:
            previous_time = _parse_time(previous.get("updatedAt"))
            next_time = _parse_time(updated_at)
            if previous_time is not None and next_time is not None and next_time < previous_time:
                raise RuntimeError("현재 데이터보다 오래된 수집 결과입니다.")

        completed_at = _iso_now()
        # Cache first: if this write fails the previously published listings stay
        # untouched, and a successful write prevents a retry from hitting Overpass.
        kv.put_bytes(NEARBY_CACHE_KEY, nearby_cache_raw)
        kv.put_bytes(LISTINGS_KEY, raw)
        kv.put_json(
            META_KEY,
            {"updatedAt": updated_at, "storedAt": completed_at, "size": len(raw)},
        )
        kv.put_json(
            STATE_KEY,
            {
                **claimed,
                "status": "succeeded",
                "completedAt": completed_at,
                "updatedAt": updated_at,
                "message": "최신 매물 데이터로 갱신했습니다.",
            },
        )
        print(f"[{completed_at}] 새로고침 완료: {updated_at}", flush=True)
    except Exception as error:
        kv.put_json(
            STATE_KEY,
            {
                **claimed,
                "status": "failed",
                "completedAt": _iso_now(),
                "message": f"수집 결과 반영에 실패했습니다. {str(error)[:300]}",
            },
        )
        raise
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="수동 매물 새로고침 KV 에이전트")
    parser.add_argument(
        "--namespace-id",
        default=os.environ.get("MIARE_REFRESH_KV_NAMESPACE_ID", DEFAULT_NAMESPACE_ID),
    )
    parser.add_argument("--poll-seconds", type=float, default=10.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument(
        "--job-id",
        help="workflow_dispatch가 전달한 작업 ID와 KV pending 작업이 같은지 검증합니다.",
    )
    args = parser.parse_args()
    if args.poll_seconds < 3:
        parser.error("--poll-seconds는 3 이상이어야 합니다.")

    kv = KvClient(args.namespace_id)
    while True:
        try:
            processed = process_once(kv, expected_job_id=args.job_id)
            if args.once:
                if args.job_id and not processed:
                    raise RuntimeError("요청한 새로고침 작업이 처리되지 않았습니다.")
                return 0
            time.sleep(1 if processed else args.poll_seconds)
        except KeyboardInterrupt:
            return 0
        except Exception as error:
            print(f"[{_iso_now()}] {error}", file=sys.stderr, flush=True)
            if args.once:
                return 1
            time.sleep(max(args.poll_seconds, 15))


if __name__ == "__main__":
    raise SystemExit(main())
