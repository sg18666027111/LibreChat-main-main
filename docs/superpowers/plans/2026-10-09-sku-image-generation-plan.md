# SKU 图制作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` syntax for tracking.

**Goal:** 在现有单图改图结果和左侧栏独立入口之上，增加一个不调用 AI 的 SKU 图制作工作台，使用固定版式按多条文字稳定批量合成、持久化并交付图片。

**Architecture:** 新增独立的 SKU 任务域和 /api/sku-generation 路由；源图、左右图标和结果图均落到现有文件存储并以稳定文件 ID 串联。合成服务使用 Sharp 组合源图、图标和服务端 SVG 文字层，前端以独立路由、轮询任务状态和结果卡完成制作、重试、下载及回流。

**Tech Stack:** Express、Multer、Mongoose、现有 Files storage adapter、Sharp、SVG、React、React Router、Vitest/Jest（沿用仓库现有脚本）。

**Spec:** docs/superpowers/specs/2026-10-09-sku-image-generation-design.md

## Global Constraints

- 首版只实现模板 sku_side_icons_text_v1，不新增自由拖拽或模板管理。
- SKU 合成过程不调用 AI provider，不复用现有 AI 批量包装任务。
- 源图、图标、输出图都必须保存为稳定文件记录，任务只存文件 ID，不存临时代理 URL 或 base64。
- 所有读取、下载、重试和任务查询都校验当前用户及租户归属。
- 允许的图片格式为 PNG、JPEG/JPG、WebP；单文件大小上限为 8 MB。
- 空文字行不生成 SKU 图；每个非空文字行对应一个可独立重试的子任务。
- 保持既有 AI 生图、单图改图和 AI 批量包装流程不变；失败时保留已有结果和下载兜底。
- 不新增生产依赖；优先复用仓库已有 Sharp、文件存储和请求封装。
- 实现前若需要隔离工作区，遵循 superpowers:using-git-worktrees 的授权流程；计划阶段不修改现有用户变更。

## Review Focus

- 临时结果 URL 在过期或刷新后仍能进入 SKU：单图改图入口必须先落稳定源文件并只传 sourceFileId。
- 恶意或过长文字不会破坏 SVG：服务端必须转义文字、限制长度/行数并测试 <、&、换行和空行。
- 左右图标缺失、格式错误或超出边界时：提交前拒绝任务并返回可理解的字段级错误。
- 任务部分失败或取消时：成功结果保留，未开始项目可取消，失败项目可单独重试。
- 跨用户/租户访问文件或任务时：统一返回不存在/无权限结果，不泄露文件元数据。

---

### Task 1: 固定版式与确定性图片合成

**Files:**

- Create: api/server/services/SkuGeneration/skuTemplate.js
- Create: api/server/services/SkuGeneration/composeSkuImage.js
- Test: api/server/services/SkuGeneration/composeSkuImage.spec.js

**Interfaces:**

- Produces SKU_TEMPLATE_V1，包含 key: sku_side_icons_text_v1、width: 800、height: 800、主体安全区、左右图标锚点、文字区边界、最大文字行数、最大单行字符数和字体配置。
- Produces validateSkuInput({ textRows, templateKey }) -> { textRows, template } | throws { code, field, message }；过滤纯空白行，保留输入顺序。
- Produces composeSkuImage({ sourceBuffer, leftIconBuffer, rightIconBuffer, text, templateKey }) -> Promise<{ buffer: Buffer, mimeType: 'image/png', width: number, height: number, templateKey: string }>。

- [ ] Step 1: Write the failing tests

  在 composeSkuImage.spec.js 中覆盖：
  - 有效 PNG/JPEG/WebP 输入返回 800×800 PNG，输出可被 Sharp 读取，且输出尺寸固定。
  - 同样的三张输入和同样的文字返回相同的尺寸、mime type，并对输出 hash 稳定。
  - <script>&、引号和换行作为普通文字渲染，不进入 SVG 标签。
  - 纯空白行被过滤，超过模板最大行数/字符数和未知模板 key 会返回带 code、field 的校验错误。
  - 图标按模板最大边界缩放且不改变输出画布，源图按主体安全区等比缩放并居中。

- [ ] Step 2: Run the focused test and verify it fails

  Run: npx vitest run api/server/services/SkuGeneration/composeSkuImage.spec.js
  Expected: FAIL because the new module and exported functions do not exist.

