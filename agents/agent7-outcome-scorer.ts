// Agent 7 — Outcome Scorer (Step 10 of self-improvement loop).
// For each call of ANY verdict (BUY, WATCH, SKIP) whose 5d/15d/30d window has
// matured, computes the return against SPY. Scoring every verdict is what
// gives BUY a baseline: the filter only earns its keep if BUY beats SKIP.
//
// Price basis is end-of-day on both ends, from one source:
//   entry = close on call_date (the first full print after the pre-market call)
//   exit  = close N trading days later
// The brief's own price string is not used. It is a pre-market figure from
// the news source and was the cause of mismatched entry/exit bases.
//
// Hit thresholds (excess vs SPY), same math for every verdict:
//   5d  > 0.0%
//   15d > 1.0%
//   30d > 3.0%

import { pendingScoresForWindow, insertOutcome, setEntryCloses } from '../lib/db';
import { fetchDailyHistory, type Bar } from '../lib/marketdata';
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

// Max calendar days a prior close may stand in for a missing bar (weekend +
// holiday). Anything older is a data gap, not a price.
export const MAX_CLOSE_GAP_DAYS = 7;

// Pure — the close on isoDate, else the nearest earlier close within
// MAX_CLOSE_GAP_DAYS, else null. Never reaches forward: a later bar would
// leak the future into the entry.
export function closeOnOrBefore(bars: Bar[], isoDate: string): number | null {
  let best: Bar | null = null;
  for (const b of bars) {
    if (b.date === isoDate) return b.close;
    if (b.date < isoDate && (!best || b.date > best.date)) best = b;
  }
  if (!best) return null;
  const gapDays =
    (Date.parse(isoDate + 'T00:00:00Z') - Date.parse(best.date + 'T00:00:00Z')) / 86_400_000;
  return gapDays <= MAX_CLOSE_GAP_DAYS ? best.close : null;
}

// One history request per symbol per run, instead of one request per
// (symbol, date). A full backfill is ~60 requests rather than thousands.
const historyCache = new Map<string, Promise<Bar[] | null>>();

async function eodClose(ticker: string, isoDate: string): Promise<number | null> {
  if (!historyCache.has(ticker)) historyCache.set(ticker, fetchDailyHistory(ticker, '1y'));
  const bars = await historyCache.get(ticker)!;
  // Only trust the history when it reaches the date; otherwise the "nearest
  // earlier close" would be a stale last bar.
  if (bars && bars[bars.length - 1].date >= isoDate) {
    const close = closeOnOrBefore(bars, isoDate);
    if (close != null) return close;
  }
  return fetchEodPriceOn(ticker, isoDate);
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
  historyCache.clear();

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

      // The exit close must already be printed. A pre-market run on the exit
      // date itself would silently pick up the prior day's close.
      if (exitDate >= date) continue;

      let entryClose = p.entry_close;
      let spyEntryClose = p.spy_entry_close;
      if (entryClose == null || spyEntryClose == null) {
        [entryClose, spyEntryClose] = await Promise.all([
          eodClose(p.ticker, p.call_date),
          eodClose('SPY', p.call_date),
        ]);
        if (entryClose != null && spyEntryClose != null) {
          setEntryCloses(p.call_id, entryClose, spyEntryClose);
        }
      }

      const [tickerExit, spyExit] = await Promise.all([
        eodClose(p.ticker, exitDate),
        eodClose('SPY', exitDate),
      ]);

      // Null means every source missed. Leave the call unscored and retry on
      // the next run rather than score it from a guess.
      if (entryClose == null || spyEntryClose == null || tickerExit == null || spyExit == null) {
        result.failed_lookups++;
        console.warn(
          `[Agent7] ${p.ticker} ${p.call_date} ${window}d: missing EOD close (entry=${entryClose}, spyEntry=${spyEntryClose}, exit=${tickerExit}, spyExit=${spyExit}) — will retry next run`
        );
        continue;
      }

      const outcome = computeOutcome(
        entryClose,
        tickerExit,
        spyEntryClose,
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
