/**
 * Soft-fork deployments with a mandatory-signalling window: every block in it must set the deployment's version bit,
 * and a node enforcing the deployment rejects a block that doesn't. A chain the rest of the network doesn't follow
 * can split off there (BIP-110 did at 961,632).
 */
export interface MandatorySignal {
  name: string;
  bit: number;              // version bit
  from: number;             // first height that must signal
  to: number;               // last height that must signal
  url: string;
}

export const MANDATORY_SIGNALS: readonly MandatorySignal[] = [
  // Reduced Data Temporary Softfork: bit 4, mandatory signalling for blocks 961632 to 963647 (its BIP, Deployment)
  { name: 'BIP-110', bit: 4, from: 961_632, to: 963_647, url: 'https://github.com/bitcoin/bips/blob/master/bip-0110.mediawiki' },
];

const signals = (version: number, bit: number) => Math.floor(version / 2 ** bit) % 2 === 1;

/**
 * The deployment whose chain work on a parent follows, judged only by recorded facts: the parent is a block at
 * height - 1 inside the deployment's mandatory window, it isn't our best block, our best block there doesn't signal
 * (so our chain doesn't follow the deployment), and every template on the parent signals (as that chain requires).
 * Null otherwise (also when our best block's version isn't known).
 */
export function followsDeployment(
  height: number, canonical: boolean, bestVersion: number | null, versions: readonly number[],
): MandatorySignal | null {
  if (canonical || bestVersion === null || versions.length === 0) return null;
  return MANDATORY_SIGNALS.find(d => height - 1 >= d.from && height - 1 <= d.to && !signals(bestVersion, d.bit)
    && versions.every(v => signals(v, d.bit))) ?? null;
}
