#!/usr/bin/env node
/**
 * record-assessment.mjs — the boss's self-contained work recorder.
 *
 * One shell_exec call per completed unit of work the boss assesses. It:
 *   1. Validates the assessment (enums, caps, PII/shape rules — references/assessment.md).
 *   2. Dedups: skips a same-(type,id) record seen within the last 24h (backstop
 *      for the skill's own dedup discipline; disable with --no-dedup).
 *   3. Appends the record as one JSON line to <DATA>/boss/assessments.jsonl
 *      (append-only source of truth; POSIX-atomic single-line write).
 *   4. Inserts a flat row into <DATA>/boss/assessments.db (Grafana reads this).
 *
 * Modes:
 *   node record-assessment.mjs '<JSON>'     record one unit ( '-' = read JSON from stdin )
 *   node record-assessment.mjs --rebuild    drop+rebuild the SQLite db from the jsonl ledger
 *
 * <DATA> = $BOSS_DATA_DIR, else /data if present, else ~/.prism.
 * No external deps beyond better-sqlite3, which is resolved from the prism
 * runtime's node_modules (the boss runs inside a stock prism sandbox).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const TYPES = ['incident', 'change', 'analysis', 'support', 'maintenance', 'task', 'boss.setup'];
const OUTCOMES = ['resolved', 'delivered', 'mitigated', 'no_action_needed', 'needs_human', 'escalated', 'failed', 'rejected'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const KINDS = ['agent', 'human'];
const OK = new Set(['resolved', 'delivered', 'mitigated', 'no_action_needed']);
const ATTENTION = new Set(['needs_human', 'escalated', 'rejected']);
const INPUT_FIELDS = ['type', 'outcome', 'id', 'performer_id', 'performer_name', 'performer_kind',
  'severity', 'category', 'detected_at', 'duration_ms', 'human_minutes_saved', 'channel', 'attrs', 'summary'];
const MAX_STRING = 128;
const MAX_SUMMARY = 280;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function dataDir() {
  const root = process.env.BOSS_DATA_DIR
    || (fs.existsSync('/data') ? '/data' : path.join(os.homedir(), '.prism'));
  return path.join(root, 'boss');
}

function fail(msg) {
  process.stderr.write(`record-assessment: ${msg}\n`);
  process.exit(1);
}

/** Resolve better-sqlite3 from the prism runtime's node_modules. */
function loadBetterSqlite() {
  const candidates = [
    process.env.BOSS_SQLITE_REQUIRE_BASE,
    process.env.PRISM_APP_DIR && path.join(process.env.PRISM_APP_DIR, 'node_modules'),
    '/app/node_modules',
    path.join(os.homedir(), '.prism', 'node_modules'),
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const req = createRequire(path.join(base, 'noop.js'));
      return req('better-sqlite3');
    } catch { /* try next */ }
  }
  // Last resort: resolve relative to this script (works in local dev checkouts).
  try {
    return createRequire(import.meta.url)('better-sqlite3');
  } catch {
    return null;
  }
}

function statusBucket(outcome) {
  if (OK.has(outcome)) return 'ok';
  if (ATTENTION.has(outcome)) return 'attention';
  return 'failed';
}

function toEpochMs(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const p = Date.parse(value);
    if (!Number.isNaN(p)) return p;
  }
  fail(`"${field}" must be epoch ms or ISO 8601, got ${JSON.stringify(value)}`);
}

function str(value, field, max = MAX_STRING) {
  if (typeof value !== 'string' || value.length === 0) fail(`"${field}" must be a non-empty string`);
  if (value.length > max) fail(`"${field}" exceeds ${max} chars — records carry ids/enums/numbers, not content`);
  return value;
}

