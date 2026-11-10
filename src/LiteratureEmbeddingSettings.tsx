import React, { useEffect, useState } from 'react';
import { Activity, Check, Info, Save, Server, Sparkles } from 'lucide-react';

type Props = { notify: (message: string) => void };
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `操作未完成 (${response.status})`);
  return data;
}

export default function LiteratureEmbeddingSettings({ notify }: Props) {
  const [status, setStatus] = useState<any>(null);
  const [values, setValues] = useState<any>({});
  const [apiKey, setApiKey] = useState('');
  const [health, setHealth] = useState<any>(null);
  const [connection, setConnection] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    const [config, vector] = await Promise.all([
      request('/api/admin/literature/embedding-config'), request('/api/admin/literature/vector-health'),
    ]);
    setStatus(config); setValues(config.config || {}); setHealth(vector);
  };
  useEffect(() => { void load().catch((reason: Error) => setError(reason.message)); }, []);
  const update = (key: string, value: unknown) => setValues((current: any) => ({ ...current, [key]: value }));
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); setConnection(null);
    try { const result = await request('/api/admin/literature/embedding-config', { method: 'PATCH', body: JSON.stringify({ ...values, ...(apiKey.trim() ? { apiKey } : {}) }) });
      setApiKey(''); setStatus(result); setValues(result.config || {}); notify('向量检索配置已保存'); await load(); }
    catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError(''); setConnection(null);
    try { const result = await request('/api/admin/literature/embedding-config/test', { method: 'POST', body: '{}' }); setConnection(result); }
    catch (reason: any) { setConnection({ ok: false, message: reason.message }); } finally { setBusy(false); }
  };
  const refreshVector = async () => {
    setBusy(true); setError('');
    try { setHealth(await request('/api/admin/literature/vector-health')); } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  if (!status) return <section className="panel"><div className="section-kicker">EMBEDDING & VECTOR SEARCH</div><h2>文献与研发报告向量化</h2>{error || '正在读取服务状态…'}</section>;
  return <section className="panel literature-embedding-settings">
    <div className="panel-heading"><div><div className="section-kicker">EMBEDDING & VECTOR SEARCH</div><h2>文献与研发报告向量化</h2><p>此配置供文献 Worker 与研发报告知识 Worker 共用；两类内容写入不同 Qdrant 集合。API Key 保存在服务端本地，保存后不再显示；留空保留现有密钥。</p></div><Sparkles size={18}/></div>
    <div className="literature-service-status"><div><span className={`literature-status ${status.embedding?.keyConfigured ? 'status-completed' : 'status-waiting_configuration'}`}>{status.embedding?.keyConfigured ? 'Embedding 密钥已配置' : '等待 Embedding 密钥'}</span><small>{status.embedding?.keySource}</small></div>
      <div><span className={`literature-status ${health?.health?.status === 'connected' ? 'status-completed' : 'status-waiting_configuration'}`}>{health?.health?.status === 'connected' ? 'Qdrant 可连接' : 'Qdrant 未连接'}</span><small>{health?.configured?.url || 'QDRANT_URL 尚未设置'} · 服务密钥 {health?.configured?.keyConfigured ? '已配置' : '未配置'}</small></div>
      <button type="button" className="button button-quiet" onClick={refreshVector} disabled={busy}><Activity size={14}/>检测 Qdrant</button>
    </div>
    {status.profile && <div className="literature-profile-note"><Check size={14}/>当前 profile：{status.profile.model} · {status.profile.dimensions} 维 · {status.profile.distance} · {status.profile.fingerprint.slice(0, 12)}</div>}
    <form className="literature-form" onSubmit={save}>
      <div className="literature-form-grid">
        <label>Embedding API Key<input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={status.embedding?.keyConfigured ? "已保存，留空不修改" : "输入 API Key"}/></label>
        <label className="field-wide">OpenAI-compatible API base URL<input value={values.baseUrl || ''} onChange={event => update('baseUrl', event.target.value)} placeholder="https://embedding.example/v1"/><small>仅 HTTPS；本机契约测试可使用回环地址 HTTP。</small></label>
        <label>模型 ID<input value={values.model || ''} onChange={event => update('model', event.target.value)} placeholder="部署方提供的 embedding 模型名"/></label>
        <label>期望维度<input type="number" min="1" max="65536" step="1" value={values.dimensions || ''} onChange={event => update('dimensions', Number(event.target.value))} placeholder="由服务商说明"/></label>
        <label>距离度量<select value={values.distance || 'Cosine'} onChange={event => update('distance', event.target.value)}><option value="Cosine">Cosine</option><option value="Dot">Dot</option><option value="Euclid">Euclid</option><option value="Manhattan">Manhattan</option></select></label>
        <label>每批输入数<input type="number" min="1" max="64" value={values.batchSize || 16} onChange={event => update('batchSize', Number(event.target.value))}/></label>
        <label>每条输入字节上限<input type="number" min="256" max="20000" value={values.maxInputChars || 6000} onChange={event => update('maxInputChars', Number(event.target.value))}/></label>
        <label>请求超时（毫秒）<input type="number" min="5000" max="300000" step="1000" value={values.timeoutMs || 45000} onChange={event => update('timeoutMs', Number(event.target.value))}/></label>
        <label>任务 token 预算<input type="number" min="0" max="2000000" step="1000" value={values.taskTokenBudget ?? 100000} onChange={event => update('taskTokenBudget', Number(event.target.value))}/></label>
        <label>任务最大请求数<input type="number" min="0" max="10000" value={values.maxRequests ?? 200} onChange={event => update('maxRequests', Number(event.target.value))}/></label>
        <label>每位成员每日查询 token 上限<input type="number" min="0" max="2000000" step="1000" value={values.queryTokenBudget ?? 20000} onChange={event => update('queryTokenBudget', Number(event.target.value))}/></label>
        <label>每位成员每日查询请求上限<input type="number" min="0" max="10000" value={values.queryMaxRequests ?? 100} onChange={event => update('queryMaxRequests', Number(event.target.value))}/></label>
        <label>文档前缀<input value={values.documentPrefix || ''} onChange={event => update('documentPrefix', event.target.value)} placeholder="默认留空"/></label>
        <label>查询前缀<input value={values.queryPrefix || ''} onChange={event => update('queryPrefix', event.target.value)} placeholder="默认留空"/></label>
        <label className="literature-check"><input type="checkbox" checked={values.sendDimensions === true} onChange={event => update('sendDimensions', event.target.checked)}/>请求中发送 dimensions 参数（仅在兼容服务明确支持时启用）</label>

      </div>
      <div className="literature-data-transfer-note"><Info size={15}/><span>文献解析后自动向量化会发送书目、摘要和本地解析正文片段。研发报告知识由独立队列发送报告标题、说明、当前有效结构化观察及相应证据摘录；不发送报告附件、原始数据附件或聊天会话。两类向量存入不同 Qdrant 集合；profile 的模型、维度或前缀改变会生成隔离索引空间。</span></div>
      <p className="literature-data-transfer-note">语义查询按登录成员、Embedding profile 与 UTC 日期累计请求和 provider 实报 token；未知用量会阻断当日后续语义外呼。该统计不估算 token 费用。</p>
      {error && <div className="literature-error">{error}</div>}
      {connection && <div className={`literature-connection-result ${connection.ok ? 'ok' : 'failed'}`}><Server size={15}/><span>{connection.ok ? `合成文本测试通过 · ${connection.embedding?.dimensions} 维 · 用量 ${connection.embedding?.usage}` : connection.message || connection.embedding?.message || `Embedding：${connection.embedding?.status || '失败'}；Qdrant：${connection.vector?.status || '未检测'}`}</span></div>}
      <div className="literature-modal-actions"><button type="button" className="button button-quiet" onClick={test} disabled={busy || status.embedding?.status !== 'configured' || status.qdrant?.status !== 'configured'}><Activity size={14}/>发送合成文本测试</button><button type="submit" className="button button-primary" disabled={busy}><Save size={14}/>{busy ? '保存中…' : '保存检索设置'}</button></div>
    </form>
  </section>;
}
