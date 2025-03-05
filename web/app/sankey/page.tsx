"use client";

import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useMemo, useState, useCallback, useEffect } from "react";
import { SankeyDiagram } from "@/components/SankeyDiagram";
import { SankeyMenu } from "@/components/SankeyMenu";
import { sankeyDataProcessor } from "@/lib/sankeyDataProcessor";

/**
 * Sankey Diagram Visualization Page
 * 
 * This page displays a Sankey diagram visualization showing the flow of data
 * between miners, pools, and the network.
 */

export default function SankeyPage() {
  const { filterByType } = useGlobalDataStream();
  const [useSampleData, setUseSampleData] = useState<boolean>(true);
  const [eventSourceUrl, setEventSourceUrl] = useState<string>('/api/events');
  const [refreshKey, setRefreshKey] = useState<number>(0);
  
  // Get only Stratum V1 data for this visualization
  const stratumV1Data = useMemo(() => {
    return filterByType(StreamDataType.STRATUM_V1);
  }, [filterByType]);

  // Handle data source change
  const handleDataSourceChange = useCallback((usesSampleData: boolean) => {
    setUseSampleData(usesSampleData);
    // Force re-render of the SankeyDiagram component
    setRefreshKey(prev => prev + 1);
  }, []);

  // Handle reset data
  const handleResetData = useCallback(() => {
    // Force re-render of the SankeyDiagram component
    setRefreshKey(prev => prev + 1);
  }, []);
  
  // Handle URL change
  const handleUrlChange = useCallback((url: string) => {
    setEventSourceUrl(url);
    // Force re-render of the SankeyDiagram component when URL changes
    setRefreshKey(prev => prev + 1);
  }, []);
  
  // Log data for debugging
  useEffect(() => {
    if (stratumV1Data.length > 0) {
      console.log('Available Stratum V1 data:', stratumV1Data);
    }
  }, [stratumV1Data]);

  return (
    <main className="flex min-h-screen flex-col items-center p-8">
      <div className="w-full max-w-7xl">
        <h1 className="text-2xl font-bold mb-6">Mining Data Flow Visualization</h1>
        
        {/* Sankey Menu for controls */}
        <div className="mb-4">
          <SankeyMenu 
            onDataSourceChange={handleDataSourceChange}
            onResetData={handleResetData}
            onUrlChange={handleUrlChange}
          />
        </div>
        
        {/* Sankey Diagram visualization */}
        <div className="w-full border border-gray-300 rounded-lg p-4 bg-gray-50">
          <div className="mb-4 p-3 bg-blue-100 border border-blue-300 rounded-md text-blue-800">
            This Sankey diagram shows the flow of data from mining pools to their merkle branches.
            The width of each link represents the number of connections between nodes.
          </div>
          
          <SankeyDiagram 
            key={refreshKey}
            width={1000} 
            height={600}
            useSampleData={useSampleData}
            eventSourceUrl={eventSourceUrl}
            data={stratumV1Data}
          />
          
          {/* Data status information */}
          <div className="mt-4 p-3 bg-gray-100 border border-gray-300 rounded-md">
            <p className="text-sm text-gray-700">
              <strong>Data Source:</strong> {useSampleData ? 'Sample Data' : 'Live Data'}
            </p>
            {!useSampleData && (
              <p className="text-sm text-gray-700">
                <strong>API URL:</strong> {eventSourceUrl}
              </p>
            )}
            <p className="text-sm text-gray-700">
              <strong>Available Events:</strong> {stratumV1Data.length}
            </p>
          </div>
          
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