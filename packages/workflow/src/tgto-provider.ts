import { createHash } from "node:crypto";
import type { ResourceCandidate, ResourceSnapshot, ResourceType } from "./domain.js";
import type { ResourceCandidateLinkResolver, ResourceProvider, ResourceSearchInput } from "./ports.js";
import {
  classifySourceFailure,
  hasRecognisedUnreachableCode,
  mergeSourceHealth,
  type SourceStatus,
} from "./resource-source-health.js";

/**
 * TgtoDrive 资源源。它自家实例同时索引 re0 / 观影 / SeedHub 三个来源：
 * - re0 返回 **115 转存分享**，搜索阶段只给 slug/source，链接要靠 copy-link 换，
 *   而 copy-link 对未解锁条目会扣积分 —— 所以只在真正转存时才解析（见
 *   TgtoShareLinkResolver），搜索阶段绝不批量调用。
 * - 观影返回**磁力**，share_url 直接随搜索结果下发，零成本、零额外请求。
 * - SeedHub 也有磁力，但一次搜索要 30s+，默认关闭。
 *
 * 目标网盘只支持 115（123/光鸭未配置；传 quark 上游直接 400），因此这个源只
 * 挂在 115 盘上，allowedTypes 不含 115 时它不发请求。
 */

export const TGTO_DEFAULT_SOURCES = ["re0", "guanying"] as const;
/** 上游是多源实时聚合：re0+观影实测 10–21s（SeedHub 单源再 +30s）。30s 留够余量，
 *  一次超时不会让整次搜索陪卡 50s；搜索是只读幂等，超时/连接失败后再试一次，
 *  冷启动与瞬时抖动通常第二次就能答（总预算 2×30s，不比原来单次 50s 差多少）。 */
export const TGTO_DEFAULT_TIMEOUT_MS = 30_000;
export const TGTO_SEARCH_ATTEMPTS = 2;
export const TGTO_DEFAULT_COPY_LINK_TIMEOUT_MS = 90_000;
export const TGTO_DEFAULT_MAX_POINTS = 0;

export interface TgtoSearchItem {
  title?: unknown;
  message_text?: unknown;
  message_body?: unknown;
  remark?: unknown;
  slug?: unknown;
  source?: unknown;
  provider?: unknown;
  link_type?: unknown;
  share_url?: unknown;
  size?: unknown;
  resource_specification?: unknown;
  resolution?: unknown;
  episode?: unknown;
  subtitle_languages?: unknown;
  subtitle_types?: unknown;
  supported_targets?: unknown;
  validate_status?: unknown;
  unlock_points?: unknown;
  points_known?: unknown;
  is_unlocked?: unknown;
  item_key?: unknown;
  published_at?: unknown;
}

export interface TgtoSearchData {
  items: TgtoSearchItem[];
  errors: unknown[];
}

export interface TgtoCopyLinkResult {
  url: string;
  password: string;
  points: number;
  alreadyOwned: boolean;
}

export interface TgtoFetchJson {
  (url: string, init: {
    method: "POST" | "GET";
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<unknown>;
}

export interface TgtoClientOptions {
  baseUrl: string;
  token: string;
  fetchJson?: TgtoFetchJson;
  /** 搜索超时。 */
  timeoutMs?: number;
  /** copy-link 换链超时：上游要现场解析分享，实测 10–20s，偶发更久。 */
  copyLinkTimeoutMs?: number;
}

/** A candidate marked for lazy copy-link: still no url at search time. */
export interface TgtoCandidateRef {
  slug: string;
  source: string;
  provider: string;
}

const TGTO_PAYLOAD_KEY = "tgto";

/** 带状态码的上游错误：搜索重试要靠它区分 5xx（值得重试）与 4xx（重试无用）。 */
class TgtoHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`tgto upstream HTTP ${status}`);
    this.name = "TgtoHttpError";
    this.status = status;
  }
}

