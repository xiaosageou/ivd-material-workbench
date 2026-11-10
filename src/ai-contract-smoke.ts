import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`AI CONTRACT FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);
const childMode = process.env.IVD_AI_CONTRACT_CHILD === '1';
const isolated = childMode ? process.env.DATA_DIR! : mkdtempSync(path.join(tmpdir(), 'ivd-ai-contract-'));
if (childMode) {
process.env.DATA_DIR = isolated;
process.env.IVD_AI_API_KEY = 'synthetic-contract-key';

try {
  const { db, id, transaction } = await import('./db.ts');
  const { createModels, createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, Type } = await import('@earendil-works/pi-ai');
  const { runPiAgent } = await import('./ai/provider.ts');
  const { createJobTokenUsageController, markPendingUsageUnknown, normalizeProviderUsage } = await import('./ai/usage.ts');
  const { classifyAiTaskError, planAiTaskRetry, retryDelayMs } = await import('./ai/errors.ts');
  const { analyzeReport, loadCurrentChunks, validateAnalysisPayload } = await import('./ai/analysis.ts');
  const { PARSER_VERSION } = await import('./ai/parsers.ts');
  const { getCurrentKnowledgeObservationsByIds, searchKnowledge } = await import('./ai/knowledge.ts');
  const { enqueueReportKnowledgeIndex, reportKnowledgeExternalizationEnabled, setReportKnowledgeExternalizationEnabled } = await import('./report-knowledge.ts');
  const { currentReportManifest, writeJobFromManifest } = await import('./ai/jobs.ts');
  const { enqueueSuggestionJob, completeSuggestionJob, getSuggestionForUser, editSuggestion, confirmSuggestion } = await import('./ai/suggestions.ts');
  const { saveRecipeVersion } = await import('./recipe-service.ts');
  const { createAssistantSession, getAssistantSession, getOwnedSession, enqueueChatMessage } = await import('./ai/chat.ts');
  const { assessObservationComparison, buildAssistantTools } = await import('./ai/tools.ts');
  const { runAiWorkerOnce } = await import('./ai/worker.ts');

  let requestedMaxTokens: number | undefined;
  let requestedMaxRetries: number | undefined;
  const faux = fauxProvider({ provider: 'ivd_contract_fixture', api: 'ivd-contract-faux', models: [{ id: 'synthetic-model' }] });
  faux.setResponses([(_context, options) => {
    requestedMaxTokens = options?.maxTokens;
    requestedMaxRetries = options?.maxRetries;
    return fauxAssistantMessage('Synthetic Pi SDK response');
  }]);
  const models = createModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(faux.provider);
  const sdkResponse = await runPiAgent({ config: { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'http://fixture.invalid/v1',
    autoArchive: true, maxTokens: 1024, taskTokenBudget: 4096, timeoutMs: 5000, maxToolCalls: 2 }, systemPrompt: 'fixture', prompt: 'return fixture' },
    { models, model: faux.getModel() });
  equal(sdkResponse.text, 'Synthetic Pi SDK response', 'Pi Agent 使用显式 faux provider 完成一次受控调用');
  equal(faux.state.callCount, 1, '合成模型调用次数可验证');
  equal(requestedMaxTokens, 1024, '管理员 maxTokens 设置作为真实 Pi streamSimple 请求参数传入');
  equal(requestedMaxRetries, 0, 'Pi provider 内部重试关闭，由任务层有限重试统一计量');
  const userId = 'fixture-user';
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)`).run(userId, '合成研发员', 'fixture@example.test', 'fixture', 'RESEARCHER');
  equal(reportKnowledgeExternalizationEnabled(), false, '报告知识外发在全新数据库中默认关闭');
  equal(setReportKnowledgeExternalizationEnabled(true, userId).enabled, true, '只有显式切换报告外发许可后才启用索引任务');
  const tokenJob = (name: string, budgetTokens: number, attempt = 1) => {
    const jobId = id('aij_');
    const leaseOwner = `lease-${name}-${attempt}`;
    db.prepare(`INSERT INTO ai_jobs(id,job_type,requested_by,input_fingerprint,status,budget_tokens,lease_owner,lease_until_ms,attempt_count,max_attempts)
      VALUES (?,'assistant_chat',?,?,'analyzing',?,?,?, ?,3)`)
      .run(jobId, userId, `token:${name}`, budgetTokens, leaseOwner, Date.now() + 60_000, attempt);
    return db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(jobId) as any;
  };
  const providerUsage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const withUsage = (models: any, usageForCall: (index: number) => unknown) => {
    const originalStream = models.streamSimple.bind(models);
    const wrappedModels = Object.create(models);
    let callCount = 0;
    wrappedModels.streamSimple = (model: any, context: any, options: any) => {
      const index = callCount++;
      const source = originalStream(model, context, options);
      const output = createAssistantMessageEventStream();
      void (async () => {
        let finalMessage: any;
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') finalMessage = event.message;
          else output.push(event);
        }
        finalMessage ||= await source.result();
        output.end({ ...finalMessage, usage: usageForCall(index) });
      })();
      return output;
    };
    return { models: wrappedModels, callCount: () => callCount };
  };
  const toolFixture = { name: 'fixture_read', label: '合成读取', description: '返回合成测试数据', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'fixture result' }], details: {} }) };
  const tokenConfig = { provider: 'openai-compatible' as const, model: 'synthetic-model', baseUrl: 'http://fixture.invalid/v1',
    autoArchive: true, maxTokens: 100, taskTokenBudget: 20, timeoutMs: 5000, maxToolCalls: 4 };

  const roundsJob = tokenJob('multi-round', 10);
  const roundFaux = fauxProvider({ provider: 'ivd_usage_rounds', api: 'ivd-usage-rounds', models: [{ id: 'synthetic-model' }] });
  const roundModels = createModels({ credentials: new InMemoryCredentialStore() }); roundModels.setProvider(roundFaux.provider);
  const roundMaxTokens: number[] = [];
  roundFaux.setResponses([
    (_context, options) => { roundMaxTokens.push(Number(options?.maxTokens)); return fauxAssistantMessage([fauxToolCall('fixture_read', {})], { stopReason: 'toolUse', responseId: 'round-response-1' }); },
    (_context, options) => { roundMaxTokens.push(Number(options?.maxTokens)); return fauxAssistantMessage('第二轮结论', { responseId: 'round-response-2' }); },
  ]);
  const roundRuntime = withUsage(roundModels, index => index === 0 ? providerUsage(2, 3, 1, 0) : providerUsage(1, 1, 1, 1));
  const roundUsage = createJobTokenUsageController(roundsJob);
  const roundResult = await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'run one tool then answer', tools: [toolFixture], usage: roundUsage },
    { models: roundRuntime.models, model: roundFaux.getModel() });
  const roundSnapshot = roundUsage.snapshot();
  equal(roundResult.text, '第二轮结论', '多轮 faux provider 在累计预算内完成工具轮次');
  equal(roundRuntime.callCount(), 2, '工具轮次的每次模型调用均有计数');
  equal(roundMaxTokens.join(','), '10,4', '后续请求的单次输出上限收敛到剩余任务预算');
  equal(roundSnapshot.usedTokens, 10, '多轮请求按 provider totalTokens 累计 input/output/cache tokens');
  equal(roundSnapshot.cacheReadTokens, 2, '缓存读取 token 纳入累计预算且独立留存');
  equal(roundSnapshot.cacheWriteTokens, 1, '缓存写入 token 纳入累计预算且独立留存');
  equal(roundSnapshot.requestCount, 2, '任务持久保存两次 provider 请求数');
  equal(roundSnapshot.status, 'known', '所有多轮响应均有 provider usage 时状态为 known');
  equal(roundSnapshot.stopReason, 'budget_exhausted', '预算恰好用尽时持久保存停止原因');
  equal(roundSnapshot.lastResponseId, 'round-response-2', '任务持久保存最后一次 provider response ID');
  equal(roundSnapshot.providerStopReason, 'stop', '任务持久保存 provider stop reason');

  const overshootJob = tokenJob('request-input-overshoot', 5);
  const overshootFaux = fauxProvider({ provider: 'ivd_usage_overshoot', api: 'ivd-usage-overshoot', models: [{ id: 'synthetic-model' }] });
  const overshootBaseModels = createModels({ credentials: new InMemoryCredentialStore() }); overshootBaseModels.setProvider(overshootFaux.provider);
  overshootFaux.setResponses([fauxAssistantMessage('overshoot fixture')]);
  const overshootRuntime = withUsage(overshootBaseModels, () => providerUsage(8, 1));
  const overshootUsage = createJobTokenUsageController(overshootJob);
  let inFlightOverrunRecorded = false;
  try { await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'input may exceed task budget', usage: overshootUsage },
    { models: overshootRuntime.models, model: overshootFaux.getModel() }); } catch (error) { inFlightOverrunRecorded = (error as any)?.code === 'token_budget_exhausted'; }
  equal(inFlightOverrunRecorded, true, '请求返回后发现输入令牌令任务超过预算时不发布结果');
  equal(overshootRuntime.callCount(), 1, '已发出的请求按边界说明只允许单次响应后停止');
  equal(overshootUsage.snapshot().usedTokens, 9, '保留 provider 报告的实际超预算值');
  equal(overshootUsage.snapshot().stopReason, 'budget_exceeded_by_inflight_request', '持久停止原因注明单次在途请求导致超额');

  const retryJobFirst = tokenJob('retry-retains-usage', 12, 1);
  const retryFaux = fauxProvider({ provider: 'ivd_usage_retry', api: 'ivd-usage-retry', models: [{ id: 'synthetic-model' }] });
  const retryModels = createModels({ credentials: new InMemoryCredentialStore() }); retryModels.setProvider(retryFaux.provider);
  const retryMaxTokens: number[] = [];
  retryFaux.setResponses([(_context, options) => { retryMaxTokens.push(Number(options?.maxTokens)); return fauxAssistantMessage('first attempt'); }]);
  const retryRuntime = withUsage(retryModels, index => index === 0 ? providerUsage(2, 3) : providerUsage(4, 3));
  const retryUsageFirst = createJobTokenUsageController(retryJobFirst);
  await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'first attempt', usage: retryUsageFirst },
    { models: retryRuntime.models, model: retryFaux.getModel() });
  equal(retryUsageFirst.snapshot().usedTokens, 5, '第一次尝试完成后已知用量写入任务行');
  db.prepare(`UPDATE ai_jobs SET lease_owner=?,lease_until_ms=?,attempt_count=2,status='analyzing' WHERE id=?`)
    .run('lease-retry-retains-usage-2', Date.now() + 60_000, retryJobFirst.id);
  const retryJobSecond = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(retryJobFirst.id) as any;
  const retryUsageSecond = createJobTokenUsageController(retryJobSecond);
  retryFaux.appendResponses([(_context, options) => { retryMaxTokens.push(Number(options?.maxTokens)); return fauxAssistantMessage([fauxToolCall('fixture_read', {})], { stopReason: 'toolUse' }); }]);
  let retryBudgetStopped = false;
  try { await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'retry round', tools: [toolFixture], usage: retryUsageSecond },
    { models: retryRuntime.models, model: retryFaux.getModel() }); } catch (error) { retryBudgetStopped = (error as any)?.code === 'token_budget_exhausted'; }
  equal(retryBudgetStopped, true, '跨 attempt 的第二轮达到预算后阻止继续生成');
  equal(retryFaux.state.callCount, 2, '跨 attempt 重试后没有发出第三次模型请求');
  equal(retryMaxTokens.join(','), '12,7', '重试请求读取已有用量，只获得剩余七个输出 token 上限');
  equal(retryUsageSecond.snapshot().usedTokens, 12, '跨 attempt 后用量累计不从零刷新');
  equal(retryUsageSecond.snapshot().requestCount, 2, '跨 attempt 请求数持久累计');

  const missingJobAttemptOne = tokenJob('missing-usage', 50, 1);
  db.prepare(`UPDATE ai_jobs SET usage_input_tokens=3,usage_output_tokens=4,usage_total_tokens=7,usage_request_count=1,usage_status='known',
    lease_owner='lease-missing-usage-2',attempt_count=2 WHERE id=?`).run(missingJobAttemptOne.id);
  const missingJob = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(missingJobAttemptOne.id) as any;
  const missingUsage = createJobTokenUsageController(missingJob);
  const missingFaux = fauxProvider({ provider: 'ivd_usage_missing', api: 'ivd-usage-missing', models: [{ id: 'synthetic-model' }] });
  const missingBaseModels = createModels({ credentials: new InMemoryCredentialStore() }); missingBaseModels.setProvider(missingFaux.provider);
  missingFaux.setResponses([fauxAssistantMessage([fauxToolCall('fixture_read', {})], { stopReason: 'toolUse' })]);
  const missingRuntime = withUsage(missingBaseModels, () => undefined);
  let unknownStopped = false;
  try { await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'missing usage', tools: [toolFixture], usage: missingUsage },
    { models: missingRuntime.models, model: missingFaux.getModel() }); } catch (error) { unknownStopped = (error as any)?.code === 'token_usage_unknown'; }
  equal(unknownStopped, true, 'provider 缺失用量时任务失败关闭而不发布无核算结果');
  equal(missingRuntime.callCount(), 1, '缺失 usage 后多轮工具链不发起额外请求');
  equal(missingUsage.snapshot().usedTokens, 7, '缺失 usage 不抹除前一 attempt 的已知累计值');
  equal(missingUsage.snapshot().unknownRequestCount, 1, '缺失 usage 持久记为一次未知请求');
  equal(missingUsage.snapshot().status, 'partial_unknown', '已有已知用量且新请求缺 usage 时标记 partial_unknown');
  db.prepare(`UPDATE ai_jobs SET lease_owner='lease-missing-usage-3',lease_until_ms=?,attempt_count=3,status='analyzing' WHERE id=?`)
    .run(Date.now() + 60_000, missingJob.id);
  let retryUnknownStopped = false;
  try { await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'retry unknown usage', usage: createJobTokenUsageController(db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(missingJob.id) as any) },
    { models: missingRuntime.models, model: missingFaux.getModel() }); } catch (error) { retryUnknownStopped = (error as any)?.code === 'token_usage_unknown'; }
  equal(retryUnknownStopped, true, '跨 attempt 的未知用量阻止后续请求');
  equal(missingRuntime.callCount(), 1, '未知 usage 的重试在 provider 调用前停止');
  equal(missingUsage.snapshot().requestCount, 2, '未知 usage 请求计入调用数但不伪造 token 数');

  const cancelledJob = tokenJob('cancel-before-request', 50);
  const cancelledUsage = createJobTokenUsageController(cancelledJob);
  const cancelledFaux = fauxProvider({ provider: 'ivd_usage_cancel', api: 'ivd-usage-cancel', models: [{ id: 'synthetic-model' }] });
  const cancelledModels = createModels({ credentials: new InMemoryCredentialStore() }); cancelledModels.setProvider(cancelledFaux.provider);
  cancelledFaux.setResponses([fauxAssistantMessage('must not be requested')]);
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  let cancelledBeforeRequest = false;
  try { await runPiAgent({ config: tokenConfig, systemPrompt: 'fixture', prompt: 'cancelled', signal: alreadyCancelled.signal, usage: cancelledUsage },
    { models: cancelledModels, model: cancelledFaux.getModel() }); } catch { cancelledBeforeRequest = true; }
  equal(cancelledBeforeRequest, true, '预先取消的任务不会等待或发布模型响应');
  equal(cancelledFaux.state.callCount, 0, '取消在 provider 调用前生效');
  equal(cancelledUsage.snapshot().requestCount, 0, '取消前没有登记请求或消耗');

  const interruptedJob = tokenJob('interrupted-request', 50);
  const interruptedUsage = createJobTokenUsageController(interruptedJob);
  interruptedUsage.beforeRequest();
  equal(interruptedUsage.snapshot().pendingRequestCount, 1, '已发出请求先持久标记为待结算');
  assert(markPendingUsageUnknown(interruptedJob), '工作进程/请求异常退出时将未结算请求关闭为未知');
  equal(interruptedUsage.snapshot().pendingRequestCount, 0, '异常请求关闭后不留下永久 pending 状态');
  equal(interruptedUsage.snapshot().unknownRequestCount, 1, '中断且无 usage 的请求按未知计数，不填入零');
  const interruptedRetry = planAiTaskRetry(new Error('ETIMEDOUT'), 1, 3, true);
  assert(!interruptedRetry.retryable && interruptedRetry.classification.code === 'network_timeout',
    '超时分类保留，但未结算用量未知时不自动重试');
  assert(interruptedRetry.classification.message.includes('用量未知'), '超时错误在未知 usage 时明确显示自动重试已停止');
  const erroredResponseJob = tokenJob('error-with-reported-usage', 50);
  const erroredResponseUsage = createJobTokenUsageController(erroredResponseJob);
  erroredResponseUsage.beforeRequest();
  erroredResponseUsage.recordProviderMessage(providerUsage(2, 1, 1, 0), 'error', 'error-response-fixture');
  equal(erroredResponseUsage.snapshot().usedTokens, 4, '错误终态仍带有完整 Pi usage 时累计实际报告用量');
  equal(erroredResponseUsage.snapshot().providerStopReason, 'error', '错误响应的 stop reason 留痕');

  equal(normalizeProviderUsage(providerUsage(3, 4, 2, 1))?.totalTokens, 10, 'Pi usage totalTokens 按 input/output/cacheRead/cacheWrite 累计一次');
  equal(normalizeProviderUsage({ input: '3', output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }), undefined,
    '数值字符串 usage 不会被转换成精确 token 数');
  equal(normalizeProviderUsage({ input: 3, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 7 }), undefined,
    'provider 分项与 totalTokens 不一致时按 usage 未知处理');
  equal(normalizeProviderUsage({ input: 3, output: 4, totalTokens: 7 }), undefined, '缺少 cache 分项时不伪造完整 usage');
  equal(normalizeProviderUsage(providerUsage(0, 0)), undefined, 'Pi SDK 无 usage chunk 时的默认全零 usage 按未知处理');
  assert(classifyAiTaskError(new Error('401 Unauthorized')).code === 'credential_error', '认证失败归类为 credential_error');
  assert(classifyAiTaskError(new Error('429 rate limit')).code === 'rate_limited', '服务限流归类为 rate_limited');
  assert(classifyAiTaskError(new Error('invalid_request_error 400')).retryable === false, '输入/请求格式错误不自动重试');
  assert(classifyAiTaskError(new Error('ETIMEDOUT')).code === 'network_timeout', '网络超时归类并保留潜在已计费用量说明');
  const codedInputError = new Error('sanitized') as Error & { code: string }; codedInputError.code = 'input_error';
  equal(classifyAiTaskError(codedInputError).code, 'input_error', '任务层重复分类保留输入错误 code 并避免重试');
  const codedQuotaError = new Error('sanitized') as Error & { code: string }; codedQuotaError.code = 'quota_exhausted';
  equal(classifyAiTaskError(codedQuotaError).code, 'quota_exhausted', '任务层重复分类保留额度错误 code 并避免重试');
  const transientRetry = planAiTaskRetry(new Error('temporary processing error'), 1, 3, false);
  assert(transientRetry.retryable && transientRetry.delayMs === 2000, '已知用量时短暂错误采用有限指数退避');
  const unknownRetry = planAiTaskRetry(new Error('429 rate limit'), 1, 3, true);
  assert(!unknownRetry.retryable && unknownRetry.classification.code === 'rate_limited', '用量未知时保留限流分类并停止自动重试');
  assert(!planAiTaskRetry(new Error('temporary processing error'), 3, 3, false).retryable, '任务尝试次数达到上限后停止重试');
  equal(retryDelayMs(1), 2000, '有限退避首轮延迟为 2 秒');
  equal(retryDelayMs(3), 8000, '有限退避随 attempt 指数递增');
  equal(retryDelayMs(20), 30_000, '有限退避延迟封顶 30 秒');

  // Exercise Pi's real OpenAI-compatible HTTP/SSE adapter. Its message Usage defaults to zero
  // unless an actual usage chunk arrives; these tests deliberately do not rewrite SDK messages.
  let httpMode: 'text_no_usage' | 'tool_no_usage' | 'valid_usage' | 'error_no_usage' = 'text_no_usage';
  let httpRequests = 0;
  const localAiServer = createServer((request, response) => {
    request.resume();
    httpRequests++;
    if (httpMode === 'error_no_usage') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic local server error', type: 'server_error', code: 'synthetic_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const id = `local-sdk-response-${httpRequests}`;
    const chunk = (choices: unknown[], usage?: unknown) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1,
      model: 'synthetic-model', choices, ...(usage ? { usage } : {}) })}\n\n`);
    if (httpMode === 'tool_no_usage') {
      chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `local-call-${httpRequests}`, type: 'function',
        function: { name: 'fixture_read', arguments: '{}' } }] }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
    } else {
      chunk([{ index: 0, delta: { role: 'assistant', content: 'Local SDK adapter response' }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      if (httpMode === 'valid_usage') chunk([], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    localAiServer.once('error', reject);
    localAiServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const httpPort = (localAiServer.address() as any).port as number;
    const httpConfig = { ...tokenConfig, baseUrl: `http://127.0.0.1:${httpPort}/v1`, taskTokenBudget: 100, timeoutMs: 5000 };
    const noUsageJob = tokenJob('http-text-no-usage', 100);
    const noUsage = createJobTokenUsageController(noUsageJob);
    let textNoUsageRejected = false;
    const beforeTextRequests = httpRequests;
    try { await runPiAgent({ config: httpConfig, systemPrompt: 'synthetic fixture prompt', prompt: 'text with no usage', usage: noUsage }); }
    catch (error) { textNoUsageRejected = (error as any)?.code === 'token_usage_unknown'; }
    equal(textNoUsageRejected, true, '真实 Pi HTTP/SSE adapter 的非空文本与默认全零 usage 被标记未知');
    equal(noUsage.snapshot().status, 'unknown', '缺失 usage 的 SDK 文本响应不会登记为 known');
    equal(noUsage.snapshot().usedTokens, 0, '缺失 usage 不伪造估算 token 数');
    equal(httpRequests - beforeTextRequests, 1, '无 usage 文本场景只发出一次真实 adapter 请求');
    let textRetryBlocked = false;
    try { await runPiAgent({ config: httpConfig, systemPrompt: 'synthetic fixture prompt', prompt: 'retry must stop', usage: noUsage }); }
    catch (error) { textRetryBlocked = (error as any)?.code === 'token_usage_unknown'; }
    equal(textRetryBlocked, true, '同任务重试在真实 adapter 请求前因 usage 未知而阻断');
    equal(httpRequests - beforeTextRequests, 1, '无 usage 文本任务没有发出第二个 HTTP 请求');

    httpMode = 'tool_no_usage';
    const toolUsage = createJobTokenUsageController(tokenJob('http-tool-no-usage', 100));
    const beforeToolRequests = httpRequests;
    let toolNoUsageRejected = false;
    try { await runPiAgent({ config: httpConfig, systemPrompt: 'synthetic fixture prompt', prompt: 'call the fixture tool', tools: [toolFixture], usage: toolUsage }); }
    catch (error) { toolNoUsageRejected = (error as any)?.code === 'token_usage_unknown'; }
    equal(toolNoUsageRejected, true, '真实 Pi HTTP/SSE 工具调用无 usage 后失败关闭');
    equal(httpRequests - beforeToolRequests, 1, '无 usage 工具响应后下一轮模型请求在发送前阻断');
    equal(toolUsage.snapshot().requestCount, 1, '未发送的后续轮次不计为 provider 请求');

    httpMode = 'valid_usage';
    const validHttpUsage = createJobTokenUsageController(tokenJob('http-explicit-usage', 100));
    const beforeValidRequests = httpRequests;
    const validHttpResponse = await runPiAgent({ config: httpConfig, systemPrompt: 'synthetic fixture prompt', prompt: 'completion with usage', usage: validHttpUsage });
    equal(validHttpResponse.text, 'Local SDK adapter response', '真实 Pi HTTP/SSE adapter 可解析本地合成 completion');
    equal(httpRequests - beforeValidRequests, 1, '明确 usage 的 adapter 请求正常完成');
    equal(validHttpUsage.snapshot().usedTokens, 14, '真实 SSE usage chunk 按 adapter 解析值累计');
    equal(validHttpUsage.snapshot().status, 'known', '真实非零 provider usage 保持 known');

    httpMode = 'error_no_usage';
    const errorHttpUsage = createJobTokenUsageController(tokenJob('http-error-no-usage', 100));
    const beforeErrorRequests = httpRequests;
    let errorUsageRejected = false;
    try { await runPiAgent({ config: httpConfig, systemPrompt: 'synthetic fixture prompt', prompt: 'server error without usage', usage: errorHttpUsage }); }
    catch (error) { errorUsageRejected = (error as any)?.code === 'token_usage_unknown'; }
    equal(errorUsageRejected, true, '真实 Pi HTTP 错误响应中的 SDK 默认零用量不会被当成未计费证明');
    equal(errorHttpUsage.snapshot().status, 'unknown', 'HTTP 错误无 usage 持久标记 unknown');
    let errorRetryBlocked = false;
    try { await runPiAgent({ config: httpConfig, systemPrompt: 'synthetic fixture prompt', prompt: 'retry server error', usage: errorHttpUsage }); }
    catch (error) { errorRetryBlocked = (error as any)?.code === 'token_usage_unknown'; }
    equal(errorRetryBlocked, true, '错误无 usage 时任务重试被预算控制器阻断');
    equal(httpRequests - beforeErrorRequests, 1, '错误无 usage 后没有再次访问本地模型服务');
  } finally {
    await new Promise<void>(resolve => localAiServer.close(() => resolve()));
  }

  const reportId = 'fixture-report';
  const versionId = 'fixture-report-version';
  const sourceHash = 'a'.repeat(64);
  db.prepare(`INSERT INTO research_reports(id,title,description,created_by) VALUES (?,?,?,?)`).run(reportId, '合成报告', '仅本机合成验证', userId);
  db.prepare(`INSERT INTO research_report_versions(id,report_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,uploaded_by)
    VALUES (?,?,1,?,?,?,?,?,?,?)`).run(versionId, reportId, 'fixture.txt', 'rrf_00000000-0000-4000-8000-000000000001.txt', '.txt', 'text/plain', 30, sourceHash, userId);
  const unselectedReportId = 'review-unselected-report';
  db.prepare(`INSERT INTO research_reports(id,title,description,created_by) VALUES (?,?,?,?)`)
    .run(unselectedReportId, 'UNSELECTED REVIEW REPORT', 'not selected context', userId);
  db.prepare(`INSERT INTO research_report_versions(id,report_id,version_no,original_name,storage_key,extension,mime_type,size_bytes,sha256,uploaded_by)
    VALUES (?,?,1,?,?,?,?,?,?,?)`).run('review-unselected-version', unselectedReportId, 'unselected.txt', 'rrf_00000000-0000-4000-8000-000000000002.txt', '.txt', 'text/plain', 5, 'b'.repeat(64), userId);
  const reportScope = searchKnowledge({ reportIds: [reportId] }).reports;
  equal(reportScope.length, 1, '显式报告集合将元数据搜索限制于所选报告');
  equal(reportScope[0].id, reportId, '显式单报告范围不会泄露未选择报告标题');
  equal(searchKnowledge({ reportIds: [] }).reports.length, 0, '显式空报告范围不退化成全组织检索');
  equal(searchKnowledge().reports.length, 2, '未指定报告范围时仍检索组织当前报告');
  db.prepare(`INSERT INTO system_settings(setting_key,setting_value,updated_by) VALUES ('ai_config',?,?)`).run(JSON.stringify({
    provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'http://fixture.invalid/v1', autoArchive: true,
    maxTokens: 1024, taskTokenBudget: 4096, timeoutMs: 5000, maxToolCalls: 2,
  }), userId);
  const manifest = currentReportManifest(reportId)!;
  const extractedId = id('ext_');
  const chunkId = id('chk_');
  db.prepare(`INSERT INTO document_extractions(id,report_id,source_kind,source_version_id,input_sha256,parser_version,status,coverage_json,text_length)
    VALUES (?,?,?,?,?,?,'parsed','{}',20)`).run(extractedId, reportId, 'report_version', versionId, sourceHash, PARSER_VERSION);
  db.prepare(`INSERT INTO document_chunks(id,extraction_id,sequence_no,locator_json,content_text,content_sha256)
    VALUES (?,?,1,?,?,?)`).run(chunkId, extractedId, JSON.stringify({ kind: 'paragraph', paragraph: 2 }), '结果：1.25 mg/mL', sourceHash);
  const sessionId = createAssistantSession(userId, 'report', [reportId]);
  assert(getOwnedSession(sessionId, userId), '研发会话归属作者');
  equal(getOwnedSession(sessionId, 'fixture-other-user'), undefined, '其他成员不能读取会话所有权记录');
  equal(getAssistantSession(sessionId, 'fixture-other-user'), undefined, '会话消息 API 读取遵循作者隔离');
  const chatMessage = enqueueChatMessage(sessionId, userId, '请总结合成报告');
  const queuedSession = getAssistantSession(sessionId, userId)!;
  equal(queuedSession.messages.length, 2, '会话问答用户消息与助手任务均持久化');
  equal(queuedSession.messages[1].jobId, chatMessage.jobId, '持久会话消息关联队列任务');
  const chunks = loadCurrentChunks(reportId, manifest);
  equal(chunks.length, 1, '活动报告版本解析区段可按来源版本与 SHA-256 加载');

  const makeJob = (key: string) => transaction(() => {
    const job = writeJobFromManifest(reportId, userId, manifest, key);
    equal(Number((db.prepare('SELECT budget_tokens FROM ai_jobs WHERE id=?').get(job.id) as any).budget_tokens), 4096,
      '新报告任务在入队时固定保存当前配置的累计 token 预算');
    db.prepare("UPDATE ai_jobs SET status='analyzing' WHERE id=?").run(job.id);
    return job.id;
  });
  const response = (value: unknown, evidenceId = chunkId) => JSON.stringify({ summary: '合成结果摘要', observations: [
    { field_key: 'results', observation_type: 'source_statement', value, evidence_ids: [evidenceId] },
  ], evidence_gaps: [], assumptions: [] });
  const fakeRunner = async () => ({ text: response({ value: '1.25', unit: 'mg/mL' }), toolCalls: 0, messages: [] });
  const firstJob = makeJob('contract:valid');
  const first = await analyzeReport(firstJob, reportId, manifest, chunks, new AbortController().signal, () => {}, fakeRunner as any);
  if (!('analysisId' in first) || !first.analysisId) throw new Error('合法分析未生成 analysisId');
  equal(first.status, 'needs_review', 'schema 合法的有来源分析进入待人工复核状态');
  equal((db.prepare('SELECT COUNT(*) AS n FROM research_analyses WHERE report_id=?').get(reportId) as any).n, 1, '结构化分析写入独立知识表');
  const firstObservation = db.prepare('SELECT * FROM research_observations WHERE analysis_id=?').get(first.analysisId) as any;
  equal(firstObservation.review_state, 'machine_unconfirmed', '模型整理结果从未默认标记为人工确认');
  equal((db.prepare('SELECT source_version_id FROM evidence_refs WHERE observation_id=?').get(firstObservation.id) as any).source_version_id,
    versionId, '观察项保存精确文档版本引用');
  const firstReportKnowledgeJob=db.prepare('SELECT id,knowledge_fingerprint,status FROM report_knowledge_index_jobs WHERE report_id=? ORDER BY rowid DESC LIMIT 1').get(reportId) as any;
  assert(firstReportKnowledgeJob&&firstReportKnowledgeJob.knowledge_fingerprint.length===64,'报告分析完成后自动建立与证据版本绑定的报告知识索引任务');
  const activeIndexOwner='fixture-slow-report-index-worker';
  db.prepare("UPDATE report_knowledge_index_jobs SET status='working',lease_owner=?,lease_until_ms=?,attempt_count=1 WHERE id=?")
    .run(activeIndexOwner,Date.now()+60_000,firstReportKnowledgeJob.id);
  enqueueReportKnowledgeIndex(reportId);
  const retainedReportIndexLease=db.prepare('SELECT status,lease_owner,attempt_count FROM report_knowledge_index_jobs WHERE id=?').get(firstReportKnowledgeJob.id) as any;
  equal(retainedReportIndexLease.status,'working','60秒巡检或重复入队不抢占仍有效的慢速报告索引任务');
  equal(retainedReportIndexLease.lease_owner,activeIndexOwner,'报告知识索引保留当前活动 worker 租约');
  equal(retainedReportIndexLease.attempt_count,1,'重复入队不重复消耗报告索引尝试次数');
  db.prepare("UPDATE report_knowledge_index_jobs SET status='queued',lease_owner=NULL,lease_until_ms=NULL,attempt_count=0 WHERE id=?")
    .run(firstReportKnowledgeJob.id);
  const preCorrectionKnowledgeFingerprint=String(firstReportKnowledgeJob.knowledge_fingerprint);

  const validInput = JSON.stringify({ summary: 'x', observations: [{ field_key: 'results', observation_type: 'source_statement', value: 'x', evidence_ids: ['outside-source'] }], evidence_gaps: [], assumptions: [] });
  let invalidSourceRejected = false;
  try { validateAnalysisPayload(validInput, chunks); } catch (error) { invalidSourceRejected = String(error).includes('输入范围之外的证据'); }
  assert(invalidSourceRejected, '模型引用输入范围之外的来源会被 schema 校验拒绝');
  equal((db.prepare('SELECT COUNT(*) AS n FROM research_analyses WHERE report_id=?').get(reportId) as any).n, 1, '无效引用校验前不产生知识写入');

  for (const forgedType of ['program_calculation', 'human_entry']) {
    const forged = JSON.stringify({ summary: '伪造来源', observations: [{ field_key: 'results', observation_type: forgedType,
      value: { value: '123', unit: 'mg/mL' }, evidence_ids: [chunkId] }], evidence_gaps: [], assumptions: [] });
    let forgedRejected = false;
    try { validateAnalysisPayload(forged, chunks); } catch { forgedRejected = true; }
    assert(forgedRejected, `模型不能自行声明受控来源类型 ${forgedType}`);
  }

  const gaps = ['缺少重复次数', '缺少阴性对照'];
  const gapsJob = makeJob('contract:nonempty-evidence-gaps');
  const gapsRunner = async () => ({ text: JSON.stringify({ summary: '存在资料缺项', observations: [], evidence_gaps: gaps, assumptions: [] }), toolCalls: 0, messages: [] });
  const gapsAnalysis = await analyzeReport(gapsJob, reportId, manifest, chunks, new AbortController().signal, () => {}, gapsRunner as any);
  if (!('analysisId' in gapsAnalysis) || !gapsAnalysis.analysisId) throw new Error('非空证据缺项无法归档');
  equal(JSON.stringify(JSON.parse(String((db.prepare('SELECT evidence_gaps_json FROM research_analyses WHERE id=?').get(gapsAnalysis.analysisId) as any).evidence_gaps_json))),
    JSON.stringify(gaps), '多个 evidence_gaps 原样归档并可查询展示');
  const gapRows = db.prepare(`SELECT field_key,value_json,normalized_text,supersedes_id FROM research_observations WHERE analysis_id=? AND field_key='evidence_gap' ORDER BY normalized_text`)
    .all(gapsAnalysis.analysisId) as any[];
  equal(gapRows.length, 2, '每条缺项均生成结构化缺项记录');
  assert(gapRows.every(row => row.supersedes_id === null && gaps.includes(JSON.parse(row.value_json).text)), '缺项记录参数列正确且不伪造 supersedes 外键');
  assert(gapRows.some(row => row.normalized_text === '缺少重复次数'), '缺项文本可由结构化查询展示');

  db.prepare(`INSERT INTO observation_reviews(id,observation_id,reviewer_id,review_state,corrected_value_json,comment) VALUES (?,?,?,?,?,?)`)
    .run(id('rev_'), firstObservation.id, userId, 'corrected', JSON.stringify({ value: '1.30', unit: 'mg/mL' }), '合成复核修正');
  db.prepare("UPDATE research_observations SET review_state='human_confirmed' WHERE id=?").run(firstObservation.id);
  const secondJob = makeJob('contract:rerun-preserve');
  const second = await analyzeReport(secondJob, reportId, manifest, chunks, new AbortController().signal, () => {}, fakeRunner as any);
  if (!('analysisId' in second) || !second.analysisId) throw new Error('重分析未生成 analysisId');
  const secondObservation = db.prepare('SELECT * FROM research_observations WHERE analysis_id=?').get(second.analysisId) as any;
  const copiedReview = db.prepare('SELECT * FROM observation_reviews WHERE observation_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(secondObservation.id) as any;
  equal(secondObservation.supersedes_id, firstObservation.id, '重分析结构化信息保留前序修订关系');
  equal(copiedReview.review_state, 'corrected', '重分析未清除人工纠正状态');
  equal(JSON.parse(copiedReview.corrected_value_json).value, '1.30', '重分析保留人工纠正值');
  const correctedReportKnowledgeJob=db.prepare('SELECT knowledge_fingerprint FROM report_knowledge_index_jobs WHERE report_id=? ORDER BY rowid DESC LIMIT 1').get(reportId) as any;
  assert(correctedReportKnowledgeJob&&correctedReportKnowledgeJob.knowledge_fingerprint!==preCorrectionKnowledgeFingerprint,
    '重分析纳入人工更正后生成新报告知识指纹，旧向量范围随之失效');
  const latestReportIndexJob=db.prepare('SELECT id FROM report_knowledge_index_jobs WHERE report_id=? ORDER BY rowid DESC LIMIT 1').get(reportId) as any;
  db.prepare(`UPDATE report_knowledge_index_jobs SET status='complete',attempt_count=1,request_count=3,usage_tokens=42,usage_status='unknown',finished_at=datetime('now') WHERE id=?`)
    .run(latestReportIndexJob.id);
  enqueueReportKnowledgeIndex(reportId,true);
  const rebuiltReportIndexJob=db.prepare('SELECT status,request_count,usage_tokens,usage_status FROM report_knowledge_index_jobs WHERE id=?').get(latestReportIndexJob.id) as any;
  equal(rebuiltReportIndexJob.status,'queued','备份恢复巡检发现向量集合缺失时可重新排队已完成记录');
  equal(rebuiltReportIndexJob.request_count,3,'报告索引恢复不清零历史请求数');
  equal(rebuiltReportIndexJob.usage_tokens,42,'报告索引恢复不清零累计 token');
  equal(rebuiltReportIndexJob.usage_status,'unknown','报告索引恢复保留历史未知用量保护');
  const correctedKnowledge = searchKnowledge({ q: '1.30', reportIds: [reportId] }).observations;
  const correctedResult = correctedKnowledge.find((item: any) => item.id === secondObservation.id) as any;
  assert(correctedResult, '人工更正值参与后续知识检索');
  equal(correctedResult.value.value, '1.30', '知识检索返回生效人工更正值，同时不覆盖原始证据');
  equal(correctedResult.originalValue.value, '1.25', '人工更正保留模型原值用于审计');

  const oldSemanticHitId = 'obs_bulk_old_semantic_hit';
  const bulkInsertObservation = db.prepare(`INSERT INTO research_observations(id,report_id,analysis_id,field_key,observation_type,review_state,value_json,normalized_text,created_at,updated_at)
    VALUES (?,?,?,'bulk_result','source_statement','machine_unconfirmed',?, ?,?,?)`);
  const bulkInsertEvidence = db.prepare(`INSERT INTO evidence_refs(id,observation_id,analysis_id,report_id,source_version_id,source_kind,content_sha256,locator_json,source_excerpt)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 2001; index++) {
    const observationId = index === 0 ? oldSemanticHitId : `obs_bulk_${index}`;
    const createdAt = index === 0 ? '1990-01-01 00:00:00' : '2025-01-01 00:00:00';
    bulkInsertObservation.run(observationId, reportId, second.analysisId, JSON.stringify({ value: index, unit: 'mg/mL' }), `${index} mg/ml`, createdAt, createdAt);
    bulkInsertEvidence.run(`evr_bulk_${index}`, observationId, second.analysisId, reportId, versionId, 'report_version', sourceHash,
      JSON.stringify({ kind: 'paragraph', paragraph: index + 10 }), `合成批量观察 ${index}`);
  }
  const cappedKnowledgeRows = searchKnowledge({ reportIds: [reportId], limit: 2000 }).observations;
  assert(!cappedKnowledgeRows.some((item: any) => item.id === oldSemanticHitId), '复现旧的全量 2000 条回查上限会丢弃范围末端命中');
  const exactSemanticHit = getCurrentKnowledgeObservationsByIds([oldSemanticHitId]);
  equal(exactSemanticHit.length, 1, '向量命中按 observation ID 精确回查，不受全库 2000 条上限影响');
  equal(exactSemanticHit[0].reportId, reportId, '精确回查仍核对报告归属');
  equal(exactSemanticHit[0].historical, false, '精确回查仍要求当前报告版本');

  const reportTools = buildAssistantTools({ jobId: 'fixture-selected-report-job', contextType: 'report', contextIds: [reportId] });
  const reportSearch = await reportTools.find(item => item.name === 'search_reports')!.execute('fixture-search', { q: '' }, new AbortController().signal, () => {});
  const reportSearchText = String(reportSearch.content.find(block => block.type === 'text')?.text || '[]');
  const reportSearchRows = JSON.parse(reportSearchText);
  equal(reportSearchRows.length, 1, '报告会话 search_reports 尊重所选报告上下文');
  equal(reportSearchRows[0].id, reportId, '报告会话不会向模型返回未选择报告的元数据');

  const compareTool = reportTools.find(item => item.name === 'compare_observations')!;
  const correctionComparison = await compareTool.execute('fixture-compare-corrected', { observationIds: [firstObservation.id, secondObservation.id] },
    new AbortController().signal, () => {});
  const comparisonResult = correctionComparison.details as any;
  assert(!comparisonResult.comparable && comparisonResult.reason.includes('缺少明确指标身份'), '缺少可比指标/条件时人工更正值只并列展示，不生成差值');
  equal(comparisonResult.numericDifference, undefined, '资料不完整时不计算数值差');
  assert(comparisonResult.rows.every((row: any) => row.value.value === '1.30'), '对比计算使用已生效人工更正值');
  assert(comparisonResult.rows.every((row: any) => row.originalValue.value === '1.25'), '对比结果保留原始观测审计值');

  const comparisonConditions = { assay: 'ELISA', temperature: '37 C', incubation: '60 min', sampleType: 'serum' };
  const comparisonValue = (value: unknown, overrides: Record<string, unknown> = {}) => ({ value, unit: 'mg/mL', metric: 'protein concentration',
    conditions: comparisonConditions, ...overrides });
  const assessPair = (left: unknown, right: unknown, leftField = 'results', rightField = leftField) =>
    assessObservationComparison([{ fieldKey: leftField, value: left }, { fieldKey: rightField, value: right }]);
  const missingOneUnit = assessPair(comparisonValue('1.30'), comparisonValue('1.25', { unit: undefined }));
  assert(!missingOneUnit.comparable && missingOneUnit.reason.includes('缺少显式单位'), '单项缺失单位时只并列展示，不推导单位');
  equal(missingOneUnit.numericDifference, undefined, '单项单位缺失不输出数值差');
  const missingAllUnits = assessPair(comparisonValue('1.30', { unit: undefined }), comparisonValue('1.25', { unit: '' }));
  assert(!missingAllUnits.comparable && missingAllUnits.reason.includes('缺少显式单位'), '所有单位缺失时不推定无量纲');
  const unknownUnits = assessPair(comparisonValue('1.30', { unit: 'unknown' }), comparisonValue('1.25', { unit: 'unknown' }));
  assert(!unknownUnits.comparable && unknownUnits.reason.includes('缺少显式单位'), '未知单位占位文本不视作已判定单位');
  for (const invalid of [null, '', '   ', true, false, '0x10']) {
    const result = assessPair(comparisonValue(invalid), comparisonValue('1.25'));
    assert(!result.comparable && result.reason.includes('严格有限数值'), `比较值 ${String(invalid)} 不作为数字转换`);
    equal(result.numericDifference, undefined, `无效比较值 ${String(invalid)} 不产生差值`);
  }
  const differentField = assessPair(comparisonValue('1.30'), comparisonValue('1.25'), 'concentration', 'results');
  assert(!differentField.comparable && differentField.reason.includes('比较字段不同'), '字段不同只并列展示');
  const differentMetric = assessPair(comparisonValue('1.30'), comparisonValue('1.25', { metric: 'total protein' }));
  assert(!differentMetric.comparable && differentMetric.reason.includes('指标不同'), '指标不同只并列展示');
  const missingMetric = assessPair(comparisonValue('1.30', { metric: 'unknown' }), comparisonValue('1.25', { metric: 'unknown' }));
  assert(!missingMetric.comparable && missingMetric.reason.includes('缺少明确指标身份'), '未知指标占位文本不能建立指标身份');
  const differentConditions = assessPair(comparisonValue('1.30'), comparisonValue('1.25', { conditions: { ...comparisonConditions, incubation: '30 min' } }));
  assert(!differentConditions.comparable && differentConditions.reason.includes('实验条件不同'), '实验条件不同不计算差值');
  const incompleteConditions = assessPair(comparisonValue('1.30', { conditions: { assay: 'ELISA', incubation: '' } }),
    comparisonValue('1.25', { conditions: { assay: 'ELISA', incubation: '' } }));
  assert(!incompleteConditions.comparable && incompleteConditions.reason.includes('缺少可核对的实验条件信息'), '实验条件字段为空时不视为条件完整');
  const unknownConditions = assessPair(comparisonValue('1.30', { conditions: { assay: 'unknown', incubation: '60 min' } }),
    comparisonValue('1.25', { conditions: { assay: 'unknown', incubation: '60 min' } }));
  assert(!unknownConditions.comparable && unknownConditions.reason.includes('缺少可核对的实验条件信息'), '未知条件占位文本不视为条件已知');
  const validComparison = assessPair(comparisonValue('1.30'), comparisonValue('1.25'));
  assert(validComparison.comparable, '同字段、同指标、同显式单位及同实验条件允许描述性数值比较');
  equal(validComparison.unit, 'mg/mL', '有效比较显示共同单位');
  equal(JSON.stringify(validComparison.numericDifference), JSON.stringify([-0.05]), '有效比较按严格数值计算差值');
  const explicitDimensionless = assessPair(comparisonValue('1', { unit: '1' }), comparisonValue('0.9', { unit: '1' }));
  assert(explicitDimensionless.comparable, '无量纲只有显式单位 1 时才参与比较');
  const explicitDimensionlessWord = assessPair(comparisonValue('1', { unit: 'dimensionless' }), comparisonValue('0.9', { unit: 'dimensionless' }));
  assert(explicitDimensionlessWord.comparable, '无量纲也可用显式 dimensionless 标签表示');

  const changedJob = makeJob('contract:rerun-conflict');
  const changedRunner = async () => ({ text: response({ value: '1.50', unit: 'mg/mL' }), toolCalls: 0, messages: [] });
  const third = await analyzeReport(changedJob, reportId, manifest, chunks, new AbortController().signal, () => {}, changedRunner as any);
  if (!('analysisId' in third) || !third.analysisId) throw new Error('冲突分析未生成 analysisId');
  const thirdObservation = db.prepare('SELECT * FROM research_observations WHERE analysis_id=?').get(third.analysisId) as any;
  const conflictReview = db.prepare('SELECT * FROM observation_reviews WHERE observation_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(thirdObservation.id) as any;
  equal(conflictReview.review_state, 'conflict', '重分析結果與人工确认/修正值不同时明确显示冲突');
  equal(JSON.parse(conflictReview.corrected_value_json).value, '1.30', '冲突状态仍保留人工修正值');

  const siblingChunkId = id('chk_');
  const siblingText = '其他观察位置：7.00 mg/mL';
  db.prepare(`INSERT INTO document_chunks(id,extraction_id,sequence_no,locator_json,content_text,content_sha256)
    VALUES (?,?,2,?,?,?)`).run(siblingChunkId, extractedId, JSON.stringify({ kind: 'paragraph', paragraph: 9 }), siblingText, 'c'.repeat(64));
  chunks.push({ id: siblingChunkId, extractionId: extractedId, sourceVersionId: versionId, sourceKind: 'report_version',
    contentSha256: sourceHash, locator: { kind: 'paragraph', paragraph: 9 }, text: siblingText });
  const siblingJob = makeJob('contract:same-field-distinct-locator');
  const siblingRunner = async () => ({ text: response({ value: '7.00', unit: 'mg/mL' }, siblingChunkId), toolCalls: 0, messages: [] });
  const siblingAnalysis = await analyzeReport(siblingJob, reportId, manifest, chunks, new AbortController().signal, () => {}, siblingRunner as any);
  if (!('analysisId' in siblingAnalysis) || !siblingAnalysis.analysisId) throw new Error('同字段不同定位分析未生成 analysisId');
  const siblingObservation = db.prepare('SELECT * FROM research_observations WHERE analysis_id=? AND field_key=\'results\'').get(siblingAnalysis.analysisId) as any;
  equal(siblingObservation.supersedes_id, null, '同字段但不同段落定位的观察不错误继承前条人工更正链');
  equal(Number((db.prepare('SELECT COUNT(*) AS n FROM observation_reviews WHERE observation_id=?').get(siblingObservation.id) as any).n), 0,
    '同字段不同源观察不继承上一条观察的更正值');

  const multiSampleRows = [
    { field_key: 'results', observation_type: 'source_statement', value: { value: '1.00', unit: 'mg/mL', metric: 'protein concentration', sample: 'sample-A', conditions: { assay: 'ELISA', temp: '37 C' } }, evidence_ids: [chunkId] },
    { field_key: 'results', observation_type: 'source_statement', value: { value: '2.00', unit: 'mg/mL', metric: 'protein concentration', sample: 'sample-B', conditions: { assay: 'ELISA', temp: '37 C' } }, evidence_ids: [chunkId] },
  ];
  const runMultiObservationAnalysis = async (key: string, observations: any[]) => {
    const jobId = makeJob(key);
    const runner = async () => ({ text: JSON.stringify({ summary: '同一 chunk 多观察合成夹具', observations, evidence_gaps: [], assumptions: [] }), toolCalls: 0, messages: [] });
    const result = await analyzeReport(jobId, reportId, manifest, chunks, new AbortController().signal, () => {}, runner as any);
    if (!('analysisId' in result) || !result.analysisId) throw new Error(`${key} 未归档`);
    return db.prepare('SELECT * FROM research_observations WHERE analysis_id=? AND field_key=\'results\' ORDER BY rowid').all(result.analysisId) as any[];
  };
  const multiSampleFirst = await runMultiObservationAnalysis('contract:multi-sample-initial', multiSampleRows);
  equal(multiSampleFirst.length, 2, '一个 chunk 内同 field_key 多样本观察均归档');
  const multiSamplePrior = new Map<string, any>();
  for (const row of multiSampleFirst) {
    const raw = JSON.parse(row.value_json);
    multiSamplePrior.set(raw.sample, row);
    const corrected = { ...raw, value: raw.sample === 'sample-A' ? '1.10' : '2.10' };
    db.prepare(`INSERT INTO observation_reviews(id,observation_id,reviewer_id,review_state,corrected_value_json,comment) VALUES (?,?,?,?,?,?)`)
      .run(id('rev_'), row.id, userId, 'corrected', JSON.stringify(corrected), `合成更正 ${raw.sample}`);
    db.prepare("UPDATE research_observations SET review_state='human_confirmed' WHERE id=?").run(row.id);
  }
  const multiSampleSecond = await runMultiObservationAnalysis('contract:multi-sample-rerun', multiSampleRows);
  equal(multiSampleSecond.length, 2, '同一 chunk 多样本重分析结果完整');
  for (const row of multiSampleSecond) {
    const sample = JSON.parse(row.value_json).sample;
    const priorRow = multiSamplePrior.get(sample);
    equal(row.supersedes_id, priorRow.id, `${sample} 只沿用相同稳定样本身份的修订链`);
    const carriedReview = db.prepare('SELECT review_state,corrected_value_json FROM observation_reviews WHERE observation_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as any;
    equal(carriedReview.review_state, 'corrected', `${sample} 的更正状态仍可追溯`);
    equal(JSON.parse(carriedReview.corrected_value_json).value, sample === 'sample-A' ? '1.10' : '2.10', `${sample} 不继承另一样本的更正值`);
  }

  const ambiguousRows = [
    { field_key: 'results', observation_type: 'source_statement', value: { value: '3.00', unit: 'mg/mL' }, evidence_ids: [chunkId] },
    { field_key: 'results', observation_type: 'source_statement', value: { value: '4.00', unit: 'mg/mL' }, evidence_ids: [chunkId] },
  ];
  const ambiguousFirst = await runMultiObservationAnalysis('contract:multi-sample-ambiguous-initial', ambiguousRows);
  equal(ambiguousFirst.length, 2, '缺少稳定身份的同 chunk 多条观察 fixture 已归档');
  for (const row of ambiguousFirst) {
    db.prepare(`INSERT INTO observation_reviews(id,observation_id,reviewer_id,review_state,corrected_value_json,comment) VALUES (?,?,?,?,?,?)`)
      .run(id('rev_'), row.id, userId, 'corrected', JSON.stringify({ value: '9.99', unit: 'mg/mL' }), '身份歧义保护夹具');
    db.prepare("UPDATE research_observations SET review_state='human_confirmed' WHERE id=?").run(row.id);
  }
  const ambiguousNext = await runMultiObservationAnalysis('contract:multi-sample-ambiguous-next', [ambiguousRows[0]]);
  equal(ambiguousNext.length, 1, '同 chunk 歧义重分析生成单条待复核观察');
  equal(ambiguousNext[0].supersedes_id, null, '同字段同 locator 缺少样本身份时不建立错误继承链');
  equal(ambiguousNext[0].review_state, 'conflict', '同 chunk 多条更正无法唯一匹配时显式标记冲突');
  const ambiguousReview = db.prepare('SELECT review_state,corrected_value_json,comment FROM observation_reviews WHERE observation_id=? ORDER BY rowid DESC LIMIT 1')
    .get(ambiguousNext[0].id) as any;
  equal(ambiguousReview.review_state, 'conflict', '身份不明的新观察保留人工复核状态');
  equal(ambiguousReview.corrected_value_json, null, '身份不明时不会把任一旧更正值带入新观察');

  const evidenceRefId = String((db.prepare('SELECT id FROM evidence_refs WHERE observation_id=? LIMIT 1').get(firstObservation.id) as any).id);
  const { createLiteratureRecord, updateLiteratureMetadata } = await import('./literature/repository.ts');
  const { searchLiterature } = await import('./literature/search.ts');
  const readerId = 'fixture-reader';
  const adminId = 'fixture-admin';
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)`).run(readerId, '合成只读成员', 'reader@example.test', 'fixture', 'RESEARCHER');
  db.prepare(`INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)`).run(adminId, '合成系统管理员', 'admin@example.test', 'fixture', 'ADMIN');
  const materialId = 'fixture-material';
  db.prepare(`INSERT INTO materials(id,code,name,category,dimension,base_unit) VALUES (?,?,?,?,?,?)`)
    .run(materialId, 'FIXTURE-MAT', '合成试剂', '试剂', 'mass', 'mg');
  const literatureId = createLiteratureRecord({ id: userId, role: 'RESEARCHER' }, { title: '合成配方参考文献', authors: ['Fixture Author'], year: 2026,
    abstract: 'Synthetic literature evidence for protein assay calibration recipe validation.' });
  const literatureHit = await searchLiterature('protein assay calibration', { mode: 'keyword', actor: { id: userId, role: 'RESEARCHER' },
    scope: { itemIds: [literatureId] }, persistEvidence: true });
  const literatureEvidenceRefId = String(literatureHit.results[0]?.evidenceRefId || '');
  assert(literatureEvidenceRefId.startsWith('litev_'), '合成文献范围生成可验证的文献 evidence ref');
  const recipeRequest = { purpose: '合成用途：按有效报告和文献建议配方', reportIds: [reportId], literatureIds: [literatureId] };
  const recipeJobId = enqueueSuggestionJob(userId, 'recipe', { ...recipeRequest });
  const recipeJob = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(recipeJobId) as any;
  const recipeModelOutput = JSON.stringify({ name: '合成AI配方', baseVolume: '10', baseVolumeUnit: 'mL', outputName: '合成产物', outputCode: 'FIXTURE-OUT',
    outputUnit: 'mL', outputDimension: 'volume', ingredients: [{ name: '合成试剂', materialId, calculationType: 'fixed_addition', amountValue: '5', amountUnit: 'mg',
      dimension: 'mass', stockConcentration: '', targetConcentration: '', molecularWeight: '', notes: '', rationale: '合成夹具参数' }],
    steps: ['合成步骤'], storage: '', rationale: '仅隔离测试', assumptions: [], missingInfo: [], evidenceRefIds: [evidenceRefId, literatureEvidenceRefId] });
  const recipeSuggestionId = completeSuggestionJob(recipeJob, 'recipe', recipeModelOutput, recipeRequest);
  equal(completeSuggestionJob(recipeJob, 'recipe', recipeModelOutput, recipeRequest), recipeSuggestionId, '任务重复交付时复用已有建议结果，不插入第二条');
  equal(Number((db.prepare('SELECT COUNT(*) AS n FROM ai_suggestions WHERE job_id=?').get(recipeJobId) as any).n), 1, '每个队列任务只保存一个建议结果');
  const recipeSuggestion = getSuggestionForUser(recipeSuggestionId, userId, 'RESEARCHER')!;
  equal(recipeSuggestion.status, 'ready', '引用当前来源且使用有效物料/单位的配方建议通过服务端校验');
  assert(recipeSuggestion.citations.some((item: any) => item.valid && item.sourceType === 'report' && item.reportId === reportId)
    && recipeSuggestion.citations.some((item: any) => item.valid && item.sourceType === 'literature' && item.literatureId === literatureId),
    '建议详情区分并展示有效报告引用与文献引用');
  const literatureOnlyRecipeRequest = { ...recipeRequest, purpose: '仅依据所选文献的合成用途', reportIds: [] };
  const literatureOnlyRecipeJobId = enqueueSuggestionJob(userId, 'recipe', literatureOnlyRecipeRequest);
  const literatureOnlyRecipeJob = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(literatureOnlyRecipeJobId) as any;
  const literatureOnlyRecipeOutput = { ...JSON.parse(recipeModelOutput), evidenceRefIds: [literatureEvidenceRefId] };
  const literatureOnlyRecipeSuggestionId = completeSuggestionJob(literatureOnlyRecipeJob, 'recipe', JSON.stringify(literatureOnlyRecipeOutput), literatureOnlyRecipeRequest);
  const literatureOnlyRecipe = getSuggestionForUser(literatureOnlyRecipeSuggestionId, userId, 'RESEARCHER')!;
  equal(literatureOnlyRecipe.status, 'ready', '仅有文献引用且没有报告来源时配方建议仍通过校验');
  assert(literatureOnlyRecipe.citations.length === 1 && literatureOnlyRecipe.citations[0].valid
    && literatureOnlyRecipe.citations[0].sourceType === 'literature', '文献单一来源在建议详情中保持typed引用');
  equal(getSuggestionForUser(recipeSuggestionId, readerId, 'RESEARCHER'), undefined, '配方建议草稿只对作者及管理员可见');
  assert(getSuggestionForUser(recipeSuggestionId, adminId, 'ADMIN'), '系统管理员可读取成员的 AI 建议草稿');
  const recipeCountBeforeConfirm = Number((db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as any).n);
  const invalidUnitEdit = editSuggestion(recipeSuggestionId, userId, 'RESEARCHER', { ingredients: [{ ...recipeSuggestion.payload.ingredients[0], amountUnit: 'unknown-unit' }] })!;
  equal(invalidUnitEdit.status, 'needs_input', 'AI 配方建议编辑复用确定性计算校验并将未知单位标为待补充');
  assert(invalidUnitEdit.payload.missingInfo.some((item: string) => item.includes('未知单位')), '未知单位错误原因展示给人工修订者');
  equal(Number((db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as any).n), recipeCountBeforeConfirm, '用户确认前没有创建配方业务记录');
  const validUnitEdit = editSuggestion(recipeSuggestionId, userId, 'RESEARCHER', { ingredients: recipeSuggestion.payload.ingredients })!;
  equal(validUnitEdit.status, 'ready', '修正为有效单位后重新通过服务端校验');
  let nonAuthorConfirmRejected = false;
  try { confirmSuggestion(recipeSuggestionId, readerId, 'RESEARCHER', 'fixture-non-author-confirm', validUnitEdit.expectedVersion); }
  catch (error) { nonAuthorConfirmRejected = String(error).includes('不存在'); }
  assert(nonAuthorConfirmRejected, '非作者且非管理员不能确认其他成员的建议');
  const recipeConfirm = confirmSuggestion(recipeSuggestionId, userId, 'RESEARCHER', 'fixture-recipe-confirm', validUnitEdit.expectedVersion);
  equal(recipeConfirm.alreadyConfirmed, false, '首次配方建议确认产生一次正式草稿写入');
  const recipeAfterConfirm = db.prepare('SELECT r.scope,r.source_type,v.status FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.id=?')
    .get(recipeConfirm.resultId) as any;
  equal(recipeAfterConfirm.scope, 'team', 'AI 配方写入组织共享范围');
  equal(recipeAfterConfirm.source_type, 'ai_draft', 'AI 配方写入标记为 AI 草稿来源');
  equal(recipeAfterConfirm.status, 'draft', 'AI 配方确认只创建草稿版本，不自动发布');
  const recipeAudit = JSON.parse(String((db.prepare("SELECT details FROM audit_events WHERE action='ai.recipe_suggestion.confirm' AND object_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(recipeConfirm.resultId) as any).details));
  assert(recipeAudit.citedSources.some((source: any) => source.type === 'literature' && source.id === literatureId && source.contentSha256),
    '配方确认审计保留文献来源身份、版本及内容 SHA');
  const recipeRowsAfterConfirm = Number((db.prepare('SELECT COUNT(*) AS n FROM recipe_versions').get() as any).n);
  equal(confirmSuggestion(recipeSuggestionId, userId, 'RESEARCHER', 'fixture-recipe-confirm', validUnitEdit.expectedVersion).alreadyConfirmed, true,
    '重复确认按建议/幂等编号返回已写入结果');
  equal(Number((db.prepare('SELECT COUNT(*) AS n FROM recipe_versions').get() as any).n), recipeRowsAfterConfirm, '重复确认不会重复创建配方版本');

  const runScopedSuggestionWorker = async (type: 'recipe' | 'preparation', request: any) => {
    const jobId = enqueueSuggestionJob(userId, type, request);
    db.prepare("UPDATE ai_jobs SET status='failed',finished_at=datetime('now'),error_code='fixture_queue_isolation' WHERE id<>? AND status IN ('queued','waiting_configuration')").run(jobId);
    let workerRefs: string[] = [];
    const parseToolText = (result: any) => String(result.content.find((block: any) => block.type === 'text')?.text || '');
    const scopedRunner = async (options: any) => {
      assert(String(options.prompt).includes(JSON.stringify(request.literatureIds)), `${type} Worker prompt includes selected literature IDs`);
      const runTool = async (name: string, args: any) => {
        const tool = options.tools.find((candidate: any) => candidate.name === name);
        assert(tool, `${type} Worker exposes ${name}`);
        return tool.execute(`worker-${name}`, args, new AbortController().signal, () => {});
      };
      const literatureSearch = await runTool('search_literature', { query: 'protein assay calibration', mode: 'keyword', limit: 3 });
      const literatureResults = JSON.parse(parseToolText(literatureSearch)).results;
      assert(literatureResults.length > 0 && literatureResults.every((row: any) => row.literatureId === literatureId), `${type} Worker literature tool is scoped to the selected item`);
      const litRef = String(literatureResults[0].evidenceRefId);
      await runTool('read_literature_evidence', { evidenceRefId: litRef });
      const reportSearch = await runTool('search_reports', { q: '合成报告' });
      assert(JSON.parse(parseToolText(reportSearch)).every((row: any) => row.id === reportId), `${type} Worker report tool is scoped to the selected report`);
      await runTool('read_evidence', { evidenceRefId });
      if (type === 'preparation') {
        const versionResult = await runTool('get_recipe_version', { recipeVersionId: request.recipeVersionId });
        assert(JSON.parse(parseToolText(versionResult)).id === request.recipeVersionId, '配液 Worker 同时保留选定配方版本读取权限');
        const calculation = await runTool('calculate_recipe', { recipeVersionId: request.recipeVersionId, targetVolume: request.targetVolume, targetVolumeUnit: request.targetVolumeUnit });
        assert(JSON.parse(parseToolText(calculation)).lines?.length > 0, '配液 Worker 可用系统确定性计算工具');
      }
      workerRefs = [evidenceRefId, litRef];
      const response = type === 'recipe'
        ? { name: 'Worker 合成配方建议', baseVolume: '1', baseVolumeUnit: 'mL', outputName: 'Worker 产物', outputCode: 'WORKER-OUT', outputUnit: 'mL', outputDimension: 'volume',
            ingredients: [{ name: '合成试剂', materialId, calculationType: 'fixed_addition', amountValue: '1', amountUnit: 'mg', dimension: 'mass',
              stockConcentration: '', targetConcentration: '', molecularWeight: '', notes: '', rationale: '隔离夹具' }],
            steps: ['合成步骤'], assumptions: [], missingInfo: [], evidenceRefIds: workerRefs }
        : { rationale: '引用所选报告与文献并沿用确定性预览', assumptions: [], cautions: [], missingInfo: [], evidenceRefIds: workerRefs };
      return { text: JSON.stringify(response), toolCalls: 4, messages: [] };
    };
    assert(await runAiWorkerOnce({ runAgent: scopedRunner as any }), `${type} suggestion runs through the durable worker`);
    const job = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(jobId) as any;
    equal(job.status, 'completed', `${type} worker suggestion completes`);
    const suggestionRow = db.prepare('SELECT id FROM ai_suggestions WHERE job_id=?').get(jobId) as any;
    assert(suggestionRow?.id, `${type} worker persists its suggestion`);
    const suggestionData = getSuggestionForUser(String(suggestionRow.id), userId, 'RESEARCHER')!;
    equal(suggestionData.status, 'ready', `${type} worker suggestion passes source-aware validation`);
    assert(suggestionData.citations.some((item: any) => item.sourceType === 'literature' && item.valid)
      && suggestionData.citations.some((item: any) => item.sourceType === 'report' && item.valid), `${type} worker result carries both typed source families`);
    equal(JSON.stringify(suggestionData.payload.evidenceRefIds), JSON.stringify(workerRefs), `${type} evidence IDs survive Pi worker and persisted suggestion`);
    return suggestionData;
  };
  const workerRecipeRequest = { purpose: 'Worker integration fixture', reportIds: [reportId], literatureIds: [literatureId] };
  const workerRecipeSuggestion = await runScopedSuggestionWorker('recipe', workerRecipeRequest);
  const workerRecipeEdit = editSuggestion(workerRecipeSuggestion.id, userId, 'RESEARCHER', { rationale: '复核后的引用说明' })!;
  equal(workerRecipeEdit.status, 'ready', 'Worker 生成的引用可通过元数据编辑后重新校验');
  const workerRecipeConfirm = confirmSuggestion(workerRecipeSuggestion.id, userId, 'RESEARCHER', 'fixture-worker-recipe-confirm', workerRecipeEdit.expectedVersion);
  equal(workerRecipeConfirm.resultType, 'recipe_version', 'Worker 生成的双来源建议可经人工确认进入配方草稿闭环');

  const locationId = 'fixture-location';
  db.prepare('INSERT INTO locations(id,code,name) VALUES (?,?,?)').run(locationId, 'FIX', '合成测试位置');
  const publishedRecipeId = 'fixture-published-recipe';
  db.prepare(`INSERT INTO recipes(id,name,scope,owner_id,source_type,created_by) VALUES (?,?,'team',?,'manual',?)`)
    .run(publishedRecipeId, '合成已发布配方', userId, userId);
  const publishedVersionId = transaction(() => {
    const versionId = saveRecipeVersion(publishedRecipeId, { baseVolume: '10', baseVolumeUnit: 'mL', outputName: '合成产物', outputCode: 'FIXTURE-OUT2',
      outputUnit: 'mL', outputDimension: 'volume', steps: ['隔离步骤'], ingredients: [{ name: '合成试剂', materialId, calculationType: 'fixed_addition',
        amountValue: '5', amountUnit: 'mg', dimension: 'mass' }] }, userId, 1);
    db.prepare("UPDATE recipe_versions SET status='published',published_at=datetime('now') WHERE id=?").run(versionId);
    return versionId;
  });
  const lotId = 'fixture-lot';
  db.prepare(`INSERT INTO inventory_lots(id,material_id,manufacturer_lot,internal_lot,expiry_date,status) VALUES (?,?,?,?,?,'active')`)
    .run(lotId, materialId, 'MFG-FIX', 'LOT-FIX', '2099-12-31');
  db.prepare('INSERT INTO stock_balances(lot_id,location_id,quantity) VALUES (?,?,?)').run(lotId, locationId, '100');
  const recipeTools = buildAssistantTools({ jobId: 'fixture-read-only-job', contextType: 'recipe', contextIds: [publishedVersionId] });
  const invokeTool = async (name: string, args: any) => recipeTools.find(item => item.name === name)!.execute('fixture-call', args, new AbortController().signal, () => {});
  const toolText = (result: any) => String(result.content.find((block: any) => block.type === 'text')?.text || '');
  const recipeScopedSearch = await invokeTool('search_reports', { q: '' });
  equal(JSON.parse(toolText(recipeScopedSearch)).length, 0, '配方版本会话不会检索未选择的报告集合');
  let outsideRecipeRejected = false;
  try { await invokeTool('get_recipe_version', { recipeVersionId: 'outside-recipe-version' }); }
  catch (error) { outsideRecipeRejected = String(error).includes('上下文'); }
  assert(outsideRecipeRejected, '配方版本会话拒绝读取未选择的配方版本');
  const recipeScopedLots = await invokeTool('find_material_lots', { q: '合成试剂' });
  equal(JSON.parse(toolText(recipeScopedLots)).length, 1, '配方版本会话仅能检索当前配方组分对应的原料批次');
  const makePreparationSuggestion = (targetVolume: string) => {
    const request = { recipeVersionId: publishedVersionId, targetVolume, targetVolumeUnit: 'mL', reportIds: [reportId], literatureIds: [literatureId] };
    const jobId = enqueueSuggestionJob(userId, 'preparation', request);
    const job = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(jobId) as any;
    const modelOutput = JSON.stringify({ rationale: '依据当前确定性预览和所选资料', assumptions: [], cautions: ['仅隔离测试'], missingInfo: [], evidenceRefIds: [evidenceRefId, literatureEvidenceRefId] });
    return { request, suggestionId: completeSuggestionJob(job, 'preparation', modelOutput, request) };
  };
  const prepSuggestion = makePreparationSuggestion('10');
  const prepSuggestionData = getSuggestionForUser(prepSuggestion.suggestionId, userId, 'RESEARCHER')!;
  equal(prepSuggestionData.status, 'ready', '当前批次满足用量时配液建议可确认');
  assert(prepSuggestionData.citations.some((item: any) => item.valid && item.sourceType === 'literature' && item.literatureId === literatureId),
    '配液建议显示所选的有效文献证据引用');
  const literatureOnlyPrepRequest = { recipeVersionId: publishedVersionId, targetVolume: '10', targetVolumeUnit: 'mL', reportIds: [], literatureIds: [literatureId] };
  const literatureOnlyPrepJobId = enqueueSuggestionJob(userId, 'preparation', literatureOnlyPrepRequest);
  const literatureOnlyPrepJob = db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(literatureOnlyPrepJobId) as any;
  const literatureOnlyPrepSuggestionId = completeSuggestionJob(literatureOnlyPrepJob, 'preparation', JSON.stringify({
    rationale: '仅引用所选合成文献', assumptions: [], cautions: [], missingInfo: [], evidenceRefIds: [literatureEvidenceRefId],
  }), literatureOnlyPrepRequest);
  const literatureOnlyPrep = getSuggestionForUser(literatureOnlyPrepSuggestionId, userId, 'RESEARCHER')!;
  equal(literatureOnlyPrep.status, 'ready', '仅有文献引用且没有报告来源时配液建议仍通过校验');
  assert(literatureOnlyPrep.citations.length === 1 && literatureOnlyPrep.citations[0].valid
    && literatureOnlyPrep.citations[0].sourceType === 'literature', '配液建议单一文献来源保持typed引用');
  equal((prepSuggestionData.payload.preview.allocations[0].batches[0].requiredQuantity), '5', '配液建议沿用系统确定性计算用量');
  const balanceBeforeConfirm = String((db.prepare('SELECT quantity FROM stock_balances WHERE lot_id=?').get(lotId) as any).quantity);
  const preparationsBeforeConfirm = Number((db.prepare('SELECT COUNT(*) AS n FROM preparations').get() as any).n);
  const stalePrep = makePreparationSuggestion('10');
  db.prepare('UPDATE stock_balances SET quantity=? WHERE lot_id=?').run('0', lotId);
  let staleInventoryRejected = false;
  try { confirmSuggestion(stalePrep.suggestionId, userId, 'RESEARCHER', 'fixture-prep-stale', getSuggestionForUser(stalePrep.suggestionId, userId, 'RESEARCHER')!.expectedVersion); }
  catch (error) { staleInventoryRejected = String(error).includes('库存') || String(error).includes('批次'); }
  assert(staleInventoryRejected, '配液建议确认时检测到库存快照变化并拦截陈旧建议');
  equal(Number((db.prepare('SELECT COUNT(*) AS n FROM preparations').get() as any).n), preparationsBeforeConfirm, '陈旧库存建议未创建配液任务');
  db.prepare('UPDATE stock_balances SET quantity=? WHERE lot_id=?').run(balanceBeforeConfirm, lotId);
  const prepConfirm = confirmSuggestion(prepSuggestion.suggestionId, userId, 'RESEARCHER', 'fixture-prep-confirm', prepSuggestionData.expectedVersion);
  const prepAfterConfirm = db.prepare('SELECT status,performed_by FROM preparations WHERE id=?').get(prepConfirm.resultId) as any;
  equal(prepAfterConfirm.status, 'planned', '确认配液建议只创建 planned 配液任务');
  equal(prepAfterConfirm.performed_by, userId, '配液任务保留实际确认操作者');
  equal(String((db.prepare('SELECT quantity FROM stock_balances WHERE lot_id=?').get(lotId) as any).quantity), balanceBeforeConfirm, '确认配液辅助不直接扣减库存');
  const prepAudit = JSON.parse(String((db.prepare("SELECT details FROM audit_events WHERE action='ai.preparation_suggestion.confirm' AND object_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(prepConfirm.resultId) as any).details));
  assert(prepAudit.citedSources.some((source: any) => source.type === 'literature' && source.id === literatureId && source.contentSha256),
    '配液确认审计保留文献来源身份、版本及内容 SHA');
  equal(confirmSuggestion(prepSuggestion.suggestionId, userId, 'RESEARCHER', 'fixture-prep-confirm', prepSuggestionData.expectedVersion).alreadyConfirmed, true,
    '重复配液确认保持幂等');
  const workerPrepRequest = { recipeVersionId: publishedVersionId, targetVolume: '10', targetVolumeUnit: 'mL', reportIds: [reportId], literatureIds: [literatureId] };
  const workerPrepSuggestion = await runScopedSuggestionWorker('preparation', workerPrepRequest);
  const workerPrepBefore = String((db.prepare('SELECT quantity FROM stock_balances WHERE lot_id=?').get(lotId) as any).quantity);
  const workerPrepConfirm = confirmSuggestion(workerPrepSuggestion.id, userId, 'RESEARCHER', 'fixture-worker-prep-confirm', workerPrepSuggestion.expectedVersion);
  equal(workerPrepConfirm.resultType, 'preparation', 'Worker 生成的配液建议可经人工确认进入配液任务草稿闭环');
  equal(String((db.prepare('SELECT quantity FROM stock_balances WHERE lot_id=?').get(lotId) as any).quantity), workerPrepBefore,
    'Worker 配液建议确认仍不直接扣减库存');

  const outOfScopeLiteratureId = createLiteratureRecord({ id: userId, role: 'RESEARCHER' }, { title: '未选择的另一篇文献', abstract: 'Out of scope synthetic literature evidence.' });
  const outOfScopeLiterature = await searchLiterature('out of scope synthetic', { mode: 'keyword', actor: { id: userId, role: 'RESEARCHER' },
    scope: { itemIds: [outOfScopeLiteratureId] }, persistEvidence: true });
  const outOfScopeRequest = { purpose: 'scope rejection', reportIds: [], literatureIds: [literatureId] };
  const outOfScopeJobId = enqueueSuggestionJob(userId, 'recipe', outOfScopeRequest);
  let outOfScopeSuggestionRejected = false;
  try {
    completeSuggestionJob(db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(outOfScopeJobId) as any, 'recipe',
      JSON.stringify({ name: 'scope fixture', baseVolume: '1', baseVolumeUnit: 'mL', outputName: 'x', outputCode: 'x', outputUnit: 'mL', outputDimension: 'volume',
        ingredients: [], steps: ['x'], assumptions: [], missingInfo: [], evidenceRefIds: [outOfScopeLiterature.results[0].evidenceRefId] }), outOfScopeRequest);
  } catch (error) { outOfScopeSuggestionRejected = String(error).includes('不在用户选择的文献范围'); }
  db.prepare("UPDATE ai_jobs SET status='failed',finished_at=datetime('now'),error_code='fixture_scope_rejected' WHERE id=? AND status='queued'").run(outOfScopeJobId);
  assert(outOfScopeSuggestionRejected, '配方建议拒绝引用用户没有选择的文献');
  const staleLiteratureRequest = { purpose: 'stale source fixture', reportIds: [], literatureIds: [literatureId] };
  const staleLiteratureJobId = enqueueSuggestionJob(userId, 'recipe', staleLiteratureRequest);
  const staleLiteratureSuggestionId = completeSuggestionJob(db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(staleLiteratureJobId) as any, 'recipe',
    JSON.stringify({ name: 'stale fixture', baseVolume: '1', baseVolumeUnit: 'mL', outputName: 'x', outputCode: 'x', outputUnit: 'mL', outputDimension: 'volume',
      ingredients: [], steps: ['x'], assumptions: [], missingInfo: [], evidenceRefIds: [literatureEvidenceRefId] }), staleLiteratureRequest);
  const literatureItem = db.prepare('SELECT * FROM literature_items WHERE id=?').get(literatureId) as any;
  updateLiteratureMetadata({ id: userId, role: 'RESEARCHER' }, literatureItem, { title: '合成配方参考文献 修订版' });
  let replacedLiteratureRejected = false;
  try { confirmSuggestion(staleLiteratureSuggestionId, userId, 'RESEARCHER', 'fixture-stale-literature', getSuggestionForUser(staleLiteratureSuggestionId, userId, 'RESEARCHER')!.expectedVersion); }
  catch (error) { replacedLiteratureRejected = String(error).includes('引用了已删除') || String(error).includes('引用来源已删除'); }
  assert(replacedLiteratureRejected, '所选文献元数据修订使旧 evidence ref 在建议确认前失效');

  const staleJob = makeJob('contract:source-change-race');
  const raceRunner = async () => {
    db.prepare('UPDATE research_reports SET description=? WHERE id=?').run('在模型运行期间被并发更新', reportId);
    return { text: response({ value: '9.99', unit: 'mg/mL' }), toolCalls: 0, messages: [] };
  };
  const beforeCount = Number((db.prepare('SELECT COUNT(*) AS n FROM research_analyses WHERE report_id=?').get(reportId) as any).n);
  const staleResult = await analyzeReport(staleJob, reportId, manifest, chunks, new AbortController().signal, () => {}, raceRunner as any);
  assert('superseded' in staleResult && staleResult.superseded, '输入来源发生变化时分析被标为过期');
  equal((db.prepare('SELECT COUNT(*) AS n FROM research_analyses WHERE report_id=?').get(reportId) as any).n, beforeCount, '过期结果未进入当前知识表');
  equal((db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(staleJob) as any).status, 'superseded', '过期任务保留明确状态');

  const staleAssistantText = '旧证据事实标记 REVIEW-STALE-FACT-731';
  db.prepare("UPDATE ai_jobs SET status='completed',finished_at=datetime('now'),lease_owner=NULL,lease_until_ms=NULL WHERE id=?").run(chatMessage.jobId);
  db.prepare("UPDATE assistant_messages SET status='completed',content_text=?,citations_json=? WHERE job_id=? AND role='assistant'")
    .run(staleAssistantText, JSON.stringify([{ evidenceRefId, reportId, sourceVersionId: versionId }]), chatMessage.jobId);
  const followup = enqueueChatMessage(sessionId, userId, '请根据当前有效资料继续回答');
  db.prepare("UPDATE research_reports SET deleted_at=datetime('now') WHERE id=?").run(reportId);
  let capturedHistory: Array<{ role: string; content: string }> = [];
  const historyRunner = async (options: any) => {
    capturedHistory = options.history;
    return { text: '仅根据当前有效证据回答。', toolCalls: 0, messages: [] };
  };
  const historyWorkerRan = await runAiWorkerOnce({ runAgent: historyRunner as any });
  assert(historyWorkerRan, '真实 worker 路径拾取失效历史复核会话中的追问任务');
  assert(capturedHistory.some(item => item.role === 'assistant' && item.content.includes('失效事实已从本轮上下文排除')),
    '报告删除后真实 Pi 请求历史收到失效证据提示');
  assert(capturedHistory.every(item => !item.content.includes('REVIEW-STALE-FACT-731')),
    '报告删除后真实 Pi 请求历史不含旧助手事实正文');
  assert(getAssistantSession(sessionId, userId)!.messages.some(item => item.content === staleAssistantText), '历史审计界面仍保留原助手回答正文');
  equal((db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(followup.jobId) as any).status, 'completed', '过滤失效历史后当前会话任务可独立完成');

  const fenceSessionId = createAssistantSession(userId, 'knowledge_base', []);
  const fencedMessage = enqueueChatMessage(fenceSessionId, userId, '验证旧 Worker 写回围栏');
  const fenceOwner = 'replacement-worker-fence';
  const fencedRunner = async (options: any) => {
    db.prepare("UPDATE ai_jobs SET status='analyzing',lease_owner=?,attempt_count=attempt_count+1,lease_until_ms=? WHERE id=?")
      .run(fenceOwner, Date.now() + 120_000, fencedMessage.jobId);
    db.prepare("UPDATE assistant_messages SET status='running',content_text='新 Worker 拥有的回答' WHERE job_id=? AND role='assistant'")
      .run(fencedMessage.jobId);
    await options.onEvent({ type: 'progress', message: 'REVIEW-STALE-LEASE-EVENT', metadata: { attempt: 'old' } });
    return { text: '旧 Worker 不应覆盖的回答', toolCalls: 0, messages: [] };
  };
  const fencedWorkerRan = await runAiWorkerOnce({ runAgent: fencedRunner as any });
  assert(fencedWorkerRan, '合成竞态 runner 经过正式 worker 领取路径');
  const fencedJob = db.prepare('SELECT status,lease_owner,attempt_count FROM ai_jobs WHERE id=?').get(fencedMessage.jobId) as any;
  equal(fencedJob.lease_owner, fenceOwner, '任务被接管后新 owner 保留');
  equal(fencedJob.status, 'analyzing', '旧 Worker 不改变新 Worker 的处理中状态');
  const fencedAssistant = db.prepare("SELECT status,content_text FROM assistant_messages WHERE job_id=? AND role='assistant'").get(fencedMessage.jobId) as any;
  equal(fencedAssistant.content_text, '新 Worker 拥有的回答', '旧 Worker 不覆盖接管后的助手消息');
  equal(fencedAssistant.status, 'running', '旧 Worker 不改变接管后的助手消息状态');
  equal((db.prepare('SELECT COUNT(*) AS n FROM ai_job_events WHERE job_id=? AND message=?').get(fencedMessage.jobId, 'REVIEW-STALE-LEASE-EVENT') as any).n,
    0, '租约接管后旧 Worker 不能写入过期进度事件');

  // Exercise the durable worker retry path after all earlier queue assertions.
  db.prepare("UPDATE ai_jobs SET status='failed',lease_owner=NULL,lease_until_ms=NULL WHERE status='queued'").run();
  const retryWorkerSession = createAssistantSession(userId, 'knowledge_base', []);
  const retryWorkerMessage = enqueueChatMessage(retryWorkerSession, userId, '验证有限任务重试');
  db.prepare('UPDATE ai_jobs SET max_attempts=2 WHERE id=?').run(retryWorkerMessage.jobId);
  const rateLimitRunner = async () => { throw new Error('429 rate limit'); };
  assert(await runAiWorkerOnce({ runAgent: rateLimitRunner as any }), '正式 Worker 领取合成限流任务');
  const scheduledRetry = db.prepare('SELECT status,attempt_count,max_attempts,lease_until_ms,error_code,error_message FROM ai_jobs WHERE id=?')
    .get(retryWorkerMessage.jobId) as any;
  equal(scheduledRetry.status, 'queued', '可重试限流错误通过任务队列安排重试');
  equal(scheduledRetry.attempt_count, 1, '一次失败只消耗一次有限尝试');
  equal(scheduledRetry.error_code, 'rate_limited', '持久任务保留限流分类');
  assert(Number(scheduledRetry.lease_until_ms) >= Date.now() + 1500 && Number(scheduledRetry.lease_until_ms) <= Date.now() + 2500,
    '任务队列持久保存首轮退避时间');
  assert(!String(scheduledRetry.error_message).includes('429'), '用户可见错误不暴露 provider 原始响应');
  assert(db.prepare("SELECT 1 FROM ai_job_events WHERE job_id=? AND event_type='retry'").get(retryWorkerMessage.jobId), '持久事件记录有限重试安排');
  db.prepare('UPDATE ai_jobs SET lease_until_ms=0 WHERE id=?').run(retryWorkerMessage.jobId);
  assert(await runAiWorkerOnce({ runAgent: rateLimitRunner as any }), '任务到期后允许进入下一次有限尝试');
  const exhaustedRetry = db.prepare('SELECT status,attempt_count,max_attempts,error_code FROM ai_jobs WHERE id=?').get(retryWorkerMessage.jobId) as any;
  equal(exhaustedRetry.status, 'failed', '达到 max_attempts 后不再排入新重试');
  equal(exhaustedRetry.attempt_count, 2, '有限重试的尝试次数准确持久化');
  equal(exhaustedRetry.error_code, 'rate_limited', '终止状态保留可诊断错误分类');

  db.close();
  console.log('AI CONTRACT PASS: Pi faux + 真实本地 HTTP/SSE adapter 的 totalTokens 预算/缓存/缺失 usage/错误/重试阻断、有限 Worker 退避/分类、结构化归档/来源校验/修订链、知识证据、AI 配方与配液建议权限/确认/幂等及前轮契约均通过。');
} finally {
  // The parent process removes the isolated SQLite directory after this child exits.
}
} else {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/ai-contract-smoke.ts'], { cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: isolated, IVD_AI_CONTRACT_CHILD: '1' }, stdio: 'inherit' });
  const [code] = await once(child, 'exit') as [number | null];
  rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (code !== 0) throw new Error(`AI contract smoke child exited ${code}`);
}
import './test-isolation.mjs';
