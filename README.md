# IVD 研发物料工作台

面向组织内部研发团队的自部署物料管理系统，覆盖物料档案、真实批次、库存变更、组织共享配方、配液执行、自制试剂、批次追溯和研发报告归档。

## 技术与数据

- 前端：React、TypeScript、Vite；服务端：Express 5、Node.js 24。
- 数据：SQLite 单节点事务存储；数量以最多 6 位小数的十进制文本保存，计算保留单位换算的完整有理因子，只在最终结果处舍入。
- 文件：附件保存在 `DATA_DIR/attachments`，数据库记录对象关联和 SHA-256 摘要。
- 文献检索：本地 PDF.js 文本解析、SQLite 元数据/证据与向量缓存、自部署 Qdrant；管理员可连接独立 OpenAI-compatible Embedding 服务。
- AI：Pi Agent SDK + Pi AI provider；持久任务队列、独立 Worker、报告与文献证据、用户私有会话，以及确认后写入的 AI 配方/配液建议。
- 部署：Docker Compose 运行 Web/API、AI Worker、文献 Worker 与 Qdrant，共享 SQLite/附件卷并单独保存 Qdrant 数据卷；提供直接 HTTP 和可选 Caddy HTTPS 配置。

当前方案适用于单节点、多用户共享同一服务。它不覆盖多节点并行写入；如需横向扩展，应迁移 PostgreSQL 并重新验证事务边界。Embedding 与聊天模型使用独立服务端配置；研发报告知识和文献共用管理员配置的 Embedding profile 与密钥，但写入不同的 Qdrant 命名空间。报告语义外发默认关闭；管理员需在“组织内研发知识”页单独启用。启用后报告标题、说明、当前有效结构化观察、证据摘录和显式提交的检索词会发送到配置的 Embedding endpoint；不发送完整报告文件、原始数据附件或聊天会话。关闭后页面和 Agent 使用本地关键词检索，Worker 不领取或巡检报告索引任务；已开始的网络请求可能完成。系统不会生成模拟分析结果。

观察值比较采用保守判定：只有比较字段与指标一致、每条记录都有显式相同单位、并且实验条件完整一致时才输出差值；缺少单位、指标或条件及数值不严格时只并列显示和指出缺项。无量纲单位也需明确填写 `1` 或 `dimensionless`。

## 本机运行

需要 Node.js 24。首次启动会顺序应用 `migrations/001_init.sql` 和增量迁移；迁移保留既有库存流水和余额。当前 schema migration 为 v12，数据库默认在项目 `data/ivd.sqlite`，可通过 `DATA_DIR` 指定持久化目录。

1. 安装依赖：`npm ci`
2. 显式创建首个管理员（PowerShell）：

   ```powershell
   $env:ADMIN_NAME = '研发管理员'
   $env:ADMIN_EMAIL = 'admin@organization.example'
   $env:ADMIN_PASSWORD = '替换为至少12位的组织密码'
   npm run setup:admin
   Remove-Item Env:ADMIN_NAME,Env:ADMIN_EMAIL,Env:ADMIN_PASSWORD
   ```

3. 开发时，分别运行 `npm run dev` 和 `npm run dev:client`。
4. 单服务运行时先执行 `npm run build`，再执行 `npm start`；网页和 API 共用 `PORT`。

系统不会自动创建管理员或演示账号。只有手动执行 `npm run seed:demo` 才会添加带有演示来源标记的样例数据。

## Docker Compose

复制 `.env.example` 为 `.env`，按需设置端口和 Cookie。Compose 会启动 Web/API、AI Worker、文献 Worker、研发报告知识 Worker 与 Qdrant；应用和三个 Worker 挂载同一个 `ivd-data` 卷，Qdrant 使用独立的 `qdrant-data` 卷。镜像由 GitHub Actions 发布到 `ghcr.io/xiaosageou/ivd-material-workbench`。私有镜像需要先使用有 `read:packages` 权限的 GitHub 凭据执行 `docker login ghcr.io`；可通过 `IVD_IMAGE` 指定其他镜像或固定版本。直接 HTTP 部署（例如受控内网）使用 `COOKIE_SECURE=false`：

