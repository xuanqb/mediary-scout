import { describe, expect, it } from "vitest";
import {
  alignSubtitleName,
  episodeNumber,
  episodeRangeKey,
  extractReleaseGroup,
  extractVideoFormat,
  fileExtension,
  fileNameStem,
  isParseableEpisodeName,
  renderLibraryFilename,
  sanitizeLibraryTitle,
  withCollisionSuffix,
} from "../src/library-filename.js";

describe("renderLibraryFilename", () => {
  it("renders the MoviePilot TV format with the optional fields present", () => {
    expect(
      renderLibraryFilename({
        title: "凡人修仙传",
        seasonEpisode: "S01E199",
        episode: "199",
        videoFormat: "2160p",
        releaseGroup: "ADWeb",
        fileExt: ".mp4",
      }),
    ).toBe("凡人修仙传 - S01E199 - 第 199 集 - 2160p - ADWeb.mp4");
  });

  it("omits absent optional segments", () => {
    expect(
      renderLibraryFilename({ title: "凡人修仙传", seasonEpisode: "S01E199", fileExt: ".mp4" }),
    ).toBe("凡人修仙传 - S01E199.mp4");
  });

  it("renders a multi-episode range", () => {
    expect(
      renderLibraryFilename({
        title: "凡人修仙传",
        seasonEpisode: "S01E199-E200",
        episode: "199",
        videoFormat: "2160p",
        fileExt: ".mp4",
      }),
    ).toBe("凡人修仙传 - S01E199-E200 - 第 199 集 - 2160p.mp4");
  });

  it("sanitizes characters that break drives or SMB", () => {
    expect(
      renderLibraryFilename({
        title: 'Re:Zero / A*B? <C>|"D"\\E',
        seasonEpisode: "S01E01",
        fileExt: ".mkv",
      }),
    ).toBe("Re：Zero ／ A＊B？ ＜C＞｜＂D＂＼E - S01E01.mkv");
  });

  it("drops trailing dots/spaces and collapses whitespace in the title", () => {
    expect(sanitizeLibraryTitle("  A   B...  ")).toBe("A B");
  });
});

describe("episode codes", () => {
  it("keeps a single code", () => {
    expect(episodeRangeKey(["S01E199"])).toBe("S01E199");
  });

  it("collapses contiguous codes into a range", () => {
    expect(episodeRangeKey(["S01E200", "S01E199"])).toBe("S01E199-E200");
  });

  it("refuses non-contiguous or cross-season codes", () => {
    expect(episodeRangeKey(["S01E199", "S01E201"])).toBeNull();
    expect(episodeRangeKey(["S01E199", "S02E200"])).toBeNull();
  });

  it("renders an unpadded display number", () => {
    expect(episodeNumber("S01E005")).toBe("5");
    expect(episodeNumber("S01E199")).toBe("199");
  });
});

describe("isParseableEpisodeName", () => {
  it("rejects a bare number with a quality suffix", () => {
    expect(isParseableEpisodeName("199.4K.mp4", 1, ["S01E199"])).toBe(false);
  });

  it("accepts SxxEyy regardless of case or zero padding", () => {
    expect(isParseableEpisodeName("凡人修仙传 - S01E199 - 第 199 集.mkv", 1, ["S01E199"])).toBe(true);
    expect(isParseableEpisodeName("凡人修仙传.S1E199.mkv", 1, ["S01E199"])).toBe(true);
    expect(isParseableEpisodeName("凡人修仙传.s01e199.mkv", 1, ["S01E199"])).toBe(true);
  });

  it("accepts 第N集 only for season 1", () => {
    expect(isParseableEpisodeName("凡人修仙传 - 第 199 集.mp4", 1, ["S01E199"])).toBe(true);
    expect(isParseableEpisodeName("凡人修仙传 - 第 199 集.mp4", 2, ["S02E199"])).toBe(false);
  });

  it("rejects a different episode or season", () => {
    expect(isParseableEpisodeName("凡人修仙传 - S01E198.mkv", 1, ["S01E199"])).toBe(false);
    expect(isParseableEpisodeName("凡人修仙传 - S02E199.mkv", 1, ["S01E199"])).toBe(false);
  });

  it("understands a contiguous range for a multi-episode file", () => {
    expect(isParseableEpisodeName("Show.S01E199-E200.mkv", 1, ["S01E199", "S01E200"])).toBe(true);
    expect(isParseableEpisodeName("Show.S01E199.mkv", 1, ["S01E199", "S01E200"])).toBe(false);
  });
});

describe("format and group extraction", () => {
  it("normalizes 4K/UHD to 2160p and prefers the candidate title", () => {
    expect(extractVideoFormat(["凡人修仙传 (2020) · 2160p.WEB-DL", "199.4K.mp4"])).toBe("2160p");
    expect(extractVideoFormat(["199.4K.mp4", "2160p.WEB-DL"])).toBe("2160p");
    expect(extractVideoFormat(["1080p.WEB-DL"])).toBe("1080p");
    expect(extractVideoFormat(["no resolution here"])).toBeUndefined();
  });

  it("extracts a conservative trailing release group", () => {
    expect(extractReleaseGroup(["A.Record.Of.Mortals.Journey.S01E194.2160p.AVC.AAC-WF.strm"])).toBe("WF");
    expect(extractReleaseGroup(["凡人修仙传 - 01 - 2160p - ADWeb"])).toBe("ADWeb");
    expect(extractReleaseGroup(["Show.2160p.OurTV.mp4"])).toBe("OurTV");
    expect(extractReleaseGroup(["A Mortal's Journey to Immortality"])).toBeUndefined();
  });

  it("refuses codec/source tokens and episode codes as groups", () => {
    expect(extractReleaseGroup(["Show.2160p.WEB-DL.mp4"])).toBeUndefined();
    expect(extractReleaseGroup(["Show.S01E199.mkv"])).toBeUndefined();
    expect(extractReleaseGroup(["Show.HEVC.mp4"])).toBeUndefined();
    expect(extractReleaseGroup(["Show.mp4"])).toBeUndefined();
    expect(extractReleaseGroup(["凡人修仙传 (2020) · 2160p.WEB-DL · 字幕:简中(内封) · 2.43G"])).toBeUndefined();
  });
});

describe("file names", () => {
  it("keeps the final extension", () => {
    expect(fileExtension("Show.S01E01.MKV")).toBe(".MKV");
    expect(fileExtension("no-extension")).toBe("");
    expect(fileNameStem("Show.S01E01.mkv")).toBe("Show.S01E01");
  });

  it("appends a collision suffix before the extension", () => {
    expect(withCollisionSuffix("Show - S01E01 - 第 1 集 - 2160p.mp4", 2)).toBe(
      "Show - S01E01 - 第 1 集 - 2160p - v2.mp4",
    );
  });

  it("aligns a subtitle with its renamed video, keeping the language infix", () => {
    expect(
      alignSubtitleName(
        "Show - 01.sc.ass",
        "Show - 01.mkv",
        "Show - S01E01 - 第 1 集 - 2160p.mkv",
      ),
    ).toBe("Show - S01E01 - 第 1 集 - 2160p.sc.ass");
    expect(alignSubtitleName("other.ass", "Show - 01.mkv", "Show - S01E01.mkv")).toBeNull();
  });
});
