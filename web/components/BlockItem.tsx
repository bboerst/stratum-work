import React from 'react';
import { Block } from '../types/blockTypes';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

interface BlockItemProps {
  block: Block;
  selectedBlockHeight: number | null;
  handleBlockClick: (block: Block) => void;
}

// Define the actual component function
const BlockItemComponent: React.FC<BlockItemProps> = ({ 
  block,
  selectedBlockHeight,
  handleBlockClick,
}) => {
  // Determine if the block is the special "being-mined" placeholder
  // This logic might need adjustment if the "being-mined" block is handled separately outside the map
  const isBeingMinedPlaceholder = block.height === -1 && block.block_hash === 'being-mined';

  // Skip rendering if it's the placeholder handled elsewhere
  if (isBeingMinedPlaceholder) {
    return null; 
  }

  const siblings = block.stale_siblings ?? [];
  const stacked = siblings.length > 0;

  const tile = (
    <div
      key={block.height} // Key remains important here for React's list reconciliation
      data-block-height={block.height}
      className={`block-3d shrink-0 ${stacked ? 'stacked' : ''} ${ 
        selectedBlockHeight === block.height ? 'selected-block' : ''
      } ${block.block_hash === 'pending' ? 'pending-block' : ''} ${ 
        block.isRealtime ? 'realtime-block' : 'historical-block'
      }`}
      title={stacked ? undefined :
        block.block_hash === 'pending'
          ? `Block ${block.height} - Waiting for data...`
          : `Block ${block.height}\nMined by: ${ 
              block.mining_pool?.name || '?' 
            }\nHash: ${block.block_hash}\nType: ${ 
              block.isRealtime ? 'Real-time' : 'Historical' 
            }`
      }
      onClick={() => block.block_hash !== 'pending' && handleBlockClick(block)}
    >
      <div className="flex flex-col items-center justify-center w-full px-2">
        <span className="text-base font-bold">{block.height}</span>
        <span className="text-[10px] opacity-75 truncate max-w-[80px] text-center">
          {block.block_hash === 'pending'
            ? '~receiving~'
            : block.mining_pool?.name || '?'} 
        </span>
        {(block.mining_pool?.datum_template_creator || block.mining_pool?.datum_gateway_default) && (
          <span className="text-[9px] opacity-60 truncate max-w-[80px] text-center"
                title={block.mining_pool.datum_template_creator ? undefined : `DATUM default tag "${block.mining_pool.datum_gateway_default}"`}>
            {block.mining_pool.datum_template_creator || 'unnamed miner'}
          </span>
        )}
      </div>
      {/* Analysis icons in upper-right corner */}
      {block.analysis?.flags && block.analysis.flags.length > 0 && (
        <div className="absolute top-px right-2 z-20 flex gap-1">
          <TooltipProvider>
            {block.analysis.flags.map((flag, idx) => (
              <Tooltip key={`${flag.key}-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="h-4 text-white flex items-center justify-center cursor-default"
                    aria-label={flag.title || flag.key}
                    title={flag.title}
                  >
                    {flag.icon === 'fork' ? (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <circle cx="6" cy="4" r="2" />
                        <circle cx="18" cy="4" r="2" />
                        <circle cx="12" cy="20" r="2" />
                        <path d="M6 6v2a6 6 0 0 0 6 6" />
                        <path d="M18 6v2a6 6 0 0 1-6 6" />
                        <path d="M12 14v4" />
                      </svg>
                    ) : flag.icon === 'error' ? '!' : '•'}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <div className="max-w-xs whitespace-pre-wrap">
                    {flag.icon === 'fork'
                      ? 'Different previous block hash detected'
                      : (flag.tooltip || flag.title || flag.key)}
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        </div>
      )}
    </div>
  );

  if (!stacked) return tile;

  // Several blocks found at this height: the best one in front, the stale ones (up to two drawn) peeking out behind
  // it. Hover lists them; a stale row opens height + 1, where the templates that built on it are (the fork view).
  const short = (h: string) => `${h.slice(0, 4)}…${h.slice(-8)}`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="block-stack shrink-0">
            {siblings.slice(0, 2).map((s, i) => (
              <div key={s.block_hash} className="block-stack-layer" style={{ left: `${4 * (siblings.length > 1 ? 2 - i : 1)}px`, opacity: i === 0 ? 0.9 : 0.6 }} />
            ))}
            {tile}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-neutral-900 text-neutral-100 border border-neutral-700 p-2">
          <div className="text-[11px] font-mono space-y-1">
            <div className="flex items-center gap-2 px-1">
              <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 shrink-0" />
              <span className="w-24 truncate">{block.mining_pool?.name || '?'}</span>
              <span className="opacity-60">{short(block.block_hash)}</span>
            </div>
            {siblings.map(s => (
              <button
                key={s.block_hash}
                type="button"
                className="flex items-center gap-2 w-full text-left rounded-sm px-1 hover:bg-neutral-800"
                onClick={() => handleBlockClick({ height: block.height + 1, block_hash: '', timestamp: 0 })}
              >
                <span className="w-2.5 h-2.5 rounded-xs bg-[#1550a4] shrink-0" />
                <span className="w-24 truncate">{s.pool || '?'}</span>
                <span className="opacity-60">{short(s.block_hash)}</span>
                <span className="opacity-60">→ {block.height + 1}</span>
              </button>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

// Memoize the component using the correct name
const MemoizedBlockItem = React.memo(BlockItemComponent);

// Use named export instead of default
export { MemoizedBlockItem as BlockItem }; 