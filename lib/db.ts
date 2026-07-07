// SQLite ledger for StockPilot self-improvement loops (A + C).
// Per Phase 3 captured workflow: BUY-only outcome tracking + watchlist rotation.

import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const DB_PATH = path.join(__dirname, '..', 'data', 'stockpilot.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

// Ordered, idempotent migrations. Each runs at most once per DB, tracked in
// schema_migrations. Append new migrations to the end — never edit a
// migration that has already shipped.
const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE IF NOT EXISTS calls (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        call_date       TEXT    NOT NULL,
        ticker          TEXT    NOT NULL,
        verdict         TEXT    NOT NULL,
        alpha_score     REAL,
        confidence      INTEGER,
        reasoning       TEXT,
        entry_note      TEXT,
        stop_note       TEXT,
        entry_price     REAL,
        spy_entry_price REAL,
        source          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calls_ticker_date  ON calls(ticker, call_date);
      CREATE INDEX IF NOT EXISTS idx_calls_verdict_date ON calls(verdict, call_date);

      CREATE TABLE IF NOT EXISTS outcomes (
        call_id           INTEGER NOT NULL,
        window_days       INTEGER NOT NULL,
        scored_date       TEXT    NOT NULL,
        ticker_return_pct REAL,
        spy_return_pct    REAL,
        excess_return_pct REAL,
        hit               INTEGER,
        PRIMARY KEY (call_id, window_days),
        FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS rotations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        rotation_date TEXT    NOT NULL,
        ticker_out    TEXT    NOT NULL,
        ticker_in     TEXT    NOT NULL,
        reason        TEXT    NOT NULL,
        approved_by   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rotations_out_date ON rotations(ticker_out, rotation_date);
      CREATE INDEX IF NOT EXISTS idx_rotations_in_date  ON rotations(ticker_in, rotation_date);
    `,
  },
  {
    // callExistsForToday already guarded application-level inserts, but
    // nothing stopped a concurrent/duplicate run from double-inserting a
    // (ticker, call_date) pair at the DB level. Enforce it as a constraint.
    version: 2,
    name: 'unique_calls_ticker_date',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_unique_ticker_date
        ON calls(ticker, call_date);
    `,
  },
  {
    // Run/stage bookkeeping so the orchestrator can resume a partially
    // failed run instead of losing all completed stages to logs only.
    version: 3,
    name: 'runs_and_agent_runs',
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_date    TEXT    NOT NULL UNIQUE,
        status      TEXT    NOT NULL DEFAULT 'running',
        started_at  TEXT    NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id      INTEGER NOT NULL,
        agent_name  TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        output_json TEXT,
        error       TEXT,
        started_at  TEXT    NOT NULL,
        finished_at TEXT    NOT NULL,
        PRIMARY KEY (run_id, agent_name),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
    `,
  },
];

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version
    )
  );

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      insertMigration.run(m.version, m.name, new Date().toISOString());
    });
    run();
  }
}

// ---------- Call persistence (Agent 6) ----------

export interface CallRow {
  call_date: string;
  ticker: string;
  verdict: 'BUY' | 'WATCH' | 'SKIP';
  alpha_score: number;
  confidence: number | null;
  reasoning: string;
  entry_note: string;
  stop_note: string;
  entry_price: number | null;
  spy_entry_price: number | null;
  source: string;
}

export function insertCall(row: CallRow): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO calls (call_date, ticker, verdict, alpha_score, confidence,
                       reasoning, entry_note, stop_note, entry_price,
                       spy_entry_price, source)
    VALUES (@call_date, @ticker, @verdict, @alpha_score, @confidence,
            @reasoning, @entry_note, @stop_note, @entry_price,
            @spy_entry_price, @source)
  `);
  const result = stmt.run(row);
  return Number(result.lastInsertRowid);
}

// Idempotency: a single (ticker, call_date) shouldn't be inserted twice
// if the orchestrator runs more than once on the same day.
export function callExistsForToday(ticker: string, callDate: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 FROM calls WHERE ticker = ? AND call_date = ? LIMIT 1`)
    .get(ticker, callDate);
  return !!row;
}

// ---------- Outcome scoring (Agent 7) ----------

export interface PendingScore {
  call_id: number;
  ticker: string;
  call_date: string;
  entry_price: number;
  spy_entry_price: number;
}

// Find BUY calls that need a window scored (window matured, no outcome row yet).
export function pendingScoresForWindow(
  windowDays: number,
  todayIso: string
): PendingScore[] {
  const db = getDb();
  return db
    .prepare(
      `
      SELECT c.id AS call_id, c.ticker, c.call_date,
             c.entry_price, c.spy_entry_price
      FROM   calls c
      LEFT JOIN outcomes o
        ON o.call_id = c.id AND o.window_days = ?
      WHERE  c.verdict = 'BUY'
        AND  c.entry_price IS NOT NULL
        AND  c.spy_entry_price IS NOT NULL
        AND  o.call_id IS NULL
        AND  date(c.call_date, '+' || ? || ' days') <= date(?)
      `
    )
    .all(windowDays, windowDays, todayIso) as PendingScore[];
}

export interface OutcomeRow {
  call_id: number;
  window_days: 5 | 15 | 30;
  scored_date: string;
  ticker_return_pct: number;
  spy_return_pct: number;
  excess_return_pct: number;
  hit: 0 | 1;
}

export function insertOutcome(row: OutcomeRow): void {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO outcomes
      (call_id, window_days, scored_date, ticker_return_pct,
       spy_return_pct, excess_return_pct, hit)
    VALUES (@call_id, @window_days, @scored_date, @ticker_return_pct,
            @spy_return_pct, @excess_return_pct, @hit)
    `
  ).run(row);
}

