// Agent 2 — Smart question asker (Ian Dunlap voice).
// Per skill: stockpilot-question-asker. Parallel via Promise.all.
// answerable=false routes to Agent 5 (Notion); true routes to Agent 3.

import { callClaude, parseJsonObject } from '../lib/claude';
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
    const text = await callClaude({
      systemPrompt: DUNLAP_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(brief),
      maxTokens: 300,
    });
    return parseJsonObject<QuestionResult>(text);
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
