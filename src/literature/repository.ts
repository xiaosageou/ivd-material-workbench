import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { attachmentDir, db, id, transaction } from '../db.ts';
import { getActiveLiteratureProfile, getLiteratureEmbeddingConfig, getLiteratureEmbeddingStatus } from './embedding-config.ts';
import { literatureCollectionName } from './vector.ts';

export type LiteratureActor = { id: string; role: string; name?: string };
export type LiteratureInput = {
  title?: unknown; authors?: unknown; year?: unknown; publicationYear?: unknown; journal?: unknown;
  doi?: unknown; pmid?: unknown; originalUrl?: unknown; language?: unknown; abstract?: unknown;
  keywords?: unknown; notes?: unknown; collectionIds?: unknown; tags?: unknown;
};
export type UploadFile = { originalname: string; mimetype: string; buffer: Buffer; size: number };
type Row = Record<string, any>;

export const LITERATURE_PARSER_VERSION = 'literature-parser-2';
export const LITERATURE_CHUNKER_VERSION = 'literature-chunker-2';
export const LITERATURE_FILE_LIMIT = 25 * 1024 * 1024;
export const LITERATURE_BATCH_LIMIT = 100 * 1024 * 1024;
export const LITERATURE_MAX_BATCH_FILES = 8;
const EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md']);
const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

export const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const literatureById = (itemId: string) => db.prepare('SELECT * FROM literature_items WHERE id=? AND deleted_at IS NULL').get(itemId) as Row | undefined;
export const mayEditLiterature = (actor: LiteratureActor, item: Row) => actor.role === 'ADMIN' || actor.id === item.created_by;

export function auditLiterature(actorId: string, action: string, objectType: string, objectId: string, details: Row = {}) {
  db.prepare('INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)')
    .run(id('aud_'), actorId, action, objectType, objectId, JSON.stringify(details));
}

function invalidateLiteratureIndexJobs(itemId: string, status: 'cancelled' | 'superseded', reason: string) {
  const jobs = db.prepare(`SELECT id,generation_id,usage_tokens,usage_pending_count FROM literature_jobs WHERE item_id=?
    AND job_type IN ('index','rebuild') AND status IN ('queued','waiting_configuration','embedding','publishing')`).all(itemId) as Row[];
  for (const job of jobs) {
    const pending = Number(job.usage_pending_count || 0);
    db.prepare(`UPDATE literature_jobs SET status=?,cancel_requested=1,lease_owner=NULL,lease_until_ms=NULL,finished_at=datetime('now'),updated_at=datetime('now'),
      usage_pending_count=0,usage_unknown_count=usage_unknown_count+?,
      usage_status=CASE WHEN ?>0 THEN CASE WHEN usage_tokens>0 THEN 'partial_unknown' ELSE 'unknown' END ELSE usage_status END,
      usage_stop_reason=CASE WHEN ?>0 THEN 'source_invalidated_pending_usage_unknown' ELSE usage_stop_reason END,
      error_code='source_invalidated',error_message=? WHERE id=? AND status IN ('queued','waiting_configuration','embedding','publishing')`)
      .run(status, pending, pending, pending, reason.slice(0, 500), job.id);
    if (job.generation_id) db.prepare(`UPDATE literature_index_generations SET status=? WHERE id=? AND status IN ('queued','building')`)
      .run(status === 'cancelled' ? 'cancelled' : 'stale', job.generation_id);
  }
}

function safeOriginalName(value: unknown) {
  const base = path.posix.basename(String(value || '').replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..') throw new Error('文件名无效');
  return Array.from(base).slice(0, 240).join('');
}

export function validateLiteratureFile(file: UploadFile) {
  if (!file.buffer?.length || file.buffer.length > LITERATURE_FILE_LIMIT) throw new Error('单份文献文件需大于 0 且不超过 25 MB');
  const originalName = safeOriginalName(file.originalname);
  const extension = path.extname(originalName).toLowerCase();
  if (!EXTENSIONS.has(extension)) throw new Error('文献仅支持 PDF、DOCX、TXT、Markdown 文件');
  if (extension === '.pdf' && !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF 文件内容与扩展名不匹配');
  if (extension === '.docx' && !(file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b && file.buffer[2] === 0x03 && file.buffer[3] === 0x04)) {
    throw new Error('DOCX 文件内容与扩展名不匹配');
  }
  if (['.txt', '.md'].includes(extension) && file.buffer.includes(0)) throw new Error('文本文件含二进制内容');
  return { originalName, extension, mimeType: FILE_MIME[extension] };
}

function normalizedAuthors(value: unknown) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;；\n]/) : [];
  const authors = input.map(author => String(author ?? '').trim()).filter(Boolean);
  if (authors.length > 100 || authors.some(author => author.length > 240)) throw new Error('作者列表过长');
  return authors;
}

function normalizedKeywords(value: unknown) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,，；\n]/) : [];
  const keywords = [...new Set(input.map(keyword => String(keyword ?? '').trim()).filter(Boolean))];
  if (keywords.length > 100 || keywords.some(keyword => keyword.length > 120)) throw new Error('关键词列表过长');
  return keywords;
}

function normalizedTags(value: unknown) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,，；\n]/) : [];
  const tags = [...new Set(input.map(tag => String(tag ?? '').trim()).filter(Boolean))];
  if (tags.length > 100 || tags.some(tag => tag.length > 120)) throw new Error('分类标签列表过长');
  return tags;
}

