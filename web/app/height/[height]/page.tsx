"use client";
import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import RealtimeTable from "@/components/RealtimeTable";
import Blocks from "@/components/Blocks";
import RealtimeTableMenu from "@/components/RealtimeTableMenu";
import { useGlobalMenu } from "@/components/GlobalMenuContext";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { useBlocks } from "@/lib/BlocksContext";
import { useVisualization } from "@/components/VisualizationContext";
import { useSelectedTemplate } from "@/lib/SelectedTemplateContext";
import VisualizationPanel from "@/components/VisualizationPanel";
import BlockTemplateCard from "@/components/BlockTemplateCard";
import HistoricalChartWrapper from "@/components/HistoricalChartWrapper";
import HistoricalPoolTiming from "@/components/HistoricalPoolTiming";
import CollapsibleRow from "@/components/CollapsibleRow";
import AnalyticsPanel from "@/components/AnalyticsPanel";

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
  const { isPanelVisible } = useVisualization();
  const { selectedTemplate, setSelectedTemplate } = useSelectedTemplate();
  
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
      // Clear any selected template when switching to realtime view
      setSelectedTemplate(null);
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
    <main className="min-h-screen h-screen bg-transparent flex flex-col">
      <header className="p-4 flex-shrink-0">
        <div>
          <Blocks 
            onBlockClick={handleBlockClick}
            selectedBlockHeight={blockHeight}
            key={`blocks-with-height-${blockHeight}`} // Add a key to force re-render when height changes
          />
        </div>
      </header>
      
      <div className="flex flex-1 overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 overflow-auto">
          {blockHeight !== null && blockHeight > 0 && (
            <div className="px-4">
              <CollapsibleRow title="Findings" defaultExpanded={true}>
                <AnalyticsPanel height={blockHeight} />
              </CollapsibleRow>
            </div>
          )}
          {blockHeight !== null && blockHeight > 0 && (
            <div className="px-4">
              <CollapsibleRow title="Time to First Template" defaultExpanded={true}>
                <HistoricalPoolTiming blockHeight={blockHeight} />
              </CollapsibleRow>
            </div>
          )}
          
          {blockHeight !== null && blockHeight > 0 && (
            <div className="px-4">
              <CollapsibleRow title="Timing Plots" defaultExpanded={false}>
                <div className="h-[210px]">
                  <HistoricalChartWrapper blockHeight={blockHeight} />
                </div>
              </CollapsibleRow>
            </div>
          )}
      
          <RealtimeTable 
            paused={paused}
            showSettings={showSettings}
            onShowSettingsChange={setShowSettings}
            filterBlockHeight={blockHeight ?? undefined}
          />
        </div>
        
        {/* Selected Template Panel */}
        {selectedTemplate && (
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
            filterBlockHeight={blockHeight ?? undefined}
          />
        )}
      </div>
    </main>
  );
} 