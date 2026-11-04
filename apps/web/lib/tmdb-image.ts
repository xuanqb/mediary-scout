/** TMDB's image CDN is blocked for mainland visitors, so posters go through the
 *  same worker that proxies metadata (its `/img` route only allows w342/w500).
 *  Override with NEXT_PUBLIC_TMDB_IMAGE_BASE when self-hosting that worker. */
const DEFAULT_TMDB_IMAGE_BASE = "https://tmdb-proxy.mediaryscout.app/img";

export function tmdbImageUrl(posterPath: string, size: "w342" | "w500" = "w342"): string {
  const base = (process.env.NEXT_PUBLIC_TMDB_IMAGE_BASE?.trim() || DEFAULT_TMDB_IMAGE_BASE).replace(
    /\/+$/,
    "",
  );
  const path = posterPath.startsWith("/") ? posterPath : `/${posterPath}`;
  return `${base}/t/p/${size}${path}`;
}
