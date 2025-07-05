import React, { useEffect, useRef } from 'react';
import { SankeyColors } from '../../utils/sankeyColors';

export type TooltipData = 
  | { type: 'pool'; name: string; label: string }
  | { type: 'branch'; name: string; branchIndex: number; connectedPools: string[] }
  | null;  // For when no tooltip should be shown

export interface SankeyTooltipProps {
  data: TooltipData;
  position: { x: number; y: number } | null;
  containerRef: React.RefObject<HTMLDivElement>;
  colors: SankeyColors;  // Theme colors
}

/**
 * SankeyTooltip component - displays tooltips for Sankey diagram nodes
 * 
 * This maintains the same behavior as the original implementation,
 * with positioning and boundary detection logic self-contained.
 */
const SankeyTooltip: React.FC<SankeyTooltipProps> = ({ 
  data, 
  position, 
  containerRef,
  colors
}) => {
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Positioning logic with boundary detection, similar to original implementation
  useEffect(() => {
    if (!position || !data || !tooltipRef.current || !containerRef.current) {
      return;
    }

    const { x, y } = position;
    const containerRect = containerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    // Default offset
    let xOffset = 10;
    let yOffset = -25;
    
    // Check if tooltip would go off the right edge
    if (x + xOffset + tooltipRect.width > containerRect.width) {
      // Position to the left of the cursor instead
      xOffset = -tooltipRect.width - 10;
    }
    
    // Check if tooltip would go off the bottom edge
    if (y + yOffset + tooltipRect.height > containerRect.height) {
      // Position above the cursor, or at least fully in view
      yOffset = -Math.min(y, tooltipRect.height + 10);
    }
    
    // Check if tooltip would go off the top edge
    if (y + yOffset < 0) {
      // Position below the cursor
      yOffset = 10;
    }
    
    // Apply the calculated position
    tooltipRef.current.style.left = `${x + xOffset}px`;
    tooltipRef.current.style.top = `${y + yOffset}px`;
    tooltipRef.current.style.visibility = 'visible';
    tooltipRef.current.style.opacity = '1';
  }, [position, data, containerRef]);

  // Don't render anything if there's no data or position
  if (!data || !position) {
    return null;
  }

  // Render tooltip content based on type
  const renderContent = () => {
    if (data.type === 'pool') {
      return (
        <div style={{ fontWeight: 'bold' }}>{data.label}</div>
      );
    } else {
      // For Merkle branches, show formatted content with indentation
      const fullHash = data.name.toLowerCase();
      const hashStart = fullHash.substring(0, 6);
      
      return (
        <>
          <div style={{ fontWeight: 'bold' }}>
            Merkle Branch {data.branchIndex}:<br />
            <div style={{ paddingLeft: '10px', display: 'flex', alignItems: 'center', margin: '2px 0' }}>
              <span style={{ marginRight: '4px' }}>&gt;</span> {hashStart}
            </div>
            <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.8 }}>
              (Click to copy full hash)
            </div>
          </div>

          {data.connectedPools.length > 0 && (
            <>
              <div style={{ marginTop: '8px', fontWeight: 'bold' }}>Pool Connections:</div>
              <div style={{ display: 'flex', marginTop: '4px' }}>
                {/* Left column */}
                <div style={{ flex: 1, paddingRight: '16px', minWidth: '120px' }}>
                  {data.connectedPools
                    .filter((_, i) => i % 2 === 0) // Even indices (0, 2, 4...)
                    .map((pool, i) => {
                      const originalIndex = i * 2; // Convert back to original index
                      return (
                        <div 
                          key={`pool-left-${originalIndex}`} 
                          style={{ display: 'flex', alignItems: 'center', margin: '2px 0', fontSize: '13px' }}
                        >
                          {originalIndex + 1}. {pool}
                        </div>
                      );
                    })
                  }
                </div>
                {/* Right column */}
                <div style={{ flex: 1, paddingLeft: '16px', minWidth: '120px' }}>
                  {data.connectedPools
                    .filter((_, i) => i % 2 === 1) // Odd indices (1, 3, 5...)
                    .map((pool, i) => {
                      const originalIndex = i * 2 + 1; // Convert back to original index
                      return (
                        <div 
                          key={`pool-right-${originalIndex}`} 
                          style={{ display: 'flex', alignItems: 'center', margin: '2px 0', fontSize: '13px' }}
                        >
                          {originalIndex + 1}. {pool}
                        </div>
                      );
                    })
                  }
                </div>
              </div>
            </>
          )}
        </>
      );
    }
  };

  return (
    <div
      ref={tooltipRef}
      className="sankey-tooltip"
      style={{
        position: 'absolute',
        visibility: 'hidden',
        opacity: 0,
        backgroundColor: colors.background || 'white',
        color: colors.text || '#1a202c',
        border: '1px solid #ddd',
        borderRadius: '4px',
        padding: '8px',
        pointerEvents: 'none',
        maxWidth: '450px',
        zIndex: 1000,
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        transition: 'opacity 0.2s'
      }}
    >
      {renderContent()}
    </div>
  );
};

export default SankeyTooltip;
