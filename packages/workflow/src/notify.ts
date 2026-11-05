import type { NotificationEvent, NotificationReport } from "./domain.js";
import { fetchWithTimeout } from "./fetch-with-timeout.js";
import { formatReportPushText } from "./notification-report.js";
import { getStorageBrand, isRegisteredStorageProvider } from "./storage-brands.js";

/** Human label for a drive in a push tag: the user-set nickname, else the brand
 *  name (115 网盘 / 夸克网盘). Mirrors the workspace switcher's fallback. Never
 *  throws — an unknown provider degrades to the raw provider string. */
export function driveDisplayName(drive: { provider: string; label: string | null }): string {
  const nickname = drive.label?.trim();
  if (nickname) return nickname;
  return isRegisteredStorageProvider(drive.provider) ? getStorageBrand(drive.provider).label : drive.provider;
}

/** Statuses that represent real files in the library (mirrors `apps/web/app/notifications/page.tsx`).
 *  A `no_coverage` / `failed` / `retrying` report landed nothing, so stamping a drive name on it
 *  (e.g. "来源网盘：夸克网盘" when the agent searched both 115 and 夸克 and found nothing)
 *  misleads the user into thinking only that one drive was searched (issue #359). */
const LANDED_REPORT_STATUSES = new Set(["acquired", "complete", "airing", "partial", "replaced"]);

/** Gate + resolution for the "which drive" push tag. Returns an EMPTY map when the
 *  account has < 2 drives (single-drive → no source tag anywhere). Otherwise maps
 *  each notification id to its source drive's display name. Entries whose drive is
 *  null/unknown (legacy run, drive unbound after the run, or the __unscoped__
 *  sentinel) or whose report status landed no files (`no_coverage` / `failed` /
 *  `retrying`) are omitted, not errored. When a multi-drive run stamped explicit
 *  `report.driveLabels`, those landed drive names take precedence over the queued
 *  `connectedStorageId`. */
export function resolveDriveSourceLabels(
  entries: Array<{
    connectedStorageId: string | null;
    notification: { id: string; report?: { status?: string; driveLabels?: string[] } };
  }>,
  drives: Array<{ id: string; provider: string; label: string | null }>,
): Map<string, string> {
  const labels = new Map<string, string>();
  if (drives.length < 2) {
    return labels;
  }
  const byId = new Map(drives.map((drive) => [drive.id, driveDisplayName(drive)]));
  for (const entry of entries) {
    const report = entry.notification.report;
    if (report?.status && !LANDED_REPORT_STATUSES.has(report.status)) {
      continue;
    }
    const reportDriveLabels = (report?.driveLabels ?? []).map((s) => s.trim()).filter(Boolean);
    if (reportDriveLabels.length > 0) {
      labels.set(entry.notification.id, reportDriveLabels.join("、"));
      continue;
    }
    const name = entry.connectedStorageId ? byId.get(entry.connectedStorageId) : undefined;
    if (name) {
      labels.set(entry.notification.id, name);
    }
  }
  return labels;
}

export interface PushMessage {
  title: string;
  text: string;
}

function reportTitle(report: NotificationReport): string {
  if (report.seasonLabel) return `${report.titleName} ${report.seasonLabel}`;
  return report.year ? `${report.titleName} (${report.year})` : report.titleName;
}

/** Render one notification as the plain-text message the WeCom robot sends.
 *  Reports get the structured emoji text + an optional source-drive line; events
 *  without a report keep their stored title/body (digest, foreign-work, legacy). */
export function buildPushMessage(
  notification: NotificationEvent,
  opts?: { sourceLabel?: string },
): PushMessage {
  const report = notification.report;
  if (!report) {
    return { title: notification.title, text: notification.body };
  }
  const text = formatReportPushText(report);
  return {
    title: reportTitle(report),
    text: opts?.sourceLabel ? `${text}\n📦 来源网盘：${opts.sourceLabel}` : text,
  };
}

