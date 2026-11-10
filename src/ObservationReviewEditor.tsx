import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Pencil, ShieldCheck } from 'lucide-react';
import './research-ai-review.css';

type Observation = {
  id: string;
  reviewVersion: number;
  value: any;
  originalValue: any;
  historical?: boolean;
  review?: { state?: string; correctedValue?: any; comment?: string };
};

type Props = { item: Observation; canReview: boolean; onSaved: () => void; compact?: boolean };

const reviewLabel: Record<string, string> = {
  machine_unconfirmed: '机器整理 · 未确认', human_confirmed: '人工确认', corrected: '人工修正', conflict: '存在冲突', stale: '来源过时',
};

function initialState(item: Observation) {
  return ['human_confirmed', 'corrected', 'conflict', 'stale'].includes(String(item.review?.state || ''))
    ? String(item.review?.state) : 'human_confirmed';
}

function editBase(item: Observation) {
  return item.review?.correctedValue ?? item.originalValue ?? item.value;
}

export default function ObservationReviewEditor({ item, canReview, onSaved, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [reviewState, setReviewState] = useState(initialState(item));
  const [comment, setComment] = useState(item.review?.comment || '');
  const [resultValue, setResultValue] = useState('');
  const [unit, setUnit] = useState('');
  const [textValue, setTextValue] = useState('');
  const [jsonValue, setJsonValue] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [versionConflict, setVersionConflict] = useState('');

  useEffect(() => {
    const base = editBase(item);
    setReviewState(initialState(item));
    setComment(item.review?.comment || '');
    setResultValue(base && typeof base === 'object' && 'value' in base ? String(base.value ?? '') : '');
    setUnit(base && typeof base === 'object' && 'unit' in base ? String(base.unit ?? '') : '');
    setTextValue(base && typeof base === 'object' && 'text' in base ? String(base.text ?? '') : '');
    setJsonValue(JSON.stringify(base, null, 2));
    setError('');
  }, [item.id, item.reviewVersion]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    let correctedValue: any;
    if (reviewState === 'corrected') {
      try {
        if (advanced) correctedValue = JSON.parse(jsonValue);
        else {
          const base = editBase(item);
          if (base && typeof base === 'object' && !Array.isArray(base) && 'value' in base) {
            correctedValue = { ...base, value: typeof base.value === 'number' ? Number(resultValue) : resultValue.trim() };
            if (unit.trim()) correctedValue.unit = unit.trim();
            else delete correctedValue.unit;
            if (typeof correctedValue.value === 'number' && !Number.isFinite(correctedValue.value)) throw new Error('修正值必须是有限数字。');
          } else if (base && typeof base === 'object' && !Array.isArray(base) && 'text' in base) {
            correctedValue = { ...base, text: textValue.trim() };
          } else {
            correctedValue = JSON.parse(jsonValue);
          }
        }
      } catch (reason: any) { setError(reason?.message || '修正值格式不正确，请检查输入。'); setBusy(false); return; }
      if (correctedValue === null || correctedValue === undefined) { setError('请填写修正值。'); setBusy(false); return; }
    }
    if (['conflict', 'stale'].includes(reviewState) && !comment.trim()) { setError('请简要填写冲突或来源过时的原因。'); setBusy(false); return; }
    try {
      const response = await fetch('/api/ai/observations/' + encodeURIComponent(item.id) + '/review', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewState, correctedValue, comment, expectedVersion: item.reviewVersion }),
      });
      const type = response.headers.get('content-type') || '';
      const data = type.includes('json') ? await response.json() : { error: await response.text() };
      if (!response.ok) {
        setError(data?.error || `保存失败 (${response.status})`);
        if (response.status === 409) { setVersionConflict('记录版本已变化，页面正在刷新最新值；请核对后重新提交。'); onSaved(); }
        return;
      }
      setSaved(true); setVersionConflict(''); setOpen(false); onSaved();
    } catch (reason: any) { setError(reason?.message || '保存失败，请重试。'); }
    finally { setBusy(false); }
  };

  if (!canReview) return <span className="review-readonly-note"><ShieldCheck size={13}/>只读查看</span>;
  const base = editBase(item);
  const hasSimpleValue = Boolean(base && typeof base === 'object' && !Array.isArray(base) && 'value' in base);
  const hasSimpleText = Boolean(base && typeof base === 'object' && !Array.isArray(base) && 'text' in base);

  return <div className={'observation-review-editor' + (compact ? ' compact' : '')}>
    {!open && <button className="button button-quiet button-small review-open-button" onClick={() => { setError(''); setOpen(true); }}>
      <Pencil size={13}/>{item.review ? '查看 / 更新复核' : '确认或修正'}<ChevronDown size={13}/>
    </button>}
    {saved && !open && <span className="review-saved-note"><Check size={13}/>复核已保存</span>}
    {open && <form className="observation-review-form" onSubmit={submit}>
      <div className="review-form-heading"><b>人工复核</b><span>保存时会校验记录版本，其他人刚更新过时会提示刷新。</span></div>
      {item.review?.state === 'corrected' && <div className="review-current-correction"><b>当前采用的人工值</b><code>{JSON.stringify(item.value)}</code><small>原始整理值：{JSON.stringify(item.originalValue)}</small></div>}
      {item.review?.state === 'conflict' && <div className="knowledge-conflict"><b>此条记录存在版本冲突</b><span>最新模型值：{JSON.stringify(item.originalValue)}；留存的人工值：{JSON.stringify(item.review.correctedValue ?? '无')}。</span></div>}
      {versionConflict && <div className="form-error">{versionConflict}</div>}
      {item.historical && <div className="form-hint">这是历史分析，只读展示。请在当前报告版本的分析结果中复核。</div>}
      <label>处理方式<select aria-label="复核方式" value={reviewState} onChange={event => setReviewState(event.target.value)}>
        <option value="human_confirmed">确认当前模型值</option><option value="corrected">人工修正</option><option value="conflict">标记存在冲突</option><option value="stale">标记来源过时</option>
      </select></label>
      {reviewState === 'corrected' && <>
        {hasSimpleValue && !advanced ? <div className="review-value-grid">
          <label>修正结果值<input aria-label="修正值" value={resultValue} onChange={event => setResultValue(event.target.value)} required/></label>
          <label>单位<input aria-label="修正单位" value={unit} onChange={event => setUnit(event.target.value)} placeholder="如 mg/mL"/></label>
        </div> : hasSimpleText && !advanced ? <label>修正说明<textarea aria-label="修正文本" value={textValue} onChange={event => setTextValue(event.target.value)} rows={3} required/></label>
          : <label>修正内容（JSON）<textarea aria-label="修正内容 JSON" value={jsonValue} onChange={event => setJsonValue(event.target.value)} rows={5} required/></label>}
        <label className="review-advanced-toggle"><input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)}/><span>高级 JSON 编辑</span></label>
        {advanced && <label>修正内容（JSON）<textarea aria-label="修正内容 JSON" value={jsonValue} onChange={event => setJsonValue(event.target.value)} rows={6} required/></label>}
      </>}
      <label>复核说明{['conflict','stale'].includes(reviewState) && <span className="required-mark">（必填）</span>}
        <textarea aria-label="复核说明" value={comment} onChange={event => setComment(event.target.value)} rows={2} maxLength={2000} placeholder="记录核对依据或仍需解决的问题" required={['conflict','stale'].includes(reviewState)}/></label>
      {reviewState === 'human_confirmed' && item.review?.state === 'corrected' && <div className="form-hint">确认当前模型值会结束这条人工修正，并采用原始整理值。</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="review-form-actions"><span>当前复核版本 V{item.reviewVersion}</span><div><button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <button className="button button-primary button-small" disabled={busy || item.historical}><Check size={13}/>{busy ? '保存中…' : '提交复核'}</button></div></div>
    </form>}
  </div>;
}
