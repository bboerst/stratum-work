// npm run perf: measures what the app costs the viewer's browser (#157, client performance principle).
//
// The stream sends raw templates and the browser does all processing and drawing, so CPU, memory and main-thread
// blocking are UX. This drives Chromium (CPU throttled to stand in for an ordinary laptop) against a running build,
// with every /api call answered from a deterministic synthetic fixture and the live stream replayed at a fixed rate,
// so runs are comparable across branches. See perf/README.md.

import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { Fixture } from "./fixture";
import { aggregate, schedule, type Side } from "./interleave";
import { markdown, type PageMetrics, type Results } from "./report";

interface Options {
  baseUrl: string;
  pages: string[];
  runs: number;
  settleSeconds: number;
  streamSeconds: number;
  rate: number; // templates per second on the replayed stream
  cpu: number; // CPU throttling factor
  out: string;
  markdown?: string;
  compare?: string;
  label?: string;
  /** A second running build (the base) measured in the same process, alternating with --base-url run by run. */
  compareUrl?: string;
  compareLabel?: string;
  compareOut: string;
  /** Write CPU profiles of each page's load and stream phases to <dir>/<page>-{load,stream}.cpuprofile (Chrome DevTools). */
  profile?: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    baseUrl: process.env.PERF_BASE_URL ?? "http://127.0.0.1:3000",
    pages: ["/", "/timing", "/sankey", "/v/pool-clocks", "/unknown-parents"],
    runs: 3,
    settleSeconds: 5,
    streamSeconds: 30,
    rate: 10,
    cpu: 4,
    out: "perf-results.json",
    compareOut: "perf-compare.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    const take = () => {
      i++;
      return v;
    };
    if (k === "--base-url") o.baseUrl = take();
    else if (k === "--pages") o.pages = take().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--runs") o.runs = Number(take());
    else if (k === "--settle") o.settleSeconds = Number(take());
    else if (k === "--stream") o.streamSeconds = Number(take());
    else if (k === "--rate") o.rate = Number(take());
    else if (k === "--cpu") o.cpu = Number(take());
    else if (k === "--out") o.out = take();
    else if (k === "--markdown") o.markdown = take();
    else if (k === "--compare") o.compare = take();
    else if (k === "--label") o.label = take();
    else if (k === "--compare-url") o.compareUrl = take();
    else if (k === "--compare-label") o.compareLabel = take();
    else if (k === "--compare-out") o.compareOut = take();
    else if (k === "--profile") o.profile = take();
    else throw new Error(`unknown argument ${k}`);
  }
  if (o.compare && o.compareUrl) throw new Error("--compare (a results file) and --compare-url (a running build) are exclusive");
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error("--runs must be a positive integer");
  return o;
}

// ── replayed stream ─────────────────────────────────────────────────────────────────────────────────────────────

/** SSE server replaying fixture templates at `rate`/s; halfway through, a new block: every pool sends new work. */
function startReplay(fixture: Fixture, rate: number, blockAfterS: number) {
  const clients = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify({ type: "connection", status: "connected" })}\n\n`);
    const started = Date.now() / 1000;
    let sent = 0;
    let blockDone = false;
    const timer = setInterval(() => {
      const now = Date.now() / 1000;
      const elapsed = now - started;
      const height = fixture.tipAt(now) + 1 + (elapsed >= blockAfterS ? 1 : 0);
      if (elapsed >= blockAfterS && !blockDone) {
        blockDone = true;
        for (let i = 0; i < fixture.opts.pools; i++) res.write(`data: ${JSON.stringify({ ...fixture.template(i, height, now), clean_jobs: true })}\n\n`);
      }
      const due = Math.floor(elapsed * rate);
      for (; sent < due; sent++) res.write(`data: ${JSON.stringify(fixture.template(sent % fixture.opts.pools, height, now))}\n\n`);
    }, 50);
    clients.add(res);
    req.on("close", () => {
      clearInterval(timer);
      clients.delete(res);
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/stream`,
        close: () => {
          for (const c of clients) c.end();
          server.close();
        },
      });
    })
  );
}

