/**
 * Short, shareable Forks links (no database, no server imports: the page component uses it too).
 *
 *   /forks/<height>                 the most notable episode at that height (SELECTION_ORDER)
 *   /forks/<height>/<kind>          the most notable episode of that kind there (KIND_SLUG)
 *   /forks/<height>/<kind>-<8 hex>  the episode whose parent ends in those 8 hex digits, for two episodes of one kind
 *                                   at one height
 *
 * No range in the link: the episode is looked up in the smallest range that has it (6e, then 26e, then all). The
 * range of an episode can't be worked out from its height (ranges filter by when templates arrived, and another
 * chain's heights are nowhere near ours), so it's read from the summaries. A kind that isn't at the height (a kind
 * can change: an unrecorded race whose block we record later) falls back to the height's most notable episode, so an
 * old link still opens the episode it was shared for, or the one that replaced it.
 */

export type ShareKind = 'stale' | 'bitcoin_block' | 'other_chain' | 'invalid_parent' | 'invalid_coinbase' | 'undetermined';
export type ShareRange = '6e' | '26e' | 'all';
export const SHARE_RANGES: readonly ShareRange[] = ['6e', '26e', 'all'];

/** What these functions read of an episode (lib/unknownParents.ts Episode, or the page's copy of it). */
export interface ShareEpisode {
  parent: string;
  height: number;
  kind: ShareKind;
  pools: { pool: string }[];
  templates: number;
  first_ms: number;
  duration_ms: number;
}

export const KIND_SLUG: Record<ShareKind, string> = {
  stale: 'race',
  bitcoin_block: 'unrecorded',
  other_chain: 'other-chain',
  invalid_parent: 'invalid-parent',
  invalid_coinbase: 'invalid-coinbase',
  undetermined: 'undetermined',
};
const SLUG_KIND = new Map(Object.entries(KIND_SLUG).map(([k, s]) => [s, k as ShareKind]));

/**
 * Which episode a height alone opens: invalid work first (an invalid coinbase, then an invalid parent: work that could
 * never make a valid block), then a race, a race whose block we never recorded, another chain, undetermined. Within a
 * kind: more pools, then more templates, then the earlier, then the lower parent hash (deterministic).
 */
export const SELECTION_ORDER: readonly ShareKind[] =
  ['invalid_coinbase', 'invalid_parent', 'stale', 'bitcoin_block', 'other_chain', 'undetermined'];

/** The glossary's names for the kinds, for titles and link previews. */
export const KIND_TITLE: Record<ShareKind, string> = {
  stale: 'Race',
  bitcoin_block: 'Race · unrecorded',
  other_chain: 'Other chain',
  invalid_parent: 'Invalid parent',
  invalid_coinbase: 'Invalid coinbase',
  undetermined: 'Undetermined',
};

const SUFFIX = 8;   // hex digits of the parent that tell two episodes of one kind at one height apart

export interface ForksPath { height: number; kind: ShareKind | null; suffix: string | null }

/** The segments after /forks; null when they aren't a short link (so the page 404s). */
export function parseForksPath(segments: string[]): ForksPath | null {
  if (segments.length < 1 || segments.length > 2) return null;
  const [h, k] = segments;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(h)) return null;
  const height = Number(h);
  if (k === undefined) return { height, kind: null, suffix: null };
  const m = /^([a-z-]+?)(?:-([0-9a-f]{8}))?$/.exec(k.toLowerCase());
  const kind = m ? SLUG_KIND.get(m[1]) : undefined;
  if (!m || !kind) return null;
  return { height, kind, suffix: m[2] ?? null };
}

function compare(a: ShareEpisode, b: ShareEpisode): number {
  return SELECTION_ORDER.indexOf(a.kind) - SELECTION_ORDER.indexOf(b.kind)
    || b.pools.length - a.pools.length
    || b.templates - a.templates
    || a.first_ms - b.first_ms
    || (a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0);
}

/** The episodes at one height, most notable first. */
export function rankAtHeight<E extends ShareEpisode>(episodes: readonly E[], height: number): E[] {
  return episodes.filter(e => e.height === height).sort(compare);
}

/**
 * The episode a path selects among the episodes at its height (any order), or null when there is none at that height.
 * exact: whether it is the one the path names (false: the kind or suffix wasn't there, so it fell back).
 */
export function selectEpisode<E extends ShareEpisode>(episodes: readonly E[], path: ForksPath): { episode: E; exact: boolean } | null {
  const ranked = rankAtHeight(episodes, path.height);
  if (ranked.length === 0) return null;
  const pick = path.suffix !== null
    ? ranked.find(e => e.parent.endsWith(path.suffix!))
    : path.kind !== null ? ranked.find(e => e.kind === path.kind) : ranked[0];
  return pick ? { episode: pick, exact: true } : { episode: ranked[0], exact: false };
}

