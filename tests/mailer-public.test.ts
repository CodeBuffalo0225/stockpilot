import { describe, it, expect, vi } from 'vitest';
import {
  composePublicBrief,
  publicSendGate,
  sanitizeSentences,
  sendPublicBrief,
  PUBLIC_STRONG_CAP,
} from '../lib/mailer-public';
import type { ScoredRecord } from '../lib/notion';

function rec(ticker: string, verdict: ScoredRecord['verdict'], reasoning = 'Earnings came in clean.'): ScoredRecord {
  return { ticker, verdict, alpha_score: 7, reasoning, time_horizon: '15d', entry_note: 'n/a', stop_note: 'n/a' };
}

const input = {
  date: '2026-11-02',
  scored: [rec('LLY', 'BUY'), rec('REGN', 'BUY'), rec('VRTX', 'BUY'), rec('AVGO', 'BUY'), rec('XOM', 'WATCH'), rec('MSFT', 'SKIP')],
  thesis: 'Healthcare news led the tape. Allocate 5% to LLY. Momentum names should recover immediately.',
  unansweredCount: 3,
};

describe('sanitizeSentences', () => {
  it('drops directive, sizing, percentage and forecast sentences whole', () => {
    expect(sanitizeSentences('Buy the dip. Trim to 3%. It should recover the hit-rate deficit immediately.')).toBe('');
    expect(sanitizeSentences('Price target $900. Upside is large. Shares will rally.')).toBe('');
  });

  it('keeps plain retrospective sentences', () => {
    expect(sanitizeSentences('Guidance was raised. FDA cleared the label. Will they ship?')).toBe(
      'Guidance was raised. FDA cleared the label.'
    );
  });
});

// Real 2026-11-19 reasoning: one long sentence with decimals and a forecast.
const REAL = [
  'Macro-driven 2.46% decline with no fundamental impairment offers a mild mean-reversion setup but lacks the signal quality or institutional catalyst needed to confidently forecast 3%+ outperformance.',
  'A 3.75% decline on a low-confidence (3/10) bearish signal with no confirmed fundamental catalyst suggests oversold conditions relative to intrinsic value, but the snap-back probability is speculative rather than actionable.',
  'A 1.56% defensive rotation gain with no fundamental catalyst limits upside conviction.',
];

describe('sanitizeSentences on real reasoning', () => {
  it('never leaves a decimal fragment such as "A 1." behind', () => {
    for (const r of REAL) expect(sanitizeSentences(r)).toBe('');
  });

  it('does not split on decimals or abbreviations', () => {
    expect(sanitizeSentences('U.S. regulators approved the label on Tuesday.')).toBe(
      'U.S. regulators approved the label on Tuesday.'
    );
    expect(sanitizeSentences('Revenue was 2.4 billion last quarter. FDA cleared the label.')).toBe(
      'Revenue was 2.4 billion last quarter. FDA cleared the label.'
    );
  });

  it('drops advice wording that the old list missed', () => {
    expect(sanitizeSentences('The highest-conviction play is a defensive trio.')).toBe('');
    expect(sanitizeSentences('Stay disciplined on stops and hold the line today.')).toBe('');
  });
});

describe('composePublicBrief with real reasoning', () => {
  it('shows ticker and label only when nothing publishable survives', () => {
    const { body } = composePublicBrief({
      date: '2026-11-19',
      scored: [rec('MSFT', 'WATCH', REAL[0]), rec('GOOGL', 'WATCH', REAL[1])],
      thesis: 'x',
      unansweredCount: 30,
    });
    expect(body).toContain('- **MSFT** · Watch\n');
    expect(body).not.toMatch(/Watch: /);
    expect(body).not.toMatch(/\b\d\.\s/);
    expect(body).toContain('30 questions the agents');
  });

  it('handles zero and one unanswered question', () => {
    const base = { date: 'd', scored: [], thesis: '' };
    expect(composePublicBrief({ ...base, unansweredCount: 0 }).body).toContain('Nothing left unanswered');
    expect(composePublicBrief({ ...base, unansweredCount: 1 }).body).toContain('1 question the agents');
  });
});

describe('composePublicBrief', () => {
  const { subject, body } = composePublicBrief(input);

  it(`caps Strong at ${PUBLIC_STRONG_CAP} and never shows SKIPs`, () => {
    expect(subject).toBe('StockPilot Daily — 2026-11-02 — LLY, REGN, VRTX');
    expect(body).not.toContain('AVGO');
    expect(body).not.toContain('MSFT');
    expect(body).toContain('**XOM** · Watch');
  });

  it('carries no allocation, percentages, scores or BUY wording', () => {
    expect(body).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(body).not.toMatch(/\bBUY\b|alpha|allocat/i);
    expect(body).not.toContain('recover');
  });

  it('never publishes the thesis paragraph', () => {
    expect(body).not.toContain('The thesis');
    expect(body).not.toContain('Healthcare news led the tape.');
  });

  it('keeps the disclaimer and AI note', () => {
    expect(body).toContain('Not investment advice.');
    expect(body).toContain('Written by AI agents');
    expect(body).toContain("## Couldn't answer\n3 questions the agents couldn't answer. Dig into those first.");
  });
});

describe('publicSendGate / sendPublicBrief', () => {
  it('returns needs_key without a key, never 0 or a guess', () => {
    expect(publicSendGate({})).toEqual({ ready: false, status: 'needs_key' });
  });

  it('refuses until the data sources are licensed', () => {
    expect(publicSendGate({ BUTTONDOWN_API_KEY: 'k' })).toEqual({ ready: false, status: 'data_unlicensed' });
    expect(publicSendGate({ BUTTONDOWN_API_KEY: 'k', PUBLIC_DATA_LICENSED: 'yes' })).toEqual({
      ready: false,
      status: 'data_unlicensed',
    });
  });

  it('defaults to draft and only sends live when asked', () => {
    expect(publicSendGate({ BUTTONDOWN_API_KEY: 'k', PUBLIC_DATA_LICENSED: 'true' })).toMatchObject({ mode: 'draft' });
    expect(
      publicSendGate({ BUTTONDOWN_API_KEY: 'k', PUBLIC_DATA_LICENSED: 'true', PUBLIC_SEND_MODE: 'send' })
    ).toMatchObject({ mode: 'about_to_send' });
  });

  it('does not call Buttondown when gated', async () => {
    const fetchImpl = vi.fn();
    const r = await sendPublicBrief(input, { BUTTONDOWN_API_KEY: 'k' }, fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ status: 'data_unlicensed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a draft when cleared, and fails soft on an API error', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 201 }));
    const env = { BUTTONDOWN_API_KEY: 'k', PUBLIC_DATA_LICENSED: 'true' };
    expect(await sendPublicBrief(input, env, ok as unknown as typeof fetch)).toEqual({ status: 'draft', id: 'em_1' });
    const sent = JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.status).toBe('draft');

    const bad = vi.fn(async () => new Response('nope', { status: 401 }));
    expect(await sendPublicBrief(input, env, bad as unknown as typeof fetch)).toMatchObject({ status: 'error' });
  });
});
