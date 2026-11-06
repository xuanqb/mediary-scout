import { describe, expect, it } from "vitest";
import {
  InMemoryWorkflowRepository,
  type AgentDecision,
  type MediaTitle,
  type PersistWorkflowRunSnapshotInput,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
} from "@media-track/workflow";
import { getRunTrace } from "./run-trace";

function title(tmdbId: number, name: string): MediaTitle {
  return {
    id: `t${tmdbId}`,
    tmdbId,
    type: "tv",
    title: name,
    originalTitle: name,
    year: 2026,
    aliases: [],
    posterPath: `/p${tmdbId}.jpg`,
  };
}

function season(titleId: string): TrackedSeason {
  return {
    id: `${titleId}_s1`,
    mediaTitleId: titleId,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata",
    startEpisode: 3,
  };
}

function search(id: string, keyword: string): ResourceSnapshot {
  return {
    id,
    provider: "pansou",
    keyword,
    createdAt: "2026-06-17T00:00:02Z",
    candidates: [
      {
        id: `c_${id}_1`,
        snapshotId: id,
        index: 0,
        title: `${keyword} 4K 全12集`,
        type: "magnet",
        source: "pansou",
        providerPayload: { url: "magnet:?xt=urn:btih:aaa", sizeBytes: 12 * 1024 ** 3 },
      },
      {
        id: `c_${id}_2`,
        snapshotId: id,
        index: 1,
        title: `${keyword} 1080p`,
        type: "115",
        source: "pansou",
        providerPayload: { url: "https://115.com/s/xyz", sizeBytes: "2048" },
      },
    ],
    sourceHealth: { status: "degraded", unhealthySources: ["prowlarr"] },
    sourceStats: [
      { name: "pansou", status: "healthy", candidates: 2 },
      {
        name: "tgto",
        status: "healthy",
        candidates: 0,
        filtered: [{ reason: "points_unknown", count: 3 }],
      },
    ],
    prefilter: {
      provider: "jev",
      model: "jev-judge",
      status: "applied",
      scores: { [`c_${id}_1`]: 0.94, [`c_${id}_2`]: 0.12 },
      dropped: [{ id: `c_${id}_2`, title: `${keyword} 1080p`, score: 0.12 }],
      thresholds: { dropBelow: 0.3, uncertainBelow: 0.6 },
      durationMs: 12,
    },
  };
}

function snapshot(): PersistWorkflowRunSnapshotInput {
  const t = title(42, "毛雪汪");
  const s = season(t.id);
  const decisions: AgentDecision[] = [
    {
      node: "pick",
      snapshotId: "snap_1",
      selectedCandidateIds: ["c_snap_1_1"],
      episodeMapping: { c_snap_1_1: ["S01E03", "S01E04"] },
      providerAheadEpisodeMapping: {},
      rejectedCandidateIds: ["c_snap_1_2"],
      confidence: "high",
      reason: "唯一覆盖目标集数的 4K 资源",
    },
  ];
  const transfers: TransferAttempt[] = [
    {
      id: "tr_1",
      workflowRunId: "run_1",
      candidateId: "c_snap_1_1",
      status: "failed",
      providerMessage: "离线下载配额不足",
      materializedFileIds: [],
    },
  ];
  return {
    title: t,
    season: s,
    workflowRun: {
      id: "run_1",
      kind: "type2_init",
      status: "failed",
      trackedSeasonId: s.id,
      startedAt: "2026-06-17T00:00:00Z",
      finishedAt: "2026-06-17T00:00:10Z",
      auditEvents: [
        { type: "search_source_unhealthy", message: "prowlarr 不可达" },
        { type: "transfer_failed", message: "离线下载配额不足" },
      ],
      progress: { activity: "正在转存", phase: "transfer", percent: 60, updatedAt: "2026-06-17T00:00:08Z" },
    },
    episodes: [],
    resourceSnapshots: [search("snap_1", "毛雪汪 4K")],
    decisions,
    transferAttempts: transfers,
    notifications: [
      {
        id: "n_1",
        workflowRunId: "run_1",
        kind: "transfer_blocked",
        title: "毛雪汪 转存失败",
        body: "115 配额不足",
        createdAt: "2026-06-17T00:00:10Z",
      },
    ],
  };
}

describe("getRunTrace", () => {
  it("assembles the durable audit trail into one trace", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshot());

    const trace = await getRunTrace({ repository: repo, runId: "run_1" });

    expect(trace).not.toBeNull();
    expect(trace!.run.status).toBe("failed");
    expect(trace!.title).toMatchObject({ tmdbId: 42, name: "毛雪汪", seasonNumber: 1, startEpisode: 3 });

    expect(trace!.searches).toHaveLength(1);
    expect(trace!.searches[0]!.sourceHealth?.unhealthySources).toEqual(["prowlarr"]);
    expect(trace!.searches[0]!.sourceStats).toEqual([
      { name: "pansou", status: "healthy", candidates: 2 },
      {
        name: "tgto",
        status: "healthy",
        candidates: 0,
        filtered: [{ reason: "points_unknown", count: 3 }],
      },
    ]);
    expect(trace!.searches[0]!.prefilter?.dropped).toEqual([
      { id: "c_snap_1_2", title: "毛雪汪 4K 1080p", score: 0.12 },
    ]);

    expect(trace!.candidates.map((candidate) => candidate.id)).toEqual(["c_snap_1_1", "c_snap_1_2"]);
    expect(trace!.candidates[0]!.sizeBytes).toBe(12 * 1024 ** 3);
    expect(trace!.candidates[1]!.sizeBytes).toBe(2048);

    expect(trace!.decisions[0]!.reason).toBe("唯一覆盖目标集数的 4K 资源");
    expect(trace!.transfers[0]!.providerMessage).toBe("离线下载配额不足");
    expect(trace!.audit.map((event) => event.type)).toEqual(["search_source_unhealthy", "transfer_failed"]);
    expect(trace!.summary).toMatchObject({
      searched: 1,
      candidateCount: 2,
      selectedCount: 1,
      rejectedCount: 1,
      droppedByIdentity: 1,
      droppedAsNsfw: 0,
      transferSucceeded: 0,
      transferFailed: 1,
      transferNoChange: 0,
    });
  });

  it("returns null for an unknown run", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await getRunTrace({ repository: repo, runId: "missing" })).toBeNull();
  });

  it("is fail-closed when the run belongs to another account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshot());
    expect(await getRunTrace({ repository: repo, runId: "run_1", scope: "acct_other" })).toBeNull();
  });
});