export class TgtoClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchJson: TgtoFetchJson;
  private readonly timeoutMs: number;
  private readonly copyLinkTimeoutMs: number;

  constructor(options: TgtoClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token.trim();
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.timeoutMs = options.timeoutMs ?? TGTO_DEFAULT_TIMEOUT_MS;
    this.copyLinkTimeoutMs = options.copyLinkTimeoutMs ?? TGTO_DEFAULT_COPY_LINK_TIMEOUT_MS;
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (!this.baseUrl || !this.token) {
      throw new Error("TGTO_NOT_CONFIGURED");
    }
    return this.fetchJson(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs,
    });
  }

  /** 搜索是只读幂等的：超时/连接失败/5xx 时立刻重试一次，避免一次冷启动抖动
   *  就把整源标成 unreachable（见 TGTO_DEFAULT_TIMEOUT_MS 的注释）。 */
  async searchResources(body: Record<string, unknown>): Promise<TgtoSearchData> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TGTO_SEARCH_ATTEMPTS; attempt += 1) {
      try {
        return await this.searchOnce(body);
      } catch (error) {
        lastError = error;
        if (attempt >= TGTO_SEARCH_ATTEMPTS || !isRetryableSearchError(error)) throw error;
      }
    }
    throw lastError;
  }

  private async searchOnce(body: Record<string, unknown>): Promise<TgtoSearchData> {
    const raw = await this.post("/api/media/resources/search", body);
    const envelope = asRecord(raw);
    if (envelope["success"] !== true) {
      throw new Error(`TGTO_SEARCH_FAILED: ${stringValue(envelope["error"]) || "upstream rejected the search"}`);
    }
    const data = asRecord(envelope["data"]);
    return { items: asArray(data["items"]) as TgtoSearchItem[], errors: asArray(data["errors"]) };
  }

  /** 换取分享链接。**会按条目 unlock_points 扣积分**，只由转存路径调用。 */
  async copyLink(input: TgtoCandidateRef): Promise<TgtoCopyLinkResult> {
    const raw = await this.post(
      "/api/media/resources/copy-link",
      { provider: input.provider, slug: input.slug, source: input.source },
      this.copyLinkTimeoutMs,
    );
    const envelope = asRecord(raw);
    const data = asRecord(envelope["data"]);
    const url = stringValue(data["share_url"]);
    if (envelope["success"] !== true || !url) {
      const message = stringValue(data["message"]) || stringValue(envelope["error"]) || "copy-link returned no share url";
      throw new Error(`TGTO_COPY_LINK_FAILED: ${message}`);
    }
    return {
      url,
      password: passwordOf(data, url),
      points: numberValue(data["points"]),
      alreadyOwned: data["already_owned"] === true,
    };
  }
}

export interface TgtoResourceProviderOptions {
  client: TgtoClient;
  /** 资源来源（re0/guanying/seedhub）。默认 re0+观影；SeedHub 单次 30s+，不建议默认开。 */
  sources?: readonly string[];
  /** 只保留 unlock_points ≤ 该值的条目。默认 0 = 只收已解锁/免费资源，绝不自动扣分。 */
  maxPoints?: number;
  /** 与 PanSou/Haisou 同义；Tgto 只能转 115，因此不含 115 时整源跳过。 */
  allowedTypes?: readonly ResourceType[];
  now?: () => string;
}

export class TgtoResourceProvider implements ResourceProvider, ResourceCandidateLinkResolver {
  private readonly client: TgtoClient;
  private readonly resolver: TgtoShareLinkResolver;
  private readonly sources: readonly string[];
  private readonly maxPoints: number;
  private readonly allowedTypes: readonly ResourceType[] | undefined;
  private readonly now: () => string;
  /** Same-run reuse keyed by media identity. Tgto resolves a search to a work via
   *  tmdb_id, so re-keywording for the same work returns the same items and only
   *  burns an upstream call (and its per-call accounting). The instance lives for
   *  one run (the worker rebuilds the provider per claimed run), so a cached
   *  result can never leak into a later run. */
  private readonly searchCache = new Map<string, TgtoSearchData>();

