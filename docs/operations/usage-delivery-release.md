# O03 release preparation — not deployed

Application candidate: `e6eac79ff320662606336053074c1fbfb98241ac`.
Tasks 1–8, the single independent code review, and its regression-backed fix pass are complete. Task 9 is pending the private-volume quote and platform configuration check. No CI build, volume provisioning, production environment change or deployment has been performed for O03.

## Verified platform facts

The existing service has one replica, Recreate strategy, a 30-second termination grace period, and runs as UID 0. Its only current persistent application mount is the public image directory. The available storage class is `local-path` on ext4, ReadWriteOnce. The node had approximately 45 GiB free during the read-only preflight. Requested local-path capacity is not treated as a proven hard quota.

The proposed independent volume is `usage-delivery`, mounted at `/app/var/usage-delivery`, target capacity 1 GiB. Journal directory/file permissions are 0700/0600; pending payload limit is 256 MiB, individual events 32 KiB, and SQLite physical limit 512 MiB. Neither the public image volume nor a network filesystem is approved as a substitute.

**Not yet verified:** the platform-selectable capacity, actual incremental monthly cost, and persistence of this mount through the Zeabur service configuration. Browser automation timed out twice; the installed CLI help does not expose a volume quote command. General public server pricing is not an account-specific quote. Do not create the resource until these fields are confirmed in the release plan and the specific resource is approved.

## Remaining execution gates

1. Confirm the exact private-volume resource and price in the platform, preserving the existing public image mount. Update the release plan; obtain the specific resource approval required by the approved implementation plan.
2. Build and pin the tested application candidate, retaining the existing incremental GitHub Actions $5 notification limit. Do not provide real provider credentials to tests. The backend Jest setup overrides Mongo/model secrets with local fixture values; the O03 phase additionally clears inherited environment variables.
3. Run an isolated Linux canary with independent Mongo and private PVC. Prove fsync/locking, kill/recreate recovery on the same PVC, duplicate delivery, space recovery and writer fencing. Use no production database/provider credentials. Send a clearly marked Feishu drill through the existing notification chain and verify firing/resolved receipts.
4. Review the immutable image digest, volume, platform-persistent environment settings, fixed `USAGE_DELIVERY_CUTOVER_AT`, interruption window, health checks and rollback image before switching production. The cutover value is already frozen in the external deployment plan and must not be regenerated on restart.
5. After deployment, use read-only health/auth/config/mount/metrics checks and naturally occurring new usage. Historical investigation is dry-run only. No provider resubmission or fabricated production accounting events.

## Rollback and closeout

Rollback preserves the PVC, journal and pending/quarantined evidence. The O02 image does not deliver the new journal, so automatic recovery pauses under rollback and must not be represented as continuing. The approved guarantee covers captured durable events; it does not cover provider charges before capturable usage or whole-node disk loss.

Close O03 only after canary, pinned production rollout, alert delivery, cleanup, read-only acceptance and natural new-business evidence are recorded. Until then, the finding remains open despite local implementation completion.
