import { restoreBackup } from './restore-core.ts';

const args = process.argv.slice(2);
const archivePath = args.find(value => value.startsWith('--file='))?.slice(7) || args[0] || '';
const dataDir = process.env.DATA_DIR || 'data';
const result = await restoreBackup(archivePath, dataDir);
console.log(`备份恢复完成：${result.dbPath}`);
console.log(`附件文件：${result.attachmentCount} 个`);
console.log(`恢复前数据保留在：${result.safetyDir}`);
