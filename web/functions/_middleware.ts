interface Env {
  /** Full Cloudflare Access team URL, for example https://example.cloudflareaccess.com. */
  TEAM_DOMAIN: string;
  /** Comma-separated Audience (AUD) tags for the production and wildcard Access apps. */
  POLICY_AUD: string;
  /** Comma-separated application allowlist. */
  ACCESS_ALLOWED_EMAILS: string;
}

interface AccessJwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface AccessJwtPayload {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
}

interface JwksResponse {
  keys?: unknown;
}

interface AccessSigningKey extends JsonWebKey {
  alg?: "RS256";
  e: string;
  kid: string;
  kty: "RSA";
  n: string;
  use?: "sig";
}

interface JwksCacheEntry {
  expiresAt: number;
  issuer: string;
  keys: AccessSigningKey[];
}

type VerificationResult =
  | { ok: true }
  | { ok: false; reason: "configuration" | "identity" | "token" };

const REQUIRED_ALLOWED_EMAILS = new Set([
  "miraemom7@gmail.com",
  "dongbinr56@gmail.com",
  "sunnydongbin@naver.com",
]);

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16_384;
const CLOCK_SKEW_SECONDS = 60;

let jwksCache: JwksCacheEntry | undefined;

function deny(status: 401 | 403 | 503): Response {
  const message = status === 503 ? "Authentication is unavailable." : "Access denied.";

  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function normalizeIssuer(value: string | undefined): string | undefined {
  if (!value || value !== value.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const isCloudflareAccessDomain =
      url.hostname.endsWith(".cloudflareaccess.com") &&
      url.hostname !== "cloudflareaccess.com";

    if (
      url.protocol !== "https:" ||
      !isCloudflareAccessDomain ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

function parseAllowedEmails(value: string | undefined): Set<string> | undefined {
  if (!value) {
    return undefined;
  }

  const entries = value.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => !entry || !/^\S+@\S+\.\S+$/.test(entry))) {
    return undefined;
  }

  const configured = new Set(entries);
  if (
    configured.size !== REQUIRED_ALLOWED_EMAILS.size ||
    [...configured].some((email) => !REQUIRED_ALLOWED_EMAILS.has(email))
  ) {
    return undefined;
  }

  return configured;
}

function decodeBase64Url(value: string): ArrayBuffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function decodeJsonPart<T>(value: string): T {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64Url(value),
  );
  const parsed: unknown = JSON.parse(decoded);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JWT JSON");
  }

  return parsed as T;
}

function getToken(request: Request): string | undefined {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (assertion) {
    return assertion;
  }

  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return undefined;
  }

  for (const part of cookie.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    if (name === "CF_Authorization") {
      const value = part.slice(separatorIndex + 1).trim();
      return value || undefined;
    }
  }

  return undefined;
}

function isJsonWebKey(value: unknown): value is AccessSigningKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const key = value as Record<string, unknown>;
  return (
    key.kty === "RSA" &&
    typeof key.kid === "string" &&
    typeof key.n === "string" &&
    typeof key.e === "string" &&
    (key.alg === undefined || key.alg === "RS256") &&
    (key.use === undefined || key.use === "sig")
  );
}

async function fetchJwks(
  issuer: string,
  forceRefresh: boolean,
): Promise<AccessSigningKey[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    jwksCache?.issuer === issuer &&
    jwksCache.expiresAt > now
  ) {
    return jwksCache.keys;
  }

  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Unable to load Access signing keys");
  }

  const body = (await response.json()) as JwksResponse;
  if (!Array.isArray(body.keys)) {
    throw new Error("Invalid Access signing keys");
  }

  const keys = body.keys.filter(isJsonWebKey);
  if (keys.length === 0 || keys.length > 10) {
    throw new Error("Invalid Access signing keys");
  }

  jwksCache = {
    expiresAt: now + JWKS_CACHE_TTL_MS,
    issuer,
    keys,
  };

  return keys;
}

async function findSigningKey(
  issuer: string,
  kid: string,
): Promise<AccessSigningKey> {
  let keys = await fetchJwks(issuer, false);
  let key = keys.find((candidate) => candidate.kid === kid);

  if (!key) {
    // The signing key may have rotated before the short local cache expired.
    keys = await fetchJwks(issuer, true);
    key = keys.find((candidate) => candidate.kid === kid);
  }

  if (!key) {
    throw new Error("Unknown Access signing key");
  }

  return key;
}

function parseExpectedAudiences(value: string | undefined): Set<string> | undefined {
  if (!value || value !== value.trim()) {
    return undefined;
  }

  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > 4 ||
    entries.some((entry) => !/^[a-f0-9]{64}$/i.test(entry))
  ) {
    return undefined;
  }

  const audiences = new Set(entries);
  return audiences.size === entries.length ? audiences : undefined;
}

function hasExpectedAudience(
  audience: unknown,
  expected: ReadonlySet<string>,
): boolean {
  if (typeof audience === "string") {
    return expected.has(audience);
  }

  return (
    Array.isArray(audience) &&
    audience.some((entry) => typeof entry === "string" && expected.has(entry))
  );
}

function hasValidTimestamps(payload: AccessJwtPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return false;
  }

  if (now >= payload.exp + CLOCK_SKEW_SECONDS) {
    return false;
  }

  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      now + CLOCK_SKEW_SECONDS < payload.nbf)
  ) {
    return false;
  }

  if (
    payload.iat !== undefined &&
    (typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.iat > now + CLOCK_SKEW_SECONDS)
  ) {
    return false;
  }

  return true;
}

async function verifyAccessRequest(
  request: Request,
  env: Env,
): Promise<VerificationResult> {
  const issuer = normalizeIssuer(env.TEAM_DOMAIN);
  const expectedAudiences = parseExpectedAudiences(env.POLICY_AUD);
  const allowedEmails = parseAllowedEmails(env.ACCESS_ALLOWED_EMAILS);

  if (!issuer || !expectedAudiences || !allowedEmails) {
    return { ok: false, reason: "configuration" };
  }

  const token = getToken(request);
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "token" };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "token" };
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJsonPart<AccessJwtHeader>(encodedHeader);
    const payload = decodeJsonPart<AccessJwtPayload>(encodedPayload);

    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !header.kid ||
      (header.typ !== undefined && header.typ !== "JWT") ||
      payload.iss !== issuer ||
      !hasExpectedAudience(payload.aud, expectedAudiences) ||
      !hasValidTimestamps(payload) ||
      typeof payload.email !== "string"
    ) {
      return { ok: false, reason: "token" };
    }

    const key = await findSigningKey(issuer, header.kid);
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureIsValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );

    if (!signatureIsValid) {
      return { ok: false, reason: "token" };
    }

    const email = payload.email.trim().toLowerCase();
    if (!email || !allowedEmails.has(email)) {
      return { ok: false, reason: "identity" };
    }

    return { ok: true };
  } catch {
    // Do not log tokens or identity claims. Verification failures are fail-closed.
    return { ok: false, reason: "token" };
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const result = await verifyAccessRequest(context.request, context.env);

  if (!result.ok) {
    if (result.reason === "configuration") {
      return deny(503);
    }

    return deny(result.reason === "identity" ? 403 : 401);
  }

  return context.next();
};
