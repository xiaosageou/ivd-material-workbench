import express, { type NextFunction, type Request, type Response, type Express, type RequestHandler } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { attachmentDir, db, id, transaction } from './db.ts';
import { enqueueReportEvent, invalidateDeletedReport } from './ai/jobs.ts';
import { enqueueReportKnowledgeIndex } from './report-knowledge.ts';

type Row = Record<string, any>;
type AuthRequest = Request & { user?: Row };
const reportExtensions = new Set(['.doc', '.docx', '.xls', '.xlsx']);
const blockedDataExtensions = new Set(['.bat', '.cmd', '.com', '.dll', '.exe', '.hta', '.htm', '.html', '.jar', '.js', '.mjs', '.msi', '.php', '.ps1', '.py', '.scr', '.sh', '.svg', '.vbs', '.wasm']);
const reportMaxBytes = 25 * 1024 * 1024;
const dataFileMaxBytes = 20 * 1024 * 1024;
const dataRequestMaxBytes = 50 * 1024 * 1024;
const maxDataFiles = 8;
const officeMime: Record<string, string> = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const uploadOptions = (fileSize: number, files: number, reportOnly = false) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize, files },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (reportOnly && !reportExtensions.has(ext)) return callback(new Error('报告正文仅支持 .doc、.docx、.xls、.xlsx'));
    if (!reportOnly && ext && (!/^\.[a-z0-9]{1,12}$/.test(ext) || blockedDataExtensions.has(ext))) {
      return callback(new Error('原始数据文件扩展名无效或属于可执行/主动内容类型'));
    }
    callback(null, true);
  },
});
const reportUpload = uploadOptions(reportMaxBytes, 1, true);
const dataUpload = uploadOptions(dataFileMaxBytes, maxDataFiles);
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const optional = (value: unknown) => String(value ?? '').trim();
const param = (req: Request, key: string) => String(req.params[key] ?? '');
const reportById = (reportId: string) => db.prepare('SELECT * FROM research_reports WHERE id=? AND deleted_at IS NULL').get(reportId) as Row | undefined;
const mayEdit = (req: AuthRequest, report: Row) => req.user?.role === 'ADMIN' || req.user?.id === report.created_by;

function safeOriginalName(value: string) {
  const base = path.posix.basename(String(value || '').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..') throw new Error('文件名无效');
  return Array.from(base).slice(0, 240).join('');
}

function metadata(file: Express.Multer.File, kind: 'report' | 'data') {
  const originalName = safeOriginalName(file.originalname);
  const extension = path.extname(originalName).toLowerCase();
  if (kind === 'report') {
    if (!reportExtensions.has(extension)) throw new Error('报告正文仅支持 .doc、.docx、.xls、.xlsx');
    const legacySignature = file.buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const zippedSignature = file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b && file.buffer[2] === 0x03 && file.buffer[3] === 0x04;
    if ((extension === '.doc' || extension === '.xls') ? !legacySignature : !zippedSignature) throw new Error('报告文件内容与所选 Word/Excel 格式不匹配');
    return { originalName, extension, mimeType: officeMime[extension] };
  }
  if (extension && (!/^\.[a-z0-9]{1,12}$/.test(extension) || blockedDataExtensions.has(extension))) throw new Error('原始数据文件扩展名无效或属于可执行/主动内容类型');
  return { originalName, extension, mimeType: 'application/octet-stream' };
}

function writeStoredFile(file: Express.Multer.File, kind: 'report' | 'data') {
  const info = metadata(file, kind);
  const storageKey = (kind === 'report' ? 'rrf_' : 'rrd_') + randomUUID() + info.extension;
  const absolutePath = path.join(attachmentDir, storageKey);
  try { writeFileSync(absolutePath, file.buffer, { flag: 'wx' }); }
  catch (error) { try { if (existsSync(absolutePath)) unlinkSync(absolutePath); } catch { /* Preserve the original storage error. */ } throw error; }
  return { ...info, storageKey, sizeBytes: file.size, sha256: sha256(file.buffer), absolutePath };
}

function safeStoredPath(storageKey: string) {
  if (path.basename(storageKey) !== storageKey || !/^rr[fd]_[0-9a-f-]{36}(?:\.[a-z0-9]{1,12})?$/.test(storageKey)) return undefined;
  const absolutePath = path.join(attachmentDir, storageKey);
  return existsSync(absolutePath) ? absolutePath : undefined;
}

function audit(actorId: string, action: string, objectType: string, objectId: string, details: Row = {}) {
  db.prepare('INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)')
    .run(id('aud_'), actorId, action, objectType, objectId, JSON.stringify(details));
}

function wrapped(handler: (req: AuthRequest, res: Response) => unknown | Promise<unknown>) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try { Promise.resolve(handler(req, res)).catch(next); } catch (error) { next(error); }
  };
}

