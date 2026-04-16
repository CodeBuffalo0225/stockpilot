// StockPilot cron entrypoint.
// Schedule per skill: stockpilot-orchestrator — '0 6 * * 1-5' (weekdays, 6AM).

// Force override — parent shell may export empty ANTHROPIC_API_KEY etc.
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import cron from 'node-cron';
import { runOrchestrator } from './orchestrator';
import { sendFailureEmail } from './lib/mailer';

console.log('[StockPilot] Scheduler started — weekdays 6:00 AM');

cron.schedule('0 6 * * 1-5', async () => {
  console.log(`[StockPilot] Run starting: ${new Date().toISOString()}`);
  try {
    await runOrchestrator();
    console.log(`[StockPilot] Run complete: ${new Date().toISOString()}`);
  } catch (e) {
    console.error('[StockPilot] Fatal error:', e);
    await sendFailureEmail(e);
  }
});

// Keep the process alive so cron stays scheduled.
process.stdin.resume();
