// Agent 4 — Portfolio allocator.
// Per skill: stockpilot-signal-scorer (Agent 4 section).
// Conviction tiers:
//   8.0–10.0 → Tier 1 → 5%
//   6.0–7.9  → Tier 2 → 3%
//   4.0–5.9  → Tier 3 (WATCH only) → 1.5%
//   <4.0 / SKIP → 0%, omitted

import { callClaude, parseJsonObject } from '../lib/claude';
import type { ScoredSignal } from './agent3-signal-scorer';

export interface AllocationItem {
  ticker: string;
  tier: number;
  position_pct: number;
  entry_note: string;
  stop_loss_note: string;
}

export interface AllocatorOutput {
  allocation: AllocationItem[];
  thesis: string;
}

const ALLOCATOR_SYSTEM_PROMPT = `You are a portfolio manager. Convert scored signals into a daily allocation table and a one-paragraph investment thesis.

Rules:
- Only size BUY verdicts at full tier weight
- WATCH verdicts get 1.5% max as a monitoring position
- SKIP = 0%, do not mention in allocation table
- Thesis: 3-5 sentences. Macro/sector narrative today. Top 2-3 conviction moves. Key risk to watch. Write like Ian Dunlap — direct, confident, no hedging.

Return ONLY valid JSON. No preamble. No markdown.`;

function buildToonBlock(scored: ScoredSignal[]): string {
  const rows = scored.map(
    (s) =>
      `  ${s.ticker},${s.verdict},${s.alpha_score},${escape(s.reasoning)},${s.time_horizon},${escape(s.entry_note)},${escape(s.stop_note)}`
  );
  return [
    `scored[${scored.length}]{ticker,verdict,alpha_score,reasoning,time_horizon,entry_note,stop_note}:`,
    ...rows,
  ].join('\n');
}

function escape(s: string): string {
  return (s ?? '').replace(/\n/g, ' ').replace(/,/g, ';');
}

function buildPrompt(scored: ScoredSignal[], date: string): string {
  const buyCandidates = scored.filter((s) => s.verdict === 'BUY');
  const watchCandidates = scored.filter((s) => s.verdict === 'WATCH');

  return `Today: ${date}

Scored signals:
${buildToonBlock(scored)}

There are ${buyCandidates.length} BUY and ${watchCandidates.length} WATCH candidates.

Return JSON:
{
  "allocation": [
    {
      "ticker": "NVDA",
      "tier": 1,
      "position_pct": 5,
      "entry_note": "Break above 940 on volume",
      "stop_loss_note": "Close below 910 invalidates"
    }
  ],
  "thesis": "3-5 sentence daily thesis in Ian Dunlap voice"
}`;
}

// Defensive sizing — enforces tier table even if model drifts.
function enforceTiers(
  alloc: AllocationItem[],
  scored: ScoredSignal[]
): AllocationItem[] {
  return alloc
    .map((a) => {
      const s = scored.find((x) => x.ticker === a.ticker);
      if (!s) return null;
      if (s.verdict === 'SKIP') return null;

      let tier = 0;
      let pct = 0;
      if (s.verdict === 'BUY') {
        if (s.alpha_score >= 8.0) {
          tier = 1;
          pct = 5;
        } else if (s.alpha_score >= 6.0) {
          tier = 2;
          pct = 3;
        } else {
          return null;
        }
      } else if (s.verdict === 'WATCH') {
        tier = 3;
        pct = 1.5;
      }

      return {
        ticker: a.ticker,
        tier,
        position_pct: pct,
        entry_note: a.entry_note || s.entry_note,
        stop_loss_note: a.stop_loss_note || s.stop_note,
      };
    })
    .filter((a): a is AllocationItem => a !== null);
}

export async function runAgent4(
  scored: ScoredSignal[],
  date: string
): Promise<AllocatorOutput> {
  const start = Date.now();
  console.log(`[Agent4] Start — allocating ${scored.length} signals`);

  const text = await callClaude({
    systemPrompt: ALLOCATOR_SYSTEM_PROMPT,
    userPrompt: buildPrompt(scored, date),
    maxTokens: 2000,
  });

  const parsed = parseJsonObject<AllocatorOutput>(text);
  const allocation = enforceTiers(parsed.allocation || [], scored);

  console.log(
    `[Agent4] End — ${allocation.length} positions sized (${Date.now() - start}ms)`
  );
  return { allocation, thesis: parsed.thesis };
}
