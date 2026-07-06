// Repeat-suppression — stops the same flat megacaps (MSFT/GOOGL/JPM…) from
// cluttering the briefing day after day. Tracks a per-ticker "quiet streak":
// consecutive runs where the name came back neutral + low-confidence. Once the
// streak crosses QUIET_SUPPRESS_DAYS the name is demoted to a collapsed "quiet"
// line in the email instead of the main sections. Any real signal (non-neutral
// OR confidence ≥ threshold) resets the streak to 0 and the name resurfaces.

import * as fs from 'fs';
import * as path from 'path';

import { THRESHOLDS } from '../config/thresholds';
import type { TickerBrief } from './scraper';

const STATE_PATH = path.join(__dirname, '..', 'data', 'suppression-state.json');

interface QuietEntry {
  quiet_streak: number;
  last_updated: string;
}
type SuppressionState = Record<string, QuietEntry>;

function loadState(): SuppressionState {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as SuppressionState;
  } catch {
    return {};
  }
}

function saveState(state: SuppressionState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function isQuiet(brief: TickerBrief): boolean {
  return (
    brief.signal === 'neutral' &&
    brief.confidence < THRESHOLDS.LOW_CONFIDENCE_THRESHOLD
  );
}

export interface SuppressionResult {
  // Tickers whose quiet streak has crossed the threshold — hide from main email.
  suppressed: string[];
  // Streak counts for the tickers evaluated this run (for the report).
  streaks: Record<string, number>;
}

// Update streaks from today's briefs and return which tickers are suppressed.
// `coreTickers` limits suppression to the fixed core — momentum-sleeve names are
// inherently "active" and never suppressed.
export function updateSuppression(
  briefs: TickerBrief[],
  coreTickers: Set<string>,
  date: string
): SuppressionResult {
  const state = loadState();
  const suppressed: string[] = [];
  const streaks: Record<string, number> = {};

  for (const brief of briefs) {
    if (!coreTickers.has(brief.ticker)) continue; // core-only

    const prev = state[brief.ticker]?.quiet_streak ?? 0;
    const next = isQuiet(brief) ? prev + 1 : 0;
    state[brief.ticker] = { quiet_streak: next, last_updated: date };
    streaks[brief.ticker] = next;

    if (next >= THRESHOLDS.QUIET_SUPPRESS_DAYS) suppressed.push(brief.ticker);
  }

  saveState(state);
  return { suppressed, streaks };
}
