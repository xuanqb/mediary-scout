import { handleTmdbProxy, type KvLike } from "./handler";

export interface Env {
  TMDB_CACHE: KvLike;
  TMDB_READ_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.TMDB_READ_TOKEN) {
      return new Response("Proxy misconfigured: missing TMDB_READ_TOKEN secret", { status: 500 });
    }
    return handleTmdbProxy({ request, kv: env.TMDB_CACHE, token: env.TMDB_READ_TOKEN });
  },
};
