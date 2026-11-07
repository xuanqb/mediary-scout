import { randomUUID } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ID,
  TmdbNotFoundError,
  createTmdbMetadataProvider,
  episodeCode,
  episodeNumberFromCode,
  ingestPayloadSignature,
  isTerminalIngestStatus,
  libraryCategoryOf,
  prepareMovieTarget,
  prepareTrackingTarget,
  queueMovieAcquisition,
  queueTrackingInitialization,
  seasonStartEpisode,
  type IngestMediaType,
  type IngestNoResourceReason,
  type IngestTask,
  type IngestTaskError,
  type MediaTitle,
  type PersistedWorkflowRunSnapshot,
  type TrackedSeason,
  type TrackedSeasonState,
  type WorkflowRepository,
} from "@media-track/workflow";
import { EmbyUnavailableError, episodesInEmby, movieInEmby } from "../emby-client";
import {
  getAccountScopedSettings,
  getOwnerAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  resolveAccountEmbyConfig,
  resolveQueueStorage,
} from "../workflow-runtime";

/** A request-level failure with a deterministic HTTP status. */
export class IngestRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IngestRequestError";
  }
}

/** A create attempt that ends as a failed task (HTTP 202), not a protocol error. */
class IngestTaskFailure extends Error {
  constructor(readonly error: IngestTaskError) {
    super(error.message);
    this.name = "IngestTaskFailure";
  }
}

export type IngestQuality = "best" | "4k" | "1080p";

export interface ParsedIngestCreate {
  requestId: string;
  tmdbId: number;
  mediaType: IngestMediaType;
  seasonNumber: number | null;
  year: number;
  title: string;
  quality: IngestQuality;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTmdbId(value: unknown): number {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw)) {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "media.tmdb_id 必须是 TMDB 数字 ID");
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "media.tmdb_id 不是有效的 TMDB ID");
  }
  return id;
}

function parseYear(value: unknown): number {
  const year = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isInteger(year) || year < 1800 || year > 3000) {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "media.year 必须是有效年份");
  }
  return year;
}

function parseQuality(value: unknown): IngestQuality {
  if (value === "4k" || value === "4K") return "4k";
  if (value === "1080p" || value === "1080P") return "1080p";
  return "best";
}

/** Validate the public create body. Throws IngestRequestError(400) on any bad field. */
export function parseIngestCreate(raw: unknown): ParsedIngestCreate {
  const body = asRecord(raw);
  if (!body) {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "请求体必须是 JSON 对象");
  }
  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
  if (!requestId || requestId.length > 64) {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "request_id 必须是非空字符串且不超过 64 字符");
  }
  const media = asRecord(body.media);
  if (!media) {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "media 字段缺失");
  }
  const mediaType = media.type;
  if (mediaType !== "movie" && mediaType !== "series") {
    throw new IngestRequestError(400, "INVALID_ARGUMENT", "media.type 必须是 movie 或 series");
  }
  const tmdbId = parseTmdbId(media.tmdb_id);
  const year = parseYear(media.year);

  let seasonNumber: number | null = null;
  if (mediaType === "series") {
    const season = media.season_number;
    if (typeof season !== "number" || !Number.isInteger(season) || season < 1) {
      throw new IngestRequestError(400, "INVALID_ARGUMENT", "剧集必须提供从 1 开始的整数 media.season_number");
    }
    seasonNumber = season;
  }

  const title = typeof media.title === "string" ? media.title.trim().slice(0, 200) : "";
  const options = asRecord(body.options);
  return {
    requestId,
    tmdbId,
    mediaType,
    seasonNumber,
    year,
    title,
    quality: parseQuality(options?.quality),
  };
}

function qualityPreference(quality: IngestQuality): "high" | "medium" | undefined {
  if (quality === "4k") return "high";
  if (quality === "1080p") return "medium";
  return undefined;
}

