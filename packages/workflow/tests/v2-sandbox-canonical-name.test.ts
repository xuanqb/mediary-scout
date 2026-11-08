import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";

type PackFiles = Array<{ path: string; sizeBytes: number }>;

async function setup(input?: {
  title?: string;
  note?: string;
  files?: PackFiles;
  libraryTitle?: string;
  extraPacks?: Record<string, { files: PackFiles }>;
  extraSeason?: boolean;
}) {
  const title = input?.title ?? "凡人修仙传 (2020) · 2160p.WEB-DL";
  const provider = new FakeResourceProviderV2({
    results: {
      show: [
        {
          id: "cand",
          title,
          ...(input?.note === undefined ? {} : { note: input.note }),
        },
      ],
    },
  });
  const storage = new Storage115Simulator({
    packs: {
      cand: { files: input?.files ?? [{ path: "Pack/199.4K.mp4", sizeBytes: 1 }] },
      ...(input?.extraPacks ?? {}),
    },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const targetSeason2DirectoryId = input?.extraSeason
    ? await storage.createDirectory({ name: "Season 2", parentId: "root" })
    : undefined;
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: {
      1: targetSeasonDirectoryId,
      ...(targetSeason2DirectoryId === undefined ? {} : { 2: targetSeason2DirectoryId }),
    },
    ...(input?.libraryTitle === undefined ? {} : { libraryNaming: { title: input.libraryTitle } }),
  });
  return { sandbox, storage, stagingDirectoryId, targetSeasonDirectoryId };
}

async function transfer(sandbox: TaskSandbox) {
  const search = await sandbox.searchResources("show");
  return sandbox.transferCandidate({
    snapshotId: search.snapshot!.id,
    candidateId: "cand",
  });
}

