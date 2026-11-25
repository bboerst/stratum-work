import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImageResponse } from "next/og";
import type { Episode } from "@/lib/unknownParents";
import { loadBlocksAt, loadEpisodes } from "@/lib/forksSummary";
import { resolveCached } from "@/lib/forksShare";
import { cardModel, type CardModel, type TileStyle } from "@/lib/forksCard";
import { KIND_TITLE, SELECTION_ORDER, SITE_NAME, fmtInt, type ShareKind } from "@/lib/forksPath";

/**
 * The Forks link-preview card (opengraph-image / twitter-image of /forks, /forks/<height> and /forks/<height>/<kind>),
 * drawn like the page's episode diagram (components/Forks.tsx WhyUnknown) in its dark theme and monospace font: the
 * header (kind, height, parent), our chain's blocks with their miners, the parent below in the kind's colour, and the
 * pools that built on it (lib/forksCard.ts). Names follow the page's rules (a POOL_BLACKLIST pool only at or below our tip). It reads the
 * cached summary and the cached blocks at the height, so a card costs one render; browsers and crawlers may keep it
 * for CACHE_S.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
const CACHE_S = 300;

// Liberation Mono (SIL OFL 1.1, fonts/OFL.txt): the metric-compatible font of the site's monospace stack
// (globals.css: ui-monospace, …, Liberation Mono, …). Referenced by URL so the build bundles it (the runtime image has
// no source tree); read once per process.
const FONT_REGULAR = new URL("./fonts/LiberationMono-Regular.ttf", import.meta.url);
const FONT_BOLD = new URL("./fonts/LiberationMono-Bold.ttf", import.meta.url);
let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }[]> | null = null;
function loadFonts() {
  fonts ??= Promise.all([readFile(fileURLToPath(FONT_REGULAR)), readFile(fileURLToPath(FONT_BOLD))]).then(([r, b]) => [
    { name: "Mono", data: r, weight: 400 as const, style: "normal" as const },
    { name: "Mono", data: b, weight: 700 as const, style: "normal" as const },
  ]);
  fonts.catch(() => { fonts = null; });
  return fonts;
}

// The page's dark theme (globals.css .dark, Forks.tsx KIND_BG / WhyUnknown)
const BG = "#020817";                          // --background: 222.2 84% 4.9%
const FG = "#f8fafc";                          // --foreground: 210 40% 98%
const FG70 = "rgba(248,250,252,0.7)", FG50 = "rgba(248,250,252,0.5)", FG60 = "rgba(248,250,252,0.6)";
const STRIP = "#313131", TILE_TEXT = "#d7d7d7", TILE_SUB = "rgba(215,215,215,0.75)";
const DOT: Record<ShareKind, string> = {        // KIND_BG, dark
  stale: "#3b82f6", bitcoin_block: "#38bdf8", never_appeared: "#14b8a6", other_chain: "#8b5cf6", invalid_parent: "#f43f5e",
  invalid_coinbase: "#f43f5e", undetermined: "#6b7280",
};
const OUTLINE: Record<ShareKind, string> = {    // WhyUnknown kindStroke
  stale: "#6b7280", bitcoin_block: "#38bdf8", never_appeared: "#14b8a6", other_chain: "#8b5cf6", invalid_parent: "#f43f5e",
  invalid_coinbase: "#f43f5e", undetermined: "#6b7280",
};
const STALE_FILL = "#2563eb";                  // fill-blue-600 (dark)
const ROSE = "#f43f5e";

// The blocks strip's 104 x 64 chevron, scaled
const S = 2.4, TW = 104 * S, TH = 64 * S, G = 4 * S, ROW_GAP = 22 * S;
const chevron = (x: number, y: number) =>
  [[4, 32], [19, 0], [104, 0], [90, 32], [104, 64], [19, 64]].map(([px, py]) => `${x + px * S},${y + py * S}`).join(" ");
const tileX = (col: 0 | 1) => col * (TW + G);
const tileY = (row: 0 | 1) => row * (TH + ROW_GAP);

function tilePaint(style: TileStyle, kind: ShareKind) {
  switch (style) {
    case "strip": return { fill: STRIP, stroke: "none", dashed: false, text: TILE_TEXT, sub: TILE_SUB };
    case "stale": return { fill: STALE_FILL, stroke: "none", dashed: false, text: "#ffffff", sub: "rgba(255,255,255,0.8)" };
    case "outline": return { fill: "none", stroke: OUTLINE[kind], dashed: true, text: TILE_TEXT, sub: TILE_SUB };
    case "overpaid": return { fill: STRIP, stroke: ROSE, dashed: false, text: TILE_TEXT, sub: TILE_SUB };
  }
}

function Diagram({ e, m }: { e: Episode; m: CardModel }) {
  const W = 1200 - 2 * 56, H = 2 * TH + ROW_GAP + 4;
  const overpaid = e.kind === "invalid_coinbase";
  const parent = m.tiles.find(t => t.row === 1);
  // the pools beside the parent (below our chain for an invalid coinbase, which has none)
  const textX = parent ? tileX(parent.col) + TW + 24 : 0;
  const textY = parent ? tileY(1) + 20 : tileY(1) - 6;
  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
        {m.link && <line x1={tileX(1) + 54 * S} x2={tileX(1) + 54 * S} y1={TH} y2={tileY(1)}
          stroke="rgba(248,250,252,0.3)" strokeWidth={2.5} strokeDasharray="7 7" />}
        {m.tiles.map((t, i) => {
          const p = tilePaint(t.style, e.kind);
          return <polygon key={i} points={chevron(tileX(t.col) + 2, tileY(t.row) + 2)} fill={p.fill} stroke={p.stroke}
            strokeWidth={p.stroke === "none" ? 0 : 3.5} strokeDasharray={p.dashed ? "10 7" : undefined} />;
        })}
      </svg>
      {m.tiles.map((t, i) => {
        const p = tilePaint(t.style, e.kind);
        return (
          <div key={i} style={{
            position: "absolute", left: tileX(t.col) + 2 + 12 * S, top: tileY(t.row) + 2, width: 84 * S, height: TH,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          }}>
            <div style={{ display: "flex", fontSize: 15 * S, fontWeight: 700, color: p.text }}>{t.label}</div>
            {t.sub && <div style={{ display: "flex", fontSize: 9.5 * S, color: p.sub, marginTop: 4 }}>{t.sub}</div>}
          </div>
        );
      })}
      {m.ourTip && <div style={{ position: "absolute", left: TW + 24, top: TH / 2 - 16, display: "flex", fontSize: 26, color: FG50 }}>our tip</div>}
      <div style={{ position: "absolute", left: textX, top: textY, width: W - textX, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 30, color: overpaid ? ROSE : FG70 }}>{m.builtOn}</div>
        <div style={{ display: "flex", fontSize: 25, color: FG50, marginTop: 8, lineHeight: 1.3 }}>{m.pools}</div>
        {m.invalidCoinbase && <div style={{ display: "flex", fontSize: 24, color: ROSE, marginTop: 8 }}>{m.invalidCoinbase}</div>}
        <div style={{ display: "flex", fontSize: 25, color: FG50, marginTop: 8 }}>{m.facts}</div>
      </div>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column", background: BG, color: FG,
      padding: "44px 56px", fontFamily: "Mono",
    }}>
      <div style={{ display: "flex", fontSize: 24, color: FG50 }}>{SITE_NAME} · Forks</div>
      {children}
    </div>
  );
}

const Dot = ({ kind, d }: { kind: ShareKind; d: number }) => (
  <div style={{ display: "flex", width: d, height: d, borderRadius: d / 2, marginRight: d * 0.6,
    background: kind === "invalid_coinbase" ? "transparent" : DOT[kind], border: `${Math.round(d / 7)}px solid ${DOT[kind]}` }} />
);

export function episodeCard(e: Episode, m: CardModel) {
  return (
    <Frame>
      {/* the page's episode header: kind, height, parent */}
      <div style={{ display: "flex", alignItems: "center", marginTop: 16 }}>
        <Dot kind={e.kind} d={26} />
        <div style={{ display: "flex", fontSize: 40 }}>{KIND_TITLE[e.kind]}</div>
        <div style={{ display: "flex", fontSize: 50, fontWeight: 700, marginLeft: 30 }}>{fmtInt(e.height)}</div>
        <div style={{ display: "flex", fontSize: 26, color: FG60, marginLeft: 30 }}>{m.hash}</div>
      </div>
      <div style={{ display: "flex", fontSize: 22, color: FG50, marginTop: 26, marginBottom: 8 }}>our chain</div>
      <Diagram e={e} m={m} />
    </Frame>
  );
}