- [ ] Step 3: Implement the template and compositor

  在 skuTemplate.js 固定模板常量和验证规则；在 composeSkuImage.js 中用 Sharp 读取图片元数据，用 SVG 生成经过 XML 转义、固定字体和换行规则的文字层，再以 composite 合成主体、左右图标和文字层。所有几何参数从模板常量读取，不接受客户端坐标。

- [ ] Step 4: Run the focused test and verify it passes

  Run: npx vitest run api/server/services/SkuGeneration/composeSkuImage.spec.js
  Expected: PASS with deterministic hash and validation coverage.

- [ ] Step 5: Commit

  git add api/server/services/SkuGeneration/skuTemplate.js api/server/services/SkuGeneration/composeSkuImage.js api/server/services/SkuGeneration/composeSkuImage.spec.js
  git commit -m "feat: add deterministic SKU image compositor"

### Task 2: SKU 任务数据模型与持久化方法

**Files:**

- Create: packages/data-schemas/src/schema/skuBatchTask.ts
- Create: packages/data-schemas/src/types/skuBatchTask.ts
- Create: packages/data-schemas/src/models/skuBatchTask.ts
- Create: packages/data-schemas/src/methods/skuBatchTask.ts
- Modify: packages/data-schemas/src/schema/index.ts
- Modify: packages/data-schemas/src/types/index.ts
- Modify: packages/data-schemas/src/models/index.ts
- Modify: packages/data-schemas/src/methods/index.ts
- Test: packages/data-schemas/src/methods/skuBatchTask.spec.ts

**Interfaces:**

- Produces ISkuBatchTask with tenantId?、userId、batchId、itemId、itemIndex、sourceFileId、leftIconFileId、rightIconFileId、templateKey、text、status、outputFileId?、error?、retryCount、processingLeaseUntil?、processingWorkerId?、completedAt?、expiresAt?、createdAt、updatedAt。
- Produces status unions pending | running | succeeded | failed | cancelled for items and pending | running | completed | partial_failed | failed | cancelled for serialized batches.
- Produces createSkuBatchTaskItem(input)、getSkuBatchTaskItem({ batchId, itemId, userId, tenantId })、getSkuBatchTaskItems({ batchId, userId, tenantId })、updateSkuBatchTaskItem({ batchId, itemId, statuses, updates })，and lease-aware acquireSkuBatchTaskLease({ batchId, itemId, workerId, leaseMs }).
- The model applies tenant isolation, unique index { batchId: 1, itemId: 1 }, user/batch lookup index, status/lease index, and expiresAt TTL index, matching existing ImageBatchTask patterns.

- [ ] Step 1: Write the failing tests

  在 skuBatchTask.spec.ts 中验证：
  - 创建任务条目会保存用户、租户、文件 ID、文字和默认状态 pending。
  - 相同 batchId/itemId 不能重复，查询按 itemIndex/createdAt 顺序返回。
  - get... 使用用户和租户过滤；错误归属任务查询不到。
  - lease 只能从 pending 取得，过期 lease 可以被再次取得，状态更新只接受指定前置状态。

- [ ] Step 2: Run the focused test and verify it fails

  Run: npx vitest run packages/data-schemas/src/methods/skuBatchTask.spec.ts
  Expected: FAIL because schema, model and methods are not registered.

- [ ] Step 3: Implement schema, types, model and methods

  复制现有 imageBatchTask 的注册和租约模式，但去除 provider/model/prompt 字段；每条文字是一个任务文档。更新四个 package index，使 create...Methods 在数据层初始化后可用。

- [ ] Step 4: Run focused tests and typecheck

  Run: npx vitest run packages/data-schemas/src/methods/skuBatchTask.spec.ts
  Expected: PASS.

  Run: npx tsc -p packages/data-schemas/tsconfig.build.json --noEmit
  Expected: PASS with no new type errors.

- [ ] Step 5: Commit

  git add packages/data-schemas/src/schema/skuBatchTask.ts packages/data-schemas/src/types/skuBatchTask.ts packages/data-schemas/src/models/skuBatchTask.ts packages/data-schemas/src/methods/skuBatchTask.ts packages/data-schemas/src/schema/index.ts packages/data-schemas/src/types/index.ts packages/data-schemas/src/models/index.ts packages/data-schemas/src/methods/index.ts packages/data-schemas/src/methods/skuBatchTask.spec.ts
  git commit -m "feat: persist SKU batch task items"

