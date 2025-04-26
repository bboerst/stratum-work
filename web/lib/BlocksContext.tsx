"use client";
import React, { createContext, useContext, useState, useRef, ReactNode, MutableRefObject } from 'react';
import { Block } from '@/types/blockTypes';

interface BlocksContextType {
  blocks: Block[];
  setBlocks: React.Dispatch<React.SetStateAction<Block[]>>;
  scrollPosition: number;
  setScrollPosition: React.Dispatch<React.SetStateAction<number>>;
  hasMore: boolean;
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  lastLoadedHeight: number | null;
  setLastLoadedHeight: React.Dispatch<React.SetStateAction<number | null>>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  selectedBlockRef: MutableRefObject<number | null>;
  scrollToBlock: (height: number) => void;
  shouldAutoScroll: boolean;
  setShouldAutoScroll: React.Dispatch<React.SetStateAction<boolean>>;
  resetBlocksState: () => void;
}

const BlocksContext = createContext<BlocksContextType | undefined>(undefined);

export function BlocksProvider({ children }: { children: ReactNode }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [scrollPosition, setScrollPosition] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [lastLoadedHeight, setLastLoadedHeight] = useState<number | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState<boolean>(true);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedBlockRef = useRef<number | null>(null);

  // Function to scroll to a specific block
  const scrollToBlock = (height: number) => {
    if (!containerRef.current) {
      return;
    }
    
    // Special case for being-mined block (height -1)
    if (height === -1) {
      // Scroll to the beginning of the list
      containerRef.current.scrollLeft = 0;
      
      // Store the selected block height in the ref
      selectedBlockRef.current = -1;
      
      // Add a class to highlight the being-mined block
      const allBlocks = containerRef.current.querySelectorAll('.block-3d');
      allBlocks.forEach(block => {
        block.classList.remove('selected-block');
      });
      
      const beingMinedBlock = containerRef.current.querySelector('[data-block-height="-1"]');
      if (beingMinedBlock) {
        beingMinedBlock.classList.add('selected-block');
      }
      
      return;
    }
    
    // Find the block element by height
    const blockElement = containerRef.current.querySelector(`[data-block-height="${height}"]`);
    
    if (blockElement) {
      // Calculate the scroll position to center the block
      const containerWidth = containerRef.current.clientWidth;
      const blockLeft = (blockElement as HTMLElement).offsetLeft;
      const blockWidth = (blockElement as HTMLElement).offsetWidth;
      
      // Center the block in the container
      // Add a slight offset to ensure the block is not at the exact center
      // This helps with visibility by showing more blocks to the left
      const scrollLeft = blockLeft - (containerWidth / 2) + (blockWidth / 2) - 100;
      
      // Scroll to the position - use immediate scrolling without smooth behavior
      containerRef.current.scrollLeft = Math.max(0, scrollLeft);
      
      // Store the selected block height in the ref
      selectedBlockRef.current = height;
      
      // Add a class to highlight the selected block
      const allBlocks = containerRef.current.querySelectorAll('.block-3d');
      allBlocks.forEach(block => {
        block.classList.remove('selected-block');
      });
      blockElement.classList.add('selected-block');
    } else {
      // If the block element is not found, try again after a short delay
      // This can happen if the DOM hasn't been updated yet
      setTimeout(() => {
        if (containerRef.current) {
          const blockElement = containerRef.current.querySelector(`[data-block-height="${height}"]`);
          if (blockElement) {
            // Calculate the scroll position to center the block
            const containerWidth = containerRef.current.clientWidth;
            const blockLeft = (blockElement as HTMLElement).offsetLeft;
            const blockWidth = (blockElement as HTMLElement).offsetWidth;
            
            // Center the block in the container
            // Add a slight offset to ensure the block is not at the exact center
            // This helps with visibility by showing more blocks to the left
            const scrollLeft = blockLeft - (containerWidth / 2) + (blockWidth / 2) - 100;
            
            // Scroll to the position - use immediate scrolling without smooth behavior
            containerRef.current.scrollLeft = Math.max(0, scrollLeft);
            
            // Store the selected block height in the ref
            selectedBlockRef.current = height;
            
            // Add a class to highlight the selected block
            const allBlocks = containerRef.current.querySelectorAll('.block-3d');
            allBlocks.forEach(block => {
              block.classList.remove('selected-block');
            });
            blockElement.classList.add('selected-block');
          }
        }
      }, 100);
    }
  };

  // Function to reset the blocks list state
  const resetBlocksState = () => {
    // Reset state in a more targeted way
    // Only reset if we have blocks or other state that needs resetting
    if (blocks.length > 0) {
      setBlocks([]);
    }
    
    if (!hasMore) {
      setHasMore(true);
    }
    
    if (lastLoadedHeight !== null) {
      setLastLoadedHeight(null);
    }
    
    if (!shouldAutoScroll) {
      setShouldAutoScroll(true);
    }
    
    // Reset scroll position
    if (containerRef.current && containerRef.current.scrollLeft > 0) {
      containerRef.current.scrollLeft = 0;
      setScrollPosition(0);
    }
    
    // Reset selected block
    if (selectedBlockRef.current !== -1) {
      selectedBlockRef.current = -1;
    }
  };

  const value: BlocksContextType = {
    blocks,
    setBlocks,
    scrollPosition,
    setScrollPosition,
    hasMore,
    setHasMore,
    lastLoadedHeight,
    setLastLoadedHeight,
    containerRef,
    selectedBlockRef,
    scrollToBlock,
    shouldAutoScroll,
    setShouldAutoScroll,
    resetBlocksState
  };

  return (
    <BlocksContext.Provider value={value}>
      {children}
    </BlocksContext.Provider>
  );
}

export function useBlocks() {
  const context = useContext(BlocksContext);
  if (context === undefined) {
    throw new Error('useBlocks must be used within a BlocksProvider');
  }
  return context;
} 