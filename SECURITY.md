# Security

This document is the working threat model for Owlat. It exists so a
new contributor (or auditor) can answer two questions quickly:

  1. **Where are the trust boundaries** and what does each side assume
     about its inputs?
  2. **Where are the choke points** that enforce those assumptions —
     and how do I prove a new piece of code respects them?

If you change one of those choke points, please update this doc in the
same PR.

---

## Trust boundaries

```
┌────────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│  Browser (SPA)     │ ←→ │  Nuxt Worker (apps/  │ ←→ │  Convex backend  │
│  (apps/web)        │    │  web SSR / API)      │    │  (apps/api)      │
└────────────────────┘    └──────────────────────┘    └──────────────────┘
                                                              ↑↓
                                       ┌──────────────────────┴───────────────────┐
                                       │  MTA  ·  IMAP  ·  External webhooks      │
                                       │  (apps/mta, apps/imap, Resend/Twilio/    │
                                       │   Meta/Stripe — over public HTTPS)       │
                                       └──────────────────────────────────────────┘
```

| Boundary                       | What's trusted on the inside                                | What must be verified at the boundary                                                                                          |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Browser → Nuxt API             | The session cookie (BetterAuth, SameSite=Lax, HttpOnly).    | Nothing on the request body — treat all input as untrusted. Open-redirect-safe handling of `redirect` / `redirectTo`.          |
| Nuxt API → Convex              | Convex JWT identity (`ctx.auth.getUserIdentity`).           | All `query` / `mutation` calls must derive userId & role from the session (`getMutationContext`, `getUserIdFromSession`).      |
| Convex action → MTA            | `MTA_API_KEY` shared secret (Bearer header).                | MTA validates the bearer; outbound `/scan/attachment` results are fail-open on outage but fail-closed on positive verdict.     |
| MTA / IMAP / external → Convex | Per-channel HMAC or shared secret in a webhook header.      | Constant-time compared against the stored secret. **Fail-closed (503) if the secret env var is unset.**                       |
| Email recipient ← MTA          | Outbound mail body has been sanitized + scanned.            | RFC 5322 headers built via `escapeHeader` (CRLF-stripped); attachments scanned via ClamAV; signature/forwarded HTML sanitized. |
| Convex action → external HTTP  | Domain is hard-coded or shape-validated (e.g. Mailchimp DC).| Never paste user input into a URL host without an allowlist regex.                                                             |
| Bundled plugin → host services | Statically composed manifest id and host-owned service implementations. | Derive tenant/actor server-side; recheck flag + declaration + exact grant; bound inputs; never expose Convex context or provider credentials. |

---

## Choke points

These are the load-bearing files. **If you change one, the security
posture changes** — keep them in sync with their callers and update
their tests.

| Concern                         | File                                                              | Function / export                                                                 |
| ------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Session + role lookup           | `apps/api/convex/lib/sessionOrganization.ts`                      | `getMutationContext`, `getUserIdFromSession`, `getBetterAuthSessionWithRole`      |
| Permission map                  | `apps/api/convex/lib/sessionOrganization.ts`                      | `PERMISSION_MAP`, `hasPermission`, `requireAdminContext`                          |
| Open-redirect filter            | `apps/web/app/utils/safeRedirect.ts`                              | `safeRedirect(value, fallback)`                                                   |
| Raw-HTML sanitizer (emails)     | `packages/email-renderer/src/sanitize.ts`                         | `sanitizeRawHtml`, `sanitizeUrl`, `sanitizeCss`                                   |
| Postbox/signature sanitizer     | `packages/shared/src/postboxSanitize.ts`                          | `POSTBOX_SANITIZE_CONFIG`                                                         |
| Webhook signature verification  | `apps/api/convex/webhooks/adapters/` (resend, twilio, meta, mta, generic), `apps/api/convex/mail/authHttp.ts` | `verifySvixSignature`, `verifyTwilioSignature`, `verifyMetaSignature`, `constantTimeEqual` |
| RFC 5322 header construction    | `apps/api/convex/mail/outbound.ts`                                | `escapeHeader`, `encodeHeaderValue`, `safeAttachmentFilename`                     |
| Outbound attachment scan        | `apps/api/convex/mail/outbound.ts`, `emailWorker.ts`              | `scanAttachment`, the `/scan/attachment` MTA call                                 |
| Agent prompt-injection filter   | `apps/api/convex/agent/steps/security_scan/index.ts`              | `detectInjection`, `detectSmuggling`                                              |
| Agent classification allowlist  | `apps/api/convex/agent/steps/draft/index.ts`                      | `safeEnum`, `ALLOWED_*`                                                           |
| File-upload validation          | `packages/email-scanner/src/files/`                               | `validateFile`, `isExtensionAllowed`, `isMimeTypeAllowed`                         |
| CSP / HSTS / cookie headers     | `apps/web/nuxt.config.ts`                                         | `security.headers`, `security.csrf`                                               |
| Plugin authority + scope        | `apps/api/convex/plugins/authorization.ts`                        | `requireAuthenticatedBundledPlugin`                                               |
| Plugin LLM spend boundary       | `apps/api/convex/plugins/llm.ts`, `llmAccounting.ts`              | bounded request, exact model + endpoint admission, atomic reservation and conservative settlement  |
| Plugin audit metadata           | `apps/api/convex/plugins/audit.ts`                                | `recordHostedPluginAudit` allowlist; no content, keys, cursors, secrets, or errors |

