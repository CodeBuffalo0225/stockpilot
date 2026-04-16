// `npm run rotate` — interactive watchlist rotation CLI.
// Per Phase 3 captured workflow: option (b) — CLI prompt approval mechanism.
//
// Flow:
//   1. Re-run Agent 8 against current watchlist to get fresh suggestions
//   2. For each flagged ticker: show 3 candidates numbered 1/2/3
//   3. User types 1/2/3 to swap, 's' to skip, 'q' to quit
//   4. On swap: update data/watchlist.json atomically + insert rotations row

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { runAgent8 } from '../agents/agent8-rotation-suggester';
import { insertRotation } from '../lib/db';
import type { WatchlistItem } from '../agents/agent1-scraper';

const WATCHLIST_PATH = path.join(__dirname, '..', 'data', 'watchlist.json');
const POOL_PATH = path.join(__dirname, '..', 'data', 'candidate-pool.json');

function loadWatchlist(): WatchlistItem[] {
  return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf-8'));
}

function loadPool(): WatchlistItem[] {
  return JSON.parse(fs.readFileSync(POOL_PATH, 'utf-8'));
}

// Atomic write: write to .tmp then rename, so an interrupted run can't
// corrupt the source-of-truth watchlist.
function saveWatchlist(items: WatchlistItem[]): void {
  const tmp = WATCHLIST_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  fs.renameSync(tmp, WATCHLIST_PATH);
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const watchlist = loadWatchlist();
  const pool = loadPool();

  console.log('\n=== StockPilot Rotation CLI ===');
  console.log(`Date: ${date}`);
  console.log(`Active watchlist (${watchlist.length}): ${watchlist.map((w) => w.ticker).join(', ')}\n`);

  console.log('Computing rotation suggestions...\n');
  const result = await runAgent8(watchlist, date);

  if (result.suggestions.length === 0) {
    console.log(
      result.flagged === 0
        ? '✓ No flagged tickers today. Watchlist is healthy.\n'
        : '⚠ Tickers flagged but no candidates available (all in cooldown or already on watchlist).\n'
    );
    process.exit(0);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let working = [...watchlist];
  let swapsMade = 0;

  for (const sug of result.suggestions) {
    console.log('━'.repeat(60));
    console.log(`FLAGGED: ${sug.ticker_out}`);
    console.log(`Reason:  ${sug.reason}`);
    console.log(`Health:  ${sug.health_summary}\n`);
    console.log('Candidates:');
    sug.candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.ticker} — ${c.rationale}`);
    });
    console.log('  s. Skip (keep ' + sug.ticker_out + ')');
    console.log('  q. Quit\n');

    const ans = (await ask(rl, 'Pick [1/2/3/s/q]: ')).toLowerCase();

    if (ans === 'q') break;
    if (ans === 's' || ans === '') {
      console.log(`→ Kept ${sug.ticker_out}\n`);
      continue;
    }

    const idx = parseInt(ans, 10) - 1;
    const chosen = sug.candidates[idx];
    if (!chosen) {
      console.log(`Invalid selection — keeping ${sug.ticker_out}\n`);
      continue;
    }

    // Find the candidate metadata in the pool for sector preservation
    const meta = pool.find((p) => p.ticker === chosen.ticker);
    if (!meta) {
      console.log(
        `⚠ ${chosen.ticker} not in candidate-pool.json — skipping (data integrity)\n`
      );
      continue;
    }

    // Swap in working list
    const outIdx = working.findIndex((w) => w.ticker === sug.ticker_out);
    if (outIdx === -1) {
      console.log(`⚠ ${sug.ticker_out} no longer on watchlist — skipping\n`);
      continue;
    }
    working[outIdx] = meta;
    insertRotation({
      rotation_date: date,
      ticker_out: sug.ticker_out,
      ticker_in: chosen.ticker,
      reason: sug.reason,
      approved_by: 'manual',
    });
    swapsMade++;
    console.log(`✓ Swapped ${sug.ticker_out} → ${chosen.ticker}\n`);
  }

  rl.close();

  if (swapsMade > 0) {
    saveWatchlist(working);
    console.log('━'.repeat(60));
    console.log(`✓ ${swapsMade} swap(s) applied. data/watchlist.json updated.`);
    console.log(`New watchlist: ${working.map((w) => w.ticker).join(', ')}\n`);
  } else {
    console.log('━'.repeat(60));
    console.log('No swaps applied. Watchlist unchanged.\n');
  }
}

main().catch((e) => {
  console.error('[rotate] Fatal:', e);
  process.exit(1);
});
