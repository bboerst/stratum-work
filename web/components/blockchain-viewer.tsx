'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { io } from 'socket.io-client';
import Link from 'next/link';
import { Github, Settings, Play, Pause } from 'lucide-react';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { SettingsDropdown } from './settings-dropdown';
import { Block } from './block';
import { MiningDataTable } from './mining-data-table';
import { useBlockchainData } from '../hooks/use-blockchain-data';
import { useVisibleColumns } from '../hooks/use-visible-columns';

export function BlockchainViewer() {
  const [isPaused, setIsPaused] = useState(false);
  const [sortConfig, setSortConfig] = useState({ key: 'coinbase_output_value', direction: 'descending' });
  const [maxMerkleBranches, setMaxMerkleBranches] = useState(10);

  const columns = useMemo(() => [
    { title: "Pool Name", key: "pool_name" },
    { title: "Template Revision", key: "template_revision" },
    { title: "Time Since Last Revision", key: "time_since_last_revision" },
    { title: "Timestamp", key: "timestamp" },
    { title: "Height", key: "height" },
    { title: "Previous Block Hash", key: "prev_block_hash" },
    { title: "Block Version", key: "block_version" },
    { title: "Coinbase RAW", key: "coinbase_raw" },
    { title: "Version", key: "version" },
    { title: "Nbits", key: "nbits" },
    { title: "Ntime", key: "ntime" },
    { title: "Coinbase Script (ASCII)", key: "coinbase_script_ascii" },
    { title: "Clean Jobs", key: "clean_jobs" },
    { title: "Coinbase Outputs", key: "coinbase_outputs" },
    { title: "First Tx", key: "first_transaction" },
    { title: "First Tx Fee Rate (sat/vB)", key: "fee_rate" },
    ...Array(13).fill(null).map((_, i) => ({ title: `Merkle Branch ${i + 1}`, key: `merkle_branch_${i}` })),
    { title: "Coinbase Output Value", key: "coinbase_output_value" }
  ], []);

  const { miningData, blocks, blockPoolNames, setMiningData, setBlocks, setBlockPoolNames, fetchPoolName } = useBlockchainData();
  const { visibleColumns, handleToggleColumn, setColumns } = useVisibleColumns(columns);

  useEffect(() => {
    setColumns(columns);
  }, [columns, setColumns]);

  useEffect(() => {
    const socket = io(process.env.NEXT_PUBLIC_SOCKET_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: false
    });

    socket.on('connect', () => {
      console.log('Connected to WebSocket');
    });

    socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected from WebSocket:', reason);
    });

    socket.on('mining_data', (data) => {
      if (!isPaused) {
        setMiningData(prevData => {
          const existingIndex = prevData.findIndex(item => item.pool_name === data.pool_name);
          let newData;
          if (existingIndex !== -1) {
            newData = [...prevData];
            newData[existingIndex] = {
              ...data,
              merkle_branch_colors: data.merkle_branch_colors || newData[existingIndex].merkle_branch_colors
            };
          } else {
            newData = [...prevData, data];
          }
          return newData;
        });
        
        setMaxMerkleBranches(prev => Math.max(prev, data.merkle_branches?.length || 0));
      }
    });

    socket.on('new_block', async (data) => {
      if (!isPaused) {
        const poolName = await fetchPoolName(data.height);
        setBlockPoolNames(prev => ({ ...prev, [data.height]: poolName }));
        setBlocks(prevBlocks => {
          if (prevBlocks.some(block => block.height === data.height)) {
            return prevBlocks;
          }
          const newBlock = { ...data, key: `${data.height}-${data.hash}-${prevBlocks.length}`, poolName };
          return [newBlock, ...prevBlocks.slice(0, 4)];
        });
      }
    });

    return () => {
      console.log('BlockchainViewer component unmounting');
      socket.disconnect();
    };
  }, [isPaused, setMiningData, setBlocks, setBlockPoolNames, fetchPoolName]);

  const handleSort = useCallback((key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'ascending' ? 'descending' : 'ascending'
    }));
  }, []);

  return (
    <div className="w-full">
      <Header
        visibleColumns={visibleColumns}
        onToggleColumn={handleToggleColumn}
        columns={columns}
      />
      <BlockChain
        blocks={blocks}
        blockPoolNames={blockPoolNames}
      />
      <div className="w-full overflow-x-auto">
        <div className="flex justify-end items-center py-2 px-4 md:px-6 lg:px-8">
          <Button variant="outline" size="sm" onClick={() => setIsPaused(!isPaused)} className="flex items-center">
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            <span className="ml-2">{isPaused ? 'Resume' : 'Pause'}</span>
          </Button>
        </div>
        <MiningDataTable
          miningData={miningData}
          columns={columns}
          visibleColumns={visibleColumns}
          sortConfig={sortConfig}
          onSort={handleSort}
          maxMerkleBranches={maxMerkleBranches}
        />
      </div>
    </div>
  );
}

function Header({ visibleColumns, onToggleColumn, columns }) {
  return (
    <div className="flex justify-end items-center py-2 px-4 md:px-6 lg:px-8">
      <div className="flex items-center space-x-4">
        <Link href="https://github.com/bboerst/stratum-work" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center w-8 h-8">
          <Github className="w-5 h-5 cursor-pointer" />
        </Link>
        <SettingsDropdown
          columns={columns}
          visibleColumns={visibleColumns}
          onToggleColumn={onToggleColumn}
        >
          <div className="flex items-center justify-center w-8 h-8">
            <Settings className="w-5 h-5 cursor-pointer" />
          </div>
        </SettingsDropdown>
      </div>
    </div>
  );
}

function BlockChain({ blocks, blockPoolNames }) {
  return (
    <div className="px-4 md:px-6 lg:px-8">
      <div className="flex items-center space-x-8 overflow-x-auto pb-4 pt-2 pl-4 transition-all duration-500 ease-in-out">
        <Block data={{height: blocks[0] ? blocks[0].height + 1 : 0, pool_name: 'Mining', timestamp: Date.now() / 1000}} isMining={true} poolName="Mining" />
        <div className="h-32 border-l-2 border-dotted border-gray-400"></div>
        {blocks.map((block) => (
          <Block key={block.key} data={block} poolName={blockPoolNames[block.height] || 'Unknown'} />
        ))}
      </div>
    </div>
  );
}