import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

function provider() {
  return new FakeResourceProviderV2({
    results: {
      show: [
        { id: "cand1", title: "Show E01" },
        { id: "cand2", title: "Show E01 dup" },
      ],
    },
  });
}

async function setupNeedingOneEpisode(need: string[]) {
  const storage = new Storage115Simulator({
    packs: {
      cand1: { files: [{ path: "Show - 01.mkv", sizeBytes: 9 }] },
      cand2: { files: [{ path: "Show - 01.mkv", sizeBytes: 8 }] },
    },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider: provider(), storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need });
  return { sandbox };
}

async function coverOneEpisode(sandbox: TaskSandbox) {
  const search = await sandbox.searchResources("show");
  const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "cand1" });
  await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: transfer.staging.map((f) => f.id) }] });
  await sandbox.markObtained({ codes: ["S01E01"] });
  return search;
}

describe("TaskSandbox — coverage gate (§3: no side effects once needSet is met)", () => {
  it("refuses a further transfer once every needed episode is obtained", async () => {
    const { sandbox } = await setupNeedingOneEpisode(["S01E01"]);
    const search = await coverOneEpisode(sandbox);

    await expect(
      sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "cand2" }),
    ).rejects.toThrow(/COVERAGE_ALREADY_MET/);
  });

  it("still allows transfers while coverage is incomplete", async () => {
    const { sandbox } = await setupNeedingOneEpisode(["S01E01", "S01E02"]);
    const search = await coverOneEpisode(sandbox); // only E01 covered; E02 still missing

    const second = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "cand2" });
    expect(second.attempt.status).toBe("succeeded");
  });
});

describe("TaskSandbox — finish / reportNoCoverage (§9)", () => {
  it("finish reports which needed episodes are covered and which remain", async () => {
    const { sandbox } = await setupNeedingOneEpisode(["S01E01", "S01E02"]);
    await coverOneEpisode(sandbox);

    const summary = await sandbox.finish();

    expect(summary.coverageMet).toBe(false);
    expect(summary.obtained).toEqual(["S01E01"]);
    expect(summary.missing).toEqual(["S01E02"]);
  });

  it("reportNoCoverage is rejected as an infrastructure failure if no real search was ever run", async () => {
    const { sandbox } = await setupNeedingOneEpisode(["S01E01"]);

    await expect(sandbox.reportNoCoverage("nothing out there")).rejects.toThrow(/NO_PROVIDER_EVIDENCE/);
  });

  it("reportNoCoverage is accepted once a real search has actually been performed", async () => {
    const { sandbox } = await setupNeedingOneEpisode(["S01E01"]);
    await sandbox.searchResources("show");

    const result = await sandbox.reportNoCoverage("candidates exist but none cover S01E01");

    expect(result.reason).toMatch(/none cover/);
    expect(result.searchesPerformed).toBeGreaterThan(0);
  });
});

describe("TaskSandbox — a needed episode still in staging cannot be finished/discarded away", () => {
  async function setupTwoEpisodePack(need: string[]) {
    const storage = new Storage115Simulator({
      packs: {
        pack: {
          files: [
            { path: "Show.S01E01.mkv", sizeBytes: 9 },
            { path: "Show.S01E02.mkv", sizeBytes: 9 },
          ],
        },
      },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { show: [{ id: "pack", title: "Show" }] } }),
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need,
    });
    const search = await sandbox.searchResources("show");
    const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "pack" });
    const fileId = (code: string) => transfer.staging.find((f) => f.path.includes(code))!.id;
    return { sandbox, stagingDirectoryId, targetSeasonDirectoryId, fileId };
  }

  it("refuses declareFinish and discardStaging while the needed video never left staging (罗小黑 E42)", async () => {
    const { sandbox } = await setupTwoEpisodePack(["S01E01"]);

    await expect(sandbox.declareFinish()).rejects.toThrow(/SANDBOX_NEEDED_FILES_IN_STAGING/);
    await expect(sandbox.declareFinish()).rejects.toThrow(/S01E01/);
    // finish() itself stays the honest, ungated coverage read (the harness records
    // the truth even when the agent skipped the move).
    expect((await sandbox.finish()).coverageMet).toBe(false);
    // Wiping staging here would take the only copy of E01 with it.
    await expect(sandbox.discardStaging()).rejects.toThrow(/SANDBOX_DISCARD_NEEDED_FILES/);
  });

  it("accepts finish once the needed video is moved, even with an unneeded episode left in staging", async () => {
    const { sandbox, fileId } = await setupTwoEpisodePack(["S01E01"]);

    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [fileId("E01")] }] });
    await sandbox.markObtained({ codes: ["S01E01"] });

    const summary = await sandbox.declareFinish();
    expect(summary.coverageMet).toBe(true);
    // E02 is not need — it is residue the agent may discard wholesale.
    await expect(sandbox.discardStaging()).resolves.toBeDefined();
  });

  it("remembers a needed, never-moved video as unmoved so the harness keeps staging", async () => {
    const { sandbox, fileId } = await setupTwoEpisodePack(["S01E01"]);

    await sandbox.rememberNeededStagingFiles();

    // Only the needed E01 is pinned; the unneeded E02 residue may still be discarded.
    expect(sandbox.unmovedStagingFileIds()).toEqual([fileId("E01")]);
  });
});
