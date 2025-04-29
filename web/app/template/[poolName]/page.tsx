'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import BlockTemplateCard from '@/components/BlockTemplateCard';
import { useParams, useRouter } from 'next/navigation';

export default function ServiceGraphPage() {
  const params = useParams();
  const router = useRouter();
  const selectedPoolName = params.poolName ? decodeURIComponent(params.poolName as string) : null;

  const { latestMessagesByPool } = useGlobalDataStream();

  const filteredMessage = useMemo(() => {
    if (selectedPoolName && latestMessagesByPool && latestMessagesByPool[selectedPoolName]) {
      return latestMessagesByPool[selectedPoolName];
    }
    return null;
  }, [latestMessagesByPool, selectedPoolName]);

  const [elapsedTime, setElapsedTime] = useState<string>('');
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    const updateTimer = () => {
        if (filteredMessage?.timestamp) {
            try {
                const receivedTimeMs = parseInt(filteredMessage.timestamp, 16) / 1000000;
                const nowMs = Date.now();
                const diffSeconds = Math.max(0, Math.floor((nowMs - receivedTimeMs) / 1000));
                const minutes = Math.floor(diffSeconds / 60);
                const seconds = diffSeconds % 60;
                setElapsedTime(`${minutes}m ${seconds}s ago`);
            } catch (e) {
                console.error("Error parsing timestamp for timer:", e);
                setElapsedTime('Error');
                if (intervalId) clearInterval(intervalId);
            }
        } else {
            setElapsedTime(''); 
        }
    };

    if (filteredMessage?.timestamp) {
        updateTimer();
        intervalId = setInterval(updateTimer, 1000);
    }

    return () => {
        if (intervalId) {
            clearInterval(intervalId);
        }
    };
  }, [filteredMessage?.timestamp]);

  return (
    <div className="pt-2 pb-10 flex flex-col h-[calc(100vh-100px)] px-6">
       <div 
         className="mb-4 text-sm text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer w-fit"
         onClick={() => router.back()}
       >
         ← Back
       </div>
       <div className="flex justify-between items-start mb-1">
        <h1 className="text-2xl font-bold">
          Block Template{selectedPoolName ? `: ${selectedPoolName}` : 's'}
        </h1>
        {filteredMessage && (
            <div className="text-right text-muted-foreground text-sm whitespace-nowrap pl-4 pt-1 pr-4">
                Updated: {elapsedTime}
            </div>
        )}
      </div>
       <div className="flex-grow overflow-y-auto pt-1 pb-4 space-y-6">
          {filteredMessage ? (
              <BlockTemplateCard key={filteredMessage.pool_name} latestMessage={filteredMessage} />
          ) : (
             <div className="flex items-center justify-center h-full">
                 <p className="text-muted-foreground bg-card p-4 rounded shadow-md"> 
                     {selectedPoolName 
                         ? `Waiting for Stratum V1 messages for pool: ${selectedPoolName}...`
                         : 'No pool specified in URL.'}
                 </p>
             </div>
         )}
       </div>
     </div>
   );
 } 