/** WeCom robot text messages are capped at 2048 bytes (UTF-8). */
export const WECOM_TEXT_MAX_BYTES = 2048;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Split an over-long single line at code-point boundaries so no character is cut. */
function hardSplit(line: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    const candidate = current + char;
    if (byteLength(candidate) > maxBytes && current !== "") {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

/** Pack text into at most `maxBytes` per chunk, preferring line boundaries. */
export function splitWeComContent(content: string, maxBytes = WECOM_TEXT_MAX_BYTES): string[] {
  if (byteLength(content) <= maxBytes) return [content];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
  };
  for (const line of content.split("\n")) {
    if (byteLength(line) > maxBytes) {
      flush();
      chunks.push(...hardSplit(line, maxBytes));
      continue;
    }
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return chunks.length === 0 ? [""] : chunks;
}

/** The actual contents POSTed for one push. A single message is left untouched;
 *  multi-part pushes get a `[i/n] ` prefix, which is accounted for in the split. */
export function weComMessageParts(
  message: PushMessage,
  maxBytes = WECOM_TEXT_MAX_BYTES,
): string[] {
  const content = `${message.title}\n${message.text}`;
  if (byteLength(content) <= maxBytes) return [content];
  // Reserve room for the widest realistic prefix ("[999/999] " = 10 bytes).
  const chunks = splitWeComContent(content, maxBytes - 12);
  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

export type WeComFetch = typeof fetch;

const defaultWeComFetch: WeComFetch = (input, init) =>
  fetchWithTimeout(String(input), init ?? {}, 20_000);

/**
 * POST plain-text parts to a WeCom group-robot webhook.
 *
 * WeCom returns HTTP 200 even for most failures; the JSON `errcode` is the real
 * delivery verdict. Anything other than an explicit `errcode: 0` (including an
 * unparseable body) throws — and the error never contains the webhook URL, whose
 * query string is the robot's credential.
 */
export async function sendWeComText(input: {
  webhookUrl: string;
  message: PushMessage;
  fetchImpl?: WeComFetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? defaultWeComFetch;
  for (const content of weComMessageParts(input.message)) {
    let response: Response;
    try {
      response = await fetchImpl(input.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      throw new Error(`wecom push failed: ${name}`);
    }
    const body = await response.text().catch(() => "");
    let parsed: { errcode?: unknown; errmsg?: unknown } | null = null;
    try {
      parsed = JSON.parse(body) as { errcode?: unknown; errmsg?: unknown } | null;
    } catch {
      parsed = null;
    }
    const errcode = parsed !== null && typeof parsed.errcode === "number" ? parsed.errcode : undefined;
    if (!response.ok || errcode !== 0) {
      const detail =
        parsed !== null && typeof parsed.errmsg === "string" && parsed.errmsg.trim() !== ""
          ? parsed.errmsg.trim()
          : body.slice(0, 120);
      throw new Error(
        `wecom push failed: HTTP ${response.status}` +
          `${errcode === undefined ? "" : ` errcode ${errcode}`}` +
          `${detail === "" ? "" : ` ${detail}`}`,
      );
    }
  }
}

/**
 * Unified push dispatch: reads the account's WeCom webhook (override > DB > env)
 * and sends one notification. Returns `["wecom"]` on success, or `[]` when no
 * webhook is configured. Throws on delivery failure so the caller can log it —
 * a push failure never affects workflow runs because every caller wraps it.
 */
export async function sendPushNotifications(input: {
  repository: { getSetting(key: string): Promise<string | null> };
  notification: NotificationEvent;
  overrideConfig?: Record<string, string>;
  fetchImpl?: WeComFetch;
  /** Source-drive tag for the message (set by the push layer when ≥2 drives). */
  sourceLabel?: string;
}): Promise<string[]> {
  const override = input.overrideConfig?.wecom;
  const dbValue = await input.repository.getSetting("push_wecom");
  const envValue = process.env.MEDIA_TRACK_PUSH_WECOM_WEBHOOK;
  const webhookUrl = (override || dbValue || envValue || "").trim();
  if (!webhookUrl) {
    return [];
  }

  const message = buildPushMessage(
    input.notification,
    input.sourceLabel ? { sourceLabel: input.sourceLabel } : undefined,
  );
  await sendWeComText({
    webhookUrl,
    message,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  return ["wecom"];
}