---

## Required environment variables (fail-closed)

The following secrets gate security-critical paths. If any are missing,
the corresponding endpoint **must** return 503 — never fall back to
accepting unsigned/unverified traffic.

| Env var                   | Used by                                                      | Failure mode if unset       |
| ------------------------- | ------------------------------------------------------------ | --------------------------- |
| `BETTER_AUTH_SECRET`      | `apps/api/convex/auth.ts`                                    | Session signing fails.      |
| `INSTANCE_SECRET`         | Mailbox auth, unsubscribe tokens.                            | Various.                    |
| `MTA_API_KEY`             | Outbound mail dispatch, attachment scan.                     | No outbound mail.           |
| `MTA_WEBHOOK_SECRET`      | `mtaWebhook.handleMtaWebhook`                                | 503.                        |
| `RESEND_WEBHOOK_SECRET`   | `resendWebhook.handleResendWebhook`                          | 503.                        |
| `TWILIO_AUTH_TOKEN`       | `webhooks/adapters/twilio.ts` (SMS webhook verification)     | 503.                        |
| `META_APP_SECRET`         | `channelWebhooks.handleWhatsAppWebhook` POST                 | 503.                        |
| `META_VERIFY_TOKEN`       | `channelWebhooks.handleWhatsAppWebhook` GET                  | 503.                        |
| `GENERIC_WEBHOOK_SECRET`  | `channelWebhooks.handleGenericWebhook`                       | 503.                        |
| `UNSUBSCRIBE_SECRET`      | Unsubscribe-link HMAC.                                       | Link generation/verify fails.|
| `GOOGLE_SAFE_BROWSING_API_KEY` (optional) | URL-reputation scanner.                          | Reputation skipped.         |

---

## Rate limiting

Self-hosted deployments have no managed WAF in front of them — rate
limiting lives in the backend itself (`lib/publicTokenEndpoint.ts`
buckets keyed per recipient/token, client IPs derived via
`RATE_LIMIT_TRUSTED_PROXY`-aware `getClientIp`). If you front the stack
with your own proxy/WAF, additional edge rules for these endpoints are
worth having, but the in-backend limits are the baseline guarantee:

- `/api/auth/*` (BetterAuth sign-in / register / forgot-password)
- `/api/setup/*` (one-time install endpoints; should also be 403'd
  when `OWLAT_SETUP_MODE` is false)
- Public form-submission endpoints (`POST /forms/*`)
- Public unsubscribe endpoints

Convex-side rate limits *are* in place for:

- Mail authentication (`apps/api/convex/mail/authRateLimit.ts`)
- IMAP per-(IP, address) (`apps/imap/src/rateLimit.ts`)
- Webhook ingestion (`publicRateLimit.checkPublicRateLimit`)
- Form submissions

If you add a new public Convex `httpAction`, run it through
`publicRateLimit.checkPublicRateLimit` near the top of the handler.

---

## When you add a new Convex function

For every new function in `apps/api/convex/`:

1. **Use the authed wrappers — bare builders are lint-banned.** Public
   functions are built from `authedQuery` / `authedMutation` /
   `authedAction` (see `lib/authedFunctions.ts`); genuinely public
   endpoints opt out with a `public*` name. `check-public-functions.sh`
   enforces this, `check-permissions.sh` requires every mutation/action
   to make an explicit role decision, and `check-query-authz.sh`
   ratchets the same rule onto queries (gate, or a
   `// authz:` / `// all-members:` comment).
