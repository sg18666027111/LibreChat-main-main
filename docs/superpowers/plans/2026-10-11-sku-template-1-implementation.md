# SKU 模板一实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SKU 首版合成从通用的“上传左右图标 + 文字”改为运营确认的模板一：源图铺满画布，左上/右上使用内置素材，左下红色容器按单行文字宽度自动扩展，并支持批量输出。

**Architecture:** 保留现有 SKU 独立工作台、稳定文件 ID、批次任务和 Sharp 合成边界。新增模板资产读取层，让服务端合成和前端预览使用同一组内置素材；模板一不要求运营上传图标，任务只保存源图、模板 key 和文字行，图标替换能力通过可选的资产覆盖字段保留给后续版本。

**Tech Stack:** Node.js、Express、Sharp、SVG text layer、Mongo/Mongoose data schemas、React/TypeScript、React Testing Library、Jest、Prettier。

**Spec:** `docs/superpowers/specs/2026-10-11-sku-template-1-design.md`

## Global Constraints

- 模板一的 `templateKey` 使用 `sku_red_delivery_label_v1`。
- 源图铺满 800×800 模板画布，左上和右上素材固定叠加，左下文字容器固定在安全区域。
- 第一版运营不能替换图 2、图 3，也不显示图标上传控件。
- 文字必须单行；不自动换行，不自动缩小字号；容器宽度按文字测量宽度加固定水平内边距增长。
- 文本超过画布安全区域时返回可理解的校验错误。
- SKU 合成只使用 Sharp/SVG，不调用 AI provider。
- 源图和生成结果继续使用稳定文件 ID；内置模板素材使用稳定的模板资产 key。
- 不新增 CSV、素材库、自由拖拽、多模板管理后台或复杂图层编辑。

## Review Focus

- 内置素材读取失败：模板资产缺失或无法解析时，批次子任务应失败并保留可读错误，不回退到空图标。
- 长文本：单行宽度超过画布安全区域时，服务端和界面都不能换行或缩放，应阻止提交或返回校验错误。
- 旧图标字段：模板一没有图标上传时，任务仍能创建并由 worker 解析内置素材；可选文件 ID 只作为后续替换扩展。
- 预览与服务端一致：前端预览的源图铺满、角标位置、红色容器位置和单行宽度规则应与 Sharp 合成一致。
- 模板 key 隔离：未知模板仍返回 `SKU_TEMPLATE_UNKNOWN`，不能静默使用模板一。

---

### Task 1: 定义模板一版式、文字测量和内置素材读取

**Files:**
- Create: `api/server/services/SkuGeneration/assets/sku-red-delivery-left.png`（由用户附件图 2 写入）
- Create: `api/server/services/SkuGeneration/assets/sku-red-delivery-right.jpg`（由用户附件图 3 写入）
- Create: `api/server/services/SkuGeneration/skuTemplateAssets.js`
- Modify: `api/server/services/SkuGeneration/skuTemplate.js`
- Modify: `api/server/services/SkuGeneration/composeSkuImage.js`
- Test: `api/server/services/SkuGeneration/composeSkuImage.spec.js`
- Test: `api/server/services/SkuGeneration/skuTemplateAssets.spec.js`

**Interfaces:**
- Produces `SKU_TEMPLATE_V1` with key `sku_red_delivery_label_v1`, full-canvas source layout, fixed icon areas, and a dynamic single-line badge configuration.
- Produces `estimateSkuTextWidth(text, template)`, `assertSkuTextFits(text, template, field)`, and `createTextSvg({ text, template })` behavior used by the compositor.
- Produces `readSkuTemplateAsset({ templateKey, slot }) -> Promise<{ buffer, contentType, filename }>` for `leftIcon` and `rightIcon`.

- [ ] **Step 1: Write failing compositor and asset tests**
  - Replace the old wrapping expectations with tests that assert:
    - `SKU_TEMPLATE_V1.key` is `sku_red_delivery_label_v1`.
    - A PNG result remains 800×800 and uses a full-canvas source.
    - `createTextSvg` contains one red rounded rectangle and one text node on a single line.
    - Longer text produces a wider badge while keeping the fixed badge height and left/bottom anchor.
    - Text that exceeds the calculated safe width throws `SKU_TEXT_TOO_LONG`.
    - `readSkuTemplateAsset` returns the attached left/right assets and rejects an unknown slot.
    - Same source, assets, template and text produce the same SHA-256 output.

