import { describe, it, expect } from 'vitest';
import {
  closeOnOrBefore,
  computeOutcome,
  HIT_THRESHOLD,
  MAX_CLOSE_GAP_DAYS,
} from '../agents/agent7-outcome-scorer';

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

describe('closeOnOrBefore (EOD price lookup)', () => {
  const bar = (date: string, close: number) => ({ date, close, high: close, low: close, volume: 0 });
  // Fri 11-06, then Mon 11-09 .. Tue 11-10. 11-07/11-08 are the weekend.
  const bars = [bar('2026-11-05', 98), bar('2026-11-06', 100), bar('2026-11-09', 103), bar('2026-11-10', 104)];

  it('returns the exact close when the date has a bar', () => {
    expect(closeOnOrBefore(bars, '2026-11-09')).toBe(103);
  });

  it('falls back to the nearest earlier close across a weekend', () => {
    expect(closeOnOrBefore(bars, '2026-11-08')).toBe(100);
  });

  it('never reaches forward for a later bar', () => {
    // Asking for a date before the first bar must not return the 11-05 close.
    expect(closeOnOrBefore(bars, '2026-11-04')).toBeNull();
  });

  it('returns null when the nearest earlier close is older than the gap limit', () => {
    const late = new Date(Date.parse('2026-11-10T00:00:00Z') + (MAX_CLOSE_GAP_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(closeOnOrBefore(bars, late)).toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(closeOnOrBefore([], '2026-11-09')).toBeNull();
  });
});
