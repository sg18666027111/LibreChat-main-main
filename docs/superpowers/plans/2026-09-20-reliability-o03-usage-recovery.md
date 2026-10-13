# O03 用量漏记恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已捕获并持久接收的用量在 Mongo 故障或进程重启后可恢复，重放不重复统计、不再次扣余额、不调用供应商。

**Architecture:** 所有用量入口先进入私有持久日志，再由独立投递 worker 更新 Mongo 统计账本；已有业务源保存同一份用量信封，补上业务终态与日志之间的崩溃窗口。采用独立 Worker Thread 中的 Node SQLite、版本条件更新、有界容量预留和账号删除屏障；业务 worker 不承担统计重放。

**Tech Stack:** CommonJS API、TypeScript data-schemas / packages/api、Node 24.16.0、内置 node:sqlite、Mongoose、Jest、隔离 MongoDB、Prometheus / Alertmanager / 飞书、Kubernetes 私有 PVC。生产只读探测返回 Node v24.16.0 / SQLite 3.53.0；本地默认 Node v24.11.0，验收统一使用 24.16.0。SQLite 运行时依赖必须纳入镜像测试，不因本地模块可加载就跳过崩溃测试。

**Spec:** [已确认设计](../specs/2026-09-20-reliability-o03-design.md)。用户 2026-09-20 的“是”确认架构；本文件是待评审的执行计划。

## Global Constraints

- 基线源码 `9d8fef8f65a51c691dde8c5b04750ddde53968f5`，main `b604c61156ec9392d6a64aaa609c99de120fa4bf`，tree `b05fabd7a6e9e56b626ad19e797c156dfe949d58`；执行时先核对远端是否前进。
- 本次只交付 O03，不重做 R03 扣款原子性、R04 金额精度，不处理 H01 未知供应商结果。
- 不调用真实付费模型，不 provider resubmit，不向生产 DB 写测试数据，不断开生产 Mongo 做演练。
- 历史差异报告只读 dry-run，四类：missing / existing / insufficient_evidence / out_of_retention；未经另行确认不批量补写。
- 建议挂载 `/app/var/usage-delivery`，不在任何静态资源目录下。初始申请 1 GiB，应用待处理数据上限建议 256 MiB，单事件上限 32 KiB；创建前核实存储类型、实际容量与费用。
- 日志仅必要账本字段；不落提示词、正文、图片、签名 URL、API Key、Cookie。日志与文件权限分别 0600 / 0700。
- 当前单实例 Recreate；单写者租约带 fencing，不能把 PVC ReadWriteOnce 当作进程互斥。
- Mongo 事件保留窗口 30 天；过期事件不得被后台重放重新延长保留期。待人工处理记录不得静默删除。
- 新增 CI 消耗累计到 5 美元告知用户；不擅自提高预算。O03 当前新增 CI 次数为 0。
- 本计划批准前仅文档工作；实施在隔离 worktree 分阶段提交，不夹带原工作区 `.superpowers/` 与 R01 未跟踪文档。
- 完成指持久接收后的恢复保障，不代表供应商实际账单完整，也不保证节点磁盘整体丢失后的恢复。

## Review Focus

1. F1：同一事件两个终态修订并发、乱序、重复到达；最新有效修订胜出，旧 submitted 不覆盖 succeeded。（Task 2、4、8）
2. F2：供应商已完成，但账本或磁盘此时失败；业务结果保留，provider 次数和余额写入次数均不增加。（Task 3、5、8）
3. F3：账号删除与补记同时发生、删除中途退出后重启；补记不重新关联已删除身份。（Task 4、6、8）
4. F4：价格变更、同一结果被 job / batch / transaction 多份源观察；重放价格不漂移，同一调用只统计一次。（Task 2、5、6、7）
5. F5：租约过期、双进程、目录不可写、日志损坏、超长事件和积压跨保留期；明确拒绝或隔离，不静默漏记、不阻断登录。（Task 1、3、4、7、8）

---

## 分期、文件边界和接口总览

执行推荐：本任务内串行实施，每一阶段完成后检查证据，最后独立审查。四阶段对应 Task 1–2（契约与账本）、Task 3–6（持久投递及入口）、Task 7–8（恢复及故障验收）、Task 9（上线）。前八项完成也不能提前把 O03 标为生产关闭。

新增目录 `api/server/services/UsageDelivery/` 只负责用量投递：

| 文件 | 单一职责 |
| --- | --- |
| `contract.js`、`contract.spec.js` | 信封白名单、边界校验、稳定键及规范化哈希 |
| `journal.js`、`journalThread.js`、`journal.spec.js` | 异步 RPC、SQLite 事务、容量和租约、重启恢复 |
| `worker.js`、`worker.spec.js` | 仅向账本投递、退避、确认和 drain |
| `service.js`、`service.spec.js` | 组合 journal / worker、捕获、预留、删除屏障 |
| `admission.js`、`admission.spec.js` | 付费操作前获得预留；失败给确定的受控响应 |
| `sourceReconciler.js`、`sourceReconciler.spec.js` | 新数据源扫描与历史只读报告 |
| `metrics.js`、`metrics.spec.js` | 固定标签指标，无业务身份 |
| `fixtures.js`（测试目录内） | 无敏感内容的固定信封 |
| `recovery.process.spec.js`、`test/recoveryChild.js` | 隔离 Mongo + 真实子进程故障测试 |

所有新模块使用依赖注入，contract / journal / worker 不导入 `~/models`。事务镜像同样只拿capture函数，不拿业务任务执行函数。composition root 在 `api/models/index.js` 与 API 启动层，阻断 models→service→models 的循环依赖。

统一类型在 `packages/data-schemas/src/types/aiUsage.ts` 定义并由现有类型出口导出，CommonJS 以 JSDoc 引用：

