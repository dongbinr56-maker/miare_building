export interface RefreshEnv {
  REFRESH_KV: KVNamespace;
  GITHUB_ACTIONS_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_WORKFLOW_ID: string;
}

export type RefreshStatus = "pending" | "running" | "succeeded" | "failed";

export interface RefreshState {
  jobId: string;
  status: RefreshStatus;
  requestedAt: string;
  claimedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  message?: string;
}

export interface ListingsMeta {
  updatedAt: string;
  storedAt: string;
  size: number;
}

export const REFRESH_STATE_KEY = "refresh:state";
export const LISTINGS_KEY = "listings:latest";
export const LISTINGS_META_KEY = "listings:meta";

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const noStoreJson = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export async function readRefreshState(kv: KVNamespace): Promise<RefreshState | null> {
  return kv.get<RefreshState>(REFRESH_STATE_KEY, "json");
}

export async function writeRefreshState(
  kv: KVNamespace,
  state: RefreshState,
): Promise<void> {
  await kv.put(REFRESH_STATE_KEY, JSON.stringify(state));
}

export function isRefreshJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

export function parseIsoTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  const requestedWith = request.headers.get("X-Requested-With");

  return (
    origin === new URL(request.url).origin &&
    (fetchSite === null || fetchSite === "same-origin") &&
    requestedWith === "miare-dashboard"
  );
}
