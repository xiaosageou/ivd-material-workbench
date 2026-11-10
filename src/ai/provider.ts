import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import {
  createModels, createProvider, envApiKeyAuth, InMemoryCredentialStore,
  type AuthContext, type Model,
} from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { getAiApiKey, type AiConfig } from './config.ts';
import { classifyAiTaskError } from './errors.ts';
import { AiTokenBudgetError, AiTokenUsageUnknownError, type AiTokenUsage } from './usage.ts';

export type AiEvent = { type: string; message: string; metadata?: Record<string, unknown> };
export type AgentRunOptions = {
  config: AiConfig;
  prompt: string;
  systemPrompt: string;
  tools?: AgentTool[];
  history?: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }>;
  signal?: AbortSignal;
  usage?: {
    beforeRequest: (signal?: AbortSignal) => number;
    recordProviderMessage: (usage: unknown, stopReason: unknown, responseId?: unknown) => AiTokenUsage;
    snapshot: () => AiTokenUsage;
  };
  onEvent?: (event: AiEvent) => void | Promise<void>;
  beforeToolCall?: (toolName: string, signal?: AbortSignal) => Promise<{ block: true; reason: string; terminate?: true } | undefined>;
};

function configuredModel(config: AiConfig) {
  const key = getAiApiKey();
  if (!key) throw new Error('请先在模型设置中配置 API Key');
  if (!config.model) throw new Error('请先配置模型 ID');
  const authContext: AuthContext = {
    env: async name => name === 'OPENAI_API_KEY' ? key : undefined,
    fileExists: async () => false,
  };
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext });
  if (config.provider === 'openai') {
    models.setProvider(openaiProvider());
    const model = models.getModel('openai', config.model);
    if (!model) throw new Error('指定模型 ID 不在 Pi SDK 的官方 OpenAI 模型目录中');
    return { models, model };
  }

  if (!config.baseUrl) throw new Error('请先配置 OpenAI 兼容接口的 /v1 地址');
  const model: Model<'openai-completions'> = {
    id: config.model,
    name: config.model,
    provider: 'ivd-openai-compatible',
    api: 'openai-completions',
    baseUrl: config.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 32_768,
    maxTokens: Math.min(config.maxTokens, 32_768),
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  models.setProvider(createProvider({
    id: 'ivd-openai-compatible',
    name: 'IVD OpenAI 兼容服务',
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth('IVD AI 服务端密钥', ['OPENAI_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  }));
  const resolved = models.getModel('ivd-openai-compatible', config.model);
  if (!resolved) throw new Error('Pi SDK 兼容 provider 未注册指定模型');
  return { models, model: resolved };
}

const assistantText = (message: any) => Array.isArray(message?.content)
  ? message.content.filter((item: any) => item?.type === 'text').map((item: any) => String(item.text || '')).join('')
  : '';

export type PiRuntime = { models: ReturnType<typeof createModels>; model: Model<string> };

export async function runPiAgent(options: AgentRunOptions, testRuntime?: PiRuntime) {
  const { models, model } = testRuntime || configuredModel(options.config);
  let toolCalls = 0;
  let timeoutReached = false;
  const history: AgentMessage[] = (options.history || []).map(message => ({
    role: message.role, content: message.content, timestamp: message.timestamp || Date.now(),
  }) as unknown as AgentMessage);
  const agent = new Agent({
    initialState: { systemPrompt: options.systemPrompt, model, thinkingLevel: 'medium', tools: options.tools || [], messages: history },
    streamFn: (requestModel, context, streamOptions) => {
      const remaining = options.usage?.beforeRequest(streamOptions?.signal);
      return models.streamSimple(requestModel, context, {
        ...streamOptions,
        maxTokens: Math.max(1, Math.min(options.config.maxTokens, requestModel.maxTokens,
          remaining === undefined ? Number.MAX_SAFE_INTEGER : remaining)),
        // Retries happen at the task layer so every retry shares persisted usage.
        maxRetries: 0,
        maxRetryDelayMs: 2_500,
      });
    },
    toolExecution: 'sequential',
    maxRetryDelayMs: 2500,
    beforeToolCall: async ({ toolCall }, signal) => {
      toolCalls++;
      if (toolCalls > options.config.maxToolCalls) return { block: true, reason: '本次请求已达到工具调用上限', terminate: true };
      return options.beforeToolCall?.(toolCall.name, signal);
    },
  });
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type === 'agent_start') await options.onEvent?.({ type: 'agent_start', message: 'Pi Agent 已开始处理' });
    else if (event.type === 'tool_execution_start') {
      const data = event as any;
      await options.onEvent?.({ type: 'tool_start', message: `读取工具：${data.toolName || '业务查询'}`, metadata: { toolName: data.toolName } });
    } else if (event.type === 'tool_execution_end') {
      const data = event as any;
      await options.onEvent?.({ type: 'tool_end', message: '业务查询已完成', metadata: { toolName: data.toolName } });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message as any;
      options.usage?.recordProviderMessage(message.usage, message.stopReason, message.responseId);
    } else if (event.type === 'turn_end') await options.onEvent?.({ type: 'turn_end', message: '模型响应阶段完成' });
    else if (event.type === 'agent_end') await options.onEvent?.({ type: 'agent_end', message: 'Pi Agent 处理结束' });
  });
  const timeout = setTimeout(() => { timeoutReached = true; agent.abort(); }, options.config.timeoutMs);
  const abort = () => agent.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('AI 任务已取消');
    await agent.prompt(options.prompt);
    await agent.waitForIdle();
    if (options.signal?.aborted) throw new Error('AI 任务已取消');
    if (timeoutReached) throw new Error('AI 任务超过配置的运行时限');
    const usage = options.usage?.snapshot();
    if (usage?.unknownRequestCount || usage?.pendingRequestCount) throw new AiTokenUsageUnknownError();
    if (usage?.stopReason === 'budget_exceeded_by_inflight_request') throw new AiTokenBudgetError();
    if (agent.state.errorMessage) {
      const error = new Error(agent.state.errorMessage);
      (error as any).code = classifyAiTaskError(error).code;
      if (usage?.stopReason === 'budget_exhausted') throw new AiTokenBudgetError();
      throw error;
    }
    const finalMessage = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
    const text = assistantText(finalMessage);
    if (!text.trim()) throw new Error('模型没有返回可读取的文本内容');
    return { text, toolCalls, messages: agent.state.messages, usage };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    unsubscribe();
  }
}

export function piRuntimeConfigured(config: AiConfig) {
  const hasKey = Boolean(getAiApiKey());
  if (!hasKey || !config.model) return false;
  if (config.provider === 'openai-compatible' && !config.baseUrl) return false;
  if (config.provider === 'openai' && !openaiProvider().getModels().some(model => model.id === config.model)) return false;
  return true;
}
