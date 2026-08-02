# -*- coding: utf-8 -*-
"""매물 조건 평가 공통 로직 (네이버/당근 수집기 공용)."""

import math
import re


PREMIUM_PRESENT = "present"
PREMIUM_NONE = "none"
PREMIUM_UNKNOWN = "unknown"

EXPLICIT_NO_PREMIUM_RE = re.compile(
    r"(?:무\s*권리(?:금)?|권리금\s*(?:은|는|이|가)?\s*(?:[:：=\-]\s*)?없(?:음|습니다|어요))",
    re.IGNORECASE,
)
EXPLICIT_PREMIUM_AMOUNT_RE = re.compile(
    r"권리금\s*(?:은|는|이|가)?\s*(?:[:：=\-]\s*)?"
    r"(?P<amount>\d+(?:,\d{3})*(?:\.\d+)?)\s*(?P<unit>만원|억)",
    re.IGNORECASE,
)
NO_PREMIUM_PREFIX_CONTRADICTION_RE = re.compile(
    r"(?:아님|아닙|아니|아닌|아닐)\s*[:：,，\-]?\s*$",
    re.IGNORECASE,
)
NO_PREMIUM_CONTRADICTION_RE = re.compile(
    r"^(?:\s|[,，:：-])*"
    r"(?:"
    r"(?:인\s*)?(?:매물\s*)?(?:은|는|이|가|도)?\s*(?:아님|아닙|아니|아닌|아닐)"
    r"|(?:이?라고)\s*볼\s*수\s*없"
    r"|(?:은|는|이|가)?\s*(?:거짓|허위)"
    r"|(?:에\s*)?해당하지\s*않"
    r"|[?？]"
    r"|(?:매물\s*)?(?:인가요|인지|맞나요|맞습니까|맞는지)"
    r"|여부(?:는|가|를)?(?:\s|[?？])*"
    r"|(?:으?로\s*)?(?:미확인|확인\s*(?:필요|요망)|문의)"
    r")",
    re.IGNORECASE,
)
PREMIUM_STATUSES = {PREMIUM_PRESENT, PREMIUM_NONE, PREMIUM_UNKNOWN}


def normalize_premium_amount(premium):
    """권리금 금액을 비교 가능한 숫자로 정규화한다.

    API의 금액 단위는 만원이다. ``None``/빈 문자열/비정상 값/음수는 금액
    근거로 사용하지 않는다. bool은 Python에서 int의 하위 타입이지만 금액이
    아니므로 명시적으로 거부한다.
    """
    if premium is None or isinstance(premium, bool):
        return None
    if isinstance(premium, str):
        value = premium.strip()
        if not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", value):
            return None
        premium = value.replace(",", "")
    try:
        amount = float(premium)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(amount) or amount < 0:
        return None
    return int(amount) if amount.is_integer() else amount


def explicit_no_premium_evidence(text):
    """명시적 무권리 문구를 반환하되 같은 절의 부정·거짓 표현은 거부한다."""
    if not isinstance(text, str) or not text.strip():
        return None
    for match in EXPLICIT_NO_PREMIUM_RE.finditer(text):
        prefix = text[max(0, match.start() - 32):match.start()]
        if NO_PREMIUM_PREFIX_CONTRADICTION_RE.search(prefix):
            continue
        # 문구 바로 뒤에서 의미를 뒤집는 표현은 무권리 근거로 쓰지 않는다.
        # 패턴을 문자열 시작에 고정해 뒤에 나오는 별개 조건(예: 주차 불가)이
        # 무권리 판정에 영향을 주지 않게 한다.
        tail = text[match.end():match.end() + 48]
        same_sentence_tail = re.split(r"[.!。！\n\r]", tail, maxsplit=1)[0]
        if (
            "?" in same_sentence_tail
            or "？" in same_sentence_tail
            or NO_PREMIUM_CONTRADICTION_RE.search(tail)
        ):
            continue
        return match.group(0).strip()
    return None


