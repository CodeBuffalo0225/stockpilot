// FMP price helpers + trading-day math.
// Per Phase 3 captured workflow: free-tier verified endpoints only.
//   • Spot price + change_pct: stable/quote
//   • Historical EOD (light): stable/historical-price-eod/light

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

const FMP_BASE = 'https://financialmodelingprep.com/stable';

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
export function addTradingDays(isoDate: string, n: number): string {
  let cursor = new Date(isoDate + 'T12:00:00Z');
  let remaining = n;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
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

// Returns the EOD close price for `ticker` on `isoDate`, or null if missing
// (e.g., not a trading day, IPO post-date, FMP gap). The light endpoint
// returns most-recent-first, so we filter to exactly the requested date.
export async function fetchEodPriceOn(
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
    if (!res.ok) return null;
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

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}
