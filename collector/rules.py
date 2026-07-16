# -*- coding: utf-8 -*-
"""매물 조건 평가 공통 로직 (네이버/당근 수집기 공용)"""


def evaluate(deposit, rent, floor, pyeong, criteria):
    """조건 체크 dict와 매치 레벨을 반환한다. 가격 단위는 만원, 면적은 평."""
    checks = {
        "deposit": deposit is not None and deposit <= criteria["depositMax"],
        "rent": rent is not None and rent <= criteria["rentMax"],
        "floor": floor == 1 if criteria.get("requireFirstFloor") else True,
        "pyeong": (pyeong is not None
                   and criteria["pyeongMin"] <= pyeong <= criteria["pyeongMax"]),
    }
    passed = sum(checks.values())
    match_level = "full" if passed == 4 else ("near" if passed == 3 else "low")
    return checks, match_level
