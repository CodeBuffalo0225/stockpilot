// StockPilot orchestrator — full daily sequence including self-improvement loops.
//
//   1. Load watchlist.json
//   2. Agent 1 — Perplexity news pull (parallel per ticker)
//   3. Agent 2 — Smart question asker (parallel per ticker)
//   4. Agent 3 — Signal scorer (single call, all briefs)
//   5. Agent 4 — Portfolio allocator (single call, BUY signals only)
//   6. Agent 5 — Notion logger (questions + daily report)
//   7. Agent 6 — Call persister (snapshot verdicts + prices into SQLite) [Loop A]
//   8. Agent 7 — Outcome scorer (score matured 5d/15d/30d windows)     [Loop A]
//   9. Agent 8 — Rotation suggester (flag + rank candidates)             [Loop C]
//  10. Compose + send email report (includes rotation suggestions)
//  11. Save reports/{DATE}.json
//
// On any single-ticker failure: retry once, skip, log error — never crash.

// Force override — parent shell may export empty ANTHROPIC_API_KEY etc.
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as path from 'path';

import { THRESHOLDS } from './config/thresholds';
import { runAgent0 } from './agents/agent0-momentum-screener';
import { runAgent1, type WatchlistItem } from './agents/agent1-scraper';
import { updateSuppression } from './lib/suppression';
import { runAgent2, type QuestionResult } from './agents/agent2-question-asker';
import type { TickerBrief } from './lib/scraper';
import { runAgent3 } from './agents/agent3-signal-scorer';
import { runAgent4 } from './agents/agent4-allocator';
import { runAgent5 } from './agents/agent5-notion-logger';
import { runAgent6 } from './agents/agent6-call-persister';
import { runAgent7 } from './agents/agent7-outcome-scorer';
import { runAgent8 } from './agents/agent8-rotation-suggester';
import { sendReportEmail, sendFailureEmail } from './lib/mailer';
import { getOrCreateRun, finishRun, getCheckpoint, recordAgentRun } from './lib/db';

const REPORTS_DIR = path.join(__dirname, 'reports');
const WATCHLIST_PATH = path.join(__dirname, 'data', 'watchlist.json');

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

function loadWatchlist(): WatchlistItem[] {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf-8');
  return JSON.parse(raw) as WatchlistItem[];
}

