import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));

const mocks = vi.hoisted(() => ({ retrySeasonNow: vi.fn() }));
vi.mock("../../../../lib/season-retry", () => ({ retrySeasonNow: mocks.retrySeasonNow }));
const { retrySeasonNow } = mocks;

import { isDemoMode } from "../../../../lib/demo-mode";
import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/seasons/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/seasons/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
  });

  it("runs the retry for the requested season and returns its outcome", async () => {
    retrySeasonNow.mockResolvedValue({ status: "completed", message: "第 1 季重试完成。" });

    const res = await post({ tmdbId: 66732, seasonNumber: 1, storageId: "cs_115" });

    expect(await res.json()).toEqual({ status: "completed", message: "第 1 季重试完成。" });
    expect(retrySeasonNow).toHaveBeenCalledWith({
      tmdbId: 66732,
      seasonNumber: 1,
      storageId: "cs_115",
    });
  });

  it("treats a missing storageId as the primary drive", async () => {
    retrySeasonNow.mockResolvedValue({ status: "not_tracked", message: "本季尚未追踪" });

    await post({ tmdbId: 66732, seasonNumber: 2 });

    expect(retrySeasonNow).toHaveBeenCalledWith({
      tmdbId: 66732,
      seasonNumber: 2,
      storageId: undefined,
    });
  });

  it("rejects a request without a season identity", async () => {
    const res = await post({ tmdbId: 66732 });

    expect(res.status).toBe(400);
    expect(retrySeasonNow).not.toHaveBeenCalled();
  });

  it("refuses to run anything in demo mode", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);

    const res = await post({ tmdbId: 66732, seasonNumber: 1 });

    expect(res.status).toBe(403);
    expect(retrySeasonNow).not.toHaveBeenCalled();
  });
});
