// Scraper library — Perplexity Finance (Playwright) for headlines,
// FMP /stable/quote for price/change (quote page is Cloudflare-blocked).
// Per skill: stockpilot-news-scraper. Zero API cost on news pull.
// Claude extracts the signal from raw headlines + price context.

// Force override — parent shell may export empty ANTHROPIC_API_KEY etc.
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { chromium, type Browser } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL } from './claude';

export interface TickerBrief {
  ticker: string;
  headline: string;
  signal: 'bullish' | 'bearish' | 'neutral';
  catalyst: string;
  risk: string;
  confidence: number;
  price: string;
  change_pct: string;
  source: 'perplexity' | 'fmp' | 'failed';
}

const DEBUG = process.env.SCRAPER_DEBUG === 'true';

function getAnthropicClient(): Anthropic {
  // Lazy — must run AFTER dotenv.config so process.env is populated.
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------- FMP stable/quote (free tier — price + change only) ----------

interface FMPQuote {
  price: string;
  change_pct: string;
}

export async function fetchFMPQuote(ticker: string): Promise<FMPQuote | null> {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(
      `https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${key}`
    );
    if (!res.ok) {
      console.error(`[FMP] Quote HTTP ${res.status} for ${ticker}`);
      return null;
    }
    const arr = (await res.json()) as any[];
    const q = arr?.[0];
    if (!q) return null;

    const price = q.price?.toString() ?? 'unknown';
    const rawPct = q.changePercentage;
    const change_pct =
      typeof rawPct === 'number'
        ? `${rawPct > 0 ? '+' : ''}${rawPct.toFixed(2)}%`
        : 'unknown';
    return { price, change_pct };
  } catch (err) {
    console.error(`[FMP] Quote failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}

// ---------- Claude signal extractor ----------

async function extractSignalFromHeadlines(
  ticker: string,
  headlines: string[],
  price: string | null,
  change: string | null
): Promise<Omit<TickerBrief, 'source'>> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 200,
    system:
      'You are a financial signal extractor. Return ONLY valid JSON. No preamble.',
    messages: [
      {
        role: 'user',
        content: `Ticker: ${ticker}
Today's headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}
Price: ${price || 'unknown'}
Change: ${change || 'unknown'}

Return JSON:
{
  "ticker": "${ticker}",
  "headline": "One sentence — the single most important signal today",
  "signal": "bullish | bearish | neutral",
  "catalyst": "What specifically is driving this",
  "risk": "Biggest near-term risk",
  "confidence": 1-10,
  "price": "${price || 'unknown'}",
  "change_pct": "${change || 'unknown'}"
}`,
      },
    ],
  });

  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no text');
  }
  const text = block.text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON in extractor response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- Source 1: Perplexity Finance via Playwright ----------

async function scrapeOnce(
  ticker: string,
  browser: Browser
): Promise<TickerBrief | null> {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Perplexity holds long-poll connections → 'networkidle' never fires.
    // Use 'domcontentloaded' + a small post-load settle.
    await page.goto(`https://www.perplexity.ai/finance/${ticker}/news`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    if (DEBUG) {
      const sample = await page.evaluate(() =>
        document.body.innerText.slice(0, 2000)
      );
      console.log(
        `[Scraper:debug] ${ticker} news page sample:\n${sample}\n---`
      );
    }

    const headlines = await page.$$eval(
      'article, [data-testid*="news"], .news-item, h3, h2',
      (els) =>
        els
          .map((el) => el.textContent?.trim() ?? '')
          .filter((t) => t && t.length > 20 && t.length < 300)
          .slice(0, 5)
    );

    await context.close();

    if (!headlines.length) return null;

    // Quote page is Cloudflare-blocked → use FMP stable/quote instead.
    const quote = await fetchFMPQuote(ticker);

    const brief = await extractSignalFromHeadlines(
      ticker,
      headlines,
      quote?.price ?? null,
      quote?.change_pct ?? null
    );
    return { ...brief, source: 'perplexity' };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// One retry with a fresh browser context per build rule #7.
export async function scrapePerplexityFinance(
  ticker: string
): Promise<TickerBrief | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    try {
      return await scrapeOnce(ticker, browser);
    } catch (err) {
      console.warn(
        `[Scraper] ${ticker} first attempt failed, retrying:`,
        (err as Error).message
      );
      return await scrapeOnce(ticker, browser);
    }
  } catch (err) {
    console.error(
      `[Scraper] Perplexity Finance failed for ${ticker}:`,
      (err as Error).message
    );
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- Source 2: FMP-only fallback (no news on free tier) ----------
// If Perplexity scrape returns no headlines, we can still surface a
// neutral "price-only" brief so Agent 3 has something to score. Uses the
// quote endpoint (free) and synthesizes a minimal headline.
export async function fetchFMPBrief(ticker: string): Promise<TickerBrief | null> {
  const quote = await fetchFMPQuote(ticker);
  if (!quote) return null;

  const synthHeadline = `${ticker} quote-only fallback: ${quote.price} (${quote.change_pct})`;

  try {
    const brief = await extractSignalFromHeadlines(
      ticker,
      [synthHeadline],
      quote.price,
      quote.change_pct
    );
    return { ...brief, source: 'fmp' };
  } catch (err) {
    console.error(`[FMP] Extractor failed for ${ticker}:`, (err as Error).message);
    return null;
  }
}
