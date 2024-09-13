import React from 'react';

interface BlockProps {
  data: {
    height: number;
    pool_name: string;
    timestamp: number;
  };
  isMining?: boolean;
  poolName: string;
}

export function Block({ data, isMining = false, poolName }: BlockProps) {
  return (
    <div className={`block-cube ${isMining ? 'mining' : ''}`}>
      <div className="cube-face front flex flex-col justify-between h-full">
        <div className="text-2xl font-bold">{data.height}</div>
        <div className="text-sm mt-auto">{isMining ? 'Mining' : poolName || 'Unknown'}</div>
      </div>
    </div>
  );
}