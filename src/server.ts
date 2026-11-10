import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, transaction, id, attachmentDir, backupDir, databasePath } from './db.ts';
import { add, decimal, div, fmt, mul, nonNegative, positive, roundDiv, sub } from './decimal.ts';
import { calculateIngredient, calculateRecipe, type Ingredient } from './calculator.ts';
import { concentrationFamily, convertQuantity, getUnitCatalog, isUnit, registerConfiguredUnit, type Dimension } from './units.ts';
import { installResearchReportRoutes } from './research-reports.ts';
import { installLiteratureRoutes } from './literature/api.ts';
import { installAiRoutes } from './ai/api.ts';
import { saveRecipeVersion as saveRecipeVersionCore, createPreparationDraft } from './recipe-service.ts';

type Row = Record<string, any>;
type AuthRequest = Request & { user?: Row };
const app = express();
const port = Number(process.env.PORT || 3001);
const archiver: (format: string, options?: Record<string, unknown>) => any = createRequire(import.meta.url)('archiver') as any;
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashFile = (filePath: string) => new Promise<string>((resolve,reject)=>{
  const hash=createHash('sha256'); const stream=createReadStream(filePath);
  stream.on('data',chunk=>hash.update(chunk)); stream.on('error',reject); stream.on('end',()=>resolve(hash.digest('hex')));
});
const passwordHash = (password: string) => {
  if (password.length < 12) throw new Error('密码至少 12 位');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
};
const passwordMatches = (password: string, stored: string) => {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const cookieOptions = (expires: Date) => `Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false' ? '; Secure' : ''}`;
const readCookie = (req: Request, name: string) => {
  const value = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
};

function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = readCookie(req, 'ivd_session');
  if (!token) return res.status(401).json({ error: '请先登录' });
  const session = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,s.id AS session_id
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>datetime('now') AND u.active=1`).get(sha256(token)) as Row | undefined;
  if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.user = session;
  next();
}
function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: '此操作需要管理员权限' });
  next();
}
const route = (fn: (req: AuthRequest, res: Response) => unknown) => (req: AuthRequest, res: Response, next: NextFunction) => {
  try { return fn(req, res); } catch (error) { return next(error); }
};
const required = (value: unknown, label: string) => {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label}为必填项`);
  return text;
};
const optional = (value: unknown) => String(value ?? '').trim();
function normalizeMaterialDraft(input: Row) {
  const code = required(input.code, '物料编号');
  const name = required(input.name, '物料名称');
  const category = required(input.category, '分类');
  const dimension = enumValue(input.dimension, ['mass','volume','amount','activity','count'], '物料量纲') as Dimension;
  const baseUnit = required(input.baseUnit ?? input.base_unit, '库存单位');
  if (!isUnit(baseUnit, dimension)) throw new Error(`库存单位“${baseUnit}”与物料量纲 ${dimension} 不一致或未配置`);
  const minStock = fmt(nonNegative(input.minStock ?? input.min_stock ?? '0', '低库存阈值'));
  return { code, name, category, dimension, baseUnit, minStock, specification:optional(input.specification),
    manufacturer:optional(input.manufacturer), supplier:optional(input.supplier ?? input.default_supplier), notes:optional(input.notes),
    isProduct:input.isProduct === true || input.is_product === '1' || input.isProduct === 1 ? 1 : 0 };
}
const param = (req: Request, name = 'id') => String(req.params[name] ?? '');
const enumValue = (value: unknown, values: string[], label: string) => {
  const text = String(value ?? '');
  if (!values.includes(text)) throw new Error(`${label}取值无效`);
  return text;
};
const audit = (actorId: string | null, action: string, objectType: string, objectId = '', details: Row = {}) => {
  db.prepare('INSERT INTO audit_events(id,actor_id,action,object_type,object_id,details) VALUES (?,?,?,?,?,?)')
    .run(id('aud_'), actorId, action, objectType, objectId, JSON.stringify(details));
};
const settingValue = <T,>(key: string, fallback: T): T => {
  const row = db.prepare('SELECT setting_value FROM system_settings WHERE setting_key=?').get(key) as Row | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.setting_value) as T; } catch { return fallback; }
};
const writeSetting = (actorId: string, key: string, value: unknown) => {
  db.prepare(`INSERT INTO system_settings(setting_key,setting_value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=datetime('now')`)
    .run(key, JSON.stringify(value), actorId);
};
const numberRules = () => settingValue('number_rules', { materialPrefix: 'MAT', lotPrefix: 'LOT', preparationPrefix: 'PREP' });
function nextCode(kind: 'material' | 'lot' | 'preparation') {
  const config = numberRules() as Row;
  const field = kind === 'material' ? 'materialPrefix' : kind === 'lot' ? 'lotPrefix' : 'preparationPrefix';
  const table = kind === 'material' ? 'materials' : kind === 'lot' ? 'inventory_lots' : 'preparations';
  const column = kind === 'material' ? 'code' : kind === 'lot' ? 'internal_lot' : 'code';
  const prefix = String(config[field] || kind.toUpperCase()).trim();
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`${prefix}-${day}-%`) as Row).n);
  return `${prefix}-${day}-${String(count + 1).padStart(4, '0')}`;
}

const savedUnits = settingValue<Array<{ name: string; dimension: Dimension; factorToCanonical: string }>>('units', []);
for (const unit of savedUnits) {
  try { registerConfiguredUnit(unit.name, unit.dimension, unit.factorToCanonical); }
  catch (error) { console.error('Ignoring invalid configured unit:', (error as Error).message); }
}
const lotInfo = (lotId: string) => db.prepare(`SELECT l.*,m.name AS material_name,m.code AS material_code,m.base_unit,m.dimension
  FROM inventory_lots l JOIN materials m ON m.id=l.material_id WHERE l.id=?`).get(lotId) as Row | undefined;
const balanceOf = (lotId: string, locationId: string) => {
  const row = db.prepare('SELECT quantity FROM stock_balances WHERE lot_id=? AND location_id=?').get(lotId, locationId) as Row | undefined;
  return row ? decimal(row.quantity) : 0n;
};
function changeBalance(lotId: string, locationId: string, delta: bigint) {
  const next = add(balanceOf(lotId, locationId), delta);
  if (next < 0n) throw new Error('库存余额不足，操作已整体回滚');
  db.prepare(`INSERT INTO stock_balances(lot_id,location_id,quantity,updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(lot_id,location_id) DO UPDATE SET quantity=excluded.quantity,updated_at=datetime('now')`)
    .run(lotId, locationId, fmt(next));
}
function movement(actorId: string, lot: Row, type: string, quantity: bigint, reason: string, sourceType: string,
  sourceId: string, fromLocation: string | null, toLocation: string | null) {
  db.prepare(`INSERT INTO stock_movements(id,lot_id,material_id,movement_type,quantity,from_location_id,to_location_id,reason,source_type,source_id,actor_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id('mov_'), lot.id, lot.material_id, type, fmt(quantity), fromLocation, toLocation, reason, sourceType, sourceId, actorId);
}
function assertConsumable(lot: Row) {
  if (!lot) throw new Error('批次不存在');
  if (lot.status !== 'active') throw new Error('该批次已停用、隔离或过期，禁止消耗');
  if (lot.expiry_date && lot.expiry_date < new Date().toISOString().slice(0, 10)) throw new Error('该批次已过期，禁止消耗');
}
function materialSummary(material: Row): Row {
  const balances = db.prepare(`SELECT b.quantity,l.name AS location_name,l.id AS location_id,lot.id AS lot_id,lot.internal_lot,lot.expiry_date,lot.status
    FROM stock_balances b JOIN inventory_lots lot ON lot.id=b.lot_id JOIN locations l ON l.id=b.location_id
    WHERE lot.material_id=? ORDER BY lot.expiry_date IS NULL,lot.expiry_date,lot.internal_lot`).all(material.id) as Row[];
  const total = balances.reduce((sum, row) => add(sum, decimal(row.quantity)), 0n);
  return { ...material, total_quantity: fmt(total), lots: balances };
}

app.post('/api/auth/login', route((req, res) => {
  const email = required(req.body?.email, '邮箱');
  const password = required(req.body?.password, '密码');
  const user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email) as Row | undefined;
  if (!user || !user.active || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: '邮箱或密码错误' });
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)').run(sha256(token), user.id, expires.toISOString().replace('T', ' ').slice(0, 19));
  res.setHeader('Set-Cookie', `ivd_session=${encodeURIComponent(token)}; ${cookieOptions(expires)}`);
  audit(user.id, 'login', 'user', user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));
app.post('/api/auth/logout', route((req, res) => {
  const token = readCookie(req, 'ivd_session');
  if (token) db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(token));
  res.setHeader('Set-Cookie', `ivd_session=; ${cookieOptions(new Date(0))}`);
  res.json({ ok: true });
}));
app.get('/api/auth/me', requireAuth, route((req, res) => res.json({ user: req.user })));

app.get('/api/dashboard', requireAuth, route((req, res) => {
  const materials = db.prepare('SELECT * FROM materials WHERE active=1 ORDER BY name').all() as Row[];
  const inventory = materials.map(materialSummary);
  const lowStock = inventory.filter(item => decimal(item.total_quantity) <= decimal(item.min_stock));
  const today = new Date().toISOString().slice(0, 10);
  const alertRules = settingValue('alert_rules', { expiringDays: 60, defaultMinStock: '0' });
  const soon = new Date(Date.now() + Number((alertRules as Row).expiringDays || 60) * 86400000).toISOString().slice(0, 10);
  const expiring = db.prepare(`SELECT l.*,m.name AS material_name,b.quantity,loc.name AS location_name
    FROM inventory_lots l JOIN materials m ON m.id=l.material_id JOIN stock_balances b ON b.lot_id=l.id
    JOIN locations loc ON loc.id=b.location_id WHERE b.quantity!='0' AND l.expiry_date BETWEEN ? AND ? ORDER BY l.expiry_date LIMIT 8`).all(today, soon);
  const pending = db.prepare(`SELECT p.*,r.name AS recipe_name,v.version FROM preparations p
    JOIN recipe_versions v ON v.id=p.recipe_version_id JOIN recipes r ON r.id=v.recipe_id WHERE p.status='planned' ORDER BY p.created_at DESC LIMIT 8`).all();
  const recent = db.prepare(`SELECT m.*,mat.name AS material_name,l.internal_lot,u.name AS actor_name
    FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN inventory_lots l ON l.id=m.lot_id JOIN users u ON u.id=m.actor_id
    ORDER BY m.created_at DESC LIMIT 8`).all();
  res.json({ metrics: { materialCount: materials.length, lowStockCount: lowStock.length, expiringCount: expiring.length,
    pendingCount: Number((db.prepare("SELECT COUNT(*) AS n FROM preparations WHERE status='planned'").get() as Row).n) },
    lowStock: lowStock.slice(0, 8), expiring, pending, recent });
}));

app.get('/api/materials', requireAuth, route((req, res) => {
  const query = `%${optional(req.query.q)}%`;
  const rows = db.prepare(`SELECT * FROM materials WHERE active=1 AND (name LIKE ? OR code LIKE ? OR category LIKE ?) ORDER BY name LIMIT 250`).all(query, query, query) as Row[];
  res.json(rows.map(materialSummary));
}));
app.post('/api/materials', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const alertRules = settingValue('alert_rules', { expiringDays: 60, defaultMinStock: '0' });
  const draft = normalizeMaterialDraft({ ...b, code:optional(b.code) || nextCode('material'), minStock:b.minStock ?? (alertRules as Row).defaultMinStock ?? '0' });
  const materialId = id('mat_');
  db.prepare(`INSERT INTO materials(id,code,name,category,dimension,base_unit,specification,manufacturer,default_supplier,min_stock,notes,is_product)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(materialId, draft.code, draft.name, draft.category, draft.dimension, draft.baseUnit,
      draft.specification, draft.manufacturer, draft.supplier, draft.minStock, draft.notes, draft.isProduct);
  audit(req.user!.id, 'material.create', 'material', materialId, { code:draft.code, name:draft.name });
  res.status(201).json(materialSummary(db.prepare('SELECT * FROM materials WHERE id=?').get(materialId) as Row));
}));
app.patch('/api/materials/:id', requireAuth, requireAdmin, route((req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id=?').get(param(req)) as Row | undefined;
  if (!material) return res.status(404).json({ error: '物料不存在' });
  if (req.body?.dimension && req.body.dimension !== material.dimension) throw new Error('物料量纲创建后固定，避免重新解释历史库存和配方数量');
  if (req.body?.baseUnit && req.body.baseUnit !== material.base_unit) throw new Error('库存单位创建后固定，避免重新解释历史库存流水');
  const values = {
    name: required(req.body?.name ?? material.name, '物料名称'),
    category: required(req.body?.category ?? material.category, '分类'),
    specification: optional(req.body?.specification ?? material.specification),
    manufacturer: optional(req.body?.manufacturer ?? material.manufacturer),
    default_supplier: optional(req.body?.supplier ?? material.default_supplier),
    min_stock: fmt(nonNegative(req.body?.minStock ?? material.min_stock, '低库存阈值')),
    notes: optional(req.body?.notes ?? material.notes),
    active: req.body?.active === false ? 0 : 1,
  };
  db.prepare(`UPDATE materials SET name=?,category=?,specification=?,manufacturer=?,default_supplier=?,min_stock=?,notes=?,active=? WHERE id=?`)
    .run(values.name, values.category, values.specification, values.manufacturer, values.default_supplier, values.min_stock, values.notes, values.active, material.id);
  audit(req.user!.id, 'material.update', 'material', material.id, { name: values.name, category: values.category, minStock: values.min_stock, active: values.active });
  res.json(materialSummary(db.prepare('SELECT * FROM materials WHERE id=?').get(material.id) as Row));
}));
app.get('/api/materials/:id', requireAuth, route((req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id=?').get(param(req)) as Row | undefined;
  if (!material) return res.status(404).json({ error: '物料不存在' });
  const summary = materialSummary(material);
  const movements = db.prepare(`SELECT m.*,l.internal_lot,fl.name AS from_location,tl.name AS to_location,u.name AS actor_name
    FROM stock_movements m JOIN inventory_lots l ON l.id=m.lot_id LEFT JOIN locations fl ON fl.id=m.from_location_id
    LEFT JOIN locations tl ON tl.id=m.to_location_id JOIN users u ON u.id=m.actor_id WHERE m.material_id=? ORDER BY m.created_at DESC LIMIT 100`).all(material.id);
  res.json({ ...summary, movements });
}));

