import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same mounting-rule guard as haisou: a configured source that silently never
// loads is the failure mode this pins. Tgto is 115-only, so a quark-only drive
// must not mount it.
const ORIGINAL_ADAPTER = process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;

vi.mock("./demo-mode", () => ({ isDemoMode: () => false }));

function settingsWith(entries: Record<string, string>) {
  return { getSetting: async (key: string) => entries[key] ?? null };
}

const TGTO_SETTINGS = {
  tgto_base_url: "http://192.168.123.148:12366",
  tgto_api_token: "tgto__test",
};

describe("getWorkerResourceProvider — tgto mounting", () => {
  beforeEach(() => {
    process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = "pansou";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { total: 0 } }), { status: 200 })),
    );
  });

  afterEach(() => {
    if (ORIGINAL_ADAPTER === undefined) delete process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;
    else process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = ORIGINAL_ADAPTER;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("mounts tgto when both base url and token are configured", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith(TGTO_SETTINGS));
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).toContain("tgto");
  });

  it("defaults to never spending points (cap 0) and re0+guanying only", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith(TGTO_SETTINGS));
    const entry = (provider as unknown as { providers: Array<{ name: string; provider: unknown }> }).providers.find(
      (p) => p.name === "tgto",
    );
    const tgto = entry!.provider as unknown as { maxPoints: number; sources: string[] };
    expect(tgto.maxPoints).toBe(0);
    expect(tgto.sources).toEqual(["re0", "guanying"]);
  });

  it("leaves tgto out when the token is missing", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith({ tgto_base_url: TGTO_SETTINGS.tgto_base_url }));
    const isComposite = provider.constructor.name === "CompositeResourceProvider";
    const names = isComposite
      ? (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name)
      : [];
    expect(names).not.toContain("tgto");
  });

  it("does not mount tgto for a quark-only drive", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(settingsWith(TGTO_SETTINGS), "quark");
    const isComposite = provider.constructor.name === "CompositeResourceProvider";
    const names = isComposite
      ? (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name)
      : [];
    expect(names).not.toContain("tgto");
  });
});
