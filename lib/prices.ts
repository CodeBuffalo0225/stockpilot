// FMP price helpers + trading-day math.
// Per Phase 3 captured workflow: free-tier verified endpoints only.
//   • Spot price + change_pct: stable/quote
//   • Historical EOD (light): stable/historical-price-eod/light
// Free-tier caveat: historical-price-eod/light 402s ("Premium Query
// Parameter") for most symbols (SPY is whitelisted). When FMP fails we
// fall back to the keyless Yahoo Finance chart API.

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// US market holidays we care about (2026–2027). Add years as needed.
// Half-days are still counted as trading days.
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
]);

export function isTradingDay(isoDate: string): boolean {
  if (US_MARKET_HOLIDAYS.has(isoDate)) return false;
  const d = new Date(isoDate + 'T12:00:00Z'); // noon UTC avoids DST edge cases
  const dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
  return dow !== 0 && dow !== 6;
}

// Add N trading days to an ISO date, skipping weekends + holidays.
// Negative n steps backwards (e.g., -5 = five trading days earlier).
export function addTradingDays(isoDate: string, n: number): string {
  let cursor = new Date(isoDate + 'T12:00:00Z');
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + step);
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso)) remaining--;
  }
  return cursor.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- FMP wrappers ----------

export interface QuoteSnap {
  price: number;
  change_pct: number;
}

export async function fetchQuoteSnap(ticker: string): Promise<QuoteSnap | null> {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `${FMP_BASE}/quote?symbol=${encodeURIComponent(ticker)}&apikey=${key}`
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as any[];
    const q = arr?.[0];
    if (!q || typeof q.price !== 'number') return null;
    return {
      price: q.price,
      change_pct: typeof q.changePercentage === 'number' ? q.changePercentage : 0,
    };
  } catch {
    return null;
  }
}

// Yahoo-first quote snap. FMP's free tier 402s on most symbols (see the
// module banner), which left Agent 6's SPY entry price null whenever FMP
// was blocked — outcome scoring then had nothing to compare against and
// silently never learned. Yahoo's keyless chart endpoint is the working
// primary everywhere else in this codebase (see marketdata.ts); mirror that
// here and keep FMP as the fallback instead of the other way around.
export async function fetchQuoteSnapCompat(ticker: string): Promise<QuoteSnap | null> {
  const { fetchSpotQuote } = await import('./marketdata');
  const y = await fetchSpotQuote(ticker);
  if (y) return { price: y.price, change_pct: y.change_pct };
  return fetchQuoteSnap(ticker);
}

// ---------- EOD fetch stats (aggregate error visibility) ----------

// Module-level counters so callers (e.g., Agent 7) can log ONE summary line
// like "FMP premium-blocked for N symbols, used Yahoo fallback" instead of
// a per-ticker warning wall. Reset at the start of a run.
export interface EodFetchStats {
  fmp_failed: number; // FMP misses (non-ok / empty / missing key)
  fmp_last_status: number | null; // last non-ok HTTP status (402 = premium-blocked)
  fmp_failed_symbols: string[]; // unique symbols FMP could not serve
  yahoo_fallback: number; // lookups rescued by the Yahoo fallback
  both_failed: number; // lookups where FMP and Yahoo both missed
}

const eodStats: EodFetchStats = {
  fmp_failed: 0,
  fmp_last_status: null,
  fmp_failed_symbols: [],
  yahoo_fallback: 0,
  both_failed: 0,
};

export function resetEodFetchStats(): void {
  eodStats.fmp_failed = 0;
  eodStats.fmp_last_status = null;
  eodStats.fmp_failed_symbols = [];
  eodStats.yahoo_fallback = 0;
  eodStats.both_failed = 0;
}

export function getEodFetchStats(): EodFetchStats {
  return { ...eodStats, fmp_failed_symbols: [...eodStats.fmp_failed_symbols] };
}

// ---------- Yahoo fallback (keyless) ----------

// Politeness throttle: space Yahoo calls ~200ms apart even when callers
// fire lookups concurrently (each caller reserves the next slot).
const YAHOO_DELAY_MS = 200;
let nextYahooSlotAt = 0;

function reserveYahooSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextYahooSlotAt);
  nextYahooSlotAt = at + YAHOO_DELAY_MS;
  return new Promise((resolve) => setTimeout(resolve, at - now));
}

// Yahoo chart API: timestamps are market-open times (unix seconds) and the
// close array can contain nulls. Prefer the exact date match; fallback to
// the nearest close <= isoDate.
async function fetchYahooEodPriceOn(
  ticker: string,
  isoDate: string
): Promise<number | null> {
  try {
    await reserveYahooSlot();
    const from = new Date(isoDate + 'T00:00:00Z');
    from.setUTCDate(from.getUTCDate() - 7);
    const to = new Date(isoDate + 'T00:00:00Z');
    to.setUTCDate(to.getUTCDate() + 1);
    const period1 = Math.floor(from.getTime() / 1000);
    const period2 = Math.floor(to.getTime() / 1000);
    const url = `${YAHOO_BASE}/${encodeURIComponent(
      ticker
    )}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    let best: number | null = null;
    let bestDate = '';
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (typeof close !== 'number') continue; // null gaps happen
      const day = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      if (day === isoDate) return close;
      if (day < isoDate && day > bestDate) {
        best = close;
        bestDate = day;
      }
    }
    return best;
  } catch {
    return null;
  }
}

// FMP attempt only — returns null on any miss so the caller can fall back.
async function fetchFmpEodPriceOn(
  ticker: string,
  isoDate: string
): Promise<number | null> {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  try {
    // Pull a small window around the date so a non-trading isoDate maps
    // to the nearest prior close (right edge of window).
    const from = addTradingDays(isoDate, -5);
    const to = isoDate;
    const url = `${FMP_BASE}/historical-price-eod/light?symbol=${encodeURIComponent(
      ticker
    )}&from=${from}&to=${to}&apikey=${key}`;
    const res = await fetch(url);
    if (!res.ok) {
      eodStats.fmp_last_status = res.status; // 402 = free-tier premium block
      return null;
    }
    const arr = (await res.json()) as any[];
    if (!Array.isArray(arr) || arr.length === 0) return null;

    // Prefer exact date match; fallback to nearest <= date (most recent).
    const exact = arr.find((r) => r.date === isoDate);
    if (exact && typeof exact.price === 'number') return exact.price;

    const sorted = [...arr]
      .filter((r) => typeof r.price === 'number' && r.date <= isoDate)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    return sorted[0]?.price ?? null;
  } catch {
    return null;
  }
}

// Returns the EOD close price for `ticker` on `isoDate`, or null if missing
// (e.g., not a trading day, IPO post-date, both sources gap). Tries FMP
// first (documented Phase 3 source, works for SPY on the free tier), then
// falls back to the Yahoo chart API when FMP misses.
export async function fetchEodPriceOn(
  ticker: string,
  isoDate: string
): Promise<number | null> {
  const fmp = await fetchFmpEodPriceOn(ticker, isoDate);
  if (fmp != null) return fmp;

  eodStats.fmp_failed++;
  if (!eodStats.fmp_failed_symbols.includes(ticker)) {
    eodStats.fmp_failed_symbols.push(ticker);
  }

  const yahoo = await fetchYahooEodPriceOn(ticker, isoDate);
  if (yahoo != null) {
    eodStats.yahoo_fallback++;
    return yahoo;
  }

  eodStats.both_failed++;
  return null;
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}
