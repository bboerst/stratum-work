// One colour per pool, the same in every visual (#157). Assigned by a stable hash of the name, so a pool keeps
// its colour across pages, reloads and as other pools come and go. Colours are mid-lightness so they read on both
// the light and the dark theme.

const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#59a14f", "#b07aa1", "#edc948", "#76b7b2", "#ff9da7",
  "#9c755f", "#86bcb6", "#d37295", "#a0cbe8", "#ffbe7d", "#8cd17d", "#f1ce63", "#bab0ac",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function poolColor(poolName: string): string {
  return PALETTE[hash(poolName) % PALETTE.length];
}
