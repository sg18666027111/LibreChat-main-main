# APIMart V2 unknown-outcome capacity fix

> Execute with independent implementation and review agents. Production access is forbidden.

**Goal:** Prevent an APIMart V2 unknown submission without a task ID from starving later jobs without resubmitting the unknown request.

**Architecture:** Preserve the existing unknown outcome and claim exclusion. Separate that outcome from local capacity: only a submitting job or an accepted task with an ID owns active capacity. At the existing unknown transition, record additive audit fields and release the owned permit. Known-ID jobs retain existing behavior.

**Tech stack:** CommonJS worker, TypeScript Mongoose methods/schema, Jest, local MongoDB memory server.

**Base:** `9227a6efaea4a1aeb3260ac2b6ebfec14163cf26`.
**Branch:** `fix/apimart-v2-status-unknown-capacity`.

## Execution

- [x] Create isolated worktree at exact base; inspect submit, lease, active count, unknown transition and claim paths.
- [x] Add worker regression tests before implementation: existing missing-ID unknown, no resubmit, known-ID unknown/submitted/polling capacity, timeout audit, later waiting progression, real adapter timeout injection, late response isolation, concurrent/repeated ticks.
- [x] Add local Mongo integration tests for the actual active query and additive audit persistence. Run RED against unchanged production files and retain output outside git.
- [x] Worker implementation: exclude missing-ID unknown from in-memory active count; keep unknown+ID; annotate unknown without ID with `providerOutcomeUnknown`, `manualReviewRequired`, `neverResubmit`, `localCapacityReleasedAt`, `localCapacityReleaseReason`; release its own permit at the local transition. Preserve original errors and job identity.
- [x] Persistence implementation: remove only the unconditional unknown clause from the V2 active query; add optional audit fields to schema/types. No migration, new TTL or provider-contract assumptions.
- [x] Run new tests GREEN, all APIMart tests, all ImageGeneration/route/job/permit/orchestration related tests. Reproduce any failure on exact base before calling it baseline.
- [x] Read actual scripts; run data-schemas typecheck/build, API build, changed-file ESLint/Prettier, JS syntax checks. Record command/exit evidence.
- [x] Independent test and code review: duplicate submit, lease/permit races, audit atomicity, late result isolation, unchanged A2 async behavior. Resolve all critical/important findings and rerun affected checks.
- [x] Verify scope excludes Skill, generic V3 behavior, Fal, frontend, infrastructure and legacy migrations; commit only fix/tests/docs.
- [x] Apply commit in separate detached worktree at `3579d87005b2da0d8201e1c1bbb8e2fe1f4550f0`; run targeted tests/typecheck without moving main.
- Publication handoff: push the verified hotfix branch and create a Draft PR (never merge); link the verification and separately authorized rollout plan. Keep Production untouched and Skill paused.

## Policy and tradeoff

Local capacity release does not prove the provider stopped or rejected the request. An untrackable orphan may still run upstream while the next managed job starts. Preserve unknown/manual-review/no-resubmit semantics; never fabricate failure or requeue the orphan. Existing pre-fix unknown jobs are excluded from the active count without modifying their audit history; any old permit remains bounded by its existing lease expiry. Known-ID unknown handling is unchanged.
