# GPT Image 2.5 Flare on fal

The image generation page offers additional Flare choices without replacing existing defaults or APIMart model IDs:

| Mode | Model key | fal endpoint |
| --- | --- | --- |
| Text and batch text | `fal_gpt_image_2_5_flare_text` | `openai/gpt-image-2.5/flare/text-to-image` |
| Edit, multi-reference and batch edit | `fal_gpt_image_2_5_flare_edit` | `openai/gpt-image-2.5/flare/edit` |

Every request and batch item generates one PNG with explicit `quality: medium`. The existing output-quality selector controls dimensions. Batch generation requests 1024-square images and retains the existing normalized 800-square delivery. The existing UI reference-image limits are unchanged.

Single generation requires the existing image-egress async rollout to admit the user and uses its durable input/output storage, ownership checks and usage capture. Existing `FAL_KEY` configuration is reused. No database migration or new credential is required.

Batch generation retains its existing item leases and accounting owner. Queue request IDs and provider-returned status/result URLs are persisted inside the sensitive `providerResult` field before polling. They are not exposed by the batch client serializer. Large edit inputs use the existing fal upload preparation. Each preparation/submission and polling wait is bounded by `FAL_IMAGE_TIMEOUT_MS`; polling uses `FAL_IMAGE_POLL_INTERVAL_MS`.

- Transient polling errors and local timeouts leave the paid task recoverable on a later status read.
- Definitive result-read errors become visible failures. Explicit retry reads the same paid task.
- Download/normalization errors retain the generated result for processing-only retry.
- Definitive provider rejection/failure permits an explicit new attempt. Unknown submission outcomes never authorize another generation.
- After a process restart, an already submitted edit can resume without its original in-memory reference. A genuinely new edit submission still requires the reference image.

API tests use simulated provider responses. Production rollout, paid generation and live provider costs require separate validation. Do not interpret fal's dollar-per-unit pricing as a fixed per-image cost.

Provider documentation: [text-to-image](https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/api), [edit](https://fal.ai/models/openai/gpt-image-2.5/flare/edit/api).

## Local verification — 2026-09-28

Implementation checkout: `LibreChat-fal-flare`, branch `feat/fal-flare-generation`, based on production baseline `7b5fa3318a84e0e18baeb3b7f71af262e0f05626` (PR #48). Existing checkouts were left intact.

Validation used Node 24.16.0 and simulated provider responses; no paid generation, production changes or deployment took place.

- Client complete Jest suite: 200 suites / 2,611 tests passed.
- API complete Jest suite: 225 suites passed, 2 skipped; 3,792 tests passed, 29 skipped. Two existing `UsageDelivery/recovery.process.spec.js` cases timed out waiting for their fixture's `start` response: `source commit before journal append survives SIGKILL without another provider or balance write` and `expired writer resumes but cannot ack after replacement owns the journal`.
- Isolated rerun of that unchanged recovery suite: all 16 tests passed, including both timed-out cases. The parallel run is recorded as having failed; it is not represented as a clean full-suite run.
- Flare coverage includes endpoint selection, count/size constraints, reference upload preparation, durable single-job output and usage ordering, both initial batch modes, restart recovery, ambiguous submissions, explicit retries, permanent read failures, and result processing retries. The expanded batch recovery suite passed all 42 tests.
- Client Vite production build, ESLint on changed/new JS/TS files and `git diff --check` passed.
- Independent read-only code review completed; the timeout, lease-conflict and permanent-result-error findings were fixed and reviewed again with no outstanding findings.

The remaining release check is an authorized live provider smoke test and deployment. Provider latency, output quality and actual per-image charges have not been measured.
