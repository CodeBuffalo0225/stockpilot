// Public subscriber edition of the daily brief, posted to Buttondown.
// The private Resend report (lib/mailer.ts) is unchanged; this runs as step 10b.
//
// Two gates, both enforced here rather than left to config discipline:
//   1. BUTTONDOWN_API_KEY must be set            -> otherwise status needs_key
//   2. PUBLIC_DATA_LICENSED must be exactly "true" -> otherwise data_unlicensed
//      Flip it only once Agent 1's news and the price feed come from sources
//      whose terms allow public display. Perplexity scraping and Yahoo do not.
// PUBLIC_SEND_MODE: "draft" (default — Travis reviews and sends in Buttondown)
// or "send". Never throws: the private report has already gone out.
//
// Public format (locked 2026-10-27 handoff): BUY -> "Strong", WATCH -> "Watch",
// no allocation %, no scores, no forecasts, max 3 Strong.

import type { ScoredRecord } from './notion';

export const PUBLIC_STRONG_CAP = 3;
const WATCH_CAP = 5;
const BUTTONDOWN_URL = 'https://api.buttondown.com/v1/emails';

const DISCLAIMER =
  "Not investment advice. Same email goes to everyone. It doesn't know your " +
  'finances. AI gets stuff wrong. Do your own homework. I may own what it mentions.';
const AI_NOTE = 'Written by AI agents from the morning news.';

export interface PublicBriefInput {
  date: string; // YYYY-MM-DD
  scored: ScoredRecord[];
  thesis: string;
  unansweredCount: number;
}

export type PublicGate =
  | { ready: true; mode: 'draft' | 'about_to_send'; key: string }
  | { ready: false; status: 'needs_key' | 'data_unlicensed' };

export type PublicSendResult =
  | { status: 'needs_key' | 'data_unlicensed' }
  | { status: 'draft' | 'about_to_send'; id: string }
  | { status: 'error'; detail: string };

export function publicSendGate(env: NodeJS.ProcessEnv = process.env): PublicGate {
  const key = env.BUTTONDOWN_API_KEY?.trim();
  if (!key) return { ready: false, status: 'needs_key' };
  if (env.PUBLIC_DATA_LICENSED !== 'true') return { ready: false, status: 'data_unlicensed' };
  return { ready: true, mode: env.PUBLIC_SEND_MODE === 'send' ? 'about_to_send' : 'draft', key };
}

// Directives, sizing, return figures and forward-looking claims. A sentence that
// matches any of these is dropped whole — editing words inside a sentence can
// leave garbled or still-misleading text.
const BLOCKED: RegExp[] = [
  /\b(buy|buying|sell|selling|short|accumulate|add to|trim|exit|allocat\w*|position[- ]?siz\w*|sizing|portfolio|stop[- ]loss|entry)\b/i,
  /\b(alpha|outperform\w*|underperform\w*|beat the market|price target|target price|upside|downside|guarantee\w*|risk[- ]free)\b/i,
  /\b(will|should|expect\w*|likely to|poised|set to|on track|going to|forecast\w*|predict\w*|recover\w*|rally|breakout|immediately)\b/i,
  /\d+(\.\d+)?\s*%|\$\s?\d/,
];

export function sanitizeSentences(text: string): string {
  const kept = (text.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s && !BLOCKED.some((re) => re.test(s)));
  return kept.join(' ');
}

export function composePublicBrief(input: PublicBriefInput): { subject: string; body: string } {
  const strong = input.scored.filter((s) => s.verdict === 'BUY').slice(0, PUBLIC_STRONG_CAP);
  const watch = input.scored.filter((s) => s.verdict === 'WATCH').slice(0, WATCH_CAP);

  const subject =
    `StockPilot Daily — ${input.date}` + (strong.length ? ` — ${strong.map((s) => s.ticker).join(', ')}` : '');

  const line = (s: ScoredRecord, label: string) => {
    const why = sanitizeSentences(s.reasoning);
    return `- **${s.ticker}** · ${label}${why ? `: ${why}` : ''}`;
  };
  const thesis = sanitizeSentences(input.thesis);
  const n = input.unansweredCount;

  const body = [
    '## Strong',
    strong.length ? strong.map((s) => line(s, 'Strong')).join('\n') : '_Nothing today._',
    '',
    ...(thesis ? ['## The thesis', thesis, ''] : []),
    ...(watch.length ? ['## Watching', watch.map((s) => line(s, 'Watch')).join('\n'), ''] : []),
    "## Couldn't answer",
    n === 1 ? '1. Dig into that first.' : `${n}. Dig into those first.`,
    '',
    '---',
    `<small>${AI_NOTE} ${DISCLAIMER}</small>`,
  ].join('\n');

  return { subject, body };
}

export async function sendPublicBrief(
  input: PublicBriefInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<PublicSendResult> {
  const gate = publicSendGate(env);
  if (!gate.ready) {
    const why =
      gate.status === 'needs_key'
        ? 'BUTTONDOWN_API_KEY not set'
        : 'PUBLIC_DATA_LICENSED is not "true" — news/price sources are not cleared for public display';
    console.log(`[public-mailer] skipped (${gate.status}): ${why}`);
    return { status: gate.status };
  }

  const { subject, body } = composePublicBrief(input);
  try {
    const res = await fetchImpl(BUTTONDOWN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${gate.key}`,
        'Content-Type': 'application/json',
        'X-API-Version': '2026-04-01',
        ...(gate.mode === 'about_to_send' ? { 'X-Buttondown-Live-Dangerously': 'true' } : {}),
      },
      body: JSON.stringify({ subject, body, status: gate.mode }),
    });
    if (!res.ok) {
      const detail = `Buttondown ${res.status}: ${(await res.text()).slice(0, 300)}`;
      console.error(`[public-mailer] ${detail}`);
      return { status: 'error', detail };
    }
    const json = (await res.json()) as { id?: string };
    console.log(`[public-mailer] ${gate.mode} created: ${json.id ?? '(no id)'}`);
    return { status: gate.mode, id: json.id ?? '' };
  } catch (e) {
    const detail = (e as Error).message;
    console.error(`[public-mailer] request failed: ${detail}`);
    return { status: 'error', detail };
  }
}
