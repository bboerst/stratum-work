/**
 * Connection letters for the live stream's `?connections=all` mode (#321): a pool's sources ranked by (site, replica)
 * over the `sources` table (lib/db/sources.ts), as the history views and the height page label them. Never from the
 * connections the stream happens to see: b stays b while a is down.
 *
 * Cached in memory; refreshed in the background every `refreshMs` and on a miss (a new collector), at most every
 * `retryMs`. `letter()` never waits: an unknown connection (or no database) gives null, and the caller sends nothing
 * for it rather than a guessed letter.
 */
import { connectionLabel } from './parentKind';
import type { SourceRankSql } from './db/sources';

export type RankLoader = () => Promise<SourceRankSql[]>;

const defaultLoader: RankLoader = async () => {
  const { enableHistoricalData } = await import('./db/blocks');
  if (!enableHistoricalData) return [];
  const { getSourceRanks } = await import('./db/sources');
  return getSourceRanks();
};

const id = (pool: string, site: string, replica: string) => JSON.stringify([pool, site, replica]);

export class ConnectionRanks {
  private letters = new Map<string, string>();
  private loadedAt = -Infinity;
  private triedAt = -Infinity;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly loader: RankLoader = defaultLoader,
    private readonly refreshMs = 5 * 60_000,
    private readonly retryMs = 30_000,
  ) {}

  /** The connection's letter ('a', 'b', …), or null while it isn't known. */
  letter(pool: string, site: string, replica: string, now: number = Date.now()): string | null {
    const l = this.letters.get(id(pool, site, replica)) ?? null;
    if ((l === null || now - this.loadedAt > this.refreshMs) && now - this.triedAt >= this.retryMs) void this.refresh(now);
    return l;
  }

  /** Reloads the ranking (one load at a time); keeps the previous one if it fails. */
  refresh(now: number = Date.now()): Promise<void> {
    if (this.loading) return this.loading;
    this.triedAt = now;
    this.loading = (async () => {
      try {
        const rows = await this.loader();
        const next = new Map<string, string>();
        for (const r of rows) next.set(id(r.name, r.site, r.replica), connectionLabel(r.conn));
        this.letters = next;
        this.loadedAt = now;
      } catch (err) {
        console.error('Live stream: could not read the connection ranking:', err instanceof Error ? err.message : err);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
}
