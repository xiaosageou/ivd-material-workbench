import { db, id } from './db.ts';
import { createHash } from 'node:crypto';
import { decimal, fmt, positive } from './decimal.ts';
import { calculateIngredient, calculateRecipe, type Ingredient } from './calculator.ts';
import { concentrationFamily, convertQuantity, isUnit, type Dimension } from './units.ts';

type Row = Record<string, any>;
const required = (value: unknown, label: string) => {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label}为必填项`);
  return text;
};
const optional = (value: unknown) => String(value ?? '').trim();
const enumValue = (value: unknown, values: string[], label: string) => {
  const text = String(value ?? '');
  if (!values.includes(text)) throw new Error(`${label}取值无效`);
  return text;
};

export function saveRecipeVersion(recipeId: string, b: Row, actorId: string, version: number) {
  const versionId = id('rv_');
  const baseVolume = positive(b.baseVolume, '基准产量');
  const baseVolumeUnit = required(b.baseVolumeUnit || 'mL', '基准产量单位');
  if (!isUnit(baseVolumeUnit, 'volume')) throw new Error(`基准产量单位“${baseVolumeUnit}”未配置或不是体积单位`);
  const outputDimension = enumValue(b.outputDimension || 'volume', ['mass','volume','amount','activity','count'], '产物量纲') as Dimension;
  const outputUnit = required(b.outputUnit, '产物库存单位');
  if (!isUnit(outputUnit, outputDimension)) throw new Error(`产物单位“${outputUnit}”未配置或与产物量纲不匹配`);
  const recipeName = String((db.prepare('SELECT name FROM recipes WHERE id=?').get(recipeId) as Row | undefined)?.name || '');
  const outputName = optional(b.outputName) || recipeName;
  if (!outputName) throw new Error('产物名称为必填项');
  const priorOutputCode = String((db.prepare('SELECT output_code FROM recipe_versions WHERE recipe_id=? ORDER BY version DESC LIMIT 1').get(recipeId) as Row | undefined)?.output_code || '');
  const outputCode = optional(b.outputCode) || priorOutputCode || `PRD-${createHash('sha256').update(recipeId).digest('hex').slice(0, 12).toUpperCase()}`;
  const targetPhRaw = optional(b.targetPH ?? b.targetPh);
  let targetPh = '';
  if (targetPhRaw) {
    const ph = decimal(targetPhRaw, '目标 pH');
    if (ph < 0n || ph > 14_000_000n) throw new Error('目标 pH 需在 0–14 之间');
    targetPh = fmt(ph);
  }
  const ingredients = Array.isArray(b.ingredients) ? b.ingredients as Row[] : [];
  if (ingredients.length === 0) throw new Error('配方至少需要一个组分');
  const steps = Array.isArray(b.steps) ? b.steps.map((item: unknown) => required(item, '配制步骤')) : [];
  db.prepare(`INSERT INTO recipe_versions(id,recipe_id,version,status,base_volume,base_volume_unit,output_name,output_code,output_unit,output_dimension,steps_json,storage,source_note,rationale,created_by,target_ph)
    VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, recipeId, version, fmt(baseVolume), baseVolumeUnit,
      outputName, outputCode, outputUnit, outputDimension, JSON.stringify(steps), optional(b.storage), optional(b.sourceNote), optional(b.rationale), actorId, targetPh);
  const insert = db.prepare(`INSERT INTO recipe_ingredients(id,recipe_version_id,material_id,name,calculation_type,amount_value,amount_unit,stock_concentration,target_concentration,molecular_weight,dimension,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const ingredient of ingredients) {
    const type = enumValue(ingredient.calculationType, ['ratio','mass_concentration','molar_concentration','stock_dilution','volume_fraction','fixed_addition'], '计算方式');
    const materialId = optional(ingredient.materialId) || null;
    if (!materialId) throw new Error('每个组分都必须关联库存物料');
    const linkedMaterial = db.prepare('SELECT dimension,base_unit,name FROM materials WHERE id=? AND active=1').get(materialId) as Row | undefined;
    if (!linkedMaterial) throw new Error('所选组分对应的物料不存在或已停用');
    const dimension = String(linkedMaterial.dimension) as Dimension;
    if ((type === 'mass_concentration' || type === 'molar_concentration') && dimension !== 'mass') throw new Error('质量浓度和摩尔浓度计算只适用于质量物料');
    if ((type === 'stock_dilution' || type === 'volume_fraction') && dimension !== 'volume') throw new Error('母液稀释和体积分数计算只适用于体积物料');
    if (type === 'ratio' || type === 'fixed_addition') {
      if (!isUnit(required(ingredient.amountUnit, '组分参数单位'), dimension)) throw new Error(`单位“${ingredient.amountUnit}”与所选物料量纲不匹配`);
      convertQuantity(positive(ingredient.amountValue, '组分参数'), required(ingredient.amountUnit, '组分参数单位'), linkedMaterial.base_unit, dimension);
    }
    if (type === 'stock_dilution') {
      concentrationFamily(required(ingredient.amountUnit, '浓度单位'));
      positive(ingredient.stockConcentration, '配方母液浓度');
      positive(ingredient.targetConcentration, '目标浓度');
    }
    const amountValue = type === 'stock_dilution' ? positive(ingredient.targetConcentration,'目标浓度') : positive(ingredient.amountValue,'组分参数');
    calculateIngredient({ id: '', name: String(linkedMaterial.name), calculation_type: type, amount_value: fmt(amountValue),
      amount_unit: required(ingredient.amountUnit,'组分参数单位'), stock_concentration: optional(ingredient.stockConcentration),
      target_concentration: optional(ingredient.targetConcentration), molecular_weight: optional(ingredient.molecularWeight), dimension,
      notes: optional(ingredient.notes), material_id: materialId || undefined, material_unit: linkedMaterial?.base_unit,
      material_dimension: linkedMaterial?.dimension } as Ingredient, fmt(baseVolume), fmt(baseVolume), baseVolumeUnit, baseVolumeUnit);
    insert.run(id('ing_'), versionId, materialId, String(linkedMaterial.name), type,
      fmt(amountValue), required(ingredient.amountUnit,'组分参数单位'), optional(ingredient.stockConcentration),
      optional(ingredient.targetConcentration), optional(ingredient.molecularWeight), dimension, optional(ingredient.notes));
  }
  return versionId;
}

function nextPreparationCode() {
  const row = db.prepare("SELECT setting_value FROM system_settings WHERE setting_key='number_rules'").get() as Row | undefined;
  let config: Row = {};
  try { config = row?.setting_value ? JSON.parse(String(row.setting_value)) : {}; } catch { config = {}; }
  const prefix = String(config.preparationPrefix || 'PREP').trim();
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM preparations WHERE code LIKE ?').get(`${prefix}-${day}-%`) as Row).n);
  return `${prefix}-${day}-${String(count + 1).padStart(4, '0')}`;
}

export function createPreparationDraft(recipeVersionId: string, rawTargetVolume: unknown, rawTargetVolumeUnit: unknown, actorId: string) {
  const version = db.prepare(`SELECT v.*,r.name AS recipe_name FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id
    WHERE v.id=? AND r.active=1 AND r.scope='team'`).get(recipeVersionId) as Row | undefined;
  if (!version) throw new Error('组织共享配方版本不存在');
  if (version.status !== 'published') throw new Error('仅已发布版本可创建配液任务');
  const targetVolume = fmt(positive(rawTargetVolume, '目标体积'));
  const targetVolumeUnit = required(rawTargetVolumeUnit || version.base_volume_unit, '目标体积单位');
  if (!isUnit(targetVolumeUnit, 'volume')) throw new Error(`目标体积单位“${targetVolumeUnit}”未配置或不是体积单位`);
  const ingredients = db.prepare(`SELECT i.*,m.base_unit AS material_unit,m.dimension AS material_dimension FROM recipe_ingredients i
    LEFT JOIN materials m ON m.id=i.material_id WHERE i.recipe_version_id=?`).all(version.id) as Ingredient[];
  const lines = calculateRecipe(ingredients, targetVolume, String(version.base_volume), targetVolumeUnit, String(version.base_volume_unit));
  const mapped = lines.map((line, index) => ({ ...line, ingredientId: ingredients[index].id, materialId: ingredients[index].material_id,
    expectedUnit: ingredients[index].material_unit || line.unit, caution: [line.caution,
      ingredients[index].calculation_type === 'stock_dilution' ? '按 C₁V₁=C₂V₂ 计算；配方体积表示待加入母液体积，剩余液体用于定容。' : ''].filter(Boolean).join(' ') }));
  for (const line of mapped) if (!line.materialId) throw new Error(`请为组分“${line.name}”绑定库存物料后再创建配液任务`);
  const preparationId = id('prep_');
  const code = nextPreparationCode();
  const outputQuantity = version.output_dimension === 'volume'
    ? fmt(convertQuantity(positive(targetVolume, '目标体积'), targetVolumeUnit, version.output_unit, 'volume')) : '';
  const snapshot = { recipeName: version.recipe_name, version: version.version, versionId: version.id, targetVolume, targetVolumeUnit,
    lines: mapped, outputName: version.output_name, outputCode: version.output_code, outputUnit: version.output_unit,
    outputDimension: version.output_dimension };
  db.prepare(`INSERT INTO preparations(id,code,recipe_version_id,target_volume,target_volume_unit,output_quantity,output_unit,theoretical_snapshot,performed_by,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(preparationId, code, version.id, targetVolume, targetVolumeUnit, outputQuantity, version.output_unit,
    JSON.stringify(snapshot), actorId, actorId);
  const stepList = JSON.parse(String(version.steps_json || '[]')) as string[];
  const insertStep = db.prepare('INSERT INTO preparation_steps(id,preparation_id,step_no,instruction) VALUES (?,?,?,?)');
  stepList.forEach((instruction, index) => insertStep.run(id('step_'), preparationId, index + 1, instruction));
  db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)`)
    .run(id('aud_'), actorId, 'preparation.create', 'preparation', preparationId, JSON.stringify({ versionId: version.id, targetVolume }));
  return preparationId;
}

export function preparationInventoryFingerprint(recipeVersionId: string) {
  const rows = db.prepare(`SELECT DISTINCT l.id,l.material_id,l.internal_lot,l.status,l.expiry_date,l.concentration,l.concentration_unit,
      b.location_id,b.quantity FROM recipe_ingredients i JOIN inventory_lots l ON l.material_id=i.material_id
    JOIN stock_balances b ON b.lot_id=l.id WHERE i.recipe_version_id=? ORDER BY l.id,b.location_id`).all(recipeVersionId) as Row[];
  return createHash('sha256').update(JSON.stringify(rows.map(row => Object.values(row)))).digest('hex');
}

export function previewPreparationAllocations(recipeVersionId: string, rawTargetVolume: unknown, rawTargetVolumeUnit?: unknown) {
  const version = db.prepare(`SELECT v.*,r.name AS recipe_name FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id
    WHERE v.id=? AND r.active=1 AND r.scope='team'`).get(recipeVersionId) as Row | undefined;
  if (!version) throw new Error('组织共享配方版本不存在');
  if (version.status !== 'published') throw new Error('仅已发布配方版本可提供配液辅助');
  const targetVolume = fmt(positive(rawTargetVolume, '目标体积'));
  const targetVolumeUnit = required(rawTargetVolumeUnit || version.base_volume_unit, '目标体积单位');
  if (!isUnit(targetVolumeUnit, 'volume')) throw new Error('目标体积单位不是已配置的体积单位');
  const ingredients = db.prepare(`SELECT i.*,m.base_unit AS material_unit,m.dimension AS material_dimension,m.name AS linked_material_name
    FROM recipe_ingredients i LEFT JOIN materials m ON m.id=i.material_id WHERE i.recipe_version_id=?`).all(version.id) as Array<Ingredient & Row>;
  const lines = calculateRecipe(ingredients, targetVolume, String(version.base_volume), targetVolumeUnit, String(version.base_volume_unit))
    .map((line, index) => ({ ...line, ingredientId: ingredients[index].id, materialId: ingredients[index].material_id,
      expectedUnit: ingredients[index].material_unit || line.unit }));
  const allocations = ingredients.map((ingredient, index) => {
    if (!ingredient.material_id) return { ingredientId: ingredient.id, name: ingredient.name, materialId: null, materialName: ingredient.name,
      theoretical: lines[index], batches: [], missingReason: '未关联库存物料' };
    const lots = db.prepare(`SELECT l.id,l.internal_lot,l.manufacturer_lot,l.status,l.expiry_date,l.concentration,l.concentration_unit,
        m.base_unit,m.dimension,b.location_id,loc.name AS location_name,b.quantity FROM inventory_lots l JOIN materials m ON m.id=l.material_id
      JOIN stock_balances b ON b.lot_id=l.id JOIN locations loc ON loc.id=b.location_id WHERE l.material_id=? AND CAST(b.quantity AS REAL)>0
      ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END,l.expiry_date,l.internal_lot`).all(ingredient.material_id) as Row[];
    const batches = lots.map(lot => {
      let requiredQuantity: string | null = lines[index].quantity;
      let requiredUnit = lines[index].unit;
      let error = '';
      if (ingredient.calculation_type === 'stock_dilution') {
        try {
          if (!lot.concentration || !lot.concentration_unit) throw new Error('批次缺少浓度和单位');
          const result = calculateIngredient(ingredient, targetVolume, String(version.base_volume), targetVolumeUnit, String(version.base_volume_unit),
            { value: String(lot.concentration), unit: String(lot.concentration_unit) });
          requiredQuantity = result.quantity; requiredUnit = result.unit;
        } catch (reason) { requiredQuantity = null; error = reason instanceof Error ? reason.message : String(reason); }
      }
      const expired = Boolean(lot.expiry_date && String(lot.expiry_date) < new Date().toISOString().slice(0, 10));
      const enough = requiredQuantity !== null && lot.base_unit === requiredUnit && decimal(String(lot.quantity)) >= decimal(requiredQuantity);
      return { lotId: String(lot.id), internalLot: String(lot.internal_lot), manufacturerLot: String(lot.manufacturer_lot || ''),
        status: String(lot.status), expiryDate: lot.expiry_date || null, expired, concentration: lot.concentration || null,
        concentrationUnit: lot.concentration_unit || null, locationId: String(lot.location_id), locationName: String(lot.location_name),
        availableQuantity: String(lot.quantity), stockUnit: String(lot.base_unit), requiredQuantity, requiredUnit, enough,
        eligible: lot.status === 'active' && !expired && enough && !error, calculationError: error };
    });
    return { ingredientId: ingredient.id, name: ingredient.name, materialId: ingredient.material_id, materialName: ingredient.linked_material_name || ingredient.name,
      theoretical: lines[index], batches, missingReason: batches.some(batch => batch.eligible) ? undefined : '没有符合状态、有效期、单位及数量要求的批次' };
  });
  return { recipeVersionId, recipeName: version.recipe_name, version: version.version, status: version.status, baseVolume: version.base_volume,
    baseVolumeUnit: version.base_volume_unit, targetVolume, targetVolumeUnit, lines, allocations, inventoryFingerprint: preparationInventoryFingerprint(recipeVersionId),
    inventoryChanged: false, note: '该结果只是当前库存快照预览，不锁定、不扣减库存；正式创建任务和登记实际用量时服务端会再次校验。' };
}
