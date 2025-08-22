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

  return (
    <div
      key={block.height} // Key remains important here for React's list reconciliation
      data-block-height={block.height}
      className={`block-3d shrink-0 ${ 
        selectedBlockHeight === block.height ? 'selected-block' : ''
      } ${block.block_hash === 'pending' ? 'pending-block' : ''} ${ 
        block.isRealtime ? 'realtime-block' : 'historical-block'
      }`}
      title={
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
      </div>
      {/* Analysis icons in upper-right corner */}
      {block.analysis?.flags && block.analysis.flags.length > 0 && (
        <div className="absolute top-1 right-1 flex gap-1">
          <TooltipProvider>
            {block.analysis.flags.map((flag, idx) => (
              <Tooltip key={`${flag.key}-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="h-4 w-4 rounded-sm bg-black/70 text-white flex items-center justify-center cursor-default"
                    aria-label={flag.title || flag.key}
                    title={flag.title}
                  >
                    {flag.icon === 'fork' ? 'Y' : flag.icon === 'error' ? '!' : '•'}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <div className="max-w-xs whitespace-pre-wrap">
                    {flag.title && <div className="font-semibold mb-1">{flag.title}</div>}
                    <div>{flag.tooltip || flag.key}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        </div>
      )}
    </div>
  );
};

// Memoize the component using the correct name
const MemoizedBlockItem = React.memo(BlockItemComponent);

// Use named export instead of default
export { MemoizedBlockItem as BlockItem }; 