```powershell
docker compose pull
docker compose up -d
$env:ADMIN_NAME = '研发管理员'
$env:ADMIN_EMAIL = 'admin@organization.example'
$env:ADMIN_PASSWORD = '替换为至少12位的组织密码'
docker compose exec -e ADMIN_NAME -e ADMIN_EMAIL -e ADMIN_PASSWORD ivd-workbench npm run setup:admin
Remove-Item Env:ADMIN_NAME,Env:ADMIN_EMAIL,Env:ADMIN_PASSWORD
```

生产模式默认给会话 Cookie 加 `Secure`。直接 HTTP 访问必须显式设置 `COOKIE_SECURE=false`；使用 HTTPS 时设为 `true`。启用 Caddy 配置前，在 `.env` 中填写 DNS 已指向此服务器的 `DOMAIN` 并设置 `COOKIE_SECURE=true`，随后运行：

```powershell
docker compose --profile https up -d
```

Caddy 监听 80/443 并将 HTTPS 请求转发给应用。DNS 和防火墙需允许证书签发与续期流量进入 80/443。真实聊天模型由管理员在“模型设置”中配置 API Key、provider、模型 ID 和服务地址；密钥保存在服务端数据目录 `ai-api-key` 文件中，也可通过 `IVD_AI_API_KEY` 环境变量提供，页面保存的密钥优先。文献与研发报告知识索引共用向量化配置；管理员可在“文献向量化”中设置 API Key、地址、模型和维度。密钥存于数据目录的 `embedding-api-key` 文件，也可使用环境变量 `IVD_EMBEDDING_API_KEY`，本地文件优先。报告知识与文献分别写入独立 Qdrant 集合，启用在线向量化会将页面所示资料内容发送至配置的 Embedding endpoint。Qdrant 使用内部地址 `http://qdrant:6333`，可通过 `QDRANT_API_KEY` 启用 API 密钥。聊天模型密钥不写入 SQLite 或浏览器；本地文件为明文，请限制数据目录访问权限。向量化密钥同样为本地明文文件，请限制数据目录访问。当前开发环境没有 Docker；Compose 容器、共享卷、容器网络与 Caddy 证书签发仍需在部署主机验收。

## 库存、单位与配方规则

- 物料档案与厂家批次分开管理；库存余额按批次和库位保存。入库、使用、移库、报损和盘点调整均写入流水。
- 质量、体积、物质的量、活性和计数单位按已知换算规则转换；未知单位或不兼容量纲会明确报错。管理员可配置组织单位、分类、编号前缀、低库存默认值和临期提醒天数。创建物料后，其量纲和库存单位固定，避免改写历史数量的解释。
- 计算支持比例、质量浓度、摩尔浓度、母液稀释、体积分数和固定添加。表达式保留原始体积单位的换算因子，避免 nL 等微量输入在中间步骤被舍入；固定添加不随目标产量缩放。计算只在最终结果处舍入。
- 母液稀释按实际选中的批次浓度重新计算。拆分到多个批次时，各组分先填写占该组分目标用量的分配百分比，合计必须为 100%；每批母液再按该批次自己的浓度分别计算。完成时服务端重新核对批次、浓度、库位、理论量和实际量；有偏差时需明确确认并填写原因。
- 配方对组织内所有已登录成员共享查看、计算及使用已发布版本。只有配方创建者或管理员可新增版本、发布和停用版本。已发布版本不原地修改，发布人、版本作者及操作记录留痕。配方共享不代表匿名公开访问。
- 配液任务分别记录创建人与实际完成执行人。旧记录证据不足时完成执行人显示“历史未记录”，不从原负责人字段推断。
- 中止配液按同一单位与量纲规则校验实际消耗，可记录只加入部分组分或少于理论量的实耗；保存中止操作人、所选批次浓度/单位、分配比例、批次理论用量及实际用量。
- 完成配液可入库，也可记录产物立即使用。配液修正采用追加冲销流水；报表同时给出毛消耗、冲销和净消耗，按物料与单位分组，不合并不同物料或单位的总量。

