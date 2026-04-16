// Agent 6 — Call Persister (Step 9 of self-improvement loop).
// Snapshots today's BUY/WATCH/SKIP verdicts plus entry price + SPY price
// into the calls table. Idempotent: re-runs on the same day are no-ops.
//
// Per Phase 3: BUY-only counts toward hit-rate, but we persist all three
// verdicts so future reports / analysis can use the full record.

import { insertCall, callExistsForToday } from '../lib/db';
import { fetchQuoteSnap } from '../lib/prices';
import type { ScoredSignal } from './agent3-signal-scorer';
import type { TickerBrief } from './agent1-scraper';

export interface Agent6Result {
  inserted: number;
  skipped_existing: number;
  spy_price: number | null;
}

function parsePrice(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function runAgent6(
  scored: ScoredSignal[],
  briefs: TickerBrief[],
  date: string
): Promise<Agent6Result> {
  const start = Date.now();
  console.log(`[Agent6] Start — persisting ${scored.length} calls`);

  // SPY snapshot once per run; same value attached to every call today.
  const spy = await fetchQuoteSnap('SPY');
  const spyPrice = spy?.price ?? null;
  if (!spyPrice) {
    console.warn('[Agent6] SPY price unavailable — outcomes will not be scorable');
  }

  let inserted = 0;
  let skipped = 0;

  for (const s of scored) {
    if (callExistsForToday(s.ticker, date)) {
      skipped++;
      continue;
    }
    const brief = briefs.find((b) => b.ticker === s.ticker);
    insertCall({
      call_date: date,
      ticker: s.ticker,
      verdict: s.verdict,
      alpha_score: s.alpha_score,
      confidence: brief?.confidence ?? null,
      reasoning: s.reasoning,
      entry_note: s.entry_note,
      stop_note: s.stop_note,
      entry_price: parsePrice(brief?.price),
      spy_entry_price: spyPrice,
      source: brief?.source ?? 'unknown',
    });
    inserted++;
  }

  console.log(
    `[Agent6] End — inserted ${inserted}, skipped ${skipped}, SPY=${spyPrice ?? '?'} (${Date.now() - start}ms)`
  );
  return { inserted, skipped_existing: skipped, spy_price: spyPrice };
}