describe("moveToSeason — canonical episode names", () => {
  it("exposes the per-video files/episodeCodes shape to the agent", () => {
    const tools = buildSandboxToolSet(
      new TaskSandbox({ provider: new FakeResourceProviderV2() }),
    ) as Record<string, { inputSchema: { parse: (value: unknown) => unknown } }>;
    expect(
      tools.moveToSeason!.inputSchema.parse({
        moves: [
          {
            season: 1,
            files: [{ fileId: "video", episodeCodes: ["S01E199"] }],
            fileIds: ["subtitle"],
          },
        ],
      }),
    ).toEqual({
      moves: [
        {
          season: 1,
          files: [{ fileId: "video", episodeCodes: ["S01E199"] }],
          fileIds: ["subtitle"],
        },
      ],
    });
  });

  it("renames an unparseable landed video to the MoviePilot TV format", async () => {
    const { sandbox } = await setup({ libraryTitle: "凡人修仙传" });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await sandbox.moveToSeason({
      moves: [{ season: 1, files: [{ fileId: video.id, episodeCodes: ["S01E199"] }] }],
    });

    expect(result.seasons[1]!.map((file) => file.path)).toEqual([
      "凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4",
    ]);
    const renamed = sandbox.auditTrail().find((event) => event.type === "episode_renamed");
    expect(renamed?.data).toMatchObject({
      from: "199.4K.mp4",
      to: "凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4",
      episodeCodes: ["S01E199"],
    });
  });

  it("leaves a name that already carries the mapped episode code alone", async () => {
    const { sandbox } = await setup({
      libraryTitle: "凡人修仙传",
      files: [{ path: "Pack/凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4", sizeBytes: 1 }],
    });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await sandbox.moveToSeason({
      moves: [{ season: 1, files: [{ fileId: video.id, episodeCodes: ["S01E199"] }] }],
    });

    expect(result.seasons[1]!.map((file) => file.path)).toEqual([
      "凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4",
    ]);
    expect(sandbox.auditTrail().some((event) => event.type === "episode_renamed")).toBe(false);
  });

  it("never overwrites an existing canonical name; appends - v2", async () => {
    const { sandbox, storage, targetSeasonDirectoryId } = await setup({
      libraryTitle: "凡人修仙传",
      extraPacks: {
        existing: {
          files: [{ path: "凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4", sizeBytes: 1 }],
        },
      },
    });
    await storage.transferCandidate({ candidateId: "existing", intoDirectoryId: targetSeasonDirectoryId });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await sandbox.moveToSeason({
      moves: [{ season: 1, files: [{ fileId: video.id, episodeCodes: ["S01E199"] }] }],
    });

    expect(result.seasons[1]!.map((file) => file.path).sort()).toEqual([
      "凡人修仙传 - S01E199 - 第 199 集 - 2160p - v2.mp4",
      "凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4",
    ]);
  });

  it("moves with the original name and audits when the rename fails", async () => {
    const { sandbox, storage } = await setup({ libraryTitle: "凡人修仙传" });
    const failingStorage = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "renameFile") {
          return async () => {
            throw new Error("rename boom");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    // Rebuild the sandbox so it uses the failing rename path.
    const provider = new FakeResourceProviderV2({
      results: { show: [{ id: "cand", title: "凡人修仙传 (2020) · 2160p.WEB-DL" }] },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging2", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1b", parentId: "root" });
    const failingSandbox = new TaskSandbox({
      provider,
      storage: failingStorage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      libraryNaming: { title: "凡人修仙传" },
    });
    const search = await failingSandbox.searchResources("show");
    const landed = await failingSandbox.transferCandidate({
      snapshotId: search.snapshot!.id,
      candidateId: "cand",
    });
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await failingSandbox.moveToSeason({
      moves: [{ season: 1, files: [{ fileId: video.id, episodeCodes: ["S01E199"] }] }],
    });

    expect(result.seasons[1]!.map((file) => file.path)).toEqual(["199.4K.mp4"]);
    const failure = failingSandbox.auditTrail().find((event) => event.type === "episode_rename_failed");
    expect(failure?.data).toMatchObject({ from: "199.4K.mp4", error: "rename boom" });
  });

  it("aligns a subtitle with the renamed video, keeping its language infix", async () => {
    const { sandbox } = await setup({
      libraryTitle: "凡人修仙传",
      files: [
        { path: "Pack/199.4K.mp4", sizeBytes: 1 },
        { path: "Pack/199.4K.sc.ass", sizeBytes: 1 },
      ],
    });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;
    const subtitle = landed.staging.find((file) => file.isSubtitle)!;

    const result = await sandbox.moveToSeason({
      moves: [
        {
          season: 1,
          files: [{ fileId: video.id, episodeCodes: ["S01E199"] }],
          fileIds: [subtitle.id],
        },
      ],
    });

    expect(result.seasons[1]!.map((file) => file.path).sort()).toEqual([
      "凡人修仙传 - S01E199 - 第 199 集 - 2160p.mp4",
      "凡人修仙传 - S01E199 - 第 199 集 - 2160p.sc.ass",
    ]);
  });

  it("renders a contiguous multi-episode file as a range", async () => {
    const { sandbox } = await setup({
      libraryTitle: "凡人修仙传",
      files: [{ path: "Pack/199-200.mkv", sizeBytes: 1 }],
    });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await sandbox.moveToSeason({
      moves: [
        {
          season: 1,
          files: [{ fileId: video.id, episodeCodes: ["S01E199", "S01E200"] }],
        },
      ],
    });

    expect(result.seasons[1]!.map((file) => file.path)).toEqual([
      "凡人修仙传 - S01E199-E200 - 第 199 集 - 2160p.mkv",
    ]);
  });

  it("keeps the original name and audits a non-contiguous multi-episode file", async () => {
    const { sandbox } = await setup({
      libraryTitle: "凡人修仙传",
      files: [{ path: "Pack/199-201.mkv", sizeBytes: 1 }],
    });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await sandbox.moveToSeason({
      moves: [
        {
          season: 1,
          files: [{ fileId: video.id, episodeCodes: ["S01E199", "S01E201"] }],
        },
      ],
    });

    expect(result.seasons[1]!.map((file) => file.path)).toEqual(["199-201.mkv"]);
    expect(
      sandbox.auditTrail().find((event) => event.type === "episode_rename_skipped")?.data,
    ).toMatchObject({ from: "199-201.mkv", reason: "non_contiguous" });
  });

  it("audits a TV video moved without codes when its name is unparseable", async () => {
    const { sandbox } = await setup({ libraryTitle: "凡人修仙传" });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    const result = await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [video.id] }] });

    expect(result.seasons[1]!.map((file) => file.path)).toEqual(["199.4K.mp4"]);
    expect(
      sandbox.auditTrail().find((event) => event.type === "episode_rename_skipped")?.data,
    ).toMatchObject({ from: "199.4K.mp4", reason: "no_episode_codes" });
  });

  it("refuses episodeCodes on a subtitle", async () => {
    const { sandbox } = await setup({
      libraryTitle: "凡人修仙传",
      files: [
        { path: "Pack/199.4K.mp4", sizeBytes: 1 },
        { path: "Pack/199.4K.ass", sizeBytes: 1 },
      ],
    });
    const landed = await transfer(sandbox);
    const subtitle = landed.staging.find((file) => file.isSubtitle)!;

    await expect(
      sandbox.moveToSeason({
        moves: [{ season: 1, files: [{ fileId: subtitle.id, episodeCodes: ["S01E199"] }] }],
      }),
    ).rejects.toThrow(/EPISODE_CODES_ON_SUBTITLE/);
  });

  it("refuses an episode code from another season", async () => {
    const { sandbox } = await setup({ libraryTitle: "凡人修仙传", extraSeason: true });
    const landed = await transfer(sandbox);
    const video = landed.staging.find((file) => file.isVideo)!;

    await expect(
      sandbox.moveToSeason({
        moves: [{ season: 1, files: [{ fileId: video.id, episodeCodes: ["S02E199"] }] }],
      }),
    ).rejects.toThrow(/SEASON_MISMATCH/);
  });
});
