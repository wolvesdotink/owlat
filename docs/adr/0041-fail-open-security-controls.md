# Fail-open security controls — risk acceptance and observability

**Status:** accepted

## Context

A security review asked whether two controls that **fail open** by design should
instead fail closed:

1. **ClamAV attachment scanning** (`apps/mta/src/routes/scan.ts`). If `clamd` is
   unreachable, the scan is *skipped* and the attachment is treated as clean
   (`{ clean: true, skipped: true }`).
2. **Rate limiters** — the IMAP LOGIN auth limiter (`apps/imap/src/rateLimit.ts`)
   and the webhook-ingestion limiter. If Redis is unreachable, the limiter
   *skips* (allows the request) rather than blocking.

Both are deliberate: a misconfigured/down ClamAV or Redis must not take mail
delivery or everyone's login offline. The question is whether that availability
bias is the right call for a security control, and whether the failure is
observable.

## Decision

**Keep both fail-open**, and treat the existing warn-logs as the required
observability hook rather than adding new behavior.

- ClamAV skip already emits `logger.warn(..., 'ClamAV scan skipped — failing
  open')` with the filename and error.
- The IMAP limiter already emits `logger.warn(..., 'auth rate-limit check failed
  — failing open')` (and the same on the record path) when Redis throws.

**Operational requirement:** alert when the rate of these skip-logs is non-trivial
— a sustained "scan skipped" or "rate-limit failing open" stream means a security
control is silently disabled and needs operator attention. This is the
compensating control for the fail-open bias.

We explicitly **do not** make campaign attachments fail-closed at this time: the
blast radius (blocking legitimate campaign/transactional sends whenever ClamAV is
briefly unavailable) outweighs the benefit pre-launch. Revisit if abuse is
observed, at which point a *campaign-only* fail-closed path (transactional stays
fail-open) is the natural split.

## Environment-hygiene invariants (operational)

The review also confirmed several guards are correct in code but depend on
production configuration. Recorded here so they are not silently regressed:

- **`OWLAT_DEV_MODE` must be unset in production.** The destructive dev endpoints
  (`/dev/reset`, which wipes all tenant + auth data) are gated by
  `assertDevDeployment()` (`devShortcuts/_guard.ts`), which is **fail-closed**
  (refuses when the flag is absent/falsey) and unit-tested
  (`devShortcuts/__tests__/guard.test.ts`). They additionally require the
  `X-Instance-Secret` header.
- **`OWLAT_SETUP_MODE` must be off after first-run setup.** `/api/setup/*`
  (`apps/web/server/api/setup/*`) refuses unless setup mode is enabled.
- **Session cookie `Secure` flag.** The BetterAuth proxy
  (`apps/web/server/api/auth/[...].ts`) strips `Secure` only under
  `import.meta.dev`; production builds must not run with dev mode on.

## Considered options

1. **Keep fail-open + alert on skip-logs** *(chosen)* — preserves availability,
   makes the disabled-control state observable, no behavior change.
2. **Fail closed globally** — rejected: a down ClamAV blocks all attachment
   sends; a down Redis locks everyone out of IMAP. Worse availability for a
   self-hostable product.
3. **Fail closed for campaign attachments only** — viable future hardening;
   deferred until there is evidence of abuse, to avoid blocking sends pre-launch.

## Consequences

- No code change; the fail-open paths and their warn-logs stay as-is.
- Ops/runbook gains an alert on the skip-log rate for ClamAV and the rate
  limiters, and a deployment checklist for the env-hygiene invariants above.
- `topics/apiHttp.ts` was also reviewed: under single-org-per-deployment the API
  key belongs to the one org and every topic is that org's, so the "no org
  ownership check" flagged by the review is a non-issue here (the same reasoning
  retires the "cross-org IDOR" finding).