// Resumability: if the orchestrator dies mid-run (e.g. Agent 4 throws after
// Agents 1-3 already burned Playwright scrapes + Claude calls), a retry on
// the same calendar date replays each stage's checkpointed output instead
// of re-running it. Failed stages are NOT cached — they re-execute on retry.
async function runStage<T>(
  runId: number,
  agentName: string,
  fn: () => Promise<T>
): Promise<T> {
  const cached = getCheckpoint(runId, agentName);
  if (cached !== null) {
    console.log(`[Orchestrator] ${agentName} — resuming from checkpoint`);
    return cached as T;
  }
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    recordAgentRun({
      run_id: runId,
      agent_name: agentName,
      status: 'ok',
      output_json: JSON.stringify(result),
      error: null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    return result;
  } catch (e) {
    recordAgentRun({
      run_id: runId,
      agent_name: agentName,
      status: 'failed',
      output_json: null,
      error: (e as Error).message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    throw e;
  }
}

export async function runOrchestrator(): Promise<void> {
  const runStart = Date.now();
  const date = todayIso();
  console.log(`\n========== StockPilot run ${date} ==========`);

  const run = getOrCreateRun(date);
  const runId = run.id;
  if (run.status !== 'running') {
    console.log(`[Orchestrator] Retrying run ${date} (previous status: ${run.status})`);
  }

  try {
    await runOrchestratorBody(runId, date, runStart);
  } catch (e) {
    finishRun(runId, 'failed');
    throw e;
  }
}

async function runOrchestratorBody(
  runId: number,
  date: string,
  runStart: number
): Promise<void> {
  // 1. Load the fixed core watchlist
  const core = loadWatchlist();
  console.log(`[Orchestrator] Loaded ${core.length} core tickers`);

  // 1b. Agent 0 — momentum screen → dynamic sleeve of today's movers.
  //     Core + sleeve = the effective watchlist for this run.
  let agent0Result;
  try {
    agent0Result = await runStage(runId, 'agent0', () => runAgent0(core, date));
  } catch (e) {
    console.error('[Orchestrator] Agent 0 failed:', (e as Error).message);
  }
  const sleeve = agent0Result?.sleeve ?? [];
  const sleeveSet = new Set(sleeve.map((s) => s.ticker));
  const coreSet = new Set(core.map((c) => c.ticker));
  // Dedupe (sleeve already excludes core, but be defensive).
  const watchlist: WatchlistItem[] = [
    ...core,
    ...sleeve.filter((s) => !coreSet.has(s.ticker)),
  ];
  console.log(
    `[Orchestrator] Effective watchlist: ${core.length} core + ${sleeve.length} momentum sleeve = ${watchlist.length}`
  );

  // 2. Agent 1 — scrape Perplexity Finance + FMP fallback
  const briefs = await runStage(runId, 'agent1', () => runAgent1(watchlist));
  if (briefs.length === 0) {
    throw new Error('Agent 1 produced 0 briefs — aborting run');
  }

  // FIX 04 — Pre-Agent 2 low-confidence filter fork. Neutral + low confidence
  // never reaches Agent 2; treated as auto-skip in the email.
  const autoSkipped: TickerBrief[] = [];
  const toQuestion: TickerBrief[] = [];
  briefs.forEach((brief) => {
    if (
      brief.signal === 'neutral' &&
      brief.confidence < THRESHOLDS.LOW_CONFIDENCE_THRESHOLD
    ) {
      console.log(
        `[Orchestrator] Auto-skip ${brief.ticker} — neutral signal, confidence ${brief.confidence}/10`
      );
      autoSkipped.push(brief);
    } else {
      toQuestion.push(brief);
    }
  });
  console.log(
    `[Orchestrator] Routing: ${toQuestion.length} to Agent 2, ${autoSkipped.length} auto-skipped`
  );

  // FIX 05 — Repeat-suppression. Core names that have been neutral + low-conf
  // for QUIET_SUPPRESS_DAYS consecutive runs are demoted out of the main email.
  const suppression = updateSuppression(briefs, coreSet, date);
  if (suppression.suppressed.length) {
    console.log(
      `[Orchestrator] Suppressing quiet core names: ${suppression.suppressed.join(', ')}`
    );
  }

  // 3. Agent 2 — questions (skipped briefs are not asked)
  const questions: QuestionResult[] = await runStage(runId, 'agent2', () =>
    runAgent2(toQuestion)
  );

  // 4. Agent 3 — score (single call, full context for BUY cap)
  const scored = await runStage(runId, 'agent3', () => runAgent3(briefs, questions, date));

  // 5. Agent 4 — allocate (BUY signals only get full size)
  const allocator = await runStage(runId, 'agent4', () => runAgent4(scored, date));

  // 6. Agent 5 — Notion logger (errors logged, do not block email). Checkpointed
  // so a retry doesn't double-write Notion pages for the same date.
  const { unansweredCount, notionHealthFlag } = await runStage(runId, 'agent5', () =>
    runAgent5(questions, scored, allocator, date)
  );

  // 7. Agent 6 — persist today's calls into SQLite (Loop A: outcome tracking)
  let callPersistResult;
  try {
    callPersistResult = await runStage(runId, 'agent6', () => runAgent6(scored, briefs, date));
  } catch (e) {
    console.error('[Orchestrator] Agent 6 failed:', (e as Error).message);
  }

  // 8. Agent 7 — score matured 5d/15d/30d windows
  let outcomeResult;
  try {
    outcomeResult = await runStage(runId, 'agent7', () => runAgent7(date));
  } catch (e) {
    console.error('[Orchestrator] Agent 7 failed:', (e as Error).message);
  }

  // 9. Agent 8 — rotation suggestions (informational — approval via `npm run rotate`)
  //     Operates on the fixed CORE only — the sleeve rotates itself daily.
  let rotationResult;
  try {
    rotationResult = await runStage(runId, 'agent8', () => runAgent8(core, date));
  } catch (e) {
    console.error('[Orchestrator] Agent 8 failed:', (e as Error).message);
  }

  // 10. Compose + send email
  try {
    await sendReportEmail({
      date,
      allocation: allocator.allocation,
      scored,
      thesis: allocator.thesis,
      unansweredCount,
      rotations: rotationResult,
      notionHealthFlag,
      momentum: agent0Result
        ? { sleeve: agent0Result.sleeve.map((s) => s.ticker), ranked: agent0Result.ranked.slice(0, 12) }
        : undefined,
      suppressed: suppression.suppressed,
    });
    console.log('[Orchestrator] Email sent');
  } catch (e) {
    console.error('[Orchestrator] Email send failed:', (e as Error).message);
  }

  // 11. Save reports/{DATE}.json
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  const reportPath = path.join(REPORTS_DIR, `${date}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        date,
        core,
        sleeve: sleeve.map((s) => s.ticker),
        watchlist,
        momentum: agent0Result
          ? {
              screened: agent0Result.screened,
              skipped: agent0Result.skipped,
              ranked: agent0Result.ranked,
            }
          : null,
        suppression,
        briefs,
        questions,
        scored,
        allocation: allocator.allocation,
        thesis: allocator.thesis,
        unansweredCount,
        callPersist: callPersistResult ?? null,
        outcomes: outcomeResult ?? null,
        rotations: rotationResult ?? null,
      },
      null,
      2
    )
  );
  console.log(`[Orchestrator] Saved ${reportPath}`);
  finishRun(runId, 'ok');

  console.log(
    `========== Run complete in ${Date.now() - runStart}ms ==========\n`
  );
}

// Allow `npm run run-now` (ts-node orchestrator.ts) to invoke directly.
if (require.main === module) {
  runOrchestrator().catch(async (e) => {
    console.error('[Orchestrator] Fatal:', e);
    await sendFailureEmail(e);
    process.exit(1);
  });
}
