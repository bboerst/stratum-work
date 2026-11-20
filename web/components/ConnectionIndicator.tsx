"use client";

import React from "react";
import { useStreamStatus } from "@/lib/DataStreamContext";

export function ConnectionIndicator() {
  // Use the global data stream
  const { isConnected } = useStreamStatus();
  
  // Only show the indicator when disconnected
  if (isConnected) {
    return null;
  }
  
  return (
    <span 
      className="inline-block text-red-500 animate-pulse"
      title="Disconnected from data stream"
      role="status"
      aria-label="Disconnected from data stream"
    >
      <svg 
        className="inline-block w-4 h-4 sm:mr-1" 
        viewBox="0 0 24 24" 
        fill="currentColor"
      >
        <circle cx="12" cy="12" r="8" />
      </svg>
      <span className="hidden sm:inline">Disconnected</span>
    </span>
  );
} 