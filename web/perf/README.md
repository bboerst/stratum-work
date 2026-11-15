# Client performance harness (`npm run perf`)

The stream sends raw templates and the **browser does all the processing and drawing**, so what a page costs in CPU,
memory and main-thread blocking is user experience. This harness measures it, reproducibly, and CI reports it on every
pull request that touches `web/` (`.github/workflows/perf.yml`).

## What it does
- Drives Chromium (Playwright) against a **running production build**, with the CPU throttled (×4 by default) to stand
  in for an ordinary laptop.
- Answers every `/api` call from a **deterministic synthetic fixture** (`fixture.ts`): 30 made-up pools with realistic
  coinbases (height, a pushed clock on some pools, tags, extranonce, witness and merge-mining outputs) and shared merkle
  branches. No database, and no real data (this repository is public).
- Replays the live stream from a local SSE server at a fixed rate (10 templates/s), with a new block halfway through:
  every pool sends new work at once, as on the real site.
- Per page, median of several runs:

| Metric | Meaning |
|---|---|
| Load script (s) | Script time from navigation until settled (history pre-fill drawn) |
| Load longest task (ms) | Longest main-thread block while loading: a frozen page |
| Streaming CPU (%) | Main-thread busy share while the stream runs |
| Streaming long tasks / longest (ms) | Blocks > 50 ms while streaming: jank |
| FPS | Frames rendered while streaming |
| Heap (MB) / Heap growth (MB) | JS heap after GC at the end, and its growth over the streaming window (a leak signal) |
| DOM nodes | Size of the document |

## Run it
```bash
cd web
npm run build && npx next start -p 3100 -H 127.0.0.1 &
npm run perf -- --base-url http://127.0.0.1:3100              # all default pages
npm run perf -- --base-url http://127.0.0.1:3100 --pages /,/timing --runs 5 --stream 60
```
Playwright needs Chromium: `npx playwright install --with-deps chromium` (or run inside the
`mcr.microsoft.com/playwright` image of the same version).

Options: `--pages` (comma-separated paths), `--runs`, `--settle` / `--stream` (seconds), `--rate` (templates/s),
`--cpu` (throttling factor, 1 = off), `--out` (JSON), `--markdown`, `--label`, `--compare <base.json>` (marks changes
beyond noise with ⚠️ / ✅), `--profile <dir>` (CPU profiles of the load and stream phases; open them in Chrome DevTools,
and use a `next dev` server when you need readable function names).

## Comparing branches
Build both, serve them on two ports, and measure the base first:
```bash
npm run perf -- --base-url http://127.0.0.1:3102 --label main --out main.json
npm run perf -- --base-url http://127.0.0.1:3100 --label branch --compare main.json
```
CI does exactly this for each PR (base = the PR's base commit) and posts the table as a comment.

## When adding a page or visual
Add its path to the default `--pages` in `run.ts` if it's a primary view. If it needs another API, answer it in
`run.ts`'s route handler from the fixture. Follow the performance rules in `web/visuals/AGENTS.md`.
