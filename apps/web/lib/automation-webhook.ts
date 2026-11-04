import { createHmac } from "node:crypto";
import type { LibraryCategory, NotificationReport } from "@media-track/workflow";
import { getWorkflowRepository, resolveLandedStoragePath } from "./workflow-runtime";

/** Settings keys (account-scoped; pending/log deliberately have no global fallback). */
export const AUTOMATION_CONFIG_SETTING_KEY = "automation_webhook_config";
export const AUTOMATION_PENDING_SETTING_KEY = "automation_webhook_pending";
export const AUTOMATION_LOG_SETTING_KEY = "automation_webhook_deliveries";

export type AutomationTaskNames = Record<LibraryCategory, string>;

export interface AutomationConfig {
  enabled: boolean;
  url: string;
  /** HMAC-SHA256 secret; blank → no signature header. */
  secret: string;
  /** SmartStrm task name per shelf. Blank → that shelf is not triggered. */
  taskNames: AutomationTaskNames;
  /** Quiet window: wait this long after the last landing for the same directory. */
  quietSeconds: number;
  /** Hard cap on debounce: send at most this long after the first landing. */
  maxWaitSeconds: number;
  /** Extra attempts after the first failure. */
  retries: number;
  /** `incremental` / `dir_time_check` forwarded to SmartStrm's a_task. */
  incremental: boolean;
  dirTimeCheck: boolean;
  delaySeconds: number;
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  enabled: false,
  url: "",
  secret: "",
  taskNames: { movies: "电影", tv: "电视剧", variety: "综艺", anime: "动漫" },
  quietSeconds: 15,
  maxWaitSeconds: 120,
  retries: 3,
  incremental: true,
  dirTimeCheck: false,
  delaySeconds: 0,
};

const MAX_QUIET_SECONDS = 3600;
const MAX_WAIT_SECONDS = 7200;
const MAX_RETRIES = 10;
const MAX_DELAY_SECONDS = 3600;
const LOG_LIMIT = 50;

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseAutomationConfig(raw: string | null | undefined): AutomationConfig {
  const base: AutomationConfig = {
    ...DEFAULT_AUTOMATION_CONFIG,
    taskNames: { ...DEFAULT_AUTOMATION_CONFIG.taskNames },
  };
  if (!raw) return base;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return base;
    parsed = value as Record<string, unknown>;
  } catch {
    return base;
  }
  const taskNamesInput =
    parsed.taskNames && typeof parsed.taskNames === "object"
      ? (parsed.taskNames as Record<string, unknown>)
      : {};
  const taskNames = { ...base.taskNames };
  for (const key of ["movies", "tv", "variety", "anime"] as const) {
    const value = taskNamesInput[key];
    if (typeof value === "string") taskNames[key] = value.trim();
  }
  const quietSeconds = intInRange(parsed.quietSeconds, base.quietSeconds, 1, MAX_QUIET_SECONDS);
  return {
    enabled: boolValue(parsed.enabled, base.enabled),
    url: typeof parsed.url === "string" ? parsed.url.trim() : base.url,
    secret: typeof parsed.secret === "string" ? parsed.secret.trim() : base.secret,
    taskNames,
    quietSeconds,
    maxWaitSeconds: Math.max(
      quietSeconds,
      intInRange(parsed.maxWaitSeconds, base.maxWaitSeconds, 1, MAX_WAIT_SECONDS),
    ),
    retries: intInRange(parsed.retries, base.retries, 0, MAX_RETRIES),
    incremental: boolValue(parsed.incremental, base.incremental),
    dirTimeCheck: boolValue(parsed.dirTimeCheck, base.dirTimeCheck),
    delaySeconds: intInRange(parsed.delaySeconds, base.delaySeconds, 0, MAX_DELAY_SECONDS),
  };
}

export async function readAutomationConfig(accountId: string): Promise<AutomationConfig> {
  const raw = await getWorkflowRepository().getAccountSetting(accountId, AUTOMATION_CONFIG_SETTING_KEY);
  return parseAutomationConfig(raw);
}

export interface SmartStrmTaskPayload {
  event: "a_task";
  delay: number;
  task: {
    name: string;
    storage_path: string;
    dir_time_check: boolean;
    incremental: boolean;
  };
}

