// Deterministic, synthetic template data for the performance harness. Made-up pools and coinbases with a realistic
// shape (BIP34 height, a pushed clock on some pools, text tags, extranonce, witness commitment and merge-mining-style
// OP_RETURNs, merkle branches shared between pools), so every run of every branch sees the same work. Never real
// data: this repository is public.

export interface FixtureOptions {
  pools: number;
  /** Heights of history to pre-fill (the app keeps 3). */
  heights: number;
  /** Templates per pool per height in the pre-fill. */
  templatesPerHeight: number;
  seed: number;
}

export const DEFAULT_FIXTURE: FixtureOptions = { pools: 30, heights: 3, templatesPerHeight: 12, seed: 42 };

export const BASE_HEIGHT = 900_000;
/** Seconds between blocks in the fixture (the pre-fill spreads each height's templates over one interval). */
export const BLOCK_SECONDS = 600;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const hexOf = (n: number, bytes: number) => {
  let out = "";
  for (let i = 0; i < bytes; i++) out += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  return out;
};
const ascii = (s: string) => Buffer.from(s, "ascii").toString("hex");
const push = (hex: string) => (hex.length / 2).toString(16).padStart(2, "0") + hex;
const randHex = (r: () => number, bytes: number) => {
  let s = "";
  for (let i = 0; i < bytes; i++) s += Math.floor(r() * 256).toString(16).padStart(2, "0");
  return s;
};

export interface Template {
  pool_name: string;
  timestamp: string; // hex nanoseconds
  job_id: string;
  height: number;
  prev_hash: string;
  version: string;
  coinbase1: string;
  coinbase2: string;
  extranonce1: string;
  extranonce2_length: number;
  clean_jobs: boolean;
  merkle_branches: string[];
  nbits: string;
  ntime: string;
  lat_ms: number;
  lat_m: string;
}

export class Fixture {
  readonly opts: FixtureOptions;
  readonly pools: { name: string; clock: number | null; tag: string; en1: string; mm: boolean }[];
  private r: () => number;
  private branchPool: string[];
  private seq = 0;
  /** Anchored to the run's start, so time windows (e.g. the timing chart's) contain the data: the tip block was
   * mined 5 minutes before it. */
  readonly tipTimeS: number;

  constructor(opts: Partial<FixtureOptions> = {}, startS = Date.now() / 1000) {
    this.tipTimeS = Math.floor(startS) - 300;
    this.opts = { ...DEFAULT_FIXTURE, ...opts };
    this.r = rng(this.opts.seed);
    this.pools = Array.from({ length: this.opts.pools }, (_, i) => ({
      name: `Pool ${String(i + 1).padStart(2, "0")}`,
      clock: i % 3 === 0 ? [0, 20, -47, 2][i % 4] : null, // a third push a clock, with a per-pool offset
      tag: `/Synthetic Pool ${i + 1}/`,
      en1: randHex(this.r, 4),
      mm: i % 2 === 0,
    }));
    this.branchPool = Array.from({ length: 64 }, () => randHex(this.r, 32));
  }

  prevHash(height: number): string {
    return hexOf(height, 4).padEnd(64, "0");
  }

