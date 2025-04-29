'use client';

import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Laptop } from 'lucide-react';

interface CollectorNodeData {
  label: string | React.ReactNode;
  // No message data needed for this node
}

const CollectorNode: React.FC<NodeProps<CollectorNodeData>> = ({ data, isConnectable }) => {
  return (
    <div className="react-flow__node-default p-4 rounded-md border bg-background shadow-md flex flex-col items-center w-48">
      <div className="flex items-center mb-2">
        <Laptop className="h-6 w-6 mr-2 text-blue-500" />
        <div className="font-medium text-center">{data.label}</div>
      </div>
      {/* Only a source handle needed */}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        className="!bg-blue-500"
      />
    </div>
  );
};

export default memo(CollectorNode); 