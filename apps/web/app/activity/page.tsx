import { Suspense } from "react";
import { AppSidebar } from "../../components/app-sidebar";
import { ActivityFeed } from "../../components/activity-feed";
import { GitHubNameplate } from "../../components/github-nameplate";
import { resolveGlobalWorkspace } from "../../lib/workflow-runtime";

// The feed MUST live in the page's static shell: a client component rendered
// inside a streamed dynamic RSC hole (the async surface below) does not hydrate,
// which silently freezes its live poll and leaves every list at its initial
// empty state. Only the drive-dependent sidebar needs the DB read, so it alone
// sits behind Suspense; the feed reads `?w` client-side.
export default function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <div className="app-shell">
      <Suspense fallback={<AppSidebar active="activity" />}>
        <ActivitySidebar searchParams={searchParams} />
      </Suspense>
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>活动</h1>
            <p>点了获取之后，资源在这里逐个被处理 —— 看得见 agent 正在干什么</p>
          </div>
        </div>
        <ActivityFeed />
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function ActivitySidebar({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <AppSidebar
      active="activity"
      basePath={workspace.basePath}
      activeStorageId={workspace.activeStorageId}
    />
  );
}
