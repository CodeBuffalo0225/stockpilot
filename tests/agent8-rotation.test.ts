import { describe, it, expect } from 'vitest';
import { evaluateTickerHealth, HIT_RATE_FLOOR, MIN_SCORED_CALLS } from '../agents/agent8-rotation-suggester';
import type { TickerHealth } from '../lib/db';

function health(overrides: Partial<TickerHealth>): TickerHealth {
  return {
    ticker: 'TEST',
    scored_calls_30d: 0,
    hit_rate_30d: 0,
    buy_signals_last_30d: 0,
    ...overrides,
  };
}

describe('evaluateTickerHealth (rotation trigger — Phase 3 trigger D)', () => {
  it('flags hit_rate_failure when hit rate is below the floor with enough sample size', () => {
    const h = health({ scored_calls_30d: MIN_SCORED_CALLS, hit_rate_30d: HIT_RATE_FLOOR - 0.01 });
    expect(evaluateTickerHealth(h, false)).toBe('hit_rate_failure');
  });

  it('does not flag a low hit rate when sample size is below MIN_SCORED_CALLS', () => {
    const h = health({ scored_calls_30d: MIN_SCORED_CALLS - 1, hit_rate_30d: 0 });
    expect(evaluateTickerHealth(h, false)).toBeNull();
  });

  it('does not flag a hit rate exactly at the floor', () => {
    const h = health({ scored_calls_30d: MIN_SCORED_CALLS, hit_rate_30d: HIT_RATE_FLOOR });
    expect(evaluateTickerHealth(h, false)).toBeNull();
  });

  it('flags silent_30d when there have been zero BUY signals and the ticker has 30+ days of history', () => {
    const h = health({ buy_signals_last_30d: 0, hit_rate_30d: 1, scored_calls_30d: 0 });
    expect(evaluateTickerHealth(h, true)).toBe('silent_30d');
  });

  it('does NOT flag silent_30d for a brand-new ticker with less than 30 days of history', () => {
    const h = health({ buy_signals_last_30d: 0 });
    expect(evaluateTickerHealth(h, false)).toBeNull();
  });

  it('does not flag a healthy, active ticker', () => {
    const h = health({ scored_calls_30d: 10, hit_rate_30d: 0.6, buy_signals_last_30d: 2 });
    expect(evaluateTickerHealth(h, true)).toBeNull();
  });

  it('hit_rate_failure takes priority over silent_30d when both could apply', () => {
    const h = health({ scored_calls_30d: MIN_SCORED_CALLS, hit_rate_30d: 0, buy_signals_last_30d: 0 });
    expect(evaluateTickerHealth(h, true)).toBe('hit_rate_failure');
  });
});
