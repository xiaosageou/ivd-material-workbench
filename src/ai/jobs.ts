import { createHash, randomUUID } from 'node:crypto';
import { db, id, transaction } from '../db.ts';
import { getAiConfig } from './config.ts';

export type Row = Record<string, any>;
export function hasCurrentJobLease(job: Row, allowCancellation = false) {
  const owner = String(job.lease_owner || '');
  const attempt = Number(job.attempt_count || 0);
  if (!owner || !Number.isSafeInteger(attempt) || attempt < 1) return false;
  const current = db.prepare('SELECT lease_owner,attempt_count,lease_until_ms,status,cancel_requested FROM ai_jobs WHERE id=?').get(job.id) as Row | undefined;
  return Boolean(current && String(current.lease_owner || '') === owner && Number(current.attempt_count) === attempt
    && Number(current.lease_until_ms || 0) > Date.now() && current.status !== 'cancelled'
    && (allowCancellation || Number(current.cancel_requested) === 0));
}

export function assertCurrentJobLease(job: Row) {
  if (job.lease_owner && !hasCurrentJobLease(job)) throw new Error('AI 任务租约已失效，拒绝旧 Worker 写回');
}

export type ReportInput = {
  kind: 'report_version' | 'data_attachment_version';
  id: string;
  content_sha256: string;
  storage_key: string;
  original_name: string;
  extension: string;
  size_bytes: number;
};
export type ReportManifest = {
  reportId: string;
  title: string;
  description: string;
  reportVersionId: string;
  sources: ReportInput[];
  fingerprint: string;
};

const fingerprintOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function enqueueReportEvent(reportId: string, eventType: string, actorId: string | null, payload: Row = {}, delayMs = Number(process.env.IVD_AI_COALESCE_MS ?? 30_000)) {
  const now = Date.now();
  db.prepare(`INSERT INTO ai_outbox_events(id,event_type,report_id,actor_id,payload_json,available_at_ms)
    VALUES (?,?,?,?,?,?)`).run(id('aie_'), eventType, reportId, actorId, JSON.stringify(payload), now + Math.max(0, delayMs));
}

export function currentReportManifest(reportId: string): ReportManifest | undefined {
  const report = db.prepare('SELECT id,title,description FROM research_reports WHERE id=? AND deleted_at IS NULL').get(reportId) as Row | undefined;
  if (!report) return undefined;
  const reportVersion = db.prepare(`SELECT id,original_name,storage_key,extension,size_bytes,sha256 AS content_sha256
    FROM research_report_versions WHERE report_id=? ORDER BY version_no DESC LIMIT 1`).get(reportId) as Row | undefined;
  if (!reportVersion) return undefined;
  const rawVersions = db.prepare(`SELECT a.id AS attachment_id,v.id,v.original_name,v.storage_key,v.extension,v.size_bytes,v.sha256 AS content_sha256
    FROM research_report_data_attachments a JOIN research_report_data_versions v ON v.attachment_id=a.id
    WHERE a.report_id=? AND a.deleted_at IS NULL AND v.version_no=(SELECT MAX(v2.version_no) FROM research_report_data_versions v2 WHERE v2.attachment_id=a.id)
    ORDER BY a.id`).all(reportId) as Row[];
  const sources: ReportInput[] = [
    { kind: 'report_version', id: reportVersion.id, content_sha256: reportVersion.content_sha256, storage_key: reportVersion.storage_key,
      original_name: reportVersion.original_name, extension: reportVersion.extension, size_bytes: Number(reportVersion.size_bytes) },
    ...rawVersions.map(row => ({ kind: 'data_attachment_version' as const, id: String(row.id), content_sha256: String(row.content_sha256),
      storage_key: String(row.storage_key), original_name: String(row.original_name), extension: String(row.extension), size_bytes: Number(row.size_bytes) })),
  ];
  const contentFingerprint = fingerprintOf({ reportId, description: report.description, sources: sources.map(({ kind, id, content_sha256 }) => ({ kind, id, content_sha256 })) });
  return { reportId: String(report.id), title: String(report.title), description: String(report.description), reportVersionId: String(reportVersion.id), sources,
    fingerprint: contentFingerprint };
}

