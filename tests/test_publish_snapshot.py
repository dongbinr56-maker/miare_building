import hashlib
import json
import unittest

from publish_snapshot import publish_verified_snapshot
from test_refresh_agent import listing_data


class FakeKv:
    def __init__(self, previous: bytes, *, corrupt_readback: bool = False):
        self.values = {
            "listings:latest": previous,
            "listings:meta": {"updatedAt": "old"},
        }
        self.corrupt_readback = corrupt_readback
        self.listing_writes = 0

    def get_text(self, key, *, missing_ok=False):
        del missing_ok
        value = self.values.get(key)
        if value is None:
            return None
        if key == "listings:latest" and self.corrupt_readback and self.listing_writes == 1:
            return "{}"
        return value.decode() if isinstance(value, bytes) else str(value)

    def get_json(self, key, *, missing_ok=False):
        del missing_ok
        value = self.values.get(key)
        return json.loads(json.dumps(value)) if isinstance(value, dict) else None

    def put_bytes(self, key, value):
        if key == "listings:latest":
            self.listing_writes += 1
        self.values[key] = bytes(value)

    def put_json(self, key, value):
        self.values[key] = json.loads(json.dumps(value))


def valid_raw() -> bytes:
    return json.dumps(listing_data(), ensure_ascii=False).encode()


class PublishSnapshotTests(unittest.TestCase):
    def test_verified_snapshot_is_published_and_read_back(self):
        raw = valid_raw()
        kv = FakeKv(b'{"old":true}')
        summary = publish_verified_snapshot(kv, raw, hashlib.sha256(raw).hexdigest())
        self.assertTrue(summary["readbackVerified"])
        self.assertEqual(summary["listings"], 1)
        self.assertEqual(kv.values["listings:latest"], raw)

    def test_hash_mismatch_never_touches_kv(self):
        raw = valid_raw()
        previous = b'{"old":true}'
        kv = FakeKv(previous)
        with self.assertRaisesRegex(RuntimeError, "SHA-256"):
            publish_verified_snapshot(kv, raw, "0" * 64)
        self.assertEqual(kv.values["listings:latest"], previous)
        self.assertEqual(kv.listing_writes, 0)

    def test_failed_readback_restores_previous_snapshot_and_meta(self):
        raw = valid_raw()
        previous = b'{"old":true}'
        kv = FakeKv(previous, corrupt_readback=True)
        with self.assertRaisesRegex(RuntimeError, "복구"):
            publish_verified_snapshot(kv, raw, hashlib.sha256(raw).hexdigest())
        self.assertEqual(kv.values["listings:latest"], previous)
        self.assertEqual(kv.values["listings:meta"], {"updatedAt": "old"})


if __name__ == "__main__":
    unittest.main()
