import { ImageResponse } from "next/og";
import type { Episode } from "@/lib/unknownParents";
import { loadEpisodes } from "@/lib/forksSummary";
import { resolveCached } from "@/lib/forksShare";
import { KIND_TITLE, SELECTION_ORDER, SITE_NAME, fmtDuration, fmtInt, type ShareKind } from "@/lib/forksPath";

/**
 * The Forks link-preview card (opengraph-image / twitter-image of /forks, /forks/<height> and /forks/<height>/<kind>):
 * the episode's chevron diagram as on the page (our chain's blocks, and the parent the templates built on below them in
 * the kind's colour), its kind and height, and its counts. No pool or miner names at all (nothing excluded by
 * POOL_BLACKLIST can show; the summary leaves those pools out anyway). It reads the cached summary
 * (lib/forksSummary.ts), so a card costs one render; browsers and crawlers may keep it for CACHE_S.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
const CACHE_S = 300;

const BG = "#0b0b0c", FG = "#e8e8e8", DIM = "#8f8f8f", STRIP = "#313131", TILE_TEXT = "#d7d7d7";
// The page's dark-theme kind colours (components/Forks.tsx KIND_FILL)
const KIND_COLOUR: Record<ShareKind, string> = {
  stale: "#3b82f6", bitcoin_block: "#38bdf8", other_chain: "#8b5cf6", invalid_parent: "#f43f5e",
  invalid_coinbase: "#f43f5e", undetermined: "#6b7280",
};

// The blocks strip's chevron tile (Forks.tsx WhyUnknown), at twice the size
const S = 2, TW = 104 * S, TH = 64 * S, G = 6;
const chevron = (x: number, y: number) =>
  [[4, 32], [19, 0], [104, 0], [90, 32], [104, 64], [19, 64]].map(([px, py]) => `${x + px * S},${y + py * S}`).join(" ");

interface Tile { x: number; y: number; label: string; sub?: string; fill: string; stroke?: string; dashed?: boolean; onColour?: boolean }

function Diagram({ e }: { e: Episode }) {
  const f = e.facts;
  const ph = e.height - 1;
  const colour = KIND_COLOUR[e.kind];
  const onOurChain = f.tip_at_first !== null && Math.abs(ph - f.tip_at_first) <= 1;
  const Y0 = 34, Y1 = Y0 + TH + 40, xNext = 0, xPrev = TW + G;
  const short = `${e.parent.slice(0, 4)}…${e.parent.slice(-6)}`;
  const tiles: Tile[] = [];
  let link: { x: number } | null = null;
  if (e.kind === "invalid_coinbase") {
    // our own chain: the block whose templates paid too much, outlined
    tiles.push({ x: xPrev, y: Y0, label: fmtInt(ph), fill: STRIP });
    tiles.push({ x: xNext, y: Y0, label: fmtInt(e.height), sub: "overpaid", fill: "transparent", stroke: colour });
  } else {
    if (onOurChain) {
      tiles.push({ x: xPrev, y: Y0, label: fmtInt(ph), fill: STRIP });
      tiles.push({ x: xNext, y: Y0, label: fmtInt(e.height), fill: STRIP });
      link = { x: xPrev };
    } else {
      tiles.push({ x: xNext, y: Y0, label: f.tip_at_first === null ? "—" : fmtInt(f.tip_at_first), sub: "our tip", fill: STRIP });
    }
    const px = onOurChain ? xPrev : xNext;
    tiles.push(e.kind === "stale"
      ? { x: px, y: Y1, label: fmtInt(f.stale_block?.height ?? ph), sub: short, fill: colour, onColour: true }
      : { x: px, y: Y1, label: fmtInt(ph), sub: short, fill: "transparent", stroke: colour, dashed: true });
  }
  const W = xPrev + TW + 4, H = Y1 + TH + 4;
  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
        {link && <line x1={link.x + 54 * S} x2={link.x + 54 * S} y1={Y0 + TH} y2={Y1} stroke="#5a5a5a" strokeWidth={3} strokeDasharray="6 6" />}
        {tiles.map((t, i) => (
          <polygon key={i} points={chevron(t.x + 2, t.y)} fill={t.fill} stroke={t.stroke ?? "none"} strokeWidth={t.stroke ? 4 : 0}
            strokeDasharray={t.dashed ? "10 7" : undefined} />
        ))}
      </svg>
      <div style={{ position: "absolute", left: 0, top: 0, fontSize: 22, color: DIM, display: "flex" }}>our chain</div>
      {tiles.map((t, i) => (
        <div key={i} style={{
          position: "absolute", left: t.x + 2 + 19 * S, top: t.y, width: (104 - 19 - 4) * S, height: TH,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 700, color: t.onColour ? "#ffffff" : TILE_TEXT }}>{t.label}</div>
          {t.sub && <div style={{ display: "flex", fontSize: 20, color: t.onColour ? "rgba(255,255,255,0.8)" : "rgba(215,215,215,0.7)" }}>{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

const BUILT_ON: Record<ShareKind, string> = {
  stale: "built on a stale block",
  bitcoin_block: "built on an unrecorded block",
  other_chain: "built on another chain",
  invalid_parent: "built on an invalid parent",
  invalid_coinbase: "overpaid the coinbase",
  undetermined: "built on an unknown parent",
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column", background: BG, color: FG,
      padding: "52px 64px", fontFamily: "sans-serif",
    }}>
      <div style={{ display: "flex", fontSize: 28, color: DIM }}>{SITE_NAME} · Forks</div>
      {children}
    </div>
  );
}

export function episodeCard(e: Episode) {
  const colour = KIND_COLOUR[e.kind];
  const n = e.pools.length;
  return (
    <Frame>
      <div style={{ display: "flex", alignItems: "center", marginTop: 18 }}>
        <div style={{ display: "flex", width: 30, height: 30, borderRadius: 15, marginRight: 22,
          background: e.kind === "invalid_coinbase" ? "transparent" : colour, border: `4px solid ${colour}` }} />
        <div style={{ display: "flex", fontSize: 66, fontWeight: 700, color: colour }}>{KIND_TITLE[e.kind]}</div>
        <div style={{ display: "flex", fontSize: 66, fontWeight: 700, marginLeft: 22 }}>at {fmtInt(e.height)}</div>
      </div>
      <div style={{ display: "flex", flex: 1, alignItems: "flex-end", justifyContent: "space-between" }}>
        <Diagram e={e} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 8 }}>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 700 }}>{fmtInt(n)} pool{n === 1 ? "" : "s"}</div>
          <div style={{ display: "flex", fontSize: 32, color: DIM }}>{BUILT_ON[e.kind]}</div>
          <div style={{ display: "flex", fontSize: 32, color: DIM, marginTop: 6 }}>
            {e.kind === "invalid_coinbase" ? "" : `for ${fmtDuration(e.duration_ms)} · `}{fmtInt(e.templates)} template{e.templates === 1 ? "" : "s"}
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** /forks itself (and a link with no episode to draw): the count per kind over the last 12,096 blocks. */
export function forksCard(episodes: Episode[] | null) {
  const counts = new Map<ShareKind, number>();
  for (const e of episodes ?? []) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return (
    <Frame>
      <div style={{ display: "flex", fontSize: 76, fontWeight: 700, marginTop: 18 }}>Forks</div>
      <div style={{ display: "flex", fontSize: 34, color: DIM, marginTop: 8 }}>Templates built on a block other than our best one</div>
      <div style={{ display: "flex", flex: 1, alignItems: "flex-end", alignContent: "flex-end", flexWrap: "wrap" }}>
        {SELECTION_ORDER.filter(k => counts.get(k)).map(k => (
          <div key={k} style={{ display: "flex", alignItems: "center", marginRight: 44, marginTop: 18 }}>
            <div style={{ display: "flex", width: 26, height: 26, borderRadius: 13, marginRight: 14,
              background: k === "invalid_coinbase" ? "transparent" : KIND_COLOUR[k], border: `4px solid ${KIND_COLOUR[k]}` }} />
            <div style={{ display: "flex", fontSize: 36 }}>{KIND_TITLE[k]}</div>
            <div style={{ display: "flex", fontSize: 36, color: DIM, marginLeft: 12 }}>{fmtInt(counts.get(k)!)}</div>
          </div>
        ))}
      </div>
      {episodes && <div style={{ display: "flex", fontSize: 26, color: DIM, marginTop: 22 }}>last 12,096 blocks</div>}
    </Frame>
  );
}

const respond = (el: React.ReactElement) =>
  new ImageResponse(el, { ...size, headers: { "Cache-Control": `public, max-age=${CACHE_S}` } });

export async function forksImage() {
  return respond(forksCard(await loadEpisodes("6e")));
}

export async function episodeImage(segments: string[]) {
  const r = await resolveCached(segments.join("/"));
  return respond(r.status === "found" ? episodeCard(r.episode) : forksCard(null));
}
