/**
 * Typed environment variable access for the Convex backend.
 *
 * All `process.env.*` reads in `apps/api/convex/` MUST go through this module.
 * The lint rule in `.eslintrc` rejects raw `process.env.` outside this file.
 *
 * Add a new variable here when introducing one — the union below is the single
 * source of truth, and adding to it is the only place TypeScript will allow.
 */

export type EnvKey =
	// Auth & instance
	| 'BETTER_AUTH_SECRET'
	| 'INSTANCE_SECRET'
	// The PREVIOUS INSTANCE_SECRET, set ONLY during a secret rotation window
	// (Sealed Mail key lifecycle, E6). While set, the E2EE key box opens a sealed
	// private key under the current secret and, on failure, falls back to this one
	// — so the vault keeps reading correctly mid-migration while
	// `e2ee/lifecycleNode.ts:reSealVault` re-seals every row under the new secret.
	// Remove it once the re-seal migration has completed. Unset ⇒ no fallback.
	| 'INSTANCE_SECRET_PREVIOUS'
	| 'OWLAT_VERSION'
	// When set to 'true' / '1' / 'yes' / 'on', enables dev-only endpoints
	// (`/seed/demo`, `/dev/reset`, `forceVerifyDomain`). Fail-closed default:
	// leaving it unset on a production deployment refuses those endpoints.
	| 'OWLAT_DEV_MODE'
	// Site URLs
	| 'SITE_URL'
	| 'ADMIN_SITE_URL'
	| 'CONVEX_SITE_URL'
	| 'CONTROL_PLANE_URL'
	| 'ALLOWED_ORIGINS'
	// Email defaults
	| 'EMAIL_PROVIDER'
	| 'DEFAULT_FROM_DOMAIN'
	| 'DEFAULT_FROM_EMAIL'
	| 'DEFAULT_FROM_NAME'
	// MTA
	| 'MTA_API_KEY'
	| 'MTA_API_URL'
	| 'MTA_INTERNAL_URL'
	// Public FQDN the MTA presents as its SMTP EHLO identity (e.g.
	// `mail.example.com`) and the host other servers deliver inbound mail to.
	// Surfaced read-only to the admin "Receiving" DNS panel as the MX target a
	// domain must publish to receive mail through this deployment's MTA
	// (`domains/domains.ts:getInboundMailConfig`). Unset ⇒ no inbound MX guidance.
	| 'EHLO_HOSTNAME'
	| 'MTA_SPF_INCLUDE'
	// SPF trailing-mechanism qualifier for the generated DNS records: one of
	// `~all` (soft-fail, the safe default while the authorized IP set is still
	// settling), `-all` (hard-fail, once the IP set is stable), `?all` or
	// `+all`. Unset / invalid ⇒ `~all`. RFC 7208 §5.1.
	| 'SPF_QUALIFIER'
	// VERP bounce return-path domain (matches the MTA's RETURN_PATH_DOMAIN,
	// e.g. `bounces.example.com`). When set together with MTA_IP_POOLS the
	// generated DNS bundle includes a return-path SPF TXT record authorizing
	// the pool IPs, so the bounce envelope passes SPF at receivers that check
	// MAIL FROM. Unset ⇒ no return-path SPF record is generated.
	| 'MTA_RETURN_PATH_DOMAIN'
	// The DKIM signing domain (`d=` tag) the ACTIVE transport stamps on outbound
	// mail, when it isn't the per-message From-domain. The built-in MTA signs
	// per-From-domain, so it leaves this unset (and aligns by construction); a
	// generic SMTP relay that re-signs as its OWN domain (e.g. `sendgrid.net`)
	// sets this so the outbound DMARC-alignment guard can detect that the relay's
	// signature won't align with the operator's sending domains. Unset ⇒ the guard
	// treats DKIM as per-From-domain (MTA) or undeclared (relay).
	| 'OUTBOUND_DKIM_DOMAIN'
	// Comma-separated list of the IP-pool addresses the MTA sends from. Used to
	// generate the return-path SPF record (each IP authorized via `ip4:`).
	| 'MTA_IP_POOLS'
	// Optional DMARC aggregate-report (`rua`) reporting URI emitted in the
	// generated `_dmarc` record, e.g. `mailto:dmarc-reports@owlat.example`.
	// Unset ⇒ no `rua=` tag (Owlat does not provision a per-customer
	// `dmarc@<domain>` mailbox, so reports would otherwise go unread).
	| 'MTA_DMARC_RUA'
	// Optional SMTP TLS Reporting (`rua`) reporting URI emitted in the generated
	// `_smtp._tls` TXT record (RFC 8460 §3), e.g.
	// `mailto:tls-reports@owlat.example` or `https://example.com/tlsrpt`.
	// Unset ⇒ no `_smtp._tls` record (Owlat does not provision a per-customer
	// `tls-reports@<domain>` mailbox, so reports would otherwise go unread).
	| 'MTA_TLSRPT_RUA'
	// Outbound TLS posture for the built-in MTA's direct-MX delivery
	// (`opportunistic` | `require` | `require-verified`). Written by the delivery
	// transport editor and surfaced read-only to that editor via
	// `delivery/status.ts:getStatus` so re-applying an edit preserves the chosen
	// floor. The MTA itself reads this from its own config; unset ⇒ `opportunistic`.
	| 'OUTBOUND_TLS_MODE'
	| 'MTA_WEBHOOK_SECRET'
	// Mail sync worker (external IMAP/SMTP accounts)
	| 'MAIL_SYNC_API_URL'
	| 'MAIL_SYNC_API_KEY'
	// Provider: Resend
	| 'RESEND_API_KEY'
	| 'RESEND_WEBHOOK_SECRET'
	// Provider: AWS SES
	| 'AWS_SES_ACCESS_KEY_ID'
	| 'AWS_SES_REGION'
	| 'AWS_SES_SECRET_ACCESS_KEY'
	// SES Configuration Set applied to every send. When set, SES tags each
	// message with the set so its event-publishing (bounce/complaint/delivery
	// via the SNS topic behind /webhooks/ses) carries attribution back to the
	// originating send. Unset ⇒ sends omit the set (feedback still works via a
	// topic subscribed to the identity, but per-send attribution is weaker).
	| 'SES_CONFIGURATION_SET'
	// The exact SNS topic ARN authorized to deliver SES feedback to
	// `/webhooks/ses`. REQUIRED to enable the endpoint: a valid SNS signature
	// only proves AWS authorship, not that the message came from THIS topic, so
	// the adapter rejects any envelope whose `TopicArn` differs (and only
	// auto-confirms subscriptions for this topic). Unset ⇒ the endpoint returns
	// 503, exactly like an unconfigured provider.
	| 'SES_SNS_TOPIC_ARN'
	// Provider: generic SMTP relay (Mailgun/Postmark/SendGrid/Brevo/custom).
	// The instance-level outbound transport when `EMAIL_PROVIDER=smtp`.
	// SMTP_RELAY_SECURE=true opens an implicit-TLS connection on port 465,
	// while unset/false connects and upgrades via STARTTLS on the default 587.
	| 'SMTP_RELAY_HOST'
	| 'SMTP_RELAY_PORT'
	| 'SMTP_RELAY_SECURE'
	| 'SMTP_RELAY_USERNAME'
	| 'SMTP_RELAY_PASSWORD'
	// LLM
	| 'LLM_PROVIDER'
	| 'LLM_API_KEY'
	| 'LLM_BASE_URL'
	| 'LLM_MODEL'
	| 'LLM_MODEL_FAST'
	| 'LLM_MODEL_CAPABLE'
	| 'LLM_EMBEDDING_MODEL'
	// Local-by-default embedding plane (an OpenAI-compatible sidecar, e.g. Ollama).
	| 'LOCAL_EMBEDDING_BASE_URL'
	| 'LOCAL_EMBEDDING_MODEL'
	| 'LLM_COMPLEXITY_ROUTING'
	| 'OPENAI_API_KEY'
	| 'OPENROUTER_API_KEY'
	// Per-org dollar-spend budget for LLM calls (analytics/spendBudget.ts).
	// Daily / monthly USD ceilings — unset or `0` ⇒ no limit for that period
	// (the budget gate is a no-op). When a ceiling is hit the autonomous path
	// degrades to draft-only and advisory AI is paused; nothing drops mail.
	| 'AI_SPEND_DAILY_BUDGET_USD'
	| 'AI_SPEND_MONTHLY_BUDGET_USD'
	// Fraction of a ceiling (0–1] at which to start warning. Default 0.8.
	| 'AI_SPEND_WARN_FRACTION'
	// Fraction of a ceiling [0–1) reserved for autonomous drafting: advisory
	// (user-triggered) AI is paused once remaining headroom drops within it.
	// Default 0.2.
	| 'AI_SPEND_ADVISORY_RESERVE_FRACTION'
	// Analytics & links
	| 'POSTHOG_API_KEY'
	| 'POSTHOG_HOST'
	| 'UNSUBSCRIBE_SECRET'
	// Security
	| 'GOOGLE_SAFE_BROWSING_API_KEY'
	// Trusted-proxy source for per-IP rate limiting on public endpoints. Selects
	// which (otherwise spoofable) forwarded header to believe — see
	// publicRateLimit.getClientIp. One of: 'cloudflare' (CF-Connecting-IP),
	// 'xforwarded' or 'xforwarded:<hops>' (X-Forwarded-For, read N entries from
	// the right), 'xrealip' (X-Real-IP). Unset ⇒ headers are NOT trusted (single
	// shared bucket) so a spoofed header can't multiply rate-limit buckets.
	| 'RATE_LIMIT_TRUSTED_PROXY'
	// Inbound channel webhooks (SMS / WhatsApp / generic)
	| 'TWILIO_AUTH_TOKEN'
	| 'META_APP_SECRET'
	| 'META_VERIFY_TOKEN'
	| 'GENERIC_WEBHOOK_SECRET'
	// Code-work / GitHub PR merge webhook
	| 'GITHUB_WEBHOOK_SECRET'
	// Calendar / availability grounding for scheduling replies (mail/availability).
	// Optional read-only ICS/CalDAV subscription URL for the owner's own calendar
	// (a private iCal export). Fetched server-side, in-deployment, to derive
	// free/busy only — never event content. Unset ⇒ scheduling replies fall back
	// to referencing only the sender's proposed times (no availability grounding).
	| 'CALENDAR_FREEBUSY_ICS_URL'
	// IANA timezone (e.g. `America/New_York`) used to compute and label the owner's
	// open business-hours slots. Unset ⇒ `UTC`.
	| 'CALENDAR_TIMEZONE'
	// Slack approvals reference app (Tier-2 connected app, PP-26). Both must be
	// set for the app to be ACTIVE: the signing secret authenticates Slack's
	// interaction callbacks (v0 HMAC, replay-windowed) and the webhook URL is
	// where approval requests are posted. When EITHER is unset the app is inert —
	// the restrict-only hold gate returns "safe" and no autonomous send is held.
	// The gate holds EVERY autonomous send until a Slack quorum approves once both
	// are configured; failure to notify Slack, or any error, holds (never sends).
	| 'SLACK_APPROVALS_SIGNING_SECRET'
	| 'SLACK_APPROVALS_WEBHOOK_URL'
	// Distinct Slack approvers required to release the Slack approvals hold.
	// Optional; unset / invalid / < 1 ⇒ 1. A larger value NEVER weakens the gate
	// (it only demands more approvers); it is clamped to a small ceiling so a
	// typo can't create an unsatisfiable quorum that silently holds forever.
	| 'SLACK_APPROVALS_QUORUM'
	// Minutes an approval request stays open before it expires unapproved (and
	// the send stays held). Optional; unset / invalid ⇒ 1440 (24h), clamped to a
	// sane range. Expiry only ever holds — an expired request never sends.
	| 'SLACK_APPROVALS_TTL_MINUTES';

