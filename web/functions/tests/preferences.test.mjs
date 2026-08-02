import assert from "node:assert/strict";
import test from "node:test";

import {
  onRequestGet as getPreferences,
  onRequestPut as putPreferences,
} from "../api/preferences.ts";

class FakeKv {
  values = new Map();

  async get(key, format) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return format === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

function request(kind, method = "GET", data) {
  return new Request(`https://snapspot.example/api/preferences?kind=${kind}`, {
    method,
    headers: method === "PUT" ? {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "application/json",
    } : undefined,
    body: data === undefined ? undefined : JSON.stringify({ data }),
  });
}

function context(kv, email, req) {
  return { env: { REFRESH_KV: kv }, data: { accessEmail: email }, request: req };
}

const listing = {
  id: "naver:123",
  source: "naver",
  name: "테스트 매물",
  dong: "신가동",
  deposit: 500,
  rent: 60,
};

test("즐겨찾기는 검증된 이메일 해시별 KV에 분리 저장된다", async () => {
  const kv = new FakeKv();
  const first = await getPreferences(context(
    kv,
    "One@Example.com",
    request("favorites"),
  ));
  const empty = await first.json();
  assert.equal(first.status, 200);
  assert.equal(empty.exists, false);
  assert.match(empty.accountId, /^[a-f0-9]{64}$/);

  const savedResponse = await putPreferences(context(
    kv,
    "one@example.com",
    request("favorites", "PUT", { "naver:123": listing }),
  ));
  assert.equal(savedResponse.status, 200);
  assert.equal(kv.values.size, 1);
  const [storedKey] = kv.values.keys();
  assert.match(storedKey, /^user-preferences:v1:[a-f0-9]{64}:favorites$/);
  assert.equal(storedKey.includes("one@example.com"), false);

  const sameAccount = await getPreferences(context(
    kv,
    "ONE@example.com",
    request("favorites"),
  ));
  assert.deepEqual((await sameAccount.json()).data, { "naver:123": listing });

  const otherAccount = await getPreferences(context(
    kv,
    "two@example.com",
    request("favorites"),
  ));
  assert.equal((await otherAccount.json()).exists, false);
});

test("관심없음 저장은 차단 ID와 항목의 일치를 검증한다", async () => {
  const kv = new FakeKv();
  const valid = {
    version: 1,
    blockedIds: ["naver:123", "daangn:456"],
    entries: [{
      entryId: "entry-1",
      listingIds: ["naver:123", "daangn:456"],
      listing,
      hiddenAt: "2026-08-02T12:00:00Z",
    }],
  };
  const saved = await putPreferences(context(
    kv,
    "one@example.com",
    request("hidden", "PUT", valid),
  ));
  assert.equal(saved.status, 200);

  const malformed = { ...valid, blockedIds: ["naver:999"] };
  const rejected = await putPreferences(context(
    kv,
    "one@example.com",
    request("hidden", "PUT", malformed),
  ));
  assert.equal(rejected.status, 400);
});

test("설정 쓰기는 동일 출처와 미들웨어 인증 이메일이 모두 필요하다", async () => {
  const kv = new FakeKv();
  const crossOrigin = new Request(
    "https://snapspot.example/api/preferences?kind=favorites",
    {
      method: "PUT",
      headers: {
        Origin: "https://attacker.example",
        "X-Requested-With": "miare-dashboard",
      },
      body: JSON.stringify({ data: {} }),
    },
  );
  const forbidden = await putPreferences(context(kv, "one@example.com", crossOrigin));
  assert.equal(forbidden.status, 403);

  const unauthenticated = await getPreferences({
    env: { REFRESH_KV: kv },
    data: {},
    request: request("favorites"),
  });
  assert.equal(unauthenticated.status, 401);
});
