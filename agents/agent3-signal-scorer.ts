// Agent 3 — Signal scorer.
// Per skill: stockpilot-signal-scorer (Agent 3 section).
// Single Claude call (not parallel) so the model can enforce the 3-BUY cap globally.

import { z } from 'zod';
import { callClaude } from '../lib/claude';
import { ScoredTickerSchema } from '../lib/schemas';
import { THRESHOLDS } from '../config/thresholds';
import type { TickerBrief } from './agent1-scraper';
import type { QuestionResult } from './agent2-question-asker';

export interface ScoredSignal {
  ticker: string;
  verdict: 'BUY' | 'WATCH' | 'SKIP';
  alpha_score: number;
  reasoning: string;
  time_horizon: '30d' | '60d' | '90d';
  entry_note: string;
  stop_note: string;
}

// PATCH 01: retry-once parser. On second failure, throws so the orchestrator can halt.
async function parseAgent3WithRetry(
  call: () => Promise<string>
): Promise<ScoredSignal[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await call();
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const jsonStart = cleaned.indexOf('[');
      if (jsonStart === -1) throw new Error('No JSON array found in response');
      const end = cleaned.lastIndexOf(']');
      const parsed = JSON.parse(cleaned.slice(jsonStart, end + 1));
      const validated = z.array(ScoredTickerSchema).parse(parsed);
      return validated as ScoredSignal[];
    } catch (e) {
      lastErr = e;
      console.error(`[Agent3] Parse attempt ${attempt} failed:`, (e as Error).message);
      if (attempt === 2) throw e;
    }
  }
  throw lastErr ?? new Error('unreachable');
}

const SCORER_SYSTEM_PROMPT = `You are a quant analyst. Score each stock for probability of outperforming the S&P 500 by 3%+ over the next 30 trading days.

Scoring criteria (weight in alpha_score):
1. Signal strength — earnings-grade or noise? (30%)
2. Institutional pressure — big players moving? (25%)
3. Sector tailwind vs headwind (20%)
4. Valuation buffer — room to run, or stretched? (15%)
5. Technical setup — momentum quality (10%)

Verdict rules:
- BUY: credible +3% path, high signal quality
- WATCH: possible outperformance, needs confirmation
- SKIP: not enough edge
- HARD RULE: Maximum 3 BUY verdicts per run. If more qualify, rank by alpha_score and downgrade the rest to WATCH.

Return ONLY valid JSON array. No preamble. No markdown.`;

// Build the TOON tabular handoff that Agent 3 sees (briefs joined to questions).
function buildToonBlock(
  briefs: TickerBrief[],
  questions: QuestionResult[]
): string {
  const header =
    'briefs[' +
    briefs.length +
    ']{ticker,headline,signal,catalyst,risk,confidence,questions}:';
  const rows = briefs.map((b) => {
    const q = questions.find((x) => x.ticker === b.ticker);
    const qStr = q?.questions?.join(' | ') ?? '';
    return `  ${b.ticker},${escape(b.headline)},${b.signal},${escape(b.catalyst)},${escape(b.risk)},${b.confidence},${escape(qStr)}`;
  });
  return [header, ...rows].join('\n');
}

function escape(s: string): string {
  return (s ?? '').replace(/\n/g, ' ').replace(/,/g, ';');
}

function buildScorerPrompt(
  briefs: TickerBrief[],
  questions: QuestionResult[],
  date: string
): string {
  return `Today: ${date}
Tickers with briefs and questions:
${buildToonBlock(briefs, questions)}

Return JSON array:
[{
  "ticker": "NVDA",
  "verdict": "BUY | WATCH | SKIP",
  "alpha_score": 8.2,
  "reasoning": "One sentence.",
  "time_horizon": "30d | 60d | 90d",
  "entry_note": "What confirms entry",
  "stop_note": "What invalidates thesis"
}]`;
}

// FIX 01: Code-level BUY cap. Never trust the model to enforce this.
export function enforceBuyCap(scored: ScoredSignal[]): ScoredSignal[] {
  const cap = THRESHOLDS.BUY_CAP;
  const buys = scored
    .filter((s) => s.verdict === 'BUY')
    .sort((a, b) => b.alpha_score - a.alpha_score);

  if (buys.length <= cap) return scored;

  console.warn(
    `[Agent3] BUY cap exceeded — ${buys.length} BUYs found, downgrading to ${cap}`
  );
  const keep = new Set(buys.slice(0, cap).map((s) => s.ticker));
  buys.slice(cap).forEach((s) =>
    console.warn(
      `[Agent3] Downgraded ${s.ticker} BUY→WATCH (alpha: ${s.alpha_score})`
    )
  );
  return scored.map((s) =>
    s.verdict === 'BUY' && !keep.has(s.ticker)
      ? { ...s, verdict: 'WATCH' as const }
      : s
  );
}

export async function runAgent3(
  briefs: TickerBrief[],
  questions: QuestionResult[],
  date: string
): Promise<ScoredSignal[]> {
  const start = Date.now();
  console.log(`[Agent3] Start — scoring ${briefs.length} tickers`);

  const scored = await parseAgent3WithRetry(() =>
    callClaude({
      systemPrompt: SCORER_SYSTEM_PROMPT,
      userPrompt: buildScorerPrompt(briefs, questions, date),
      // ~120 output tokens per ticker; 2000 truncated at >16 tickers
      maxTokens: Math.max(4000, briefs.length * 250),
    })
  );
  const capped = enforceBuyCap(scored);

  const buys = capped.filter((s) => s.verdict === 'BUY').length;
  const watches = capped.filter((s) => s.verdict === 'WATCH').length;
  const skips = capped.filter((s) => s.verdict === 'SKIP').length;
  console.log(
    `[Agent3] End — ${buys} BUY, ${watches} WATCH, ${skips} SKIP (${Date.now() - start}ms)`
  );
  return capped;
}