function authorizedEditor(req: AuthRequest, res: Response, report: Row | undefined) {
  if (!report) { res.status(404).json({ error: '研发报告不存在' }); return false; }
  if (!mayEdit(req, report)) { res.status(403).json({ error: '仅报告上传者或管理员可执行此操作' }); return false; }
  return true;
}

function getReportDetails(reportId: string, user: Row) {
  const report = db.prepare(`SELECT r.*,u.name AS author_name,u.email AS author_email,
      CASE WHEN r.created_by=? OR ?='ADMIN' THEN 1 ELSE 0 END AS can_edit
    FROM research_reports r JOIN users u ON u.id=r.created_by WHERE r.id=? AND r.deleted_at IS NULL`).get(user.id, user.role, reportId) as Row | undefined;
  if (!report) return undefined;
  const versions = db.prepare(`SELECT v.*,u.name AS uploader_name FROM research_report_versions v
    JOIN users u ON u.id=v.uploaded_by WHERE v.report_id=? ORDER BY v.version_no DESC`).all(reportId) as Row[];
  const dataAttachments = db.prepare(`SELECT a.id,a.created_at,a.updated_at,u.name AS uploader_name,
      (SELECT COUNT(*) FROM research_report_data_versions v WHERE v.attachment_id=a.id) AS version_count
    FROM research_report_data_attachments a JOIN users u ON u.id=a.created_by
    WHERE a.report_id=? AND a.deleted_at IS NULL ORDER BY a.created_at DESC`).all(reportId) as Row[];
  for (const item of dataAttachments) {
    item.versions = db.prepare(`SELECT v.*,u.name AS uploader_name FROM research_report_data_versions v
      JOIN users u ON u.id=v.uploaded_by WHERE v.attachment_id=? ORDER BY v.version_no DESC`).all(item.id) as Row[];
    item.latest = item.versions[0];
  }
  return { ...report, versions, dataAttachments };
}

