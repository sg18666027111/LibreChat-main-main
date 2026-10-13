# Image Generation Egress Resilience Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the approved Fal and APIMart Gemini image-generation paths from browser-held requests to an isolated, gated, durable v3 worker with safe cross-turn read retries, one-shot Provider submit, and durable input/output storage.

**Architecture:** Keep the existing APIMart GPT Image 2 v2 worker, claim method, permit, concurrency, lease/fencing, and route selection behavior unchanged. Add a structurally isolated `asyncVersion: 3` / `workerFamily: "image-egress-v1"` job path, a separate globally bounded worker-slot collection, Provider-specific submit/status/result adapters, and short worker turns that persist retry deadlines and resume the same Provider task. Phase B delivers Fal GPT Image 2 Edit, Grok Image Edit, and Nano Banana; Phase C independently adds APIMart Gemini 3.1 and 2.5.

**Tech Stack:** Node.js, Express, MongoDB/Mongoose, Jest, React/TypeScript, existing LibreChat file-storage strategies, Docker.

---

## Guardrails and Execution Rules

- Work only on `fix/image-generation-egress-resilience`, based on approved design commit `130a631d8dacfad98873b5beb78095a382317ac8` and release-candidate baseline `950f7de8855d9843435ab86db0f8dacc04e95b48`.
- Do not deploy, push, restart services, touch `librechat-main`, switch traffic, or operate on production data.
- Do not migrate Ark Seedream or SiliconFlow. Their synchronous routes must remain unchanged.
- Do not modify Skill behavior.
- Do not change the signature, defaults, query, or call sites of the existing `acquireImageGenerationJobLease` method.
- Do not reuse or modify APIMart GPT Image 2 permits or concurrency leases for the v3 worker.
- Never automatically retry a Fal or APIMart submit POST. Once the Provider adapter is invoked, a missing task ID after any transport/process ambiguity becomes `status_unknown`.
- MongoDB may store durable object references and sanitized metadata only; it must never store image input/output binary or complete base64.
- `IMAGE_EGRESS_ASYNC_MODE` defaults to `off`; deploying code alone must not enable v3 traffic.
- Every numbered task follows red/green TDD and ends in one focused local commit. If the declared red test unexpectedly passes, stop and correct the test so it proves the missing behavior before implementation.
- After each task's focused green run, run the APIMart GPT Image 2 regression gate listed below before committing. Any regression blocks the task commit.
- Keep each task's red/green loop to its declared targeted suites plus the APIMart GPT Image 2 critical regression gate. Run the broader ImageGeneration/build gates only at the Phase B checkpoint, Phase C checkpoint, and Final Delivery Gate.

### APIMart GPT Image 2 regression gate used in every task

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/apimartImg2Async.spec.js server/services/ImageGeneration/apimartImg2JobWorker.spec.js server/services/ImageGeneration/apimartImg2InputStorage.spec.js server/services/ImageGeneration/adapters/apimart/gptImage2.spec.js server/routes/imageGeneration.apimartAsync.spec.js
```

Expected: all suites pass; existing v2 acquisition, input externalization, submit fencing, permit/concurrency, lease recovery, and route behavior remain green.

## Fixed Public and Internal Contracts

### Runtime gate

- `IMAGE_EGRESS_ASYNC_MODE=off|canary|all`; missing or invalid values are `off`.
- `IMAGE_EGRESS_ASYNC_CANARY_USER_IDS` is the comma/whitespace-separated user allowlist used only by `canary`.
- `IMAGE_EGRESS_MAX_CONCURRENCY` is the global `image-egress-v1` active-turn bound; missing, zero, negative, or invalid values are `1` for the recovery-window release.

```js
getImageEgressAsyncMode(env = process.env)
// -> 'off' | 'canary' | 'all'; missing/invalid values return 'off'

getImageEgressCanaryUserIds(env = process.env)
// -> Set<string>; comma and whitespace separators are accepted

shouldUseImageEgressAsyncForUser({ userId, env = process.env })
// off=false; canary=allowlist membership; all=true

getImageEgressMaxConcurrency(env = process.env)
// -> positive integer; missing, zero, negative, or invalid values return 1

getImageEgressWorkerRolloutModes(env = process.env)
// off=[]; canary=['canary']; all=['canary', 'all']

shouldStartImageEgressWorker(env = process.env)
// false in test/ci, false in off, true for all,
// true for canary only when the allowlist is non-empty
```

### v3 identity and public status

- New jobs persist `asyncVersion: 3`, `workerFamily: 'image-egress-v1'`, and an exact allowed Provider/model pair.
- `frontendTaskId` dedupe identity is `userId + frontendTaskId + businessType + asyncVersion`.
- Batch dedupe identity is `userId + batchTaskId + itemId + asyncVersion`.
- Public mapping is fixed:
  - `waiting` -> `queued`
  - `submitting` -> `running`
  - `polling` -> `running`
  - `succeeded` -> `success`
  - `failed` -> `failed`
  - `status_unknown` -> `status_unknown`
- No cancellation state is added in this implementation.

### Provider allowset

```js
const IMAGE_EGRESS_PROVIDER_MODEL_ALLOWSET = [
  { provider: 'fal', model: 'openai/gpt-image-2/edit' },
  { provider: 'fal', model: 'xai/grok-imagine-image/edit' },
  { provider: 'fal', model: 'fal-ai/nano-banana-pro' },
  { provider: 'apimart', model: 'gemini-3.1-flash-image-preview' },
  { provider: 'apimart', model: 'gemini-2.5-flash-image-preview' },
];
```

### Usage audit semantics

- `billingConfirmed` is not a new top-level `AIUsageEvent` schema field. The existing schema already accepts Provider-safe audit attributes through `metadata: Schema.Types.Mixed`; the v3 worker writes `metadata.billingConfirmed` there so existing pricing/report consumers continue using the established top-level `status` and `costCny` fields.
- A successful task records or updates one deterministic logical event, using the existing `usageEventId = businessType:requestId:itemId` rule, with its normal confirmed cost and `metadata.billingConfirmed: true`.
- `submit_result_unknown` is stored publicly as `status_unknown`; an audit `AIUsageEvent` may be retained with `status: 'status_unknown'`, `requestCount: 1`, `imageCount: 0`, explicit `costCny: 0`, and metadata `{ billingConfirmed: false, auditOnly: true, submitOutcome: 'unknown' }`.
- A `status_unknown` audit record must never be counted or presented as confirmed successful billing. Existing reports may continue counting it as a failed/unknown event, but its explicit top-level `costCny: 0` contributes no confirmed cost. The Provider may still have charged externally; zero means only that this application did not confirm billable success.
- Retrying a worker turn updates the same deterministic event; it must not insert a second logical usage row.

## Task 1: Add Structurally Isolated v3 Persistence and Worker Slots

**Phase:** Shared prerequisite for Phase B and Phase C
**Commit:** `feat(image-generation): isolate v3 egress jobs`

**Files:**

- Modify: `packages/data-schemas/src/types/imageGenerationJob.ts`
- Modify: `packages/data-schemas/src/schema/imageGenerationJob.ts`
- Modify: `packages/data-schemas/src/methods/imageGenerationJob.ts`
- Modify: `packages/data-schemas/src/methods/imageGenerationJob.spec.ts`
- Create: `packages/data-schemas/src/types/imageEgressWorkerSlot.ts`
- Create: `packages/data-schemas/src/schema/imageEgressWorkerSlot.ts`
- Create: `packages/data-schemas/src/models/imageEgressWorkerSlot.ts`
- Create: `packages/data-schemas/src/methods/imageEgressWorkerSlot.ts`
- Create: `packages/data-schemas/src/methods/imageEgressWorkerSlot.spec.ts`
- Modify: `packages/data-schemas/src/types/index.ts`
- Modify: `packages/data-schemas/src/schema/index.ts`
- Modify: `packages/data-schemas/src/models/index.ts`
- Modify: `packages/data-schemas/src/methods/index.ts`

**Interfaces to add:**

```ts
type ImageEgressOperation =
  | 'input_read'
  | 'status_read'
  | 'result_read'
  | 'output_download'
  | 'output_storage';

