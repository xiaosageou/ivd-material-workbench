import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Bot, Clock3, Download, FileText, FolderOpen, Info, Plus, RotateCcw, Save, Search, ShieldCheck, Sparkles, Tag, Trash2, Upload, X } from 'lucide-react';
import './literature-library.css';

type Props = { notify: (message: string) => void; onAskAssistant?: (itemId?: string) => void; initialItemId?: string };
type Row = Record<string, any>;
type SelectedUploadFile = { key: string; file: File; title?: string };
type UploadResultRow = Row & { clientKey: string; file: File; title?: string };

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw Object.assign(new Error(data?.error || `操作未完成 (${response.status})`), { status: response.status, data });
  return data;
}

const fmtDate = (value?: string) => value ? new Date(value.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtSize = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;
const parseLabel: Record<string,string> = { parsed: '全文已解析', partial: '部分覆盖', needs_ocr: '待 OCR', unsupported: '暂不支持解析', failed: '解析失败' };
const jobLabel: Record<string,string> = { queued:'队列中', waiting_configuration:'等待配置', parsing:'正在解析', embedding:'生成向量中', publishing:'发布索引中', completed:'已完成', partial:'部分完成', failed:'处理失败', cancelled:'已取消', superseded:'来源已更新' };

export default function LiteratureLibrary({ notify, onAskAssistant, initialItemId = '' }: Props) {
  const [query, setQuery] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [trashRows, setTrashRows] = useState<Row[]>([]);
  const [stats, setStats] = useState({ total: 0, searchable: 0, processing: 0, failed: 0 });
  const [searchStatus, setSearchStatus] = useState<any>(null);
  const searchMode = 'semantic';
  const [searchSummary, setSearchSummary] = useState<any>(null);
  const [collections, setCollections] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Row | null>(null);
  const [trashMode, setTrashMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<SelectedUploadFile[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [batchResults, setBatchResults] = useState<UploadResultRow[]>([]);
  const uploadInFlight = useRef(false);
  const uploadSelectionCounter = useRef(0);

  useEffect(() => { if (initialItemId) { setTrashMode(false); setSelectedId(initialItemId); } }, [initialItemId]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        const [list, collectionList, trash, searchStatusResult] = await Promise.all([
          api('/api/literature?q=' + encodeURIComponent(query) + '&collectionId=' + encodeURIComponent(collectionId) + '&mode=' + searchMode),
          api('/api/literature/collections'), api('/api/literature/trash'), api('/api/literature/search-status'),
        ]);
        if (!live) return;
        setRows(list.rows || []); setStats(list.stats || { total: 0, searchable: 0, processing: 0, failed: 0 });
        setCollections(collectionList); setTrashRows(trash);
        setSearchStatus(searchStatusResult);
        setSearchSummary(list.search || null);
        const visible = trashMode ? trash : list.rows || [];
        setSelectedId(current => visible.some((row: Row) => row.id === current) ? current : visible[0]?.id || '');
        setError('');
      } catch (reason: any) { if (live) setError(reason.message); }
    }, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, collectionId, trashMode, refresh, searchMode]);

  useEffect(() => {
    if (!selectedId || trashMode) { setDetail(null); return; }
    let live = true;
    api('/api/literature/' + encodeURIComponent(selectedId)).then(data => { if (live) { setDetail(data); setError(''); } })
      .catch((reason: Error) => { if (live) { setDetail(null); setError(reason.message); } });
    return () => { live = false; };
  }, [selectedId, trashMode, refresh]);

  const visibleRows = trashMode ? trashRows : rows;
  const selectedRow = useMemo(() => visibleRows.find(row => row.id === selectedId) || null, [visibleRows, selectedId]);
  const canEdit = Boolean(detail?.can_edit || selectedRow?.can_edit);
  const nextUploadFileKey = () => `upload-${Date.now()}-${++uploadSelectionCounter.current}`;
  const fileSignature = (file: File) => `${file.name}\0${file.size}\0${file.lastModified}`;
  const retryingFailedFiles = selectedFiles.length > 0 && selectedFiles.every(selected =>
    batchResults.some(row => !row.ok && row.clientKey === selected.key));
  const openUpload = () => {
    setSelectedFiles([]); setBatchResults([]); setUploadError(''); setUploadOpen(true);
  };
  const chooseUploadFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []);
    if (!files.length) return;
    if (!batchResults.length) {
      setUploadError(''); setSelectedFiles(files.map(file => ({ key: nextUploadFileKey(), file })));
      return;
    }
    const unused = new Set(batchResults.map(row => row.clientKey));
    const matched: SelectedUploadFile[] = [];
    let selectedPreviouslySaved = false;
    let selectedUnknownFile = false;
    for (const file of files) {
      const candidates = batchResults.filter(row => unused.has(row.clientKey));
      const exact = candidates.filter(row => fileSignature(row.file) === fileSignature(file));
      const sameName = candidates.filter(row => row.file.name === file.name);
      const previous = exact.length === 1 ? exact[0] : exact.length > 1 ? undefined : sameName.length === 1 ? sameName[0] : undefined;
      if (!previous) {
        if (exact.some(row => row.ok) || sameName.some(row => row.ok)) selectedPreviouslySaved = true;
        selectedUnknownFile = true; continue;
      }
      unused.delete(previous.clientKey);
      if (previous.ok) selectedPreviouslySaved = true;
      else matched.push({ key: previous.clientKey, file, title: previous.title });
    }
    if (selectedPreviouslySaved || (matched.length && selectedUnknownFile)) {
      const pending = batchResults.filter(row => !row.ok).map(row => ({ key: row.clientKey, file: row.file, title: row.title }));
      setSelectedFiles(pending);
      setUploadError(selectedPreviouslySaved
        ? '已保存文件不会重复上传。请只重新选择未保存项；已保存项仍保留在下方结果中。'
        : '请一次只选择本批次未保存的文件；若要添加其他文献，请先结束本批次后重新上传。');
      return;
    }
    if (matched.length && !selectedUnknownFile) {
      setSelectedFiles(matched); setUploadError('');
      return;
    }
    setBatchResults([]); setUploadError('');
    setSelectedFiles(files.map(file => ({ key: nextUploadFileKey(), file })));
  };
  const update = async (work: () => Promise<any>, message: string) => {
    setBusy(true); setError(''); setNotice('');
    try { const result = await work(); setRefresh(value => value + 1); setNotice(message); notify(message); return result; }
    catch (reason: any) { setError(reason.message); return undefined; }
    finally { setBusy(false); }
  };

  const uploadLiterature = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (uploadInFlight.current) return;
    uploadInFlight.current = true;
    setBusy(true); setError('');
    if (!retryingFailedFiles) { setUploadError(''); setBatchResults([]); }
    const form = new FormData(formElement);
    const authors = String(form.get('authors') || '').split(/[;；\n]/).map(value => value.trim()).filter(Boolean);
    const keywords = String(form.get('keywords') || '').split(/[;,，；]/).map(value => value.trim()).filter(Boolean);
    const tags = String(form.get('tags') || '').split(/[;,，；]/).map(value => value.trim()).filter(Boolean);
    const metadata = {
      title: String(form.get('title') || '').trim(), authors, publicationYear: String(form.get('year') || ''),
      journal: String(form.get('journal') || ''), doi: String(form.get('doi') || ''), pmid: String(form.get('pmid') || ''),
      originalUrl: String(form.get('originalUrl') || ''), language: String(form.get('language') || ''),
      abstract: String(form.get('abstract') || ''), keywords, tags, notes: String(form.get('notes') || ''),
      collectionIds: form.getAll('collectionIds').map(String),
    };
    try {
      let result: any;
      if (selectedFiles.length) {
        const body = new FormData();
        const titlePrefix = metadata.title;
        const filesForAttempt = selectedFiles.map(selected => ({ ...selected,
          title: selected.title || (selectedFiles.length === 1
            ? (titlePrefix || selected.file.name.replace(/\.[^.]+$/, ''))
            : `${titlePrefix ? titlePrefix + ' · ' : ''}${selected.file.name.replace(/\.[^.]+$/, '')}`) }));
        setSelectedFiles(filesForAttempt);
        const records = filesForAttempt.map(selected => ({ ...metadata, title: selected.title }));
        body.set('records', JSON.stringify(records));
        filesForAttempt.forEach(selected => body.append('files', selected.file, selected.file.name));
        try { result = await api('/api/literature', { method: 'POST', body }); }
        catch (reason: any) {
          if (!Array.isArray(reason?.data?.results)) throw reason;
          result = reason.data;
        }
        const attemptResults: UploadResultRow[] = (result.results || []).map((row: Row) => {
          const selected = filesForAttempt[Number(row.index)];
          return { ...row, clientKey: selected?.key || nextUploadFileKey(), file: selected?.file, title: selected?.title };
        });
        const resultKeys = new Set(attemptResults.map(row => row.clientKey));
        const priorResults = batchResults.filter(row => !resultKeys.has(row.clientKey));
        const mergedResults = [...priorResults, ...attemptResults];
        const failures = mergedResults.filter(row => !row.ok);
        const duplicates = (result.results || []).flatMap((row: Row) => row.duplicates || []);
        setBatchResults(mergedResults);
        setSelectedFiles(failures.map(row => ({ key: row.clientKey, file: row.file, title: row.title })));
        if (result.successCount > 0) {
          setRefresh(value => value + 1);
          const first = (attemptResults.find((row: Row) => row.ok)?.item || mergedResults.find((row: Row) => row.ok)?.item);
          if (first) setSelectedId(first.id);
        }
        if (failures.length) {
          const savedCount = mergedResults.filter(row => row.ok).length;
          setUploadError(`当前批次 ${savedCount} 份已保存，${failures.length} 份未保存。已保存项不会重复上传；请重新选择下方未保存文件后重试。`);
          const fileInput = formElement.querySelector<HTMLInputElement>('input[type="file"]');
          if (fileInput) fileInput.value = '';
          if (result.successCount > 0) notify(`文献已保存 ${result.successCount} 份；${failures.length} 份需要重试`);
          return;
        }
        if (duplicates.length) setNotice('检测到相同 DOI 或文件摘要的文献候选；系统保留了每份文件，请检查后再决定是否归并。');
        if (!result.successCount) {
          setUploadError('本批次文件均未保存。请按下方逐项原因修正后，重新选择失败文件重试。');
          const fileInput = formElement.querySelector<HTMLInputElement>('input[type="file"]');
          if (fileInput) fileInput.value = '';
          return;
        }
        formElement.reset(); setUploadOpen(false); setSelectedFiles([]); setBatchResults([]);
        notify(`文献批次已全部保存，共 ${result.successCount} 份`);
        return;
      } else {
        result = await api('/api/literature', { method: 'POST', body: JSON.stringify(metadata) });
        setSelectedId(result.item.id);
        if (result.duplicates?.length) setNotice('检测到重复 DOI 候选；新书目已单独保存，请检查后再决定是否归并。');
      }
      formElement.reset(); setUploadOpen(false); setSelectedFiles([]); setBatchResults([]); setRefresh(value => value + 1);
      notify('书目已保存');
    } catch (reason: any) { setUploadError(reason.message); }
    finally { uploadInFlight.current = false; setBusy(false); }
  };

  const saveMetadata = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!detail) return;
    const form = new FormData(event.currentTarget);
    const body = {
      expectedRevision: detail.revision, title: form.get('title'), authors: String(form.get('authors') || '').split(/[;；\n]/).map(x => x.trim()).filter(Boolean),
      year: form.get('year'), journal: form.get('journal'), doi: form.get('doi'), pmid: form.get('pmid'), originalUrl: form.get('originalUrl'),
      language: form.get('language'), abstract: form.get('abstract'), keywords: String(form.get('keywords') || '').split(/[;,，；]/).map(x => x.trim()).filter(Boolean),
      tags: String(form.get('tags') || '').split(/[;,，；]/).map(x => x.trim()).filter(Boolean), notes: form.get('notes'),
      collectionIds: form.getAll('collectionIds').map(String),
    };
    const saved = await update(async () => api('/api/literature/' + encodeURIComponent(detail.id), { method: 'PATCH', body: JSON.stringify(body) }), '书目信息已按新修订保存');
    if (saved !== undefined) setMetadataOpen(false);
  };

  const replaceFile = async (file?: File) => {
    if (!file || !detail || !canEdit) return;
    const form = new FormData(); form.set('file', file); form.set('expectedRevision', String(detail.revision)); form.set('changeNote', '页面上传的文献修订版');
    const replaced = await update(async () => api(`/api/literature/${encodeURIComponent(detail.id)}/versions`, { method: 'POST', body: form }), '新全文版本已保存，旧版本仍保留');
    if (replaced) setDetail(replaced.item);
  };

  const indexCurrent = async () => {
    if (!detail || !canEdit) return;
    const result = await update(async () => api(`/api/literature/${encodeURIComponent(detail.id)}/index`, { method: 'POST', body: '{}' }), '文献索引任务已提交');
    if (result) setRefresh(value => value + 1);
  };

  const cancelIndex = async (jobId: string) => {
    await update(async () => api(`/api/literature/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}' }), '文献索引任务已取消');
  };

  const retryIndex = async (jobId: string) => {
    const result = await update(async () => api(`/api/literature/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: '{}' }), '文献索引任务已有限次数重试');
    if (result) setRefresh(value => value + 1);
  };

  const deleteCurrent = async () => {
    if (!detail || !window.confirm('将此文献移入回收站？原文和历史版本保留在备份中，回收站可恢复。')) return;
    const removed = await update(async () => api(`/api/literature/${encodeURIComponent(detail.id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: detail.revision }) }), '文献已移入回收站');
    if (removed) { setSelectedId(''); setDetail(null); }
  };

  const restoreItem = async (itemId: string) => {
    const restored = await update(async () => api(`/api/literature/${encodeURIComponent(itemId)}/restore`, { method: 'POST', body: '{}' }), '文献已恢复到共享列表');
    if (restored) { setTrashMode(false); setSelectedId(itemId); }
  };

  const createCollection = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const created = await update(async () => api('/api/literature/collections', { method: 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description') }) }), '文献集合已创建');
    if (created) setCollectionOpen(false);
  };

  return <div className="literature-page">
    <div className="literature-toolbar panel">
      <div><div className="section-kicker">LITERATURE ARCHIVE</div><h2>组织共享的文献知识库</h2><p>管理书目、全文版本与解析状态。文献和报告分开存放，原文件只会在你明确启用向量化后发送给所配置的 Embedding 服务。</p></div>
      <div className="literature-actions">
        <label className="searchbox"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、作者、DOI、摘要或正文"/></label>

        <button className="button button-quiet" onClick={() => setCollectionOpen(true)}><FolderOpen size={14}/>集合</button>
        <button className="button button-quiet" onClick={openUpload}><BookOpen size={14}/>添加书目</button>
        <button className="button button-primary" onClick={openUpload}><Upload size={14}/>上传文献</button>
      </div>
    </div>

    {searchSummary?.fallbackReason && query.trim() && <div className="literature-search-fallback"><Info size={14}/>{searchSummary.fallbackReason}</div>}
    {searchStatus && <div className="literature-service-strip"><Sparkles size={14}/><span>{searchStatus.workerOnline ? '本地解析/索引 Worker 在线' : '本地解析/索引 Worker 离线'} · {searchStatus.embeddingReady && searchStatus.vectorConfigured ? `${searchStatus.profile?.model || 'Embedding'} 已配置；当前搜索模式：${searchSummary?.mode || '向量检索'}` : 'Embedding 或 Qdrant 尚未完整配置，向量检索不可用'}</span></div>}

    <div className="literature-stats">
      <div className="literature-stat"><span>共享文献</span><b>{stats.total}</b><small>有效书目</small></div>
      <div className="literature-stat"><span>可检索全文</span><b>{stats.searchable}</b><small>当前已发布索引</small></div>
      <div className="literature-stat"><span>处理中</span><b>{stats.processing}</b><small>持久任务队列</small></div>
      <div className="literature-stat"><span>需要处理</span><b>{stats.failed}</b><small>失败任务</small></div>
    </div>

    {notice && <div className="literature-notice"><ShieldCheck size={15}/>{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14}/></button></div>}
    {error && <div className="literature-error"><AlertTriangle size={15}/>{error}</div>}
    <div className="literature-layout">
      <section className="literature-list panel">
        <div className="literature-list-head"><div><div className="section-kicker">COLLECTIONS</div><h3>{trashMode ? '回收站' : '文献目录'}</h3></div><span className="literature-count">{visibleRows.length}</span></div>
        <div className="literature-filters">
          {!trashMode && <select value={collectionId} onChange={event => setCollectionId(event.target.value)} aria-label="筛选文献集合">
            <option value="">全部集合</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name} · {collection.item_count}</option>)}
          </select>}
          <button className={trashMode ? 'selected' : ''} onClick={() => { setTrashMode(value => !value); setSelectedId(''); }}><Trash2 size={13}/>{trashMode ? '返回文献目录' : '回收站'}</button>
        </div>
        <div className="literature-list-scroll">
          {visibleRows.map(row => <button key={row.id} className={`literature-row ${selectedId === row.id ? 'selected' : ''}`} onClick={() => setSelectedId(row.id)}>
            <span className="literature-row-icon"><FileText size={16}/></span><span className="literature-row-main"><b>{row.title}</b><small>{(row.authors || []).slice(0, 3).join(', ') || row.creator_name || '作者待整理'}{row.publication_year ? ` · ${row.publication_year}` : ''}</small>
              <small className="literature-row-meta">{row.doi || row.current_file_name || '仅书目'} · {trashMode ? `删除于 ${fmtDate(row.deleted_at)}` : row.current_version_id ? (parseLabel[row.parse_status] || jobLabel[row.index_status] || '待解析') : '仅书目'}</small></span>
            {row.can_edit ? <span className="literature-owner-mark" title="你可以维护"><ShieldCheck size={13}/></span> : null}
          </button>)}
          {!visibleRows.length && <div className="literature-empty"><BookOpen size={22}/><b>{trashMode ? '回收站为空' : '还没有文献'}</b><span>{trashMode ? '已删除的文献会显示在这里。' : '上传全文或先建立书目，文献会按文件版本留痕。'}</span>{!trashMode && <button className="button button-primary" onClick={() => setUploadOpen(true)}><Plus size={13}/>添加第一篇文献</button>}</div>}
        </div>
      </section>

      {trashMode ? <section className="literature-detail panel">
        {selectedRow ? <><div className="literature-detail-head"><div><div className="section-kicker">RECYCLE BIN</div><h2>{selectedRow.title}</h2><p>{selectedRow.authors?.join(', ') || '作者待整理'} · 删除于 {fmtDate(selectedRow.deleted_at)}</p></div>
          {selectedRow.can_edit && <button className="button button-primary" disabled={busy} onClick={() => restoreItem(selectedRow.id)}><RotateCcw size={14}/>恢复文献</button>}</div>
          <div className="literature-archive-note"><ShieldCheck size={15}/>恢复后书目和原文件版本会回到共享列表；索引状态会重新核验。</div></> : <EmptyDetail text="选择一篇已删除文献查看恢复入口。"/>}
      </section> : <section className="literature-detail panel">
        {detail ? <>
          <div className="literature-detail-head"><div><div className="section-kicker">LITERATURE / REVISION {detail.revision}</div><h2>{detail.title}</h2><p>{detail.authors.join(', ') || '作者待整理'}{detail.publication_year ? ` · ${detail.publication_year}` : ''}{detail.journal ? ` · ${detail.journal}` : ''}</p></div>
            <div className="literature-detail-actions">{canEdit && <><button className="button button-quiet" onClick={() => setMetadataOpen(true)}><Save size={13}/>编辑书目</button><button className="button button-danger" onClick={deleteCurrent}><Trash2 size={13}/>删除</button></>}</div>
          </div>
          <div className="literature-meta-grid">
            <MetaCard label="DOI / PMID" value={detail.doi || detail.pmid || '未填写'}/><MetaCard label="语言" value={detail.language || '待整理'}/>
            <MetaCard label="上传者" value={detail.creator_name}/><MetaCard label="最近更新" value={fmtDate(detail.updated_at)}/>
          </div>
          {detail.abstract && <section className="literature-section"><SectionHeading title="摘要" badge={detail.currentVersion ? '书目信息' : '用户录入'}/><p className="literature-abstract">{detail.abstract}</p></section>}
          <section className="literature-section">
            <SectionHeading title="全文与版本" badge={`${detail.versions.length} 个版本`}/>
            {canEdit && <label className="literature-replace"><span>页面通过替换文件更新正文，历史版本会保留</span><input type="file" disabled={busy} onChange={event => { void replaceFile(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label>}
            <div className="literature-version-list">{detail.versions.map((version: Row) => <div className={`literature-version ${version.id === detail.current_version_id ? 'current' : ''}`} key={version.id}>
              <div className="literature-file-icon"><FileText size={15}/></div><div className="literature-file-info"><b>{version.original_name}</b><small>V{version.version_no} · {version.extension.toUpperCase().replace('.', '')} · {fmtSize(version.size_bytes)} · {fmtDate(version.created_at)}{version.id === detail.current_version_id ? ' · 当前版本' : ''}</small>{version.change_note && <small>{version.change_note}</small>}</div>
              <a className="button button-quiet" href={`/api/literature/${encodeURIComponent(detail.id)}/versions/${encodeURIComponent(version.id)}/download`}><Download size={13}/>下载</a>
            </div>)}
              {!detail.versions.length && <div className="literature-inline-empty">当前仅有书目信息，可随时补充全文。</div>}
            </div>
          </section>
          <section className="literature-section">
            <div className="literature-section-heading"><h3>解析与索引</h3><div className="literature-index-actions"><span>{detail.extraction ? (parseLabel[detail.extraction.status] || detail.extraction.status) : detail.currentVersion ? '等待解析' : '仅书目'}</span>{canEdit && <button className="button button-primary button-small" disabled={busy || !detail.chunks?.length} onClick={indexCurrent}><Sparkles size={12}/>{detail.indexes?.[0]?.status === 'ready' ? '重建向量索引' : '建立向量索引'}</button>}{onAskAssistant && <button className="button button-quiet button-small" onClick={() => onAskAssistant(detail.id)}><Bot size={12}/>向助手提问</button>}</div></div>
            {!detail.currentVersion ? <div className="literature-inline-empty">还没有上传全文。页面支持 PDF、DOCX、TXT 和 Markdown；扫描 PDF 会标为待 OCR，不会假称完成识别。</div> : <>
              <div className="literature-parse-grid"><MetaCard label="解析器" value={detail.extraction?.parser_version || '等待本地解析'}/><MetaCard label="提取字符" value={detail.extraction?.text_length?.toLocaleString?.() || '—'}/><MetaCard label="页数 / 覆盖" value={detail.extraction ? `${detail.extraction.pages_read}/${detail.extraction.page_count}` : '—'}/><MetaCard label="索引状态" value={detail.indexes[0]?.status || '未建立'}/></div>
              {Array.isArray(detail.extraction?.coverage?.pagesWithoutText) && detail.extraction.coverage.pagesWithoutText.length > 0 && <div className="literature-search-fallback"><Info size={14}/><span>部分页面没有可提取文本层：第 {detail.extraction.coverage.pagesWithoutText.join('、')} 页。可能是空白页或扫描页；正文与助手引用都不覆盖这些页。</span></div>}
              {detail.extraction?.coverage && <details className="literature-coverage"><summary>查看解析覆盖与限制</summary><pre>{JSON.stringify(detail.extraction.coverage, null, 2)}</pre></details>}
              {detail.chunks?.length > 0 && <div className="literature-chunk-list">{detail.chunks.slice(0, 12).map((chunk: Row) => <article key={chunk.id} className="literature-chunk"><div><span>{chunk.section_title || chunk.source_extent}</span><small>{chunk.locator.page ? `第 ${chunk.locator.page} 页` : chunk.locator.paragraph ? `段落 ${chunk.locator.paragraph}` : chunk.source_extent}</small></div><p>{chunk.content_text}</p></article>)}</div>}
            </>}
          </section>
          <section className="literature-section"><SectionHeading title="分类与整理" badge={`${detail.tags.length} 个标签`}/><div className="literature-chip-row">{detail.collections.map((collection: Row) => <span className="literature-chip" key={collection.id}><FolderOpen size={12}/>{collection.name}</span>)}{detail.tags.map((tag: Row) => <span className="literature-chip" key={tag.id}><Tag size={12}/>{tag.name}</span>)}{!detail.tags.length && !detail.collections.length && <small>尚未添加集合或标签</small>}</div>{detail.notes && <p className="literature-notes">{detail.notes}</p>}</section>
          <section className="literature-section"><SectionHeading title="处理任务" badge={`${detail.jobs.length} 条`}/>{detail.jobs.length ? <div className="literature-job-list">{detail.jobs.map((job: Row) => <div className="literature-job" key={job.id}><span className={`literature-status status-${job.status}`}>{jobLabel[job.status] || job.status}</span><span>{job.progress.message || job.error_message || '等待任务执行'}</span><small>{job.job_type === 'index' ? `请求 ${job.usage_request_count || 0}/${job.budget_requests} · token ${job.usage_tokens || 0}/${job.budget_tokens} · 用量 ${job.usage_status}${job.usage_pending_count ? ' · 有待结算请求' : ''}` : `尝试 ${job.attempt_count}/${job.max_attempts}`}</small>{canEdit && job.job_type === 'index' && ['queued','waiting_configuration','embedding','publishing'].includes(job.status) && <button className="row-action" onClick={() => cancelIndex(job.id)}>取消</button>}{canEdit && job.job_type === 'index' && ['failed','partial'].includes(job.status) && <button className="row-action" onClick={() => retryIndex(job.id)}>重试</button>}</div>)}</div> : <div className="literature-inline-empty">文献上传后先提取文字，再进行向量化。</div>}</section>
          <div className="literature-access-note"><ShieldCheck size={14}/>{canEdit ? '你是此文献的上传者或管理员，可以编辑书目信息、替换全文、移入回收站。' : '组织成员可查看和下载；只有上传者或管理员可以编辑。'}</div>
        </> : <EmptyDetail text="选择一篇文献查看书目、全文版本和处理状态。"/>}
      </section>}
    </div>

    {uploadOpen && <Modal title={selectedFiles.length ? '上传文献' : '添加书目'} onClose={() => { if (!busy) { setUploadOpen(false); setSelectedFiles([]); setBatchResults([]); setUploadError(''); } }}>
      <form className="literature-form" onSubmit={uploadLiterature}>
        <p className="literature-form-help">可选择任意文件；PDF、DOCX、XLSX、CSV、TSV、TXT 和 Markdown 可提取文本，其他格式保留原文件。扫描件中的文字需要 OCR。</p>
        <label className="literature-file-picker"><Upload size={16}/><span>{selectedFiles.length ? `已选 ${selectedFiles.length} 份` : '选择一份或多份文献'}</span><input type="file" multiple onChange={chooseUploadFiles}/></label>
        {selectedFiles.length > 0 && <div className="literature-selected-files">{selectedFiles.map(selected => <div key={selected.key}><FileText size={13}/><span>{selected.file.name}</span><small>{fmtSize(selected.file.size)}</small></div>)}</div>}
        <div className="literature-form-grid"><label className="field-wide">标题或批次标题<input name="title" placeholder={selectedFiles.length > 1 ? '批次前缀；每篇会追加各自文件名' : '文献标题'}/></label>
          <label>作者（用分号分隔）<input name="authors" placeholder="作者 A; 作者 B"/></label><label>发表年份<input name="year" type="number" min="1000" max="3000" placeholder="2026"/></label>
          <label>期刊 / 会议<input name="journal" placeholder="来源名称"/></label><label>语言<input name="language" placeholder="中文 / English"/></label>
          <label>DOI<input name="doi" placeholder="10.xxxx/xxxxx"/></label><label>PMID<input name="pmid" placeholder="可选"/></label>
          <label className="field-wide">原始链接<input name="originalUrl" type="url" placeholder="https://…"/></label>
          <label className="field-wide">摘要<textarea name="abstract" rows={3} placeholder="摘要内容；可先保存书目，稍后补全文。"/></label>
          <label>关键词<input name="keywords" placeholder="蛋白定量, 质控"/></label><label>分类标签<input name="tags" placeholder="方法学, ELISA"/></label>
          <label className="field-wide">整理备注<textarea name="notes" rows={2} placeholder="内部整理备注"/></label>
          {collections.length > 0 && <fieldset className="field-wide"><legend>加入集合</legend><div className="literature-collection-options">{collections.map(collection => <label key={collection.id}><input type="checkbox" name="collectionIds" value={collection.id}/>{collection.name}</label>)}</div></fieldset>}
        </div>
        {uploadError && <div className="literature-error">{uploadError}</div>}
        {batchResults.length > 0 && <div className="literature-batch-results" aria-live="polite"><b>逐份处理结果</b>{batchResults.map((row: UploadResultRow) => <div key={row.clientKey} className={row.ok ? 'saved' : 'failed'}><span>{row.ok ? '已保存' : '未保存'}</span><strong>{row.fileName}</strong><small>{row.ok ? `文献编号 ${row.item?.id}` : row.error}</small></div>)}</div>}
        <div className="literature-modal-actions"><button type="button" className="button button-quiet" onClick={() => setUploadOpen(false)} disabled={busy}>取消</button><button type="submit" className="button button-primary" disabled={busy || uploadInFlight.current}>{busy ? '保存中…' : selectedFiles.length ? retryingFailedFiles ? `重试未保存项（${selectedFiles.length}份）` : '保存文献批次' : '保存书目'}</button></div>
      </form>
    </Modal>}

    {metadataOpen && detail && <Modal title="编辑书目信息" onClose={() => setMetadataOpen(false)}>
      <form className="literature-form" onSubmit={saveMetadata}><p className="literature-form-help">当前修订 {detail.revision}。保存时服务端会检查修订号；如果其他成员已更新，请刷新页面后再提交。</p>
        <div className="literature-form-grid"><label className="field-wide">标题<input name="title" defaultValue={detail.title} required/></label>
          <label>作者（用分号分隔）<input name="authors" defaultValue={detail.authors.join('; ')} /></label><label>发表年份<input name="year" type="number" min="1000" max="3000" defaultValue={detail.publication_year || ''}/></label>
          <label>期刊 / 会议<input name="journal" defaultValue={detail.journal}/></label><label>语言<input name="language" defaultValue={detail.language}/></label>
          <label>DOI<input name="doi" defaultValue={detail.doi}/></label><label>PMID<input name="pmid" defaultValue={detail.pmid}/></label>
          <label className="field-wide">原始链接<input name="originalUrl" type="url" defaultValue={detail.original_url}/></label>
          <label className="field-wide">摘要<textarea name="abstract" rows={4} defaultValue={detail.abstract}/></label>
          <label>关键词<input name="keywords" defaultValue={detail.keywords.join(', ')}/></label><label>分类标签<input name="tags" defaultValue={detail.tags.map((tag: Row) => tag.name).join(', ')}/></label>
          <label className="field-wide">整理备注<textarea name="notes" rows={3} defaultValue={detail.notes}/></label>
          <fieldset className="field-wide"><legend>集合</legend><div className="literature-collection-options">{collections.map(collection => <label key={collection.id}><input type="checkbox" name="collectionIds" value={collection.id} defaultChecked={detail.collections.some((x: Row) => x.id === collection.id)}/>{collection.name}</label>)}</div></fieldset>
        </div>
        <div className="literature-modal-actions"><button type="button" className="button button-quiet" onClick={() => setMetadataOpen(false)}>取消</button><button type="submit" className="button button-primary" disabled={busy}><Save size={13}/>保存书目修订</button></div>
      </form>
    </Modal>}

    {collectionOpen && <Modal title="新建文献集合" onClose={() => setCollectionOpen(false)}><form className="literature-form" onSubmit={createCollection}><p className="literature-form-help">集合用于整理共享文献；归档集合不会删除文献正文。</p><div className="literature-form-grid"><label className="field-wide">集合名称<input name="name" required maxLength={120} placeholder="例如：蛋白定量方法"/></label><label className="field-wide">说明<textarea name="description" rows={3} placeholder="可选说明"/></label></div><div className="literature-modal-actions"><button type="button" className="button button-quiet" onClick={() => setCollectionOpen(false)}>取消</button><button type="submit" className="button button-primary" disabled={busy}><Plus size={13}/>创建集合</button></div></form></Modal>}
  </div>;
}

function MetaCard({ label, value }: { label: string; value: any }) { return <div className="literature-meta-card"><small>{label}</small><b>{value || '—'}</b></div>; }
function SectionHeading({ title, badge }: { title: string; badge: string }) { return <div className="literature-section-heading"><h3>{title}</h3><span>{badge}</span></div>; }
function EmptyDetail({ text }: { text: string }) { return <div className="literature-detail-empty"><BookOpen size={28}/><b>文献信息面板</b><span>{text}</span></div>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card literature-modal"><div className="modal-head"><div><div className="section-kicker">LITERATURE LIBRARY</div><h2>{title}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16}/></button></div>{children}</section></div>; }
