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
	// Outbound TLS posture for the built-in MTA's direct-MX delivery. Only the
	// `mta` transport emits it; cleared for the relay/API transports (their TLS is
	// the provider's concern).
	'OUTBOUND_TLS_MODE',
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
] as const;

export type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number];

/**
 * The From-identity keys within `PROVIDER_ENV_KEYS`. Unlike a credential, the
 * transport editor never shows the current value and treats a blank field as
 * "leave unchanged" — so these must be PRESERVED when a patch omits them, never
 * cleared. Wiping them would destroy the operator's configured system/campaign
 * From address on an unrelated change (e.g. rotating an API key). Everything
 * else is a credential, cleared-then-set so a dropped credential never stays
 * live.
 */
export type FromIdentityEnvKey = 'DEFAULT_FROM_EMAIL' | 'DEFAULT_FROM_NAME';

function isFromIdentityKey(key: string): key is FromIdentityEnvKey {
	return key === 'DEFAULT_FROM_EMAIL' || key === 'DEFAULT_FROM_NAME';
}

/** Thrown by `planTransportEnvChange` when a patch carries a non-transport key. */
export class UnexpectedTransportEnvKeyError extends Error {
	constructor(readonly key: string) {
		super(`Unexpected env key: ${key}.`);
		this.name = 'UnexpectedTransportEnvKeyError';
	}
}

export interface TransportEnvPlan {
	/**
	 * The full env to persist to `.env`: credentials replaced (dropped ones
	 * removed), From identity preserved when the patch omits it.
	 */
	merged: Record<string, string>;
	/**
	 * The `[key, value]` pairs to push into the LIVE deployment env: credentials
	 * cleared-or-set (a dropped credential is pushed as `''` to unset it); From
	 * identity is pushed ONLY when the patch supplies it, so an omitted (blank)
	 * From field leaves the current default untouched.
	 */
	changes: Array<[ProviderEnvKey, string]>;
}

/**
 * Compute the env change for an in-app transport swap from the current `.env`
 * (`existing`) and the provider-key `patch` the editor built with
 * `buildProviderEnv` (SET keys only).
 *
 *  - Only `PROVIDER_ENV_KEYS` may appear in the patch — any other key throws
 *    `UnexpectedTransportEnvKeyError`, so a browser request can never inject an
 *    unrelated env var such as `INSTANCE_SECRET`.
 *  - CREDENTIALS are clear-then-set: each is unset first (pushed as `''` live)
 *    so a dropped credential never stays live, then the patch re-applies the
 *    supplied ones.
 *  - FROM-IDENTITY keys are preserved when the patch omits them (blank means
 *    "keep the current default"); they are written only when the patch sets one.
 */
export function planTransportEnvChange(
	existing: Record<string, string>,
	patch: Record<string, string>
): TransportEnvPlan {
	for (const key of Object.keys(patch)) {
		if (!(PROVIDER_ENV_KEYS as readonly string[]).includes(key)) {
			throw new UnexpectedTransportEnvKeyError(key);
		}
	}

	const merged: Record<string, string> = { ...existing };
	const changes: Array<[ProviderEnvKey, string]> = [];

	for (const key of PROVIDER_ENV_KEYS) {
		const supplied = patch[key];
		if (isFromIdentityKey(key)) {
			// Preserve on omission; only touch when the patch sets it.
			if (supplied !== undefined) {
				merged[key] = supplied;
				changes.push([key, supplied]);
			}
			continue;
		}
		// Credential: clear-then-set.
		if (supplied !== undefined) {
			merged[key] = supplied;
		} else {
			delete merged[key];
		}
		changes.push([key, supplied ?? '']);
	}

	return { merged, changes };
}
