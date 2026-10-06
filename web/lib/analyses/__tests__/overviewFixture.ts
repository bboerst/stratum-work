import { TemplateStore } from '@/lib/templates/store';
import type { RawTemplate } from '@/lib/templates/types';
import { makeRaw, tsHex } from '@/lib/templates/__tests__/fixtures';

export const NOW = 1_700_000_600_000;
export function storeWithClones() {
  const s = new TemplateStore({ retentionMs: null, now: () => NOW, schedule: () => 0 });
  const raws: RawTemplate[] = [];
  for (let i = 0; i < 40; i++) {
    const at = NOW - 3_000_000 + i * 60_000, br = [`s${i}`, 'y', 'z'];
    raws.push(makeRaw({ pool_name: 'A', timestamp: tsHex(at), merkle_branches: br }));
    raws.push(makeRaw({ pool_name: 'B', timestamp: tsHex(at + 80), merkle_branches: br }));
    raws.push(makeRaw({ pool_name: 'C', timestamp: tsHex(at), merkle_branches: [`c${i}`, 'y', 'z'] }));
    raws.push(makeRaw({ pool_name: 'D', timestamp: tsHex(at), merkle_branches: [`d${i}`, 'y', 'z'] }));
    raws.push(makeRaw({ pool_name: 'W', connection_id: 'W/work', mode: 'work', timestamp: tsHex(at), merkle_branches: br }));
  }
  s.ingest(raws);
  s.setPools([]);
  s.ingestBlocks(Array.from({ length: 100 }, (_, i) => ({ hash: `h${i}`, height: 1000 + i, mining_pool: { id: 1, name: i < 60 ? 'A' : i < 80 ? 'C' : 'Hidden' } })) as never);
  return s;
}
