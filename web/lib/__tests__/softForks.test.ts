import { describe, expect, it } from 'vitest';
import { followsDeployment } from '../softForks';

const SIGNALS = 0x20000010, PLAIN = 0x20006000;

describe('followsDeployment (BIP-110: bit 4, mandatory for 961,632-963,647)', () => {
  it('names a chain whose every template signals, on a parent in the window our best chain (not signalling) left', () => {
    expect(followsDeployment(961_633, false, PLAIN, [SIGNALS, SIGNALS])?.name).toBe('BIP-110');
    expect(followsDeployment(963_648, false, PLAIN, [SIGNALS])?.name).toBe('BIP-110');      // parent 963,647: last
  });
  it('says nothing outside the window, for our best block, or when the evidence is mixed or missing', () => {
    expect(followsDeployment(961_632, false, PLAIN, [SIGNALS])).toBeNull();                  // parent 961,631
    expect(followsDeployment(963_649, false, PLAIN, [SIGNALS])).toBeNull();
    expect(followsDeployment(961_633, true, PLAIN, [SIGNALS])).toBeNull();
    expect(followsDeployment(961_633, false, PLAIN, [SIGNALS, PLAIN])).toBeNull();
    expect(followsDeployment(961_633, false, SIGNALS, [SIGNALS])).toBeNull();               // our chain signals too
    expect(followsDeployment(961_633, false, null, [SIGNALS])).toBeNull();
    expect(followsDeployment(961_633, false, PLAIN, [])).toBeNull();
  });
});