async function resolveAccountId(): Promise<string> {
  try {
    return await getOwnerAccountId();
  } catch {
    return DEFAULT_ACCOUNT_ID;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

const INGEST_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let lastIngestPruneAt = 0;

/** Opportunistic housekeeping: contract §7.3 keeps task rows for 30 days. */
async function pruneOldIngestTasks(repository: WorkflowRepository): Promise<void> {
  const now = Date.now();
  if (now - lastIngestPruneAt < 60 * 60 * 1000) return;
  lastIngestPruneAt = now;
  try {
    await repository.pruneIngestTasks(new Date(now - INGEST_TASK_RETENTION_MS).toISOString());
  } catch (error) {
    console.warn(`[ingest] task prune failed: ${String(error)}`);
  }
}

function terminalTask(
  task: IngestTask,
  status: Exclude<IngestTask["status"], "following">,
  input: {
    message: string;
    alreadyExists?: boolean;
    reason?: IngestNoResourceReason | null;
    error?: IngestTaskError | null;
    workflowRunId?: string | null;
    trackedSeasonId?: string | null;
  },
): IngestTask {
  const at = nowIso();
  return {
    ...task,
    status,
    message: input.message,
    alreadyExists: input.alreadyExists ?? task.alreadyExists,
    reason: input.reason ?? null,
    error: input.error ?? null,
    workflowRunId: input.workflowRunId === undefined ? task.workflowRunId : input.workflowRunId,
    trackedSeasonId: input.trackedSeasonId === undefined ? task.trackedSeasonId : input.trackedSeasonId,
    updatedAt: at,
    finishedAt: at,
  };
}

function followingTask(
  task: IngestTask,
  input: {
    message: string;
    workflowRunId?: string | null;
    trackedSeasonId?: string | null;
    connectedStorageId?: string | null;
    title?: string;
    year?: number;
  },
): IngestTask {
  return {
    ...task,
    status: "following",
    message: input.message,
    alreadyExists: false,
    reason: null,
    error: null,
    workflowRunId: input.workflowRunId === undefined ? task.workflowRunId : input.workflowRunId,
    trackedSeasonId: input.trackedSeasonId === undefined ? task.trackedSeasonId : input.trackedSeasonId,
    connectedStorageId:
      input.connectedStorageId === undefined ? task.connectedStorageId : input.connectedStorageId,
    title: input.title ?? task.title,
    year: input.year ?? task.year,
    updatedAt: nowIso(),
    finishedAt: null,
  };
}

/** A film is unreleased until TMDB's release date (or, lacking one, its year). */
function isUnreleased(title: MediaTitle, now = new Date()): boolean {
  if (title.releaseDate) {
    const releasedAt = Date.parse(`${title.releaseDate}T00:00:00Z`);
    if (Number.isFinite(releasedAt)) {
      return releasedAt > Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    }
  }
  return title.year > now.getUTCFullYear();
}

/** Whether every aired episode of the requested season is already in Emby. */
function seasonCompleteInEmby(season: TrackedSeason, embyEpisodes: readonly string[]): boolean {
  if (season.totalEpisodes <= 0) return false;
  if (season.latestAiredEpisode < season.totalEpisodes) return false;
  const start = seasonStartEpisode(season);
  const present = new Set(embyEpisodes);
  for (let number = start; number <= season.totalEpisodes; number += 1) {
    if (!present.has(episodeCode(season.seasonNumber, number))) return false;
  }
  return true;
}

async function queueTask(input: {
  task: IngestTask;
  parsed: ParsedIngestCreate;
  repository: WorkflowRepository;
  connectedStorageId: string;
}): Promise<IngestTask> {
  const { task, parsed, connectedStorageId } = input;
  const settings = getAccountScopedSettings(task.accountId);
  const metadataProvider = createTmdbMetadataProvider(await getTmdbAccesses(settings));
  const embyConfig = await resolveAccountEmbyConfig(task.accountId);
  if (!embyConfig) throw new EmbyUnavailableError("not configured");
  const quality = qualityPreference(parsed.quality);

  if (parsed.mediaType === "movie") {
    const target = await prepareMovieTarget({
      tmdbId: parsed.tmdbId,
      qualityPreference: "4K",
      metadataProvider,
    });
    const title = target.title;
    if (title.year !== parsed.year) {
      console.warn(
        `[ingest] year mismatch for tmdb movie ${parsed.tmdbId}: request ${parsed.year}, TMDB ${title.year} (TMDB wins for naming)`,
      );
    }
    const alreadyInEmby = await movieInEmby(
      embyConfig,
      { tmdbId: parsed.tmdbId, category: libraryCategoryOf(title) },
      { failClosed: true },
    );
    if (alreadyInEmby) {
      return terminalTask(task, "completed", {
        message: "已在 Emby 中，无需获取",
        alreadyExists: true,
        trackedSeasonId: `${title.id}_movie`,
      });
    }
    if (isUnreleased(title)) {
      return terminalTask(task, "no_resource", {
        message: "电影尚未上映",
        reason: "UNRELEASED",
        trackedSeasonId: `${title.id}_movie`,
      });
    }
    const queued = await queueMovieAcquisition({
      title,
      keyword: target.keyword,
      repository: input.repository,
      accountId: task.accountId,
      connectedStorageId,
      providerMode: true,
      ...(quality === undefined ? {} : { providerQuality: quality }),
    });
    return followingTask(task, {
      message: "已受理，开始获取",
      workflowRunId: queued.workflowRunId,
      trackedSeasonId: `${title.id}_movie`,
      connectedStorageId,
      title: title.title,
      year: title.year || parsed.year,
    });
  }

  const seasonNumber = parsed.seasonNumber;
  if (seasonNumber === null) {
    throw new IngestTaskFailure({
      code: "INVALID_ARGUMENT",
      message: "剧集缺少 season_number",
      retryable: false,
    });
  }
  const target = await prepareTrackingTarget({
    tmdbId: parsed.tmdbId,
    mediaType: "tv",
    seasonNumber,
    qualityPreference: "4K",
    metadataProvider,
  });
  const title = target.title;
  if (title.year !== parsed.year) {
    console.warn(
      `[ingest] year mismatch for tmdb tv ${parsed.tmdbId}: request ${parsed.year}, TMDB ${title.year} (TMDB wins for naming)`,
    );
  }
  const season: TrackedSeason = {
    ...target.season,
    providerMode: true,
    ...(quality === undefined ? {} : { providerQuality: quality }),
  };
  const embyEpisodes = await episodesInEmby(
    embyConfig,
    { tmdbId: parsed.tmdbId, category: libraryCategoryOf(title) },
    { failClosed: true },
  );
  if (seasonCompleteInEmby(season, embyEpisodes)) {
    return terminalTask(task, "completed", {
      message: "本季已完整存在于 Emby",
      alreadyExists: true,
      trackedSeasonId: season.id,
    });
  }
  const queued = await queueTrackingInitialization({
    title,
    season,
    keyword: target.keyword,
    repository: input.repository,
    accountId: task.accountId,
    connectedStorageId,
    providerMode: true,
  });
  return followingTask(task, {
    message: "已受理，开始追更",
    workflowRunId: queued.workflowRunId,
    trackedSeasonId: queued.trackedSeasonId,
    connectedStorageId,
    title: title.title,
    year: title.year || parsed.year,
  });
}

function taskErrorForCreate(error: unknown, mediaType: IngestMediaType): IngestTaskError {
  if (error instanceof IngestTaskFailure) return error.error;
  if (error instanceof EmbyUnavailableError) {
    return { code: "EMBY_UNAVAILABLE", message: "Emby 不可达", retryable: true };
  }
  if (error instanceof TmdbNotFoundError) {
    return mediaType === "movie"
      ? { code: "MEDIA_NOT_FOUND", message: "TMDB 中不存在该电影", retryable: false }
      : { code: "SEASON_NOT_FOUND", message: "TMDB 中不存在该季", retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL_ERROR", message: message.slice(0, 500), retryable: true };
}

/**
 * POST /api/v1/ingest/tasks: reserve the request_id first (race-safe duplicate
 * detection), then prepare metadata / inspect Emby / queue the acquisition.
 */
export async function createIngestTask(raw: unknown): Promise<{ task: IngestTask; created: boolean }> {
  const parsed = parseIngestCreate(raw);
  const accountId = await resolveAccountId();
  const repository = getWorkflowRepository();
  await pruneOldIngestTasks(repository);
  const signature = ingestPayloadSignature({
    tmdbId: parsed.tmdbId,
    mediaType: parsed.mediaType,
    seasonNumber: parsed.seasonNumber,
    year: parsed.year,
  });

  const existing = await repository.getIngestTaskByRequestId(parsed.requestId);
  if (existing) {
    if (existing.payloadSignature !== signature) {
      console.warn(
        `[ingest] duplicate request_id ${parsed.requestId} with a different payload — returning the original task`,
      );
    }
    return { task: existing, created: false };
  }

  const at = nowIso();
  const placeholder: IngestTask = {
    id: `ingest_${randomUUID().replaceAll("-", "")}`,
    requestId: parsed.requestId,
    accountId,
    tmdbId: parsed.tmdbId,
    mediaType: parsed.mediaType,
    seasonNumber: parsed.seasonNumber,
    year: parsed.year,
    title: parsed.title,
    status: "following",
    message: "已受理",
    alreadyExists: false,
    reason: null,
    error: null,
    workflowRunId: null,
    trackedSeasonId: null,
    connectedStorageId: null,
    payloadSignature: signature,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
  };
  const inserted = await repository.createIngestTask(placeholder);
  if (!inserted.created) {
    if (inserted.task.payloadSignature !== signature) {
      console.warn(
        `[ingest] duplicate request_id ${parsed.requestId} with a different payload — returning the original task`,
      );
    }
    return inserted;
  }

  try {
    const workspace = await resolveQueueStorage(accountId);
    if (workspace.unknown) {
      throw new IngestTaskFailure({
        code: "TEMPORARY_FAILURE",
        message: "网盘状态不可用",
        retryable: true,
      });
    }
    if (workspace.frozen) {
      throw new IngestTaskFailure({
        code: "STORAGE_AUTH_EXPIRED",
        message: "115 登录已失效，需要重新授权",
        retryable: false,
      });
    }
    if (!workspace.id) {
      throw new IngestTaskFailure({
        code: "TEMPORARY_FAILURE",
        message: "没有可用的网盘",
        retryable: true,
      });
    }
    const task = await queueTask({
      task: inserted.task,
      parsed,
      repository,
      connectedStorageId: workspace.id,
    });
    await repository.updateIngestTask(task);
    return { task, created: true };
  } catch (error) {
    const failure = taskErrorForCreate(error, parsed.mediaType);
    console.error(
      `[ingest] create ${parsed.requestId} failed: ${failure.code} ${failure.message}`,
    );
    const failed = terminalTask(inserted.task, "failed", {
      message: failure.message,
      error: failure,
      workflowRunId: null,
    });
    try {
      await repository.updateIngestTask(failed);
    } catch (persistError) {
      console.error(`[ingest] failed to persist failed task ${failed.id}: ${String(persistError)}`);
    }
    return { task: failed, created: true };
  }
}

async function findTaskRun(
  repository: WorkflowRepository,
  task: IngestTask,
): Promise<PersistedWorkflowRunSnapshot | null> {
  if (task.workflowRunId) {
    const snapshot = await repository.getWorkflowRunSnapshot(task.workflowRunId, task.accountId);
    if (snapshot) return snapshot;
  }
  const movie = task.mediaType === "movie";
  const active = await repository.listActiveWorkflowRuns(task.accountId);
  return (
    active.find(
      (snapshot) =>
        snapshot.title.tmdbId === task.tmdbId &&
        (snapshot.title.type === "movie") === movie &&
        (movie || snapshot.season.seasonNumber === task.seasonNumber),
    ) ?? null
  );
}

async function releaseTracking(
  repository: WorkflowRepository,
  task: IngestTask,
  state: TrackedSeasonState | undefined,
): Promise<void> {
  if (!state) return;
  try {
    await repository.untrackTitle(
      task.tmdbId,
      { accountId: task.accountId, connectedStorageId: state.connectedStorageId },
      task.mediaType === "movie" ? "movie" : "tv",
      task.mediaType === "movie" ? undefined : state.season.seasonNumber,
    );
  } catch (error) {
    console.warn(`[ingest] release tracking failed for task ${task.id}: ${String(error)}`);
  }
}

function summarizeRunFailure(run: PersistedWorkflowRunSnapshot): string {
  const events = run.workflowRun.auditEvents.filter((event) => event.type === "workflow_failed");
  const message = events.at(-1)?.message ?? "获取失败";
  return message.replace(/\s+/g, " ").slice(0, 300);
}

async function ingestErrorFromRun(
  repository: WorkflowRepository,
  task: IngestTask,
  run: PersistedWorkflowRunSnapshot,
): Promise<IngestTaskError> {
  const messages = run.workflowRun.auditEvents.map((event) => event.message).join(" | ");
  if (messages.includes("EMBY_UNAVAILABLE")) {
    return { code: "EMBY_UNAVAILABLE", message: "Emby 不可达", retryable: true };
  }
  if (task.connectedStorageId) {
    try {
      const storages = await repository.listConnectedStorages(task.accountId);
      if (storages.find((storage) => storage.id === task.connectedStorageId)?.status === "frozen") {
        return { code: "STORAGE_AUTH_EXPIRED", message: "115 登录已失效，需要重新授权", retryable: false };
      }
    } catch {
      // status read is best-effort — the message heuristics below still apply
    }
  }
  if (/(cookie|unauthori[sz]ed|未登录|鉴权|401)/i.test(messages)) {
    return { code: "STORAGE_AUTH_EXPIRED", message: "网盘登录已失效，需要重新授权", retryable: false };
  }
  if (/(空间不足|配额|quota|out of space)/i.test(messages)) {
    return { code: "QUOTA_EXCEEDED", message: "网盘空间不足", retryable: false };
  }
  return {
    code: "TEMPORARY_FAILURE",
    message: summarizeRunFailure(run),
    retryable: true,
  };
}

/** Derive a `following` task's live status from tracking state + its run. */
export async function resolveTaskStatus(
  task: IngestTask,
  repository: WorkflowRepository,
): Promise<IngestTask> {
  const movie = task.mediaType === "movie";
  const states = await repository.listTrackedSeasonStates(task.accountId);
  const matches = states.filter(
    (candidate) =>
      candidate.title.tmdbId === task.tmdbId &&
      (candidate.title.type === "movie") === movie &&
      (movie || candidate.season.seasonNumber === task.seasonNumber),
  );
  const state =
    matches.find((candidate) => candidate.connectedStorageId === task.connectedStorageId) ??
    matches[0];
  const run = await findTaskRun(repository, task);

  if (movie) {
    // A movie's delivery signal is the run result, not an episode row (the movie
    // anchor season carries no episodes). `partial` means the film landed but a
    // subtitle fallback was used — still delivered.
    const delivered =
      state?.episodes.some((episode) => episode.obtained) === true ||
      run?.workflowRun.status === "succeeded" ||
      run?.workflowRun.status === "partial";
    if (delivered) {
      return terminalTask(task, "completed", { message: "已交付" });
    }
    if (run?.workflowRun.status === "failed") {
      const error = await ingestErrorFromRun(repository, task, run);
      await releaseTracking(repository, task, state);
      return terminalTask(task, "failed", { message: error.message, error });
    }
    if (run?.workflowRun.status === "no_coverage") {
      await releaseTracking(repository, task, state);
      return terminalTask(task, "no_resource", {
        message: "当前没有可用资源",
        reason: "NO_RESOURCE",
      });
    }
    // A re-submitted film can already be delivered but not linked to this task's
    // run (the prior request's tracking had no run id). Emby is the shared
    // "already in library" truth — best-effort here; an outage just keeps following.
    try {
      const embyConfig = await resolveAccountEmbyConfig(task.accountId);
      if (embyConfig) {
        const inEmby = await movieInEmby(embyConfig, {
          tmdbId: task.tmdbId,
          category: state ? libraryCategoryOf(state.title) : "movies",
        });
        if (inEmby) {
          return terminalTask(task, "completed", {
            message: "已在 Emby 中，无需获取",
            alreadyExists: true,
          });
        }
      }
    } catch (error) {
      console.warn(`[ingest] status Emby lookup failed for ${task.id}: ${String(error)}`);
    }
    return followingTask(task, { message: "已受理，后台处理中" });
  }

  if (state) {
    const start = seasonStartEpisode(state.season);
    const inScope = state.episodes.filter(
      (episode) => episodeNumberFromCode(episode.episodeCode) >= start,
    );
    const aired = inScope.filter((episode) => episode.airStatus === "aired");
    const missing = aired.filter((episode) => !episode.obtained && !episode.availableInEmby);
    const fullyAired =
      state.season.totalEpisodes > 0 && state.season.latestAiredEpisode >= state.season.totalEpisodes;
    if (state.season.status === "completed" || (fullyAired && missing.length === 0)) {
      const delivered = aired.filter((episode) => episode.obtained).length;
      return terminalTask(task, "completed", { message: `已交付 ${delivered} 集` });
    }
    if (run?.workflowRun.status === "failed") {
      const error = await ingestErrorFromRun(repository, task, run);
      if (!inScope.some((episode) => episode.obtained)) {
        await releaseTracking(repository, task, state);
      }
      return terminalTask(task, "failed", { message: error.message, error });
    }
    const delivered = inScope.filter((episode) => episode.obtained).length;
    return followingTask(task, {
      message:
        state.season.latestAiredEpisode === 0
          ? "已受理，等待播出"
          : `已交付 ${delivered} 集，继续追踪`,
    });
  }

  if (run?.workflowRun.status === "failed") {
    const error = await ingestErrorFromRun(repository, task, run);
    return terminalTask(task, "failed", { message: error.message, error });
  }
  return followingTask(task, { message: "已受理，等待后台处理" });
}

/** GET /api/v1/ingest/tasks/{task_id}: terminal tasks are frozen as stored;
 *  `following` tasks are re-derived from tracking state on every read. */
export async function getIngestTask(taskId: string): Promise<IngestTask | null> {
  const repository = getWorkflowRepository();
  const task = await repository.getIngestTask(taskId);
  if (!task) return null;
  if (isTerminalIngestStatus(task.status)) return task;
  try {
    const resolved = await resolveTaskStatus(task, repository);
    if (resolved.status !== task.status || resolved.message !== task.message) {
      await repository.updateIngestTask(resolved);
    }
    return resolved;
  } catch (error) {
    console.warn(`[ingest] status resolution failed for ${taskId}: ${String(error)}`);
    return task;
  }
}

/** Wire-shaped response `data` (contract §8.1/§8.2). */
export function toIngestTaskData(task: IngestTask) {
  return {
    task_id: task.id,
    request_id: task.requestId,
    status: task.status,
    message: task.message,
    already_exists: task.alreadyExists,
    reason: task.reason,
    error: task.error,
    created_at: task.createdAt,
    finished_at: task.finishedAt,
  };
}
