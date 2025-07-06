import React, { useEffect, useRef, useMemo } from 'react';
import { SankeyColors } from '../../utils/sankeyColors';
import { sankeyDataProcessor } from '../../lib/sankeyDataProcessor';

// Similarity score data structure
interface SimilarityScore {
  poolA: string;
  poolB: string;
  score: number; // 0-100 percentage
}

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
 * Calculate weighted similarity score between two pools based on their merkle branches
 * Formula: score(A,B) = Σ(i=1 to l) [1_{A_i=B_i} / 2^(1+l-i)]
 * Where l = min(|A|, |B|) and i is 1-based index
 */
function calculateSimilarityScore(branchesA: string[], branchesB: string[]): number {
  if (branchesA.length === 0 || branchesB.length === 0) {
    return 0;
  }

  const l = Math.min(branchesA.length, branchesB.length);
  let score = 0;

  for (let i = 1; i <= l; i++) {
    // Compare branches at position i-1 (0-based array index)
    if (branchesA[i - 1] === branchesB[i - 1]) {
      score += 1 / Math.pow(2, 1 + l - i);
    }
  }

  // Convert to percentage
  return score * 100;
}

/**
 * Format similarity score percentage, trimming trailing zeros
 */
function formatPercentage(score: number): string {
  // Round to 2 decimal places and remove trailing zeros
  const rounded = Math.round(score * 100) / 100;
  const formatted = rounded.toFixed(2);
  return formatted.replace(/\.?0+$/, '') + '%';
}

/**
 * Get color style for similarity score based on thresholds
 */
function getSimilarityColor(score: number): React.CSSProperties {
  if (score < 30) {
    return { color: '#22c55e' }; // green
  } else if (score < 90) {
    return { color: '#eab308' }; // yellow
  } else {
    return { color: '#ef4444' }; // red
  }
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

  // Calculate similarity scores for branch tooltips
  const similarityScores = useMemo((): SimilarityScore[] => {
    if (!data || data.type !== 'branch' || data.connectedPools.length < 2) {
      return [];
    }

    const scores: SimilarityScore[] = [];
    const pools = data.connectedPools;

    // Calculate all unique pairwise similarities
    for (let i = 0; i < pools.length - 1; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        const poolA = pools[i];
        const poolB = pools[j];
        
        const branchesA = sankeyDataProcessor.getMerkleBranchesForPool(poolA);
        const branchesB = sankeyDataProcessor.getMerkleBranchesForPool(poolB);
        
        const score = calculateSimilarityScore(branchesA, branchesB);
        
        scores.push({
          poolA,
          poolB,
          score
        });
      }
    }

    // Sort by score descending (highest first)
    return scores.sort((a, b) => b.score - a.score);
  }, [data]);

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
      
      // But also make sure it doesn't go off the left edge
      if (x + xOffset < 0) {
        // If it would go off the left edge, keep it within bounds
        xOffset = -x + 10; // Position it 10px from the left edge
      }
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
            Merkle Branch {data.branchIndex}: {hashStart}
            <div style={{ fontSize: '10px', marginTop: '2px', opacity: 0.8 }}>
              (Click to copy full hash)
            </div>
          </div>

          {/* Similarity Score Section */}
          {similarityScores.length > 0 && (
            <>
              <div style={{ marginTop: '8px', fontWeight: 'bold' }}>Similarity Scores:</div>
              {similarityScores.length <= 10 ? (
                // Single column layout for 10 or fewer pairs
                <div style={{ marginTop: '4px' }}>
                  {similarityScores.map((similarity, i) => (
                    <div 
                      key={`similarity-${i}`}
                      style={{ 
                        display: 'block',
                        margin: '1px 0', 
                        fontSize: '12px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        ...getSimilarityColor(similarity.score)
                      }}
                      title={`${similarity.poolA} ↔ ${similarity.poolB}: ${formatPercentage(similarity.score)}`}
                    >
                      {similarity.poolA} ↔ {similarity.poolB}: {formatPercentage(similarity.score)}
                    </div>
                  ))}
                </div>
              ) : (
                // Two column layout for more than 10 pairs
                <div style={{ display: 'flex', marginTop: '4px' }}>
                  {/* Left column */}
                  <div style={{ flex: 1, paddingRight: '8px', minWidth: '300px' }}>
                    {similarityScores
                      .filter((_, i) => i % 2 === 0) // Even indices (0, 2, 4...)
                      .map((similarity, i) => {
                        const originalIndex = i * 2; // Convert back to original index
                        return (
                          <div 
                            key={`similarity-left-${originalIndex}`}
                            style={{ 
                              display: 'block',
                              margin: '1px 0', 
                              fontSize: '12px',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              ...getSimilarityColor(similarity.score)
                            }}
                            title={`${similarity.poolA} ↔ ${similarity.poolB}: ${formatPercentage(similarity.score)}`}
                          >
                            {similarity.poolA} ↔ {similarity.poolB}: {formatPercentage(similarity.score)}
                          </div>
                        );
                      })
                    }
                  </div>
                  {/* Right column */}
                  <div style={{ flex: 1, paddingLeft: '8px', minWidth: '300px' }}>
                    {similarityScores
                      .filter((_, i) => i % 2 === 1) // Odd indices (1, 3, 5...)
                      .map((similarity, i) => {
                        const originalIndex = i * 2 + 1; // Convert back to original index
                        return (
                          <div 
                            key={`similarity-right-${originalIndex}`}
                            style={{ 
                              display: 'block',
                              margin: '1px 0', 
                              fontSize: '12px',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              ...getSimilarityColor(similarity.score)
                            }}
                            title={`${similarity.poolA} ↔ ${similarity.poolB}: ${formatPercentage(similarity.score)}`}
                          >
                            {similarity.poolA} ↔ {similarity.poolB}: {formatPercentage(similarity.score)}
                          </div>
                        );
                      })
                    }
                  </div>
                </div>
              )}
            </>
          )}

          {data.connectedPools.length > 0 && (
            <>
              <div style={{ marginTop: '8px', fontWeight: 'bold' }}>Pool Connections:</div>
              {similarityScores.length <= 10 ? (
                // Single column layout for 10 or fewer similarity score pairs
                <div style={{ marginTop: '4px' }}>
                  {data.connectedPools.map((pool, i) => (
                    <div 
                      key={`pool-${i}`} 
                      style={{ display: 'flex', alignItems: 'center', margin: '2px 0', fontSize: '13px' }}
                    >
                      {i + 1}. {pool}
                    </div>
                  ))}
                </div>
              ) : (
                // Two column layout for more than 10 similarity score pairs
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
              )}
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
        maxWidth: similarityScores.length > 10 ? '700px' : '450px',
        minWidth: similarityScores.length > 0 ? '300px' : 'auto',
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
