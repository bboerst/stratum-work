"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useMemo } from "react";
import { SankeyDiagram } from "@/components/SankeyDiagram";
import { SankeyMenu } from "@/components/SankeyMenu";

/**
 * This is a placeholder for the Sankey diagram visualization.
 * Currently, it just displays raw messages from the data stream.
 * Feel free to change anything on this page, I'm just using it as a placeholder for the real Sankey diagram.
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
        <h1 className="text-2xl font-bold mb-6">Stratum V1 Data Stream</h1>
        
        {/* Sankey Menu for controls */}
        <div className="mb-4">
          <SankeyMenu />
        </div>
        
        {/* Sankey Diagram visualization */}
        <div className="w-full border border-gray-300 rounded-lg p-4 bg-gray-50">
          <div className="mb-4 p-3 bg-yellow-100 border border-yellow-300 rounded-md text-yellow-800">
            Sankey diagram visualization using the SankeyDiagram component. The actual data visualization will need to be implemented within the component.
          </div>
          
          <SankeyDiagram width={1000} height={600} />
          
          {/* Keeping the raw data display for reference */}
          <details className="mt-6">
            <summary className="cursor-pointer font-medium text-gray-700 mb-2">Show Raw Data</summary>
            <textarea
              className="w-full h-[300px] font-mono text-sm p-4 border border-gray-300 rounded-lg"
              value={stratumV1Data.map(data => JSON.stringify(data, null, 2)).join('\n\n')}
              readOnly
            />
          </details>
        </div>
      </div>
    </main>
  );
} 