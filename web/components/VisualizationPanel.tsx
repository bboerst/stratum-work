"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useVisualization } from './VisualizationContext';

// Improved throttle helper function with correct typing and better performance
function createThrottle<T extends (e: MouseEvent) => void>(
  func: T,
  limit: number
): T {
  let lastCall = 0;
  return ((e: MouseEvent) => {
    const now = performance.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      func(e);
    }
  }) as T;
}

interface VisualizationPanelProps {
  paused?: boolean;
  filterBlockHeight?: number;
}

export default function VisualizationPanel({ 
  filterBlockHeight
}: VisualizationPanelProps) {
  const { isPanelVisible } = useVisualization();
  const [width, setWidth] = useState(350); // Default width
  const minWidth = 350; // Minimum width
  const maxWidth = 800; // Maximum width
  // Removed timing chart from this panel
  type AnalysisFlag = { icon?: string; key?: string; title?: string; details?: Record<string, unknown> };
  type InterestingItem = { height: number; block_hash: string; analysis?: { flags?: AnalysisFlag[] } | undefined; mining_pool?: { name?: string } };
  const [interesting, setInteresting] = useState<InterestingItem[]>([]);
  const router = useRouter();
  const [loadingInteresting, setLoadingInteresting] = useState(false);
  
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Check if we're in historical mode (viewing a specific historical block)
  const isHistoricalBlock = filterBlockHeight !== undefined && filterBlockHeight !== -1;

  // Throttled resize handler to improve performance
  const handleThrottledMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingRef.current) {
      // Invert the delta since we're resizing from the left side now
      const delta = startXRef.current - e.clientX;
      let newWidth = startWidthRef.current + delta;
      
      // Apply constraints
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      
      setWidth(newWidth);
    }
  }, []);
  
  // Apply throttling outside of useCallback to avoid dependency issues
  const throttledMouseMove = createThrottle(handleThrottledMouseMove, 16); // Approximately 60fps

  useEffect(() => {
    // Fetch interesting blocks list (server rendered API)
    setLoadingInteresting(true);
    fetch('/api/analysis-data?interesting=true', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        const items = Array.isArray(d.items) ? d.items : [];
        setInteresting(items);
      })
      .catch(() => setInteresting([]))
      .finally(() => setLoadingInteresting(false));
  }, []);

  const renderInterestingPanel = useCallback(() => {
    function buildTooltip(item: InterestingItem): string {
      const parts: string[] = [];
      const flags = (item.analysis && Array.isArray(item.analysis.flags)) ? (item.analysis.flags as AnalysisFlag[]) : [];
      const forkFlag = flags.find(f => f && f.icon === 'fork');
      const errorFlag = flags.find(f => f && f.icon === 'error');
      // Fork summary
      if (forkFlag) {
        parts.push('prev-hash divergence');
      }
      // Error summary (no counts)
      if (errorFlag) {
        parts.push('Invalid templates');
      }
      if (parts.length === 0) parts.push('Interesting analysis finding');
      return `${item.height} — ${parts.join(' • ')}`;
    }
    return (
      <div className="border border-border rounded-md bg-card w-full">
        <div className="px-3 py-2 border-b border-border text-sm font-semibold">Findings</div>
        <div className="max-h-[260px] overflow-auto">
          {loadingInteresting && (
            <div className="p-3 text-xs opacity-70">Loading…</div>
          )}
          {!loadingInteresting && interesting.length === 0 && (
            <div className="p-3 text-xs opacity-70">No findings</div>
          )}
          {!loadingInteresting && interesting.length > 0 && (
            <ul className="divide-y divide-border">
              {interesting.map(item => {
                const flags = (item.analysis && Array.isArray(item.analysis.flags)) ? (item.analysis.flags as AnalysisFlag[]) : [];
                const hasFork = flags.some((f) => f && f.icon === 'fork');
                const hasError = flags.some((f) => f && f.icon === 'error');
                const summary = buildTooltip(item);
                return (
                  <li
                    key={item.block_hash}
                    title={summary}
                    className="px-3 py-2 grid grid-cols-[24px_1fr] items-center gap-2 text-xs cursor-pointer hover:bg-muted"
                    onClick={() => router.push(`/height/${item.height}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.push(`/height/${item.height}`); } }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex items-center gap-1 w-6">
                      {hasFork && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <circle cx="6" cy="4" r="2" />
                          <circle cx="18" cy="4" r="2" />
                          <circle cx="12" cy="20" r="2" />
                          <path d="M6 6v2a6 6 0 0 0 6 6" />
                          <path d="M18 6v2a6 6 0 0 1-6 6" />
                          <path d="M12 14v4" />
                        </svg>
                      )}
                      {hasError && (
                        <span className="inline-block h-3 w-3 rounded-sm bg-red-600 text-white leading-3 text-[9px] text-center">!</span>
                      )}
                    </div>
                    <div className="truncate">
                      {summary}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }, [interesting, loadingInteresting, router]);
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (resizeHandleRef.current && resizeHandleRef.current.contains(e.target as Node)) {
        isDraggingRef.current = true;
        startXRef.current = e.clientX;
        startWidthRef.current = width;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
      }
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', throttledMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', throttledMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [width, throttledMouseMove]);

  // Don't render visualization panel if toggled off
  if (!isPanelVisible) {
    return null;
  }

  // For historical blocks, don't render the side panel
  if (isHistoricalBlock) {
    return null;
  }

  return (
    <div 
      ref={panelRef}
      className="h-full bg-background border-r border-border relative flex-shrink-0"
      style={{ width: `${width}px`, color: '#9d9d9d' }}
    >

      {/* Resize handle */}
      <div 
        ref={resizeHandleRef}
        className="absolute top-0 left-0 w-4 h-full cursor-ew-resize z-10 group flex items-center justify-center"
        style={{ transform: 'translateX(-50%)' }}
      >
        <div className="w-1 h-full bg-gray-700/60 group-hover:bg-gray-400">
          {/* Resize grip indicator */}
          <div className="absolute left-1/2 top-1/2 transform -translate-y-1/2 -translate-x-1/2 flex flex-col gap-1.5">
            <div className="w-1 h-8 rounded-full bg-gray-400 group-hover:bg-gray-400"></div>
            <div className="w-1 h-8 rounded-full bg-gray-400 group-hover:bg-gray-400"></div>
          </div>
        </div>
      </div>
      
      {/* Visualization content */}
      <div className="pt-2 px-4 pb-4 h-[calc(100%-60px)] overflow-auto w-full">
        {/* Interesting findings */}
        <div className="mt-3">
          {renderInterestingPanel()}
        </div>
      </div>
    </div>
  );
} 