# Image Generation Egress Resilience Design

## Context

The release-candidate baseline is commit
`950f7de8855d9843435ab86db0f8dacc04e95b48`. It already contains durable
APIMart GPT Image 2 jobs, staged multi-reference inputs that stay below the
MongoDB BSON limit, and frontend terminal-state handling.

This recovery-window change must reduce browser-held HTTP requests without
rewriting the proven APIMart GPT Image 2 worker. Work is deliberately split:

1. Phase B migrates Fal models to durable internal jobs.
2. Phase C migrates APIMart Gemini 3.1 and 2.5 to the same new framework.
3. Ark Seedream and SiliconFlow remain synchronous and unchanged.

No production deployment, traffic switch, Provider submit retry, Skill change,
or broad ImageGeneration redesign is part of this work.

## Current Provider Lifecycles

| Entry/model | Current route lifecycle | Current Provider lifecycle |
| --- | --- | --- |
| APIMart GPT Image 2 text/edit/multi-reference | Durable only when the existing rollout selects the user; otherwise route waits | submit, persist `providerTaskId`, poll |
| Fal GPT Image 2 Edit | Browser-held route request | Fal Queue submit, status polling, result GET |
| Fal Grok Image Edit | Browser-held route request | Fal Queue submit, status polling, result GET |
| Fal Nano Banana | Browser-held route request | Fal Queue submit, status polling, result GET |
| APIMart Gemini 3.1/2.5 | Browser-held route request | APIMart submit, polling |
| Ark Seedream | Browser-held route request | synchronous POST returning final output |
| SiliconFlow | Browser-held route request | synchronous POST returning final output |

Fal already uses the official persistent Queue API, but the server currently
performs submit, status polling, and result retrieval in one Express request.
The migration splits those operations across durable worker turns.

## Scope Boundaries

### In scope

- Fal GPT Image 2 Edit, Grok Image Edit, and Nano Banana.
- APIMart Gemini 3.1 and Gemini 2.5.
- Text-to-image, single-reference edit, and multi-reference routes where the
  selected in-scope model supports that task.
- Durable input references for image-edit jobs.
- Bounded retry for Provider status GET, Provider result GET, durable input
  reference reads, and output image download.
- Durable output file storage before a job is marked successful.
- Frontend polling through the existing `internalTaskId` contract.
- Fault-injection and regression tests.

### Out of scope

- Any change to APIMart GPT Image 2 worker, permit, concurrency, lease/fencing,
  or submit semantics.
- Ark Seedream or SiliconFlow migration.
- Automatic retry of any Provider task-creation POST.
- Provider retry-count increases hidden inside longer global timeouts.
- UI redesign, production deployment, or traffic changes.

## Architecture

### Preserve the APIMart GPT Image 2 path

The following existing modules remain behaviorally unchanged:

- `apimartImg2Async.js`
- `apimartImg2JobWorker.js`
- APIMart GPT Image 2 provider adapter behavior
- APIMart GPT Image 2 permit and concurrency persistence

New routes must check APIMart GPT Image 2 first and continue using its existing
rollout-controlled path. The existing APIMart GPT Image 2 claim/query method,
its signature, its defaults, and every call site remain unchanged.

### Structural worker isolation

New Fal/Gemini jobs use both of these persisted discriminators:

- `asyncVersion: 3`
- `workerFamily: "image-egress-v1"`

The data-schema layer adds a separate `acquireImageEgressJobLease` method. It
does not add filters or default arguments to the existing
`acquireImageGenerationJobLease` method. The new claim query requires all of:

- `asyncVersion: 3`;
- `workerFamily: "image-egress-v1"`;
- `workerEligible: true`;
- an enabled rollout mode;
- `nextAttemptAt` missing, null, or at/before the current wall-clock time;
- an exact Provider/model pair from this allowset:
  - `fal/openai/gpt-image-2/edit`;
  - `fal/xai/grok-imagine-image/edit`;
  - `fal/fal-ai/nano-banana-pro`;
  - `apimart/gemini-3.1-flash-image-preview`;
  - `apimart/gemini-2.5-flash-image-preview`.

