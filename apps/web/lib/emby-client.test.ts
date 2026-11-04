import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBY_LIBRARY_NAMES,
  episodesInEmby,
  fetchEmbyImage,
  listEmbyLibraryItems,
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
  it("finds the library by configured name, matches the series by TMDB id, returns SxxExx", async () => {
    stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-tv", Name: "电视剧" }] }],
      [
        "IncludeItemTypes=Series",
        { Items: [{ Id: "series-1", ProviderIds: { Tmdb: "1399" } }] },
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
  });

  it("returns [] when the configured library is missing", async () => {
    stubFetch([["/Library/MediaFolders", { Items: [{ Id: "lib-x", Name: "别的库" }] }]]);
    expect(await episodesInEmby(config, { tmdbId: 1399, category: "tv" })).toEqual([]);
  });

  it("returns [] when the series is not in Emby", async () => {
    stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-tv", Name: "电视剧" }] }],
      ["IncludeItemTypes=Series", { Items: [{ Id: "series-1", ProviderIds: { Tmdb: "1" } }] }],
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
});

describe("movieInEmby", () => {
  it("matches a movie by TMDB id in the movies library", async () => {
    stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-movies", Name: "电影" }] }],
      ["IncludeItemTypes=Movie", { Items: [{ Id: "m1", ProviderIds: { Tmdb: "603" } }] }],
    ]);
    expect(await movieInEmby(config, { tmdbId: 603 })).toBe(true);
    expect(await movieInEmby(config, { tmdbId: 604 })).toBe(false);
  });
});

describe("listEmbyLibraryItems", () => {
  it("maps movies + series with TMDB ids, dedupes, and keeps the image flag", async () => {
    stubFetch([
      ["/Library/MediaFolders", { Items: [{ Id: "lib-v", Name: "综艺" }] }],
      [
        "IncludeItemTypes=Movie%2CSeries",
        {
          Items: [
            {
              Id: "i1",
              Name: "爸爸当家",
              Type: "Series",
              ProductionYear: 2022,
              ProviderIds: { Tmdb: "201781" },
              ImageTags: { Primary: "tag" },
            },
            { Id: "i2", Name: "无 TMDB", Type: "Series", ProviderIds: {} },
            // Emby often lists the same work twice (two folders); keep one card.
            { Id: "i3", Name: "爸爸当家", Type: "Series", ProductionYear: 2022, ProviderIds: { Tmdb: "201781" } },
            { Id: "i4", Name: "动画电影", Type: "Movie", ProductionYear: 2020, ProviderIds: { Tmdb: "99" } },
          ],
        },
      ],
    ]);
    expect(await listEmbyLibraryItems(config, "variety")).toEqual([
      { id: "i1", tmdbId: 201781, name: "爸爸当家", year: 2022, type: "tv", hasPrimaryImage: true },
      { id: "i4", tmdbId: 99, name: "动画电影", year: 2020, type: "movie", hasPrimaryImage: false },
    ]);
  });

  it("returns [] when the library name does not exist", async () => {
    stubFetch([["/Library/MediaFolders", { Items: [{ Id: "lib-x", Name: "别的库" }] }]]);
    expect(await listEmbyLibraryItems(config, "variety")).toEqual([]);
  });

  it("fails open when Emby errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listEmbyLibraryItems(config, "variety")).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("fetchEmbyImage", () => {
  it("returns the image bytes and content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
      ),
    );
    const image = await fetchEmbyImage(config, "item-1");
    expect(image?.contentType).toBe("image/png");
    expect(new Uint8Array(image!.body)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await fetchEmbyImage(config, "item-1")).toBeNull();
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
