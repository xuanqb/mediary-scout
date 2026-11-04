import { describe, expect, it, vi } from "vitest";
import { RealStorageV2 } from "../src/acquisition-v2/real-storage-adapter.js";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import type { PackageTreeFile, ResourceCandidate, TransferAttempt, VerifiedFile } from "../src/domain.js";
import type { StorageExecutor } from "../src/ports.js";

function tgtoCandidate(id: string, payload: Record<string, unknown> = {}): ResourceCandidate {
  return {
    id,
    snapshotId: "snap",
    index: 0,
    title: "沙丘 · 2160p.REMUX",
    type: "115",
    source: "tgto",
    providerPayload: {
      tgto: { slug: "slug-1", source: "re0", provider: "115" },
      targetProvider: "115",
      sizeBytes: 1024,
      ...payload,
    },
  };
}

/** Records the exact candidate the executor was handed. */
class PayloadRecorder implements StorageExecutor {
  seen: ResourceCandidate[] = [];
  async createDirectory(): Promise<string> {
    return "dir";
  }
  async transfer(input: { candidate: ResourceCandidate }): Promise<TransferAttempt> {
    this.seen.push(input.candidate);
    return {
      id: "a1",
      workflowRunId: "run",
      candidateId: input.candidate.id,
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ["f1"],
    };
  }
  async listVideoFiles(): Promise<VerifiedFile[]> {
    return [];
  }
  async listUnparsedVideoFiles() {
    return [];
  }
  async renameFile() {}
  async flattenDirectory() {
    return { moved: [], removed: [] };
  }
  async deleteFiles() {
    return { deleted: [] };
  }
  async removeDirectory() {
    return { removed: true };
  }
  async listTree(): Promise<PackageTreeFile[]> {
    return [];
  }
  async listSubdirectories() {
    return [];
  }
  async listChildDirectories() {
    return [];
  }
  async moveFiles() {
    return { moved: [] };
  }
}

describe("RealStorageV2 — lazy Tgto link resolution", () => {
  it("resolves a url-less candidate once, hands it to the executor, and updates the alias", async () => {
    const registry = new CandidateRegistry();
    const candidate = tgtoCandidate("real-1");
    registry.record(candidate, "s1-1");
    const executor = new PayloadRecorder();
    const resolve = vi.fn(async (c: ResourceCandidate) => ({
      ...c,
      providerPayload: { ...c.providerPayload, url: "https://115cdn.com/s/abc?password=pw", password: "pw" },
    }));
    const storage = new RealStorageV2({
      executor,
      registry,
      workflowRunId: "run",
      resolveCandidateLink: resolve,
    });

    await storage.transferCandidate({ candidateId: "s1-1", intoDirectoryId: "dir" });
    await storage.transferCandidate({ candidateId: "s1-1", intoDirectoryId: "dir" });

    // Paid call happened once; the second transfer reuses the resolved payload.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(executor.seen[0]!.providerPayload["url"]).toBe("https://115cdn.com/s/abc?password=pw");
    expect(executor.seen[1]!.providerPayload["url"]).toBe("https://115cdn.com/s/abc?password=pw");
    expect(registry.get("s1-1")!.providerPayload["url"]).toBe("https://115cdn.com/s/abc?password=pw");
  });

  it("does not resolve a candidate that already has a url", async () => {
    const registry = new CandidateRegistry();
    registry.record(tgtoCandidate("real-2", { url: "https://115cdn.com/s/abc" }));
    const resolve = vi.fn(async (c: ResourceCandidate) => c);
    const storage = new RealStorageV2({
      executor: new PayloadRecorder(),
      registry,
      workflowRunId: "run",
      resolveCandidateLink: resolve,
    });
    await storage.transferCandidate({ candidateId: "real-2", intoDirectoryId: "dir" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("classifies a url-less 115 target as a share so transferUntilLanded accepts it", () => {
    const registry = new CandidateRegistry();
    registry.record(tgtoCandidate("real-3"));
    const storage = new RealStorageV2({ executor: new PayloadRecorder(), registry, workflowRunId: "run" });
    expect(storage.candidateLinkKind("real-3")).toBe("share");
  });

  it("surfaces a copy-link failure as a transfer error (no silent skip)", async () => {
    const registry = new CandidateRegistry();
    registry.record(tgtoCandidate("real-4"));
    const storage = new RealStorageV2({
      executor: new PayloadRecorder(),
      registry,
      workflowRunId: "run",
      resolveCandidateLink: async () => {
        throw new Error("TGTO_COPY_LINK_FAILED: 积分不足");
      },
    });
    await expect(
      storage.transferCandidate({ candidateId: "real-4", intoDirectoryId: "dir" }),
    ).rejects.toThrow(/TGTO_COPY_LINK_FAILED/);
  });
});
