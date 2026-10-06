"use client";
import React from 'react';

export const FAMILY_COLORS = ['#f59e0b', '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#facc15'];
export const familyColor = (i: number) => FAMILY_COLORS[i % FAMILY_COLORS.length];
export const HATCH = 'repeating-linear-gradient(45deg,#374151,#374151 4px,#1f2937 4px,#1f2937 8px)';
export const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
export const btc = (sats: number) => `${(sats / 1e8).toFixed(3)} BTC`;
export const ago = (ms: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
export const txRange = ([a, b]: [number, number]) => (b === 0 ? '0 tx' : `${a.toLocaleString()}–${b.toLocaleString()} tx`);

export function SectionLabel({ title, meta }: { title: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="mt-4 mb-1 flex justify-between text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
      <span>{title}</span>
      {meta && <span className="normal-case tracking-normal">{meta}</span>}
    </div>
  );
}

export function Insufficient({ what = 'data' }: { what?: string }) {
  return <span className="text-[11px] italic text-gray-500">insufficient {what}</span>;
}

export function Unavailable({ what }: { what: string }) {
  return <span className="text-[11px] italic text-gray-500">{what} unavailable</span>;
}

/** 95% range as a thin bar: full width = 0..scaleMax. */
export function RangeBar({ lo, hi, scaleMax = 1 }: { lo: number; hi: number; scaleMax?: number }) {
  return (
    <div className="relative mt-1 h-[3px] rounded bg-black/30">
      <i className="absolute -top-[2px] h-[7px] rounded bg-black/80" style={{ left: `${(lo / scaleMax) * 100}%`, width: `${Math.max(1, ((hi - lo) / scaleMax) * 100)}%` }} />
    </div>
  );
}

export function BitsBar({ bits, max = 64, insufficient }: { bits: number; max?: number; insufficient?: boolean }) {
  if (insufficient) return <Insufficient what="events" />;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded bg-gray-200 dark:bg-gray-700">
        <div className="h-1.5 rounded bg-gray-700 dark:bg-gray-200" style={{ width: `${Math.min(100, (bits / max) * 100)}%` }} />
      </div>
      <span className="font-mono text-[10px] text-gray-500">{bits.toFixed(1)} bits</span>
    </div>
  );
}

export function StoreNotes({ status }: { status: { historyUnavailable: boolean; poolsUnavailable: boolean; blocksUnavailable: boolean } }) {
  const notes = [
    status.historyUnavailable && 'history unavailable (live data only)',
    status.poolsUnavailable && 'pool identities unavailable',
    status.blocksUnavailable && 'block history unavailable',
  ].filter(Boolean);
  return notes.length ? <div className="text-[11px] text-amber-600 dark:text-amber-400">{notes.join(' · ')}</div> : null;
}
