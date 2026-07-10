import { beforeEach, describe, expect, test } from 'vitest';

import { detectTemplateChanges, TemplateChangeType, clearTemplateCache } from '../templateChangeDetection';
import { StratumV1Data } from '@/lib/types';

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

describe('Template Change Detection', () => {
  beforeEach(() => {
    clearTemplateCache();
  });

  test('shows first template without specific change indicators', () => {
    const result = detectTemplateChanges(mockStratumData);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toHaveLength(0);
  });

  test('detects merkle branch changes', () => {
    detectTemplateChanges(mockStratumData);
    
    const newData = { 
      ...mockStratumData, 
      job_id: 'job2',
      merkle_branches: ['branch1', 'branch3']
    };
    
    const result = detectTemplateChanges(newData);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(result.changeDetails.merkleBranches?.old).toEqual(['branch1', 'branch2']);
    expect(result.changeDetails.merkleBranches?.new).toEqual(['branch1', 'branch3']);
  });

  test('detects clean jobs changes only when becoming true', () => {
    detectTemplateChanges({ ...mockStratumData, clean_jobs: false });
    
    const newData = { 
      ...mockStratumData, 
      job_id: 'job2',
      clean_jobs: true
    };
    
    const result = detectTemplateChanges(newData);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toContain(TemplateChangeType.CLEAN_JOBS);
    expect(result.changeDetails.cleanJobs?.old).toBe(false);
    expect(result.changeDetails.cleanJobs?.new).toBe(true);
  });

  test('detects multiple core stratum changes', () => {
    detectTemplateChanges(mockStratumData);
    
    const newData = { 
      ...mockStratumData, 
      job_id: 'job2',
      merkle_branches: ['branch1', 'branch3'],
      prev_hash: 'def456',
      version: '20000001'
    };
    
    const result = detectTemplateChanges(newData);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toContain(TemplateChangeType.MERKLE_BRANCHES);
    expect(result.changeTypes).toContain(TemplateChangeType.PREV_HASH);
    expect(result.changeTypes).toContain(TemplateChangeType.VERSION);
  });

  test('shows duplicate job IDs without specific change indicators', () => {
    detectTemplateChanges(mockStratumData);
    
    const result = detectTemplateChanges(mockStratumData);
    
    expect(result.hasChanges).toBe(true);
    expect(result.changeTypes).toHaveLength(0);
  });
});
