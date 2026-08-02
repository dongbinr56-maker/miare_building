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

function workspaceRequest(data, expectedAccountId, method = "PUT") {
  return new Request("https://snapspot.example/api/preferences?kind=workspace", {
    method,
    headers: method === "PUT" ? {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "application/json",
    } : undefined,
    body: data === undefined ? undefined : JSON.stringify({ expectedAccountId, data }),
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
    request("favorites", "PUT", { "naver:123": listing }, empty.accountId),
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
  const identityResponse = await getPreferences(context(
    kv,
    "one@example.com",
    request("hidden"),
  ));
  const { accountId } = await identityResponse.json();
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
    request("hidden", "PUT", valid, accountId),
  ));
  assert.equal(saved.status, 200);

  const malformed = { ...valid, blockedIds: ["naver:999"] };
  const rejected = await putPreferences(context(
    kv,
    "one@example.com",
    request("hidden", "PUT", malformed, accountId),
  ));
  assert.equal(rejected.status, 400);
});

test("모든 개인 설정 PUT은 GET에서 받은 계정 ID가 바뀌면 저장하지 않는다", async () => {
  const kv = new FakeKv();
  for (const [kind, data] of [
    ["favorites", {}],
    ["hidden", { version: 1, blockedIds: [], entries: [] }],
  ]) {
    const response = await putPreferences(context(
      kv,
      "owner@example.com",
      request(kind, "PUT", data, "0".repeat(64)),
    ));
    assert.equal(response.status, 409);
  }
  assert.equal(kv.values.size, 0);
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

test("후보 작업공간은 인증 계정별 KV에 저장되고 빈 상태를 명시한다", async () => {
  const kv = new FakeKv();
  const emptyResponse = await getPreferences(context(
    kv,
    "Owner@Example.com",
    request("workspace"),
  ));
  const empty = await emptyResponse.json();
  assert.equal(emptyResponse.status, 200);
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.data, { version: 1, workflow: {}, compareEntries: [] });

  const updatedAt = "2026-08-03T04:00:00Z";
  const workspace = {
    version: 1,
    workflow: {
      "naver:123": { workflowId: "workflow-1", status: "visit", updatedAt },
      "daangn:456": { workflowId: "workflow-1", status: "visit", updatedAt },
    },
    compareEntries: [{
      entryId: "compare-1",
      listingIds: ["naver:123", "daangn:456"],
      addedAt: "2026-08-03T03:00:00Z",
    }],
  };
  const saved = await putPreferences(context(
    kv,
    "owner@example.com",
    workspaceRequest(workspace, empty.accountId),
  ));
  assert.equal(saved.status, 200);
  assert.equal(kv.values.size, 1);
  const [storedKey] = kv.values.keys();
  assert.match(storedKey, /^user-preferences:v1:[a-f0-9]{64}:workspace$/);
  assert.equal(storedKey.includes("owner@example.com"), false);

  const sameAccount = await getPreferences(context(
    kv,
    "OWNER@example.com",
    request("workspace"),
  ));
  assert.deepEqual((await sameAccount.json()).data, workspace);

  const otherAccount = await getPreferences(context(
    kv,
    "other@example.com",
    request("workspace"),
  ));
  assert.equal((await otherAccount.json()).exists, false);
});

test("후보 작업공간 PUT은 GET에서 받은 expectedAccountId를 필수로 요구한다", async () => {
  const kv = new FakeKv();
  const emptyWorkspace = { version: 1, workflow: {}, compareEntries: [] };

  for (const expectedAccountId of [undefined, "0".repeat(64)]) {
    const response = await putPreferences(context(
      kv,
      "owner@example.com",
      workspaceRequest(emptyWorkspace, expectedAccountId),
    ));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /인증 계정이 변경/);
  }
  assert.equal(kv.values.size, 0);
});

