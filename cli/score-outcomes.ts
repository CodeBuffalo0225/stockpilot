// Runs the outcome scorer on its own (no news pull, no email) and prints the
// per-verdict baseline. Safe to re-run: already-scored windows are skipped.
//
//   npm run score

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { runAgent7 } from '../agents/agent7-outcome-scorer';
import { scoreByVerdict } from '../lib/db';
import { todayIso } from '../lib/prices';

async function main(): Promise<void> {
  const result = await runAgent7(todayIso());
  console.log(JSON.stringify(result));

  const f = (n: number) => n.toFixed(2).padStart(7);
  console.log('\nwindow  verdict      n  avg_ret  avg_spy   excess  beat_spy%');
  for (const r of scoreByVerdict()) {
    console.log(
      `${String(r.window_days).padStart(5)}d  ${r.verdict.padEnd(7)} ${String(r.n).padStart(5)}  ${f(
        r.avg_return_pct
      )}  ${f(r.avg_spy_pct)}  ${f(r.avg_excess_pct)}  ${f(r.beat_spy_pct)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
