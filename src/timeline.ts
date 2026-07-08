/**
 * Timeline: minute-bucket ring buffer for activity chart.
 *
 * Fixed-size ring buffer (1440 entries = 24 hours of per-minute data).
 * Memory: ~280 KB worst case. Resets on gateway restart.
 */

import { MinuteBucket } from './types';

const RING_SIZE = 1440; // 24 hours of minute-level data

/** Ring buffer of minute buckets */
const ring: MinuteBucket[] = [];

/** Floor a timestamp to the nearest minute boundary */
function floorToMinute(ts: number): number {
  return Math.floor(ts / 60000) * 60000;
}

/** Find or create a bucket for the current minute */
function getOrCreateBucket(now: number): MinuteBucket {
  const minuteTs = floorToMinute(now);

  // Check if the last bucket is for this minute
  if (ring.length > 0 && ring[ring.length - 1].minuteTs === minuteTs) {
    return ring[ring.length - 1];
  }

  // Create new bucket
  const bucket: MinuteBucket = {
    minuteTs,
    requests: 0,
    errors: 0,
    totalMs: 0,
    perServer: {},
  };

  ring.push(bucket);

  // Trim ring to max size
  while (ring.length > RING_SIZE) {
    ring.shift();
  }

  return bucket;
}

/** Record a timeline event (called from recordToolCall in server.ts) */
export function recordTimelineEvent(
  serverName: string,
  elapsedMs: number,
  isError: boolean,
): void {
  const bucket = getOrCreateBucket(Date.now());
  bucket.requests++;
  if (isError) bucket.errors++;
  bucket.totalMs += elapsedMs;
  bucket.perServer[serverName] = (bucket.perServer[serverName] ?? 0) + 1;
}

/**
 * Get the last N minutes of timeline data, zero-filling gaps.
 * Returns exactly `minutes` entries, oldest first.
 */
export function getTimeline(minutes: number): MinuteBucket[] {
  const now = Date.now();
  const endMinute = floorToMinute(now);
  const startMinute = endMinute - (minutes - 1) * 60000;

  // Build a map of existing buckets for O(1) lookup
  const bucketMap = new Map<number, MinuteBucket>();
  for (const bucket of ring) {
    bucketMap.set(bucket.minuteTs, bucket);
  }

  // Generate the full timeline with zero-filled gaps
  const result: MinuteBucket[] = [];
  for (let ts = startMinute; ts <= endMinute; ts += 60000) {
    const existing = bucketMap.get(ts);
    if (existing) {
      result.push(existing);
    } else {
      result.push({
        minuteTs: ts,
        requests: 0,
        errors: 0,
        totalMs: 0,
        perServer: {},
      });
    }
  }

  return result;
}
