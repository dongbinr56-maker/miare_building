# -*- coding: utf-8 -*-
"""직전 최종 스냅샷과 새 최종 스냅샷의 사용자용 변경 이력 계산."""

from __future__ import annotations

import math
import re
from typing import Any


MAX_CHANGE_EVENTS = 500
RELIST_COORDINATE_RADIUS_M = 30
RELIST_PRECISE_LOCATIONS = {"building", "complex"}


def _listing_ids(item: dict[str, Any]) -> set[str]:
    values: list[object] = [item.get("id")]
    merged = item.get("mergedListingIds")
    if isinstance(merged, list):
        values.extend(merged)
    return {
        value.strip()
        for value in values
        if isinstance(value, str)
        and re.fullmatch(r"(?:naver|daangn):\d+", value.strip())
    }


def _normalized_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _normalized_address(value: object) -> str:
    return re.sub(r"[\s,.-]+", "", str(value or "")).strip().lower()


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _coordinate(item: dict[str, Any]) -> tuple[float, float] | None:
    lat = _number(item.get("lat"))
    lon = _number(item.get("lon"))
    if lat is None or lon is None or abs(lat) < 0.001 or abs(lon) < 0.001:
        return None
    return lat, lon


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    radius = 6_371_000.0
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    d_lat = lat2 - lat1
    d_lon = lon2 - lon1
    hav = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(hav))


