import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`LITERATURE WORKER SMOKE FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);
async function freePort() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as net.AddressInfo).port; probe.close(); await once(probe, 'close'); return port;
}
function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output || `${args.join(' ')} exited ${code}`)));
  });
}
async function pdfWithPages(pageTexts: string[]) {
  const objects = new Array<string>(3 + pageTexts.length * 2);
  const pageIds = pageTexts.map((_text, index) => 4 + index * 2);
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(pageId => `${pageId} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageTexts.forEach((text, index) => {
    const pageId = pageIds[index]; const streamId = pageId + 1;
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const stream = text ? `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET\n` : '';
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId - 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
const pdfWithText = (text: string) => pdfWithPages([text]);

const dataDir = mkdtempSync(path.join(tmpdir(), 'ivd-literature-worker-smoke-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), IVD_AI_API_KEY: '', IVD_EMBEDDING_API_KEY: '',
  ADMIN_NAME: '文献解析测试管理员', ADMIN_EMAIL: 'literature-worker-admin@example.test', ADMIN_PASSWORD: 'literature-worker-password-long' };
let server: ReturnType<typeof spawn> | undefined;
let serverOutput = '';
let cookie = '';
const call = async (url: string, body?: FormData | any, method = 'GET') => {
  const headers: Record<string, string> = { Cookie: cookie };
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  return { status: response.status, data };
};
async function waitForHealth() {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* startup */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Worker smoke server did not start: ${serverOutput}`);
}

try {
  await run(['src/cli.ts', 'admin-init'], env);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout?.on('data', value => serverOutput += value); server.stderr?.on('data', value => serverOutput += value);
  await waitForHealth();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) });
  equal(login.status, 200, '隔离管理员登录'); cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const pdf = await pdfWithText('Literature evidence has 17 samples and a protein assay validation method.');
  const body = new FormData(); body.set('records', JSON.stringify([{ title: 'Synthetic PDF parser coverage', year: 2024, authors: ['Local Fixture'] }]));
  body.append('files', new Blob([pdf], { type: 'application/pdf' }), 'synthetic-paper.pdf');
  const created = await call('/api/literature', body, 'POST');
  equal(created.status, 201, '合成数字 PDF 通过文件签名和书目写入');
  const itemId = String(created.data.results[0].item.id);
  equal(created.data.results[0].item.jobs[0].status, 'queued', '文件入库后解析任务持久排队');

  const workerOutput = await run(['src/literature-worker.ts'], { ...env, IVD_LITERATURE_WORKER_ONCE: '1' });
  assert(workerOutput.length >= 0, '独立文献 Worker 执行一次任务');
  const detail = await call(`/api/literature/${itemId}`);
  equal(detail.status, 200, '查询文献解析详情');
  equal(detail.data.extraction?.status, 'parsed', `数字 PDF 文本层解析完成; worker=${workerOutput}; detail=${JSON.stringify({ extraction: detail.data.extraction, jobs: detail.data.jobs })}`);
  equal(detail.data.extraction?.page_count, 1, 'PDF 解析保留实际页数');
  equal(detail.data.extraction?.pages_read, 1, 'PDF 解析记录读取页数');
  assert(detail.data.chunks.some((chunk: any) => chunk.source_extent === 'full_text' && chunk.content_text.includes('17 samples')),
    '全文片段持久保存且可检索原文');
  const chunk = detail.data.chunks.find((row: any) => row.source_extent === 'full_text');
  equal(JSON.parse(chunk.locator_json).page, 1, '全文片段包含 PDF 物理页码定位');
  equal(detail.data.jobs[0].status, 'completed', 'Worker 以租约持有者完成任务');
  equal(detail.data.jobs[0].attempt_count, 1, '任务尝试次数留痕');
  const bytes = Buffer.from(pdf);
  equal(createHash('sha256').update(bytes).digest('hex'), created.data.results[0].item.currentVersion.sha256, 'PDF 源文件 SHA-256 留痕');

  const parser = await import('./literature/parser.ts');
  const scan = await parser.parseLiteratureFile('scan.pdf', await pdfWithText(''));
  equal(scan.status, 'needs_ocr', '不含文本层的 PDF 明确标记待 OCR');
  equal(scan.coverage.ocr && (scan.coverage.ocr as any).used, false, '未将未配置的 OCR 假报为已执行');
  const mixed = await parser.parseLiteratureFile('mixed-scan.pdf', await pdfWithPages(['A searchable result appears on page one.', '']));
  equal(mixed.status, 'partial', '混合型 PDF 中同时含可读文本页和无文本页时明确标记部分覆盖');
  equal(JSON.stringify(mixed.coverage.pagesWithoutText), '[2]', '未提取文本的实际 PDF 页码单列');
  assert(String(mixed.coverage.omittedReason).includes('第 2 页'), '部分覆盖原因明确指出缺失页码');
  const pageFailure = await parser.parsePdfDocument({ numPages: 2, getPage: async (pageNumber: number) => {
    if (pageNumber === 2) throw new Error('Synthetic page content failure');
    return { getTextContent: async () => ({ items: [{ str: 'Page one has readable text.', hasEOL: true }] }), cleanup() {} };
  } });
  equal(pageFailure.status, 'partial', '单页内容流解析异常保留同一文件其他已解析页面');
  equal(JSON.stringify(pageFailure.coverage.pagesFailed), '[2]', '解析异常页单列页码');
  assert(String(pageFailure.coverage.omittedReason).includes('解析失败'), '页面级异常明确标记内容覆盖不完整');
  const textLimit = await parser.parseLiteratureFile('over-limit.txt', Buffer.from('x'.repeat(2_000_001), 'utf8'));
  equal(textLimit.status, 'partial', '纯文本达到提取上限后标记部分覆盖');
  equal(textLimit.textLength, 2_000_000, '纯文本正文严格截断到配置字符上限');
  assert(String(textLimit.coverage.omittedReason).includes('2,000,000'), '纯文本超限原因明确呈现上限');
  const { LITERATURE_MAX_PDF_PAGES } = parser;
  let pageLimitCalls = 0;
  const tooManyPages = await parser.parsePdfDocument({ numPages: LITERATURE_MAX_PDF_PAGES + 1, getPage: async () => {
    pageLimitCalls++;
    return { getTextContent: async () => ({ items: [{ str: 'Page text to verify PDF page cap.', hasEOL: true }] }), cleanup() {} };
  } });
  equal(tooManyPages.status, 'partial', '超过页数上限的可读PDF明确标记部分覆盖');
  equal(tooManyPages.pagesRead, LITERATURE_MAX_PDF_PAGES, 'PDF严格停止在页数上限');
  equal(pageLimitCalls, LITERATURE_MAX_PDF_PAGES, 'PDF上限后不再读取后续页面');
  assert(String(tooManyPages.coverage.omittedReason).includes('最大页数上限'), 'PDF页数截断原因明确呈现');
  console.log('LITERATURE WORKER SMOKE PASS: 隔离任务队列、独立 Worker、PDF.js 文本层/页码/SHA、租约栅栏、待 OCR、混合PDF、页级异常及PDF页数/文本上限均通过。');
} finally {
  if (server) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]); }
  rmSync(dataDir, { recursive: true, force: true });
}
import './test-isolation.mjs';
