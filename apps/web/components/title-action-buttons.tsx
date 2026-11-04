"use client";

import { Check, DownloadCloud, Layers, LoaderCircle, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import {
  requestRemainingAction,
  requestSeasonAction,
  retrySeasonAction,
  type RequestTrackingActionResult,
  type RetrySeasonActionResult,
} from "../app/actions";
import { runAction } from "../lib/run-action";
import { useAcquisitionLock } from "./acquisition-lock";
import { AcquireResultNotice, isLockedResult } from "./request-state";
import { isDemoModeClient } from "../lib/demo-mode";
import { DemoAcquirePlayback } from "./demo-acquire-playback";
import type { DemoAcquisitionEntry } from "../lib/demo-session";
import { useDemoAcquiredTmdbIds } from "../lib/use-demo-session";

export function RequestSeasonButton({
  tmdbId,
  seasonNumber,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  seasonNumber: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = `season-${seasonNumber}`;
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <>
      <button
        className="season-request-button"
        type="button"
        title={
          othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? `获取第 ${seasonNumber} 季`
        }
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          lock?.lock(scope);
          startTransition(async () => {
            try {
              const r = await runAction(
                () => requestSeasonAction({ tmdbId, seasonNumber, storageId }),
                (msg) => {
                  setResult({ status: "unsupported", message: msg });
                  // 必须 refresh:lock.acquiring 是前端 state,靠重挂载重置。
                  // 失败不刷新,锁永远卡住,兄弟按钮全禁用(Copilot round 1)。
                  router.refresh();
                },
              );
              if (!r.ok) return;
              setResult(r.value);
              router.refresh();
            } finally {
              // Never leave the spinner up after the action settles — a queued run
              // is tracked by server truth, not by this local double-click guard.
              lock?.lock(null);
            }
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={13} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={13} aria-hidden />
        ) : (
          <DownloadCloud size={13} aria-hidden />
        )}
        {inFlight ? "获取中" : isLocked ? "已请求" : "获取本季"}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

export function RequestRemainingButton({
  tmdbId,
  label,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  label: string;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = "remaining";
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <>
      <button
        className="primary-button"
        type="button"
        title={othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? label}
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          lock?.lock(scope);
          startTransition(async () => {
            try {
              const r = await runAction(
                () => requestRemainingAction({ tmdbId, storageId }),
                (msg) => {
                  setResult({ status: "unsupported", message: msg });
                  // 同上一处:失败必须 refresh 清锁,否则 sibling 全禁用。
                  router.refresh();
                },
              );
              if (!r.ok) return;
              setResult(r.value);
              router.refresh();
            } finally {
              lock?.lock(null);
            }
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={14} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={14} aria-hidden />
        ) : (
          <Layers size={14} aria-hidden />
        )}
        {inFlight ? "获取中" : isLocked ? "已请求" : label}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

/**
 * 「重试」：对已追踪、仍在更新的这一季跑一次与每日巡检同款的补缺流程。
 * 它同步等待整季跑完（和设置页「立即巡检」一致），所以按钮在这段时间一直
 * 显示「重试中」；结束后刷新页面，进度条/徽章就是真实结果。
 *
 * 这个按钮位于 <summary> 里，必须 preventDefault + stopPropagation，
 * 否则点它会顺手展开/收起整季的集列表。
 */
export function RetrySeasonButton({
  tmdbId,
  seasonNumber,
  storageId,
  titleAcquiring = false,
}: {
  tmdbId: number;
  seasonNumber: number;
  /** Tree model: the active workspace drive — the retry runs on this drive. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RetrySeasonActionResult | null>(null);
  const scope = `retry-${seasonNumber}`;
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();

  if (demo) return null;

  const note =
    result === null || result.status === "completed"
      ? null
      : result.status === "partial"
        ? "仍有缺集"
        : result.status === "running"
          ? "运行中"
          : result.status === "failed"
            ? "失败"
            : result.status === "not_active"
              ? "已完结"
              : result.status === "not_tracked"
                ? "未追踪"
                : "不可用";

  return (
    <span className="season-retry">
      <button
        className="season-request-button"
        type="button"
        title={
          othersAcquiring && !inFlight
            ? "该剧正在获取中，请稍候"
            : result?.message ?? `重试第 ${seasonNumber} 季（只补缺集）`
        }
        disabled={isPending || othersAcquiring}
        onClick={(event) => {
          // Inside <summary>: never toggle the episode list when retrying.
          event.preventDefault();
          event.stopPropagation();
          lock?.lock(scope);
          startTransition(async () => {
            try {
              const r = await runAction(
                () => retrySeasonAction({ tmdbId, seasonNumber, storageId }),
                (msg) => {
                  setResult({ status: "unsupported", message: msg });
                  router.refresh();
                },
              );
              if (!r.ok) return;
              setResult(r.value);
              router.refresh();
            } finally {
              lock?.lock(null);
            }
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={13} className="spin" aria-hidden />
        ) : (
          <RotateCcw size={13} aria-hidden />
        )}
        {inFlight ? "重试中" : "重试"}
      </button>
      {note ? (
        <span className="season-retry-note" title={result?.message}>
          {note}
        </span>
      ) : null}
    </span>
  );
}
