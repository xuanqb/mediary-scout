import { describe, expect, it } from "vitest";
import {
  allowedResourceTypesForKinds,
  brandSupportsProwlarr,
  getStorageBrand,
  isRegisteredStorageProvider,
} from "./storage-brands.js";

describe("allowedResourceTypesForKinds", () => {
  it("maps a quark brand's kinds to quark-only links", () => {
    expect(allowedResourceTypesForKinds(getStorageBrand("quark").resourceProviderKinds)).toEqual(["quark"]);
  });

  it("maps a 115 brand's kinds to 115 + magnet", () => {
    expect(allowedResourceTypesForKinds(getStorageBrand("pan115").resourceProviderKinds)).toEqual([
      "115",
      "magnet",
    ]);
  });

  it("keeps a magnet-only kind set magnet-only", () => {
    expect(allowedResourceTypesForKinds(["pansou-magnet", "prowlarr"])).toEqual(["magnet"]);
  });

  it("falls back to 115 + magnet for an unknown/legacy kind set", () => {
    expect(allowedResourceTypesForKinds(["pansou-115", "prowlarr"])).toEqual(["115", "magnet"]);
  });
});

describe("STORAGE_BRANDS registry", () => {
  it("registers exactly 115 and 夸克", () => {
    expect(getStorageBrand("pan115").label).toBe("115 网盘");
    expect(getStorageBrand("quark").label).toBe("夸克网盘");
    expect(isRegisteredStorageProvider("pan115")).toBe(true);
    expect(isRegisteredStorageProvider("quark")).toBe(true);
    expect(isRegisteredStorageProvider("uc")).toBe(false);
    expect(isRegisteredStorageProvider("guangya")).toBe(false);
    expect(isRegisteredStorageProvider("tianyi")).toBe(false);
    expect(isRegisteredStorageProvider("pan123")).toBe(false);
  });

  it("both cookie brands report authKind cookie", () => {
    expect(getStorageBrand("pan115").authKind).toBe("cookie");
    expect(getStorageBrand("quark").authKind).toBe("cookie");
  });

  it("carries each brand's provisionRootId (category-dir root parent is registry data)", () => {
    expect(getStorageBrand("pan115").provisionRootId).toBe("0");
    expect(getStorageBrand("quark").provisionRootId).toBe("0");
  });

  it("only 115 supports Prowlarr", () => {
    expect(brandSupportsProwlarr("pan115")).toBe(true);
    expect(brandSupportsProwlarr("quark")).toBe(false);
    expect(brandSupportsProwlarr("guangya")).toBe(false);
  });
});
