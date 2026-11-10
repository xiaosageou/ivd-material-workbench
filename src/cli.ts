import { scryptSync, randomBytes } from 'node:crypto';
import { db, id, transaction, databasePath } from './db.ts';
import { fmt, positive } from './decimal.ts';

const args = process.argv.slice(2);
const command = args[0];
const arg = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
function hashPassword(password: string) {
  if (password.length < 12) throw new Error('管理员密码至少 12 位');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

if (command === 'admin-init') {
  const name = arg('name') || process.env.ADMIN_NAME;
  const email = arg('email') || process.env.ADMIN_EMAIL;
  const password = arg('password') || process.env.ADMIN_PASSWORD;
  if (!name || !email || !password) throw new Error('请通过 ADMIN_NAME、ADMIN_EMAIL、ADMIN_PASSWORD 环境变量提供首位管理员信息；密码至少 12 位。');
  const existing = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (existing) throw new Error('此邮箱已存在，请使用其他邮箱或在用户管理中维护账户。');
  const userId = id('usr_');
  db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,'ADMIN')").run(userId, name, email, hashPassword(password));
  console.log(`管理员账户已创建：${email}`);
  console.log(`数据文件：${databasePath}`);
} else if (command === 'seed-demo') {
  const admin = db.prepare("SELECT id FROM users WHERE role='ADMIN' AND active=1 LIMIT 1").get() as { id: string } | undefined;
  if (!admin) throw new Error('请先运行 npm run setup:admin');
  const existing = db.prepare("SELECT id FROM recipes WHERE source_type='demo' LIMIT 1").get();
  if (existing) throw new Error('演示配方已存在');
  transaction(() => {
    let location = db.prepare('SELECT id FROM locations WHERE code=?').get('R1-A') as { id: string } | undefined;
    if (!location) {
      const locationId = id('loc_');
      db.prepare('INSERT INTO locations(id,code,name) VALUES (?,?,?)').run(locationId, 'R1-A', '试剂柜 A-01');
      location = { id: locationId };
    }
    const materialId = id('mat_');
    db.prepare(`INSERT INTO materials(id,code,name,category,dimension,base_unit,specification,manufacturer,default_supplier,min_stock,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(materialId,'DEMO-NACl','氯化钠（分析纯）','无机盐','mass','g','分析纯，演示档案','演示供应商','演示供应商','25','演示数据；实际使用前需由企业确认规格与适用性');
    const lotId = id('lot_');
    db.prepare(`INSERT INTO inventory_lots(id,material_id,manufacturer_lot,internal_lot,expiry_date,purity,notes) VALUES (?,?,?,?,?,?,?)`)
      .run(lotId, materialId, 'DEMO-LOT-01', 'DEMO-NACl-20261026', '2028-10-26', '99.5%', '仅用于演示');
    db.prepare('INSERT INTO stock_balances(lot_id,location_id,quantity) VALUES (?,?,?)').run(lotId, location.id, '250');
    db.prepare(`INSERT INTO stock_movements(id,lot_id,material_id,movement_type,quantity,to_location_id,reason,source_type,source_id,actor_id)
      VALUES (?,?,?,'RECEIVE','250',?,'演示期初库存','demo','seed',?)`).run(id('mov_'),lotId,materialId,location.id,admin.id);
    const recipeId = id('rcp_');
    const versionId = id('rv_');
    db.prepare("INSERT INTO recipes(id,name,scope,owner_id,source_type) VALUES (?,?, 'team',NULL,'demo')").run(recipeId,'0.9% 氯化钠溶液（演示配方）');
    db.prepare(`INSERT INTO recipe_versions(id,recipe_id,version,status,base_volume,base_volume_unit,output_name,output_code,output_unit,output_dimension,steps_json,storage,source_note,rationale,created_by,published_at)
      VALUES (?,?,1,'published','100','mL','0.9% 氯化钠溶液','DEMO-NS-09','mL','volume',?,?,?,?,?,datetime('now'))`)
      .run(versionId,recipeId,JSON.stringify(['称取氯化钠，记录实际称量值。','加入适量纯化水并混匀至溶解。','以纯化水定容至目标体积，记录终体积。']),
        '按企业确认的储存条件执行','演示条目；非经验证的产品配方','比例缩放：0.9 g / 100 mL；以定容终体积为准',admin.id);
    db.prepare(`INSERT INTO recipe_ingredients(id,recipe_version_id,material_id,name,calculation_type,amount_value,amount_unit,dimension,notes)
      VALUES (?,?,?,'氯化钠','ratio','0.9','g','mass','示例比例；请依据企业批准文件确认')`).run(id('ing_'),versionId,materialId);
    console.log(`演示数据已载入：物料 ${materialId}、批次 ${lotId}、配方 ${recipeId}`);
  });
  console.log('演示数据标记为 demo；请在企业使用前替换为已确认的数据。');
} else {
  console.log('用法：npm run setup:admin | npm run seed:demo');
}
