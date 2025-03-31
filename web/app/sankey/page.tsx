"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useMemo, useState, useCallback } from "react";
import SankeyDiagram from "@/components/SankeyDiagram";

export default function SankeyPage() {
  const { filterByType, paused, setPaused } = useGlobalDataStream();
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [showLabels, setShowLabels] = useState(false); // Add state for labels toggle
  
  // Get only Stratum V1 data for this visualization
  const stratumV1Data = useMemo(() => {
    return filterByType(StreamDataType.STRATUM_V1);
  }, [filterByType]);
  
  // Toggle pause state
  const handleTogglePause = useCallback(() => {
    setPaused(!paused);
  }, [paused, setPaused]);

  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Mining Data Flow Visualization</h1>
        <div className="mb-4 p-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200">
            This Sankey diagram shows the flow of data from mining pools to their merkle branches.
            The width of each link represents the number of connections between nodes.
            {paused && (
              <div className="mt-2 font-bold">
                ⚠️ Data stream is currently paused. Click the Resume button to see live updates.
              </div>
            )}
          </div>
        {/* Sankey Diagram visualization */}
        <div className="w-full border border-gray-300 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
          {/* Data status information */}
          <div id="sankey-status" className="mb-4 p-3 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  <strong>Status:</strong> {paused ? 'Paused' : 'Live'}
                </p>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  <strong>Available Events:</strong> {stratumV1Data.length}
                </p>
              </div>
              <div className="flex gap-2">
                {/* Show/Hide Labels Button */}
                <button 
                  className={`rounded-md text-sm font-medium ${
                    showLabels 
                      ? 'bg-blue-500 hover:bg-blue-600' 
                      : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600'
                  } ${showLabels ? 'text-white' : 'text-gray-800 dark:text-gray-200'} px-4 py-2`}
                  onClick={() => setShowLabels(!showLabels)}
                >
                  {showLabels ? 'Hide Labels' : 'Show Labels'}
                </button>
                
                {/* Pause/Resume Button */}
                <button 
                  className={`rounded-md text-sm font-medium ${paused ? 'bg-green-500' : 'bg-amber-500'} text-white px-4 py-2`}
                  onClick={handleTogglePause}
                >
                  {paused ? 'Resume' : 'Pause'}
                </button>
              </div>
            </div>
          </div>

          <SankeyDiagram 
            key={refreshKey}
            height={600}
            data={stratumV1Data}
            showLabels={showLabels}
          />
          
          {/* Keeping the raw data display for reference */}
          <details className="mt-6">
            <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-300 mb-2">Show Raw Data</summary>
            <textarea
              className="w-full h-[300px] text-sm p-4 border border-gray-300 rounded-lg"
              value={stratumV1Data.map(data => JSON.stringify(data, null, 2)).join('\n\n')}
              readOnly
            />
          </details>
        </div>
      </div>
    </main>
  );
}