app.get('/api/locations', requireAuth, route((req, res) => res.json(db.prepare('SELECT * FROM locations WHERE active=1 ORDER BY code').all())));
app.post('/api/locations', requireAuth, requireAdmin, route((req, res) => {
  const b = req.body ?? {};
  const locationId = id('loc_');
  db.prepare('INSERT INTO locations(id,code,name,parent_id) VALUES (?,?,?,?)').run(locationId, required(b.code,'库位编号'), required(b.name,'库位名称'), optional(b.parentId) || null);
  audit(req.user!.id, 'location.create', 'location', locationId);
  res.status(201).json(db.prepare('SELECT * FROM locations WHERE id=?').get(locationId));
}));

app.post('/api/inventory/receive', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const lotId = id('lot_');
  const material = db.prepare('SELECT * FROM materials WHERE id=? AND active=1').get(required(b.materialId, '物料')) as Row | undefined;
  if (!material) throw new Error('物料不存在或已停用');
  const locationId = required(b.locationId, '库位');
  const location = db.prepare('SELECT id FROM locations WHERE id=? AND active=1').get(locationId);
  if (!location) throw new Error('库位不存在或已停用');
  const quantityUnit = optional(b.quantityUnit) || material.base_unit;
  if (!isUnit(quantityUnit, material.dimension)) throw new Error(`入库单位“${quantityUnit}”未配置或与物料量纲不匹配`);
  const quantity = convertQuantity(positive(b.quantity, '入库数量'), quantityUnit, material.base_unit, material.dimension as Dimension);
  if (!!optional(b.concentration) !== !!optional(b.concentrationUnit)) throw new Error('填写批次浓度时，浓度值和单位必须同时提供');
  if (optional(b.concentration)) {
    positive(b.concentration, '批次浓度');
    concentrationFamily(required(b.concentrationUnit, '批次浓度单位'));
  }
  const internalLot = optional(b.internalLot) || nextCode('lot');
  transaction(() => {
    db.prepare(`INSERT INTO inventory_lots(id,material_id,manufacturer_lot,internal_lot,expiry_date,concentration,concentration_unit,purity,container_id,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(lotId, material.id, optional(b.manufacturerLot), internalLot, optional(b.expiryDate) || null,
      optional(b.concentration), optional(b.concentrationUnit), optional(b.purity), optional(b.containerId), optional(b.notes));
    changeBalance(lotId, locationId, quantity);
    movement(req.user!.id, { id: lotId, material_id: material.id }, 'RECEIVE', quantity, required(b.reason || '采购入库', '入库原因'), 'receive', lotId, null, locationId);
    audit(req.user!.id, 'inventory.receive', 'lot', lotId, { quantity: fmt(quantity), materialId: material.id, locationId });
  });
  res.status(201).json({ id: lotId, internalLot, quantity: fmt(quantity) });
}));

app.post('/api/inventory/consume', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const lot = lotInfo(required(b.lotId, '批次'));
  assertConsumable(lot as Row);
  const locationId = required(b.locationId, '库位');
  const inputUnit = optional(b.quantityUnit) || lot!.base_unit;
  if (!isUnit(inputUnit, lot!.dimension)) throw new Error(`使用单位“${inputUnit}”未配置或与物料量纲不匹配`);
  const quantity = convertQuantity(positive(b.quantity, '使用数量'), inputUnit, lot!.base_unit, lot!.dimension as Dimension);
  const reason = required(b.reason, '使用目的或项目');
  transaction(() => {
    changeBalance(lot!.id, locationId, -quantity);
    movement(req.user!.id, lot!, 'USE', quantity, reason, 'manual_use', optional(b.sourceId), locationId, null);
    audit(req.user!.id, 'inventory.consume', 'lot', lot!.id, { quantity: fmt(quantity), reason });
  });
  res.json({ ok: true, remaining: fmt(balanceOf(lot!.id, locationId)) });
}));

app.post('/api/inventory/transfer', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const lot = lotInfo(required(b.lotId, '批次'));
  if (!lot) throw new Error('批次不存在');
  const from = required(b.fromLocationId, '原库位');
  const to = required(b.toLocationId, '目标库位');
  if (from === to) throw new Error('原库位与目标库位需不同');
  const inputUnit = optional(b.quantityUnit) || lot.base_unit;
  if (!isUnit(inputUnit, lot.dimension)) throw new Error(`移库单位“${inputUnit}”未配置或与物料量纲不匹配`);
  const quantity = convertQuantity(positive(b.quantity, '移库数量'), inputUnit, lot.base_unit, lot.dimension as Dimension);
  const reason = required(b.reason || '库位调整', '移库原因');
  transaction(() => {
    changeBalance(lot.id, from, -quantity);
    changeBalance(lot.id, to, quantity);
    movement(req.user!.id, lot, 'TRANSFER_OUT', quantity, reason, 'transfer', '', from, to);
    movement(req.user!.id, lot, 'TRANSFER_IN', quantity, reason, 'transfer', '', from, to);
    audit(req.user!.id, 'inventory.transfer', 'lot', lot.id, { quantity: fmt(quantity), from, to });
  });
  res.json({ ok: true });
}));

app.post('/api/inventory/loss', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const lot = lotInfo(required(b.lotId, '批次'));
  if (!lot) throw new Error('批次不存在');
  const locationId = required(b.locationId, '库位');
  const inputUnit = optional(b.quantityUnit) || lot.base_unit;
  if (!isUnit(inputUnit, lot.dimension)) throw new Error(`报损单位“${inputUnit}”未配置或与物料量纲不匹配`);
  const quantity = convertQuantity(positive(b.quantity, '报损数量'), inputUnit, lot.base_unit, lot.dimension as Dimension);
  const reason = required(b.reason, '报损原因');
  transaction(() => {
    changeBalance(lot.id, locationId, -quantity);
    movement(req.user!.id, lot, 'LOSS', quantity, reason, 'loss', '', locationId, null);
    audit(req.user!.id, 'inventory.loss', 'lot', lot.id, { quantity: fmt(quantity), reason });
  });
  res.json({ ok: true });
}));

app.post('/api/inventory/adjust', requireAuth, requireAdmin, route((req, res) => {
  const b = req.body ?? {};
  const lot = lotInfo(required(b.lotId, '批次'));
  if (!lot) throw new Error('批次不存在');
  const locationId = required(b.locationId, '库位');
  const inputUnit = optional(b.quantityUnit) || lot.base_unit;
  if (!isUnit(inputUnit, lot.dimension)) throw new Error(`调整单位“${inputUnit}”未配置或与物料量纲不匹配`);
  const quantity = convertQuantity(positive(b.quantity, '调整数量'), inputUnit, lot.base_unit, lot.dimension as Dimension);
  const direction = enumValue(b.direction, ['increase','decrease'], '盘点方向');
  const reason = required(b.reason, '盘点差异说明');
  transaction(() => {
    const delta = direction === 'increase' ? quantity : -quantity;
    changeBalance(lot.id, locationId, delta);
    movement(req.user!.id, lot, direction === 'increase' ? 'ADJUST_IN' : 'ADJUST_OUT', quantity, reason, 'stocktake', '', direction === 'increase' ? null : locationId, direction === 'increase' ? locationId : null);
    audit(req.user!.id, 'inventory.adjust', 'lot', lot.id, { quantity: fmt(quantity), direction, reason });
  });
  res.json({ ok: true });
}));

app.get('/api/movements', requireAuth, route((req, res) => {
  const q = `%${optional(req.query.q)}%`;
  const rows = db.prepare(`SELECT m.*,mat.name AS material_name,mat.code AS material_code,l.internal_lot,l.expiry_date,
    fl.name AS from_location,tl.name AS to_location,u.name AS actor_name FROM stock_movements m
    JOIN materials mat ON mat.id=m.material_id JOIN inventory_lots l ON l.id=m.lot_id
    LEFT JOIN locations fl ON fl.id=m.from_location_id LEFT JOIN locations tl ON tl.id=m.to_location_id
    JOIN users u ON u.id=m.actor_id WHERE (mat.name LIKE ? OR mat.code LIKE ? OR l.internal_lot LIKE ? OR m.reason LIKE ?)
    ORDER BY m.created_at DESC LIMIT 500`).all(q, q, q, q);
  res.json(rows);
}));

app.get('/api/users', requireAuth, requireAdmin, route((req, res) => res.json(db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY created_at').all())));
app.post('/api/users', requireAuth, requireAdmin, route((req, res) => {
  const b = req.body ?? {};
  const userId = id('usr_');
  const role = enumValue(b.role, ['ADMIN','RESEARCHER'], '角色');
  db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
    .run(userId, required(b.name,'姓名'), required(b.email,'邮箱'), passwordHash(required(b.password,'初始密码')), role);
  audit(req.user!.id, 'user.create', 'user', userId, { email: b.email, role });
  res.status(201).json(db.prepare('SELECT id,name,email,role,active,created_at FROM users WHERE id=?').get(userId));
}));
app.patch('/api/users/:id', requireAuth, requireAdmin, route((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(param(req)) as Row | undefined;
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.user!.id && req.body?.active === false) throw new Error('当前登录管理员不能停用自身');
  const role = req.body?.role ? enumValue(req.body.role, ['ADMIN','RESEARCHER'], '角色') : target.role;
  db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(role, req.body?.active === false ? 0 : 1, target.id);
  audit(req.user!.id, 'user.update', 'user', target.id, { role, active: req.body?.active !== false });
  res.json({ ok: true });
}));

function saveRecipeVersion(recipeId: string, b: Row, actorId: string, version: number) {
  return saveRecipeVersionCore(recipeId, b, actorId, version);
}

app.get('/api/recipes', requireAuth, route((req, res) => {
  const recipes = db.prepare(`SELECT r.*,COALESCE(creator.name,owner.name) AS owner_name,r.created_by AS creator_id FROM recipes r
    LEFT JOIN users creator ON creator.id=r.created_by LEFT JOIN users owner ON owner.id=r.owner_id WHERE r.active=1 ORDER BY r.created_at DESC`).all() as Row[];
  const data = recipes.map(recipe => ({ ...recipe, versions: db.prepare(`SELECT v.*,author.name AS created_by_name,publisher.name AS published_by_name,retirer.name AS retired_by_name
    FROM recipe_versions v LEFT JOIN users author ON author.id=v.created_by LEFT JOIN users publisher ON publisher.id=v.published_by
    LEFT JOIN users retirer ON retirer.id=v.retired_by WHERE v.recipe_id=? ORDER BY v.version DESC`).all(recipe.id) }));
  res.json(data);
}));
app.get('/api/recipe-versions/:id', requireAuth, route((req, res) => {
  const version = db.prepare(`SELECT v.*,r.name AS recipe_name,r.scope,r.owner_id,r.source_type,r.created_by AS recipe_created_by,
    author.name AS created_by_name,publisher.name AS published_by_name,retirer.name AS retired_by_name
    FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id LEFT JOIN users author ON author.id=v.created_by
    LEFT JOIN users publisher ON publisher.id=v.published_by LEFT JOIN users retirer ON retirer.id=v.retired_by WHERE v.id=?`).get(param(req)) as Row | undefined;
  if (!version) return res.status(404).json({ error: '配方版本不存在' });
  const ingredients = db.prepare(`SELECT i.*,m.code AS material_code,m.base_unit AS material_unit,m.dimension AS material_dimension FROM recipe_ingredients i LEFT JOIN materials m ON m.id=i.material_id WHERE i.recipe_version_id=?`).all(version.id);
  res.json({ ...version, ingredients });
}));
app.post('/api/recipes', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const recipeId = id('rcp_');
  enumValue(b.scope || 'team', ['team','personal'], '配方范围');
  const source = enumValue(b.sourceType || 'manual', ['manual','demo','imported','ai_draft'], '来源类型');
  transaction(() => {
    db.prepare('INSERT INTO recipes(id,name,scope,owner_id,source_type,created_by) VALUES (? ,? ,\'team\',?,?,?)')
      .run(recipeId, required(b.name,'配方名称'), req.user!.id, source, req.user!.id);
    saveRecipeVersion(recipeId, b, req.user!.id, 1);
    audit(req.user!.id, 'recipe.create', 'recipe', recipeId, { name: b.name, source });
  });
  res.status(201).json({ id: recipeId });
}));
app.post('/api/recipes/:id/versions', requireAuth, route((req, res) => {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id=? AND active=1').get(param(req)) as Row | undefined;
  if (!recipe) return res.status(404).json({ error: '配方不存在' });
  if (recipe.created_by !== req.user!.id && req.user!.role !== 'ADMIN') return res.status(403).json({ error: '仅配方创建者或管理员可新增版本' });
  const current = Number((db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM recipe_versions WHERE recipe_id=?').get(recipe.id) as Row).n);
  const newVersionId = transaction(() => {
    const versionId = saveRecipeVersion(recipe.id, req.body ?? {}, req.user!.id, current + 1);
    audit(req.user!.id, 'recipe.version.create', 'recipe', recipe.id, { version: current + 1 });
    return versionId;
  });
  res.status(201).json({ id: newVersionId, version: current + 1 });
}));
app.post('/api/recipe-versions/:id/publish', requireAuth, route((req, res) => {
  const version = db.prepare('SELECT v.*,r.scope,r.owner_id FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.id=?').get(param(req)) as Row | undefined;
  if (!version) return res.status(404).json({ error: '配方版本不存在' });
  const recipe = db.prepare('SELECT created_by FROM recipes WHERE id=?').get(version.recipe_id) as Row;
  if (recipe.created_by !== req.user!.id && req.user!.role !== 'ADMIN') return res.status(403).json({ error: '仅配方创建者或管理员可发布版本' });
  if (version.status !== 'draft') throw new Error('仅草稿版本可发布');
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_version_id=?').get(version.id) as Row).n);
  if (!count) throw new Error('配方无组分，不能发布');
  db.prepare(`UPDATE recipe_versions SET status='published',published_by=?,published_at=datetime('now') WHERE id=? AND status='draft'`).run(req.user!.id,version.id);
  audit(req.user!.id, 'recipe.publish', 'recipe_version', version.id);
  res.json({ ok: true });
}));
app.post('/api/recipe-versions/:id/retire', requireAuth, route((req, res) => {
  const version = db.prepare('SELECT v.*,r.scope,r.owner_id FROM recipe_versions v JOIN recipes r ON r.id=v.recipe_id WHERE v.id=?').get(param(req)) as Row | undefined;
  if (!version) return res.status(404).json({ error: '配方版本不存在' });
  const recipe = db.prepare('SELECT created_by FROM recipes WHERE id=?').get(version.recipe_id) as Row;
  if (recipe.created_by !== req.user!.id && req.user!.role !== 'ADMIN') return res.status(403).json({ error: '仅配方创建者或管理员可停用版本' });
  if (version.status !== 'published') throw new Error('仅已发布版本可停用');
  transaction(() => {
    db.prepare("UPDATE recipe_versions SET status='retired',retired_by=?,retired_at=datetime('now') WHERE id=? AND status='published'").run(req.user!.id,version.id);
    audit(req.user!.id, 'recipe.retire', 'recipe_version', version.id, { recipeId: version.recipe_id, version: version.version });
  });
  res.json({ ok: true });
}));

function versionIngredients(versionId: string) {
  return db.prepare(`SELECT i.*,m.base_unit AS material_unit,m.dimension AS material_dimension,m.name AS linked_material_name FROM recipe_ingredients i LEFT JOIN materials m ON m.id=i.material_id WHERE i.recipe_version_id=?`).all(versionId) as Row[];
}
function computed(version: Row, targetVolume: string, targetVolumeUnit = version.base_volume_unit) {
  const ingredients = versionIngredients(version.id) as Ingredient[];
  const result = calculateRecipe(ingredients, targetVolume, version.base_volume, targetVolumeUnit, version.base_volume_unit);
  return result.map((line, index) => {
    const materialUnit = (ingredients[index] as Row).material_unit;
    return { ...line, ingredientId: ingredients[index].id, materialId: ingredients[index].material_id,
      expectedUnit: materialUnit || line.unit, caution: [line.caution,
        ingredients[index].calculation_type === 'stock_dilution' ? '按 C₁V₁=C₂V₂ 计算；配方体积表示待加入母液体积，剩余液体用于定容。' : ''].filter(Boolean).join(' ') };
  });
}
app.post('/api/recipe-versions/:id/calculate', requireAuth, route((req, res) => {
  const version = db.prepare('SELECT * FROM recipe_versions WHERE id=?').get(param(req)) as Row | undefined;
  if (!version) return res.status(404).json({ error: '配方版本不存在' });
  const targetVolume = fmt(positive(req.body?.targetVolume, '目标体积'));
  const targetVolumeUnit = optional(req.body?.targetVolumeUnit) || version.base_volume_unit;
  const lines = computed(version, targetVolume, targetVolumeUnit);
  res.json({ versionId: version.id, version: version.version, baseVolume: version.base_volume, baseVolumeUnit: version.base_volume_unit, targetVolume, targetVolumeUnit, lines,
    operationNotes: ['pH 调整为操作目标，滴定用量需现场记录，不作确定剂量预测。', '含定容步骤时，按容量器具补足至目标体积；添加溶剂体积不等于目标体积。',
      '预置计算仅用于演示，实施前需由企业确认配方来源和适用性。'] });
}));

app.post('/api/calculator/preview', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const baseVolume = fmt(positive(b.baseVolume, '基准产量'));
  const targetVolume = fmt(positive(b.targetVolume, '目标体积'));
  const baseVolumeUnit = required(b.baseVolumeUnit || 'mL', '基准产量单位');
  const targetVolumeUnit = required(b.targetVolumeUnit || baseVolumeUnit, '目标体积单位');
  if (!isUnit(baseVolumeUnit, 'volume') || !isUnit(targetVolumeUnit, 'volume')) throw new Error('基准和目标单位必须是已配置的体积单位');
  const ingredients = Array.isArray(b.ingredients) ? b.ingredients.map((item: Row) => ({
    name: required(item.name, '组分名称'), calculation_type: required(item.calculationType, '计算方式'),
    amount_value: required(item.amountValue, '组分参数'), amount_unit: required(item.amountUnit, '组分单位'),
    stock_concentration: optional(item.stockConcentration), target_concentration: optional(item.targetConcentration),
    molecular_weight: optional(item.molecularWeight), dimension: required(item.dimension, '组分量纲'), notes: optional(item.notes),
  })) as Ingredient[] : [];
  if (!ingredients.length) throw new Error('至少填写一个组分');
  res.json({ baseVolume, baseVolumeUnit, targetVolume, targetVolumeUnit,
    lines: calculateRecipe(ingredients, targetVolume, baseVolume, targetVolumeUnit, baseVolumeUnit) });
}));

function preparationDetail(preparationId: string) {
  const prep = db.prepare(`SELECT p.*,r.name AS recipe_name,v.version,v.output_name,v.output_code,v.output_unit,v.output_dimension,v.storage,
    creator.name AS created_by_name,executor.name AS completed_by_name,aborter.name AS aborted_by_name,
    CASE WHEN p.status='planned' THEN COALESCE(creator.name,'历史未记录') WHEN p.status='aborted' THEN COALESCE(aborter.name,'历史未记录') ELSE COALESCE(executor.name,'历史未记录') END AS performer
    FROM preparations p JOIN recipe_versions v ON v.id=p.recipe_version_id
    JOIN recipes r ON r.id=v.recipe_id LEFT JOIN users creator ON creator.id=p.created_by LEFT JOIN users executor ON executor.id=p.completed_by
    LEFT JOIN users aborter ON aborter.id=p.aborted_by WHERE p.id=?`).get(preparationId) as Row | undefined;
  if (!prep) return undefined;
  const usages = db.prepare(`SELECT u.*,l.internal_lot,l.manufacturer_lot,m.name AS material_name,loc.name AS location_name
    FROM preparation_ingredient_usage u JOIN inventory_lots l ON l.id=u.lot_id JOIN materials m ON m.id=l.material_id
    JOIN locations loc ON loc.id=u.location_id WHERE u.preparation_id=?`).all(prep.id);
  const steps = db.prepare('SELECT * FROM preparation_steps WHERE preparation_id=? ORDER BY step_no').all(prep.id);
  const product = db.prepare(`SELECT l.*,b.quantity,loc.name AS location_name FROM inventory_lots l JOIN stock_balances b ON b.lot_id=l.id
    JOIN locations loc ON loc.id=b.location_id WHERE l.source_preparation_id=?`).get(prep.id);
  return { ...prep, theoretical: JSON.parse(prep.theoretical_snapshot), usages, steps, product };
}
app.get('/api/preparations', requireAuth, route((req, res) => {
  const status = optional(req.query.status);
  const rows = db.prepare(`SELECT p.*,r.name AS recipe_name,v.version,creator.name AS created_by_name,executor.name AS completed_by_name,aborter.name AS aborted_by_name,
    CASE WHEN p.status='planned' THEN COALESCE(creator.name,'历史未记录') WHEN p.status='aborted' THEN COALESCE(aborter.name,'历史未记录') ELSE COALESCE(executor.name,'历史未记录') END AS performer FROM preparations p
    JOIN recipe_versions v ON v.id=p.recipe_version_id JOIN recipes r ON r.id=v.recipe_id
    LEFT JOIN users creator ON creator.id=p.created_by LEFT JOIN users executor ON executor.id=p.completed_by LEFT JOIN users aborter ON aborter.id=p.aborted_by
    WHERE (?='' OR p.status=?) ORDER BY p.created_at DESC LIMIT 300`).all(status, status);
  res.json(rows);
}));
app.post('/api/preparations', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const prepId = transaction(() => createPreparationDraft(required(b.recipeVersionId,'配方版本'), b.targetVolume, b.targetVolumeUnit, req.user!.id));
  res.status(201).json(preparationDetail(prepId));
}));
app.get('/api/preparations/:id', requireAuth, route((req, res) => {
  const detail = preparationDetail(param(req));
  if (!detail) return res.status(404).json({ error: '配液记录不存在' });
  res.json(detail);
}));

function allocationPreview(prep: Row, actuals: Row[], requireQuantities: boolean,
  options: { requireAllIngredients?: boolean; requireFullShare?: boolean } = {}) {
  const requireAllIngredients = options.requireAllIngredients !== false;
  const requireFullShare = options.requireFullShare !== false;
  const theoretical = JSON.parse(prep.theoretical_snapshot);
  const recipeIngredients = versionIngredients(prep.recipe_version_id) as Row[];
  if (!actuals.length && requireAllIngredients) throw new Error('请至少选择一个实际原料批次');
  const grouped = new Map<string, Row[]>();
  actuals.forEach((item, rowIndex) => {
    const key = required(item.ingredientId, '配方组分');
    grouped.set(key, [...(grouped.get(key) || []), { ...item, _rowIndex:rowIndex }]);
  });
  const checked: Row[] = [];
  for (const ingredient of recipeIngredients) {
    const rows = grouped.get(String(ingredient.id)) || [];
    if (!rows.length) {
      if (requireAllIngredients) throw new Error(`缺少组分“${ingredient.name}”的批次分配`);
      continue;
    }
    const shares = rows.map((item, index) => {
      const value = optional(item.sharePercent) || (rows.length === 1 ? '100' : '');
      if (!value) throw new Error(`组分“${ingredient.name}”拆分到多个批次时，每行都要填写目标组分分配百分比`);
      const parsed = positive(value, `${ingredient.name}分配百分比`);
      if (parsed > decimal('100')) throw new Error(`${ingredient.name}分配百分比不能超过 100%`);
      return parsed;
    });
    if (requireFullShare && shares.reduce((sum, value) => add(sum, value), 0n) !== decimal('100')) throw new Error(`组分“${ingredient.name}”的批次分配百分比合计必须为 100%`);
    rows.forEach((item, index) => {
      const lot = lotInfo(required(item.lotId, '原料批次'));
      assertConsumable(lot as Row);
      if (!ingredient.material_id || lot!.material_id !== ingredient.material_id) throw new Error(`批次 ${lot!.internal_lot} 与组分“${ingredient.name}”物料不匹配`);
      const locationId = required(item.locationId, '消耗库位');
      if (!db.prepare('SELECT 1 FROM stock_balances WHERE lot_id=? AND location_id=?').get(lot!.id, locationId)) throw new Error(`批次 ${lot!.internal_lot} 在所选库位没有库存记录`);
      const rawLine = theoretical.lines.find((line: Row) => line.ingredientId === ingredient.id);
      if (!rawLine) throw new Error(`配方快照缺少组分“${ingredient.name}”的计算结果`);
      let expected: bigint;
      let expectedUnit = lot!.base_unit;
      let batchConcentration = '';
      let batchConcentrationUnit = '';
      if (ingredient.calculation_type === 'stock_dilution') {
        batchConcentration = optional(lot!.concentration);
        batchConcentrationUnit = optional(lot!.concentration_unit);
        if (!batchConcentration || !batchConcentrationUnit) throw new Error(`母液批次 ${lot!.internal_lot} 缺少浓度及单位，无法复核用量`);
        positive(batchConcentration, '母液批次浓度');
        const line = calculateIngredient(ingredient as Ingredient, prep.target_volume, prep.base_volume,
          prep.target_volume_unit, prep.base_volume_unit, { value: batchConcentration, unit: batchConcentrationUnit, share: fmt(shares[index]) });
        expected = decimal(line.quantity, `${ingredient.name}批次理论用量`);
        expectedUnit = line.unit;
      } else {
        const line = calculateIngredient(ingredient as Ingredient, prep.target_volume, prep.base_volume,
          prep.target_volume_unit, prep.base_volume_unit);
        expected = roundDiv(decimal(line.quantity) * shares[index], decimal('100'));
        expectedUnit = line.unit;
      }
      if (expectedUnit !== lot!.base_unit) throw new Error(`组分“${ingredient.name}”计算单位 ${expectedUnit} 与批次库存单位 ${lot!.base_unit} 不一致`);
      let quantity = 0n;
      if (requireQuantities || optional(item.quantity)) {
        const inputUnit = optional(item.unit) || lot!.base_unit;
        if (!isUnit(inputUnit, lot!.dimension)) throw new Error(`实际用量单位“${inputUnit}”未配置或与物料量纲不匹配`);
        quantity = convertQuantity(positive(item.quantity, '实际消耗量'), inputUnit, lot!.base_unit, lot!.dimension as Dimension);
      }
      checked.push({ ingredient, lot, locationId, quantity, expected, expectedUnit, share: shares[index],
        batchConcentration, batchConcentrationUnit, rowIndex: item._rowIndex, original: item, theoretical: rawLine.quantity });
    });
  }
  return checked;
}

app.post('/api/preparations/:id/preview', requireAuth, route((req, res) => {
  const prep = db.prepare('SELECT p.*,v.base_volume,v.base_volume_unit FROM preparations p JOIN recipe_versions v ON v.id=p.recipe_version_id WHERE p.id=?').get(param(req)) as Row | undefined;
  if (!prep) return res.status(404).json({ error: '配液记录不存在' });
  if (prep.status !== 'planned') throw new Error('仅待执行任务可预览批次计算');
  const actuals = Array.isArray(req.body?.actuals) ? req.body.actuals as Row[] : [];
  if (!actuals.length) return res.json({ rows: [], lines: JSON.parse(prep.theoretical_snapshot).lines });
  const rows = allocationPreview(prep, actuals, false).map(item => ({ rowIndex:item.rowIndex, ingredientId: item.ingredient.id, lotId: item.lot.id,
    expectedQuantity: fmt(item.expected), expectedUnit: item.expectedUnit, sharePercent: fmt(item.share),
    batchConcentration: item.batchConcentration, batchConcentrationUnit: item.batchConcentrationUnit,
    method: item.ingredient.calculation_type === 'stock_dilution' ? '按所选批次浓度重新计算' : '按配方用量按分配比例拆分' }));
  res.json({ rows, rule: '拆分到多批次时先按目标有效组分量分配百分比，总和必须为 100%；母液用量再按各批次浓度分别计算。' });
}));

app.post('/api/preparations/:id/complete', requireAuth, route((req, res) => {
  const b = req.body ?? {};
  const prepId = required(param(req), '配液任务');
  const prep = db.prepare(`SELECT p.*,v.output_name,v.output_code,v.output_unit,v.output_dimension,v.base_volume,v.base_volume_unit
    FROM preparations p JOIN recipe_versions v ON v.id=p.recipe_version_id WHERE p.id=?`).get(prepId) as Row | undefined;
  if (!prep) return res.status(404).json({ error: '配液记录不存在' });
  const idempotencyKey = required(b.idempotencyKey, '提交编号');
  if (prep.status === 'completed') {
    if (prep.idempotency_key === idempotencyKey) return res.json({ ...preparationDetail(prepId), alreadyCompleted: true });
    return res.status(409).json({ error: '配液已完成，未再次扣减库存' });
  }
  if (prep.status !== 'planned') throw new Error('只有待执行配液任务可完成');
  const actuals = Array.isArray(b.actuals) ? b.actuals as Row[] : [];
  const checked = allocationPreview(prep, actuals, true);
  const deviated = checked.some(item => item.quantity !== item.expected);
  const deviationReason = optional(b.deviationReason || b.deviation);
  if (deviated && (b.confirmDeviation !== true || !deviationReason)) throw new Error('实际用量与按所选批次计算的理论用量不一致；请核对后勾选确认并填写偏差原因');
  const immediateUse = b.immediateUse === true;
  const immediateUseReason = immediateUse ? required(b.immediateUseReason, '立即使用说明') : '';
  let outputQuantity: bigint;
  if (optional(b.outputQuantity)) {
    const outputInputUnit = optional(b.outputQuantityUnit) || prep.output_unit;
    if (!isUnit(outputInputUnit, prep.output_dimension)) throw new Error(`产物数量单位“${outputInputUnit}”未配置或与产物量纲不匹配`);
    outputQuantity = convertQuantity(positive(b.outputQuantity, '产物数量'), outputInputUnit, prep.output_unit, prep.output_dimension as Dimension);
  } else if (prep.output_dimension === 'volume') {
    outputQuantity = convertQuantity(decimal(prep.target_volume), prep.target_volume_unit, prep.output_unit, 'volume');
  } else throw new Error('非体积产物需明确填写实际产量');
  const outputLocationId = required(b.outputLocationId, '产物入库库位');
  if (!db.prepare('SELECT id FROM locations WHERE id=? AND active=1').get(outputLocationId)) throw new Error('产物入库库位不存在或已停用');
  const steps = Array.isArray(b.steps) ? b.steps as Row[] : [];
  let outputLotId = '';
  transaction(() => {
    const current = db.prepare('SELECT status,idempotency_key FROM preparations WHERE id=?').get(prepId) as Row;
    if (current.status === 'completed' && current.idempotency_key === idempotencyKey) return;
    if (current.status !== 'planned') throw new Error('配液状态已变化，请刷新后确认');
    for (const item of checked) {
      changeBalance(item.lot.id, item.locationId, -(item.quantity as bigint));
      movement(req.user!.id, item.lot, 'PREPARATION_USE', item.quantity, `配液 ${prep.code}`, 'preparation', prepId, item.locationId, null);
      db.prepare(`INSERT INTO preparation_ingredient_usage(id,preparation_id,ingredient_name,lot_id,location_id,theoretical_quantity,actual_quantity,unit,batch_concentration,batch_concentration_unit,allocation_share)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id('use_'), prepId, item.ingredient.name, item.lot.id, item.locationId, fmt(item.expected), fmt(item.quantity), item.lot.base_unit,
          item.batchConcentration, item.batchConcentrationUnit, fmt(item.share));
    }
    let outputMaterial = db.prepare('SELECT * FROM materials WHERE code=?').get(prep.output_code) as Row | undefined;
    if (outputMaterial && (outputMaterial.base_unit !== prep.output_unit || outputMaterial.dimension !== prep.output_dimension)) throw new Error('同编号产物物料的单位或量纲不匹配');
    if (!outputMaterial) {
      const materialId = id('mat_');
      db.prepare(`INSERT INTO materials(id,code,name,category,dimension,base_unit,notes,is_product) VALUES (?,?,?,'自制试剂',?,?,?,1)`)
        .run(materialId, prep.output_code, prep.output_name, prep.output_dimension, prep.output_unit, `由配液记录 ${prep.code} 建立`);
      outputMaterial = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId) as Row;
    }
    outputLotId = id('lot_');
    const internalLot = `SELF-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${outputLotId.slice(-8).toUpperCase()}`;
    db.prepare(`INSERT INTO inventory_lots(id,material_id,manufacturer_lot,internal_lot,expiry_date,concentration,concentration_unit,purity,status,source_preparation_id,notes)
      VALUES (?,?,?, ?,?,?,?,?, 'active',?,?)`).run(outputLotId, outputMaterial.id, '', internalLot, optional(b.outputExpiryDate) || null,
        optional(b.outputConcentration), optional(b.outputConcentrationUnit), '', prepId, optional(b.outputNotes));
    changeBalance(outputLotId, outputLocationId, outputQuantity);
    movement(req.user!.id, { id: outputLotId, material_id: outputMaterial.id }, 'RECEIVE', outputQuantity, `配液 ${prep.code} 产物入库`, 'preparation', prepId, null, outputLocationId);
    if (immediateUse) {
      changeBalance(outputLotId, outputLocationId, -outputQuantity);
      movement(req.user!.id, { id: outputLotId, material_id: outputMaterial.id }, 'USE', outputQuantity,
        `配液 ${prep.code} 立即使用：${immediateUseReason}`, 'preparation_immediate_use', prepId, outputLocationId, null);
    }
    for (const step of steps) {
      const stepNo = Number(step.stepNo);
      if (!Number.isInteger(stepNo) || stepNo < 1) throw new Error('配制步骤编号无效');
      db.prepare(`UPDATE preparation_steps SET result=?,performed_at=datetime('now') WHERE preparation_id=? AND step_no=?`)
        .run(optional(step.result), prepId, stepNo);
    }
    db.prepare(`UPDATE preparations SET status='completed',output_quantity=?,output_unit=?,measured_ph=?,deviation=?,deviation_confirmed=?,completed_by=?,
      immediate_use=?,immediate_use_reason=?,idempotency_key=?,completed_at=datetime('now') WHERE id=? AND status='planned'`)
      .run(fmt(outputQuantity), prep.output_unit, optional(b.measuredPh), deviationReason, deviated ? 1 : 0, req.user!.id,
        immediateUse ? 1 : 0, immediateUseReason, idempotencyKey, prepId);
    audit(req.user!.id, 'preparation.complete', 'preparation', prepId, { outputLotId, outputQuantity: fmt(outputQuantity), actualRows: checked.length,
      deviationConfirmed: deviated, immediateUse, deviationReason });
  });
  res.json(preparationDetail(prepId));
}));

