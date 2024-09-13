import { useState, useCallback } from 'react';

export function useBlockchainData() {
  const [miningData, setMiningData] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [blockPoolNames, setBlockPoolNames] = useState({});

  const fetchPoolName = useCallback(async (blockHeight) => {
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
  }, []);

  return {
    miningData,
    blocks,
    blockPoolNames,
    setMiningData,
    setBlocks,
    setBlockPoolNames,
    fetchPoolName
  };
}