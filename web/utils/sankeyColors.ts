import { getMerkleColor } from './colorUtils';

/**
 * SankeyColors type definition for theme-dependent colors used in Sankey diagrams
 */
export interface SankeyColors {
  background: string;
  text: string;
  poolNode: string;
  nodeStroke: string;
  textStroke: string;
  link: string;
  statusLive: string;
  statusPaused: string;
  error: string;
  poolLabel: string;
  gridLine: string;
  gridText: string;
}

/**
 * Get theme-dependent colors for Sankey diagram
 * @param theme The current theme ('dark' | 'light' or other string)
 * @returns Object containing all color values for the Sankey diagram
 */
export function getSankeyColors(theme: string | undefined): SankeyColors {
  const isDark = theme === 'dark';
  
  return {
    background: isDark ? '#1e1e2f' : '#ffffff',
    text: isDark ? '#e2e8f0' : '#1a202c',
    poolNode: isDark ? '#3182ce' : '#2563eb',
    nodeStroke: isDark ? '#4a5568' : '#2d3748',
    textStroke: isDark ? '#000000' : '#000000',
    link: isDark ? 'rgba(160, 174, 192, 0.5)' : 'rgba(100, 116, 139, 0.5)',
    statusLive: isDark ? '#68d391' : '#48bb78',
    statusPaused: isDark ? '#f6ad55' : '#ed8936',
    error: isDark ? '#fc8181' : '#f56565',
    poolLabel: isDark ? '#ff9d4d' : '#ff8000',
    gridLine: isDark ? 'rgba(160, 174, 192, 0.3)' : 'rgba(100, 116, 139, 0.3)',
    gridText: isDark ? 'rgba(226, 232, 240, 0.8)' : 'rgba(26, 32, 44, 0.8)',
  };
}

/**
 * Get a color for a specific branch name, utilizing the cached merkle color function
 * @param branch Branch name
 * @returns Color string for the branch
 */
export function getBranchColor(branch: string): string {
  return getMerkleColor(branch);
}
