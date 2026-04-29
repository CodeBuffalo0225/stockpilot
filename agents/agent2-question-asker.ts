// Agent 2 — Smart question asker (Ian Dunlap voice).
// Per skill: stockpilot-question-asker. Parallel via Promise.all.
// answerable=false routes to Agent 5 (Notion); true routes to Agent 3.

import { callClaude, parseJsonObject } from '../lib/claude';
import { QuestionOutputSchema } from '../lib/schemas';
import type { TickerBrief } from './agent1-scraper';

export interface QuestionResult {
  ticker: string;
  questions: string[];
  answerable: boolean;
  unanswered_reason: string | null;
}

const DUNLAP_SYSTEM_PROMPT = `You are Ian Dunlap from Earn Your Leisure. You are a long-term, data-driven growth investor who manages money like a professional portfolio manager targeting 3%+ annual alpha over the S&P 500.

Your job is to ask the 3 hardest questions an investor MUST answer before acting on a stock signal. Rules:
- Never describe what happened. You already read the brief.
- Ask what the signal MEANS for price action over the next 30-90 days.
- Expose whether this is real edge or just noise.
- Be direct. Never hedge. One sentence per question.
- Think about: institutional positioning, options flow, technical levels, sector rotation, macro context, valuation headroom.

Return ONLY valid JSON. No preamble. No markdown.`;

// FIX 05 — bearish-specific framing. Forked at the call site by signal direction.
const DUNLAP_BEARISH_SYSTEM_PROMPT = `You are Ian Dunlap from Earn Your Leisure. You are a disciplined portfolio
manager who has just seen a bearish signal on a stock.

Your job is to ask the 3 hardest questions an investor MUST answer before
deciding whether to avoid, hedge, or short this position. Rules:
- Never describe what happened. You already read the brief.
- Ask what this bearish signal means for downside over the next 30-90 days.
- Expose whether the bad news is already priced in or if there is more to fall.
- Ask about short interest, put/call ratio, and institutional exits.
- Be direct. Never hedge. One sentence per question.

Return ONLY valid JSON. No preamble. No markdown.`;

function buildUserPrompt(brief: TickerBrief): string {
  return `Stock brief for ${brief.ticker}:
Headline: ${brief.headline}
Signal: ${brief.signal}
Catalyst: ${brief.catalyst}
Risk: ${brief.risk}
Confidence: ${brief.confidence}/10

Return:
{
  "ticker": "${brief.ticker}",
  "questions": ["Question 1", "Question 2", "Question 3"],
  "answerable": true,
  "unanswered_reason": null
}

Set answerable=false if answering requires data not in this brief (options chain, insider flow, earnings transcripts, etc.) and explain what data source is needed in unanswered_reason.`;
}

async function askQuestions(
  brief: TickerBrief,
  attempt = 0
): Promise<QuestionResult | null> {
  try {
    const systemPrompt =
      brief.signal === 'bearish'
        ? DUNLAP_BEARISH_SYSTEM_PROMPT
        : DUNLAP_SYSTEM_PROMPT;
    const text = await callClaude({
      systemPrompt,
      userPrompt: buildUserPrompt(brief),
      maxTokens: 300,
    });
    const raw = parseJsonObject<unknown>(text);
    const validated = QuestionOutputSchema.safeParse(raw);
    if (!validated.success) {
      console.error(
        `[Agent2] Schema validation failed for ${brief.ticker}:`,
        validated.error.issues.slice(0, 3)
      );
      return raw as QuestionResult;
    }
    return validated.data as QuestionResult;
  } catch (e) {
    if (attempt === 0) {
      console.warn(`[Agent2] ${brief.ticker} failed, retrying...`);
      return askQuestions(brief, 1);
    }
    console.error(`[Agent2] ${brief.ticker} failed after retry:`, (e as Error).message);
    return null;
  }
}

export async function runAgent2(briefs: TickerBrief[]): Promise<QuestionResult[]> {
  const start = Date.now();
  console.log(`[Agent2] Start — ${briefs.length} briefs`);

  const results = await Promise.all(briefs.map((b) => askQuestions(b)));
  const filtered = results.filter((r): r is QuestionResult => r !== null);

  console.log(
    `[Agent2] End — ${filtered.length}/${briefs.length} ok (${Date.now() - start}ms)`
  );
  return filtered;
}
