"use client";

import React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AuxPowInfo, MergeMiningSummary, OpReturnDecoded, Confidence } from "@/utils/mergeMining";

// Decoded merge-mining data for the template card (#42, #82). All values render as React text, never as HTML.

const CONFIDENCE: Record<Confidence, string> = {
  spec: "Layout from the protocol's spec or reference code; matches templates seen in the wild.",
  marker: "Identified by its protocol marker; the payload isn't decoded.",
  heuristic: "A shape match without a distinctive marker: may be something else.",
  observed: "A marker seen repeatedly in real coinbases, with no published spec; the payload isn't decoded.",
  structural: "Known from how the coinbase is built (the extranonce position), not from the bytes.",
};

function Hint({ text, children }: { text?: string; children: React.ReactNode }) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="underline decoration-dotted cursor-help">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="bg-background text-foreground max-w-xs">
        <p>{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Protocol name and named fields of one OP_RETURN output. */
export function OpReturnFields({ decoded }: { decoded: OpReturnDecoded }) {
  return (
    <div className="mb-1 border-t border-gray-300 dark:border-gray-600 pt-1" data-protocol={decoded.id}>
      <div>
        <span className="font-medium">Protocol:</span>{" "}
        <Hint text={CONFIDENCE[decoded.confidence]}>
          <span className="italic text-blue-500 dark:text-blue-400">{decoded.protocol}</span>
        </Hint>
        {decoded.chain && <span className="text-muted-foreground"> (commits to {decoded.chain})</span>}
      </div>
      {decoded.fields.length > 0 && (
        <ul className="list-disc list-inside pl-2">
          {decoded.fields.map((f) => (
            <li key={f.label}>
              <span className="font-semibold">
                <Hint text={f.hint}>{f.label}</Hint>:
              </span>{" "}
              {f.href ? (
                <a
                  href={f.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline break-all"
                  onClick={(e) => e.stopPropagation()}
                >
                  {f.value}
                </a>
              ) : (
                <span className="break-all">{f.value}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {decoded.error && <div className="text-amber-700 dark:text-amber-400">Note: {decoded.error}</div>}
    </div>
  );
}

/** Which other chains the template commits to. */
export function MergeMiningSummaryLine({ summary }: { summary: MergeMiningSummary }) {
  return (
    <div>
      <div className="font-medium text-muted-foreground mb-0.5">
        <Hint text="Other chains and protocols this template commits to: the AuxPoW commitment in the scriptSig and the OP_RETURN outputs that name a chain. The AuxPoW tree can hold several chains; the coinbase alone doesn't say which.">
          Merge mining:
        </Hint>
      </div>
      <div className="p-2 border rounded-sm font-mono text-[11px] bg-card/80">{summary.label || "None"}</div>
    </div>
  );
}

/** The AuxPoW commitment and what can (and can't) be derived from it. */
export function AuxPowDetails({ aux, flashClass = "" }: { aux: AuxPowInfo; flashClass?: string }) {
  return (
    <div className="mt-2 border-t pt-3">
      <div className="font-medium text-muted-foreground mb-1">
        <Hint text="Merged mining (AuxPoW): the magic fabe6d6d, then the root of a merkle tree of aux chain block hashes, the tree's size and a nonce. Aux chains accept a share of this work when it meets their target.">
          Auxiliary Proof-of-Work (AuxPoW):
        </Hint>
      </div>
      <div className={`space-y-2 text-[10px] border rounded-sm p-2 bg-card/50 ${flashClass}`}>
        <div>
          <span className="font-semibold">
            <Hint text="Root of the aux chain merkle tree, as the coinbase holds it (already the usual display byte order). With a tree of one chain, it's that chain's block hash.">
              Aux merkle root:
            </Hint>
          </span>
          <span className="break-all ml-1">{aux.root}</span>
        </div>
        {aux.merkleSize !== undefined && (
          <div>
            <span className="font-semibold">
              <Hint text="Number of slots in the aux tree (a power of two). It bounds how many chains this work can serve; it doesn't say how many are used.">
                Merkle size:
              </Hint>
            </span>{" "}
            {aux.merkleSize} slots{aux.treeHeight !== undefined && ` (branch length ${aux.treeHeight})`}
          </div>
        )}
        {aux.nonce !== undefined && (
          <div>
            <span className="font-semibold">
              <Hint text="Picks each chain's slot in the tree, together with the chain's ID.">Merkle nonce:</Hint>
            </span>{" "}
            {aux.nonce} (0x{aux.nonce.toString(16).padStart(8, "0")})
          </div>
        )}
        {aux.problems.length > 0 && <div className="text-amber-700 dark:text-amber-400">Note: {aux.problems.join("; ")}</div>}
        {aux.knownSlots.length > 0 && (
          <div>
            <div className="font-semibold">
              <Hint text="Each aux chain's slot follows from its chain ID, the tree size and the nonce (merged mining spec). This shows where a known chain would be if this tree includes it: the coinbase doesn't reveal which chains are in the tree, or whether a slot is filled.">
                Slot if included:
              </Hint>
            </div>
            <ul className="list-disc list-inside pl-2">
              {aux.knownSlots.map((s) => (
                <li key={s.name}>
                  {s.name} (chain ID {s.chainId}): slot {s.slot}
                  {s.sharesSlotWith.length > 0 && (
                    <span className="text-muted-foreground"> (same slot as {s.sharesSlotWith.join(", ")}: not both)</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
