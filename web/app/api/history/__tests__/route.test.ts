import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getTemplatesInRange } = vi.hoisted(() => ({ getTemplatesInRange: vi.fn() }));
vi.mock('@/lib/db/mining-notify', () => ({ getTemplatesInRange, MAX_TEMPLATE_RANGE_MS: 2 * 60 * 60 * 1000 }));
import { GET } from '../route';
import { GET as healthz } from '../../healthz/route';

const req = (qs: string) => new Request(`http://x/api/history?${qs}`);

beforeEach(() => getTemplatesInRange.mockReset());

describe('/api/history', () => {
  it.each(['', 'from=1', 'from=a&to=b', 'from=10&to=10', 'from=0&to=7200001'])('rejects %s with 400', async qs => {
    const res = await GET(req(qs));
    expect(res.status).toBe(400);
    expect(getTemplatesInRange).not.toHaveBeenCalled();
  });

  it('returns items for a valid 2 h window', async () => {
    getTemplatesInRange.mockResolvedValueOnce([{ pool_name: 'P', id: 'x' }]);
    const res = await GET(req('from=0&to=7200000'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ pool_name: 'P', id: 'x' }] });
    expect(getTemplatesInRange).toHaveBeenCalledWith(0, 7200000);
  });
});

describe('/api/healthz', () => {
  it('returns ok', async () => {
    expect(await healthz().json()).toEqual({ ok: true });
  });
});