```ts
type UsageSource = 'image' | 'batch' | 'chat' | 'assistant' | 'transaction';
type DeliveryFailure = 'invalid' | 'oversize' | 'full' | 'unavailable' | 'conflict';
type CaptureResult =
  | { durableAccepted: true; ledgerPersisted: boolean; eventId: string; revision: number }
  | { durableAccepted: false; ledgerPersisted: false; reason: DeliveryFailure };
type PricingEvidence =
  | { kind: 'snapshot'; snapshot: NonNullable<IAIUsageEvent['pricingSnapshot']> }
  | { kind: 'confirmed_cost'; costCny: number }
  | { kind: 'missing' };
interface UsageEnvelope {
  schemaVersion: 1;
  source: UsageSource;
  sourceKey: string;
  revision: number;
  event: RecordAIUsageEventInput;
  occurredAt: string;
  expiresAt: string;
  reportingSubjectId: string;
  pricing: PricingEvidence;
}
interface UsageReservation {
  id: string;
  remainingBytes: number;
  expiresAt: string;
}
interface UsageClaim {
  envelope: UsageEnvelope;
  digest: string;
  token: string;
  attempts: number;
}
interface UsageStats {
  pendingCount: number;
  pendingBytes: number;
  reservedBytes: number;
  oldestPendingSeconds: number;
  quarantinedCount: number;
  writable: boolean;
}
```

规则：`event.usageEventId` 延续现有合法稳定 ID；sourceKey 对应真实调用/图片尝试，不是某次重试写账的随机 ID。首次 submitted 为 revision=0，首次终态为 revision=1；后续同状态更正必须从持久业务源获得递增 revision。固定 `(eventId, revision)` 的不同内容是 conflict，不擅自“后到者覆盖”。规范化对象递归按 key 排序后 SHA-256；散列包含冻结时间和价格，不包含投递次数、worker ID。缺失身份/时间/版本的历史数据不能凭 replay 当天补造。requestId/messageId 必须来自请求或持久业务源；`no-message` 不能作为多个调用共享的去重依据，缺 messageId 时在首次请求接受处生成并持久化 requestId，重试沿用。occurredAt 在首次业务调用时冻结，submitted和terminal沿用同一发生时间，不在每次写账时new Date。

### Task 1：用量契约与入口清单（不提前切换生产路径）

**Files:** Create `api/server/services/UsageDelivery/contract.js`, `contract.spec.js`, `test/fixtures.js`; modify `packages/data-schemas/src/types/aiUsage.ts`; create `docs/operations/usage-delivery.md`。

**Interfaces:** Produces `validateEnvelope(value: unknown): { ok: true; envelope: UsageEnvelope; digest: string; bytes: number } | { ok: false; reason: DeliveryFailure }`；测试夹具 `makeEnvelope(overrides?: Partial<UsageEnvelope>): UsageEnvelope`。本任务不调用 DB 或供应商。

- [ ] **1. 写失败测试：严格白名单和稳定键。** 夹具使用固定 occurredAt `2026-09-20T00:00:00.000Z`、expiresAt `2026-10-20T00:00:00.000Z`、source=image、sourceKey=test-call-1、revision=1、固定 reportingSubjectId 和 costCny=0.25，event 的 usageEventId=image_generation:test-call-1:single、provider=fixture、model=fixture-image、status=succeeded、imageCount=1。

```js
const { validateEnvelope } = require('./contract');
const { makeEnvelope } = require('./test/fixtures');
test('rejects content and credentials instead of persisting them', () => {
  const input = makeEnvelope();
  input.event.metadata = { prompt: 'must-not-persist', authorization: 'secret' };
  expect(validateEnvelope(input)).toEqual({ ok: false, reason: 'invalid' });
});
test('rejects nonfinite counts and timestamps', () => {
  const input = makeEnvelope();
  input.event.imageCount = Infinity;
  input.occurredAt = 'invalid';
  expect(validateEnvelope(input).ok).toBe(false);
});
test('keeps canonical digest independent of key ordering', () => {
  const input = makeEnvelope();
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  expect(validateEnvelope(reordered).digest).toBe(validateEnvelope(input).digest);
});
```

- [ ] **2. Run RED:** `npm run test:api -- --runInBand server/services/UsageDelivery/contract.spec.js`；预期模块不存在或断言失败，不把依赖安装错误当 RED。
- [ ] **3. 实现契约。** 使用 `Buffer.byteLength(canonicalJson, 'utf8')` 限制 32768 bytes；整数计数非负且 safe integer，有限非负成本，日期 ISO 且 expiresAt 不超过 occurredAt+30天。枚举状态复用现有类型。只允许 metadata 的 taskType / subMode / providerTaskId / durationMs / billingConfirmed / usageContext / usageType / inputOnlyTokens / tokenType / context，字符串长度分别受限（统一上限256字符）；未知键拒绝并记录固定原因，不能把 payload 写进日志。嵌套对象仅允许已定义的 pricingSnapshot，拒绝任意 metadata 对象、原型键、URL 字段；身份 ID 不作为 metric label。

```js
const MAX_EVENT_BYTES = 32 * 1024;
const ALLOWED_METADATA = new Set([
  'taskType', 'subMode', 'providerTaskId', 'durationMs', 'billingConfirmed',
  'usageContext', 'usageType', 'inputOnlyTokens', 'tokenType', 'context',
]);
// validateEnvelope 先提取明确字段，再验证类型、大小，最后计算 digest。
// 不对未知对象执行 String(value)，不把未知数据插入 error message。
```

- [ ] **4. 补测并 Run GREEN：** 多字节32KiB边界、负数、NaN、缺 eventId、非法 revision、同修订不同 counts、未知 schemaVersion（F5）；命令同上。
- [ ] **5. 写入调用清单并提交。** 清单覆盖 `UsageLedgerService.js`、`Threads/manage.js:recordUsage`、llmAssistant routes、agents client/openai/responses 注入、data-schemas transaction mirror；仅 `aiUsage.ts` 保留原始写库函数。提交范围只上述文件：`git commit -m "test: define durable usage capture contract"`。

### Task 2：账本版本 CAS、冻结价格和真实持久确认

**Files:** Modify `packages/data-schemas/src/types/aiUsage.ts`, `schema/aiUsage.ts`, `methods/aiUsage.ts`, `methods/aiUsage.spec.ts`; create `methods/aiUsageDelivery.spec.ts`。