2. **Never trust caller-supplied IDs**. `args: { userId: v.string() }`
   is suspicious — derive userId from the session instead.
3. **Multi-tenant scoping**. If your data is org-scoped, filter the
   query by the session's `activeOrganizationId` (single-org-per-deployment
   is enforced by `assertSingletonOrgInvariant` for current Owlat).
4. **Role check** if the action is admin-level. Use
   `requireAdminContext` or `requirePermission(hasPermission(...))`.

The `.semgrep.yml` rule `convex-userid-without-session-check` will
catch the most common variants of (1) and (2) at PR time.

---

## When you add a new webhook receiver

1. Pick a stored secret (`*_WEBHOOK_SECRET` or `*_AUTH_TOKEN`).
2. Document it in `.env.selfhost.example` and in the table above.
3. Read the raw request body **before** parsing JSON (HMAC is over
   the raw bytes).
4. Compute the expected signature and compare with
   `constantTimeEqual` from one of the existing modules.
5. If the secret env var is unset, return 503 — never fall through.
6. Add three tests: correct sig (200), missing sig (401), wrong sig
   (401).

`apps/api/convex/__tests__/channelWebhooks.integration.test.ts` is the
canonical example.

---

## When you accept a file upload or attachment

1. Validate extension + MIME via `@owlat/email-scanner/files`
   (`validateFile`, magic-bytes check).
2. Scan via MTA's `/scan/attachment` endpoint. Fail-open on scanner
   outage; fail-closed on positive verdict.
3. Sanitize filenames before they hit the filesystem or appear in
   `Content-Disposition` headers (`safeAttachmentFilename`).

`apps/api/convex/emailWorker.ts:280–334` and `apps/api/convex/mail/outbound.ts`
are the canonical wirings.

---

## When you render user-supplied HTML

There are three boundaries with three different sanitizers — pick the
right one:

| Use case                                  | Sanitizer                                                | Notes                                                                          |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Email body (`rawHtml` block, exported)   | `sanitizeRawHtml` in `packages/email-renderer/src/sanitize.ts` | Tight email-safe allowlist, `data:`/`javascript:`/`vbscript:` stripped.       |
| Postbox received email (iframe-sandboxed) | `POSTBOX_SANITIZE_CONFIG` in `packages/shared/src/postboxSanitize.ts` | Defense-in-depth — the iframe sandbox is the primary defense.                  |
| Postbox signature (no sandbox)            | `POSTBOX_SANITIZE_CONFIG` + the 64 KB cap in `mail/signatures.ts` | Allowlist is the only defense; data: stripped from background-image.          |

Never write a new regex-based HTML stripper. The C4 fix replaced one
because it was bypassable in multiple ways.

---

## When you render an LLM agent response

The agent pipeline has multiple gates; preserve them when you add a
new step:

1. **Inbound scan** (`agentSecurity.runSecurityScan`) — pattern-match
   + HTML smuggling + zero-width-char detection on the inbound email.
   Quarantine at confidence ≥ 0.7.
2. **Re-scan retrieved context** before passing to the drafter
   (`agentDrafter` calls `detectInjection(args.context)`).
3. **Enum-validate classifier output** before it lands in any
   downstream system prompt (`safeEnum` + `ALLOWED_*`).
4. **Delimit untrusted content** with explicit tags
   (`<untrusted_email_content>…</untrusted_email_content>`) and tell
   the model to refuse role-changes / instruction-overrides inside.
5. **Human-in-the-loop by default**. Drafts land in a verification
   queue. The only exception is the `ai.autonomy` feature flag
   (default OFF): when an operator enables it, replies matching the
   org's explicit `autonomyRules` can send without review, gated by
   `assertFeatureEnabled(ctx, 'ai.autonomy')` plus the fail-closed
   guard + outbound injection scan in the route step.

Treat widening (5) with extreme suspicion: every preceding gate must
hold for autonomous sending to be safe, and they are defense-in-depth,
not proofs.

---

## Supported versions

Owlat is pre-1.0 and ships as a rolling release: security fixes land on the
latest released version, and self-hosters update in place (`owlat upgrade`).
Only the most recent release is supported — please update before reporting,
in case the issue is already fixed.

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Older releases | ❌ (update first) |

## Reporting

Please email `security@owlat.app` for sensitive reports (or DM the
maintainers on the project chat). For non-sensitive findings, open
an issue with the `security` label.

Please **do not** open a public issue for an unfixed vulnerability — report it
privately first so a fix can ship before details are disclosed.
