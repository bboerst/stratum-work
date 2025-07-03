"use client";

import React, { useState } from "react";

/**
 * SankeyMenu Component
 * 
 * This component provides controls for the Sankey diagram visualization.
 */

export function SankeyMenu() {
  const [timeRange, setTimeRange] = useState<string>("1h");
  const [showLabels, setShowLabels] = useState<boolean>(true);
  
  return (
    <div className="flex items-center space-x-4 p-3 bg-gray-100 rounded-lg">
      {/* Time range selector */}
      <div className="flex items-center">
        <span className="mr-2 text-sm font-medium">Time Range:</span>
        <select 
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value)}
          className="bg-white border border-gray-300 rounded-md px-2 py-1 text-sm"
        >
          <option value="15m">15 minutes</option>
          <option value="1h">1 hour</option>
          <option value="6h">6 hours</option>
          <option value="24h">24 hours</option>
        </select>
      </div>
      
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
      
      {/* Refresh button */}
      <button 
        className="px-3 py-1 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600 transition-colors"
        onClick={() => {
          // This would refresh the data in a real implementation
          console.log("Refreshing data...");
        }}
      >
        Refresh
      </button>
    </div>
  );
}