**Interfaces:** Produces `persistUsageEnvelope(envelope: UsageEnvelope, digest: string): Promise<{ persisted: true; revision: number; superseded: boolean }>`，只写 AIUsageEvent；`resolveUsagePricing(input: RecordAIUsageEventInput): Promise<PricingEvidence>` 仅在首次捕获前读取价格。新 schema 字段 `deliveryRevision`, `deliveryDigest`, `deliverySource`, `deliveryStatusRank`；旧文档缺字段视为 legacy，不自动允许不明历史修订覆盖。

- [ ] **1. 写 RED：真实隔离 Mongo 竞争写入，同 ID 同 revision 重复不增量，同 revision 不同 digest 报 conflict；revision2 success 完成后 revision1 success 不能改 counts；低状态即使较高 revision 也不能倒退。** 沿用现有 aiUsage.spec.ts 的隔离数据库 setup，不连接任何环境提供的生产 URI。

```ts
const results = await Promise.all([
  methods.persistUsageEnvelope(newerSuccess, newerDigest),
  methods.persistUsageEnvelope(olderSuccess, olderDigest),
]);
expect(results.every((r) => r.persisted)).toBe(true);
const stored = await AIUsageEvent.findOne({ usageEventId: newerSuccess.event.usageEventId });
expect(stored.deliveryRevision).toBe(2);
expect(stored.imageCount).toBe(newerSuccess.event.imageCount);
expect(await AIUsageEvent.countDocuments({ usageEventId: stored.usageEventId })).toBe(1);
```

这里 `newerSuccess` / `olderSuccess` 在测试内用固定信封分别构造 revision2/imageCount2 和 revision1/imageCount1；digest 从对应规范化信封得到，不写常量绕过校验。

- [ ] **2. Run RED:** `npm run test:packages:data-schemas -- --runInBand src/methods/aiUsageDelivery.spec.ts`。
- [ ] **3. 实现条件写。** 创建用唯一 usageEventId + `$setOnInsert`；E11000 后进入条件更新，不直接把任意现存行算成功。条件同时包含先前观察到的 revision/digest 和状态等级；匹配失败重新读取，最多3次局部竞争重试，然后交回投递退避。相同 revision+digest 返回 persisted；更高版本/更高状态的现存行返回 superseded；同修订冲突抛固定 `USAGE_REVISION_CONFLICT`。绝不把 null 当确认。

```ts
const filter = {
  usageEventId: envelope.event.usageEventId,
  deliveryRevision: observed.deliveryRevision,
  deliveryDigest: observed.deliveryDigest,
};
const updated = await AIUsageEvent.findOneAndUpdate(
  filter, { $set: nextLedgerFields }, { new: true },
).lean();
// nextLedgerFields 只来自校验后信封；版本/状态判断在构造前完成。
// 更新字段不包含userId/reportingSubjectId/anonymizedAt，绝不撤销匿名化。
// updated===null 表示竞争，重新读取；它不是 persisted=true。
```

- [ ] **4. 实现冻结证据规则并 GREEN。** 首次接收确定 occurredAt、expiresAt 和原始 pricing；重放不调用 findPrice。既有账本已冻结的 snapshot 优先且不可替换；缺证据可持久记录 counts + pricingMissing，但进入人工核价类别，不能声称账单完整。confirmed_cost 仅来自已授权明确成本来源，不用猜测价格。补测原价格变更/停用、已有 pricingMissing、30天过期（拒绝重建）、legacy行冲突保留（F1/F4/F5）。沿用现有金额算法，避免混入R04。
- [ ] **5. 提交:** `git commit -m "fix: make usage ledger replay monotonic and idempotent"`。

### Task 3：私有持久日志、容量预留和单写者保护

**Files:** Create `UsageDelivery/journal.js`, `journalThread.js`, `journal.spec.js`（路径均以 `api/server/services/` 为前缀）。

**Interfaces:** `openUsageJournal({ directory, maxPendingBytes, maxEventBytes, ownerId, now }): Promise<UsageJournal>`；`now(): number` 默认 Date.now，仅测试可注入。

```ts
interface UsageJournal {
  reserve(input: { key: string; bytes: number; expiresAt: string }): Promise<UsageReservation>;
  release(reservationId: string): Promise<void>;
  append(envelope: UsageEnvelope, reservationId?: string): Promise<CaptureResult>;
  claim(limit: number): Promise<UsageClaim[]>;
  isDeletedSubject(subjectId: string): Promise<boolean>;
  listSubjectEnvelopes(subjectId: string, cursor: string | null, limit: number): Promise<{ items: UsageEnvelope[]; cursor: string | null }>;
  ack(claim: UsageClaim): Promise<void>;
  retry(claim: UsageClaim, nextAttemptAt: number, reason: string): Promise<void>;
  quarantine(claim: UsageClaim, reason: string): Promise<void>;
  tombstone(subjectId: string): Promise<void>;
  stats(): Promise<UsageStats>;
  close(): Promise<void>;
}
```

`reason` 只允许固定 enum 分类，不能保存 error.message。append 可无 reservation 用于已完成的持久源恢复；新付费请求必须先 reserve。超限不 evict pending；同键重复 reserve 幂等。

- [ ] **1. 写 RED：真实 tmpdir + SQLite 开关重启。** 测试文件直接使用 Node fs/os 创建私有临时目录，在 finally close + rm；用 Task1 makeEnvelope。

```js
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-journal-'));
let journal = await openUsageJournal({ directory, ownerId: 'first', maxPendingBytes: 262144, maxEventBytes: 32768 });
const first = await journal.append(makeEnvelope());
expect(first.durableAccepted).toBe(true);
await journal.close();
journal = await openUsageJournal({ directory, ownerId: 'second', maxPendingBytes: 262144, maxEventBytes: 32768 });
expect((await journal.stats()).pendingCount).toBe(1);
expect((await journal.append(makeEnvelope())).revision).toBe(first.revision);
```

