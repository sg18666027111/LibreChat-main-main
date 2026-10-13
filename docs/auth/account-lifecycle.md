# Account lifecycle restoration

Baseline: `9dd42c7` (remote `main` verified through the GitHub connector on 2026-09-19). Work is limited to registration,
registration verification, approval/login gates, logout, password recovery and mail.
Git transport and the deployed public `/api/config` endpoint were unreachable during
initial investigation. No deployment or real outbound mail was performed.

## Initial findings

```text
CURRENT_REGISTRATION_IMPLEMENTATION=/register and POST /api/auth/register already exist; users become pending
REGISTRATION_BUTTON_MISSING_REASON=Login renders the existing link only when registrationEnabled=true; ALLOW_REGISTRATION/LDAP control it; production flag unset; old public config returned registrationEnabled=false
CAPTCHA_CURRENT_IMPLEMENTATION=JJC invitation-code service retains expiry/use limits; cd495eb removed its registration input, validation and consumption; optional Turnstile was frontend-only
BACKEND_CAPTCHA_ENFORCED=false
APPROVAL_CURRENT_IMPLEMENTATION=Admin approval retained; pending users blocked from business endpoints but not from obtaining login tokens
CAN_PENDING_USER_LOGIN=true
CURRENT_LOGOUT_IMPLEMENTATION=Existing menu calls real logout API; zh-Hans translated logout as 注销; refresh sessions removed but access JWTs remained valid
PASSWORD_RESET_EXISTING_IMPLEMENTATION=Existing routes, mail templates, random tokens, bcrypt hashes and 15-minute TTL; no explicit expiry/atomic consumption; unconfigured mail returned a usable reset link
EMAIL_INFRASTRUCTURE=Nodemailer SMTP and Mailgun supported; production SMTP/Mailgun/sender configuration absent; actual delivery not verified
```

The historical typed registration code is an administrator-issued invitation code,
not an emailed OTP. The UI labels it “注册验证码（邀请码）”. No new authentication
system or email registration-code system was introduced.

## Behavior after this change

- Public registration always validates the supplied invitation code in the service,
  including first-user and invitation-link requests. A valid, unexpired code use is
  claimed atomically before inserting a user with `approvalStatus: pending`.
  Failed registration refunds the use only after rollback confirms no account
  remains, while preserving any administrator disable action.
  Existing admin approval routes remain; pending/rejected users cannot log in or
  refresh. User-supplied privilege fields cannot grant approval/admin rights.
- The existing trusted `npm run create-user` CLI retains its direct provisioning
  behavior through an explicit server-only option. HTTP registration never reads
  this option from the request body; a regression test verifies it cannot bypass
  public code validation. CLI-created users still retain the existing pending state.
- If the existing Turnstile widget is configured, the frontend sends its challenge
  and the server must obtain a positive Siteverify result. Missing/invalid/expired/
  repeated challenges, missing secret and network failure all reject registration.
  The widget resets after a failed submission. The secret is never sent to clients.
- “退出登录” uses the existing logout API, separately from account deletion. A
  valid refresh credential can also authorize logout when its access JWT expired. New
  access JWTs carry the existing server session id, checked on authenticated
  requests; logout deletes that session. Legacy JWTs are revoked using a hashed
  payload fingerprint in the existing expiring Token store. Other sessions and
  user records remain unchanged. Failed server logout remains visible/retryable;
  an already-invalid identity (HTTP 401, including deleted accounts) returns to login.
  Logout uses a trusted login destination separately from the post-login redirect
  validator, which intentionally rejects `/login`.
- Password recovery is administrator-assisted and does not send email. The login page
  directs users to their company administrator. The public request endpoint always
  returns the same contact-administrator message without looking up an email,
  generating a token, sending mail, or revealing whether an account exists.
- An authenticated administrator with ACCESS_ADMIN and MANAGE_USERS can generate
  a reset link from account management after verifying the employee offline. The
  service rechecks the actor's current role/status, tenant boundary and target
  privilege level. Only super administrators can reset other administrator accounts;
  self-reset, SSO accounts and deleting accounts are excluded.
