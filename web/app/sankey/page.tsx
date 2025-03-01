"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";

/**
 * This is a placeholder for the Sankey diagram visualization.
 * Currently, it just displays raw messages from the data stream.
 * Feel free to change anything on this page, I'm just using it as a placeholder for the real Sankey diagram.
 */

export default function SankeyPage() {
  const { data: miningData } = useGlobalDataStream();

  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Raw Data Stream</h1>
        
        {/* This is where the Sankey diagram should go */}
        {/* Replace this entire section with the actual Sankey visualization */}
        <div className="w-full border border-gray-300 rounded-lg p-4 bg-gray-50">
          <div className="mb-4 p-3 bg-yellow-100 border border-yellow-300 rounded-md text-yellow-800">
            This is a placeholder for the Sankey diagram visualization. Currently just showing raw data from the stream. Replace this with the actual Sankey implementation.
          </div>
          
          <textarea
            className="w-full h-[500px] font-mono text-sm p-4 border border-gray-300 rounded-lg"
            value={miningData.map(data => JSON.stringify(data, null, 2)).join('\n\n')}
            readOnly
          />
        </div>
      </div>
    </main>
  );
} 