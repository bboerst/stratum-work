import type { Episode } from "./unknownParents";
import { fmtDuration, fmtInt } from "./forksPath";

/**
 * What the Forks link-preview card draws (app/forks/ogImage.tsx), worked out as the page's episode diagram does
 * (components/Forks.tsx WhyUnknown): our chain's blocks at the parent's height and the next (height over miner), the
 * parent below them, and beside it the pools that built on it. Pure, so the text is tested
 * (lib/__tests__/forksCard.test.ts).
 *
 * Names follow the page's rules: the pools are the episode's (a POOL_BLACKLIST pool only where the summary keeps it:
 * its work at or below our tip); every block's miner as recorded (finishEpisodes, getDrillBlocks).
 */

export interface CardBlock { block_hash: string; height: number; best: boolean; miner: string | null }

export type TileStyle = "strip" | "stale" | "outline" | "overpaid";
export interface CardTile {
  col: 0 | 1;                    // 0 = newest, on the left (as in the blocks strip); 1 = the one before
  row: 0 | 1;                    // 0 = our chain, 1 = the parent the templates built on
  label: string;                 // the height
  sub: string;                   // the miner, else a short hash
  style: TileStyle;
}

export interface CardModel {
  hash: string;                  // the parent, as the page's header shows it
  tiles: CardTile[];
  link: boolean;                 // a dashed line from our block at the parent's height down to the parent
  ourTip: boolean;               // "our tip" beside our chain (the parent is far off it)
  builtOn: string;               // "← 9 pools built on it"
  pools: string;                 // "Pool A, Pool B, Pool C, Pool D +5"
  invalidCoinbase: string | null;   // "✗ invalid coinbase: Pool A +1"
  facts: string;                 // "for 76s · 24 templates"
}

const MINER_MAX = 14;
export const shortHash = (h: string) => `${h.slice(0, 4)}…${h.slice(-6)}`;
export const headerHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-6)}`;
export const fitName = (s: string, max = MINER_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Characters that fit beside the parent tile on one line: the card's monospace at 25 px is 15 px a character, and
 * the text column is about 550 px wide (36 characters); 34 leaves a margin. */
export const POOL_LINE_CHARS = 34;

/** As many names as fit in `maxChars` on one line, and how many more: "Pool A, Pool B, Pool C +6". The "+N" always
 * fits on the same line; at least one name is shown (shortened if it alone is too long). */
export function nameList(names: string[], maxChars = POOL_LINE_CHARS): string {
  if (names.length === 0) return "";
  const more = (shown: number) => (names.length > shown ? ` +${names.length - shown}` : "");
  let shown = 1;
  while (shown < names.length && [...names.slice(0, shown + 1)].join(", ").length + more(shown + 1).length <= maxChars) shown++;
  const first = names.slice(0, shown).join(", ");
  if (first.length + more(shown).length <= maxChars) return first + more(shown);
  return fitName(names[0], Math.max(4, maxChars - more(1).length)) + more(1);
}

const plural = (n: number, w: string) => `${fmtInt(n)} ${w}${n === 1 ? "" : "s"}`;

export function cardModel(e: Episode, blocks: CardBlock[] | null): CardModel {
  const f = e.facts;
  const ph = e.height - 1;
  const ours = (h: number) => (blocks ?? []).find(b => b.height === h && b.best);
  const prev = ours(ph), next = ours(e.height);
  const chain = f.tip_at_first !== null && Math.abs(ph - f.tip_at_first) <= 1;
  const sub = (b: CardBlock | undefined) => (b ? (b.miner ? fitName(b.miner) : shortHash(b.block_hash)) : "");
  const tiles: CardTile[] = [];
  const pools = e.pools.map(p => p.pool);
  const overpaid = e.kind === "invalid_coinbase";

  if (overpaid || chain) {
    tiles.push({ col: 1, row: 0, label: fmtInt(prev?.height ?? ph), sub: sub(prev), style: "strip" });
    tiles.push({ col: 0, row: 0, label: fmtInt(next?.height ?? e.height), sub: sub(next), style: overpaid ? "overpaid" : "strip" });
  } else {
    tiles.push({ col: 0, row: 0, label: f.tip_at_first !== null ? fmtInt(f.tip_at_first) : "—", sub: "", style: "strip" });
  }
  if (!overpaid) {
    const col = chain ? 1 : 0;
    const sb = f.stale_block;
    tiles.push(e.kind === "stale"
      ? { col, row: 1, label: fmtInt(sb?.height ?? ph), sub: sb?.miner ? fitName(sb.miner) : shortHash(e.parent), style: "stale" }
      : { col, row: 1, label: fmtInt(ph), sub: shortHash(e.parent), style: "outline" });
  }
  const ic = e.invalid_coinbase && !overpaid ? e.invalid_coinbase.pools.map(p => p.pool) : null;
  return {
    hash: headerHash(e.parent),
    tiles,
    link: chain && !overpaid,
    ourTip: !chain && !overpaid,
    builtOn: overpaid ? `${plural(pools.length, "pool")} overpaid the coinbase` : `← ${plural(pools.length, "pool")} built on it`,
    pools: nameList(pools),
    invalidCoinbase: ic && ic.length ? `✗ invalid coinbase: ${nameList(ic, POOL_LINE_CHARS - 20)}` : null,
    facts: overpaid ? plural(e.templates, "template") : `for ${fmtDuration(e.duration_ms)} · ${plural(e.templates, "template")}`,
  };
}
