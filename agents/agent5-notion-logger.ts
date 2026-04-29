// Agent 5 — Notion logger.
// Per skill: stockpilot-notion-logger. Notion failures must NOT block email send.
// Logs unanswered questions to DB1 and the daily report to DB2.

import {
  logUnansweredQuestion,
  logDailyReport,
  type DailyReport,
} from '../lib/notion';
import type { QuestionResult } from './agent2-question-asker';
import type { ScoredSignal } from './agent3-signal-scorer';
import type { AllocatorOutput } from './agent4-allocator';

export interface Agent5Result {
  unansweredCount: number;
  notionHealthFlag: string;
}

export async function runAgent5(
  questions: QuestionResult[],
  scored: ScoredSignal[],
  allocator: AllocatorOutput,
  date: string
): Promise<Agent5Result> {
  const start = Date.now();
  console.log(`[Agent5] Start`);

  const unanswered = questions.filter((q) => !q.answerable);
  let unansweredCount = 0;
  let notionSuccessCount = 0;
  const notionAttempts = unanswered.length + 1; // +1 for daily report

  // DB 1 — Unanswered questions. Per-record try/catch so one bad write
  // never blocks the rest.
  for (const q of unanswered) {
    try {
      await logUnansweredQuestion(q, scored);
      unansweredCount += q.questions.length;
      notionSuccessCount++;
    } catch (e) {
      console.error(
        `[Agent5] Notion DB1 write failed for ${q.ticker}:`,
        (e as Error).message
      );
    }
  }

  // DB 2 — Daily report.
  const report: DailyReport = {
    date,
    allocation: allocator.allocation,
    thesis: allocator.thesis,
    unansweredCount,
    scored,
  };

  try {
    await logDailyReport(report);
    notionSuccessCount++;
  } catch (e) {
    console.error('[Agent5] Notion DB2 write failed:', (e as Error).message);
  }

  // FIX 06 / PATCH 03: total-failure flag returned to orchestrator (no module-scope export).
  const notionHealthFlag =
    notionSuccessCount === 0 && notionAttempts > 0
      ? '⚠️ NOTION WRITES FAILED'
      : `Notion: ${notionSuccessCount}/${notionAttempts}`;

  console.log(
    `[Agent5] End — ${unansweredCount} questions logged | ${notionHealthFlag} (${Date.now() - start}ms)`
  );
  return { unansweredCount, notionHealthFlag };
}
