// Agent 0 — Momentum Screener (the "ROI radar").
// Runs BEFORE Agent 1. Screens a broad universe by relative strength vs SPY,
// recent price thrust, volume surge, and proximity to 52-week highs, then
// hands the top-N movers to the daily pipeline as a dynamic "sleeve" on top
// of the fixed core watchlist.
//
// Why this exists: the old design could only ever brief hand-typed names.
// This agent lets the system surface a mover (e.g. SNDK / COHR / AMD) the
// day it starts ripping, without a human editing JSON.

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as path from 'path';

import { THRESHOLDS } from '../config/thresholds';
import {
  fetchDailyHistory,
  mapLimit,
  type Bar,
} from '../lib/marketdata';
import {
  computeMetrics,
  scoreUniverse,
  spyReturn63d,
  type ScoredMomentum,
} from '../lib/momentum';
import { tickersInCooldown } from '../lib/db';
import type { WatchlistItem } from './agent1-scraper';

const UNIVERSE_PATH = path.join(__dirname, '..', 'data', 'universe.json');
const COOLDOWN_DAYS = 60;

export interface Agent0Result {
  sleeve: WatchlistItem[]; // names to add to the daily run
  ranked: ScoredMomentum[]; // full ranked board (for the report/email)
  screened: number; // how many universe names had usable data
  skipped: number; // names dropped for missing/short history
}

function loadUniverse(): WatchlistItem[] {
  if (!fs.existsSync(UNIVERSE_PATH)) {
    console.warn('[Agent0] universe.json missing — no momentum sleeve possible');
    return [];
  }
  return JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf-8')) as WatchlistItem[];
}

export async function runAgent0(
  coreWatchlist: WatchlistItem[],
  date: string
): Promise<Agent0Result> {
  const start = Date.now();
  const universe = loadUniverse();
  console.log(`[Agent0] Start — screening ${universe.length} names`);

  // SPY benchmark first — every RS calc needs it.
  const spyBars = await fetchDailyHistory('SPY', '1y');
  if (!spyBars) {
    console.warn('[Agent0] SPY history unavailable — aborting screen (no RS benchmark)');
    return { sleeve: [], ranked: [], screened: 0, skipped: universe.length };
  }
  const spyRet63 = spyReturn63d(spyBars);
  console.log(`[Agent0] SPY 63d return = ${spyRet63.toFixed(1)}%`);

  // Fetch + score the universe with bounded concurrency.
  const meta = new Map(universe.map((u) => [u.ticker, u]));
  let skipped = 0;
  const histories = await mapLimit(
    universe,
    THRESHOLDS.SCREEN_CONCURRENCY,
    async (u) => {
      const bars = await fetchDailyHistory(u.ticker, '1y');
      return { ticker: u.ticker, bars };
    }
  );

  const metrics = [];
  for (const h of histories) {
    if (!h.bars) {
      skipped++;
      continue;
    }
    const m = computeMetrics(h.ticker, h.bars as Bar[], spyRet63);
    if (!m) {
      skipped++;
      continue;
    }
    metrics.push(m);
  }

  const ranked = scoreUniverse(metrics);

  // Exclude names already in the core, and any in post-rotation cooldown.
  const coreSet = new Set(coreWatchlist.map((c) => c.ticker));
  const cooldownSet = tickersInCooldown(COOLDOWN_DAYS, date);

  const sleeve: WatchlistItem[] = [];
  for (const r of ranked) {
    if (sleeve.length >= THRESHOLDS.SLEEVE_SIZE) break;
    if (coreSet.has(r.ticker)) continue;
    if (cooldownSet.has(r.ticker)) continue;
    if (r.momentum_score < THRESHOLDS.MOMENTUM_SCORE_FLOOR) continue;
    const item = meta.get(r.ticker);
    if (item) sleeve.push(item);
  }

  console.log(
    `[Agent0] End — ${metrics.length} scored, ${skipped} skipped, ` +
      `sleeve: ${sleeve.map((s) => s.ticker).join(', ') || '(none above floor)'} ` +
      `(${Date.now() - start}ms)`
  );

  return { sleeve, ranked, screened: metrics.length, skipped };
}

// Allow standalone debugging: `ts-node agents/agent0-momentum-screener.ts`
if (require.main === module) {
  const core = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'watchlist.json'), 'utf-8')
  ) as WatchlistItem[];
  runAgent0(core, new Date().toISOString().slice(0, 10))
    .then((r) => {
      console.log('\nTop 15 momentum board:');
      r.ranked.slice(0, 15).forEach((m, i) => {
        console.log(
          `${String(i + 1).padStart(2)}. ${m.ticker.padEnd(6)} score=${m.momentum_score
            .toFixed(1)
            .padStart(5)}  RSx63=${m.rs_excess_63d.toFixed(1).padStart(6)}  ` +
            `r21=${m.ret_21d.toFixed(1).padStart(6)}  volx=${m.vol_surge.toFixed(2)}  ` +
            `%52wH=${(m.pct_of_52w_high * 100).toFixed(0)}%`
        );
      });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