/** The exact contract SmartStrm's `/webhook/<token>` accepts (see usapi's
 *  SupportAlistStrm.SMARTSTRM_MODE). */
export function buildSmartStrmPayload(
  config: Pick<AutomationConfig, "incremental" | "dirTimeCheck" | "delaySeconds">,
  taskName: string,
  storagePath: string,
): SmartStrmTaskPayload {
  return {
    event: "a_task",
    delay: config.delaySeconds,
    task: {
      name: taskName,
      storage_path: storagePath,
      dir_time_check: config.dirTimeCheck,
      incremental: config.incremental,
    },
  };
}

/** SmartStrm does not require a signature, but the header lets any other
 *  receiver verify the body came from this instance. */
export function automationSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

interface SendResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

async function postAutomation(
  url: string,
  secret: string,
  payload: SmartStrmTaskPayload,
): Promise<SendResult> {
  const body = JSON.stringify(payload);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Media-Track-Signature": automationSignature(secret, body) } : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, body: text.slice(0, 500) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type PendingTask = {
  id: string;
  storageId: string;
  category: LibraryCategory;
  title: string;
  year: number | null;
  tmdbId: number;
  taskName: string;
  storagePath: string;
  firstAt: string;
  dueAt: string;
  attempts: number;
};

export type AutomationDelivery = {
  id: string;
  at: string;
  storagePath: string;
  taskName: string;
  status: "sent" | "failed";
  httpStatus?: number;
  detail?: string;
};

async function readJsonArray<T>(accountId: string, key: string): Promise<T[]> {
  const raw = await getWorkflowRepository().getAccountSetting(accountId, key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJson(accountId: string, key: string, value: unknown): Promise<void> {
  await getWorkflowRepository().setAccountSetting(accountId, key, JSON.stringify(value));
}

/** Serialize read-modify-write cycles across the in-process worker and server actions. */
let mutationChain: Promise<unknown> = Promise.resolve();
function withMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => undefined);
  return next;
}

const LANDED_STATUSES = new Set(["acquired", "complete", "airing", "partial", "replaced"]);

export interface LandingInput {
  connectedStorageId: string | null;
  report: NotificationReport | undefined;
}

/** Queue one SmartStrm task per (landed drive × title folder), debounced by path. */
export async function enqueueAutomationForLandings(input: {
  accountId: string;
  entries: LandingInput[];
}): Promise<number> {
  const config = await readAutomationConfig(input.accountId);
  if (!config.enabled || !config.url) return 0;
  return withMutation(async () => {
    const pending = await readJsonArray<PendingTask>(input.accountId, AUTOMATION_PENDING_SETTING_KEY);
    // SmartStrm only feeds drives that Emby cannot mount directly. 115 is mounted
    // as-is, so refreshing .strm there would just rescan the library for nothing.
    const drives = await getWorkflowRepository().listConnectedStorages(input.accountId);
    const providerByStorageId = new Map(drives.map((drive) => [drive.id, drive.provider]));
    const now = Date.now();
    let queued = 0;
    for (const entry of input.entries) {
      const report = entry.report;
      if (!report || !LANDED_STATUSES.has(report.status)) continue;
      // A patrol no-op or an Emby-only skip carries a landed-looking status but
      // wrote nothing this run — scanning SmartStrm would be pure noise.
      if (report.landed !== true) continue;
      if (!report.tmdbId) continue;
      const category: LibraryCategory =
        report.libraryCategory ??
        (report.mediaType === "movie" ? "movies" : report.mediaType === "anime" ? "anime" : "tv");
      const taskName = config.taskNames[category];
      if (!taskName) continue;
      const storageIds =
        report.landedStorageIds && report.landedStorageIds.length > 0
          ? report.landedStorageIds
          : entry.connectedStorageId
            ? [entry.connectedStorageId]
            : [];
      for (const storageId of new Set(storageIds)) {
        if (providerByStorageId.get(storageId) === "pan115") continue;
        const storagePath = await resolveLandedStoragePath({
          accountId: input.accountId,
          storageId,
          category,
          title: report.titleName,
          year: report.year ?? null,
          tmdbId: report.tmdbId,
        });
        if (!storagePath) continue;
        const existing = pending.find((task) => task.storagePath === storagePath);
        const quietUntil = now + config.quietSeconds * 1000;
        if (existing) {
          const maxWait = Date.parse(existing.firstAt) + config.maxWaitSeconds * 1000;
          existing.dueAt = new Date(Math.min(quietUntil, maxWait)).toISOString();
          existing.taskName = taskName;
          continue;
        }
        pending.push({
          id: `automation_${now}_${Math.random().toString(36).slice(2, 8)}`,
          storageId,
          category,
          title: report.titleName,
          year: report.year ?? null,
          tmdbId: report.tmdbId,
          taskName,
          storagePath,
          firstAt: new Date(now).toISOString(),
          dueAt: new Date(quietUntil).toISOString(),
          attempts: 0,
        });
        queued += 1;
      }
    }
    if (queued > 0 || pending.length > 0) {
      await writeJson(input.accountId, AUTOMATION_PENDING_SETTING_KEY, pending);
    }
    return queued;
  });
}

