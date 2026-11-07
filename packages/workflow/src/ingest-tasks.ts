/**
 * USAPI ⇄ 巡影 provider contract: one ingest task per (request_id).
 *
 * The four statuses are the entire public surface (no stage/progress):
 * `following` is an accepted-terminal state — USAPI stops polling it and
 * reconciles daily; only `completed` / `no_resource` / `failed` end a task.
 */
export type IngestTaskStatus = "following" | "completed" | "no_resource" | "failed";

export type IngestMediaType = "movie" | "series";

/** Why a task carries `no_resource`. Movies only — a series never reports it. */
export type IngestNoResourceReason = "NO_RESOURCE" | "UNRELEASED";

export interface IngestTaskError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface IngestTask {
  /** Vendor task id returned to USAPI (`task_id`). */
  id: string;
  /** USAPI's idempotency key; instance-unique. */
  requestId: string;
  accountId: string;
  tmdbId: number;
  mediaType: IngestMediaType;
  /** Null for movies, the requested season for series. */
  seasonNumber: number | null;
  year: number;
  title: string;
  status: IngestTaskStatus;
  /** Human-readable phase/result line for USAPI logs. */
  message: string | null;
  /** Only meaningful when status = completed: the film was already in Emby. */
  alreadyExists: boolean;
  reason: IngestNoResourceReason | null;
  error: IngestTaskError | null;
  /** The run this request queued. Null when it attached to existing tracking. */
  workflowRunId: string | null;
  trackedSeasonId: string | null;
  connectedStorageId: string | null;
  /** Fingerprint of the create payload — a duplicate request_id with a different
   *  payload is returned unchanged and logged (contract §7.3). */
  payloadSignature: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Canonical payload identity for duplicate-request detection. */
export function ingestPayloadSignature(input: {
  tmdbId: number;
  mediaType: IngestMediaType;
  seasonNumber: number | null;
  year: number;
}): string {
  return `${input.tmdbId}:${input.mediaType}:${input.seasonNumber ?? ""}:${input.year}`;
}

export function isTerminalIngestStatus(status: IngestTaskStatus): boolean {
  return status !== "following";
}
