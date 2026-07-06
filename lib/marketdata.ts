// Market data layer — Yahoo Finance v8 chart API (keyless, free).
// Replaces the gated FMP free tier for momentum/RS screening.
//
//   • fetchDailyHistory(ticker, range) → OHLCV daily bars
//   • fetchSpotQuote(ticker)           → {price, change_pct}
//   • mapLimit()                       → bounded-concurrency batch helper
//
// Yahoo returns null bars on non-trading slots; we filter those out.
// All functions return null on failure — never throw — so a single bad
// ticker can't crash a screen over hundreds of names.

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export interface Bar {
  date: string; // ISO yyyy-mm-dd (US/Eastern session date)
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface SpotQuote {
  price: number;
  change_pct: number;
}

export type YahooRange = '1mo' | '3mo' | '6mo' | '1y' | '2y';

async function yahooFetch(url: string, attempts = 3): Promise<any | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429) {
        // Rate limited — back off and retry.
        await sleep(800 * (i + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(300 * (i + 1));
    }
  }
  return null;
}

// Daily OHLCV history. `range` controls lookback window.
export async function fetchDailyHistory(
  ticker: string,
  range: YahooRange = '1y'
): Promise<Bar[] | null> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(
    ticker
  )}?range=${range}&interval=1d`;
  const json = await yahooFetch(url);
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp || !result?.indicators?.quote?.[0]) return null;

  const ts: number[] = result.timestamp;
  const q = result.indicators.quote[0];
  const closes: (number | null)[] = q.close ?? [];
  const highs: (number | null)[] = q.high ?? [];
  const lows: (number | null)[] = q.low ?? [];
  const vols: (number | null)[] = q.volume ?? [];

  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null) continue; // skip null (non-trading / bad) bars
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      close,
      high: highs[i] ?? close,
      low: lows[i] ?? close,
      volume: vols[i] ?? 0,
    });
  }
  return bars.length ? bars : null;
}

// Spot price + intraday change %. Pulled from the chart meta block.
export async function fetchSpotQuote(ticker: string): Promise<SpotQuote | null> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
  const json = await yahooFetch(url);
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  const prev =
    typeof meta.chartPreviousClose === 'number'
      ? meta.chartPreviousClose
      : typeof meta.previousClose === 'number'
      ? meta.previousClose
      : meta.regularMarketPrice;
  const change_pct = prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0;
  return { price: meta.regularMarketPrice, change_pct };
}

// Bounded-concurrency map — keeps Yahoo happy while screening a large universe.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
