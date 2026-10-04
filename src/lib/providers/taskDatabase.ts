import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { getWorkspacePath } from '../storagePaths';

// Older Vite versions strip node: from this prefix-only Node built-in.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = SQLiteDatabase;

type Connection = { file: string; database: DatabaseSync };
const runtime = globalThis as typeof globalThis & { __workspaceTaskDatabase?: Connection };

export function taskDatabasePath(): string {
  return getWorkspacePath('providers', 'tasks.sqlite');
}

function openDatabase(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA busy_timeout = 2500;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS task_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO task_store_meta VALUES ('revision', '0');
    CREATE TABLE IF NOT EXISTS provider_tasks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      business_date TEXT NOT NULL,
      core TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_account_date ON provider_tasks(account_id, business_date, mode);
    CREATE INDEX IF NOT EXISTS task_date_mode ON provider_tasks(business_date, mode);
    CREATE INDEX IF NOT EXISTS task_status_mode ON provider_tasks(status, mode);
    CREATE INDEX IF NOT EXISTS task_provider_id ON provider_tasks(provider, provider_task_id);
    CREATE INDEX IF NOT EXISTS task_inventory_saved_date ON provider_tasks(
      strftime('%Y-%m-%d', json_extract(summary, '$.inventorySavedAt'), '+8 hours')
    ) WHERE json_extract(summary, '$.inventorySavedAt') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_status_output_count ON provider_tasks(
      status,
      CAST(COALESCE(json_extract(summary, '$.outputCount'), 0) AS INTEGER)
    );
    CREATE INDEX IF NOT EXISTS task_daily_quota ON provider_tasks(
      status,
      mode,
      strftime(
        '%Y-%m-%d',
        COALESCE(NULLIF(json_extract(summary, '$.inventorySavedAt'), ''), updated_at),
        '+8 hours'
      ),
      COALESCE(NULLIF(json_extract(summary, '$.metadata.ownerId'), ''), account_id),
      COALESCE(NULLIF(json_extract(summary, '$.metadata.modelId'), ''), json_extract(summary, '$.model'))
    );
    CREATE TABLE IF NOT EXISTS provider_task_details (
      task_id TEXT PRIMARY KEY REFERENCES provider_tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_worker_lease (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      worker_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_generation_events (
      event_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('image', 'video')),
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('call', 'success', 'restore', 'inventory')),
      event_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_generation_event_date
      ON provider_generation_events(event_at, provider, mode, event_type);
  `);
  if (!database.prepare("SELECT value FROM task_store_meta WHERE key='provider_generation_events_backfill_v1'").get()) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        INSERT OR IGNORE INTO provider_generation_events(event_key,task_id,account_id,mode,provider,event_type,event_at)
          SELECT 'call:' || id,id,account_id,mode,provider,'call',created_at
          FROM provider_tasks WHERE mode IN ('image','video');
        INSERT OR IGNORE INTO provider_generation_events(event_key,task_id,account_id,mode,provider,event_type,event_at)
          SELECT 'success:' || id,id,account_id,mode,provider,'success',
            COALESCE(NULLIF(json_extract(summary,'$.metadata.schedulerFinishedAt'),''),updated_at)
          FROM provider_tasks WHERE mode IN ('image','video') AND status='completed';
        INSERT OR IGNORE INTO provider_generation_events(event_key,task_id,account_id,mode,provider,event_type,event_at)
          SELECT 'inventory:' || id,id,account_id,mode,provider,'inventory',json_extract(summary,'$.inventorySavedAt')
          FROM provider_tasks
          WHERE mode IN ('image','video') AND json_extract(summary,'$.inventorySavedAt') IS NOT NULL;
        INSERT INTO task_store_meta(key,value) VALUES ('provider_generation_events_backfill_v1',datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value;
      `);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return database;
}

export function withTaskDatabase<T>(run: (database: DatabaseSync) => T): T {
  const file = taskDatabasePath();
  // Closing each test connection lets isolated Windows fixtures be removed.
  if (process.env.NODE_ENV === 'test') {
    const database = openDatabase(file);
    try { return run(database); } finally { database.close(); }
  }
  if (!runtime.__workspaceTaskDatabase || runtime.__workspaceTaskDatabase.file !== file) {
    runtime.__workspaceTaskDatabase?.database.close();
    runtime.__workspaceTaskDatabase = { file, database: openDatabase(file) };
  }
  return run(runtime.__workspaceTaskDatabase.database);
}

export function taskTransaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function bumpTaskRevision(database: DatabaseSync): void {
  database.exec("UPDATE task_store_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'");
}

export function closeTaskDatabase(): void {
  runtime.__workspaceTaskDatabase?.database.close();
  delete runtime.__workspaceTaskDatabase;
}
