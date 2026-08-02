import { noStoreJson, readRefreshState } from "../../_refresh";
import type { RefreshEnv } from "../../_refresh";

export const onRequestGet: PagesFunction<RefreshEnv> = async ({ env }) => {
  const state = await readRefreshState(env.REFRESH_KV);
  return noStoreJson(state ?? { status: "idle" });
};
