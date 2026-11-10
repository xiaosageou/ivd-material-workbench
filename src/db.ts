import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertIsolatedTestDataDir } from './test-isolation.mjs';

assertIsolatedTestDataDir();

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
export const databasePath = path.join(dataDir, 'ivd.sqlite');
export const attachmentDir = path.join(dataDir, 'attachments');
export const backupDir = path.join(dataDir, 'backups');
mkdirSync(attachmentDir, { recursive: true });
mkdirSync(backupDir, { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
let current = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version ?? 0);
if (current < 1) {
  db.exec(readFileSync(path.resolve('migrations/001_init.sql'), 'utf8'));
  db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(1);
  current = 1;
}
if (current < 2) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/002_revision.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(2);
    db.exec('COMMIT');
    current = 2;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 3) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/003_abort_actor.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(3);
    db.exec('COMMIT');
    current = 3;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 4) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/004_research_reports.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(4);
    db.exec('COMMIT');
    current = 4;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 5) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/005_research_assistant.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(5);
    db.exec('COMMIT');
    current = 5;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 6) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/006_research_observation_lineage.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(6);
    db.exec('COMMIT');
    current = 6;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 7) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/007_research_datasets.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(7);
    db.exec('COMMIT');
    current = 7;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 8) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/008_ai_job_token_usage.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(8);
    db.exec('COMMIT');
    current = 8;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 9) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/009_literature_library.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(9);
    db.exec('COMMIT');
    current = 9;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 10) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/010_literature_query_usage.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(10);
    db.exec('COMMIT');
    current = 10;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 11) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/011_recipe_target_ph.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(11);
    db.exec('COMMIT');
    current = 11;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (current < 12) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/012_report_knowledge_vector_jobs.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(12);
    db.exec('COMMIT');
    current = 12;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (current < 13) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/013_registration.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(13);
    db.exec('COMMIT');
    current = 13;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (current < 14) {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/014_literature_file_formats.sql'), 'utf8'));
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('文献文件迁移后关联校验失败');
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(14);
    db.exec('COMMIT');
    current = 14;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}

if (current < 15) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(readFileSync(path.resolve('migrations/015_vector_literature.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(15);
    db.exec('COMMIT'); current = 15;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (current < 16) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const versions = db.prepare('SELECT id,original_name FROM literature_file_versions').all() as Array<{id: string; original_name: string}>;
    const update = db.prepare('UPDATE literature_file_versions SET original_name=? WHERE id=?');
    for (const version of versions) {
      const name = version.original_name;
      if (![...name].every(char => char.codePointAt(0)! <= 255) || !/[\u0080-\u00ff]/.test(name)) continue;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
        if (/[\u3400-\u9fff]/u.test(decoded) && !/[\u0000-\u001f\u007f]/.test(decoded)) update.run(decoded, version.id);
      } catch { /* Not UTF-8 decoded as Latin-1: preserve the original. */ }
    }
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(16);
    db.exec('COMMIT'); current = 16;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function transaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function id(prefix = ''): string {
  return `${prefix}${randomUUID()}`;
}