// ---------- Watchlist health (Agent 8) ----------

export interface TickerHealth {
  ticker: string;
  scored_calls_30d: number;
  hit_rate_30d: number; // 0..1
  buy_signals_last_30d: number;
}

export function computeTickerHealth(
  ticker: string,
  todayIso: string
): TickerHealth {
  const db = getDb();

  // 30d-window outcomes for this ticker's BUY calls
  const stats = db
    .prepare(
      `
      SELECT COUNT(*) AS n, SUM(o.hit) AS hits
      FROM   outcomes o
      JOIN   calls    c ON c.id = o.call_id
      WHERE  c.ticker = ? AND c.verdict = 'BUY' AND o.window_days = 30
      `
    )
    .get(ticker) as { n: number; hits: number | null };

  // Count of BUY signals over the last 30 calendar days
  const signals = db
    .prepare(
      `
      SELECT COUNT(*) AS n
      FROM   calls
      WHERE  ticker = ? AND verdict = 'BUY'
        AND  call_date >= date(?, '-30 days')
      `
    )
    .get(ticker, todayIso) as { n: number };

  const n = stats.n || 0;
  const hits = stats.hits || 0;
  return {
    ticker,
    scored_calls_30d: n,
    hit_rate_30d: n > 0 ? hits / n : 0,
    buy_signals_last_30d: signals.n,
  };
}

// Tickers whose last rotation_out was within `cooldownDays` calendar days.
export function tickersInCooldown(
  cooldownDays: number,
  todayIso: string
): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT DISTINCT ticker_out AS ticker
      FROM   rotations
      WHERE  rotation_date >= date(?, '-' || ? || ' days')
      `
    )
    .all(todayIso, cooldownDays) as { ticker: string }[];
  return new Set(rows.map((r) => r.ticker));
}

// ---------- Run / stage checkpointing (resumability) ----------

export interface RunRow {
  id: number;
  run_date: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

// One run per calendar date. If today's run already exists (e.g. a retry
// after a mid-run crash), reuse it so completed stages can be replayed from
// their checkpoints instead of re-executed.
export function getOrCreateRun(runDate: string): RunRow {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM runs WHERE run_date = ?')
    .get(runDate) as RunRow | undefined;
  if (existing) return existing;

  const result = db
    .prepare(
      `INSERT INTO runs (run_date, status, started_at) VALUES (?, 'running', ?)`
    )
    .run(runDate, new Date().toISOString());
  return db
    .prepare('SELECT * FROM runs WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as RunRow;
}

export function finishRun(runId: number, status: 'ok' | 'failed'): void {
  const db = getDb();
  db.prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    runId
  );
}

export interface AgentRunRow {
  run_id: number;
  agent_name: string;
  status: 'ok' | 'failed';
  output_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string;
}

// Cached output from a previously *successful* stage in this run, if any.
// Failed stages are not returned — they must re-execute on retry.
export function getCheckpoint(runId: number, agentName: string): unknown | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT output_json FROM agent_runs WHERE run_id = ? AND agent_name = ? AND status = 'ok'`
    )
    .get(runId, agentName) as { output_json: string | null } | undefined;
  if (!row || row.output_json == null) return null;
  return JSON.parse(row.output_json);
}

export function recordAgentRun(row: AgentRunRow): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO agent_runs (run_id, agent_name, status, output_json, error, started_at, finished_at)
    VALUES (@run_id, @agent_name, @status, @output_json, @error, @started_at, @finished_at)
    ON CONFLICT(run_id, agent_name) DO UPDATE SET
      status = excluded.status,
      output_json = excluded.output_json,
      error = excluded.error,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at
    `
  ).run(row);
}

export function insertRotation(row: {
  rotation_date: string;
  ticker_out: string;
  ticker_in: string;
  reason: string;
  approved_by: string;
}): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO rotations (rotation_date, ticker_out, ticker_in, reason, approved_by)
    VALUES (@rotation_date, @ticker_out, @ticker_in, @reason, @approved_by)
    `
  ).run(row);
}
