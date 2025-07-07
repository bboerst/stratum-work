"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from '@/lib/types';
import { useMemo, useState, useEffect } from "react";
import SankeyDiagram from "@/components/SankeyDiagram";
import { useGlobalMenu } from "@/components/GlobalMenuContext";
import SankeyMenu from "@/components/SankeyMenu";

export default function SankeyPage() {
  // Local state
  const [showLabels, setShowLabels] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [nodeLinkCounts, setNodeLinkCounts] = useState({ nodes: 0, links: 0 });
  const [showRawEvents, setShowRawEvents] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('sankeyShowRawEvents') === 'true';
    }
    return false;
  });
  const [showStatus, setShowStatus] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('sankeyShowStatus') === 'true';
    }
    return false;
  });
  
  // Global state
  const { filterByType, data, paused, setPaused } = useGlobalDataStream();
  const { setMenuContent } = useGlobalMenu();
  
  // Get only Stratum V1 data for this visualization
  const stratumV1Data = useMemo(() => {
    return filterByType(StreamDataType.STRATUM_V1);
  }, [filterByType]);
  
  // Calculate dynamic height based on pool count using square root scaling
  const dynamicHeight = useMemo(() => {
    const calculateHeight = (poolCount: number): number => {
      const baseHeight = 200;
      const maxHeight = 1400;
      const multiplier = 190; // Calculated to reach ~1400px at 40 pools with baseHeight = 200
      const calculatedHeight = baseHeight + (Math.sqrt(poolCount) * multiplier);
      return Math.min(calculatedHeight, maxHeight);
    };
    
    // Count unique pools from the data
    const poolCount = new Set(
      stratumV1Data
        .filter(item => item.type === StreamDataType.STRATUM_V1)
        .map(item => item.data.pool_name)
    ).size;
    return calculateHeight(Math.max(poolCount, 1)); // Ensure minimum of 1 pool for calculation
  }, [stratumV1Data]);
  
  // Persist showStatus and showRawEvents to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sankeyShowStatus', String(showStatus));
      localStorage.setItem('sankeyShowRawEvents', String(showRawEvents));
    }
  }, [showStatus, showRawEvents]);

  
  // Set the menu content when the component mounts
  useEffect(() => {
    setMenuContent(
      <SankeyMenu
        paused={paused}
        setPaused={setPaused}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        showLabels={showLabels}
        setShowLabels={setShowLabels}
        showStatus={showStatus}
        setShowStatus={setShowStatus}
        showRawEvents={showRawEvents}
        setShowRawEvents={setShowRawEvents}
      />
    );
    return () => setMenuContent(null);
  }, [paused, showSettings, showLabels, showStatus, showRawEvents, setMenuContent, setPaused]);
  
  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Mining Data Flow Visualization</h1>
        {/* Sankey Diagram visualization */}
        <div className="w-full border border-gray-300 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                
          <SankeyDiagram 
            
            height={dynamicHeight}
            data={stratumV1Data}
            showLabels={showLabels}
            onDataRendered={(nodes, links) => setNodeLinkCounts({ nodes, links })}
          />

{/* Data status below diagram */}
          {showStatus && (
            <div id="sankey-status-bottom" className="mt-4 p-3 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                <strong>Available Events:</strong> {stratumV1Data.length}
                <span className="mx-4"></span>
                <strong>Nodes:</strong> {nodeLinkCounts.nodes}
                <span className="mx-4"></span>
                <strong>Links:</strong> {nodeLinkCounts.links}
              </p>
            </div>
          )}
          
          {/* Raw data display */}
          {showRawEvents && (
            <div className="mt-6">
              <textarea
                className="w-full h-[300px] text-sm p-4 border border-gray-300 rounded-lg"
                value={stratumV1Data.map(data => JSON.stringify(data, null, 2)).join('\n\n')}
                readOnly
              />
            </div>
          )}
        </div>
        
        {/* Description moved below diagram container */}
        <div className="mt-4 p-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md">
          <div className="text-blue-800 dark:text-blue-200">
            This interactive Sankey diagram traces how mining pools assemble and broadcast block templates via Stratum, showing the relationship between pools and their Merkle branches. <strong>Continuous streaming</strong> keeps the visualization current, so you can watch as block-template elements shift between pools and spot emerging patterns in how those templates are constructed.<br /><br />
            
            <strong>Interactions:</strong> Hover over elements to see tooltips displaying similarity scores between pool block templates. Click any Merkle branch node to copy its full hash to your clipboard—a green flash confirms the copy.<br /><br />
            
            <strong>Menu controls:</strong><br />
            ⏯️ Pause/Resume real-time data<br />
            ⚙️ Settings (light/dark mode, toggle labels, stats, raw events)<br /><br />
            
            <strong>Template Similarity:</strong> Following <em>b10c&apos;s research</em>, similarity scores are calculated by comparing the Merkle branches pools send in Stratum jobs. A score of 0.92 means two pools share 92% of their block template structure, indicating potential coordination or shared infrastructure between mining operations.
          </div>
        </div>
      </div>
    </main>
  );
}