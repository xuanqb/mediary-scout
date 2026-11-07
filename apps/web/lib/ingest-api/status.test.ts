import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  queueTrackingInitialization,
  type IngestTask,
  type MediaTitle,
  type PersistedWorkflowRunSnapshot,
  type TrackedSeason,
  type WorkflowStatus,
} from "@media-track/workflow";
import { resolveTaskStatus } from "./service";

const movieTitle: MediaTitle = {
  id: "tmdb_movie_278",
  tmdbId: 278,
  type: "movie",
  title: "肖申克的救赎",
  originalTitle: "The Shawshank Redemption",
  year: 1994,
  aliases: [],
};

function tvTitle(tmdbId: number): MediaTitle {
  return {
    id: `tmdb_tv_${tmdbId}`,
    tmdbId,
    type: "tv",
    title: `剧 ${tmdbId}`,
    originalTitle: `剧 ${tmdbId}`,
    year: 2026,
    aliases: [],
  };
}

function seasonOf(title: MediaTitle, total: number, aired: number): TrackedSeason {
  return {
    id: `${title.id}_s2`,
    mediaTitleId: title.id,
    seasonNumber: 2,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: total,
    latestAiredEpisode: aired,
    latestAiredSource: "metadata",
    providerMode: true,
  };
}

function taskOf(overrides: Partial<IngestTask>): IngestTask {
  return {
    id: "ingest_t",
    requestId: "req_t",
    accountId: DEFAULT_ACCOUNT_ID,
    tmdbId: 278,
    mediaType: "movie",
    seasonNumber: null,
    year: 1994,
    title: "肖申克的救赎",
    status: "following",
    message: null,
    alreadyExists: false,
    reason: null,
    error: null,
    workflowRunId: null,
    trackedSeasonId: null,
    connectedStorageId: null,
    payloadSignature: "",
    createdAt: "2026-11-06T12:30:00.000Z",
    updatedAt: "2026-11-06T12:30:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

async function finishRun(
  repository: InMemoryWorkflowRepository,
  snapshot: PersistedWorkflowRunSnapshot,
  status: WorkflowStatus,
  options: { obtained?: boolean; failureMessage?: string } = {},
): Promise<void> {
  await repository.saveWorkflowRunSnapshot({
    ...snapshot,
    workflowRun: {
      ...snapshot.workflowRun,
      status,
      finishedAt: "2026-11-07T00:00:00.000Z",
      ...(options.failureMessage
        ? {
            auditEvents: [
              ...snapshot.workflowRun.auditEvents,
              { type: "workflow_failed", message: options.failureMessage },
            ],
          }
        : {}),
    },
    episodes: snapshot.episodes.map((episode) =>
      options.obtained === true ? { ...episode, obtained: true } : episode,
    ),
  });
}

describe("resolveTaskStatus", () => {
  it("completes a movie once the run obtained it", async () => {
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueMovieAcquisition({
      title: movieTitle,
      keyword: movieTitle.title,
      repository,
      providerMode: true,
    });
    const snapshot = (await repository.getWorkflowRunSnapshot(queued.workflowRunId!))!;
    await finishRun(repository, snapshot, "succeeded", { obtained: true });

    const task = taskOf({ workflowRunId: queued.workflowRunId });
    const resolved = await resolveTaskStatus(task, repository);
    expect(resolved.status).toBe("completed");
  });

  it("reports no_resource and releases tracking for a movie with no coverage", async () => {
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueMovieAcquisition({
      title: movieTitle,
      keyword: movieTitle.title,
      repository,
      providerMode: true,
    });
    const snapshot = (await repository.getWorkflowRunSnapshot(queued.workflowRunId!))!;
    await finishRun(repository, snapshot, "no_coverage");

    const task = taskOf({ workflowRunId: queued.workflowRunId, connectedStorageId: snapshot.connectedStorageId });
    const resolved = await resolveTaskStatus(task, repository);
    expect(resolved.status).toBe("no_resource");
    expect(resolved.reason).toBe("NO_RESOURCE");
    expect(await repository.listTrackedSeasonStates(DEFAULT_ACCOUNT_ID)).toHaveLength(0);
  });

  it("keeps an ongoing series following and completes it when fully obtained", async () => {
    const title = tvTitle(1001);
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueTrackingInitialization({
      title,
      season: seasonOf(title, 4, 2),
      keyword: title.title,
      repository,
    });
    const task = taskOf({
      tmdbId: title.tmdbId,
      mediaType: "series",
      seasonNumber: 2,
      workflowRunId: queued.workflowRunId,
    });

    expect((await resolveTaskStatus(task, repository)).status).toBe("following");
  });

  it("completes a fully aired series whose aired episodes are all obtained", async () => {
    const title = tvTitle(1002);
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueTrackingInitialization({
      title,
      season: seasonOf(title, 2, 2),
      keyword: title.title,
      repository,
    });
    const snapshot = (await repository.getWorkflowRunSnapshot(queued.workflowRunId!))!;
    await finishRun(repository, snapshot, "succeeded", { obtained: true });

    const task = taskOf({
      tmdbId: title.tmdbId,
      mediaType: "series",
      seasonNumber: 2,
      workflowRunId: queued.workflowRunId,
    });
    const resolved = await resolveTaskStatus(task, repository);
    expect(resolved.status).toBe("completed");
  });

  it("surfaces EMBY_UNAVAILABLE from a failed provider run", async () => {
    const title = tvTitle(1003);
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueTrackingInitialization({
      title,
      season: seasonOf(title, 4, 2),
      keyword: title.title,
      repository,
    });
    const snapshot = (await repository.getWorkflowRunSnapshot(queued.workflowRunId!))!;
    await finishRun(repository, snapshot, "failed", {
      failureMessage: "EMBY_UNAVAILABLE: network error while querying Emby (down)",
    });

    const task = taskOf({
      tmdbId: title.tmdbId,
      mediaType: "series",
      seasonNumber: 2,
      workflowRunId: queued.workflowRunId,
    });
    const resolved = await resolveTaskStatus(task, repository);
    expect(resolved.status).toBe("failed");
    expect(resolved.error?.code).toBe("EMBY_UNAVAILABLE");
    expect(resolved.error?.retryable).toBe(true);
  });
});
