# replica-compare: what identifies "the same job" across two connections

With redundant collection, a pool is collected by two (or more) collectors at the same site, each registering its own source (`sources.replica`, `a`, `b`, …) and writing its own rows. Reads that need one row per *job* must group those rows, and that needs a key the replicas agree on. This tool measures, for a time window and per pool, how two replicas' templates compare, so the key can be chosen (and re-checked later) from data.

It reads a database with the stratum-work schema ([`db/migrations`](../../db/migrations)): `templates`, `templates_other` and `sources`. It only reads; any role with `SELECT` on those tables works (`stratum_backend`, `stratum_web`).

## What it reports
Per pool (`sources.name`, comparing two `sources.replica` values):

- **Pairs.** Each template of replica `a` is paired with the replica-`b` template with the same `prev_hash` and the nearest `received_at`, at most `--max-offset` seconds away (one-to-one, closest first). Also reported: pair offsets (p50 / p95 / max) and unpaired counts.
- **Field equality** across pairs: share equal for every column (`prev_hash`, `merkle_branches`, `version`, `nbits`, `ntime`, `clean_jobs`, `job_id`, `extranonce1`, `coinbase1`, `coinbase2`, …), plus decoded coinbase outputs and coinbase lengths.
- **Coinbase structure.** Each coinbase is rebuilt as `coinbase1 + extranonce1 + zero extranonce2 + coinbase2` and decoded into header, scriptSig, sequence, outputs (value + scriptPubKey each) and locktime. Reported:
  - whether the **outputs** are identical across replicas (payout scripts, OP_RETURNs, witness commitment), and if not, which outputs differ, by kind;
  - where the extranonce sits (normally the scriptSig; some pools let it run into the sequence field);
  - **fields** that differ across connections. With the extranonce bytes masked, a field is a run of adjacent bytes that differs in at least 2 % of pairs. Each field gets a region, an offset from the region start and from its end, a length, and the share of pairs it differs in.
  - **a classification** from how the field behaves within each session (one extranonce1 of one replica): per-session constant, timestamp (s/ms/µs/ns, often only the low bytes differ), clock-like counter (steady ticks per second), per-session counter, new value with each job, random per template, mostly constant per session, changes occasionally, or "usually equal" (it differs in under half the pairs, i.e. an update reached the connections at different moments).
- **Candidate job keys**, by default:
  - `prev_hash + merkle_branches + version + nbits`
  - the same plus `ntime`
  - `prev_hash + merkle_branches`
  - the first plus the decoded coinbase outputs

  For each key: jobs per replica, jobs both saw (match rate), jobs only one saw, templates per job, jobs whose templates carry several output sets (the key merges them), the first-seen offset of matched jobs (p50 / p95 / max), and which replica saw them first how often. For jobs only one replica saw, also how long they lived before that replica's next job.

- **De-duplication on the read path**: when the database has `template_dedup_report` (migration `20261115000001_templates_dedup.sql`), its table for the window, per UTC day, pool and site, plus the pool's total. It covers primary and secondary rows, secondary rows hidden as exact copies and shown (extra copies, near misses by |ntime difference|, gap fills), and first-seen gains (p50 / p95 / max ms). It covers every site of each pool (`--site` doesn't filter it). The rule is in the [design doc](../../docs/design/postgres-timescale.md) ("Redundant collection").

**Privacy of the output:** counts, shares, offsets, lengths and byte positions only. Coinbase bytes, extranonce values and job ids are never printed, in the Markdown or the JSON.

## Run it
```bash
cd tools/replica-compare
pip install -r requirements.txt          # Python 3.13; psycopg is the only dependency

PGHOST=... PGUSER=... PGDATABASE=stratum PGPASSFILE=~/.pgpass \
  python -m replica_compare --last 3h --site <site> --out report.md --json report.json
```

Options:
- **Window:** `--last 3h` (ending now or at `--until`), or `--since` / `--until` (ISO 8601; naive = UTC).
- **Filter:** `--site`, `--pool NAME` (repeatable), `--replicas a,b` (default `a,b`).
- **Pairing:** `--max-offset S` (default 2), `--tie-ms MS` (first-seen offsets up to this count as ties; default 0).
- **Connection:** `--pg-host/--pg-port/--pg-database/--pg-user/--pg-sslmode`, or libpq's `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE`. The password only via `PGPASSWORD` or a `PGPASSFILE`. Connections take keyword arguments, never a URL, and the session is read-only.

A window holds both tables' rows (`templates` and `templates_other`), so templates from other chains are included and counted per chain (`chains`). They have their own `prev_hash`, so they never pair with Bitcoin templates.

## Test
```bash
tools/replica-compare/test-e2e.sh      # unit tests + a synthetic fixture in a throwaway TimescaleDB (Docker)
python -m pytest tests                 # unit tests only (from tools/replica-compare)
```

Tests and fixtures are synthetic: made-up coinbases built by `tests/helpers.py`.
