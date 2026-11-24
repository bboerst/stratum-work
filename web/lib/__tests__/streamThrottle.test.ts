import { describe, expect, it } from "vitest";
import { PoolStreamThrottle, poolThrottleFromEnv } from "../streamThrottle";
import { applyBurstMarker, BURST_DISPLAY_MS, BURST_EPISODE_GAP_MS, pruneBursts } from "../useDataStream";

const tpl = (pool: string, job: string) => JSON.stringify({ pool_name: pool, job_id: job });
const jobs = (msgs: string[]) => msgs.filter(m => !m.includes('"type":"burst"')).map(m => JSON.parse(m).job_id);
const markers = (msgs: string[]) => msgs.filter(m => m.includes('"type":"burst"')).map(m => JSON.parse(m));

describe("PoolStreamThrottle", () => {
  it("passes normal traffic untouched", () => {
    const t = new PoolStreamThrottle();
    const out: string[] = [];
    // A template every 2 s, and 15 at once at a new block.
    for (let s = 0; s < 120; s += 2) out.push(...t.offer("A", tpl("A", `j${s}`), s * 1000));
    for (let i = 0; i < 15; i++) out.push(...t.offer("A", tpl("A", `block${i}`), 121_000 + i));
    out.push(...t.tick(125_000));
    expect(jobs(out)).toHaveLength(60 + 15);
    expect(markers(out)).toHaveLength(0);
  });

  it("limits a flooding pool, keeps the newest, and reports what it held back", () => {
    const t = new PoolStreamThrottle({ ratePerSecond: 5, burst: 20 });
    const now = 1_000_000;
    let out: string[] = [];
    for (let i = 0; i < 3000; i++) out.push(...t.offer("F", tpl("F", `f${i}`), now + i / 3)); // 3000 in 1 s
    expect(jobs(out)).toHaveLength(20); // the burst allowance, then held
    for (let ms = 200; ms <= 2000; ms += 200) out.push(...t.tick(now + 1000 + ms));
    const shown = jobs(out);
    expect(shown[shown.length - 1]).toBe("f2999"); // the display ends on the newest template
    const reported = markers(out).reduce((n, m) => n + m.suppressed, 0);
    expect(shown.length + reported).toBe(3000); // every template is either shown or counted
    expect(markers(out).every(m => m.pool_name === "F")).toBe(true);
    // A second flood after ~1 s of refill: at most the burst allowance plus the rate over these ~2 s, out of 1000.
    out = [];
    for (let i = 0; i < 1000; i++) out.push(...t.offer("F", tpl("F", `g${i}`), now + 4000 + i));
    for (let ms = 200; ms <= 1000; ms += 200) out.push(...t.tick(now + 5000 + ms));
    expect(jobs(out).length).toBeLessThanOrEqual(20 + 5 * 2);
    expect(markers(out).length).toBeLessThanOrEqual(5); // at most one per tick that forwards a held template
  });

  it("sends the marker before a held template that follows skipped ones (change detection's gap signal)", () => {
    const t = new PoolStreamThrottle({ ratePerSecond: 5, burst: 2 });
    const out: string[] = [];
    for (let i = 0; i < 50; i++) out.push(...t.offer("F", tpl("F", `f${i}`), 1000 + i));
    for (let ms = 200; ms <= 3000; ms += 100) out.push(...t.tick(1000 + ms));
    // After the first skip, every forwarded template comes right after a marker.
    const firstHeld = out.findIndex(m => m.includes('"type":"burst"'));
    expect(firstHeld).toBeGreaterThan(-1);
    for (let i = firstHeld; i < out.length; i++) {
      if (!out[i].includes('"type":"burst"')) expect(out[i - 1]).toContain('"type":"burst"');
    }
  });

  it("throttles each pool on its own", () => {
    const t = new PoolStreamThrottle({ ratePerSecond: 5, burst: 20 });
    const out: string[] = [];
    for (let i = 0; i < 500; i++) out.push(...t.offer("F", tpl("F", `f${i}`), 1000 + i));
    for (let i = 0; i < 10; i++) out.push(...t.offer("N", tpl("N", `n${i}`), 1200 + i));
    expect(jobs(out).filter(j => j.startsWith("n"))).toHaveLength(10);
  });

  it("is a pass-through when disabled", () => {
    const t = new PoolStreamThrottle({ ratePerSecond: 0, burst: 1 });
    const out: string[] = [];
    for (let i = 0; i < 100; i++) out.push(...t.offer("F", tpl("F", `f${i}`), 1000));
    expect(out).toHaveLength(100);
    expect(t.tick(5000)).toHaveLength(0);
  });

  it("forgets idle pools (bounded memory)", () => {
    const t = new PoolStreamThrottle();
    t.offer("A", tpl("A", "x"), 0);
    t.tick(1000);
    t.tick(120_000);
    // A fresh state: the full burst allowance again.
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push(...t.offer("A", tpl("A", `y${i}`), 120_001));
    expect(out).toHaveLength(20);
  });
});

describe("poolThrottleFromEnv", () => {
  it("uses the defaults, accepts overrides, and 0 disables", () => {
    expect(poolThrottleFromEnv({})).toMatchObject({ ratePerSecond: 5, burst: 20 });
    expect(poolThrottleFromEnv({ STREAM_POOL_RATE: "50", STREAM_POOL_BURST: "200" })).toMatchObject({ ratePerSecond: 50, burst: 200 });
    expect(poolThrottleFromEnv({ STREAM_POOL_RATE: "0" }).ratePerSecond).toBe(0);
    expect(poolThrottleFromEnv({ STREAM_POOL_RATE: "nope", STREAM_POOL_BURST: "-3" })).toMatchObject({ ratePerSecond: 5, burst: 20 });
  });
});

describe("applyBurstMarker", () => {
  const m = (n: number, first: number, last: number) => ({ pool_name: "F", suppressed: n, first_ms: first, last_ms: last });
  it("adds up markers of one burst and starts over after a quiet gap", () => {
    let s = applyBurstMarker({}, m(100, 1, 2), 10_000);
    s = applyBurstMarker(s, m(50, 3, 4), 11_000);
    expect(s.F).toMatchObject({ suppressed: 150, firstMs: 1, lastMs: 4 });
    s = applyBurstMarker(s, m(7, 9, 9), 11_000 + BURST_EPISODE_GAP_MS + 1);
    expect(s.F).toMatchObject({ suppressed: 7, firstMs: 9 });
  });
});

describe("pruneBursts", () => {
  it("drops bursts past the display time and keeps the same object otherwise", () => {
    const s = applyBurstMarker({}, { pool_name: "F", suppressed: 1, first_ms: 0, last_ms: 0 }, 1000);
    expect(pruneBursts(s, 1000 + BURST_DISPLAY_MS - 1)).toBe(s);
    expect(pruneBursts(s, 1000 + BURST_DISPLAY_MS)).toEqual({});
  });
});