type ImageEgressProviderModel = {
  provider: 'fal' | 'apimart';
  model:
    | 'openai/gpt-image-2/edit'
    | 'xai/grok-imagine-image/edit'
    | 'fal-ai/nano-banana-pro'
    | 'gemini-3.1-flash-image-preview'
    | 'gemini-2.5-flash-image-preview';
};

acquireImageEgressJobLease({
  workerId,
  leaseMs,
  statuses,
  rolloutModes,
  allowset,
  now,
}): Promise<IImageGenerationJob | null>

findImageEgressJobByIdentity({
  userId,
  frontendTaskId,
  businessType,
  batchTaskId,
  itemId,
}): Promise<IImageGenerationJob | null>

hasNonterminalImageEgressJobReferencingFile({
  fileId,
}): Promise<boolean>

acquireImageEgressWorkerSlot({
  workerFamily,
  ownerId,
  maxConcurrency,
  leaseMs,
  now,
}): Promise<IImageEgressWorkerSlot | null>

heartbeatImageEgressWorkerSlot({
  leaseId,
  ownerId,
  leaseMs,
  now,
}): Promise<IImageEgressWorkerSlot | null>

releaseImageEgressWorkerSlot({
  leaseId,
  ownerId,
  now,
}): Promise<boolean>
```

The v3 job fields are:

```ts
workerFamily?: 'image-egress-v1';
providerMetadata?: Record<string, unknown>; // schema select:false
currentOperation?: ImageEgressOperation;
operationAttemptCount?: number;
operationTransientFailureCount?: number;
failedTurnCount?: number;
lastOperationErrorCode?: string;
lastOperationAt?: Date;
nextAttemptAt?: Date;
deadlineAt?: Date;
jobDeadlineAt?: Date;
```

The slot document is a fixed/reusable coordination record with unique `(workerFamily, slotNumber)`, nullable `ownerId`, `leaseId`, `leaseUntil`, and `heartbeatAt`. Releasing a slot clears ownership; it does not delete the document.

- [ ] **Step 1: Write failing v3 claim-isolation and index tests**

Add cases to `imageGenerationJob.spec.ts` that seed historical jobs, v2 APIMart GPT Image 2 jobs, v3 jobs with a wrong family, disallowed Provider/model jobs, a future `nextAttemptAt`, an expired lease, and due eligible v3 jobs. Assert `acquireImageEgressJobLease` can claim only due jobs matching all structural discriminators and the caller-supplied exact allowset. Assert the existing `acquireImageGenerationJobLease` export, function arity, and v2 selection cases remain unchanged.

Add assertions for named partial unique indexes:

```text
uniq_image_egress_v3_frontend_identity
uniq_image_egress_v3_batch_identity
```

The partial filters must require `asyncVersion: 3` and `workerFamily: 'image-egress-v1'`, so no historical index semantics change.

Add a file-ownership lookup test proving `hasNonterminalImageEgressJobReferencingFile` returns true only when a v3 `image-egress-v1` job in `waiting`, `submitting`, or `polling` references the exact `payload.imageInputRefs.fileId`. Historical/v2 jobs, terminal v3 jobs, output refs, and other file IDs return false.

- [ ] **Step 2: Write failing global slot-bound tests**

In `imageEgressWorkerSlot.spec.ts`, simulate two owners acquiring with `maxConcurrency: 1`. Assert only one owner succeeds, a non-owner cannot heartbeat/release it, expiry makes it reclaimable, and release makes the same fixed slot reusable. Add a `maxConcurrency: 2` case proving only slot numbers `0` and `1` can be leased.

- [ ] **Step 3: Run the red data-schema tests**

Run from `packages/data-schemas/`:

```bash
npx jest --runInBand --coverage=false src/methods/imageGenerationJob.spec.ts src/methods/imageEgressWorkerSlot.spec.ts
```

Expected red: missing v3 fields/methods/model exports and missing slot acquisition behavior. Existing v2 assertions must remain green within the mixed run.

- [ ] **Step 4: Implement the minimum schema and methods**

Add the declared fields and v3-only partial indexes. Implement `acquireImageEgressJobLease` as a new method whose query hard-codes `asyncVersion: 3`, `workerFamily: 'image-egress-v1'`, `workerEligible: true`, due `nextAttemptAt`, expired/unowned job lease, allowed rollout modes, and an `$or` made only from the exact Provider/model pairs passed by the worker. Reject an empty allowset without querying.

Implement slot acquisition by trying fixed slot numbers from `0` to `maxConcurrency - 1` with an atomic expired/unowned ownership update and unique upsert handling. The new job claim selects `+payload +result +providerMetadata` for its own worker and restricts `status` to the caller-supplied nonterminal statuses. Keep `acquireImageGenerationJobLease` byte-for-byte unchanged unless formatting tools change whitespace; inspect its diff before commit.

- [ ] **Step 5: Run green schema tests and package build**

Run from `packages/data-schemas/`:

```bash
npx jest --runInBand --coverage=false src/methods/imageGenerationJob.spec.ts src/methods/imageEgressWorkerSlot.spec.ts
```

Run from repository root:

```bash
npm run build:data-schemas
```

Expected: both targeted suites and the data-schema build pass.

- [ ] **Step 6: Run the APIMart GPT Image 2 regression gate**

Run the standard regression command from `api/`. Expected: all existing v2 suites pass.

- [ ] **Step 7: Inspect, stage, and commit**

Run:

```bash
git diff --check
git diff -- packages/data-schemas/src/methods/imageGenerationJob.ts
git status --short
```

Confirm the existing v2 claim method has no behavioral diff. Stage only Task 1 files and commit:

```bash
git commit -m "feat(image-generation): isolate v3 egress jobs"
```

## Task 2: Add Bounded Turn Retry and Persistent Scheduling Primitives

**Phase:** Shared prerequisite for Phase B and Phase C
**Commit:** `feat(image-generation): add bounded egress retry`

**Files:**

- Create: `api/server/services/ImageGeneration/imageEgressRetry.js`
- Create: `api/server/services/ImageGeneration/imageEgressRetry.spec.js`

**Interfaces to add:**

```js
isRetryableImageEgressError(error)

runImageEgressTurnRetry(operation, {
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  jitterRatio,
  turnBudgetMs,
  sleep,
  monotonicNow,
  random,
})
// -> { value, attempts, elapsedMs }

