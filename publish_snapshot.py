"""엄격 검증을 통과한 비공개 스냅샷을 운영 KV에 게시한다."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any

from refresh_agent import (
    DEFAULT_NAMESPACE_ID,
    LISTINGS_KEY,
    META_KEY,
    KvClient,
    _validate_listings,
)


def publish_verified_snapshot(
    kv: Any,
    raw: bytes,
    expected_sha256: str,
) -> dict[str, Any]:
    actual_sha256 = hashlib.sha256(raw).hexdigest()
    if actual_sha256 != expected_sha256.lower():
        raise RuntimeError("스냅샷 SHA-256이 전송 전 값과 일치하지 않습니다.")
    updated_at = _validate_listings(raw)
    payload = json.loads(raw)

    previous_text = kv.get_text(LISTINGS_KEY, missing_ok=True)
    previous_meta = kv.get_json(META_KEY, missing_ok=True)
    if previous_text is None:
        raise RuntimeError("복구 가능한 기존 운영 스냅샷이 없어 게시를 중단했습니다.")

    try:
        kv.put_bytes(LISTINGS_KEY, raw)
        stored_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        kv.put_json(
            META_KEY,
            {
                "updatedAt": updated_at,
                "storedAt": stored_at,
                "size": len(raw),
                "sha256": actual_sha256,
            },
        )
        readback = (kv.get_text(LISTINGS_KEY) or "").encode("utf-8")
        _validate_listings(readback)
        if hashlib.sha256(readback).hexdigest() != actual_sha256:
            raise RuntimeError("KV 게시 후 읽기 검증 해시가 일치하지 않습니다.")
    except Exception as error:
        rollback_errors: list[str] = []
        try:
            kv.put_bytes(LISTINGS_KEY, previous_text.encode("utf-8"))
        except Exception as rollback_error:  # pragma: no cover
            rollback_errors.append(str(rollback_error))
        if previous_meta is not None:
            try:
                kv.put_json(META_KEY, previous_meta)
            except Exception as rollback_error:  # pragma: no cover
                rollback_errors.append(str(rollback_error))
        suffix = f"; 롤백 오류: {' | '.join(rollback_errors)}" if rollback_errors else ""
        raise RuntimeError(f"스냅샷 게시 실패 후 기존 값을 복구했습니다: {error}{suffix}") from error

    return {
        "updatedAt": updated_at,
        "listings": len(payload["listings"]),
        "new": payload["stats"]["new"],
        "changeCounts": payload["changeHistory"]["counts"],
        "sha256": actual_sha256,
        "readbackVerified": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--namespace-id", default=DEFAULT_NAMESPACE_ID)
    args = parser.parse_args()
    if len(args.expected_sha256) != 64 or any(
        character not in "0123456789abcdefABCDEF" for character in args.expected_sha256
    ):
        raise SystemExit("expected SHA-256 must be 64 hexadecimal characters")
    summary = publish_verified_snapshot(
        KvClient(args.namespace_id),
        args.path.read_bytes(),
        args.expected_sha256,
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
