// Resend HTML report sender.
// Subject: "StockPilot — {DATE} — {N} BUYs, {N} WATCHes"
// Sections: BUYs w/ allocation, daily thesis, WATCHes, unanswered count.

import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import { Resend } from 'resend';
import type { AllocationItem, ScoredRecord } from './notion';
import type { Agent8Result } from '../agents/agent8-rotation-suggester';

export interface EmailReport {
  date: string;
  allocation: AllocationItem[];
  scored: ScoredRecord[];
  thesis: string;
  unansweredCount: number;
  rotations?: Agent8Result;
  notionHealthFlag?: string;
}

// Lazy-init so a missing key doesn't crash module load.
let _resend: Resend | null = null;
function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

// Resend's sandbox `from` — works without domain verification; only delivers
// to the account's signup email. Override with REPORT_FROM once you verify a domain.
const DEFAULT_FROM = 'StockPilot <onboarding@resend.dev>';

function buildHtml(r: EmailReport): string {
  const buys = r.scored.filter((s) => s.verdict === 'BUY');
  const watches = r.scored.filter((s) => s.verdict === 'WATCH');

  const buyRows = r.allocation
    .filter((a) => a.tier <= 2)
    .map((a) => {
      const scored = r.scored.find((s) => s.ticker === a.ticker);
      return `
        <tr>
          <td><b>${a.ticker}</b></td>
          <td>${a.position_pct}%</td>
          <td>${scored?.alpha_score ?? ''}</td>
          <td>${a.entry_note}</td>
          <td>${a.stop_loss_note}</td>
        </tr>`;
    })
    .join('');

  const watchRows = watches
    .map(
      (w) => `
        <tr>
          <td><b>${w.ticker}</b></td>
          <td>${w.alpha_score}</td>
          <td>${w.reasoning}</td>
        </tr>`
    )
    .join('');

  return `
  <html>
    <body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;max-width:720px;">
      <h2>StockPilot — ${r.date}</h2>
      <p><b>${buys.length} BUYs</b> · <b>${watches.length} WATCHes</b> · ${r.unansweredCount} unanswered questions logged to Notion</p>

      <h3>1. Today's BUYs</h3>
      ${
        buyRows
          ? `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;">
              <thead>
                <tr style="background:#f3f4f6;"><th>Ticker</th><th>Size</th><th>Alpha</th><th>Entry</th><th>Stop</th></tr>
              </thead>
              <tbody>${buyRows}</tbody>
            </table>`
          : '<p><i>No BUY signals today.</i></p>'
      }

      <h3>2. Daily Thesis</h3>
      <p>${r.thesis}</p>

      <h3>3. WATCHes to Monitor</h3>
      ${
        watchRows
          ? `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;">
              <thead><tr style="background:#f3f4f6;"><th>Ticker</th><th>Alpha</th><th>Reasoning</th></tr></thead>
              <tbody>${watchRows}</tbody>
            </table>`
          : '<p><i>No WATCHes today.</i></p>'
      }

      <h3>4. Unanswered Questions</h3>
      <p>${r.unansweredCount} questions logged to Notion for follow-up research.</p>

      <h3>5. Watchlist Rotation Suggestions</h3>
      ${buildRotationsHtml(r.rotations)}
    </body>
  </html>`;
}

function buildRotationsHtml(rot: Agent8Result | undefined): string {
  if (!rot || rot.flagged === 0) {
    return '<p><i>No tickers flagged — watchlist is healthy.</i></p>';
  }
  if (rot.suggestions.length === 0) {
    return `<p><i>${rot.flagged} ticker(s) flagged but no eligible candidates (all on watchlist or in cooldown).</i></p>`;
  }
  const blocks = rot.suggestions
    .map((s) => {
      const reason =
        s.reason === 'hit_rate_failure'
          ? 'Low 30d hit-rate'
          : 'No BUY signals in 30+ days';
      const cands = s.candidates
        .map(
          (c, i) =>
            `<li><b>${c.ticker}</b> — ${c.rationale}</li>`
        )
        .join('');
      return `
        <div style="margin:10px 0;padding:10px;border-left:3px solid #f59e0b;background:#fffbeb;">
          <p style="margin:0 0 4px 0;"><b>${s.ticker_out}</b> — ${reason}</p>
          <p style="margin:0 0 4px 0;font-size:12px;color:#555;">${s.health_summary}</p>
          <ol style="margin:6px 0 0 20px;padding:0;">${cands}</ol>
        </div>`;
    })
    .join('');
  return `
    ${blocks}
    <p style="font-size:13px;color:#555;">To approve a swap, run <code>npm run rotate</code>.</p>`;
}

export async function sendReportEmail(r: EmailReport): Promise<void> {
  const client = getClient();
  if (!client) {
    console.log('[mailer] RESEND_API_KEY not set — skipping email (report is still saved to reports/).');
    return;
  }
  const to = process.env.REPORT_EMAIL;
  if (!to) {
    console.log('[mailer] REPORT_EMAIL not set — skipping email.');
    return;
  }

  const buys = r.scored.filter((s) => s.verdict === 'BUY').length;
  const watches = r.scored.filter((s) => s.verdict === 'WATCH').length;
  const flagSuffix = r.notionHealthFlag ? ` | ${r.notionHealthFlag}` : '';
  const subject = `StockPilot — ${r.date} — ${buys} BUYs, ${watches} WATCHes${flagSuffix}`;

  const { error } = await client.emails.send({
    from: process.env.REPORT_FROM || DEFAULT_FROM,
    to,
    subject,
    html: buildHtml(r),
  });
  if (error) throw new Error(`Resend error: ${error.name}: ${error.message}`);
}

export async function sendFailureEmail(err: unknown): Promise<void> {
  try {
    const client = getClient();
    if (!client) return; // silently skip — we already logged the run failure elsewhere
    const to = process.env.REPORT_EMAIL;
    if (!to) return;

    const { error } = await client.emails.send({
      from: process.env.REPORT_FROM || DEFAULT_FROM,
      to,
      subject: `StockPilot — FAILED ${new Date().toISOString()}`,
      text: `StockPilot run failed:\n\n${(err as Error)?.stack ?? String(err)}`,
    });
    if (error) throw new Error(`Resend error: ${error.name}: ${error.message}`);
  } catch (e) {
    console.error('[mailer] Failure email also failed:', e);
  }
}
