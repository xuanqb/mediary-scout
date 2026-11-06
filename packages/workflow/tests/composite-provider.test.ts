import { describe, expect, it } from "vitest";
import { CompositeResourceProvider } from "../src/index.js";
import type { ResourceProvider, ResourceSnapshot } from "../src/index.js";

function fakeProvider(
  name: string,
  candidates: Array<{ url: string; infoHash?: string }>,
  throws = false,
): ResourceProvider {
  return {
    async search(input: { keyword: string }): Promise<ResourceSnapshot> {
      if (throws) throw new Error(`${name} down`);
      return {
        id: `${name}_snap`,
        provider: name,
        keyword: input.keyword,
        createdAt: "2026-06-17T00:00:00.000Z",
        candidates: candidates.map((c, index) => ({
          id: `${name}_c${index + 1}`,
          snapshotId: `${name}_snap`,
          index,
          title: `${name} ${index}`,
          type: c.infoHash ? "magnet" : "115",
          source: name,
          providerPayload: c.infoHash ? { url: c.url, infoHash: c.infoHash } : { url: c.url },
        })),
      };
    },
  };
}

describe("CompositeResourceProvider", () => {
  it("merges candidates from all providers into one snapshot with sequential ids", async () => {
    const composite = new CompositeResourceProvider({
      now: () => "2026-06-17T00:00:00.000Z",
      providers: [
        { name: "pansou", provider: fakeProvider("pansou", [{ url: "115://a" }]) },
        { name: "prowlarr", provider: fakeProvider("prowlarr", [{ url: "magnet:?xt=urn:btih:bbb", infoHash: "bbb" }]) },
      ],
    });
    const snap = await composite.search({ keyword: "x" });
    expect(snap.provider).toBe("composite");
    expect(snap.candidates).toHaveLength(2);
    expect(snap.candidates.map((c) => c.index)).toEqual([0, 1]);
    expect(snap.candidates.map((c) => c.id)).toEqual([
      `${snap.id}_candidate_1`,
      `${snap.id}_candidate_2`,
    ]);
    expect(snap.candidates.map((c) => c.source)).toEqual(["pansou", "prowlarr"]);
  });

  it("dedupes by infohash across providers", async () => {
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: fakeProvider("pansou", [{ url: "magnet:?xt=urn:btih:dup", infoHash: "dup" }]) },
        { name: "prowlarr", provider: fakeProvider("prowlarr", [{ url: "magnet:?xt=urn:btih:dup&x=1", infoHash: "DUP" }]) },
      ],
    });
    const snap = await composite.search({ keyword: "x" });
    expect(snap.candidates).toHaveLength(1);
  });

  it("keeps other providers' results when one throws", async () => {
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: fakeProvider("pansou", [{ url: "115://a" }]) },
        { name: "prowlarr", provider: fakeProvider("prowlarr", [], true) },
      ],
    });
    const snap = await composite.search({ keyword: "x" });
    expect(snap.candidates).toHaveLength(1);
    expect(snap.candidates[0]!.source).toBe("pansou");
  });

  it("records every provider's contribution so a 0-result source is visible", async () => {
    const tgto: ResourceProvider = {
      async search(input) {
        return {
          id: "tgto_snap",
          provider: "tgto",
          keyword: input.keyword,
          createdAt: "2026-06-17T00:00:00.000Z",
          candidates: [],
          sourceStats: [
            {
              name: "tgto",
              status: "degraded",
              candidates: 0,
              filtered: [{ reason: "points_unknown", count: 3 }],
              error: "1 个上游源报错：re0 timeout",
            },
          ],
          sourceHealth: { status: "degraded", unhealthySources: ["tgto"] },
        };
      },
    };
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: fakeProvider("pansou", [{ url: "115://a" }, { url: "115://b" }]) },
        { name: "tgto", provider: tgto },
        { name: "haisou", provider: fakeProvider("haisou", [], true) },
      ],
    });
    const snap = await composite.search({ keyword: "x" });
    expect(snap.sourceStats).toEqual([
      { name: "pansou", status: "healthy", candidates: 2 },
      {
        name: "tgto",
        status: "degraded",
        candidates: 0,
        filtered: [{ reason: "points_unknown", count: 3 }],
        error: "1 个上游源报错：re0 timeout",
      },
      { name: "haisou", status: "unreachable", candidates: 0, error: "haisou down" },
    ]);
  });

  it("carries a member's cached flag into the composite stats", async () => {
    const tgto: ResourceProvider = {
      async search(input) {
        return {
          id: "tgto_snap",
          provider: "tgto",
          keyword: input.keyword,
          createdAt: "2026-06-17T00:00:00.000Z",
          candidates: [],
          sourceStats: [{ name: "tgto", status: "healthy", candidates: 0, cached: true }],
        };
      },
    };
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: fakeProvider("pansou", []) },
        { name: "tgto", provider: tgto },
      ],
    });
    const snap = await composite.search({ keyword: "x" });
    expect(snap.sourceStats?.[1]).toEqual({ name: "tgto", status: "healthy", candidates: 0, cached: true });
  });

  it("records why a source failed, so a transient timeout is explainable later", async () => {
    const timedOut: ResourceProvider = {
      async search() {
        throw Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        });
      },
    };
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: fakeProvider("pansou", []) },
        { name: "tgto", provider: timedOut },
      ],
    });
    const snap = await composite.search({ keyword: "x" });
    expect(snap.sourceStats).toEqual([
      { name: "pansou", status: "healthy", candidates: 0 },
      { name: "tgto", status: "unreachable", candidates: 0, error: "请求超时" },
    ]);
  });
});
