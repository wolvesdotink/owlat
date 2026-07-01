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
	// LLM
	| 'LLM_PROVIDER'
	| 'LLM_API_KEY'
	| 'LLM_BASE_URL'
	| 'LLM_MODEL'
	| 'LLM_MODEL_FAST'
	| 'LLM_MODEL_CAPABLE'
	| 'LLM_EMBEDDING_MODEL'
	| 'LLM_COMPLEXITY_ROUTING'
	| 'OPENAI_API_KEY'
	| 'OPENROUTER_API_KEY'
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
	| 'GITHUB_WEBHOOK_SECRET';

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
