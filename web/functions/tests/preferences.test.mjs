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

function request(kind, method = "GET", data, accountId) {
  return new Request(`https://snapspot.example/api/preferences?kind=${kind}`, {
    method,
    headers: method === "PUT" ? {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "application/json",
    } : undefined,
    body: data === undefined ? undefined : JSON.stringify({
      data,
      ...(accountId ? { accountId } : {}),
    }),
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

test("개인 메모는 플랫폼 ID별로 저장되고 인증 이메일 계정 간 분리된다", async () => {
  const kv = new FakeKv();
  const identityResponse = await getPreferences(context(
    kv,
    "owner@example.com",
    request("notes"),
  ));
  const { accountId } = await identityResponse.json();
  const notes = {
    version: 1,
    entries: {
      "naver:123": {
        noteId: "note-merged-1",
        text: "사진관 전기 용량 확인\n<img src=x onerror=alert(1)>",
        updatedAt: "2026-08-03T01:00:00Z",
      },
      "daangn:456": {
        noteId: "note-merged-1",
        text: "사진관 전기 용량 확인\n<img src=x onerror=alert(1)>",
        updatedAt: "2026-08-03T01:00:00Z",
      },
    },
  };

  const saved = await putPreferences(context(
    kv,
    "owner@example.com",
    request("notes", "PUT", notes, accountId),
  ));
  assert.equal(saved.status, 200);
  const [storedKey] = kv.values.keys();
  assert.match(storedKey, /^user-preferences:v1:[a-f0-9]{64}:notes$/);
  assert.equal(storedKey.includes("owner@example.com"), false);

  const sameAccount = await getPreferences(context(
    kv,
    "OWNER@example.com",
    request("notes"),
  ));
  assert.deepEqual((await sameAccount.json()).data, notes);

  const otherAccount = await getPreferences(context(
    kv,
    "other@example.com",
    request("notes"),
  ));
  const otherBody = await otherAccount.json();
  assert.equal(otherBody.exists, false);
  assert.deepEqual(otherBody.data, { version: 1, entries: {} });
});

test("개인 메모는 ID·타입·길이·본문 크기·JSON Content-Type을 검증한다", async () => {
  const kv = new FakeKv();
  const identityResponse = await getPreferences(context(
    kv,
    "owner@example.com",
    request("notes"),
  ));
  const { accountId } = await identityResponse.json();
  const note = {
    noteId: "note-1",
    text: "현장 확인",
    updatedAt: "2026-08-03T01:00:00Z",
  };

  for (const invalid of [
    { version: 1, entries: { "other:123": note } },
    { version: 1, entries: { "naver:123": { ...note, text: 123 } } },
    { version: 1, entries: { "naver:123": { ...note, text: "가".repeat(1_001) } } },
    { version: 1, entries: { "naver:123": { ...note, text: "   " } } },
    {
      version: 1,
      entries: {
        "naver:123": note,
        "daangn:456": { ...note, text: "같은 noteId의 상충 내용" },
      },
    },
  ]) {
    const response = await putPreferences(context(
      kv,
      "owner@example.com",
      request("notes", "PUT", invalid, accountId),
    ));
    assert.equal(response.status, 400);
  }

  const wrongType = new Request("https://snapspot.example/api/preferences?kind=notes", {
    method: "PUT",
    headers: {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "text/plain",
    },
    body: JSON.stringify({ accountId, data: { version: 1, entries: {} } }),
  });
  assert.equal(
    (await putPreferences(context(kv, "owner@example.com", wrongType))).status,
    415,
  );

  const oversized = new Request("https://snapspot.example/api/preferences?kind=notes", {
    method: "PUT",
    headers: {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "application/json",
    },
    body: "x".repeat(512 * 1024 + 1),
  });
  assert.equal(
    (await putPreferences(context(kv, "owner@example.com", oversized))).status,
    413,
  );

  const changedAccount = await putPreferences(context(
    kv,
    "owner@example.com",
    request("notes", "PUT", { version: 1, entries: {} }, "0".repeat(64)),
  ));
  assert.equal(changedAccount.status, 409);
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