/**
 * Read a required environment variable. Throws if unset or empty.
 * Use this when missing the value should hard-fail the action/mutation.
 */
export function getRequired(key: EnvKey): string {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

/**
 * Read an optional environment variable.
 * Returns the raw value or `undefined` — preserves existing fall-through behavior.
 */
export function getOptional(key: EnvKey): string | undefined {
	return process.env[key];
}

/**
 * Read an environment variable with a fallback default.
 */
export function getWithDefault(key: EnvKey, fallback: string): string {
	return process.env[key] ?? fallback;
}

/**
 * Boolean parse of an environment variable. Treats 'true', '1', 'yes', 'on'
 * (case-insensitive) as true; anything else (including unset) as false.
 */
export function getBoolean(key: EnvKey): boolean {
	const value = process.env[key]?.toLowerCase();
	return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/**
 * Whether an environment variable is present (set and non-empty).
 *
 * Accepts an arbitrary key (not just the typed `EnvKey` union) because the
 * config-status introspection that drives the Features "needs config" badge
 * iterates declarative `requiredEnvVars` lists from `@owlat/shared/featureFlags`
 * — some of which (the hosted-only `STRIPE_*` / `HETZNER_API_TOKEN`) live
 * outside this deployment's typed union. Reading through this module keeps the
 * no-raw-`process.env` lint satisfied; it returns only a boolean, never the
 * value, so it leaks no secrets.
 */
export function isEnvPresent(key: string): boolean {
	const value = process.env[key];
	return value !== undefined && value !== '';
}

/**
 * Read a plugin-declared signing secret by the `secretEnvVar` name from a
 * plugin's inbound signature-verification contract. Accepts an arbitrary key
 * (not the typed `EnvKey` union) because plugin secret variable names are
 * declared in plugin manifests, not this deployment's fixed union. Reading
 * through this module keeps the no-raw-`process.env` lint satisfied. Returns
 * `undefined` when unset or empty so the host fails closed; the value is only
 * ever fed into a constant-time HMAC comparison, never logged.
 */
export function getPluginSecret(key: string): string | undefined {
	const value = process.env[key];
	return value === undefined || value === '' ? undefined : value;
}
