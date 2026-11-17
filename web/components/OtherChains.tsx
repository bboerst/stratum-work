"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The "Other chains" view: templates the collectors didn't store as Bitcoin's (/api/other-chains). The server does
 * every aggregation and decoding; this component sorts the summary rows (a few hundred at most) and renders one page
 * of templates at a time.
 */

interface SummaryGroup {
  pool: string;
  chain: string;
  reason: string;
  templates: number;
  min_height: number;
  max_height: number;
  distinct_heights: number;
  distinct_prev_hashes: number;
  first_seen: number;
  last_seen: number;
  auxpow_templates: number;
  auxpow_share: number;
  monthly: number[];
}

interface SummaryResponse {
  enabled: boolean;
  supported: boolean;
  generated_at?: number;
  months?: string[];
  groups?: SummaryGroup[];
  error?: string;
}

interface Output { value: number; address?: string; protocol?: string; script_hex: string }

interface OtherTemplate {
  id: string;
  pool_name: string;
  chain: string;
  reason: string;
  height: number;
  received_at: number;
  copies: number;
  prev_hash: string;
  version: string;
  nbits: string;
  ntime: string;
  clean_jobs: boolean;
  extranonce1: string;
  extranonce2_length: number;
  merkle_branches: number;
  coinbase_ok: boolean;
  coinbase_error?: string;
  scriptsig_height: number | null;
  coinbase_tags: string;
  auxpow: boolean;
  auxpow_root: string | null;
  auxpow_merkle_size: number | null;
  outputs: Output[];
  output_total: number;
}

interface TemplatesResponse { templates?: OtherTemplate[]; next_before?: string | null; error?: string }

type SortKey = "pool" | "group" | "templates" | "min_height" | "distinct_heights" | "first_seen" | "last_seen" | "auxpow_share";

const PAGE_SIZE = 50;
const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const groupKey = (g: { pool: string; chain: string; reason: string }) => `${g.pool}\u0000${g.chain}\u0000${g.reason}`;

function Sparkline({ values, months }: { values: number[]; months: string[] }) {
  const w = 96, h = 20;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
  const title = months.map((m, i) => `${m}: ${fmtInt(values[i] ?? 0)}`).join("\n");
  return (
    <svg width={w} height={h} className="text-blue-500 dark:text-blue-400" role="img" aria-label="templates per month">
      <title>{title}</title>
      {values.length > 1 ? (
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
      ) : (
        <circle cx={w / 2} cy={h / 2} r={2} fill="currentColor" />
      )}
    </svg>
  );
}