function normalizedCollectionIds(value: unknown) {
  if (value === undefined || value === null || value === '') return [] as string[];
  const input = Array.isArray(value) ? value : (() => { try { return JSON.parse(String(value)); } catch { throw new Error('文献集合选择格式无效'); } })();
  if (!Array.isArray(input) || input.length > 100) throw new Error('文献集合选择无效');
  return [...new Set(input.map(item => String(item || '').trim()).filter(Boolean))];
}

export function normalizeLiteratureInput(input: LiteratureInput, file?: UploadFile) {
  const titleFromName = file ? path.basename(safeOriginalName(file.originalname), path.extname(file.originalname)) : '';
  const title = String(input.title ?? titleFromName).trim();
  if (!title || title.length > 500) throw new Error('文献标题为必填项且不超过 500 字');
  const yearRaw = input.publicationYear ?? input.year ?? '';
  const year = yearRaw === '' || yearRaw === null || yearRaw === undefined ? null : Number(yearRaw);
  if (year !== null && (!Number.isSafeInteger(year) || year < 1000 || year > 3000)) throw new Error('发表年份需为 1000 至 3000 之间的整数');
  const journal = String(input.journal ?? '').trim();
  const doi = String(input.doi ?? '').trim().slice(0, 300);
  const doiNormalized = doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  const pmid = String(input.pmid ?? '').trim().slice(0, 40);
  const originalUrl = String(input.originalUrl ?? '').trim().slice(0, 2000);
  if (originalUrl) {
    let url: URL;
    try { url = new URL(originalUrl); } catch { throw new Error('原始链接需为有效的 HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('原始链接仅支持 HTTP(S) 且不能带账号信息');
  }
  const language = String(input.language ?? '').trim().slice(0, 40);
  const abstract = String(input.abstract ?? '').trim();
  if (abstract.length > 100_000) throw new Error('摘要不超过 100,000 字');
  const notes = String(input.notes ?? '').trim();
  if (notes.length > 20_000) throw new Error('整理备注不超过 20,000 字');
  return {
    title, authors: normalizedAuthors(input.authors), year, journal: journal.slice(0, 500), doi, doiNormalized,
    pmid, originalUrl, language, abstract, keywords: normalizedKeywords(input.keywords), tags: normalizedTags(input.tags), notes,
    collectionIds: normalizedCollectionIds(input.collectionIds),
  };
}

function metadataSnapshot(values: ReturnType<typeof normalizeLiteratureInput>) {
  return JSON.stringify({ title: values.title, authors: values.authors, publicationYear: values.year, journal: values.journal,
    doi: values.doi, pmid: values.pmid, originalUrl: values.originalUrl, language: values.language,
    abstract: values.abstract, keywords: values.keywords, tags: values.tags, notes: values.notes, collectionIds: values.collectionIds });
}

function storeFile(file: UploadFile) {
  const info = validateLiteratureFile(file);
  const storageKey = `lit_${randomUUID()}${info.extension}`;
  const absolutePath = path.join(attachmentDir, storageKey);
  writeFileSync(absolutePath, file.buffer, { flag: 'wx' });
  return { ...info, storageKey, sizeBytes: file.buffer.length, sha256: hash(file.buffer), absolutePath };
}

export function safeLiteraturePath(storageKey: string) {
  if (path.basename(storageKey) !== storageKey || !/^lit_[0-9a-f-]{36}\.(?:pdf|docx|txt|md)$/.test(storageKey)) return undefined;
  const absolutePath = path.join(attachmentDir, storageKey);
  return existsSync(absolutePath) ? absolutePath : undefined;
}

function chunkText(text: string, max = 1100, overlap = 160) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[\t\u00a0]+/g, ' ').trim();
  if (!normalized) return [] as string[];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + max);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(max * 0.6)) end = boundary;
    }
    const part = normalized.slice(start, end).trim();
    if (part) chunks.push(part);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function deterministicChunkId(itemId: string, extent: string, sequenceNo: number, content: string) {
  return `lch_${hash(`${itemId}\0${extent}\0${sequenceNo}\0${hash(content)}`).slice(0, 40)}`;
}

function insertStaticChunks(itemId: string, versionId: string | null, revision: number, values: ReturnType<typeof normalizeLiteratureInput>) {
  const sources = [
    { extent: 'metadata', text: [values.title, values.authors.join('; '), values.year ?? '', values.journal, values.doi, values.pmid,
      values.keywords.join('; ')].filter(Boolean).join('\n'), section: '书目信息' },
    { extent: 'abstract', text: values.abstract, section: '摘要' },
  ];
  for (const source of sources) {
    chunkText(source.text, source.extent === 'abstract' ? 1000 : 700, 120).forEach((content, sequenceNo) => {
      const chunkId = deterministicChunkId(itemId, `${source.extent}:${revision}`, sequenceNo, content);
      db.prepare(`INSERT INTO literature_chunks(id,item_id,version_id,extraction_id,sequence_no,source_extent,locator_json,section_title,content_text,content_sha256,metadata_revision)
        VALUES (?,?,?,NULL,?,?,?,?,?,?,?)`).run(chunkId, itemId, versionId, sequenceNo, source.extent,
        JSON.stringify({ kind: source.extent, revision, segment: sequenceNo + 1 }), source.section, content, hash(content), revision);
    });
  }
}

