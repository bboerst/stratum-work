"use client";

import React from "react";
import PauseButton from "./PauseButton";

interface SankeyPageControlsProps {
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

export default function SankeyPageControls({ paused, setPaused }: SankeyPageControlsProps) {
  return (
    <PauseButton
      paused={paused}
      onToggle={() => setPaused(!paused)}
    />
  );
}