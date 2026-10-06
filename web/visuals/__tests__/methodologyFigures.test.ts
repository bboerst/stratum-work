import { describe, expect, it } from 'vitest';
import { formatFigures, rawDataLinks } from '../methodologyFigures';

describe('rawDataLinks', () => {
  it('builds /templates and /stream links from the configured endpoints', () => {
    expect(rawDataLinks({ streamEndpoint: 'https://s.example/', templatesEndpoint: 'https://t.example/' }, 1_000_000)).toEqual({
      templates: 'https://t.example/templates?since=1000000',
      stream: 'https://s.example/stream',
    });
  });
  it('omits templates when no templates endpoint is configured', () => {
    expect(rawDataLinks({ streamEndpoint: 'https://s.example', templatesEndpoint: '' }, 5)).toEqual({ templates: null, stream: 'https://s.example/stream' });
  });
  it('returns nulls when config is missing', () => {
    expect(rawDataLinks({}, 5)).toEqual({ templates: null, stream: null });
  });
});

describe('formatFigures', () => {
  it('formats K and the effective number', () => {
    expect(formatFigures({ k: 3, effectiveNumber: 5.678 })).toEqual({ k: '3', effectiveNumber: '5.7' });
  });
  it('shows unavailable when the summary is null', () => {
    expect(formatFigures(null)).toEqual({ k: 'unavailable', effectiveNumber: 'unavailable' });
  });
});
