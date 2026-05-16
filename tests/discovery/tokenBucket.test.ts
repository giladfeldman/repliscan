import { describe, it, expect } from '@jest/globals';
import { TokenBucket } from '../../src/discovery/engine/sources/tokenBucket.js';

describe('TokenBucket', () => {
  it('grants burst tokens immediately', async () => {
    const b = new TokenBucket({ ratePerSec: 1, burst: 5 });
    const start = Date.now();
    await Promise.all([b.take(), b.take(), b.take(), b.take(), b.take()]);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('rate-limits beyond burst', async () => {
    const b = new TokenBucket({ ratePerSec: 10, burst: 2 });
    const start = Date.now();
    await b.take();
    await b.take();
    await b.take();
    await b.take();
    // 2 free, 2 throttled at 10/sec → expect ~200ms minimum (allow 100ms slack)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it('setRate adjusts subsequent throttling', async () => {
    const b = new TokenBucket({ ratePerSec: 100, burst: 1 });
    await b.take();           // consume initial token
    b.setRate(2);             // 0.5s/token
    const start = Date.now();
    await b.take();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  it('rejects non-positive rate or burst', () => {
    expect(() => new TokenBucket({ ratePerSec: 0, burst: 1 })).toThrow();
    expect(() => new TokenBucket({ ratePerSec: -1, burst: 1 })).toThrow();
    expect(() => new TokenBucket({ ratePerSec: 1, burst: 0 })).toThrow();
  });

  it('getRate reflects current rate', () => {
    const b = new TokenBucket({ ratePerSec: 5, burst: 1 });
    expect(b.getRate()).toBe(5);
    b.setRate(2);
    expect(b.getRate()).toBe(2);
  });

  it('setRate ignores non-positive values', () => {
    const b = new TokenBucket({ ratePerSec: 5, burst: 1 });
    b.setRate(0);
    expect(b.getRate()).toBe(5);
    b.setRate(-3);
    expect(b.getRate()).toBe(5);
  });
});
