"use client";

import React, { useMemo } from "react";
import { parseCoinbase, ScriptSegmentKind } from "@/utils/coinbaseParser";

// A byte map of the coinbase scriptSig: what each part is (height, the pool's tags, its clock, merge-mining,
// extranonce), decoded by utils/coinbaseParser.

const KINDS: Record<ScriptSegmentKind, { label: string; className: string; hint: string }> = {
  height: { label: "Height", className: "bg-sky-200 text-sky-950 dark:bg-sky-800 dark:text-sky-50", hint: "BIP34 block height" },
  time: { label: "Pool time", className: "bg-violet-200 text-violet-950 dark:bg-violet-800 dark:text-violet-50", hint: "A Unix time the pool pushed, close to ntime" },
  tag: { label: "Text", className: "bg-emerald-200 text-emerald-950 dark:bg-emerald-800 dark:text-emerald-50", hint: "Printable text (pool tag)" },
  auxpow: { label: "AuxPoW", className: "bg-amber-200 text-amber-950 dark:bg-amber-800 dark:text-amber-50", hint: "Merge-mining commitment (magic fabe6d6d + aux root, size, nonce)" },
  extranonce1: { label: "Extranonce1", className: "bg-rose-200 text-rose-950 dark:bg-rose-900 dark:text-rose-50", hint: "Per connection, assigned by the pool (not shown)" },
  extranonce2: { label: "Extranonce2", className: "bg-orange-200 text-orange-950 dark:bg-orange-900 dark:text-orange-50", hint: "Chosen by the miner for each share (zeros here)" },
  push: { label: "Push", className: "text-muted-foreground", hint: "Script push opcode / length bytes" },
  data: { label: "Data", className: "", hint: "Other bytes (binary data or opcodes)" },
};

interface Props {
  coinbase1: string;
  extranonce1: string;
  extranonce2Length: number;
  coinbase2: string;
  ntime?: string; // hex, from the template
}

const ScriptSigMap: React.FC<Props> = ({ coinbase1, extranonce1, extranonce2Length, coinbase2, ntime }) => {
  const ntimeSec = ntime && /^[0-9a-fA-F]{1,8}$/.test(ntime) ? parseInt(ntime, 16) : undefined;
  const parsed = useMemo(
    () => parseCoinbase(coinbase1, extranonce1 || "", Number(extranonce2Length), coinbase2, { ntime: ntimeSec }),
    [coinbase1, extranonce1, extranonce2Length, coinbase2, ntimeSec]
  );
  const sig = parsed.scriptSig;
  if (!sig) return <div className="italic text-muted-foreground">Coinbase not parseable{parsed.error ? `: ${parsed.error}` : ""}</div>;

  const hex = coinbase1 + (extranonce1 || "") + "00".repeat(Math.max(0, Number(extranonce2Length) | 0)) + coinbase2;
  const used = new Set(sig.segments.map((s) => s.kind));

  return (
    <div className="space-y-2">
      <div className="p-2 border rounded-sm bg-card/80 font-mono text-[11px] leading-5 break-all">
        {sig.segments.map((s, i) => {
          const k = KINDS[s.kind];
          const bytes = s.kind === "extranonce1" ? "••".repeat(s.end - s.start) : hex.slice(s.start * 2, s.end * 2);
          return (
            <span key={i} className={`${k.className} rounded-[2px] px-px`} title={`${k.label}: ${s.end - s.start} bytes${s.text ? ` "${s.text}"` : ""}`}>
              {bytes}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
        {(Object.keys(KINDS) as ScriptSegmentKind[]).filter((k) => used.has(k)).map((k) => (
          <span key={k} title={KINDS[k].hint} className="cursor-help">
            <span className={`${KINDS[k].className} inline-block w-3 h-3 align-middle rounded-[2px] border mr-1`} />
            {KINDS[k].label}
          </span>
        ))}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
        <dt className="text-muted-foreground">Size</dt>
        <dd>{sig.end - sig.start} bytes{sig.end - sig.start > 100 ? " (over Bitcoin's 100-byte limit)" : ""}</dd>
        {sig.time !== null && ntimeSec !== undefined && (
          <>
            <dt className="text-muted-foreground">Pool time</dt>
            <dd>
              {new Date(sig.time * 1000).toISOString().replace(".000Z", "Z")} ({sig.time - ntimeSec >= 0 ? "+" : ""}
              {sig.time - ntimeSec} s vs ntime)
            </dd>
          </>
        )}
        {parsed.extranonceIn.length > 0 && (
          <>
            <dt className="text-muted-foreground">Extranonce in</dt>
            <dd>{parsed.extranonceIn.join(" + ")}</dd>
          </>
        )}
        {sig.tags.length > 0 && (
          <>
            <dt className="text-muted-foreground">Text</dt>
            <dd className="wrap-break-word">{sig.tags.map((t) => t.text).join(" · ")}</dd>
          </>
        )}
        {!parsed.ok && parsed.error && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd>{parsed.error}</dd>
          </>
        )}
      </dl>
    </div>
  );
};

export default ScriptSigMap;
