import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { calculateIngredient } from './calculator.ts';
import { convertQuantity } from './units.ts';
import { restoreBackup } from './restore-core.ts';
import ExcelJS from 'exceljs';

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`SMOKE FAIL: ${message}`); };
const equal = (actual: unknown, expected: unknown, message: string) => assert(actual === expected, `${message} (actual=${actual}, expected=${expected})`);

const cases = [
  [ { name:'比例',calculation_type:'ratio',amount_value:'2',amount_unit:'g',dimension:'mass' }, '250','100','5','g' ],
  [ { name:'质量浓度',calculation_type:'mass_concentration',amount_value:'2',amount_unit:'mg/mL',dimension:'mass' }, '100','100','200','mg' ],
  [ { name:'摩尔浓度',calculation_type:'molar_concentration',amount_value:'10',amount_unit:'mM',molecular_weight:'58.44',dimension:'mass' }, '100','100','0.05844','g' ],
  [ { name:'母液稀释',calculation_type:'stock_dilution',amount_value:'1',amount_unit:'mg/mL',stock_concentration:'10',target_concentration:'1',dimension:'volume' }, '100','100','10','mL' ],
  [ { name:'稀释微量精度',calculation_type:'stock_dilution',amount_value:'0.0001',amount_unit:'mg/mL',stock_concentration:'1000',target_concentration:'0.0001',dimension:'volume' }, '1000','1000','0.0001','mL' ],
  [ { name:'体积分数',calculation_type:'volume_fraction',amount_value:'5',amount_unit:'%',dimension:'volume' }, '100','100','5','mL' ],
  [ { name:'固定添加',calculation_type:'fixed_addition',amount_value:'2',amount_unit:'mL',dimension:'volume' }, '250','100','2','mL' ],
  [ { name:'g/L换算',calculation_type:'mass_concentration',amount_value:'9',amount_unit:'g/L',dimension:'mass',material_unit:'g',material_dimension:'mass' }, '1000','1000','9','g' ],
  [ { name:'摩尔/L换算',calculation_type:'molar_concentration',amount_value:'1',amount_unit:'mol/L',molecular_weight:'58.44',dimension:'mass' }, '1000','1000','58.44','g' ],
  [ { name:'微量比例精度',calculation_type:'ratio',amount_value:'1000',amount_unit:'g',dimension:'mass' }, '0.0001','1000','0.0001','g' ],
  [ { name:'纳升体积完整比例精度',calculation_type:'ratio',amount_value:'100',amount_unit:'g',dimension:'mass',material_unit:'g',material_dimension:'mass' }, '0.1','100','0.1','g' ],
] as const;
for (const [item,target,base,expected,unit] of cases) {
  const result = calculateIngredient(item,target,base);
  const isNanoLiter = item.name === '纳升体积完整比例精度';
  const scaledResult = isNanoLiter ? calculateIngredient(item,target,base,'nL','nL') : result;
  equal(scaledResult.quantity,expected,`${item.name}用量计算`);
  equal(scaledResult.unit,unit,`${item.name}单位`);
}
let invalidBlocked=false;
try { calculateIngredient({name:'无效母液',calculation_type:'stock_dilution',amount_value:'1',amount_unit:'mg/mL',stock_concentration:'1',target_concentration:'2',dimension:'volume'},'100','100'); }
catch { invalidBlocked=true; }
assert(invalidBlocked,'母液浓度低于目标浓度必须阻止计算');
let molecularWeightBlocked=false;
try { calculateIngredient({name:'缺分子量',calculation_type:'molar_concentration',amount_value:'2',amount_unit:'mM',dimension:'mass'},'100','100'); }
catch { molecularWeightBlocked=true; }
assert(molecularWeightBlocked,'摩尔浓度缺少分子量必须阻止计算');
equal(convertQuantity(1_000_000n,'g','mg','mass').toString(),'1000000000','质量单位换算保持精确');
let unknownUnitBlocked=false;
try { convertQuantity(1_000_000n,'mystery','g','mass'); } catch { unknownUnitBlocked=true; }
assert(unknownUnitBlocked,'未配置单位必须阻止数量换算');

