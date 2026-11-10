import { db } from './db.ts';

try {
  const row = db.prepare(`SELECT worker_id FROM ai_worker_heartbeats WHERE status='online' AND last_seen_ms>? ORDER BY last_seen_ms DESC LIMIT 1`)
    .get(Date.now() - 30_000);
  db.close();
  process.exit(row ? 0 : 1);
} catch {
  try { db.close(); } catch { /* Database may not have opened. */ }
  process.exit(1);
}
