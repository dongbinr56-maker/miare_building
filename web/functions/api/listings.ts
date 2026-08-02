import { LISTINGS_KEY, LISTINGS_META_KEY } from "../_refresh";
import type { ListingsMeta, RefreshEnv } from "../_refresh";

export const onRequestGet: PagesFunction<RefreshEnv> = async ({ env, request }) => {
  const body = await env.REFRESH_KV.get(LISTINGS_KEY, "text");
  if (body === null) {
    return Response.json(
      { error: "아직 수동 갱신 데이터가 없습니다." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const meta = await env.REFRESH_KV.get<ListingsMeta>(LISTINGS_META_KEY, "json");
  const etag = meta ? `W/"${meta.updatedAt}-${meta.size}"` : undefined;
  if (etag && request.headers.get("If-None-Match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": "no-store", ETag: etag },
    });
  }

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if (etag) headers.set("ETag", etag);
  return new Response(body, { headers });
};
