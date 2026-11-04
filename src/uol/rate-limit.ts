export interface Limit {
  requests: number;
  windowMs: number;
}

/**
 * UOL limits: `/v1/receivables` 10 requests / 10 s, every other `/v1/*` path
 * 30 / 10 s; exceeding either locks the user out for 30 s. We stay a little
 * below both so that other clients of the same user (the web, a mobile app)
 * still have headroom.
 */
export const UOL_LIMITS = {
  general: { requests: 25, windowMs: 10_500 },
  receivables: { requests: 8, windowMs: 10_500 },
} satisfies Record<string, Limit>;

export type Bucket = keyof typeof UOL_LIMITS;

export function bucketFor(path: string): Bucket {
  return path.startsWith('/v1/receivables') ? 'receivables' : 'general';
}

interface BucketState {
  limit: Limit;
  stamps: number[];
  tail: Promise<void>;
}

/** Sliding-window limiter; callers are served in FIFO order per bucket. */
export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(
    private readonly limits: Record<string, Limit> = UOL_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  acquire(bucket: string): Promise<void> {
    const state = this.state(bucket);
    const turn = state.tail.then(() => this.take(state));
    state.tail = turn.catch(() => undefined);
    return turn;
  }

  private async take(state: BucketState): Promise<void> {
    for (;;) {
      const now = this.now();
      state.stamps = state.stamps.filter((t) => now - t < state.limit.windowMs);
      if (state.stamps.length < state.limit.requests) {
        state.stamps.push(now);
        return;
      }
      const oldest = state.stamps[0] ?? now;
      await this.sleep(oldest + state.limit.windowMs - now);
    }
  }

  private state(bucket: string): BucketState {
    let state = this.buckets.get(bucket);
    if (!state) {
      const limit = this.limits[bucket];
      if (!limit) throw new Error(`Unknown rate-limit bucket: ${bucket}`);
      state = { limit, stamps: [], tail: Promise.resolve() };
      this.buckets.set(bucket, state);
    }
    return state;
  }
}