getImageEgressNextAttemptAt({
  now,
  failedTurnCount,
  random,
})
// -> Date, base 5s exponential delay, 60s cap, 20% jitter
```

Export immutable policies with these exact values:

| Operation | Attempts | Base | Cap | Jitter | Turn budget | Persistent operation deadline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| status read / APIMart poll | 4 | 500 ms | 5 s | 20% | 30 s | 15 min from Provider acceptance, capped by job deadline |
| Fal result read | 4 | 500 ms | 5 s | 20% | 30 s | 3 min from entering result phase, capped by job deadline |
| output download | 3 | 750 ms | 6 s | 20% | 45 s | 5 min from first fetch, capped by job deadline |
| durable input read | 3 | 250 ms | 2 s | 20% | 20 s | 5 min from first read, capped by job deadline |

- [ ] **Step 1: Write failing retry-classification tests**

Test timeouts, TLS/network errors, `ECONNRESET`, and HTTP 502/503/504 as retryable. Test HTTP 4xx, parsed Provider rejection, invalid image/content, rejected URL, oversized response, and generic validation errors as non-retryable. Submit is not exposed through any retry wrapper.

- [ ] **Step 2: Write failing deterministic budget tests**

Inject a zero-delay sleeper, controlled monotonic clock, and deterministic random values. Prove first-failure/second-success, multiple transient failures then success, attempt-cap exhaustion, elapsed-turn-budget exhaustion, exponential delays with jitter bounds, and immediate propagation of a non-retryable error. The exhausted error must have:

```js
{
  code: 'IMAGE_EGRESS_TURN_RETRY_EXHAUSTED',
  operation,
  attempts,
  elapsedMs,
  lastError,
}
```

Test cross-turn scheduling at failed turns 1, 2, and the 60-second cap. This helper calculates `nextAttemptAt`; it does not itself make a job terminal.

- [ ] **Step 3: Run the red retry suite**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/imageEgressRetry.spec.js
```

Expected red: module and exports do not exist.

- [ ] **Step 4: Implement the minimum retry module**

Normalize known transport and HTTP-status shapes without parsing log strings for submit safety. Use monotonic time only for the current call's `turnBudgetMs`; accept wall-clock `now` only in `getImageEgressNextAttemptAt`. Stop before sleeping or making another attempt if the next action would exceed the attempt or turn budget.

- [ ] **Step 5: Run green focused tests and lint**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/imageEgressRetry.spec.js
npx eslint server/services/ImageGeneration/imageEgressRetry.js server/services/ImageGeneration/imageEgressRetry.spec.js
```

Expected: tests and ESLint pass.

- [ ] **Step 6: Run the APIMart GPT Image 2 regression gate**

Run the standard regression command from `api/`. Expected: all existing v2 suites pass.

- [ ] **Step 7: Inspect and commit**

Run `git diff --check` and inspect both new files. Stage only Task 2 files and commit:

```bash
git commit -m "feat(image-generation): add bounded egress retry"
```

## Task 3: Add Durable Input/Output Lifecycle and Signed-URL Hygiene

**Phase:** Shared prerequisite for Phase B and Phase C
**Commit:** `feat(image-generation): persist durable egress images`

**Files:**

- Create: `api/server/services/ImageGeneration/imageEgressInputStorage.js`
- Create: `api/server/services/ImageGeneration/imageEgressInputStorage.spec.js`
- Create: `api/server/services/ImageGeneration/imageEgressOutputStorage.js`
- Create: `api/server/services/ImageGeneration/imageEgressOutputStorage.spec.js`
- Modify: `api/server/services/ImageGeneration/providerResultDownload.js`
- Modify: `api/server/services/ImageGeneration/providerResultDownload.spec.js`
- Modify: `packages/api/src/files/sweep.ts`
- Modify: `packages/api/src/files/sweep.spec.ts`
- Modify: `api/server/services/Files/process.js`
- Modify: `api/server/services/Files/process.spec.js`

**Interfaces to add:**

```js
stageImageEgressInputs({
  req,
  requestId,
  taskType,
  imageInputs,
  metadata,
})
// -> { refs, stagingBatchId }

resolveImageEgressInputRefs({
  userId,
  tenantId,
  refs,
  storageConfig,
})
// -> Buffer[] held only for the submit turn

cleanupImageEgressInputRefs({
  req,
  userId,
  tenantId,
  refs,
  storageConfig,
})

promoteImageEgressInputRefsToJobOwnership({
  internalTaskId,
  refs,
})
// verifies the nonterminal v3 job owns every ref, then clears provisional expiredAt

downloadImageEgressOutput({
  url,
  provider,
  retryPolicy,
  deps,
})
// -> { buffer, contentType, sourceMetadata, retryDiagnostics }

storeImageEgressOutput({ job, downloaded, storageConfig })
// -> { fileRef, expiresAt }

readImageEgressOutput({ userId, tenantId, fileRef, storageConfig })
// -> { buffer, contentType }

cleanupUncommittedImageEgressOutput({ fileRef, jobId, storageConfig })

sanitizeImageEgressOutputUrl(url)
// -> { hostname, pathHash, urlHash, hasQuery }
```

- [ ] **Step 1: Write failing staged-input lifecycle tests**

Prove staging writes only durable file references into the returned `refs` and never returns/stores binary or base64 metadata. Assign every staged file a bounded 26-hour provisional expiry immediately when it is created, before job creation. Test cleanup of all successfully staged refs when a later staging item fails.

Use a fake staging store and explicitly test the caller contract for all job-create outcomes:

1. pre-staging dedupe returns the existing job and creates zero objects;
2. duplicate unique-index race cleans the losing request's staged refs;
3. validation or database error after successful staging cleans every staged ref;
4. a simulated process crash before job create performs no cleanup call, but each staged file already has the 26-hour provisional expiry consumed by the existing expired-file sweep;
5. successful job creation promotes every input to job-owned retention by clearing provisional `expiredAt`, so a legitimate nonterminal job remains readable through runtime-gate pauses or worker outages longer than 26 hours;
6. if the process crashes after job creation but before explicit promotion, the existing expired-file sweep asks the injected ownership guard whether the exact file is referenced by a nonterminal v3 job; when true it clears the provisional expiry and skips deletion;
7. terminal job cleanup first restores an immediately sweepable bounded expiry and then attempts deletion, so a storage-delete failure is retried by the existing sweep instead of becoming a permanent orphan.

The route/service orchestration assertions for cases 1–3 and 5 are completed in Task 5; this task proves the storage primitives, provisional TTL, ownership promotion, crash-window guard, and terminal cleanup fallback.

In `packages/api/src/files/sweep.spec.ts`, add a dependency-injected `shouldPreserveExpiredFile(file)` case. A protected file is not passed to `processDeleteRequest`; an unowned provisional file follows the existing deletion path. In `api/server/services/Files/process.spec.js`, prove the wiring uses `db.hasNonterminalImageEgressJobReferencingFile`, clears `expiredAt` for a protected file, and otherwise preserves existing sweep behavior. This extends the current sweep and does not create another scheduler or GC subsystem.

- [ ] **Step 2: Write failing output retry, storage, and security tests**

Inject the Task 2 retry helper and fake downloader. Prove the first output GET timeout followed by success uses the exact same URL and makes no Provider call; final transient exhaustion exposes `IMAGE_OUTPUT_FETCH_FAILED`; HTTP 4xx, invalid image signature, rejected private/non-HTTPS URL, redirect to a private host, and oversized bodies are not retried.

Prove `storeImageEgressOutput` writes through the existing durable file strategy, assigns bounded retention before returning, and returns only a file reference. Simulate a final DB transition failure: `cleanupUncommittedImageEgressOutput` deletes only after confirming no job references the file; otherwise it leaves the bounded-TTL file for the existing sweep.

Capture logs and terminal metadata. Assert a signed URL's full query/token never appears, `sanitizeImageEgressOutputUrl` returns only hostname/hashes/query-presence, and terminal metadata contains no `pendingOutputUrl`.

- [ ] **Step 3: Run the red storage suites**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/imageEgressInputStorage.spec.js server/services/ImageGeneration/imageEgressOutputStorage.spec.js server/services/ImageGeneration/providerResultDownload.spec.js
npx jest --runInBand --coverage=false server/services/Files/process.spec.js
```

