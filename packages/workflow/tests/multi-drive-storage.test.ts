import { describe, expect, it } from "vitest";
import {
  MULTI_DRIVE_STAGING_HANDLE,
  MultiDriveStorageV2,
  multiDriveSeasonHandle,
  Storage115Simulator,
  type AcquisitionDriveContext,
  type StorageExecutor,
} from "../src/index.js";

function makeDrive(options: {
  storageId: string;
  provider: string;
  label: string;
  sim: Storage115Simulator;
  space?: { totalBytes: number; usedBytes: number } | null;
  createdDirs?: string[];
  removedDirs?: string[];
}): AcquisitionDriveContext {
  const createdDirs = options.createdDirs ?? [];
  const removedDirs = options.removedDirs ?? [];
  const executor: StorageExecutor = {
    createDirectory: async (input) => {
      createdDirs.push(`${options.storageId}:${input.name}`);
      return options.sim.createDirectory(input);
    },
    listChildDirectories: async () => [],
    listVideoFiles: async () => [],
    listUnparsedVideoFiles: async () => [],
    renameFile: async (input) => options.sim.renameFile(input),
    transfer: async () => ({
      id: "t1",
      workflowRunId: "r1",
      candidateId: "c1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: [],
    }),
    flattenDirectory: async () => ({ moved: [], removed: [] }),
    deleteFiles: async (input) => options.sim.deleteFiles(input),
    removeDirectory: async (directoryId) => {
      removedDirs.push(`${options.storageId}:${directoryId}`);
      await options.sim.removeDirectory({ directoryId });
      return { removed: true };
    },
    listTree: async () => [],
    listSubdirectories: async () => [],
    moveFiles: async (input) => options.sim.moveFiles(input),
  };
  return {
    storageId: options.storageId,
    provider: options.provider,
    label: options.label,
    storage: executor,
    parents: { tv: "root", anime: "root", movies: "root", variety: "root" },
    space: options.space ?? { totalBytes: 20 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 },
  };
}

