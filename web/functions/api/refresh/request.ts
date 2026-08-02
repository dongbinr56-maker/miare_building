import {
  isRefreshJobId,
  isSameOriginRequest,
  noStoreJson,
  parseIsoTime,
  readRefreshState,
  writeRefreshState,
} from "../../_refresh.ts";
import type { RefreshEnv, RefreshState } from "../../_refresh.ts";

const PENDING_STALE_MS = 30 * 60 * 1_000;
const RUNNING_STALE_MS = 2 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function isActive(state: RefreshState, now: number): boolean {
  if (state.status === "pending") {
    const requestedAt = parseIsoTime(state.requestedAt);
    return (
      requestedAt !== null &&
      requestedAt <= now + CLOCK_SKEW_MS &&
      now - requestedAt <= PENDING_STALE_MS
    );
  }

  if (state.status === "running") {
    const claimedAt = parseIsoTime(state.claimedAt) ?? parseIsoTime(state.requestedAt);
    return (
      claimedAt !== null &&
      claimedAt <= now + CLOCK_SKEW_MS &&
      now - claimedAt <= RUNNING_STALE_MS
    );
  }

  return false;
}

function hasDispatchConfiguration(env: RefreshEnv): boolean {
  return (
    typeof env.GITHUB_ACTIONS_TOKEN === "string" &&
    env.GITHUB_ACTIONS_TOKEN.length >= 20 &&
    REPOSITORY_PATTERN.test(env.GITHUB_REPOSITORY ?? "") &&
    WORKFLOW_PATTERN.test(env.GITHUB_WORKFLOW_ID ?? "")
  );
}

export const onRequestPost: PagesFunction<RefreshEnv> = async ({ env, request }) => {
  if (!isSameOriginRequest(request)) {
    return noStoreJson({ error: "잘못된 새로고침 요청입니다." }, 403);
  }

  if (!hasDispatchConfiguration(env)) {
    return noStoreJson({ error: "새로고침 서버 설정이 완료되지 않았습니다." }, 503);
  }

  const now = Date.now();
  const current = await readRefreshState(env.REFRESH_KV);
  if (current && isRefreshJobId(current.jobId) && isActive(current, now)) {
    return noStoreJson(current, 202);
  }

  const next: RefreshState = {
    jobId: crypto.randomUUID(),
    status: "pending",
    requestedAt: new Date(now).toISOString(),
    message: "GitHub 클라우드 수집기 연결을 기다리고 있습니다.",
  };
  await writeRefreshState(env.REFRESH_KV, next);

  const dispatchUrl = `https://api.github.com/repos/${env.GITHUB_REPOSITORY
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/actions/workflows/${encodeURIComponent(env.GITHUB_WORKFLOW_ID)}/dispatches`;
  let response: Response;
  try {
    response = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "snapspot-studio-finder",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          job_id: next.jobId,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    response = new Response(null, { status: 503 });
  }

  if (response.status !== 204) {
    const failed: RefreshState = {
      ...next,
      status: "failed",
      completedAt: new Date().toISOString(),
      message: "GitHub 수집 서버를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
    const latest = await readRefreshState(env.REFRESH_KV);
    if (latest?.jobId === next.jobId && latest.status === "pending") {
      await writeRefreshState(env.REFRESH_KV, failed);
    }
    return noStoreJson(failed, 502);
  }

  return noStoreJson(next, 202);
};
