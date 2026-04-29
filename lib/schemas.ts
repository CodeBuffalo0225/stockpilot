// Shared Zod schemas for all 4 Claude-response agents.
// Import schemas from here — never inline in agent files.

import { z } from 'zod';

// Agent 1 — Perplexity News Puller output
export const TickerBriefSchema = z.object({
  ticker: z.string().min(1).max(5).toUpperCase(),
  headline: z.string().min(10),
  signal: z.enum(['bullish', 'bearish', 'neutral']),
  catalyst: z.string().min(5),
  risk: z.string().min(5),
  price_target_change: z.string().nullable(),
  earnings_note: z.string().nullable(),
  momentum: z.enum(['short', 'medium', 'long']),
  // PATCH 02: drop .int() — Perplexity returns fractional confidence (e.g. 7.5).
  // Floor at the call site after parse.
  confidence: z.number().min(1).max(10),
  source: z.string().optional(),
});
export type TickerBriefValidated = z.infer<typeof TickerBriefSchema>;

// Agent 2 — Question Asker output
export const QuestionOutputSchema = z.object({
  ticker: z.string().min(1).max(5).toUpperCase(),
  questions: z.array(z.string().min(10)).length(3),
  answerable: z.boolean(),
  unanswered_reason: z.string().nullable(),
});
export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;

// Agent 3 — Signal Scorer output (single item; Agent 3 returns an array of these)
export const ScoredTickerSchema = z.object({
  ticker: z.string().min(1).max(5).toUpperCase(),
  verdict: z.enum(['BUY', 'WATCH', 'SKIP']),
  alpha_score: z.number().min(0).max(10),
  reasoning: z.string().min(10),
  time_horizon: z.enum(['30d', '60d', '90d']),
  entry_note: z.string(),
  stop_note: z.string(),
});
export type ScoredTicker = z.infer<typeof ScoredTickerSchema>;

// Agent 4 — Portfolio Allocator output
export const AllocationItemSchema = z.object({
  ticker: z.string().min(1).max(5).toUpperCase(),
  tier: z.number().int().min(1).max(3),
  position_pct: z.number().min(0).max(10),
  entry_note: z.string(),
  stop_loss_note: z.string(),
});
export type AllocationItem = z.infer<typeof AllocationItemSchema>;

export const AllocatorOutputSchema = z.object({
  allocation: z.array(AllocationItemSchema),
  thesis: z.string().min(50),
});
export type AllocatorOutput = z.infer<typeof AllocatorOutputSchema>;