/** /forks itself (and a link with no episode to draw): the count per kind over the last 12,096 blocks. */
export function forksCard(episodes: Episode[] | null) {
  const counts = new Map<ShareKind, number>();
  for (const e of episodes ?? []) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return (
    <Frame>
      <div style={{ display: "flex", fontSize: 72, fontWeight: 700, marginTop: 18 }}>Forks</div>
      <div style={{ display: "flex", fontSize: 30, color: FG60, marginTop: 8 }}>Templates built on a block other than our best one</div>
      <div style={{ display: "flex", flex: 1, alignItems: "flex-end", alignContent: "flex-end", flexWrap: "wrap" }}>
        {SELECTION_ORDER.filter(k => counts.get(k)).map(k => (
          <div key={k} style={{ display: "flex", alignItems: "center", marginRight: 44, marginTop: 18 }}>
            <Dot kind={k} d={24} />
            <div style={{ display: "flex", fontSize: 34 }}>{KIND_TITLE[k]}</div>
            <div style={{ display: "flex", fontSize: 34, color: FG60, marginLeft: 14 }}>{fmtInt(counts.get(k)!)}</div>
          </div>
        ))}
      </div>
      {episodes && <div style={{ display: "flex", fontSize: 24, color: FG50, marginTop: 22 }}>last 12,096 blocks</div>}
    </Frame>
  );
}

const respond = async (el: React.ReactElement) =>
  new ImageResponse(el, { ...size, fonts: await loadFonts(), headers: { "Cache-Control": `public, max-age=${CACHE_S}` } });

export async function forksImage() {
  return respond(forksCard(await loadEpisodes("6e")));
}

export async function episodeImage(segments: string[]) {
  const r = await resolveCached(segments.join("/"));
  if (r.status !== "found") return respond(forksCard(null));
  return respond(episodeCard(r.episode, cardModel(r.episode, await loadBlocksAt(r.episode.height))));
}
