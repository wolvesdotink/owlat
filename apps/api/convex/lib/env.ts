/**
 * Typed environment variable access for the Convex backend.
 *
 * All `process.env.*` reads in `apps/api/convex/` MUST go through this module.
 * The lint rule in `.eslintrc` rejects raw `process.env.` outside this file.
 *
 * Add a new variable here when introducing one — the union below is the single
 * source of truth, and adding to it is the only place TypeScript will allow.
 */

// The kit's namespace predicate, imported rather than restated — see
// `getPluginTransportEnv`. A leaf contract with no runtime of its own, which is
// what lets this module stay importable from every isolate.
import { isPluginSecretEnvVar } from '@owlat/plugin-kit';

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
	// Additional NAMED transport instances, beyond the one default instance each
	// transport kind gets for free. Comma-separated `<kind>#<instanceKey>` entries
	// (e.g. `smtp#backup,resend#trial`). Each named instance reads its own config
	// from the same variables as its kind, suffixed with `__<INSTANCEKEY>` —
	// `smtp#backup` reads `SMTP_RELAY_HOST__BACKUP`, `SMTP_RELAY_USERNAME__BACKUP`,
	// and so on. Instance keys are lowercase `[a-z0-9][a-z0-9_-]{0,31}`; malformed
	// entries are ignored rather than crashing dispatch. Unset ⇒ exactly one
	// transport per kind, which is the shipped single-transport deployment.
	| 'SEND_TRANSPORT_INSTANCES'
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
	// The MTA's VERP signing key (BOUNCE_VERP_KEY on the MTA side). Convex needs
	// the SAME key to stamp a verifiable VERP envelope sender on RELAY sends, so
	// a bounce a third-party relay generates still reaches our bounce server and
	// attributes to the right send. Unset ⇒ relay sends keep the composer's
	// envelope sender and that arm's bounce data is graded degraded — never an
	// error, never a blocked send.
	| 'MTA_BOUNCE_VERP_KEY'
	// SPF mechanism terms (e.g. `include:amazonses.com`) that authorise a
	// third-party RELAY to send with a `bounce+…@<return-path host>` envelope
	// sender. Emitted into the generated return-path SPF record, and required —
	// published and verified — before a relay send may carry our VERP address:
	// the record otherwise authorises the MTA pool only, so stamping it on a
	// relay send would fail SPF on the very arm being measured. Unset ⇒ no relay
	// stamp, degraded measurement, nothing blocked.
	| 'MTA_RETURN_PATH_RELAY_SPF'
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
	// BIMI (P4-7) — OPTIONAL IN EVERY SENSE. The domain wizard offers a BIMI
	// record only once the domain's DMARC is at `p=quarantine` or stricter, and
	// only once a logo is known; unset ⇒ the wizard states that BIMI exists and
	// what a VMC is, and generates no record. Never a blocked send, never a
	// blocked promotion, never an unresolvable warning (D2).
	// HTTPS URL of the SVG Tiny PS brand logo (the `l=` tag).
	| 'MTA_BIMI_LOGO_URL'
	// HTTPS URL of the Verified Mark Certificate PEM (the `a=` tag). Gmail and
	// Apple Mail need one; other receivers show the logo without it.
	| 'MTA_BIMI_VMC_URL'
	// BIMI selector label (`<selector>._bimi.<domain>`). Unset ⇒ the spec's
	// `default`. A value that is not a DNS label falls back to `default`.
	| 'MTA_BIMI_SELECTOR'
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
	// Provider: Emailit
	| 'EMAILIT_API_KEY'
	| 'EMAILIT_WEBHOOK_SECRET'
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
	// Provider: Mailchimp Transactional (Mandrill). The instance-level outbound
	// transport when `EMAIL_PROVIDER=mandrill`, and the reference arm a team
	// arriving from Mailchimp migrates AWAY from under the ramp controller.
	// The API key alone enables the kind; the three below only refine it.
	| 'MANDRILL_API_KEY'
	// Per-webhook signing key Mandrill shows after you create the webhook
	// pointing at `<convex-site>/webhooks/mandrill`. Keys the HMAC-SHA1
	// signature the inbound adapter verifies. Unset ⇒ no verified feedback
	// loop, so bounces/complaints from this arm never reach the lifecycle.
	| 'MANDRILL_WEBHOOK_KEY'
	// Optional Mandrill subaccount. Isolates Owlat's traffic — and therefore
	// its reputation — inside a shared Mandrill account. Unset ⇒ sends omit
	// the field and land on the account's default reputation.
	| 'MANDRILL_SUBACCOUNT'
	// Optional default Mandrill dedicated-IP pool name. A resolved route's
	// `providerRoutes.ipPool` overrides it per send; unset (and unrouted) ⇒
	// sends omit the field and Mandrill picks the account default pool.
	| 'MANDRILL_IP_POOL'
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
	// Microsoft SNDS "Automated Data Access" feed URLs (comma- or
	// whitespace-separated, `https` only), one per registered IP range. Each URL
	// is a BEARER CAPABILITY to the deployment's SNDS data — it is read only by
	// the SNDS poller, never logged and never returned to a client. Unset ⇒ the
	// poller returns immediately having written nothing: SNDS enrollment is
	// additive-only, so its absence lowers measurement confidence for the
	// Microsoft cell and slows that cell's ramp, and does nothing else.
	| 'SNDS_DATA_FEED_URLS'
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
	| 'CALENDAR_TIMEZONE';

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
 * The truthy set, applied to an already-read value.
 *
 * Exported so the per-transport-instance reader in
 * `lib/sendProviders/transportEnv.ts` — which resolves its own variable name at
 * runtime and so cannot go through `getBoolean`'s typed `EnvKey` — parses with
 * the SAME set instead of restating it. One definition, no drift.
 */
