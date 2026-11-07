import { describe, expect, it } from "vitest";
import type { IngestTask } from "../src/ingest-tasks.js";
import { ingestPayloadSignature } from "../src/ingest-tasks.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { createSqliteWorkflowRepository, type SqliteWorkflowRepository } from "../src/sqlite.js";
import { queueMovieAcquisition, queueTrackingInitialization } from "../src/commands.js";
import { DEFAULT_ACCOUNT_ID, type MediaTitle, type TrackedSeason } from "../src/domain.js";

function makeTask(requestId: string, id: string): IngestTask {
  const at = "2026-11-06T12:30:00.000Z";
  return {
    id,
    requestId,
    accountId: DEFAULT_ACCOUNT_ID,
    tmdbId: 275297,
    mediaType: "series",
    seasonNumber: 2,
    year: 2026,
    title: "走马上任",
    status: "following",
    message: "已受理",
    alreadyExists: false,
    reason: null,
    error: null,
    workflowRunId: null,
    trackedSeasonId: null,
    connectedStorageId: null,
    payloadSignature: ingestPayloadSignature({
      tmdbId: 275297,
      mediaType: "series",
      seasonNumber: 2,
      year: 2026,
    }),
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
  };
}

const movieTitle: MediaTitle = {
  id: "tmdb_movie_278",
  tmdbId: 278,
  type: "movie",
  title: "肖申克的救赎",
  originalTitle: "The Shawshank Redemption",
  year: 1994,
  aliases: [],
};

const tvTitle: MediaTitle = {
  id: "tmdb_tv_275297",
  tmdbId: 275297,
  type: "tv",
  title: "走马上任",
  originalTitle: "走马上任",
  year: 2026,
  aliases: [],
};

const tvSeason: TrackedSeason = {
  id: "tmdb_tv_275297_s2",
  mediaTitleId: "tmdb_tv_275297",
  seasonNumber: 2,
  status: "active",
  qualityPreference: "4K",
  storageDirectoryId: "",
  totalEpisodes: 24,
  latestAiredEpisode: 12,
  latestAiredSource: "metadata",
  providerMode: true,
  providerQuality: "high",
};

describe("ingest task repository", () => {
  it("returns the original task for a duplicate request_id", async () => {
    const repository = new InMemoryWorkflowRepository();
    const first = await repository.createIngestTask(makeTask("usapi-1", "ingest_a"));
    expect(first.created).toBe(true);

    const second = await repository.createIngestTask(makeTask("usapi-1", "ingest_b"));
    expect(second.created).toBe(false);
    expect(second.task.id).toBe("ingest_a");
  });

  it("looks tasks up by task id and request id", async () => {
    const repository = new InMemoryWorkflowRepository();
    const task = makeTask("usapi-2", "ingest_c");
    await repository.createIngestTask(task);

    expect((await repository.getIngestTask("ingest_c"))?.requestId).toBe("usapi-2");
    expect((await repository.getIngestTaskByRequestId("usapi-2"))?.id).toBe("ingest_c");
  });

  it("persists terminal status updates", async () => {
    const repository = new InMemoryWorkflowRepository();
    const task = makeTask("usapi-3", "ingest_d");
    await repository.createIngestTask(task);

    await repository.updateIngestTask({
      ...task,
      status: "completed",
      message: "已交付 24 集",
      finishedAt: "2026-11-07T00:00:00.000Z",
    });

    const stored = await repository.getIngestTask("ingest_d");
    expect(stored?.status).toBe("completed");
    expect(stored?.finishedAt).toBe("2026-11-07T00:00:00.000Z");
  });
});

describe("ingest task persistence (SQLite)", () => {
  it("round-trips a task row and its terminal fields", async () => {
    const repository: SqliteWorkflowRepository = createSqliteWorkflowRepository({ path: ":memory:" });
    try {
      const task = makeTask("usapi-sqlite-1", "ingest_sqlite_1");
      const created = await repository.createIngestTask(task);
      expect(created.created).toBe(true);
      expect(await repository.getIngestTaskByRequestId("usapi-sqlite-1")).toEqual(task);

      const duplicate = await repository.createIngestTask(makeTask("usapi-sqlite-1", "ingest_sqlite_2"));
      expect(duplicate.created).toBe(false);
      expect(duplicate.task.id).toBe("ingest_sqlite_1");

      await repository.updateIngestTask({
        ...task,
        status: "failed",
        reason: null,
        error: { code: "EMBY_UNAVAILABLE", message: "Emby 不可达", retryable: true },
        finishedAt: "2026-11-07T00:00:00.000Z",
      });
      const stored = await repository.getIngestTask("ingest_sqlite_1");
      expect(stored?.status).toBe("failed");
      expect(stored?.error).toEqual({
        code: "EMBY_UNAVAILABLE",
        message: "Emby 不可达",
        retryable: true,
      });
    } finally {
      repository.close();
    }
  });

  it("prunes tasks older than the cutoff", async () => {
    const repository: SqliteWorkflowRepository = createSqliteWorkflowRepository({ path: ":memory:" });
    try {
      await repository.createIngestTask({
        ...makeTask("old", "ingest_old"),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(await repository.pruneIngestTasks("2026-02-01T00:00:00.000Z")).toBe(1);
      expect(await repository.getIngestTask("ingest_old")).toBeNull();
    } finally {
      repository.close();
    }
  });
});

describe("provider-mode queueing", () => {
  it("marks the movie anchor as a provider task with its quality preference", async () => {
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueMovieAcquisition({
      title: movieTitle,
      keyword: movieTitle.title,
      repository,
      providerMode: true,
      providerQuality: "medium",
    });
    const snapshot = await repository.getWorkflowRunSnapshot(queued.workflowRunId!, DEFAULT_ACCOUNT_ID);
    expect(snapshot?.season.providerMode).toBe(true);
    expect(snapshot?.season.providerQuality).toBe("medium");
  });

  it("keeps providerMode on the tracked season for later patrols", async () => {
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueTrackingInitialization({
      title: tvTitle,
      season: tvSeason,
      keyword: tvTitle.title,
      repository,
    });
    const snapshot = await repository.getWorkflowRunSnapshot(queued.workflowRunId!, DEFAULT_ACCOUNT_ID);
    expect(snapshot?.season.providerMode).toBe(true);
    expect(snapshot?.season.providerQuality).toBe("high");
  });
});