  /** One template of `pool` at `height`, received at `timeS` (Unix seconds, fractional). */
  template(poolIndex: number, height: number, timeS: number): Template {
    const p = this.pools[poolIndex];
    const r = this.r;
    const ntime = Math.floor(timeS);
    const sigBefore =
      push(hexOf(height, 3)) +
      (p.clock !== null ? push(hexOf(ntime + p.clock, 4)) : "") +
      push(ascii(p.tag)) +
      (p.mm ? push("fabe6d6d" + randHex(r, 32) + hexOf(8, 4) + hexOf(0, 4)) : "");
    const en2Len = 8;
    const sigLen = sigBefore.length / 2 + p.en1.length / 2 + en2Len + 4;
    const coinbase1 = hexOf(2, 4) + "01" + "00".repeat(32) + "ffffffff" + sigLen.toString(16).padStart(2, "0") + sigBefore;
    const outputs: string[] = [
      hexOf(312_500_000, 4) + "00000000" + push("0014" + randHex(r, 20)),
      "0000000000000000" + push("6a24aa21a9ed" + randHex(r, 32)),
    ];
    if (p.mm) outputs.push("0000000000000000" + push("6a" + push(ascii("RSKBLOCK:") + randHex(r, 32))));
    const coinbase2 = randHex(r, 4) + "ffffffff" + outputs.length.toString(16).padStart(2, "0") + outputs.join("") + "00000000";
    // 10-13 branches, mostly shared between pools at the same height (as real templates are)
    const branches = Array.from({ length: 10 + Math.floor(r() * 4) }, (_, k) =>
      this.branchPool[(height * 7 + k * 3 + (r() < 0.2 ? Math.floor(r() * 64) : 0)) % this.branchPool.length]
    );
    return {
      pool_name: p.name,
      timestamp: (BigInt(Math.round(timeS * 1e6)) * BigInt(1000)).toString(16),
      job_id: (++this.seq).toString(16),
      height,
      prev_hash: this.prevHash(height - 1),
      version: "20000000",
      coinbase1,
      coinbase2,
      extranonce1: p.en1,
      extranonce2_length: en2Len,
      clean_jobs: false,
      merkle_branches: branches,
      nbits: "17023a04",
      ntime: ntime.toString(16),
      lat_ms: 20 + Math.round(r() * 120),
      lat_m: "tcp",
    };
  }

  /** History rows already generated, so repeated pre-fill reads return identical templates. */
  private readonly history = new Map<string, Template>();

  /** The /api/realtime-prefill response: `heights` heights ending at the tip + 1, spread over 10-minute blocks. */
  prefill(nowS: number) {
    const tip = this.tipAt(nowS);
    const templates: Template[] = [];
    for (let h = tip - this.opts.heights + 2; h <= tip + 1; h++) {
      const start = this.blockTime(h - 1);
      for (let i = 0; i < this.opts.pools; i++) {
        for (let k = 0; k < this.opts.templatesPerHeight; k++) {
          const t = start + (k / this.opts.templatesPerHeight) * BLOCK_SECONDS + i * 0.05;
          if (t > nowS) continue;
          // The same row every time, as a database returns it (template() draws fresh random bytes on each call).
          const key = `${i}|${h}|${t}`;
          let row = this.history.get(key);
          if (!row) this.history.set(key, (row = this.template(i, h, t)));
          templates.push(row);
        }
      }
    }
    return {
      enabled: true,
      tip: { height: tip, timestamp: this.blockTime(tip) },
      heights: Array.from({ length: this.opts.heights }, (_, k) => tip + 1 - k),
      templates,
    };
  }

  /** When block `h` was mined: the tip at tipTimeS, earlier ones every BLOCK_SECONDS, later ones on the same grid. */
  blockTime(h: number) {
    return this.tipTimeS + (h - BASE_HEIGHT) * BLOCK_SECONDS;
  }

  tipAt(nowS: number) {
    return BASE_HEIGHT + Math.floor((nowS - this.tipTimeS) / BLOCK_SECONDS);
  }