- [ ] **Step 2: Run the focused tests and verify they fail for the old layout**
  - Run:
    `./node_modules/.bin/jest --config api/jest.config.js api/server/services/SkuGeneration/composeSkuImage.spec.js api/server/services/SkuGeneration/skuTemplateAssets.spec.js --runInBand --silent`
  - Expected: FAIL because the current key, wrapped text layout, and user-uploaded icon assumptions do not match template one.

- [ ] **Step 3: Copy the two supplied template assets into the service asset directory**
  - Preserve image 2 as the left transparent PNG and image 3 as the right red banner image.
  - Keep the asset filenames stable so later template revisions can add a versioned asset set without changing renderer code.

- [ ] **Step 4: Define the template-one constants in `skuTemplate.js`**
  - Set the canonical key to `sku_red_delivery_label_v1`.
  - Set the output canvas to 800×800 and source area to the full canvas with cover behavior.
  - Define fixed left/right icon anchors, red badge anchor, badge height, corner radius, horizontal padding, font family, font size, font weight, text color, and safe maximum width.
  - Replace wrapped-line limits with a maximum number of text rows plus measured single-line width validation.
  - Keep `getSkuTemplate` rejecting unknown keys with `SKU_TEMPLATE_UNKNOWN`.

- [ ] **Step 5: Implement deterministic text measurement and SVG overlay rendering**
  - Add `estimateSkuTextWidth` using the template’s configured per-character width rules so Chinese/full-width characters, Latin characters, spaces and punctuation are measured consistently on server and client.
  - Make `assertSkuTextFits` trim input, reject blank text, and reject only when the measured single-line width plus padding exceeds the safe width.
  - Make `createTextSvg` render the red rounded rectangle and a single escaped SVG `<text>` node; do not emit wrapped lines or a smaller fallback font.
  - Make `composeSkuImage` fit the source over the full canvas, fit the two icons into their fixed areas, and composite the SVG overlay.

- [ ] **Step 6: Implement `skuTemplateAssets.js`**
  - Resolve only known `templateKey`/slot pairs to files under the service asset directory.
  - Read the buffer with `fs.promises.readFile`, validate it with Sharp, and return its content type and stable filename.
  - Throw field-specific template asset errors when a file is missing, invalid, or requested through an unknown slot.

- [ ] **Step 7: Run the focused tests and commit**
  - Expected: all compositor and asset tests pass.
  - Commit:
    `git add api/server/services/SkuGeneration && git commit -m "feat: add SKU template one compositor"`

---

### Task 2: Make batch creation resolve template assets without operator icon uploads

**Files:**
- Modify: `api/server/services/SkuGeneration/skuBatchService.js`
- Modify: `api/server/services/SkuGeneration/skuBatchSerialization.js`
- Modify: `api/server/routes/skuGeneration.js`
- Modify: `packages/data-schemas/src/schema/skuBatchTask.ts`
- Modify: `packages/data-schemas/src/types/skuBatchTask.ts`
- Test: `api/server/services/SkuGeneration/skuBatchService.spec.js`
- Test: `api/server/routes/__tests__/skuGeneration.spec.js`
- Test: `packages/data-schemas/src/methods/skuBatchTask.spec.ts`

**Interfaces:**
- `createSkuBatch` accepts `sourceFileId`, `templateKey`, and `textRows`; `leftIconFileId` and `rightIconFileId` become optional future overrides.
- Worker resolves optional override file IDs when present, otherwise calls `readSkuTemplateAsset({ templateKey, slot })`.
- Route adds authenticated `GET /api/sku-generation/templates/:templateKey/assets/:slot` for frontend preview bytes.
- Batch records keep `templateKey`, optional icon file IDs, text, output file IDs and existing status fields.

- [ ] **Step 1: Write failing batch, route and schema tests**
  - Add a service test that creates a template-one batch with no icon IDs and asserts each item keeps the canonical template key and can be processed with mocked built-in asset buffers.
  - Add a service test that an optional override file ID is used only when supplied.
  - Add a route test that the asset endpoint requires authentication, returns an image content type for known assets, and returns 404/400 for unknown template or slot.
  - Update route batch payload tests to omit icon IDs for template one.
  - Update schema fixtures/types so icon IDs are optional while source and template key remain required.

