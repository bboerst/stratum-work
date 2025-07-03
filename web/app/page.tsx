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
import { useSelectedTemplate } from "../lib/SelectedTemplateContext";
import VisualizationPanel from "../components/VisualizationPanel";
import BlockTemplateCard from "../components/BlockTemplateCard";

export default function HomePage() {
  const router = useRouter();
  const [selectedBlock, setSelectedBlock] = useState<number | null>(-1);
  const [paused, setPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { setMenuContent } = useGlobalMenu();
  const { isConnected } = useGlobalDataStream();
  const { resetBlocksState } = useBlocks();
  const { isPanelVisible } = useVisualization();
  const { selectedTemplate, setSelectedTemplate } = useSelectedTemplate();
  
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

  // Clear selected template when switching to realtime mode
  useEffect(() => {
    if (selectedBlock === -1) {
      setSelectedTemplate(null);
    }
  }, [selectedBlock, setSelectedTemplate]);

  // Handle block click
  const handleBlockClick = (height: number) => {
    // Special case for the being-mined block (height -1)
    if (height === -1) {
      // Clear any selected template when switching to realtime view
      setSelectedTemplate(null);
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
        
        {/* Selected Template Panel - only show for historical data */}
        {selectedTemplate && selectedBlock !== null && selectedBlock !== -1 && (
          <div className="w-[600px] flex-shrink-0 border-l border-border bg-background overflow-auto">
            <div className="p-4">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold">Selected Template Details</h2>
                <button 
                  onClick={() => setSelectedTemplate(null)}
                  className="text-gray-500 hover:text-gray-700 text-xl font-bold w-6 h-6 flex items-center justify-center"
                  title="Close"
                >
                  ×
                </button>
              </div>
              <BlockTemplateCard latestMessage={selectedTemplate} />
            </div>
          </div>
        )}
        
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