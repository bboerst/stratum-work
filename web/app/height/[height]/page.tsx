"use client";
import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import RealtimeTable from "@/components/RealtimeTable";
import RealtimeChart from "@/components/RealtimeChart";
import Blocks from "@/components/Blocks";
import RealtimeTableMenu from "@/components/RealtimeTableMenu";
import { useGlobalMenu } from "@/components/GlobalMenuContext";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { useBlocks } from "@/lib/BlocksContext";

export default function HeightPage() {
  const params = useParams();
  const router = useRouter();
  const heightParam = params.height as string;
  const blockHeight = heightParam ? parseInt(heightParam, 10) : null;
  
  const [paused, setPaused] = useState(true); // Start paused when viewing historical data
  const [showSettings, setShowSettings] = useState(false);
  const { setMenuContent } = useGlobalMenu();
  const { isConnected } = useGlobalDataStream();
  const { resetBlocksState } = useBlocks();
  
  // Set the menu content when the component mounts
  useEffect(() => {
    setMenuContent(
      <RealtimeTableMenu 
        paused={paused}
        setPaused={setPaused}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        selectedBlockHeight={blockHeight}
      />
    );
    
    // Clean up when the component unmounts
    return () => setMenuContent(null);
  }, [paused, showSettings, setMenuContent, isConnected, blockHeight]);

  // Handle block click
  const handleBlockClick = (height: number) => {
    // Special case for the being-mined block (height -1)
    if (height === -1) {
      // Reset blocks state before navigating
      resetBlocksState();
      // Navigate to the root URL for the being-mined block using client-side navigation
      router.push('/');
      return;
    }
    
    // Regular case for historical blocks
    if (height > 0) {
      // Use Next.js router for client-side navigation
      router.push(`/height/${height}`);
    }
  };

  return (
    <main className="min-h-screen bg-transparent">
      <header className="p-4 flex items-center">
        <div className="flex-1">
          <Blocks 
            onBlockClick={handleBlockClick}
            selectedBlockHeight={blockHeight}
            key={`blocks-with-height-${blockHeight}`} // Add a key to force re-render when height changes
          />
        </div>
      </header>
      
      <div className="px-4 mb-4" style={{ height: "400px" }}>
        <RealtimeChart 
          paused={paused}
          filterBlockHeight={blockHeight ?? undefined}
        />
      </div>
      
      <RealtimeTable 
        paused={paused}
        showSettings={showSettings}
        onShowSettingsChange={setShowSettings}
        filterBlockHeight={blockHeight ?? undefined}
      />
    </main>
  );
} 