- [ ] **2. Run RED:** `npm run test:api -- --runInBand server/services/UsageDelivery/journal.spec.js`。
- [ ] **3. 实现 Worker Thread RPC + SQLite。** 所有 DatabaseSync I/O 在线程内；RPC 最多64个在途请求，超额返回 unavailable，单次等待上限5秒。RPC timeout 表示结果不确定，调用者可用同键重试；不能换事件 ID。生产路径必须绝对路径、非 symlink、非 public 路径，目录0700/file0600。数据库 schemaVersion 升级在事务中完成。

```sql
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 1000;
CREATE TABLE IF NOT EXISTS delivery (
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  envelope TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claim_token TEXT,
  claim_until INTEGER,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, revision)
);
CREATE INDEX IF NOT EXISTS delivery_due ON delivery(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS reservation (
  id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS writer (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner TEXT NOT NULL, fence INTEGER NOT NULL, lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deleted_subject (
  subject_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
);
```

append 在 `BEGIN IMMEDIATE` 内验证 writer fence、去重、检查 pending+reserved 容量、消费预留并插入；COMMIT 成功后才返回 durableAccepted。`journal_mode=DELETE` 避免引入 WAL checkpoint 运维；必须是支持 SQLite 文件锁/fsync 的本机持久块存储，不使用 NFS。文件模式同步及目录 fsync 纳入首次创建；已有 journal 启动做 quick_check，失败停止付费 admission，不新建空库掩盖损坏。

writer lease30秒，heartbeat5秒，每个写事务核验 owner+fence；新 writer 仅过期后 CAS 接管并递增 fence。旧进程恢复时写失败，不再 renew/append/ack；这是围栏，不靠删 lock 文件猜测存活。重复实例启动 journal unavailable，登录可继续，不开启投递。claim lease30秒、token随机；ack/retry 均匹配 token+fence。关闭停止领取、等待在途持久写、清理自己的租约；SIGKILL 由过期租约接管。

- [ ] **4. 加容量/损坏测试并 GREEN。** 预留和 pending 总量 ≤256MiB；SQLite物理页限额、statfs 空间低水位和256MiB之外的运行余量同时检查，数据库+rollback日志不得超过1GiB卷预算。已确认行24小时内清理、空闲时增量回收页，pending 永不自动清理；隔离行仍计容量。满盘异常/readonly/BUSY/损坏都不返回 durableAccepted。测试 ENOSPC 注入和 SQLite `max_page_count` 真正满库；进程级故障放Task8。租约过期不能收回仍有可证明在途业务的 reservation；崩溃遗留先核对源再释放（F2/F5）。
- [ ] **5. 提交:** `git commit -m "feat: persist usage delivery in bounded private journal"`。

### Task 4：投递 worker、捕获服务及删除屏障

**Files:** Create `UsageDelivery/worker.js`, `worker.spec.js`, `service.js`, `service.spec.js`; modify `api/models/index.js`, `api/server/index.js`, `packages/data-schemas/src/methods/index.ts`, `api/server/services/UserDeletionService.js`, `UserDeletionService.spec.js`。

**Interfaces:**
- `createUsageDeliveryWorker({ journal, persist, now, random }): { runOnce(): Promise<number>; start(): void; drain(): Promise<void> }`；persist 是 Task2 `persistUsageEnvelope`，不注入整个 db。
- `createUsageDeliveryService({ journal, worker, resolvePricing, resolveSubject }): UsageDeliveryService`；resolvePricing 为 Task2 方法；resolveSubject 为现有 `getOrCreateReportingSubjectId` 包装，必须识别 deleting/deleted 账号而非新建身份。
- `capture(envelope: UsageEnvelope, reservationId?: string): Promise<CaptureResult>`；业务源已冻结信封后调用，不能在 replay 中再生成时间/价格。
- `withDeletedSubject(subjectId: string, anonymize: () => Promise<void>): Promise<void>`：持久 tombstone、等待该 subject 的在途写完成、执行 anonymize；新写只能匿名化后进入账本。worker每次写入前调用journal.isDeletedSubject；检查与该subject的本进程投递/删除互斥保持在同一屏障内，跨进程受writer fence保护。
- `reserve` / `release` 同 Task3；`drain(): Promise<void>` 给现有 registerShutdownDrain。

- [ ] **1. 写 RED：确认丢失后重放，写库为 null 必须重试。**

```js
const journal = {
  claim: jest.fn().mockResolvedValue([claim]),
  ack: jest.fn(), retry: jest.fn(), quarantine: jest.fn(),
};
const persist = jest.fn().mockResolvedValue(null);
const worker = createUsageDeliveryWorker({ journal, persist, now: () => 1000, random: () => 0.5 });
await worker.runOnce();
expect(journal.ack).not.toHaveBeenCalled();
expect(journal.retry).toHaveBeenCalled();
```

`claim` 在测试内由 makeEnvelope、validateEnvelope digest 构造，token固定test-claim，attempts=0；新增 persist 成功而 ack 抛错的下一轮测试：最终1条账本、重放可 ack。不能仅检查 mock 调用，Task8复测真实存储。

- [ ] **2. Run RED:** `npm run test:api -- --runInBand server/services/UsageDelivery/worker.spec.js server/services/UsageDelivery/service.spec.js`。
- [ ] **3. 实现有界 worker。** 每批20、并发2、空队列间隔5秒；退避1秒起、指数至300秒、±20%抖动。Mongo timeout/network 是 retry；未知schema/conflict/expired 是 quarantine，坏一条不阻塞后面的有效记录。以 `persisted === true` 为 ack 条件，不测 truthy；ack失败不转业务失败。捕获只等待 journal COMMIT，ledgerPersisted 默认false；异步投递后通过状态查询/业务源对账更新确认。

```js
const result = await persist(claim.envelope, claim.digest);
if (result?.persisted !== true) {
  throw Object.assign(new Error('Usage persistence unconfirmed'), { code: 'USAGE_UNCONFIRMED' });
}
await journal.ack(claim);
```

投递代码禁止 provider、spendTokens、createTransaction、updateBalance import；静态 import 检查 + 调用计数测试双重验证。drain 最多8秒，留在既有25秒应用shutdown预算内；未 ack 的 claim 等待下一进程恢复，不强行丢弃。