The query contains no fallback Provider or model. Historical jobs, jobs without
the worker-family discriminator, and all APIMart GPT Image 2 v2 jobs are
structurally ineligible for this worker.

### Add a narrow durable Provider job framework

Add a separate worker/service for Fal and APIMart Gemini while reusing the
existing `ImageGenerationJob` collection and frontend status response shape.
The framework owns only:

- job creation and frontend-task deduplication;
- lease-based worker claiming for an explicit Provider/model set;
- durable input-reference resolution;
- submit-state fencing;
- Provider task ID persistence;
- retryable status/result reads;
- output download and durable result-file storage;
- terminal state and one logical usage event.

The framework does not use the APIMart GPT Image 2 concurrency permit
collection. Its lease and concurrency controls are independent.

### Rollout and kill switch

The new framework has its own runtime gate:

- `IMAGE_EGRESS_ASYNC_MODE=off|canary|all`, default `off`;
- `IMAGE_EGRESS_ASYNC_CANARY_USER_IDS`, a comma/whitespace-separated user ID
  allowlist used only in `canary` mode;
- `IMAGE_EGRESS_MAX_CONCURRENCY`, a positive integer with default `1`.

In `off`, routes preserve their current synchronous behavior for Fal/Gemini,
no v3 jobs are created, and the `image-egress-v1` worker does not claim jobs.
In `canary`, only allowlisted users receive v3 jobs and the worker claims only
`rolloutMode: "canary"`. In `all`, all users receive v3 jobs and the worker may
claim both `canary` and `all` v3 jobs. Invalid or missing mode values resolve to
`off`. A code deployment therefore cannot enable this framework by itself.

Switching to `off` pauses unclaimed/nonterminal v3 jobs without mutating them;
returning to the matching rollout mode resumes them from persisted state.

### Worker concurrency and turn shape

`image-egress-v1` runs at most `IMAGE_EGRESS_MAX_CONCURRENCY` active job turns
across all application replicas, with recovery-window default `1`. This bound
uses a new worker-family slot lease keyed by
`workerFamily + slotNumber` in a separate `ImageEgressWorkerSlot` collection.
It does not reuse the APIMart GPT Image 2 provider-permit collection. Slot lease
records are fixed/reusable coordination records, not per-job objects; a unique
`workerFamily + slotNumber` index and lease expiry enforce the global bound.

A worker acquires one family slot before claiming one job. A turn performs one
state-machine operation (status read, result read, output download, or output
storage), persists the outcome, releases the job lease, then releases the slot.
It does not hold either lease while waiting for the next Provider poll.

The only combined turn is initial input resolution plus submit: image bytes
must remain in memory and must not be written into the Mongo job. That turn
retries only the input-reference reads; once all inputs are resolved it invokes
Provider submit exactly once under the same heartbeated job/slot leases. A
transient input-read exhaustion schedules another pre-submit turn without ever
calling Provider submit.

Retryable work that cannot finish in the current turn sets `nextAttemptAt` and
releases the lease. Submit and storage calls may heartbeat their own job lease
and family-slot lease while the single call is in flight, but they do not
acquire or modify APIMart GPT Image 2 provider permits. Increasing new-worker
concurrency later creates/uses only additional `image-egress-v1` slots and
affects only v3 jobs.

### Fast browser contract

For in-scope models the route performs validation, prompt construction, image
preprocessing, and durable input staging, then creates one job and returns HTTP
202:

```text
browser -> route -> durable job -> 202 { internalTaskId, state: "queued" }
browser -> GET /api/image-generation/tasks/:internalTaskId
```

The existing frontend task polling handles queued/running/succeeded/failed and
status-unknown responses. True waiting and polling states continue showing the
spinner. Terminal failure stops it and exposes Retry.

The v3 public-state mapping is fixed: `waiting` maps to `queued`; `submitting`
and `polling` map to `running`; `succeeded` maps to `success`; `failed` maps to
`failed`; and `status_unknown` maps to `status_unknown`. Phase B/C adds no other
terminal or public state.

## Phase B: Fal State Machine

Fal Queue operations are separated into `submit`, `status`, and `result`
adapter methods.

```text
waiting
  -> submitting
  -> polling (request_id persisted before any later operation)
       phase=status
       phase=result
       phase=output_download
       phase=output_storage
  -> succeeded
```