app.post('/api/preparations/:id/abort', requireAuth, route((req, res) => {
  const prep = db.prepare(`SELECT p.*,v.base_volume,v.base_volume_unit FROM preparations p
    JOIN recipe_versions v ON v.id=p.recipe_version_id WHERE p.id=?`).get(param(req)) as Row | undefined;
  if (!prep) return res.status(404).json({ error: '配液记录不存在' });
  if (prep.status !== 'planned') throw new Error('仅待执行任务可中止');
  const actuals = Array.isArray(req.body?.actuals) ? req.body.actuals as Row[] : [];
  const checked = allocationPreview(prep, actuals, true, { requireAllIngredients: false, requireFullShare: false });
  transaction(() => {
    for (const item of checked) {
      changeBalance(item.lot.id, item.locationId, -(item.quantity as bigint));
      movement(req.user!.id, item.lot, 'PREPARATION_USE', item.quantity, `中止配液 ${prep.code}`, 'preparation_abort', prep.id, item.locationId, null);
      db.prepare(`INSERT INTO preparation_ingredient_usage(id,preparation_id,ingredient_name,lot_id,location_id,theoretical_quantity,actual_quantity,unit,
        batch_concentration,batch_concentration_unit,allocation_share)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id('use_'), prep.id, item.ingredient.name, item.lot.id, item.locationId, fmt(item.expected), fmt(item.quantity), item.lot.base_unit,
          item.batchConcentration, item.batchConcentrationUnit, fmt(item.share));
    }
    db.prepare(`UPDATE preparations SET status='aborted',deviation=?,aborted_by=?,aborted_at=datetime('now') WHERE id=? AND status='planned'`)
      .run(optional(req.body?.reason), req.user!.id, prep.id);
    audit(req.user!.id, 'preparation.abort', 'preparation', prep.id, { consumedRows: checked.length, actuals: checked.map(item => ({
      ingredientId:item.ingredient.id,lotId:item.lot.id,locationId:item.locationId,quantity:fmt(item.quantity),unit:item.lot.base_unit,
      batchConcentration:item.batchConcentration,batchConcentrationUnit:item.batchConcentrationUnit,allocationShare:fmt(item.share),
    })) });
  });
  res.json(preparationDetail(prep.id));
}));

app.post('/api/preparations/:id/correct', requireAuth, route((req, res) => {
  const prep = db.prepare('SELECT * FROM preparations WHERE id=?').get(param(req)) as Row | undefined;
  if (!prep) return res.status(404).json({ error: '配液记录不存在' });
  if (prep.status !== 'completed') throw new Error('仅已完成配液可做冲销更正');
  const reason = required(req.body?.reason, '更正原因');
  const productLots = db.prepare('SELECT * FROM inventory_lots WHERE source_preparation_id=?').all(prep.id) as Row[];
  if (!productLots.length) throw new Error('未找到产物批次');
  for (const product of productLots) {
    const downstream = db.prepare('SELECT COUNT(*) AS n FROM preparation_ingredient_usage u WHERE u.lot_id=?').get(product.id) as Row;
    const directUses = db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE lot_id=? AND movement_type IN ('USE','LOSS')").get(product.id) as Row;
    if (Number(downstream.n) + Number(directUses.n) > 0) throw new Error('产物批次已有后续消耗，无法整单冲销；请按批次登记库存调整并保留说明');
  }
  const usages = db.prepare('SELECT * FROM preparation_ingredient_usage WHERE preparation_id=?').all(prep.id) as Row[];
  transaction(() => {
    const current = db.prepare('SELECT status FROM preparations WHERE id=?').get(prep.id) as Row;
    if (current.status !== 'completed') throw new Error('配液状态已变化，请刷新后确认');
    for (const usage of usages) {
      const lot = lotInfo(String(usage.lot_id));
      if (!lot) throw new Error('原始消耗批次缺失，冲销已取消');
      const quantity = positive(usage.actual_quantity, '原消耗量');
      changeBalance(lot.id, String(usage.location_id), quantity);
      movement(req.user!.id, lot, 'REVERSAL', quantity, `冲销配液 ${prep.code}：${reason}`, 'preparation_correction', prep.id, null, String(usage.location_id));
    }
    for (const product of productLots) {
      const balances = db.prepare('SELECT * FROM stock_balances WHERE lot_id=?').all(product.id) as Row[];
      const total = balances.reduce((sum,row)=>add(sum,decimal(row.quantity)),0n);
      if (total !== positive(prep.output_quantity,'产物数量')) throw new Error('产物批次余额已变动，无法整单冲销');
      for (const balance of balances) {
        const quantity=nonNegative(balance.quantity,'产物余额');
        if (quantity === 0n) continue;
        changeBalance(product.id,String(balance.location_id),-quantity);
        movement(req.user!.id,{id:product.id,material_id:product.material_id},'REVERSAL',quantity,`冲销配液 ${prep.code}：${reason}`,'preparation_correction',prep.id,String(balance.location_id),null);
      }
      db.prepare("UPDATE inventory_lots SET status='disabled' WHERE id=?").run(product.id);
    }
    db.prepare("UPDATE preparations SET status='corrected',correction_note=? WHERE id=? AND status='completed'").run(reason,prep.id);
    audit(req.user!.id,'preparation.correct','preparation',prep.id,{reason,restoredInputRows:usages.length});
  });
  res.json(preparationDetail(prep.id));
}));

app.get('/api/lots', requireAuth, route((req, res) => {
  const q = `%${optional(req.query.q)}%`;
  const rows = db.prepare(`SELECT lot.*,m.name AS material_name,m.code AS material_code,m.base_unit,m.dimension,b.quantity,loc.name AS location_name,loc.id AS location_id
    FROM inventory_lots lot JOIN materials m ON m.id=lot.material_id JOIN stock_balances b ON b.lot_id=lot.id
    JOIN locations loc ON loc.id=b.location_id WHERE (m.name LIKE ? OR m.code LIKE ? OR lot.internal_lot LIKE ? OR lot.manufacturer_lot LIKE ?)
    ORDER BY lot.expiry_date IS NULL,lot.expiry_date,lot.internal_lot`).all(q,q,q,q);
  res.json(rows);
}));
app.patch('/api/lots/:id/status', requireAuth, requireAdmin, route((req, res) => {
  const lot = db.prepare('SELECT * FROM inventory_lots WHERE id=?').get(param(req)) as Row | undefined;
  if (!lot) return res.status(404).json({ error: '批次不存在' });
  const status = enumValue(req.body?.status,['active','quarantined','disabled'],'批次状态');
  const reason = required(req.body?.reason,'状态变更原因');
  if (status === 'active' && lot.expiry_date && lot.expiry_date < new Date().toISOString().slice(0,10)) throw new Error('已过期批次不能恢复为可用状态');
  db.prepare('UPDATE inventory_lots SET status=? WHERE id=?').run(status,lot.id);
  audit(req.user!.id,'lot.status.change','lot',lot.id,{from:lot.status,to:status,reason});
  res.json({ok:true});
}));
app.get('/api/trace/lots/:id', requireAuth, route((req, res) => {
  const root = lotInfo(param(req));
  if (!root) return res.status(404).json({ error: '批次不存在' });
  const rootBalances = db.prepare('SELECT quantity FROM stock_balances WHERE lot_id=?').all(root.id) as Row[];
  root.quantity = fmt(rootBalances.reduce((sum,row)=>add(sum,decimal(row.quantity)),0n));
  const upstream: Row[] = [];
  const downstream: Row[] = [];
  const visitedUp = new Set<string>();
  const visitedDown = new Set<string>();
  const followUp = (lot: Row, level: number) => {
    if (!lot.source_preparation_id || level > 12 || visitedUp.has(lot.source_preparation_id)) return;
    visitedUp.add(lot.source_preparation_id);
    const prep = preparationDetail(lot.source_preparation_id);
    if (!prep) return;
    upstream.push({ level, lot: { id: lot.id, internalLot: lot.internal_lot, material: lot.material_name }, preparation: prep });
    for (const usage of prep.usages) {
      const source = lotInfo(String(usage.lot_id));
      if (source) followUp(source, level + 1);
    }
  };
  const followDown = (lot: Row, level: number) => {
    if (level > 12 || visitedDown.has(lot.id)) return;
    visitedDown.add(lot.id);
    const rows = db.prepare(`SELECT p.id FROM preparation_ingredient_usage u JOIN preparations p ON p.id=u.preparation_id
      WHERE u.lot_id=? AND p.status='completed'`).all(lot.id) as Row[];
    for (const row of rows) {
      const prep = preparationDetail(row.id);
      if (!prep) continue;
      const products = db.prepare('SELECT * FROM inventory_lots WHERE source_preparation_id=?').all(row.id) as Row[];
      for (const product of products) {
        downstream.push({ level, sourceLot: { id: lot.id, internalLot: lot.internal_lot, material: lot.material_name }, preparation: prep,
          productLot: { id: product.id, internalLot: product.internal_lot, material: lotInfo(product.id)?.material_name } });
        followDown(lotInfo(String(product.id))!, level + 1);
      }
    }
  };
  followUp(root, 0);
  followDown(root, 0);
  const uses = db.prepare(`SELECT m.*,u.name AS actor_name FROM stock_movements m JOIN users u ON u.id=m.actor_id WHERE m.lot_id=? AND m.movement_type='USE' ORDER BY m.created_at DESC`).all(root.id);
  res.json({ lot: root, upstream, downstream, directUses: uses });
}));

app.get('/api/reports/usage', requireAuth, route((req, res) => {
  const from = optional(req.query.from) || '1970-01-01';
  const to = optional(req.query.to) || '2999-12-31';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('日期需使用 YYYY-MM-DD');
  const outflows = db.prepare(`SELECT m.*,mat.name AS material_name,mat.code AS material_code,mat.base_unit,l.internal_lot,
    u.name AS actor_name,p.code AS preparation_code FROM stock_movements m JOIN materials mat ON mat.id=m.material_id
    JOIN inventory_lots l ON l.id=m.lot_id JOIN users u ON u.id=m.actor_id LEFT JOIN preparations p ON p.id=m.source_id AND m.source_type LIKE 'preparation%'
    WHERE date(m.created_at) BETWEEN ? AND ? AND m.movement_type IN ('USE','LOSS','PREPARATION_USE','ADJUST_OUT') ORDER BY m.created_at DESC`).all(from,to) as Row[];
  const reversals = db.prepare(`SELECT m.*,mat.name AS material_name,mat.code AS material_code,mat.base_unit,l.internal_lot,
    u.name AS correcting_actor_name FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN inventory_lots l ON l.id=m.lot_id
    JOIN users u ON u.id=m.actor_id WHERE date(m.created_at) BETWEEN ? AND ? AND m.movement_type='REVERSAL'
      AND m.source_type='preparation_correction' ORDER BY m.created_at DESC`).all(from,to) as Row[];
  const originalPrepUses = db.prepare(`SELECT m.source_id,m.lot_id,m.material_id,m.actor_id,m.reason,u.name AS actor_name,p.code AS preparation_code
    FROM stock_movements m JOIN users u ON u.id=m.actor_id LEFT JOIN preparations p ON p.id=m.source_id
    WHERE m.movement_type='PREPARATION_USE' AND m.source_type='preparation'`).all() as Row[];
  const originalMap = new Map<string, Row>();
  for (const original of originalPrepUses) originalMap.set(`${original.source_id}|${original.lot_id}`, original);
  const signedRows: Row[] = ([
    ...outflows.map(row => ({ ...row, event_kind: 'consumption', signed_quantity: fmt(decimal(row.quantity)) })),
    ...reversals.flatMap(row => {
      const original = originalMap.get(`${row.source_id}|${row.lot_id}`);
      return original ? [{ ...row, actor_id: original.actor_id, actor_name: original.actor_name, reason: original.reason,
        preparation_code: original.preparation_code, event_kind: 'reversal', signed_quantity: fmt(-decimal(row.quantity)) }] : [];
    }),
  ] as Row[]).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  const newGroup = (data: Row) => ({ ...data, grossQuantity: '0', reversalQuantity: '0', netQuantity: '0', quantity: '0', records: 0 });
  const byMaterial = new Map<string, Row>();
  const byUser = new Map<string, Row>();
  const byProject = new Map<string, Row>();
  for (const row of signedRows) {
    const keyByMaterial = `${row.material_id}|${row.base_unit}`;
    const keyByUser = `${row.actor_id}|${row.material_id}|${row.base_unit}`;
    const project = row.reason || '未注明';
    const keyByProject = `${project}|${row.material_id}|${row.base_unit}`;
    const groups: Array<[Map<string, Row>, string, Row]> = [
      [byMaterial, keyByMaterial, { material_id: row.material_id, material_name: row.material_name, material_code: row.material_code, unit: row.base_unit }],
      [byUser, keyByUser, { user_id: row.actor_id, actor_name: row.actor_name, material_id: row.material_id, material_name: row.material_name, material_code: row.material_code, unit: row.base_unit }],
      [byProject, keyByProject, { project, material_id: row.material_id, material_name: row.material_name, material_code: row.material_code, unit: row.base_unit }],
    ];
    for (const [map,key,data] of groups) {
      const group = map.get(key) || newGroup(data);
      if (row.event_kind === 'reversal') group.reversalQuantity = fmt(add(decimal(group.reversalQuantity), decimal(row.quantity)));
      else group.grossQuantity = fmt(add(decimal(group.grossQuantity), decimal(row.quantity)));
      group.netQuantity = fmt(sub(decimal(group.grossQuantity), decimal(group.reversalQuantity)));
      group.quantity = group.netQuantity;
      group.records += 1;
      map.set(key,group);
    }
  }
  res.json({ from, to, rows: signedRows,
    byMaterial: [...byMaterial.values()], byUser: [...byUser.values()], byProject: [...byProject.values()] });
}));

function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
app.get('/api/export/movements.csv', requireAuth, route((req, res) => {
  const rows = db.prepare(`SELECT m.created_at,m.movement_type,mat.code AS material_code,mat.name AS material_name,l.internal_lot,m.quantity,mat.base_unit,
    fl.name AS from_location,tl.name AS to_location,m.reason,m.source_type,m.source_id,u.name AS actor_name
    FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN inventory_lots l ON l.id=m.lot_id
    LEFT JOIN locations fl ON fl.id=m.from_location_id LEFT JOIN locations tl ON tl.id=m.to_location_id JOIN users u ON u.id=m.actor_id ORDER BY m.created_at DESC`).all() as Row[];
  const columns = ['created_at','movement_type','material_code','material_name','internal_lot','quantity','base_unit','from_location','to_location','reason','source_type','source_id','actor_name'];
  const csv = '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ivd-stock-movements-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
}));
app.get('/api/export/movements.xlsx', requireAuth, route(async (_req, res) => {
  const rows = db.prepare(`SELECT m.created_at,m.movement_type,mat.code AS material_code,mat.name AS material_name,l.internal_lot,m.quantity,mat.base_unit,
    fl.name AS from_location,tl.name AS to_location,m.reason,m.source_type,m.source_id,u.name AS actor_name
    FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN inventory_lots l ON l.id=m.lot_id
    LEFT JOIN locations fl ON fl.id=m.from_location_id LEFT JOIN locations tl ON tl.id=m.to_location_id JOIN users u ON u.id=m.actor_id ORDER BY m.created_at DESC`).all() as Row[];
  const columns = ['created_at','movement_type','material_code','material_name','internal_lot','quantity','base_unit','from_location','to_location','reason','source_type','source_id','actor_name'];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('库存流水');
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(columns.map(column => row[column] ?? ''));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state:'frozen', ySplit:1 }];
  const bytes = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ivd-stock-movements-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(Buffer.from(bytes));
}));
app.get('/api/export/materials.csv', requireAuth, route((req,res)=>{
  const rows=db.prepare('SELECT code,name,category,dimension,base_unit,specification,manufacturer,default_supplier,min_stock,notes FROM materials WHERE active=1 ORDER BY code').all() as Row[];
  const columns=['code','name','category','dimension','base_unit','specification','manufacturer','default_supplier','min_stock','notes'];
  const csv='\uFEFF'+[columns.join(','),...rows.map(row=>columns.map(column=>csvCell(row[column])).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="ivd-materials-${new Date().toISOString().slice(0,10)}.csv"`);res.send(csv);
}));
app.get('/api/export/materials.xlsx', requireAuth, route(async (_req,res)=>{
  const rows=db.prepare('SELECT code,name,category,dimension,base_unit,specification,manufacturer,default_supplier,min_stock,notes FROM materials WHERE active=1 ORDER BY code').all() as Row[];
  const columns=['code','name','category','dimension','base_unit','specification','manufacturer','default_supplier','min_stock','notes'];
  const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('物料档案');sheet.addRow(columns);for(const row of rows)sheet.addRow(columns.map(column=>row[column]??''));sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];
  const bytes=await workbook.xlsx.writeBuffer();res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="ivd-materials-${new Date().toISOString().slice(0,10)}.xlsx"`);res.send(Buffer.from(bytes));
}));

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i=0; i<source.length; i++) {
    const char = source[i];
    if (quoted && char === '"' && source[i+1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(cell); cell=''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && source[i+1] === '\n') i++;
      row.push(cell); cell='';
      if (row.some(value => value.trim())) rows.push(row);
      row=[];
    } else cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function validateMaterialImport(rows: string[][]) {
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一条数据');
  const header = rows[0].map(x => x.trim());
  const requiredColumns = ['code','name','category','dimension','base_unit'];
  for (const column of requiredColumns) if (!header.includes(column)) throw new Error(`缺少列：${column}`);
  const seen = new Set<string>();
  return rows.slice(1).map((line, index) => {
    const item = Object.fromEntries(header.map((name, col) => [name, line[col] ?? ''])) as Row;
    const errors: string[] = [];
    let normalized: ReturnType<typeof normalizeMaterialDraft> | undefined;
    try {
      normalized = normalizeMaterialDraft(item);
    } catch (error) {
      errors.push((error as Error).message);
    }
    const code = normalized?.code ?? optional(item.code);
    if (code && seen.has(code)) errors.push('文件内编号重复');
    if (code) seen.add(code);
    if (code && db.prepare('SELECT id FROM materials WHERE code=?').get(code)) errors.push('系统中已存在此编号');
    return { row: index + 2, data: normalized ? { ...item, ...normalized, base_unit:normalized.baseUnit, default_supplier:normalized.supplier } : item, errors };
  });
}
app.post('/api/import/materials/preview', requireAuth, requireAdmin, route((req, res) => {
  const text = required(req.body?.csv, 'CSV 内容');
  if (Buffer.byteLength(text, 'utf8') > 2_000_000) throw new Error('CSV 文件不超过 2 MB');
  const validated = validateMaterialImport(parseCsv(text));
  res.json({ rows: validated, validCount: validated.filter(row => !row.errors.length).length, errorCount: validated.filter(row => row.errors.length).length,
    columns: ['code','name','category','dimension','base_unit','specification','manufacturer','default_supplier','min_stock','notes'] });
}));
app.post('/api/import/materials/commit', requireAuth, requireAdmin, route((req, res) => {
  const text = required(req.body?.csv, 'CSV 内容');
  const validated = validateMaterialImport(parseCsv(text));
  const errors = validated.filter(row => row.errors.length);
  if (errors.length) return res.status(422).json({ error: '导入校验未通过，未写入任何数据', rows: errors });
  transaction(() => {
    for (const row of validated) {
      const item = row.data;
      db.prepare(`INSERT INTO materials(id,code,name,category,dimension,base_unit,specification,manufacturer,default_supplier,min_stock,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id('mat_'), item.code.trim(), item.name.trim(), item.category.trim(), item.dimension,
        item.baseUnit, item.specification, item.manufacturer, item.supplier, item.minStock, item.notes);
    }
    audit(req.user!.id, 'materials.import', 'material', '', { count: validated.length });
  });
  res.json({ imported: validated.length });
}));

