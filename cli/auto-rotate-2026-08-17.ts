// One-off auto-approve run for the 2026-08-17 rotation suggestions.
// Reuses rotate.ts's atomic-write pattern; picks the first non-duplicate
// candidate per suggestion instead of prompting interactively.

import * as fs from 'fs';
import * as path from 'path';

import { insertRotation } from '../lib/db';
import type { WatchlistItem } from '../agents/agent1-scraper';

const WATCHLIST_PATH = path.join(__dirname, '..', 'data', 'watchlist.json');
const POOL_PATH = path.join(__dirname, '..', 'data', 'candidate-pool.json');

const date = '2026-08-17';

const suggestions: { ticker_out: string; reason: string; candidates: string[] }[] = [
  { ticker_out: 'MSFT', reason: 'hit_rate_failure', candidates: ['AVGO', 'ORCL', 'CRM'] },
  { ticker_out: 'NVDA', reason: 'hit_rate_failure', candidates: ['AVGO', 'TSM', 'ORCL'] },
  { ticker_out: 'IBM', reason: 'silent_30d', candidates: ['AVGO', 'ORCL', 'ACN'] },
  { ticker_out: 'GOOGL', reason: 'hit_rate_failure', candidates: ['META', 'NFLX', 'AVGO'] },
  { ticker_out: 'HD', reason: 'silent_30d', candidates: ['LOW', 'AMZN', 'NKE'] },
  { ticker_out: 'PG', reason: 'silent_30d', candidates: ['COST', 'WMT', 'KO'] },
  { ticker_out: 'BP', reason: 'silent_30d', candidates: ['XOM', 'CVX', 'COP'] },
  { ticker_out: 'JPM', reason: 'silent_30d', candidates: ['GS', 'V', 'BLK'] },
];

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveWatchlist(items: WatchlistItem[]): void {
  const tmp = WATCHLIST_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  fs.renameSync(tmp, WATCHLIST_PATH);
}

function main(): void {
  const watchlist = loadJson<WatchlistItem[]>(WATCHLIST_PATH);
  const pool = loadJson<WatchlistItem[]>(POOL_PATH);

  const working = [...watchlist];
  const used = new Set<string>();
  let swapsMade = 0;

  for (const sug of suggestions) {
    const chosenTicker = sug.candidates.find((t) => !used.has(t));
    if (!chosenTicker) {
      console.log(`⚠ No unused candidate left for ${sug.ticker_out} — skipping`);
      continue;
    }
    const meta = pool.find((p) => p.ticker === chosenTicker);
    if (!meta) {
      console.log(`⚠ ${chosenTicker} not in candidate-pool.json — skipping`);
      continue;
    }
    const outIdx = working.findIndex((w) => w.ticker === sug.ticker_out);
    if (outIdx === -1) {
      console.log(`⚠ ${sug.ticker_out} no longer on watchlist — skipping`);
      continue;
    }

    working[outIdx] = meta;
    used.add(chosenTicker);
    insertRotation({
      rotation_date: date,
      ticker_out: sug.ticker_out,
      ticker_in: chosenTicker,
      reason: sug.reason,
      approved_by: 'auto',
    });
    swapsMade++;
    console.log(`✓ Swapped ${sug.ticker_out} → ${chosenTicker}`);
  }

  if (swapsMade > 0) {
    saveWatchlist(working);
    console.log(`\n${swapsMade} swap(s) applied. New watchlist: ${working.map((w) => w.ticker).join(', ')}`);
  } else {
    console.log('\nNo swaps applied.');
  }
}

main();