Terminal alternatives are `failed` and `status_unknown`.
The phase labels are diagnostic metadata while the durable job status remains
`polling`; this change does not expand the existing public status enum.

1. The worker transitions the job to `submitting` before calling Fal.
2. It calls Fal submit exactly once for that job.
3. On a successful response, it persists `request_id`, status/response URLs,
   `submittedToProvider=true`, and `providerAcceptedAt` before polling.
4. A restart with a persisted `request_id` resumes status polling and never
   calls submit.
5. Status GET is retried only for transient reads. If a turn exhausts its retry
   budget before the persistent deadline, the job remains `polling`, records
   `nextAttemptAt`, and releases its lease. A completed status leads to result
   GET using the same `request_id` in a later operation/turn.
6. Result GET follows the same cross-turn retry rule.
7. Output URLs are persisted as diagnostic metadata, downloaded with bounded
   retry, validated as images, and stored through the existing file-storage
   strategies.
8. The job is marked `succeeded` only after the durable output file reference
   is saved.

If a recovered job is in `submitting` without a persisted `request_id`, the
worker marks it `status_unknown` and does not submit again.

## Phase C: APIMart Gemini State Machine

APIMart Gemini 3.1 and 2.5 use the same durable framework but keep their
existing APIMart payload builders and polling response parsers.

1. The route returns an internal task immediately.
2. The worker performs one APIMart submit.
3. The returned `providerTaskId` is durably persisted before polling.
4. A worker restart resumes polling with that exact task ID.
5. A recovered `submitting` job without a task ID becomes `status_unknown` and
   is never resubmitted automatically.
6. Provider output goes through the same bounded download and durable storage
   pipeline as Fal.

No APIMart GPT Image 2 module is generalized or renamed to implement Gemini.

## Submit Ambiguity Policy

Provider submit has no automatic retry in this recovery-window change.

| Observation | Classification | Action |
| --- | --- | --- |
| Validation, configuration, input staging, or job creation fails before the Provider adapter is invoked | `definitely_not_submitted` | Terminal failure; user may explicitly retry with a new job |
| Fal/APIMart returns a task ID | `submitted` | Persist ID, then poll/resume only |
| Submit returns an explicit terminal HTTP response with a parsed Provider rejection | `rejected` | Terminal failure; no automatic resubmit |
| Fetch throws, times out, TLS resets, process crashes, or response is lost after the Provider adapter is invoked and no task ID is known | `submit_result_unknown` | Persist `status_unknown`; fail closed; no automatic resubmit |
| Worker recovers a `submitting` job without task ID | `submit_result_unknown` | Persist `status_unknown`; no automatic resubmit |

Error strings are not used to infer that bytes were never sent. Only failures
before invoking the Provider adapter qualify as `definitely_not_submitted`.

## Network Retry Matrix

Retries use exponential backoff with injected jitter. A monotonic clock limits
elapsed time only inside the current worker turn. Cross-turn limits use the
persisted absolute wall-clock fields described below, so process restart does
not reset a deadline. Tests inject a zero-delay sleeper, deterministic jitter,
and controlled monotonic/wall clocks.

| Operation | Retryable failures | Per-turn budget | Persistent deadline | Never retried |
| --- | --- | --- | --- | --- |
| Provider submit POST | none | one call | existing per-attempt timeout; ambiguity is immediately terminal unknown | every submit failure |
| Fal status GET / APIMart poll GET | timeout, TLS/network error, `ECONNRESET`, HTTP 502/503/504 | 4 attempts, 500 ms base, 5 s cap, 20% jitter, maximum 30 s in one turn | `deadlineAt = min(providerAcceptedAt + 15 minutes, jobDeadlineAt)` | 4xx, parsed terminal Provider status |
| Fal result GET | same transient set | 4 attempts, 500 ms base, 5 s cap, 20% jitter, maximum 30 s in one turn | three minutes from entering result phase, capped by `jobDeadlineAt` | 4xx, malformed terminal result |
| Output image GET | same transient set | 3 attempts, 750 ms base, 6 s cap, 20% jitter, maximum 45 s in one turn | five minutes from first output-fetch attempt, capped by `jobDeadlineAt` | 4xx, invalid image, rejected URL, oversized body |
| Durable input-reference read | timeout, TLS/storage transport error, `ECONNRESET`, storage 502/503/504 equivalent | 3 attempts, 250 ms base, 2 s cap, 20% jitter, maximum 20 s in one turn | five minutes from first input-read attempt, capped by `jobDeadlineAt` | missing/expired reference, authorization error, invalid content |
| Durable output storage | none until the storage adapter proves an idempotent write contract | one call after a successful download | current turn, capped by `jobDeadlineAt` | every ambiguous or failed storage write; existing file TTL handles possible orphan output |

