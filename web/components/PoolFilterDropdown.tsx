"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Filter } from "lucide-react";
import { usePoolFilter } from "./PoolFilterContext";

export function PoolFilterDropdown() {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const {
    allPools,
    hiddenPools,
    togglePool,
    isPoolVisible,
    showAllPools,
    hideAllPools,
    visiblePoolCount,
  } = usePoolFilter();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const updateScrollIndicators = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 2);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(updateScrollIndicators);
    return () => cancelAnimationFrame(frame);
  }, [open, allPools.length, updateScrollIndicators]);

  const hasHiddenPools = hiddenPools.size > 0;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setOpen(prev => !prev)}
        className={`
          flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors
          ${hasHiddenPools
            ? "text-orange-400 bg-orange-500/10 hover:bg-orange-500/20"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }
        `}
        title="Filter mining pools"
      >
        <Filter className="h-4 w-4" />
        <span className="hidden sm:inline">
          Pools{allPools.length > 0 ? ` (${visiblePoolCount}/${allPools.length})` : ""}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg shadow-md border bg-background text-foreground z-50 flex flex-col">
          {/* Select / Deselect All */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b flex-shrink-0">
            <button
              onClick={showAllPools}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Select All
            </button>
            <button
              onClick={hideAllPools}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Deselect All
            </button>
          </div>

          {/* Pool list with scroll indicators */}
          <div className="relative min-h-0 flex-1">
            {canScrollUp && (
              <div className="pointer-events-none absolute top-0 inset-x-0 h-5 bg-gradient-to-b from-background to-transparent z-10 rounded-t" />
            )}

            <div
              ref={listRef}
              onScroll={updateScrollIndicators}
              className="max-h-80 overflow-y-auto overscroll-contain py-1"
            >
              {allPools.length === 0 && (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                  Waiting for pools…
                </div>
              )}
              {allPools.map(pool => (
                <label
                  key={pool}
                  className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-muted transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={isPoolVisible(pool)}
                    onChange={() => togglePool(pool)}
                    className="h-3.5 w-3.5 rounded accent-orange-500 flex-shrink-0"
                  />
                  <span className="text-xs truncate">{pool}</span>
                </label>
              ))}
            </div>

            {canScrollDown && (
              <div className="pointer-events-none absolute bottom-0 inset-x-0 h-5 bg-gradient-to-t from-background to-transparent z-10 rounded-b" />
            )}
          </div>

          {/* Sticky footer with count */}
          {allPools.length > 0 && (
            <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground text-center flex-shrink-0">
              {visiblePoolCount} of {allPools.length} pools selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