- [ ] **Step 2: Run focused tests and verify they fail**
  - Run:
    `./node_modules/.bin/jest --config api/jest.config.js api/server/services/SkuGeneration/skuBatchService.spec.js api/server/routes/__tests__/skuGeneration.spec.js --runInBand --silent`
  - Expected: FAIL because the current service requires owned left/right files and the route has no template asset endpoint.

- [ ] **Step 3: Update the batch service to validate only the source file for template one**
  - Continue calling `validateSkuInput` with the canonical template key.
  - Require and authorize `sourceFileId`.
  - Authorize optional icon override IDs only when present; leave them undefined for the first-version UI.
  - Store the canonical `templateKey` and optional IDs on every item.

- [ ] **Step 4: Update the worker asset resolution**
  - Add a small resolver in `skuBatchService.js` that reads user override files when their IDs exist, otherwise reads the template’s `leftIcon` and `rightIcon` assets.
  - Pass the resolved buffers to `composeSkuImage`.
  - Convert template asset failures into failed subtask records with the existing error serialization path.

- [ ] **Step 5: Add the authenticated template asset route**
  - Resolve the asset through `readSkuTemplateAsset`.
  - Set `Content-Type`, `Content-Length`, private cache headers and inline disposition.
  - Return existing business error codes for unknown templates/assets without exposing filesystem paths.

- [ ] **Step 6: Update serialization and schema types**
  - Make `leftIconFileId` and `rightIconFileId` optional in the Mongoose schema, TypeScript interface, serialized batch summary and client type.
  - Keep existing task status, retry, ownership and expiry behavior unchanged.

- [ ] **Step 7: Run tests and commit**
  - Expected: service, route and data-schema tests pass.
  - Commit:
    `git add api/server/services/SkuGeneration api/server/routes/skuGeneration.js api/server/routes/__tests__/skuGeneration.spec.js packages/data-schemas/src/schema/skuBatchTask.ts packages/data-schemas/src/types/skuBatchTask.ts packages/data-schemas/src/methods/skuBatchTask.spec.ts && git commit -m "feat: resolve built-in SKU template assets"`

---

### Task 3: Replace the SKU workbench controls and preview with template one

**Files:**
- Create: `client/src/routes/SkuGeneration/skuTemplate.ts`
- Modify: `client/src/routes/SkuGeneration/api.ts`
- Modify: `client/src/routes/SkuGeneration/types.ts`
- Modify: `client/src/routes/SkuGeneration/SkuGeneration.tsx`
- Modify: `client/src/routes/SkuGeneration/SkuPreview.tsx`
- Test: `client/src/routes/SkuGeneration/SkuGeneration.spec.tsx`

**Interfaces:**
- `SKU_TEMPLATE_V1_KEY = 'sku_red_delivery_label_v1'`.
- `loadSkuTemplateAssetObjectUrl(templateKey, slot) -> Promise<string>` loads an authenticated object URL from the new route.
- `createSkuBatch` sends `sourceFileId`, `templateKey`, and `textRows`; it does not send operator icon IDs.
- `SkuPreview` renders a full-canvas source, fixed asset URLs, and a single-line red badge whose width is content-driven.

- [ ] **Step 1: Write failing UI tests**
  - Replace icon-upload tests with assertions that:
    - Template-one preview loads both built-in asset URLs.
    - No left/right icon file inputs are rendered.
    - The compose step shows the template name and fixed-asset description.
    - Entering one text row enables generation with only a source file.
    - The create request contains the canonical template key, source ID and text rows, with no icon file IDs.
    - A long single-line text remains one line in the preview and the red badge grows horizontally.
    - Source upload and embedded image-edit results still advance to compose step.
    - Existing result download, retry, “再次制作 SKU 图” and “继续单图改图” actions remain available.

- [ ] **Step 2: Run the focused client test and verify it fails**
  - Run from `client`:
    `../node_modules/.bin/jest --config jest.config.cjs src/routes/SkuGeneration/SkuGeneration.spec.tsx --runInBand --silent`
  - Expected: FAIL because the current page requires icon uploads and the preview uses the old wrapped neutral text layout.