test("후보 작업공간은 여섯 상태와 병합 매물의 동일한 workflow 복제본만 허용한다", async () => {
  const kv = new FakeKv();
  const identityResponse = await getPreferences(context(
    kv,
    "owner@example.com",
    request("workspace"),
  ));
  const { accountId } = await identityResponse.json();
  const statuses = ["review", "call", "visit", "hold", "finalist", "rejected"];
  const validWorkflow = Object.fromEntries(statuses.map((status, index) => [
    `naver:${index + 1}`,
    {
      workflowId: `workflow-${index + 1}`,
      status,
      updatedAt: `2026-08-03T0${index}:00:00Z`,
    },
  ]));
  const valid = await putPreferences(context(
    kv,
    "owner@example.com",
    workspaceRequest({ version: 1, workflow: validWorkflow, compareEntries: [] }, accountId),
  ));
  assert.equal(valid.status, 200);

  for (const workflow of [
    {
      "naver:123": { workflowId: "workflow-1", status: "unknown", updatedAt: "2026-08-03T01:00:00Z" },
    },
    {
      "naver:123": { workflowId: "workflow-1", status: "review", updatedAt: "2026-08-03T01:00:00Z" },
      "daangn:456": { workflowId: "workflow-1", status: "call", updatedAt: "2026-08-03T01:00:00Z" },
    },
    {
      "naver:123": { workflowId: "workflow-1", status: "review", updatedAt: "2026-08-03T01:00:00Z" },
      "daangn:456": { workflowId: "workflow-1", status: "review", updatedAt: "2026-08-03T02:00:00Z" },
    },
    {
      "naver:123": { workflowId: "workflow-1", updatedAt: "2026-08-03T01:00:00Z" },
    },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
      `naver:${index + 1}`,
      { workflowId: "workflow-too-wide", status: "review", updatedAt: "2026-08-03T01:00:00Z" },
    ])),
  ]) {
    const response = await putPreferences(context(
      kv,
      "owner@example.com",
      workspaceRequest({ version: 1, workflow, compareEntries: [] }, accountId),
    ));
    assert.equal(response.status, 400);
  }
});

test("후보 작업공간도 JSON Content-Type·동일 출처·본문 크기 방어를 적용한다", async () => {
  const kv = new FakeKv();
  const identityResponse = await getPreferences(context(
    kv,
    "owner@example.com",
    request("workspace"),
  ));
  const { accountId } = await identityResponse.json();
  const body = JSON.stringify({
    expectedAccountId: accountId,
    data: { version: 1, workflow: {}, compareEntries: [] },
  });

  const wrongType = new Request("https://snapspot.example/api/preferences?kind=workspace", {
    method: "PUT",
    headers: {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "text/plain",
    },
    body,
  });
  assert.equal(
    (await putPreferences(context(kv, "owner@example.com", wrongType))).status,
    415,
  );

  const crossOrigin = new Request("https://snapspot.example/api/preferences?kind=workspace", {
    method: "PUT",
    headers: {
      Origin: "https://attacker.example",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "application/json",
    },
    body,
  });
  assert.equal(
    (await putPreferences(context(kv, "owner@example.com", crossOrigin))).status,
    403,
  );

  const oversized = new Request("https://snapspot.example/api/preferences?kind=workspace", {
    method: "PUT",
    headers: {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      "Content-Type": "application/json",
      "Content-Length": String(512 * 1024 + 1),
    },
    body,
  });
  assert.equal(
    (await putPreferences(context(kv, "owner@example.com", oversized))).status,
    413,
  );
});

test("비교 목록은 최대 3개이고 병합 ID가 항목 간 겹치지 않아야 한다", async () => {
  const kv = new FakeKv();
  const identityResponse = await getPreferences(context(
    kv,
    "owner@example.com",
    request("workspace"),
  ));
  const { accountId } = await identityResponse.json();
  const entry = (entryId, listingIds, addedAt = "2026-08-03T01:00:00Z") => ({
    entryId,
    listingIds,
    addedAt,
  });
  const validEntries = [
    entry("compare-1", ["naver:123", "daangn:456"]),
    entry("compare-2", ["naver:789"]),
    entry("compare-3", ["daangn:999"]),
  ];
  const valid = await putPreferences(context(
    kv,
    "owner@example.com",
    workspaceRequest({ version: 1, workflow: {}, compareEntries: validEntries }, accountId),
  ));
  assert.equal(valid.status, 200);

  for (const compareEntries of [
    [...validEntries, entry("compare-4", ["naver:1000"])],
    [entry("compare-1", ["naver:123"]), entry("compare-2", ["naver:123", "daangn:456"])],
    [entry("compare-1", ["naver:123", "naver:123"])],
    [entry("compare-1", [])],
    [entry("compare-1", ["other:123"])],
    [entry("compare-1", ["naver:123"]), entry("compare-1", ["daangn:456"])],
    [entry("compare-1", ["naver:123"], "not-a-date")],
  ]) {
    const response = await putPreferences(context(
      kv,
      "owner@example.com",
      workspaceRequest({ version: 1, workflow: {}, compareEntries }, accountId),
    ));
    assert.equal(response.status, 400);
  }
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
