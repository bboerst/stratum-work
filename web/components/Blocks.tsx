"use client";
import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useBlocks } from "@/lib/BlocksContext";
import { Block } from '../types/blockTypes';
import { BlockItem } from '@/components/BlockItem'; // Use named import

interface BlocksProps { 
  onBlockClick?: (height: number) => void;
  selectedBlockHeight?: number | null;
}

export default function Blocks({ onBlockClick, selectedBlockHeight }: BlocksProps) {
  const { 
    blocks, 
    setBlocks, 
    scrollPosition, 
    setScrollPosition, 
    hasMore, 
    setHasMore, 
    lastLoadedHeight: contextLastLoadedHeight, 
    setLastLoadedHeight,
    containerRef,
    selectedBlockRef,
    scrollToBlock,
    setShouldAutoScroll,
    resetBlocksState
  } = useBlocks();
  
  const [currentBlockHeight, setCurrentBlockHeight] = useState<number | null>(null);
  const [pendingBlockHeights, setPendingBlockHeights] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const observerRef = useRef<HTMLDivElement>(null);
  const newerObserverRef = useRef<HTMLDivElement>(null);
  const isRequestingRef = useRef(false);
  const isRequestingNewerRef = useRef(false);
  const blocksRef = useRef<Block[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastLoadedHeight = useRef<number | null>(contextLastLoadedHeight);
  const highestHistoricalBlockRef = useRef<number | null>(null); // Track the highest historical block
  const isLoadingOlderRef = useRef(false);
  const initialLoadDoneRef = useRef<Record<number, boolean>>({});

  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();

  // Update the context's lastLoadedHeight when our ref changes
  useEffect(() => {
    setLastLoadedHeight(lastLoadedHeight.current);
  }, [setLastLoadedHeight]);

  // Update our blocks ref when blocks change
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  // Add scroll handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Restore scroll position on mount
    if (scrollPosition > 0) {
      container.scrollLeft = scrollPosition;
      // Use the fade effect in the UI instead of storing it in state
      const leftFadeElement = document.querySelector('.left-fade');
      if (leftFadeElement) {
        leftFadeElement.classList.toggle('visible', scrollPosition > 0);
      }
    }

    // Flag to track if the scroll is user-initiated or programmatic
    let isUserScrolling = false;
    let scrollTimeout: NodeJS.Timeout | null = null;

    const handleScroll = () => {
      // Only update the scroll position if this is a user-initiated scroll
      if (!isUserScrolling) {
        isUserScrolling = true;
        
        // Clear any existing timeout
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }
        
        // Set a timeout to update the scroll position after scrolling stops
        scrollTimeout = setTimeout(() => {
          const position = container.scrollLeft;
          // Use the fade effect in the UI instead of storing it in state
          const leftFadeElement = document.querySelector('.left-fade');
          if (leftFadeElement) {
            leftFadeElement.classList.toggle('visible', position > 0);
          }
          
          // Save scroll position to context
          setScrollPosition(position);
          
          // Reset the flag
          isUserScrolling = false;
        }, 100);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
    };
  }, [containerRef, setScrollPosition, scrollPosition]);

  // Function to fetch historical blocks with pagination
  const fetchBlocksWithPromise = useCallback(async (lastHeight?: number) => {
    // Use ref to prevent concurrent requests
    if (isRequestingRef.current) {
      return Promise.resolve();
    }
    
    return new Promise<void>((resolve) => {
      isRequestingRef.current = true;
      setIsLoading(true);
      setError(null); // Clear any existing errors

      try {
        // If we have a lastHeight, request blocks at and before that height
        // and adjust batch size when approaching block 0
        const batchSize = lastHeight && lastHeight < 100 ? lastHeight : 20;
        
        // Determine the endpoint based on whether we have blocks already
        let endpoint;
        
        if (lastHeight) {
          // If we have a specific height, fetch blocks before that height
          endpoint = `/api/blocks?n=${batchSize}&before=${lastHeight}`;
        } else if (blocksRef.current.length > 0) {
          // If we have blocks but no specific height, use the lowest height we have
          // Filter to only consider historical blocks (not real-time updates)
          const historicalBlocks = blocksRef.current.filter((b: Block) => !b.isRealtime);
          if (historicalBlocks.length > 0) {
            const lowestHeight = Math.min(...historicalBlocks.map((b: Block) => b.height));
            endpoint = `/api/blocks?n=${batchSize}&before=${lowestHeight}`;
          } else {
            // If we only have real-time blocks, fetch the latest blocks
            endpoint = '/api/blocks?n=20';
          }
        } else {
          // If we have no blocks, fetch the latest blocks
          endpoint = '/api/blocks?n=20';
        }
              
        fetch(endpoint, {
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          },
          cache: 'no-store'
        })
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
          }
          return res.json();
        })
        .then(data => {
          // Validate response structure
          if (!data || typeof data !== 'object') {
            throw new Error('Invalid response format');
          }

          // Ensure blocks array exists
          const receivedBlocks = Array.isArray(data.blocks) ? data.blocks : [];
          const hasMore = !!data.has_more;
          const nextHeight = data.next_height;
          
          // If we got no blocks at all, we're done paginating
          if (receivedBlocks.length === 0) {
            setHasMore(false);
            resolve();
            return;
          }
          
          // Filter out any blocks that we already have and ensure proper typing
          const existingHeights = new Set(blocksRef.current.map((b: Block) => b.height));
          const filteredData = receivedBlocks.filter((block: unknown): block is Block => {
            if (!block || typeof block !== 'object' || block === null) {
              return false;
            }
            
            const b = block as { height?: number; block_hash?: string };
            return (
              'height' in b &&
              typeof b.height === 'number' &&
              'block_hash' in b &&
              typeof b.block_hash === 'string' &&
              !existingHeights.has(b.height)
            );
          }).map((block: Block) => ({
            ...block,
            isRealtime: false // Mark these as historical blocks
          }));
          
          if (filteredData.length === 0) {
            // If we got blocks but they were all filtered, update pagination state
            if (nextHeight !== undefined && nextHeight !== null) {
              lastLoadedHeight.current = nextHeight;
              setHasMore(hasMore);
            } else {
              setHasMore(false);
            }
          } else {
            setBlocks((prev: Block[]) => {
              // Create a map of existing blocks for quick lookup
              const existingBlocks = new Map(prev.map((b: Block) => [b.height, b]));
              
              // Add new historical blocks
              filteredData.forEach((block: Block) => {
                existingBlocks.set(block.height, block);
              });
              
              // Convert back to array and sort by height in descending order
              const sorted = Array.from(existingBlocks.values())
                .sort((a: Block, b: Block) => b.height - a.height);
              
              // Update lastLoadedHeight with the next height from the response
              if (nextHeight !== undefined && nextHeight !== null) {
                lastLoadedHeight.current = nextHeight;
              } else {
                // If no nextHeight is provided, use the lowest height we have minus 1
                const historicalBlocks = sorted.filter((b: Block) => !b.isRealtime);
                if (historicalBlocks.length > 0) {
                  const lowestHeight = Math.min(...historicalBlocks.map((b: Block) => b.height));
                  lastLoadedHeight.current = lowestHeight - 1;
                }
              }
              
              // Update the highest historical block reference
              const historicalBlocks = sorted.filter(
                (b: Block) => !b.isRealtime && b.block_hash !== 'pending' && b.height > 0
              );
              if (historicalBlocks.length > 0) {
                const highestHeight = Math.max(...historicalBlocks.map((b: Block) => b.height));
                highestHistoricalBlockRef.current = highestHeight;
              }
              
              // Check if we have contiguous blocks among the historical blocks
              const historicalHeights = historicalBlocks.map((b: Block) => b.height).sort((a, b) => a - b);
              let isContiguous = true;
              
              // Only check for contiguity if we have more than one historical block
              if (historicalHeights.length > 1) {
                // Find the largest gap between consecutive heights
                let maxGap = 0;
                for (let i = 1; i < historicalHeights.length; i++) {
                  const gap = historicalHeights[i] - historicalHeights[i-1];
                  if (gap > maxGap) {
                    maxGap = gap;
                  }
                  if (gap > 1) {
                    isContiguous = false;
                  }
                }
                
                // If the largest gap is too big, we don't have contiguous blocks
                if (maxGap > 1) {
                  isContiguous = false;
                }
              }
              
              // Update hasMore based on the response and whether we have contiguous blocks
              setHasMore(hasMore && isContiguous);
              
              return sorted;
            });
          }
          
          resolve();
        })
        .catch(err => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          setError(`Error fetching blocks: ${errorMessage}`);
          console.error("Error fetching blocks:", err);
          setHasMore(false);
          setIsLoading(false);
          isRequestingRef.current = false;
          resolve();
        })
        .finally(() => {
          setIsLoading(false);
          isRequestingRef.current = false;
        });
        
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(`Error fetching blocks: ${errorMessage}`);
        console.error("Error fetching blocks:", err);
        setHasMore(false);
        setIsLoading(false);
        isRequestingRef.current = false;
        resolve();
      }
    });
  }, [setError, setHasMore, setBlocks]);

  // Function to fetch newer blocks (towards higher block heights)
  const fetchNewerBlocks = useCallback(() => {
    // Skip if we're already loading or have a pending request
    if (isRequestingNewerRef.current) {
      return;
    }
    
    // Set loading state
    isRequestingNewerRef.current = true;
    setIsLoadingNewer(true);
    
    // Get the highest historical block we have
    const highestHistoricalBlock = highestHistoricalBlockRef.current;
    
    // Skip if we don't have a reference point
    if (highestHistoricalBlock === null) {
      setIsLoadingNewer(false);
      isRequestingNewerRef.current = false;
      return;
    }
    
    // Fetch blocks after our highest historical block
    fetch(`/api/blocks?n=10&after=${highestHistoricalBlock}`, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      cache: 'no-store'
    })
    .then(res => {
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      return res.json();
    })
    .then(data => {
      // Validate response structure
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format');
      }

      // Ensure blocks array exists
      const receivedBlocks = Array.isArray(data.blocks) ? data.blocks : [];
      
      // Skip if no blocks received
      if (receivedBlocks.length === 0) {
        return;
      }
      
      // Filter out any blocks that we already have
      const existingHeights = new Set(blocksRef.current.map((b: Block) => b.height));
      const filteredData = receivedBlocks
        .filter((block: unknown): block is Block => {
          if (!block || typeof block !== 'object' || block === null) {
            return false;
          }
          
          const b = block as { height?: number; block_hash?: string };
          return (
            'height' in b &&
            typeof b.height === 'number' &&
            'block_hash' in b &&
            typeof b.block_hash === 'string' &&
            !existingHeights.has(b.height)
          );
        })
        .map((block: Block) => ({
          ...block,
          isRealtime: false // Mark these as historical blocks
        }));
      
      // Skip if no new blocks after filtering
      if (filteredData.length === 0) {
        return;
      }
      
      // Remember current scroll position
      const savedScrollLeft = containerRef.current?.scrollLeft || 0;
      
      // Update the state with new blocks
      setBlocks((prev: Block[]) => {
        // Create a map of existing blocks for quick lookup
        const existingBlocks = new Map(prev.map((b: Block) => [b.height, b]));
        
        // Add new blocks
        filteredData.forEach((block: Block) => {
          existingBlocks.set(block.height, block);
        });
        
        // Convert back to array and sort by height in descending order
        const sorted = Array.from(existingBlocks.values())
          .sort((a, b) => b.height - a.height);
        
        // Update the highest historical block reference
        const historicalBlocks = sorted.filter(
          b => !b.isRealtime && b.block_hash !== 'pending' && b.height > 0
        );
        
        if (historicalBlocks.length > 0) {
          const highestHeight = Math.max(...historicalBlocks.map(b => b.height));
          highestHistoricalBlockRef.current = highestHeight;
        }
        
        return sorted;
      });
      
      // Restore scroll position after a short delay
      setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.scrollLeft = savedScrollLeft;
        }
      }, 50);
    })
    .catch(err => {
      console.error("Error fetching newer blocks:", err);
    })
    .finally(() => {
      setIsLoadingNewer(false);
      isRequestingNewerRef.current = false;
    });
  }, [setBlocks, containerRef]);

  // Set up intersection observer for infinite scroll with debounce
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let isIntersecting = false;
    
    const observer = new IntersectionObserver(
      (entries) => {
        // Update intersection state
        isIntersecting = entries[0].isIntersecting;
        
        const shouldFetch = isIntersecting && hasMore && !isLoading && !isRequestingRef.current;
                
        if (shouldFetch) {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          
          timeoutId = setTimeout(() => {
            // Double check conditions
            const currentHeight = lastLoadedHeight.current;
            if (isIntersecting && hasMore && !isLoading && !isRequestingRef.current) {
              // Set loading older blocks flag to true
              isLoadingOlderRef.current = true;
              
              // If this is the first load, use the lowest height we have
              if (currentHeight === null && blocksRef.current.length > 0) {
                // Filter to only consider historical blocks
                const historicalBlocks = blocksRef.current.filter(b => !b.isRealtime);
                if (historicalBlocks.length > 0) {
                  const lowestHeight = Math.min(...historicalBlocks.map(b => b.height));
                  lastLoadedHeight.current = lowestHeight;
                  
                  // Remember current scroll position
                  const savedScrollPosition = containerRef.current?.scrollLeft || 0;
                  
                  fetchBlocksWithPromise(lowestHeight).then(() => {
                    // Restore scroll position after a short delay
                    setTimeout(() => {
                      if (containerRef.current) {
                        containerRef.current.scrollLeft = savedScrollPosition;
                      }
                      isLoadingOlderRef.current = false;
                    }, 50);
                  });
                } else {
                  // If we only have real-time blocks, fetch the latest blocks
                  fetchBlocksWithPromise().then(() => {
                    isLoadingOlderRef.current = false;
                  });
                }
              } 
              // Otherwise use the current height
              else if (currentHeight !== null) {
                // Only fetch if we haven't reached block 0
                if (currentHeight > 0) {
                  // Remember current scroll position
                  const savedScrollPosition = containerRef.current?.scrollLeft || 0;
                  
                  fetchBlocksWithPromise(currentHeight).then(() => {
                    // Restore scroll position after a short delay
                    setTimeout(() => {
                      if (containerRef.current) {
                        containerRef.current.scrollLeft = savedScrollPosition;
                      }
                      isLoadingOlderRef.current = false;
                    }, 50);
                  });
                } else {
                  setHasMore(false);
                  isLoadingOlderRef.current = false;
                }
              } else {
                // If we have no blocks and no current height, just fetch the latest blocks
                fetchBlocksWithPromise().then(() => {
                  isLoadingOlderRef.current = false;
                });
              }
            }
          }, 250);
        }
      },
      { 
        threshold: 0.1,
        rootMargin: '200px' // Increased margin to start loading earlier
      }
    );

    const observerTarget = observerRef.current;
    if (observerTarget) {
      observer.observe(observerTarget);
    }
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      observer.disconnect();
    };
  }, [hasMore, isLoading, fetchBlocksWithPromise, setHasMore, containerRef]);

  // Set up intersection observer for loading newer blocks
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let isIntersecting = false;
    
    const observer = new IntersectionObserver(
      (entries) => {
        // Update intersection state
        isIntersecting = entries[0].isIntersecting;
        
        // Only consider the observer if we're actually scrolled away from the beginning
        // This prevents triggers when the list is at its initial position
        const shouldConsiderObserver = containerRef.current && containerRef.current.scrollLeft > 50;
        
        const shouldFetch = isIntersecting && 
                          shouldConsiderObserver && 
                          !isLoadingNewer && 
                          !isRequestingNewerRef.current && 
                          highestHistoricalBlockRef.current !== null;
                
        if (shouldFetch) {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          
          timeoutId = setTimeout(() => {
            // Double check conditions
            const stillShouldConsiderObserver = containerRef.current && containerRef.current.scrollLeft > 50;
            
            if (isIntersecting && 
                stillShouldConsiderObserver && 
                !isLoadingNewer && 
                !isRequestingNewerRef.current && 
                highestHistoricalBlockRef.current !== null) {
              fetchNewerBlocks();
            }
          }, 250);
        }
      },
      { 
        threshold: 0.1,
        rootMargin: '200px' // Increased margin to start loading earlier
      }
    );

    const observerTarget = newerObserverRef.current;
    if (observerTarget) {
      observer.observe(observerTarget);
    }
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      observer.disconnect();
    };
  }, [isLoadingNewer, fetchNewerBlocks, containerRef]);

  // Initial fetch of blocks
  useEffect(() => {
    // Only fetch blocks if we don't have any yet
    if (blocks.length === 0) {
      fetchBlocksWithPromise();
    }
  }, [fetchBlocksWithPromise, blocks.length]);

  // Subscribe to stratum updates to track being-mined block height
  useEffect(() => {
    // Get stratum updates from the stream
    const stratumUpdates = filterByType(StreamDataType.STRATUM_V1);
    
    if (stratumUpdates.length > 0) {
      // Get the latest stratum update
      const latestStratum = stratumUpdates[stratumUpdates.length - 1].data;
      
      // Update current block height if it's different
      if (latestStratum.height && latestStratum.height !== currentBlockHeight) {
        const newHeight = latestStratum.height;
        setCurrentBlockHeight(newHeight);
        
        // Only add pending blocks if they're newer than our highest historical block
        // AND we're not viewing a specific historical block (selectedBlockHeight is null or -1)
        if (highestHistoricalBlockRef.current === null || newHeight > highestHistoricalBlockRef.current) {
          // Only create pending blocks if we're not viewing a specific historical block
          // or if we're viewing the realtime view (selectedBlockHeight === -1)
          if (selectedBlockHeight === null || selectedBlockHeight === -1) {
            // Find the highest block we have
            const highestBlock = blocks.length > 0 ? Math.max(...blocks.map((b: Block) => b.height)) : newHeight - 1;
            
            // Add all missing block heights between our highest block and the new height - 1
            const newPendingHeights = new Set(pendingBlockHeights);
            for (let height = highestBlock + 1; height < newHeight; height++) {
              // Only add pending blocks if they're newer than our highest historical block
              if (highestHistoricalBlockRef.current === null || height > highestHistoricalBlockRef.current) {
                if (!blocks.some((b: Block) => b.height === height)) {
                  newPendingHeights.add(height);
                }
              }
            }
            
            if (newPendingHeights.size !== pendingBlockHeights.size) {
              setPendingBlockHeights(newPendingHeights);
            }
          }
        }
      }
    }
  }, [filterByType, currentBlockHeight, blocks, pendingBlockHeights, selectedBlockHeight]);

  // Subscribe to block updates from the global data stream
  useEffect(() => {
    // Get block messages from the stream
    const blockUpdates = filterByType(StreamDataType.BLOCK);
    
    if (blockUpdates.length > 0) {
      // Get the latest block update
      const latestBlock = blockUpdates[blockUpdates.length - 1].data;
      
      // Type check that this is a BlockData
      if ('hash' in latestBlock && 'timestamp' in latestBlock) {
        // Only add real-time blocks if they're newer than our highest historical block
        // AND we're not viewing a specific historical block (selectedBlockHeight is null or -1)
        if ((highestHistoricalBlockRef.current === null || latestBlock.height > highestHistoricalBlockRef.current) &&
            (selectedBlockHeight === null || selectedBlockHeight === -1)) {
          // Update the blocks list with the new block
          setBlocks((prev) => {
            // Check if we already have this block
            const existingIndex = prev.findIndex(b => b.block_hash === latestBlock.hash);
            
            // Convert the BlockData to our Block interface format
            const newBlock: Block = {
              block_hash: latestBlock.hash,
              height: latestBlock.height,
              timestamp: new Date(latestBlock.timestamp).getTime(),
              mining_pool: latestBlock.mining_pool || { id: 0, name: 'Unknown' },
              isRealtime: true // Mark this as a real-time block
            };
            
            if (existingIndex >= 0) {
              // Replace the existing block
              const newBlocks = [...prev];
              newBlocks[existingIndex] = newBlock;
              return newBlocks;
            } else {
              // Add the new block
              return [...prev, newBlock].sort((a, b) => b.height - a.height);
            }
          });
          
          // Remove this height from pending blocks if it exists
          if (pendingBlockHeights.has(latestBlock.height)) {
            const newPendingHeights = new Set(pendingBlockHeights);
            newPendingHeights.delete(latestBlock.height);
            setPendingBlockHeights(newPendingHeights);
          }
        }
      }
    }
  }, [filterByType, setBlocks, pendingBlockHeights, selectedBlockHeight]);

  // Memoize the calculation of the blocks to display
  const blocksToDisplay = useMemo(() => {
    const displayList = [...blocks];

    if (currentBlockHeight && currentBlockHeight > 0) {
      // Create pending blocks for future blocks, but NOT the current height
      // since that's shown in the dedicated "being-mined" block
      const pendingBlocks: Block[] = Array.from(pendingBlockHeights)
        .filter(height => !blocks.some(b => b.height === height) && height !== currentBlockHeight)
        .map(height => ({
          height,
          block_hash: 'pending',
          timestamp: Math.floor(Date.now() / 1000),
          isRealtime: true // Mark pending blocks as real-time
        }));
      
      // Add pending blocks and sort everything by height
      displayList.push(...pendingBlocks);
      displayList.sort((a, b) => b.height - a.height);
    }
    return displayList;
  }, [blocks, pendingBlockHeights, currentBlockHeight]); // Dependencies for useMemo

  // Load blocks for a specific height only once
  useEffect(() => {
    // Skip if selectedBlockHeight is invalid
    if (selectedBlockHeight === null || selectedBlockHeight === undefined || selectedBlockHeight <= 0) {
      return;
    }

    // Skip if we've already processed this height
    if (initialLoadDoneRef.current[selectedBlockHeight]) {
      return;
    }

    // Mark this height as processed
    initialLoadDoneRef.current[selectedBlockHeight] = true;

    // Update the selected block ref
    selectedBlockRef.current = selectedBlockHeight;
    
    // Find the block in our current blocks
    const blockIndex = blocks.findIndex(b => b.height === selectedBlockHeight);
    
    if (blockIndex >= 0) {
      // If we have the block, scroll to it once
      setTimeout(() => {
        scrollToBlock(selectedBlockHeight);
      }, 100);
    } else {
      // If we don't have the block yet, we need to fetch it once
      // First, clear existing blocks to avoid confusion
      setBlocks([]);
      setIsLoading(true);
      
      // Clear pending block heights to prevent "Receiving..." blocks
      setPendingBlockHeights(new Set());
      
      // Remember the current selectedBlockHeight to compare in the fetch callback
      const targetHeight = selectedBlockHeight;
      
      // Then fetch the block and surrounding blocks using the API endpoint
      fetch(`/api/blocks?height=${targetHeight}&n=40`)
        .then(res => res.json())
        .then(data => {
          // Check if the selectedBlockHeight has changed since we started the fetch
          if (selectedBlockHeight !== targetHeight) {
            setIsLoading(false);
            return;
          }
          
          if (data.blocks && Array.isArray(data.blocks)) {
            // Mark these as historical blocks
            const historicalBlocks = data.blocks.map((block: Block) => ({
              ...block,
              isRealtime: false
            }));
            
            setBlocks(historicalBlocks);
            
            // Update the highest historical block reference
            if (historicalBlocks.length > 0) {
              // Filter out being-mined and pending blocks
              const validHistoricalBlocks = historicalBlocks.filter(
                (b: Block) => b.block_hash !== 'pending' && b.height > 0
              );
              
              if (validHistoricalBlocks.length > 0) {
                const highestHeight = Math.max(...validHistoricalBlocks.map((b: Block) => b.height));
                highestHistoricalBlockRef.current = highestHeight;
              
                // Update lastLoadedHeight to the lowest height we have
                const lowestHeight = Math.min(...validHistoricalBlocks.map((b: Block) => b.height));
                lastLoadedHeight.current = lowestHeight;
              }
            }
            
            // After blocks are loaded, scroll to the selected one with a delay
            // but only do this once
            setTimeout(() => {
              if (selectedBlockHeight === targetHeight) {
                scrollToBlock(targetHeight);
              }
            }, 300);
          }
          setIsLoading(false);
        })
        .catch(err => {
          console.error("Error fetching block:", err);
          setError("Failed to fetch block data");
          setIsLoading(false);
        });
    }
  }, [selectedBlockHeight, blocks, scrollToBlock, setBlocks, setPendingBlockHeights, setIsLoading, setError, selectedBlockRef, fetchBlocksWithPromise, containerRef]);

  // Reset the initialLoadDoneRef when the component unmounts
  useEffect(() => {
    return () => {
      initialLoadDoneRef.current = {};
    };
  }, []);

  // Reset the initialLoadDoneRef when the being-mined block is selected
  useEffect(() => {
    if (selectedBlockHeight === -1) {
      initialLoadDoneRef.current = {};
    }
  }, [selectedBlockHeight]);

  // Make sure handleBlockClick uses useCallback or is stable
  // It seems okay already based on its definition around line 714
  const handleBlockClick = useCallback((block: Block) => {
    // Enable auto-scrolling for user clicks
    setShouldAutoScroll(true);
    
    // Special handling for being-mined block
    if (block.height === -1) {
      // Reset all state to start fresh using the context function
      resetBlocksState();
      
      // Reset component-specific state
      setPendingBlockHeights(new Set());
      setIsLoading(true);
      highestHistoricalBlockRef.current = null;
      lastLoadedHeight.current = null;
      
      // Fetch the latest blocks to start fresh
      fetch('/api/blocks?n=20')
        .then(res => res.json())
        .then(data => {
          if (data.blocks && Array.isArray(data.blocks)) {
            // Mark these as historical blocks
            const historicalBlocks = data.blocks.map((block: Block) => ({
              ...block,
              isRealtime: false
            }));
            
            setBlocks(historicalBlocks);
            
            // Update the highest historical block reference
            if (historicalBlocks.length > 0) {
              // Filter out being-mined and pending blocks
              const validHistoricalBlocks = historicalBlocks.filter(
                (b: Block) => b.block_hash !== 'pending' && b.height > 0
              );
              
              if (validHistoricalBlocks.length > 0) {
                const highestHeight = Math.max(...validHistoricalBlocks.map((b: Block) => b.height));
                highestHistoricalBlockRef.current = highestHeight;
              
                // Update lastLoadedHeight to the lowest height we have
                const lowestHeight = Math.min(...validHistoricalBlocks.map((b: Block) => b.height));
                lastLoadedHeight.current = lowestHeight;
              }
            }
          }
          setIsLoading(false);
        })
        .catch(err => {
          console.error("Error fetching fresh blocks:", err);
          setError("Failed to fetch block data");
          setIsLoading(false);
        });
    }
    
    // Call onBlockClick if provided, regardless of block height
    if (onBlockClick) {
      onBlockClick(block.height);
    }
  }, [onBlockClick, setShouldAutoScroll, resetBlocksState, setPendingBlockHeights, setIsLoading, setError, setBlocks]); // Add dependencies for useCallback

  // Update blocks ref when blocks change
  useEffect(() => {
    blocksRef.current = blocks;
    
    // Update the highest historical block reference
    const historicalBlocks = blocks.filter(
      (b: Block) => !b.isRealtime && b.block_hash !== 'pending' && b.height > 0
    );
    if (historicalBlocks.length > 0) {
      const highestHeight = Math.max(...historicalBlocks.map((b: Block) => b.height));
      highestHistoricalBlockRef.current = highestHeight;
    }
  }, [blocks]);

  return (
    <div className="relative w-full h-[64px] flex items-center">
      {error && (
        <div className="absolute top-0 left-0 right-0 bg-red-500 text-white text-sm py-1 px-2 text-center z-50">
          {error}
        </div>
      )}

      {/* Outer container with overflow hidden */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Scrollable container */}
        <div 
          ref={containerRef} 
          className="blocks-container absolute inset-0 flex items-center overflow-x-auto overflow-y-hidden"
          style={{ 
            msOverflowStyle: 'none',
            scrollbarWidth: 'none',
            overscrollBehavior: 'none'
          }}
          data-testid="blocks-container"
        >
          {/* Sticky being-mined block container with background shield */}
          <div className="sticky left-0 z-10 mr-0 relative h-[64px]">
            {/* Background shield with fade effect */}
            <div className="absolute h-[64px] bg-white dark:bg-black" style={{
              width: '45px',
              left: '0'
            }}></div>
            
            {/* Fade effect on the right side of the background shield - only shown when scrolled */}
            {scrollPosition > 0 && (
              <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-white from-50% dark:from-black to-transparent" style={{ left: '45px', zIndex: 1 }}></div>
            )}
            
            <div
              key="being-mined"
              data-block-height={-1}
              className={`block-3d ${selectedBlockHeight === -1 ? 'animate-block-pulse-orange' : 'animate-block-pulse-purple'} shrink-0 relative z-10 ${selectedBlockHeight === -1 ? 'selected-block' : ''}`}
              title={currentBlockHeight ? `Block ${currentBlockHeight} (being mined) – click for realtime` : "Waiting for updates..."}
              onClick={() => {
                // Handle click on being-mined block
                handleBlockClick({ 
                  height: -1, 
                  block_hash: 'being-mined', 
                  timestamp: Math.floor(Date.now() / 1000),
                  isRealtime: true
                });
              }}
              style={{ marginRight: '10px' }} /* Override margin for being-mined block */
            >
              <div className="flex flex-col items-center justify-center">
                <span className="text-sm font-bold">{currentBlockHeight || "?"}</span>
              </div>
            </div>
          </div>

          {/* Container for scrollable blocks */}
          <div className="flex items-center min-w-max h-[64px] relative">
            {/* Intersection observer for loading newer blocks (towards higher heights) - placed inside the blocks container */}
            <div
              ref={newerObserverRef}
              className="absolute left-0 w-2 flex items-center justify-center h-full z-10"
            >
              {isLoadingNewer && (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500"></div>
              )}
            </div>
            
            {blocksToDisplay.map((block) => (
              <BlockItem
                key={block.height} // Keep the key here for React's list diffing
                block={block}
                selectedBlockHeight={selectedBlockHeight ?? null}
                handleBlockClick={handleBlockClick}
              />
            ))}

            {/* Loading indicator and intersection observer target for older blocks */}
            <div 
              ref={observerRef} 
              className="shrink-0 w-20 flex items-center justify-center h-[64px]"
            >
              {isLoading && (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-orange-500"></div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Fixed fade effect overlay */}
      <div className="pointer-events-none fixed-fade h-[64px]">
        <div className="absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-white dark:from-black to-transparent" />
      </div>

      <style jsx global>{`
        .blocks-container::-webkit-scrollbar {
          display: none;
        }
        
        .blocks-container {
          scrollbar-width: none; /* Firefox */
          position: relative; /* For sticky positioning context */
          overflow-y: hidden; /* Prevent vertical scrolling */
        }
        
        .fixed-fade {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
          z-index: 10;
          overflow: hidden;
        }
        
        .block-3d {
          position: relative;
          width: 104px;
          height: 64px;
          background: rgb(49, 49, 49);
          color: #d7d7d7;
          font-family: monospace;
          font-weight: bold;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          margin-right: -6px;
          transform-origin: center;
          z-index: 1;
          transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
        }
        :global(.light) .block-3d {
          background: rgb(236, 234, 234);
          color: black;
        }
        .block-3d::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 104px;
          height: 64px;
          background: rgb(39, 39, 39);
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-1px);
          z-index: -1;
        }
        :global(.light) .block-3d::before {
          background: rgb(216, 214, 214);
        }
        .block-3d::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 104px;
          height: 64px;
          background: rgb(29, 29, 29);
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-2px);
          z-index: -2;
        }
        :global(.light) .block-3d::after {
          background: rgb(196, 194, 194);
        }
        .block-3d:hover {
          opacity: 0.9;
        }
        .selected-block {
          z-index: 5;
          box-shadow: 0 0 10px 2px rgba(255, 165, 0, 0.8);
          background: rgb(196, 92, 21);
          color: white;
        }
        :global(.light) .selected-block {
          box-shadow: 0 0 10px 2px rgba(255, 165, 0, 0.8);
          background: rgb(196, 92, 21);
          color: white;
        }
        :global(.light) .selected-block::before {
          background: rgb(176, 72, 0);
        }
        :global(.light) .selected-block::after {
          background: rgb(156, 52, 0);
        }
        .selected-block::before {
          background: rgb(176, 72, 0);
        }
        .selected-block::after {
          background: rgb(156, 52, 0);
        }
        .pending-block {
          background: rgb(69, 69, 69);
          opacity: 0.8;
          cursor: default;
        }
        :global(.light) .pending-block {
          background: rgb(216, 214, 214);
        }
        .pending-block::before {
          background: rgb(59, 59, 59);
        }
        :global(.light) .pending-block::before {
          background: rgb(196, 194, 194);
        }
        .pending-block::after {
          background: rgb(49, 49, 49);
        }
        :global(.light) .pending-block::after {
          background: rgb(176, 174, 174);
        }
        .pending-block:hover {
          opacity: 0.8;
        }
        .realtime-block {
          /* Subtle visual indicator for real-time blocks */
          /* Removed border-top styling as requested */
        }
        .historical-block {
          /* Subtle visual indicator for historical blocks */
          /* Removed border-top styling as requested */
        }
        
        @keyframes block-pulse {
          0% {
            filter: brightness(1);
          }
          50% {
            filter: brightness(0.4);
          }
          100% {
            filter: brightness(1);
          }
        }
        
        .animate-block-pulse-orange {
          position: relative;
          background: rgb(196, 92, 21); /* Orange background for the being-mined block */
          color: white;
          animation: block-pulse 4s ease-in-out infinite;
          width: 104px; /* Ensure full width */
          overflow: visible; /* Prevent cutting off */
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.2); /* Add shadow to separate from other blocks */
        }
        
        .animate-block-pulse-orange::before {
          content: "";
          position: absolute;
          inset: 0;
          background: rgb(176, 72, 0); /* Slightly darker orange for the side */
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-1px);
          z-index: -1;
        }
        
        .animate-block-pulse-orange::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 104px;
          height: 64px;
          background: rgb(156, 52, 0); /* Even darker orange for the bottom */
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-2px);
          z-index: -2;
        }
        
        .animate-block-pulse-gray {
          position: relative;
          background: rgb(80, 80, 80); /* Gray background for the being-mined block when not in realtime */
          color: white;
          animation: block-pulse 4s ease-in-out infinite;
          width: 104px; /* Ensure full width */
          overflow: visible; /* Prevent cutting off */
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.2); /* Add shadow to separate from other blocks */
        }
        
        :global(.light) .animate-block-pulse-gray {
          background: rgb(150, 150, 150);
          color: white;
        }
        
        .animate-block-pulse-gray::before {
          content: "";
          position: absolute;
          inset: 0;
          background: rgb(70, 70, 70); /* Slightly darker gray for the side */
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-1px);
          z-index: -1;
        }
        
        :global(.light) .animate-block-pulse-gray::before {
          background: rgb(130, 130, 130);
        }
        
        .animate-block-pulse-gray::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 104px;
          height: 64px;
          background: rgb(60, 60, 60); /* Even darker gray for the bottom */
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-2px);
          z-index: -2;
        }
        
        :global(.light) .animate-block-pulse-gray::after {
          background: rgb(110, 110, 110);
        }
        
        :global(.light) .animate-block-pulse-orange {
          background: rgb(196, 92, 21);
          color: white;
        }
        
        :global(.light) .animate-block-pulse-orange::before {
          background: rgb(176, 72, 0);
        }
        
        :global(.light) .animate-block-pulse-orange::after {
          background: rgb(156, 52, 0);
        }
        
        /* New animation class for the purple being-mined block */
        .animate-block-pulse-purple {
          position: relative;
          background: rgb(107, 70, 193); /* Purple background for the being-mined block */
          color: white;
          animation: block-pulse 4s ease-in-out infinite;
          width: 104px; /* Ensure full width */
          overflow: visible; /* Prevent cutting off */
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.2); /* Add shadow to separate from other blocks */
        }
        
        .animate-block-pulse-purple::before {
          content: "";
          position: absolute;
          inset: 0;
          background: rgb(87, 50, 173); /* Slightly darker purple for the side */
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-1px);
          z-index: -1;
        }
        
        .animate-block-pulse-purple::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 104px;
          height: 64px;
          background: rgb(67, 30, 153); /* Even darker purple for the bottom */
          clip-path: polygon(4px 32px, 19px 0px, 104px 0px, 90px 32px, 104px 64px, 19px 64px);
          transform: translateZ(-2px);
          z-index: -2;
        }
        
        :global(.light) .animate-block-pulse-purple {
          background: rgb(107, 70, 193);
          color: white;
        }
        
        :global(.light) .animate-block-pulse-purple::before {
          background: rgb(87, 50, 173);
        }
        
        :global(.light) .animate-block-pulse-purple::after {
          background: rgb(67, 30, 153);
        }
      `}</style>
    </div>
  );
} 