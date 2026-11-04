import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mocks = vi.hoisted(() => ({
  listTrackedSeasonStates: vi.fn(),
  runSeasonPatrolNow: vi.fn(),
}));
const { listTrackedSeasonStates, runSeasonPatrolNow } = mocks;
vi.mock("../lib/workflow-runtime", () => ({
  queueCandidateSeries: vi.fn(),
  queueCandidateTracking: vi.fn(),
  reserveCandidate: vi.fn(),
  getCurrentAccountId: async () => "default",
  acquireLlmPreflightError: async () => null,
  getActiveWorkspaceScope: async () => ({ accountId: "default", connectedStorageId: "cs_115" }),
  getWorkflowRepository: () => ({ listTrackedSeasonStates: mocks.listTrackedSeasonStates }),
  runSeasonPatrolNow: mocks.runSeasonPatrolNow,
}));

import { retrySeasonAction } from "./actions";

const prevDemo = process.env.MEDIA_TRACK_DEMO_MODE;

function trackedState(overrides: { status?: "active" | "completed"; seasonNumber?: number } = {}) {
  return {
    accountId: "default",
    connectedStorageId: "cs_115",
    title: { id: "title", tmdbId: 66732, type: "tv", title: "怪奇物语", originalTitle: "Stranger Things", year: 2016, aliases: [] },
    season: {
      id: "season_1",
      mediaTitleId: "title",
      seasonNumber: overrides.seasonNumber ?? 1,
      status: overrides.status ?? "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir",
      totalEpisodes: 8,
      latestAiredEpisode: 8,
      latestAiredSource: "metadata",
    },
    episodes: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  if (prevDemo === undefined) delete process.env.MEDIA_TRACK_DEMO_MODE;
  else process.env.MEDIA_TRACK_DEMO_MODE = prevDemo;
});

describe("retrySeasonAction", () => {
  it("refuses an untracked season instead of starting a new acquisition", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    listTrackedSeasonStates.mockResolvedValue([]);
    expect(await retrySeasonAction({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" })).toEqual({
      status: "not_tracked",
      message: "本季尚未追踪，请先点「获取本季」。",
    });
    expect(runSeasonPatrolNow).not.toHaveBeenCalled();
  });

  it("does not patrol a completed season", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    listTrackedSeasonStates.mockResolvedValue([trackedState({ status: "completed" })]);
    expect(await retrySeasonAction({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" }).then((r) => r.status)).toBe(
      "not_active",
    );
    expect(runSeasonPatrolNow).not.toHaveBeenCalled();
  });

  it("runs the same patrol for exactly that season and reports success", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    listTrackedSeasonStates.mockResolvedValue([trackedState()]);
    runSeasonPatrolNow.mockResolvedValue({
      trackedSeasonId: "season_1",
      status: "ran",
      workflowRunId: "run_1",
      workflowStatus: "succeeded",
    });
    expect(await retrySeasonAction({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" })).toEqual({
      status: "completed",
      message: "第 1 季重试完成。",
    });
    expect(runSeasonPatrolNow).toHaveBeenCalledWith({ trackedSeasonId: "season_1", accountId: "default" });
  });

  it("surfaces a partial result and a failed run instead of pretending success", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    listTrackedSeasonStates.mockResolvedValue([trackedState()]);
    runSeasonPatrolNow.mockResolvedValueOnce({
      trackedSeasonId: "season_1",
      status: "ran",
      workflowRunId: "run_1",
      workflowStatus: "partial",
    });
    expect((await retrySeasonAction({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" })).status).toBe("partial");

    runSeasonPatrolNow.mockResolvedValueOnce({
      trackedSeasonId: "season_1",
      status: "failed",
      workflowRunId: "run_2",
      errorMessage: "storage auth expired",
    });
    const failed = await retrySeasonAction({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" });
    expect(failed.status).toBe("failed");
    expect(failed.message).toContain("storage auth expired");
  });

  it("does not fight a task that is already running for this season", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    listTrackedSeasonStates.mockResolvedValue([trackedState()]);
    runSeasonPatrolNow.mockResolvedValue({ trackedSeasonId: "season_1", status: "skipped_active" });
    expect((await retrySeasonAction({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" })).status).toBe("running");
  });
});