- [ ] **4. 实现删除屏障并 GREEN（F3）。** 删除流程 mark_deleting 后、anonymize_usage 前持久 tombstone；同 subject 的投递与 anonymize 串行。tombstone 成功后即使删除流程失败也保持匿名状态；重启时在投递前加载 tombstone。信封仍保留 reportingSubjectId用于原有匿名统计，删除 userId 和用户关联 metadata；不凭用户不存在创建新 identity。磁盘不可写不能宣告删除完成，现有 deletion job 记录步骤失败并可重试。与所有写入口一起切换，不能让 legacy raw writer 绕过屏障。跨进程旧writer可能有尚未返回的Mongo请求，单独检查journal fence不足以阻止这类迟到写入：tombstone后用listSubjectEnvelopes分页取待处理信封，先以同一eventId幂等upsert匿名账本行（保留原始counts/价格），再执行现有anonymize；旧请求若后到则唯一键命中现存匿名行，版本更新不得修改身份字段。该封存步骤成功前删除步骤不能完成，重启需先恢复未完成的删除屏障。补测旧writer在Mongo首次insert前被暂停、新writer完成匿名封存后旧请求返回，最终仍userId=null。测试删除等待一个在途ledger写、后续匿名写，SIGKILL恢复由Task8负责。
- [ ] **5. 组合依赖并提交。** models先创建 raw methods，把 `persistUsageEnvelope` / pricing / subject方法注入 service；transaction recorder 用惰性函数引用已初始化service，不在import时开启worker。API启动连接完成后初始化，journal不可用仅关闭付费admission，不改变登录/readyz 的 Mongo 语义。不得把Journal健康加入会循环restart进程的探针；持久卷故障需告警并停新付费调用，保留只读服务。`git commit -m "feat: deliver usage safely with retry and deletion fencing"`。

### Task 5：图片、APIMart、Egress、批量入口与容量门禁

**Files:** Modify `api/server/services/UsageLedgerService.js`, `UsageLedgerService.spec.js`; `api/server/services/ImageGeneration/apimartImg2JobWorker.js`, `.spec.js`, `imageEgressJobWorker.js`, `.spec.js`, `apimartImg2Async.js`, `imageEgressAsync.js`, `batchPackaging.js`, `batchTaskPersistence.js`; `packages/data-schemas/src/schema/imageGenerationJob.ts`, `types/imageGenerationJob.ts`, `schema/imageBatchTask.ts`, `types/imageBatchTask.ts`; create `UsageDelivery/admission.js`, `admission.spec.js`; modify `api/server/routes/imageGeneration.js`, `batchImageGeneration.js`。

**Interfaces:** `admitUsage({ key: string; maxEvents: number; expiresAt: string }): Promise<UsageReservation>`（内部 bytes=maxEvents*32768）；`recordImageUsage` 返回 CaptureResult，使用参数 `envelope`/持久源生成的 sourceKey/revision/occurredAt/pricing/reservationId。新增源字段 `usageDelivery: { envelope, state: 'pending'|'durable'|'persisted'|'review', revision }`；已有 usageRecorded 只表示该修订已写账本。

- [ ] **1. 固化 APIMart 已复现 RED。** 从证据 `model-retirement-release/reliability-o03/apimart-ledger-reproduction.json` 转成正式spec，使用现有导出的内存store、真实worker及fake provider，两个场景：submitted/final 都未持久接收；submitted成功但final失败。

```js
const recordUsage = jest.fn().mockResolvedValue({
  durableAccepted: false, ledgerPersisted: false, reason: 'unavailable',
});
// 使用现有 createBaseJob 和 worker setup，provider.generate 仅返回固定图片URL。
await worker.runOnce();
const stored = await store.getJob(job.internalTaskId);
expect(stored.status).toBe('succeeded');
expect(stored.usageRecorded).toBe(false);
expect(stored.usageDelivery.state).toBe('pending');
await worker.runOnce();
expect(provider.generate).toHaveBeenCalledTimes(1);
```

worker 在测试构造时注入上面的 recordUsage，不能保留旧 mock。另测 `{ durableAccepted:true, ledgerPersisted:false }` 只能state=durable，不能usageRecorded=true。

- [ ] **2. Run RED:** `npm run test:api -- --runInBand server/services/ImageGeneration/apimartImg2JobWorker.spec.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/services/UsageLedgerService.spec.js server/services/UsageDelivery/admission.spec.js`。
- [ ] **3. 把信封与业务终态同一次源更新持久化。** APIMart成功/失败终态与usageDelivery.pending原子写入job，随后capture；capture失败不进入provider retry catch。submitted与final拥有不同revision，final清除submitted的usageRecorded。Egress现有终态恢复不再因“仅排队成功”假定落账；由sourceReconciler确认后关闭统计pending。payload清理只需保留白名单信封，不为补记无限保留图片。batch每个实际attempt使用原有内部itemID，母任务不再对同一provider job额外计一条；所有provider共享的同步图片入口同样capture。

```js
const result = await recordUsage(envelope);
const state = result?.ledgerPersisted === true ? 'persisted'
  : result?.durableAccepted === true ? 'durable' : 'pending';
await store.updateJob(job.internalTaskId, {
  usageRecorded: result?.ledgerPersisted === true,
  'usageDelivery.state': state,
});
```

实际更新使用当前 store 支持的原子字段格式，且条件包含revision，防止submitted迟到覆盖final状态（F1）。

- [ ] **4. 门禁放在真正付费提交前。** image routes的 text-to-image / image-to-image / multi-reference / white-background；batch创建与每次item retry；APIMart/Egress领取后首次provider提交前二次检查预留。async入队携带reservationId，已提交任务poll/recover-result/cancel不被当作新付费提交。门禁同时解析reportingSubjectId、冻结原始occurredAt及当前可证实价格；这些字段随reservation对应的持久业务上下文传递。若调用完成时Mongo已断连，仍使用已冻结上下文；无法获得原价的既有在途结果以pricing.kind=missing保留，不能查恢复当天价格。单图片尝试预留submitted+terminal共2条；batch按实际验证后的item数×2预留，不按用户任意未校验数量。队列等待期间续预留，终态释放未消费字节。达到容量/不可写返回HTTP503和固定code `USAGE_CAPTURE_UNAVAILABLE`，文案“暂时无法开始新任务，请稍后再试”；保证provider调用次数0。已开始调用发生故障保留业务结果和pending源，不返回诱导重试的生成失败。
- [ ] **5. GREEN并提交。** 测试并发抢最后一个容量槽只有一个提交、批量部分完成后崩溃、job+batch观察同结果账本仅1条、低容量GET/登录仍成功；无paid调用。`git commit -m "fix: preserve image usage for ledger recovery"`。

