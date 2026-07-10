import { describe, expect, test } from 'vitest';
import { DEFAULT_INFRA_LATENCY_WINDOW_SECONDS } from '../infraMetricsConfig';

describe('infra metrics config', () => {
  test('defaults the latency chart to a six-minute rolling window', () => {
    expect(DEFAULT_INFRA_LATENCY_WINDOW_SECONDS).toBe(360);
  });
});