### Task 3: 后端文件保存、任务编排和 HTTP API

**Files:**

- Create: api/server/services/SkuGeneration/skuFileStorage.js
- Create: api/server/services/SkuGeneration/skuBatchService.js
- Create: api/server/services/SkuGeneration/skuBatchSerialization.js
- Create: api/server/routes/skuGeneration.js
- Modify: api/server/routes/index.js
- Test: api/server/services/SkuGeneration/skuBatchService.spec.js
- Test: api/server/routes/**tests**/skuGeneration.spec.js

**Interfaces:**

- saveSkuSourceFile({ req, file, kind }) -> Promise<{ fileId, filename, contentType, bytes, width, height }>：校验图片并以 FileContext.image_generation 保存，kind 为 source | icon。
- createSkuBatch({ userId, tenantId, storageConfig, sourceFileId, leftIconFileId, rightIconFileId, templateKey, textRows }) -> Promise<SerializedSkuBatch>：校验文件归属、模板和文字，创建每个非空文字条目并异步启动本地 worker。
- getSkuBatch(batchId, { userId, tenantId }) -> Promise<SerializedSkuBatch | null>：返回任务摘要、条目状态以及成功条目的 outputFileId 和预览/下载 URL。
- cancelSkuBatch(batchId, { userId, tenantId }) -> Promise<SerializedSkuBatch>：只把尚未开始的条目标记为 cancelled。
- retrySkuBatchItem({ batchId, itemId, userId, tenantId }) -> Promise<SkuBatchItem>：只接受 failed，重置错误并重新排队本地合成。
- getAuthorizedSkuFile({ fileId, userId, tenantId }) -> Promise<FileRecord | null> 和 readAuthorizedSkuFile(req, file) -> Promise<{ buffer, contentType }>：复用现有 storage strategy 读取并再次校验 MIME/大小。

- [ ] Step 1: Write failing service and route tests

  Service tests mock compositor、data-schema methods 和文件 storage，验证：
  - 创建 3 条有效文字只创建 3 个 item，空行不创建；
  - 源图/图标归属不匹配或缺少任一图标时拒绝；
  - 单条合成成功保存 output file 并更新 succeeded/outputFileId；
  - 一条失败不会抹掉其他成功结果，批次序列化为 partial_failed；
  - cancel 只取消未运行条目，retry 只允许 failed 条目。

  Route tests 验证：
  - POST /api/sku-generation/sources 接收 multipart file，超过 8 MB 或非图片返回 400；
  - POST /api/sku-generation/batches、GET /batches/:id、cancel、retry 和文件下载均要求 JWT 且不能跨用户/租户；
  - 文件下载对 ?download=1 返回 attachment，默认 inline。

- [ ] Step 2: Run tests to verify they fail

  Run: npx vitest run api/server/services/SkuGeneration/skuBatchService.spec.js api/server/routes/**tests**/skuGeneration.spec.js
  Expected: FAIL because service, route and router registration do not exist.

- [ ] Step 3: Implement stable source/result storage

  在 skuFileStorage.js 中沿用 uploadImageBuffer、getStrategyFunctions 和 db.findFileById；源素材和结果文件设置与应用文件生命周期一致的过期时间，保存失败时清理已经创建的文件记录。输出命名包含 batch/item 标识但响应只暴露稳定文件 ID 和 API 路径。

- [ ] Step 4: Implement batch orchestration

  在 skuBatchService.js 中顺序处理一个 batch 的 item，使用 data-schema lease 防止重复 worker；读取三张已授权图片后调用 Task 1 的 composeSkuImage，保存结果并更新状态。每次状态变化更新 batch 聚合摘要；worker 不依赖 provider 轮询，应用进程内通过已存在的任务记录恢复 pending/expired-running 项目。

- [ ] Step 5: Implement routes and register router

  在 skuGeneration.js 使用 requireJwtAuth、config middleware 和 Multer memory storage，暴露：
  - POST /sources；
  - POST /batches；
  - GET /batches/:id；
  - POST /batches/:id/cancel；
  - POST /batches/:id/items/:itemId/retry；
  - GET /files/:fileId。

  将 router 挂到 api/server/routes/index.js 的 /api/sku-generation，把业务错误映射为 400/404/409/410，避免将底层存储路径或跨租户文件信息写入响应。

