"use client";

import React from "react";

interface PauseButtonProps {
  paused: boolean;
  setPaused: (value: boolean | ((prev: boolean) => boolean)) => void;
  className?: string;
}

export default function PauseButton({ paused, setPaused, className = "" }: PauseButtonProps) {
  const handleToggle = () => {
    setPaused(!paused);
  };

  return (
    <button
      className={`pause-button flex items-center gap-2 px-3 py-2 rounded bg-gray-200 text-gray-800 hover:bg-gray-300 transition-colors duration-200 text-sm font-medium ${className}`}
      onClick={handleToggle}
      title={paused ? "Resume" : "Pause"}
    >
      {paused ? (
        <>
          <svg
            className="inline-block w-5 h-5"
            height="800px"
            width="800px"
            version="1.1"
            viewBox="0 0 512 512"
            fill="currentColor"
          >
            <path d="M256,0C114.625,0,0,114.625,0,256c0,141.374,114.625,256,256,256s256-114.626,256-256C512,114.625,397.374,0,256,0z M351.062,258.898l-144,85.945c-1.031,0.626-2.344,0.657-3.406,0.031c-1.031-0.594-1.687-1.702-1.687-2.937v-85.946v-85.946c0-1.218,0.656-2.343,1.687-2.938c1.062-0.609,2.375-0.578,3.406,0.031l144,85.962c1.031,0.586,1.641,1.718,1.641,2.89C352.703,257.187,352.094,258.297,351.062,258.898z" />
          </svg>
          Resume
        </>
      ) : (
        <>
          <svg
            className="inline-block w-5 h-5"
            fill="currentColor"
            version="1.1"
            viewBox="0 0 45.812 45.812"
            width="800px"
            height="800px"
          >
            <g>
              <g>
                <g>
                  <path d="M39.104,6.708c-8.946-8.943-23.449-8.946-32.395,0c-8.946,8.944-8.946,23.447,0,32.394   c8.944,8.946,23.449,8.946,32.395,0C48.047,30.156,48.047,15.653,39.104,6.708z M20.051,31.704c0,1.459-1.183,2.64-2.641,2.64   s-2.64-1.181-2.64-2.64V14.108c0-1.457,1.182-2.64,2.64-2.64s2.641,1.183,2.641,2.64V31.704z M31.041,31.704   c0,1.459-1.183,2.64-2.64,2.64s-2.64-1.181-2.64-2.64V14.108c0-1.457,1.183-2.64,2.64-2.64s2.64,1.183,2.64,2.64V31.704z" />
                </g>
              </g>
            </g>
          </svg>
          Pause
        </>
      )}
    </button>
  );
}
