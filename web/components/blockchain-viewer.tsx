'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Settings, Github, Play, Pause } from 'lucide-react'
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import io from 'socket.io-client'

const generateCoinbaseOutputs = () => {
  const outputs = [];
  const numOutputs = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < numOutputs; i++) {
    outputs.push({
      address: `bc1q${Math.random().toString(36).substring(2, 15)}`,
      value: (Math.random() * 5).toFixed(8),
    });
  }
  return outputs;
};

const generateFirstTransaction = () => {
  return Math.random() < 0.1 ? 'empty block' : `${Math.random().toString(36).substring(2, 15)}`;
};

const Block = ({ data, isMining = false, poolName }) => (
  <div className={`flex flex-col items-center justify-center w-24 h-24 ${isMining ? 'bg-green-700' : 'bg-blue-700'} text-white border border-gray-600 transition-all duration-500 ease-in-out`}>
    <div className="text-lg font-bold">{data.height}</div>
    <div className="text-xs mt-1">{isMining ? 'Mining' : poolName || 'Unknown'}</div>
    <div className="text-xs">{new Date(data.timestamp * 1000).toLocaleTimeString()}</div>
  </div>
)

export function BlockchainViewer() {
  const [miningData, setMiningData] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [sortConfig, setSortConfig] = useState({ key: 'coinbase_output_value', direction: 'descending' });
  const [maxMerkleBranches, setMaxMerkleBranches] = useState(10);
  const [blockPoolNames, setBlockPoolNames] = useState({});

  const handleSort = (key) => {
    let direction = 'ascending';
    if (sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending';
    }
    setSortConfig({ key, direction });
  };

  const sortedMiningData = useMemo(() => {
    let sortableItems = [...miningData];
    const { key, direction } = sortConfig;
    if (key !== null) {
      sortableItems.sort((a, b) => {
        if (key === 'coinbase_output_value') {
          const aValue = a.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0);
          const bValue = b.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0);
          return direction === 'ascending' ? aValue - bValue : bValue - aValue;
        } else if (key.startsWith('merkle_branch_')) {
          const index = parseInt(key.split('_')[2]);
          const aValue = a.merkle_branches[index] || '';
          const bValue = b.merkle_branches[index] || '';
          return direction === 'ascending' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
        } else {
          const aValue = a[key];
          const bValue = b[key];
          if (typeof aValue === 'string' && typeof bValue === 'string') {
            return direction === 'ascending' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
          }
          return direction === 'ascending' ? aValue - bValue : bValue - aValue;
        }
      });
    }
    return sortableItems;
  }, [miningData, sortConfig, maxMerkleBranches]);

  const fetchPoolName = async (blockHeight) => {
    try {
      const response = await fetch(`https://mempool.space/api/v1/block-height/${blockHeight}`);
      const blockHash = await response.text();
      const blockResponse = await fetch(`https://mempool.space/api/block/${blockHash}`);
      const blockData = await blockResponse.json();
      return blockData.pool?.name || 'Unknown';
    } catch (error) {
      console.error('Error fetching pool name:', error);
      return 'Unknown';
    }
  };

  useEffect(() => {
    const socket = io(process.env.NEXT_PUBLIC_SOCKET_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: false
    });

    socket.on('connect', () => {
      console.log('Connected to WebSocket');
      setConnectionStatus('Connected');
      socket.emit('request_initial_blocks');
    });

    socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      setConnectionStatus(`Connection error: ${error.message}`);
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected from WebSocket:', reason);
      setConnectionStatus(`Disconnected: ${reason}`);
    });

    socket.on('mining_data', (data) => {
      console.log('Received mining_data event:', data);
      if (!isPaused) {
        setMiningData(prevData => {
          const existingIndex = prevData.findIndex(item => item.pool_name === data.pool_name);
          let newData;
          if (existingIndex !== -1) {
            newData = [...prevData];
            newData[existingIndex] = data;
          } else {
            newData = [...prevData, data];
          }
          console.log('Updated miningData:', newData);
          return newData;
        });
        
        // Update maxMerkleBranches
        setMaxMerkleBranches(prev => Math.max(prev, data.merkle_branches?.length || 0));
      }
    });

    socket.on('initial_blocks', (initialBlocks) => {
      setBlocks(initialBlocks.map((block, index) => ({
        ...block,
        key: `${block.height}-${block.hash}-${index}`
      })));
    });

    socket.on('new_block', async (data) => {
      if (!isPaused) {
        const poolName = await fetchPoolName(data.height);
        setBlockPoolNames(prev => ({ ...prev, [data.height]: poolName }));
        setBlocks(prevBlocks => {
          if (prevBlocks.some(block => block.height === data.height)) {
            return prevBlocks;
          }
          const newBlocks = [data, ...prevBlocks.slice(0, 4)];
          return newBlocks.map((block, index) => ({
            ...block,
            key: `${block.height}-${block.hash}-${index}`
          }));
        });
      }
    });

    return () => {
      console.log('BlockchainViewer component unmounting');
      socket.disconnect();
    };
  }, [isPaused]);

  const columns = [
    { title: "Pool Name", key: "pool_name", width: "200px" },
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
    ...Array(maxMerkleBranches).fill(null).map((_, i) => ({ title: `Merkle Branch ${i + 1}`, key: `merkle_branch_${i}` })),
    { title: "Coinbase Output Value", key: "coinbase_output_value" }
  ];

  return (
    <div className="w-full">
      <div className="px-4 md:px-6 lg:px-8">
        <header className="flex justify-between items-center py-4">
          <h1 className="text-2xl font-bold">Mining Data Viewer</h1>
          <div className="flex space-x-2">
            <Button variant="outline" size="sm" onClick={() => setIsPaused(!isPaused)}>
              {isPaused ? <Play className="w-4 h-4 mr-2" /> : <Pause className="w-4 h-4 mr-2" />}
              {isPaused ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="outline" size="sm">
              <Settings className="w-4 h-4 mr-2" />
              Settings
            </Button>
            <Button variant="outline" size="sm">
              <Github className="w-4 h-4 mr-2" />
              GitHub
            </Button>
          </div>
        </header>
        <p className="mb-4">Connection status: {connectionStatus}</p>
        
        <div className="flex space-x-4 mb-8 overflow-x-auto transition-all duration-500 ease-in-out">
          <Block data={{height: blocks[0] ? blocks[0].height + 1 : 0, pool_name: 'Mining', timestamp: Date.now() / 1000}} isMining={true} poolName="Mining" />
          {blocks.map((block) => (
            <Block key={block.key} data={block} poolName={blockPoolNames[block.height] || 'Unknown'} />
          ))}
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <Table className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => (
                <TableHead 
                  key={index} 
                  className="cursor-pointer select-none relative"
                  onClick={() => handleSort(column.key)}
                  style={{ width: column.key === 'pool_name' ? 'px' : `${100 / columns.length}%` }}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{column.title}</span>
                    {sortConfig.key === column.key && (
                      <span className="ml-1">
                        {sortConfig.direction === 'ascending' ? '▲' : '▼'}
                      </span>
                    )}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedMiningData.map((data) => (
              <TableRow key={data.pool_name}>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.pool_name}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.template_revision}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.time_since_last_revision}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{new Date(data.timestamp).toLocaleString()}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.height}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.prev_block_hash}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.block_version}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.coinbase_raw}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.version}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.nbits}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{new Date(data.ntime * 1000).toLocaleString()}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.coinbase_script_ascii}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.clean_jobs ? 'Yes' : 'No'}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{JSON.stringify(data.coinbase_outputs)}</TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">
                  {data.first_transaction !== 'empty block' ? (
                    <a href={`https://mempool.space/tx/${data.first_transaction}`} target="_blank" rel="noopener noreferrer">
                      {data.first_transaction}
                    </a>
                  ) : (
                    'empty block'
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">{data.fee_rate}</TableCell>
                {data.merkle_branches?.map((branch, index) => (
                  <TableCell 
                    key={index} 
                    className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0"
                    style={{
                      backgroundColor: data.merkle_branch_colors?.[index] || 'white',
                      color: 'black',
                      borderColor: data.merkle_branch_colors?.[index] || 'white'
                    }}
                  >
                    {branch}
                  </TableCell>
                ))}
                <TableCell className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0">
                  {data.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0).toFixed(8)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}