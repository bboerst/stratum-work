# site-compare: does a new site show the same data as the current one?

Before switching a deployment to a new stack (another database, other collectors, collectors at another location),
this tool checks that the new site (**B**) shows the same data as the current one (**A**), height by height, and
lists every difference with a classification. It only uses the sites' **public HTTP API** (`web/app/api`): no
database access, no credentials. Base URLs are arguments.

## What it compares
For a height range (default: from the first height B has data for, up to the lower of the two tips):

| What | Route | How |
|---|---|---|
| Blocks | `/api/blocks?after=…&n=…` (R5) | Per height: the set of block hashes; for a common hash every field except the ids (`_id`/`id` differ by design), with object keys compared order-insensitively. Differences are grouped as pool identification (`mining_pool`, `analysis.pool_identification`), analysis, coinbase, other fields |
| Templates | `/api/mining-notify?height=h` (R1) | Matched by job key, per pool and height (below) |
| First seen per block | `/api/block-pool-first-seen?height=h` (R4) | Pool sets, the order of the pools both sides have (discordant pairs, Kendall tau), the `reliable` flag, and the first-seen difference per pool |
| Pools list | `/api/pools` (R7) | By name: present on one side only, tag and address differences. Ids and order differ by design |
| Interesting blocks | `/api/analysis-data?interesting=true` (R3) | Items in the range (each side returns its newest 200) |

Pools hidden from the public view by configuration are removed by both sites' routes, so they show up as "a pool on
one side only" (in the templates, R4 and the pools list) if the configuration differs.

### Template matching
The two sites' collectors are different processes at different locations, so template ids and receive times differ
by design. A template is identified by its **job key**: `(pool, height, prev_hash, merkle_branches, version, nbits,
ntime)`. Per key, each side's templates are paired one to one, closest in time first (a pool may send one key several
times). Nothing is matched by time
or with tolerances. For matched templates the tool reports the **first-seen difference, B minus A** (p50 / p95 / min
/ max per pool, and how often B saw it first): the network-location difference between the two collectors. Matched
templates are also checked for `clean_jobs`, `extranonce2_length` and the extranonce1 length (its value is masked per
site, so it isn't compared), and the share with an identical coinbase is shown (per-connection coinbase bytes make
that < 100 % for some pools). The per-pool table also counts each side's **sources**: the collector connections
named by the template ids, when a site's ids name them (`?` otherwise). Only sources with shown rows count: the read
path hides a second collector's exact copies.

Two first-seen measures are reported, and they mean different things: **R4 Δ** (each pool's first template per
height, usually the `clean_jobs` broadcast after a block) is the network-location difference; the **matched
template Δ** also includes how a pool schedules job updates per connection, which can be seconds apart.

Templates left over are classified, first rule that applies:

| Class | Meaning |
|---|---|
| `extra_copy` | the other side has the same job key, fewer times |
| `near_miss:<fields>` | the other side has the same job (pool, height, `prev_hash`, `merkle_branches`) with another `ntime` / `version` / `nbits` only (e.g. a re-send seen with a different `ntime`) |
| `pool_one_side_only` | the other side has no template from this pool anywhere in the range (hidden, or not collected) |
| `pool_missing_at_height` | the other side has the pool elsewhere, but nothing at this height (collector down) |
| `before_other_started` | received before the other side's first template of the pool in the range (its collection started later, e.g. during the first height) |
| `other_prev_hash` | the other side has the pool at this height, never with this `prev_hash` |
| `other_source_missing` | the other side's ids name its sources (collector connections; Postgres ids are `<source_id>-<µs>-<job_id>`), and the source whose templates usually match this side shows nothing at this height (that collector was down or on another job stream) |
| `before_other_first` | more than `--gap-s` before the other side's first template of the pool at this height (connected late) |
| `after_other_last` | more than `--gap-s` after the other side's last one (disconnected, or a response cached before the height was complete) |
| `other_side_gap` | inside the other side's span, but nothing from the pool within `--gap-s` |
| `multi_source` | this side shows rows from several sources of the pool at this height: a second connection's own job stream (some pools give each connection different jobs), shown by the read path because it isn't a copy |
| `unexplained` | none of the above (examples are listed) |

## Run it
```bash
cd tools/site-compare          # Python 3.12+, standard library only
python -m site_compare --a https://site-a.example --b https://site-b.example \
  --cache /tmp/site-compare-cache --out report.md --json report.json
```
Options:
- **Range:** `--from H`, `--to H` (clamped to the lower tip). By default the start is B's lowest block, extended down
  while B has templates below it (`--probe-down`, default 10 heights).
- **Gentle by default:** `--rate 2` requests/s for both sites together (at most 5, the sites' per-client limit),
  `--burst 1`, `--retries 6` on 429 / 5xx / network errors with exponential backoff and jitter, never shorter than the
  server's `Retry-After`. `--max-requests 2000` stops the run (exit status 3) before it sends more.
- **Resumable:** `--cache DIR` keeps every response that can't change any more (heights at or below both tips; full
  block pages below the tip). A rerun, or a run after `--max-requests` stopped one, refetches only the tips, the pools
  list and R3. `--refresh` refetches everything.
- `--gap-s 60`: the time gap used by the classification.

A run needs about `4 × heights + 2 × ⌈heights / 100⌉ + 8` requests (templates and first seen per height and site,
block pages, tips, pools, R3).

**Output:** a Markdown report (summary, per-pool table, per-height table, block differences, R4 and pools-list
differences, unexplained examples) and the full result as JSON. Both contain pool names and block hashes from the
sites, but no template contents; keep reports of real sites out of the repository.

## Test
```bash
tools/site-compare/test-e2e.sh     # unit tests + two synthetic fake sites over HTTP, in a throwaway container (Docker)
python -m pytest tests             # unit tests only (from tools/site-compare; needs pytest)
```
The fake sites (`tests/fakesite.py`) serve made-up data with the API shapes and plant one of each difference.
