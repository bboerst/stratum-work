import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildLatencyPlot } from '../../utils/latencyPlot';

describe('infra latency legend ordering', () => {
  test('orders pools alphabetically without a configurable sort mode', () => {
    const plot = buildLatencyPlot([
      { id: 'b-late', poolName: 'Pool B', timestampMs: 3_000, latencyMs: 40 },
      { id: 'a-early', poolName: 'Pool A', timestampMs: 1_000, latencyMs: 20 },
    ], {
      timeWindowSeconds: 10,
      newestTimestampMs: 3_000,
    });

    expect(plot.poolNames).toEqual(['Pool A', 'Pool B']);
  });

  test('does not expose legend reordering controls on the Infra page', () => {
    const pageSource = readFileSync(join(process.cwd(), 'app/infra/page.tsx'), 'utf8');
    const controlsSource = readFileSync(join(process.cwd(), 'components/InfraPageControls.tsx'), 'utf8');
    const chartSource = readFileSync(join(process.cwd(), 'components/InfraLatencyChart.tsx'), 'utf8');

    expect(pageSource + controlsSource + chartSource).not.toContain('sortByLatest');
    expect(controlsSource).not.toContain('Legend order');
    expect(controlsSource).not.toContain('Latest');
    expect(controlsSource).not.toContain('A-Z');
  });
});
