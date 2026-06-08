/**
 * TokenBucket — simple monotonic-clock rate limiter.
 *
 * Each source adapter holds one bucket. Every API call awaits `take()`,
 * which sleeps just long enough for a token to be available based on the
 * configured rate. After a 429, callers can `setRate()` lower defensively.
 *
 * Spec: docs/superpowers/specs/2026-05-04-replication-discovery-design.md §4.5
 */

export interface TokenBucketOptions {
  /** Tokens per second (e.g. 5 for OpenAlex's 50%-safety budget under 10/sec). */
  ratePerSec: number;
  /** Burst capacity — how many tokens accrue while idle. */
  burst: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private rate: number;
  private capacity: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.ratePerSec <= 0) {
      throw new Error(`TokenBucket: ratePerSec must be > 0 (got ${opts.ratePerSec})`);
    }
    if (opts.burst <= 0) {
      throw new Error(`TokenBucket: burst must be > 0 (got ${opts.burst})`);
    }
    this.rate = opts.ratePerSec;
    this.capacity = opts.burst;
    this.tokens = opts.burst;
    this.lastRefill = Date.now();
  }

  /** Adjust rate at runtime (e.g. halve after a 429 to back off). */
  setRate(ratePerSec: number): void {
    if (ratePerSec <= 0) return;
    this.rate = ratePerSec;
  }

  /** Read-only access to the current rate (for diagnostics). */
  getRate(): number {
    return this.rate;
  }

  /** Wait until at least one token is available, then consume it. */
  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, ((1 - this.tokens) / this.rate) * 1000);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, 1000));
        // Don't let a pending backoff timer keep the host process (or a Jest run)
        // alive at shutdown; the await still resolves on schedule while running (D7).
        (timer as { unref?: () => void }).unref?.();
      });
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
    this.lastRefill = now;
  }
}
