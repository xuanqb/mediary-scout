import { describe, expect, it, vi } from "vitest";
import { CompositeResourceProvider } from "../src/composite-provider.js";
import type { ResourceCandidate, ResourceSnapshot } from "../src/domain.js";
import type { ResourceProvider } from "../src/ports.js";
import {
  TgtoClient,
  TgtoResourceProvider,
  TgtoShareLinkResolver,
  parseSizeToBytes,
} from "../src/tgto-provider.js";
import type { TgtoFetchJson } from "../src/tgto-provider.js";

const NOW = "2026-11-05T00:00:00.000Z";

function shareItem(overrides: Record<string, unknown> = {}) {
  return {
    title: "沙丘 (2021)",
    message_text: "[LGNB]沙丘 4K-REMUX",
    slug: "7c467fe304a311f08b0d0242ac130007",
    source: "re0",
    provider: "115",
    link_type: "share",
    size: "81.10GB",
    resource_specification: "2160p.REMUX",
    resolution: "2160p",
    episode: { kind: "none", season_num: null, episode_num: null, end_episode_num: null, source_text: "" },
    subtitle_languages: ["简中", "繁中", "简英双语"],
    subtitle_types: ["内封"],
    supported_targets: ["115"],
    validate_status: "valid",
    unlock_points: 0,
    points_known: true,
    is_unlocked: true,
    item_key: "key-1",
    published_at: "2025-03-19 09:21:06",
    ...overrides,
  };
}

function magnetItem(overrides: Record<string, unknown> = {}) {
  return {
    title: "Dune.2021.1080p",
    slug: "",
    source: "guanying",
    provider: "offline",
    link_type: "magnet",
    share_url: "magnet:?xt=urn:btih:cb7d15e81b2e8497990c200277058da2fe26efeb&dn=Dune",
    size: "4.39G",
    resource_specification: "1080p.HDRip",
    resolution: "1080p",
    episode: { kind: "none" },
    supported_targets: ["115", "123", "guangya"],
    validate_status: "unknown",
    unlock_points: 0,
    points_known: true,
    is_unlocked: false,
    ...overrides,
  };
}

function okResponse(items: unknown[]) {
  return { success: true, data: { items, errors: [], media_type: "movie", provider: "115" } };
}

function provider(fetchJson: TgtoFetchJson, extra?: { maxPoints?: number; allowedTypes?: readonly ("115" | "quark" | "magnet" | "manual")[] }) {
  return new TgtoResourceProvider({
    client: new TgtoClient({ baseUrl: "http://tgto.local:12366/", token: "tgto__test", fetchJson, timeoutMs: 1000 }),
    now: () => NOW,
    ...(extra?.maxPoints === undefined ? {} : { maxPoints: extra.maxPoints }),
    ...(extra?.allowedTypes ? { allowedTypes: extra.allowedTypes } : {}),
  });
}

