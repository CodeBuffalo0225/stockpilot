// Momentum / relative-strength scoring — the "ROI radar" layer.
// Ian-Dunlap-style emphasis: relative strength vs the index leads, recent
// price thrust + volume participation + proximity to highs confirm.
//
// Raw metrics are computed per ticker from daily bars; the composite is a
// percentile-rank blend across the screened universe (scale-robust, 0–100).

import type { Bar } from './marketdata';

export interface MomentumMetrics {
  ticker: string;
  last_close: number;
  ret_21d: number; // % return, ~1 month
  ret_63d: number; // % return, ~3 months
  rs_excess_63d: number; // stock 63d return minus SPY 63d return (pts)
  vol_surge: number; // avg vol last 5d / avg vol prior 30d
  pct_of_52w_high: number; // last close / 252d high (0..1+)
}

// Composite weights — RS leads (Dunlap), thrust + participation confirm.
export const MOMENTUM_WEIGHTS = {
  rs_excess_63d: 0.4,
  ret_21d: 0.25,
  vol_surge: 0.2,
  pct_of_52w_high: 0.15,
} as const;

function pctReturn(bars: Bar[], lookback: number): number | null {
  if (bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1].close;
  const past = bars[bars.length - 1 - lookback].close;
  if (!past) return null;
  return ((last - past) / past) * 100;
}

function avgVolume(bars: Bar[], window: number, offsetFromEnd = 0): number | null {
  const end = bars.length - offsetFromEnd;
  const start = end - window;
  if (start < 0) return null;
  const slice = bars.slice(start, end);
  if (!slice.length) return null;
  return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

// Compute raw momentum metrics for one ticker. Returns null if insufficient
// history (needs ~3 months minimum). `spyRet63` is SPY's 63d return for RS.
export function computeMetrics(
  ticker: string,
  bars: Bar[],
  spyRet63: number
): MomentumMetrics | null {
  if (bars.length < 64) return null;
  const ret21 = pctReturn(bars, 21);
  const ret63 = pctReturn(bars, 63);
  if (ret21 == null || ret63 == null) return null;

  const vol5 = avgVolume(bars, 5);
  const vol30 = avgVolume(bars, 30, 5); // prior 30d, excluding the last 5d
  const volSurge = vol5 != null && vol30 ? vol5 / vol30 : 1;

  const window52w = bars.slice(-252);
  const high52w = Math.max(...window52w.map((b) => b.high));
  const lastClose = bars[bars.length - 1].close;
  const pctOfHigh = high52w ? lastClose / high52w : 0;

  return {
    ticker,
    last_close: lastClose,
    ret_21d: ret21,
    ret_63d: ret63,
    rs_excess_63d: ret63 - spyRet63,
    vol_surge: volSurge,
    pct_of_52w_high: pctOfHigh,
  };
}

// SPY 63d return helper (used as the RS benchmark).
export function spyReturn63d(spyBars: Bar[]): number {
  return pctReturn(spyBars, 63) ?? 0;
}

export interface ScoredMomentum extends MomentumMetrics {
  momentum_score: number; // 0..100 composite percentile blend
}

// Percentile rank of `value` within `arr` (0..1). Higher value = higher rank.
function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length <= 1) return 0.5;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  return below / (sorted.length - 1);
}

// Blend raw metrics into a 0–100 composite via cross-sectional percentile ranks.
export function scoreUniverse(metrics: MomentumMetrics[]): ScoredMomentum[] {
  if (metrics.length === 0) return [];
  const sortedRS = metrics.map((m) => m.rs_excess_63d).sort((a, b) => a - b);
  const sorted21 = metrics.map((m) => m.ret_21d).sort((a, b) => a - b);
  const sortedVol = metrics.map((m) => m.vol_surge).sort((a, b) => a - b);
  const sortedHigh = metrics.map((m) => m.pct_of_52w_high).sort((a, b) => a - b);

  return metrics
    .map((m) => {
      const blend =
        MOMENTUM_WEIGHTS.rs_excess_63d * percentileRank(m.rs_excess_63d, sortedRS) +
        MOMENTUM_WEIGHTS.ret_21d * percentileRank(m.ret_21d, sorted21) +
        MOMENTUM_WEIGHTS.vol_surge * percentileRank(m.vol_surge, sortedVol) +
        MOMENTUM_WEIGHTS.pct_of_52w_high *
          percentileRank(m.pct_of_52w_high, sortedHigh);
      return { ...m, momentum_score: Math.round(blend * 1000) / 10 };
    })
    .sort((a, b) => b.momentum_score - a.momentum_score);
}