describe("MultiDriveStorageV2 — lazy per-drive staging, brand/storageId routing, and hard space gate (C4)", () => {
  it("routes a url-less candidate by its declared target brand (Tgto lazy shares)", () => {
    const sim115 = new Storage115Simulator({ packs: {} });
    const simQuark = new Storage115Simulator({ packs: {} });
    const drive115 = makeDrive({ storageId: "cs_115", provider: "pan115", label: "115 网盘", sim: sim115 });
    const driveQuark = makeDrive({ storageId: "cs_quark", provider: "quark", label: "夸克网盘", sim: simQuark });
    const coordinator = new MultiDriveStorageV2({
      // Quark is first, so a brand-less candidate would land there by default.
      drives: [driveQuark, drive115],
      target: { kind: "tv", categoryKey: "tv", title: "沙丘", year: 2021, tmdbId: 1, seasons: [1], workflowRunId: "run" },
      buildDriveAdapter: (drive) => (drive.storageId === "cs_115" ? sim115 : simQuark),
      resolveCandidate: (id) => (id === "lazy" ? { url: "", provider: "pan115" } : undefined),
    });
    expect(coordinator.resolveDriveForCandidate("lazy").drive.storageId).toBe("cs_115");
  });

  it("lazily creates staging and season directories only on the drive that actually receives transfers", async () => {
    const sim115 = new Storage115Simulator({
      packs: { c115: { files: [{ path: "Show.S01E01.mkv", sizeBytes: 1000 }] } },
    });
    const simQuark2 = new Storage115Simulator({
      packs: { cq: { files: [{ path: "Show.S01E02.mkv", sizeBytes: 1000 }] } },
    });

    const created115: string[] = [];
    const createdQuark2: string[] = [];

    const drive115 = makeDrive({ storageId: "cs_115", provider: "pan115", label: "115 网盘", sim: sim115, createdDirs: created115 });
    const driveQuark2 = makeDrive({ storageId: "cs_quark2", provider: "quark", label: "夸克网盘", sim: simQuark2, createdDirs: createdQuark2 });

    const coordinator = new MultiDriveStorageV2({
      drives: [drive115, driveQuark2],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "琅琊榜",
        year: 2015,
        tmdbId: 65756,
        seasons: [1],
        workflowRunId: "run_lazy",
      },
      buildDriveAdapter: (drive) => {
        if (drive.storageId === "cs_115") return sim115;
        return simQuark2;
      },
      resolveCandidate: (id) => {
        if (id === "c115") return { url: "https://115.com/s/sw3abcd1234" };
        if (id === "cq") return { url: "https://pan.quark.cn/s/Ab-cD_12" };
        return undefined;
      },
    });

    // Before any transfer: ZERO directories created on any drive.
    expect(created115).toEqual([]);
    expect(createdQuark2).toEqual([]);

    // Transfer 115 candidate → only 115 creates show + staging; Season 01 not created yet!
    const t1 = await coordinator.transferCandidate({
      candidateId: "c115",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    expect(t1.status).toBe("succeeded");
    expect(created115).toEqual([
      "cs_115:琅琊榜 (2015) {tmdb-65756}",
      "cs_115:staging-run_lazy",
    ]);
    expect(createdQuark2).toEqual([]);

    // Transfer 夸克 candidate → 夸克 lazily creates show + staging; 115 still untouched!
    const t2 = await coordinator.transferCandidate({
      candidateId: "cq",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    expect(t2.status).toBe("succeeded");
    expect(createdQuark2).toEqual([
      "cs_quark2:琅琊榜 (2015) {tmdb-65756}",
      "cs_quark2:staging-run_lazy",
    ]);

    // inspectStaging via MULTI_DRIVE_STAGING_HANDLE returns scoped file IDs and clean relative paths.
    const stagingTree = await coordinator.listTree({ directoryId: MULTI_DRIVE_STAGING_HANDLE });
    expect(stagingTree.map((f) => ({ id: f.id, path: f.path }))).toEqual([
      { id: "cs_115::file_3", path: "Show.S01E01.mkv" },
      { id: "cs_quark2::file_3", path: "Show.S01E02.mkv" },
    ]);

    // Move files to Season 01 → each file moves into its own drive's lazily-created Season 01 dir.
    const moved = await coordinator.moveFiles({
      fileIds: [...t1.materializedFileIds, ...t2.materializedFileIds],
      targetDirectoryId: multiDriveSeasonHandle(1),
    });
    expect(moved.moved.length).toBe(2);
    expect(created115).toContain("cs_115:Season 01");
    expect(createdQuark2).toContain("cs_quark2:Season 01");
  });

  it("enforces the hard space gate: refuses over-quota drives (negative remaining) and oversized candidates", async () => {
    const simQuark = new Storage115Simulator({
      packs: { cQuark: { files: [{ path: "Ep01.mkv", sizeBytes: 1000 }] } },
    });
    const sim115Small = new Storage115Simulator({
      packs: { cBig115: { files: [{ path: "Remux.mkv", sizeBytes: 50 * 1024 ** 3 }] } },
    });
    const sim115Large = new Storage115Simulator({
      packs: { cBig115: { files: [{ path: "Remux.mkv", sizeBytes: 50 * 1024 ** 3 }] } },
    });

    const createdQuark: string[] = [];
    // Quark over-quota (-1368 GB), like production.
    const driveQuark = makeDrive({
      storageId: "cs_quark",
      provider: "quark",
      label: "夸克网盘",
      sim: simQuark,
      createdDirs: createdQuark,
      space: { totalBytes: 10 * 1024 ** 3, usedBytes: 1378 * 1024 ** 3 },
    });
    // First 115 drive has only 5 GB left; second 115 drive has 20 TB left.
    const drive115Small = makeDrive({
      storageId: "cs_115_small",
      provider: "pan115",
      label: "115 网盘（小号）",
      sim: sim115Small,
      space: { totalBytes: 15 * 1024 ** 3, usedBytes: 10 * 1024 ** 3 },
    });
    const drive115Large = makeDrive({
      storageId: "cs_115_large",
      provider: "pan115",
      label: "115 网盘（大号）",
      sim: sim115Large,
      space: { totalBytes: 40 * 1024 ** 4, usedBytes: 20 * 1024 ** 4 },
    });

    const coordinator = new MultiDriveStorageV2({
      drives: [driveQuark, drive115Small, drive115Large],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "三体",
        year: 2023,
        tmdbId: 12345,
        seasons: [1],
        workflowRunId: "run_space",
      },
      buildDriveAdapter: (drive) => {
        if (drive.storageId === "cs_quark") return simQuark;
        if (drive.storageId === "cs_115_small") return sim115Small;
        return sim115Large;
      },
      resolveCandidate: (id) => {
        if (id === "cQuark") return { url: "https://pan.quark.cn/s/1a2B3c4D" };
        if (id === "cBig115") return { url: "https://115.com/s/sw3abcd1234", sizeBytes: 50 * 1024 ** 3 };
        return undefined;
      },
    });

    // Quark is over-quota → hard rejection before any directory is created!
    await expect(
      coordinator.transferCandidate({
        candidateId: "cQuark",
        intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
      }),
    ).rejects.toThrow(/SANDBOX_DRIVE_OUT_OF_SPACE.*夸克网盘/);
    expect(createdQuark).toEqual([]);

    // Explicit transfer of 50 GB pack onto the 5 GB 115 drive → hard rejection!
    await expect(
      coordinator.transferCandidate({
        candidateId: "cBig115",
        intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
        storageId: "cs_115_small",
      }),
    ).rejects.toThrow(/SANDBOX_DRIVE_OUT_OF_SPACE.*115 网盘（小号）/);

    // Auto-routed transfer of 50 GB pack skips the 5 GB 115 drive and lands on the 20 TB 115 drive!
    const landed = await coordinator.transferCandidate({
      candidateId: "cBig115",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    expect(landed.status).toBe("succeeded");
    expect(coordinator.driveOfFile(landed.materializedFileIds[0]!)).toBe("cs_115_large");
  });

  it("protects unmovedFileIds per drive during cleanupMaterializedStagings", async () => {
    const sim115 = new Storage115Simulator({
      packs: { c115: { files: [{ path: "Ep01.mkv", sizeBytes: 1000 }] } },
    });
    const simQuark2 = new Storage115Simulator({
      packs: { cq: { files: [{ path: "Ep02.mkv", sizeBytes: 1000 }] } },
    });
    const removed115: string[] = [];
    const removedQuark2: string[] = [];

    const drive115 = makeDrive({ storageId: "cs_115", provider: "pan115", label: "115", sim: sim115, removedDirs: removed115 });
    const driveQuark2 = makeDrive({ storageId: "cs_quark2", provider: "quark", label: "夸克", sim: simQuark2, removedDirs: removedQuark2 });

    const coordinator = new MultiDriveStorageV2({
      drives: [drive115, driveQuark2],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "狂飙",
        year: 2023,
        tmdbId: 999,
        seasons: [1],
        workflowRunId: "run_cleanup",
      },
      buildDriveAdapter: (d) => (d.storageId === "cs_115" ? sim115 : simQuark2),
      resolveCandidate: (id) =>
        id === "c115"
          ? { url: "https://115.com/s/sw3abcd1234" }
          : { url: "https://pan.quark.cn/s/Ab-cD_12" },
    });

    const t1 = await coordinator.transferCandidate({
      candidateId: "c115",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    const t2 = await coordinator.transferCandidate({
      candidateId: "cq",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });

    // Suppose 115's file failed to move (in unmovedFileIds), while 夸克's file moved cleanly.
    const keptEvents: Array<{ stagingDirectoryId: string; fileCount: number }> = [];
    await coordinator.cleanupMaterializedStagings({
      unmovedFileIds: new Set(t1.materializedFileIds),
      onLeak: () => {},
      onCleanupUnverified: () => {},
      onKept: (e) => keptEvents.push(e),
    });

    // 115 staging was KEPT (not removed) because it holds an unmoved file; 夸克 staging was removed!
    expect(removed115).toEqual([]);
    expect(removedQuark2.length).toBe(1);
    expect(keptEvents.length).toBe(1);
    expect(keptEvents[0]!.fileCount).toBe(1);
    expect(t2.materializedFileIds.length).toBe(1);
  });

  it("deduplicates concurrent directory creation on the same drive and disambiguates transferAttempt IDs across drives", async () => {
    const sim115 = new Storage115Simulator({
      packs: {
        c115_a: { files: [{ path: "Show.S01E01.mkv", sizeBytes: 1000 }] },
        c115_b: { files: [{ path: "Show.S01E02.mkv", sizeBytes: 1000 }] },
      },
    });
    const simQuark2 = new Storage115Simulator({
      packs: {
        cq_a: { files: [{ path: "Show.S01E03.mkv", sizeBytes: 1000 }] },
        cq_b: { files: [{ path: "Show.S01E04.mkv", sizeBytes: 1000 }] },
      },
    });
    const createdQuark2: string[] = [];
    const drive115 = makeDrive({ storageId: "cs_115", provider: "pan115", label: "115", sim: sim115 });
    const driveQuark2 = makeDrive({ storageId: "cs_quark2", provider: "quark", label: "夸克", sim: simQuark2, createdDirs: createdQuark2 });

    const attempts115 = [
      { id: "run_dup_transfer_1", workflowRunId: "run_dup", candidateId: "c115_a", status: "succeeded" as const, providerMessage: "", materializedFileIds: ["f1"] },
    ];
    const attemptsQuark = [
      { id: "run_dup_transfer_1", workflowRunId: "run_dup", candidateId: "cq_a", status: "succeeded" as const, providerMessage: "", materializedFileIds: ["f3"] },
    ];

    const coordinator = new MultiDriveStorageV2({
      drives: [drive115, driveQuark2],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "幻视任务",
        year: 2026,
        tmdbId: 213375,
        seasons: [1],
        workflowRunId: "run_dup",
      },
      buildDriveAdapter: (d) => {
        const base = d.storageId === "cs_115" ? sim115 : simQuark2;
        return {
          createDirectory: (i) => base.createDirectory(i),
          transferCandidate: (i) => base.transferCandidate(i),
          transferSubtitleUrls: (i) => base.transferSubtitleUrls(i),
          listTree: (i) => base.listTree(i),
          listSubdirectories: (i) => base.listSubdirectories(i),
          moveFiles: (i) => base.moveFiles(i),
          renameFile: (i) => base.renameFile(i),
          deleteFiles: (i) => base.deleteFiles(i),
          removeDirectory: (i) => base.removeDirectory(i),
          candidateLinkKind: (c) => base.candidateLinkKind(c),
          attempts: () => (d.storageId === "cs_115" ? attempts115 : attemptsQuark),
        };
      },
      resolveCandidate: (id) =>
        id.startsWith("c115")
          ? { url: `https://115.com/s/sw3abcd${id}` }
          : { url: `https://pan.quark.cn/s/Ab-cD_${id}` },
    });

    // Fire two concurrent transfers onto drive 夸克 (simulating parallel tool calls in one LLM turn)
    await Promise.all([
      coordinator.transferCandidate({ candidateId: "cq_a", intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE, storageId: "cs_quark2" }),
      coordinator.transferCandidate({ candidateId: "cq_b", intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE, storageId: "cs_quark2" }),
    ]);

    // Show directory and staging directory on 夸克 must each be created ONLY ONCE (no 5060 duplicate folder race)
    expect(createdQuark2).toEqual([
      "cs_quark2:幻视任务 (2026) {tmdb-213375}",
      "cs_quark2:staging-run_dup",
    ]);

    // TransferAttempt IDs from both drives must be globally unique (no transfer_attempts_pkey collision)
    const allAttempts = coordinator.attempts();
    expect(allAttempts.map((a) => a.id)).toEqual([
      "run_dup_transfer_cs_115_1",
      "run_dup_transfer_cs_quark2_1",
    ]);
  });

  it("discovers pre-existing season files on a secondary drive when primaryStorageId has none (issue #359: 115 primary + Quark already holds S01E01-E04)", async () => {
    const simPrimary115 = new Storage115Simulator({ packs: {} });
    const simQuark = new Storage115Simulator({
      packs: {
        preseed: {
          files: [
            { path: "S01E01.mp4", sizeBytes: 1400 },
            { path: "S01E02.mp4", sizeBytes: 1400 },
            { path: "S01E03.mp4", sizeBytes: 1400 },
            { path: "S01E04.mp4", sizeBytes: 1400 },
          ],
        },
      },
    });

    // Pre-seed Quark with 731部队 (2026) {tmdb-999999}/Season 01 holding S01E01-S01E04
    const quarkShowDir = await simQuark.createDirectory({
      name: "731部队 (2026) {tmdb-999999}",
      parentId: "root",
    });
    const quarkSeasonDir = await simQuark.createDirectory({
      name: "Season 01",
      parentId: quarkShowDir,
    });
    await simQuark.transferCandidate({ candidateId: "preseed", intoDirectoryId: quarkSeasonDir });

    const drivePrimary115 = makeDrive({ storageId: "cs_115_primary", provider: "pan115", label: "115 网盘", sim: simPrimary115 });
    const driveQuark = makeDrive({ storageId: "cs_quark", provider: "quark", label: "夸克网盘", sim: simQuark });
    // Wire listChildDirectories on Quark so findExistingSeasonDirReadOnly can see the pre-existing folders
    driveQuark.storage.listChildDirectories = async (parentId) => {
      if (parentId === "root") return [{ id: quarkShowDir, name: "731部队 (2026) {tmdb-999999}" }];
      if (parentId === quarkShowDir) return [{ id: quarkSeasonDir, name: "Season 01" }];
      return [];
    };

    const coordinator = new MultiDriveStorageV2({
      drives: [drivePrimary115, driveQuark],
      primaryStorageId: "cs_115_primary",
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "731部队",
        year: 2026,
        tmdbId: 999999,
        seasons: [1],
        workflowRunId: "run_731",
      },
      buildDriveAdapter: (d) => (d.storageId === "cs_115_primary" ? simPrimary115 : simQuark),
      resolveCandidate: () => undefined,
    });

    const files = await coordinator.listTree({ directoryId: multiDriveSeasonHandle(1) });
    expect(files.map((f) => f.path)).toEqual([
      "S01E01.mp4",
      "S01E02.mp4",
      "S01E03.mp4",
      "S01E04.mp4",
    ]);
    expect(files.every((f) => f.id.startsWith("cs_quark::"))).toBe(true);
  });
});
