import { describe, it, expect } from 'vitest';
import { enforceTiers } from '../agents/agent4-allocator';
import type { AllocationItem } from '../agents/agent4-allocator';
import type { ScoredSignal } from '../agents/agent3-signal-scorer';

function scoredSignal(
  ticker: string,
  verdict: ScoredSignal['verdict'],
  alpha_score: number
): ScoredSignal {
  return {
    ticker,
    verdict,
    alpha_score,
    reasoning: 'test',
    time_horizon: '30d',
    entry_note: 'entry',
    stop_note: 'stop',
  };
}

function allocRow(ticker: string, tier: number, position_pct: number): AllocationItem {
  return { ticker, tier, position_pct, entry_note: 'e', stop_loss_note: 's' };
}

describe('enforceTiers', () => {
  it('sizes Tier 1 BUY (alpha >= 8.0) at 5% regardless of model drift', () => {
    const scored = [scoredSignal('NVDA', 'BUY', 9.1)];
    const alloc = [allocRow('NVDA', 1, 10)]; // model tried to size at 10%
    const result = enforceTiers(alloc, scored);
    expect(result).toEqual([expect.objectContaining({ ticker: 'NVDA', tier: 1, position_pct: 5 })]);
  });

  it('sizes Tier 2 BUY (6.0 <= alpha < 8.0) at 3%', () => {
    const scored = [scoredSignal('AMD', 'BUY', 6.5)];
    const alloc = [allocRow('AMD', 2, 7)];
    const result = enforceTiers(alloc, scored);
    expect(result[0].position_pct).toBe(3);
  });

  it('sizes WATCH at Tier 3 / 1.5% even if the model omits or mis-tiers it', () => {
    const scored = [scoredSignal('GOOGL', 'WATCH', 6.5)];
    const alloc = [allocRow('GOOGL', 99, 5)];
    const result = enforceTiers(alloc, scored);
    expect(result[0]).toEqual(expect.objectContaining({ tier: 3, position_pct: 1.5 }));
  });

  it('drops BUY rows with alpha_score below 6.0 (no tier exists for them)', () => {
    const scored = [scoredSignal('WEAK', 'BUY', 4.0)];
    const alloc = [allocRow('WEAK', 3, 1.5)];
    expect(enforceTiers(alloc, scored)).toEqual([]);
  });

  it('drops SKIP verdicts even if present in the allocation array', () => {
    const scored = [scoredSignal('SKIP1', 'SKIP', 2)];
    const alloc = [allocRow('SKIP1', 1, 5)];
    expect(enforceTiers(alloc, scored)).toEqual([]);
  });

  it('drops allocation rows with no matching scored signal', () => {
    const scored: ScoredSignal[] = [];
    const alloc = [allocRow('GHOST', 1, 5)];
    expect(enforceTiers(alloc, scored)).toEqual([]);
  });
});
