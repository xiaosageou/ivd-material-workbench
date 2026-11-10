import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { embedOpenAiCompatible, EmbeddingRequestError } from './literature/embedding-provider.ts';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`EMBEDDING CONTRACT FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);
function caughtAsEmbeddingError(error: unknown, message: string): EmbeddingRequestError {
  assert(error instanceof EmbeddingRequestError, message);
  return error as EmbeddingRequestError;
}
const calls: Array<{ pathname: string; body: any; auth: string }> = [];
async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload));
}
const server = createServer(async (request, response) => {
  try {
    const body = await readBody(request);
    calls.push({ pathname: String(request.url), body, auth: String(request.headers.authorization || '') });
    const model = String(body.model);
    if (model === 'fixture-429') return send(response, 429, { error: { message: 'synthetic rate limit' } });
    if (model === 'fixture-500') return send(response, 500, { error: { message: 'synthetic server failure' } });
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const vector = (value: number) => [value, value + 1, value + 2];
    let data = input.map((_text: string, index: number) => ({ index, embedding: vector(index + 1) }));
    let usage: any = { prompt_tokens: input.length, total_tokens: input.length };
    if (model === 'fixture-shuffled') data = [...data].reverse();
    if (model === 'fixture-no-usage') usage = undefined;
    if (model === 'fixture-zero-usage') usage = { prompt_tokens: 0, total_tokens: 0 };
    if (model === 'fixture-duplicate-index') data = [{ index: 0, embedding: vector(1) }, { index: 0, embedding: vector(2) }];
    if (model === 'fixture-wrong-dimension') data = input.map((_text: string, index: number) => ({ index, embedding: [1, 2] }));
    if (model === 'fixture-string-vector') data = input.map((_text: string, index: number) => ({ index, embedding: ['1', '2', '3'] }));
    const payload: any = { id: `resp-${calls.length}`, model, data };
    if (usage) payload.usage = usage;
    send(response, 200, payload);
  } catch { send(response, 500, { error: { message: 'fixture parse failure' } }); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address() as { port: number };
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const profile = (model: string, overrides: Record<string, unknown> = {}) => ({ baseUrl, model, dimensions: 3, distance: 'Cosine' as const,
  sendDimensions: false, maxInputChars: 4000, timeoutMs: 3000, ...overrides });

try {
  const ordered = await embedOpenAiCompatible(['synthetic alpha', '合成乙'], profile('fixture-shuffled', { sendDimensions: true }), { apiKey: 'synthetic-test-key' });
  equal(ordered.vectors[0][0], 1, '响应 data 乱序时按 index 恢复第一个向量');
  equal(ordered.vectors[1][0], 2, '响应 data 乱序时按 index 恢复第二个向量');
  equal(ordered.usage.status, 'known', '完整 usage 标为 known');
  equal(ordered.usage.totalTokens, 2, 'prompt_tokens/total_tokens 采用响应真实值');
  equal(calls.at(-1)?.pathname, '/v1/embeddings', '请求使用兼容 Embeddings endpoint');
  equal(calls.at(-1)?.auth, 'Bearer synthetic-test-key', '服务端凭据进入本地 HTTP 请求');
  equal(calls.at(-1)?.body.dimensions, 3, '仅在配置开启时发送 dimensions');
  await embedOpenAiCompatible(['synthetic text'], profile('fixture-shuffled'), { apiKey: 'synthetic-test-key' });
  assert(!('dimensions' in calls.at(-1)!.body), 'dimensions 默认不发送');

  const missingUsage = await embedOpenAiCompatible(['synthetic text'], profile('fixture-no-usage'), { apiKey: 'synthetic-test-key' });
  equal(missingUsage.usage.status, 'unknown', '缺失 usage 明确标 unknown');
  equal(missingUsage.usage.totalTokens, null, '缺失 usage 不伪造为零');
  const zeroUsage = await embedOpenAiCompatible(['synthetic text'], profile('fixture-zero-usage'), { apiKey: 'synthetic-test-key' });
  equal(zeroUsage.usage.status, 'unknown', '非空内容配全零 usage 采用保守未知');
  for (const [model, expected] of [['fixture-duplicate-index', 'response_count_unknown'], ['fixture-wrong-dimension', 'vector_shape_invalid'], ['fixture-string-vector', 'vector_shape_invalid']] as const) {
    try { await embedOpenAiCompatible(['synthetic text'], profile(model), { apiKey: 'synthetic-test-key' }); throw new Error(`expected ${expected}`); }
    catch (error) { const failure = caughtAsEmbeddingError(error, `${model} 使用可分类错误`); equal(failure.code, expected, `${model} 拒绝不可信向量`); }
  }
  try { await embedOpenAiCompatible(['x'.repeat(50)], profile('fixture-shuffled', { maxInputChars: 10 }), { apiKey: 'synthetic-test-key' }); throw new Error('expected input size reject'); }
  catch (error) { const failure = caughtAsEmbeddingError(error, '超长输入提前拒绝'); equal(failure.code, 'input_size_limit', '超长输入不发送到服务'); }
  try { await embedOpenAiCompatible(['synthetic text'], profile('fixture-429'), { apiKey: 'synthetic-test-key' }); throw new Error('expected 429'); }
  catch (error) { const failure = caughtAsEmbeddingError(error, '429 返回结构化错误'); equal(failure.code, 'http_429', '429 状态码保留'); equal(failure.retryable, true, '429 允许有限退避'); equal(failure.usageOutcome, 'rejected', '明确限流拒绝不虚构 token'); }
  try { await embedOpenAiCompatible(['synthetic text'], profile('fixture-500'), { apiKey: 'synthetic-test-key' }); throw new Error('expected 500'); }
  catch (error) { const failure = caughtAsEmbeddingError(error, '5xx 返回结构化错误'); equal(failure.usageOutcome, 'unknown', '5xx 用量状态保守未知'); equal(failure.retryable, false, '未知用量阻止再次外呼'); }
  assert(calls.every(call => call.pathname === '/v1/embeddings' && call.auth === 'Bearer synthetic-test-key'), '全部流量仅发往本地合成 HTTP fixture');
  console.log(`EMBEDDING CONTRACT PASS: ${calls.length} local HTTP requests; response order, dimension option, usage unknown/zero, vector validation, input cap, 429 retry classification, and 5xx unknown usage verified.`);
} finally { const closed = once(server, 'close'); server.close(); server.closeIdleConnections(); await closed; }
import './test-isolation.mjs';
