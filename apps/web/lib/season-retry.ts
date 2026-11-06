import { revalidatePath } from "next/cache";

export interface RetrySeasonResult {
  status:
    | "completed"
    | "partial"
    | "running"
    | "not_tracked"
    | "not_active"
    | "failed"
    | "unsupported";
  message: string;
}

/**
 * 「重试本季」：只对这一季跑一次每日巡检同款的 type3_monitor（补缺集），
 * 不碰全天 sweep 的认领/汇总。运行时间与一次正常获取相当。
 *
 * 调用方是 API 路由而不是 server action：这条请求可能跑几分钟，而 server action
 * 会让 App Router 一直挂在 action 的 promise 上 —— 期间页面上的链接/按钮全部
 * 没有反应（用户看到的就是「整个页面点不了」）。走普通 fetch 后，请求再长
 * 也不影响客户端交互。
 */
export async function retrySeasonNow(input: {
  tmdbId: number;
  seasonNumber: number;
  // Tree model: REQUIRED (value may be undefined = primary) — the retry must run
  // on the drive whose season row the user is looking at.
  storageId: string | undefined;
}): Promise<RetrySeasonResult> {
  const { getCurrentAccountId, acquireLlmPreflightError } = await import("./workflow-runtime");
  const preflight = await acquireLlmPreflightError(await getCurrentAccountId());
  if (preflight) {
    return { status: "unsupported", message: preflight };
  }
  const { getActiveWorkspaceScope, getWorkflowRepository, runSeasonPatrolNow } = await import(
    "./workflow-runtime"
  );
  const scope = await getActiveWorkspaceScope(input.storageId);
  const states = await getWorkflowRepository().listTrackedSeasonStates(scope);
  const state = states.find(
    (candidate) =>
      candidate.title.tmdbId === input.tmdbId &&
      candidate.title.type !== "movie" &&
      candidate.season.seasonNumber === input.seasonNumber,
  );
  if (!state) {
    return { status: "not_tracked", message: "本季尚未追踪，请先点「获取本季」。" };
  }
  if (state.season.status !== "active") {
    return { status: "not_active", message: "本季已完结，无需重试。" };
  }
  const outcome = await runSeasonPatrolNow({
    trackedSeasonId: state.season.id,
    accountId: state.accountId,
  });
  revalidatePath(`/show/${input.tmdbId}`);
  revalidatePath("/");
  if (outcome === null) {
    return { status: "unsupported", message: "没有可重试的任务。" };
  }
  switch (outcome.status) {
    case "ran":
      return outcome.workflowStatus === "succeeded"
        ? { status: "completed", message: `第 ${input.seasonNumber} 季重试完成。` }
        : {
            status: "partial",
            message: `第 ${input.seasonNumber} 季重试结束，仍有缺集。`,
          };
    case "skipped_active":
      return { status: "running", message: "本季已有任务在运行中。" };
    case "skipped_untracked":
      return { status: "not_tracked", message: "本季已取消追踪。" };
    case "failed":
      return { status: "failed", message: `重试失败：${outcome.errorMessage}` };
  }
}
