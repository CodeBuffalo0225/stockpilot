// Agent 1 — Scraper (v2). Replaces agent1-news-puller.ts.
// Per skill: stockpilot-news-scraper.
// Playwright runs SERIAL with 2s delay (avoid bot detection).
// FMP fallback fires if Perplexity Finance returns nothing.

// Force override — parent shell may export empty ANTHROPIC_API_KEY etc.
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as path from 'path';

import {
  scrapePerplexityFinance,
  fetchFMPBrief,
  type TickerBrief,
} from '../lib/scraper';

export type { TickerBrief } from '../lib/scraper';

export interface WatchlistItem {
  ticker: string;
  name: string;
  sector: string;
}

export async function runAgent1(
  watchlist: WatchlistItem[]
): Promise<TickerBrief[]> {
  console.log(`[Agent1] Start — ${watchlist.length} tickers`);
  const start = Date.now();

  const briefs: TickerBrief[] = [];

  for (const stock of watchlist) {
    const ticker = stock.ticker;
    console.log(`[Agent1] Scraping ${ticker}...`);

    try {
      // Primary: Perplexity Finance via Playwright
      let brief = await scrapePerplexityFinance(ticker);

      // Fallback: FMP free tier
      if (!brief) {
        console.log(`[Agent1] ${ticker} — Perplexity empty, trying FMP...`);
        brief = await fetchFMPBrief(ticker);
      }

      if (brief) {
        briefs.push(brief);
        console.log(
          `[Agent1] ${ticker} ok — ${brief.signal} (source: ${brief.source})`
        );
      } else {
        console.log(`[Agent1] ${ticker} skipped — both sources failed`);
      }
    } catch (err) {
      console.error(`[Agent1] ${ticker} unexpected error:`, (err as Error).message);
    }

    // Polite delay between Playwright runs to avoid rate-limiting / detection.
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(
    `[Agent1] End — ${briefs.length}/${watchlist.length} ok (${Date.now() - start}ms)`
  );
  return briefs;
}

// Standalone debug entrypoint: `npm run debug-scraper` or `ts-node agents/agent1-scraper.ts`
if (require.main === module) {
  const watchlistPath = path.join(__dirname, '..', 'data', 'watchlist.json');
  const watchlist: WatchlistItem[] = JSON.parse(
    fs.readFileSync(watchlistPath, 'utf-8')
  );
  runAgent1(watchlist)
    .then((briefs) => {
      console.log('\n[Debug] Final briefs:');
      console.log(JSON.stringify(briefs, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error('[Debug] Fatal:', e);
      process.exit(1);
    });
}