### Task 6：聊天、助手、vision 和事务镜像接入

**Files:** Modify `packages/api/src/agents/usage.ts`, `usage.spec.ts`, `transactions.ts`; `packages/data-schemas/src/methods/transaction.ts`, `spendTokens.ts`, `schema/transaction.ts`, `types/transaction.ts`, `methods/index.ts`; `api/server/services/Threads/manage.js`, `api/server/services/ToolService.js`; `api/server/routes/llmAssistant.js`; `api/server/controllers/agents/client.js`, `openai.js`, `responses.js`, `recordCollectedUsage.spec.js`; routes `agents/chat.js`, `agents/openai.js`, `agents/responses.js`, `assistants/chatV1.js`, `assistants/chatV2.js`; create `UsageDelivery/chatCapture.spec.js`。

**Interfaces:** `RecordUsageEventFn` 改为返回 Promise<CaptureResult>；保留稳定eventId，扩展输入携带 Task1 信封。`createMethods` / `createTransactionMethods`新增可选依赖 `captureUsage: (envelope: UsageEnvelope) => Promise<CaptureResult>`，生产初始化必须注入，不使用rawwriter fallback。Transaction增加 `usageEventId` 与 `usageDelivery`，`skipUsageLedger=true` 的事务关联规范eventId，不再独立镜像。

- [ ] **1. 写 RED：账本断连仍等待 durable capture，重放不执行spend。**

```js
let accept;
const capture = jest.fn(() => new Promise((resolve) => { accept = resolve; }));
let completed = false;
const pending = recordCollectedUsage(params, { ...deps, recordUsageEvent: capture })
  .then(() => { completed = true; });
await Promise.resolve();
expect(completed).toBe(false);
accept({ durableAccepted: true, ledgerPersisted: false, eventId, revision: 1 });
await pending;
expect(completed).toBe(true);
```

复用现有recordCollectedUsage.spec固定params/deps；再测两次投递同event后provider fake次数不增加，spendTokens或bulk余额更新总数保持原始调用数；Threads与vision调用通过同一capture。补测取消/abort终态使用同一规范ID，不创建额外账目。

- [ ] **2. Run RED:** `npm run test:packages:api -- --runInBand src/agents/usage.spec.ts`；`npm run test:api -- --runInBand server/controllers/agents/recordCollectedUsage.spec.js server/services/UsageDelivery/chatCapture.spec.js`。
- [ ] **3. 所有入口先捕获，再按现有逻辑执行余额处理。** packages/api收集capture promise，await全部durable结果；捕获失败保留既有响应并提高固定指标，不假装落账成功。不要await后台Mongo恢复，不把capture失败转换成模型重试。Threads原先spend后rawledger改为先durablecapture再spend；transaction save同文档保存恢复信封，然后镜像只调用capture。显式聊天/assistant/vision事件的相关prompt/completion事务全部skipUsageLedger且关联同一个usageEventId；否则现有direct+transaction镜像可能双算。没有显式事件的legacy事务仍以transaction:_id作为唯一事件，source=transaction，不改余额算法。

```ts
const captures: Promise<CaptureResult>[] = [];
// 现有每个 usage group 循环：稳定的 index 在重放时不重排。
captures.push(recordUsageEvent(envelope));
const captureResults = await Promise.all(captures);
// 按 durableAccepted 记录状态；balance/spend不作为usage worker的依赖。
```

- [ ] **4. 门禁覆盖所有已映射聊天入口（F2/F4）。** agents chat、OpenAI-compatible chat/completions、Responses create、assistants V1/V2新run、llmAssistant analyze/chat；GET模型/历史、abort和现有run结果读取不门禁。每次新provider调用前消费一个capture slot；agent循环在递归上限基础上预留，summary/vision工具调用单独预留，不使用“每请求一条”的假设。没有本地可控模型调用数的远端assistant run按最终run用量一次汇总预留，沿用原有计量粒度。LLM开始hook若库不保证等待/错误传播，不依赖hook实施门禁，必须在调用provider invoke/create前await admission。测试工具分支、summary、流式取消都带预留，不漏真实付费入口。
- [ ] **5. GREEN + 全路径扫描并提交。** `rg -n 'recordAIUsageEvent|recordUsageEvent' api packages --glob '*.{js,ts}' --glob '!**/dist/**' --glob '!**/node_modules/**'`：除raw ledger实现/测试外每项要么接capture，要么有明确说明不执行写库。补测账号已deleting时不会创建新reportingSubjectId（F3）。`git commit -m "fix: capture chat and transaction usage durably"`。

### Task 7：源对账、历史只读报告和告警

**Files:** Create `UsageDelivery/sourceReconciler.js`, `sourceReconciler.spec.js`, `metrics.js`, `metrics.spec.js`, `config/reconcile-usage-delivery.js`; modify `packages/data-schemas/src/methods/imageGenerationJob.ts`, `methods/imageBatchTask.ts`, `methods/transaction.ts`及对应schema；modify `packages/api/src/app/metrics.ts`, `metrics.spec.ts`, `deploy/monitoring/image-reliability.rules.yml`; update `docs/operations/usage-delivery.md`。

**Interfaces:**
- `reconcileUsageSources({ after, limit, mode, capture, readPage, readLedger }): Promise<{ cursor: string|null; counts: Record<'missing'|'existing'|'insufficient_evidence'|'out_of_retention', number> }>`；mode仅'new'或'dry-run'，limit最多100。
- readPage按来源+`(updatedAt,_id)`稳定游标读取最小投影；readLedger 批量查询usageEventId避免N+1。
- `sampleUsageMetrics(stats: UsageStats): void`，固定指标，无用户ID/eventID/error原文。

