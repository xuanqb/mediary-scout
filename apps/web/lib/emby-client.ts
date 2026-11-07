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
  ParentIndexNumber?: number;
  IndexNumber?: number;
}

/**
 * A provider-mode Emby read failed. Deliberately marked as a network error so
 * the worker's transient classifier retries it; the message also carries the
 * `EMBY_UNAVAILABLE` code the ingest status mapper reports back to USAPI.
 */
export class EmbyUnavailableError extends Error {
  constructor(detail: string) {
    super(`EMBY_UNAVAILABLE: network error while querying Emby (${detail})`);
    this.name = "EmbyUnavailableError";
  }
}

function embyFailure(error: unknown): EmbyUnavailableError {
  return new EmbyUnavailableError(error instanceof Error ? error.message : String(error));
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function embyGet<T>(config: EmbyConfig, path: string): Promise<T | null> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
    headers: { "X-Emby-Token": config.apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Emby ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Server-side lookup: Emby resolves the provider id itself and returns at most
 *  one item, so a huge library is never dumped into Node memory. */
async function findIdByTmdb(
  config: EmbyConfig,
  input: { libraryId: string; itemType: "Series" | "Movie"; tmdbId: number },
): Promise<string | null> {
  const data = await embyGet<{ Items?: EmbyItem[] }>(
    config,
    `/Items?ParentId=${encodeURIComponent(input.libraryId)}&Recursive=true&IncludeItemTypes=${input.itemType}&AnyProviderIdEquals=Tmdb.${input.tmdbId}&Limit=1`,
  );
  return data?.Items?.[0]?.Id ?? null;
}

/** Libraries by id, so the configured name → library id lookup is one call. */
async function findLibraryId(config: EmbyConfig, name: string): Promise<string | null> {
  const data = await embyGet<{ Items?: Array<{ Id: string; Name: string }> }>(
    config,
    "/Library/MediaFolders",
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
 *  Fail-open by default: any error returns [] so an Emby outage never blocks a
 *  user's acquisition. Provider tasks pass `failClosed` — an outage must abort
 *  the run instead of risking duplicate transfers.
 *
 *  `categories` lets a provider task search 电视剧/综艺/动漫 together. The two
 *  systems classify some series differently (an animated documentary, say), and
 *  USAPI decides the FINAL shelf after it moves the files. Looking the TMDB id up
 *  in every series shelf makes the "already in Emby" check independent of that
 *  classification difference, so a film/series is not delivered twice. */
export async function episodesInEmby(
  config: EmbyConfig,
  input: { tmdbId: number; category: LibraryCategory },
  options: { failClosed?: boolean; categories?: readonly LibraryCategory[] } = {},
): Promise<string[]> {
  const categories = [...new Set(options.categories ?? [input.category])];
  try {
    const codes = new Set<string>();
    let resolvedLibraries = 0;
    for (const category of categories) {
      const libraryId = await findLibraryId(config, config.libraryNames[category]);
      if (!libraryId) continue;
      resolvedLibraries += 1;
      const seriesId = await findIdByTmdb(config, {
        libraryId,
        itemType: "Series",
        tmdbId: input.tmdbId,
      });
      if (!seriesId) continue;
      const episodes = await embyGet<{ Items?: EmbyItem[] }>(
        config,
        `/Items?ParentId=${encodeURIComponent(seriesId)}&Recursive=true&IncludeItemTypes=Episode&Fields=IndexNumber,ParentIndexNumber&Limit=10000`,
      );
      for (const episode of episodes?.Items ?? []) {
        const season = episode.ParentIndexNumber;
        const number = episode.IndexNumber;
        if (season === undefined || number === undefined) continue;
        codes.add(`S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`);
      }
    }
    if (options.failClosed && resolvedLibraries === 0) {
      throw new EmbyUnavailableError(`libraries ${categories.join("/")} not found`);
    }
    return [...codes];
  } catch (error) {
    if (options.failClosed) {
      throw error instanceof EmbyUnavailableError ? error : embyFailure(error);
    }
    console.warn(
      `[emby] episode lookup failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** Whether a film already exists in Emby. Fail-open → false by default. */
export async function movieInEmby(
  config: EmbyConfig,
  input: { tmdbId: number; category?: LibraryCategory },
  options: { failClosed?: boolean } = {},
): Promise<boolean> {
  const category = input.category ?? "movies";
  try {
    const libraryId = await findLibraryId(config, config.libraryNames[category]);
    if (!libraryId) {
      if (options.failClosed) {
        throw new EmbyUnavailableError(`library "${config.libraryNames[category]}" not found`);
      }
      return false;
    }
    const movieId = await findIdByTmdb(config, {
      libraryId,
      itemType: "Movie",
      tmdbId: input.tmdbId,
    });
    return movieId !== null;
  } catch (error) {
    if (options.failClosed) {
      throw error instanceof EmbyUnavailableError ? error : embyFailure(error);
    }
    console.warn(
      `[emby] movie lookup failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
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
