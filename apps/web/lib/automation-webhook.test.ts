import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { repo, resolveLandedStoragePath } = vi.hoisted(() => {
  const settings = new Map<string, string>();
  return {
    repo: {
      settings,
      settingsKey: (accountId: string, key: string) => `${accountId}:${key}`,
      async getAccountSetting(accountId: string, key: string) {
        return settings.get(`${accountId}:${key}`) ?? null;
      },
      async setAccountSetting(accountId: string, key: string, value: string) {
        settings.set(`${accountId}:${key}`, value);
      },
      async listAccounts() {
        return [{ id: "acct" }];
      },
    },
    resolveLandedStoragePath: vi.fn(async (..._args: unknown[]) => "/115/影视/电影/示例影片 (2026) {tmdb-1}"),
  };
});

vi.mock("./workflow-runtime", () => ({
  getWorkflowRepository: () => repo,
  resolveLandedStoragePath: (...args: unknown[]) => resolveLandedStoragePath(...args),
}));

import {
  AUTOMATION_CONFIG_SETTING_KEY,
  AUTOMATION_LOG_SETTING_KEY,
  AUTOMATION_PENDING_SETTING_KEY,
  automationSignature,
  buildSmartStrmPayload,
  enqueueAutomationForLandings,
  flushDueAutomationWebhooks,
  parseAutomationConfig,
  readAutomationDeliveries,
  testAutomationWebhook,
} from "./automation-webhook";

function saveConfig(overrides: Record<string, unknown> = {}) {
  repo.settings.set(
    `acct:${AUTOMATION_CONFIG_SETTING_KEY}`,
    JSON.stringify({ enabled: true, url: "http://smartstrm:8024/webhook/t", ...overrides }),
  );
}

function readPending() {
  return JSON.parse(repo.settings.get(`acct:${AUTOMATION_PENDING_SETTING_KEY}`) ?? "[]") as Array<{
    storagePath: string;
    taskName: string;
    dueAt: string;
    firstAt: string;
    attempts: number;
  }>;
}

const report = {
  titleName: "示例影片",
  seasonLabel: null,
  status: "acquired" as const,
  lines: [],
  newlyObtained: [],
  realMissing: [],
  tmdbId: 1,
  year: 2026,
  mediaType: "movie" as const,
  libraryCategory: "movies" as const,
  landed: true,
};

beforeEach(() => {
  repo.settings.clear();
  resolveLandedStoragePath.mockReset();
  resolveLandedStoragePath.mockResolvedValue("/115/影视/电影/示例影片 (2026) {tmdb-1}");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseAutomationConfig", () => {
  it("returns the defaults for empty / garbage", () => {
    expect(parseAutomationConfig(null)).toMatchObject({
      enabled: false,
      quietSeconds: 15,
      maxWaitSeconds: 120,
      retries: 3,
      taskNames: { movies: "电影", tv: "电视剧", variety: "综艺", anime: "动漫" },
    });
    expect(parseAutomationConfig("not json").enabled).toBe(false);
  });

  it("clamps numbers and keeps maxWait >= quiet", () => {
    const config = parseAutomationConfig(
      JSON.stringify({ quietSeconds: 500, maxWaitSeconds: 10, retries: 99 }),
    );
    expect(config.quietSeconds).toBe(500);
    expect(config.maxWaitSeconds).toBe(500);
    expect(config.retries).toBe(10);
  });
});