function attachCollections(itemId: string, collectionIds: string[], actorId: string) {
  if (collectionIds.length) {
    const placeholders = collectionIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id FROM literature_collections WHERE deleted_at IS NULL AND id IN (${placeholders})`).all(...collectionIds) as Row[];
    if (rows.length !== collectionIds.length) throw new Error('所选文献集合不存在或已归档');
  }
  db.prepare('DELETE FROM literature_item_collections WHERE item_id=?').run(itemId);
  for (const collectionId of collectionIds) db.prepare('INSERT INTO literature_item_collections(item_id,collection_id,added_by) VALUES (?,?,?)').run(itemId, collectionId, actorId);
}

function ensureTags(itemId: string, tags: string[], actorId: string) {
  db.prepare('DELETE FROM literature_item_tags WHERE item_id=?').run(itemId);
  for (const raw of tags) {
    const name = String(raw).trim().slice(0, 120);
    if (!name) continue;
    db.prepare('INSERT INTO literature_tags(id,name,created_by) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING').run(id('ltg_'), name, actorId);
    const tag = db.prepare('SELECT id FROM literature_tags WHERE name=? COLLATE NOCASE').get(name) as Row;
    db.prepare('INSERT OR IGNORE INTO literature_item_tags(item_id,tag_id) VALUES (?,?)').run(itemId, tag.id);
  }
}

function enqueueParse(itemId: string, versionId: string, inputHash: string, actorId: string) {
  const fingerprint = hash(`${versionId}\0${inputHash}\0${LITERATURE_PARSER_VERSION}`);
  const jobId = id('lj_');
  db.prepare(`INSERT OR IGNORE INTO literature_jobs(id,job_type,item_id,version_id,requested_by,input_fingerprint,run_key,status,config_snapshot_json,progress_json)
    VALUES (?,'parse',?,?,?,?,'auto','queued',?,?)`).run(jobId, itemId, versionId, actorId,
    fingerprint, JSON.stringify({ parserVersion: LITERATURE_PARSER_VERSION, chunkerVersion: LITERATURE_CHUNKER_VERSION, fileSha256: inputHash }), JSON.stringify({ stage: 'queued', message: '等待本地文献解析' }));
  const row = db.prepare("SELECT id FROM literature_jobs WHERE job_type='parse' AND input_fingerprint=? AND run_key='auto'").get(fingerprint) as Row | undefined;
  if (row) {
    const existing = db.prepare('SELECT status FROM literature_jobs WHERE id=?').get(row.id) as Row | undefined;
    if (existing && ['cancelled', 'failed'].includes(String(existing.status))) {
      db.prepare(`UPDATE literature_jobs SET status='queued',cancel_requested=0,lease_owner=NULL,lease_until_ms=NULL,attempt_count=0,
        error_code=NULL,error_message='',started_at=NULL,finished_at=NULL,updated_at=datetime('now'),progress_json=?
        WHERE id=? AND status IN ('cancelled','failed')`)
        .run(JSON.stringify({ stage: 'queued', message: '恢复文献后重新排队本地解析' }), row.id);
    }
    const sequence = Number((db.prepare('SELECT COALESCE(MAX(sequence_no),0) AS n FROM literature_job_events WHERE job_id=?').get(row.id) as Row).n) + 1;
    db.prepare('INSERT INTO literature_job_events(id,job_id,sequence_no,event_type,message,metadata_json) VALUES (?,?,?,?,?,?)')
      .run(id('lje_'), row.id, sequence, 'queued', '文献本地解析任务已排队', JSON.stringify({ itemId, versionId, actorId }));
  }
  return String(row?.id || jobId);
}

export function createLiteratureRecord(actor: LiteratureActor, input: LiteratureInput, file?: UploadFile, changeNote = '首次上传') {
  const values = normalizeLiteratureInput(input, file);
  const saved = file ? storeFile(file) : undefined;
  const itemId = id('lit_');
  const versionId = saved ? id('litv_') : null;
  const metadataVersionId = id('litm_');
  try {
    transaction(() => {
      db.prepare(`INSERT INTO literature_items(id,title,authors_json,publication_year,journal,doi,doi_normalized,pmid,original_url,language,abstract,keywords_json,notes,current_version_id,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(itemId, values.title, JSON.stringify(values.authors), values.year, values.journal, values.doi,
        values.doiNormalized, values.pmid, values.originalUrl, values.language, values.abstract, JSON.stringify(values.keywords), values.notes, versionId, actor.id);
      if (saved && versionId) db.prepare(`INSERT INTO literature_file_versions(id,item_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,change_note,uploaded_by)
        VALUES (?,?,1,?,?,?,?,?,?,?,?)`).run(versionId, itemId, saved.originalName, saved.storageKey, saved.extension, saved.mimeType,
        saved.sizeBytes, saved.sha256, changeNote.slice(0, 500), actor.id);
      db.prepare('INSERT INTO literature_metadata_versions(id,item_id,revision,snapshot_json,changed_by) VALUES (?,?,1,?,?)')
        .run(metadataVersionId, itemId, metadataSnapshot(values), actor.id);
      attachCollections(itemId, values.collectionIds, actor.id);
      ensureTags(itemId, values.tags, actor.id);
      insertStaticChunks(itemId, versionId, 1, values);
      if (saved && versionId) enqueueParse(itemId, versionId, saved.sha256, actor.id);
      auditLiterature(actor.id, 'literature.create', 'literature', itemId, { title: values.title, version: versionId ? 1 : null, fileName: saved?.originalName || null });
    });
  } catch (error) {
    if (saved?.absolutePath && existsSync(saved.absolutePath)) unlinkSync(saved.absolutePath);
    throw error;
  }
  return itemId;
}