// ── one measurement ─────────────────────────────────────────────────────────────────────────────────────────────


const INIT = `
  window.__perf = { lt: [], frames: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lt.push([e.startTime, e.duration]); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
  const tick = () => { window.__perf.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
`;

// /api/tx answers for any txid: in the mempool, with a fee rate derived from the txid (deterministic, synthetic)
function syntheticTxs(txids: string) {
  return txids.split(",").filter(Boolean).map((txid) => {
    const rate = 1 + (parseInt(txid.slice(0, 6), 16) % 2000) / 10;
    return { txid, found: true, status: "in_mempool", fee: Math.round(rate * 141), vsize: 141, weight: 564,
      fee_rate: rate, ancestor_fee_rate: rate, effective_fee_rate: rate, ancestor_count: 1, descendant_count: 1,
      first_seen: Date.now() - 60_000, first_seen_src: "zmq", removal: null, offmempool: null };
  });
}

// Requests to /api/tx and to mempool.space (base builds look fee rates up there), per page and side
interface FeeLookups {
  tx: number;
  mempoolSpace: number;
}

/** What one measurement runs against: a build's URL, where its CPU profiles go, and its fee-lookup counters. */
interface Target {
  baseUrl: string;
  profile?: string;
  lookups: FeeLookups;
}

