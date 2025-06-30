import { detectTemplateChanges, TemplateChangeType, clearTemplateCache } from '../templateChangeDetection';
import { StratumV1Data } from '@/lib/types';
import { CoinbaseOutputDetail } from '../bitcoinUtils';

// Mock data for testing
const mockStratumData: StratumV1Data = {
  pool_name: 'test-pool',
  timestamp: '1234567890',
  job_id: 'job1',
  height: 100,
  prev_hash: 'abc123',
  version: '20000000',
  coinbase1: 'coinbase1',
  coinbase2: 'coinbase2',
  extranonce1: 'extra1',
  extranonce2_length: 4,
  clean_jobs: true,
  first_transaction: 'tx1',
  fee_rate: 1000,
  merkle_branches: ['branch1', 'branch2']
};

const mockCoinbaseOutputs: CoinbaseOutputDetail[] = [
  {
    type: 'nulldata',
    value: 0,
    hex: '6a',
    decodedData: {
      protocol: 'RSK Block',
      details: {
        rskBlockHash: 'rsk123'
      },
      dataHex: 'deadbeef'
    }
  }
];

describe('Template Change Detection', () => {
  beforeEach(() => {
    clearTemplateCache();
  });

  test('should detect no changes for first template', () => {
    const result = detectTemplateChanges(mockStratumData, mockCoinbaseOutputs);
    
    expect(result.hasChanges).toBe(false);
    expect(result.changeTypes).toHaveLength(0);
  });

  test('should detect RSK hash changes', () => {
    // First template
    detectTemplateChanges(mockStratumData, mockCoinbaseOutputs);
    
    // Second template with different RSK hash
    const newOutputs: CoinbaseOutputDetail[] = [
      {
        type: 'nulldata',
        value: 0,
        hex: '6a',
        decodedData: {
          protocol: 'RSK Block',
          details: {
            rskBlockHash: 'rsk456' // Different RSK hash
          },
          dataHex: 'deadbeef'
        }
      }
    ];
    
    const newData = { ...mockStratumData, job_id: 'job2' };
    const result = detectTemplateChanges(newData, newOutputs);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toContain(TemplateChangeType.RSK_HASH);
    expect(result.changeDetails.rskHash?.old).toBe('rsk123');
    expect(result.changeDetails.rskHash?.new).toBe('rsk456');
  });

  test('should detect merkle branch changes', () => {
    // First template
    detectTemplateChanges(mockStratumData, mockCoinbaseOutputs);
    
    // Second template with different merkle branches
    const newData = { 
      ...mockStratumData, 
      job_id: 'job2',
      merkle_branches: ['branch1', 'branch3'] // Changed branch2 to branch3
    };
    
    const result = detectTemplateChanges(newData, mockCoinbaseOutputs);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(result.changeDetails.merkleBranches?.old).toEqual(['branch1', 'branch2']);
    expect(result.changeDetails.merkleBranches?.new).toEqual(['branch1', 'branch3']);
  });

  test('should detect multiple changes', () => {
    // First template
    detectTemplateChanges(mockStratumData, mockCoinbaseOutputs);
    
    // Second template with multiple changes
    const newOutputs: CoinbaseOutputDetail[] = [
      {
        type: 'nulldata',
        value: 0,
        hex: '6a',
        decodedData: {
          protocol: 'RSK Block',
          details: {
            rskBlockHash: 'rsk456' // Different RSK hash
          },
          dataHex: 'deadbeef'
        }
      }
    ];
    
    const newData = { 
      ...mockStratumData, 
      job_id: 'job2',
      merkle_branches: ['branch1', 'branch3'] // Different merkle branches
    };
    
    const result = detectTemplateChanges(newData, newOutputs);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toContain(TemplateChangeType.RSK_HASH);
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
  });

  test('should ignore duplicate job IDs', () => {
    // First template
    detectTemplateChanges(mockStratumData, mockCoinbaseOutputs);
    
    // Same template with same job ID (duplicate message)
    const result = detectTemplateChanges(mockStratumData, mockCoinbaseOutputs);
    
    expect(result.hasChanges).toBe(false);
    expect(result.changeTypes).toHaveLength(0);
  });
});