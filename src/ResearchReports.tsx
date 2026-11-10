import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Check, Clock3, Download, FileClock, FilePlus2, FileText, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import './research-reports.css';
import ObservationReviewEditor from './ObservationReviewEditor.tsx';

type Props = { notify: (message: string) => void; initialReportId?: string };

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || '操作未完成');
  return data;
}

const fmtDate = (value?: string) => value ? new Date(value.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const formatSize = (value: number) => value < 1024 ? value + ' B' : value < 1024 * 1024 ? (value / 1024).toFixed(1) + ' KB' : (value / 1024 / 1024).toFixed(2) + ' MB';
const aiJobStatus: Record<string, string> = { queued: '队列中', waiting_configuration: '等待模型配置', parsing: '正在解析', analyzing: '模型分析中', validating: '来源校验中',
  completed: '已完成', partial: '部分完成', needs_review: '待人工复核', failed: '处理失败', cancelled: '已取消', superseded: '来源已更新' };
const parseStatus: Record<string, string> = { parsed: '已解析', partial: '部分解析', unsupported: '格式暂不支持解析', failed: '解析失败' };
const aiActive = (status: string) => ['queued','waiting_configuration','parsing','analyzing','validating','waiting_configuration'].includes(status);
const retryableFailure = (job: any) => job.status === 'failed' && ['processing_error','network_error','network_timeout','rate_limited'].includes(String(job.error_code || ''))
  && !['pending','unknown','partial_unknown'].includes(String(job.usage?.status || 'none'))
  && Number(job.usage?.unknownRequestCount || 0) === 0 && Number(job.usage?.usedTokens || 0) < Number(job.usage?.budgetTokens || 0);

export default function ResearchReports({ notify, initialReportId }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newReportTitle, setNewReportTitle] = useState('');
  const [reportTitleTouched, setReportTitleTouched] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [changeNote, setChangeNote] = useState('');
  const [aiData, setAiData] = useState<any>(null);
  const [observationData, setObservationData] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiNotice, setAiNotice] = useState('');
  const [aiRefresh, setAiRefresh] = useState(0);

  useEffect(() => { if (initialReportId) setSelectedId(initialReportId); }, [initialReportId]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      api('/api/research-reports?q=' + encodeURIComponent(query)).then(data => { if (live) setRows(data); })
        .catch((err: Error) => { if (live) setError(err.message); });
    }, 160);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, refresh]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let live = true;
    api('/api/research-reports/' + encodeURIComponent(selectedId)).then(data => { if (live) { setDetail(data); setError(''); } })
      .catch((err: Error) => { if (live) { setDetail(null); setError(err.message); } });
    return () => { live = false; };
  }, [selectedId, refresh]);

  useEffect(() => {
    if (!selectedId) { setAiData(null); setObservationData(null); return; }
    let live = true;
    setAiLoading(true); setAiError('');
    Promise.all([
      api('/api/ai/reports/' + encodeURIComponent(selectedId) + '/analysis'),
      api('/api/ai/reports/' + encodeURIComponent(selectedId) + '/observations'),
    ]).then(([analysis, observations]) => { if (live) { setAiData(analysis); setObservationData(observations); } })
      .catch((reason: Error) => { if (live) setAiError(reason.message); })
      .finally(() => { if (live) setAiLoading(false); });
    return () => { live = false; };
  }, [selectedId, refresh, aiRefresh]);

  useEffect(() => {
    if (!(aiData?.jobs || []).some((job: any) => aiActive(job.status))) return;
    const timer = window.setInterval(() => setAiRefresh(value => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [aiData?.jobs]);

  const run = async (work: () => Promise<any>, message: string) => {
    setBusy(true); setError('');
    try {
      const result = await work();
      setRefresh(x => x + 1);
      if (result?.id) setSelectedId(result.id);
      if (result?.versions && result?.dataAttachments) setDetail(result);
      notify(message);
      return result;
    } catch (err: any) { setError(err.message); return undefined; }
    finally { setBusy(false); }
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) { setError('请选择报告文件'); return; }
    const created = await run(async () => api('/api/research-reports', { method: 'POST', body: form }), '研发报告已上传');
    if (created) setCreateOpen(false);
  };

  const edit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const saved = await run(async () => api('/api/research-reports/' + encodeURIComponent(selectedId), {
      method: 'PATCH', body: JSON.stringify({ title: form.get('title'), description: form.get('description') }),
    }), '报告信息已保存');
    if (saved) setEditOpen(false);
  };

  const replaceReport = async (file?: File) => {
    if (!file || !detail) return;
    const form = new FormData(); form.set('file', file); form.set('changeNote', changeNote);
    const updated = await run(async () => api('/api/research-reports/' + encodeURIComponent(detail.id) + '/versions', { method: 'POST', body: form }), '报告修订版已留存');
    if (updated) setChangeNote('');
  };

  const addRawData = async (files: FileList | null) => {
    if (!files?.length || !detail) return;
    const form = new FormData(); Array.from(files).forEach(file => form.append('files', file));
    await run(async () => api('/api/research-reports/' + encodeURIComponent(detail.id) + '/data-attachments', { method: 'POST', body: form }), '原始数据附件已添加');
  };

  const replaceRawData = async (attachmentId: string, file?: File) => {
    if (!file || !detail) return;
    const form = new FormData(); form.set('file', file);
    await run(async () => api('/api/research-reports/' + encodeURIComponent(detail.id) + '/data-attachments/' + encodeURIComponent(attachmentId) + '/replace', { method: 'POST', body: form }), '原始数据新版本已留存');
  };

  const deleteReport = async () => {
    if (!detail || !window.confirm('删除这份研发报告？报告将从共享列表移除，历史文件保留在审计与备份中。')) return;
    const removed = await run(async () => api('/api/research-reports/' + encodeURIComponent(detail.id), { method: 'DELETE' }), '研发报告已删除');
    if (removed) { setSelectedId(''); setDetail(null); setRefresh(x => x + 1); }
  };

  const deleteRawData = async (attachmentId: string) => {
    if (!detail || !window.confirm('移除这份原始数据附件？其历史版本会继续保留在审计与备份中。')) return;
    await run(async () => api('/api/research-reports/' + encodeURIComponent(detail.id) + '/data-attachments/' + encodeURIComponent(attachmentId), { method: 'DELETE' }), '原始数据附件已移除');
  };

  const reanalyze = async () => {
    if (!detail) return;
    setAiBusy(true); setAiError(''); setAiNotice('');
    try {
      const result = await api('/api/ai/reports/' + encodeURIComponent(detail.id) + '/analyze', { method: 'POST' });
      setAiNotice(result.status === 'queued' ? '分析任务已加入持久队列。未配置模型时，Worker 会解析文件后停在“等待模型配置”，不会生成模拟分析。' : '分析任务已提交。');
      setAiRefresh(value => value + 1); notify('报告分析任务已排队');
    } catch (reason: any) { setAiError(reason.message); setAiRefresh(value => value + 1); }
    finally { setAiBusy(false); }
  };

  const aiJobAction = async (jobId: string, action: 'cancel' | 'retry') => {
    setAiBusy(true); setAiError(''); setAiNotice('');
    try {
      await api('/api/ai/jobs/' + encodeURIComponent(jobId) + '/' + action, { method: 'POST' });
      setAiNotice(action === 'cancel' ? '已提交取消请求；运行中的任务会在当前步骤安全停止。' : '任务已重新排队，沿用原任务累计用量和预算。');
      setAiRefresh(value => value + 1); notify(action === 'cancel' ? '已请求取消分析任务' : '分析任务已重新排队');
    } catch (reason: any) { setAiError(reason.message); setAiRefresh(value => value + 1); }
    finally { setAiBusy(false); }
  };

  return <div className="research-reports">
    <div className="report-library-toolbar panel">
      <div><div className="section-kicker">RESEARCH ARCHIVE</div><h2>组织内共享的研发报告</h2><p>已登录成员均可查看和下载；上传者与管理员可维护报告。</p></div>
      <div className="report-library-actions"><label className="searchbox"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、说明、作者或文件名"/></label>
        <button className="button button-primary" onClick={() => { setError(''); setNewReportTitle(''); setReportTitleTouched(false); setCreateOpen(true); }}><Plus size={15}/>上传研发报告</button>
      </div>
    </div>
    {error && <div className="form-error report-error">{error}</div>}
    <div className="research-report-layout">
      <section className="panel report-library-list">
        <div className="panel-heading"><div><div className="section-kicker">REPORTS</div><h2>报告目录</h2></div><span className="count-bubble">{rows.length}</span></div>
        {rows.length ? rows.map(report => <button key={report.id} className={'report-library-item' + (selectedId === report.id ? ' selected' : '')} onClick={() => { setSelectedId(report.id); setEditOpen(false); setError(''); }}>
          <span className="report-library-icon"><FileText size={17}/></span><span className="report-library-copy"><b>{report.title}</b><small>{report.author_name} · V{report.version_no} · {report.extension?.toUpperCase()}</small><small>{report.original_name}</small></span>
          <span className="report-library-count">{report.data_attachment_count} 个<br/>原始数据</span>
        </button>) : <div className="report-library-empty"><FileClock size={22}/><b>{query ? '没有匹配的报告' : '还没有研发报告'}</b><span>上传 Word 或 Excel 报告后，组织成员可登录查看和下载。</span></div>}
      </section>

      <section className="panel report-detail-panel">
        {!detail ? <div className="report-detail-empty"><FileText size={27}/><b>选择一份报告查看详情</b><span>报告正文及原始数据均作为下载文件保存；不在浏览器中解析或编辑 Office 内容。</span></div> : <>
          <div className="panel-heading report-detail-heading"><div><div className="section-kicker">REPORT / V{detail.versions?.[0]?.version_no || 1}</div><h2>{detail.title}</h2><p>{detail.description || '暂无说明'}</p></div>
            {detail.can_edit ? <div className="report-detail-actions"><button className="button button-quiet" onClick={() => setEditOpen(x => !x)}><Pencil size={14}/>编辑信息</button><button className="button button-danger-quiet" onClick={deleteReport}><Trash2 size={14}/>删除</button></div> : <span className="report-readonly-badge"><ShieldCheck size={13}/>只读共享</span>}
          </div>
          {editOpen && Boolean(detail.can_edit) && <form className="report-metadata-editor" onSubmit={edit}>
            <label>标题<input name="title" required maxLength={200} defaultValue={detail.title}/></label>
            <label>说明<textarea name="description" maxLength={10000} rows={3} defaultValue={detail.description}/></label>
            <div className="dialog-actions"><button className="button button-quiet" type="button" onClick={() => setEditOpen(false)}>取消</button><button className="button button-primary" disabled={busy}>保存信息</button></div>
          </form>}
          <div className="report-meta-grid"><div><small>作者</small><b>{detail.author_name}</b></div><div><small>上传时间</small><b>{fmtDate(detail.created_at)}</b></div><div><small>最近更新</small><b>{fmtDate(detail.updated_at)}</b></div><div><small>当前版本</small><b>V{detail.versions?.[0]?.version_no || 1}</b></div></div>

          <section className="report-files-section"><div className="report-section-heading"><div><div className="section-kicker">REPORT FILE</div><h3>报告正文与修订历史</h3></div>{Boolean(detail.can_edit) && <div className="report-replace-control"><input aria-label="修订说明" placeholder="修订说明（可选）" value={changeNote} maxLength={500} onChange={event => setChangeNote(event.target.value)}/><label className="button button-quiet"><Upload size={14}/>替换文件<input type="file" hidden accept=".doc,.docx,.xls,.xlsx" disabled={busy} onChange={event => { void replaceReport(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label></div>}</div>
            <p className="report-file-help">Word 与 Excel 文件提供下载；正文修改请在本机 Office 中编辑后上传修订文件。系统保留每个版本。</p>
            <div className="report-version-list">{detail.versions?.map((version: any) => <div key={version.id} className="report-file-row"><div className="report-file-icon"><FileText size={16}/></div><div className="report-file-info"><b>{version.original_name}</b><small>V{version.version_no} · {version.extension.slice(1).toUpperCase()} · {formatSize(version.size_bytes)} · {fmtDate(version.created_at)} · {version.uploader_name}{version.change_note ? ' · ' + version.change_note : ''}</small></div><a className="button button-quiet button-small" href={'/api/research-reports/' + encodeURIComponent(detail.id) + '/versions/' + encodeURIComponent(version.id) + '/download'}><Download size={14}/>下载</a></div>)}</div>
          </section>

          <section className="report-files-section raw-data-section"><div className="report-section-heading"><div><div className="section-kicker">RAW DATA / ATTACHMENTS</div><h3>实验原始数据</h3></div>{Boolean(detail.can_edit) && <label className="button button-primary"><Plus size={14}/>添加原始数据<input type="file" hidden multiple disabled={busy} onChange={event => { void addRawData(event.target.files); event.currentTarget.value = ''; }}/></label>}</div>
            <p className="report-file-help">每个文件最多 20 MB，每次最多 8 个、合计不超过 50 MB。仪器导出和未知格式以附件下载，不会执行或在网页中解析；无在线 Office 编辑器。</p>
            {detail.dataAttachments?.length ? <div className="report-version-list">{detail.dataAttachments.map((item: any) => <div key={item.id} className="raw-attachment-card"><div className="raw-attachment-head"><div className="report-file-icon"><FilePlus2 size={16}/></div><div className="report-file-info"><b>{item.latest.original_name}</b><small>{item.latest.extension ? item.latest.extension.slice(1).toUpperCase() : '未知格式'} · {formatSize(item.latest.size_bytes)} · {item.version_count} 个版本 · {item.uploader_name}</small></div>{Boolean(detail.can_edit) && <div className="raw-attachment-actions"><label className="icon-button" title="追加替换版本"><Upload size={15}/><input type="file" hidden disabled={busy} onChange={event => { void replaceRawData(item.id, event.target.files?.[0]); event.currentTarget.value = ''; }}/></label><button className="icon-button" title="移除附件" onClick={() => deleteRawData(item.id)}><Trash2 size={15}/></button></div>}</div>
                {item.versions.map((version: any) => <div key={version.id} className="report-raw-version"><span>V{version.version_no} · {version.original_name} · {formatSize(version.size_bytes)} · {fmtDate(version.created_at)}</span><a href={'/api/research-reports/' + encodeURIComponent(detail.id) + '/data-attachments/' + encodeURIComponent(item.id) + '/versions/' + encodeURIComponent(version.id) + '/download'}><Download size={13}/>下载</a></div>)}
              </div>)}</div> : <div className="attachment-empty">尚无原始数据附件。</div>}
          </section>
          <section className="report-files-section report-ai-section">
            <div className="report-section-heading"><div><div className="section-kicker">AI ANALYSIS & REVIEW</div><h3>报告分析与人工复核</h3></div>
              {detail.can_edit && <button className="button button-primary" onClick={() => void reanalyze()} disabled={aiBusy || aiLoading || (aiData?.jobs || []).some((job: any) => aiActive(job.status))}>
                <RefreshCw size={14}/>{aiBusy ? '提交中…' : '手动重新分析'}
              </button>}
            </div>
            <p className="report-file-help">显示本报告当前版本的解析覆盖、分析结论与持久任务状态。作者和管理员可发起分析、取消适用任务及复核结构化条目；其他成员只读。</p>
            {aiError && <div className="form-error report-ai-error">{aiError}</div>}
            {aiNotice && <div className="report-ai-notice"><Check size={14}/>{aiNotice}</div>}
            {aiLoading ? <div className="report-ai-empty"><Clock3 size={16}/>正在读取解析和任务记录…</div> : <>
              {aiData?.config?.status !== 'configured' && <div className="report-ai-config-note"><AlertTriangle size={15}/><span><b>模型尚未配置</b><small>手动重新分析仍会先执行本地文件解析，并将任务保留为“等待模型配置”；不会生成模拟结论。配置状态：{(aiData?.config?.missing || []).join('、') || '等待服务端 Pi 配置'}。</small></span></div>}
              {aiData?.worker?.online === false && (aiData?.jobs || []).some((job: any) => aiActive(job.status)) && <div className="report-ai-config-note"><Clock3 size={15}/><span><b>当前没有在线 AI Worker</b><small>新任务会留在队列中，Worker 恢复后继续处理。</small></span></div>}

              <div className="report-ai-subsection"><div className="report-ai-subhead"><b>文件解析覆盖</b><span>{aiData?.sources?.length || 0} 个当前文件来源</span></div>
                {aiData?.sources?.length ? <div className="report-ai-source-list">{aiData.sources.map((source: any) => <article className="report-ai-source" key={source.sourceVersionId}>
                  <div className="report-ai-source-head"><FileText size={14}/><b>{source.name}</b><span className={'report-ai-status parse-' + (source.extraction?.status || 'waiting')}>{source.extraction ? parseStatus[source.extraction.status] || source.extraction.status : '尚未解析'}</span></div>
                  <small>{source.kind === 'report_version' ? '报告正文' : '原始数据'} · {source.extension?.toUpperCase()} · {formatSize(Number(source.sizeBytes || 0))}{source.extraction ? ` · 文本 ${Number(source.extraction.textLength || 0).toLocaleString()} 字符 · 解析器 ${source.extraction.parserVersion}` : ''}</small>
                  {source.extraction?.coverage && <div className="report-ai-coverage">{source.extraction.coverage.reason && <span className="coverage-warning">{source.extraction.coverage.reason}</span>}
                    {source.extraction.coverage.datasetCount !== undefined && <span>{source.extraction.coverage.datasetCount} 个数据表</span>}
                    {source.extraction.coverage.chunkCount !== undefined && <span>{source.extraction.coverage.chunkCount} 个证据片段</span>}
                    {source.extraction.coverage.omittedCount > 0 && <span className="coverage-warning">有 {source.extraction.coverage.omittedCount} 项未纳入解析</span>}
                    <details><summary>查看解析覆盖明细</summary><pre>{JSON.stringify(source.extraction.coverage, null, 2)}</pre></details>
                  </div>}
                </article>)}</div> : <div className="report-ai-empty">当前报告没有可解析的文件来源。</div>}
              </div>

              <div className="report-ai-subsection"><div className="report-ai-subhead"><b>当前分析结果</b>{aiData?.current && <span className="report-ai-status">{aiJobStatus[aiData.current.status] || aiData.current.status} · {fmtDate(aiData.current.createdAt)}</span>}</div>
                {aiData?.current ? <div className="report-ai-current-result">
                  <p>{aiData.current.summary || '本轮分析未提供摘要。'}</p>
                  {aiData.current.evidenceGaps?.length > 0 && <div className="report-ai-gaps"><b>证据缺口与待核实项</b><ul>{aiData.current.evidenceGaps.map((gap: any, index: number) => <li key={index}>{typeof gap === 'string' ? gap : JSON.stringify(gap)}</li>)}</ul></div>}
                  <details><summary>查看分析覆盖信息</summary><pre>{JSON.stringify(aiData.current.coverage, null, 2)}</pre></details>
                  {observationData?.analysis?.id === aiData.current.id && observationData.observations?.length > 0 ? <div className="report-ai-observations">
                    <div className="report-ai-subhead"><b>结构化结果与复核</b><span>{observationData.observations.length} 条</span></div>
                    {observationData.observations.map((item: any) => <article className="report-ai-observation" key={item.id}>
                      <div className="report-ai-observation-head"><div><span className={'knowledge-review review-' + (item.review?.state || item.reviewState)}>{({ machine_unconfirmed: '机器整理 · 未确认', human_confirmed: '人工确认', corrected: '人工修正', conflict: '存在冲突', stale: '来源过时' } as any)[item.review?.state || item.reviewState] || item.reviewState}</span><b>{item.fieldKey}</b><small>{item.observationType}</small></div></div>
                      <pre className="knowledge-value">{JSON.stringify(item.value, null, 2)}</pre>
                      {JSON.stringify(item.value) !== JSON.stringify(item.originalValue) && <div className="knowledge-original">原始模型整理值：{JSON.stringify(item.originalValue)}</div>}
                      {item.review?.comment && <div className="knowledge-review-comment">最近复核：{item.review.comment} · {fmtDate(item.review.createdAt)}</div>}
                      <div className="report-ai-evidence-list">{item.evidence?.length ? item.evidence.map((evidence: any) => <div key={evidence.id}><FileText size={12}/><span>{evidence.sourceKind === 'report_version' ? '报告正文' : '原始数据'} · {JSON.stringify(evidence.locator)}<small>{evidence.excerpt}</small></span></div>) : <span className="coverage-warning">当前文件版本中没有可用的证据定位。</span>}</div>
                      <ObservationReviewEditor item={item} canReview={Boolean(detail.can_edit) && !item.historical} onSaved={() => setAiRefresh(value => value + 1)}/>
                    </article>)}
                  </div> : <div className="report-ai-empty">当前版本尚无可复核的结构化条目。分析完成后，带有当前来源证据的结果会显示在这里。</div>}
                </div> : <div className="report-ai-empty">当前报告版本还没有完成的模型分析。手动重新分析会创建持久任务；未配置模型时任务停在等待配置状态。</div>}
              </div>

              {(aiData?.analyses || []).length > 0 && <div className="report-ai-subsection"><div className="report-ai-subhead"><b>历史分析版本</b><span>{aiData.analyses.length} 轮</span></div>
                <div className="report-ai-history-list">{aiData.analyses.map((analysis: any) => <details className="report-ai-history" key={analysis.id}>
                  <summary><span>{analysis.current ? '当前' : '历史'} · {aiJobStatus[analysis.status] || analysis.status}</span><small>{fmtDate(analysis.createdAt)}</small></summary>
                  <p>{analysis.summary || '本轮没有摘要。'}</p>
                  {analysis.evidenceGaps?.length > 0 && <div className="report-ai-gaps"><b>本轮证据缺口</b><ul>{analysis.evidenceGaps.map((gap: any, index: number) => <li key={index}>{typeof gap === 'string' ? gap : JSON.stringify(gap)}</li>)}</ul></div>}
                  {analysis.structured?.observations?.length > 0 && <div className="report-ai-history-items"><b>本轮结构化结果</b>{analysis.structured.observations.map((observation: any, index: number) => <div key={index}><span>{observation.field_key || observation.fieldKey || '未命名字段'}</span><code>{JSON.stringify(observation.value)}</code></div>)}</div>}
                  <details><summary>覆盖与假设</summary><pre>{JSON.stringify({ coverage: analysis.coverage, assumptions: analysis.structured?.assumptions || [] }, null, 2)}</pre></details>
                </details>)}</div>
              </div>}

              <div className="report-ai-subsection"><div className="report-ai-subhead"><b>分析任务</b><span>{aiData?.jobs?.length || 0} 条</span></div>
                {aiData?.jobs?.length ? <div className="report-ai-job-list">{aiData.jobs.map((job: any) => <article className="report-ai-job" key={job.id}>
                  <div className="report-ai-job-head"><span className={'report-ai-status job-' + job.status}>{aiJobStatus[job.status] || job.status}</span><small>尝试 {job.attempt_count || 0}/{job.max_attempts || 3} · 更新 {fmtDate(job.updated_at)}</small></div>
                  <p>{job.progress?.message || job.progress?.stage || (job.status === 'waiting_configuration' ? '文件解析已完成，等待模型配置。' : '任务已持久保存。')}</p>
                  {job.error_message && <div className="report-ai-job-error">{job.error_message}</div>}
                  {job.usage?.budgetTokens > 0 && <small className="report-ai-usage">累计 token {Number(job.usage.usedTokens || 0).toLocaleString()} / {Number(job.usage.budgetTokens).toLocaleString()} · 用量状态 {job.usage.status}</small>}
                  {detail.can_edit && <div className="report-ai-job-actions">{aiActive(job.status) && <button className="button button-quiet button-small" disabled={aiBusy} onClick={() => void aiJobAction(job.id, 'cancel')}>取消任务</button>}
                    {retryableFailure(job) && <button className="button button-quiet button-small" disabled={aiBusy} onClick={() => void aiJobAction(job.id, 'retry')}><RefreshCw size={12}/>重试此任务</button>}</div>}
                </article>)}</div> : <div className="report-ai-empty">尚无分析任务记录。</div>}
              </div>
            </>}
          </section>
          <div className="report-access-note"><ShieldCheck size={15}/><span>组织内所有已登录成员可查看和下载。{detail.can_edit ? '你可维护此报告。' : '当前为只读权限。'}文件替换保留版本记录，删除采用软删除并写入审计。</span></div>
        </>}
      </section>
    </div>

    {createOpen && <div className="modal-scrim" onClick={() => !busy && setCreateOpen(false)}><section className="modal-card modal-wide report-create-modal" onClick={event => event.stopPropagation()}>
      <div className="modal-head"><div><div className="section-kicker">NEW REPORT</div><h2>上传研发报告</h2><p>支持 .doc、.docx、.xls、.xlsx；正文后续通过替换文件上传修订版。</p></div><button className="icon-button" onClick={() => setCreateOpen(false)}><X size={17}/></button></div>
      <form className="report-metadata-editor" onSubmit={create}><label>标题<input name="title" required maxLength={200} value={newReportTitle} onChange={event => { setNewReportTitle(event.target.value); setReportTitleTouched(true); }} placeholder="默认取文件名，可自行修改"/></label><label>说明<textarea name="description" maxLength={10000} rows={4} placeholder="记录实验主题、适用批次或主要结论"/></label><label>报告文件<input name="file" type="file" required accept=".doc,.docx,.xls,.xlsx" onChange={event => { const file = event.target.files?.[0]; if (file && (!reportTitleTouched || !newReportTitle.trim())) setNewReportTitle(file.name.replace(/\.[^.]+$/, '')); }}/></label><small className="report-file-help">单个报告最大 25 MB。文件作为下载附件保存，浏览器不解析全部 Word/Excel 格式。</small>{error && <div className="form-error">{error}</div>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setCreateOpen(false)}>取消</button><button className="button button-primary" disabled={busy}><Upload size={14}/>{busy ? '上传中…' : '上传报告'}</button></div></form>
    </section></div>}
  </div>;
}
