"use client";
import React, { useEffect, useState, useRef } from "react";
export interface Block { height: number; block_hash: string; timestamp: number; }
interface BlocksProps { onBlockClick?: (height: number) => void; }
export default function Blocks({ onBlockClick }: BlocksProps) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [chainTip, setChainTip] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch("/api/blocks?n=20")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Block[]) => {
        if (data.length) {
          const sorted = data.sort((a, b) => b.height - a.height);
          setChainTip(sorted[0].height);
          setBlocks(sorted);
        }
      })
      .catch((err) => console.error("Initial fetch error", err));
  }, []);
  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/blocks?n=20")
        .then((res) => (res.ok ? res.json() : []))
        .then((data: Block[]) => {
          if (data.length) {
            const sorted = data.sort((a, b) => b.height - a.height);
            const latest = sorted[0];
            if (latest.height > chainTip) {
              if (containerRef.current) {
                containerRef.current.classList.add("shift-animation");
                setTimeout(() => {
                  containerRef.current?.classList.remove("shift-animation");
                }, 300);
              }
              setBlocks((prev) => [latest, ...prev].slice(0, 20));
              setChainTip(latest.height);
            }
          }
        })
        .catch((err) => console.error("Polling error", err));
    }, 5000);
    return () => clearInterval(interval);
  }, [chainTip]);
  const currentMinedBlockHeight = chainTip + 1;
  return (
    <div ref={containerRef} className="blocks-container flex items-center transition-transform duration-300">
      <div
        className="block-3d animate-pulse"
        title={`Block ${currentMinedBlockHeight} (being mined) – click to revert to realtime`}
        onClick={() => onBlockClick && onBlockClick(-1)}
      >
        <span className="text-xs">{currentMinedBlockHeight}</span>
      </div>
      {blocks.map((block) => (
        <div
          key={block.block_hash}
          className="block-3d transition-transform duration-300"
          title={`Block ${block.height}\nHash: ${block.block_hash}`}
          onClick={() => onBlockClick && onBlockClick(block.height)}
        >
          <span className="text-xs">{block.height}</span>
        </div>
      ))}
      <style jsx>{`
        .block-3d {
          position: relative;
          width: 96px;
          height: 64px;
          background: rgb(100, 100, 100);
          color: white;
          font-family: monospace;
          font-weight: bold;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          clip-path: polygon(0px 32px, 15px 0px, 96px 0px, 82px 32px, 96px 64px, 15px 64px);
          margin-right: 4px;
        }
        .block-3d::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 96px;
          height: 64px;
          background: rgb(80, 80, 80);
          clip-path: polygon(96px 0px, 82px 32px, 96px 64px, 106px 74px, 106px 10px);
          z-index: -1;
        }
        .block-3d::after {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 96px;
          height: 64px;
          background: rgb(60, 60, 60);
          clip-path: polygon(15px 64px, 96px 64px, 106px 74px, 5px 74px);
          z-index: -2;
        }
        .shift-animation > .block-3d {
          transform: translateX(100px);
        }
      `}</style>
    </div>
  );
}