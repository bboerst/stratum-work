import { NextResponse } from 'next/server';
import { getTemplatesInRange, MAX_TEMPLATE_RANGE_MS } from '@/lib/db/mining-notify';
import { filterBlacklistedItems } from '@/lib/poolBlacklist';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const from = Number(u.searchParams.get('from'));
  const to = Number(u.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_TEMPLATE_RANGE_MS) {
    return NextResponse.json({ error: 'from/to must be ms timestamps spanning at most 2 hours' }, { status: 400 });
  }
  try {
    const items = filterBlacklistedItems(await getTemplatesInRange(from, to), d => d.pool_name);
    return NextResponse.json({ items });
  } catch (error: Error | unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