Run from `packages/api/`:

```bash
npx jest --runInBand --coverage=false src/files/sweep.spec.ts
```

Expected red: the new storage modules and wider safe Provider download contract do not exist.

- [ ] **Step 4: Implement the minimum storage adapters**

Build on the same file upload/read/delete and expiry mechanisms already used by `apimartImg2InputStorage.js`; do not add a second GC service. The 26-hour value is provisional orphan protection only. Normal job creation calls `promoteImageEgressInputRefsToJobOwnership` before returning 202; the narrow existing-sweep ownership guard closes the create-commit/process-crash window. Terminal cleanup makes the refs sweepable before best-effort delete. Generalize only the public-HTTPS Provider result validation in `providerResultDownload.js` so Fal and APIMart hosts pass the same redirect, size, and image-signature checks. Keep buffers in process memory only while resolving submit inputs or storing a downloaded output.

Persist raw signed URLs only through the job's select-false `providerMetadata.pendingOutputUrl` in later worker tasks. This module returns sanitized metadata for logging and terminal storage and never logs the input URL.

- [ ] **Step 5: Run green storage suites and lint**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/imageEgressInputStorage.spec.js server/services/ImageGeneration/imageEgressOutputStorage.spec.js server/services/ImageGeneration/providerResultDownload.spec.js
npx jest --runInBand --coverage=false server/services/Files/process.spec.js
npx eslint server/services/ImageGeneration/imageEgressInputStorage.js server/services/ImageGeneration/imageEgressInputStorage.spec.js server/services/ImageGeneration/imageEgressOutputStorage.js server/services/ImageGeneration/imageEgressOutputStorage.spec.js server/services/ImageGeneration/providerResultDownload.js server/services/ImageGeneration/providerResultDownload.spec.js server/services/Files/process.js server/services/Files/process.spec.js
```

Run from `packages/api/`:

```bash
npx jest --runInBand --coverage=false src/files/sweep.spec.ts
npx eslint src/files/sweep.ts src/files/sweep.spec.ts
```

Expected: all focused tests and ESLint pass.

- [ ] **Step 6: Run the APIMart GPT Image 2 regression gate**

Run the standard regression command from `api/`. Expected: v2 input externalization and result downloading remain green.

- [ ] **Step 7: Inspect and commit**

Run `git diff --check`, verify no binary/base64 fixtures were added, stage only Task 3 files, and commit:

```bash
git commit -m "feat(image-generation): persist durable egress images"
```

## Task 4: Split Fal Queue Submit, Status, and Result Operations

**Phase:** Phase B
**Commit:** `refactor(image-generation): split Fal queue operations`

**Files:**

- Modify: `api/server/services/ImageGeneration/adapters/fal/common.js`
- Create: `api/server/services/ImageGeneration/adapters/fal/common.queue.spec.js`
- Modify: `api/server/services/ImageGeneration/adapters/fal/index.js`
- Modify: `api/server/services/ImageGeneration/adapters/fal/openaiGptImage2Edit.js`
- Modify: `api/server/services/ImageGeneration/adapters/fal/openaiGptImage2Edit.spec.js`
- Modify: `api/server/services/ImageGeneration/adapters/fal/grokImagineImageEdit.js`
- Create: `api/server/services/ImageGeneration/adapters/fal/grokImagineImageEdit.spec.js`
- Modify: `api/server/services/ImageGeneration/adapters/fal/nanoBananaPro.js`
- Create: `api/server/services/ImageGeneration/adapters/fal/nanoBananaPro.spec.js`
- Create: `api/server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.js`
- Create: `api/server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.spec.js`

**Interfaces to add:**

```js
submitFalQueueTask({ model, payload, signal })
// -> {
//      providerTaskId: request_id,
//      providerMetadata: { statusUrl, responseUrl },
//    }

readFalQueueStatus({ model, providerTaskId, statusUrl, signal })
// -> {
//      state: 'pending' | 'succeeded' | 'failed',
//      providerStatus,
//      providerMetadata,
//    }

readFalQueueResult({ model, providerTaskId, responseUrl, signal })
// -> { outputUrls, providerMetadata }

createFalImageEgressAdapter({ model, deps })
// -> { submit, status, result }
```

Each model module must continue exporting its existing synchronous `generateImage` contract. Add a payload-builder export only where the durable adapter needs the identical already-tested payload mapping; do not duplicate prompt/image parameter construction.

- [ ] **Step 1: Write failing queue-operation contract tests**

In `common.queue.spec.js`, use a fake Fal client to assert:

- `submitFalQueueTask` calls the Queue submit endpoint once and maps `request_id` only to common `providerTaskId`;
- `status_url` and `response_url` remain Provider metadata, not alternate task IDs;
- status pending/completed/failed responses normalize to the fixed three-state adapter result;
- result parsing returns output URLs without downloading them;
- an error after invoking submit is returned to the caller with no internal retry;
- raw signed URLs are not logged.

In `imageEgressFalAdapter.spec.js`, exercise all exact models:

```text
openai/gpt-image-2/edit
xai/grok-imagine-image/edit
fal-ai/nano-banana-pro
```

Assert each uses its current request builder, produces the same Provider payload as the existing sync path, and exposes `submit/status/result`.

- [ ] **Step 2: Write failing synchronous-regression tests**

Extend `openaiGptImage2Edit.spec.js` and add the two declared Grok/Nano Banana specs to prove each `generateImage` export still completes submit -> poll -> result in one server call. Assert the v3 runtime gate is not consulted inside these synchronous model functions; the route remains responsible for choosing sync versus durable execution.

- [ ] **Step 3: Run the red Fal adapter suites**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/adapters/fal/common.queue.spec.js server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.spec.js server/services/ImageGeneration/adapters/fal/openaiGptImage2Edit.spec.js server/services/ImageGeneration/adapters/fal/grokImagineImageEdit.spec.js server/services/ImageGeneration/adapters/fal/nanoBananaPro.spec.js
```

Expected red: separated Queue exports and durable adapter do not exist; existing synchronous cases stay green.

- [ ] **Step 4: Implement the minimum Fal Queue split**

Extract one-call Queue operations from `common.js`. Keep the current synchronous helper by composing those operations with its existing polling behavior. The durable adapter's `submit` calls `submitFalQueueTask` exactly once; it must not call Task 2 retry code. `status` and `result` each make one Provider read so the worker controls bounded retries and deadlines.