describe("TgtoResourceProvider", () => {
  it("maps a share item to a 115 candidate with a lazy tgto ref and no url", async () => {
    const p = provider(async () => okResponse([shareItem()]));
    const snapshot = await p.search({ keyword: "沙丘" });
    const candidate = snapshot.candidates[0]!;
    expect(candidate.type).toBe("115");
    expect(candidate.providerPayload["url"]).toBeUndefined();
    expect(candidate.providerPayload["tgto"]).toEqual({
      slug: "7c467fe304a311f08b0d0242ac130007",
      source: "re0",
      provider: "115",
    });
    expect(candidate.providerPayload["targetProvider"]).toBe("115");
    expect(candidate.providerPayload["sizeBytes"]).toBe(Math.round(81.1 * 1024 ** 3));
    expect(candidate.providerPayload["datetime"]).toBe("2025-03-19");
    expect(candidate.title).toContain("2160p.REMUX");
    expect(candidate.title).toContain("字幕:简中/繁中/简英双语(内封)");
    expect(candidate.title).toContain("81.10GB");
  });

  it("keeps a magnet item's url (copy-link never needed for it)", async () => {
    const p = provider(async () => okResponse([magnetItem()]));
    const snapshot = await p.search({ keyword: "沙丘" });
    const candidate = snapshot.candidates[0]!;
    expect(candidate.type).toBe("magnet");
    expect(String(candidate.providerPayload["url"])).toMatch(/^magnet:/);
    expect(candidate.providerPayload["infoHash"]).toBe("cb7d15e81b2e8497990c200277058da2fe26efeb");
    expect(candidate.providerPayload["tgto"]).toBeUndefined();
    expect(candidate.title).not.toContain("字幕:");
  });

  it("never sees a candidate above the points cap (default 0 = no automatic spend)", async () => {
    const p = provider(async () => okResponse([
      shareItem({ unlock_points: 0 }),
      shareItem({ slug: "s2", unlock_points: 4 }),
      shareItem({ slug: "s3", unlock_points: 8 }),
    ]));
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(snapshot.candidates).toHaveLength(1);
  });

  it("includes paid items only when the cap allows them", async () => {
    const p = provider(async () => okResponse([shareItem({ unlock_points: 4 })]), { maxPoints: 4 });
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(snapshot.candidates).toHaveLength(1);
  });

  it("drops unknown cost, invalid links, and non-115 targets", async () => {
    const p = provider(async () => okResponse([
      shareItem({ slug: "unknown", points_known: false }),
      shareItem({ slug: "invalid", validate_status: "invalid" }),
      shareItem({ slug: "only123", supported_targets: ["123"] }),
      shareItem({ slug: "" }),
    ]));
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(snapshot.candidates).toHaveLength(0);
    // A 0-result source must stay explainable: the trace shows these reasons.
    expect(snapshot.sourceStats).toEqual([
      {
        name: "tgto",
        status: "healthy",
        candidates: 0,
        filtered: [
          { reason: "points_unknown", count: 1 },
          { reason: "invalid", count: 1 },
          { reason: "target_not_115", count: 1 },
          { reason: "no_share_ref", count: 1 },
        ],
      },
    ]);
  });

  it("carries upstream source errors when an empty result is degraded", async () => {
    const p = provider(async () => ({
      success: true,
      data: {
        items: [],
        errors: [{ source: "re0", error: "timeout" }, "观影 429"],
        media_type: "tv",
        provider: "115",
      },
    }));
    const snapshot = await p.search({ keyword: "后会友期" });
    expect(snapshot.sourceStats).toEqual([
      {
        name: "tgto",
        status: "degraded",
        candidates: 0,
        error: '2 个上游源报错：{"source":"re0","error":"timeout"}；观影 429',
      },
    ]);
    expect(snapshot.sourceHealth?.status).toBe("degraded");
  });

  it("reports kept candidates and omits the filter list when nothing was dropped", async () => {
    const p = provider(async () => okResponse([shareItem(), magnetItem()]));
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(snapshot.sourceStats).toEqual([
      { name: "tgto", status: "healthy", candidates: 2 },
    ]);
  });

  it("sends tmdb identity but never a season", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const p = provider(async (_url, init) => {
      bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return okResponse([]);
    });
    // A single-season task used to send season:1 — Tgto silently drops shares
    // whose title carries no season tag (the only 115 hit for 后会友期), so the
    // season must be left out even for a one-season scope.
    await p.search({
      keyword: "怪奇物语",
      context: { title: "怪奇物语", tmdbId: 66732, mediaType: "tv", year: 2016, seasons: [1] },
    });
    expect(bodies[0]).toMatchObject({
      title: "怪奇物语",
      tmdb_id: 66732,
      media_type: "tv",
      year: 2016,
    });
    // Target filtering happens locally (supported_targets must include 115);
    // asking Tgto to filter too only risks dropping valid results.
    expect(bodies[0]).not.toHaveProperty("provider");
    expect(bodies[0]).not.toHaveProperty("season");

    await p.search({
      keyword: "怪奇物语",
      context: { title: "怪奇物语", tmdbId: 66732, mediaType: "tv", seasons: [1, 2] },
    });
    expect(bodies[1]).not.toHaveProperty("season");
  });

  it("searches the requested keyword, not the canonical title (Tgto ignores aliases)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const p = provider(async (_url, init) => {
      bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return okResponse([]);
    });
    await p.search({
      keyword: "再见朋友",
      context: {
        title: "后会友期",
        tmdbId: 338938,
        mediaType: "tv",
        seasons: [1],
        aliases: ["再见朋友"],
      },
    });
    expect(bodies[0]).toMatchObject({ title: "再见朋友", tmdb_id: 338938 });
    expect(bodies[0]).not.toHaveProperty("aliases");
  });

  it("does not query upstream when the drive is not 115", async () => {
    const fetchJson = vi.fn(async () => okResponse([]));
    const p = provider(fetchJson, { allowedTypes: ["quark"] });
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(snapshot.candidates).toHaveLength(0);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("reports the source unreachable instead of throwing", async () => {
    const p = provider(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(snapshot.candidates).toHaveLength(0);
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
  });

  it("retries a timed-out search once, then succeeds", async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        });
      }
      return okResponse([shareItem()]);
    });
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(calls).toBe(2);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });

  it("gives up after a single retry when the source stays down", async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    });
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(calls).toBe(2);
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
  });

  it("does not retry a search the upstream explicitly rejected", async () => {
    const fetchJson = vi.fn(async () => ({ success: false, error: "bad request" }));
    const p = provider(fetchJson);
    const snapshot = await p.search({ keyword: "沙丘" });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
  });
});

