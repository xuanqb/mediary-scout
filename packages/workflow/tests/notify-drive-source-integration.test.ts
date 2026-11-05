import { describe, expect, it, vi } from "vitest";
import {
  buildPushMessage,
  resolveDriveSourceLabels,
  sendWeComText,
  type NotificationReport,
  type WeComFetch,
} from "../src/index.js";
import { formatDailyDigestPushText } from "../src/notification-report.js";

// End-to-end through the REAL render + WeCom wire: a fake fetch captures the
// actual text content. Proves "gate → resolve → render → deliver" composes
// (unit-green ≠ the push actually carried the source).

const report: NotificationReport = {
  titleName: "阿甘正传",
  seasonLabel: null,
  status: "acquired",
  lines: ["已获取"],
  newlyObtained: [],
  realMissing: [],
  year: 1994,
};
const drivesTwo = [
  { id: "cs_a", provider: "pan115", label: null },
  { id: "cs_quark_x", provider: "quark", label: null },
];

function notification(id: string, report?: NotificationReport) {
  return {
    id,
    workflowRunId: `run_${id}`,
    kind: "acquire",
    title: "t",
    body: "b",
    createdAt: "2026-06-20T00:00:00Z",
    ...(report ? { report } : {}),
  };
}

function captureFetch(): { fetchImpl: WeComFetch; contents: string[] } {
  const contents: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { msgtype: string; text: { content: string } };
    expect(payload.msgtype).toBe("text");
    contents.push(payload.text.content);
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
  }) as unknown as WeComFetch;
  return { fetchImpl, contents };
}

describe("notification drive-source: end-to-end through the WeCom wire", () => {
  it("≥2 drives → the delivered message carries the correct source drive", async () => {
    const n = notification("n1", report);
    const labels = resolveDriveSourceLabels([{ connectedStorageId: "cs_quark_x", notification: n }], drivesTwo);
    const { fetchImpl, contents } = captureFetch();
    await sendWeComText({
      webhookUrl: "https://q/send?key=K",
      message: buildPushMessage(n, { sourceLabel: labels.get("n1")! }),
      fetchImpl,
    });
    expect(contents[0]).toContain("来源网盘：夸克网盘");
  });

  it("1 drive → the delivered message has NO source tag (gate)", async () => {
    const n = notification("n1", report);
    const labels = resolveDriveSourceLabels([{ connectedStorageId: "cs_a", notification: n }], [drivesTwo[0]!]);
    const sourceLabel = labels.get("n1");
    const { fetchImpl, contents } = captureFetch();
    await sendWeComText({
      webhookUrl: "https://q/send?key=K",
      message: buildPushMessage(n, sourceLabel ? { sourceLabel } : undefined),
      fetchImpl,
    });
    expect(contents[0]).not.toContain("来源网盘");
  });

  it("digest: each show line carries its source drive when ≥2 drives, and omits no_coverage shows", async () => {
    const sched = {
      ...notification("d1"),
      kind: "episodes_restored",
      trigger: "scheduled" as const,
      report: {
        ...report,
        titleName: "斗破苍穹",
        seasonLabel: "第 5 季",
        status: "airing" as const,
        lines: ["已获取至最新第 6 集"],
        newlyObtained: ["S05E06"],
        realMissing: [],
      },
    };
    const noCov = {
      ...notification("d2"),
      kind: "no_coverage",
      trigger: "scheduled" as const,
      report: {
        ...report,
        titleName: "731部队",
        seasonLabel: "第 1 季",
        status: "no_coverage" as const,
        lines: ["暂未找到可用资源 · 将持续尝试"],
        newlyObtained: [],
        realMissing: ["E01", "E02"],
      },
    };
    const labels = resolveDriveSourceLabels(
      [
        { connectedStorageId: "cs_a", notification: sched },
        { connectedStorageId: "cs_quark_x", notification: noCov },
      ],
      drivesTwo,
    );
    const digest = {
      id: "dg",
      workflowRunId: "run_dg",
      kind: "daily_digest",
      title: "每日巡检",
      body: formatDailyDigestPushText([sched as never, noCov as never], { sourceLabelById: labels }),
      createdAt: "2026-06-20T00:00:00Z",
    };
    const { fetchImpl, contents } = captureFetch();
    await sendWeComText({
      webhookUrl: "https://q/send?key=K",
      message: buildPushMessage(digest as never),
      fetchImpl,
    });
    expect(contents[0]).toContain("来自115 网盘");
    expect(contents[0]).not.toContain("来自夸克网盘");
  });
});
