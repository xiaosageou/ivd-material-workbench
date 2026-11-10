import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Check, ChevronRight, CircleStop, FileText, MessageSquarePlus, Plus, Send, Settings2, Sparkles, Trash2, Wrench } from 'lucide-react';
import './research-assistant.css';

type Props = { user: any; notify: (message: string) => void; onOpenReport: (reportId: string) => void;
  onOpenLiterature?: (literatureId: string) => void; initialLiteratureIds?: string[] };
async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
  return data;
}
const send = (path: string, body: any, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
const jobStatusLabel = (status: string) => ({ queued: '队列中', parsing: '读取资料', analyzing: '分析中', validating: '校验中',
  waiting_configuration: '等待模型配置', completed: '已完成', partial: '部分完成', needs_review: '待人工复核', failed: '处理失败',
  cancelled: '已取消', superseded: '来源已更新' } as Record<string, string>)[status] || status || '新建';
const usageLabel = (usage: any) => {
  if (!usage?.budgetTokens) return '';
  const known = Number(usage.usedTokens || 0);
  const stopReason = ({ budget_exhausted: '累计预算已用尽', budget_exceeded_by_inflight_request: '在途请求导致超出预算',
    provider_usage_missing: '模型未返回用量', request_failed_usage_unknown: '请求中断，用量未知',
    request_interrupted_usage_unknown: '进程中断，用量未知' } as Record<string, string>)[String(usage.stopReason || '')] || '';
  if (usage.status === 'unknown' || usage.status === 'partial_unknown') return `token 用量未知 · 已知 ${known.toLocaleString()} / ${Number(usage.budgetTokens).toLocaleString()} · 后续模型请求已停止${stopReason ? ` · ${stopReason}` : ''}`;
  return `累计 token ${known.toLocaleString()} / ${Number(usage.budgetTokens).toLocaleString()}（输入 ${Number(usage.inputTokens || 0).toLocaleString()}，输出 ${Number(usage.outputTokens || 0).toLocaleString()}，缓存读/写 ${Number(usage.cacheReadTokens || 0).toLocaleString()}/${Number(usage.cacheWriteTokens || 0).toLocaleString()}）${stopReason ? ` · ${stopReason}` : ''}`;
};

export default function ResearchAssistant({ user, notify, onOpenReport, onOpenLiterature, initialLiteratureIds = [] }: Props) {
  const [status, setStatus] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);
  const [selectedId, setSelectedId] = useState('');
  const [reports, setReports] = useState<any[]>([]);
  const [literature, setLiterature] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [contextType, setContextType] = useState(initialLiteratureIds.length ? 'literature' : 'knowledge_base');
  const [contextId, setContextId] = useState('');
  const [literatureContextIds, setLiteratureContextIds] = useState<string[]>(initialLiteratureIds);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<any>({ provider: 'openai-compatible', model: '', baseUrl: '', autoArchive: true, maxTokens: 8192,
    taskTokenBudget: 32768, timeoutMs: 90000, maxToolCalls: 8 });
  const [configBusy, setConfigBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [recipePurpose, setRecipePurpose] = useState('');
  const [recipeReports, setRecipeReports] = useState<string[]>([]);
  const [recipeLiterature, setRecipeLiterature] = useState<string[]>([]);
  const [basedOnRecipeVersionId, setBasedOnRecipeVersionId] = useState('');
  const [prepRecipeVersionId, setPrepRecipeVersionId] = useState('');
  const [prepTargetVolume, setPrepTargetVolume] = useState('');
  const [prepTargetVolumeUnit, setPrepTargetVolumeUnit] = useState('mL');
  const [prepReports, setPrepReports] = useState<string[]>([]);
  const [prepLiterature, setPrepLiterature] = useState<string[]>([]);
  const [suggestionJobId, setSuggestionJobId] = useState('');
  const [suggestionJobStatus, setSuggestionJobStatus] = useState('');
  const [suggestionUsage, setSuggestionUsage] = useState<any>(null);
  const [suggestion, setSuggestion] = useState<any>(null);
  const [suggestionDraft, setSuggestionDraft] = useState('');
  const [suggestionBusy, setSuggestionBusy] = useState(false);

  const refresh = async () => {
    const [state, chats, reportRows, literatureResponse] = await Promise.all([api('/api/ai/status'), api('/api/ai/sessions'), api('/api/research-reports'), api('/api/literature')]);
    setStatus(state); setSessions(chats); setReports(reportRows); setLiterature(literatureResponse.rows || []);
    if (user.role === 'ADMIN') {
      const saved = await api('/api/ai/admin/config');
      setConfig({ provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl, autoArchive: saved.autoArchive,
        maxTokens: saved.maxTokens, taskTokenBudget: saved.taskTokenBudget, timeoutMs: saved.timeoutMs, maxToolCalls: saved.maxToolCalls });
    }
  };
  useEffect(() => { void refresh().catch(reason => setError(reason.message)); }, []);
  useEffect(() => {
    api('/api/recipes').then((rows: any[]) => setRecipes(rows.flatMap(recipe => recipe.versions.map((version: any) => ({ id: version.id,
      recipeName: recipe.name, version: version.version, status: version.status })) ))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!selectedId) { setSession(null); return; }
    let live = true;
    const load = () => api('/api/ai/sessions/' + encodeURIComponent(selectedId)).then(value => { if (live) setSession(value); })
      .catch(reason => { if (live) setError(reason.message); });
    void load();
    const timer = window.setInterval(() => { if (session?.messages?.some((message: any) => message.status === 'queued' || message.status === 'running')) void load(); }, 1200);
    return () => { live = false; window.clearInterval(timer); };
  }, [selectedId, session?.messages?.map((item: any) => item.status).join(',')]);
  useEffect(() => {
    if (!suggestionJobId) return;
    let live = true;
    const load = () => api(`/api/ai/suggestions/by-job/${encodeURIComponent(suggestionJobId)}`).then((value: any) => {
      if (!live) return;
      setSuggestionJobStatus(value.job.status);
      setSuggestionUsage(value.job.usage);
      if (value.suggestion) { setSuggestion(value.suggestion); setSuggestionDraft(JSON.stringify(value.suggestion.payload, null, 2)); }
    }).catch((reason: any) => { if (live) setError(reason.message); });
    void load();
    const timer = window.setInterval(() => { if (!['completed','failed','cancelled'].includes(suggestionJobStatus)) void load(); }, 1400);
    return () => { live = false; window.clearInterval(timer); };
  }, [suggestionJobId, suggestionJobStatus]);

  const createSession = async () => {
    setError('');
    try {
      const reportIds = contextType === 'reports' || contextType === 'reports_literature'
        ? contextId.split(',').map(value => value.trim()).filter(Boolean) : contextType === 'report' && contextId ? [contextId] : [];
      if (contextType === 'literature' && !literatureContextIds.length) throw new Error('请选择至少一篇文献');
      if (contextType === 'reports_literature' && !reportIds.length && !literatureContextIds.length) throw new Error('请选择报告或文献作为本次会话范围');
      const apiContextType = contextType === 'literature' ? 'knowledge_base' : contextType === 'reports_literature' ? 'reports' : contextType;
      const literatureScope = contextType === 'knowledge_base' ? { type: 'reports_literature', literatureIds: [], reportIds: [], allowAll: true }
        : contextType === 'literature' ? { type: 'items', literatureIds: literatureContextIds }
          : contextType === 'reports_literature' ? { type: 'reports_literature', literatureIds: literatureContextIds, reportIds }
            : undefined;
      const created = await send('/api/ai/sessions', { contextType: apiContextType, contextIds: reportIds, literatureScope });
      setSelectedId(created.id); setSession(created); setQuery(''); await refresh();
    } catch (reason: any) { setError(reason.message); }
  };
  const postMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedId || !query.trim()) return;
    setBusy(true); setError('');
    try {
      await send(`/api/ai/sessions/${encodeURIComponent(selectedId)}/messages`, { message: query });
      setQuery('');
      const updated = await api('/api/ai/sessions/' + encodeURIComponent(selectedId)); setSession(updated);
      await refresh();
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!selectedId) return;
    await send(`/api/ai/sessions/${encodeURIComponent(selectedId)}/cancel`, {});
    setSession(await api('/api/ai/sessions/' + encodeURIComponent(selectedId)));
  };
  const removeSession = async (id: string) => {
    await api(`/api/ai/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (selectedId === id) { setSelectedId(''); setSession(null); }
    await refresh();
  };
  const saveConfig = async (event: React.FormEvent) => {
    event.preventDefault(); setConfigBusy(true); setError('');
    try {
      const saved = await api('/api/ai/admin/config', { method: 'PATCH', body: JSON.stringify(config) });
      setConfig({ provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl, autoArchive: saved.autoArchive,
        maxTokens: saved.maxTokens, taskTokenBudget: saved.taskTokenBudget, timeoutMs: saved.timeoutMs, maxToolCalls: saved.maxToolCalls });
      notify('研发助手设置已保存'); await refresh();
    } catch (reason: any) { setError(reason.message); }
    finally { setConfigBusy(false); }
  };
  const testConnection = async () => {
    setTesting(true); setError('');
    try { const result = await send('/api/ai/admin/test-connection', {}); notify(result.message); await refresh(); }
    catch (reason: any) { setError(reason.message); }
    finally { setTesting(false); }
  };
  const startSuggestion = async (type: 'recipe' | 'preparation') => {
    setError(''); setSuggestionBusy(true); setSuggestion(null); setSuggestionDraft('');
    try {
      const body = type === 'recipe'
        ? { purpose: recipePurpose, reportIds: recipeReports, literatureIds: recipeLiterature, basedOnRecipeVersionId: basedOnRecipeVersionId || undefined }
        : { recipeVersionId: prepRecipeVersionId, targetVolume: prepTargetVolume, targetVolumeUnit: prepTargetVolumeUnit,
            reportIds: prepReports, literatureIds: prepLiterature };
      const result = await send(`/api/ai/suggestions/${type}`, body);
      setSuggestionJobId(result.jobId); setSuggestionJobStatus(result.status || 'queued');
      notify(type === 'recipe' ? '配方建议任务已进入队列' : '配液建议任务已进入队列');
    } catch (reason: any) { setError(reason.message); }
    finally { setSuggestionBusy(false); }
  };
  const saveSuggestion = async () => {
    if (!suggestion) return;
    setSuggestionBusy(true); setError('');
    try {
      const payload = JSON.parse(suggestionDraft);
      const updated = await api(`/api/ai/suggestions/${encodeURIComponent(suggestion.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setSuggestion(updated); setSuggestionDraft(JSON.stringify(updated.payload, null, 2));
      notify('建议草稿已保存并重新校验');
    } catch (reason: any) { setError(reason instanceof SyntaxError ? '建议草稿 JSON 格式有误，请修正后保存' : reason.message); }
    finally { setSuggestionBusy(false); }
  };
  const confirmSuggestionDraft = async () => {
    if (!suggestion) return;
    setSuggestionBusy(true); setError('');
    try {
      const result = await send(`/api/ai/suggestions/${encodeURIComponent(suggestion.id)}/confirm`, {
        expectedVersion: suggestion.expectedVersion, idempotencyKey: crypto.randomUUID(),
      });
      const updated = await api(`/api/ai/suggestions/${encodeURIComponent(suggestion.id)}`);
      setSuggestion(updated); setSuggestionDraft(JSON.stringify(updated.payload, null, 2));
      notify(result.alreadyConfirmed ? '该建议已确认' : result.resultType === 'preparation' ? '已创建配液任务草稿' : '已创建配方草稿版本');
    } catch (reason: any) { setError(reason.message); }
    finally { setSuggestionBusy(false); }
  };

  const selected = sessions.find(item => item.id === selectedId);
  const contextLabel = (type: string, ids: string[], scope?: any, scopeType?: string) => type === 'knowledge_base'
    ? scopeType === 'reports_literature' ? '全报告与文献知识库' : scopeType === 'items' ? `文献范围 · ${scope?.itemIds?.length || 0} 篇` : '报告知识库（旧会话）'
    : type === 'report' ? `报告：${reports.find(row => row.id === ids[0])?.title || '所选报告'}`
      : type === 'reports' ? scopeType === 'reports_literature' ? `报告 ${ids.length} 份 · 文献 ${scope?.itemIds?.length || 0} 篇` : `报告集合 · ${ids.length} 份`
        : `配方：${recipes.find(row => row.id === ids[0])?.recipeName || '所选版本'}`;

  return <div className="research-ai-page">
    <section className="ai-hero panel"><div className="ai-hero-mark"><Sparkles size={22}/></div><div className="grow"><div className="section-kicker">PI R&amp;D ASSISTANT</div><h2>研发助手</h2><p>围绕组织共享报告、原始数据和配方版本提问；回答可查看有效来源与读取工具记录。</p></div>
      <span className={`ai-state-pill ${status?.status === 'configured' && status?.worker?.online ? 'configured' : ''}`}><span className="ai-state-dot"/>{status?.status === 'configured' ? status?.worker?.online ? '模型已配置 · Worker 在线' : '模型已配置 · Worker 离线' : '等待管理员配置模型'}</span>
      {user.role === 'ADMIN' && <button className="button button-quiet" onClick={() => setConfigOpen(value => !value)}><Settings2 size={15}/>模型设置</button>}</section>

    {user.role === 'ADMIN' && configOpen && <form className="panel ai-config-panel" onSubmit={saveConfig}>
      <div className="panel-heading"><div><div className="section-kicker">MODEL SERVICE</div><h2>模型与归档设置</h2><p>密钥只在服务端环境变量 IVD_AI_API_KEY 配置；页面仅显示配置状态。</p></div><span className={`badge ${status?.apiKeyConfigured ? 'badge-published' : 'badge-pending'}`}>{status?.apiKeyConfigured ? '服务端密钥已配置' : '服务端密钥待配置'}</span></div>
      <div className="ai-config-grid"><label>服务类型<select value={config.provider} onChange={e => setConfig({ ...config, provider: e.target.value })}><option value="openai-compatible">OpenAI 兼容服务</option><option value="openai">Pi 官方 OpenAI 服务</option></select></label>
        <label>模型 ID<input value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} required maxLength={200} placeholder="填写部署方提供的模型 ID"/></label>
        {config.provider === 'openai-compatible' && <label className="ai-url-field">兼容服务地址<input type="url" value={config.baseUrl} onChange={e => setConfig({ ...config, baseUrl: e.target.value })} placeholder="https://model.example/v1" required/></label>}
        <label>单次模型输出上限（token）<input type="number" min="1024" max="32768" value={config.maxTokens} onChange={e => setConfig({ ...config, maxTokens: Number(e.target.value) })}/></label>
        <label>每任务累计预算（token）<input type="number" min="1024" max="1000000" value={config.taskTokenBudget} onChange={e => setConfig({ ...config, taskTokenBudget: Number(e.target.value) })}/></label>
        <label>单任务时限（毫秒）<input type="number" min="5000" max="300000" value={config.timeoutMs} onChange={e => setConfig({ ...config, timeoutMs: Number(e.target.value) })}/></label>
        <label>工具调用上限<input type="number" min="1" max="24" value={config.maxToolCalls} onChange={e => setConfig({ ...config, maxToolCalls: Number(e.target.value) })}/></label>
      </div>
      <label className="ai-auto-archive"><input type="checkbox" checked={config.autoArchive} onChange={e => setConfig({ ...config, autoArchive: e.target.checked })}/><span><b>报告上传后自动解析与归档</b><small>关闭后，上传事件不自动生成分析任务；仍可在报告详情手动重分析。</small></span></label>
      <p className="config-note">每任务累计预算按 Pi provider 报告的 totalTokens 计数（含 input、output、cacheRead、cacheWrite），跨工具轮次及任务重试累加；reasoning 是 output 的子集，不重复累计。单次输出上限只限制每次响应。预算在每次模型请求前检查，当前请求的完整输入量只有收到 provider 用量后才能核算，因此该次在途请求仍可能使累计量超过预算。用量字段缺失、不完整或总数不一致时保留已知数并停止后续请求；不估算 token 或费用。</p>
      <div className="ai-config-actions"><span>状态：{status?.status === 'configured' ? '配置完整' : `等待：${status?.missing?.join('、') || '管理员配置'}`}</span><div><button className="button button-quiet" type="button" onClick={testConnection} disabled={testing || status?.status !== 'configured'}>{testing ? '检测中…' : '测试连接'}</button><button className="button button-primary" disabled={configBusy}>{configBusy ? '保存中…' : '保存设置'}</button></div></div>
    </form>}

    {error && <div className="form-error ai-page-error">{error}</div>}
    <div className="assistant-layout">
      <aside className="assistant-sessions panel"><div className="panel-heading"><div><div className="section-kicker">PRIVATE SESSIONS</div><h2>我的会话</h2></div><span className="count-bubble">{sessions.length}</span></div>
        <div className="assistant-new-session"><label>上下文<select value={contextType} onChange={e => { setContextType(e.target.value); setContextId(''); setLiteratureContextIds([]); }}><option value="knowledge_base">整个研发知识库（含报告与文献）</option><option value="report">单份报告</option><option value="reports">选定报告集合</option><option value="literature">选定文献</option><option value="reports_literature">选定报告＋文献</option><option value="recipe">指定配方版本</option></select></label>
          {contextType === 'report' && <label>报告<select value={contextId} onChange={e => setContextId(e.target.value)}><option value="">选择报告</option>{reports.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
          {contextType === 'reports' && <label>报告集合<select multiple value={contextId ? contextId.split(',') : []} onChange={e => setContextId(Array.from(e.target.selectedOptions).map(option => option.value).join(','))}>{reports.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select><small>按住 Ctrl / ⌘ 可选择多份</small></label>}
          {(contextType === 'literature' || contextType === 'reports_literature') && <label>选择文献（可多选）<select multiple value={literatureContextIds} onChange={e => setLiteratureContextIds(Array.from(e.target.selectedOptions).map(option => option.value))}>{literature.map(row => <option key={row.id} value={row.id}>{row.title}{row.publication_year ? ` · ${row.publication_year}` : ''}</option>)}</select><small>按住 Ctrl / ⌘ 可选择多篇；空选择不会自动扩展范围</small></label>}
          {contextType === 'reports_literature' && <label>选择报告（可多选）<select multiple value={contextId ? contextId.split(',') : []} onChange={e => setContextId(Array.from(e.target.selectedOptions).map(option => option.value).join(','))}>{reports.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select><small>仅检索明确选择的报告</small></label>}
          {contextType === 'recipe' && <label>配方版本<select value={contextId} onChange={e => setContextId(e.target.value)}><option value="">选择组织共享配方</option>{recipes.map(row => <option key={row.id} value={row.id}>{row.recipeName} · V{row.version} · {row.status}</option>)}</select></label>}
          <button className="button button-primary assistant-new-button" onClick={createSession}><MessageSquarePlus size={15}/>新建会话</button>
        </div>
        <div className="assistant-session-list">{sessions.map(item => <div className={'assistant-session-row' + (selectedId === item.id ? ' active' : '')} key={item.id}>
          <button onClick={() => setSelectedId(item.id)}><b>{item.title || item.first_prompt || '新会话'}</b><small>{contextLabel(item.context_type, JSON.parse(item.context_ids_json || '[]'), item.literatureScope, item.literatureScopeType)} · {jobStatusLabel(item.last_status)}</small></button>
          <button title="删除会话" className="icon-button" onClick={() => void removeSession(item.id)}><Trash2 size={14}/></button></div>)}
          {!sessions.length && <div className="assistant-session-empty">创建会话后，对话记录仅对本人可见。</div>}
        </div>
      </aside>
      <section className="assistant-chat panel">
        {!session ? <div className="assistant-chat-empty"><Bot size={30}/><b>围绕研发证据提问</b><span>选择知识库、报告集合或配方版本作为上下文，再开始新会话。</span><div className="assistant-shortcuts"><button onClick={() => setQuery('请总结所选资料的主要实验结果，并列出每条结论的来源。')}>总结结果</button><button onClick={() => setQuery('请核对原始数据的缺失值、均值、样本标准差和 CV，并说明所用列和单位。')}>核对原始数据</button><button onClick={() => setQuery('请结合已发布配方和当前可用批次，按目标体积预览理论用量与可选批次。')}>预览配液</button></div></div> : <>
          <div className="assistant-chat-head"><div><div className="section-kicker">{session.contextType?.toUpperCase() || 'SESSION'}</div><h2>{session.title || '研发助手会话'}</h2><p>{contextLabel(session.contextType, session.contextIds || [], session.literatureScope, session.literatureScopeType)}</p></div>
            {session.messages?.some((message: any) => message.status === 'queued' || message.status === 'running') && <button className="button button-quiet" onClick={cancel}><CircleStop size={14}/>取消回答</button>}
          </div>
          <div className="assistant-messages" key={selectedId}>{(session.messages || []).map((message: any) => <article className={'assistant-message message-' + message.role} key={message.id}>
              <div className="assistant-message-avatar">{message.role === 'user' ? user.name.slice(0, 1) : <Sparkles size={15}/>}</div><div className="assistant-message-body"><div className="assistant-message-label">{message.role === 'user' ? '你' : '研发助手'}{message.role === 'assistant' && message.jobStatus ? ` · ${jobStatusLabel(message.jobStatus)}` : message.status === 'running' ? ' · 正在处理' : message.status === 'queued' ? ' · 等待处理' : message.status === 'failed' ? ' · 处理失败' : ''}</div>
              <div className="assistant-message-text">{message.content || (message.status === 'running' ? '正在读取选定上下文并调用只读工具…' : '等待模型服务配置。')}</div>
              {message.role === 'assistant' && message.jobId && <small className="assistant-usage-status">{usageLabel(message.usage)}</small>}
              {message.toolTrace?.length > 0 && <details className="assistant-tool-trace"><summary><Wrench size={13}/>已执行 {message.toolTrace.length} 项只读查询</summary>{message.toolTrace.map((trace: any, index: number) => <span key={index}>{trace.name} · {trace.summary}</span>)}</details>}
              {message.citations?.length > 0 && <div className="assistant-citations"><b>来源</b>{message.citations.map((citation: any, index: number) => <button key={index} className={citation.valid ? '' : 'invalid'} disabled={!citation.valid} onClick={() => citation.sourceType === 'literature' ? onOpenLiterature?.(citation.literatureId) : onOpenReport(citation.reportId)}><FileText size={13}/><span>{citation.sourceType === 'literature' ? `${citation.title || citation.source?.title || '文献'}${citation.year ? ` · ${citation.year}` : ''}` : citation.reportTitle || citation.source?.reportTitle || '报告'} · {citation.locator?.page ? `第 ${citation.locator.page} 页` : citation.locator?.kind || citation.source?.locator?.kind}<small>{citation.valid ? JSON.stringify(citation.locator || citation.source?.locator) : '来源已删除、替换或超出会话范围'}</small></span><ChevronRight size={13}/></button>)}</div>}
            </div></article>)}</div>
          <form className="assistant-composer" onSubmit={postMessage}><textarea rows={3} value={query} onChange={e => setQuery(e.target.value)} placeholder="输入问题。回答中的事实将基于当前有效报告和系统查询结果。" disabled={busy}/><div><span>单条消息最多 6,000 字 · 会话私有 · 业务查询只读</span><button className="button button-primary" disabled={busy || !query.trim()}><Send size={15}/>{busy ? '发送中…' : '发送'}</button></div></form>
        </>}
      </section>
    </div>
    <section className="panel ai-suggestion-panel">
      <div className="panel-heading"><div><div className="section-kicker">RECIPE &amp; PREPARATION ASSIST</div><h2>AI 配方与配液建议</h2><p>建议先保存为待审核草稿；只有点击确认后，系统才创建配方草稿版本或配液任务。</p></div><span className="ai-state-pill">确定性计算 · 用户确认写入</span></div>
      <div className="ai-suggestion-forms">
        <form className="ai-suggestion-form" onSubmit={event => { event.preventDefault(); void startSuggestion('recipe'); }}>
          <h3>生成配方建议</h3>
          <label>研发用途与目标<textarea rows={3} value={recipePurpose} onChange={event => setRecipePurpose(event.target.value)} maxLength={2000} required placeholder="说明用途、目标和已知约束；未经资料支持的参数会标为待补充"/></label>
          <label>参考报告（可多选）<select multiple value={recipeReports} onChange={event => setRecipeReports(Array.from(event.target.selectedOptions).map(option => option.value))}>{reports.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select><small>按住 Ctrl / ⌘ 选择；系统只接受当前有效报告证据。</small></label>
          <label>参考文献（可多选）<select multiple value={recipeLiterature} onChange={event => setRecipeLiterature(Array.from(event.target.selectedOptions).map(option => option.value))}>{literature.map(row => <option key={row.id} value={row.id}>{row.title}{row.publication_year ? ` · ${row.publication_year}` : ''}</option>)}</select><small>只检索所选文献；模型引用需与当前版本匹配。</small></label>
          <label>基于组织共享配方（可选）<select value={basedOnRecipeVersionId} onChange={event => setBasedOnRecipeVersionId(event.target.value)}><option value="">新建建议</option>{recipes.map(row => <option key={row.id} value={row.id}>{row.recipeName} · V{row.version} · {row.status}</option>)}</select></label>
          <button className="button button-primary" disabled={suggestionBusy || !recipePurpose.trim()}><Sparkles size={14}/>生成配方草稿建议</button>
        </form>
        <form className="ai-suggestion-form" onSubmit={event => { event.preventDefault(); void startSuggestion('preparation'); }}>
          <h3>预览配液建议</h3>
          <label>已发布配方版本<select value={prepRecipeVersionId} onChange={event => setPrepRecipeVersionId(event.target.value)} required><option value="">选择配方版本</option>{recipes.filter(row => row.status === 'published').map(row => <option key={row.id} value={row.id}>{row.recipeName} · V{row.version}</option>)}</select></label>
          <label>参考报告（可多选）<select multiple value={prepReports} onChange={event => setPrepReports(Array.from(event.target.selectedOptions).map(option => option.value))}>{reports.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select><small>仅在所选报告中检索证据。</small></label>
          <label>参考文献（可多选）<select multiple value={prepLiterature} onChange={event => setPrepLiterature(Array.from(event.target.selectedOptions).map(option => option.value))}>{literature.map(row => <option key={row.id} value={row.id}>{row.title}{row.publication_year ? ` · ${row.publication_year}` : ''}</option>)}</select><small>仅在所选文献中检索证据。</small></label>
          <div className="ai-prep-target"><label>目标体积<input type="number" min="0.000000001" step="any" value={prepTargetVolume} onChange={event => setPrepTargetVolume(event.target.value)} required/></label><label>单位<select value={prepTargetVolumeUnit} onChange={event => setPrepTargetVolumeUnit(event.target.value)}><option>mL</option><option>µL</option><option>L</option><option>nL</option></select></label></div>
          <p>理论用量、批次可用量、单位与效期由系统计算并生成库存快照；AI 只解释快照，不选择批次或扣减库存。</p>
          <button className="button button-primary" disabled={suggestionBusy || !prepRecipeVersionId || !prepTargetVolume.trim()}><Sparkles size={14}/>生成配液辅助建议</button>
        </form>
      </div>
      {suggestionJobId && <div className="ai-suggestion-result">
        <div className="ai-suggestion-result-head"><div><b>{suggestion ? suggestion.type === 'recipe' ? '配方建议草稿' : '配液辅助建议' : '建议任务处理中'}</b><small>任务状态：{suggestionJobStatus || suggestion?.jobStatus || 'queued'}{suggestion?.jobStatus === 'waiting_configuration' || suggestionJobStatus === 'waiting_configuration' ? ' · 等待管理员配置模型与服务端密钥' : ''}{suggestionUsage ? ` · ${usageLabel(suggestionUsage)}` : ''}</small></div>{suggestion && <span className={`knowledge-review review-${suggestion.status}`}>{suggestion.status}</span>}</div>
        {suggestion?.errorMessage && <p className="form-error">{suggestion.errorMessage}</p>}
        {!suggestion && <p>任务由独立 Worker 持久处理；真实模型配置缺失时会保持等待状态。</p>}
        {suggestion && <><p>编辑区为建议结构化草稿。保存后服务端重新检查单位、物料、来源和库存预览；状态为“可确认”时可创建正式业务草稿。</p>
          {suggestion.citations?.length > 0 && <div className="assistant-citations"><b>引用来源</b>{suggestion.citations.map((citation: any, index: number) => <button key={citation.evidenceRefId || index} className={citation.valid ? '' : 'invalid'} disabled={!citation.valid}
            onClick={() => citation.sourceType === 'literature' ? onOpenLiterature?.(citation.literatureId) : citation.reportId && onOpenReport(citation.reportId)}><FileText size={13}/><span>{citation.sourceType === 'literature' ? citation.source?.title || '文献' : citation.source?.reportTitle || '研发报告'}<small>{citation.source?.locator?.page ? `第 ${citation.source.locator.page} 页 · ` : ''}{citation.source?.coverageNotice || JSON.stringify(citation.source?.locator || {})}</small></span><ChevronRight size={13}/></button>)}</div>}
          {(suggestion.validation?.missingInfo || suggestion.payload?.missingInfo || []).length > 0 && <ul className="ai-suggestion-missing">{(suggestion.validation?.missingInfo || suggestion.payload?.missingInfo || []).map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>}
          <textarea className="ai-suggestion-json" value={suggestionDraft} onChange={event => setSuggestionDraft(event.target.value)} rows={16} aria-label="编辑结构化建议草稿"/>
          <div className="ai-suggestion-actions"><span>引用 {suggestion.citations?.filter((item: any) => item.valid).length || 0} 条有效证据 · 保存后必须重新确认</span><div><button className="button button-quiet" type="button" disabled={suggestionBusy || ['confirmed','cancelled'].includes(suggestion.status)} onClick={() => void saveSuggestion()}>保存并校验</button><button className="button button-primary" type="button" disabled={suggestionBusy || suggestion.status !== 'ready'} onClick={() => void confirmSuggestionDraft()}><Check size={14}/>{suggestion.type === 'recipe' ? '确认创建配方草稿' : '确认创建配液任务'}</button></div></div>
        </>}
      </div>}
    </section>
    <div className="assistant-disclaimer"><Check size={14}/>模型仅提供研发辅助；配方和配液数值由系统确定性计算，业务写入必须由用户确认。</div>
  </div>;
}