describe("TgtoShareLinkResolver", () => {
  function candidate(payload: Record<string, unknown>): ResourceCandidate {
    return {
      id: "c1",
      snapshotId: "s1",
      index: 0,
      title: "沙丘",
      type: "115",
      source: "tgto",
      providerPayload: payload,
    };
  }

  it("exchanges slug/source via copy-link and keeps the password from the url", async () => {
    const fetchJson = vi.fn<TgtoFetchJson>(async () => ({
      success: true,
      data: { share_url: "https://115cdn.com/s/swhjxry3nc0?password=r4d1", points: 0, already_owned: true },
    }));
    const resolver = new TgtoShareLinkResolver(new TgtoClient({ baseUrl: "http://tgto.local", token: "t", fetchJson }));
    const resolved = await resolver.resolve(candidate({ tgto: { slug: "abc", source: "re0", provider: "115" } }));
    expect(resolved.providerPayload["url"]).toBe("https://115cdn.com/s/swhjxry3nc0?password=r4d1");
    expect(resolved.providerPayload["password"]).toBe("r4d1");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    const [url, init] = fetchJson.mock.calls[0]!;
    expect(url).toBe("http://tgto.local/api/media/resources/copy-link");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ provider: "115", slug: "abc", source: "re0" });
  });

  it("does not call copy-link again once the url is known", async () => {
    const fetchJson = vi.fn<TgtoFetchJson>(async () => okResponse([]));
    const resolver = new TgtoShareLinkResolver(new TgtoClient({ baseUrl: "http://tgto.local", token: "t", fetchJson }));
    const original = candidate({ url: "https://115cdn.com/s/x?password=1", tgto: { slug: "abc", source: "re0", provider: "115" } });
    const resolved = await resolver.resolve(original);
    expect(resolved).toBe(original);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("leaves another provider's candidate untouched", async () => {
    const fetchJson = vi.fn<TgtoFetchJson>(async () => okResponse([]));
    const resolver = new TgtoShareLinkResolver(new TgtoClient({ baseUrl: "http://tgto.local", token: "t", fetchJson }));
    const original = candidate({ title: "pansou" });
    expect(await resolver.resolve(original)).toBe(original);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe("CompositeResourceProvider lazy-link delegation", () => {
  it("routes resolution to the member that owns the candidate", async () => {
    const lazy = {
      search: async (): Promise<ResourceSnapshot> => ({ id: "s", provider: "tgto", keyword: "k", candidates: [], createdAt: NOW }),
      resolveCandidateLink: async (c: ResourceCandidate): Promise<ResourceCandidate> =>
        c.source === "tgto" ? { ...c, providerPayload: { ...c.providerPayload, url: "https://115cdn.com/s/x" } } : c,
    } satisfies ResourceProvider & { resolveCandidateLink: (c: ResourceCandidate) => Promise<ResourceCandidate> };
    const plain: ResourceProvider = {
      search: async () => ({ id: "p", provider: "pansou", keyword: "k", candidates: [], createdAt: NOW }),
    };
    const composite = new CompositeResourceProvider({
      providers: [{ name: "pansou", provider: plain }, { name: "tgto", provider: lazy }],
    });
    const input: ResourceCandidate = { id: "c", snapshotId: "s", index: 0, title: "t", type: "115", source: "tgto", providerPayload: {} };
    const resolved = await composite.resolveCandidateLink(input);
    expect(resolved.providerPayload["url"]).toBe("https://115cdn.com/s/x");
  });
});

describe("parseSizeToBytes", () => {
  it("parses the shapes Tgto emits", () => {
    expect(parseSizeToBytes("81.10GB")).toBe(Math.round(81.1 * 1024 ** 3));
    expect(parseSizeToBytes("896.57M")).toBe(Math.round(896.57 * 1024 ** 2));
    expect(parseSizeToBytes("4.39G")).toBe(Math.round(4.39 * 1024 ** 3));
    expect(parseSizeToBytes("")).toBe(0);
    expect(parseSizeToBytes("unknown")).toBe(0);
  });
});
