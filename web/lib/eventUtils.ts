/**
 * Live data validation utilities for Stratum V1 events
 */

import { StratumV1Event } from './sankeyDataProcessor';

/**
 * Validate that a StratumV1Event has the expected structure
 */
export function validateStratumV1Event(event: any): event is StratumV1Event {
  return (
    event &&
    typeof event === 'object' &&
    typeof event.type === 'string' &&
    typeof event.id === 'string' &&
    typeof event.timestamp === 'string' &&
    event.data &&
    typeof event.data === 'object' &&
    typeof event.data._id === 'string' &&
    typeof event.data.timestamp === 'string' &&
    typeof event.data.pool_name === 'string' &&
    typeof event.data.height === 'number' &&
    typeof event.data.job_id === 'string' &&
    Array.isArray(event.data.merkle_branches) &&
    event.data.merkle_branches.every((branch: any) => typeof branch === 'string')
  );
}


