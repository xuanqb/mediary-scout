"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Clock3,
  Loader2,
  Search,
} from "lucide-react";
import { tmdbImageUrl } from "../lib/tmdb-image";
import type {
  RunTrace,
  RunTraceCandidate,
  RunTraceDecision,
  RunTraceStep,
  RunTraceTransfer,
} from "../lib/run-trace";

const POLL_MS = 2600;

const RUN_STATUS: Record<string, { label: string; tone: TraceTone }> = {
  queued: { label: "排队中", tone: "muted" },
  running: { label: "获取中", tone: "info" },
  succeeded: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "warn" },
  partial: { label: "部分入库", tone: "warn" },
  no_coverage: { label: "暂无资源", tone: "warn" },
  reserved: { label: "待上映", tone: "muted" },
};

const KIND_LABEL: Record<string, string> = {
  type1_package_init: "整包获取",
  type2_init: "首次获取",
  type3_monitor: "巡检追更",
  movie_init: "电影获取",
  replace_request: "换源",
  staging_recovery: "暂存恢复",
};

const PHASE_LABEL: Record<string, string> = {
  search: "搜索",
  pick: "选片",
  transfer: "转存",
  verify: "校验",
  organize: "整理",
  mark: "标记",
  finalize: "收尾",
};

const MEDIA_TYPE_LABEL: Record<string, string> = {
  tv: "剧集",
  anime: "动漫",
  movie: "电影",
};

type TraceTone = "success" | "warn" | "info" | "muted";

export function RunTraceView({
  runId,
  storageId,
  backHref,
}: {
  runId: string;
  storageId?: string | undefined;
  backHref: string;
}) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const url = `/api/workflows/${encodeURIComponent(runId)}/trace${
      storageId ? `?w=${encodeURIComponent(storageId)}` : ""
    }`;

    const load = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.status === 404) {
          if (alive) setState("missing");
          return;
        }
        if (!res.ok) throw new Error(`trace ${res.status}`);
        const data = (await res.json()) as RunTrace;
        if (!alive) return;
        setTrace(data);
        setState("ready");
        if (data.run.status === "queued" || data.run.status === "running") {
          timer = setTimeout(() => void load(), POLL_MS);
        }
      } catch {
        if (!alive) return;
        setState((current) => (current === "ready" ? current : "error"));
        timer = setTimeout(() => void load(), POLL_MS);
      }
    };

    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, storageId]);

  if (state === "missing") {
    return (
      <div className="trace">
        <BackLink href={backHref} />
        <p className="trace-empty">找不到这次运行，可能已被清理，或不属于当前网盘。</p>
      </div>
    );
  }

  if (state === "error" || (state === "loading" && !trace)) {
    return (
      <div className="trace">
        <BackLink href={backHref} />
        <p className="trace-empty">
          {state === "error" ? "读取运行轨迹失败，正在重试…" : "正在读取运行轨迹…"}
        </p>
      </div>
    );
  }

  if (!trace) return null;

  return <TraceBody trace={trace} backHref={backHref} />;
}

