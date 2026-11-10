import { decimal, fmt } from './decimal.ts';

export type Dimension = 'mass' | 'volume' | 'amount' | 'activity' | 'count';
type Factor = { n: bigint; d: bigint };
type Unit = { dimension: Dimension; factor: Factor; canonical: string };
type Concentration = { family: 'mass' | 'molar'; factor: Factor };

const S = 1_000_000n;
const units = new Map<string, Unit>();
const register = (names: string[], dimension: Dimension, n: bigint, d = 1n, canonical: string) => {
  for (const name of names) units.set(normalize(name), { dimension, factor: { n, d }, canonical });
};
const normalize = (value: string) => value.trim().replace(/[μµ]/g, 'u').replace(/\s+/g, '').toLowerCase();

register(['mg'], 'mass', 1n, 1n, 'mg');
register(['g'], 'mass', 1000n, 1n, 'mg');
register(['kg'], 'mass', 1_000_000n, 1n, 'mg');
register(['ug', 'µg', 'μg'], 'mass', 1n, 1000n, 'mg');
register(['ul', 'µl', 'μl'], 'volume', 1n, 1000n, 'mL');
register(['ml'], 'volume', 1n, 1n, 'mL');
register(['l'], 'volume', 1000n, 1n, 'mL');
register(['nl'], 'volume', 1n, 1_000_000n, 'mL');
register(['umol', 'µmol', 'μmol'], 'amount', 1n, 1_000_000n, 'mol');
register(['mmol'], 'amount', 1n, 1000n, 'mol');
register(['mol'], 'amount', 1n, 1n, 'mol');
register(['mu', 'mU'], 'activity', 1n, 1000n, 'U');
register(['u'], 'activity', 1n, 1n, 'U');
register(['ku'], 'activity', 1000n, 1n, 'U');
for (const name of ['个', '支', '瓶', '片', '套', '孔', 'pcs', 'piece', 'vial', 'kit']) register([name], 'count', 1n, 1n, name);

const BUILTIN_UNIT_CATALOG: Record<Dimension, string[]> = {
  mass: ['µg', 'mg', 'g', 'kg'],
  volume: ['nL', 'µL', 'mL', 'L'],
  amount: ['µmol', 'mmol', 'mol'],
  activity: ['mU', 'U', 'kU'],
  count: ['个', '支', '瓶', '片', '套', '孔', 'pcs', 'vial', 'kit'],
};

export function getUnitCatalog(): Record<Dimension, string[]> {
  const result = Object.fromEntries(Object.entries(BUILTIN_UNIT_CATALOG).map(([dimension, names]) => [dimension, [...names]])) as Record<Dimension, string[]>;
  for (const [key, value] of units) if (!result[value.dimension].some(item => normalize(item) === key)) result[value.dimension].push(key);
  return result;
}

export function registerConfiguredUnit(name: string, dimension: Dimension, factorToCanonical: string) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 18 || /[\/\s]/.test(cleanName)) throw new Error('单位符号需为 1–18 位且不含空格或斜线');
  const key = normalize(cleanName);
  const existing = units.get(key);
  if (existing) {
    if (existing.dimension === dimension && existing.canonical === `custom:${dimension}`) return;
    throw new Error(`单位“${cleanName}”已存在，不能覆盖标准单位`);
  }
  const factor = decimal(factorToCanonical, '换算系数');
  if (factor <= 0n) throw new Error('换算系数必须大于 0');
  units.set(key, { dimension, factor: { n: factor, d: S }, canonical: `custom:${dimension}` });
  BUILTIN_UNIT_CATALOG[dimension].push(cleanName);
}

export function unitDimension(unit: string): Dimension | undefined {
  return units.get(normalize(unit))?.dimension;
}

export function isUnit(unit: string, dimension?: Dimension): boolean {
  const found = units.get(normalize(unit));
  return !!found && (!dimension || found.dimension === dimension);
}

function factorFor(unit: string, dimension: Dimension): Unit {
  const found = units.get(normalize(unit));
  if (!found) throw new Error(`未知单位“${unit}”，请在单位配置中选择已支持单位`);
  if (found.dimension !== dimension) throw new Error(`单位“${unit}”属于${found.dimension}量纲，与${dimension}量纲不一致`);
  return found;
}