/** The shortest path that selects this episode among the given ones (those at its height count). */
export function shortPath(e: ShareEpisode, episodes: readonly ShareEpisode[]): string {
  const ranked = rankAtHeight(episodes.some(x => x.parent === e.parent) ? episodes : [...episodes, e], e.height);
  const base = `/forks/${e.height}`;
  if (ranked[0]?.parent === e.parent) return base;
  if (ranked.find(x => x.kind === e.kind)?.parent === e.parent) return `${base}/${KIND_SLUG[e.kind]}`;
  return `${base}/${KIND_SLUG[e.kind]}-${e.parent.slice(-SUFFIX)}`;
}

/**
 * The path the page writes for an episode it shows from one range's summary. The short forms are resolved against the
 * smallest range with anything at that height, so they are only safe when this is the smallest range (6e) or the
 * episode is alone at its height here (a smaller range then has it alone or nothing). Otherwise a larger range can
 * hold an episode a smaller one lacks, and the bare or kind form would open another one: the suffix form, which
 * matches exactly in any range.
 */
export function pagePath(e: ShareEpisode, episodes: readonly ShareEpisode[], range: ShareRange): string {
  if (range === SHARE_RANGES[0] || rankAtHeight(episodes, e.height).length <= 1) return shortPath(e, episodes);
  return `/forks/${e.height}/${KIND_SLUG[e.kind]}-${e.parent.slice(-SUFFIX)}`;
}

/**
 * Resolve a path against the ranges' summaries, smallest range first: the first range with an exact match wins, else
 * the first with any episode at the height (a fallback). load returns a range's episodes, or null (no data).
 */
export async function resolvePath<E extends ShareEpisode>(
  path: ForksPath, load: (r: ShareRange) => Promise<readonly E[] | null>,
): Promise<{ range: ShareRange; episode: E; episodes: readonly E[]; exact: boolean } | null> {
  let fallback: { range: ShareRange; episode: E; episodes: readonly E[]; exact: boolean } | null = null;
  for (const range of SHARE_RANGES) {
    const episodes = await load(range);
    if (!episodes) continue;
    const s = selectEpisode(episodes, path);
    if (s?.exact) return { range, episodes, ...s };
    if (s && !fallback) fallback = { range, episodes, ...s };
  }
  return fallback;
}

/**
 * The short path of the episode with this parent (an old /forks?parent= link), checked by resolving it back: null
 * when the parent is in no range, or its short path wouldn't select it. asked: the link's range, tried first.
 */
export async function shortPathForParent<E extends ShareEpisode>(
  parent: string, load: (r: ShareRange) => Promise<readonly E[] | null>, asked: ShareRange | null = null,
): Promise<string | null> {
  let episode: E | undefined;
  for (const range of asked ? [asked, ...SHARE_RANGES.filter(r => r !== asked)] : SHARE_RANGES) {
    episode = (await load(range))?.find(e => e.parent === parent);
    if (episode) break;
  }
  if (!episode) return null;
  // the path is resolved the way the short link will be: against the smallest range with that height
  for (const candidate of [`/forks/${episode.height}`, `/forks/${episode.height}/${KIND_SLUG[episode.kind]}`,
    `/forks/${episode.height}/${KIND_SLUG[episode.kind]}-${episode.parent.slice(-SUFFIX)}`]) {
    const p = parseForksPath(candidate.split('/').slice(2));
    const r = p && await resolvePath(p, load);
    if (r?.exact && r.episode.parent === parent) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Link previews

export const fmtInt = (n: number) => n.toLocaleString('en-US');

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

const plural = (n: number, w: string) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;

export const SITE_NAME = 'stratum.work';

/** "Race at 976,175 · 7 pools · stratum.work" */
export function episodeTitle(e: ShareEpisode): string {
  return `${KIND_TITLE[e.kind]} at ${fmtInt(e.height)} · ${plural(e.pools.length, 'pool')} · ${SITE_NAME}`;
}

const BUILT_ON: Record<ShareKind, string> = {
  stale: 'a stale block we recorded',
  bitcoin_block: 'a valid Bitcoin block we never recorded',
  other_chain: "another chain's block",
  invalid_parent: "a parent that can't be a valid Bitcoin block",
  invalid_coinbase: '',
  undetermined: 'a parent of undetermined kind',
};

/** One line from the episode's facts, e.g. "7 pools built on a stale block we recorded for 72s (1,234 templates)." */
export function episodeDescription(e: ShareEpisode): string {
  const what = e.kind === 'invalid_coinbase'
    ? `${plural(e.pools.length, 'pool')} sent templates whose coinbase pays more than the block can`
    : `${plural(e.pools.length, 'pool')} built on ${BUILT_ON[e.kind]} for ${fmtDuration(e.duration_ms)}`;
  return `Height ${fmtInt(e.height)}: ${what} (${plural(e.templates, 'template')}).`;
}

export const FORKS_TITLE = `Forks · ${SITE_NAME}`;
export const FORKS_DESCRIPTION =
  'Templates mining pools built on a block other than our best one: races, other chains and invalid work, by block height.';