On the first worker claim, before any input read or submit, `jobDeadlineAt` is
persisted as the current wall-clock time plus 30 minutes. Jobs paused by the
runtime gate before their first claim therefore do not consume the deadline.
Once work has started, disabling the worker does not reset or extend the
absolute deadline. When an operation starts, the worker persists `deadlineAt`
to the operation deadline shown above. It also persists:

- `currentOperation` (`input_read`, `status_read`, `result_read`,
  `output_download`, or `output_storage`);
- `operationAttemptCount`, cumulative for that operation across turns;
- `operationTransientFailureCount`, cumulative across turns;
- `lastOperationErrorCode` and `lastOperationAt`;
- `nextAttemptAt`.

When a turn succeeds, the next operation resets operation-specific counters and
gets a new `deadlineAt`, still capped by `jobDeadlineAt`. When a transient turn
budget is exhausted before the deadline, the worker keeps the job nonterminal,
increments the persistent counters, and schedules the next turn with
`min(5 seconds * 2^(failed turns - 1), 60 seconds)` plus 20% jitter. It then
releases the lease.

Only a non-retryable error, `deadlineAt` expiry, or `jobDeadlineAt` expiry makes
the job terminal. Retry exhaustion preserves the last error code, cumulative
attempt count, Provider task ID, request ID, and operation name. While waiting
for `nextAttemptAt`, the public state remains processing/polling, not failed.

## Output Fetch and Storage

The worker handles only already-created Provider results:

```text
provider terminal success
  -> persist output URL metadata
  -> bounded GET retry of the same URL
  -> validate public HTTPS target, redirect chain, size, and image signature
  -> save buffer using existing durable file-storage strategy
  -> persist file reference metadata in ImageGenerationJob.result
  -> mark succeeded
```

Mongo stores only file reference metadata and sanitized Provider output URL
metadata. It never stores output binary or full base64. The job status endpoint
returns an authenticated task-result URL backed by the stored file reference.

If download or storage finally fails, the job becomes terminal `failed` with
`IMAGE_OUTPUT_FETCH_FAILED` or `RESULT_STORAGE_FAILED`. The job retains
`providerTaskId`, sanitized output-source metadata, and retry
diagnostics. It never returns to submit or creates another Provider task.

### Provider identity and signed URL security

Fal `request_id` is always stored in the common `providerTaskId` field. Fal
`status_url`, `response_url`, queue position, and similar fields live in a
select-false `providerMetadata` object and are never treated as a second task
identity.

While output fetch is pending, a signed output URL may be stored in the
select-false `providerMetadata.pendingOutputUrl` field because a later worker
turn must resume the same download. Logs never contain the full URL, query,
signature, or token; they may contain only hostname, a sanitized path hash,
whether a query exists, and an overall URL hash.

Every terminal transition removes `pendingOutputUrl` and any raw signed URL.
Terminal diagnostic metadata retains only hostname, path hash, URL hash,
redirect hostnames, HTTP status, and retry counts. A successful terminal result
contains only its durable file reference and sanitized source metadata.

## Durable Object Lifecycle

The route first looks up an existing v3 job by the deterministic
`userId + frontendTaskId + businessType + asyncVersion` identity. If it exists,
the route returns it before staging any input. Separate v3 partial unique
indexes enforce the same identity for frontend and batch jobs under concurrent
requests.

If no job exists, the route stages inputs and attempts job creation. When a
concurrent duplicate wins the unique-index race, the losing request immediately
cleans only the input objects it staged, then returns the winning job. A
successful terminal transition (`succeeded`, `failed`, or `status_unknown`)
cleans the job's staged inputs after the terminal state is durable.

