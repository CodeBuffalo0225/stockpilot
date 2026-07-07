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
import {
  addTradingDays,
  fetchEodPriceOn,
  getEodFetchStats,
  pctChange,
  resetEodFetchStats,
} from '../lib/prices';

export const WINDOWS = [5, 15, 30] as const;

export const HIT_THRESHOLD: Record<number, number> = {
  5: 0.0,
  15: 1.0,
  30: 3.0,
};

export interface OutcomeComputation {
  ticker_return_pct: number;
  spy_return_pct: number;
  excess_return_pct: number;
  hit: 0 | 1;
}

// Pure — no I/O. Isolated so the hit-rate math (the actual money rule) can
// be unit tested without mocking price fetches or SQLite.
export function computeOutcome(
  entryPrice: number,
  exitPrice: number,
  spyEntryPrice: number,
  spyExitPrice: number,
  windowDays: 5 | 15 | 30
): OutcomeComputation {
  const tickerRet = pctChange(entryPrice, exitPrice);
  const spyRet = pctChange(spyEntryPrice, spyExitPrice);
  const excess = tickerRet - spyRet;
  const hit = excess > HIT_THRESHOLD[windowDays] ? 1 : 0;
  return {
    ticker_return_pct: tickerRet,
    spy_return_pct: spyRet,
    excess_return_pct: excess,
    hit: hit as 0 | 1,
  };
}

export interface Agent7Result {
  scored_5d: number;
  scored_15d: number;
  scored_30d: number;
  failed_lookups: number;
}

export async function runAgent7(date: string): Promise<Agent7Result> {
  const start = Date.now();
  console.log(`[Agent7] Start — scoring matured outcomes`);
  resetEodFetchStats();

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

      // fetchEodPriceOn falls back to Yahoo internally, so null here means
      // BOTH sources missed — the only case worth a per-ticker warning.
      if (tickerExit == null || spyExit == null) {
        result.failed_lookups++;
        console.warn(
          `[Agent7] ${p.ticker} ${window}d: missing EOD from both FMP and Yahoo (ticker=${tickerExit}, spy=${spyExit}) — will retry next run`
        );
        continue;
      }

      const outcome = computeOutcome(
        p.entry_price,
        tickerExit,
        p.spy_entry_price,
        spyExit,
        window as 5 | 15 | 30
      );

      insertOutcome({
        call_id: p.call_id,
        window_days: window as 5 | 15 | 30,
        scored_date: date,
        ...outcome,
      });

      if (window === 5) result.scored_5d++;
      else if (window === 15) result.scored_15d++;
      else if (window === 30) result.scored_30d++;
    }
  }

  // One aggregate line for source health instead of a per-ticker wall.
  const eod = getEodFetchStats();
  if (eod.fmp_failed > 0) {
    console.log(
      `[Agent7] FMP missed ${eod.fmp_failed} lookups across ${eod.fmp_failed_symbols.length} symbols` +
        (eod.fmp_last_status != null ? ` (last HTTP ${eod.fmp_last_status})` : '') +
        `; Yahoo fallback served ${eod.yahoo_fallback}, both failed ${eod.both_failed}`
    );
  }

  console.log(
    `[Agent7] End — scored 5d=${result.scored_5d} 15d=${result.scored_15d} 30d=${result.scored_30d}, failed=${result.failed_lookups} (${Date.now() - start}ms)`
  );
  return result;
}
