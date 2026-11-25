import { describe, it, expect } from "vitest";
import { clockGroups, poolClocks, templatePushedTime } from "../pool-clocks/selectors";
import type { BufferedTemplate } from "@/lib/templateBuffer";
import type { StratumV1Data } from "@/lib/types";

const le32 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]).toString("hex");
const push = (hex: string) => (hex.length / 2).toString(16).padStart(2, "0") + hex;
const tag = Buffer.from("/Example/", "ascii").toString("hex");

// A minimal valid coinbase split at the extranonce, optionally pushing `poolTime` after the height.
function template(pool: string, ntime: number, receivedMs: number, poolTime?: number): BufferedTemplate {
  const sigBefore = "03" + "1ce40e" + (poolTime !== undefined ? push(le32(poolTime)) : "") + push(tag);
  const en1 = "a1b2c3d4";
  const sigLen = sigBefore.length / 2 + 4 + 8;
  const coinbase1 = le32(2) + "01" + "00".repeat(32) + "ffffffff" + sigLen.toString(16).padStart(2, "0") + sigBefore;
  const coinbase2 = "ffffffff" + "01" + "0000000000000000" + "16" + "0014" + "11".repeat(20) + "00000000";
  const data = {
    pool_name: pool, timestamp: "", job_id: "j", height: 975_900, prev_hash: "00", version: "20000000",
    coinbase1, coinbase2, extranonce1: en1, extranonce2_length: 8, clean_jobs: false, first_transaction: "",
    fee_rate: "", merkle_branches: [], ntime: ntime.toString(16),
  } as StratumV1Data;
  return { key: `${pool}-${receivedMs}`, seq: receivedMs, timeMs: receivedMs, recvMs: receivedMs, data, segs: [] };
}

const T = 1_789_000_000;

describe("pool clocks", () => {
  it("reads the pushed time, only when close to ntime", () => {
    expect(templatePushedTime(template("A", T, 0, T + 20).data)).toBe(T + 20);
    expect(templatePushedTime(template("A", T, 0).data)).toBeNull();
    expect(templatePushedTime(template("A", T, 0, T + 86_400).data)).toBeNull(); // a day off: not a clock
  });

  it("computes per-pool offsets against ntime or receive time, and lists pools without a clock", () => {
    const ts = [
      template("A", T, (T + 1) * 1000, T + 20),
      template("A", T + 30, (T + 31) * 1000, T + 50),
      template("B", T, (T + 0.5) * 1000, T - 47),
      template("C", T, T * 1000),
    ];
    const byNtime = poolClocks(ts, "ntime");
    expect(byNtime.pools.map((p) => [p.pool, p.median])).toEqual([["B", -47], ["A", 20]]);
    expect(byNtime.withoutClock).toEqual(["C"]);
    const a = byNtime.pools.find((p) => p.pool === "A")!;
    expect([a.min, a.max, a.coverage, a.samples.length]).toEqual([20, 20, 1, 2]);

    const byReceived = poolClocks(ts, "received");
    expect(byReceived.pools.find((p) => p.pool === "A")!.median).toBe(19); // pool time - (receive time in s)
    expect(byReceived.pools.find((p) => p.pool === "B")!.median).toBe(-47.5);
    expect(poolClocks(ts, "ntime", "name").pools.map((p) => p.pool)).toEqual(["A", "B"]);
  });

  it("reports partial coverage when only some jobs carry a time", () => {
    const r = poolClocks([template("A", T, 0, T + 1), template("A", T, 1)], "ntime");
    expect(r.pools[0].coverage).toBe(0.5);
  });

  it("groups pools with similar medians", () => {
    const mk = (pool: string, median: number) => ({ pool, median, samples: [], min: median, max: median, coverage: 1 });
    expect(clockGroups([mk("a", 0), mk("b", 0.5), mk("c", 20), mk("d", 21), mk("e", -47)], 2)).toEqual([["a", "b"], ["c", "d"]]);
    expect(clockGroups([mk("a", 0), mk("b", 5)], 2)).toEqual([]);
  });
});