export function convertQuantity(value: bigint, fromUnit: string, toUnit: string, dimension: Dimension): bigint {
  const from = factorFor(fromUnit, dimension);
  const to = factorFor(toUnit, dimension);
  if (dimension === 'count' && normalize(fromUnit) !== normalize(toUnit)) {
    throw new Error(`计数单位“${fromUnit}”与“${toUnit}”不可互换`);
  }
  return roundDiv(value * from.factor.n * to.factor.d, from.factor.d * to.factor.n);
}

export function scaledConvertQuantity(value: bigint, multiplierNumerator: bigint, multiplierDenominator: bigint,
  fromUnit: string, toUnit: string, dimension: Dimension): bigint {
  const from = factorFor(fromUnit, dimension);
  const to = factorFor(toUnit, dimension);
  if (dimension === 'count' && normalize(fromUnit) !== normalize(toUnit)) {
    throw new Error(`计数单位“${fromUnit}”与“${toUnit}”不可互换`);
  }
  if (multiplierDenominator <= 0n) throw new Error('换算比例分母必须大于 0');
  return roundDiv(value * multiplierNumerator * from.factor.n * to.factor.d,
    multiplierDenominator * from.factor.d * to.factor.n);
}

function conversionFactor(fromUnit: string, toUnit: string, dimension: Dimension): Factor {
  const from = factorFor(fromUnit, dimension);
  const to = factorFor(toUnit, dimension);
  if (dimension === 'count' && normalize(fromUnit) !== normalize(toUnit)) {
    throw new Error(`计数单位“${fromUnit}”与“${toUnit}”不可互换`);
  }
  return { n: from.factor.n * to.factor.d, d: from.factor.d * to.factor.n };
}

export function scaledConvertByVolume(value: bigint, targetVolume: bigint, targetVolumeUnit: string,
  baseVolume: bigint, baseVolumeUnit: string, fromUnit: string, toUnit: string, dimension: Dimension): bigint {
  const targetFactor = conversionFactor(targetVolumeUnit, 'mL', 'volume');
  const baseFactor = conversionFactor(baseVolumeUnit, 'mL', 'volume');
  const from = factorFor(fromUnit, dimension);
  const to = factorFor(toUnit, dimension);
  if (dimension === 'count' && normalize(fromUnit) !== normalize(toUnit)) {
    throw new Error(`计数单位“${fromUnit}”与“${toUnit}”不可互换`);
  }
  return roundDiv(value * targetVolume * targetFactor.n * baseFactor.d * from.factor.n * to.factor.d,
    baseVolume * targetFactor.d * baseFactor.n * from.factor.d * to.factor.n);
}

export function volumeFractionQuantity(percent: bigint, volume: bigint, volumeUnit: string, outputUnit: string): bigint {
  const volumeFactor = conversionFactor(volumeUnit, outputUnit, 'volume');
  return roundDiv(percent * volume * volumeFactor.n, S * 100n * volumeFactor.d);
}

export function normalizeVolume(value: bigint, unit: string): bigint {
  return convertQuantity(value, unit, 'mL', 'volume');
}

function concentrationFactor(unit: string): Concentration {
  const cleaned = unit.trim().replace(/[μµ]/g, 'u').replace(/\s+/g, '');
  const shorthand = cleaned.match(/^([numuk]?)[mM]$/);
  const normalized = shorthand ? `${shorthand[1] || ''}mol/L` : cleaned;
  const parts = normalized.split('/');
  if (parts.length !== 2) throw new Error(`未知浓度单位“${unit}”`);
  const numerator = parts[0].toLowerCase();
  const denominator = parts[1].toLowerCase();
  const mass = new Map<string, Factor>([['ug', { n: 1n, d: 1000n }], ['mg', { n: 1n, d: 1n }], ['g', { n: 1000n, d: 1n }], ['kg', { n: 1_000_000n, d: 1n }]]);
  const volumeMl = new Map<string, Factor>([['ul', { n: 1n, d: 1000n }], ['nl', { n: 1n, d: 1_000_000n }], ['ml', { n: 1n, d: 1n }], ['l', { n: 1000n, d: 1n }]]);
  const amounts = new Map<string, Factor>([['umol', { n: 1n, d: 1_000_000n }], ['mmol', { n: 1n, d: 1000n }], ['mol', { n: 1n, d: 1n }]]);
  if (mass.has(numerator) && volumeMl.has(denominator)) {
    const a = mass.get(numerator)!; const v = volumeMl.get(denominator)!;
    return { family: 'mass', factor: { n: a.n * v.d, d: a.d * v.n } };
  }
  if (amounts.has(numerator) && (denominator === 'l' || denominator === 'ml')) {
    const a = amounts.get(numerator)!;
    const vL = denominator === 'l' ? { n: 1n, d: 1n } : { n: 1n, d: 1000n };
    return { family: 'molar', factor: { n: a.n * vL.d, d: a.d * vL.n } };
  }
  throw new Error(`未知浓度单位“${unit}”，目前支持质量/体积浓度与 mol/L、mmol/L、µmol/L`);
}