const allowedFiles = new Set(['application/pdf','image/png','image/jpeg','image/webp','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => {
  if (!allowedFiles.has(file.mimetype)) return callback(new Error('附件仅支持 PDF、PNG、JPEG、WebP、CSV 或 XLSX'));
  callback(null, true);
} });
app.post('/api/import/materials/file-preview', requireAuth, requireAdmin, upload.single('file'), route(async (req,res)=>{
  const file=(req as Request&{file?:Express.Multer.File}).file;
  if(!file)throw new Error('请选择 CSV 或 XLSX 文件');
  let rows:string[][];
  if(path.extname(file.originalname).toLowerCase()==='.xlsx'){
    const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const sheet=workbook.worksheets[0];
    if(!sheet)throw new Error('工作簿没有可读取的工作表');
    rows=[];
    sheet.eachRow({includeEmpty:false},row=>{
      const values=(row.values as any[]).slice(1).map(value=>{
        if(value&&typeof value==='object')return String(value.text??value.result??value.richText?.map((part:any)=>part.text).join('')??'');
        return String(value??'');
      });
      rows.push(values);
    });
  }else rows=parseCsv(file.buffer.toString('utf8'));
  const validated=validateMaterialImport(rows);
  const normalizedCsv=rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
  res.json({rows:validated,validCount:validated.filter(row=>!row.errors.length).length,errorCount:validated.filter(row=>row.errors.length).length,
    columns:['code','name','category','dimension','base_unit','specification','manufacturer','default_supplier','min_stock','notes'],normalizedCsv});
}));
app.post('/api/attachments', requireAuth, upload.single('file'), route((req, res) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) throw new Error('请选择附件');
  const objectType = enumValue(req.body?.objectType, ['material','lot','recipe','preparation','movement'], '附件对象类型');
  const objectId = required(req.body?.objectId, '附件关联对象');
  const filename = `${id('file_')}${path.extname(file.originalname).toLowerCase()}`;
  writeFileSync(path.join(attachmentDir, filename), file.buffer, { flag: 'wx' });
  const attachmentId = id('att_');
  db.prepare(`INSERT INTO attachments(id,object_type,object_id,original_name,stored_name,mime_type,size_bytes,sha256,uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(attachmentId, objectType, objectId, path.basename(file.originalname), filename, file.mimetype,
      file.size, sha256(file.buffer), req.user!.id);
  audit(req.user!.id, 'attachment.upload', objectType, objectId, { attachmentId, size: file.size });
  res.status(201).json({ id: attachmentId, name: path.basename(file.originalname), size: file.size });
}));
app.get('/api/attachments', requireAuth, route((req, res) => {
  const objectType = enumValue(req.query.objectType, ['material','lot','recipe','preparation','movement'], '附件对象类型');
  res.json(db.prepare('SELECT id,object_type,object_id,original_name,mime_type,size_bytes,created_at FROM attachments WHERE object_type=? AND object_id=? ORDER BY created_at DESC')
    .all(objectType, required(req.query.objectId, '附件关联对象')));
}));
app.get('/api/attachments/:id/download', requireAuth, route((req, res) => {
  const item = db.prepare('SELECT * FROM attachments WHERE id=?').get(param(req)) as Row | undefined;
  if (!item) return res.status(404).json({ error: '附件不存在' });
  const storedPath = path.join(attachmentDir, item.stored_name);
  if (!existsSync(storedPath)) return res.status(404).json({ error: '附件文件缺失' });
  res.setHeader('Content-Type', item.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.original_name)}`);
  res.sendFile(storedPath);
}));

