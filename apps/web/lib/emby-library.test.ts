import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as unknown,
  calls: [] as string[],
}));

vi.mock("./workflow-runtime", () => ({
  resolveAccountEmbyConfig: async () => h.config,
}));

vi.mock("./emby-client", () => ({
  listEmbyLibraryItems: async (_config: unknown, category: string) => {
    h.calls.push(category);
    return [
      {
        id: `${category}-1`,
        tmdbId: 1,
        name: `Emby ${category}`,
        year: 2024,
        type: category === "movies" ? "movie" : "tv",
        hasPrimaryImage: false,
      },
    ];
  },
}));

import { clearEmbyLibraryCache, listEmbyLibrariesForAccount } from "./emby-library";

beforeEach(() => {
  clearEmbyLibraryCache();
  h.config = null;
  h.calls.length = 0;
});

describe("listEmbyLibrariesForAccount", () => {
  it("returns nothing and never calls Emby when Emby is not configured", async () => {
    expect(await listEmbyLibrariesForAccount("acct")).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("loads all four shelves and caches them across library page loads", async () => {
    h.config = { baseUrl: "http://emby", apiKey: "k", libraryNames: {} };
    const first = await listEmbyLibrariesForAccount("acct");
    expect(first.map((entry) => entry.category)).toEqual(["movies", "tv", "variety", "anime"]);
    expect(h.calls).toEqual(["movies", "tv", "variety", "anime"]);

    const second = await listEmbyLibrariesForAccount("acct");
    expect(second).toEqual(first);
    expect(h.calls).toHaveLength(4);
  });

  it("clearing the cached account makes the next load refetch", async () => {
    h.config = { baseUrl: "http://emby", apiKey: "k", libraryNames: {} };
    await listEmbyLibrariesForAccount("acct");
    clearEmbyLibraryCache("acct");
    await listEmbyLibrariesForAccount("acct");
    expect(h.calls).toHaveLength(8);
  });
});
