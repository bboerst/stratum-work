"use client";

import React, { useState, useEffect } from "react";
import { sankeyDataProcessor } from "@/lib/sankeyDataProcessor";
import { eventSourceService } from "@/lib/eventSourceService";

/**
 * SankeyMenu Component
 * 
 * This component provides controls for the Sankey diagram visualization.
 */

interface SankeyMenuProps {
  onDataSourceChange?: (useSampleData: boolean) => void;
  onResetData?: () => void;
  onUrlChange?: (url: string) => void;
}

export function SankeyMenu({ 
  onDataSourceChange,
  onResetData,
  onUrlChange
}: SankeyMenuProps) {
  const [useSampleData, setUseSampleData] = useState<boolean>(true);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [eventSourceUrl, setEventSourceUrl] = useState<string>('/api/events');
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  
  // Handle data source change
  const handleDataSourceChange = (value: boolean) => {
    // Disconnect any existing connection
    eventSourceService.disconnect();
    setIsConnected(false);
    setIsSimulating(false);
    
    // Update state
    setUseSampleData(value);
    
    // Notify parent component
    if (onDataSourceChange) {
      onDataSourceChange(value);
    }
  };
  
  // Reset data
  const handleResetData = () => {
    // Reset the data processor
    sankeyDataProcessor.reset();
    
    // Notify parent component
    if (onResetData) {
      onResetData();
    }
    
    // If using sample data, process it again
    if (useSampleData) {
      sankeyDataProcessor.processSampleData();
    }
  };
  
  // Handle URL change
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUrl = e.target.value;
    setEventSourceUrl(newUrl);
    
    // Notify parent component
    if (onUrlChange) {
      onUrlChange(newUrl);
    }
  };
  
  // Start simulation
  const handleStartSimulation = () => {
    if (!isSimulating) {
      eventSourceService.simulateEvents();
      setIsSimulating(true);
      
      // Disable simulation after 30 seconds
      setTimeout(() => {
        setIsSimulating(false);
      }, 30000);
    }
  };
  
  // Connect to EventSource
  const handleConnect = () => {
    if (!isConnected) {
      eventSourceService.connect(eventSourceUrl);
      setIsConnected(true);
    } else {
      eventSourceService.disconnect();
      setIsConnected(false);
    }
  };
  
  // Clean up on unmount
  useEffect(() => {
    return () => {
      eventSourceService.disconnect();
    };
  }, []);
  
  return (
    <div className="flex flex-wrap items-center gap-4 p-4 bg-gray-100 rounded-lg">
      {/* Data source selector */}
      <div className="flex items-center">
        <span className="mr-2 text-sm font-medium">Data Source:</span>
        <div className="flex rounded-md shadow-sm" role="group">
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium rounded-l-lg ${
              useSampleData
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => handleDataSourceChange(true)}
          >
            Sample Data
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium rounded-r-lg ${
              !useSampleData
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
            onClick={() => handleDataSourceChange(false)}
          >
            Live Data
          </button>
        </div>
      </div>
      
      {/* EventSource URL input (only shown when using live data) */}
      {!useSampleData && (
        <div className="flex items-center">
          <span className="mr-2 text-sm font-medium">API URL:</span>
          <input
            type="text"
            value={eventSourceUrl}
            onChange={handleUrlChange}
            className="w-64 px-3 py-2 text-sm border border-gray-300 rounded-md"
            placeholder="EventSource URL"
          />
        </div>
      )}
      
      {/* Show/hide labels toggle */}
      <div className="flex items-center">
        <label className="inline-flex items-center cursor-pointer">
          <input 
            type="checkbox" 
            checked={showLabels}
            onChange={() => setShowLabels(!showLabels)}
            className="sr-only peer"
          />
          <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          <span className="ms-3 text-sm font-medium">Show Labels</span>
        </label>
      </div>
      
      {/* Control buttons */}
      <div className="flex items-center space-x-2">
        {/* Reset button */}
        <button 
          className="px-3 py-2 bg-gray-500 text-white rounded-md text-sm hover:bg-gray-600 transition-colors"
          onClick={handleResetData}
        >
          Reset Data
        </button>
        
        {/* Simulate events button (only shown when using sample data) */}
        {useSampleData && (
          <button 
            className={`px-3 py-2 rounded-md text-sm transition-colors ${
              isSimulating 
                ? 'bg-gray-400 text-gray-700 cursor-not-allowed' 
                : 'bg-green-500 text-white hover:bg-green-600'
            }`}
            onClick={handleStartSimulation}
            disabled={isSimulating}
          >
            {isSimulating ? 'Simulating...' : 'Simulate Events'}
          </button>
        )}
        
        {/* Connect button (only shown when using live data) */}
        {!useSampleData && (
          <button 
            className={`px-3 py-2 rounded-md text-sm transition-colors ${
              isConnected 
                ? 'bg-red-500 text-white hover:bg-red-600' 
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
            onClick={handleConnect}
          >
            {isConnected ? 'Disconnect' : 'Connect'}
          </button>
        )}
      </div>
    </div>
  );
}