## 导入、导出、附件和备份

- 管理员可用 CSV 或 XLSX 导入物料；预览校验全部通过后才会整体写入。
- 物料档案与库存流水支持 CSV、XLSX 导出。
- 新增“研发报告”独立导航。所有已登录组织成员可搜索、查看和下载报告；报告上传者与管理员可修改标题/说明、替换文件或软删除。每次替换生成新版本并留痕，已发布版本历史可下载。正文支持 `.doc`、`.docx`、`.xls`、`.xlsx`，每份报告最大 25 MB；网页提供附件下载，不解析或在线编辑全部 Word/Excel 格式，正文修改后请从本机 Office 上传修订文件。
- 每份报告可添加多个原始数据附件、替换附件版本或软删除。单个文件最大 20 MB，每次最多 8 个且合计不超过 50 MB。支持实验常见文本表格、Excel、PDF、PNG/JPEG/WebP/TIFF/GIF、ZIP 及扩展名不超过 12 个 ASCII 字母/数字的仪器导出文件；未知格式以 `application/octet-stream` 附件下载，不执行也不在网页中解析。主动内容或可执行扩展名（包括 HTML、JavaScript、脚本、SVG、EXE 等）会被拒绝。
- 原始文件采用随机存储键，展示文件名会剥除目录路径与控制字符；所有报告和原始数据下载均要求登录，报告或附件软删除后其文件下载立即返回 404。软删除保留版本和文件以支持审计及历史备份；附件内容不会以内嵌预览方式执行。
- 既有通用附件仍支持 PDF、PNG、JPEG、WebP、CSV、XLSX，单个文件不超过 15 MB。
- 系统设置可创建数据库与附件一体化 ZIP 备份，清单包含每个文件的 SHA-256 摘要。恢复前停止应用，并在与原来相同的 `DATA_DIR` 运行：

  ```powershell
  npm run restore:backup -- --file=备份文件.zip
  ```

  恢复会先校验路径、摘要、SQLite 完整性、外键和所有通用附件、报告正文修订版、原始数据附件版本的数据库关联；解包暂存目录创建在目标 `DATA_DIR` 内，使跨盘备份恢复的文件安装发生在同一数据卷。旧数据库、旧附件目录、新数据库和新附件目录分别跟踪移动状态；任一阶段失败时只回滚本次已安装文件并恢复原文件。恢复前的数据保留在 `restore-safety-*` 目录。不要在服务仍运行或存在未清理的 SQLite WAL 时执行恢复。

## 文献知识库与在线向量检索

## 研发报告知识与 Agent 检索

- 报告语义外发默认关闭。管理员在“组织内研发知识”页明确启用后，知识页面和 Agent 才使用 Qdrant 报告集合进行语义检索；关闭时页面与 Agent 只做本地关键词检索。候选结果回 SQLite 校验报告版本和有效证据。研发报告集合使用 `ivd_rpt_*`，文献集合使用 `ivd_lit_*`。
- 启用后，分析完成或人工复核更新会按当前报告版本、证据哈希和观察值指纹排入 SQLite 持久队列。替换报告、更新元数据、删除来源或人工更正后，旧指纹不再进入当前检索。Worker 保留活动租约，发布旧指纹时不清除新指纹点；过期失败任务不会由巡检无限重试，管理员可显式开启有限的新重试次数。
- 报告知识 Worker 与文献共用管理员配置的 Embedding profile、endpoint、密钥和累计请求/token预算。索引发送标题、说明、结构化观察、证据摘录；用户提交语义查询时发送查询词。报告附件与会话历史不进入此报告向量索引。关闭外发会暂停排队任务并阻断后续请求，已经发出的请求可能完成。
- ZIP 备份包括 SQLite 中的报告索引任务、累计 usage 和 SHA 校验后的本地向量缓存；Qdrant 是独立存储卷，不会写入 ZIP。恢复后运行 `npm run report-knowledge:worker`，Worker 会核对 Qdrant 现有点并从本地缓存重建缺失集合；缺少缓存且 Embedding usage 为未知时不会再次外呼。Docker Compose 部署自动启动 `ivd-report-knowledge-worker`。
- Qdrant 未配置或不可用时，Agent 检索退回当前有效数据的关键词路径；未知 Embedding usage 会持久保留并阻断额外请求。合成测试不代表真实 Embedding 语义质量或生产服务可用性。

