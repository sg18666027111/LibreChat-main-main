# APIMart V2 unknown submission capacity hotfix

## Scope and root cause

Base: `9227a6efaea4a1aeb3260ac2b6ebfec14163cf26`.
Branch: `fix/apimart-v2-status-unknown-capacity`.

The V2 active-provider query counted `status_unknown` with `submittedToProvider=true` even without a provider task ID. Unknown jobs are excluded from worker claims, so this active marker never reconciled or expired and starved all later jobs. The existing provider permit also remained held for a local observation interval after submit timeout.

The prior Production incident was mitigated with a single manual fence of the confirmed blocker. Existing queued jobs then progressed successfully. This patch neither repeats that mutation nor touches the blocker. The unrelated Skill release remains paused; this does not establish a cause for the separate `3579d870...` deployment failure.

## Permanent behavior

- Submitting jobs and submitted/polling/unknown jobs with a provider ID retain existing capacity protection.
- Unknown jobs without an ID no longer count as local active capacity. They remain `status_unknown`, unclaimable and never automatically resubmitted.
- The existing local unknown transition records optional `providerOutcomeUnknown`, `manualReviewRequired`, `neverResubmit`, `localCapacityReleasedAt` and `localCapacityReleaseReason` fields. Timeout/error and submitted provenance remain intact.
- A timeout without an ID releases its owned permit through the existing owner/task-fenced release. A crashed worker's old permit can survive until its existing finite lease expires.
- No provider lifetime is inferred. An untrackable orphan may still execute upstream while a later managed job starts. Known-ID unknown behavior is preserved; no new reconciliation loop is introduced.
- Historical unknown records are not backfilled. No migration, env/config changes, generic V3, Fal, Skill, frontend or legacy-job changes.

## Local verification

All commands run in the isolated hotfix worktree. Tests mock provider transport; Mongo integration uses a fresh local MongoMemoryServer database. No Production access was performed.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run test --workspace=@librechat/backend -- --runInBand server/services/ImageGeneration/apimartImg2JobWorker.capacity.spec.js` before worker edits | 1 | Valid RED: 3 failed / 4 passed; later job remained waiting after real adapter abort, and audit missing |
| `npm run test:ci --workspace=@librechat/data-schemas -- --runInBand --coverage=false --runTestsByPath src/methods/imageGenerationJob.capacity.spec.ts` before schema/query edits | 1 | Valid RED: 4 failed / 5 passed; actual Mongo counted missing/null/empty IDs as active and discarded undeclared audit fields |
| `npm run test:ci --workspace=@librechat/backend -- --runInBand --testPathPatterns='(ImageGeneration/\|imageGeneration.*spec\|imageBatch.*spec)'` | 0 | 33 suites / 444 tests passed |
| `npm run test:ci --workspace=@librechat/data-schemas -- --runInBand --coverage=false --testPathPatterns='(imageGeneration\|imageProviderConcurrency\|imageEgress\|imageBatch)'` | 0 | 5 suites / 46 tests passed |
| `node_modules/.bin/tsc -p packages/data-schemas/tsconfig.build.json --noEmit` | 0 | PASS |
| `npm run build:data-schemas` | 0 | PASS |
| `npm run build:api` | 0 | PASS |
| `node_modules/.bin/eslint` on the 8 changed JS/TS files | 0 | PASS |
| `node_modules/.bin/prettier --check` on the same 8 files | 0 | PASS |
| `node --check api/server/services/ImageGeneration/apimartImg2JobWorker.js` | 0 | PASS |
| `git diff --check` | 0 | PASS |

The first sandboxed Mongo attempt could not bind a local port (EPERM); it is not counted as RED or a baseline defect. The authorized local rerun above established valid RED. No baseline test failures remain.

New regression cases: 17 (8 worker + 9 real Mongo), 0 failures. APIMart V2 coverage: 90 tests (worker, async orchestration, input storage, HTTP route, common submit adapter and GPT Image 2 adapter), 0 failures. All related coverage: 490 tests, 0 failures. Coverage includes A–J: starvation, no-resubmit, known-ID capacity, durable audit, real AbortController submit timeout, next-job progression, late callbacks and late completion isolation, concurrent/repeated ticks, lease fencing and resource/version isolation. Existing A2 async mode-all behavior and managed concurrency-one tests pass.

Independent design/test review and separate code review found 0 critical, 0 important and 0 minor issues. Review specifically examined lease and permit races, duplicate create, atomic audit/state updates, optional schema compatibility, late result ownership and unchanged known-ID semantics.

## Forward compatibility

The hotfix commit `c60a31e` cherry-picked cleanly into a separate detached worktree based exactly on `3579d87005b2da0d8201e1c1bbb8e2fe1f4550f0`; no main ref was changed. On that applied tree:

- `npm run test:ci --workspace=@librechat/backend -- --runInBand --testPathPatterns='(apimartImg2|imageGeneration.apimartAsync|adapters/apimart/(common|gptImage2))'`: exit 0, 7 suites / 90 tests passed.
- `npm run test:ci --workspace=@librechat/data-schemas -- --runInBand --coverage=false --testPathPatterns='(imageGeneration|imageProviderConcurrency)'`: exit 0, 3 suites / 34 tests passed.
- Data-schemas typecheck and build: exit 0.

## Rollout plan — not executed, requires separate operator authorization

1. Keep this PR Draft and Skill paused. Select an immutable release artifact built from this hotfix commit over the stable base; do not deploy unrelated main changes by accident. Record source SHA, artifact digest and target environment.
2. Before authorizing release, read current Production deployment/runtime provenance and health; capture only nonsecret async/concurrency values and existing queue counts/job IDs. Preserve persisted env (including both async modes and concurrency=1), secrets, resources and existing jobs.
3. Under a separately approved deployment gate, deploy the exact hotfix artifact once through the normal release mechanism. Do not change main, restart speculatively, retry provider creates or edit DB records.
4. Confirm terminal deployment success, running/healthy container, exact runtime build commit, APIMART_IMG2_ASYNC_MODE=all and APIMART_IMG2_MAX_CONCURRENCY=1; confirm Image Egress settings remain unchanged. Stop on failed/stuck deployment or env mismatch.
5. Observe only existing jobs: waiting→submitting/polling→succeeded, with managed capacity one for trackable tasks. Confirm at least one queued job succeeds and queue progress persists. No new image test is required.
6. If an unknown-without-ID event naturally occurs, verify its unknown outcome, original error, manual-review/no-resubmit and local-release audit, no second create for its internal ID, and subsequent queued progression. Never manufacture this failure in Production or claim it proves the provider stopped.
7. Monitor active/unknown counts, oldest waiting age, successful completions and duplicate-submission indicators. Escalate known-ID unknowns separately; their existing behavior is unchanged.
8. If runtime provenance, health, queue behavior or duplicate safety fails, halt rollout and request explicit approval for a single restore to the stable artifact `9227a6efaea4a1aeb3260ac2b6ebfec14163cf26`. Do not automate rollback or mutate jobs. The old artifact can reintroduce this queue defect, so retain incident awareness and manual review. Additive fields require no schema rollback.

**Production untouched. DO_NOT_MERGE=true. Skill release remains PAUSED.**
