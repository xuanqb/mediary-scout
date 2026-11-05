import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPushMessage,
  driveDisplayName,
  resolveDriveSourceLabels,
  sendPushNotifications,
  sendWeComText,
  splitWeComContent,
  weComMessageParts,
  WECOM_TEXT_MAX_BYTES,
  type NotificationReport,
  type PushMessage,
  type WeComFetch,
} from "../src/index.js";

describe("driveDisplayName", () => {
  it("uses the user-set nickname when present", () => {
    expect(driveDisplayName({ provider: "pan115", label: "我的主盘" })).toBe("我的主盘");
  });
  it("falls back to the brand name when label is empty/blank", () => {
    expect(driveDisplayName({ provider: "pan115", label: null })).toBe("115 网盘");
    expect(driveDisplayName({ provider: "quark", label: "   " })).toBe("夸克网盘");
  });
  it("never throws on an unknown provider (returns the raw provider)", () => {
    expect(driveDisplayName({ provider: "weird", label: null })).toBe("weird");
  });
});

describe("resolveDriveSourceLabels (gate: account drive count ≥ 2)", () => {
  const drivesTwo = [
    { id: "cs_a", provider: "pan115", label: null },
    { id: "cs_quark_x", provider: "quark", label: null },
  ];
  const entries = [
    { connectedStorageId: "cs_quark_x", notification: { id: "n1" } },
    { connectedStorageId: "cs_a", notification: { id: "n2" } },
  ];

  it("≥2 drives → maps each notification id to its source drive name", () => {
    const m = resolveDriveSourceLabels(entries, drivesTwo);
    expect(m.get("n1")).toBe("夸克网盘");
    expect(m.get("n2")).toBe("115 网盘");
  });
  it("<2 drives → empty map (single-drive shows NO source tag at all)", () => {
    const m = resolveDriveSourceLabels(entries, [drivesTwo[0]!]);
    expect(m.size).toBe(0);
  });
  it("omits entries whose drive is null or unknown (legacy/unbound), never throws", () => {
    const m = resolveDriveSourceLabels(
      [
        { connectedStorageId: null, notification: { id: "legacy" } },
        { connectedStorageId: "cs_gone", notification: { id: "unbound" } },
      ],
      drivesTwo,
    );
    expect(m.has("legacy")).toBe(false);
    expect(m.has("unbound")).toBe(false);
  });

  it("omits entries whose report status is no_coverage / failed / retrying so empty runs never blame a single drive (issue #359)", () => {
    const m = resolveDriveSourceLabels(
      [
        { connectedStorageId: "cs_quark_x", notification: { id: "n_nocov", report: { status: "no_coverage" } } },
        { connectedStorageId: "cs_quark_x", notification: { id: "n_fail", report: { status: "failed" } } },
        { connectedStorageId: "cs_quark_x", notification: { id: "n_retry", report: { status: "retrying" } } },
        {
          connectedStorageId: "cs_a",
          notification: { id: "n_ok", report: { status: "partial", driveLabels: ["夸克"] } },
        },
      ],
      drivesTwo,
    );
    expect(m.has("n_nocov")).toBe(false);
    expect(m.has("n_fail")).toBe(false);
    expect(m.has("n_retry")).toBe(false);
    expect(m.get("n_ok")).toBe("夸克");
  });
});

const sampleReport: NotificationReport = {
  titleName: "阿甘正传",
  seasonLabel: null,
  status: "acquired",
  lines: ["已获取"],
  newlyObtained: [],
  realMissing: [],
  year: 1994,
};

function notification(report?: NotificationReport) {
  return {
    id: "n1",
    workflowRunId: "run1",
    kind: "acquire",
    title: "t",
    body: "b",
    createdAt: "2026-06-13T00:00:00.000Z",
    ...(report ? { report } : {}),
  };
}

describe("buildPushMessage", () => {
  it("renders a report with a year title and the source-drive line", () => {
    const m = buildPushMessage(notification(sampleReport), { sourceLabel: "夸克网盘" });
    expect(m.title).toBe("阿甘正传 (1994)");
    expect(m.text).toContain("已获取");
    expect(m.text).toContain("📦 来源网盘：夸克网盘");
  });

  it("omits the source line when no sourceLabel (single-drive)", () => {
    expect(buildPushMessage(notification(sampleReport)).text).not.toContain("来源网盘");
  });

  it("a TV season carries the season label, not the year", () => {
    const m = buildPushMessage(
      notification({ ...sampleReport, seasonLabel: "第 1 季", year: 2026 }),
    );
    expect(m.title).toBe("阿甘正传 第 1 季");
  });

  it("keeps stored title/body for events without a report (digest/test/legacy)", () => {
    expect(buildPushMessage(notification())).toEqual({ title: "t", text: "b" });
  });
});

