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
  /** Write CPU profiles of each page's load and stream phases to <dir>/<page>-{load,stream}.cpuprofile (Chrome DevTools). */
  profile?: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    baseUrl: process.env.PERF_BASE_URL ?? "http://127.0.0.1:3000",
    pages: ["/", "/timing", "/sankey", "/v/pool-clocks"],
    runs: 3,
    settleSeconds: 5,
    streamSeconds: 30,
    rate: 10,
    cpu: 4,
    out: "perf-results.json",
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
    else if (k === "--profile") o.profile = take();
    else throw new Error(`unknown argument ${k}`);
  }
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

export interface PageMetrics {
  loadScriptS: number; // script time until settled
  loadLongestTaskMs: number;
  loadLongTasksMs: number; // total long-task time until settled
  streamCpuPct: number; // main-thread busy share while streaming
  streamLongTasks: number;
  streamLongestTaskMs: number;
  fps: number;
  heapMB: number; // after GC, end of the stream window
  heapGrowthMB: number; // over the stream window, after GC (leak signal)
  domNodes: number;
}

const INIT = `
  window.__perf = { lt: [], frames: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lt.push([e.startTime, e.duration]); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
  const tick = () => { window.__perf.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
`;

async function measure(browser: Browser, o: Options, fixture: Fixture, streamUrl: string, path: string): Promise<PageMetrics> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();
  await page.addInitScript(INIT);
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const nowS = Date.now() / 1000;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    switch (url.pathname) {
      case "/api/runtime-config":
        return json({ streamEndpoint: streamUrl, historicalDataEnabled: true });
      case "/api/realtime-prefill":
        return json(fixture.prefill(nowS));
      case "/api/blocks":
        return json(fixture.blocks(nowS, Math.min(Number(url.searchParams.get("n") ?? 20), 50)));
      case "/api/analysis-data":
        return json(url.searchParams.get("interesting") ? { items: [] } : { results: [] });
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

  if (o.profile) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  await page.goto(o.baseUrl + path, { waitUntil: "load" });
  await page.waitForTimeout(o.settleSeconds * 1000);
  if (o.profile) {
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown };
    mkdirSync(o.profile, { recursive: true });
    writeFileSync(`${o.profile}/${path.replace(/[^a-z0-9]+/gi, "_") || "root"}-load.cpuprofile`, JSON.stringify(profile));
    await cdp.send("Profiler.start");
  }
  const m1 = await metrics();
  const loadEndMs = await page.evaluate(() => performance.now());
  const heap1 = await heap();
  const frames0 = await page.evaluate(() => (window as unknown as { __perf: { frames: number } }).__perf.frames);
  await page.waitForTimeout(o.streamSeconds * 1000);
  const frames1 = await page.evaluate(() => (window as unknown as { __perf: { frames: number } }).__perf.frames);
  if (o.profile) {
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown };
    writeFileSync(`${o.profile}/${path.replace(/[^a-z0-9]+/gi, "_") || "root"}-stream.cpuprofile`, JSON.stringify(profile));
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

// ── reporting ───────────────────────────────────────────────────────────────────────────────────────────────────

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

type Results = { label?: string; options: Omit<Options, "out" | "markdown" | "compare">; pages: Record<string, PageMetrics> };

const COLUMNS: { key: keyof PageMetrics; title: string; digits: number; higherIsWorse: boolean; noise: number }[] = [
  { key: "loadScriptS", title: "Load script (s)", digits: 2, higherIsWorse: true, noise: 0.1 },
  { key: "loadLongestTaskMs", title: "Load longest task (ms)", digits: 0, higherIsWorse: true, noise: 50 },
  { key: "streamCpuPct", title: "Streaming CPU (%)", digits: 1, higherIsWorse: true, noise: 2 },
  { key: "streamLongTasks", title: "Streaming long tasks", digits: 0, higherIsWorse: true, noise: 2 },
  { key: "streamLongestTaskMs", title: "Streaming longest task (ms)", digits: 0, higherIsWorse: true, noise: 50 },
  { key: "fps", title: "FPS", digits: 0, higherIsWorse: false, noise: 3 },
  { key: "heapMB", title: "Heap (MB)", digits: 1, higherIsWorse: true, noise: 1 },
  { key: "heapGrowthMB", title: "Heap growth (MB)", digits: 1, higherIsWorse: true, noise: 1 },
  { key: "domNodes", title: "DOM nodes", digits: 0, higherIsWorse: true, noise: 100 },
];

export function markdown(r: Results, base?: Results): string {
  const o = r.options;
  const lines = [
    `**Client performance** (median of ${o.runs} runs; Chromium, CPU ×${o.cpu}; ${o.settleSeconds} s settle, then ${o.streamSeconds} s of stream at ${o.rate} templates/s with a new block halfway${base ? `; compared with ${base.label ?? "base"}` : ""})`,
    "",
    `| Page | ${COLUMNS.map((c) => c.title).join(" | ")} |`,
    `|---|${COLUMNS.map(() => "---:").join("|")}|`,
  ];
  let worse = 0;
  for (const [path, m] of Object.entries(r.pages)) {
    const cells = COLUMNS.map((c) => {
      const v = m[c.key];
      let cell = v.toFixed(c.digits);
      const b = base?.pages[path]?.[c.key];
      if (b !== undefined) {
        const d = v - b;
        if (Math.abs(d) > c.noise) {
          const bad = c.higherIsWorse ? d > 0 : d < 0;
          if (bad) worse++;
          cell += ` (${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(c.digits)} ${bad ? "⚠️" : "✅"})`;
        }
      }
      return cell;
    });
    lines.push(`| \`${path}\` | ${cells.join(" | ")} |`);
  }
  if (base) lines.push("", worse ? `⚠️ ${worse} metric(s) worse than ${base.label ?? "base"} beyond noise.` : `No metric worse than ${base.label ?? "base"} beyond noise.`);
  lines.push("", "Long task: main thread blocked > 50 ms. Heap growth: after GC, over the streaming window (a leak signal). Lower is better except FPS.");
  return lines.join("\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const fixture = new Fixture();
  const replay = await startReplay(fixture, o.rate, o.settleSeconds + o.streamSeconds / 2);
  const browser = await chromium.launch();
  const pages: Record<string, PageMetrics> = {};
  try {
    for (const path of o.pages) {
      const runs: PageMetrics[] = [];
      for (let i = 0; i < o.runs; i++) runs.push(await measure(browser, o, fixture, replay.url, path));
      pages[path] = Object.fromEntries(
        (Object.keys(runs[0]) as (keyof PageMetrics)[]).map((k) => [k, median(runs.map((r) => r[k]))])
      ) as unknown as PageMetrics;
      console.error(`measured ${path}`);
    }
  } finally {
    await browser.close();
    replay.close();
  }
  const { out, markdown: md, compare, ...options } = o;
  const results: Results = { label: o.label, options, pages };
  writeFileSync(out, JSON.stringify(results, null, 2));
  const base = compare ? (JSON.parse(readFileSync(compare, "utf8")) as Results) : undefined;
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
