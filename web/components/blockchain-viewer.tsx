'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Settings, Github, Play, Pause } from 'lucide-react'
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import io from 'socket.io-client'
import { SettingsDropdown } from '@/components/settings-dropdown';

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
  <div className={`block-cube ${isMining ? 'mining' : ''}`}>
    <div className="cube-face front flex flex-col justify-between h-full">
      <div className="text-2xl font-bold">{data.height}</div>
      <div className="text-sm mt-auto">{isMining ? 'Mining' : poolName || 'Unknown'}</div>
    </div>
  </div>
)

export function BlockchainViewer() {
  const [miningData, setMiningData] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  const [sortConfig, setSortConfig] = useState({ key: 'coinbase_output_value', direction: 'descending' });
  const [maxMerkleBranches, setMaxMerkleBranches] = useState(10);
  const [blockPoolNames, setBlockPoolNames] = useState({});
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    const defaultVisibleColumns = new Set(columns.map(col => col.key));
    const hiddenColumns = [
      "prev_block_hash",
      "block_version",
      "coinbase_raw",
      "version",
      "nbits",
      "ntime"
    ];
    hiddenColumns.forEach(col => defaultVisibleColumns.delete(col));

    const storedVisibleColumns = localStorage.getItem('visibleColumns');
    if (storedVisibleColumns) {
      setVisibleColumns(new Set(JSON.parse(storedVisibleColumns)));
    } else {
      setVisibleColumns(defaultVisibleColumns);
    }
  }, [columns]);

  const handleToggleColumn = useCallback((key: string) => {
    setVisibleColumns(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      localStorage.setItem('visibleColumns', JSON.stringify(Array.from(newSet)));
      return newSet;
    });
  }, []);

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
      const blockHashResponse = await fetch(`https://mempool.space/api/block-height/${blockHeight}`);
      const blockHash = await blockHashResponse.text();
      
      const blockResponse = await fetch(`https://mempool.space/api/block/${blockHash}`);
      const blockData = await blockResponse.json();
      
      return blockData.extras?.pool?.name || 'Unknown';
    } catch (error) {
      console.error('Error fetching pool name:', error);
      return 'Unknown';
    }
  };

  const fetchInitialBlocks = async () => {
    try {
      const response = await fetch('/api/blocks');
      if (!response.ok) {
        throw new Error('Failed to fetch blocks');
      }
      const initialBlocks = await response.json();
      const blocksWithPoolNames = await Promise.all(initialBlocks.map(async (block, index) => {
        const poolName = await fetchPoolName(block.height);
        return {
          ...block,
          key: `${block.height}-${block.hash}-${index}`,
          poolName
        };
      }));
      setBlocks(blocksWithPoolNames);
      setBlockPoolNames(Object.fromEntries(blocksWithPoolNames.map(block => [block.height, block.poolName])));
    } catch (error) {
      console.error('Error fetching initial blocks:', error);
    }
  };

  useEffect(() => {
    fetchInitialBlocks();

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
      console.log('Received mining_data event:', data);
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
          console.log('Updated miningData:', newData);
          return newData;
        });
        
        // Update maxMerkleBranches
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
          const newBlocks = [newBlock, ...prevBlocks.slice(0, 4)];
          return newBlocks;
        });
      }
    });

    return () => {
      console.log('BlockchainViewer component unmounting');
      socket.disconnect();
    };
  }, [isPaused]);

  return (
    <div className="w-full">
      <div className="flex justify-end items-center py-2 px-4 md:px-6 lg:px-8">
        <div className="flex items-center space-x-4">
          <Link href="https://github.com/bboerst/stratum-work" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center w-8 h-8">
            <Github className="w-5 h-5 cursor-pointer" />
          </Link>
          <SettingsDropdown
            columns={columns}
            visibleColumns={visibleColumns}
            onToggleColumn={handleToggleColumn}
          >
            <div className="flex items-center justify-center w-8 h-8">
              <Settings className="w-5 h-5 cursor-pointer" />
            </div>
          </SettingsDropdown>
        </div>
      </div>

      <div className="px-4 md:px-6 lg:px-8">
        <div className="flex items-center space-x-8 overflow-x-auto pb-4 pt-2 pl-4 transition-all duration-500 ease-in-out">
          <Block data={{height: blocks[0] ? blocks[0].height + 1 : 0, pool_name: 'Mining', timestamp: Date.now() / 1000}} isMining={true} poolName="Mining" />
          <div className="h-32 border-l-2 border-dotted border-gray-400"></div>
          {blocks.map((block) => (
            <Block key={block.key} data={block} poolName={blockPoolNames[block.height] || 'Unknown'} />
          ))}
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <div className="flex justify-end items-center py-2 px-4 md:px-6 lg:px-8">
          <Button variant="outline" size="sm" onClick={() => setIsPaused(!isPaused)} className="flex items-center">
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            <span className="ml-2">{isPaused ? 'Resume' : 'Pause'}</span>
          </Button>
        </div>
        <Table className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              {columns.filter(column => visibleColumns.has(column.key)).map((column, index) => (
                <TableHead 
                  key={index} 
                  className="cursor-pointer select-none relative"
                  onClick={() => handleSort(column.key)}
                  isPoolName={column.key === 'pool_name'}
                  title={column.title}
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
                {columns.filter(column => visibleColumns.has(column.key)).map((column, index) => {
                  const content = renderCellContent(data, column);
                  const cellValue = content.value;
                  const tooltipContent = content.tooltip || (typeof cellValue === 'string' ? cellValue : JSON.stringify(cellValue, (key, value) => {
                    if (typeof value === 'object' && value !== null) {
                      if (value instanceof Date) {
                        return value.toISOString();
                      }
                      if (Object.keys(value).length > 20) {
                        return '[Complex Object]';
                      }
                    }
                    return value;
                  }));
                  return (
                    <TableCell
                      key={index} 
                      className="whitespace-nowrap overflow-hidden text-ellipsis font-mono p-1 max-w-0"
                      style={column.key.startsWith('merkle_branch_') || column.key === 'coinbase_outputs' ? { backgroundColor: content.color, color: content.textColor } : {}}
                      title={tooltipContent}
                      data-merkle-branch={column.key.startsWith('merkle_branch_') ? true : undefined}
                    >
                      {cellValue}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function renderCellContent(data, column) {
  switch (column.key) {
    case 'timestamp': {
      const date = new Date(data.timestamp);
      const timeString = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return { value: timeString, tooltip: date.toLocaleString() };
    }
    case 'ntime': {
      const ntimeHex = parseInt(data.ntime, 16);
      const date = new Date(ntimeHex * 1000);
      const timeString = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return { value: timeString, tooltip: date.toLocaleString() };
    }
    case 'time_since_last_revision':
      return { value: `${data.time_since_last_revision.toFixed(3)}s` };
    case 'clean_jobs':
      return { value: data.clean_jobs ? 'Yes' : 'No' };
    case 'coinbase_outputs': {
      const filteredOutputs = data.coinbase_outputs.filter(output => !output.address.startsWith('(nulldata'));
      const outputs = filteredOutputs.map(output => `${output.address}: ${output.value} BTC`).join('\n');
      const addresses = filteredOutputs.map(output => output.address).join('');

      // Generate a hash from the addresses
      let hash = 0;
      for (let i = 0; i < addresses.length; i++) {
        hash = addresses.charCodeAt(i) + ((hash << 5) - hash);
      }
      let color = '#';
      for (let i = 0; i < 3; i++) {
        const value = (hash >> (i * 8)) & 0xFF;
        color += ('00' + value.toString(16)).slice(-2);
      }

      // Blend the color with white to make it lighter
      const blendWithWhite = (color, percentage) => {
        const f = parseInt(color.slice(1), 16);
        const t = percentage < 0 ? 0 : 255;
        const p = percentage < 0 ? percentage * -1 : percentage;
        const R = f >> 16;
        const G = f >> 8 & 0x00FF;
        const B = f & 0x0000FF;
        return `#${(0x1000000 + (Math.round((t - R) * p) + R) * 0x10000 + (Math.round((t - G) * p) + G) * 0x100 + (Math.round((t - B) * p) + B)).toString(16).slice(1)}`;
      };

      color = blendWithWhite(color, 0.5); // Adjust the percentage to make the color lighter

      return { value: outputs, tooltip: outputs, color, textColor: '#000000' };
    }
    case 'first_transaction':
      return {
        value: data.first_transaction !== 'empty block' ? (
          <a href={`https://mempool.space/tx/${data.first_transaction}`} target="_blank" rel="noopener noreferrer">
            {data.first_transaction}
          </a>
        ) : 'empty block'
      };
    case 'coinbase_output_value':
      return { value: data.coinbase_outputs.reduce((sum, output) => sum + parseFloat(output.value), 0).toFixed(8) };
    default:
      if (column.key.startsWith('merkle_branch_')) {
        const index = parseInt(column.key.split('_')[2]);
        const value = data.merkle_branches?.[index] || '';
        const color = data.merkle_branch_colors?.[index] || 'transparent';
        return { value, color, textColor: value ? '#000000' : 'transparent' };
      }
      return { value: data[column.key] };
  }
}