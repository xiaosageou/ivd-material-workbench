const SCALE = 1_000_000n;
const scaleText = 1_000_000n;

export function decimal(value: unknown, label = '数量'): bigint {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(text)) throw new Error(`${label}需为最多 6 位小数的数字`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const parsed = BigInt(whole) * SCALE + BigInt((fraction + '000000').slice(0, 6));
  return negative ? -parsed : parsed;
}

export function fmt(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function add(a: bigint, b: bigint): bigint { return a + b; }
export function sub(a: bigint, b: bigint): bigint { return a - b; }
export function mul(a: bigint, b: bigint): bigint {
  return roundDiv(a * b, SCALE);
}
export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('除数不能为 0');
  return roundDiv(a * SCALE, b);
}

export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('除数不能为 0');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n + d / 2n) / d;
  return negative ? -rounded : rounded;
}

export const zero = () => 0n;
export const scale = () => scaleText;

export function positive(value: unknown, label = '数量'): bigint {
  const parsed = decimal(value, label);
  if (parsed <= 0n) throw new Error(`${label}必须大于 0`);
  return parsed;
}

export function nonNegative(value: unknown, label = '数量'): bigint {
  const parsed = decimal(value, label);
  if (parsed < 0n) throw new Error(`${label}不能小于 0`);
  return parsed;
}
