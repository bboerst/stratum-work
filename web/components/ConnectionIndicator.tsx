"use client";

import React from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";

export function ConnectionIndicator() {
  // Use the global data stream
  const { isConnected } = useGlobalDataStream();
  
  // Only show the indicator when disconnected
  if (isConnected) {
    return null;
  }
  
  return (
    <span 
      className="inline-block text-red-500 animate-pulse"
      title="Disconnected from data stream"
    >
      <svg 
        className="inline-block w-4 h-4 mr-1" 
        viewBox="0 0 24 24" 
        fill="currentColor"
      >
        <circle cx="12" cy="12" r="8" />
      </svg>
      Disconnected
    </span>
  );
} 