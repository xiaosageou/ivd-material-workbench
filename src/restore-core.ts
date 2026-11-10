import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const unzipper: any = createRequire(import.meta.url)('unzipper');
type Manifest = {
  format: string;
  version: number;
  database: { path: string; sha256: string };
  attachments: Array<{ path: string; sha256: string }>;
};
export type RestoreFileOps = { rename: (from: string, to: string) => void };

const fileHash = (filePath: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  let digest = '';
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => { digest = hash.digest('hex'); });
  stream.on('close', () => resolve(digest));
});

const readEntry = async (entry: any) => {
  const chunks: Buffer[] = [];
  for await (const chunk of entry.stream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

function validateEntryName(value: unknown) {
  const name = String(value).replaceAll('\\', '/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('备份包包含无效路径');
  }
  return name;
}

export async function restoreBackup(archiveInput: string, dataDirInput: string, fileOps: RestoreFileOps = { rename: renameSync }) {
  const archivePath = path.resolve(archiveInput);
  const dataDir = path.resolve(dataDirInput);
  if (!archivePath || !existsSync(archivePath) || !archivePath.toLowerCase().endsWith('.zip')) {
    throw new Error('用法：npm run restore:backup -- --file=备份文件.zip');
  }

  const dbPath = path.join(dataDir, 'ivd.sqlite');
  const attachmentDir = path.join(dataDir, 'attachments');
  mkdirSync(dataDir, { recursive: true });
  const stageRoot = path.join(dataDir, `.restore-stage-${randomUUID()}`);
  mkdirSync(stageRoot);
  const stageDb = path.join(stageRoot, 'database', 'ivd.sqlite');
  const stageAttachments = path.join(stageRoot, 'attachments');

  try {
    const zip = await unzipper.Open.file(archivePath);
    const files = zip.files.filter((entry: any) => entry.type === 'File');
    const names: string[] = files.map((entry: any) => validateEntryName(entry.path) as string);
    const manifestEntry = files.find((entry: any) => entry.path === 'manifest.json');
    if (!manifestEntry) throw new Error('备份包缺少清单');
    const manifest = JSON.parse((await readEntry(manifestEntry)).toString('utf8')) as Manifest;
    if (manifest.format !== 'ivd-material-workbench-backup' || manifest.version !== 1 || manifest.database?.path !== 'database/ivd.sqlite') {
      throw new Error('备份清单格式或版本不受支持');
    }
    if (!/^[a-f0-9]{64}$/i.test(manifest.database.sha256) || !Array.isArray(manifest.attachments)) {
      throw new Error('备份清单摘要或附件列表无效');
    }

    const manifestPaths = new Map<string, string>();
    for (const item of manifest.attachments) {
      const name = validateEntryName(item.path);
      if (!name.startsWith('attachments/') || path.posix.basename(name) !== name.slice('attachments/'.length)
          || !/^[a-f0-9]{64}$/i.test(item.sha256) || manifestPaths.has(name)) {
        throw new Error('备份清单包含无效附件路径或摘要');
      }
      manifestPaths.set(name, item.sha256);
    }
    const allowed = new Set(['manifest.json', 'database/ivd.sqlite', ...manifestPaths.keys()]);
    if (names.some(name => !allowed.has(name))) throw new Error('备份包包含清单之外的文件');
    if (names.length !== allowed.size) throw new Error('备份包存在重复或缺失文件');

    for (const entry of files) {
      const name = validateEntryName(entry.path);
      if (name === 'manifest.json') continue;
      const relative = name === 'database/ivd.sqlite' ? path.join('database', 'ivd.sqlite') : path.join('attachments', path.posix.basename(name));
      const target = path.join(stageRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      await pipeline(entry.stream(), createWriteStream(target, { flags: 'wx' }));
    }
    mkdirSync(stageAttachments, { recursive: true });

    if (await fileHash(stageDb) !== manifest.database.sha256) throw new Error('数据库快照校验失败');
    for (const [name, expectedHash] of manifestPaths) {
      const fullPath = path.join(stageAttachments, path.posix.basename(name));
      if (!existsSync(fullPath) || await fileHash(fullPath) !== expectedHash) throw new Error(`附件校验失败：${name}`);
    }
    const snapshotDb = new DatabaseSync(stageDb);
    try {
      const integrity = (snapshotDb.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)?.integrity_check;
      if (integrity !== 'ok') throw new Error('数据库完整性检查失败');
      if (snapshotDb.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库关联完整性检查失败');
      const referenced = snapshotDb.prepare('SELECT stored_name,sha256 FROM attachments').all() as Array<{ stored_name: string; sha256: string }>;
      const hasReportFiles = Boolean(snapshotDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_report_versions'").get());
      if (hasReportFiles) {
        referenced.push(...snapshotDb.prepare('SELECT storage_key AS stored_name,sha256 FROM research_report_versions').all() as Array<{ stored_name: string; sha256: string }>);
        referenced.push(...snapshotDb.prepare('SELECT storage_key AS stored_name,sha256 FROM research_report_data_versions').all() as Array<{ stored_name: string; sha256: string }>);
      }
      const hasLiteratureFiles = Boolean(snapshotDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='literature_file_versions'").get());
      if (hasLiteratureFiles) {
        referenced.push(...snapshotDb.prepare('SELECT storage_key AS stored_name,sha256 FROM literature_file_versions').all() as Array<{ stored_name: string; sha256: string }>);
      }
      for (const item of referenced) {
        const manifestHash = manifestPaths.get(`attachments/${item.stored_name}`);
        if (!manifestHash || manifestHash !== item.sha256) throw new Error(`附件关联与数据库快照不一致：${item.stored_name}`);
      }
      if (referenced.length !== manifestPaths.size) throw new Error('附件清单与数据库索引数量不一致');
    } finally {
      snapshotDb.close();
    }

    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (existsSync(walPath) && statSync(walPath).size > 0) throw new Error('检测到未清理的 SQLite WAL；停止应用后再执行恢复');
    if (existsSync(shmPath) && statSync(shmPath).size > 0) throw new Error('检测到 SQLite 共享内存文件；停止应用后再执行恢复');

    const safetyDir = path.join(dataDir, `restore-safety-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
    const safeDb = path.join(safetyDir, 'ivd.sqlite');
    const safeAttachments = path.join(safetyDir, 'attachments');
    mkdirSync(safetyDir);
    let oldDbMoved = false;
    let oldAttachmentsMoved = false;
    let newDbInstalled = false;
    let newAttachmentsInstalled = false;
    try {
      if (existsSync(dbPath)) {
        fileOps.rename(dbPath, safeDb);
        oldDbMoved = true;
      }
      if (existsSync(attachmentDir)) {
        fileOps.rename(attachmentDir, safeAttachments);
        oldAttachmentsMoved = true;
      }
      fileOps.rename(stageDb, dbPath);
      newDbInstalled = true;
      fileOps.rename(stageAttachments, attachmentDir);
      newAttachmentsInstalled = true;
      return { dbPath, attachmentDir, safetyDir, attachmentCount: manifest.attachments.length };
    } catch (error) {
      const rollbackErrors: Error[] = [];
      if (newAttachmentsInstalled && existsSync(attachmentDir)) {
        try { rmSync(attachmentDir, { recursive: true, force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError as Error); }
      }
      if (newDbInstalled && existsSync(dbPath)) {
        try { unlinkSync(dbPath); } catch (rollbackError) { rollbackErrors.push(rollbackError as Error); }
      }
      if (oldAttachmentsMoved && existsSync(safeAttachments) && !existsSync(attachmentDir)) {
        try { fileOps.rename(safeAttachments, attachmentDir); } catch (rollbackError) { rollbackErrors.push(rollbackError as Error); }
      }
      if (oldDbMoved && existsSync(safeDb) && !existsSync(dbPath)) {
        try { fileOps.rename(safeDb, dbPath); } catch (rollbackError) { rollbackErrors.push(rollbackError as Error); }
      }
      if (rollbackErrors.length) {
        throw new Error(`恢复失败，原始数据安全副本保留在 ${safetyDir}；回滚也遇到错误：${rollbackErrors.map(item => item.message).join('；')}`, { cause: error });
      }
      try { rmSync(safetyDir, { recursive: true, force: true }); } catch { /* Original files have already been restored. */ }
      throw error;
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