type RecordedCall = [string, RequestInit];

function weComOk(): WeComFetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 }),
  ) as unknown as WeComFetch;
}

function recordedCalls(fetchImpl: WeComFetch): RecordedCall[] {
  return (fetchImpl as unknown as { mock: { calls: RecordedCall[] } }).mock.calls;
}

function postedContents(fetchImpl: WeComFetch): string[] {
  return recordedCalls(fetchImpl).map(([, init]) => {
    const payload = JSON.parse(String(init.body)) as { msgtype: string; text: { content: string } };
    expect(payload.msgtype).toBe("text");
    return payload.text.content;
  });
}

describe("sendWeComText", () => {
  const message: PushMessage = { title: "黑袍纠察队 更新", text: "S05E08 已入库" };

  it("posts ONLY a text msgtype with title + body", async () => {
    const fetchImpl = weComOk();
    await sendWeComText({ webhookUrl: "https://qyapi.example/send?key=K", message, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(recordedCalls(fetchImpl)[0]![1].body))).toEqual({
      msgtype: "text",
      text: { content: "黑袍纠察队 更新\nS05E08 已入库" },
    });
  });

  it("throws when errcode is non-zero (HTTP 200 is not delivery)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errcode: 40058, errmsg: "content exceed max length" }), { status: 200 }),
    ) as unknown as WeComFetch;
    await expect(
      sendWeComText({ webhookUrl: "https://q/send?key=K", message, fetchImpl }),
    ).rejects.toThrow(/errcode 40058.*content exceed max length/);
  });

  it("throws when the body is not JSON / has no errcode", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 200 })) as unknown as WeComFetch;
    await expect(
      sendWeComText({ webhookUrl: "https://q/send?key=K", message, fetchImpl }),
    ).rejects.toThrow(/wecom push failed: HTTP 200/);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" }), { status: 500 }),
    ) as unknown as WeComFetch;
    await expect(
      sendWeComText({ webhookUrl: "https://q/send?key=K", message, fetchImpl }),
    ).rejects.toThrow(/HTTP 500 errcode 93000/);
  });

  it("never puts the webhook URL (and its key) in the error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as WeComFetch;
    await expect(
      sendWeComText({ webhookUrl: "https://q/send?key=SECRET", message, fetchImpl }),
    ).rejects.toThrow(/^wecom push failed: TimeoutError$/);
  });
});

describe("WeCom text splitting", () => {
  it("leaves a short message as one un-prefixed part", () => {
    expect(weComMessageParts({ title: "t", text: "b" })).toEqual(["t\nb"]);
  });

  it("splits long line-based text into [i/n] parts that all fit the byte limit", () => {
    const lines = Array.from({ length: 80 }, () => "这一行包含足够多的中文内容用于测试分段逻辑");
    const parts = weComMessageParts({ title: "每日巡检", text: lines.join("\n") });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.startsWith("[1/")).toBe(true);
    for (const part of parts) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(WECOM_TEXT_MAX_BYTES);
    }
    const joined = parts.join("\n");
    for (const line of lines) expect(joined).toContain(line);
  });

  it("hard-splits a single line longer than the limit", () => {
    const parts = splitWeComContent("中".repeat(1500), 2048);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(2048);
    }
  });
});

describe("sendPushNotifications (WeCom only)", () => {
  afterEach(() => {
    delete process.env.MEDIA_TRACK_PUSH_WECOM_WEBHOOK;
  });

  it("reads override > DB > env and sends through WeCom", async () => {
    process.env.MEDIA_TRACK_PUSH_WECOM_WEBHOOK = "https://env/send?key=E";
    const fetchImpl = weComOk();
    const repository = { getSetting: vi.fn(async () => "https://db/send?key=D") };

    const sent = await sendPushNotifications({
      repository,
      notification: notification(sampleReport),
      overrideConfig: { wecom: "https://override/send?key=O" },
      fetchImpl,
    });

    expect(sent).toEqual(["wecom"]);
    expect(recordedCalls(fetchImpl)[0]![0]).toBe("https://override/send?key=O");
    expect(postedContents(fetchImpl)[0]).toContain("阿甘正传");
  });

  it("returns [] and sends nothing when no webhook is configured anywhere", async () => {
    const fetchImpl = weComOk();
    const sent = await sendPushNotifications({
      repository: { getSetting: async () => null },
      notification: notification(sampleReport),
      fetchImpl,
    });
    expect(sent).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates a delivery failure (callers log it)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errcode: 40058, errmsg: "too long" }), { status: 200 }),
    ) as unknown as WeComFetch;
    await expect(
      sendPushNotifications({
        repository: { getSetting: async () => "https://db/send?key=D" },
        notification: notification(sampleReport),
        fetchImpl,
      }),
    ).rejects.toThrow(/errcode 40058/);
  });
});