def explicit_premium_amount_evidence(text):
    """설명에 명시된 양수 권리금 금액과 원문을 만원 단위로 반환한다."""
    if not isinstance(text, str) or not text.strip():
        return None
    found = []
    for match in EXPLICIT_PREMIUM_AMOUNT_RE.finditer(text):
        amount = normalize_premium_amount(match.group("amount"))
        if amount is None:
            continue
        if match.group("unit") == "억":
            amount *= 10_000
        # 설명의 0원은 구조화 0원이 아니므로 무권리 근거로 승격하지 않는다.
        if amount > 0:
            found.append({"amount": amount, "matchedText": match.group(0).strip()})
    return max(found, key=lambda evidence: evidence["amount"]) if found else None


def has_valid_no_premium_evidence(item):
    """구조화 0원 또는 허용된 명시 문구 근거만 무권리 증거로 인정한다."""
    raw_amount = item.get("premiumMoney")
    if raw_amount is not None and premium_status_from_amount(raw_amount) == PREMIUM_NONE:
        return True

    evidence = item.get("premiumEvidence")
    if not isinstance(evidence, dict):
        return False
    source = evidence.get("source")
    field = evidence.get("field")
    # 구조화 0원은 위의 실제 premiumMoney 필드로만 증명한다. evidence 안에
    # value=0을 임의로 넣는 것만으로는 원본 금액과 결합되지 않으므로 거부한다.
    matched_text = evidence.get("matchedText")
    if not isinstance(matched_text, str):
        return False
    context = evidence.get("contextText")
    if not (
        isinstance(context, str)
        and matched_text in context
        and explicit_no_premium_evidence(context) == matched_text
        and explicit_no_premium_evidence(item.get("desc")) is not None
    ):
        return False

    listing_ids = {item.get("id")}
    merged_ids = item.get("mergedListingIds")
    if isinstance(merged_ids, (list, tuple, set)):
        listing_ids.update(merged_ids)
    article_url = evidence.get("articleUrl")
    if source == "daangn_public_detail" and field in {
        "content",
        "premiumMoneyDescription",
    }:
        return any(
            article_url == f"https://realty.daangn.com/articles/{listing_id.split(':', 1)[1]}"
            for listing_id in listing_ids
            if isinstance(listing_id, str) and listing_id.startswith("daangn:")
        )
    if source == "naver_list_description" and field == "articleFeatureDesc":
        return any(
            article_url == f"https://new.land.naver.com/offices?articleNo={listing_id.split(':', 1)[1]}"
            for listing_id in listing_ids
            if isinstance(listing_id, str) and listing_id.startswith("naver:")
        )
    return False


def premium_status_from_amount(premium):
    """구조화된 권리금 금액을 ``present/none/unknown``으로 분류한다.

    명시적인 0만원만 무권리다. 0보다 크면 액수와 무관하게 권리금 있음이며,
    미기재 또는 비정상 값은 확인 불가다.
    """
    amount = normalize_premium_amount(premium)
    if amount is None:
        return PREMIUM_UNKNOWN
    if amount > 0:
        return PREMIUM_PRESENT
    return PREMIUM_NONE


def is_no_premium_amount(premium):
    """당근 권리금 금액이 명시적인 무권리 표기인지 판별한다.

    0만원만 통과시킨다. 미표기(None)는 확인 필요, 양수는 권리금 있음이다.
    """
    return premium_status_from_amount(premium) == PREMIUM_NONE


