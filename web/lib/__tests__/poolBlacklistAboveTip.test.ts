import { describe, it, expect, vi, afterEach } from "vitest";

// POOL_BLACKLIST is read when the module loads.
async function load(blacklist: string) {
  vi.resetModules();
  process.env.POOL_BLACKLIST = blacklist;
  return import("../poolBlacklist");
}

const templates = [{ pool_name: "Pool A" }, { pool_name: "Blocked Pool" }];
const name = (t: { pool_name: string }) => t.pool_name;

describe("filterBlacklistedAboveTip", () => {
  const saved = process.env.POOL_BLACKLIST;
  afterEach(() => {
    process.env.POOL_BLACKLIST = saved;
  });

  it("filters blacklisted pools above the tip (the current work)", async () => {
    const { filterBlacklistedAboveTip } = await load("Blocked Pool");
    expect(filterBlacklistedAboveTip(templates, 101, 100, name)).toEqual([{ pool_name: "Pool A" }]);
  });

  it("keeps them for mined heights (history for analysis)", async () => {
    const { filterBlacklistedAboveTip } = await load("Blocked Pool");
    expect(filterBlacklistedAboveTip(templates, 100, 100, name)).toEqual(templates);
    expect(filterBlacklistedAboveTip(templates, 42, 100, name)).toEqual(templates);
  });

  it("fails closed when the tip is unknown", async () => {
    const { filterBlacklistedAboveTip } = await load("Blocked Pool");
    expect(filterBlacklistedAboveTip(templates, 100, null, name)).toEqual([{ pool_name: "Pool A" }]);
    expect(filterBlacklistedAboveTip(templates, 100, undefined, name)).toEqual([{ pool_name: "Pool A" }]);
  });

  it("is a no-op without a blacklist", async () => {
    const { filterBlacklistedAboveTip } = await load("");
    expect(filterBlacklistedAboveTip(templates, 101, 100, name)).toBe(templates);
  });
});