def _same_building(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    if _normalized_text(previous.get("dong")) != _normalized_text(current.get("dong")):
        return False

    previous_addresses = {
        normalized
        for normalized in (
            _normalized_address(previous.get("roadAddress")),
            _normalized_address(previous.get("jibunAddress")),
        )
        if normalized
    }
    current_addresses = {
        normalized
        for normalized in (
            _normalized_address(current.get("roadAddress")),
            _normalized_address(current.get("jibunAddress")),
        )
        if normalized
    }
    if previous_addresses & current_addresses:
        return True

    if (
        previous.get("locationConfidence") != "high"
        or current.get("locationConfidence") != "high"
        or previous.get("locationPrecision") not in RELIST_PRECISE_LOCATIONS
        or current.get("locationPrecision") not in RELIST_PRECISE_LOCATIONS
    ):
        return False
    previous_coordinate = _coordinate(previous)
    current_coordinate = _coordinate(current)
    return bool(
        previous_coordinate
        and current_coordinate
        and _haversine_m(previous_coordinate, current_coordinate)
        <= RELIST_COORDINATE_RADIUS_M
    )


def _same_unit_signature(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    previous_floor = _number(previous.get("floor"))
    current_floor = _number(current.get("floor"))
    if (
        previous_floor is None
        or current_floor is None
        or previous_floor != current_floor
    ):
        return False
    previous_area = _number(previous.get("areaM2"))
    current_area = _number(current.get("areaM2"))
    if previous_area is None or current_area is None:
        return False
    return abs(previous_area - current_area) <= 1.0


def _relist_candidate(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    return _same_building(previous, current) and _same_unit_signature(previous, current)


def _summary(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "source": item.get("source"),
        "dong": _normalized_text(item.get("dong")),
        "name": _normalized_text(item.get("name")),
        "deposit": item.get("deposit"),
        "rent": item.get("rent"),
        "floor": item.get("floor"),
        "areaM2": item.get("areaM2"),
        "link": item.get("link"),
    }


def _event(
    event_type: str,
    current: dict[str, Any] | None,
    previous: dict[str, Any] | None,
    *,
    changes: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current_id = str((current or {}).get("id") or "")
    previous_id = str((previous or {}).get("id") or "")
    result: dict[str, Any] = {
        "eventId": f"{event_type}:{current_id}:{previous_id}",
        "type": event_type,
        "listingId": current_id or previous_id,
        "current": _summary(current) if current else None,
        "previous": _summary(previous) if previous else None,
    }
    if changes:
        result["changes"] = changes
    if event_type == "relisted":
        result["confidence"] = "high"
    return result


def _content_change_events(
    current: dict[str, Any],
    previous: dict[str, Any],
) -> list[dict[str, Any]]:
    """같은 매물 정체성에서 가격·설명 변화 이벤트를 모두 만든다."""
    events: list[dict[str, Any]] = []
    price_changes: dict[str, Any] = {}
    for field in ("deposit", "rent"):
        if previous.get(field) != current.get(field):
            price_changes[field] = {
                "before": previous.get(field),
                "after": current.get(field),
            }
    if price_changes:
        events.append(_event("price_changed", current, previous, changes=price_changes))
    if _normalized_text(previous.get("desc")) != _normalized_text(current.get("desc")):
        events.append(_event("description_changed", current, previous))
    return events


def _stable_matches(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
) -> tuple[dict[int, int], set[int], set[int]]:
    candidates: list[tuple[int, int, int]] = []
    previous_ids = [_listing_ids(item) for item in previous]
    current_ids = [_listing_ids(item) for item in current]
    for current_index, ids in enumerate(current_ids):
        if not ids:
            continue
        for previous_index, old_ids in enumerate(previous_ids):
            overlap = len(ids & old_ids)
            if overlap:
                candidates.append((-overlap, current_index, previous_index))

    matches: dict[int, int] = {}
    used_previous: set[int] = set()
    used_current: set[int] = set()
    for _, current_index, previous_index in sorted(candidates):
        if current_index in used_current or previous_index in used_previous:
            continue
        matches[current_index] = previous_index
        used_current.add(current_index)
        used_previous.add(previous_index)
    return matches, used_previous, used_current


def _relist_matches(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
    unmatched_previous: set[int],
    unmatched_current: set[int],
) -> dict[int, int]:
    current_candidates = {
        current_index: [
            previous_index
            for previous_index in unmatched_previous
            if _relist_candidate(previous[previous_index], current[current_index])
        ]
        for current_index in unmatched_current
    }
    previous_candidate_counts: dict[int, int] = {}
    for candidates in current_candidates.values():
        for previous_index in candidates:
            previous_candidate_counts[previous_index] = (
                previous_candidate_counts.get(previous_index, 0) + 1
            )

    # 양쪽 모두 후보가 하나뿐인 경우에만 새 번호 재등록으로 판정한다.
    return {
        current_index: candidates[0]
        for current_index, candidates in current_candidates.items()
        if len(candidates) == 1 and previous_candidate_counts.get(candidates[0]) == 1
    }


def build_change_history(
    previous_data: dict[str, Any] | None,
    current_listings: list[dict[str, Any]],
    current_updated_at: str,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """변경 이력 JSON과 현재 ID→직전 매물 identity 맵을 반환한다."""
    previous_raw = (previous_data or {}).get("listings")
    previous = [item for item in previous_raw or [] if isinstance(item, dict)]
    current = [item for item in current_listings if isinstance(item, dict)]
    previous_updated_at = (previous_data or {}).get("updatedAt")
    if not previous:
        return (
            {
                "version": 1,
                "baseline": True,
                "comparedAt": None,
                "currentAt": current_updated_at,
                "counts": {
                    "new": 0,
                    "priceChanged": 0,
                    "descriptionChanged": 0,
                    "deleted": 0,
                    "relisted": 0,
                },
                "events": [],
            },
            {},
        )

    stable, used_previous, used_current = _stable_matches(previous, current)
    unmatched_previous = set(range(len(previous))) - used_previous
    unmatched_current = set(range(len(current))) - used_current
    relisted = _relist_matches(previous, current, unmatched_previous, unmatched_current)
    used_previous.update(relisted.values())
    used_current.update(relisted)

    identity_map: dict[str, dict[str, Any]] = {}
    events: list[dict[str, Any]] = []
    for current_index, previous_index in stable.items():
        current_item = current[current_index]
        previous_item = previous[previous_index]
        identity_map[str(current_item.get("id"))] = previous_item
        events.extend(_content_change_events(current_item, previous_item))

    for current_index, previous_index in relisted.items():
        current_item = current[current_index]
        previous_item = previous[previous_index]
        identity_map[str(current_item.get("id"))] = previous_item
        events.append(_event("relisted", current_item, previous_item))
        # 새 번호 재등록도 동일 매물의 연속선이다. 재등록 사실과 함께 이번
        # 수집에서 바뀐 가격·설명을 별도 이벤트로 남긴다.
        events.extend(_content_change_events(current_item, previous_item))

    for current_index in sorted(set(range(len(current))) - used_current):
        events.append(_event("new", current[current_index], None))
    for previous_index in sorted(set(range(len(previous))) - used_previous):
        events.append(_event("deleted", None, previous[previous_index]))

    priority = {
        "relisted": 0,
        "price_changed": 1,
        "new": 2,
        "description_changed": 3,
        "deleted": 4,
    }
    events.sort(
        key=lambda item: (
            priority.get(str(item.get("type")), 99),
            str(((item.get("current") or item.get("previous") or {}).get("dong"))),
            str(item.get("listingId")),
        )
    )
    counts = {
        "new": sum(event["type"] == "new" for event in events),
        "priceChanged": sum(event["type"] == "price_changed" for event in events),
        "descriptionChanged": sum(event["type"] == "description_changed" for event in events),
        "deleted": sum(event["type"] == "deleted" for event in events),
        "relisted": sum(event["type"] == "relisted" for event in events),
    }
    return (
        {
            "version": 1,
            "baseline": False,
            "comparedAt": previous_updated_at if isinstance(previous_updated_at, str) else None,
            "currentAt": current_updated_at,
            "counts": counts,
            "events": events[:MAX_CHANGE_EVENTS],
            "truncated": len(events) > MAX_CHANGE_EVENTS,
        },
        identity_map,
    )
