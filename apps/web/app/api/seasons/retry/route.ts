import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { retrySeasonNow } from "../../../../lib/season-retry";

/**
 * 「重试本季」的 HTTP 入口。以前是 server action，但整个 App Router 会挂在
 * action 的 promise 上直到这一季跑完 —— 期间链接和按钮全部无响应。普通路由
 * 不受这个约束，长请求期间页面仍可正常交互（见 lib/season-retry.ts）。
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as {
    tmdbId?: unknown;
    seasonNumber?: unknown;
    storageId?: unknown;
  };
  const tmdbId = typeof body.tmdbId === "number" ? body.tmdbId : null;
  const seasonNumber = typeof body.seasonNumber === "number" ? body.seasonNumber : null;
  if (tmdbId === null || seasonNumber === null) {
    return NextResponse.json({ error: "tmdbId and seasonNumber required" }, { status: 400 });
  }
  const storageId = typeof body.storageId === "string" ? body.storageId : undefined;
  const result = await retrySeasonNow({ tmdbId, seasonNumber, storageId });
  return NextResponse.json(result);
}
