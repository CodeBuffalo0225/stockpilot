import { describe, it, expect } from 'vitest';
import { computeOutcome, HIT_THRESHOLD } from '../agents/agent7-outcome-scorer';

describe('computeOutcome (5d/15d/30d hit-rate math)', () => {
  it('is a hit when excess return exceeds the window threshold', () => {
    // ticker +5%, SPY +1% -> excess +4%, well above every window's floor.
    const r = computeOutcome(100, 105, 100, 101, 5);
    expect(r.ticker_return_pct).toBeCloseTo(5);
    expect(r.spy_return_pct).toBeCloseTo(1);
    expect(r.excess_return_pct).toBeCloseTo(4);
    expect(r.hit).toBe(1);
  });

  it('is not a hit when excess return is exactly at the threshold (strict >)', () => {
    // 15d threshold is 1.0% — excess of exactly 1.0% must NOT count as a hit.
    const r = computeOutcome(100, 102, 100, 101, 15);
    expect(r.excess_return_pct).toBeCloseTo(1.0);
    expect(r.hit).toBe(0);
  });

  it('is not a hit when the ticker merely tracks or trails SPY', () => {
    const r = computeOutcome(100, 103, 100, 103, 30);
    expect(r.excess_return_pct).toBeCloseTo(0);
    expect(r.hit).toBe(0);
  });

  it('30d requires a bigger excess (3.0%) than 5d (0.0%) to count as a hit', () => {
    // +2% excess: hits the 5d floor but not the 30d floor.
    const fiveDay = computeOutcome(100, 102, 100, 100, 5);
    const thirtyDay = computeOutcome(100, 102, 100, 100, 30);
    expect(fiveDay.hit).toBe(1);
    expect(thirtyDay.hit).toBe(0);
  });

  it('HIT_THRESHOLD is monotonically increasing across windows', () => {
    expect(HIT_THRESHOLD[5]).toBeLessThan(HIT_THRESHOLD[15]);
    expect(HIT_THRESHOLD[15]).toBeLessThan(HIT_THRESHOLD[30]);
  });
});