function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 5_000 * 2 ** attempts);
}

/** Send every pending task whose debounce window has elapsed. Called by the
 *  background worker; survives process restarts because the queue is persisted. */
export async function flushDueAutomationWebhooks(now = Date.now()): Promise<number> {
  return withMutation(async () => {
    const repository = getWorkflowRepository();
    const accounts = await repository.listAccounts();
    let sent = 0;
    for (const account of accounts) {
      const config = await readAutomationConfig(account.id);
      if (!config.enabled || !config.url) continue;
      const pending = await readJsonArray<PendingTask>(account.id, AUTOMATION_PENDING_SETTING_KEY);
      if (pending.length === 0) continue;
      const due = pending.filter((task) => Date.parse(task.dueAt) <= now);
      if (due.length === 0) continue;
      const remaining = pending.filter((task) => !due.includes(task));
      const log = await readJsonArray<AutomationDelivery>(account.id, AUTOMATION_LOG_SETTING_KEY);
      for (const task of due) {
        const result = await postAutomation(
          config.url,
          config.secret,
          buildSmartStrmPayload(config, task.taskName, task.storagePath),
        );
        if (result.ok) {
          sent += 1;
          log.unshift({
            id: task.id,
            at: new Date(now).toISOString(),
            storagePath: task.storagePath,
            taskName: task.taskName,
            status: "sent",
            httpStatus: result.status,
            ...(result.body ? { detail: result.body } : {}),
          });
          continue;
        }
        if (task.attempts < config.retries) {
          remaining.push({
            ...task,
            attempts: task.attempts + 1,
            dueAt: new Date(now + retryDelayMs(task.attempts)).toISOString(),
          });
          continue;
        }
        log.unshift({
          id: task.id,
          at: new Date(now).toISOString(),
          storagePath: task.storagePath,
          taskName: task.taskName,
          status: "failed",
          httpStatus: result.status,
          detail: result.error ?? result.body,
        });
      }
      await writeJson(account.id, AUTOMATION_PENDING_SETTING_KEY, remaining);
      await writeJson(account.id, AUTOMATION_LOG_SETTING_KEY, log.slice(0, LOG_LIMIT));
    }
    return sent;
  });
}

export async function readAutomationDeliveries(accountId: string): Promise<AutomationDelivery[]> {
  return (await readJsonArray<AutomationDelivery>(accountId, AUTOMATION_LOG_SETTING_KEY)).slice(0, 20);
}

/** One-off send used by the settings test button. Never queued or logged. */
export async function testAutomationWebhook(input: {
  url: string;
  secret: string;
  taskName: string;
  storagePath: string;
  config?: Partial<AutomationConfig>;
}): Promise<{ success: boolean; message: string }> {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return { success: false, message: "Webhook 地址需以 http:// 或 https:// 开头。" };
  }
  const config = { ...DEFAULT_AUTOMATION_CONFIG, ...(input.config ?? {}) };
  const result = await postAutomation(
    url,
    input.secret.trim(),
    buildSmartStrmPayload(config, input.taskName.trim() || "测试", input.storagePath),
  );
  if (result.ok) {
    return {
      success: true,
      message: `HTTP ${result.status}${result.body ? ` · ${result.body}` : ""}`,
    };
  }
  return {
    success: false,
    message: result.error ? `请求失败：${result.error}` : `HTTP ${result.status}${result.body ? ` · ${result.body}` : ""}`,
  };
}
