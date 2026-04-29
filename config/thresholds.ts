// Centralized numeric thresholds. Never hardcode in agent files —
// import from here so every gate is tuned in one place.

export const THRESHOLDS = {
  BUY_CAP: 3,
  LOW_CONFIDENCE_THRESHOLD: 5,
  TIER_PCT: { 1: 5, 2: 3, 3: 1.5 } as Record<number, number>,
} as const;