def audit_premium_classifications(listings, regression_ids=("daangn:2970853",)):
    """수집 결과의 권리금 보수 분류 불변식을 검사한다.

    반환된 ``totalViolations``가 0이 아니면 기존 결과를 덮어쓰지 않아야 한다.
    ``regression_ids``는 과거 오탐 매물이 병합 대표 ID 뒤에 숨은 경우까지
    ``mergedListingIds``를 따라 검사한다.
    """
    result = {
        "positiveMisclassified": 0,
        "noPremiumWithoutEvidence": 0,
        "regressionListingSelected": 0,
        "classificationInconsistent": 0,
        "selectedWithoutNoPremiumProof": 0,
        "totalViolations": 0,
    }
    regression_ids = set(regression_ids)

    for item in listings:
        raw_amount = item.get("premiumMoney")
        amount_status = premium_status_from_amount(raw_amount)
        declared_status = item.get("premiumStatus")
        checks = item.get("checks") or {}
        premium_check = checks.get("premium") is True
        no_premium = item.get("noPremium") is True
        evidence_ok = has_valid_no_premium_evidence(item)

        if amount_status == PREMIUM_PRESENT and (
            no_premium
            or declared_status != PREMIUM_PRESENT
            or premium_check
            or item.get("matchLevel") == "full"
        ):
            result["positiveMisclassified"] += 1

        if no_premium and not evidence_ok:
            result["noPremiumWithoutEvidence"] += 1

        expected_no_premium = declared_status == PREMIUM_NONE
        amount_conflict = (
            raw_amount is not None
            and amount_status != PREMIUM_UNKNOWN
            and declared_status != amount_status
        )
        merged_ids = item.get("mergedListingIds")
        merged_ids_invalid = merged_ids is not None and not (
            isinstance(merged_ids, (list, tuple, set))
            and bool(merged_ids)
            and item.get("id") in merged_ids
            and len(merged_ids) == len(set(merged_ids))
            and all(
                isinstance(value, str)
                and re.fullmatch(r"(?:naver|daangn):\d+", value)
                for value in merged_ids
            )
        )
        if (
            declared_status not in PREMIUM_STATUSES
            or amount_conflict
            or no_premium != expected_no_premium
            or ("premium" in checks and premium_check != no_premium)
            or (declared_status == PREMIUM_NONE and not evidence_ok)
            or (declared_status == PREMIUM_PRESENT and amount_status != PREMIUM_PRESENT)
            or merged_ids_invalid
        ):
            result["classificationInconsistent"] += 1

        selected = premium_check or item.get("matchLevel") == "full"
        if selected and not (
            declared_status == PREMIUM_NONE
            and no_premium
            and premium_check
            and evidence_ok
        ):
            result["selectedWithoutNoPremiumProof"] += 1

        listing_ids = {item.get("id")}
        if isinstance(merged_ids, (list, tuple, set)):
            listing_ids.update(merged_ids)
        elif isinstance(merged_ids, str):
            listing_ids.add(merged_ids)
        if (
            regression_ids.intersection(listing_ids)
            and (premium_check or item.get("matchLevel") == "full")
        ):
            result["regressionListingSelected"] += 1

    result["totalViolations"] = sum(
        result[key]
        for key in (
            "positiveMisclassified",
            "noPremiumWithoutEvidence",
            "regressionListingSelected",
            "classificationInconsistent",
            "selectedWithoutNoPremiumProof",
        )
    )
    return result


def evaluate(deposit, rent, floor, no_premium, criteria):
    """조건 체크 dict와 매치 레벨을 반환한다. 가격 단위는 만원이다.

    월세는 관리비가 포함되지 않은 순수 월세다. 새 설정인 ``rentMax``는
    상한을 포함하고, 이전 스냅샷/설정의 ``rentMaxExclusive``도 하위 호환한다.
    면적과 주차 여부는 매칭 등급에 사용하지 않는다.
    """
    if "rentMax" in criteria:
        rent_ok = rent is not None and rent <= criteria["rentMax"]
    else:
        rent_ok = rent is not None and rent < criteria["rentMaxExclusive"]

    checks = {
        "deposit": (deposit is not None
                    and criteria["depositMin"] <= deposit <= criteria["depositMax"]),
        "rent": rent_ok,
        "floor": (floor is not None
                  and criteria["floorMin"] <= floor <= criteria["floorMax"]),
        "premium": bool(no_premium) if criteria.get("requireNoPremium") else True,
    }
    passed = sum(checks.values())
    match_level = "full" if passed == 4 else ("near" if passed == 3 else "low")
    return checks, match_level
