"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useMemo } from "react";
import { SankeyDiagram } from "@/components/SankeyDiagram";
import { SankeyMenu } from "@/components/SankeyMenu";

/**
 * Sankey Diagram Visualization Page
 * 
 * This page displays a Sankey diagram visualization showing the flow of data
 * between miners, pools, and the network.
 */

export default function SankeyPage() {
  const { filterByType } = useGlobalDataStream();
  
  // Get only Stratum V1 data for this visualization
  const stratumV1Data = useMemo(() => {
    return filterByType(StreamDataType.STRATUM_V1);
  }, [filterByType]);

  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Mining Data Flow Visualization</h1>
        
        {/* Sankey Menu for controls */}
        <div className="mb-4">
          <SankeyMenu />
        </div>
        
        {/* Sankey Diagram visualization */}
        <div className="w-full border border-gray-300 rounded-lg p-4 bg-gray-50">
          <div className="mb-4 p-3 bg-blue-100 border border-blue-300 rounded-md text-blue-800">
            This Sankey diagram shows the flow of hashrate between miners, pools, and the network. 
            The width of each link represents the volume of data flowing between nodes.
          </div>
          
          <SankeyDiagram width={1000} height={600} />
          
          {/* Keeping the raw data display for reference */}
          <details className="mt-6">
            <summary className="cursor-pointer font-medium text-gray-700 mb-2">Show Raw Data</summary>
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