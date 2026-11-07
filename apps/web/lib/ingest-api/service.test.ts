import { describe, expect, it } from "vitest";
import { IngestRequestError, parseIngestCreate } from "./service";

const movieBody = {
  request_id: "usapi-20261106-8f3c2a",
  media: { tmdb_id: "278", type: "movie", year: 1994, title: "肖申克的救赎" },
  options: { quality: "best" },
};

const seriesBody = {
  request_id: "usapi-20261106-a91d7b",
  media: { tmdb_id: "275297", type: "series", season_number: 2, year: 2026, title: "走马上任" },
};

describe("parseIngestCreate", () => {
  it("parses a movie request", () => {
    expect(parseIngestCreate(movieBody)).toEqual({
      requestId: "usapi-20261106-8f3c2a",
      tmdbId: 278,
      mediaType: "movie",
      seasonNumber: null,
      year: 1994,
      title: "肖申克的救赎",
      quality: "best",
    });
  });

  it("parses a series request and defaults an unknown quality to best", () => {
    const parsed = parseIngestCreate({ ...seriesBody, options: { quality: "8k" } });
    expect(parsed.seasonNumber).toBe(2);
    expect(parsed.quality).toBe("best");
  });

  it("rejects a missing request_id", () => {
    expect(() => parseIngestCreate({ ...movieBody, request_id: "" })).toThrow(IngestRequestError);
  });

  it("rejects a series without a season number", () => {
    const { season_number: _season, ...media } = seriesBody.media;
    expect(() => parseIngestCreate({ ...seriesBody, media })).toThrow(IngestRequestError);
  });

  it("rejects an unsupported media type", () => {
    expect(() =>
      parseIngestCreate({ ...movieBody, media: { ...movieBody.media, type: "anime" } }),
    ).toThrow(IngestRequestError);
  });

  it("rejects a non-numeric tmdb id", () => {
    expect(() =>
      parseIngestCreate({ ...movieBody, media: { ...movieBody.media, tmdb_id: "tt0111161" } }),
    ).toThrow(IngestRequestError);
  });
});
