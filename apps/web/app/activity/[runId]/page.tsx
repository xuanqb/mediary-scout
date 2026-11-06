import { connection } from "next/server";
import { Suspense } from "react";
import { globalNavHref } from "@media-track/workflow/scope";
import { AppSidebar } from "../../../components/app-sidebar";
import { GitHubNameplate } from "../../../components/github-nameplate";
import { RunTraceView } from "../../../components/run-trace";
import { resolveGlobalWorkspace } from "../../../lib/workflow-runtime";

/** `/activity/<runId>` — post-mortem for one acquisition run: what was searched,
 *  which candidates were dropped and why, and what happened at transfer time.
 *  The audit trail is already persisted; this route is the reader it lacked. */
export default function RunTracePage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <Suspense fallback={<TraceShell />}>
      <TraceSurface params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function TraceShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="activity" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function TraceSurface({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  await connection();
  const [{ runId }, { w }] = await Promise.all([params, searchParams]);
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <div className="app-shell">
      <AppSidebar
        active="activity"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
      />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>运行详情</h1>
            <p>这次获取的每一步：搜了什么、候选怎么被筛掉、转存为什么失败</p>
          </div>
        </div>
        <RunTraceView
          runId={runId}
          storageId={workspace.activeStorageId}
          backHref={globalNavHref("/activity", workspace.activeStorageId)}
        />
        <GitHubNameplate />
      </main>
    </div>
  );
}
