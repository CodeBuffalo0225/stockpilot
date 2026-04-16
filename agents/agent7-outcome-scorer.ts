// Agent 7 — Outcome Scorer (Step 10 of self-improvement loop).
// For each BUY call whose 5d/15d/30d window has matured and is unscored,
// fetches the ticker + SPY EOD prices N trading days after call_date and
// computes excess return. Hits use the captured Phase 3 thresholds.
//
// Hit thresholds (excess vs SPY):
//   5d  > 0.0%
//   15d > 1.0%
//   30d > 3.0%

import { pendingScoresForWindow, insertOutcome } from '../lib/db';
import { addTradingDays, fetchEodPriceOn, pctChange } from '../lib/prices';

export const WINDOWS = [5, 15, 30] as const;

const HIT_THRESHOLD: Record<number, number> = {
  5: 0.0,
  15: 1.0,
  30: 3.0,
};

export interface Agent7Result {
  scored_5d: number;
  scored_15d: number;
  scored_30d: number;
  failed_lookups: number;
}

export async function runAgent7(date: string): Promise<Agent7Result> {
  const start = Date.now();
  console.log(`[Agent7] Start — scoring matured outcomes`);

  const result: Agent7Result = {
    scored_5d: 0,
    scored_15d: 0,
    scored_30d: 0,
    failed_lookups: 0,
  };

  for (const window of WINDOWS) {
    const pending = pendingScoresForWindow(window, date);
    if (pending.length === 0) continue;
    console.log(`[Agent7] ${window}d window: ${pending.length} pending`);

    for (const p of pending) {
      const exitDate = addTradingDays(p.call_date, window);

      // Defensive — shouldn't happen because the SQL filter requires
      // exitDate <= today, but guard anyway.
      if (exitDate > date) continue;

      const [tickerExit, spyExit] = await Promise.all([
        fetchEodPriceOn(p.ticker, exitDate),
        fetchEodPriceOn('SPY', exitDate),
      ]);

      if (tickerExit == null || spyExit == null) {
        result.failed_lookups++;
        console.warn(
          `[Agent7] ${p.ticker} ${window}d: missing EOD (ticker=${tickerExit}, spy=${spyExit}) — will retry next run`
        );
        continue;
      }

      const tickerRet = pctChange(p.entry_price, tickerExit);
      const spyRet = pctChange(p.spy_entry_price, spyExit);
      const excess = tickerRet - spyRet;
      const hit = excess > HIT_THRESHOLD[window] ? 1 : 0;

      insertOutcome({
        call_id: p.call_id,
        window_days: window as 5 | 15 | 30,
        scored_date: date,
        ticker_return_pct: tickerRet,
        spy_return_pct: spyRet,
        excess_return_pct: excess,
        hit: hit as 0 | 1,
      });

      if (window === 5) result.scored_5d++;
      else if (window === 15) result.scored_15d++;
      else if (window === 30) result.scored_30d++;
    }
  }

  console.log(
    `[Agent7] End — scored 5d=${result.scored_5d} 15d=${result.scored_15d} 30d=${result.scored_30d}, failed=${result.failed_lookups} (${Date.now() - start}ms)`
  );
  return result;
}
