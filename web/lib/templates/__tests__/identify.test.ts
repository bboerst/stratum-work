import { describe, expect, it } from 'vitest';
import fx from './fixtures/identity-fixtures.json';
import { identifyPool, makeIdentifier, parsePoolDefs } from '../identify';

const pools = parsePoolDefs(fx.pools);

function expectedIdentity(e: Record<string, unknown>) {
  if (!e || !('name' in e)) return { id: null, name: 'Unknown', method: 'none' };
  const id = { id: String(e.id), name: e.name, method: e.identification_method } as Record<string, unknown>;
  if (e.datum_template_creator) id.datumTemplateCreator = e.datum_template_creator;
  return id;
}

describe('identifyPool parity with backend/analytics/pool_identification.py', () => {
  for (const c of fx.cases) {
    it(c.name, () => {
      expect(identifyPool(pools, c.scriptHex, c.addresses)).toEqual(expectedIdentity(c.expected));
      expect(makeIdentifier(pools)(c.scriptHex, c.addresses)).toEqual(expectedIdentity(c.expected));
    });
  }
  it('parsePoolDefs tolerates missing arrays and bad input', () => {
    expect(parsePoolDefs([{ id: 9, name: 'X' }])).toEqual([{ id: '9', name: 'X', tags: [], regexes: [], addresses: [] }]);
    expect(parsePoolDefs({ error: 'x' })).toEqual([]);
  });
});