## 文献知识库与在线向量检索

- 文献知识库独立于研发报告。已登录成员可共享查看、搜索和下载；文献上传者与管理员可编辑书目、替换全文、删除及恢复。替换文件保留版本和哈希；旧版引用在全文/元数据变更后立即失效。
- 首版支持 PDF、DOCX、TXT 和 Markdown。PDF.js 在本地逐页解析文本并保留页码；扫描件标为待 OCR，文字层缺失/损坏/不支持的文件显示覆盖状态，不将图片识别或 Word/Excel 完整解析作为已验证能力。详情页面可下载原文件并查看解析片段、定位和任务历史。
- 关键词检索离线可用；语义/混合检索先把查询发给管理员配置的 Embedding 服务，再从 Qdrant 召回候选并回 SQLite 复验当前文献版本、范围、片段哈希及索引代。向量分数只用于排序，不表示事实可信度。Embedding/Qdrant 未配置或不可用时清楚显示关键词降级。
- `IVD_EMBEDDING_API_KEY` 与聊天模型密钥分开。管理员配置独立 endpoint、模型、维度、前缀、超时与批次/输入上限、每任务 token/请求预算和每日检索预算；凭据不进入数据库或浏览器。每任务用量累计保留，服务缺少可核验 usage 时标记未知并停止后续 Embedding 外呼/重试，不把未知计为零、不估算费用。
- 向量索引由异步文献 Worker 执行，SQLite 保存 profile/generation、完整性清单、证据和 SHA-256 向量缓存；只有整代写入 Qdrant 并通过复验后才发布。备份包含文献原文件、元数据、任务、证据和缓存，恢复后可在无在线模型调用时从缓存重建 Qdrant 索引。模型密钥和 Qdrant 密钥不进入备份。
- 研发助手只在用户明确选择的文献或集合范围内搜索与读取证据；空范围保持为空，报告/配方会话不会自动扩大为全库。历史消息中的文献引用在继续提交模型前再次校验有效性。文献只能作为研发建议的依据，计算、配方草稿和库存写入继续经过确定性规则与人工确认。
- 当前阶段、可复现回归命令及环境边界见 `docs/文献知识库实施状态-20261028.md`；第三方依赖版本、许可与官方来源见 `docs/文献知识库依赖来源与许可-20261028.md`。

## 构建、回归与验收

```powershell
npm run build
npm run test:smoke
npm run test:ai-smoke
npm run test:ai-contract
npm run test:ai-worker-health
npm run test:migration
npm run test:literature-smoke
npm run test:literature-worker-smoke
npm run test:embedding-contract
$env:QDRANT_URL = 'http://127.0.0.1:6335'  # 指向隔离的真实 Qdrant 实例
npm run test:literature-qdrant
npm run test:literature-index
npm run test:isolation
```

