import { describe, expect, it } from "vitest";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  formatDriveSpaceSummary,
  InMemoryWorkflowRepository,
  Pan115CookieClient,
  QuarkCookieClient,
  resolveWorkerDeps,
  sortDrivesByOrder,
  type AcquisitionDriveContext,
} from "../src/index.js";

describe("drive space querying + cache + summary formatting", () => {
  it("Pan115CookieClient.getSpace parses /user/space all_total.size and all_use.size", async () => {
    let calledUrl = "";
    const client = new Pan115CookieClient({
      cookie: "UID=103164004_A1_1; CID=a; SEID=b",
      fetchJson: async (url) => {
        calledUrl = url;
        return {
          state: true,
          data: {
            all_total: { size: 43996571238400, size_format: "40.01TB" },
            all_remain: { size: 23166891805517, size_format: "21.07TB" },
            all_use: { size: 20829679432883, size_format: "18.94TB" },
          },
        };
      },
    });
    const space = await client.getSpace();
    expect(calledUrl).toBe("https://webapi.115.com/user/space");
    expect(space).toEqual({
      totalBytes: 43996571238400,
      usedBytes: 20829679432883,
    });
  });

  it("QuarkCookieClient.getSpace parses /1/clouddrive/member (over-quota)", async () => {
    const quarkClient = new QuarkCookieClient({
      cookie: "__uid=u1; __pus=p1",
      fetchJson: async () => ({
        status: 200,
        code: 0,
        data: {
          total_capacity: 10737418240,
          use_capacity: 1479851127848,
        },
      }),
    });
    const quarkSpace = await quarkClient.getSpace();
    expect(quarkSpace).toEqual({
      totalBytes: 10737418240,
      usedBytes: 1479851127848,
    });
    expect(quarkSpace!.totalBytes - quarkSpace!.usedBytes).toBeLessThan(0);
  });

  it("formatDriveSpaceSummary formats normal, over-quota (negative remaining), and unknown states", () => {
    const normal = formatDriveSpaceSummary({
      totalBytes: 40 * 1024 ** 4,
      usedBytes: 19 * 1024 ** 4,
    });
    expect(normal.overQuota).toBe(false);
    expect(normal.badgeText).toBe("剩余 21.00 TB / 40.00 TB");
    expect(normal.agentText).toBe("剩余 21.00 TB（总额 40.00 TB）");

    const overQuota = formatDriveSpaceSummary({
      totalBytes: 10 * 1024 ** 3,
      usedBytes: 1378 * 1024 ** 3,
    });
    expect(overQuota.overQuota).toBe(true);
    expect(overQuota.remainingBytes).toBeLessThan(0);
    expect(overQuota.badgeText).toContain("已超额");
    expect(overQuota.agentText).toContain("禁止写入");

    const unknown = formatDriveSpaceSummary(null);
    expect(unknown.overQuota).toBe(false);
    expect(unknown.remainingBytes).toBeNull();
    expect(unknown.badgeText).toBe("容量未知");
  });

  it("stores and retrieves drive_space_cache entries in repository", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await repo.getDriveSpaceCache("cs_1")).toBeNull();
    await repo.upsertDriveSpaceCache({
      storageId: "cs_1",
      totalBytes: 1000,
      usedBytes: 400,
      probedAt: "2026-10-27T12:00:00.000Z",
    });
    expect(await repo.getDriveSpaceCache("cs_1")).toEqual({
      storageId: "cs_1",
      totalBytes: 1000,
      usedBytes: 400,
      probedAt: "2026-10-27T12:00:00.000Z",
    });

    // Non-finite numbers must not overwrite valid cached entries.
    await repo.upsertDriveSpaceCache({
      storageId: "cs_1",
      totalBytes: Number.NaN,
      usedBytes: 400,
      probedAt: "2026-10-27T12:05:00.000Z",
    });
    expect(await repo.getDriveSpaceCache("cs_1")).toEqual({
      storageId: "cs_1",
      totalBytes: 1000,
      usedBytes: 400,
      probedAt: "2026-10-27T12:00:00.000Z",
    });
  });

  it("rejects null or empty-string metrics instead of coercing them to 0", async () => {
    const pan115 = new Pan115CookieClient({
      cookie: "UID=103164004_A1_1; CID=a; SEID=b",
      fetchJson: async () => ({
        state: true,
        data: { all_total: { size: 1000 }, all_use: { size: null } },
      }),
    });
    expect(await pan115.getSpace()).toBeNull();

    const quark = new QuarkCookieClient({
      cookie: "__uid=u1; __pus=p1",
      fetchJson: async () => ({
        status: 200,
        code: 0,
        data: { total_capacity: 1000, use_capacity: "" },
      }),
    });
    expect(await quark.getSpace()).toBeNull();
  });

  it("sortDrivesByOrder orders drives by user preference and falls back to createdAt for unlisted drives", () => {
    const drives = [
      { id: "cs_115", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "cs_quark", createdAt: "2026-06-02T00:00:00.000Z" },
      { id: "cs_quark2", createdAt: "2026-06-03T00:00:00.000Z" },
    ];
    expect(sortDrivesByOrder(drives, ["cs_quark2", "cs_115"]).map((d) => d.id)).toEqual([
      "cs_quark2",
      "cs_115",
      "cs_quark",
    ]);
    expect(sortDrivesByOrder(drives, []).map((d) => d.id)).toEqual([
      "cs_115",
      "cs_quark",
      "cs_quark2",
    ]);
  });

  it("resolveWorkerDeps threads the resolved multi-drive contexts through to callers", async () => {
    const fakeExec = new FakeStorageExecutor({ transferOutcomes: {} });
    const fakeProvider = new FakeResourceProvider({ keywordResults: {} });
    const mockDrives: AcquisitionDriveContext[] = [
      {
        storageId: "cs_115",
        provider: "pan115",
        label: "115 网盘",
        storage: fakeExec,
        parents: { tv: "tv_115", anime: "anime_115", movies: "mov_115", variety: "var_115" },
        space: { totalBytes: 40 * 1024 ** 4, usedBytes: 19 * 1024 ** 4 },
      },
      {
        storageId: "cs_quark",
        provider: "quark",
        label: "夸克网盘",
        storage: fakeExec,
        parents: { tv: "tv_quark", anime: "anime_quark", movies: "mov_quark", variety: "var_quark" },
        space: { totalBytes: 20 * 1024 ** 4, usedBytes: 2 * 1024 ** 4 },
      },
    ];
    const resolved = await resolveWorkerDeps(
      async () => ({ drives: mockDrives }),
      "acct_default",
      "cs_115",
      {
        storage: fakeExec,
        resourceProvider: fakeProvider,
        model: {} as never,
      },
    );
    expect(resolved.drives).toEqual(mockDrives);
  });
});