export function updateLiteratureMetadata(actor: LiteratureActor, item: Row, input: LiteratureInput) {
  const merged = normalizeLiteratureInput({
    title: input.title ?? item.title,
    authors: input.authors ?? JSON.parse(item.authors_json),
    year: input.publicationYear ?? input.year ?? item.publication_year,
    journal: input.journal ?? item.journal,
    doi: input.doi ?? item.doi,
    pmid: input.pmid ?? item.pmid,
    originalUrl: input.originalUrl ?? item.original_url,
    language: input.language ?? item.language,
    abstract: input.abstract ?? item.abstract,
    keywords: input.keywords ?? JSON.parse(item.keywords_json),
    tags: input.tags ?? (db.prepare('SELECT t.name FROM literature_item_tags it JOIN literature_tags t ON t.id=it.tag_id WHERE it.item_id=?').all(item.id) as Row[]).map(row => row.name),
    notes: input.notes ?? item.notes,
    collectionIds: input.collectionIds ?? (db.prepare('SELECT collection_id FROM literature_item_collections WHERE item_id=?').all(item.id) as Row[]).map(row => row.collection_id),
  });
  const newRevision = Number(item.revision) + 1;
  const snapshot = metadataSnapshot(merged);
  const versionId = item.current_version_id ? String(item.current_version_id) : null;
  transaction(() => {
    const update = db.prepare(`UPDATE literature_items SET title=?,authors_json=?,publication_year=?,journal=?,doi=?,doi_normalized=?,pmid=?,original_url=?,language=?,abstract=?,keywords_json=?,notes=?,revision=?,updated_at=datetime('now')
      WHERE id=? AND revision=? AND deleted_at IS NULL`).run(merged.title, JSON.stringify(merged.authors), merged.year, merged.journal,
      merged.doi, merged.doiNormalized, merged.pmid, merged.originalUrl, merged.language, merged.abstract, JSON.stringify(merged.keywords), merged.notes,
      newRevision, item.id, item.revision);
    if (!update.changes) throw Object.assign(new Error('文献信息已被其他人更新，请刷新后再保存'), { status: 409 });
    db.prepare('INSERT INTO literature_metadata_versions(id,item_id,revision,snapshot_json,changed_by) VALUES (?,?,?,?,?)')
      .run(id('litm_'), item.id, newRevision, snapshot, actor.id);
    attachCollections(String(item.id), merged.collectionIds, actor.id);
    ensureTags(String(item.id), merged.tags, actor.id);
    insertStaticChunks(String(item.id), versionId, newRevision, merged);
    invalidateLiteratureIndexJobs(String(item.id), 'superseded', '文献信息已更新，旧索引不再有效');
    db.prepare("UPDATE literature_index_generations SET status='stale' WHERE item_id=? AND status IN ('ready','building','partial')").run(item.id);
    auditLiterature(actor.id, 'literature.metadata.update', 'literature', item.id, { revision: newRevision });
  });
  return newRevision;
}

