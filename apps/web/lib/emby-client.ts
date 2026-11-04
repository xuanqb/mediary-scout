import type { LibraryCategory } from "@media-track/workflow";

export type EmbyLibraryNames = Record<LibraryCategory, string>;

export const DEFAULT_EMBY_LIBRARY_NAMES: EmbyLibraryNames = {
  movies: "电影",
  tv: "电视剧",
  variety: "综艺",
  anime: "动漫",
};

export interface EmbyConfig {
  baseUrl: string;
  apiKey: string;
  libraryNames: EmbyLibraryNames;
}

interface EmbyItem {
  Id: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  ImageTags?: Record<string, string | undefined>;
  ProviderIds?: Record<string, string | undefined>;
  ParentIndexNumber?: number;
  IndexNumber?: number;
}

/** One title present in an Emby library, normalized for the poster wall. */
export interface EmbyLibraryItem {
  id: string;
  tmdbId: number;
  name: string;
  year: number | null;
  type: "movie" | "tv";
  hasPrimaryImage: boolean;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function embyGet<T>(config: EmbyConfig, path: string, timeoutMs = 8000): Promise<T | null> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
    headers: { "X-Emby-Token": config.apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Emby ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function tmdbOf(item: EmbyItem): number | null {
  const raw = item.ProviderIds?.Tmdb;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Libraries by id, so the configured name → library id lookup is one call. */
async function findLibraryId(config: EmbyConfig, name: string, timeoutMs = 8000): Promise<string | null> {
  const data = await embyGet<{ Items?: Array<{ Id: string; Name: string }> }>(
    config,
    "/Library/MediaFolders",
    timeoutMs,
  );
  const want = name.trim();
  const match = data?.Items?.find((item) => item.Name === want);
  return match?.Id ?? null;
}

/** Save-time reachability probe: lists media libraries. */
export async function probeEmby(config: EmbyConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const data = await embyGet<{ Items?: Array<{ Id: string; Name: string }> }>(
      config,
      "/Library/MediaFolders",
    );
    const names = (data?.Items ?? []).map((item) => item.Name).filter(Boolean);
    return {
      ok: true,
      message: names.length > 0 ? `已连接，媒体库：${names.join("、")}` : "已连接（未发现媒体库）",
    };
  } catch (error) {
    return {
      ok: false,
      message: `无法连接 Emby：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Episodes already present in Emby for a TMDB series (codes like S01E02).
 *  Fail-open: any error returns [] so an Emby outage never blocks acquisition. */
export async function episodesInEmby(
  config: EmbyConfig,
  input: { tmdbId: number; category: LibraryCategory },
): Promise<string[]> {
  try {
    const libraryId = await findLibraryId(config, config.libraryNames[input.category]);
    if (!libraryId) return [];
    const items = await embyGet<{ Items?: EmbyItem[] }>(
      config,
      `/Items?ParentId=${encodeURIComponent(libraryId)}&Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds&Limit=10000`,
    );
    const series = items?.Items?.find((item) => tmdbOf(item) === input.tmdbId);
    if (!series) return [];
    const episodes = await embyGet<{ Items?: EmbyItem[] }>(
      config,
      `/Items?ParentId=${encodeURIComponent(series.Id)}&Recursive=true&IncludeItemTypes=Episode&Fields=IndexNumber,ParentIndexNumber&Limit=10000`,
    );
    const codes: string[] = [];
    for (const episode of episodes?.Items ?? []) {
      const season = episode.ParentIndexNumber;
      const number = episode.IndexNumber;
      if (season === undefined || number === undefined) continue;
      codes.push(`S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`);
    }
    return codes;
  } catch (error) {
    console.warn(
      `[emby] episode lookup failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** Whether a film already exists in Emby. Fail-open → false. */
export async function movieInEmby(
  config: EmbyConfig,
  input: { tmdbId: number; category?: LibraryCategory },
): Promise<boolean> {
  try {
    const libraryId = await findLibraryId(config, config.libraryNames[input.category ?? "movies"]);
    if (!libraryId) return false;
    const items = await embyGet<{ Items?: EmbyItem[] }>(
      config,
      `/Items?ParentId=${encodeURIComponent(libraryId)}&Recursive=true&IncludeItemTypes=Movie&Fields=ProviderIds&Limit=10000`,
    );
    return (items?.Items ?? []).some((item) => tmdbOf(item) === input.tmdbId);
  } catch (error) {
    console.warn(
      `[emby] movie lookup failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Every movie/series in one Emby library, so Emby-only titles can appear in the
 *  app's poster wall. Fail-open → [] (an Emby outage must not break the library). */
export async function listEmbyLibraryItems(
  config: EmbyConfig,
  category: LibraryCategory,
): Promise<EmbyLibraryItem[]> {
  try {
    // The poster wall is a page load: fail fast when Emby is unreachable.
    const libraryId = await findLibraryId(config, config.libraryNames[category], 4000);
    if (!libraryId) return [];
    const data = await embyGet<{ Items?: EmbyItem[] }>(
      config,
      `/Items?ParentId=${encodeURIComponent(libraryId)}&Recursive=true&IncludeItemTypes=Movie%2CSeries&Fields=ProviderIds%2CProductionYear%2CImageTags&Limit=10000`,
      4000,
    );
    const seen = new Set<string>();
    const items: EmbyLibraryItem[] = [];
    for (const item of data?.Items ?? []) {
      const tmdbId = tmdbOf(item);
      const type = item.Type === "Movie" ? "movie" : item.Type === "Series" ? "tv" : null;
      if (tmdbId === null || type === null) continue;
      const key = `${type}:${tmdbId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: item.Id,
        tmdbId,
        name: item.Name?.trim() || `TMDB ${tmdbId}`,
        year:
          typeof item.ProductionYear === "number" && Number.isInteger(item.ProductionYear)
            ? item.ProductionYear
            : null,
        type,
        hasPrimaryImage: Boolean(item.ImageTags?.Primary),
      });
    }
    return items;
  } catch (error) {
    console.warn(
      `[emby] library listing failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** Proxy one Emby poster through the app, so the API key never reaches the
 *  browser. Null on any failure (the card falls back to its title text). */
export async function fetchEmbyImage(
  config: EmbyConfig,
  itemId: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  try {
    const response = await fetch(
      `${normalizeBaseUrl(config.baseUrl)}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxWidth=342&quality=90`,
      {
        headers: { "X-Emby-Token": config.apiKey },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) return null;
    return {
      body: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") ?? "image/jpeg",
    };
  } catch (error) {
    console.warn(
      `[emby] image fetch failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** One library scan after files land. Best-effort — Emby being down must not fail a run. */
export async function refreshEmbyLibrary(config: EmbyConfig): Promise<boolean> {
  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/Library/Refresh`, {
      method: "POST",
      headers: { "X-Emby-Token": config.apiKey },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch (error) {
    console.warn(
      `[emby] library refresh failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
