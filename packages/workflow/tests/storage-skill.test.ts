import { describe, expect, it } from "vitest";
import { buildMultiDriveAllocationBlock, getStorageSkill, readSkillSection } from "../src/index.js";

describe("brand-aware storage skill", () => {
  it("getStorageSkill('quark') teaches 转存分享, 无磁力, and fail-loud codes", () => {
    const quark = getStorageSkill("quark");
    expect(quark).toContain("转存分享");
    expect(quark).toMatch(/无磁力|NO magnet|没有.*磁力/i);
    expect(quark).toContain("41006"); // 分享不存在 fail-loud code
    expect(quark).toContain("夸克");
  });

  it("getStorageSkill('pan115') keeps the 115 transfer model (秒传/magnet)", () => {
    const pan115 = getStorageSkill("pan115");
    expect(pan115).toContain("115");
    expect(pan115).toMatch(/秒传/);
    expect(pan115).toMatch(/magnet/i);
    expect(pan115).not.toContain("41006"); // 115 has no quark codes
  });

  it("getStorageSkill throws for an unknown brand", () => {
    expect(() => getStorageSkill("baidu")).toThrowError(/unknown storage brand/i);
  });

  it.each(["pan115", "quark"])(
    "%s teaches the systemic-block STOP rule (quota/auth = account problem, not a dead link)",
    (brand) => {
      const skill = getStorageSkill(brand);
      // distinguishes a systemic ACCOUNT block from an ordinary dead link
      expect(skill).toMatch(/系统性|systemic|账号|account/i);
      expect(skill).toMatch(/配额|额度|VIP|登录|鉴权/);
      // it must tell the agent to STOP, not keep grinding every candidate
      expect(skill).toMatch(/立即停|STOP|不要(再|继续)|别(再|继续)/i);
      expect(skill).toContain("systemicBlock"); // the surfaced tool field
      // and NOT report "no resource" (the resource exists)
      expect(skill).toMatch(/资源.*(存在|有)|不是.*没有?资源|别甩锅/);
    },
  );

  it("readSkillSection selects the brand variant for dead-links-black-box", () => {
    expect(readSkillSection("dead-links-black-box", "quark")).toBe(getStorageSkill("quark"));
    expect(readSkillSection("dead-links-black-box", "pan115")).toBe(getStorageSkill("pan115"));
    // defaults to 115 when no brand is given (single-user / legacy)
    expect(readSkillSection("dead-links-black-box")).toBe(getStorageSkill("pan115"));
  });

  it("readSkillSection still serves shared sections regardless of brand", () => {
    expect(readSkillSection("protocol", "quark")).toContain("Evidence");
    expect(readSkillSection("dedup", "quark")).toContain("larger");
    expect(readSkillSection("nope", "quark")).toContain("Unknown skill section");
  });

  it("buildMultiDriveAllocationBlock and readSkillSection inject multi-drive rules when >1 drive is present (C6)", () => {
    const drives = [
      {
        storageId: "cs_115",
        provider: "pan115",
        label: "115 网盘",
        space: { totalBytes: 40 * 1024 ** 4, usedBytes: 19 * 1024 ** 4 },
      },
      {
        storageId: "cs_quark",
        provider: "quark",
        label: "夸克网盘",
        space: { totalBytes: 10 * 1024 ** 3, usedBytes: 1378 * 1024 ** 3 },
      },
    ];
    const block = buildMultiDriveAllocationBlock(drives, "cs_115");
    expect(block).toContain("## 你手上有这几块盘");
    expect(block).toContain("115 网盘 [storageId=cs_115, provider=pan115] — 剩余 21.00 TB");
    expect(block).toContain("【本剧历史在追主盘】");
    expect(block).toContain("夸克网盘 [storageId=cs_quark, provider=quark] — 已超配额 1.34 TB");
    expect(block).toContain("禁止写入");
    expect(block).toContain("默认一块盘收齐");
    expect(block).toContain("拆完能拿到的总集数 > 单盘能拿到的集数");
    expect(block).toContain("严禁为了「均衡剩余空间」而拆盘");
    expect(block).toContain("同一集绝不在两块盘各存一份");

    const protocolWithMulti = readSkillSection("protocol", "pan115", drives, "cs_115");
    expect(protocolWithMulti).toContain("## 你手上有这几块盘");
    expect(protocolWithMulti).toContain("Evidence → Facts → Decision");

    const deadLinksWithMulti = readSkillSection("dead-links-black-box", "quark", drives, "cs_115");
    expect(deadLinksWithMulti).toContain("## 你手上有这几块盘");
    expect(deadLinksWithMulti).toContain("41006"); // quark manual included
  });
});
