import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutorForBrand, QuarkStorageExecutor, Storage115Executor, STORAGE_BRANDS } from "../src/index.js";

describe("createExecutorForBrand", () => {
  it("pan115 → Storage115Executor (write scope from scopeCids)", () => {
    const exec = createExecutorForBrand({ provider: "pan115", cookie: "UID=1;CID=2", scopeCids: ["root"] });
    expect(exec).toBeInstanceOf(Storage115Executor);
  });

  it("quark → QuarkStorageExecutor", () => {
    const exec = createExecutorForBrand({ provider: "quark", cookie: "__uid=1", scopeCids: ["ROOT"] });
    expect(exec).toBeInstanceOf(QuarkStorageExecutor);
  });

  it("unknown provider throws", () => {
    expect(() => createExecutorForBrand({ provider: "baidu", cookie: "x", scopeCids: ["y"] })).toThrowError(
      /unknown storage brand/i,
    );
  });
});

describe("STORAGE_BRANDS writeScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Both supported drives look the target up on the drive before deciding, so the
  // executor must actually ask the drive (not refuse locally).
  for (const brand of STORAGE_BRANDS) {
    it(`${brand.provider}: the executor checks writes on the drive`, async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("offline (test)");
      });
      vi.stubGlobal("fetch", fetchMock);
      const executor = createExecutorForBrand({
        provider: brand.provider,
        cookie: "UID=1_A1_2;CID=2;SEID=3;__uid=1",
        scopeCids: ["scope-root"],
        env: {},
      });
      const error: unknown = await executor.removeDirectory("never-listed").then(
        () => null,
        (rejected: unknown) => rejected,
      );
      expect(error).not.toBeNull();
      expect(fetchMock).toHaveBeenCalled();
    });
  }
});
