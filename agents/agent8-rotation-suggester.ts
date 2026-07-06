// Agent 8 — Rotation Suggester (Steps 11–13 of self-improvement loop).
// Per Phase 3 trigger D:
//   Flag if (30d hit-rate < 33% AND scored_calls ≥ 5) OR
//          (zero BUY signals in last 30 trading days)
// Per Phase 3 candidate rule:
//   Pull from data/candidate-pool.json, exclude current watchlist,
//   exclude tickers in 60-trading-day cooldown.
// Claude ranks the top 3 candidates per flagged ticker with reasoning.

import * as fs from 'fs';
import * as path from 'path';

import { computeTickerHealth, tickersInCooldown } from '../lib/db';
import { callClaude, parseJsonArray } from '../lib/claude';
import type { WatchlistItem } from './agent1-scraper';

const HIT_RATE_FLOOR = 0.33;
const MIN_SCORED_CALLS = 5;
const COOLDOWN_DAYS = 60; // calendar days (cooldown table uses calendar dates)

type FlagReason = 'hit_rate_failure' | 'silent_30d';

export interface RotationSuggestion {
  ticker_out: string;
  reason: FlagReason;
  health_summary: string;
  candidates: Array<{
    ticker: string;
    rationale: string;
  }>;
}

export interface Agent8Result {
  flagged: number;
  suggestions: RotationSuggestion[];
}

function loadCandidatePool(): WatchlistItem[] {
  const p = path.join(__dirname, '..', 'data', 'candidate-pool.json');
  if (!fs.existsSync(p)) {
    console.warn('[Agent8] candidate-pool.json missing — no suggestions possible');
    return [];
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as WatchlistItem[];
}

const SUGGESTER_SYSTEM_PROMPT = `You are a portfolio composition analyst. Given a failing ticker and a pool of candidate replacements, pick the 3 strongest candidates and explain WHY each fits the slot being vacated. Consider sector parity, market cap, momentum profile, and catalyst exposure. Be direct. One sentence rationale per candidate. Return ONLY a JSON array — no preamble, no markdown.`;

function buildSuggesterPrompt(
  flaggedTicker: string,
  reason: FlagReason,
  healthSummary: string,
  candidates: WatchlistItem[],
  currentWatchlist: WatchlistItem[]
): string {
  const flaggedSector = currentWatchlist.find(
    (w) => w.ticker === flaggedTicker
  )?.sector;

  return `Failing ticker: ${flaggedTicker}${flaggedSector ? ` (${flaggedSector})` : ''}
Reason: ${reason === 'hit_rate_failure' ? 'Low hit-rate' : 'No actionable signals in 30+ days'}
Current health: ${healthSummary}

Current watchlist: ${currentWatchlist.map((w) => w.ticker).join(', ')}

Candidate pool (eligible — already filtered for cooldown):
${candidates.map((c) => `  ${c.ticker} — ${c.name} (${c.sector})`).join('\n')}

Pick the 3 best replacements. Return:
[
  { "ticker": "AVGO", "rationale": "One sentence." },
  { "ticker": "TSM",  "rationale": "One sentence." },
  { "ticker": "QCOM", "rationale": "One sentence." }
]`;
}

export async function runAgent8(
  watchlist: WatchlistItem[],
  date: string
): Promise<Agent8Result> {
  const start = Date.now();
  console.log(`[Agent8] Start — checking ${watchlist.length} watchlist tickers`);

  // Health check for each active ticker
  const flagged: Array<{ ticker: string; reason: FlagReason; summary: string }> = [];
  for (const w of watchlist) {
    const h = computeTickerHealth(w.ticker, date);
    const ratePct = (h.hit_rate_30d * 100).toFixed(0);
    const summary = `${h.scored_calls_30d} scored BUYs, ${ratePct}% 30d hit-rate, ${h.buy_signals_last_30d} BUY signals in last 30d`;

    const hitRateFails =
      h.scored_calls_30d >= MIN_SCORED_CALLS &&
      h.hit_rate_30d < HIT_RATE_FLOOR;
    const silent = h.buy_signals_last_30d === 0;

    if (hitRateFails) {
      flagged.push({ ticker: w.ticker, reason: 'hit_rate_failure', summary });
    } else if (silent) {
      // Silent-30d only makes sense for tickers that have been tracked for
      // ≥30 calendar days. Otherwise we'd flag every ticker on day 1 simply
      // because it hasn't accumulated 30 days of history yet.
      if (tickerTrackedAtLeast(w.ticker, date, 30)) {
        flagged.push({ ticker: w.ticker, reason: 'silent_30d', summary });
      }
    }
  }

  if (flagged.length === 0) {
    console.log(`[Agent8] End — 0 flagged (${Date.now() - start}ms)`);
    return { flagged: 0, suggestions: [] };
  }

  // Build candidate pool
  const pool = loadCandidatePool();
  const watchlistSet = new Set(watchlist.map((w) => w.ticker));
  const cooldownSet = tickersInCooldown(COOLDOWN_DAYS, date);
  const eligible = pool.filter(
    (c) => !watchlistSet.has(c.ticker) && !cooldownSet.has(c.ticker)
  );

  if (eligible.length === 0) {
    console.warn('[Agent8] All candidates are watchlist-current or in cooldown');
    return { flagged: flagged.length, suggestions: [] };
  }

  // Ask Claude to pick top 3 per flagged ticker
  const suggestions: RotationSuggestion[] = [];
  for (const f of flagged) {
    try {
      const text = await callClaude({
        systemPrompt: SUGGESTER_SYSTEM_PROMPT,
        userPrompt: buildSuggesterPrompt(
          f.ticker,
          f.reason,
          f.summary,
          eligible,
          watchlist
        ),
        maxTokens: 600,
      });
      const candidates = parseJsonArray<{ ticker: string; rationale: string }>(text);
      suggestions.push({
        ticker_out: f.ticker,
        reason: f.reason,
        health_summary: f.summary,
        candidates: candidates.slice(0, 3),
      });
      // FIX 08 — daily report parses stdout only; surface each suggestion.
      const top = candidates[0];
      console.log(
        `[Agent8] rotate: ${f.ticker} → out (${f.reason}), top candidate: ${
          top ? `${top.ticker} — ${top.rationale}` : 'none'
        }`
      );
    } catch (e) {
      console.error(
        `[Agent8] Claude failed for ${f.ticker}:`,
        (e as Error).message
      );
    }
  }

  console.log(
    `[Agent8] End — ${flagged.length} flagged, ${suggestions.length} suggestion sets (${Date.now() - start}ms)`
  );
  return { flagged: flagged.length, suggestions };
}

// Helper — does this ticker have a call whose call_date is ≥`days` calendar
// days before today? Used to gate the silent-30d flag so brand-new watchlist
// additions aren't flagged on day 1.
function tickerTrackedAtLeast(
  ticker: string,
  todayIso: string,
  days: number
): boolean {
  const { getDb } = require('../lib/db');
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM calls
       WHERE ticker = ? AND call_date <= date(?, '-' || ? || ' days')
       LIMIT 1`
    )
    .get(ticker, todayIso, days);
  return !!row;
}