  /**
   * /api/forks: 36 synthetic episodes over 90 days (a little over the default 6 epochs), a mix of the kinds (block
   * races across many pools on recorded and unrecorded stale blocks, short bursts of another chain on one pool, invalid
   * parents), some with an invalid-coinbase badge. Its own random stream, so the other fixtures don't change.
   */
  unknownParents(nowS: number) {
    const r = rng(this.opts.seed + 7);
    const end = nowS * 1000, start = end - 90 * 86_400_000;
    const tip = this.tipAt(nowS);
    const episodes = Array.from({ length: 36 }, (_, i) => {
      const kind = i % 6 === 5 ? "invalid_parent" : i % 6 === 1 ? "stale" : i % 6 === 4 ? "bitcoin_block" : "other_chain";
      const first = Math.floor(start + ((i + r()) / 36) * (end - start));
      const duration = Math.floor((kind === "other_chain" ? 10 + r() * 170 : 30 + r() * 600) * 1000);
      const n = kind === "other_chain" ? 1 : 1 + Math.floor(r() * 12);
      const pools = Array.from({ length: n }, (_, k) => ({
        pool: this.pools[kind === "other_chain" ? 0 : (k * 7 + i) % this.opts.pools].name,
        connections: k % 3 === 0 ? ["a"] : ["a", "b"], templates: 1 + Math.floor(r() * 40),
      }));
      const height = kind === "other_chain" ? 6_000_000 + i * 3 : tip - 13_000 + i * 320;
      const offset = kind === "other_chain" ? height - 1 - (tip - 13_000 + i * 320) : 0;
      return {
        parent: (kind === "invalid_parent" ? "ff".repeat(28) : "00".repeat(9) + randHex(r, 19)) + hexOf(i, 4),
        height, heights: [height], pools, first_ms: first, last_ms: first + duration, duration_ms: duration,
        templates: pools.reduce((s, p) => s + p.templates, 0), auxpow_templates: 0, auxpow_share: 0,
        facts: {
          tip_at_first: height - 1 - offset, tip_at_last: height - 1 - offset, tip_offset: offset,
          nbits: [kind === "other_chain" ? "1a0abcde" : "17030ecd"],
          bitcoin_bits: kind === "other_chain" ? null : "17030ecd", bitcoin_bits_at: null,
          bitcoin_difficulty: kind === "other_chain" ? null : true, pow_ok: kind !== "invalid_parent",
          pow_bits: kind === "other_chain" ? "1a0abcde" : "17030ecd", in_stale_blocks: kind === "stale",
          stale_block: kind === "stale" ? { height: height - 1, header_source: "node", miner: pools[0].pool } : null,
        },
        kind,
        invalid_coinbase: kind === "stale" && i % 4 === 1 ? { height, pools: pools.slice(0, 2).map((p) => ({
          pool: p.pool, templates: 2, total_sats: 328_466_550, subsidy_sats: 312_500_000 })) } : null,
      };
    });
    return {
      enabled: true, supported: true, range: "6e", blocks: 12_096, tip_height: tip, from_height: tip - 12_096,
      generated_at: end, episodes,
    };
  }

  /**
   * /api/forks?view=strip: 90 races and invalid rows over 65 epochs (all history), as the page's strip reads them.
   */
  /** /api/off-mempool: 6 epochs of blocks (the default range), the record covering all of it, a few gaps. */
  offMempool(nowS: number) {
    const r = rng(this.opts.seed + 13);
    const tip = this.tipAt(nowS), from = tip - 6 * 2016;
    const rows = [];
    for (let h = from; h <= tip; h++) {
      const txs = 1000 + Math.floor(r() * 5000);
      const roll = r();
      const state = roll < 0.002 ? 1 : roll < 0.004 ? 3 : 0;
      const off = state !== 0 ? null : roll > 0.97 ? Math.floor(txs * r()) : Math.floor(r() * 3);
      rows.push([h, `Pool ${h % 17}`, state === 1 ? null : txs, off, state, Math.floor(this.blockTime(h))]);
    }
    return { enabled: true, supported: true, range: "6e", tip_height: tip, from_height: from, record_from: from,
      after_gap_blocks: 6, generated_at: nowS * 1000, rows };
  }

  forksStrip(nowS: number) {
    const r = rng(this.opts.seed + 11);
    const tip = this.tipAt(nowS), from = tip - 65 * 2016;
    const rows = Array.from({ length: 90 }, (_, i) => {
      const pos = from + Math.floor(((i + r()) / 90) * (tip - from));
      const kind = i % 23 === 7 ? "invalid_parent" : i % 19 === 3 ? "bitcoin_block" : "stale";
      return [pos, pos, kind, i % 9 === 4 ? 1 : 0, "00".repeat(28) + hexOf(i, 4)];
    });
    for (const e of this.unknownParents(nowS).episodes) {
      if (e.kind !== "other_chain") rows.push([e.facts.tip_at_first + 1, e.height, e.kind, e.invalid_coinbase ? 1 : 0, e.parent]);
    }
    return { enabled: true, supported: true, tip_height: tip, from_height: from, generated_at: nowS * 1000,
      other_chain_epochs: [Math.floor((tip - 3000) / 2016)], rows };
  }

