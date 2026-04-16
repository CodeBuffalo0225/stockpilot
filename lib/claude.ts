// Anthropic Claude client wrapper.
// Per global build rules: model fixed to 'claude-sonnet-4-20250514' for all calls.

// Force override — parent shell may export empty ANTHROPIC_API_KEY etc.
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface ClaudeCallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

export async function callClaude(opts: ClaudeCallOptions): Promise<string> {
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: opts.maxTokens,
    system: opts.systemPrompt,
    messages: [{ role: 'user', content: opts.userPrompt }],
  });

  const block = res.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no text content');
  }
  return block.text;
}

// Strip preamble/markdown and parse a single JSON object.
export function parseJsonObject<T = unknown>(text: string): T {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found: ${text.slice(0, 200)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

// Strip preamble/markdown and parse a JSON array.
export function parseJsonArray<T = unknown>(text: string): T[] {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON array found: ${text.slice(0, 200)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as T[];
}