- [ ] **Step 5: Run green Fal adapter suites and lint**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/adapters/fal/common.queue.spec.js server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.spec.js server/services/ImageGeneration/adapters/fal/openaiGptImage2Edit.spec.js server/services/ImageGeneration/adapters/fal/grokImagineImageEdit.spec.js server/services/ImageGeneration/adapters/fal/nanoBananaPro.spec.js
npx eslint server/services/ImageGeneration/adapters/fal/common.js server/services/ImageGeneration/adapters/fal/common.queue.spec.js server/services/ImageGeneration/adapters/fal/index.js server/services/ImageGeneration/adapters/fal/openaiGptImage2Edit.js server/services/ImageGeneration/adapters/fal/openaiGptImage2Edit.spec.js server/services/ImageGeneration/adapters/fal/grokImagineImageEdit.js server/services/ImageGeneration/adapters/fal/grokImagineImageEdit.spec.js server/services/ImageGeneration/adapters/fal/nanoBananaPro.js server/services/ImageGeneration/adapters/fal/nanoBananaPro.spec.js server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.js server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.spec.js
```

Expected: all Fal adapter and existing sync-path suites pass; ESLint passes.

- [ ] **Step 6: Run the APIMart GPT Image 2 regression gate**

Run the standard regression command from `api/`. Expected: all existing APIMart v2 suites pass.

- [ ] **Step 7: Inspect and commit**

Run `git diff --check`. Inspect that submit functions contain no retry loop and no retry wrapper. Stage only Task 4 files and commit:

```bash
git commit -m "refactor(image-generation): split Fal queue operations"
```

## Task 5: Implement the Isolated v3 Worker, Creation Service, and Usage Semantics

**Phase:** Phase B
**Commit:** `feat(image-generation): run Fal jobs durably`

**Files:**

- Create: `api/server/services/ImageGeneration/imageEgressAsync.js`
- Create: `api/server/services/ImageGeneration/imageEgressAsync.spec.js`
- Create: `api/server/services/ImageGeneration/imageEgressJobWorker.js`
- Create: `api/server/services/ImageGeneration/imageEgressJobWorker.spec.js`
- Modify: `api/server/services/UsageLedgerService.js`
- Modify: `api/server/services/UsageLedgerService.spec.js`

**Interfaces to add:**

```js
getImageEgressAsyncMode(env)
getImageEgressCanaryUserIds(env)
getImageEgressMaxConcurrency(env)
shouldUseImageEgressAsyncForUser({ userId, env })
getImageEgressWorkerRolloutModes(env)
shouldStartImageEgressWorker(env)

findOrStageAndEnqueueImageEgressJob({
  req,
  userId,
  tenantId,
  frontendTaskId,
  requestId,
  businessType,
  taskType,
  subMode,
  provider,
  model,
  modelKey,
  payload,
  imageInputs,
  inputMetadata,
  rolloutMode,
})
// -> { job, created }

getImageEgressJobStatus({ internalTaskId, userId })
startImageEgressWorker({ env, deps })

createImageEgressJobWorker({
  workerId,
  jobStore,
  slotStore,
  adapters,
  inputStorage,
  outputStorage,
  recordUsage,
  now,
  monotonicNow,
  sleep,
  random,
})
// -> { runOnce }

recordImageUsage({
  req,
  userId,
  tenantId,
  requestId,
  provider,
  model,
  modelKey,
  taskType,
  subMode,
  businessType,
  status,
  imageCount = 0,
  providerTaskId,
  batchId,
  itemId,
  durationMs,
  costCny,             // optional; explicit 0 must be preserved
  billingConfirmed,    // optional audit metadata
  metadata = {},       // optional Provider-safe audit metadata
})
```

Existing `recordImageUsage` callers may omit the new optional cost/audit fields and retain current behavior. The v3 worker must pass explicit `costCny: 0` and `billingConfirmed: false` for `status_unknown`.

- [ ] **Step 1: Write failing rollout and creation-lifecycle tests**

In `imageEgressAsync.spec.js`, test missing/invalid mode -> `off`, canary allowlist parsing, canary denial, all-mode selection, and max concurrency default/validation. Test that `off` starts no claiming loop and creates no v3 job, `canary` workers claim only `rolloutMode: 'canary'`, and `all` workers claim both `rolloutMode: 'canary'` and `rolloutMode: 'all'` so already-created canary jobs can finish after promotion.

For `findOrStageAndEnqueueImageEgressJob`, use injected stores and prove:

1. deterministic lookup happens before staging and returns an existing job;
2. successful staging creates a v3 job with `asyncVersion: 3`, `workerFamily: 'image-egress-v1'`, `workerEligible: true`, rollout mode, and refs only;
3. successful creation promotes all refs from provisional 26-hour expiry to non-expiring job-owned retention before returning the job;
4. a duplicate-index race cleans every ref staged by the losing request and returns the winning job;
5. any other validation/database or ownership-promotion exception after staging cleans every staged ref, removes/terminalizes the unusable just-created job as appropriate, and rethrows without returning 202;
6. the storage primitive had already applied the provisional 26-hour TTL before the create call, so a process crash before create cannot create an unbounded orphan; the existing sweep ownership guard protects the separate crash window after create;
7. no serialized job document contains `data:image`, base64 payloads, or image buffers.

- [ ] **Step 2: Write failing worker isolation, concurrency, and short-turn tests**

In `imageEgressJobWorker.spec.js`, inject fake job and slot stores. Assert `runOnce` acquires an `image-egress-v1` slot before calling the independent v3 claim, passes only Fal allowset entries during Phase B, runs one state-machine operation, persists the outcome, then releases job lease and slot. Simulate two worker instances with concurrency `1`; only one operation may be active. Assert no APIMart GPT Image 2 permit method is imported or called.

Test a pending status response: the worker persists polling state and `nextAttemptAt`, then releases both leases without sleeping until the next poll while holding either lease.

- [ ] **Step 3: Write failing Fal state-machine fault-injection tests**

Use a persistent in-memory job store shared across newly constructed worker instances to simulate restarts. Cover every transition and side effect:

- first claim sets `jobDeadlineAt` to wall-clock now + 30 minutes before input read;
- input-read first timeout then success stays pre-submit and invokes Fal submit once;
- input-read turn exhaustion persists operation diagnostics/deadlines/`nextAttemptAt`, remains nonterminal, releases leases, and a later worker resumes before submit;
- submit success persists `providerTaskId = request_id`, `submittedToProvider`, `providerAcceptedAt`, and select-false status/response metadata before any poll;
- restart with persisted ID resumes status and invokes submit zero times;
- status first timeout then success and multiple transient failures then success obey per-turn limits;
- status turn exhaustion before absolute deadline remains polling, persists cumulative attempts/error/deadline/`nextAttemptAt`, and resumes the same ID in a later process;
- result GET transient failure then success uses the same ID;
- result-turn exhaustion follows the same nonterminal cross-turn rule;
- output download first failure then success uses the exact same URL and never resubmits;
- final output-download failure becomes `failed` with `IMAGE_OUTPUT_FETCH_FAILED`, retains task ID and sanitized source metadata, removes raw signed URL, and stops loading via public terminal state;
- output storage succeeds before the job can become `succeeded`;
- output storage ambiguity becomes `failed` with `RESULT_STORAGE_FAILED`; it never retries storage or Provider submit;
- final DB transition failure leaves the uploaded file on bounded TTL or deletes it only after no-reference confirmation;
- every terminal state durably clears `pendingOutputUrl`, then cleans staged input refs;
- recovered `submitting` without task ID becomes `status_unknown` and a second worker turn never submits;
- non-retryable 4xx/Provider terminal errors fail immediately;
- `deadlineAt` or `jobDeadlineAt` expiry fails without another read;
- a gate switch to `off` stops new claims without mutating the paused job or resetting its absolute deadlines.

- [ ] **Step 4: Write failing usage-event audit tests**

In `UsageLedgerService.spec.js`, assert explicit `costCny: 0` reaches the existing top-level cost field while `billingConfirmed: false` is merged only into the existing `metadata` object; do not add a top-level schema field. Assert existing callers that omit these options produce the same event shape as before. In the worker spec, simulate a crash after the deterministic event upsert but before the job's `usageRecorded` flag. Restart and finish the same job; the fake usage store keyed by `usageEventId` must contain exactly one logical row.

Assert successful jobs produce one event with confirmed billing metadata. Assert `status_unknown` produces one audit event with:

```js
{
  status: 'status_unknown',
  requestCount: 1,
  imageCount: 0,
  costCny: 0,
  metadata: {
    billingConfirmed: false,
    auditOnly: true,
    submitOutcome: 'unknown',
  },
}
```

- [ ] **Step 5: Run the red worker/service/usage suites**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/services/UsageLedgerService.spec.js
```