export function concentrationFamily(unit: string) { return concentrationFactor(unit).family; }

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('除数不能为 0');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n + d / 2n) / d;
  return negative ? -rounded : rounded;
}

export function dilutionVolume(targetConcentration: bigint, targetUnit: string, finalVolume: bigint, finalVolumeUnit: string,
  stockConcentration: bigint, stockUnit: string, outputVolumeUnit = 'mL', share = 100n * S): bigint {
  const target = concentrationFactor(targetUnit);
  const stock = concentrationFactor(stockUnit);
  if (target.family !== stock.family) throw new Error(`目标浓度单位 ${targetUnit} 与母液批次单位 ${stockUnit} 量纲不一致`);
  if (stockConcentration * stock.factor.n * target.factor.d < targetConcentration * target.factor.n * stock.factor.d) {
    throw new Error('母液批次浓度低于目标浓度，无法通过稀释达到目标');
  }
  const volumeFactor = conversionFactor(finalVolumeUnit, 'mL', 'volume');
  const to = factorFor(outputVolumeUnit, 'volume');
  if (share <= 0n || share > 100n * S) throw new Error('批次分配比例需大于 0 且不超过 100%');
  const numerator = finalVolume * volumeFactor.n * targetConcentration * target.factor.n * stock.factor.d * share * to.factor.d;
  const denominator = stockConcentration * target.factor.d * stock.factor.n * 100n * S * volumeFactor.d * to.factor.n;
  if (denominator <= 0n) throw new Error('母液批次浓度必须大于 0');
  return roundDiv(numerator, denominator);
}

export function massConcentrationQuantity(concentration: bigint, concentrationUnit: string, volume: bigint, volumeUnit: string,
  outputUnit: string): bigint {
  const c = concentrationFactor(concentrationUnit);
  if (c.family !== 'mass') throw new Error(`质量浓度单位“${concentrationUnit}”无效`);
  const out = factorFor(outputUnit, 'mass');
  const volumeFactor = conversionFactor(volumeUnit, 'mL', 'volume');
  return roundDiv(concentration * volume * c.factor.n * volumeFactor.n * out.factor.d,
    S * c.factor.d * volumeFactor.d * out.factor.n);
}

export function molarConcentrationMass(concentration: bigint, concentrationUnit: string, volume: bigint, volumeUnit: string,
  molecularWeight: bigint, outputUnit: string): bigint {
  const c = concentrationFactor(concentrationUnit);
  if (c.family !== 'molar') throw new Error(`摩尔浓度单位“${concentrationUnit}”无效`);
  const out = factorFor(outputUnit, 'mass');
  const volumeFactor = conversionFactor(volumeUnit, 'L', 'volume');
  const gToMg = factorFor('g', 'mass').factor;
  return roundDiv(concentration * volume * molecularWeight * c.factor.n * volumeFactor.n * gToMg.n * out.factor.d,
    S * S * c.factor.d * volumeFactor.d * gToMg.d * out.factor.n);
}

export function unitLabel(unit: string) {
  factorFor(unit, units.get(normalize(unit))?.dimension || 'count');
  return unit;
}

export function toUnit(value: string, fromUnit: string, toUnitName: string, dimension: Dimension) {
  return fmt(convertQuantity(decimal(value), fromUnit, toUnitName, dimension));
}
