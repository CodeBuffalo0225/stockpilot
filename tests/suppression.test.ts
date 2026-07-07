import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { updateSuppression } from '../lib/suppression';
import type { TickerBrief } from '../lib/scraper';

function brief(
  ticker: string,
  signal: TickerBrief['signal'],
  confidence: number
): TickerBrief {
  return {
    ticker,
    headline: 'test headline',
    signal,
    catalyst: 'test catalyst',
    risk: 'test risk',
    confidence,
    price: '100',
    change_pct: '+0.00%',
    source: 'perplexity',
  };
}

describe('updateSuppression (quiet-streak repeat suppression)', () => {
  let statePath: string;

  beforeEach(() => {
    statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-')), 'state.json');
  });

  afterEach(() => {
    if (fs.existsSync(statePath)) fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  });

  it('does not suppress on the first quiet day', () => {
    const core = new Set(['MSFT']);
    const result = updateSuppression([brief('MSFT', 'neutral', 3)], core, '2026-01-01', statePath);
    expect(result.suppressed).toEqual([]);
    expect(result.streaks.MSFT).toBe(1);
  });

  it('suppresses once the quiet streak crosses QUIET_SUPPRESS_DAYS (4)', () => {
    const core = new Set(['MSFT']);
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    let result;
    for (const date of dates) {
      result = updateSuppression([brief('MSFT', 'neutral', 3)], core, date, statePath);
    }
    expect(result!.streaks.MSFT).toBe(4);
    expect(result!.suppressed).toEqual(['MSFT']);
  });

  it('resets the streak the moment a real signal (non-neutral) appears', () => {
    const core = new Set(['MSFT']);
    updateSuppression([brief('MSFT', 'neutral', 3)], core, '2026-01-01', statePath);
    updateSuppression([brief('MSFT', 'neutral', 3)], core, '2026-01-02', statePath);
    const result = updateSuppression([brief('MSFT', 'bullish', 3)], core, '2026-01-03', statePath);
    expect(result.streaks.MSFT).toBe(0);
    expect(result.suppressed).toEqual([]);
  });

  it('resets the streak when confidence rises above the low-confidence threshold', () => {
    const core = new Set(['MSFT']);
    updateSuppression([brief('MSFT', 'neutral', 3)], core, '2026-01-01', statePath);
    const result = updateSuppression([brief('MSFT', 'neutral', 8)], core, '2026-01-02', statePath);
    expect(result.streaks.MSFT).toBe(0);
  });

  it('never suppresses tickers outside the core set (momentum sleeve names)', () => {
    const core = new Set(['MSFT']);
    let result;
    for (let i = 0; i < 5; i++) {
      result = updateSuppression(
        [brief('SLEEVE', 'neutral', 3)],
        core,
        `2026-01-0${i + 1}`,
        statePath
      );
    }
    expect(result!.suppressed).toEqual([]);
    expect(result!.streaks.SLEEVE).toBeUndefined();
  });
});
