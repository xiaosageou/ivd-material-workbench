import React, { useEffect, useState } from 'react';
import { BookOpen, CalendarDays, ChevronRight, FileText, Search, ShieldCheck } from 'lucide-react';
import ObservationReviewEditor from './ObservationReviewEditor.tsx';
import './research-assistant.css';

type Props = { onOpenReport: (reportId: string) => void };
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { ...(init.headers || {}),
    ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || '查询失败');
  return data;
}

export default function ResearchKnowledge({ onOpenReport }: Props) {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<any>({ observations: [], reports: [] });
  const [indexStatus, setIndexStatus] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingBusy, setSettingBusy] = useState(false);
  const search = async () => {
    setBusy(true); setError('');
    try {
      setData(await api('/api/ai/knowledge?semantic=true&q=' + encodeURIComponent(query)));
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const refreshStatus = async () => setIndexStatus(await api('/api/ai/knowledge/index-status'));
  const setExternalization = async (enabled: boolean) => {
    const message = enabled
      ? '启用后，当前和后续报告的标题、说明、人工有效的结构化观察及证据摘录会发送到管理员配置的 Embedding 服务进行报告语义索引；Agent 语义检索时还会发送查询词。报告原文件、原始数据附件和会话不进入索引。确认启用？'
      : '关闭后将停止后续报告知识 Embedding 请求，并暂停队列任务；已经发出的请求可能完成。确认关闭？';
    if (!window.confirm(message)) return;
    setSettingBusy(true); setError('');
    try { await api('/api/ai/knowledge/externalization', { method: 'PATCH', body: JSON.stringify({ enabled }) }); await refreshStatus(); }
    catch (reason: any) { setError(reason.message); }
    finally { setSettingBusy(false); }
  };
  const retryIndex = async (reportId: string) => {
    setSettingBusy(true); setError('');
    try { await api(`/api/ai/knowledge/reports/${encodeURIComponent(reportId)}/retry`, { method: 'POST', body: '{}' }); await refreshStatus(); }
    catch (reason: any) { setError(reason.message); }
    finally { setSettingBusy(false); }
  };
  useEffect(() => { void refreshStatus().catch(() => setIndexStatus(null)); void search(); }, []);

  return <div className="research-ai-page">
    <section className="ai-hero panel"><div className="ai-hero-mark"><BookOpen size={22}/></div><div className="grow"><div className="section-kicker">REPORT KNOWLEDGE</div><h2>组织内研发知识</h2><p>按关键词检索报告和结构化结论；管理员单独启用报告语义外发后，页面与 Agent 会通过独立 Qdrant 集合检索并回查当前报告证据。</p></div><span className="ai-state-pill"><ShieldCheck size={14}/>登录成员共享查看</span></section>
    <section className="panel knowledge-filters">
      <div className="panel-heading"><div><div className="section-kicker">REPORT SEARCH</div><h2>搜索报告与结论</h2></div></div>
      <div className="knowledge-search-row"><label className="knowledge-query">关键词<input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && void search()} placeholder="报告标题、结论、数值、单位、批次…"/></label><button className="button button-primary" onClick={() => void search()} disabled={busy}><Search size={15}/>{busy ? '检索中…' : '检索'}</button></div>
      <div className="knowledge-index-notice"><b>报告语义外发与索引</b><span>{indexStatus?.enabled ? '管理员已启用报告知识语义外发' : '报告知识语义外发默认关闭'} · {indexStatus?.completedReports ?? 0} 份报告已建索引 · {indexStatus?.activeJobs ?? 0} 项排队或处理中</span><small>{indexStatus?.embedding?.dataNotice || '启用后，报告标题、说明、有效结构化观察和证据摘录会发送到管理员配置的 Embedding 服务；语义检索会发送查询词。报告原文件、原始数据附件和会话不进入索引。报告和文献使用不同的 Qdrant 集合。关闭时页面与 Agent 均只做本地关键词检索。'}</small>
        {indexStatus?.canManageExternalization && <div className="knowledge-admin-actions"><button className={indexStatus.enabled ? 'button button-secondary' : 'button button-primary'} disabled={settingBusy}
          onClick={() => void setExternalization(!indexStatus.enabled)}>{settingBusy ? '保存中…' : indexStatus.enabled ? '关闭报告语义外发' : '单独启用报告语义外发'}</button>
          <span>仅管理员可切换；启用操作会排入当前有效报告。</span></div>}
      </div>
      {data.fallbackReason && <div className="knowledge-mode-note">本次使用关键词检索：{data.fallbackReason}</div>}
      {data.mode === 'semantic' && <div className="knowledge-mode-note">本次使用报告语义检索（Qdrant），结果已核验当前报告版本与有效证据。</div>}
      {error && <div className="form-error">{error}</div>}
    </section>
    <div className="knowledge-result-count"><b>{data.observations.length}</b> 条结构化信息 <span>·</span> <b>{data.reports.length}</b> 份报告</div>
    {indexStatus?.canManageExternalization && indexStatus?.jobs?.some((job: any) => ['failed','partial'].includes(job.status))
      && <section className="panel knowledge-failed-jobs"><div className="panel-heading"><div><div className="section-kicker">INDEX RECOVERY</div><h2>需要处理的索引任务</h2></div></div>
        {indexStatus.jobs.filter((job: any) => ['failed','partial'].includes(job.status)).map((job: any) => <div className="knowledge-failed-job" key={job.id}>
          <span><b>{job.title || job.reportId}</b><small>{job.status === 'partial' ? '部分完成' : '失败'} · 尝试 {job.attemptCount}/{job.maxAttempts} · {job.errorCode || '未知错误'}</small></span>
          <button className="button button-secondary" disabled={settingBusy || !indexStatus.enabled} onClick={() => void retryIndex(job.reportId)}>管理员重试</button>
        </div>)}</section>}
    <div className="knowledge-results">
      {data.observations.map((item: any) => <article className="knowledge-card panel" key={item.id}>
        <div className="knowledge-card-head"><div><span className={`knowledge-review review-${item.review?.state || item.reviewState}`}>
          {({ machine_unconfirmed: '机器整理 · 未确认', human_confirmed: '人工确认', corrected: '人工修正', conflict: '存在冲突', stale: '来源过时' } as any)[item.review?.state || item.reviewState] || item.reviewState}</span>
          <h3>{item.fieldKey}</h3><p>{item.reportTitle}</p></div><button className="text-link" onClick={() => onOpenReport(item.reportId)}>打开报告 <ChevronRight size={14}/></button></div>
        <pre className="knowledge-value">{JSON.stringify(item.value, null, 2)}</pre>
        {(item.review?.state === 'corrected' || item.review?.state === 'human_confirmed') && item.review?.correctedValue
          && JSON.stringify(item.originalValue) !== JSON.stringify(item.value)
          && <div className="knowledge-original">原始模型整理值：{JSON.stringify(item.originalValue)}</div>}
        {item.review?.state === 'conflict' && <div className="knowledge-conflict"><b>复核值与新分析结果有差异</b><span>保留的人工值：{JSON.stringify(item.review.correctedValue)}；请结合下面的来源核对。</span></div>}
        {item.summary && <p className="knowledge-summary">{item.summary}</p>}
        <div className="knowledge-sources">{item.evidence.map((source: any) => <div className="knowledge-source" key={source.id}><FileText size={14}/><span><b>{source.reportTitle}</b><small>{source.sourceKind === 'report_version' ? '报告正文' : '原始数据'} · {source.locator.kind} · {JSON.stringify(source.locator)}</small><em>{source.excerpt}</em></span></div>)}</div>
        {item.review?.comment && <div className="knowledge-review-comment">人工复核：{item.review.comment}</div>}
        {item.reviewState !== 'invalidated' && <ObservationReviewEditor item={item} canReview={item.canReview} compact onSaved={() => { void search(); }} />}
        <div className="knowledge-card-foot"><span><CalendarDays size={13}/>{item.reportDate || '日期未标注'}</span><span>{item.observationType}</span><span>分析于 {item.analysisCreatedAt}</span>{item.supersedesId && <span>已关联前序修订</span>}</div>
      </article>)}
      {!data.observations.length && <div className="knowledge-empty panel"><BookOpen size={24}/><b>当前没有匹配的结构化信息</b><span>报告尚未完成 AI 归档，或筛选条件下没有可验证来源的条目。</span></div>}
    </div>
    {data.reports?.length > 0 && <section className="panel knowledge-matching-reports"><div className="panel-heading"><div><div className="section-kicker">MATCHING REPORTS</div><h2>匹配报告</h2></div><span className="count-bubble">{data.reports.length}</span></div><div className="knowledge-report-links">{data.reports.map((report: any) => <button className="text-link" key={report.id} onClick={() => onOpenReport(report.id)}><FileText size={14}/>{report.title}<ChevronRight size={14}/></button>)}</div></section>}
  </div>;
}
