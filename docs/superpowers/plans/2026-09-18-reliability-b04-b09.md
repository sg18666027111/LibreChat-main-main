# Reliability B04–B09 Implementation Plan

> **For agentic workers:** Use test-driven-development for each task; independent file lifecycle and LLM timeout tasks use dispatching-parallel-agents. Parent owns batch recovery and integration review.

**Goal:** Close audit B04–B09 without weakening provider idempotency or modifying production.

**Architecture:** Preserve existing job indexes. Store an optional per-attempt child item identity on the batch record in the atomic explicit retry transition; initial/legacy jobs keep their existing identity. Preserve only matching, unexpired reference image cache inputs when hydrating durable batch state. File operations report actual outcomes and own their resource cleanup; LLM request timeout spans headers and body.

**Tech Stack:** Node.js, Express, TypeScript, Mongoose, Jest, React Query.

**Spec:** `/private/tmp/production-reliability-audit-2026-09-18.md`, findings B04–B09. User authorized continued fixes on 2026-09-18.

## Global Constraints

- No production changes, provider submissions, paid tests, commits, PRs or deployment in this repair phase.
- Safe test databases must be isolated, ephemeral and localhost-only.
- Existing B01–B03 behavior and legacy records remain compatible.
- Unknown provider acceptance and result-only recovery must never create a replacement provider job.

## Tasks

- [x] B04: Add RED contract tests to `batchAsyncRecovery.spec.js`: failed child → explicit retry → distinct waiting child; repeated/concurrent request → one attempt; crash between enqueue and linkage → recover the current attempt; result-only/unknown state → no replacement. Add optional `internalJobItemId` to `schema/imageBatchTask.ts` and `types/imageBatchTask.ts`; persist it atomically with `failed → pending`, clear old child/provider linkage, and use `internalJobItemId || itemId` for child enqueue, waiter and orphan lookup. Public item IDs remain unchanged. Validate with real isolated Mongo unique indexes and casting.
- [x] B05: Add RED real-hydration tests to `batchAsyncRecovery.spec.js`. In `getBatchTask`, retain cached `referenceImage` only for matching batch/user/tenant/mode, within cache TTL and matching the persisted SHA-256 fingerprint. Durable item statuses remain authoritative. Missing/mismatched cache must still fail safely without submission.
- [x] B06: In `routes/files/multer.js`, make disk filename UUID-based with useful extension, preserving original display metadata and B03 callback handling. Test distinct same-name multipart uploads and independent cleanup.
- [x] B07: In `routes/files/files.js` consume `processDeleteRequest` success/failure IDs. Align delete response type and client cache/selection updates with actual successes. Test partial and total storage failure with real service logic and in-memory external boundaries.
- [x] B08: In download route close/destroy response on asynchronous source failure and destroy source on client disconnect. Test before headers, after headers, cancellation and successful bytes.
- [x] B09: In `LLMAssistant/siliconflow.js` retain timeout and error classification through body consumption. Test delayed headers, stalled/rejecting body, normal completion and timer cleanup with fake provider.
- [x] Integration (local scoped verification complete; full frontend build remains an explicit release gate): Run affected API/client/schema suites, isolated Mongo contract tests, targeted lint/typecheck/format; review all diffs and run independent code review. Record remaining limits and deliver changes without deployment.

## Verification commands

```sh
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test LOG_TO_FILE=false node node_modules/jest/bin/jest.js --config api/jest.config.js --runInBand --runTestsByPath api/server/services/ImageGeneration/batchAsyncRecovery.spec.js api/server/services/ImageGeneration/batchTaskPersistence.spec.js
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test B02_REAL_MONGO=1 B02_MONGOD_BINARY=/Users/adrian/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.1 node node_modules/jest/bin/jest.js --config api/server/services/ImageGeneration/__fixtures__/batchAsyncRecovery.mongo.config.cjs --runInBand
git diff --check
```