describe("SmartStrm contract", () => {
  it("builds the a_task payload usapi uses", () => {
    expect(
      buildSmartStrmPayload(
        { incremental: true, dirTimeCheck: false, delaySeconds: 0 },
        "电影",
        "/115/影视/电影/示例 (2026)",
      ),
    ).toEqual({
      event: "a_task",
      delay: 0,
      task: {
        name: "电影",
        storage_path: "/115/影视/电影/示例 (2026)",
        dir_time_check: false,
        incremental: true,
      },
    });
  });

  it("signs the raw body with HMAC-SHA256", () => {
    expect(automationSignature("secret", '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(automationSignature("secret", '{"a":1}')).toBe(
      automationSignature("secret", '{"a":1}'),
    );
    expect(automationSignature("other", '{"a":1}')).not.toBe(
      automationSignature("secret", '{"a":1}'),
    );
  });
});

describe("enqueueAutomationForLandings", () => {
  it("does nothing when disabled or no URL", async () => {
    await enqueueAutomationForLandings({
      accountId: "acct",
      entries: [{ connectedStorageId: "drive-1", report }],
    });
    expect(repo.settings.get(`acct:${AUTOMATION_PENDING_SETTING_KEY}`)).toBeUndefined();
  });

  it("queues one task per landed path and debounces the same directory", async () => {
    saveConfig();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T10:00:00.000Z"));
    await enqueueAutomationForLandings({
      accountId: "acct",
      entries: [{ connectedStorageId: "drive-1", report }],
    });
    let pending = readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dueAt).toBe("2026-11-04T10:00:15.000Z");
    expect(pending[0]!.taskName).toBe("电影");

    vi.setSystemTime(new Date("2026-11-04T10:00:05.000Z"));
    await enqueueAutomationForLandings({
      accountId: "acct",
      entries: [{ connectedStorageId: "drive-1", report }],
    });
    pending = readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dueAt).toBe("2026-11-04T10:00:20.000Z");
    vi.useRealTimers();
  });

  it("skips notifications that did not land files", async () => {
    saveConfig();
    await enqueueAutomationForLandings({
      accountId: "acct",
      entries: [
        { connectedStorageId: "drive-1", report: { ...report, status: "no_coverage" } },
      ],
    });
    expect(repo.settings.get(`acct:${AUTOMATION_PENDING_SETTING_KEY}`)).toBeUndefined();
  });

  it("ignores a landed-looking status that wrote nothing this run", async () => {
    saveConfig();
    await enqueueAutomationForLandings({
      accountId: "acct",
      entries: [
        // Patrol no-op / Emby-only skip: status looks acquired, no landing marker.
        { connectedStorageId: "drive-1", report: { ...report, landed: false } },
      ],
    });
    expect(repo.settings.get(`acct:${AUTOMATION_PENDING_SETTING_KEY}`)).toBeUndefined();
  });
});

describe("flushDueAutomationWebhooks", () => {
  function queuePending(dueAt: string, attempts = 0) {
    repo.settings.set(
      `acct:${AUTOMATION_PENDING_SETTING_KEY}`,
      JSON.stringify([
        {
          id: "task-1",
          storageId: "drive-1",
          category: "movies",
          title: "示例影片",
          year: 2026,
          tmdbId: 1,
          taskName: "电影",
          storagePath: "/115/影视/电影/示例影片 (2026) {tmdb-1}",
          firstAt: "2026-11-04T10:00:00.000Z",
          dueAt,
          attempts,
        },
      ]),
    );
  }

  it("sends a due task, clears it from the queue and logs the delivery", async () => {
    saveConfig();
    queuePending("2026-11-04T09:59:00.000Z");
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await flushDueAutomationWebhooks(Date.parse("2026-11-04T10:00:00.000Z"));

    expect(sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://smartstrm:8024/webhook/t");
    expect(JSON.parse(String(init.body))).toMatchObject({
      event: "a_task",
      task: { name: "电影", storage_path: "/115/影视/电影/示例影片 (2026) {tmdb-1}" },
    });
    expect(readPending()).toEqual([]);
    const log = await readAutomationDeliveries("acct");
    expect(log[0]).toMatchObject({ status: "sent", httpStatus: 200, taskName: "电影" });
  });

  it("keeps a failed task for a retry, then records the final failure", async () => {
    saveConfig({ retries: 1 });
    queuePending("2026-11-04T09:59:00.000Z");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const sent = await flushDueAutomationWebhooks(Date.parse("2026-11-04T10:00:00.000Z"));
    expect(sent).toBe(0);
    const pending = readPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
    expect(Date.parse(pending[0]!.dueAt)).toBeGreaterThan(Date.parse("2026-11-04T10:00:00.000Z"));

    // Retry due (attempts already 1 == retries) → log the failure instead of looping forever.
    repo.settings.set(
      `acct:${AUTOMATION_PENDING_SETTING_KEY}`,
      JSON.stringify([{ ...pending[0]!, dueAt: "2026-11-04T10:00:00.000Z" }]),
    );
    await flushDueAutomationWebhooks(Date.parse("2026-11-04T10:00:01.000Z"));
    expect(readPending()).toEqual([]);
    const log = await readAutomationDeliveries("acct");
    expect(log[0]).toMatchObject({ status: "failed" });
  });

  it("leaves a task alone before its due time", async () => {
    saveConfig();
    queuePending("2026-11-04T10:00:15.000Z");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await flushDueAutomationWebhooks(Date.parse("2026-11-04T10:00:00.000Z"))).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPending()).toHaveLength(1);
  });
});

describe("testAutomationWebhook", () => {
  it("rejects a non-http URL", async () => {
    expect(await testAutomationWebhook({ url: "ftp://x", secret: "", taskName: "电影", storagePath: "/x" }))
      .toMatchObject({ success: false });
  });

  it("reports the HTTP status of the test send", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 202 })));
    const result = await testAutomationWebhook({
      url: "http://smartstrm/webhook/t",
      secret: "",
      taskName: "电影",
      storagePath: "/115/影视/电影/x",
    });
    expect(result).toEqual({ success: true, message: "HTTP 202 · ok" });
  });
});
