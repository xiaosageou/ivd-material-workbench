import { decimal, fmt } from './decimal.ts';
import { convertQuantity, dilutionVolume, massConcentrationQuantity, molarConcentrationMass, scaledConvertByVolume, volumeFractionQuantity, type Dimension } from './units.ts';

export type Ingredient = {
  id?: string; name: string; calculation_type: string; amount_value: string; amount_unit: string;
  stock_concentration?: string; target_concentration?: string; molecular_weight?: string; dimension: string; notes?: string;
  material_id?: string; material_unit?: string; material_dimension?: Dimension;
};

export function calculateIngredient(ingredient: Ingredient, targetVolume: string, baseVolume: string,
  targetVolumeUnit = 'mL', baseVolumeUnit = 'mL', batchConcentration?: { value: string; unit: string; share?: string }) {
  const amount = decimal(ingredient.amount_value, `${ingredient.name}配方参数`);
  const volume = decimal(targetVolume, '目标体积');
  const basis = decimal(baseVolume, '基准产量');
  if (volume <= 0n || basis <= 0n) throw new Error('目标体积和基准产量必须大于 0');
  let quantity: bigint;
  let unit = ingredient.amount_unit;
  let basisText: string;
  const outputMassUnit = ingredient.material_unit || (ingredient.calculation_type === 'molar_concentration' ? 'g' : ingredient.amount_unit.split('/')[0]);

  switch (ingredient.calculation_type) {
    case 'ratio': {
      const outputUnit = ingredient.material_unit || ingredient.amount_unit;
      const dimension = ingredient.material_dimension || ingredient.dimension as Dimension;
      quantity = scaledConvertByVolume(amount, volume, targetVolumeUnit, basis, baseVolumeUnit,
        ingredient.amount_unit, outputUnit, dimension);
      unit = outputUnit;
      basisText = `${ingredient.amount_value} ${ingredient.amount_unit} × ${targetVolume} ${targetVolumeUnit}/${baseVolume} ${baseVolumeUnit}`;
      break;
    }
    case 'mass_concentration': {
      if (ingredient.dimension !== 'mass') throw new Error('质量浓度计算只适用于质量维度物料');
      const match = ingredient.amount_unit.match(/^\s*(?:µ|μ|u)?(?:g|mg|kg)\s*\/\s*(?:µ|μ|u)?(?:L|mL|nL)\s*$/i);
      if (!match) throw new Error(`${ingredient.name}质量浓度单位需使用 µg/mL、mg/mL、mg/L、g/mL 或 g/L`);
      quantity = massConcentrationQuantity(amount, ingredient.amount_unit, volume, targetVolumeUnit, outputMassUnit);
      unit = outputMassUnit;
      basisText = `${ingredient.amount_value} ${ingredient.amount_unit} × ${targetVolume} ${targetVolumeUnit}`;
      break;
    }
    case 'molar_concentration': {
      if (ingredient.dimension !== 'mass') throw new Error('摩尔浓度计算需指定质量维度物料');
      if (!ingredient.molecular_weight || decimal(ingredient.molecular_weight, '分子量') <= 0n) throw new Error(`${ingredient.name}缺少有效分子量`);
      quantity = molarConcentrationMass(amount, ingredient.amount_unit, volume, targetVolumeUnit,
        decimal(ingredient.molecular_weight, '分子量'), outputMassUnit);
      unit = outputMassUnit;
      basisText = `${ingredient.amount_value} ${ingredient.amount_unit} × ${targetVolume} ${targetVolumeUnit} × ${ingredient.molecular_weight} g/mol`;
      break;
    }
    case 'stock_dilution': {
      const recipeStock = decimal(ingredient.stock_concentration, `${ingredient.name}母液浓度`);
      const target = decimal(ingredient.target_concentration, `${ingredient.name}目标浓度`);
      if (recipeStock <= 0n) throw new Error(`${ingredient.name}母液浓度必须大于 0`);
      if (target <= 0n) throw new Error(`${ingredient.name}目标浓度必须大于 0`);
      const stockValue = batchConcentration ? decimal(batchConcentration.value, `${ingredient.name}批次浓度`) : recipeStock;
      const stockUnit = batchConcentration?.unit || ingredient.amount_unit;
      const share = decimal(batchConcentration?.share ?? '100', `${ingredient.name}批次分配比例`);
      if (stockValue <= 0n) throw new Error(`${ingredient.name}批次浓度必须大于 0`);
      if (share <= 0n || share > 100n * 1_000_000n) throw new Error(`${ingredient.name}批次分配比例需大于 0 且不超过 100%`);
      unit = ingredient.material_unit || 'mL';
      quantity = dilutionVolume(target, ingredient.amount_unit, volume, targetVolumeUnit, stockValue, stockUnit, unit, share);
      basisText = `${ingredient.target_concentration}/${batchConcentration ? `${stockValue} ${stockUnit}` : `${ingredient.stock_concentration} ${ingredient.amount_unit}`} × ${targetVolume} ${targetVolumeUnit} × ${fmt(share)}%（按所选批次浓度计算）`;
      break;
    }
    case 'volume_fraction': {
      if (ingredient.dimension !== 'volume') throw new Error('体积分数计算只适用于体积维度物料');
      const percent = amount;
      unit = ingredient.material_unit || 'mL';
      quantity = volumeFractionQuantity(percent, volume, targetVolumeUnit, unit);
      basisText = `${ingredient.amount_value}% × ${targetVolume} ${targetVolumeUnit}`;
      break;
    }
    case 'fixed_addition': {
      const outputUnit = ingredient.material_unit || ingredient.amount_unit;
      const dimension = ingredient.material_dimension || ingredient.dimension as Dimension;
      quantity = convertQuantity(amount, ingredient.amount_unit, outputUnit, dimension);
      unit = outputUnit;
      basisText = `${ingredient.amount_value} ${ingredient.amount_unit} / 批（固定添加，不随体积缩放）`;
      break;
    }
    default:
      throw new Error(`不支持的计算类型：${ingredient.calculation_type}`);
  }
  const result = fmt(quantity);
  const precisionWarning = quantity === 0n;
  return { name: ingredient.name, quantity: result, unit, calculationType: ingredient.calculation_type, basis: basisText,
    notes: ingredient.notes || '', precisionWarning,
    caution: precisionWarning ? '计算结果低于 0.000001 单位分辨率，按 0 显示；请核对目标量程与可操作精度。' : '' };
}

export function calculateRecipe(ingredients: Ingredient[], targetVolume: string, baseVolume: string,
  targetVolumeUnit = 'mL', baseVolumeUnit = 'mL') {
  return ingredients.map(item => calculateIngredient(item, targetVolume, baseVolume, targetVolumeUnit, baseVolumeUnit));
}