- [ ] **1. 写 RED：dry-run执行缺账扫描且capture调用为0，已有事件不重复。**

```js
const capture = jest.fn();
const result = await reconcileUsageSources({
  after: null, limit: 100, mode: 'dry-run', capture,
  readPage: jest.fn().mockResolvedValue({ items: sourceFixtures, cursor: null }),
  readLedger: jest.fn().mockResolvedValue(existingLedgerFixtures),
});
expect(capture).not.toHaveBeenCalled();
expect(result.counts).toEqual({ missing: 1, existing: 1, insufficient_evidence: 1, out_of_retention: 1 });
```

sourceFixtures在测试内构造四条：合法新信封缺账、同ID已存在、缺原始时间/价格且不能证实、occurredAt早于30天。无模型请求。

- [ ] **2. Run RED:** `npm run test:api -- --runInBand server/services/UsageDelivery/sourceReconciler.spec.js server/services/UsageDelivery/metrics.spec.js`。
- [ ] **3. 实现新事件恢复。** 首次启用时间固定为 cutover UTC，不随重启更新；只自动处理cutover之后带v1信封的源，APIMart/Egress/batch/transaction 各有复合索引 `usageDelivery.state, updatedAt, _id`。每轮每源最多100条、并发1、30秒间隔；游标重启可重扫，幂等由event+revision保证。终态源更新与journal之间的崩溃窗口→append同信封；journal已ack而源未确认→批量读ledger匹配revision/digest后条件标persisted；缺价格→review而非按今天价格重算。不启动原worker，不重取provider结果，不调用余额方法。源TTL不能早于其恢复保障窗口；若源将先过期，须确认日志durable后方能清理。
- [ ] **4. 实现CLI只读报告。** `node config/reconcile-usage-delivery.js --dry-run --since=2026-09-01T00:00:00.000Z --until=2026-09-20T00:00:00.000Z --limit=100 --output=/tmp/o03-dry-run.json`。无dry-run或未知参数直接退出2；CLI构造db时禁用默认seed/索引创建/重连写副作用，只使用只读查询。输出聚合counts、证据原因和必要内部ID到0600文件，控制台不列个人信息。历史dry-run只报告证据，不因缺价一律丢弃已证明的counts；价格不足归insufficient_evidence。旧数据即使能推导也不自动append；expired不重建。
- [ ] **5. 实现指标告警并 GREEN。** Gauges：`librechat_usage_delivery_pending`、`pending_bytes`、`oldest_seconds`、`quarantined`、`writable`；Counters：`failures_total{reason}`、`recovered_total`。所有名称使用完整`librechat_usage_delivery_`前缀。writable=0持续1分钟critical；oldest>300持续5分钟warning；pending_bytes>201326592持续5分钟warning；quarantined>0持续5分钟warning。静态rules用promtool验证；测试expired/坏记录进入隔离、好记录仍可恢复、指标label不含身份（F5）。现有飞书链路只新增规则，不改webhook/密钥，测试通知标注“演练”，按已有通知授权执行。
- [ ] **6. 提交:** `git commit -m "feat: reconcile missing usage and expose delivery health"`。

### Task 8：真实故障测试、构建与独立审查

**Files:** Create `UsageDelivery/recovery.process.spec.js`, `test/recoveryChild.js`; modify `.github/workflows/backend-review.yml`; update `docs/operations/usage-delivery.md` 的验证矩阵。

**Interfaces:** 子进程IPC输入 `start|capture|runOnce|pauseAt|stats|exit`，输出固定事件 `journal_committed|ledger_committed|ack_committed|deletion_tombstoned`；pauseAt只在测试fixture实现，不给生产代码暴露管理端点。fixture注入对应persist/ack函数控制崩溃时点。Mongo使用每测试独立database，URI只接受loopback或CI专用mongodb服务主机，拒绝任何来自production env的连接。

- [ ] **1. 写进程级 RED。** 下列每一行单独命名用例并断言外部可观察结果：

| 故障 | 验收结果 |
| --- | --- |
| Mongo不可达→capture→进程SIGKILL→Mongo恢复→新进程 | capture已确认事件最终1条ledger |
| ledger已commit、journal ack前SIGKILL | 重投后仍1条，ack成功 |
| 源终态持久化、append前SIGKILL | sourceReconciler恢复，provider次数1 |
| revision2与revision1竞争，同状态修订乱序 | revision2内容不回退，低状态不覆盖 |
| writer lease过期、旧writer恢复、新writer接管 | 旧writer被fence，只有当前writer可ack |
| SQLite提交时退出、真实页上限满库、权限只读 | 不伪造持久接收；已确认数据可恢复 |
| 账号tombstone后SIGKILL，重启补记 | userId为空，原匿名subject保持 |
| 同一调用由batch/job/transaction重复观察 | 1条规范事件，余额写入次数不增加 |
| 价格配置更新、事件重放 | 原snapshot/cost不变 |
| 坏信封、超长字段、超保留期和正常记录混合 | 坏记录隔离，正常恢复，积压指标准确 |
| shutdown drain超时 | 未确认保留，下次重启恢复，25秒预算内退出 |

```js
// 子进程必须在明确IPC屏障后被杀，不能用sleep猜测已commit。
await child.waitFor('journal_committed');
child.kill('SIGKILL');
await child.waitForExit();
const restarted = await startRecoveryChild({ directory, mongoUri });
await restarted.send('runOnce');
expect(await AIUsageEvent.countDocuments({ usageEventId })).toBe(1);
expect(await fakeProviderCallCounter.read()).toBe(1);
expect(await balanceWriteCounter.read()).toBe(initialBalanceWrites);
```

`startRecoveryChild` / waitFor / send / waitForExit /两个counter在同一test文件内实现：Node fork+IPC，10秒超时，counter存隔离fixture文件，kill后重读而不是依赖父进程mock；这些helper不进入生产包。

