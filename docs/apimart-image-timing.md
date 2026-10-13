# APIMart image recovery timing

After an accepted task exhausts its local polling budget while the provider is still processing, the durable worker schedules the next recovery query 30 seconds later. The normal worker tick and capacity availability may add delay. Recovery queries the original provider task; it does not upload inputs or submit another generation. Provider terminal failures still finish immediately. The existing final observation horizon and provider concurrency limit are unchanged.

This removes up to 90 seconds of the previous 120-second scheduled recovery delay. It does not shorten upstream generation time, and the upstream completion instant between queries remains unknown.

Timing events are info-level messages starting with `[ImageGeneration] APIMart timing `, followed by a JSON object. The payload is in the message itself so the plain production console formatter retains it. No global debug configuration is required.

| Stage                         | Duration                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference_prepare`           | Entire durable input resolution, including storage configuration and individual reads                                                                 |
| `reference_read`              | One staged file lookup, download, stream consumption and base64 conversion                                                                            |
| `upload`                      | One binary reference upload including response body consumption and URL validation; direct HTTPS inputs do not upload                                 |
| `submit`                      | GPT Image 2 generation submission and its existing provider-accepted callback; excludes uploads and later polling                                     |
| `recovery_wait` / `scheduled` | Planned delay after a nonterminal polling timeout                                                                                                     |
| `recovery_wait` / `resumed`   | Actual wall-clock gap from timeout scheduling to recovery; `scheduledDelayMs` retains the original plan, including jobs scheduled before this release |

Operation durations use a monotonic clock. Persisted recovery timestamps use wall-clock time. `reference_prepare` includes `reference_read` durations; do not add both. Success/failure describes the individual stage, not necessarily final image success. No event is emitted if the process dies mid-stage.

A 24-hex SHA-256 prefix of the internal task ID correlates durable task stages without logging the ID. Optional numeric fields are image count, zero-based image index, decoded bytes and scheduled delay. Only fixed stage/outcome/model values are accepted. Prompts, images, URLs, user identifiers, API credentials and raw errors are excluded. Logging failures cannot change an operation's result or original exception.

After rollout, compare actual versus scheduled recovery gaps, per-reference read/upload durations and submission durations. Keep reference count and total bytes comparable when comparing latency. These logs distinguish preparation from recovery delay; they do not measure the provider's unobserved completion time.