- Reset links use 32 random bytes, stored only as bcrypt hashes with purpose
  `password_reset` and a 15-minute expiry. The existing reset page and atomic token
  consumption are reused. Generating a new link invalidates old links. Links are
  returned only to the authorized administrator with `Cache-Control: no-store`,
  shown in an ephemeral dialog, and never written to localStorage or audit logs.
  The administrator privately forwards the link using an existing company channel.
- Issuance and consumption reuse the existing per-account database mutation lock.
  Each user has one reset-record key in the Token collection, replaced atomically.
  Tokens are bound to the target session version, role, super-admin flag and tenant;
  the password update checks those fields atomically, so promotion or session
  revocation invalidates an older link. Cleanup cannot remove a link issued for
  a new security identity even if the lock lease expires.
- Issuance persists an audit entry with actor, target and expiry. If audit persistence
  fails, the newly issued token is removed and no link is returned. Password and
  session version change atomically; refresh sessions and remaining reset tokens
  are removed. No password-reset or confirmation emails are sent, even if mail
  infrastructure is configured. Existing account approval status and MFA remain.
- Registration/reset availability is computed by the same helper for UI config and
  API gates. Both default to enabled when unset; explicit false is respected.
  Mail configuration is no longer a prerequisite for administrator-assisted recovery.

## Deployment requirements

Use the existing deployment environment (do not put secrets in this document):

```dotenv
ALLOW_REGISTRATION=true
ALLOW_PASSWORD_RESET=true
DOMAIN_CLIENT=https://your-existing-site.example
```

No SMTP, Mailgun account, sending domain or mail credentials are needed. Keep
`DOMAIN_CLIENT` set to the actual trusted site URL; production links must use HTTPS.
Do not derive reset URLs from request headers. Administrator-generated links expire
quickly and must be shared only with the employee whose identity was checked.

Only if `turnstile.siteKey` is enabled in the existing YAML configuration, set
`TURNSTILE_SECRET_KEY` to the matching secret. The verification protocol follows
[Cloudflare's server-side validation documentation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

Build/deploy shared data-provider and data-schemas artifacts with the backend and
frontend so the new token/session fields and methods are present. No database
migration is required; existing token/session schemas are reused. Pre-change
password-reset links without a bound security identity are intentionally rejected:
ask an administrator for a new link after release. Account-approval and deletion workflows remain separate.

If the deployed registration flag is explicitly false, a code deployment alone
will not reveal the link: update that deployment flag as part of release.

## Verification

The revised tests cover public guidance without email lookup or mail delivery;
unauthenticated and insufficient-capability requests; stale administrator roles;
privileged and cross-tenant targets; SSO/deleting restrictions; audit persistence
failure; hash-only storage; expiry and wrong-purpose tokens; replacement and
concurrent consumption; old/new password login; session invalidation; and retention
of pending, rejected and suspended statuses. Frontend tests cover the administrator
entry, identity confirmation, copy/fallback, dialog cleanup and self-service form.
Existing registration, invitation code, approval, logout and account-deletion tests
are retained. The Mongo lifecycle suite uses an isolated temporary database.

The earlier email-delivery candidate at `77ecd62` had 22 focused suites / 402 passing
tests and passed standalone packaging verification. That candidate is superseded
by this administrator-assisted recovery change; its image/test evidence must not
be represented as verification of the revised source. Neither version has been
merged or deployed by this task. New verification results are recorded in the PR
and release-readiness record when the revised checks finish.

The revised source passes 26 focused suites / 462 tests: backend auth/user/mail
(281), shared user/token methods (109), frontend auth/admin dialogs (41), and shared
mail/config checks (31). This includes expired-lock interleavings, prevention of
stale issuance replacing a newer-version link, and preservation of a new link
during old-token cleanup. Changed-file ESLint, formatting and diff checks pass.
Shared schema/API and frontend production builds completed. The local shared API
build reports an existing Redis type incompatibility in the linked dependency tree;
no cache code was changed. Full frontend typecheck comparison with the main
baseline remains 177 diagnostics on each side, with zero new diagnostics.
These checks are not a production deployment or a claim that all repository CI passes.