Expected red: v3 service/worker and new usage semantics do not exist.

- [ ] **Step 6: Implement the minimum creation service and Fal worker**

Implement the fixed runtime gate and pre-staging dedupe/cleanup transaction boundary. Register only the three Fal adapters in the Phase B worker registry. Keep raw Provider URLs in select-false metadata only while needed for recovery. As with the existing v2 async module, guard module-level worker startup with `shouldStartImageEgressWorker`: importing the service in test/CI or `off` mode must never start a loop, while a runtime-enabled import starts only the isolated v3 worker.

Implement one operation per worker turn. The initial turn may resolve all staged inputs and invoke submit once under heartbeated job and slot leases; only the input reads use bounded retry. Transition to `submitting` before invoking the adapter. If the adapter was invoked and no task ID is known afterward, persist `status_unknown` without parsing the error to guess whether bytes were sent. With a task ID, all future work is status/result/download/storage on that same ID.

When a transient read exhausts the current turn before the absolute deadline, persist cumulative counters, last error, `deadlineAt`, and jittered `nextAttemptAt`; do not mark terminal. Use wall-clock absolute timestamps across worker instances and monotonic time only inside Task 2's current-turn helper.

Add optional UsageLedger fields without changing existing call behavior. Use the existing deterministic `usageEventId` so replay is an upsert, not a second charge/event.

- [ ] **Step 7: Run green worker/service/usage suites and lint**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/services/UsageLedgerService.spec.js
npx eslint server/services/ImageGeneration/imageEgressAsync.js server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/services/UsageLedgerService.js server/services/UsageLedgerService.spec.js
```

Expected: all focused tests and ESLint pass.

- [ ] **Step 8: Run the APIMart GPT Image 2 regression gate**

Run the standard regression command from `api/`. Expected: existing v2 worker/permit/lease behavior remains green.

- [ ] **Step 9: Inspect and commit**

Run:

```bash
git diff --check
git diff -- api/server/services/ImageGeneration/apimartImg2Async.js api/server/services/ImageGeneration/apimartImg2JobWorker.js
git status --short
```

Expected: the two named APIMart v2 worker files have no diff. Stage only Task 5 files and commit:

```bash
git commit -m "feat(image-generation): run Fal jobs durably"
```

## Task 6: Gate Phase B Routes, Status/Result Serving, and Frontend Polling

**Phase:** Phase B independent review and delivery checkpoint
**Commit:** `feat(image-generation): enable gated Fal async routes`

**Files:**

- Modify: `api/server/routes/imageGeneration.js`
- Create: `api/server/routes/imageGeneration.imageEgressAsync.spec.js`
- Modify: `client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx`

`ImageGeneration.tsx` remains unchanged: commit `950f7de8855d9843435ab86db0f8dacc04e95b48` already polls `internalTaskId`, keeps true waiting/running states processing, closes explicit terminal failures, exposes Retry, and accepts returned image URLs. This task supplies v3 responses in that existing shape and extends its regression test only.

**HTTP contracts:**

```text
POST /api/image-generation/text-to-image
POST /api/image-generation/image-to-image
POST /api/image-generation/multi-reference
202 { internalTaskId, state: "queued" }

GET /api/image-generation/tasks/:internalTaskId
200 {
  internalTaskId,
  state: "queued" | "running" | "success" | "failed" | "status_unknown",
  error?: { code, message, retryableByUser },
  images?: [{ url: "/api/image-generation/tasks/:internalTaskId/result-image" }]
}

GET /api/image-generation/tasks/:internalTaskId/result-image
200 image bytes for the authenticated owner only
```

- [ ] **Step 1: Write failing route gate and model-selection tests**

In `imageGeneration.imageEgressAsync.spec.js`, cover `off`, canary allowlisted, canary denied, and all modes for each exact Fal model. Assert:

- `off` and denied canary users follow the existing synchronous adapter path;
- selected users get a fast 202 with `internalTaskId`, and the Express response does not wait for Provider submit/polling;
- route validation, prompt construction, preprocessing, and staging occur before successful job creation;
- APIMart GPT Image 2 is checked first and still uses only `apimartImg2Async.js`;
- Ark and SiliconFlow remain synchronous and create no v3 job;
- text-to-image Nano Banana, single-reference edits, and supported multi-reference Fal edits select the correct durable adapter;
- duplicate frontend POST returns the existing v3 task without restaging.

- [ ] **Step 2: Write failing authenticated status/result tests**

Prove status lookup checks v3 ownership and maps every fixed public state without adding `cancelled`. Successful jobs expose only the authenticated result route, not file storage credentials or raw Provider URLs. The result route reads the durable file reference and returns content type/body; a different user receives the existing not-found/forbidden response. A missing/expired output file becomes an explicit terminal result error and never invokes Provider submit.

- [ ] **Step 3: Write failing frontend state tests**

In `ImageGeneration.multiReferenceUpload.spec.tsx`, prove v3 `queued` and `running` continue the spinner/polling flow. Prove `failed`, `status_unknown`, `degraded`, `IMAGE_GENERATION_TIMEOUT`, `APIMART_IMAGE_SUBMIT_TIMEOUT`, `IMAGE_OUTPUT_FETCH_FAILED`, and `FAL_NETWORK_ERROR` stop the spinner and expose the existing retry action. Prove successful status uses the authenticated task-result URL and ends loading. Preserve the existing terminal-state regression fixed by commit `950f7de8855d9843435ab86db0f8dacc04e95b48`.

- [ ] **Step 4: Run the red route/client tests**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/routes/imageGeneration.imageEgressAsync.spec.js
```

Run from `client/`:

```bash
npx jest --runInBand --coverage=false src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
```

Expected red: Fal v3 route/status/result contracts are not wired; existing terminal-state cases stay green.

- [ ] **Step 5: Implement the minimum route and frontend integration**

Place APIMart GPT Image 2's current routing decision before the new v3 selection. For in-scope Fal users selected by the new gate, call `findOrStageAndEnqueueImageEgressJob` and return 202. Extend the existing task-status endpoint to look up an owned v3 task, then fall back to the unchanged v2 lookup. Add the authenticated result-image route backed only by the stored file ref.

Reuse the current frontend polling state machine without a production UI edit or redesign. The API adapter must return the exact existing state/result shape proved by the client regression test.

- [ ] **Step 6: Run green route/client tests and lint**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/routes/imageGeneration.imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/services/ImageGeneration/adapters/fal/imageEgressFalAdapter.spec.js
npx eslint server/routes/imageGeneration.js server/routes/imageGeneration.imageEgressAsync.spec.js
```

Run from `client/`:

```bash
npx jest --runInBand --coverage=false src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
npx eslint src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
```

Expected: Phase B API/client tests and lint pass.

- [ ] **Step 7: Run Phase B regressions, including APIMart GPT Image 2**

Run the standard APIMart GPT Image 2 gate from `api/`, then run:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/adapters/fal server/services/ImageGeneration/imageEgressRetry.spec.js server/services/ImageGeneration/imageEgressInputStorage.spec.js server/services/ImageGeneration/imageEgressOutputStorage.spec.js server/services/UsageLedgerService.spec.js
```

Expected: all Phase B and v2 regression suites pass. Explicitly inspect test evidence for one Provider submit, one logical usage row, cross-turn continuation, and unchanged sync fallback.

- [ ] **Step 8: Review Phase B diff and commit**

Run:

```bash
git diff --check
git diff --stat 130a631d8dacfad98873b5beb78095a382317ac8
git diff --name-only 130a631d8dacfad98873b5beb78095a382317ac8
```

Confirm Phase B contains only shared v3 primitives, Fal adapter/worker/routes/storage, Usage audit support, data schemas, and focused tests. Confirm no Ark/SiliconFlow adapter or APIMart GPT Image 2 worker/permit file changed. Stage Task 6 files and commit:

```bash
git commit -m "feat(image-generation): enable gated Fal async routes"
```

This commit is the independent Phase B review point. Do not begin Phase C until its diff and tests are reviewable on their own.

## Task 7: Add APIMart Gemini 3.1/2.5 to the v3 Worker

**Phase:** Phase C independent review and delivery checkpoint
**Commit:** `feat(image-generation): queue APIMart Gemini jobs durably`

**Files:**

- Modify: `api/server/services/ImageGeneration/adapters/apimart/common.js`
- Modify: `api/server/services/ImageGeneration/adapters/apimart/common.spec.js`
- Modify: `api/server/services/ImageGeneration/adapters/apimart/index.js`
- Create: `api/server/services/ImageGeneration/adapters/apimart/imageEgressGeminiAdapter.js`
- Create: `api/server/services/ImageGeneration/adapters/apimart/imageEgressGeminiAdapter.spec.js`
- Modify: `api/server/services/ImageGeneration/imageEgressAsync.js`
- Modify: `api/server/services/ImageGeneration/imageEgressAsync.spec.js`
- Modify: `api/server/services/ImageGeneration/imageEgressJobWorker.js`
- Modify: `api/server/services/ImageGeneration/imageEgressJobWorker.spec.js`
- Modify: `api/server/routes/imageGeneration.imageEgressAsync.spec.js`

**Interfaces to add:**

```js
readAPIMartTaskStatus({ taskId, signal })
// -> {
//      state: 'pending' | 'succeeded' | 'failed',
//      providerStatus,
//      outputUrls,
//      providerMetadata,
//    }

createAPIMartGeminiImageEgressAdapter({ model, deps })
// -> { submit, status }
```

The adapter allowset is exactly:

```text
gemini-3.1-flash-image-preview
gemini-2.5-flash-image-preview
```

The existing `submitImageTask`, APIMart payload builders, response parser, and synchronous `pollTask` behavior are reused. `readAPIMartTaskStatus` performs one poll read; Task 2/Task 5 own retries and scheduling. APIMart's completed task response already contains the output URL, so the Gemini adapter has no separate Provider result GET: a successful `status` returns `outputUrls`, and the worker persists the selected URL before scheduling `output_download`.

- [ ] **Step 1: Write failing one-shot APIMart poll tests**

In `common.spec.js`, assert `readAPIMartTaskStatus` makes exactly one status GET and normalizes pending, successful output, and terminal Provider failure. Assert it has no loop, sleep, submit, or retry side effect. Re-run all existing `pollTask` tests in the same suite to protect synchronous behavior and GPT Image 2 parser behavior.

- [ ] **Step 2: Write failing Gemini adapter tests**

In `imageEgressGeminiAdapter.spec.js`, test both exact models. Assert `submit` calls the existing `submitImageTask` once, maps its task ID to `providerTaskId`, and performs no retry. Assert `status` performs one `readAPIMartTaskStatus` call with the same ID. A completed response must return its parsed `outputUrls` directly; the adapter performs no second Provider result request, and the worker's next turn is `output_download` for the persisted selected URL.

Test explicit Provider rejection versus ambiguous submit transport loss. The adapter returns enough classification for the worker to store `rejected` as failed and transport loss after invocation as `submit_result_unknown`; neither path calls submit twice.

- [ ] **Step 3: Write failing Gemini worker recovery and route tests**

Extend `imageEgressJobWorker.spec.js` and `imageGeneration.imageEgressAsync.spec.js` to prove:

- Gemini 3.1/2.5 selected users get v3 jobs with `asyncVersion: 3`, `workerFamily: 'image-egress-v1'`, and Provider/model allowset match;
- task ID is durable before the first poll;
- a newly constructed worker resumes the same task ID and invokes submit zero times;
- first APIMart poll timeout then success uses bounded retry;
- a poll turn exhausting its local budget persists `nextAttemptAt` and absolute deadline, remains running, and resumes across process restart;
- ambiguous submit becomes `status_unknown`, records the zero-cost/non-confirmed audit event, stops the frontend spinner through the fixed public mapping, and never submits again;
- output URL download/storage follows Task 3 and reaches success only after durable file storage;
- one successful Gemini task produces one deterministic usage row;
- runtime `off` and denied canary continue through the existing synchronous APIMart Gemini path;
- Ark, SiliconFlow, and APIMart GPT Image 2 route selection remains unchanged.

