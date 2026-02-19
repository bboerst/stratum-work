import React, { useRef, useEffect } from 'react';
import { useGlobalDataStream } from '@/lib/DataStreamContext';

interface PoolFilterProps {
  showFilter: boolean;
  onShowFilterChange: (showFilter: boolean) => void;
}

export default function PoolFilter({
  showFilter,
  onShowFilterChange
}: PoolFilterProps) {
  const filterRef = useRef<HTMLDivElement>(null);
  const {
    availablePools,
    enabledPools,
    togglePool,
    toggleAllPools
  } = useGlobalDataStream();

  // Calculate if all pools are selected
  const allPoolsSelected = availablePools.length > 0 && availablePools.every(pool => enabledPools.has(pool));
  const somePoolsSelected = availablePools.some(pool => enabledPools.has(pool));

  // Auto-hide filter panel if clicked outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        onShowFilterChange(false);
      }
    };
    if (showFilter) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showFilter, onShowFilterChange]);

  const handleSelectAllToggle = () => {
    toggleAllPools(!allPoolsSelected);
  };

  const handlePoolToggle = (poolName: string) => {
    togglePool(poolName);
  };

  if (!showFilter) return null;

  return (
    <div
      ref={filterRef}
      className="pool-filter-dropdown fixed bg-background text-foreground border shadow-md rounded p-3 z-50 max-h-96 overflow-y-auto"
      style={{ 
        top: '60px', 
        right: '20px',
        minWidth: '200px'
      }}
    >          
      <div className="mb-3">
        <div className="font-bold text-sm mb-2">Pool Filter</div>
        
        {/* Select All checkbox */}
        <label className="flex items-center text-sm mb-2 pb-2 border-b">
          <input
            type="checkbox"
            className="mr-2"
            checked={allPoolsSelected}
            ref={(input) => {
              if (input) {
                input.indeterminate = somePoolsSelected && !allPoolsSelected;
              }
            }}
            onChange={handleSelectAllToggle}
          />
          <span className="font-medium">
            {allPoolsSelected ? 'Deselect All' : 'Select All'}
          </span>
        </label>
        
        {/* Individual pool checkboxes */}
        <div className="space-y-1">
          {availablePools.map((pool) => (
            <label key={pool} className="flex items-center text-sm hover:bg-muted/50 p-1 rounded">
              <input
                type="checkbox"
                className="mr-2"
                checked={enabledPools.has(pool)}
                onChange={() => handlePoolToggle(pool)}
              />
              <span className="truncate" title={pool}>
                {pool}
              </span>
            </label>
          ))}
        </div>
        
        {availablePools.length === 0 && (
          <div className="text-sm text-muted-foreground italic">
            No pools available
          </div>
        )}
      </div>
    </div>
  );
}