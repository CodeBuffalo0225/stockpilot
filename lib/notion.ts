// Notion client wrapper. Two databases:
//   NOTION_DATABASE_ID         — Unanswered Questions
//   NOTION_REPORT_DATABASE_ID  — Daily Reports
// Per skill: stockpilot-notion-logger. Errors must NOT block email send.

import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { Client } from '@notionhq/client';

export const notion = new Client({ auth: process.env.NOTION_TOKEN });

export interface QuestionRecord {
  ticker: string;
  questions: string[];
  answerable: boolean;
  unanswered_reason: string | null;
}

export interface ScoredRecord {
  ticker: string;
  verdict: 'BUY' | 'WATCH' | 'SKIP';
  alpha_score: number;
  reasoning: string;
  time_horizon: string;
  entry_note: string;
  stop_note: string;
}

export interface AllocationItem {
  ticker: string;
  tier: number;
  position_pct: number;
  entry_note: string;
  stop_loss_note: string;
}

export interface DailyReport {
  date: string;
  allocation: AllocationItem[];
  thesis: string;
  unansweredCount: number;
  scored: ScoredRecord[];
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

// DB 1 — Unanswered Questions. One Notion page per question.
export async function logUnansweredQuestion(
  q: QuestionRecord,
  scored: ScoredRecord[]
): Promise<void> {
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error('NOTION_DATABASE_ID missing');

  const match = scored.find((s) => s.ticker === q.ticker);
  const priority = match?.verdict === 'BUY' ? 'High' : 'Normal';

  for (const question of q.questions) {
    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        Name: {
          title: [{ text: { content: `${q.ticker} — ${question}` } }],
        },
        Ticker: { select: { name: q.ticker } },
        Date: { date: { start: todayIso() } },
        Reason: {
          rich_text: [{ text: { content: q.unanswered_reason || '' } }],
        },
        Status: { select: { name: 'Needs Research' } },
        Priority: { select: { name: priority } },
      },
    });
  }
}

// DB 2 — Daily Reports. One page per run.
export async function logDailyReport(report: DailyReport): Promise<void> {
  const dbId = process.env.NOTION_REPORT_DATABASE_ID;
  if (!dbId) throw new Error('NOTION_REPORT_DATABASE_ID missing');

  const buys = report.scored.filter((s) => s.verdict === 'BUY');
  const watches = report.scored.filter((s) => s.verdict === 'WATCH');
  const skips = report.scored.filter((s) => s.verdict === 'SKIP');

  const buysText = report.allocation
    .filter((a) => a.tier <= 2)
    .map((a) => `${a.ticker} (${a.position_pct}%) — ${a.entry_note}`)
    .join('\n');

  const watchesText = watches
    .map((w) => `${w.ticker} — ${w.reasoning}`)
    .join('\n');

  const skipsText = skips.map((s) => s.ticker).join(', ');

  // TOON-style allocation block as plain text.
  const allocationText = [
    'allocation[' + report.allocation.length + ']{ticker,tier,position_pct,entry_note,stop_loss_note}:',
    ...report.allocation.map(
      (a) =>
        `  ${a.ticker},${a.tier},${a.position_pct},${a.entry_note},${a.stop_loss_note}`
    ),
  ].join('\n');

  await notion.pages.create({
    parent: { database_id: dbId },
    properties: {
      Name: {
        title: [
          { text: { content: `StockPilot Report — ${report.date}` } },
        ],
      },
      Date: { date: { start: report.date } },
      Buys: { rich_text: [{ text: { content: buysText || '(none)' } }] },
      Watches: {
        rich_text: [{ text: { content: watchesText || '(none)' } }],
      },
      Skips: {
        rich_text: [{ text: { content: skipsText || '(none)' } }],
      },
      Allocation: {
        rich_text: [{ text: { content: allocationText } }],
      },
      Thesis: { rich_text: [{ text: { content: report.thesis } }] },
      'Unanswered Count': { number: report.unansweredCount },
    },
  });

  // Suppress unused-var warning for buys (kept for symmetry/clarity).
  void buys;
}
