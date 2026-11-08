/**
 * Library filename contract for non-movie media.
 *
 * Mirrors MoviePilot's TV_RENAME_FORMAT:
 *   {{title}} - {{season_episode}}{% if part %}-{{part}}{% endif %}{% if episode %} - 第 {{episode}} 集{% endif %}{% if videoFormat %} - {{videoFormat}}{% endif %}{% if releaseGroup %} - {{releaseGroup}}{% endif %}{{fileExt}}
 *
 * The acquisition workflow only needs this one fixed shape, so it is rendered by
 * typed functions instead of a general Jinja2 engine. `season_episode` must carry
 * the episode identity: Emby reads the landed file name (through SmartStrm) and a
 * name like `199.4K` is invisible to it.
 */

export interface LibraryFilenameInput {
  title: string;
  /** `S01E199`, or `S01E199-E200` for one contiguous multi-episode file. */
  seasonEpisode: string;
  /** First episode number, rendered as `第 N 集` (unpadded: `第 199 集`). */
  episode?: string;
  /** Reserved for multi-part releases; the acquisition workflow leaves it empty. */
  part?: string;
  videoFormat?: string;
  releaseGroup?: string;
  /** Including the dot (`.mkv`) or empty. */
  fileExt: string;
}

export function renderLibraryFilename(input: LibraryFilenameInput): string {
  let name = `${sanitizeLibraryTitle(input.title)} - ${input.seasonEpisode}`;
  if (input.part) name += `-${input.part}`;
  if (input.episode) name += ` - 第 ${input.episode} 集`;
  if (input.videoFormat) name += ` - ${input.videoFormat}`;
  if (input.releaseGroup) name += ` - ${input.releaseGroup}`;
  return `${name}${input.fileExt}`;
}

const TITLE_REPLACEMENTS: Record<string, string> = {
  "/": "／",
  "\\": "＼",
  ":": "：",
  "*": "＊",
  "?": "？",
  '"': "＂",
  "<": "＜",
  ">": "＞",
  "|": "｜",
};

/** Keep a title readable while making it safe for the drive and Emby/SMB. */
export function sanitizeLibraryTitle(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, (char) => TITLE_REPLACEMENTS[char] ?? " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();
}

interface ParsedEpisodeCode {
  season: number;
  episode: number;
}

function parseEpisodeCode(code: string): ParsedEpisodeCode | null {
  const match = /^[Ss](\d{1,2})[Ee](\d{1,4})$/.exec(code.trim());
  if (!match?.[1] || !match[2]) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

function seasonToken(season: number): string {
  return String(season).padStart(2, "0");
}

function episodeToken(episode: number): string {
  return String(episode).padStart(2, "0");
}

/** `S01E199` for one code, `S01E199-E200` for contiguous codes, null otherwise. */
export function episodeRangeKey(codes: readonly string[]): string | null {
  const parsed = codes.map(parseEpisodeCode);
  if (parsed.length === 0 || parsed.some((code) => code === null)) return null;
  const episodes = parsed as ParsedEpisodeCode[];
  const season = episodes[0]!.season;
  if (episodes.some((code) => code.season !== season)) return null;

  const ordered = [...new Set(episodes.map((code) => code.episode))].sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] !== ordered[index - 1]! + 1) return null;
  }
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  return first === last
    ? `S${seasonToken(season)}E${episodeToken(first)}`
    : `S${seasonToken(season)}E${episodeToken(first)}-E${episodeToken(last)}`;
}

/** `S01E005` → `5` (the template's `第 N 集` is unpadded). */
export function episodeNumber(code: string): string | null {
  const parsed = parseEpisodeCode(code);
  return parsed ? String(parsed.episode) : null;
}

/**
 * True when the bare file name already carries the mapped episode identity.
 * Bare numbers (`199.4K`) do NOT count; only an explicit code matching the
 * mapped season/episode does.
 */
export function isParseableEpisodeName(
  name: string,
  season: number,
  codes: readonly string[],
): boolean {
  const mapped = codes.map(parseEpisodeCode);
  if (mapped.length === 0 || mapped.some((code) => code === null)) return false;
  const episodes = mapped as ParsedEpisodeCode[];
  if (episodes.some((code) => code.season !== season)) return false;

  if (episodes.length > 1) {
    const range = /[Ss](\d{1,2})[Ee](\d{1,4})\s*-\s*[Ee](\d{1,4})/.exec(name);
    if (range?.[1] && range[2] && range[3]) {
      const ordered = [...new Set(episodes.map((code) => code.episode))].sort((a, b) => a - b);
      if (
        Number(range[1]) === season &&
        Number(range[2]) === ordered[0] &&
        Number(range[3]) === ordered[ordered.length - 1]
      ) {
        return true;
      }
    }
    // A name that spells every episode code out (e.g. S01E199.S01E200) is
    // parseable too; a single code is not enough for a multi-episode file.
    return episodes.every((code) => hasSeasonEpisode(name, code.season, code.episode));
  }

  const only = episodes[0]!;
  if (hasSeasonEpisode(name, only.season, only.episode)) return true;
  if (season !== 1) return false;
  const chinese = /第\s*(\d{1,4})\s*集/.exec(name);
  return chinese?.[1] !== undefined && Number(chinese[1]) === only.episode;
}

