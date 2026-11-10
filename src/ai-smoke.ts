import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import net from 'node:net';
import ExcelJS from 'exceljs';
import { parseResearchFile } from './ai/parsers.ts';

const archiver = createRequire(import.meta.url)('archiver') as (format: string, options: Record<string, unknown>) => any;

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`AI SMOKE FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, 'close');
  return port;
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output || `${args.join(' ')} exited ${code}`)));
  });
}

async function makeZip(entries: Record<string, string>) {
  return new Promise<Buffer>((resolve, reject) => {
    const output: Buffer[] = [];
    const archive = archiver('zip', { store: true });
    archive.on('data', (chunk: Buffer) => output.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(output)));
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    void archive.finalize();
  });
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'ivd-ai-smoke-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), IVD_AI_COALESCE_MS: '0', IVD_AI_API_KEY: '',
  ADMIN_NAME: 'AI 测试管理员', ADMIN_EMAIL: 'ai-admin@example.test', ADMIN_PASSWORD: 'ai-smoke-password-long' };
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', value => serverOutput += value);
server.stderr.on('data', value => serverOutput += value);
let cookie = '';
const call = async (url: string, body?: any, method = 'GET', auth = cookie) => {
  const headers: Record<string, string> = {};
  if (auth) headers.Cookie = auth;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { response, status: response.status, data };
};
async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(base + '/api/health'); if (response.ok) return; } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`AI smoke server did not start: ${serverOutput}`);
}
async function uploadReport(title: string) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>实验目的：评估人工合成的缓冲条件。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>样本</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>结果 1.25 mg/mL</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const bytes = await makeZip({ '[Content_Types].xml': '<Types/>', '_rels/.rels': '<Relationships/>', 'word/document.xml': documentXml });
  const form = new FormData();
  form.set('title', title);
  form.set('description', '合成夹具，仅测试离线解析与来源定位。');
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'synthetic-report.docx');
  const result = await call('/api/research-reports', form, 'POST');
  equal(result.status, 201, '上传隔离 DOCX 报告');
  return result.data;
}
async function uploadRaw(reportId: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('读数表');
  sheet.addRow(['批次', '信号', '浓度']);
  sheet.addRow(['SYN-01', 15.25, { formula: 'B2/10', result: 1.525 }]);
  const hidden = workbook.addWorksheet('隐藏校准');
  hidden.state = 'hidden';
  hidden.addRow(['factor']); hidden.addRow([10]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const csv = Buffer.from('sample,value,unit\nSYN-01,1.25,mg/mL\nSYN-02,1.50,mg/mL\n', 'utf8');
  const form = new FormData();
  form.append('files', new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'raw-data.xlsx');
  form.append('files', new Blob([csv], { type: 'text/csv' }), 'raw-data.csv');
  const result = await call(`/api/research-reports/${reportId}/data-attachments`, form, 'POST');
  equal(result.status, 201, '一个事务上传多个原始数据文件');
  return result.data;
}

try {
  const multilineCsv = await parseResearchFile('multiline.csv', Buffer.from('name,value\r\n"sample,\r\n""A""",12\r\nB,20\r\n', 'utf8'));
  const csvRows = multilineCsv.datasets[0]?.rows || [];
  equal(csvRows.length, 2, '引号字段中的换行保持为同一个 CSV 数据行');
  equal(csvRows[0]['0'], 'sample,\n"A"', 'CSV 分隔符、换行和转义双引号在引号字段内原样解析');
  equal(csvRows[0]['1'], '12', '含换行 CSV 行中的数值列不会丢失');
  equal(csvRows[1]['0'], 'B', '多行字段后的下一条 CSV 记录边界正确');
  equal(csvRows[1]['1'], '20', '下一条 CSV 记录数值列保留');
  assert(multilineCsv.chunks.some(chunk => Number(chunk.locator.rowStart) === 2 && Number(chunk.locator.rowEnd) === 3
    && Number(chunk.locator.physicalLineStart) === 2 && Number(chunk.locator.physicalLineEnd) === 4), '多行 CSV 证据定位同时记录逻辑行和物理行范围');

  await run(['src/cli.ts', 'admin-init'], env);
  await waitForHealth();
  const login = await call('/api/auth/login', { email: 'ai-admin@example.test', password: 'ai-smoke-password-long' }, 'POST', '');
  equal(login.status, 200, '隔离 AI 管理员登录');
  cookie = (login.response.headers.get('set-cookie') || '').split(';')[0];
  const member = await call('/api/users', { name: 'AI 只读研发员', email: 'ai-member@example.test', password: 'ai-member-password-long', role: 'RESEARCHER' }, 'POST');
  equal(member.status, 201, '创建研发成员权限夹具');
  const memberLogin = await call('/api/auth/login', { email: 'ai-member@example.test', password: 'ai-member-password-long' }, 'POST', '');
  equal(memberLogin.status, 200, '研发成员登录');
  const memberCookie = (memberLogin.response.headers.get('set-cookie') || '').split(';')[0];
  const status = await call('/api/ai/status', undefined, 'GET', memberCookie);
  equal(status.status, 200, '登录成员可读取 AI 配置状态');
  equal(status.data.status, 'waiting_configuration', '未配置凭据时明确等待配置');
  assert(!JSON.stringify(status.data).includes('OPENAI_API_KEY='), 'AI 状态不包含实际密钥');
  equal((await call('/api/ai/admin/test-connection', {}, 'POST', memberCookie)).status, 403, '研发人员不能访问管理员模型连接接口');
  const defaultKnowledgeStatus = await call('/api/ai/knowledge/index-status');
  equal(defaultKnowledgeStatus.status, 200, '管理员可查看报告知识外发状态');
  equal(defaultKnowledgeStatus.data.enabled, false, '报告知识语义外发默认关闭');
  equal(defaultKnowledgeStatus.data.canManageExternalization, true, '管理员页面获得外发开关权限');
  const memberKnowledgeStatus = await call('/api/ai/knowledge/index-status', undefined, 'GET', memberCookie);
  equal(memberKnowledgeStatus.data.canManageExternalization, false, '普通成员只能查看报告知识外发状态');
  equal((await call('/api/ai/knowledge/externalization', { enabled: true }, 'PATCH', memberCookie)).status, 403,
    '普通成员不能启用报告知识语义外发');
  const disabledSemanticSearch = await call('/api/ai/knowledge?q=synthetic&semantic=true');
  equal(disabledSemanticSearch.data.mode, 'keyword', '报告知识外发关闭时页面检索保持本地关键词模式');
  assert(String(disabledSemanticSearch.data.fallbackReason).includes('尚未由管理员启用'), '关闭状态向页面明确说明未发起语义检索');

  const secretValue = 'synthetic-local-key';
  equal((await call('/api/ai/admin/config', { apiKey: secretValue }, 'PATCH', memberCookie)).status, 403, '普通成员不能设置密钥');
  const savedSecret = await call('/api/ai/admin/config', { apiKey: secretValue }, 'PATCH');
  equal(savedSecret.status, 200, '管理员可保存本地密钥');
  equal(savedSecret.data.apiKeyConfigured, true, '显示密钥配置状态');
  assert(!JSON.stringify(savedSecret.data).includes(secretValue), '响应不返回密钥');
  assert(!JSON.stringify((await call('/api/ai/admin/config')).data).includes(secretValue), '读取配置不返回密钥');
  const secretDb = new DatabaseSync(path.join(dataDir, 'ivd.sqlite'), { readOnly: true });
  assert(!JSON.stringify(secretDb.prepare('SELECT * FROM system_settings').all()).includes(secretValue), '设置表不保存密钥');
  assert(!JSON.stringify(secretDb.prepare('SELECT * FROM audit_events').all()).includes(secretValue), '审计记录不保存密钥');
  secretDb.close();
  rmSync(path.join(dataDir, 'ai-api-key'));

  const noModelCall = await call('/api/ai/admin/test-connection', {}, 'POST');
  equal(noModelCall.status, 409, '缺少模型凭据时连接检测不发起模型调用');

  const report = await uploadReport('AI 解析定位夹具');
  const attachments = await uploadRaw(report.id);
  equal(attachments.length, 2, '报告原始数据支持多个文件');
  const completed = await run(['src/ai-worker.ts'], { ...env, IVD_AI_WORKER_ONCE: '1', IVD_AI_FORCE_READY: '1' });
  assert(completed.length >= 0, '独立 AI Worker 正常退出');
  const analysis = await call(`/api/ai/reports/${report.id}/analysis`);
  equal(analysis.status, 200, '读取报告解析和任务状态');
  equal(analysis.data.jobs.length, 1, '正文与连续附件事件合并为一个幂等归档任务');
  equal(analysis.data.jobs[0].status, 'waiting_configuration', '离线解析完成后等待真实模型配置');
  assert(!analysis.data.current && analysis.data.analyses.length === 0, '没有凭据时不会伪造模型分析');
  equal(analysis.data.sources.length, 3, '分析详情列出正文和两个原始数据来源');
  assert(analysis.data.sources.every((source: any) => source.extraction && ['parsed','partial','unsupported','failed'].includes(source.extraction.status)), '分析详情逐文件显示解析状态和覆盖元数据');
  const evidence = await call(`/api/ai/reports/${report.id}/evidence`);
  equal(evidence.status, 200, '读取活动来源证据区段');
  assert(evidence.data.some((item: any) => item.locator.kind === 'paragraph' && item.text.includes('评估人工合成')), 'DOCX 正文段落带稳定段落定位');
  assert(evidence.data.some((item: any) => item.locator.kind === 'table_paragraph' && item.text.includes('1.25 mg/mL')), 'DOCX 表格内容带行列定位');
  assert(evidence.data.some((item: any) => item.locator.kind === 'worksheet_range' && item.locator.sheet === '读数表'), 'XLSX 工作表按名称与行范围定位');
  assert(evidence.data.some((item: any) => item.locator.sheet === '隐藏校准' && item.locator.hidden === true), '隐藏工作表纳入覆盖清单');
  assert(evidence.data.some((item: any) => item.locator.kind === 'delimited_rows' && item.text.includes('SYN-02')), 'CSV 表格保留原始行号和数据值');

  // Seed only the initial synthetic analysis and observation; review itself is exercised through the authenticated HTTP API here and through real browser form interaction in the acceptance run.
  const fixtureDb = new DatabaseSync(path.join(dataDir, 'ivd.sqlite'));
  fixtureDb.exec('PRAGMA foreign_keys=ON');
  try {
    const job = fixtureDb.prepare("SELECT * FROM ai_jobs WHERE report_id=? AND job_type='report_analysis' ORDER BY created_at DESC LIMIT 1").get(report.id) as any;
    const reportVersionId = String((fixtureDb.prepare('SELECT id FROM research_report_versions WHERE report_id=? ORDER BY version_no DESC LIMIT 1').get(report.id) as any).id);
    const fixtureAnalysisId = 'ana_ui_' + randomUUID();
    const fixtureObservationId = 'obs_ui_' + randomUUID();
    const source = evidence.data.find((item: any) => item.sourceKind === 'report_version');
    assert(source, '为合成结构化结果找到正文来源证据');
    fixtureDb.prepare(`UPDATE ai_jobs SET status='completed',finished_at=datetime('now'),updated_at=datetime('now'),progress_json=? WHERE id=?`)
      .run(JSON.stringify({ stage: 'completed', message: '合成浏览器初始分析结果' }), job.id);
    fixtureDb.prepare(`INSERT INTO research_analyses(id,job_id,report_id,report_version_id,status,summary,structured_json,evidence_gaps_json,coverage_json,input_manifest_json,
      provider,model,prompt_version,schema_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fixtureAnalysisId, job.id, report.id, reportVersionId, 'needs_review', '合成初始分析摘要：观察到 1.25 mg/mL。',
        JSON.stringify({ observations: [{ field_key: 'results', observation_type: 'source_statement', value: { value: '1.25', unit: 'mg/mL' }, evidence_ids: [source.id] }], assumptions: [] }),
        JSON.stringify(['合成待核实项：确认重复次数']), JSON.stringify({ sourceCount: 1, evidenceCount: 1 }),
        JSON.stringify({ fingerprint: job.input_fingerprint }), 'synthetic-fixture', 'synthetic-analysis-fixture', 'fixture', '1');
    fixtureDb.prepare(`INSERT INTO research_observations(id,report_id,analysis_id,field_key,observation_type,review_state,value_json,normalized_text)
      VALUES (?,?,?,'results','source_statement','machine_unconfirmed',?,?)`)
      .run(fixtureObservationId, report.id, fixtureAnalysisId, JSON.stringify({ value: '1.25', unit: 'mg/mL' }), '1.25 mg/ml');
    fixtureDb.prepare(`INSERT INTO evidence_refs(id,observation_id,analysis_id,report_id,source_version_id,source_kind,content_sha256,locator_json,source_excerpt)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('evr_ui_' + randomUUID(), fixtureObservationId, fixtureAnalysisId, report.id,
        source.sourceVersionId, source.sourceKind, source.contentSha256, JSON.stringify(source.locator), source.text.slice(0, 300));
    const currentDetail = await call(`/api/ai/reports/${report.id}/analysis`);
    equal(currentDetail.data.current.id, fixtureAnalysisId, '分析详情接口返回当前报告版本的分析结论');
    assert(currentDetail.data.current.evidenceGaps[0].includes('合成待核实'), '分析详情呈现当前证据缺口');
    const observations = await call(`/api/ai/reports/${report.id}/observations`);
    equal(observations.data.observations[0].reviewVersion, 1, '初始人工复核版本可在页面读取');
    const observationId = observations.data.observations[0].id;
    const memberKnowledge = await call('/api/ai/knowledge', undefined, 'GET', memberCookie);
    const memberCard = memberKnowledge.data.observations.find((item: any) => item.id === observationId);
    assert(memberCard && memberCard.canReview === false, '普通成员可读共享知识但没有复核权限');
    equal((await call(`/api/ai/observations/${observationId}/review`, { reviewState: 'corrected', correctedValue: { value: '1.30', unit: 'mg/mL' }, expectedVersion: 1 }, 'POST', memberCookie)).status,
      403, '服务端阻止普通成员修改共享观察');
    const adminReview = await call(`/api/ai/observations/${observationId}/review`, { reviewState: 'corrected', correctedValue: { value: '1.30', unit: 'mg/mL' }, comment: '合成浏览器流程：按来源复核后更正', expectedVersion: 1 }, 'POST');
    equal(adminReview.status, 201, '作者/管理员可提交带版本号的人工更正');
    equal(adminReview.data.reviewVersion, 2, '人工复核后版本号递增');
    equal((await call(`/api/ai/observations/${observationId}/review`, { reviewState: 'human_confirmed', expectedVersion: 1 }, 'POST')).status,
      409, '旧页面版本无法覆盖后来保存的人工更正');
    const correctedKnowledge = await call('/api/ai/knowledge', undefined, 'GET', memberCookie);
    const correctedCard = correctedKnowledge.data.observations.find((item: any) => item.id === observationId);
    equal(correctedCard.value.value, '1.30', '跨成员知识检索采用人工更正值');
    equal(correctedCard.originalValue.value, '1.25', '跨成员知识卡仍留存原始模型值供对照');
    const authorReviewCard = (await call('/api/ai/knowledge')).data.observations.find((item: any) => item.id === observationId);
    assert(authorReviewCard.canReview, '报告作者/管理员知识卡显示复核入口权限');
    equal((fixtureDb.prepare('SELECT COUNT(*) AS n FROM report_knowledge_index_jobs WHERE report_id=?').get(report.id) as any).n, 0,
      '默认关闭状态下报告分析与人工更正不会自动建立可外发索引任务');

    equal((await call(`/api/ai/reports/${report.id}/analyze`, {}, 'POST', memberCookie)).status, 403, '普通成员不能从报告详情发起分析任务');
    const manualJob = await call(`/api/ai/reports/${report.id}/analyze`, {}, 'POST');
    equal(manualJob.status, 202, '没有活动任务时作者/管理员可发起新的持久分析任务');
    equal((await call(`/api/ai/reports/${report.id}/analyze`, {}, 'POST')).status, 409, '已有活动分析任务时阻止重复排队');
    equal((await call(`/api/ai/jobs/${manualJob.data.jobId}/cancel`, {}, 'POST', memberCookie)).status, 404, '普通成员不能取消报告分析任务');
    equal((await call(`/api/ai/jobs/${manualJob.data.jobId}/cancel`, {}, 'POST')).status, 200, '作者/管理员可取消排队任务');
    const retryJob = await call(`/api/ai/reports/${report.id}/analyze`, {}, 'POST');
    equal(retryJob.status, 202, '取消队列任务后允许重新分析');
    fixtureDb.prepare(`UPDATE ai_jobs SET status='failed',error_code='network_timeout',error_message='合成的暂时性网络中断',usage_status='known',
      usage_total_tokens=10,usage_input_tokens=6,usage_output_tokens=4,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(retryJob.data.jobId);
    equal((await call(`/api/ai/jobs/${retryJob.data.jobId}/retry`, {}, 'POST', memberCookie)).status, 404, '普通成员不能重试报告任务');
    equal((await call(`/api/ai/jobs/${retryJob.data.jobId}/retry`, {}, 'POST')).status, 200, '可重试网络错误沿用累计预算与用量后重新排队');
    const retried = fixtureDb.prepare('SELECT status,max_attempts,usage_total_tokens FROM ai_jobs WHERE id=?').get(retryJob.data.jobId) as any;
    equal(retried.status, 'queued', '显式重试任务回到持久队列');
    equal(Number(retried.usage_total_tokens), 10, '显式重试不清空已知累计 token 用量');
    equal((await call('/api/ai/knowledge/externalization', { enabled: true }, 'PATCH', memberCookie)).status, 403,
      '普通成员不能切换报告语义外发许可');
    const adminEnabledKnowledge = await call('/api/ai/knowledge/externalization', { enabled: true }, 'PATCH');
    equal(adminEnabledKnowledge.status, 200, '管理员可通过单独授权开启报告知识语义外发');
    equal((await call('/api/ai/knowledge/index-status')).data.enabled, true, '启用状态持久化并显示给成员');
    const adminDisabledKnowledge = await call('/api/ai/knowledge/externalization', { enabled: false }, 'PATCH');
    equal(adminDisabledKnowledge.status, 200, '管理员可关闭报告知识语义外发');
    equal((await call('/api/ai/knowledge/index-status')).data.enabled, false, '关闭状态在服务端持久化');
    const afterOptOutSearch = await call('/api/ai/knowledge?q=protein&semantic=true');
    equal(afterOptOutSearch.data.mode, 'keyword', '关闭外发后页面接口回到关键词检索');
  } finally { fixtureDb.close(); }

  const events = await call(`/api/ai/jobs/${analysis.data.jobs[0].id}/events`);
  assert(events.status === 200 && events.data.some((item: any) => item.message.includes('waiting') || item.type === 'waiting_configuration'), '持久任务事件记录等待配置状态');
  const replay = await call('/api/ai/jobs/' + analysis.data.jobs[0].id);
  equal(replay.status, 200, '任务状态可在独立 Worker 进程后恢复查询');

  const race = await uploadReport('AI 删除竞态夹具');
  const beforeDelete = await call(`/api/ai/reports/${race.id}/analysis`);
  assert(beforeDelete.data.jobs.length === 0, 'outbox 延迟合并前尚未创建归档任务');
  equal((await call(`/api/research-reports/${race.id}`, {}, 'DELETE')).status, 200, '软删除竞态报告');
  await run(['src/ai-worker.ts'], { ...env, IVD_AI_WORKER_ONCE: '1', IVD_AI_FORCE_READY: '1' });
  equal((await call(`/api/ai/reports/${race.id}/analysis`)).status, 404, '删除来源被隔离于 AI 查询');

  console.log('AI SMOKE PASS: Pi 依赖接入、密钥不落库、无凭据不外呼、DOCX/XLSX/CSV 离线解析定位、隐藏工作表覆盖、任务/事件持久化、连续上传事件合并、删除来源竞态拦截均通过。');
} finally {
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]);
  rmSync(dataDir, { recursive: true, force: true });
}
import './test-isolation.mjs';
