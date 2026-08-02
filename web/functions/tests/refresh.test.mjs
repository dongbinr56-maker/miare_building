import assert from "node:assert/strict";
import test from "node:test";

import { REFRESH_STATE_KEY } from "../_refresh.ts";
import { onRequestPost as requestRefresh } from "../api/refresh/request.ts";

const ACTIVE_JOB_ID = "123e4567-e89b-42d3-a456-426614174000";

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

  setJson(key, value) {
    this.values.set(key, JSON.stringify(value));
  }

  getJson(key) {
    const value = this.values.get(key);
    return value === undefined ? null : JSON.parse(value);
  }
}

function makeEnv(kv = new FakeKv()) {
  return {
    REFRESH_KV: kv,
    GITHUB_ACTIONS_TOKEN: "github_pat_test_token_long_enough",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_WORKFLOW_ID: "refresh-listings.yml",
  };
}

function browserRequest(headers = {}) {
  return new Request("https://snapspot.example/api/refresh/request", {
    method: "POST",
    headers: {
      Origin: "https://snapspot.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "miare-dashboard",
      ...headers,
    },
  });
}

test("refresh request dispatches only the main workflow with a generated job ID", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  let dispatched;
  globalThis.fetch = async (url, init) => {
    dispatched = { url, init };
    return new Response(null, { status: 204 });
  };

  try {
    const response = await requestRefresh({ env, request: browserRequest() });
    assert.equal(response.status, 202);
    const state = await response.json();
    assert.equal(state.status, "pending");
    assert.match(state.jobId, /^[0-9a-f-]{36}$/i);
    assert.equal(env.REFRESH_KV.getJson(REFRESH_STATE_KEY).jobId, state.jobId);

    assert.equal(
      dispatched.url,
      "https://api.github.com/repos/owner/repository/actions/workflows/refresh-listings.yml/dispatches",
    );
    assert.equal(dispatched.init.headers.Authorization, `Bearer ${env.GITHUB_ACTIONS_TOKEN}`);
    const dispatchBody = JSON.parse(dispatched.init.body);
    assert.deepEqual(dispatchBody, {
      ref: "main",
      inputs: { job_id: state.jobId },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an active refresh is returned without a duplicate dispatch", async () => {
  const env = makeEnv();
  env.REFRESH_KV.setJson(REFRESH_STATE_KEY, {
    jobId: ACTIVE_JOB_ID,
    status: "running",
    requestedAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    const response = await requestRefresh({ env, request: browserRequest() });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).jobId, ACTIVE_JOB_ID);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale active state can be replaced by a new dispatch", async () => {
  const env = makeEnv();
  env.REFRESH_KV.setJson(REFRESH_STATE_KEY, {
    jobId: ACTIVE_JOB_ID,
    status: "pending",
    requestedAt: "2020-01-01T00:00:00Z",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    const response = await requestRefresh({ env, request: browserRequest() });
    const next = await response.json();
    assert.equal(response.status, 202);
    assert.notEqual(next.jobId, ACTIVE_JOB_ID);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed GitHub dispatch closes only its own pending job", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });

  try {
    const response = await requestRefresh({ env, request: browserRequest() });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).status, "failed");
    assert.equal(env.REFRESH_KV.getJson(REFRESH_STATE_KEY).status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-origin and complete server configuration are required", async () => {
  const env = makeEnv();
  const crossOrigin = await requestRefresh({
    env,
    request: browserRequest({ Origin: "https://attacker.example" }),
  });
  assert.equal(crossOrigin.status, 403);

  const missingConfiguration = await requestRefresh({
    env: { ...env, GITHUB_ACTIONS_TOKEN: "" },
    request: browserRequest(),
  });
  assert.equal(missingConfiguration.status, 503);
  assert.equal(env.REFRESH_KV.getJson(REFRESH_STATE_KEY), null);
});
