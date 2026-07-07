import { describe, it, expect } from 'vitest';
import { enforceBuyCap } from '../agents/agent3-signal-scorer';
import type { ScoredSignal } from '../agents/agent3-signal-scorer';

function signal(ticker: string, verdict: ScoredSignal['verdict'], alpha_score: number): ScoredSignal {
  return {
    ticker,
    verdict,
    alpha_score,
    reasoning: 'test',
    time_horizon: '30d',
    entry_note: 'test',
    stop_note: 'test',
  };
}

describe('enforceBuyCap', () => {
  it('leaves output untouched when BUY count is at or under the cap', () => {
    const scored = [signal('A', 'BUY', 9), signal('B', 'BUY', 8), signal('C', 'WATCH', 5)];
    expect(enforceBuyCap(scored)).toEqual(scored);
  });

  it('downgrades excess BUYs to WATCH, keeping the highest alpha_score BUYs', () => {
    const scored = [
      signal('LOW', 'BUY', 6),
      signal('HIGH', 'BUY', 9),
      signal('MID', 'BUY', 7.5),
      signal('EXTRA', 'BUY', 8.2),
    ];
    const result = enforceBuyCap(scored);
    const buys = result.filter((s) => s.verdict === 'BUY').map((s) => s.ticker).sort();
    expect(buys).toEqual(['EXTRA', 'HIGH', 'MID'].sort());
    expect(result.find((s) => s.ticker === 'LOW')?.verdict).toBe('WATCH');
  });

  it('never produces more than 3 BUYs regardless of input size', () => {
    const scored = Array.from({ length: 20 }, (_, i) => signal(`T${i}`, 'BUY', i));
    const result = enforceBuyCap(scored);
    expect(result.filter((s) => s.verdict === 'BUY')).toHaveLength(3);
  });

  it('does not touch SKIP verdicts', () => {
    const scored = [
      signal('A', 'BUY', 9),
      signal('B', 'BUY', 8),
      signal('C', 'BUY', 7),
      signal('D', 'BUY', 6),
      signal('E', 'SKIP', 1),
    ];
    const result = enforceBuyCap(scored);
    expect(result.find((s) => s.ticker === 'E')?.verdict).toBe('SKIP');
  });
});
