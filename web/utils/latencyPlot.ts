type LatencyMessage = {
  pool_name?: string;
  timestamp?: string;
  lat_ms?: number | null;
  lat_m?: string;
};

export type LatencySample = {
  id: string;
  poolName: string;
  timestampMs: number;
  latencyMs: number;
  method?: string;
};

export type LatencyPlot = {
  samples: LatencySample[];
  poolNames: string[];
  timeDomainMs: [number, number];
  latencyDomainMs: [number, number];
  maxLatencyMs: number;
};

const HEX_TIMESTAMP_RE = /^(0[xX])?[0-9a-fA-F]+$/;

export function timestampToMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;

  if (HEX_TIMESTAMP_RE.test(timestamp)) {
    try {
      const cleaned = timestamp.replace(/^0[xX]/, '');
      const ns = BigInt('0x' + cleaned);
      return Number(ns / BigInt(1_000_000));
    } catch {
      return null;
    }
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function latencySampleFromMessage(message: LatencyMessage): LatencySample | null {
  const poolName = message.pool_name?.trim();
  const latencyMs = message.lat_ms;
  const timestampMs = timestampToMs(message.timestamp);

  if (!poolName || timestampMs == null) return null;
  if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs <= 0) return null;

  return {
    id: `${poolName}-${message.timestamp}-${latencyMs}`,
    poolName,
    timestampMs,
    latencyMs,
    method: message.lat_m,
  };
}

export function pruneLatencySamples(
  samples: LatencySample[],
  newestTimestampMs: number,
  timeWindowSeconds: number
): LatencySample[] {
  const cutoffMs = newestTimestampMs - timeWindowSeconds * 1000;
  return samples.filter(sample => sample.timestampMs >= cutoffMs);
}

export function latencyColorIntensity(latencyMs: number, maxLatencyMs: number): number {
  if (!Number.isFinite(latencyMs) || !Number.isFinite(maxLatencyMs) || maxLatencyMs <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, latencyMs / maxLatencyMs));
}

export function headerLegendStartX(
  statItems: Array<{ x: number; width: number }>,
  padding: number
): number {
  const statsRightEdge = statItems.reduce(
    (rightEdge, item) => Math.max(rightEdge, item.x + item.width),
    0
  );
  return statsRightEdge + padding;
}

export function buildLatencyPlot(
  samples: LatencySample[],
  options: {
    timeWindowSeconds: number;
    newestTimestampMs?: number;
  }
): LatencyPlot {
  const newestTimestampMs = options.newestTimestampMs ?? Math.max(...samples.map(sample => sample.timestampMs), Date.now());
  const visibleSamples = pruneLatencySamples(samples, newestTimestampMs, options.timeWindowSeconds)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const poolNamesSeen = new Set<string>();
  let maxLatencyMs = 0;

  visibleSamples.forEach(sample => {
    poolNamesSeen.add(sample.poolName);
    maxLatencyMs = Math.max(maxLatencyMs, sample.latencyMs);
  });

  const poolNames = Array.from(poolNamesSeen).sort((a, b) => a.localeCompare(b));

  return {
    samples: visibleSamples,
    poolNames,
    timeDomainMs: [newestTimestampMs - options.timeWindowSeconds * 1000, newestTimestampMs],
    latencyDomainMs: [0, Math.max(1, maxLatencyMs * 1.2)],
    maxLatencyMs,
  };
}
