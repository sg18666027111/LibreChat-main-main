# Durable usage delivery (O03, implementation in progress)

This document describes the target contract; it does not assert a deployed recovery guarantee.
The journal records only whitelisted usage metadata. It must not reside below any public directory.
`durableAccepted` acknowledges private journal commit; `ledgerPersisted` acknowledges Mongo ledger persistence. Neither is provider success or a balance mutation.

## Capture entrypoints

| Entry | Current path | Required boundary |
| --- | --- | --- |
| Image / batch | UsageLedgerService.recordImageUsage | Freeze canonical attempt identity, journal before ledger; persist source envelope with terminal state |
| APIMart / Egress | ImageGeneration job workers | Provider calls independent of ledger retry; false/null capture never marks usageRecorded |
| Agents / compatible OpenAI / Responses | controllers/agents client/openai/responses → packages/api recordCollectedUsage | Await durable capture, not eventual Mongo availability |
| Assistants / vision | Threads/manage.recordUsage, called by assistants and ToolService | Capture one canonical call; linked token transactions skip mirror |
| LLM assistant | routes/llmAssistant.recordLLMAssistantUsage | Same capture contract and paid-call admission |
| Legacy token transactions | data-schemas transaction.mirrorTransactionToUsageLedger | Replay only usage envelope; never spendTokens/updateBalance/createTransaction |

Canonical event ID and revision are preserved during replay. Frozen ISO timestamps live only in the envelope; adapters restore Dates at Mongo boundary. Unknown fields, nonfinite counts, credentials, URLs, unbounded strings and unsupported versions are rejected without logging their content. Existing retired business-type enum values remain accepted for read-only legacy reconciliation; this does not reactivate retired routes.

## Chat admission and cancellation

A paid request freezes its reporting identity, timestamps and available price evidence before a provider call. Agent runs reserve a bounded number of slots from their recursion limit; every model-local start handler must await admission, including children and fallback models. Summaries share the bounded run reservation with separate model/price identities. Titles and background memory have separate reservations. Remote assistant runs retain their existing aggregate usage granularity.

The installed LangChain callback implementation forces awaited error propagation when `raiseError` is true. Tests exercise an actual application `Run` with a forbidden provider transport and model instances with cleared invocation callbacks. Preserve these tests when upgrading the dependency.

Usage capture completes before the existing balance processing. Linked prompt/completion transactions retain the same canonical envelope and suppress the legacy mirror. Abort cleanup can capture without spending again; array-local weak indexes retain identity when abort handling clears the shared array and a later model callback arrives. Capturing or replaying an envelope never invokes a provider or updates a balance.

Missing original admission context is not replaced with a recovery-day price or a new reporting identity. Such evidence requires reconciliation review. This includes old runs resumed without their original in-process context; this stage alone does not promise recovery of every provider operation that finished before its usage was captured. The feature remains off until source reconciliation, crash testing and private-volume verification are complete.

## Source reconciliation and historical reports

The background reconciler starts only in journal mode with a fixed cutover timestamp. Every 30 seconds it scans at most 100 rows from each of ImageGenerationJob (APIMart and Egress), ImageBatchTask, and Transaction. It batches ledger reads and uses an exact envelope/revision condition when acknowledging a source. It never calls providers, calculates new prices or spends balances. Invalid evidence raises a fixed failure metric. Missing-price and expired captured evidence remain private and require review; expired ledger rows are never recreated.

A pending source envelope suspends that document's TTL. Durable capture or matching ledger evidence restores its original cleanup timestamp. Image file retention remains separate; this does not extend file availability. After the original source retention expires, valid terminal sources retain recovery evidence while image/prompt/provider payloads are pruned and the recovery-only record is hidden from business lookups. Private journal quarantine is retained until a deliberate operator resolution.

Historical checks require `--dry-run`, an explicit UTC interval, a page size of 1–100, and a new absolute report path:

```sh
node config/reconcile-usage-delivery.js --dry-run --since=2026-09-01T00:00:00.000Z --until=2026-09-20T00:00:00.000Z --limit=100 --output=/tmp/usage-review.json
```

The CLI requires `MONGO_URI` already supplied by the operator; it does not bootstrap the application, seed data or create indexes. Reports use mode 0600 and contain source IDs, four evidence categories and proved counts, without user content or credentials. Counts describe source rows, not distinct provider calls: linked prompt and completion transactions can refer to one canonical event. `complete=false` and a cursor explicitly indicate truncation; this bounded report must not be presented as an exhaustive historical total. Historical rows are never automatically written back.

## Recovery health

Protected application metrics expose `librechat_usage_delivery_pending`, `pending_bytes`, `oldest_seconds`, `quarantined`, `writable`, `failures_total{reason}` and `recovered_total` with the same prefix. Failure reasons are a fixed allowlist. Off mode emits no usage-journal availability gauge and causes no false journal-down alert. Journal mode starts with unavailable until a successful health sample; initialization failures preserve login/read-only routes and close new paid admission.

The existing alert rules include journal unavailability (critical after one minute), age over five minutes, pending bytes over 192 MiB, quarantined evidence, and repeated capture/reconciliation failures. Run both `image-reliability.test.yml` and `usage-delivery.test.yml` with pinned promtool 3.14.0. No Feishu webhook or secret is changed by these rules.

## Isolated fault validation

`api/server/services/UsageDelivery/recovery.process.spec.js` uses real SQLite, a separate loopback Mongo database per test, and child processes with an environment allowlist and external-network refusal. Fault controls are test fixtures only. IPC barriers identify committed journal/source/ledger state; tests do not infer commit from a sleep.

The process suite covers Mongo disconnection followed by SIGKILL, ledger commit before ack, source commit before append, competing revisions, writer fencing, actual SQLite page exhaustion, read-only storage, persisted deletion tombstones, canonical job/batch/transaction observations, frozen pricing, mixed corrupt/expired/good evidence, bounded shutdown, and SIGKILL inside an uncommitted SQLite transaction. Provider/balance fixture counters stay at one original operation in source-replay cases; all recovery paths make zero real provider calls. Adapter suites separately prove actual business entrypoint behavior with forbidden/fake provider transports.

On local Node 24.16.0 / SQLite 3.53.0 / isolated Mongo 8.2.1, all 14 process cases passed. A small 40-event fixture accepted and recovered all events; capture took approximately 85 ms and the SQLite file occupied 73,728 bytes. This is a functional smoke measurement on a local disk, not a production throughput or PVC durability claim. Production-volume canary and notification delivery remain release gates.


## Ownership recovery and deletion guards

Journal schema v2 records reservation scope and writer fence. Local request reservations (chat, titles, synchronous images) cannot resume through a replacement writer and are reclaimed at ownership transfer. Already captured envelopes are retained. Async image/batch source reservations survive handoff: a bounded scan first reconciles usage, then consults indexed durable source ownership before releasing absent or durably terminal owners. A source read failure or a still-running/uncertain source retains the reservation; elapsed time alone never proves safety.

For an expired quarantined event, account deletion creates only a minimal anonymous identity guard in the unique ledger event-ID namespace. It has no billable quantities, occurrence window or expiry; reports explicitly exclude it. This prevents a delayed old writer's first upsert from reattaching a deleted identity without recreating an expired billable event. Private original evidence remains quarantined for deliberate review. Guard cleanup is not automatic because removal would discard the delayed-writer deduplication protection.

Assistant vision now captures at the paid completion promise. Zero, one or multiple tool reads all refer to one event and one existing accounting operation. The vision request model is explicit and matches its admitted identity. Legacy assistant title generation also uses bounded admission and capture; it preserves its existing model and does not introduce a new balance charge.