- [ ] **Step 3: Add client template constants and asset loading**
  - Define the canonical key, asset slots and user-facing template copy in `skuTemplate.ts`.
  - Add `loadSkuTemplateAssetObjectUrl` to `api.ts` using the existing Authorization header pattern and blob URL lifecycle.
  - Remove icon upload state and handlers from `SkuGeneration.tsx`; load/revoke the two built-in asset URLs when the compose step is active.

- [ ] **Step 4: Update the compose form**
  - Keep source replacement, text row add/delete/reorder, count preview, batch polling, retry and download behavior.
  - Remove both icon upload labels and inputs.
  - Show a fixed-template card/description explaining that the two top assets are provided by the template and cannot be changed in v1.
  - Remove wrapped-line copy and validate blank rows/maximum row count on the client; allow server width validation to provide the authoritative overflow error.

- [ ] **Step 5: Update `SkuPreview.tsx` to match the server layout**
  - Make the source image fill the preview canvas with the same cover behavior.
  - Position the two loaded assets using the template’s fixed percentage anchors.
  - Render the lower-left badge as an absolutely positioned inline-flex element with fixed height, red background, fixed radius/padding, white-space nowrap and content-driven width.
  - Do not use a right constraint that forces wrapping.

- [ ] **Step 6: Run client tests and formatting, then commit**
  - Run:
    `../node_modules/.bin/jest --config jest.config.cjs src/routes/SkuGeneration/SkuGeneration.spec.tsx src/routes/ImageGeneration.multiReferenceUpload.spec.tsx --runInBand --silent`
  - Run:
    `npx prettier --check src/routes/SkuGeneration/*.ts src/routes/SkuGeneration/*.tsx`
  - Expected: focused tests and formatting pass.
  - Commit:
    `git add client/src/routes/SkuGeneration && git commit -m "feat: update SKU workbench for template one"`

---

### Task 4: Verify integration, navigation and regression behavior

**Files:**
- Modify if needed: `api/server/services/SkuGeneration/*.spec.js`
- Modify if needed: `client/src/routes/SkuGeneration/SkuGeneration.spec.tsx`
- Modify if needed: `api/server/routes/__tests__/skuGeneration.spec.js`
- Modify if needed: `packages/data-schemas/src/methods/skuBatchTask.spec.ts`
- No product files outside the SKU flow unless a regression is found.

- [ ] **Step 1: Run the complete focused backend suite**
  - Run:
    `./node_modules/.bin/jest --config api/jest.config.js api/server/services/SkuGeneration/composeSkuImage.spec.js api/server/services/SkuGeneration/skuTemplateAssets.spec.js api/server/services/SkuGeneration/skuBatchService.spec.js api/server/routes/__tests__/skuGeneration.spec.js --runInBand --silent`
  - Expected: all SKU backend suites pass.

- [ ] **Step 2: Run the complete focused frontend/navigation suite**
  - Run from `client`:
    `../node_modules/.bin/jest --config jest.config.cjs src/routes/SkuGeneration/SkuGeneration.spec.tsx src/routes/ImageGeneration.multiReferenceUpload.spec.tsx src/hooks/Nav/useSideNavLinks.spec.tsx src/components/SidePanel/Nav.spec.tsx src/Providers/__tests__/ActivePanelContext.spec.tsx --runInBand --silent`
  - Expected: SKU flow, deep link, distinct sidebar icon and routeOnly behavior pass.

- [ ] **Step 3: Run formatting checks on all changed source files**
  - Run:
    `npx prettier --check api/server/services/SkuGeneration/*.js api/server/routes/skuGeneration.js client/src/routes/SkuGeneration/*.ts client/src/routes/SkuGeneration/*.tsx packages/data-schemas/src/schema/skuBatchTask.ts packages/data-schemas/src/types/skuBatchTask.ts`
  - Expected: all changed files match Prettier.

- [ ] **Step 4: Perform native local acceptance**
  - Start the existing Mongo/Meili-backed backend and frontend worktree without occupying the original workspace ports.
  - Open `/sku-generation`, verify no conversation list appears, complete source generation/upload, confirm the two fixed assets and single-line red badge, create at least two text rows, preview results, download one output, and exercise “再次制作 SKU 图”.
  - Record any environment limitation separately from product failures.

- [ ] **Step 5: Review the branch diff and leave the worktree clean**
  - Confirm only the template-one assets, SKU services, schema fields, SKU page/preview/API/tests and the approved design/plan changed.
  - Run `git status --short --branch`; do not create a product commit for verification-only changes.

