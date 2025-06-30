"use client";

import React, { useState } from 'react';

interface CollapsibleRowProps {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}

export default function CollapsibleRow({ title, children, defaultExpanded = false }: CollapsibleRowProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="mb-4">
      <div 
        className="flex items-center cursor-pointer px-4 py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded-t-lg"
        onClick={toggleExpanded}
      >
        <span className="text-lg font-medium mr-2 select-none">
          {isExpanded ? '−' : '+'}
        </span>
        <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">
          {title}
        </h3>
      </div>
      
      <div 
        className={`bg-white dark:bg-gray-900 rounded-b-lg border-l border-r border-b border-gray-200 dark:border-gray-700 transition-all duration-300 overflow-hidden ${
          isExpanded ? 'max-h-screen opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        {children}
      </div>
    </div>
  );
}