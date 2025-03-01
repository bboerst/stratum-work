"use client";

import { useEffect, useState } from "react";
import { MiningData } from "@/lib/types";

/**
 * This is a placeholder for the Sankey diagram visualization.
 * Currently, it just displays raw messages from the data stream.
 * Feel free to change anything on this page, I'm just using it as a placeholder for the real Sankey diagram.
 */

export default function SankeyPage() {
  const [miningData, setMiningData] = useState<MiningData[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Connect to the EventSource stream
  useEffect(() => {
    let evtSource: EventSource | null = null;
    let reconnectFrequencySeconds = 1;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const setupEventSource = () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Connect to the SSE endpoint
      evtSource = new EventSource("/api/stream");
      setIsConnected(true);

      evtSource.onmessage = (event) => {
        try {
          const data: MiningData = JSON.parse(event.data);
          
          // Add the new data to our state
          setMiningData((prev) => {
            // Remove any existing row for that pool_name
            const withoutPool = prev.filter((r) => r.pool_name !== data.pool_name);
            const newRows = [...withoutPool, data];
            return newRows;
          });
        } catch (error) {
          console.error("Error parsing SSE data", error);
        }
      };

      evtSource.onerror = () => {
        setIsConnected(false);
        evtSource?.close();
        evtSource = null;
        
        // Exponential backoff for reconnection
        const reconnectDelay = reconnectFrequencySeconds * 1000;
        reconnectFrequencySeconds = Math.min(reconnectFrequencySeconds * 2, 60);
        
        reconnectTimeout = setTimeout(() => {
          setupEventSource();
        }, reconnectDelay);
      };

      evtSource.onopen = () => {
        setIsConnected(true);
        reconnectFrequencySeconds = 1;
      };
    };

    setupEventSource();

    return () => {
      if (evtSource) {
        evtSource.close();
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Raw Data Stream</h1>
        
        {/* This is where the Sankey diagram should go */}
        {/* Replace this entire section with the actual Sankey visualization */}
        <div className="w-full border border-gray-300 rounded-lg p-4 bg-gray-50">
          <div className="mb-2 text-sm font-medium">
            {isConnected ? "Connected to data stream" : "Connecting to data stream..."}
          </div>
          
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