所有 `test:*` 脚本通过 `src/test-runner.mjs` 先创建专属临时 `DATA_DIR`，再启动业务入口；数据库导入护栏会在 SQLite 打开前拒绝缺少隔离目录或指向项目默认目录。`npm run test:isolation` 以临时假默认路径验证这些拒绝。集成验证 v1 旧库到 v12 迁移保数、报告/文献共享权限、版本与附件、全量备份恢复 SHA 校验、计算精度与库存追溯，以及 Pi 接入、无凭据等待、解析定位、任务竞态、来源校验、会话与建议隔离、AI 配方/配液建议确认和幂等。文献集成测试通过本机真实 Qdrant 1.20.0 和本地 HTTP 合成 Embedding，创建完整备份并恢复到全新隔离数据库后删除专属 Qdrant collection、清空 Embedding key，再由 Worker 用缓存离线重建；另记录20条固定中英关键词查询命中表。这些结果验证实现路径，不代表真实模型语义质量。AI任务预算累计 Pi provider 报告的 input/output/cacheRead/cacheWrite `totalTokens`，跨工具轮次和重试持久累计；缺失、不一致或 SDK 默认全零usage均保留已知数并停止后续调用，不估算费用。正式 AI 契约含本地HTTP SSE和真实 Pi OpenAI-compatible adapter，但不连接外网或真实模型。恢复失败注入仅针对临时夹具，并逐字节比对原数据库与附件。

首轮独立审核指出，较早一次索引测试可能遗漏 `DATA_DIR`，默认数据库历史迁移/触碰情况没有主代理独立核实。此前“默认库未迁移”的结论已在文献实施状态和交付报告中撤回；本轮测试使用隔离runner，未读取或检查默认数据库。

2026-10-28 返修在正式 AI 契约回归中补充并通过：多项 `evidence_gaps` 归档、拒绝模型伪报 `program_calculation`/`human_entry`、所选报告范围过滤、人工更正参与检索/比较及重分析、同字段不同定位不继承更正、删除资料后的历史回答上下文过滤、Pi 请求 `maxTokens` 透传，以及任务租约被接管后旧 Worker 不写消息或进度事件。CSV/TSV 引号内换行、分隔符与转义双引号已有回归；旧版非 CSV/TSV 解析结果仍可读取，CSV/TSV 必须使用当前解析器重解析。早期浏览器记录仅显示预置的管理员更正值和成员共享知识；没有通过页面表单提交人工复核。第五轮另以管理员真实点击、输入并提交 1.30 mg/mL 复核，确认知识卡保留原模型 1.25 mg/mL 与说明；成员登录后只读查看共享知识和报告，作者/管理员编辑入口对成员隐藏。管理员从报告页面发起重新分析后，隔离 Worker 完成本地解析并将任务置于“等待模型配置”。逐步页面快照与截图见 `output/playwright/fifth-review-ui-20261028/`。配方建议使用本地合成夹具生成，不代表真实模型调用。

旧独立探针 `npx tsx work/ai-review-check.ts` 保持原样；运行至模型伪造观察类型检查时，脚本未捕获 validator 对非法类型的预期拒绝而提前退出。该脚本、额外探针资料及原始证据日志未改写；返修后重跑输出单独记录在 `work/ai-review-check-fixed-20261028.txt`。完整修复断言以 `npm run test:ai-contract` 为准。

2026-10-28 第二轮独立复审返修：修正缺少单位仍被判 `comparable:true` 的问题；比较值拒绝 `null`、空串、布尔值和非十进制字符串，单位必须显式提供，指标与比较字段一致、实验条件对象完整且一致方可计算。对同一 chunk/locator 内多个样本或指标，重分析只按结构化身份继承更正；身份不明或不匹配时置冲突并清空带入的更正值。复跑探针为 `npx tsx work/ai-review-check-v2.ts`，输出 `work/ai-review-check-v2-fixed-20261028.log`。

真实模型连通性与输出质量、Docker Compose 容器/共享卷、Caddy TLS 和组织生产报告分析尚未在本机环境验证；Pi faux provider 仅验证隔离协议、结构与确认闭环，不代表外部服务或科学结论。Worker 心跳在隔离本机进程中实测；Compose 健康检查仍需部署主机验收。