- [ ] Step 6: Run focused tests and API checks

  Run: npx vitest run api/server/services/SkuGeneration/skuBatchService.spec.js api/server/routes/**tests**/skuGeneration.spec.js
  Expected: PASS.

  Run: npm run test:api -- --runInBand
  Expected: PASS for existing API suite plus the new SKU route/service tests.

- [ ] Step 7: Commit

  git add api/server/services/SkuGeneration/skuFileStorage.js api/server/services/SkuGeneration/skuBatchService.js api/server/services/SkuGeneration/skuBatchSerialization.js api/server/routes/skuGeneration.js api/server/routes/index.js api/server/services/SkuGeneration/skuBatchService.spec.js api/server/routes/**tests**/skuGeneration.spec.js
  git commit -m "feat: add SKU generation API"

### Task 4: SKU 页面、预览和批量结果交互

**Files:**

- Create: client/src/routes/SkuGeneration/types.ts
- Create: client/src/routes/SkuGeneration/api.ts
- Create: client/src/routes/SkuGeneration/SkuPreview.tsx
- Create: client/src/routes/SkuGeneration/SkuGeneration.tsx
- Create: client/src/routes/SkuGeneration/SkuGeneration.spec.tsx
- Modify: client/src/routes/index.tsx

**Interfaces:**

- SkuBatchItem and SkuBatchSummary mirror the serialized API fields: batchId、itemId、itemIndex、text、status、outputFileId?、previewUrl?、downloadUrl?、error?。
- uploadSkuFile(file: File, kind: 'source' | 'icon') -> Promise<SkuFile>。
- createSkuBatch(input: { sourceFileId: string; leftIconFileId: string; rightIconFileId: string; templateKey: string; textRows: string[] }) -> Promise<SkuBatchSummary>。
- getSkuBatch(batchId: string) -> Promise<SkuBatchSummary>、cancelSkuBatch(batchId: string)、retrySkuBatchItem(batchId: string, itemId: string)。
- SkuPreview({ sourceUrl, leftIconUrl, rightIconUrl, text }) renders the same fixed 800×800 visual hierarchy as the server template and never accepts arbitrary coordinates.

- [ ] Step 1: Write failing component and API tests

  在 SkuGeneration.spec.tsx 验证：
  - 读取 sourceFileId 和 sourceType query 参数后显示源图和“来自单图改图”标签；
  - 未选择源图时显示上传入口；上传左右图标和添加/删除/排序文字行后，预计数量等于非空行数；
  - 未完成三张图片或文字行为空时“批量生成”不可提交；
  - 提交后按 2 秒间隔轮询，显示每个 item 的 pending/running/succeeded/failed/cancelled，并在部分失败时提供单项重试；
  - 成功结果显示预览、下载和“再次制作 SKU 图”“继续单图改图”两个回流动作；
  - API helper 将 multipart 上传和 JSON body 发送到约定路径，并将服务端错误消息映射到表单区域。

- [ ] Step 2: Run the focused test and verify it fails

  Run: npx vitest run client/src/routes/SkuGeneration/SkuGeneration.spec.tsx
  Expected: FAIL because route modules and API helpers do not exist.

- [ ] Step 3: Implement API helpers and shared types

  在 api.ts 中使用现有 client request 封装，不在组件中拼接裸 fetch；统一处理 401、404、409、410 和 field error。文件响应使用返回的 API URL，不把源文件转成长期 base64。

- [ ] Step 4: Implement fixed preview and page state

  页面按源图、SKU 配置、结果三块组织。使用本地 object URL/服务端 file URL 做预览，文字编辑器保持输入顺序并过滤空行；提交后维护 batchId，只轮询未完成任务，卸载组件时清理 timer 和 object URL。结果操作通过稳定 outputFileId 的 API 路径生成下一次制作或单图改图所需的数据。

- [ ] Step 5: Register lazy route and run tests

  在 client/src/routes/index.tsx 增加 loadSkuGeneration 和 /sku-generation 路由；运行：

  npx vitest run client/src/routes/SkuGeneration/SkuGeneration.spec.tsx

  Expected: PASS.

- [ ] Step 6: Commit

  git add client/src/routes/SkuGeneration/types.ts client/src/routes/SkuGeneration/api.ts client/src/routes/SkuGeneration/SkuPreview.tsx client/src/routes/SkuGeneration/SkuGeneration.tsx client/src/routes/SkuGeneration/SkuGeneration.spec.tsx client/src/routes/index.tsx
  git commit -m "feat: add SKU generation workbench"