  constructor(options: TgtoResourceProviderOptions) {
    this.client = options.client;
    this.resolver = new TgtoShareLinkResolver(options.client);
    this.sources = options.sources && options.sources.length > 0 ? options.sources : TGTO_DEFAULT_SOURCES;
    this.maxPoints = options.maxPoints ?? TGTO_DEFAULT_MAX_POINTS;
    this.allowedTypes = options.allowedTypes;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async search(input: ResourceSearchInput): Promise<ResourceSnapshot> {
    const keyword = input.keyword.trim();
    const snapshotId = scopedId("tgto", keyword, input.workflowRunId);

    if (this.allowedTypes && !this.allowedTypes.includes("115")) {
      return emptySnapshot(snapshotId, keyword, this.now());
    }
    if (!keyword) {
      return emptySnapshot(snapshotId, keyword, this.now());
    }

    const context = input.context;
    // Tgto 的 title 是要搜的字面词，不是作品规范名：它不会拿 aliases 兜底
    // （实测传 aliases 仍只按 title 搜，响应里连别名都不回）。所以必须用 agent
    // 这一次的关键词，否则「再见朋友」这类别名搜索永远到不了 Tgto。
    //
    // 也不要传 season：re0 的整包/综艺候选经常没有季集标记，传单个季会把唯一
    // 的结果滤成 0（实测《后会友期》season:1=0，不传=1）。季节匹配交给 agent：
    // 候选标题里带 SxxEyy，选片阶段再对齐。
    //
    // 不传 provider：它只是目标端过滤，本地已经按 supported_targets 只收 115
    // （见 toCandidateOutcome），多一层过滤只会误伤；copy-link 时仍用
    // targetProvider:"115"。网页端搜索也是传空。
    const body: Record<string, unknown> = {
      title: keyword,
      sources: [...this.sources],
      ...(context?.tmdbId ? { tmdb_id: context.tmdbId } : {}),
      ...(context?.mediaType ? { media_type: context.mediaType } : {}),
      ...(context?.year ? { year: context.year } : {}),
    };

    // A search for a known work is answered by the work, not the keyword: once
    // this run has asked Tgto about it, another keyword would return the same
    // items. Re-building a fresh snapshot from the cached response keeps every
    // search a distinct, snapshot-bound trace entry.
    const cacheKey = mediaIdentityKey(context);
    const cached = cacheKey === null ? undefined : this.searchCache.get(cacheKey);
    let data: TgtoSearchData;
    let reused = false;
    if (cached) {
      data = cached;
      reused = true;
    } else {
      try {
        data = await this.client.searchResources(body);
      } catch (error) {
        return emptySnapshot(snapshotId, keyword, this.now(), classifySourceFailure(error));
      }
      // Only an authoritative answer is reusable: a degraded response means an
      // upstream sub-source failed, and a later keyword may reach it healthy.
      if (cacheKey !== null && data.errors.length === 0) this.searchCache.set(cacheKey, data);
    }

    const candidates: ResourceCandidate[] = [];
    // Explain a 0-result search: raw items the target/points/link guards removed
    // never reach the snapshot, so without this they look like "upstream had none".
    const filtered = new Map<string, number>();
    for (const raw of data.items) {
      const outcome = this.toCandidateOutcome(raw, snapshotId, candidates.length);
      if ("candidate" in outcome) {
        candidates.push(outcome.candidate);
      } else {
        filtered.set(outcome.reason, (filtered.get(outcome.reason) ?? 0) + 1);
      }
    }
    const status: SourceStatus =
      candidates.length === 0 && data.errors.length > 0 ? "degraded" : "healthy";
    const filteredStats = [...filtered].map(([reason, count]) => ({ reason, count }));

    return {
      id: snapshotId,
      provider: "tgto",
      keyword,
      candidates,
      createdAt: this.now(),
      sourceStats: [
        {
          name: "tgto",
          status,
          candidates: candidates.length,
          ...(reused ? { cached: true } : {}),
          ...(filteredStats.length > 0 ? { filtered: filteredStats } : {}),
          ...(status === "degraded" ? { error: summarizeSearchErrors(data.errors) } : {}),
        },
      ],
      // An empty result WITH upstream errors is not an authoritative "no such
      // resource" — say degraded so the UI/agent knows the source wobbled.
      sourceHealth: mergeSourceHealth([{ status, source: "tgto" }]),
    };
  }

  /** See ResourceCandidateLinkResolver — paid copy-link only happens here. */
  async resolveCandidateLink(candidate: ResourceCandidate): Promise<ResourceCandidate> {
    return this.resolver.resolve(candidate);
  }

  private toCandidateOutcome(
    item: TgtoSearchItem,
    snapshotId: string,
    index: number,
  ): { candidate: ResourceCandidate } | { reason: string } {
    if (stringValue(item.validate_status) === "invalid") return { reason: "invalid" };

    const targets = asArray(item.supported_targets).map((t) => stringValue(t));
    if (targets.length > 0 && !targets.includes("115")) return { reason: "target_not_115" };

    // points_known=false 时无法判断成本 → 当作需要积分，宁可不收也不盲扣。
    const pointsKnown = item.points_known === true;
    const unlockPoints = numberValue(item.unlock_points);
    if (!pointsKnown) return { reason: "points_unknown" };
    if (unlockPoints > this.maxPoints) return { reason: "points_over_cap" };

    const linkType = stringValue(item.link_type).toLowerCase();
    const source = stringValue(item.source);
    const shareUrl = stringValue(item.share_url);
    const slug = stringValue(item.slug);
    const directMagnet = linkType === "magnet" && /^magnet:/i.test(shareUrl);

    if (!directMagnet) {
      // 分享链要 slug+source 才能换链；缺任何一个这条候选都不可转。
      if (linkType !== "share" || !slug || !source) return { reason: "no_share_ref" };
    }

    // Upstream's free-text fields say what the title/spec cannot: coverage claims
    // ("全40集"), subtitle language, release group. They go to BOTH the agent and
    // Jev as one deduped note, and stay verbatim in the payload for later audits.
    const note = candidateNote(item);
    const rawTitle = stringValue(item.title);
    const title = candidateTitle(item, note);
    if (!title) return { reason: "no_title" };

    const ref: TgtoCandidateRef | undefined = directMagnet
      ? undefined
      : { slug, source, provider: stringValue(item.provider) || "115" };
    const datetime = stringValue(item.published_at).slice(0, 10);
    const remark = stringValue(item.remark).trim();
    const messageText = stringValue(item.message_text).trim();
    const messageBody = stringValue(item.message_body).trim();

    return {
      candidate: {
        id: `${snapshotId}:${index}`,
        snapshotId,
        index,
        title,
        type: directMagnet ? "magnet" : "115",
        source: "tgto",
        providerPayload: {
          title: rawTitle || title,
          // A title-less row falls back to the note AS its title — repeating it as
          // a note would only make the agent read the same line twice.
          ...(rawTitle && note ? { note } : {}),
          ...(remark ? { remark } : {}),
          ...(messageText ? { messageText } : {}),
          ...(messageBody ? { messageBody } : {}),
          // 磁力直接带链接；分享链故意留空，转存时由 resolver 调 copy-link。
          ...(directMagnet ? { url: shareUrl, ...(infoHashOf(shareUrl) ? { infoHash: infoHashOf(shareUrl) } : {}) } : {}),
          ...(ref ? { [TGTO_PAYLOAD_KEY]: ref, targetProvider: "115" } : {}),
          sizeBytes: parseSizeToBytes(stringValue(item.size)),
          resolution: stringValue(item.resolution),
          unlockPoints,
          ...(datetime.length === 10 ? { datetime } : {}),
        },
      },
    };
  }
}

/**
 * 把「搜索时还没有链接」的 Tgto 分享候选，在真正转存的那一刻换成 115 分享链。
 * copy-link 是唯一会扣积分的调用点；解锁过的条目之后 already_owned=true、points=0。
 */
export class TgtoShareLinkResolver {
  private readonly client: TgtoClient;