export function parseBooleanEnv(value: string | undefined): boolean {
	const normalized = value?.toLowerCase();
	return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/**
 * Boolean parse of an environment variable. Treats 'true', '1', 'yes', 'on'
 * (case-insensitive) as true; anything else (including unset) as false.
 */
export function getBoolean(key: EnvKey): boolean {
	return parseBooleanEnv(process.env[key]);
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
 * The one untyped-key read. Every escape hatch below delegates here — each
 * fencing its own key shape first — so "unset or empty means absent" has a
 * single definition. Deliberately uncounted: the sentence went stale the first
 * time a third one was added.
 */
function readNonEmptyEnv(key: string): string | undefined {
	const value = process.env[key];
	return value === undefined || value === '' ? undefined : value;
}

/**
 * `<BASE>__<INSTANCEKEY>` — the only key shape a named send-transport instance
 * may read. Fencing the shape keeps this untyped escape hatch from being used
 * (by a future caller, or by a crafted instance key) to read unrelated
 * deployment configuration.
 */
const SEND_TRANSPORT_ENV_KEY_PATTERN = /^[A-Z0-9_]+__[A-Z0-9_]+$/;

/**
 * Read one send-transport configuration variable by its INSTANCE-RESOLVED name.
 *
 * Accepts an arbitrary key (not the typed `EnvKey` union) because a named
 * transport instance reads its kind's variables under an `__<INSTANCEKEY>`
 * suffix (`SMTP_RELAY_HOST__BACKUP`) — a name derived at runtime from
 * `SEND_TRANSPORT_INSTANCES`, so it cannot be enumerated in the union. Reading
 * through this module keeps the no-raw-`process.env` lint satisfied. Returns
 * `undefined` when unset, empty, or not of the suffixed instance shape, so the
 * transport resolver fails closed; the value is only ever handed to the adapter
 * that owns it, never logged and never returned to a client.
 *
 * The UNSUFFIXED default instance keeps reading through the typed accessors
 * above — this is only the extra-instance path.
 */
export function getSendTransportEnv(key: string): string | undefined {
	if (!SEND_TRANSPORT_ENV_KEY_PATTERN.test(key)) return undefined;
	return readNonEmptyEnv(key);
}

/**
 * Read one bundled SEND TRANSPORT's declared configuration variable.
 *
 * Accepts an arbitrary key (not the typed `EnvKey` union) because the names are
 * declared in plugin manifests, not in this deployment's fixed union, and a named
 * instance reads them under a runtime-derived `__<INSTANCEKEY>` suffix. Reading
 * through this module keeps the no-raw-`process.env` lint satisfied.
 *
 * The value IS handed to plugin code — that is the point: a transport that reads
 * the environment itself would read the deployment-default instance's variables
 * no matter which transport id the send was addressed to. So the namespace fence
 * is the security boundary, and it is checked here as well as at manifest
 * validation, because the host's caller is a generated artifact rather than a
 * validated manifest — the innermost of the three readings, and the one that has
 * to hold for an artifact no validator ever saw. Returns `undefined` when unset,
 * empty, or outside the namespace, so the caller fails closed.
 *
 * THE FENCE IS THE KIT'S OWN PREDICATE, not a fourth copy of the pattern.
 * `isPluginSecretEnvVar` is where the `PLUGIN_` namespace is defined — the
 * manifest validator and the catalog composition guard both compose onto it — and
 * a private regex here would be free to disagree with it in the one direction
 * nobody would notice: a tightening that lands on the two outer readings and not
 * on this one still hands the value over. It accepts the instance-suffixed form
 * (`PLUGIN_ACME_TOKEN__EU`) because that is one more name inside the same
 * namespace; only a BASE name is held to the stricter no-`__` rule, and that is
 * the manifest's business, not this read's.
 */
export function getPluginTransportEnv(key: string): string | undefined {
	if (!isPluginSecretEnvVar(key)) return undefined;
	return readNonEmptyEnv(key);
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
	return readNonEmptyEnv(key);
}
