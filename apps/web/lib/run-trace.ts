import type {
  AgentDecision,
  AuditEvent,
  MediaTitle,
  MergedSourceHealth,
  NotificationEvent,
  ResourceSnapshot,
  ResourceSourceStat,
  SnapshotPrefilter,
  TrackedSeason,
  TransferAttempt,
  WorkflowKind,
  WorkflowRepository,
  WorkflowRunProgress,
  WorkflowStatus,
} from "@media-track/workflow";
import type { ScopeArg } from "@media-track/workflow/scope";

/** Everything the run-detail page needs, resolved from the already-persisted
 *  audit trail: the run itself, its ordered tool-call trace, every search
 *  snapshot (with prefilter scores), pick decisions, transfer attempts, audit
 *  events and notifications. Read-only — nothing here mutates a run. */
export interface RunTrace {
  run: {
    id: string;
    kind: WorkflowKind;
    status: WorkflowStatus;
    startedAt: string;
    finishedAt: string | null;
    progress: WorkflowRunProgress | null;
  };
  title: {
    tmdbId: number;
    name: string;
    year: number;
    type: MediaTitle["type"];
    posterPath: string | null;
    seasonNumber: number;
    startEpisode: number | null;
  };
  summary: RunTraceSummary;
  candidates: RunTraceCandidate[];
  searches: RunTraceSearch[];
  decisions: RunTraceDecision[];
  transfers: RunTraceTransfer[];
  audit: RunTraceAuditEvent[];
  notifications: RunTraceNotification[];
}

export interface RunTraceSummary {
  searched: number;
  candidateCount: number;
  selectedCount: number;
  rejectedCount: number;
  droppedByIdentity: number;
  droppedAsNsfw: number;
  transferSucceeded: number;
  transferFailed: number;
  transferNoChange: number;
}

export interface RunTraceCandidate {
  id: string;
  snapshotId: string;
  snapshotKeyword: string;
  index: number;
  title: string;
  type: string;
  source: string;
  sizeBytes: number | null;
  targetProvider: string | null;
}

export interface RunTraceSearch {
  id: string;
  provider: string;
  keyword: string;
  createdAt: string;
  candidateIds: string[];
  sourceHealth: MergedSourceHealth | null;
  /** Per-provider contribution (composite). null on legacy snapshots. */
  sourceStats: ResourceSourceStat[] | null;
  prefilter: SnapshotPrefilter | null;
}

export interface RunTraceDecision {
  ordinal: number;
  node: string;
  snapshotId: string;
  confidence: AgentDecision["confidence"];
  reason: string;
  selectedCandidateIds: string[];
  rejectedCandidateIds: string[];
  episodeMapping: Record<string, string[]>;
  providerAheadEpisodeMapping: Record<string, string[]>;
}

export interface RunTraceTransfer {
  ordinal: number;
  candidateId: string;
  status: TransferAttempt["status"];
  providerMessage: string;
  materializedFileIds: string[];
  materializedNames?: string[];
  fate?: TransferAttempt["fate"];
}

export interface RunTraceAuditEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunTraceNotification {
  kind: string;
  title: string;
  body: string;
  createdAt: string;
}

/** Read a run's full trace. Returns null when the run is invisible in `scope`
 *  (wrong account/drive, or already pruned) — the caller maps that to a 404. */
