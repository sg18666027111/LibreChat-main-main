# Application readiness

`GET /readyz` returns `200 OK` only after startup has completed, shutdown has
not begun, and the existing MongoDB connection can successfully ping a primary.
Otherwise it returns `503 NOT_READY`. Responses use `Cache-Control: no-store`
and do not disclose connection strings or database errors.

Each process shares a single read-only ping across callers. The driver timeout
and response deadline are one second. Results are cached for two seconds using
a monotonic clock. Connection transitions invalidate the cache and any pending
result. A timed-out driver operation retains its concurrency slot until it
settles, so repeated probes cannot accumulate unbounded background work.

`/livez` and the compatibility endpoint `/health` report HTTP process liveness;
they do not depend on MongoDB. **Do not configure `/readyz` as a liveness probe.**
Readiness failures should withdraw traffic, not restart a process during a
shared database outage. Shutdown closes readiness through the existing drain
registry, including when startup completes late.

The Helm default readiness probe uses `/readyz`, a three-second timeout, a
ten-second interval and three consecutive failures. The current Zeabur
deployment is managed separately: verify its persisted platform configuration
and the generated Kubernetes readiness probe before claiming production
acceptance. A platform deployment-time check alone does not demonstrate
continuous readiness enforcement. Preserve sufficient startup time and the
existing graceful shutdown budget.

Image worker failures retain their independent O01 alerts rather than taking
login and chat traffic offline. This check does not prove that every provider,
Redis-backed feature in other deployments, or historical image task is healthy.

Validation covers the actual HTTP startup route with an isolated MongoDB,
disconnect/reconnect, shutdown, a real driver's stalled TCP connection,
single-flight requests, cache invalidation and late completions. Never disconnect
the production database to demonstrate the failure branch.
