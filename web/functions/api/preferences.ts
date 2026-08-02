import { isSameOriginRequest, noStoreJson } from "../_refresh.ts";
import type { AccessContextData } from "../_middleware.ts";

interface PreferencesEnv {
  REFRESH_KV: KVNamespace;
}

type PreferenceKind = "favorites" | "hidden";

interface PreferenceEnvelope {
  version: 1;
  updatedAt: string;
  data: unknown;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const LISTING_ID_PATTERN = /^(?:naver|daangn):\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preferenceKind(request: Request): PreferenceKind | null {
  const kind = new URL(request.url).searchParams.get("kind");
  return kind === "favorites" || kind === "hidden" ? kind : null;
}

function isListingId(value: unknown): value is string {
  return typeof value === "string" && LISTING_ID_PATTERN.test(value);
}

function isListingSnapshot(value: unknown, expectedId?: string): boolean {
  if (!isRecord(value) || !isListingId(value.id)) return false;
  if (expectedId !== undefined && value.id !== expectedId) return false;
  if (value.source !== "naver" && value.source !== "daangn") return false;
  return (
    typeof value.name === "string" &&
    typeof value.dong === "string" &&
    (value.deposit === null || typeof value.deposit === "number") &&
    (value.rent === null || typeof value.rent === "number")
  );
}

function isFavoritesData(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_ENTRIES &&
    entries.every(([id, snapshot]) => isListingId(id) && isListingSnapshot(snapshot, id))
  );
}

function isHiddenData(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!Array.isArray(value.blockedIds) || !Array.isArray(value.entries)) return false;
  if (value.entries.length > MAX_ENTRIES || value.blockedIds.length > MAX_ENTRIES * 32) {
    return false;
  }

  const blockedIds = value.blockedIds;
  if (!blockedIds.every(isListingId) || new Set(blockedIds).size !== blockedIds.length) {
    return false;
  }

  const derivedIds: string[] = [];
  for (const entry of value.entries) {
    if (!isRecord(entry)) return false;
    if (
      typeof entry.entryId !== "string" ||
      !entry.entryId ||
      entry.entryId.length > 128 ||
      typeof entry.hiddenAt !== "string" ||
      Number.isNaN(Date.parse(entry.hiddenAt)) ||
      !Array.isArray(entry.listingIds) ||
      entry.listingIds.length === 0 ||
      entry.listingIds.length > 32 ||
      !entry.listingIds.every(isListingId) ||
      new Set(entry.listingIds).size !== entry.listingIds.length ||
      !isListingSnapshot(entry.listing)
    ) {
      return false;
    }
    derivedIds.push(...entry.listingIds);
  }

  const expected = [...new Set(derivedIds)].sort();
  const supplied = [...blockedIds].sort();
  return expected.length === supplied.length && expected.every((id, index) => id === supplied[index]);
}

function validPreferenceData(kind: PreferenceKind, value: unknown): boolean {
  return kind === "favorites" ? isFavoritesData(value) : isHiddenData(value);
}

function emptyPreference(kind: PreferenceKind): unknown {
  return kind === "favorites"
    ? {}
    : { version: 1, blockedIds: [], entries: [] };
}

async function storageIdentity(
  email: string,
  kind: PreferenceKind,
): Promise<{ accountId: string; key: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !/^\S+@\S+\.\S+$/.test(normalized)) {
    throw new Error("Invalid authenticated identity");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return { accountId: hash, key: `user-preferences:v1:${hash}:${kind}` };
}

async function preferenceIdentity(
  data: AccessContextData,
  kind: PreferenceKind,
): Promise<{ accountId: string; key: string } | null> {
  if (typeof data.accessEmail !== "string") return null;
  try {
    return await storageIdentity(data.accessEmail, kind);
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<PreferencesEnv, string, AccessContextData> = async ({
  env,
  request,
  data,
}) => {
  const kind = preferenceKind(request);
  if (!kind) return noStoreJson({ error: "잘못된 저장소 종류입니다." }, 400);
  const identity = await preferenceIdentity(data, kind);
  if (!identity) return noStoreJson({ error: "인증 사용자를 확인할 수 없습니다." }, 401);

  const stored = await env.REFRESH_KV.get<PreferenceEnvelope>(identity.key, "json");
  if (stored === null) {
    return noStoreJson({ accountId: identity.accountId, exists: false, data: emptyPreference(kind) });
  }
  if (
    !isRecord(stored) ||
    stored.version !== 1 ||
    typeof stored.updatedAt !== "string" ||
    Number.isNaN(Date.parse(stored.updatedAt)) ||
    !validPreferenceData(kind, stored.data)
  ) {
    return noStoreJson({ error: "저장된 사용자 설정이 손상되었습니다." }, 500);
  }
  return noStoreJson({
    accountId: identity.accountId,
    exists: true,
    updatedAt: stored.updatedAt,
    data: stored.data,
  });
};

export const onRequestPut: PagesFunction<PreferencesEnv, string, AccessContextData> = async ({
  env,
  request,
  data,
}) => {
  if (!isSameOriginRequest(request)) {
    return noStoreJson({ error: "잘못된 사용자 설정 요청입니다." }, 403);
  }
  const kind = preferenceKind(request);
  if (!kind) return noStoreJson({ error: "잘못된 저장소 종류입니다." }, 400);
  const identity = await preferenceIdentity(data, kind);
  if (!identity) return noStoreJson({ error: "인증 사용자를 확인할 수 없습니다." }, 401);

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return noStoreJson({ error: "사용자 설정 데이터가 너무 큽니다." }, 413);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return noStoreJson({ error: "사용자 설정 데이터가 너무 큽니다." }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return noStoreJson({ error: "사용자 설정 JSON이 올바르지 않습니다." }, 400);
  }
  if (!isRecord(body) || !validPreferenceData(kind, body.data)) {
    return noStoreJson({ error: "사용자 설정 형식이 올바르지 않습니다." }, 400);
  }

  const envelope: PreferenceEnvelope = {
    version: 1,
    updatedAt: new Date().toISOString(),
    data: body.data,
  };
  await env.REFRESH_KV.put(identity.key, JSON.stringify(envelope));
  return noStoreJson({
    accountId: identity.accountId,
    exists: true,
    updatedAt: envelope.updatedAt,
    data: envelope.data,
  });
};