export function replaceLiteratureFile(actor: LiteratureActor, item: Row, file: UploadFile, changeNote = '') {
  const saved = storeFile(file);
  const versionId = id('litv_');
  const versionNo = Number((db.prepare('SELECT COALESCE(MAX(version_no),0) AS n FROM literature_file_versions WHERE item_id=?').get(item.id) as Row).n) + 1;
  try {
    transaction(() => {
      const live = literatureById(String(item.id));
      if (!live || Number(live.revision) !== Number(item.revision)) throw Object.assign(new Error('文献信息已更新，请刷新后再替换全文'), { status: 409 });
      db.prepare(`INSERT INTO literature_file_versions(id,item_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,change_note,uploaded_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, item.id, versionNo, saved.originalName, saved.storageKey, saved.extension, saved.mimeType,
        saved.sizeBytes, saved.sha256, changeNote.slice(0, 500), actor.id);
      db.prepare("UPDATE literature_items SET current_version_id=?,revision=revision+1,updated_at=datetime('now') WHERE id=? AND revision=?")
        .run(versionId, item.id, item.revision);
      db.prepare(`UPDATE literature_jobs SET status='superseded',cancel_requested=1,lease_owner=NULL,lease_until_ms=NULL,finished_at=datetime('now'),updated_at=datetime('now'),error_message='全文版本已替换'
        WHERE item_id=? AND job_type='parse' AND status IN ('queued','waiting_configuration','parsing')`).run(item.id);
      invalidateLiteratureIndexJobs(String(item.id), 'superseded', '全文版本已替换，旧索引不再有效');
      db.prepare("UPDATE literature_index_generations SET status='stale' WHERE item_id=? AND version_id<>? AND status IN ('queued','building','ready','partial')").run(item.id, versionId);
      const fresh = literatureById(String(item.id)) as Row;
      const values = normalizeLiteratureInput({ title: fresh.title, authors: JSON.parse(fresh.authors_json), year: fresh.publication_year,
        journal: fresh.journal, doi: fresh.doi, pmid: fresh.pmid, originalUrl: fresh.original_url, language: fresh.language,
        abstract: fresh.abstract, keywords: JSON.parse(fresh.keywords_json),
        tags: (db.prepare('SELECT t.name FROM literature_item_tags it JOIN literature_tags t ON t.id=it.tag_id WHERE it.item_id=?').all(item.id) as Row[]).map(row => row.name), notes: fresh.notes,
        collectionIds: (db.prepare('SELECT collection_id FROM literature_item_collections WHERE item_id=?').all(item.id) as Row[]).map(row => row.collection_id) });
      db.prepare('INSERT INTO literature_metadata_versions(id,item_id,revision,snapshot_json,changed_by) VALUES (?,?,?,?,?)')
        .run(id('litm_'), item.id, Number(fresh.revision), metadataSnapshot(values), actor.id);
      insertStaticChunks(String(item.id), versionId, Number(fresh.revision), values);
      enqueueParse(String(item.id), versionId, saved.sha256, actor.id);
      auditLiterature(actor.id, 'literature.file.replace', 'literature', item.id, { version: versionNo, fileName: saved.originalName, sha256: saved.sha256 });
    });
  } catch (error) {
    if (existsSync(saved.absolutePath)) unlinkSync(saved.absolutePath);
    throw error;
  }
  return versionId;
}

export function setLiteratureDeleted(actor: LiteratureActor, item: Row, deleted: boolean) {
  transaction(() => {
    if (deleted) {
      db.prepare("UPDATE literature_items SET deleted_at=datetime('now'),deleted_by=?,revision=revision+1,updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL")
        .run(actor.id, item.id);
      db.prepare(`UPDATE literature_jobs SET status='cancelled',cancel_requested=1,lease_owner=NULL,lease_until_ms=NULL,finished_at=datetime('now'),updated_at=datetime('now'),error_message='文献已移入回收站'
        WHERE item_id=? AND job_type='parse' AND status IN ('queued','waiting_configuration','parsing')`).run(item.id);
      invalidateLiteratureIndexJobs(String(item.id), 'cancelled', '文献已移入回收站，索引任务已取消');
      db.prepare("UPDATE literature_index_generations SET status='stale' WHERE item_id=? AND status IN ('queued','building','ready','partial')").run(item.id);
      auditLiterature(actor.id, 'literature.delete', 'literature', item.id, { title: item.title, revision: Number(item.revision) + 1 });
    } else {
      db.prepare("UPDATE literature_items SET deleted_at=NULL,deleted_by=NULL,revision=revision+1,updated_at=datetime('now') WHERE id=? AND deleted_at IS NOT NULL")
        .run(item.id);
      const version = item.current_version_id ? db.prepare('SELECT id,sha256 FROM literature_file_versions WHERE id=? AND item_id=?').get(item.current_version_id, item.id) as Row | undefined : undefined;
      if (version) enqueueParse(String(item.id), String(version.id), String(version.sha256), actor.id);
      auditLiterature(actor.id, 'literature.restore', 'literature', item.id, { title: item.title });
    }
  });
}

export function enqueueLiteratureIndex(actor: LiteratureActor, item: Row) {
  const live = literatureById(String(item.id));
  if (!live) throw Object.assign(new Error('文献不存在或已移入回收站'), { status: 404 });
  const profile = getActiveLiteratureProfile();
  if (!profile) throw Object.assign(new Error('请先由管理员配置并保存 Embedding profile'), { status: 409, code: 'waiting_profile' });
  const lastUsage = db.prepare(`SELECT j.id,j.status,j.usage_status,j.usage_unknown_count FROM literature_jobs j
    WHERE j.item_id=? AND j.version_id IS ? AND j.profile_id=? AND j.job_type IN ('index','rebuild')
      AND j.status IN ('partial','failed') ORDER BY j.created_at DESC LIMIT 1`)
    .get(item.id, item.current_version_id, profile.id) as Row | undefined;
  if (lastUsage && (['unknown','partial_unknown'].includes(String(lastUsage.usage_status)) || Number(lastUsage.usage_unknown_count) > 0)) {
    throw Object.assign(new Error('上一文献索引任务的 Embedding 用量未知；同一 profile 下已停止后续外呼，请管理员检查配置并切换到新的明确 profile。'),
      { status: 409, code: 'usage_unknown' });
  }
  const config = getLiteratureEmbeddingConfig();
  const extraction = live.current_version_id ? db.prepare(`SELECT * FROM literature_extractions WHERE version_id=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(live.current_version_id) as Row | undefined : undefined;
  if (live.current_version_id && !extraction) throw Object.assign(new Error('全文仍在本地解析；解析完成后再建立向量索引'), { status: 409, code: 'parse_pending' });
  if (extraction && ['failed','unsupported'].includes(String(extraction.status))) throw Object.assign(new Error('当前全文解析结果不适合向量化，请检查解析状态或先替换文件'), { status: 409, code: 'parse_unavailable' });
  const chunks = db.prepare(`SELECT id,source_extent,content_sha256 FROM literature_chunks WHERE item_id=?
    AND (source_extent IN ('metadata','abstract') AND extraction_id IS NULL AND metadata_revision=? OR extraction_id=?) ORDER BY source_extent,sequence_no`)
    .all(live.id, live.revision, extraction?.id || '') as Row[];
  if (!chunks.length) throw Object.assign(new Error('文献没有摘要或可索引片段'), { status: 409, code: 'no_chunks' });
  const activeJob = db.prepare(`SELECT id,status,generation_id FROM literature_jobs WHERE job_type='index' AND item_id=? AND profile_id=?
    AND status IN ('queued','waiting_configuration','embedding','publishing') ORDER BY created_at DESC LIMIT 1`)
    .get(live.id, profile.id) as Row | undefined;
  if (activeJob) return { jobId: String(activeJob.id), generationId: String(activeJob.generation_id || ''), status: String(activeJob.status), reused: true };
  const generationNo = Number((db.prepare(`SELECT COALESCE(MAX(generation_no),0) AS n FROM literature_index_generations
    WHERE item_id=? AND version_id IS ? AND profile_id=?`).get(live.id, live.current_version_id, profile.id) as Row).n) + 1;
  const generationId = id('litgen_');
  const jobId = id('lj_');
  const collectionName = literatureCollectionName(String(profile.fingerprint), Number(profile.generation));
  const readiness = getLiteratureEmbeddingStatus();
  const initialStatus = readiness.missing.length ? 'waiting_configuration' : 'queued';
  const manifest = chunks.map(chunk => `${chunk.id}:${chunk.content_sha256}`).join('\n');
  const manifestSha256 = hash(`${live.current_version_id || 'metadata'}\0${profile.fingerprint}\0${manifest}`);
  const fingerprint = hash(`${live.id}\0${live.current_version_id || ''}\0${profile.fingerprint}\0${manifestSha256}`);
  const snapshot = { profileId: profile.id, profileFingerprint: profile.fingerprint, endpointUrl: profile.endpoint_url, model: profile.model,
    dimensions: Number(profile.dimensions), distance: profile.distance, documentPrefix: profile.document_prefix, queryPrefix: profile.query_prefix,
    sendDimensions: Number(profile.send_dimensions) === 1, batchSize: config.batchSize, maxInputChars: config.maxInputChars, timeoutMs: config.timeoutMs,
    fileSha256: live.current_sha256 || '', chunkerVersion: profile.chunker_version, parserVersion: profile.parser_version,
    collectionName, generationId, manifestSha256 };
  transaction(() => {
    db.prepare(`INSERT INTO literature_index_generations(id,item_id,version_id,profile_id,generation_no,status,chunk_count,indexed_count,manifest_sha256,collection_name)
      VALUES (?,?,?,?,?,'queued',?,0,?,?)`).run(generationId, live.id, live.current_version_id || null, profile.id,
      generationNo, chunks.length, manifestSha256, collectionName);
    db.prepare(`INSERT INTO literature_jobs(id,job_type,item_id,version_id,profile_id,generation_id,requested_by,input_fingerprint,run_key,status,
      config_snapshot_json,progress_json,budget_tokens,budget_requests)
      VALUES (?,'index',?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(jobId, live.id, live.current_version_id, profile.id, generationId, actor.id, fingerprint, generationId,
        initialStatus, JSON.stringify(snapshot), JSON.stringify({ stage: initialStatus, message: initialStatus === 'queued' ? '等待文献向量索引Worker' : `等待配置：${readiness.missing.join('、')}` }), config.taskTokenBudget, config.maxRequests);
    db.prepare(`INSERT INTO literature_job_events(id,job_id,sequence_no,event_type,message,metadata_json) VALUES (?,?,1,?,?,?)`)
      .run(id('lje_'), jobId, initialStatus, initialStatus === 'queued' ? '文献向量索引任务已排队' : `等待配置：${readiness.missing.join('、')}`,
        JSON.stringify({ itemId: live.id, generationId, profileId: profile.id, chunks: chunks.length }));
    auditLiterature(actor.id, 'literature.index.enqueue', 'literature', live.id, { jobId, generationId, profileId: profile.id, chunks: chunks.length });
  });
  return { jobId, generationId, status: initialStatus, reused: false };
}

export function createCollection(actor: LiteratureActor, name: string, description = '') {
  const normalizedName = name.trim();
  const normalizedDescription = description.trim();
  if (!normalizedName || normalizedName.length > 120) throw new Error('集合名称为必填项且不超过 120 字');
  if (normalizedDescription.length > 3000) throw new Error('集合说明不超过 3,000 字');
  const collectionId = id('lcol_');
  db.prepare('INSERT INTO literature_collections(id,name,description,created_by) VALUES (?,?,?,?)')
    .run(collectionId, normalizedName, normalizedDescription, actor.id);
  auditLiterature(actor.id, 'literature.collection.create', 'literature_collection', collectionId, { name: normalizedName });
  return collectionId;
}

export function collectionById(collectionId: string) {
  return db.prepare('SELECT * FROM literature_collections WHERE id=? AND deleted_at IS NULL').get(collectionId) as Row | undefined;
}

export function updateCollection(actor: LiteratureActor, collection: Row, values: { name?: unknown; description?: unknown }) {
  if (actor.role !== 'ADMIN' && collection.created_by !== actor.id) throw Object.assign(new Error('仅集合创建者或管理员可修改集合'), { status: 403 });
  const name = String(values.name ?? collection.name).trim();
  const description = String(values.description ?? collection.description).trim();
  if (!name || name.length > 120 || description.length > 3000) throw new Error('集合名称或说明长度无效');
  db.prepare("UPDATE literature_collections SET name=?,description=?,updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL")
    .run(name, description, collection.id);
  auditLiterature(actor.id, 'literature.collection.update', 'literature_collection', collection.id, { name });
}

export function deleteCollection(actor: LiteratureActor, collection: Row) {
  if (actor.role !== 'ADMIN' && collection.created_by !== actor.id) throw Object.assign(new Error('仅集合创建者或管理员可归档集合'), { status: 403 });
  transaction(() => {
    db.prepare("UPDATE literature_collections SET deleted_at=datetime('now'),deleted_by=?,updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL")
      .run(actor.id, collection.id);
    db.prepare('DELETE FROM literature_item_collections WHERE collection_id=?').run(collection.id);
    auditLiterature(actor.id, 'literature.collection.archive', 'literature_collection', collection.id, { name: collection.name });
  });
}

export function listLiteratureCollections() {
  return db.prepare(`SELECT c.*,u.name AS creator_name,COUNT(ic.item_id) AS item_count
    FROM literature_collections c JOIN users u ON u.id=c.created_by
    LEFT JOIN literature_item_collections ic ON ic.collection_id=c.id
    LEFT JOIN literature_items i ON i.id=ic.item_id AND i.deleted_at IS NULL
    WHERE c.deleted_at IS NULL GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all();
}

export function listLiteratureRows(query: { q?: string; collectionId?: string; year?: string; author?: string; status?: string; actorId?: string; role?: string;
  scopeItemIds?: string[]; scopeCollectionIds?: string[]; unbounded?: boolean }): Row[] {
  const q = (query.q || '').trim().slice(0, 300);
  const like = `%${q.replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const author = String(query.author || '').trim().slice(0, 160);
  const authorLike = `%${author.replace(/[\\%_]/g, value => `\\${value}`)}%`;
  let ftsIds = new Set<string>();
  if (q.length >= 3) {
    const match = `"${q.replaceAll('"', '""')}"`;
    try {
      ftsIds = new Set((db.prepare('SELECT DISTINCT item_id FROM literature_chunks_fts WHERE literature_chunks_fts MATCH ? LIMIT 300').all(match) as Row[]).map(row => String(row.item_id)));
    } catch { /* Search falls back to bound metadata LIKE predicates. */ }
  }
  const collectionId = query.collectionId || '';
  const year = query.year ? Number(query.year) : null;
  if (year !== null && (!Number.isSafeInteger(year) || year < 1000 || year > 3000)) throw new Error('发表年份筛选无效');
  const scopeItemIds = query.scopeItemIds;
  const scopeCollectionIds = query.scopeCollectionIds;
  if (scopeItemIds && !scopeItemIds.length || scopeCollectionIds && !scopeCollectionIds.length) return [];
  const scopeItemSql = scopeItemIds?.length ? `AND i.id IN (${scopeItemIds.map(() => '?').join(',')})` : '';
  const scopeCollectionSql = scopeCollectionIds?.length ? `AND EXISTS(SELECT 1 FROM literature_item_collections sc
      JOIN literature_collections scc ON scc.id=sc.collection_id AND scc.deleted_at IS NULL
      WHERE sc.item_id=i.id AND sc.collection_id IN (${scopeCollectionIds.map(() => '?').join(',')}))` : '';
  const limitSql = query.unbounded ? '' : 'LIMIT 250';
  const rows = db.prepare(`SELECT i.*,u.name AS creator_name,
      v.version_no AS current_version_no,v.original_name AS current_file_name,v.extension AS current_extension,v.size_bytes AS current_size_bytes,v.sha256 AS current_sha256,
      (SELECT status FROM literature_extractions e WHERE e.version_id=v.id ORDER BY e.created_at DESC LIMIT 1) AS parse_status,
      (SELECT status FROM literature_index_generations g WHERE g.item_id=i.id AND g.version_id=v.id ORDER BY g.created_at DESC LIMIT 1) AS index_status,
      CASE WHEN i.created_by=? OR ?='ADMIN' THEN 1 ELSE 0 END AS can_edit
    FROM literature_items i JOIN users u ON u.id=i.created_by
    LEFT JOIN literature_file_versions v ON v.id=i.current_version_id
    WHERE i.deleted_at IS NULL
      AND (?='' OR i.title LIKE ? ESCAPE '\\' OR i.authors_json LIKE ? ESCAPE '\\' OR i.doi LIKE ? ESCAPE '\\'
        OR i.pmid LIKE ? ESCAPE '\\' OR i.abstract LIKE ? ESCAPE '\\' OR i.keywords_json LIKE ? ESCAPE '\\' OR i.id IN (${ftsIds.size ? [...ftsIds].map(() => '?').join(',') : "SELECT ''"}))
      AND (?='' OR EXISTS(SELECT 1 FROM literature_item_collections ic WHERE ic.item_id=i.id AND ic.collection_id=?))
      AND (? IS NULL OR i.publication_year=?)
      AND (?='' OR i.authors_json LIKE ? ESCAPE '\\')
      AND (?='' OR COALESCE((SELECT status FROM literature_index_generations g WHERE g.item_id=i.id AND g.version_id=v.id ORDER BY g.created_at DESC LIMIT 1),'not_indexed')=?)
      ${scopeItemSql} ${scopeCollectionSql}
    ORDER BY i.updated_at DESC,i.created_at DESC ${limitSql}`).all(
      query.actorId || '', query.role || '', q, like, like, like, like, like, like, ...ftsIds,
      collectionId, collectionId, year, year, author, authorLike, query.status || '', query.status || '',
      ...(scopeItemIds || []), ...(scopeCollectionIds || [])) as Row[];
  return rows.map(row => ({ ...row, authors: JSON.parse(row.authors_json), keywords: JSON.parse(row.keywords_json) }));
}

export function getLiteratureStats() {
  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM literature_items WHERE deleted_at IS NULL').get() as Row).n);
  const searchable = Number((db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM literature_index_generations WHERE status='ready'").get() as Row).n);
  const processing = Number((db.prepare("SELECT COUNT(*) AS n FROM literature_jobs WHERE status IN ('queued','waiting_configuration','parsing','embedding','publishing')").get() as Row).n);
  const failed = Number((db.prepare("SELECT COUNT(*) AS n FROM literature_jobs WHERE status='failed'").get() as Row).n);
  return { total, searchable, processing, failed };
}

export function listDeletedLiterature(actor: LiteratureActor) {
  return db.prepare(`SELECT i.id,i.title,i.authors_json,i.publication_year,i.doi,i.revision,i.deleted_at,
      u.name AS creator_name,v.version_no AS current_version_no,v.original_name AS current_file_name,
      CASE WHEN i.created_by=? OR ?='ADMIN' THEN 1 ELSE 0 END AS can_edit
    FROM literature_items i JOIN users u ON u.id=i.created_by LEFT JOIN literature_file_versions v ON v.id=i.current_version_id
    WHERE i.deleted_at IS NOT NULL AND (i.created_by=? OR ?='ADMIN') ORDER BY i.deleted_at DESC LIMIT 250`)
    .all(actor.id, actor.role, actor.id, actor.role).map((row: any) => ({ ...row, authors: JSON.parse(row.authors_json) }));
}

export function getLiteratureDetails(itemId: string, actor: LiteratureActor): Row | undefined {
  const item = db.prepare(`SELECT i.*,u.name AS creator_name,CASE WHEN i.created_by=? OR ?='ADMIN' THEN 1 ELSE 0 END AS can_edit
    FROM literature_items i JOIN users u ON u.id=i.created_by WHERE i.id=? AND i.deleted_at IS NULL`).get(actor.id, actor.role, itemId) as Row | undefined;
  if (!item) return undefined;
  const versions = db.prepare(`SELECT v.*,u.name AS uploader_name FROM literature_file_versions v JOIN users u ON u.id=v.uploaded_by
    WHERE v.item_id=? ORDER BY v.version_no DESC`).all(itemId) as Row[];
  const collections = db.prepare(`SELECT c.id,c.name FROM literature_item_collections ic JOIN literature_collections c ON c.id=ic.collection_id
    WHERE ic.item_id=? AND c.deleted_at IS NULL ORDER BY c.name COLLATE NOCASE`).all(itemId);
  const tags = db.prepare(`SELECT t.id,t.name FROM literature_item_tags it JOIN literature_tags t ON t.id=it.tag_id WHERE it.item_id=? ORDER BY t.name COLLATE NOCASE`).all(itemId);
  const currentVersion = versions.find(version => version.id === item.current_version_id) || null;
  const extraction = currentVersion ? db.prepare('SELECT * FROM literature_extractions WHERE version_id=? ORDER BY created_at DESC LIMIT 1').get(currentVersion.id) as Row | undefined : undefined;
  const chunks = extraction ? db.prepare('SELECT id,sequence_no,source_extent,locator_json,section_title,content_text,content_sha256 FROM literature_chunks WHERE extraction_id=? ORDER BY sequence_no LIMIT 300').all(extraction.id) as Row[] : [];
  const staticChunks = db.prepare("SELECT id,sequence_no,source_extent,locator_json,section_title,content_text,content_sha256 FROM literature_chunks WHERE item_id=? AND extraction_id IS NULL AND metadata_revision=? ORDER BY source_extent,sequence_no").all(itemId, item.revision) as Row[];
  const indexes = db.prepare(`SELECT g.*,p.model,p.dimensions,p.fingerprint FROM literature_index_generations g JOIN literature_embedding_profiles p ON p.id=g.profile_id
    WHERE g.item_id=? ORDER BY g.created_at DESC LIMIT 20`).all(itemId);
  const jobs = db.prepare('SELECT * FROM literature_jobs WHERE item_id=? ORDER BY created_at DESC LIMIT 30').all(itemId) as Row[];
  return {
    ...item, authors: JSON.parse(item.authors_json), keywords: JSON.parse(item.keywords_json), collections, tags,
    currentVersion, versions, extraction: extraction ? { ...extraction, coverage: JSON.parse(extraction.coverage_json) } : null,
    chunks: [...staticChunks, ...chunks].map(row => ({ ...row, locator: JSON.parse(row.locator_json) })), indexes,
    jobs: jobs.map(job => ({ ...job, configSnapshot: JSON.parse(job.config_snapshot_json), progress: JSON.parse(job.progress_json),
      events: (db.prepare('SELECT * FROM literature_job_events WHERE job_id=? ORDER BY sequence_no').all(job.id) as Row[]).map(event => ({ ...event, metadata: JSON.parse(event.metadata_json) })) })),
  };
}

export function duplicateCandidates(values: ReturnType<typeof normalizeLiteratureInput>, file?: UploadFile, excludeId = '') {
  const matches: Row[] = [];
  if (values.doiNormalized) {
    matches.push(...db.prepare(`SELECT id,title,doi,doi_normalized,current_version_id,'doi' AS reason FROM literature_items
      WHERE deleted_at IS NULL AND doi_normalized=? AND id<>? LIMIT 10`).all(values.doiNormalized, excludeId) as Row[]);
  }
  if (file) {
    const digest = hash(file.buffer);
    matches.push(...db.prepare(`SELECT i.id,i.title,i.doi,i.doi_normalized,i.current_version_id,'file_hash' AS reason
      FROM literature_file_versions v JOIN literature_items i ON i.id=v.item_id
      WHERE i.deleted_at IS NULL AND v.sha256=? AND i.id<>? LIMIT 10`).all(digest, excludeId) as Row[]);
  }
  return [...new Map(matches.map(row => [`${row.id}:${row.reason}`, row])).values()];
}

export function getMetadataHistory(itemId: string) {
  return db.prepare(`SELECT m.id,m.revision,m.snapshot_json,m.created_at,u.name AS changed_by_name
    FROM literature_metadata_versions m JOIN users u ON u.id=m.changed_by WHERE m.item_id=? ORDER BY m.revision DESC`).all(itemId) as Row[];
}

export function readLiteratureVersion(itemId: string, versionId: string) {
  return db.prepare('SELECT * FROM literature_file_versions WHERE item_id=? AND id=?').get(itemId, versionId) as Row | undefined;
}
