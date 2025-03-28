"use client";
import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Blocks from "../components/Blocks";
import RealtimeTable from "../components/RealtimeTable";
import RealtimeTableMenu from "../components/RealtimeTableMenu";
import { useGlobalMenu } from "../components/GlobalMenuContext";
import { useGlobalDataStream } from "../lib/DataStreamContext";
import { useBlocks } from "../lib/BlocksContext";
import { useVisualization } from "../components/VisualizationContext";
import VisualizationPanel from "../components/VisualizationPanel";

export default function HomePage() {
  const router = useRouter();
  const [selectedBlock, setSelectedBlock] = useState<number | null>(-1);
  const [paused, setPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { setMenuContent } = useGlobalMenu();
  const { isConnected } = useGlobalDataStream();
  const { resetBlocksState } = useBlocks();
  const { isPanelVisible } = useVisualization();
  
  // Use a ref to track if we've already reset the state to avoid infinite loops
  const hasResetRef = useRef(false);
  
  // Set the menu content when the component mounts
  useEffect(() => {
    setMenuContent(
      <RealtimeTableMenu 
        paused={paused}
        setPaused={setPaused}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        selectedBlockHeight={selectedBlock}
      />
    );
    
    // Clean up when the component unmounts
    return () => setMenuContent(null);
  }, [paused, showSettings, setMenuContent, isConnected, selectedBlock]);

  // Reset blocks state and set selectedBlock to -1 when the home page is mounted
  // But only do it once to avoid infinite loops
  useEffect(() => {
    if (!hasResetRef.current) {
      resetBlocksState();
      setSelectedBlock(-1);
      hasResetRef.current = true;
    }
  }, [resetBlocksState]);

  // Handle block click
  const handleBlockClick = (height: number) => {
    // Special case for the being-mined block (height -1)
    if (height === -1) {
      // Just update the selected block for the being-mined block
      // We don't need to reset the state again here since we're already on the home page
      setSelectedBlock(height);
      return;
    }
    
    // For historical blocks, navigate to the height page using client-side navigation
    if (height > 0) {
      router.push(`/height/${height}`);
    }
  };

  return (
    <main className="min-h-screen h-screen bg-transparent flex flex-col">
      <header className="p-4 flex-shrink-0">
        <div>
          <Blocks 
            onBlockClick={handleBlockClick}
            selectedBlockHeight={selectedBlock}
            key="blocks-home-page" // Add a key to ensure proper rendering
          />
        </div>
      </header>
      
      {/* Remove RealtimeChart for home page - we only want it in the visualization panel */}
      
      <div className="flex flex-1 overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 overflow-auto">
          <RealtimeTable 
            paused={paused}
            showSettings={showSettings}
            onShowSettingsChange={setShowSettings}
            filterBlockHeight={selectedBlock ?? undefined}
          />
        </div>
        
        {/* Visualization Panel */}
        {isPanelVisible && (
          <VisualizationPanel 
            paused={paused}
            filterBlockHeight={selectedBlock ?? undefined}
          />
        )}
      </div>
    </main>
  );
}