- [ ] **2. Run RED:** `npm run test:api -- --runInBand server/services/UsageDelivery/recovery.process.spec.js`。环境失败先修隔离环境，不跳过测试或改成mock绿灯。
- [ ] **3. GREEN并接CI。** 使用生产同版本Node24.16.0、真实隔离Mongo；未配置外部模型key、测试网络只允许本机Mongo。CI增量阶段先跑O03相关测试再按现有backend-review执行。跑 `npm run build:data-schemas`、`npm run build:api`，测试api、packages/api、data-schemas的相关完整套件，以及 `npx eslint` 后接本次实际修改的JS/TS文件列表。测试payload无真实聊天内容。
- [ ] **4. 复核报告。** 保存Node/SQLite/Mongo版本、源码SHA、故障用例结果、退出码、精确provider/balance计数、日志恢复行数、存储占用和吞吐。每个入口必须有契约映射和对应行为测试；测试coverage百分比不是替代证据。核查同步fs调用未进入HTTP线程，正常业务只等待有限journal落盘。
- [ ] **5. 提交并审查:** `git commit -m "test: verify usage recovery across process and database failures"`。执行所选方式规定的独立最终审查，重点F1–F5、未经映射的rawwriter、循环依赖、source清理顺序、SQLite故障后的用户响应；有缺陷先修复重测，不能靠文档豁免发布。

### Task 9：私有卷、固定镜像发布与生产验收

**Files:** Create `docs/operations/usage-delivery-release.md`; evidence目录 `/Users/adrian/Desktop/jingjicang/model-retirement-release/reliability-o03/` 保存 `validation-report.md`, `deployment-plan.json`, `release-report.md`，更新该目录state和全局followup状态。禁止把Secret写进报告。

**Interfaces:** 发布参数固定为已测试源码SHA/镜像digest、私有PVC标识、mountPath、UID/GID、容量、rollback镜像；依赖Task8全部通过。新增配置明确校验：

```text
USAGE_DELIVERY_MODE=journal
USAGE_DELIVERY_DIR=/app/var/usage-delivery
USAGE_DELIVERY_MAX_PENDING_BYTES=268435456
USAGE_DELIVERY_MAX_EVENT_BYTES=32768
```

另一个必填配置`USAGE_DELIVERY_CUTOVER_AT`从deployment-plan.json.cutoverAt加载：首次生成发布计划时以`new Date().toISOString()`生成并保存具体UTC，后续部署和重启复用该值；不在应用每次启动时重新取时间。off只用于未启用的旧环境；journal模式不可写时不能静默降级rawledger。对数值做范围校验且拒绝NaN/负数/超卷预算。

- [ ] **1. 先验证发布前置条件。** 只读查平台持久卷类型、费用、容量、访问模式、Pod权限和Recreate副本数。不可复用 `/app/client/public/images`。将实际选择及金额写入deployment-plan供用户审核；若平台需要新增购买确认，只对具体金额/资源提问，不重新问架构是否同意。存储不能可靠支持SQLite文件锁/fsync时停止发布并重新评审日志后端，不能套用NFS。
- [ ] **2. 隔离canary先演练。** 使用待发布镜像、独立私有PVC与隔离Mongo；不注入生产DB/provider凭据。写固定测试事件，kill/recreate Pod，在同PVC恢复并核对幂等；验证非public路径、权限、真实满库/清理后空间回收、writer围栏。测试通知使用明确演练文字。退出后清理canary数据与临时资源，保留证据。
- [ ] **3. 提供具体生产变更并按授权发布。** 固定镜像digest、PVC、env、cutover、健康检查、预计Recreate短暂中断、回滚方式都可审核后再执行；不混入H01或历史补账。既有部署授权不代替未知新资源费用确认。使用平台持久配置来源，避免仅patch Deployment随后被Zeabur覆盖。
- [ ] **4. 生产只读验收。** 检查实际挂载、单writer、/readyz、/health、未登录权限、已有登录只读页面、metric采集、pending/oldest/quarantine；不构造生产计费事件。新真实业务到来后只读验证capture与ledger对应，不对用户任务resubmit。历史CLI只dry-run，report四类数量，输出与权限验证。
- [ ] **5. 回滚与关闭条件。** 回滚保留PVC和journal，禁止删除待投递文件或将pending当已完成。旧镜像不识别新日志时恢复保障暂停，必须明确告警并保留事件，不能宣称回滚后仍自动恢复。若问题仅投递worker，可停止领取并拒绝新增付费请求，保留登录和结果读取。Task8、canary、生产配置/健康、告警与临时资源清理证据齐全才把O03 CLOSED；无自然新事件时注明新业务实测仍未完成，保持O03待验收。

## 计划自检记录

- 设计覆盖：统一入口Task1/5/6；持久日志和私有卷Task3/9；版本/价格Task2；删除屏障Task4；重放不扣款/不调用provider Task4/8；新源恢复与历史dry-run Task7；指标/清理Task3/7；门禁和在途预留Task5/6；故障演练Task8；固定镜像/平台持久配置Task9。
- 接口检查：CaptureResult以durableAccepted与ledgerPersisted分开；业务成功不等于ledger成功；worker只调用persistUsageEnvelope；source与journal共用UsageEnvelope和稳定revision。
- F1–F5分别有上述任务归属和Task8真实进程验收，没有用“没有抛错”代替持久确认。
- 待执行验证：本文件中的RED/GREEN命令尚未执行，SQLite方案尚未做故障验收；当前仅批准架构，O03未关闭。
- 实施顺序：Task1→2→3→4→5→6→7→8→9。Task9新增资源需金额/类型核实；历史补写始终不在本次执行范围。

## 技术依据

- [Node SQLite API](https://nodejs.org/api/sqlite.html)：DatabaseSync为同步API，故隔离在线程中；以目标Node24.16.0实测为发布依据，不使用更高版本新增API。
- [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)：使用FULL并配合宿主存储可靠fsync；本计划不宣称同节点PVC可抵御整盘丢失。
- [MongoDB事务生产约束](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)：当前standalone不能依赖跨文档事务outbox。
- [Kubernetes持久卷访问模式](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)：访问模式不替代单进程写入围栏。
