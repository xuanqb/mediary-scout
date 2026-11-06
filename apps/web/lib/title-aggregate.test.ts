import { describe, expect, it } from "vitest";
import {
  aggregateAiring,
  aggregateStateFromSeasons,
  libraryWallAiring,
  libraryWallState,
  seasonBadgeState,
  type AggregateSeasonInput,
} from "./title-aggregate";

function season(overrides: Partial<AggregateSeasonInput>): AggregateSeasonInput {
  return {
    tracked: true,
    status: "completed",
    obtainedCount: 0,
    latestAiredEpisode: 13,
    totalEpisodes: 13,
    ...overrides,
  };
}

describe("aggregateStateFromSeasons", () => {
  it("untracked when no season is tracked", () => {
    expect(aggregateStateFromSeasons([season({ tracked: false, status: null })])).toBe(
      "untracked",
    );
  });

  it("complete when a completed season has all aired episodes obtained", () => {
    expect(aggregateStateFromSeasons([season({ obtainedCount: 13 })])).toBe("complete");
  });

  it("complete when resource is ahead (obtained >= aired)", () => {
    // 资源超前: 12 aired, 13 obtained.
    expect(
      aggregateStateFromSeasons([
        season({ obtainedCount: 13, latestAiredEpisode: 12, totalEpisodes: 13 }),
      ]),
    ).toBe("complete");
  });

  it("tracking when an active season is caught up to aired", () => {
    expect(
      aggregateStateFromSeasons([
        season({ status: "active", obtainedCount: 5, latestAiredEpisode: 5, totalEpisodes: 13 }),
      ]),
    ).toBe("tracking");
  });

  it("partial when an active season is behind aired", () => {
    expect(
      aggregateStateFromSeasons([
        season({ status: "active", obtainedCount: 3, latestAiredEpisode: 5, totalEpisodes: 13 }),
      ]),
    ).toBe("partial");
  });

  it("partial when some seasons are untracked", () => {
    expect(
      aggregateStateFromSeasons([
        season({ obtainedCount: 13 }),
        season({ tracked: false, status: null }),
      ]),
    ).toBe("partial");
  });

  // The regression that motivated this module: a FAILED/never-materialized
  // acquisition leaves a "completed" tracked season with 0 obtained and 0
  // materialized episode states. The old aggregate relied on missingAiredCount
  // (derived only from materialized episodes), which read 0 and falsely
  // reported "complete" → 已全部入库 for a 0/13 show. Must be "partial".
  it("partial when a completed season has 0 obtained and no materialized episodes", () => {
    expect(
      aggregateStateFromSeasons([
        season({ status: "completed", obtainedCount: 0, latestAiredEpisode: 13, totalEpisodes: 13 }),
      ]),
    ).toBe("partial");
  });
});

describe("aggregateAiring (orthogonal to completeness)", () => {
  it("true when any tracked season is still active, even while the title is 缺集", () => {
    // 斗破苍穹: S01 complete, S05 active but behind → partial AND airing.
    const seasons = [
      season({ status: "completed", obtainedCount: 13 }),
      season({ status: "active", obtainedCount: 100, latestAiredEpisode: 203, totalEpisodes: 999 }),
    ];
    expect(aggregateStateFromSeasons(seasons)).toBe("partial");
    expect(aggregateAiring(seasons)).toBe(true);
  });

  it("false when no tracked season is active (all completed)", () => {
    expect(aggregateAiring([season({ status: "completed", obtainedCount: 13 })])).toBe(false);
  });

  it("false when nothing is tracked", () => {
    expect(aggregateAiring([season({ tracked: false, status: null })])).toBe(false);
  });
});

describe("libraryWallAiring (orthogonal to completeness)", () => {
  it("true when released with an active season — pairs with partial for the dual badge", () => {
    expect(libraryWallAiring({ anyActive: true, unreleased: false })).toBe(true);
  });

  it("false for an unreleased (reserved) title even if flagged active", () => {
    expect(libraryWallAiring({ anyActive: true, unreleased: true })).toBe(false);
  });

  it("false when nothing is active", () => {
    expect(libraryWallAiring({ anyActive: false, unreleased: false })).toBe(false);
  });
});

describe("seasonBadgeState", () => {
  it("untracked when not tracked", () => {
    expect(seasonBadgeState(season({ tracked: false, status: null }))).toBe("untracked");
  });

  it("missing when a completed season has fewer obtained than aired (failed/0-materialized)", () => {
    // The season-row regression: 0/13 completed showed green 已完结 because
    // missingAiredCount read 0 from zero materialized episodes.
    expect(seasonBadgeState(season({ status: "completed", obtainedCount: 0 }))).toBe("missing");
  });

  it("missing when an active season is behind aired", () => {
    expect(
      seasonBadgeState(season({ status: "active", obtainedCount: 3, latestAiredEpisode: 5 })),
    ).toBe("missing");
  });

  it("airing when an active season is caught up to aired", () => {
    expect(
      seasonBadgeState(season({ status: "active", obtainedCount: 5, latestAiredEpisode: 5 })),
    ).toBe("airing");
  });

  it("complete when a completed season has all aired obtained", () => {
    expect(seasonBadgeState(season({ status: "completed", obtainedCount: 13 }))).toBe("complete");
  });

  it("complete when resource is ahead of aired", () => {
    expect(
      seasonBadgeState(season({ status: "completed", obtainedCount: 13, latestAiredEpisode: 12 })),
    ).toBe("complete");
  });

  it("not missing when Emby covers the aired remainder (even with 0 drive-obtained)", () => {
    expect(
      seasonBadgeState(season({ status: "completed", obtainedCount: 0, inEmbyCount: 13 })),
    ).toBe("complete");
    expect(
      seasonBadgeState(season({ status: "active", obtainedCount: 3, inEmbyCount: 2, latestAiredEpisode: 5 })),
    ).toBe("airing");
  });

  it("judges a 从第 N 集起 season on its subscription range only", () => {
    // 20 episodes, subscription from E11 → 10 in-scope aired episodes.
    const scoped = { startEpisode: 11, totalEpisodes: 20, latestAiredEpisode: 20 };
    expect(seasonBadgeState(season({ ...scoped, status: "completed", obtainedCount: 10 }))).toBe(
      "complete",
    );
    expect(seasonBadgeState(season({ ...scoped, status: "active", obtainedCount: 9 }))).toBe(
      "missing",
    );
    expect(
      aggregateStateFromSeasons([
        season({ ...scoped, status: "active", obtainedCount: 10 }),
      ]),
    ).toBe("tracking");
  });
});

describe("libraryWallState", () => {
  it("reserved when the title is unreleased — even though its movie anchor reads aired=1/obtained=0", () => {
    // 复仇者联盟5: future releaseDate, anchor aired=1 but unobtained. Without the
    // unreleased gate this falls into 'partial' (有缺集 ⚠️), the bug we're fixing.
    expect(libraryWallState({ obtained: 0, aired: 1, anyActive: false, unreleased: true })).toBe(
      "reserved",
    );
  });

  it("partial when released and obtained is behind aired", () => {
    expect(libraryWallState({ obtained: 4, aired: 6, anyActive: true, unreleased: false })).toBe(
      "partial",
    );
  });

  it("tracking when caught up but an active season remains", () => {
    expect(libraryWallState({ obtained: 6, aired: 6, anyActive: true, unreleased: false })).toBe(
      "tracking",
    );
  });

  it("complete when caught up and nothing active (e.g. an acquired movie)", () => {
    expect(libraryWallState({ obtained: 1, aired: 1, anyActive: false, unreleased: false })).toBe(
      "complete",
    );
  });
});