function sendStoredFile(res: Response, storageKey: string, originalName: string, mimeType: string) {
  const target = safeStoredPath(storageKey);
  if (!target) return res.status(404).json({ error: '文件不存在或已归档' });
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(originalName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.sendFile(target);
}

export function installResearchReportRoutes(app: Express, requireAuth: RequestHandler) {
  app.get('/api/research-reports', requireAuth, wrapped((req, res) => {
    const search = optional(req.query.q);
    const pattern = '%' + search + '%';
    const rows = db.prepare(`SELECT r.id,r.title,r.description,r.created_by,r.created_at,r.updated_at,u.name AS author_name,
        (SELECT v.version_no FROM research_report_versions v WHERE v.report_id=r.id ORDER BY v.version_no DESC LIMIT 1) AS version_no,
        (SELECT v.original_name FROM research_report_versions v WHERE v.report_id=r.id ORDER BY v.version_no DESC LIMIT 1) AS original_name,
        (SELECT v.extension FROM research_report_versions v WHERE v.report_id=r.id ORDER BY v.version_no DESC LIMIT 1) AS extension,
        (SELECT v.mime_type FROM research_report_versions v WHERE v.report_id=r.id ORDER BY v.version_no DESC LIMIT 1) AS mime_type,
        (SELECT v.size_bytes FROM research_report_versions v WHERE v.report_id=r.id ORDER BY v.version_no DESC LIMIT 1) AS size_bytes,
        (SELECT COUNT(*) FROM research_report_data_attachments a WHERE a.report_id=r.id AND a.deleted_at IS NULL) AS data_attachment_count,
        CASE WHEN r.created_by=? OR ?='ADMIN' THEN 1 ELSE 0 END AS can_edit
      FROM research_reports r JOIN users u ON u.id=r.created_by
      WHERE r.deleted_at IS NULL AND (?='' OR r.title LIKE ? OR r.description LIKE ? OR u.name LIKE ? OR EXISTS(
        SELECT 1 FROM research_report_versions v WHERE v.report_id=r.id AND v.original_name LIKE ?))
      ORDER BY r.updated_at DESC,r.created_at DESC LIMIT 250`).all(req.user!.id, req.user!.role, search, pattern, pattern, pattern, pattern);
    res.json(rows);
  }));

  app.post('/api/research-reports', requireAuth, reportUpload.single('file'), wrapped((req, res) => {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw new Error('请选择 Word 或 Excel 报告文件');
    const title = optional(req.body?.title) || path.parse(safeOriginalName(file.originalname)).name;
    const description = optional(req.body?.description);
    if (!title || title.length > 200) throw new Error('标题为必填项且不超过 200 字');
    if (description.length > 10000) throw new Error('说明不超过 10,000 字');
    const saved = writeStoredFile(file, 'report');
    const reportId = id('rr_');
    const versionId = id('rrv_');
    try {
      transaction(() => {
        db.prepare('INSERT INTO research_reports(id,title,description,created_by) VALUES (?,?,?,?)').run(reportId, title, description, req.user!.id);
        db.prepare(`INSERT INTO research_report_versions(id,report_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,change_note,uploaded_by)
          VALUES (?,?,1,?,?,?,?,?,?,?,?)`).run(versionId, reportId, saved.originalName, saved.storageKey, saved.extension, saved.mimeType,
          saved.sizeBytes, saved.sha256, '首次上传', req.user!.id);
        audit(req.user!.id, 'research_report.create', 'research_report', reportId, { title, version: 1, fileName: saved.originalName, sha256: saved.sha256 });
        enqueueReportEvent(reportId, 'report.created', req.user!.id, { reportVersionId: versionId });
      });
    } catch (error) {
      unlinkSync(saved.absolutePath);
      throw error;
    }
    res.status(201).json(getReportDetails(reportId, req.user!)!);
  }));

  app.get('/api/research-reports/:id', requireAuth, wrapped((req, res) => {
    const report = getReportDetails(param(req, 'id'), req.user!);
    if (!report) return res.status(404).json({ error: '研发报告不存在' });
    res.json(report);
  }));

  app.patch('/api/research-reports/:id', requireAuth, wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!authorizedEditor(req, res, report)) return;
    const title = req.body?.title === undefined ? report!.title : optional(req.body.title);
    const description = req.body?.description === undefined ? report!.description : optional(req.body.description);
    if (!title || title.length > 200) throw new Error('标题为必填项且不超过 200 字');
    if (description.length > 10000) throw new Error('说明不超过 10,000 字');
    transaction(() => {
      db.prepare("UPDATE research_reports SET title=?,description=?,updated_at=datetime('now') WHERE id=?").run(title, description, report!.id);
      audit(req.user!.id, 'research_report.metadata.update', 'research_report', report!.id,
        { before: { title: report!.title, description: report!.description }, after: { title, description } });
      if (description !== report!.description) enqueueReportEvent(report!.id, 'report.description.updated', req.user!.id);
    });
    enqueueReportKnowledgeIndex(String(report!.id));
    res.json(getReportDetails(report!.id, req.user!)!);
  }));

  app.post('/api/research-reports/:id/versions', requireAuth, reportUpload.single('file'), wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!authorizedEditor(req, res, report)) return;
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw new Error('请选择需要替换的报告文件');
    const note = optional(req.body?.changeNote).slice(0, 500);
    const saved = writeStoredFile(file, 'report');
    const versionId = id('rrv_');
    try {
      transaction(() => {
        const versionNo = Number((db.prepare('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM research_report_versions WHERE report_id=?').get(report!.id) as Row).n);
        db.prepare(`INSERT INTO research_report_versions(id,report_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,change_note,uploaded_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, report!.id, versionNo, saved.originalName, saved.storageKey, saved.extension, saved.mimeType,
          saved.sizeBytes, saved.sha256, note, req.user!.id);
        db.prepare("UPDATE research_reports SET updated_at=datetime('now') WHERE id=?").run(report!.id);
        audit(req.user!.id, 'research_report.file.replace', 'research_report', report!.id,
          { version: versionNo, fileName: saved.originalName, sizeBytes: saved.sizeBytes, sha256: saved.sha256, changeNote: note });
        enqueueReportEvent(report!.id, 'report.file.replaced', req.user!.id, { versionNo });
      });
    } catch (error) {
      unlinkSync(saved.absolutePath);
      throw error;
    }
    res.json(getReportDetails(report!.id, req.user!)!);
  }));

  app.delete('/api/research-reports/:id', requireAuth, wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!authorizedEditor(req, res, report)) return;
    transaction(() => {
      db.prepare("UPDATE research_reports SET deleted_at=datetime('now'),deleted_by=?,updated_at=datetime('now') WHERE id=?").run(req.user!.id, report!.id);
      db.prepare("UPDATE research_report_data_attachments SET deleted_at=datetime('now'),deleted_by=?,updated_at=datetime('now') WHERE report_id=? AND deleted_at IS NULL")
        .run(req.user!.id, report!.id);
      audit(req.user!.id, 'research_report.delete', 'research_report', report!.id, { title: report!.title, softDelete: true });
      enqueueReportEvent(report!.id, 'report.deleted', req.user!.id);
      invalidateDeletedReport(report!.id);
    });
    res.json({ ok: true });
  }));

  app.post('/api/research-reports/:id/data-attachments', requireAuth, dataUpload.array('files', maxDataFiles), wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!authorizedEditor(req, res, report)) return;
    const files = (req as AuthRequest & { files?: Express.Multer.File[] }).files ?? [];
    if (!files.length) throw new Error('请选择至少一个原始数据文件');
    if (files.reduce((sum, file) => sum + file.size, 0) > dataRequestMaxBytes) throw new Error('单次原始数据上传总量不超过 50 MB');
    const saved: ReturnType<typeof writeStoredFile>[] = [];
    try { for (const file of files) saved.push(writeStoredFile(file, 'data')); }
    catch (error) { for (const item of saved) { try { unlinkSync(item.absolutePath); } catch { /* Preserve the upload error. */ } } throw error; }
    try {
      transaction(() => {
        for (let index = 0; index < saved.length; index++) {
          const item = saved[index];
          const attachmentId = id('rrd_');
          db.prepare('INSERT INTO research_report_data_attachments(id,report_id,created_by) VALUES (?,?,?)').run(attachmentId, report!.id, req.user!.id);
          db.prepare(`INSERT INTO research_report_data_versions(id,attachment_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,uploaded_by)
            VALUES (?,?,1,?,?,?,?,?,?,?)`).run(id('rrdv_'), attachmentId, item.originalName, item.storageKey, item.extension, item.mimeType,
            item.sizeBytes, item.sha256, req.user!.id);
          audit(req.user!.id, 'research_report.data_attachment.add', 'research_report', report!.id,
            { attachmentId, fileName: item.originalName, sizeBytes: item.sizeBytes, sha256: item.sha256 });
        }
        db.prepare("UPDATE research_reports SET updated_at=datetime('now') WHERE id=?").run(report!.id);
        enqueueReportEvent(report!.id, 'report.data.added', req.user!.id, { count: saved.length });
      });
    } catch (error) {
      for (const item of saved) unlinkSync(item.absolutePath);
      throw error;
    }
    res.status(201).json(getReportDetails(report!.id, req.user!)!.dataAttachments);
  }));

  app.post('/api/research-reports/:id/data-attachments/:attachmentId/replace', requireAuth, dataUpload.single('file'), wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!authorizedEditor(req, res, report)) return;
    const attachment = db.prepare('SELECT * FROM research_report_data_attachments WHERE id=? AND report_id=? AND deleted_at IS NULL')
      .get(param(req, 'attachmentId'), report!.id) as Row | undefined;
    if (!attachment) return res.status(404).json({ error: '原始数据附件不存在' });
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) throw new Error('请选择用于替换的原始数据文件');
    const saved = writeStoredFile(file, 'data');
    try {
      transaction(() => {
        const versionNo = Number((db.prepare('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM research_report_data_versions WHERE attachment_id=?').get(attachment.id) as Row).n);
        db.prepare(`INSERT INTO research_report_data_versions(id,attachment_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,uploaded_by)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id('rrdv_'), attachment.id, versionNo, saved.originalName, saved.storageKey, saved.extension, saved.mimeType,
          saved.sizeBytes, saved.sha256, req.user!.id);
        db.prepare("UPDATE research_report_data_attachments SET updated_at=datetime('now') WHERE id=?").run(attachment.id);
        db.prepare("UPDATE research_reports SET updated_at=datetime('now') WHERE id=?").run(report!.id);
        audit(req.user!.id, 'research_report.data_attachment.replace', 'research_report', report!.id,
          { attachmentId: attachment.id, version: versionNo, fileName: saved.originalName, sizeBytes: saved.sizeBytes, sha256: saved.sha256 });
        enqueueReportEvent(report!.id, 'report.data.replaced', req.user!.id, { attachmentId: attachment.id, versionNo });
      });
    } catch (error) {
      unlinkSync(saved.absolutePath);
      throw error;
    }
    res.json(getReportDetails(report!.id, req.user!)!.dataAttachments);
  }));

  app.delete('/api/research-reports/:id/data-attachments/:attachmentId', requireAuth, wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!authorizedEditor(req, res, report)) return;
    const attachment = db.prepare('SELECT * FROM research_report_data_attachments WHERE id=? AND report_id=? AND deleted_at IS NULL')
      .get(param(req, 'attachmentId'), report!.id) as Row | undefined;
    if (!attachment) return res.status(404).json({ error: '原始数据附件不存在' });
    transaction(() => {
      db.prepare("UPDATE research_report_data_attachments SET deleted_at=datetime('now'),deleted_by=?,updated_at=datetime('now') WHERE id=?").run(req.user!.id, attachment.id);
      db.prepare("UPDATE research_reports SET updated_at=datetime('now') WHERE id=?").run(report!.id);
      audit(req.user!.id, 'research_report.data_attachment.delete', 'research_report', report!.id,
        { attachmentId: attachment.id, softDelete: true });
      enqueueReportEvent(report!.id, 'report.data.deleted', req.user!.id, { attachmentId: attachment.id });
    });
    res.json(getReportDetails(report!.id, req.user!)!.dataAttachments);
  }));

  app.get('/api/research-reports/:id/versions/:versionId/download', requireAuth, wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!report) return res.status(404).json({ error: '研发报告不存在' });
    const version = db.prepare('SELECT * FROM research_report_versions WHERE id=? AND report_id=?')
      .get(param(req, 'versionId'), report.id) as Row | undefined;
    if (!version) return res.status(404).json({ error: '报告版本不存在' });
    audit(req.user!.id, 'research_report.download', 'research_report', report.id,
      { version: version.version_no, fileName: version.original_name, sha256: version.sha256 });
    return sendStoredFile(res, version.storage_key, version.original_name, version.mime_type);
  }));

  app.get('/api/research-reports/:id/data-attachments/:attachmentId/versions/:versionId/download', requireAuth, wrapped((req, res) => {
    const report = reportById(param(req, 'id'));
    if (!report) return res.status(404).json({ error: '研发报告不存在' });
    const attachment = db.prepare(`SELECT a.id FROM research_report_data_attachments a
      WHERE a.id=? AND a.report_id=? AND a.deleted_at IS NULL`).get(param(req, 'attachmentId'), report.id) as Row | undefined;
    if (!attachment) return res.status(404).json({ error: '原始数据附件不存在' });
    const version = db.prepare('SELECT * FROM research_report_data_versions WHERE id=? AND attachment_id=?')
      .get(param(req, 'versionId'), attachment.id) as Row | undefined;
    if (!version) return res.status(404).json({ error: '原始数据版本不存在' });
    audit(req.user!.id, 'research_report.data_attachment.download', 'research_report', report.id,
      { attachmentId: attachment.id, version: version.version_no, fileName: version.original_name, sha256: version.sha256 });
    return sendStoredFile(res, version.storage_key, version.original_name, version.mime_type);
  }));
}
