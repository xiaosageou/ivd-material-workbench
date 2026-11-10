import React, { useState } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import './styles.css';

type Option = { value: string; label: string };
type Props = { initial?: any; onClose: () => void; onSubmit: (value: any) => Promise<void>; showName: boolean };
const CALC_TYPES: Option[] = [
  { value: 'ratio', label: '比例缩放' }, { value: 'mass_concentration', label: '质量浓度' },
  { value: 'molar_concentration', label: '摩尔浓度' }, { value: 'stock_dilution', label: '母液稀释 C₁V₁=C₂V₂' },
  { value: 'volume_fraction', label: '体积分数' }, { value: 'fixed_addition', label: '固定添加量' },
];
const MASS_CONCENTRATION_UNITS = ['µg/mL', 'mg/mL', 'mg/L', 'g/L', 'g/mL'];
const MOLAR_CONCENTRATION_UNITS = ['µmol/L', 'mmol/L', 'mol/L'];
const STOCK_CONCENTRATION_UNITS = [...MASS_CONCENTRATION_UNITS, ...MOLAR_CONCENTRATION_UNITS];
const rowsFrom = (initial: any) => initial?.ingredients?.map((item: any) => ({
  materialId: item.material_id || '', calculationType: item.calculation_type, amountValue: item.amount_value,
  amountUnit: item.amount_unit, stockConcentration: item.stock_concentration, targetConcentration: item.target_concentration,
  molecularWeight: item.molecular_weight, dimension: item.dimension, notes: item.notes,
})) || [{ materialId: '', calculationType: 'ratio', amountValue: '', amountUnit: '', stockConcentration: '',
  targetConcentration: '', molecularWeight: '', dimension: '', notes: '' }];

async function api(path: string) {
  const response = await fetch(path, { credentials: 'include' });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || '读取数据失败');
  return data;
}
function useData(path: string) {
  const [state, setState] = useState<any>(null);
  React.useEffect(() => { let active = true; api(path).then(value => { if (active) setState(value); }).catch(() => { if (active) setState(null); }); return () => { active = false; }; }, [path]);
  return state;
}

