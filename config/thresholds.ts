// Centralized numeric thresholds. Never hardcode in agent files —
// import from here so every gate is tuned in one place.

export const THRESHOLDS = {
  BUY_CAP: 3,
  LOW_CONFIDENCE_THRESHOLD: 5,
  TIER_PCT: { 1: 5, 2: 3, 3: 1.5 } as Record<number, number>,

  // --- Momentum sleeve (Agent 0) ---
  // How many dynamic momentum slots to add on top of the fixed core each day.
  SLEEVE_SIZE: 6,
  // Minimum composite momentum score (0–100) for a name to earn a sleeve slot.
  // Keeps the sleeve empty on flat/weak tape rather than forcing in junk.
  MOMENTUM_SCORE_FLOOR: 55,
  // Concurrency when fetching the universe from Yahoo.
  SCREEN_CONCURRENCY: 8,

  // --- Repeat-suppression ---
  // After this many consecutive "quiet" runs (neutral + low-confidence) a core
  // ticker is moved out of the main briefing into a collapsed "quiet" line.
  // Any real signal (non-neutral OR confidence ≥ threshold) resets the counter.
  QUIET_SUPPRESS_DAYS: 4,
} as const;
