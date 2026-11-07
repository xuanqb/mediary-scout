import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBY_LIBRARY_NAMES,
  EmbyUnavailableError,
  episodesInEmby,
  movieInEmby,
  probeEmby,
  refreshEmbyLibrary,
  type EmbyConfig,
} from "./emby-client";

const config: EmbyConfig = {
  baseUrl: "http://emby.lan:8096/",
  apiKey: "secret",
  libraryNames: DEFAULT_EMBY_LIBRARY_NAMES,
};

type Call = { url: string; init?: RequestInit | undefined };

/** Routes by path substring; every request pushed to `calls` for assertions. */
function stubFetch(routes: Array<[string, unknown]>, calls: Call[] = []): Call[] {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const route = routes.find(([path]) => String(url).includes(path));
      if (!route) return new Response("not found", { status: 404 });
      const body = route[1];
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeEmby", () => {
  it("sends the API key and reports the library names", async () => {
    const calls = stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "1", Name: "电影" }, { Id: "2", Name: "电视剧" }] }],
    ]);
    const result = await probeEmby(config);
    expect(result).toEqual({ ok: true, message: "已连接，媒体库：电影、电视剧" });
    expect(calls[0]!.url).toBe("http://emby.lan:8096/Library/MediaFolders");
    expect((calls[0]!.init?.headers as Record<string, string>)["X-Emby-Token"]).toBe("secret");
  });

  it("reports failure instead of throwing when Emby is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    const result = await probeEmby(config);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fetch failed");
  });
});

describe("episodesInEmby", () => {
  it("looks the series up server-side by TMDB id, returns SxxExx", async () => {
    const calls = stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-tv", Name: "电视剧" }] }],
      [
        "AnyProviderIdEquals=Tmdb.1399",
        { Items: [{ Id: "series-1" }] },
      ],
      [
        "IncludeItemTypes=Episode",
        {
          Items: [
            { Id: "e1", ParentIndexNumber: 1, IndexNumber: 2 },
            { Id: "e2", ParentIndexNumber: 1, IndexNumber: 10 },
            { Id: "e3" }, // no numbers → skipped
          ],
        },
      ],
    ]);
    const codes = await episodesInEmby(config, { tmdbId: 1399, category: "tv" });
    expect(codes).toEqual(["S01E02", "S01E10"]);
    const seriesCall = calls.find((call) => call.url.includes("IncludeItemTypes=Series"));
    expect(seriesCall?.url).toContain("AnyProviderIdEquals=Tmdb.1399");
    expect(seriesCall?.url).toContain("ParentId=lib-tv");
  });

  it("returns [] when the configured library is missing", async () => {
    stubFetch([["/Library/MediaFolders", { Items: [{ Id: "lib-x", Name: "别的库" }] }]]);
    expect(await episodesInEmby(config, { tmdbId: 1399, category: "tv" })).toEqual([]);
  });

  it("returns [] when the series is not in Emby", async () => {
    stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-tv", Name: "电视剧" }] }],
      ["AnyProviderIdEquals=Tmdb.1399", { Items: [] }],
    ]);
    expect(await episodesInEmby(config, { tmdbId: 1399, category: "tv" })).toEqual([]);
  });

  it("fails open when the request errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await episodesInEmby(config, { tmdbId: 1399, category: "tv" })).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails closed with EMBY_UNAVAILABLE for provider tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(
      episodesInEmby(config, { tmdbId: 1399, category: "tv" }, { failClosed: true }),
    ).rejects.toBeInstanceOf(EmbyUnavailableError);
    await expect(
      episodesInEmby(config, { tmdbId: 1399, category: "tv" }, { failClosed: true }),
    ).rejects.toThrow(/EMBY_UNAVAILABLE: network error/);
  });

  it("fails closed when a configured library is missing", async () => {
    stubFetch([["/Library/MediaFolders", { Items: [{ Id: "lib-x", Name: "别的库" }] }]]);
    await expect(
      episodesInEmby(config, { tmdbId: 1399, category: "tv" }, { failClosed: true }),
    ).rejects.toBeInstanceOf(EmbyUnavailableError);
  });

  it("unions episodes across all series shelves regardless of our category", async () => {
    const calls = stubFetch([
      [
        "/Library/MediaFolders",
        {
          Items: [
            { Id: "lib-tv", Name: "电视剧" },
            { Id: "lib-anime", Name: "动漫" },
          ],
        },
      ],
      ["AnyProviderIdEquals=Tmdb.1399", { Items: [{ Id: "series-1" }] }],
      ["IncludeItemTypes=Episode", { Items: [{ ParentIndexNumber: 2, IndexNumber: 3 }] }],
    ]);
    // We classify it as Anime; USAPI might place it on the TV shelf.
    const codes = await episodesInEmby(
      config,
      { tmdbId: 1399, category: "anime" },
      { failClosed: true, categories: ["tv", "variety", "anime"] },
    );
    expect(codes).toEqual(["S02E03"]);
    expect(
      calls.some(
        (call) => call.url.includes("IncludeItemTypes=Series") && call.url.includes("ParentId=lib-tv"),
      ),
    ).toBe(true);
  });
});

describe("movieInEmby", () => {
  it("matches a movie by TMDB id in the movies library", async () => {
    stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-movies", Name: "电影" }] }],
      ["AnyProviderIdEquals=Tmdb.603", { Items: [{ Id: "m1" }] }],
      ["AnyProviderIdEquals=Tmdb.604", { Items: [] }],
    ]);
    expect(await movieInEmby(config, { tmdbId: 603 })).toBe(true);
    expect(await movieInEmby(config, { tmdbId: 604 })).toBe(false);
  });

  it("fails closed for provider tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    await expect(
      movieInEmby(config, { tmdbId: 603 }, { failClosed: true }),
    ).rejects.toBeInstanceOf(EmbyUnavailableError);
  });
});

describe("refreshEmbyLibrary", () => {
  it("POSTs /Library/Refresh with the token", async () => {
    const calls = stubFetch([["/Library/Refresh", {}]]);
    expect(await refreshEmbyLibrary(config)).toBe(true);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://emby.lan:8096/Library/Refresh");
  });

  it("swallows errors and returns false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await refreshEmbyLibrary(config)).toBe(false);
    vi.restoreAllMocks();
  });
});