  /**
   * /api/forks/timeline?height=…: one race's runs, as the server sends them: about 30 pools, most on the block that
   * stayed, a few on the stale one, some switching, one with a run of invalid work.
   */
  forkLanes(nowS: number, height: number) {
    const r = rng(this.opts.seed + height);
    const active = this.prevHash(height - 1), stale = "00".repeat(9) + randHex(r, 19) + "0000";
    const lanes = Array.from({ length: Math.min(30, this.opts.pools) }, (_, k) => {
      const start = Math.floor(r() * 3000), onStale = k % 5 === 0;
      const runs: [number, number, 0 | 1][] = [[start, onStale ? 1 : 0, 0]];
      if (k % 7 === 3) runs.push([start + 1000, onStale ? 1 : 0, 1], [start + 20_000, onStale ? 1 : 0, 0]);
      if (onStale && k % 10 === 0) runs.push([start + 40_000 + Math.floor(r() * 20_000), 0, 0]);
      return { pool: this.pools[k].name, runs, end: 70_000 + Math.floor(r() * 20_000) };
    });
    return {
      height, active, from_ms: this.blockTime(height - 1) * 1000, last_ms: 80_000,
      parents: [{ hash: active, status: "canonical", kind: null }, { hash: stale, status: "stale", kind: null }],
      lanes, blocks: [{ hash: active, height: height - 1, seen_ms: this.blockTime(height - 1) * 1000, best: true, miner: this.pools[1].name }],
    };
  }

  /** /api/forks?parent=…: the episode's pools, a template every 5 s each over its minutes ± 5 (thousands). */
  unknownParentDrill(nowS: number, parent: string) {
    const summary = this.unknownParents(nowS);
    const episode = summary.episodes.find((e) => e.parent === parent);
    if (!episode) return { error: "no such episode" };
    const from_ms = episode.first_ms - 300_000, to_ms = episode.last_ms + 300_000;
    const labels = ["best", "this", "best"] as const;
    const templates = [];
    for (const [pi, p] of episode.pools.entries()) {
      for (let t = from_ms + pi * 300; t <= to_ms; t += 5000) {
        const phase = t < episode.first_ms ? 0 : t <= episode.last_ms ? 1 : 2;
        templates.push({
          id: `${pi}-${t}`, pool_name: p.pool, parent: labels[phase], connections: p.connections,
          height: episode.height - 1 + phase, received_at: t, copies: p.connections.length, prev_hash: parent,
          version: "20000000", nbits: "17030ecd", ntime: Math.floor(t / 1000).toString(16), clean_jobs: true,
          extranonce1: "00000000", extranonce2_length: 4, merkle_branches: 12, coinbase_ok: true, scriptsig_height: episode.height,
          coinbase_tags: `/Synthetic Pool ${pi + 1}/`, auxpow: false, auxpow_root: null, auxpow_merkle_size: null,
          outputs: [{ value: 312_500_000, script_hex: "0014" + "11".repeat(20) }], output_total: 312_500_000,
        });
      }
    }
    templates.sort((a, b) => a.received_at - b.received_at);
    return {
      enabled: true, supported: true, episode, from_ms, to_ms, templates, truncated: false,
      blocks: [{ hash: this.prevHash(episode.height - 1), height: episode.height - 1, arrival_ms: episode.first_ms - 2000, best: true }],
    };
  }

  /** /api/blocks?n=… : the last n blocks up to the tip. */
  blocks(nowS: number, n: number) {
    const tip = this.tipAt(nowS);
    const blocks = Array.from({ length: n }, (_, k) => {
      const h = tip - k;
      return {
        height: h,
        block_hash: this.prevHash(h),
        timestamp: this.blockTime(h),
        mining_pool: { name: this.pools[h % this.opts.pools].name },
        transactions: 3000,
        size: 1_500_000,
        weight: 3_990_000,
      };
    });
    return { blocks, has_more: true, next_height: tip - n };
  }
}
