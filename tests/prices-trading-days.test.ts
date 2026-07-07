import { describe, it, expect } from 'vitest';
import { isTradingDay, addTradingDays, pctChange } from '../lib/prices';

describe('isTradingDay', () => {
  it('treats weekdays as trading days', () => {
    expect(isTradingDay('2026-07-08')).toBe(true); // Wednesday
  });

  it('treats Saturday and Sunday as non-trading days', () => {
    expect(isTradingDay('2026-07-11')).toBe(false); // Saturday
    expect(isTradingDay('2026-07-12')).toBe(false); // Sunday
  });

  it('treats known US market holidays as non-trading days', () => {
    expect(isTradingDay('2026-07-03')).toBe(false); // Independence Day observed
    expect(isTradingDay('2026-12-25')).toBe(false); // Christmas
  });
});

describe('addTradingDays', () => {
  it('steps forward N trading days, skipping weekends', () => {
    // 2026-07-08 is a Wednesday; +3 trading days -> Mon 2026-07-13
    // (Thu 7/9, Fri 7/10, then skip weekend, Mon 7/13)
    expect(addTradingDays('2026-07-08', 3)).toBe('2026-07-13');
  });

  it('steps forward across a holiday, skipping it', () => {
    // 2026-07-02 (Thu) +1 trading day should skip Fri 7/3 (holiday) and
    // the weekend, landing on Mon 7/6.
    expect(addTradingDays('2026-07-02', 1)).toBe('2026-07-06');
  });

  it('steps backward N trading days', () => {
    expect(addTradingDays('2026-07-13', -3)).toBe('2026-07-08');
  });
});

describe('pctChange', () => {
  it('computes positive percentage change', () => {
    expect(pctChange(100, 110)).toBeCloseTo(10);
  });

  it('computes negative percentage change', () => {
    expect(pctChange(100, 90)).toBeCloseTo(-10);
  });

  it('returns 0 when the base is 0 (avoids divide-by-zero)', () => {
    expect(pctChange(0, 50)).toBe(0);
  });
});
