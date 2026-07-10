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
	host: string;
	/** String because it feeds a form field; blank host ⇒ operator fills it in. */
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