export default function RecipeEditorForm({ initial, onClose, onSubmit, showName }: Props) {
  const materialList = useData('/api/materials') || [];
  const unitCatalog = useData('/api/settings/summary')?.units || {};
  const [rows, setRows] = useState<any[]>(() => rowsFrom(initial));
  const [steps, setSteps] = useState<string[]>(() => initial?.steps_json ? JSON.parse(initial.steps_json) : ['']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recipeName, setRecipeName] = useState(String(initial?.recipe_name || ''));
  const [outputName, setOutputName] = useState(String(initial?.output_name || initial?.recipe_name || ''));
  const [outputNameTouched, setOutputNameTouched] = useState(Boolean(initial?.output_name && initial?.recipe_name && initial.output_name !== initial.recipe_name));

  const dimensionUnits = (dimension: string, baseUnit?: string) => {
    const configured = Array.isArray(unitCatalog[dimension]) ? unitCatalog[dimension] : [];
    return [...new Set([...(baseUnit ? [baseUnit] : []), ...configured])];
  };
  const materialFor = (row: any) => materialList.find((item: any) => item.id === row.materialId);
  const supportedTypes = (dimension: string) => CALC_TYPES.filter(item => dimension === 'mass'
    ? ['ratio', 'mass_concentration', 'molar_concentration', 'fixed_addition'].includes(item.value)
    : dimension === 'volume' ? ['ratio', 'stock_dilution', 'volume_fraction', 'fixed_addition'].includes(item.value)
      : ['ratio', 'fixed_addition'].includes(item.value));
  const defaultUnit = (type: string, material: any) => type === 'mass_concentration' ? 'g/L'
    : type === 'molar_concentration' ? 'mol/L' : type === 'stock_dilution' ? 'mg/mL'
      : type === 'volume_fraction' ? '%' : material?.base_unit || '';
  const parameterUnits = (row: any, material: any) => row.calculationType === 'mass_concentration' ? MASS_CONCENTRATION_UNITS
    : row.calculationType === 'molar_concentration' ? MOLAR_CONCENTRATION_UNITS
      : row.calculationType === 'stock_dilution' ? STOCK_CONCENTRATION_UNITS
        : row.calculationType === 'volume_fraction' ? ['%'] : dimensionUnits(material?.dimension || row.dimension, material?.base_unit);
  const update = (index: number, key: string, value: string) => setRows(current => current.map((row, rowIndex) => {
    if (rowIndex !== index) return row;
    const next = { ...row, [key]: value };
    if (key === 'materialId') {
      const material = materialList.find((item: any) => item.id === value);
      next.dimension = material?.dimension || '';
      const valid = supportedTypes(next.dimension);
      if (!valid.some(item => item.value === next.calculationType)) next.calculationType = valid[0]?.value || 'ratio';
      next.amountUnit = defaultUnit(next.calculationType, material);
    }
    if (key === 'calculationType') next.amountUnit = defaultUnit(value, materialFor(row));
    return next;
  }));

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const value: any = Object.fromEntries(form.entries());
    value.name = recipeName;
    value.outputName = outputName || recipeName;
    value.ingredients = rows.map(row => {
      const material = materialFor(row);
      return { ...row, name: material?.name || '', dimension: material?.dimension || row.dimension };
    });
    value.steps = steps.map(step => step.trim()).filter(Boolean);
    try { await onSubmit(value); } catch (reason: any) { setError(reason.message || '保存失败'); }
    finally { setBusy(false); }
  };

  const outputDimension = String(initial?.output_dimension || 'volume');
  const outputUnits = dimensionUnits(outputDimension, initial?.output_unit || (outputDimension === 'volume' ? 'mL' : undefined));
  const addRow = () => setRows(current => [...current, { materialId: '', calculationType: 'ratio', amountValue: '', amountUnit: '',
    stockConcentration: '', targetConcentration: '', molecularWeight: '', dimension: '', notes: '' }]);

  return <div className="modal-scrim" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal-card modal-wide" role="dialog" aria-modal="true" aria-labelledby="recipe-editor-title">
      <div className="modal-head"><div><div className="section-kicker">FORMULATION VERSION</div><h2 id="recipe-editor-title">{showName ? '新建配方' : '复制为新版本'}</h2><p>已发布版本保持不变；修改将保存为一个新的草稿版本。</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></div>
      <form className="dialog-form recipe-editor-form" onSubmit={save}>
        <div className="editor-section-title"><span>01</span><b>版本与产物</b></div>
        <div className="field-grid">
          {showName ? <label>配方名称<input name="name" required value={recipeName} onChange={event => { const next = event.target.value; setRecipeName(next); if (!outputNameTouched) setOutputName(next); }} placeholder="例：洗涤液工作液"/></label> : <input type="hidden" name="name" value={recipeName}/>}
          <label>基准产量<input name="baseVolume" type="number" min="0" step="0.000001" required defaultValue={initial?.base_volume || '100'}/></label>
          <label>产量单位<select name="baseVolumeUnit" required defaultValue={initial?.base_volume_unit || 'mL'}>{dimensionUnits('volume', 'mL').map((unit: string) => <option key={unit}>{unit}</option>)}</select></label>
          <label>产物名称<input name="outputName" required value={outputName} onChange={event => { setOutputName(event.target.value); setOutputNameTouched(true); }} placeholder={recipeName || '默认使用配方名称'}/></label>
          <label>产物库存单位<select name="outputUnit" required defaultValue={initial?.output_unit || 'mL'}>{outputUnits.map((unit: string) => <option key={unit}>{unit}</option>)}</select><input type="hidden" name="outputDimension" value={outputDimension}/></label>
          <label>目标 pH（可选）<input name="targetPH" type="number" min="0" max="14" step="0.01" defaultValue={initial?.target_ph || ''} placeholder="例如 7.2"/></label>
        </div>
        <div className="editor-section-title editor-title-gap"><span>02</span><b>组分参数</b><button type="button" className="text-link" onClick={addRow}><Plus size={14}/> 添加组分</button></div>
        <div className="ingredient-editor-list">{rows.map((row, index) => {
          const material = materialFor(row); const types = supportedTypes(material?.dimension || row.dimension); const units = parameterUnits(row, material);
          return <div className="ingredient-edit-row" key={index}>
            <div className="ingredient-edit-top"><span>组分 {String(index + 1).padStart(2, '0')}</span>{rows.length > 1 && <button type="button" className="remove-link" onClick={() => setRows(current => current.filter((_, rowIndex) => rowIndex !== index))}>移除</button>}</div>
            <div className="field-grid">
              <label>关联物料<select required value={row.materialId} onChange={event => update(index, 'materialId', event.target.value)}><option value="">选择库存物料</option>{materialList.map((item: any) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
              <label>计算方式<select required value={row.calculationType} onChange={event => update(index, 'calculationType', event.target.value)}>{types.map((item: Option) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              {row.calculationType !== 'stock_dilution' && <label>{['mass_concentration', 'molar_concentration'].includes(row.calculationType) ? '目标浓度' : '组分用量'}<input type="number" min="0" step="0.000001" value={row.amountValue} onChange={event => update(index, 'amountValue', event.target.value)} required/></label>}
              <label>{row.calculationType === 'stock_dilution' ? '浓度单位（C₁/C₂）' : '参数单位'}<select required value={row.amountUnit} onChange={event => update(index, 'amountUnit', event.target.value)}>{units.map((unit: string) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
              {row.calculationType === 'stock_dilution' && <><label>母液浓度 C₁<input type="number" min="0" step="0.000001" value={row.stockConcentration} onChange={event => update(index, 'stockConcentration', event.target.value)} required/></label><label>目标浓度 C₂<input type="number" min="0" step="0.000001" value={row.targetConcentration} onChange={event => update(index, 'targetConcentration', event.target.value)} required/></label></>}
              {row.calculationType === 'molar_concentration' && <label>分子量（g/mol）<input type="number" min="0" step="0.000001" value={row.molecularWeight} onChange={event => update(index, 'molecularWeight', event.target.value)} required/></label>}
              <div className="field-full quiet-count">{material ? `使用关联物料“${material.name}”的档案单位 ${material.base_unit} 记账。` : '请选择库存物料；名称和量纲会从物料档案读取。'}</div>
            </div>
          </div>;
        })}</div>
        <div className="editor-section-title editor-title-gap"><span>03</span><b>操作步骤</b><button type="button" className="text-link" onClick={() => setSteps(current => [...current, ''])}><Plus size={14}/> 添加步骤</button></div>
        <div className="steps-editor">{steps.map((step, index) => <div key={index}><span>{String(index + 1).padStart(2, '0')}</span><input value={step} onChange={event => setSteps(current => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="记录可执行的配制步骤"/>{steps.length > 1 && <button type="button" className="icon-button" onClick={() => setSteps(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={15}/></button>}</div>)}</div>
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy}>{busy ? '保存中…' : '保存为草稿'}<ChevronRight size={15}/></button></div>
      </form>
    </section>
  </div>;
}