  constructor(client: TgtoClient) {
    this.client = client;
  }

  /** 非 Tgto 候选原样返回；Tgto 分享候选返回带 url/password 的新候选。 */
  async resolve(candidate: ResourceCandidate): Promise<ResourceCandidate> {
    const existing = stringValue(candidate.providerPayload?.["url"]);
    if (existing) return candidate;
    const ref = tgtoRefOf(candidate);
    if (!ref) return candidate;

    const link = await this.client.copyLink(ref);
    return {
      ...candidate,
      providerPayload: {
        ...candidate.providerPayload,
        url: link.url,
        ...(link.password ? { password: link.password } : {}),
        tgtoPointsSpent: link.points,
      },
    };
  }
}

export function tgtoRefOf(candidate: ResourceCandidate): TgtoCandidateRef | null {
  const raw = candidate.providerPayload?.[TGTO_PAYLOAD_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const ref = raw as Record<string, unknown>;
  const slug = stringValue(ref["slug"]);
  const source = stringValue(ref["source"]);
  const provider = stringValue(ref["provider"]) || "115";
  if (!slug || !source) return null;
  return { slug, source, provider };
}

/** Structured episode numbers are deliberately NOT part of a candidate: upstream
 *  regex-extracts them and gets them wrong often enough to mislead selection. The
 *  free-text note is the only coverage statement the agent/Jev see. */
function candidateTitle(item: TgtoSearchItem, note: string): string {
  const base = stringValue(item.title) || note;
  const spec = stringValue(item.resource_specification);
  const subtitles = subtitleLabel(item);
  const size = stringValue(item.size);
  return [base, spec, subtitles, size].filter((part) => part.length > 0).join(" · ");
}

export const TGTO_NOTE_MAX_CHARS = 200;

/** One deduped note out of the three free-text fields the upstream mirrors into
 *  each other. Whitespace is collapsed so the note stays one line; identical
 *  (case-insensitive) fragments keep only their first, original spelling. */
export function candidateNote(item: TgtoSearchItem): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [item.remark, item.message_text, item.message_body]) {
    const text = stringValue(raw).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }
  const note = parts.join("；");
  return note.length <= TGTO_NOTE_MAX_CHARS ? note : `${note.slice(0, TGTO_NOTE_MAX_CHARS)}…`;
}