function hasSeasonEpisode(name: string, season: number, episode: number): boolean {
  const pattern = /[Ss](\d{1,2})[Ee](\d{1,4})/g;
  for (const match of name.matchAll(pattern)) {
    if (Number(match[1]) === season && Number(match[2]) === episode) return true;
  }
  return false;
}

const RESOLUTION = /\b(2160p|1080p|720p|480p|4k|8k|uhd)\b/i;

/** Best-effort resolution tag (`4K` → `2160p`), or undefined when unknown. */
export function extractVideoFormat(texts: readonly (string | null | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const match = RESOLUTION.exec(text);
    if (!match?.[1]) continue;
    const value = match[1].toLowerCase();
    if (value === "4k" || value === "uhd") return "2160p";
    if (value === "8k") return "4320p";
    return value;
  }
  return undefined;
}

const MEDIA_EXTENSION = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv|srt|ass|ssa|sub|idx|vtt|sup|smi|strm|nfo)$/i;

/** Only strip a real media extension — `.S01E199` is an episode code, not one. */
function stripMediaExtension(text: string): string {
  return text.replace(MEDIA_EXTENSION, "");
}

// Tokens that look like a trailing group but are codec/source/episode debris.
const NON_GROUP_TOKENS = new Set([
  "dl",
  "web",
  "webdl",
  "webrip",
  "bluray",
  "ray",
  "remux",
  "hdr",
  "hdr10",
  "dv",
  "dovi",
  "sdr",
  "hevc",
  "h264",
  "h265",
  "avc",
  "x264",
  "x265",
  "aac",
  "ac3",
  "eac3",
  "ddp",
  "dts",
  "hd",
  "ma",
  "truehd",
  "atmos",
  "uhd",
  "4k",
  "8k",
  "2160p",
  "1080p",
  "720p",
  "480p",
  "10bit",
  "8bit",
  "60fps",
  "24fps",
  "chs",
  "cht",
  "zh",
  "cn",
  "eng",
  "jpn",
  "hq",
  "internal",
  "repack",
  "proper",
  "complete",
  "v2",
  "v3",
]);

/**
 * Best-effort release group from a trailing `-GROUP` / `.GROUP` segment.
 * Conservative: a wrong group is worse than none, so known codec/source
 * tokens and episode codes are rejected.
 */
const RELEASE_TOKEN =
  /\b(?:2160p|1080p|720p|480p|4k|8k|uhd|web-?dl|webrip|bluray|remux|hdr10?|hevc|h264|h265|avc|x264|x265|aac|ac3|eac3|dts|truehd)\b/i;

export function extractReleaseGroup(texts: readonly (string | null | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    // Only release-shaped text can carry a group; a plain title ending in a
    // capitalized word ("... Immortality") is not a group.
    if (!RELEASE_TOKEN.test(text)) continue;
    const stem = stripMediaExtension(text.trim());
    const match =
      /(?:^|[.\s])-\s*([A-Za-z][A-Za-z0-9]{1,15})$/.exec(stem) ??
      /-([A-Za-z][A-Za-z0-9]{1,15})$/.exec(stem) ??
      /[.\s]([A-Za-z][A-Za-z0-9]{1,15})$/.exec(stem);
    const candidate = match?.[1];
    if (!candidate || !/[A-Z]/.test(candidate)) continue;
    if (/^[Ss]\d{1,2}[Ee]\d{1,4}$/.test(candidate)) continue;
    if (NON_GROUP_TOKENS.has(candidate.toLowerCase())) continue;
    return candidate;
  }
  return undefined;
}

/** Last extension including the dot (`.mkv`), or empty. */
export function fileExtension(name: string): string {
  return /\.[A-Za-z0-9]+$/.exec(name)?.[0] ?? "";
}

export function fileNameStem(name: string): string {
  const extension = fileExtension(name);
  return extension ? name.slice(0, -extension.length) : name;
}

/** `.../x - S01E01.mp4` + 2 → `.../x - S01E01 - v2.mp4`. */
export function withCollisionSuffix(name: string, attempt: number): string {
  const extension = fileExtension(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} - v${attempt}${extension}`;
}

/**
 * A subtitle follows its renamed video, keeping any language infix
 * (`Show.sc.ass` → `<new video stem>.sc.ass`). Null when the subtitle was not
 * named after that video.
 */
export function alignSubtitleName(
  subtitleName: string,
  oldVideoName: string,
  newVideoName: string,
): string | null {
  const oldStem = fileNameStem(oldVideoName);
  if (!oldStem || !subtitleName.startsWith(`${oldStem}.`)) return null;
  return `${fileNameStem(newVideoName)}${subtitleName.slice(oldStem.length)}`;
}
