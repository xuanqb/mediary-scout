import type { LibraryCategory, MediaType } from "./domain.js";

/** TMDB genre id for "Animation" (shared by tv and movie). */
const ANIMATION_GENRE_ID = 16;

/** TV genres that land on the 综艺 shelf (variety / documentary / news / reality
 *  / talk). A film is never reshelved by these — a documentary film is 电影. */
const VARIETY_GENRE_IDS = new Set([99, 10763, 10764, 10767]);

export const LIBRARY_CATEGORIES = ["movies", "tv", "variety", "anime"] as const;

/**
 * Map a TMDB title onto one of the four Emby shelves.
 *
 * - A **movie is always 电影**, even an animated film.
 * - An animated series is 动漫.
 * - A series with a variety/documentary/news/reality/talk genre is 综艺.
 * - Every other series is 电视剧.
 */
export function classifyLibraryCategory(input: {
  mediaType: MediaType;
  genreIds?: number[];
}): LibraryCategory {
  if (input.mediaType === "movie") return "movies";
  if (input.mediaType === "anime") return "anime";
  if ((input.genreIds ?? []).some((id) => VARIETY_GENRE_IDS.has(id))) return "variety";
  return "tv";
}

/** Persisted categories win (manual override); older rows fall back to `type`. */
export function libraryCategoryOf(title: {
  type: MediaType;
  libraryCategory?: LibraryCategory;
}): LibraryCategory {
  return title.libraryCategory ?? classifyLibraryCategory({ mediaType: title.type });
}

/**
 * Refine a base TMDB type into the library's shelf type.
 *
 * - A **movie is always a movie** — an animated film (你的名字, 哪吒) belongs on the
 *   电影 shelf and routes to the movie agent. Animation genre never reshelves a film.
 * - A **series** becomes "anime" whenever it's the Animation genre, regardless of
 *   origin — 日漫 / 国漫 / 美漫 (无敌少侠) / anything animated. The 动漫 shelf means
 *   "all animated series", not a region. (`originCountries` is kept in the signature
 *   for callers but no longer affects the result.)
 */
export function classifyMediaType(input: {
  baseType: Extract<MediaType, "tv" | "movie">;
  genreIds: number[];
  originCountries: string[];
}): MediaType {
  if (input.baseType === "movie") {
    return "movie";
  }
  return input.genreIds.includes(ANIMATION_GENRE_ID) ? "anime" : "tv";
}
