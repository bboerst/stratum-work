"use client";
import React, { useEffect, useState } from 'react';
import { useAnalysis } from '@/lib/templates/hooks';
import { computeOverview } from '@/lib/analyses/overview';
import { formatFigures, rawDataLinks, type RuntimeEndpoints } from './methodologyFigures';

export interface MethodologyParams { thresholdBits: number; windowBlocks: number }

const RAW_SINCE_MS = 10 * 60 * 1000;
const EDUCATION = [
  { href: 'https://en.bitcoin.it/wiki/Stratum_mining_protocol', label: 'Stratum mining protocol (Bitcoin Wiki)' },
  { href: 'https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki', label: 'BIP 34: block height in coinbase' },
  { href: 'https://b10c.me/', label: 'b10c.me: mining pool research' },
];

export function Methodology({ params }: { params: MethodologyParams }) {
  const o = useAnalysis(computeOverview, { thresholdBits: params.thresholdBits, windowBlocks: params.windowBlocks });
  const figures = formatFigures(o.summary);
  const [links, setLinks] = useState<{ templates: string | null; stream: string | null }>({ templates: null, stream: null });
  useEffect(() => {
    let alive = true;
    fetch('/api/runtime-config', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<RuntimeEndpoints>; })
      .catch(() => ({} as RuntimeEndpoints))
      .then(cfg => { if (alive) setLinks(rawDataLinks(cfg, Date.now() - RAW_SINCE_MS)); });
    return () => { alive = false; };
  }, []);
  const coincidence = Math.pow(2, params.thresholdBits).toLocaleString('en-US');
  const a = 'text-blue-600 hover:underline dark:text-blue-400';
  return (
    <details className="mt-4 rounded border border-gray-200 p-2 text-xs text-gray-700 dark:border-gray-800 dark:text-gray-300">
      <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">How this is measured</summary>
      <div className="mt-2 flex flex-col gap-3">
        <section>
          <h3 className="font-semibold">Windows</h3>
          <ul className="list-disc pl-5">
            <li>Groupings: last 60 min of templates.</li>
            <li>Hashrate shares: last {params.windowBlocks.toLocaleString('en-US')} blocks.</li>
            <li>Bars: 95% Wilson range.</li>
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Evidence channels</h3>
          <ul className="list-disc pl-5">
            <li>Transaction selection: each pool&apos;s current template is sampled every 5 s; pools on the same previous block that share a distinct set of merkle branches form one observation.</li>
            <li>Identical changes: the same template change (excluding nTime, output value, witness commitment and coinbase tag) made by several pools within 2 s forms one observation.</li>
            <li>New-tip switching (experimental): for each new block, the gap between two pools&apos; latency-corrected switch times is compared with all pair gaps on that block; a pair&apos;s per-block ranks are combined (Fisher&apos;s method), so unrelated pools stay near 0 bits however many blocks are observed.</li>
            <li>Payouts &amp; merge-mining: a shared non-OP_RETURN payout address, or an identical merge-mining commitment within 5 s, forms one observation.</li>
            <li>bits = −log₂(k/n), where k of n observed pools showed the observation; a channel with fewer than 5 comparable events for a pair shows &quot;insufficient&quot;.</li>
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Groupings</h3>
          <p>Pools are joined when total pair evidence ≥ {params.thresholdBits} bits (≈ 1 in {coincidence} coincidence); groupings are connected components.</p>
        </section>
        <section>
          <h3 className="font-semibold">Figures</h3>
          <ul className="list-disc pl-5">
            <li>Fewest groupings controlling &gt; 50% of hashrate: {figures.k}</li>
            <li>Effective number of groupings (1/Σ share²): {figures.effectiveNumber}</li>
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Blind spots</h3>
          <ul className="list-disc pl-5">
            <li>A single vantage point per site.</li>
            <li>Pools we don&apos;t connect to are shown as &quot;Not observed&quot;.</li>
            <li>Latency correction uses RTT/2, which assumes symmetric network paths.</li>
            <li>Merkle branches identify transaction selection, not ordering beyond branch depth.</li>
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Background reading</h3>
          <ul className="list-disc pl-5">
            {EDUCATION.map(l => <li key={l.href}><a className={a} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a></li>)}
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Raw data</h3>
          <ul className="list-disc pl-5">
            <li>Templates (last 10 min): {links.templates ? <a className={a} href={links.templates} target="_blank" rel="noopener noreferrer">{links.templates}</a> : 'unavailable'}</li>
            <li>Live stream (SSE): {links.stream ? <a className={a} href={links.stream} target="_blank" rel="noopener noreferrer">{links.stream}</a> : 'unavailable'}</li>
          </ul>
        </section>
      </div>
    </details>
  );
}