function SortHeader({ label, k, sort, setSort, align = "left" }: {
  label: string; k: SortKey; sort: { key: SortKey; desc: boolean }; setSort: (s: { key: SortKey; desc: boolean }) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  return (
    <th
      className={`p-2 text-xs font-medium text-muted-foreground cursor-pointer select-none whitespace-nowrap ${align === "right" ? "text-right" : "text-left"}`}
      onClick={() => setSort({ key: k, desc: active ? !sort.desc : k !== "pool" && k !== "group" })}
    >
      {label}{active ? (sort.desc ? " ▼" : " ▲") : ""}
    </th>
  );
}

function TemplateRow({ t }: { t: OtherTemplate }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-border hover:bg-muted/50 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <td className="p-2 font-mono text-xs whitespace-nowrap">{fmtTime(t.received_at)}</td>
        <td className="p-2 font-mono text-xs text-right">{fmtInt(t.height)}</td>
        <td className="p-2 font-mono text-xs" title={t.prev_hash}>{t.prev_hash.slice(0, 16)}…</td>
        <td className="p-2 font-mono text-xs max-w-[20rem] truncate" title={t.coinbase_tags}>{t.coinbase_tags || "—"}</td>
        <td className="p-2 text-xs text-right">{t.outputs.length}</td>
        <td className="p-2 font-mono text-xs">{t.version}</td>
        <td className="p-2 font-mono text-xs">{t.nbits}</td>
        <td className="p-2 font-mono text-xs">{parseInt(t.ntime, 16)}</td>
        <td className="p-2 text-xs">{t.auxpow ? "yes" : ""}</td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/30">
          <td colSpan={9} className="p-3 text-xs">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono break-all">
              <dt className="text-muted-foreground">prev hash</dt><dd>{t.prev_hash}</dd>
              <dt className="text-muted-foreground">scriptSig height</dt><dd>{t.scriptsig_height ?? "—"}</dd>
              <dt className="text-muted-foreground">AuxPoW root</dt>
              <dd>{t.auxpow_root ? `${t.auxpow_root}${t.auxpow_merkle_size != null ? ` (merkle size ${t.auxpow_merkle_size})` : ""}` : t.auxpow ? "magic outside the scriptSig" : "—"}</dd>
              <dt className="text-muted-foreground">merkle branches</dt><dd>{t.merkle_branches}</dd>
              <dt className="text-muted-foreground">clean jobs</dt><dd>{String(t.clean_jobs)}</dd>
              <dt className="text-muted-foreground">extranonce</dt><dd>{t.extranonce1} + {t.extranonce2_length} bytes</dd>
              <dt className="text-muted-foreground">connections</dt><dd>{t.copies}</dd>
              {!t.coinbase_ok && (<><dt className="text-muted-foreground">coinbase</dt><dd>not fully parsed{t.coinbase_error ? `: ${t.coinbase_error}` : ""}</dd></>)}
              <dt className="text-muted-foreground">outputs</dt>
              <dd>
                {t.outputs.length === 0 ? "—" : (
                  <ul>
                    {t.outputs.map((o, i) => (
                      <li key={i}>
                        {(o.value / 1e8).toFixed(8)} → {o.address ?? (o.protocol ? `OP_RETURN (${o.protocol})` : o.script_hex.slice(0, 80))}
                      </li>
                    ))}
                  </ul>
                )}
                <span className="text-muted-foreground font-sans">
                  Total {(t.output_total / 1e8).toFixed(8)}. Addresses use Bitcoin&apos;s encoding.
                </span>
              </dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function GroupTemplates({ group }: { group: SummaryGroup }) {
  // Cursors of the pages visited so far (null = newest), so "Newer" goes back without refetching from the start.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  // The response and the cursor it is for: loading = the current cursor's page hasn't arrived yet.
  const [loaded, setLoaded] = useState<{ cursor: string | null; data: TemplatesResponse } | null>(null);
  const cursor = cursors[cursors.length - 1];
  const loading = !loaded || loaded.cursor !== cursor;
  const data = loaded?.data ?? null;

  useEffect(() => {
    const ctl = new AbortController();
    const qs = new URLSearchParams({ pool: group.pool, chain: group.chain, reason: group.reason, n: String(PAGE_SIZE) });
    if (cursor) qs.set("before", cursor);
    fetch(`/api/other-chains?${qs}`, { signal: ctl.signal })
      .then(r => r.json())
      .then((d: TemplatesResponse) => setLoaded({ cursor, data: d }))
      .catch(e => { if (e?.name !== "AbortError") setLoaded({ cursor, data: { error: String(e) } }); });
    return () => ctl.abort();
  }, [group, cursor]);

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">
          {group.pool} · {group.chain} · {group.reason}
          <span className="ml-2 font-normal text-muted-foreground">page {cursors.length}{loading ? " · loading…" : ""}</span>
        </h2>
        <div className="flex gap-2">
          <button className="px-3 py-1 text-xs rounded-md border border-border disabled:opacity-40 hover:bg-muted"
            disabled={cursors.length <= 1 || loading} onClick={() => setCursors(c => c.slice(0, -1))}>Newer</button>
          <button className="px-3 py-1 text-xs rounded-md border border-border disabled:opacity-40 hover:bg-muted"
            disabled={!data?.next_before || loading} onClick={() => setCursors(c => [...c, data!.next_before!])}>Older</button>
        </div>
      </div>
      {data?.error && <p className="text-sm text-red-500">{data.error}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {["Received (UTC)", "Height", "Prev hash", "Coinbase text", "Outputs", "Version", "nBits", "nTime", "AuxPoW"].map(h => (
                <th key={h} className={`p-2 text-xs font-medium text-muted-foreground whitespace-nowrap ${h === "Height" || h === "Outputs" ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.templates ?? []).map(t => <TemplateRow key={t.id} t={t} />)}
            {data && !data.error && (data.templates ?? []).length === 0 && (
              <tr><td colSpan={9} className="p-4 text-center text-muted-foreground text-xs">No templates.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function OtherChains() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "templates", desc: true });
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/other-chains")
      .then(r => r.json())
      .then((d: SummaryResponse) => setSummary(d))
      .catch(e => setSummary({ enabled: true, supported: true, error: String(e) }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const list = [...(summary?.groups ?? [])];
    const val = (g: SummaryGroup): string | number =>
      sort.key === "pool" ? g.pool.toLowerCase() : sort.key === "group" ? `${g.chain}/${g.reason}` : g[sort.key];
    list.sort((a, b) => {
      const x = val(a), y = val(b);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -c : c;
    });
    return list;
  }, [summary, sort]);
  const selectedGroup = groups.find(g => groupKey(g) === selected) ?? null;
  const total = groups.reduce((s, g) => s + g.templates, 0);

  let body: React.ReactNode;
  if (!summary) body = <p className="text-sm text-muted-foreground">Loading…</p>;
  else if (summary.error) body = <p className="text-sm text-red-500">{summary.error}</p>;
  else if (!summary.enabled) body = <p className="text-sm text-muted-foreground">Historical data is disabled on this deployment.</p>;
  else if (!summary.supported) body = <p className="text-sm text-muted-foreground">This view is available with the Postgres backend.</p>;
  else body = (
    <>
      <p className="text-xs text-muted-foreground mb-3">
        {fmtInt(total)} templates in {groups.length} groups
        {summary.months?.length ? `, ${summary.months[0]} to ${summary.months[summary.months.length - 1]}` : ""}
        {summary.generated_at ? ` · computed ${fmtTime(summary.generated_at)} UTC` : ""}.
        One stream per pool: a template seen on several connections of a pool counts once. Click a row for its templates.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <SortHeader label="Pool" k="pool" sort={sort} setSort={setSort} />
              <SortHeader label="Chain / reason" k="group" sort={sort} setSort={setSort} />
              <SortHeader label="Templates" k="templates" sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Height range" k="min_height" sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Distinct heights" k="distinct_heights" sort={sort} setSort={setSort} align="right" />
              <SortHeader label="First seen" k="first_seen" sort={sort} setSort={setSort} />
              <SortHeader label="Last seen" k="last_seen" sort={sort} setSort={setSort} />
              <SortHeader label="AuxPoW" k="auxpow_share" sort={sort} setSort={setSort} align="right" />
              <th className="p-2 text-xs font-medium text-muted-foreground text-left whitespace-nowrap">Per month</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => {
              const key = groupKey(g);
              return (
                <tr key={key}
                  className={`border-b border-border cursor-pointer hover:bg-muted/50 ${key === selected ? "bg-muted" : ""}`}
                  onClick={() => setSelected(key === selected ? null : key)}>
                  <td className="p-2 text-xs whitespace-nowrap">{g.pool}</td>
                  <td className="p-2 text-xs whitespace-nowrap">{g.chain} / {g.reason}</td>
                  <td className="p-2 text-xs text-right font-mono">{fmtInt(g.templates)}</td>
                  <td className="p-2 text-xs text-right font-mono whitespace-nowrap">
                    {g.min_height === g.max_height ? fmtInt(g.min_height) : `${fmtInt(g.min_height)} – ${fmtInt(g.max_height)}`}
                  </td>
                  <td className="p-2 text-xs text-right font-mono" title={`${fmtInt(g.distinct_prev_hashes)} distinct prev hashes`}>
                    {fmtInt(g.distinct_heights)}
                  </td>
                  <td className="p-2 text-xs font-mono whitespace-nowrap">{fmtDate(g.first_seen)}</td>
                  <td className="p-2 text-xs font-mono whitespace-nowrap">{fmtDate(g.last_seen)}</td>
                  <td className="p-2 text-xs text-right font-mono">{g.auxpow_templates ? `${(g.auxpow_share * 100).toFixed(1)}%` : "—"}</td>
                  <td className="p-2"><Sparkline values={g.monthly} months={summary.months ?? []} /></td>
                </tr>
              );
            })}
            {groups.length === 0 && (
              <tr><td colSpan={9} className="p-4 text-center text-muted-foreground text-xs">No templates from other chains.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {selectedGroup && <GroupTemplates key={selected!} group={selectedGroup} />}
    </>
  );

  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold mb-1">Other chains</h1>
      <p className="text-xs text-muted-foreground mb-4 max-w-4xl">
        Templates that aren&apos;t Bitcoin&apos;s: other chains some pools mine on the same connections, heights far from
        Bitcoin&apos;s, and coinbases whose height couldn&apos;t be read. AuxPoW = the coinbase carries a merge-mining
        commitment (<span className="font-mono">fabe6d6d</span>).
      </p>
      {body}
    </div>
  );
}