export async function getRunTrace(input: {
  repository: Pick<WorkflowRepository, "getWorkflowRunSnapshot">;
  runId: string;
  scope?: ScopeArg;
}): Promise<RunTrace | null> {
  const snapshot = await input.repository.getWorkflowRunSnapshot(input.runId, input.scope);
  if (!snapshot) {
    return null;
  }

  const candidates = uniqueCandidates(snapshot.resourceSnapshots);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const selectedIds = new Set<string>();
  const rejectedIds = new Set<string>();
  for (const decision of snapshot.decisions) {
    for (const id of decision.selectedCandidateIds) if (candidateIds.has(id)) selectedIds.add(id);
    for (const id of decision.rejectedCandidateIds) if (candidateIds.has(id)) rejectedIds.add(id);
  }

  const prefilterDrops = snapshot.resourceSnapshots.reduce(
    (acc, search) => {
      acc.identity += search.prefilter?.dropped.length ?? 0;
      acc.nsfw += search.prefilter?.nsfwDropped?.length ?? 0;
      return acc;
    },
    { identity: 0, nsfw: 0 },
  );

  return {
    run: {
      id: snapshot.workflowRun.id,
      kind: snapshot.workflowRun.kind,
      status: snapshot.workflowRun.status,
      startedAt: snapshot.workflowRun.startedAt,
      finishedAt: snapshot.workflowRun.finishedAt,
      progress: snapshot.workflowRun.progress ?? null,
    },
    title: titleOf(snapshot.title, snapshot.season),
    summary: {
      searched: snapshot.resourceSnapshots.length,
      candidateCount: candidates.length,
      selectedCount: selectedIds.size,
      rejectedCount: rejectedIds.size,
      droppedByIdentity: prefilterDrops.identity,
      droppedAsNsfw: prefilterDrops.nsfw,
      transferSucceeded: snapshot.transferAttempts.filter((a) => a.status === "succeeded").length,
      transferFailed: snapshot.transferAttempts.filter((a) => a.status === "failed").length,
      transferNoChange: snapshot.transferAttempts.filter((a) => a.status === "no_target_change").length,
    },
    candidates,
    searches: snapshot.resourceSnapshots
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(traceSearch),
    decisions: snapshot.decisions.map(traceDecision),
    transfers: snapshot.transferAttempts.map(traceTransfer),
    audit: snapshot.workflowRun.auditEvents.map(traceAuditEvent),
    notifications: snapshot.notifications.map(traceNotification),
  };
}

function titleOf(title: MediaTitle, season: TrackedSeason): RunTrace["title"] {
  return {
    tmdbId: title.tmdbId,
    name: title.title,
    year: title.year,
    type: title.type,
    posterPath: title.posterPath ?? null,
    seasonNumber: season.seasonNumber,
    startEpisode: season.startEpisode ?? null,
  };
}

function uniqueCandidates(snapshots: readonly ResourceSnapshot[]): RunTraceCandidate[] {
  const byId = new Map<string, RunTraceCandidate>();
  for (const snapshot of snapshots) {
    for (const candidate of snapshot.candidates) {
      if (byId.has(candidate.id)) continue;
      byId.set(candidate.id, {
        id: candidate.id,
        snapshotId: candidate.snapshotId,
        snapshotKeyword: snapshot.keyword,
        index: candidate.index,
        title: candidate.title,
        type: candidate.type,
        source: candidate.source,
        sizeBytes: numberOrNull(candidate.providerPayload["sizeBytes"]),
        targetProvider: stringOrNull(candidate.providerPayload["targetProvider"]),
      });
    }
  }
  return [...byId.values()];
}

function traceSearch(snapshot: ResourceSnapshot): RunTraceSearch {
  return {
    id: snapshot.id,
    provider: snapshot.provider,
    keyword: snapshot.keyword,
    createdAt: snapshot.createdAt,
    candidateIds: snapshot.candidates.map((candidate) => candidate.id),
    sourceHealth: snapshot.sourceHealth ?? null,
    sourceStats: snapshot.sourceStats ?? null,
    prefilter: snapshot.prefilter ?? null,
  };
}

function traceDecision(decision: AgentDecision, ordinal: number): RunTraceDecision {
  return {
    ordinal,
    node: decision.node,
    snapshotId: decision.snapshotId,
    confidence: decision.confidence,
    reason: decision.reason,
    selectedCandidateIds: decision.selectedCandidateIds,
    rejectedCandidateIds: decision.rejectedCandidateIds,
    episodeMapping: decision.episodeMapping,
    providerAheadEpisodeMapping: decision.providerAheadEpisodeMapping,
  };
}

function traceTransfer(attempt: TransferAttempt, ordinal: number): RunTraceTransfer {
  return {
    ordinal,
    candidateId: attempt.candidateId,
    status: attempt.status,
    providerMessage: attempt.providerMessage,
    materializedFileIds: attempt.materializedFileIds,
    ...(attempt.materializedNames !== undefined ? { materializedNames: attempt.materializedNames } : {}),
    ...(attempt.fate !== undefined ? { fate: attempt.fate } : {}),
  };
}

function traceAuditEvent(event: AuditEvent): RunTraceAuditEvent {
  return {
    type: event.type,
    message: event.message,
    ...(event.data !== undefined ? { data: event.data } : {}),
  };
}

function traceNotification(event: NotificationEvent): RunTraceNotification {
  return { kind: event.kind, title: event.title, body: event.body, createdAt: event.createdAt };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