### Task 5: 左侧栏入口与单图结果快捷链路

**Files:**

- Modify: client/src/hooks/Nav/useSideNavLinks.ts
- Modify: client/src/routes/ImageGeneration.tsx
- Modify: client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
- Test: client/src/routes/SkuGeneration/SkuGeneration.spec.tsx (extend handoff cases)

**Interfaces:**

- Nav adds id: sku-generation、label SKU 图制作、route /sku-generation，using an existing lucide icon and current permission/feature visibility conventions.
- Image result action calls handleMakeSkuFromResult(result): convert the result to a validated File, call uploadSkuFile(file, 'source'), then navigate to /sku-generation?sourceFileId=<id>&sourceType=image-edit-result.
- Existing handleUseResultAsSource and “基于此图修改” behavior remain unchanged.
- SKU result “继续单图改图” uses the existing ImageGeneration source handoff；“再次制作 SKU 图” navigates to the SKU page with the output file ID.

- [ ] Step 1: Write failing handoff tests

  Extend the existing ImageGeneration result test coverage to assert:
  - “制作 SKU 图” appears beside the existing “基于此图修改” action；
  - clicking it uploads the result through the SKU source endpoint and navigates with sourceFileId and sourceType=image-edit-result；
  - upload failure keeps the user on the result card, shows an understandable error and leaves the existing download action available；
  - the existing edit handoff still calls handleUseResultAsSource and does not navigate to SKU。

- [ ] Step 2: Run tests to verify they fail

  Run: npx vitest run client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
  Expected: FAIL because the new result action, nav link and handoff are not present.

- [ ] Step 3: Implement the sidebar link

  Add the left nav item using current useSideNavLinks ordering and route navigation conventions. Do not move or rename existing AI 生图 / AI 视觉画布 entries.

- [ ] Step 4: Implement result-card handoff

  Add the new action to the result card and inject a navigate callback at the page level. Reuse existing imageToFile and validateUploadFile checks, then call the Task 4 upload helper. Keep temporary result URLs out of the query string and preserve existing toast/error handling style.

- [ ] Step 5: Run focused tests and route checks

  Run: npx vitest run client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx client/src/routes/SkuGeneration/SkuGeneration.spec.tsx
  Expected: PASS.

- [ ] Step 6: Commit

  git add client/src/hooks/Nav/useSideNavLinks.ts client/src/routes/ImageGeneration.tsx client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx client/src/routes/SkuGeneration/SkuGeneration.spec.tsx
  git commit -m "feat: link image editing results to SKU generation"

### Task 6: Cross-layer verification and release hardening

**Files:**

- Modify: api/server/services/SkuGeneration/\*.js only for fixes found by verification
- Modify: client/src/routes/SkuGeneration/\*.tsx only for fixes found by verification
- Test: existing SKU tests and build/typecheck outputs

**Interfaces:**

- No new public API; this task verifies the interfaces from Tasks 1–5 remain consistent.

- [ ] Step 1: Run package and feature-focused tests

  Run:
  - npx vitest run api/server/services/SkuGeneration api/server/routes/**tests**/skuGeneration.spec.js packages/data-schemas/src/methods/skuBatchTask.spec.ts client/src/routes/SkuGeneration client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx

  Expected: PASS.

- [ ] Step 2: Run project verification

  Run:
  - npm run build:client
  - npm run build:api
  - npx tsc -p packages/data-schemas/tsconfig.build.json --noEmit

  Expected: all commands exit 0 with no SKU-related warnings/errors.

- [ ] Step 3: Manually verify the approved flows

  Verify:
  - single-image edit result → “制作 SKU 图” → source preview;
  - left sidebar → upload source → configure icons/text → generate;
  - multiple text rows produce one output each with stable preview/download;
  - partial failure keeps successful outputs and retries only the failed item;
  - result “再次制作 SKU 图” and “继续单图改图” preserve the correct source file.

- [ ] Step 4: Review diff and commit hardening fixes

  Run git diff --check and inspect git diff main...HEAD for accidental changes to existing AI flows, temporary URL leakage, or untracked test fixtures. Commit any fixes with a focused message; do not stage the pre-existing AGENTS.md change.