function TraceBody({ trace, backHref }: { trace: RunTrace; backHref: string }) {
  const status = RUN_STATUS[trace.run.status] ?? { label: trace.run.status, tone: "muted" as TraceTone };
  const selectedIds = useMemo(
    () => new Set(trace.decisions.flatMap((decision) => decision.selectedCandidateIds)),
    [trace.decisions],
  );
  const rejectedIds = useMemo(
    () => new Set(trace.decisions.flatMap((decision) => decision.rejectedCandidateIds)),
    [trace.decisions],
  );
  const candidateById = useMemo(
    () => new Map(trace.candidates.map((candidate) => [candidate.id, candidate])),
    [trace.candidates],
  );
  const transferByCandidate = useMemo(() => {
    const map = new Map<string, RunTraceTransfer[]>();
    for (const attempt of trace.transfers) {
      const list = map.get(attempt.candidateId) ?? [];
      list.push(attempt);
      map.set(attempt.candidateId, list);
    }
    return map;
  }, [trace.transfers]);

  const duration = durationText(trace.run.startedAt, trace.run.finishedAt);
  const diagnosis = runDiagnostics(trace);
  const active = trace.run.status === "queued" || trace.run.status === "running";

  return (
    <div className="trace">
      <BackLink href={backHref} />

      <section className="trace-head">
        {trace.title.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="trace-poster" src={tmdbImageUrl(trace.title.posterPath)} alt="" />
        ) : (
          <span className="trace-poster trace-poster-fallback">{trace.title.name.slice(0, 2)}</span>
        )}
        <div className="trace-head-body">
          <div className="trace-title-row">
            <strong className="trace-title">{trace.title.name}</strong>
            <span className={`trace-pill tone-${status.tone}`}>
              {active ? <Loader2 size={11} className="act-spin" aria-hidden /> : null}
              {status.label}
            </span>
            <span className="trace-pill tone-muted">{KIND_LABEL[trace.run.kind] ?? trace.run.kind}</span>
          </div>
          <div className="trace-meta">
            <span>
              {trace.title.year} · {MEDIA_TYPE_LABEL[trace.title.type] ?? trace.title.type} · 第{" "}
              {trace.title.seasonNumber} 季
              {trace.title.startEpisode && trace.title.startEpisode > 1
                ? ` · 从第 ${trace.title.startEpisode} 集起`
                : ""}
            </span>
            <span>
              <Clock3 size={11} aria-hidden /> {hhmmss(trace.run.startedAt)}
              {trace.run.finishedAt ? ` → ${hhmmss(trace.run.finishedAt)}` : " → 进行中"}
              {duration ? ` · 用时 ${duration}` : ""}
            </span>
            <span className="trace-run-id" title="运行 ID">
              {trace.run.id}
            </span>
          </div>
          {active ? (
            <>
              <div className="act-bar trace-bar">
                <div
                  className="act-bar-fill"
                  style={{ width: `${Math.max(3, Math.min(100, trace.run.progress?.percent ?? 3))}%` }}
                />
              </div>
              <div className="trace-activity">
                <Loader2 size={13} className="act-spin" aria-hidden />
                {trace.run.progress?.activity ?? "正在准备…"}
              </div>
            </>
          ) : null}
        </div>
      </section>

      <section className="trace-summary">
        <Chip label="搜索" value={trace.summary.searched} suffix="次" />
        <Chip label="候选" value={trace.summary.candidateCount} suffix="个" />
        <Chip label="选中" value={trace.summary.selectedCount} suffix="个" />
        <Chip label="弃用" value={trace.summary.rejectedCount} suffix="个" />
        <Chip label="预筛丢弃" value={trace.summary.droppedByIdentity} suffix="个" />
        <Chip label="转存成功" value={trace.summary.transferSucceeded} suffix="个" />
        <Chip label="转存失败" value={trace.summary.transferFailed} suffix="个" tone="warn" />
        <Chip label="无缓存副本" value={trace.summary.transferNoChange} suffix="个" />
      </section>

      {diagnosis.length > 0 ? (
        <section className="trace-diagnosis">
          {diagnosis.map((line) => (
            <div className="trace-diagnosis-item" key={line}>
              <AlertTriangle size={14} aria-hidden />
              <span>{line}</span>
            </div>
          ))}
        </section>
      ) : trace.run.status === "succeeded" ? (
        <section className="trace-diagnosis is-ok">
          <div className="trace-diagnosis-item">
            <CheckCircle2 size={14} aria-hidden />
            <span>这轮没有发现异常，候选已正常转存。</span>
          </div>
        </section>
      ) : null}

      <TraceSection title="时间线" count={trace.steps.length}>
        {trace.steps.length === 0 ? (
          <p className="trace-empty">这次运行没有留下工具调用轨迹（旧版本运行，或尚未进入 agent）。</p>
        ) : (
          <div className="trace-steps">
            {trace.steps.map((step) => (
              <StepRow step={step} key={step.ordinal} />
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="搜索与候选" count={trace.searches.length}>
        {trace.searches.length === 0 ? (
          <p className="trace-empty">没有搜索快照。</p>
        ) : (
          <div className="trace-cards">
            {trace.searches.map((search) => {
              const candidates = search.candidateIds
                .map((id) => candidateById.get(id))
                .filter((candidate): candidate is RunTraceCandidate => candidate !== undefined);
              return (
                <div className="trace-card" key={search.id}>
                  <div className="trace-card-head">
                    <Search size={13} aria-hidden />
                    <strong className="trace-keyword">{search.keyword}</strong>
                    <span className="trace-sub">
                      {search.provider} · {hhmmss(search.createdAt)} · {candidates.length} 个候选
                    </span>
                    {search.sourceHealth && search.sourceHealth.status !== "healthy" ? (
                      <span className="trace-pill tone-warn">
                        {healthLabel(search.sourceHealth.status)}
                        {search.sourceHealth.unhealthySources.length > 0
                          ? `：${search.sourceHealth.unhealthySources.join("、")}`
                          : ""}
                      </span>
                    ) : null}
                    {search.prefilter ? <PrefilterPill prefilter={search.prefilter} /> : null}
                  </div>
                  {candidates.length === 0 ? (
                    <p className="trace-empty">这个关键词没有返回候选。</p>
                  ) : (
                    <div className="trace-peers">
                      {candidates.map((candidate) => (
                        <CandidateRow
                          candidate={candidate}
                          prefilter={search.prefilter}
                          selected={selectedIds.has(candidate.id)}
                          rejected={rejectedIds.has(candidate.id)}
                          transfers={transferByCandidate.get(candidate.id) ?? []}
                          key={candidate.id}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </TraceSection>

      <TraceSection title="选片决策" count={trace.decisions.length}>
        {trace.decisions.length === 0 ? (
          <p className="trace-empty">没有留下选片决策。</p>
        ) : (
          <div className="trace-cards">
            {trace.decisions.map((decision) => (
              <DecisionCard
                decision={decision}
                candidateById={candidateById}
                key={decision.ordinal}
              />
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="转存记录" count={trace.transfers.length}>
        {trace.transfers.length === 0 ? (
          <p className="trace-empty">这次运行没有尝试转存。</p>
        ) : (
          <div className="trace-cards">
            {trace.transfers.map((attempt) => (
              <TransferCard
                attempt={attempt}
                candidate={candidateById.get(attempt.candidateId)}
                key={`${attempt.ordinal}-${attempt.candidateId}`}
              />
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="审计事件" count={trace.audit.length}>
        {trace.audit.length === 0 ? (
          <p className="trace-empty">没有审计事件。</p>
        ) : (
          <div className="trace-cards">
            {trace.audit.map((event, index) => (
              <div className="trace-card trace-audit" key={`${event.type}-${index}`}>
                <div className="trace-card-head">
                  <span className="trace-pill tone-muted">{event.type}</span>
                  <span className="trace-audit-message">{event.message}</span>
                </div>
                {event.data ? <ArgsDetails args={event.data} /> : null}
              </div>
            ))}
          </div>
        )}
      </TraceSection>

      <TraceSection title="通知" count={trace.notifications.length}>
        {trace.notifications.length === 0 ? (
          <p className="trace-empty">这次运行没有发出通知。</p>
        ) : (
          <div className="trace-cards">
            {trace.notifications.map((notification, index) => (
              <div className="trace-card" key={`${notification.kind}-${index}`}>
                <div className="trace-card-head">
                  <span className="trace-pill tone-muted">{notification.kind}</span>
                  <strong>{notification.title}</strong>
                  <span className="trace-sub">{hhmmss(notification.createdAt)}</span>
                </div>
                <p className="trace-notification-body">{notification.body}</p>
              </div>
            ))}
          </div>
        )}
      </TraceSection>
    </div>
  );
}

function BackLink({ href }: { href: string }) {
  return (
    <Link className="trace-back" href={href}>
      <ArrowLeft size={14} aria-hidden /> 返回活动
    </Link>
  );
}

function Chip({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: number;
  suffix: string;
  tone?: TraceTone;
}) {
  return (
    <span className={`trace-chip${tone ? ` tone-${tone}` : ""}`}>
      {label}
      <strong>{value}</strong>
      {suffix}
    </span>
  );
}

function TraceSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="trace-section">
      <div className="trace-section-head">
        {title} · {count}
      </div>
      {children}
    </section>
  );
}

function StepRow({ step }: { step: RunTraceStep }) {
  return (
    <div className="trace-step">
      <span className="trace-step-ord">{step.ordinal + 1}</span>
      <div className="trace-step-main">
        <div className="trace-step-top">
          <span className="trace-pill tone-info">{PHASE_LABEL[step.phase] ?? step.phase}</span>
          <span className="trace-step-activity">{step.activity}</span>
          <span className="trace-step-tool">{step.toolName}</span>
          <span className="trace-step-time">{hhmmss(step.at)}</span>
          {step.apiCalls !== undefined ? (
            <span className="trace-sub">API {step.apiCalls}</span>
          ) : null}
        </div>
        <ArgsDetails args={step.args} />
      </div>
    </div>
  );
}

function ArgsDetails({ args }: { args: Record<string, unknown> }) {
  if (Object.keys(args).length === 0) return null;
  return (
    <details className="trace-args">
      <summary>
        <ChevronDown size={11} aria-hidden /> 参数
      </summary>
      <pre>{JSON.stringify(args, null, 2)}</pre>
    </details>
  );
}

function PrefilterPill({ prefilter }: { prefilter: NonNullable<RunTrace["searches"][number]["prefilter"]> }) {
  const dropped = prefilter.dropped.length + (prefilter.nsfwDropped?.length ?? 0);
  const tone: TraceTone = prefilter.status === "failed" ? "warn" : "muted";
  return (
    <span className={`trace-pill tone-${tone}`}>
      Jev {prefilter.status === "applied" ? "已筛选" : prefilter.status === "skipped" ? "跳过" : "失败回落"}
      {prefilter.reason ? `：${prefilter.reason}` : ""}
      {dropped > 0 ? ` · 丢弃 ${dropped}` : ""}
    </span>
  );
}

function CandidateRow({
  candidate,
  prefilter,
  selected,
  rejected,
  transfers,
}: {
  candidate: RunTraceCandidate;
  prefilter: NonNullable<RunTrace["searches"][number]["prefilter"]> | null;
  selected: boolean;
  rejected: boolean;
  transfers: RunTraceTransfer[];
}) {
  const score = prefilter?.scores[candidate.id];
  const dropped = prefilter?.dropped.some((entry) => entry.id === candidate.id) ?? false;
  const nsfwDropped = prefilter?.nsfwDropped?.some((entry) => entry.id === candidate.id) ?? false;
  const floored = prefilter?.floored?.some((entry) => entry.id === candidate.id) ?? false;
  const succeeded = transfers.some((attempt) => attempt.status === "succeeded");
  const failed = transfers.some((attempt) => attempt.status === "failed");
  const size = formatSize(candidate.sizeBytes);

  return (
    <div className={`trace-cand${dropped || nsfwDropped ? " is-dropped" : ""}`}>
      <div className="trace-cand-main">
        <div className="trace-cand-title">{candidate.title}</div>
        <div className="trace-cand-meta">
          {[
            candidate.type,
            candidate.source,
            size,
            score !== undefined ? `评分 ${score.toFixed(2)}` : null,
            candidate.targetProvider ? `目标 ${candidate.targetProvider}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="trace-cand-flags">
        {succeeded ? <span className="trace-pill tone-success">已转存</span> : null}
        {!succeeded && failed ? <span className="trace-pill tone-warn">转存失败</span> : null}
        {selected ? <span className={`trace-pill tone-${succeeded || failed ? "muted" : "success"}`}>已选中</span> : null}
        {rejected ? (
          <span className="trace-pill tone-muted">
            <CircleSlash size={10} aria-hidden /> 弃用
          </span>
        ) : null}
        {dropped ? <span className="trace-pill tone-warn">预筛丢弃</span> : null}
        {nsfwDropped ? <span className="trace-pill tone-warn">成人内容</span> : null}
        {floored ? <span className="trace-pill tone-info">结构兜底</span> : null}
      </div>
    </div>
  );
}

function DecisionCard({
  decision,
  candidateById,
}: {
  decision: RunTraceDecision;
  candidateById: Map<string, RunTraceCandidate>;
}) {
  return (
    <div className="trace-card">
      <div className="trace-card-head">
        <span className="trace-pill tone-info">{decision.node}</span>
        <span className="trace-pill tone-muted">置信度 {confidenceLabel(decision.confidence)}</span>
        <span className="trace-reason">{decision.reason}</span>
      </div>
      {decision.selectedCandidateIds.length > 0 ? (
        <div className="trace-decision-block">
          <span className="trace-decision-label">选中</span>
          {decision.selectedCandidateIds.map((id) => (
            <div className="trace-decision-row" key={id}>
              <span>{candidateById.get(id)?.title ?? id}</span>
              <span className="trace-sub">{episodesLabel(decision.episodeMapping[id] ?? [])}</span>
            </div>
          ))}
        </div>
      ) : null}
      {decision.rejectedCandidateIds.length > 0 ? (
        <div className="trace-decision-block">
          <span className="trace-decision-label">弃用</span>
          {decision.rejectedCandidateIds.map((id) => (
            <div className="trace-decision-row is-muted" key={id}>
              <span>{candidateById.get(id)?.title ?? id}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TransferCard({
  attempt,
  candidate,
}: {
  attempt: RunTraceTransfer;
  candidate: RunTraceCandidate | undefined;
}) {
  const tone: TraceTone =
    attempt.status === "succeeded" ? "success" : attempt.status === "failed" ? "warn" : "muted";
  const label =
    attempt.status === "succeeded" ? "成功" : attempt.status === "failed" ? "失败" : "无变化";
  return (
    <div className="trace-card">
      <div className="trace-card-head">
        <span className={`trace-pill tone-${tone}`}>{label}</span>
        <span className="trace-transfer-title">{candidate?.title ?? attempt.candidateId}</span>
        {attempt.fate ? (
          <span className="trace-sub">
            保留 {attempt.fate.kept} · 丢弃 {attempt.fate.thrownAway}
          </span>
        ) : null}
      </div>
      {attempt.providerMessage ? (
        <p className="trace-transfer-message">{attempt.providerMessage}</p>
      ) : null}
      {attempt.materializedNames && attempt.materializedNames.length > 0 ? (
        <p className="trace-sub">落地文件：{attempt.materializedNames.join("、")}</p>
      ) : null}
    </div>
  );
}

/** One-line answers to "why wasn't this saved?" — ordered by pipeline stage, so
 *  the first line names the earliest reason the run could not proceed. */
function runDiagnostics(trace: RunTrace): string[] {
  const out: string[] = [];
  const sources = new Map<string, string>();
  for (const search of trace.searches) {
    for (const source of search.sourceHealth?.unhealthySources ?? []) {
      sources.set(source, search.sourceHealth?.status ?? "unhealthy");
    }
  }
  for (const [source, status] of sources) {
    out.push(
      status === "protocol_error"
        ? `搜索源「${source}」协议错误（地址填错，或对方不是 PanSou 服务），这次“没找到”不成立。`
        : status === "degraded"
          ? `搜索源「${source}」证据不完整（部分源不可用），这次“没找到”不能完全当真。`
          : `搜索源「${source}」不可用（${status}），这次结果可能不完整。`,
    );
  }
  if (trace.searches.length === 0 && trace.run.kind !== "replace_request") {
    out.push("这次运行没有发起资源搜索。");
  }
  if (trace.searches.length > 0 && trace.summary.candidateCount === 0) {
    out.push("搜索已执行，但所有源都没有返回候选。");
  }
  if (trace.summary.droppedByIdentity > 0) {
    out.push(`Jev 预筛丢弃了 ${trace.summary.droppedByIdentity} 个候选，评分见候选行。`);
  }
  if (trace.summary.droppedAsNsfw > 0) {
    out.push(`另有 ${trace.summary.droppedAsNsfw} 个候选因成人内容被丢弃。`);
  }
  if (
    trace.summary.candidateCount > 0 &&
    trace.summary.selectedCount === 0 &&
    trace.transfers.length === 0
  ) {
    out.push("搜到了候选，但没有任何一个被选中——原因见下方“选片决策”。");
  }
  const failureMessages = [
    ...new Set(
      trace.transfers
        .filter((attempt) => attempt.status === "failed" && attempt.providerMessage.trim() !== "")
        .map((attempt) => attempt.providerMessage.trim()),
    ),
  ];
  for (const message of failureMessages) {
    out.push(`转存失败：${message}`);
  }
  if (
    trace.transfers.length > 0 &&
    trace.transfers.every((attempt) => attempt.status === "no_target_change")
  ) {
    out.push("115 返回 no_target_change：网盘里没有可用缓存副本，并不代表链接失效。");
  }
  return out;
}

function healthLabel(status: string): string {
  switch (status) {
    case "degraded":
      return "部分源不可用";
    case "unreachable":
      return "搜索源不可达";
    case "protocol_error":
      return "协议错误";
    default:
      return status;
  }
}

function confidenceLabel(confidence: string): string {
  switch (confidence) {
    case "high":
      return "高";
    case "medium":
      return "中";
    default:
      return "低";
  }
}

function episodesLabel(codes: string[]): string {
  if (codes.length === 0) return "";
  const short = codes
    .map((code) => code.replace(/^S\d+E?/, "E"))
    .filter((code) => code !== "");
  if (short.length === 0) return "";
  return short.length <= 4
    ? short.join("、")
    : `${short[0]}–${short[short.length - 1]}（${short.length} 集）`;
}

function formatSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= TB) return `${(bytes / TB).toFixed(2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes)} B`;
}

const TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function hhmmss(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : TIME.format(date);
}

function durationText(start: string, finish: string | null): string | null {
  if (!finish) return null;
  const ms = Date.parse(finish) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}