function enumField(value, field, allowed) {
  if (!allowed.includes(value)) fail(`"${field}" must be one of: ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
  return value;
}

function normalize(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('input must be a JSON object');
  for (const k of Object.keys(input)) {
    if (!INPUT_FIELDS.includes(k)) fail(`unknown field "${k}" — allowed: ${INPUT_FIELDS.join(', ')}`);
  }
  const r = {};
  r.type = enumField(input.type, 'type', TYPES);
  r.outcome = enumField(input.outcome, 'outcome', OUTCOMES);
  r.id = str(input.id, 'id');
  r.performer_id = str(input.performer_id, 'performer_id');
  r.performer_name = str(input.performer_name, 'performer_name');
  r.performer_kind = enumField(input.performer_kind, 'performer_kind', KINDS);
  if (input.severity !== undefined) r.severity = enumField(input.severity, 'severity', SEVERITIES);
  if (input.category !== undefined) r.category = str(input.category, 'category');
  if (input.channel !== undefined) r.channel = str(input.channel, 'channel');
  if (input.detected_at !== undefined) r.detected_at = toEpochMs(input.detected_at, 'detected_at');
  if (input.duration_ms !== undefined) {
    if (typeof input.duration_ms !== 'number' || !Number.isFinite(input.duration_ms) || input.duration_ms < 0) fail('"duration_ms" must be a non-negative number');
    r.duration_ms = Math.round(input.duration_ms);
  } else if (r.detected_at !== undefined) {
    r.duration_ms = Math.max(0, Date.now() - r.detected_at);
  }
  if (input.human_minutes_saved !== undefined) {
    if (typeof input.human_minutes_saved !== 'number' || !Number.isFinite(input.human_minutes_saved) || input.human_minutes_saved < 0) fail('"human_minutes_saved" must be a non-negative number');
    if (r.performer_kind === 'human' && input.human_minutes_saved > 0) fail('human_minutes_saved must be 0/omitted for human performers (a human\'s work is the labor, not a saving)');
    r.human_minutes_saved = input.human_minutes_saved;
  }
  if (input.summary !== undefined) r.summary = str(input.summary, 'summary', MAX_SUMMARY);
  if (input.attrs !== undefined) {
    if (typeof input.attrs !== 'object' || input.attrs === null || Array.isArray(input.attrs)) fail('"attrs" must be an object');
    const attrs = {};
    for (const [k, v] of Object.entries(input.attrs)) {
      if (!/^[a-z][a-z0-9_.]*$/.test(k)) fail(`attrs key "${k}" must be dotted lowercase`);
      if (typeof v === 'string') str(v, `attrs.${k}`);
      else if (typeof v !== 'number' && typeof v !== 'boolean') fail(`attrs.${k} must be string|number|boolean`);
      attrs[k] = v;
    }
    r.attrs = attrs;
  }
  return r;
}

const COLUMNS = ['record_id', 'ts', 'type', 'outcome', 'status', 'id', 'performer_id', 'performer_name',
  'performer_kind', 'severity', 'category', 'channel', 'detected_at', 'duration_ms', 'human_minutes_saved',
  'evidence_verified', 'summary', 'attrs_json'];

function toRow(rec) {
  const ev = rec.attrs && typeof rec.attrs['evidence.verified'] === 'boolean' ? (rec.attrs['evidence.verified'] ? 1 : 0) : null;
  return {
    record_id: rec.record_id,
    ts: rec.ts,
    type: rec.type,
    outcome: rec.outcome,
    status: statusBucket(rec.outcome),
    id: rec.id,
    performer_id: rec.performer_id,
    performer_name: rec.performer_name,
    performer_kind: rec.performer_kind,
    severity: rec.severity ?? null,
    category: rec.category ?? null,
    channel: rec.channel ?? null,
    detected_at: rec.detected_at ?? null,
    duration_ms: rec.duration_ms ?? null,
    human_minutes_saved: rec.human_minutes_saved ?? null,
    evidence_verified: ev,
    summary: rec.summary ?? null,
    attrs_json: rec.attrs ? JSON.stringify(rec.attrs) : null,
  };
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS assessments (
    record_id TEXT PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, outcome TEXT NOT NULL,
    status TEXT NOT NULL, id TEXT NOT NULL, performer_id TEXT NOT NULL, performer_name TEXT NOT NULL,
    performer_kind TEXT NOT NULL, severity TEXT, category TEXT, channel TEXT, detected_at INTEGER,
    duration_ms INTEGER, human_minutes_saved REAL, evidence_verified INTEGER, summary TEXT, attrs_json TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_assessments_ts ON assessments(ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_assessments_workid ON assessments(id, type);');
}

function insertRow(db, row) {
  const cols = COLUMNS.join(', ');
  const placeholders = COLUMNS.map((c) => `@${c}`).join(', ');
  db.prepare(`INSERT OR REPLACE INTO assessments (${cols}) VALUES (${placeholders})`).run(row);
}

function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const arg = positional[0];
  const rebuild = flags.includes('--rebuild');
  if (!arg && !rebuild) fail("usage: record-assessment.mjs '<JSON>' | - | --rebuild  [--no-dedup]");
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const ledgerPath = path.join(dir, 'assessments.jsonl');
  const dbPath = path.join(dir, 'assessments.db');
  const Database = loadBetterSqlite();

  if (rebuild) {
    if (!Database) fail('better-sqlite3 not resolvable — cannot rebuild the db (ledger is intact)');
    const records = readLedger(ledgerPath);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const db = new Database(dbPath);
    ensureTable(db);
    const insert = db.transaction((recs) => { for (const r of recs) insertRow(db, toRow(r)); });
    insert(records);
    db.close();
    process.stdout.write(`${JSON.stringify({ ok: true, rebuilt: true, rows: records.length })}\n`);
    return;
  }

  const dedup = !flags.includes('--no-dedup');
  const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : arg;
  let input;
  try { input = JSON.parse(raw); } catch (e) { fail(`input is not valid JSON: ${e.message}`); }
  const rec = normalize(input);

  if (dedup) {
    const now = Date.now();
    const dup = readLedger(ledgerPath).some((p) =>
      p.type === rec.type && p.id === rec.id && (now - Date.parse(p.ts)) <= DEDUP_WINDOW_MS);
    if (dup) {
      process.stdout.write(`${JSON.stringify({ ok: true, deduped: true, reason: `same (type,id) within 24h: ${rec.type}/${rec.id}` })}\n`);
      return;
    }
  }

  rec.record_id = crypto.randomUUID();
  rec.ts = new Date().toISOString();
  fs.appendFileSync(ledgerPath, `${JSON.stringify(rec)}\n`);

  const result = { ok: true, recorded: true, record_id: rec.record_id, status: statusBucket(rec.outcome) };
  if (Database) {
    const db = new Database(dbPath);
    ensureTable(db);
    insertRow(db, toRow(rec));
    db.close();
    result.db = true;
  } else {
    result.db = false;
    result.warning = 'better-sqlite3 not resolvable — ledger written, db skipped (run --rebuild once available)';
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
