# APIMart task failure diagnostics

APIMart task failures may arrive in an HTTP 200 envelope with a nested error object. An outer `code: 200` or `message: success` does not describe the task outcome. Both normal polling and one-shot recovery use the same failure parser after detecting a terminal provider status.

The parser reads scalar `code` and `message` values from explicit errors at `error`, `data.error`, or `result.error` before falling back to their envelopes. String-valued errors remain supported. It ignores malformed object/array messages, success envelope codes, and success-only messages. Missing diagnostics become `APIMART_TASK_FAILED` / `APIMart task failed`; arbitrary response objects are never serialized into the diagnostic fields.

Selected messages are limited to 240 characters. URL, image base64, configured API key, recognized credential values, email, and labelled prompt/image-input fragments are redacted; control characters are normalized. This is bounded redaction of provider message text, not a guarantee that arbitrary unlabeled personal text can be identified. The parser does not inspect or copy unrelated response fields.

The existing worker persists the selected message to `error` and code to `errorCode` / `providerErrorCode`. Provider status remains authoritative for terminal failure: parsing diagnostics does not turn failures into retries, change recovery delays or concurrency, or submit another task. A code mentioning timeout on a terminal failure remains a terminal failure.

After rollout, inspect new failed tasks by provider status, error code and sanitized message. Historical records already stored as `[object Object]` cannot be reconstructed from those records. This change improves diagnosis; it does not establish why historical provider jobs failed or guarantee a lower failure rate.