Output upload uses the existing file record, TTL, and expired-file sweep. A new
output file receives the existing bounded retention expiry before the worker
attempts the final job transition. If upload succeeds but the final DB
transition loses its lease or otherwise fails, the worker does not expose that
file and does not extend its lifetime. A best-effort immediate delete is allowed
only after confirming no job result references the file; otherwise the existing
TTL sweep removes it. This design does not add a new GC subsystem.

## Usage and Deduplication

- The existing unique frontend-task identity continues deduplicating repeated
  browser job-creation requests.
- Each job has at most one Provider submit transition.
- A persisted task ID is the sole key for all resumed Provider operations.
- New-worker usage recording uses the existing deterministic
  `usageEventId = businessType:requestId:itemId`, producing one logical
  `AIUsageEvent` row per task.
- Success, failure, and status-unknown recovery all update that same logical
  event rather than inserting a second row.

## Fault-Injection Test Design

Tests must prove observable job state and Provider side effects rather than
asserting implementation constants.

### Fal

- Submit succeeds, `request_id` is persisted before polling.
- Restart from a job with `request_id` resumes status and never calls submit.
- First status GET times out and the next succeeds.
- Multiple transient status failures then success remain within the attempt and
  per-turn and persistent-deadline limits.
- Exhausting one status/result/input-read turn persists `nextAttemptAt`, retry
  diagnostics, and `deadlineAt`, releases the lease, and later resumes the same
  Provider task after a simulated process restart.
- First result GET fails transiently and the next succeeds.
- First output download fails transiently and the second succeeds using the
  identical URL.
- Exhausted output download marks the job failed, retains output metadata, and
  never calls submit again.
- Ambiguous submit response marks `status_unknown`; a later worker turn does
  not call submit.
- A historical job and an APIMart GPT Image 2 v2 job cannot be claimed by the
  `image-egress-v1` claim method.
- Runtime mode defaults to `off`; canary mode rejects non-allowlisted users and
  all mode creates v3 jobs without changing the old GPT Image 2 path.
- GPT Image 2 Edit, Grok, and Nano Banana all select the Fal durable adapter.

### APIMart Gemini

- Gemini 3.1 and 2.5 persist the returned Provider task ID.
- Restart resumes polling with that same ID and never calls submit.
- Poll transient failures use the bounded read retry policy.
- Gemini jobs use `asyncVersion: 3`/`workerFamily: image-egress-v1`; existing
  APIMart GPT Image 2 acquisition behavior, signature, and callers are
  unchanged.

### Cross-cutting regressions

- Terminal failure stops the frontend spinner and exposes Retry.
- Queued and polling jobs continue showing processing.
- One successful task produces one logical usage row.
- Deduplicated browser creation and worker restart do not duplicate generation
  or billing.
- Pre-staging dedupe creates no extra input object; a simulated create-race
  loser cleans its staged input; terminal jobs clean staged inputs.
- Output upload followed by a failed DB transition leaves a bounded-TTL file,
  not an unbounded orphan.
- Logs and terminal job metadata never retain a raw signed output URL.
- Two simulated application replicas with concurrency `1` cannot hold more
  than one `image-egress-v1` family slot at once, and the slot is released after
  each short turn.
- Existing APIMart GPT Image 2 async, input externalization, worker permit,
  lease/fencing, and frontend tests remain green.
- Text-to-image regression covers APIMart GPT Image 2, Fal Nano Banana, and
  unchanged synchronous Ark/SiliconFlow routing.

## Verification and Delivery

Before the implementation commit:

- Run focused retry, Fal worker, Gemini worker, route, output-storage, frontend,
  UsageLedger, and APIMart GPT Image 2 suites.
- Run the complete ImageGeneration test set.
- Run ESLint on changed files.
- Run repository typecheck and report existing unrelated baseline failures
  separately from new errors.
- Run client/production build, `git diff --check`, and local production Docker
  build.
- Confirm the final diff changes only ImageGeneration job/schema, Provider
  adapters, focused routes/status serving, storage helpers, and their tests.
- Create local commits only. Do not push, deploy, or switch traffic.