installResearchReportRoutes(app, requireAuth);
installAiRoutes(app, requireAuth, requireAdmin);
installLiteratureRoutes(app, requireAuth, requireAdmin);

app.get('/api/settings/summary', requireAuth, route((req, res) => res.json({
  role: req.user!.role,
  dimensions: ['mass','volume','amount','activity','count'],
  units: getUnitCatalog(),
  calculationTypes: ['ratio','mass_concentration','molar_concentration','stock_dilution','volume_fraction','fixed_addition'],
  movementTypes: ['RECEIVE','USE','TRANSFER_OUT','TRANSFER_IN','LOSS','ADJUST_IN','ADJUST_OUT','PREPARATION_USE','REVERSAL'],
  locations: db.prepare('SELECT * FROM locations WHERE active=1 ORDER BY code').all(),
  counts: { users: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n,
    materials: (db.prepare('SELECT COUNT(*) AS n FROM materials WHERE active=1').get() as Row).n,
    recipes: (db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE active=1').get() as Row).n }
})));
app.get('/api/settings/config', requireAuth, route((req, res) => {
  const configured = settingValue<string[]>('categories', ['无机盐','抗体','抗原','缓冲液','耗材','自制试剂','其他']);
  const inUse = (db.prepare('SELECT DISTINCT category FROM materials ORDER BY category').all() as Row[]).map(row=>String(row.category));
  const categories = [...new Set([...configured, ...inUse])];
  res.json({ categories, units: getUnitCatalog(), numberRules: numberRules(),
    alertRules: settingValue('alert_rules', { expiringDays: 60, defaultMinStock: '0' }),
    configuredUnits: settingValue('units', []) });
}));
app.patch('/api/settings/config', requireAuth, requireAdmin, route((req, res) => {
  const b = req.body ?? {};
  if (Array.isArray(b.categories)) {
    const categories = [...new Set(b.categories.map((item: unknown)=>required(item,'分类名称')).filter((item:string)=>item.length<=64))];
    if (!categories.length) throw new Error('至少保留一个物料分类');
    const inUse = (db.prepare('SELECT DISTINCT category FROM materials').all() as Row[]).map(row=>String(row.category));
    const omitted = inUse.filter(category=>!categories.includes(category));
    if (omitted.length) throw new Error(`仍有物料使用以下分类，请先调整物料档案：${omitted.join('、')}`);
    writeSetting(req.user!.id,'categories',categories);
  }
  if (b.numberRules) {
    const current = numberRules() as Row;
    const next = { ...current };
    for (const [key,value] of Object.entries({ materialPrefix:b.numberRules.materialPrefix, lotPrefix:b.numberRules.lotPrefix, preparationPrefix:b.numberRules.preparationPrefix })) {
      if (value !== undefined) {
        const text = required(value,'编号前缀');
        if (!/^[A-Za-z0-9_-]{1,16}$/.test(text)) throw new Error('编号前缀需为 1–16 位字母、数字、连字符或下划线');
        next[key] = text;
      }
    }
    writeSetting(req.user!.id,'number_rules',next);
  }
  if (b.alertRules) {
    const current = settingValue('alert_rules', { expiringDays:60, defaultMinStock:'0' }) as Row;
    const days = b.alertRules.expiringDays === undefined ? Number(current.expiringDays) : Number(b.alertRules.expiringDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('临期提醒天数需为 1–365 天');
    const defaultMinStock = fmt(nonNegative(b.alertRules.defaultMinStock ?? current.defaultMinStock, '默认低库存阈值'));
    writeSetting(req.user!.id,'alert_rules',{ expiringDays:days, defaultMinStock });
  }
  audit(req.user!.id,'settings.update','system_settings','',{ keys:Object.keys(b) });
  res.json({ ok:true, config: { categories:settingValue('categories',[]), units:getUnitCatalog(), numberRules:numberRules(),
    alertRules:settingValue('alert_rules',{expiringDays:60,defaultMinStock:'0'}), configuredUnits:settingValue('units',[]) } });
}));
app.post('/api/settings/units', requireAuth, requireAdmin, route((req, res) => {
  const name = required(req.body?.name,'单位符号').trim();
  if (name.length > 18 || /[\/\s]/.test(name)) throw new Error('单位符号需为 1–18 位且不含空格或斜线');
  const dimension = enumValue(req.body?.dimension,['mass','volume','amount','activity','count'],'量纲') as Dimension;
  const factorToCanonical = fmt(positive(req.body?.factorToCanonical,'换算系数'));
  if (isUnit(name)) throw new Error(`单位“${name}”已配置`);
  const configured = settingValue<Array<{name:string;dimension:Dimension;factorToCanonical:string}>>('units',[]);
  const next = [...configured,{name,dimension,factorToCanonical}];
  writeSetting(req.user!.id,'units',next);
  registerConfiguredUnit(name,dimension,factorToCanonical);
  audit(req.user!.id,'unit.create','unit',name,{dimension,factorToCanonical});
  res.status(201).json({name,dimension,factorToCanonical,units:getUnitCatalog()});
}));
app.get('/api/settings/next-code', requireAuth, route((req,res)=>{
  const kind=enumValue(req.query.kind,['material','lot','preparation'],'编号类型') as 'material'|'lot'|'preparation';
  res.json({kind,code:nextCode(kind)});
}));
app.get('/api/audit', requireAuth, requireAdmin, route((req, res) => res.json(db.prepare(`SELECT a.*,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 300`).all())));
app.get('/api/admin/backups', requireAuth, requireAdmin, route((req, res) => {
  const backups = readdirSync(backupDir).filter(name => name.endsWith('.zip') || name.endsWith('.sqlite')).map(filename => ({ filename, sizeBytes: statSync(path.join(backupDir, filename)).size }));
  res.json(backups);
}));
app.post('/api/admin/backups', requireAuth, requireAdmin, route(async (req, res) => {
  const filename = `ivd-backup-${new Date().toISOString().replaceAll(':','-')}.zip`;
  const target = path.join(backupDir, filename);
  const snapshotDb=path.join(backupDir,`${filename}.sqlite.tmp`);
  db.prepare('VACUUM INTO ?').run(snapshotDb);
  const attachmentFiles=readdirSync(attachmentDir,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>entry.name).sort();
  const manifest={format:'ivd-material-workbench-backup',version:1,createdAt:new Date().toISOString(),
    database:{path:'database/ivd.sqlite',sha256:await hashFile(snapshotDb)},
    derivedIndexes:{reportKnowledge:{provider:'qdrant',namespace:'ivd_rpt_*',included:false,
      recovery:'SQLite job state and validated embedding cache are included in the database snapshot. After restore, start report-knowledge:worker to verify Qdrant points and rebuild missing vectors from cache; uncached vectors require the configured Embedding service.'}},
    attachments:await Promise.all(attachmentFiles.map(async name=>({path:`attachments/${name}`,sha256:await hashFile(path.join(attachmentDir,name))})))};
  audit(req.user!.id, 'backup.create', 'backup', filename, { attachmentCount:attachmentFiles.length });
  await new Promise<void>((resolve,reject)=>{
    const output=createWriteStream(target,{flags:'wx'});
    const archive=archiver('zip',{zlib:{level:9}});
    output.on('close',resolve); output.on('error',reject); archive.on('error',reject);
    archive.pipe(output);
    archive.file(snapshotDb,{name:'database/ivd.sqlite'});
    for(const name of attachmentFiles) archive.file(path.join(attachmentDir,name),{name:`attachments/${name}`});
    archive.append(JSON.stringify(manifest,null,2),{name:'manifest.json'});
    void archive.finalize().catch(reject);
  }).finally(()=>{if(existsSync(snapshotDb))unlinkSync(snapshotDb)});
  res.json({ filename, sizeBytes:statSync(target).size, attachmentCount:attachmentFiles.length });
}));
app.get('/api/admin/backups/:filename/download', requireAuth, requireAdmin, route((req, res) => {
  const filename = path.basename(param(req, 'filename'));
  const target = path.join(backupDir, filename);
  if ((!filename.endsWith('.sqlite') && !filename.endsWith('.zip')) || !existsSync(target)) return res.status(404).json({ error: '备份文件不存在' });
  res.download(target, filename);
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, database: 'sqlite', version: Number((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as Row).version) }));
const clientDir = path.resolve('dist/client');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: '编号或批次已存在，请检查后重试' });
  if (error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(422).json({ error: '关联记录不存在，操作未保存' });
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过对应上传限制：通用附件 15 MB、研发报告 25 MB、原始数据 20 MB/个、文献 25 MB/份' });
  if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message });
  console.error('Request failed:', error?.message || error);
  res.status(400).json({ error: error?.message || '请求未完成，请检查填写内容后重试' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`IVD material workbench listening on http://0.0.0.0:${port}`);
  console.log(`SQLite data: ${databasePath}`);
});