const dataDir=mkdtempSync(join(tmpdir(),'ivd-smoke-'));
const port=Number(process.env.SMOKE_PORT||31891);
const base=`http://127.0.0.1:${port}`;
const env={...process.env,DATA_DIR:dataDir,PORT:String(port),ADMIN_NAME:'Test Admin',ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD:'smoke-password-long-enough'};
let restoreDir='';
let crossRestoreDir='';
let restoreValidationDb:DatabaseSync|undefined;
const faultRestoreDirs:string[]=[];
const run=(args:string[],extraEnv:NodeJS.ProcessEnv={})=>new Promise<string>((resolvePromise,reject)=>{
  const child=spawn(process.execPath,['--import','tsx',...args],{cwd:process.cwd(),env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  child.on('error',reject);child.on('close',code=>code===0?resolvePromise(output):reject(new Error(output)));
});
const server=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
let cookie='';
const call=async(path:string,body?:any,method='GET',auth=cookie,extraHeaders:Record<string,string>={})=>{
  const response=await fetch(`${base}${path}`,{method,headers:{...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...(auth?{Cookie:auth}:{}),...extraHeaders},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
  const type=response.headers.get('content-type')||'';
  return {status:response.status,data:type.includes('json')?await response.json():await response.text(),response};
};
async function waitForHealth(){
  for(let i=0;i<80;i++){try{const result=await call('/api/health');if(result.status===200)return}catch{} await new Promise(r=>setTimeout(r,125));}
  throw new Error(`服务启动超时。${logs}`);
}
try {
  const migrationResult=await run(['src/migration-smoke.ts']);assert(migrationResult.includes('MIGRATION SMOKE PASS'),'v1 业务数据增量迁移回归');
  await waitForHealth();
  equal((await call('/api/auth/registration-status',undefined,'GET','')).data.firstAdmin,true,'空库显示首位管理员注册');
  const firstPair=await Promise.all([
    call('/api/auth/register',{name:'Test Admin',email:'admin@example.test',password:'smoke-password-long-enough',role:'ADMIN'},'POST',''),
    call('/api/auth/register',{name:'申请成员',email:'pending@example.test',password:'pending-password-long',role:'ADMIN'},'POST','')]);
  equal(firstPair.filter(x=>x.data.firstAdmin===true).length,1,'并发注册仅一位首位管理员');
  const chosenAdmin=firstPair[0].data.firstAdmin?'admin@example.test':'pending@example.test';
  const chosenPassword=firstPair[0].data.firstAdmin?'smoke-password-long-enough':'pending-password-long';
  const pendingEmail=firstPair[0].data.firstAdmin?'pending@example.test':'admin@example.test';
  const pendingPassword=firstPair[0].data.firstAdmin?'pending-password-long':'smoke-password-long-enough';
  const firstLogin=await call('/api/auth/login',{email:chosenAdmin,password:chosenPassword},'POST','');
  equal(firstLogin.status,200,'首位管理员可登录');
  const firstCookie=(firstLogin.response.headers.get('set-cookie')||'').split(';')[0];
  equal((await call('/api/auth/login',{email:pendingEmail,password:pendingPassword},'POST','')).status,401,'待审批用户不能登录');
  const listed=await call('/api/users',undefined,'GET',firstCookie);
  const pendingUser=listed.data.find((u:any)=>u.email===pendingEmail);
  equal(pendingUser.role,'RESEARCHER','注册请求不能指定管理员角色');
  equal(pendingUser.registration_pending,1,'申请显示待审批');
  equal((await call('/api/users/'+pendingUser.id,{active:true},'PATCH','')).status,401,'匿名用户不能审批');
  equal((await call('/api/users/'+pendingUser.id,{active:true},'PATCH',firstCookie)).status,200,'管理员可批准');
  equal((await call('/api/auth/login',{email:pendingEmail,password:pendingPassword},'POST','')).status,200,'批准后可登录');

  const login=await call('/api/auth/login',{email:chosenAdmin,password:chosenPassword},'POST','');
  equal(login.status,200,'管理员登录');
  cookie=(login.response.headers.get('set-cookie')||'').split(';')[0];
  assert(cookie.includes('ivd_session='),'登录会话 Cookie');
  const invalidUnit=await call('/api/settings/units',{name:'bad unit',dimension:'count',factorToCanonical:'2'},'POST');equal(invalidUnit.status,400,'无效单位符号被拒绝');
  const settingsAfterInvalidUnit=await call('/api/settings/config');assert(!settingsAfterInvalidUnit.data.configuredUnits.some((unit:any)=>unit.name==='bad unit'),'无效单位不会先写入配置再失败');
  const locA=await call('/api/locations',{code:'A-01',name:'试剂柜 A-01'},'POST');
  const locB=await call('/api/locations',{code:'B-01',name:'冷藏柜 B-01'},'POST');
  equal(locA.status,201,'新增库位 A'); equal(locB.status,201,'新增库位 B');
  const material=await call('/api/materials',{code:'SMOKE-NACl',name:'氯化钠验证物料',category:'无机盐',dimension:'mass',baseUnit:'g',minStock:'1'},'POST');
  equal(material.status,201,'新增物料档案');
  const invalidManualMaterial=await call('/api/materials',{code:'SMOKE-BAD-DIM',name:'量纲错配验证',category:'试剂',dimension:'mass',baseUnit:'mL'},'POST');equal(invalidManualMaterial.status,400,'手工物料新增拒绝库存单位量纲错配');
  assert(!(await call('/api/materials?q=SMOKE-BAD-DIM')).data.length,'手工物料量纲错配失败后未写入');
  const editable=await call(`/api/materials/${material.data.id}`,{name:'氯化钠验证物料',category:'无机盐',dimension:'mass',baseUnit:'mg'},'PATCH');equal(editable.status,400,'物料档案拒绝重释历史量纲/单位');
  const changed=await call(`/api/materials/${material.data.id}`,{name:'氯化钠验证物料（已核验）',category:'无机盐',minStock:'1',manufacturer:'验证生产商'},'PATCH');equal(changed.status,200,'管理员维护物料档案字段');
  const generatedCode=await call('/api/settings/next-code?kind=lot');assert(/^LOT-\d{8}-\d{4}$/.test(generatedCode.data.code),'批次编号可由配置生成');
  const received=await call('/api/inventory/receive',{materialId:material.data.id,locationId:locA.data.id,internalLot:'SMOKE-LOT-001',manufacturerLot:'MFG-001',quantity:'10',expiryDate:'2028-12-31',reason:'烟测入库'},'POST');
  equal(received.status,201,'批次入库');
  let use=await call('/api/inventory/consume',{lotId:received.data.id,locationId:locA.data.id,quantity:'2',reason:'项目 SMOKE-01'},'POST');equal(use.status,200,'登记使用');
  const insufficient=await call('/api/inventory/consume',{lotId:received.data.id,locationId:locA.data.id,quantity:'9',reason:'余额不足'},'POST');equal(insufficient.status,400,'余额不足拒绝');
  let lotRows=await call('/api/lots?q=SMOKE-LOT-001');equal(lotRows.data[0].quantity,'8','余额不足后原余额未变化');
  const transfer=await call('/api/inventory/transfer',{lotId:received.data.id,fromLocationId:locA.data.id,toLocationId:locB.data.id,quantity:'1',reason:'位置验证'},'POST');equal(transfer.status,200,'移库');
  const loss=await call('/api/inventory/loss',{lotId:received.data.id,locationId:locB.data.id,quantity:'0.1',reason:'破损验证'},'POST');equal(loss.status,200,'报损');
  const adjust=await call('/api/inventory/adjust',{lotId:received.data.id,locationId:locB.data.id,quantity:'0.1',direction:'increase',reason:'盘点复核'},'POST');equal(adjust.status,200,'管理员盘点调整');
  const defaultRecipe=await call('/api/recipes',{name:'SMOKE 默认产物配方',scope:'team',baseVolume:'100',baseVolumeUnit:'mL',outputUnit:'mL',targetPH:'7.2',steps:['称量'],ingredients:[{name:'客户端伪造名称',materialId:material.data.id,calculationType:'mass_concentration',amountValue:'9',amountUnit:'g/L',dimension:'mass'}]},'POST');equal(defaultRecipe.status,201,'创建未显式指定产物名称的配方');
  const defaultRecipeRows=await call('/api/recipes');const defaultVersion=defaultRecipeRows.data.find((row:any)=>row.id===defaultRecipe.data.id).versions[0];
  equal(defaultVersion.output_name,'SMOKE 默认产物配方','省略产物名称时默认采用配方名称');equal(defaultVersion.output_unit,'mL','默认产物库存单位为 mL');equal(defaultVersion.output_dimension,'volume','默认产物量纲保持体积');equal(defaultVersion.target_ph,'7.2','可选目标 pH 留存');
  const defaultVersionDetails=await call(`/api/recipe-versions/${defaultVersion.id}`);equal(defaultVersionDetails.data.ingredients[0].name,'氯化钠验证物料（已核验）','组分名称必须从关联物料档案读取');
  const recipe=await call('/api/recipes',{name:'SMOKE 配方',scope:'personal',baseVolume:'100',baseVolumeUnit:'mL',outputName:'SMOKE 自制液',outputCode:'SMOKE-PRODUCT',outputUnit:'mL',outputDimension:'volume',sourceNote:'验证用配方',steps:['溶解','定容'],ingredients:[{name:'氯化钠验证物料',materialId:material.data.id,calculationType:'ratio',amountValue:'0.9',amountUnit:'g',dimension:'mass'}]},'POST');equal(recipe.status,201,'创建配方草稿');
  const recipes=await call('/api/recipes');const recipeVersion=recipes.data.find((r:any)=>r.id===recipe.data.id).versions[0];
  const published=await call(`/api/recipe-versions/${recipeVersion.id}/publish`,{},'POST');equal(published.status,200,'发布配方版本');
  const calculation=await call(`/api/recipe-versions/${recipeVersion.id}/calculate`,{targetVolume:'200'},'POST');equal(calculation.data.lines[0].quantity,'1.8','配方比例缩放');
  const prep=await call('/api/preparations',{recipeVersionId:recipeVersion.id,targetVolume:'200'},'POST');equal(prep.status,201,'创建配液任务');
  equal(prep.data.created_by_name,'Test Admin','配液创建人已单独留痕');
  const output={idempotencyKey:'smoke-once',actuals:[{ingredientId:recipeVersion.id,lotId:received.data.id,locationId:locA.data.id,quantity:'1.8',unit:'g'}]};
  output.actuals[0].ingredientId=prep.data.theoretical.lines[0].ingredientId;
  const completeBody={...output,outputQuantity:'200',outputLocationId:locB.data.id,measuredPh:'7.0',deviation:'烟测',steps:[{stepNo:1,result:'已溶解'},{stepNo:2,result:'已定容'}]};
  const user=await call('/api/users',{name:'研发测试员',email:'researcher@example.test',password:'researcher-password-long',role:'RESEARCHER'},'POST');equal(user.status,201,'创建研发用户');
  const researcherLogin=await call('/api/auth/login',{email:'researcher@example.test',password:'researcher-password-long'},'POST','');equal(researcherLogin.status,200,'研发用户登录');
  const researcherCookie=(researcherLogin.response.headers.get('set-cookie')||'').split(';')[0];
  const sharedRecipes=await call('/api/recipes',undefined,'GET',researcherCookie);const sharedRecipe=sharedRecipes.data.find((r:any)=>r.id===recipe.data.id);assert(sharedRecipe,'personal 提交的配方仍在组织内共享');equal(sharedRecipe.scope,'team','配方范围按组织共享保存');
  equal(sharedRecipe.versions[0].published_by_name,'Test Admin','配方发布人已留痕');
  const sharedVersion=await call(`/api/recipe-versions/${recipeVersion.id}`,undefined,'GET',researcherCookie);equal(sharedVersion.status,200,'研发人员读取共享配方版本');
  const forbiddenVersion=await call(`/api/recipes/${recipe.data.id}/versions`,{baseVolume:'100',baseVolumeUnit:'mL',outputName:'x',outputCode:'x',outputUnit:'mL',outputDimension:'volume',ingredients:[{name:'x',materialId:material.data.id,calculationType:'ratio',amountValue:'1',amountUnit:'g',dimension:'mass'}]},'POST',researcherCookie);equal(forbiddenVersion.status,403,'共享不开放非创建者改版');
  const complete=await call(`/api/preparations/${prep.data.id}/complete`,completeBody,'POST',researcherCookie);assert(complete.status===200,`研发人员完成配液并生成产物批次 (${JSON.stringify(complete.data)})`);
  equal(complete.data.created_by_name,'Test Admin','配液创建人保留');equal(complete.data.completed_by_name,'研发测试员','配液完成执行人单独留痕');
  assert(complete.data.product?.id,'自制试剂批次存在');
  lotRows=await call('/api/lots?q=SMOKE-LOT-001');equal(lotRows.data.find((x:any)=>x.location_id===locA.data.id).quantity,'5.2','配液只扣除实际用量');
  const before=await call('/api/movements?q=SMOKE-PRODUCT');
  const replay=await call(`/api/preparations/${prep.data.id}/complete`,completeBody,'POST');equal(replay.status,200,'幂等重复提交');assert(replay.data.alreadyCompleted,'重复提交返回已完成状态');
  const after=await call('/api/movements?q=SMOKE-PRODUCT');equal(after.data.length,before.data.length,'重复提交不增加流水');
  const trace=await call(`/api/trace/lots/${complete.data.product.id}`);equal(trace.status,200,'自制批次追溯');equal(trace.data.upstream.length,1,'追溯回配液消耗');
  const newVersion=await call(`/api/recipes/${recipe.data.id}/versions`,{baseVolume:'100',baseVolumeUnit:'mL',outputName:'SMOKE 自制液',outputCode:'SMOKE-PRODUCT',outputUnit:'mL',outputDimension:'volume',sourceNote:'第二版',steps:['溶解'],ingredients:[{name:'氯化钠验证物料',materialId:material.data.id,calculationType:'ratio',amountValue:'1',amountUnit:'g',dimension:'mass'}]},'POST');equal(newVersion.status,201,'创建不可变配方新版本');
  const oldVersion=await call(`/api/recipe-versions/${recipeVersion.id}`);equal(oldVersion.data.ingredients[0].amount_value,'0.9','旧配方版本保持原值');
  const forbidden=await call('/api/users',undefined,'GET',cookie);equal(forbidden.status,200,'管理员读取用户列表');
  const blocked=await call('/api/users',undefined,'GET',researcherCookie);equal(blocked.status,403,'研发人员不能访问管理员接口');
  const parallel=await Promise.all([
    call('/api/inventory/consume',{lotId:received.data.id,locationId:locA.data.id,quantity:'3',reason:'并发扣减 A'},'POST',researcherCookie),
    call('/api/inventory/consume',{lotId:received.data.id,locationId:locA.data.id,quantity:'3',reason:'并发扣减 B'},'POST',researcherCookie),
  ]);
  equal(parallel.filter(x=>x.status===200).length,1,'并发余额竞争只允许一个足额扣减');
  equal(parallel.filter(x=>x.status===400).length,1,'并发超额扣减整体失败');
  lotRows=await call('/api/lots?q=SMOKE-LOT-001');equal(lotRows.data.find((x:any)=>x.location_id===locA.data.id).quantity,'2.2','并发扣减后没有负库存');
  const fullProductTransfer=await call('/api/inventory/transfer',{lotId:complete.data.product.id,fromLocationId:locB.data.id,toLocationId:locA.data.id,quantity:'200',reason:'移库全部配液产物后验证冲销'},'POST',researcherCookie);equal(fullProductTransfer.status,200,'移库全部配液产物并留下原库位零余额行');
  const productBalances=await call('/api/lots?q=SMOKE-PRODUCT');assert(productBalances.data.some((row:any)=>row.location_id===locB.data.id&&row.quantity==='0'),'整批移库后保留原库位零余额行');
  const correction=await call(`/api/preparations/${prep.data.id}/correct`,{reason:'烟测纠错'},'POST');equal(correction.status,200,'含零余额库位的整单冲销更正');equal(correction.data.status,'corrected','更正状态');
  lotRows=await call('/api/lots?q=SMOKE-LOT-001');equal(lotRows.data.find((x:any)=>x.location_id===locA.data.id).quantity,'4','更正恢复原料实际消耗');
  const usageReport=await call('/api/reports/usage');
  const correctedRows=usageReport.data.rows.filter((row:any)=>row.source_id===prep.data.id&&row.material_id===material.data.id);
  equal(correctedRows.reduce((sum:number,row:any)=>sum+Number(row.signed_quantity),0),0,'冲销后原配液耗用在净消耗报告中归零');
  const usageGroup=usageReport.data.byMaterial.find((row:any)=>row.material_id===material.data.id&&row.unit==='g');
  assert(usageGroup&&Number(usageGroup.netQuantity)>=0,'物料净消耗按物料和单位分组');
  const stockMaterial=await call('/api/materials',{code:'SMOKE-STOCK',name:'母液验证物料',category:'缓冲液',dimension:'volume',baseUnit:'mL'},'POST');equal(stockMaterial.status,201,'创建母液物料档案');
  const stockLot=await call('/api/inventory/receive',{materialId:stockMaterial.data.id,locationId:locA.data.id,internalLot:'SMOKE-STOCK-5',quantity:'1',quantityUnit:'L',concentration:'5',concentrationUnit:'mg/mL',reason:'浓度换算验证'},'POST');equal(stockLot.status,201,'母液按 L 转为 mL 入库');equal(stockLot.data.quantity,'1000','入库数量按物料单位换算');
  const abortRecipe=await call('/api/recipes',{name:'SMOKE 中止配液快照',scope:'team',baseVolume:'100',baseVolumeUnit:'mL',outputName:'SMOKE 中止产物',outputCode:'SMOKE-ABORT-PRODUCT',outputUnit:'mL',outputDimension:'volume',sourceNote:'中止配液实际用量与批次快照回归',steps:['配制'],ingredients:[{name:'已实际加入母液',materialId:stockMaterial.data.id,calculationType:'stock_dilution',amountValue:'1',amountUnit:'mg/mL',stockConcentration:'10',targetConcentration:'1',dimension:'volume'},{name:'尚未加入的定容补液',materialId:stockMaterial.data.id,calculationType:'fixed_addition',amountValue:'2',amountUnit:'mL',dimension:'volume'}]},'POST');equal(abortRecipe.status,201,'创建部分实际消耗中止配方');
  const abortRecipes=await call('/api/recipes');const abortVersion=abortRecipes.data.find((r:any)=>r.id===abortRecipe.data.id).versions[0];equal((await call(`/api/recipe-versions/${abortVersion.id}/publish`,{},'POST')).status,200,'发布中止配液回归配方');
  const abortPrep=await call('/api/preparations',{recipeVersionId:abortVersion.id,targetVolume:'200'},'POST');equal(abortPrep.status,201,'创建中止配液任务');equal(abortPrep.data.theoretical.lines.find((line:any)=>line.name==='母液验证物料').quantity,'20','组分名称由关联物料提供，且中止任务保存原始理论快照');
  const actualBatchExpected=calculateIngredient({name:'已实际加入母液',calculation_type:'stock_dilution',amount_value:'1',amount_unit:'mg/mL',stock_concentration:'10',target_concentration:'1',dimension:'volume'},'200','100','mL','mL',{value:'5',unit:'mg/mL',share:'100'});equal(actualBatchExpected.quantity,'40','中止实际批次快照按所选 5 mg/mL 批次重算理论用量');
  const abortIngredient=abortPrep.data.theoretical.lines.find((line:any)=>line.name==='母液验证物料').ingredientId;
  const abortActual={ingredientId:abortIngredient,lotId:stockLot.data.id,locationId:locA.data.id,quantity:'0.02',unit:'L'};
  const beforeAbortBalance=await call('/api/lots?q=SMOKE-STOCK-5');const oldAbortBalance=beforeAbortBalance.data[0].quantity;
  const invalidAbortUnit=await call(`/api/preparations/${abortPrep.data.id}/abort`,{reason:'单位错配验证',actuals:[{...abortActual,unit:'g'}]},'POST',researcherCookie);equal(invalidAbortUnit.status,400,'中止配液拒绝跨量纲实际消耗单位');
  const stillPlanned=await call(`/api/preparations/${abortPrep.data.id}`);equal(stillPlanned.data.status,'planned','中止量纲校验失败时任务仍待执行');
  const aborted=await call(`/api/preparations/${abortPrep.data.id}/abort`,{reason:'仅加入部分母液后中止',actuals:[abortActual]},'POST',researcherCookie);assert(aborted.status===200,`允许部分实际消耗并中止 (${JSON.stringify(aborted.data)})`);equal(aborted.data.status,'aborted','中止状态留痕');equal(aborted.data.created_by_name,'Test Admin','中止记录保留任务创建人');equal(aborted.data.aborted_by_name,'研发测试员','中止记录保存实际操作人');equal(aborted.data.performer,'研发测试员','中止记录展示实际操作人');equal(aborted.data.usages.length,1,'只记录实际投入的配方组分');equal(aborted.data.usages[0].theoretical_quantity,'40','中止实际批次用量快照保存为 40 mL');equal(aborted.data.usages[0].actual_quantity,'20','0.02 L 按物料库存单位扣减为 20 mL');equal(aborted.data.usages[0].unit,'mL','中止用量记录使用库存单位');equal(aborted.data.usages[0].batch_concentration,'5','中止用量记录保存批次浓度快照');equal(aborted.data.usages[0].batch_concentration_unit,'mg/mL','中止用量记录保存批次浓度单位快照');equal(aborted.data.usages[0].allocation_share,'100','中止用量记录保存组分分配比例快照');
  const afterAbortBalance=await call('/api/lots?q=SMOKE-STOCK-5');equal(Number(oldAbortBalance)-Number(afterAbortBalance.data[0].quantity),20,'中止配液按换算后实际用量扣减库存');
  const nanoMaterial=await call('/api/materials',{code:'SMOKE-NANO',name:'纳升计算验证物料',category:'试剂',dimension:'volume',baseUnit:'nL'},'POST');equal(nanoMaterial.status,201,'创建 nL 库存单位物料');
  const nanoLot=await call('/api/inventory/receive',{materialId:nanoMaterial.data.id,locationId:locA.data.id,internalLot:'SMOKE-NANO-LOT',quantity:'100',quantityUnit:'nL',reason:'纳升端到端计算'},'POST');equal(nanoLot.status,201,'登记 nL 验证库存');
  const nanoRecipe=await call('/api/recipes',{name:'SMOKE 纳升端到端配方',scope:'team',baseVolume:'100',baseVolumeUnit:'nL',outputName:'纳升验收产物',outputCode:'SMOKE-NANO-PRODUCT',outputUnit:'nL',outputDimension:'volume',steps:['称量'],ingredients:[{name:'纳升验证组分',materialId:nanoMaterial.data.id,calculationType:'fixed_addition',amountValue:'0.1',amountUnit:'nL',dimension:'volume'}]},'POST');equal(nanoRecipe.status,201,'创建 nL 端到端配方');
  const nanoVersion=(await call('/api/recipes')).data.find((row:any)=>row.id===nanoRecipe.data.id).versions[0];equal((await call(`/api/recipe-versions/${nanoVersion.id}/publish`,{},'POST')).status,200,'发布 nL 端到端配方');
  const nanoPrep=await call('/api/preparations',{recipeVersionId:nanoVersion.id,targetVolume:'0.1',targetVolumeUnit:'nL'},'POST');equal(nanoPrep.status,201,'创建 0.1 nL 配液任务');equal(nanoPrep.data.output_quantity,'0.1','任务输出体积直接按 nL 换算并保留精度');
  const nanoIngredient=nanoPrep.data.theoretical.lines[0].ingredientId;const nanoComplete=await call(`/api/preparations/${nanoPrep.data.id}/complete`,{idempotencyKey:'smoke-nano-once',actuals:[{ingredientId:nanoIngredient,lotId:nanoLot.data.id,locationId:locA.data.id,quantity:'0.1',unit:'nL'}],outputLocationId:locA.data.id},'POST',researcherCookie);assert(nanoComplete.status===200,`nL 配液完成保持 0.1 nL 产物 (${JSON.stringify(nanoComplete.data)})`);equal(nanoComplete.data.product.quantity,'0.1','nL 配液产物库存不经 mL 中间舍入而归零');
  const stockRecipe=await call('/api/recipes',{name:'SMOKE 母液配方',scope:'team',baseVolume:'100',baseVolumeUnit:'mL',outputName:'SMOKE 稀释液',outputCode:'SMOKE-DILUTED',outputUnit:'mL',outputDimension:'volume',sourceNote:'批次浓度验证',steps:['稀释'],ingredients:[{name:'母液验证物料',materialId:stockMaterial.data.id,calculationType:'stock_dilution',amountValue:'1',amountUnit:'mg/mL',stockConcentration:'10',targetConcentration:'1',dimension:'volume'}]},'POST');equal(stockRecipe.status,201,'创建母液稀释配方');
  const stockRecipes=await call('/api/recipes');const stockVersion=stockRecipes.data.find((r:any)=>r.id===stockRecipe.data.id).versions[0];
  const stockPublished=await call(`/api/recipe-versions/${stockVersion.id}/publish`,{},'POST');equal(stockPublished.status,200,'发布母液稀释配方');
  const stockPrep=await call('/api/preparations',{recipeVersionId:stockVersion.id,targetVolume:'100'},'POST');equal(stockPrep.status,201,'创建母液稀释任务');
  const stockIngredient=stockPrep.data.theoretical.lines[0].ingredientId;
  const stockActuals=[{ingredientId:stockIngredient,lotId:stockLot.data.id,locationId:locA.data.id,quantity:'20',unit:'mL',sharePercent:'100'}];
  const stockPreview=await call(`/api/preparations/${stockPrep.data.id}/preview`,{actuals:stockActuals},'POST');assert(stockPreview.status===200,`按所选母液批次浓度预览用量 (${JSON.stringify(stockPreview.data)})`);equal(stockPreview.data.rows[0].expectedQuantity,'20','5 mg/mL 批次的理论用量为 20 mL');
  const stockLot10=await call('/api/inventory/receive',{materialId:stockMaterial.data.id,locationId:locA.data.id,internalLot:'SMOKE-STOCK-10',quantity:'100',concentration:'10',concentrationUnit:'mg/mL',reason:'多批次比例回归'},'POST');equal(stockLot10.status,201,'登记不同浓度母液批次');
  const splitPrep=await call('/api/preparations',{recipeVersionId:stockVersion.id,targetVolume:'100'},'POST');equal(splitPrep.status,201,'创建多批次母液稀释任务');
  const splitIngredient=splitPrep.data.theoretical.lines[0].ingredientId;
  const splitActuals=[{ingredientId:splitIngredient,lotId:stockLot.data.id,locationId:locA.data.id,quantity:'10',unit:'mL',sharePercent:'50'},{ingredientId:splitIngredient,lotId:stockLot10.data.id,locationId:locA.data.id,quantity:'5',unit:'mL',sharePercent:'50'}];
  const splitPreview=await call(`/api/preparations/${splitPrep.data.id}/preview`,{actuals:splitActuals},'POST');equal(splitPreview.status,200,'多批次按目标组分量分配预览');
  equal(splitPreview.data.rows.find((row:any)=>row.lotId===stockLot.data.id).expectedQuantity,'10','5 mg/mL 批次承担 50% 组分量并分别重算为 10 mL');
  equal(splitPreview.data.rows.find((row:any)=>row.lotId===stockLot10.data.id).expectedQuantity,'5','10 mg/mL 批次承担 50% 组分量并分别重算为 5 mL');
  const invalidSplit=await call(`/api/preparations/${splitPrep.data.id}/preview`,{actuals:splitActuals.map((row:any,index:number)=>({...row,sharePercent:index===0?'60':'50'}))},'POST');equal(invalidSplit.status,400,'多批次分配比例总和不为 100% 时拒绝');
  const splitComplete=await call(`/api/preparations/${splitPrep.data.id}/complete`,{idempotencyKey:'split-stock-once',actuals:splitActuals,outputQuantity:'100',outputLocationId:locB.data.id},'POST',researcherCookie);equal(splitComplete.status,200,'按不同浓度分别复核后完成多批次配液');
  equal(splitComplete.data.usages.find((row:any)=>row.lot_id===stockLot.data.id).batch_concentration,'5','完成快照保留第一批实测浓度');
  equal(splitComplete.data.usages.find((row:any)=>row.lot_id===stockLot10.data.id).batch_concentration,'10','完成快照保留第二批实测浓度');
  const unconfirmed=await call(`/api/preparations/${stockPrep.data.id}/complete`,{idempotencyKey:'stock-unconfirmed',actuals:[{...stockActuals[0],quantity:'19'}],outputQuantity:'100',outputLocationId:locB.data.id},'POST',researcherCookie);equal(unconfirmed.status,400,'偏离批次理论用量需要确认');
  const stockComplete=await call(`/api/preparations/${stockPrep.data.id}/complete`,{idempotencyKey:'stock-once',actuals:[{...stockActuals[0],quantity:'19'}],outputQuantity:'100',outputLocationId:locB.data.id,confirmDeviation:true,deviationReason:'记录一次确认偏差',immediateUse:true,immediateUseReason:'SMOKE-02 立即使用'},'POST',researcherCookie);equal(stockComplete.status,200,'确认偏差后完成并立即使用');
  equal(stockComplete.data.deviation_confirmed,1,'已确认偏差写入记录');equal(stockComplete.data.immediate_use,1,'立即使用写入配液记录');equal(stockComplete.data.completed_by_name,'研发测试员','共享配方执行人单独留痕');equal(stockComplete.data.product.quantity,'0','立即使用后产物库存为零');
  const stockBalance=await call('/api/lots?q=SMOKE-STOCK-5');equal(stockBalance.data[0].quantity,'951','中止配液、多批次与偏差记录的原料实际扣减量一致');
  const separatedUsage=await call('/api/reports/usage');
  assert(separatedUsage.data.byMaterial.some((row:any)=>row.material_id===material.data.id&&row.unit==='g'),'质量物料按 g 独立汇总');
  assert(separatedUsage.data.byMaterial.some((row:any)=>row.material_id===stockMaterial.data.id&&row.unit==='mL'),'体积物料按 mL 独立汇总');
  equal(new Set(separatedUsage.data.byMaterial.map((row:any)=>`${row.material_id}|${row.unit}`)).size,separatedUsage.data.byMaterial.length,'物料汇总的分组键包含物料与单位');
  equal(new Set(separatedUsage.data.byUser.map((row:any)=>`${row.user_id}|${row.material_id}|${row.unit}`)).size,separatedUsage.data.byUser.length,'人员汇总不会混合不同物料或单位');
  equal(new Set(separatedUsage.data.byProject.map((row:any)=>`${row.project}|${row.material_id}|${row.unit}`)).size,separatedUsage.data.byProject.length,'项目汇总不会混合不同物料或单位');
  assert(!('grossTotal' in separatedUsage.data)&&!('netTotal' in separatedUsage.data),'统计 API 不返回跨物料/单位的无量纲总和');
  const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('物料档案');sheet.addRow(['code','name','category','dimension','base_unit','specification','manufacturer','default_supplier','min_stock','notes']);sheet.addRow(['SMOKE-IMPORT-01','导入验证物料','试剂','mass','mg','标准品','','','0','Excel 导入烟测']);const workbookBytes=await workbook.xlsx.writeBuffer();
  const importForm=new FormData();importForm.set('file',new Blob([Buffer.from(workbookBytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'smoke-import.xlsx');
  const preview=await call('/api/import/materials/file-preview',importForm,'POST');equal(preview.status,200,'Excel 物料导入预览');equal(preview.data.validCount,1,'Excel 导入列校验');
  const imported=await call('/api/import/materials/commit',{csv:preview.data.normalizedCsv},'POST');equal(imported.status,200,'确认导入预览数据');
  const invalidCsv='code,name,category,dimension,base_unit\r\nSMOKE-IMPORT-BAD-CSV,量纲错配 CSV,试剂,mass,mL';
  const invalidCsvPreview=await call('/api/import/materials/preview',{csv:invalidCsv},'POST');equal(invalidCsvPreview.status,200,'CSV 导入错误预览');equal(invalidCsvPreview.data.errorCount,1,'CSV 预览执行库存单位量纲校验');
  const invalidCsvCommit=await call('/api/import/materials/commit',{csv:invalidCsv},'POST');equal(invalidCsvCommit.status,422,'CSV 提交复用预览写入校验');assert(!(await call('/api/materials?q=SMOKE-IMPORT-BAD-CSV')).data.length,'CSV 校验失败时零写入');
  const invalidMinStockCsv='code,name,category,dimension,base_unit,min_stock\r\nSMOKE-IMPORT-BAD-MIN,阈值错值,试剂,volume,mL,abc';
  const invalidMinStockPreview=await call('/api/import/materials/preview',{csv:invalidMinStockCsv},'POST');equal(invalidMinStockPreview.data.errorCount,1,'CSV 预览拒绝非法低库存数值');equal((await call('/api/import/materials/commit',{csv:invalidMinStockCsv},'POST')).status,422,'CSV 提交复用低库存数值校验');
  const invalidWorkbook=new ExcelJS.Workbook();const invalidSheet=invalidWorkbook.addWorksheet('错误量纲');invalidSheet.addRow(['code','name','category','dimension','base_unit']);invalidSheet.addRow(['SMOKE-IMPORT-BAD-XLSX','量纲错配 XLSX','试剂','mass','mL']);const invalidWorkbookBytes=await invalidWorkbook.xlsx.writeBuffer();
  const invalidImportForm=new FormData();invalidImportForm.set('file',new Blob([Buffer.from(invalidWorkbookBytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'smoke-invalid.xlsx');
  const invalidXlsxPreview=await call('/api/import/materials/file-preview',invalidImportForm,'POST');equal(invalidXlsxPreview.status,200,'XLSX 量纲错误预览');equal(invalidXlsxPreview.data.errorCount,1,'XLSX 预览执行库存单位量纲校验');
  const invalidXlsxCommit=await call('/api/import/materials/commit',{csv:invalidXlsxPreview.data.normalizedCsv},'POST');equal(invalidXlsxCommit.status,422,'XLSX 预览结果提交仍执行同一写入校验');assert(!(await call('/api/materials?q=SMOKE-IMPORT-BAD-XLSX')).data.length,'XLSX 校验失败时零写入');
  const attachmentForm=new FormData();attachmentForm.set('objectType','lot');attachmentForm.set('objectId',received.data.id);attachmentForm.set('file',new Blob(['smoke attachment'],{type:'application/pdf'}),'receipt.pdf');
  const attachment=await call('/api/attachments',attachmentForm,'POST');equal(attachment.status,201,'批次附件上传');
  const attachments=await call(`/api/attachments?objectType=lot&objectId=${received.data.id}`);equal(attachments.data.length,1,'附件对象关联列表');
  const reportZipHeader=Buffer.from([0x50,0x4b,0x03,0x04,0x10,0x00,0x00,0x00]);
  const reportForm=new FormData();reportForm.set('title','共享验证报告');reportForm.set('description','跨成员读取与修订版本验证');
  reportForm.set('file',new Blob([reportZipHeader,Buffer.from('report-v1')],{type:'application/octet-stream'}),'validation-v1.docx');
  const report=await call('/api/research-reports',reportForm,'POST',researcherCookie);equal(report.status,201,'研发成员上传 Word 报告');
  equal(report.data.created_by, user.data.id, '报告上传者作为作者留存');equal(report.data.versions.length,1,'报告初始版本进入修订历史');
  const secondUser=await call('/api/users',{name:'共享查看员',email:'reader@example.test',password:'reader-password-long',role:'RESEARCHER'},'POST');equal(secondUser.status,201,'创建第二名研发成员');
  const secondLogin=await call('/api/auth/login',{email:'reader@example.test',password:'reader-password-long'},'POST','');equal(secondLogin.status,200,'第二名研发成员登录');
  const secondCookie=(secondLogin.response.headers.get('set-cookie')||'').split(';')[0];
  equal((await call('/api/research-reports',undefined,'GET','')).status,401,'研发报告目录要求登录');
  const sharedReportList=await call('/api/research-reports?q='+encodeURIComponent('共享验证报告'),undefined,'GET',secondCookie);
  equal(sharedReportList.status,200,'其他组织成员搜索并读取报告目录');equal(sharedReportList.data[0].id,report.data.id,'搜索结果包含共享报告');equal(sharedReportList.data[0].can_edit,0,'非上传者显示只读权限');
  const sharedReportDetail=await call('/api/research-reports/'+report.data.id,undefined,'GET',secondCookie);equal(sharedReportDetail.status,200,'其他组织成员查看报告详情');equal(sharedReportDetail.data.versions[0].original_name,'validation-v1.docx','共享详情显示文件名和版本');
  const sharedReportDownload=await call(`/api/research-reports/${report.data.id}/versions/${report.data.versions[0].id}/download`,undefined,'GET',secondCookie);equal(sharedReportDownload.status,200,'其他组织成员下载共享报告');
  const forbiddenReportEdit=await call('/api/research-reports/'+report.data.id,{title:'越权修改',description:''},'PATCH',secondCookie);equal(forbiddenReportEdit.status,403,'非上传者修改报告元数据被服务端拒绝');
  const forbiddenReportReplace=new FormData();forbiddenReportReplace.set('file',new Blob([reportZipHeader,Buffer.from('denied')]),'denied.xlsx');
  equal((await call(`/api/research-reports/${report.data.id}/versions`,forbiddenReportReplace,'POST',secondCookie)).status,403,'非上传者替换报告文件被服务端拒绝');
  equal((await call('/api/research-reports/'+report.data.id,undefined,'DELETE',secondCookie)).status,403,'非上传者删除报告被服务端拒绝');
  const metadataEdit=await call('/api/research-reports/'+report.data.id,{title:'共享验证报告（已修订）',description:'作者更新元数据'},'PATCH',researcherCookie);equal(metadataEdit.status,200,'上传者编辑报告元数据');
  const reportReplaceForm=new FormData();reportReplaceForm.set('changeNote','增加验证结果');reportReplaceForm.set('file',new Blob([reportZipHeader,Buffer.from('report-v2')]),'validation-v2.xlsx');
  const replacedReport=await call(`/api/research-reports/${report.data.id}/versions`,reportReplaceForm,'POST',researcherCookie);equal(replacedReport.status,200,'上传者替换 Word/Excel 报告文件');equal(replacedReport.data.versions[0].version_no,2,'报告文件版本递增并保留上一版');
  const rawDataForm=new FormData();rawDataForm.append('files',new Blob(['cycle\tct\r\n1\t23'],{type:'text/tab-separated-values'}),'plate.tsv');rawDataForm.append('files',new Blob([Buffer.from([0,1,2,3])]),'instrument.qgd');
  const rawAdded=await call(`/api/research-reports/${report.data.id}/data-attachments`,rawDataForm,'POST',researcherCookie);equal(rawAdded.status,201,'一次添加多个实验原始数据附件');equal(rawAdded.data.length,2,'保留多个原始数据条目');
  equal(rawAdded.data.find((item:any)=>item.latest.extension==='.qgd')?.latest.mime_type,'application/octet-stream','未知仪器格式作为二进制下载文件保存');
  const rawSharedDetail=await call('/api/research-reports/'+report.data.id,undefined,'GET',secondCookie);equal(rawSharedDetail.data.dataAttachments.length,2,'其他成员读取共享原始数据附件目录');
  const rawUnknown=rawSharedDetail.data.dataAttachments.find((item:any)=>item.latest.extension==='.qgd');
  const unknownDownload=await call(`/api/research-reports/${report.data.id}/data-attachments/${rawUnknown.id}/versions/${rawUnknown.latest.id}/download`,undefined,'GET',secondCookie);equal(unknownDownload.status,200,'未知仪器格式可由登录成员下载');equal(unknownDownload.response.headers.get('content-type'),'application/octet-stream','未知仪器格式只作为下载流返回');
  const rawTsv=rawAdded.data.find((item:any)=>item.latest.extension==='.tsv');
  const rawReplaceForm=new FormData();rawReplaceForm.set('file',new Blob(['cycle\tct\r\n1\t24']),'plate-revised.tsv');
  const rawReplaced=await call(`/api/research-reports/${report.data.id}/data-attachments/${rawTsv.id}/replace`,rawReplaceForm,'POST',researcherCookie);equal(rawReplaced.status,200,'上传者替换原始数据并保留新版本');
  const rawHistory=rawReplaced.data.find((item:any)=>item.id===rawTsv.id);equal(rawHistory.version_count,2,'原始数据替换递增版本并保留历史');
  const rawRemoved=await call(`/api/research-reports/${report.data.id}/data-attachments/${rawUnknown.id}`,undefined,'DELETE',researcherCookie);equal(rawRemoved.status,200,'上传者软删除原始数据附件');
  equal((await call(`/api/research-reports/${report.data.id}/data-attachments/${rawUnknown.id}/versions/${rawUnknown.latest.id}/download`,undefined,'GET',secondCookie)).status,404,'已移除原始数据的旧版本下载被拦截');
  const adminReportForm=new FormData();adminReportForm.set('title','管理员操作验证');adminReportForm.set('file',new Blob([reportZipHeader,Buffer.from('admin-v1')]),'admin-v1.docx');
  const adminReport=await call('/api/research-reports',adminReportForm,'POST');equal(adminReport.status,201,'管理员上传报告');
  const adminReportEdit=await call('/api/research-reports/'+adminReport.data.id,{title:'管理员更新报告',description:'管理员维护测试'},'PATCH');equal(adminReportEdit.status,200,'管理员可编辑其他成员报告');
  const adminReportReplaceForm=new FormData();adminReportReplaceForm.set('file',new Blob([reportZipHeader,Buffer.from('admin-v2')]),'admin-v2.xlsx');
  const adminReportReplaced=await call(`/api/research-reports/${adminReport.data.id}/versions`,adminReportReplaceForm,'POST');equal(adminReportReplaced.status,200,'管理员可替换其他成员报告文件');equal(adminReportReplaced.data.versions[0].version_no,2,'管理员替换亦保留报告版本历史');
  const adminReportDelete=await call('/api/research-reports/'+adminReport.data.id,undefined,'DELETE');equal(adminReportDelete.status,200,'管理员可软删除其他成员报告');
  equal((await call('/api/research-reports/'+adminReport.data.id+'/versions/'+adminReportReplaced.data.versions[0].id+'/download')).status,404,'已删除报告的历史文件下载受限');
  const reportKnowledgeDb=new DatabaseSync(join(dataDir,'ivd.sqlite'));
  const reportKnowledgeProfile='smoke-report-knowledge-profile';
  const reportKnowledgeFingerprint=createHash('sha256').update('synthetic-report-knowledge-fingerprint').digest('hex');
  const reportKnowledgeInput=createHash('sha256').update('synthetic-report-knowledge-input').digest('hex');
  const reportKnowledgeVector=Buffer.from(Float32Array.from([1,0,0]).buffer);
  const reportKnowledgeVectorHash=createHash('sha256').update(reportKnowledgeVector).digest('hex');
  const reportKnowledgeAdmin=reportKnowledgeDb.prepare('SELECT id FROM users WHERE email=?').get(chosenAdmin) as any;
  reportKnowledgeDb.prepare(`INSERT INTO literature_embedding_profiles(id,fingerprint,endpoint_url,model,dimensions,distance,chunker_version,parser_version,created_by)
    VALUES (?,?,?,?,3,'Cosine','synthetic','synthetic',?)`).run(reportKnowledgeProfile,createHash('sha256').update('synthetic-report-profile').digest('hex'),
    'http://127.0.0.1:1/v1','synthetic-backup-only',reportKnowledgeAdmin.id);
  reportKnowledgeDb.prepare(`INSERT INTO report_knowledge_index_jobs(id,report_id,knowledge_fingerprint,status,attempt_count,request_count,usage_tokens,usage_status,finished_at)
    VALUES ('smoke-report-index-job',?,?,'complete',1,1,3,'known',datetime('now'))`).run(report.data.id,reportKnowledgeFingerprint);
  reportKnowledgeDb.prepare(`INSERT INTO report_knowledge_embedding_cache(profile_id,input_sha256,dimensions,vector_blob,vector_sha256,usage_tokens,usage_status,response_id)
    VALUES (?,?,3,?,?,3,'known','synthetic-backup-only')`).run(reportKnowledgeProfile,reportKnowledgeInput,reportKnowledgeVector,reportKnowledgeVectorHash);
  reportKnowledgeDb.close();
  const backup=await call('/api/admin/backups',{},'POST');equal(backup.status,200,'在线一致性备份');assert(backup.data.filename.endsWith('.zip'),'备份同时生成数据库与附件 ZIP 包');
  const backupFile=await fetch(`${base}/api/admin/backups/${encodeURIComponent(backup.data.filename)}/download`,{headers:{Cookie:cookie}});equal(backupFile.status,200,'备份文件下载');
  const archivePath=join(dataDir,backup.data.filename);writeFileSync(archivePath,Buffer.from(await backupFile.arrayBuffer()));
  equal((await call('/api/research-reports/'+report.data.id,undefined,'DELETE',researcherCookie)).status,200,'上传者软删除已备份报告');
  equal((await call('/api/research-reports/'+report.data.id+'/versions/'+replacedReport.data.versions[0].id+'/download',undefined,'GET',secondCookie)).status,404,'报告删除后其版本下载受限');
  equal((await call('/api/research-reports/'+report.data.id+'/data-attachments/'+rawTsv.id+'/versions/'+rawHistory.versions[0].id+'/download',undefined,'GET',secondCookie)).status,404,'报告删除后其原始数据历史版本下载受限');
  assert(!(await call('/api/research-reports',undefined,'GET',secondCookie)).data.some((item:any)=>item.id===report.data.id),'软删除报告从共享搜索结果移除');
  const workRoot=resolve('work');mkdirSync(workRoot,{recursive:true});
  crossRestoreDir=mkdtempSync(join(workRoot,'ivd-cross-volume-restore-'));
  equal(parse(archivePath).root.toUpperCase(),'C:\\','跨磁盘恢复归档来自 C 盘');equal(parse(crossRestoreDir).root.toUpperCase(),'D:\\','跨磁盘恢复目标位于 D 盘');
  const crossOldDb=new DatabaseSync(join(crossRestoreDir,'ivd.sqlite'));crossOldDb.exec('PRAGMA journal_mode=DELETE; CREATE TABLE cross_volume_marker(value TEXT); INSERT INTO cross_volume_marker VALUES (\'old-database\');');crossOldDb.close();
  mkdirSync(join(crossRestoreDir,'attachments'),{recursive:true});writeFileSync(join(crossRestoreDir,'attachments','old-cross-volume.txt'),'old attachment');
  const crossMoves:string[]=[];
  const crossRestored=await restoreBackup(archivePath,crossRestoreDir,{rename(from,to){
    crossMoves.push(from);
    assert(resolve(from).toLowerCase().startsWith(resolve(crossRestoreDir).toLowerCase()),'暂存及旧文件操作均位于目标 D 盘数据目录');
    equal(statSync(from).dev,statSync(dirname(to)).dev,'恢复文件重命名源与目标在同一数据卷');
    renameSync(from,to);
  }});
  assert(crossMoves.length===4,'跨磁盘恢复完成旧库、旧附件、数据库与附件四次本地卷移动');
  const crossDb=new DatabaseSync(join(crossRestoreDir,'ivd.sqlite'));equal((crossDb.prepare("SELECT name FROM materials WHERE code='SMOKE-NACl'").get() as any).name,'氯化钠验证物料（已核验）','C 盘归档恢复到 D 盘后业务数据库可读');crossDb.close();
  assert(readdirSync(crossRestoreDir).some(name=>name===crossRestored.safetyDir.split(/[\\/]/).pop()),'跨卷恢复保留原数据安全副本');
  for(let failAt=1;failAt<=4;failAt++){
    const faultDir=mkdtempSync(join(workRoot,`ivd-restore-fault-${failAt}-`));faultRestoreDirs.push(faultDir);
    const originalDb=new DatabaseSync(join(faultDir,'ivd.sqlite'));originalDb.exec('PRAGMA journal_mode=DELETE; CREATE TABLE original_marker(value TEXT); INSERT INTO original_marker VALUES (\'preserve-exactly\');');originalDb.close();
    mkdirSync(join(faultDir,'attachments'),{recursive:true});writeFileSync(join(faultDir,'attachments','original.txt'),`attachment-${failAt}`);
    const originalDbBytes=readFileSync(join(faultDir,'ivd.sqlite'));const originalAttachmentBytes=readFileSync(join(faultDir,'attachments','original.txt'));
    let operations=0;let injected=false;
    try{await restoreBackup(archivePath,faultDir,{rename(from,to){operations++;if(operations===failAt&&!injected){injected=true;throw new Error(`injected rename failure ${failAt}`);}renameSync(from,to);}});}
    catch(error){assert((error as Error).message.includes(`injected rename failure ${failAt}`),`恢复移动操作 ${failAt} 的故障被报告`);}
    assert(injected,`恢复文件操作 ${failAt} 注入了单次故障`);
    const afterFailureDbBytes=readFileSync(join(faultDir,'ivd.sqlite'));
    assert(afterFailureDbBytes.equals(originalDbBytes),`恢复文件操作 ${failAt} 失败后原数据库逐字节保留 (old=${originalDbBytes.length}/${createHash('sha256').update(originalDbBytes).digest('hex')}, current=${afterFailureDbBytes.length}/${createHash('sha256').update(afterFailureDbBytes).digest('hex')}, operations=${operations})`);
    assert(readFileSync(join(faultDir,'attachments','original.txt')).equals(originalAttachmentBytes),`恢复文件操作 ${failAt} 失败后原附件逐字节保留`);
    equal(readdirSync(join(faultDir,'attachments')).join(','),'original.txt',`恢复文件操作 ${failAt} 失败后原附件目录内容原样保留`);
  }
  restoreDir=mkdtempSync(join(tmpdir(),'ivd-restore-smoke-'));
  const oldDb=new DatabaseSync(join(restoreDir,'ivd.sqlite'));oldDb.exec('PRAGMA journal_mode=DELETE; CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker VALUES (\'keep-before-restore\');');oldDb.close();
  mkdirSync(join(restoreDir,'attachments'),{recursive:true});writeFileSync(join(restoreDir,'attachments','old.txt'),'preserve-before-restore');
  const restored=await run(['--experimental-strip-types','src/restore.ts',`--file=${archivePath}`],{DATA_DIR:restoreDir});assert(restored.includes('备份恢复完成'),'备份恢复命令完成');
  const restoredDb=restoreValidationDb=new DatabaseSync(join(restoreDir,'ivd.sqlite'));equal((restoredDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version,13,'恢复后迁移版本为 13');equal((restoredDb.prepare("SELECT name FROM materials WHERE code='SMOKE-NACl'").get() as any).name,'氯化钠验证物料（已核验）','恢复保留物料业务数据');equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM attachments').get() as any).n,1,'恢复保留既有通用附件索引');
  equal((restoredDb.prepare("SELECT status FROM report_knowledge_index_jobs WHERE id='smoke-report-index-job'").get() as any).status,'complete','备份恢复保留报告知识索引状态');
  const restoredKnowledgeVector=restoredDb.prepare('SELECT vector_blob,vector_sha256,dimensions FROM report_knowledge_embedding_cache WHERE profile_id=? AND input_sha256=?').get(reportKnowledgeProfile,reportKnowledgeInput) as any;
  assert(restoredKnowledgeVector&&restoredKnowledgeVector.dimensions===3,'备份恢复包含报告知识向量缓存维度');
  equal(createHash('sha256').update(Buffer.from(restoredKnowledgeVector.vector_blob)).digest('hex'),restoredKnowledgeVector.vector_sha256,'备份恢复报告知识向量缓存 SHA-256 一致');
  equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM research_reports WHERE deleted_at IS NULL').get() as any).n,1,'備份恢复保留备份时点的共享报告状态');
  equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM research_reports WHERE deleted_at IS NOT NULL').get() as any).n,1,'备份恢复保留已软删除报告审计状态');
  equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM research_report_versions WHERE report_id=?').get(report.data.id) as any).n,2,'备份恢复保留报告修订历史');
  equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM research_report_data_versions').get() as any).n,3,'备份恢复保留原始数据多个文件及替换历史');
  const restoredRefs=[...(restoredDb.prepare('SELECT stored_name,sha256 FROM attachments').all() as any[]),
    ...(restoredDb.prepare('SELECT storage_key AS stored_name,sha256 FROM research_report_versions').all() as any[]),
    ...(restoredDb.prepare('SELECT storage_key AS stored_name,sha256 FROM research_report_data_versions').all() as any[])];
  const restoredAttachment=restoredDb.prepare('SELECT stored_name,sha256 FROM attachments LIMIT 1').get() as any;restoredDb.close();restoreValidationDb=undefined;
  assert(readdirSync(restoreDir).some(name=>name.startsWith('restore-safety-')),'恢复前目标数据保存在安全目录');
  const restoredAttachmentBytes=readFileSync(join(restoreDir,'attachments',restoredAttachment.stored_name));
  equal(restoredAttachmentBytes.toString(),'smoke attachment','备份恢复保留附件原始字节');
  equal(createHash('sha256').update(restoredAttachmentBytes).digest('hex'),restoredAttachment.sha256,'恢复附件 SHA-256 与数据库索引一致');
  equal(readdirSync(join(restoreDir,'attachments')).length,restoredRefs.length,'恢复后附件目录无缺失或未索引文件');
  for(const item of restoredRefs){const bytes=readFileSync(join(restoreDir,'attachments',item.stored_name));equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,`恢复文件 ${item.stored_name} 与历史索引 SHA-256 一致`);}
  const excelExport=await call('/api/export/movements.xlsx');equal(excelExport.status,200,'库存流水 Excel 导出');
  console.log('SMOKE PASS: 六项二次审查缺陷、计算与单位校验、配液/冲销/配方共享权限、研发报告跨用户共享与作者/管理员编辑权限、Word/Excel 文件版本、多份原始数据与替换/软删除下载限制、审计、备份恢复全量文件 SHA-256、跨 C/D 盘与恢复故障回滚、库存/追溯/并发控制均通过。');
} finally {
  server.kill();
  await new Promise(resolvePromise=>server.once('close',resolvePromise));
  restoreValidationDb?.close();
  rmSync(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  if(restoreDir)rmSync(restoreDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  if(crossRestoreDir)rmSync(crossRestoreDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  for(const faultDir of faultRestoreDirs)rmSync(faultDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
import './test-isolation.mjs';
