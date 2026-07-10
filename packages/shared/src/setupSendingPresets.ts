/**
 * Connection presets for the generic SMTP relay transport — the single source
 * of truth both the web setup wizard (`apps/web/app/pages/setup/email.vue`) and
 * the setup CLI (`apps/setup-cli`) prefill from, so the two can never drift.
 *
 * There is deliberately no per-provider API adapter: every one of these speaks
 * plain SMTP submission, so a single set of `SMTP_RELAY_*` env vars drives them
 * all. Ports/TLS mirror each provider's documented submission endpoint; every
 * one defaults to STARTTLS on 587, which the backend `smtp` adapter upgrades and
 * enforces (`requireTLS`). `custom` carries the same safe default so the fields
 * are never empty.
 */

/** Which well-known relay a "SMTP relay" install points at; `custom` leaves the
 * fields for the operator. */
export type SmtpRelayPreset = 'mailgun' | 'postmark' | 'sendgrid' | 'brevo' | 'custom';

export interface SmtpRelayPresetConfig {
	label: string;
	/** Blank for `custom` ⇒ the operator fills it in. */
	host: string;
	/** String because it feeds a form field. */
	port: string;
	secure: boolean;
}

export const SMTP_RELAY_PRESETS: Record<SmtpRelayPreset, SmtpRelayPresetConfig> = {
	mailgun: { label: 'Mailgun', host: 'smtp.mailgun.org', port: '587', secure: false },
	postmark: { label: 'Postmark', host: 'smtp.postmarkapp.com', port: '587', secure: false },
	sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: '587', secure: false },
	brevo: { label: 'Brevo', host: 'smtp-relay.brevo.com', port: '587', secure: false },
	custom: { label: 'Custom SMTP server', host: '', port: '587', secure: false },
};

/**
 * The env keys the delivery-transport configuration owns — the provider kind,
 * every per-provider credential, and the optional From-identity. This is the
 * single source of truth for two callers that must never drift:
 *
 *  - the setup wizard / in-app transport editor's `buildProviderEnv`, which
 *    CLEARS all of these before re-applying so flipping provider never leaves a
 *    stale credential behind; and
 *  - the admin `/api/delivery/apply-transport` endpoint, which uses it as the
 *    ALLOWLIST of keys a client is permitted to patch (so a transport change can
 *    never inject an unrelated env var such as `INSTANCE_SECRET`) and as the set
 *    of keys to clear in the Convex deployment when they are dropped.
 */
export const PROVIDER_ENV_KEYS = [
	'EMAIL_PROVIDER',
	'RESEND_API_KEY',
	'AWS_SES_REGION',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
	'SMTP_RELAY_HOST',
	'SMTP_RELAY_PORT',
	'SMTP_RELAY_SECURE',
	'SMTP_RELAY_USERNAME',
	'SMTP_RELAY_PASSWORD',
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
] as const;

export type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number];