async function measure(browser: Browser, o: Options, t: Target, fixture: Fixture, streamUrl: string, path: string): Promise<PageMetrics> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();
  await page.addInitScript(INIT);
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "mempool.space") t.lookups.mempoolSpace++;
    const nowS = Date.now() / 1000;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    switch (url.pathname) {
      case "/api/runtime-config":
        // Fee rates from this deployment's /api/tx (#198), as a Postgres deployment serves them
        return json({ streamEndpoint: streamUrl, historicalDataEnabled: true, txApi: { source: "local", mempoolSpaceFallback: false } });
      case "/api/tx":
        t.lookups.tx++;
        return json({ enabled: true, supported: true, txs: syntheticTxs(url.searchParams.get("txids") ?? "") });
      case "/api/realtime-prefill":
        return json(fixture.prefill(nowS));
      case "/api/blocks":
        return json(fixture.blocks(nowS, Math.min(Number(url.searchParams.get("n") ?? 20), 50)));
      case "/api/analysis-data":
        return json(url.searchParams.get("interesting") ? { items: [] } : { results: [] });
      case "/api/unknown-parents": {
        const parent = url.searchParams.get("parent");
        return json(parent ? fixture.unknownParentDrill(nowS, parent) : fixture.unknownParents(nowS));
      }
      case "/api/stream":
        return route.abort();
      default:
        return json([]);
    }
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (o.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: o.cpu });
  const metrics = async () =>
    Object.fromEntries(((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await metrics()).JSHeapUsedSize / 1e6;
  };

  if (t.profile) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  await page.goto(t.baseUrl + path, { waitUntil: "load" });
  await page.waitForTimeout(o.settleSeconds * 1000);
  if (t.profile) {
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown };
    mkdirSync(t.profile, { recursive: true });
    writeFileSync(`${t.profile}/${path.replace(/[^a-z0-9]+/gi, "_") || "root"}-load.cpuprofile`, JSON.stringify(profile));
    await cdp.send("Profiler.start");
  }
  const m1 = await metrics();
  const loadEndMs = await page.evaluate(() => performance.now());
  const heap1 = await heap();
  const frames0 = await page.evaluate(() => (window as unknown as { __perf: { frames: number } }).__perf.frames);
  await page.waitForTimeout(o.streamSeconds * 1000);
  const frames1 = await page.evaluate(() => (window as unknown as { __perf: { frames: number } }).__perf.frames);
  if (t.profile) {
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown };
    writeFileSync(`${t.profile}/${path.replace(/[^a-z0-9]+/gi, "_") || "root"}-stream.cpuprofile`, JSON.stringify(profile));
  }
  const heap2 = await heap();
  const m2 = await metrics();
  const lt = await page.evaluate(() => (window as unknown as { __perf: { lt: [number, number][] } }).__perf.lt);
  await ctx.close();

  const loadLt = lt.filter(([s]) => s < loadEndMs).map(([, d]) => d);
  const streamLt = lt.filter(([s]) => s >= loadEndMs).map(([, d]) => d);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return {
    loadScriptS: m1.ScriptDuration,
    loadLongestTaskMs: loadLt.length ? Math.max(...loadLt) : 0,
    loadLongTasksMs: sum(loadLt),
    streamCpuPct: ((m2.TaskDuration - m1.TaskDuration) / o.streamSeconds) * 100,
    streamLongTasks: streamLt.length,
    streamLongestTaskMs: streamLt.length ? Math.max(...streamLt) : 0,
    fps: (frames1 - frames0) / o.streamSeconds,
    heapMB: heap2,
    heapGrowthMB: heap2 - heap1,
    domNodes: m2.Nodes,
  };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const sides: Side[] = o.compareUrl ? ["compare", "primary"] : ["primary"];
  // With two builds, profiles go to <dir>/primary and <dir>/compare so the sides don't overwrite each other
  const profileDir = (side: Side) => (o.profile && o.compareUrl ? `${o.profile}/${side}` : o.profile);
  const targets = {} as Record<Side, Target>;
  for (const side of sides) {
    const baseUrl = side === "primary" ? o.baseUrl : o.compareUrl!;
    targets[side] = { baseUrl, profile: profileDir(side), lookups: { tx: 0, mempoolSpace: 0 } };
  }
  const fixture = new Fixture();
  const replay = await startReplay(fixture, o.rate, o.settleSeconds + o.streamSeconds / 2);
  const browser = await chromium.launch();
  const pages = { primary: {}, compare: {} } as Record<Side, Record<string, PageMetrics>>;
  try {
    const steps = schedule(o.pages, o.runs, Boolean(o.compareUrl));
    for (const path of o.pages) {
      const runs = { primary: [], compare: [] } as Record<Side, PageMetrics[]>;
      for (const side of sides) targets[side].lookups = { tx: 0, mempoolSpace: 0 };
      for (const step of steps.filter((s) => s.path === path)) {
        runs[step.side].push(await measure(browser, o, targets[step.side], fixture, replay.url, path));
      }
      for (const side of sides) {
        const { tx, mempoolSpace } = targets[side].lookups;
        // Fee-rate lookups the page made (not a metric: base and branch builds may use different sources)
        if (tx || mempoolSpace) {
          const who = o.compareUrl ? ` (${side === "primary" ? o.label ?? "primary" : o.compareLabel ?? "compare"})` : "";
          console.error(`${path}${who}: fee-rate requests per run: /api/tx ${tx / o.runs}, mempool.space ${mempoolSpace / o.runs}`);
        }
        pages[side][path] = aggregate(runs[side]);
      }
      console.error(`measured ${path}`);
    }
  } finally {
    await browser.close();
    replay.close();
  }
  const { out, markdown: md, compare, compareUrl, compareLabel, compareOut, ...options } = o;
  const results: Results = { label: o.label, options: { ...options, ...(compareUrl ? { interleaved: true } : {}) }, pages: pages.primary };
  writeFileSync(out, JSON.stringify(results, null, 2));
  let base: Results | undefined;
  if (compareUrl) {
    // The compare side's own results, in the same format as a separate run, so it can be fed to --compare later
    base = { label: compareLabel, options: { ...results.options, baseUrl: compareUrl }, pages: pages.compare };
    writeFileSync(compareOut, JSON.stringify(base, null, 2));
  } else if (compare) {
    base = JSON.parse(readFileSync(compare, "utf8")) as Results;
  }
  const text = markdown(results, base);
  if (md) writeFileSync(md, text + "\n");
  console.log(text);
}

if (process.argv[1] && /run\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
