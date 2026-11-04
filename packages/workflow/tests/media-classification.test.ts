import { describe, expect, it } from "vitest";
import {
  classifyLibraryCategory,
  classifyMediaType,
  libraryCategoryOf,
} from "../src/index.js";

describe("classifyMediaType", () => {
  it("classifies a Japanese animation series as anime", () => {
    expect(
      classifyMediaType({ baseType: "tv", genreIds: [16, 10765], originCountries: ["JP"] }),
    ).toBe("anime");
  });

  it("classifies a Chinese animation series (国漫) as anime", () => {
    // 国漫 (e.g. 一人之下): Animation genre + CN origin → 动漫 shelf, like 日漫.
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: ["CN"] })).toBe(
      "anime",
    );
  });

  it("keeps a Japanese animated MOVIE as a movie (a film is a film)", () => {
    // 你的名字 / 千与千寻: animation genre + JP, but a movie stays a movie — it
    // belongs on the 电影 shelf and routes to the movie agent, not 动漫.
    expect(classifyMediaType({ baseType: "movie", genreIds: [16], originCountries: ["JP"] })).toBe(
      "movie",
    );
  });

  it("keeps a Chinese animated MOVIE as a movie too", () => {
    expect(classifyMediaType({ baseType: "movie", genreIds: [16], originCountries: ["CN"] })).toBe(
      "movie",
    );
  });

  it("classifies a Western animation series (美漫, e.g. 无敌少侠) as anime — any animation counts", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: ["US"] })).toBe(
      "anime",
    );
  });

  it("classifies a Korean animation series as anime too (origin no longer matters)", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: ["KR"] })).toBe(
      "anime",
    );
  });

  it("classifies an animation series with no origin info as anime (genre is the only signal)", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [16], originCountries: [] })).toBe("anime");
  });

  it("keeps a live-action Japanese series as tv (animation genre required)", () => {
    expect(classifyMediaType({ baseType: "tv", genreIds: [18], originCountries: ["JP"] })).toBe("tv");
  });

  it("falls back to the base type when genre/origin are unknown", () => {
    expect(classifyMediaType({ baseType: "movie", genreIds: [], originCountries: [] })).toBe("movie");
    expect(classifyMediaType({ baseType: "tv", genreIds: [], originCountries: [] })).toBe("tv");
  });
});

describe("classifyLibraryCategory — the four Emby shelves", () => {
  it("keeps every film on 电影, animated or not", () => {
    expect(classifyLibraryCategory({ mediaType: "movie", genreIds: [16] })).toBe("movies");
    expect(classifyLibraryCategory({ mediaType: "movie", genreIds: [99] })).toBe("movies");
  });

  it("puts animated series on 动漫", () => {
    expect(classifyLibraryCategory({ mediaType: "anime", genreIds: [16, 10759] })).toBe("anime");
  });

  it("puts variety/documentary/news/reality/talk series on 综艺", () => {
    for (const genre of [99, 10763, 10764, 10767]) {
      expect(classifyLibraryCategory({ mediaType: "tv", genreIds: [genre] })).toBe("variety");
    }
  });

  it("puts every other series on 电视剧", () => {
    expect(classifyLibraryCategory({ mediaType: "tv", genreIds: [18, 10759] })).toBe("tv");
    expect(classifyLibraryCategory({ mediaType: "tv" })).toBe("tv");
  });

  it("a persisted override wins over the inferred category", () => {
    expect(libraryCategoryOf({ type: "tv", libraryCategory: "variety" })).toBe("variety");
    expect(libraryCategoryOf({ type: "anime" })).toBe("anime");
  });
});
