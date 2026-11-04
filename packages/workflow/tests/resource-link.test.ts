import { describe, expect, it } from "vitest";
import { deadLinkKey } from "../src/acquisition-v2/dead-links.js";
import {
  brandOfUrl,
  candidateDriveLabel,
  resourceLinkKey,
  storageProviderForResourceType,
} from "../src/acquisition-v2/resource-link.js";

describe("resourceLinkKey — a resource's link identity for rejections and recorded sources", () => {
  it("115 shares and magnets: the same key dead-link tracking uses", () => {
    for (const url of [
      "https://115.com/s/sw3abcd1234?password=x1y2",
      `magnet:?xt=urn:btih:${"A".repeat(40)}&dn=x`,
    ]) {
      expect(resourceLinkKey(url)).toBe(deadLinkKey(url)!.key);
    }
  });

  it("夸克 shares, which dead-link tracking leaves out, get a key of their own — the same share under any passcode or fragment", () => {
    expect(deadLinkKey("https://pan.quark.cn/s/1a2B3c4D")).toBeNull();
    expect(resourceLinkKey("https://pan.quark.cn/s/1a2B3c4D")).toBe("quark:1a2B3c4D");
    expect(resourceLinkKey("https://pan.quark.cn/s/1a2B3c4D?pwd=abcd#/list/share")).toBe("quark:1a2B3c4D");
  });

  it("different shares stay different; a link no drive transfers by has no key", () => {
    expect(resourceLinkKey("https://pan.quark.cn/s/aaaa1111")).not.toBe(resourceLinkKey("https://pan.quark.cn/s/bbbb2222"));
    expect(resourceLinkKey("https://example.com/The.Odyssey.2026.mkv")).toBeNull();
    expect(resourceLinkKey("")).toBeNull();
  });
});

describe("brandOfUrl / candidateDriveLabel / storageProviderForResourceType", () => {
  it("classifies both drive share shapes plus magnet and rejects lookalike hosts", () => {
    expect(brandOfUrl("https://115.com/s/sw3abcd1234")).toBe("115");
    expect(brandOfUrl("https://115cdn.com/s/sw3abcd1234?password=x")).toBe("115");
    expect(brandOfUrl("https://anxia.com/s/sw3abcd1234")).toBe("115");
    expect(brandOfUrl("https://pan.quark.cn/s/1a2B3c4D")).toBe("quark");
    expect(brandOfUrl("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")).toBe("magnet");

    expect(brandOfUrl("https://evilpan.quark.cn/s/1a2B3c4D")).toBeNull();
    expect(brandOfUrl("https://attacker.com/115.com/s/sw3abcd1234")).toBeNull();
    expect(brandOfUrl("https://www.123pan.com/s/Ab-cD_12")).toBeNull();
    expect(brandOfUrl("")).toBeNull();
  });

  it("maps candidate resource types to Chinese labels and storage providers", () => {
    expect(candidateDriveLabel("115")).toBe("115");
    expect(candidateDriveLabel("quark")).toBe("夸克");
    expect(candidateDriveLabel("magnet")).toBe("磁力");
    expect(candidateDriveLabel("123")).toBeUndefined();

    expect(storageProviderForResourceType("115")).toBe("pan115");
    expect(storageProviderForResourceType("quark")).toBe("quark");
    expect(storageProviderForResourceType("magnet")).toBeNull();
  });
});