- [ ] **Step 4: Run the red Phase C suites**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/adapters/apimart/common.spec.js server/services/ImageGeneration/adapters/apimart/imageEgressGeminiAdapter.spec.js server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/routes/imageGeneration.imageEgressAsync.spec.js
```

Expected red: one-shot Gemini adapter/registry/route behavior is missing. Existing APIMart common and Phase B Fal cases remain green.

- [ ] **Step 5: Implement the minimum Phase C adapter and registration**

Add `readAPIMartTaskStatus` beside, not inside, the existing long-poll helper. Build the Gemini durable adapter from existing submit/payload/parse functions. Register only Gemini 3.1 and 2.5 in the v3 service and worker allowset; do not generalize or rename APIMart GPT Image 2 modules.

Use the same one-operation-per-turn state machine and retry policies delivered in Phase B. Persist a returned task ID before polling. A recovered `submitting` Gemini job with no task ID becomes `status_unknown`; it must not call APIMart submit.

- [ ] **Step 6: Run green Phase C suites and lint**

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/adapters/apimart/common.spec.js server/services/ImageGeneration/adapters/apimart/imageEgressGeminiAdapter.spec.js server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/routes/imageGeneration.imageEgressAsync.spec.js
npx eslint server/services/ImageGeneration/adapters/apimart/common.js server/services/ImageGeneration/adapters/apimart/common.spec.js server/services/ImageGeneration/adapters/apimart/index.js server/services/ImageGeneration/adapters/apimart/imageEgressGeminiAdapter.js server/services/ImageGeneration/adapters/apimart/imageEgressGeminiAdapter.spec.js server/services/ImageGeneration/imageEgressAsync.js server/services/ImageGeneration/imageEgressAsync.spec.js server/services/ImageGeneration/imageEgressJobWorker.js server/services/ImageGeneration/imageEgressJobWorker.spec.js server/routes/imageGeneration.imageEgressAsync.spec.js
```

Expected: Phase C, Phase B worker cases, and ESLint pass.

- [ ] **Step 7: Run APIMart GPT Image 2 and text-to-image regressions**

Run the standard APIMart GPT Image 2 gate from `api/`, then run:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration/adapters/apimart server/services/ImageGeneration/adapters/fal server/routes/imageGeneration.imageEgressAsync.spec.js
```

Expected: APIMart GPT Image 2 v2, Fal Phase B, Gemini Phase C, Fal Nano Banana text-to-image, and current sync fallback cases all pass. Route assertions must explicitly prove Ark/SiliconFlow remain outside the v3 path.

- [ ] **Step 8: Review Phase C diff and commit**

Run:

```bash
git diff --check
git diff --stat HEAD
git diff --name-only HEAD
git diff -- api/server/services/ImageGeneration/apimartImg2Async.js api/server/services/ImageGeneration/apimartImg2JobWorker.js packages/data-schemas/src/methods/imageProviderConcurrencyLease.ts
```

Expected: Phase C changes only the declared Gemini/common adapter, v3 registry/worker tests, and route tests; the named GPT Image 2 and permit files have no diff. Stage only Task 7 files and commit:

```bash
git commit -m "feat(image-generation): queue APIMart Gemini jobs durably"
```

This commit is the independent Phase C review point.

## Final Delivery Gate

Run this gate only after Tasks 1–7 have their focused commits. Fix any failure by returning to red/green TDD in the smallest responsible module and adding a focused fix commit; do not hide failures by increasing timeouts.

### 1. Data-schema regression

Run from `packages/data-schemas/`:

```bash
npx jest --runInBand --coverage=false src/methods/imageGenerationJob.spec.ts src/methods/imageEgressWorkerSlot.spec.ts src/methods/imageProviderConcurrencyLease.spec.ts
```

Run from repository root:

```bash
npm run build:data-schemas
```

Expected: all tests and the package build pass; v2 lease methods are unchanged.

### 2. Complete API ImageGeneration and usage regression

Run from `api/`:

```bash
npx jest --runInBand --coverage=false server/services/ImageGeneration server/routes/imageGeneration.apimartAsync.spec.js server/routes/imageGeneration.imageEgressAsync.spec.js server/services/UsageLedgerService.spec.js
```

Expected: the complete ImageGeneration service directory, both async route suites, and UsageLedger tests pass. The output must include the fault-injection cases for Fal/Gemini restart recovery, bounded cross-turn retry, submit ambiguity, identical-URL output retry, final output failure, one logical usage row, no repeated Provider submit, and no repeated billing event.

### 3. Client terminal/waiting regression

Run from `client/`:

```bash
npx jest --runInBand --coverage=false src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
```

Expected: queued/polling stays processing; every explicit terminal failure stops loading and exposes Retry; success displays the result.

### 4. ESLint and typecheck

Run from repository root:

```bash
npx eslint packages/data-schemas/src/types/imageGenerationJob.ts packages/data-schemas/src/schema/imageGenerationJob.ts packages/data-schemas/src/methods/imageGenerationJob.ts packages/data-schemas/src/methods/imageGenerationJob.spec.ts packages/data-schemas/src/types/imageEgressWorkerSlot.ts packages/data-schemas/src/schema/imageEgressWorkerSlot.ts packages/data-schemas/src/models/imageEgressWorkerSlot.ts packages/data-schemas/src/methods/imageEgressWorkerSlot.ts packages/data-schemas/src/methods/imageEgressWorkerSlot.spec.ts
npx eslint api/server/services/ImageGeneration api/server/routes/imageGeneration.js api/server/routes/imageGeneration.imageEgressAsync.spec.js api/server/services/UsageLedgerService.js api/server/services/UsageLedgerService.spec.js client/src/routes/ImageGeneration.multiReferenceUpload.spec.tsx
npm run typecheck --workspace=@librechat/frontend
```

Expected: ESLint passes on all changed implementation/test areas. Typecheck passes; if the baseline commit has unrelated known failures, first reproduce the identical failure on `130a631d8dacfad98873b5beb78095a382317ac8`, document both outputs, and prove the implementation adds no new error. Do not waive a new error.

### 5. Client production build and diff hygiene

Run from repository root:

```bash
npm run build:client
git diff --check 130a631d8dacfad98873b5beb78095a382317ac8..HEAD
git diff --stat 130a631d8dacfad98873b5beb78095a382317ac8..HEAD
git diff --name-only 130a631d8dacfad98873b5beb78095a382317ac8..HEAD
```

Expected: production client build passes; no whitespace errors. The name/stat output is limited to:

- v3 ImageGeneration job/worker-slot schemas and tests;
- shared v3 retry/input/output/service/worker modules and tests;
- Fal and APIMart Gemini adapters/tests;
- focused ImageGeneration routes and frontend polling tests;
- Usage audit semantics/tests;
- required schema export indexes.

The final diff must not contain Ark/SiliconFlow adapter changes, APIMart GPT Image 2 worker/permit/concurrency/lease changes, unrelated UI redesign, Skill changes, deployment manifests, or production configuration.

### 6. Local production Docker build

Run from repository root:

```bash
docker build --build-arg BUILD_COMMIT=local-image-egress-resilience --build-arg BUILD_BRANCH=fix/image-generation-egress-resilience -t jingjicang-librechat:image-egress-resilience-local .
```

Expected: Docker exits 0 and produces local image `jingjicang-librechat:image-egress-resilience-local`. Do not push the image and do not deploy it.

### 7. Delivery report and stop condition

Record:

- Phase B commit range and exact files;
- Phase C commit and exact files;
- retry matrix test evidence;
- submit ambiguity and zero-cost/non-confirmed usage audit evidence;
- staged-input cleanup/TTL and output orphan-bound evidence;
- fault-injection, APIMart GPT Image 2, text-to-image, terminal frontend, full regression, ESLint, typecheck/build, `git diff --check`, and Docker results;
- final `git diff --stat` and HEAD SHA.

Then stop. Do not push, deploy Canary, switch traffic, or touch production.
