"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useMemo, useState, useEffect } from "react";
import SankeyDiagram from "@/components/SankeyDiagram";
import { useGlobalMenu } from "@/components/GlobalMenuContext";
import SankeyMenu from "@/components/SankeyMenu";

export default function SankeyPage() {
  // Local state
  const [refreshKey, setRefreshKey] = useState<number>(0);
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
  const { filterByType, paused: globalPaused, setPaused: setGlobalPaused } = useGlobalDataStream();
  const { setMenuContent } = useGlobalMenu();
  
  // Local pause state - we want to manage this locally since it's specific to the Sankey diagram
  const [localPaused, setLocalPaused] = useState(false);
  
  // Keep local pause state in sync with global pause state
  useEffect(() => {
    setGlobalPaused(localPaused);
  }, [localPaused, setGlobalPaused]);
  
  // Get only Stratum V1 data for this visualization
  const stratumV1Data = useMemo(() => {
    return filterByType(StreamDataType.STRATUM_V1);
  }, [filterByType]);
  
  // Persist showStatus and showRawEvents to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sankeyShowStatus', String(showStatus));
      localStorage.setItem('sankeyShowRawEvents', String(showRawEvents));
    }
  }, [showStatus, showRawEvents]);

  // Effect to force refresh the diagram if needed
  useEffect(() => {
    const timer = setInterval(() => {
      // Only refresh if not paused
      if (!localPaused) {
        setRefreshKey(prev => prev + 1);
      }
    }, 10000); // Refresh every 10 seconds when not paused
    
    return () => clearInterval(timer);
  }, [localPaused]);
  
  // Set the menu content when the component mounts
  useEffect(() => {
    setMenuContent(
      <SankeyMenu
        paused={localPaused}
        setPaused={setLocalPaused}
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

    // Clean up when the component unmounts
    return () => setMenuContent(null);
  }, [localPaused, showSettings, showLabels, showStatus, showRawEvents, setMenuContent]);
  
  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Mining Data Flow Visualization</h1>
        <div className="mb-4 p-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200">
            This Sankey diagram shows the flow of data from mining pools to their merkle branches.
            The width of each link represents the number of connections between nodes.
            {localPaused && (
              <div className="mt-2 font-bold">
                ⚠️ Diagram updates are currently paused. Click the Resume button to see live updates.
              </div>
            )}
          </div>
        {/* Sankey Diagram visualization */}
        <div className="w-full border border-gray-300 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                
          <SankeyDiagram 
            key={refreshKey}
            height={600}
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
      </div>
    </main>
  );
}