export function writeJobFromManifest(reportId: string, actorId: string | null, manifest: ReportManifest, runKey = 'auto') {
  const jobId = id('aij_');
  const status = process.env.IVD_AI_API_KEY ? 'queued' : 'queued';
  const result = db.prepare(`INSERT OR IGNORE INTO ai_jobs(id,job_type,report_id,requested_by,input_fingerprint,input_manifest_json,run_key,status,
      provider,model,budget_tokens,timeout_ms)
    VALUES (?,'report_analysis',?,?,?,?,?,?,?,?,?,?)`).run(jobId, reportId, actorId, manifest.fingerprint,
    JSON.stringify({ reportId: manifest.reportId, title: manifest.title, description: manifest.description, reportVersionId: manifest.reportVersionId,
      sources: manifest.sources.map(source => ({ ...source })) }), runKey, status,
    process.env.IVD_AI_PROVIDER || null, process.env.IVD_AI_MODEL || null,
    getAiConfig().taskTokenBudget, Number(process.env.IVD_AI_TIMEOUT_MS || 90000));
  const stored = result.changes ? jobId : String((db.prepare(`SELECT id FROM ai_jobs WHERE job_type='report_analysis' AND input_fingerprint=? AND run_key=?`).get(manifest.fingerprint, runKey) as Row).id);
  if (result.changes) {
    const insert = db.prepare(`INSERT INTO ai_job_inputs(job_id,position,input_kind,source_id,content_sha256,storage_key,original_name,source_json)
      VALUES (?,?,?,?,?,?,?,?)`);
    manifest.sources.forEach((source, index) => insert.run(stored, index, source.kind, source.id, source.content_sha256, source.storage_key,
      source.original_name, JSON.stringify({ extension: source.extension, sizeBytes: source.size_bytes })));
    appendJobEvent(stored, 'queued', '已生成报告分析任务', { inputCount: manifest.sources.length, fingerprint: manifest.fingerprint });
  }
  return { id: stored, inserted: Boolean(result.changes) };
}

export function enqueueManualReportJob(reportId: string, actorId: string) {
  const manifest = currentReportManifest(reportId);
  if (!manifest) return undefined;
  return transaction(() => writeJobFromManifest(reportId, actorId, manifest, `manual:${randomUUID()}`));
}

export function appendJobEvent(jobId: string, eventType: string, message: string, metadata: Row = {}) {
  const sequence = Number((db.prepare('SELECT COALESCE(MAX(sequence_no),0)+1 AS n FROM ai_job_events WHERE job_id=?').get(jobId) as Row).n);
  db.prepare(`INSERT INTO ai_job_events(id,job_id,sequence_no,event_type,message,metadata_json) VALUES (?,?,?,?,?,?)`)
    .run(id('aije_'), jobId, sequence, eventType, message.slice(0, 1000), JSON.stringify(metadata));
}

export function appendLeasedJobEvent(job: Row, eventType: string, message: string, metadata: Row = {}) {
  const result = db.prepare(`INSERT INTO ai_job_events(id,job_id,sequence_no,event_type,message,metadata_json)
    SELECT ?,?,(SELECT COALESCE(MAX(sequence_no),0)+1 FROM ai_job_events WHERE job_id=?),?,?,?
    WHERE EXISTS (SELECT 1 FROM ai_jobs WHERE id=? AND lease_owner=? AND attempt_count=? AND lease_until_ms>?
      AND cancel_requested=0 AND status!='cancelled')`)
    .run(id('aije_'), job.id, job.id, eventType, message.slice(0, 1000), JSON.stringify(metadata), job.id, job.lease_owner, job.attempt_count, Date.now());
  return result.changes > 0;
}

export function invalidateDeletedReport(reportId: string) {
  const activeJobs = db.prepare(`SELECT id FROM ai_jobs WHERE report_id=? AND status IN ('queued','waiting_configuration','parsing','analyzing','validating')`).all(reportId) as Row[];
  db.prepare(`UPDATE ai_jobs SET status='cancelled',cancel_requested=1,finished_at=datetime('now'),updated_at=datetime('now'),
      error_code='source_deleted',error_message='报告来源已删除' WHERE report_id=? AND status IN ('queued','waiting_configuration','parsing','analyzing','validating')`).run(reportId);
  for (const job of activeJobs) appendJobEvent(String(job.id), 'cancelled', '报告来源已删除，任务结果将不再发布');
  db.prepare("UPDATE research_analyses SET status='invalidated' WHERE report_id=? AND status IN ('completed','partial','needs_review')").run(reportId);
  db.prepare("UPDATE research_observations SET review_state='invalidated',updated_at=datetime('now') WHERE report_id=? AND review_state!='invalidated'").run(reportId);
}

export function consumeOutbox(limit = 100, forceReady = false) {
  return transaction(() => {
    const now = Date.now();
    const events = db.prepare(`SELECT * FROM ai_outbox_events WHERE processed_at IS NULL AND (?=1 OR available_at_ms<=?)
      ORDER BY available_at_ms,id LIMIT ?`).all(forceReady ? 1 : 0, now, limit) as Row[];
    const grouped = new Map<string, Row[]>();
    for (const event of events) grouped.set(String(event.report_id), [...(grouped.get(String(event.report_id)) || []), event]);
    for (const [reportId, group] of grouped) {
      const latestEvent = group[group.length - 1];
      if (group.some(event => event.event_type === 'report.deleted')) {
        invalidateDeletedReport(reportId);
      } else {
        const manifest = currentReportManifest(reportId);
        if (!manifest) invalidateDeletedReport(reportId);
        else if (getAiConfig().autoArchive) writeJobFromManifest(reportId, latestEvent.actor_id ? String(latestEvent.actor_id) : null, manifest, 'auto');
      }
      const mark = db.prepare('UPDATE ai_outbox_events SET processed_at=datetime(\'now\') WHERE id=?');
      for (const event of group) mark.run(event.id);
    }
    return events.length;
  });
}

export function requestReportCancellation(reportId: string) {
  return transaction(() => invalidateDeletedReport(reportId));
}