/** 「字幕:简中/繁中(内封)」——质量判断之外，中字语言与内封/外挂也是选片依据。 */
function subtitleLabel(item: TgtoSearchItem): string {
  const languages = asArray(item.subtitle_languages).map((v) => stringValue(v)).filter((v) => v.length > 0);
  const types = asArray(item.subtitle_types).map((v) => stringValue(v)).filter((v) => v.length > 0);
  if (languages.length === 0 && types.length === 0) return "";
  const language = languages.length > 0 ? languages.join("/") : "字幕";
  return `字幕:${language}${types.length > 0 ? `(${types.join("/")})` : ""}`;
}

/** "81.10GB" / "896.57M" / "4.39G" → bytes. Unknown shape → 0 (the V2 view treats
 *  a non-positive size as absent). */
export function parseSizeToBytes(raw: string): number {
  const match = /^\s*([\d.]+)\s*([KMGT]?)i?B?\s*$/i.exec(raw);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const unit = (match[2] ?? "").toUpperCase();
  const factor = unit === "T" ? 1024 ** 4 : unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return Math.round(value * factor);
}

function passwordOf(data: Record<string, unknown>, url: string): string {
  const declared = stringValue(data["password"]);
  if (declared) return declared;
  try {
    return new URL(url).searchParams.get("password") ?? "";
  } catch {
    return "";
  }
}

function infoHashOf(magnet: string): string {
  const match = /urn:btih:([0-9a-z]+)/i.exec(magnet);
  return match?.[1] ?? "";
}

function emptySnapshot(
  id: string,
  keyword: string,
  createdAt: string,
  health?: SourceStatus,
): ResourceSnapshot {
  const snapshot: ResourceSnapshot = { id, provider: "tgto", keyword, candidates: [], createdAt };
  if (health) snapshot.sourceHealth = mergeSourceHealth([{ status: health, source: "tgto" }]);
  return snapshot;
}

/** The key a search can be reused under, or null when the run has no media
 *  identity. Without a tmdb id the keyword IS the query, so two keywords may
 *  genuinely recall different items and must each hit the source. */
function mediaIdentityKey(context: ResourceSearchInput["context"]): string | null {
  const id = context?.tmdbId;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return null;
  return `${id}|${context?.mediaType ?? ""}`;
}

function scopedId(provider: string, keyword: string, workflowRunId?: string): string {
  const hash = createHash("sha256").update(`${provider}:${keyword}`).digest("hex").slice(0, 16);
  return workflowRunId ? `${workflowRunId}:${hash}` : `${provider}-${hash}`;
}

async function defaultFetchJson(
  url: string,
  init: {
    method: "POST" | "GET";
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(init.timeoutMs ?? TGTO_DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new TgtoHttpError(response.status);
  }
  return response.json();
}

/** 只有「基础设施暂时没答」才值得重试：超时、连接类错误、5xx。
 *  4xx 与上游明确拒绝（success=false）重试也不会变，反而放大延迟。 */
function isRetryableSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error instanceof TgtoHttpError) return error.status >= 500;
  return hasRecognisedUnreachableCode(error);
}

/** Tgto answers 200 even when some of its internal sources fail; carry those
 *  errors into the trace so \"degraded\" is not a dead end. */
function summarizeSearchErrors(errors: readonly unknown[]): string {
  const parts = errors
    .slice(0, 3)
    .map((error) => (typeof error === "string" ? error : (JSON.stringify(error) ?? String(error))))
    .filter((part) => part.length > 0);
  const summary = `${errors.length} 个上游源报错${parts.length > 0 ? `：${parts.join("；")}` : ""}`;
  return summary.length <= 160 ? summary : `${summary.slice(0, 159)}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
