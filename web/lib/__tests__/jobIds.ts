import { templateIdSuffix } from '../connectionMask';

/**
 * Test helper: the job id behind a served template id (`<source_id>-<µs>-<keyed hash of the job id>`, lib/db/pg-mapping.ts),
 * found among the job ids a test inserted (add them as they are inserted).
 */
export function jobIds() {
  const known = new Set<string>();
  return {
    add(job: string): string { known.add(job); return job; },
    of(id: string): string | undefined {
      const [source, us, suffix] = id.split('-');
      for (const j of known) if (templateIdSuffix(source, us, j) === suffix) return j;
      return undefined;
    },
  };
}
