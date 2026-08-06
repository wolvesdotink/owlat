/**
 * The delivery-transport ENV SURFACE: which variables a transport swap owns, and
 * the clear-vs-preserve rule `POST /api/delivery/apply-transport` applies to a
 * patch of them.
 *
 * The per-provider DATA this used to declare beside that rule — the SMTP relay
 * presets and the env-key allowlist — is now derived from the send-provider
 * catalog (`./sendProviderCatalog`, the seams plan's D1). What stays here is the
 * POLICY: the allowlist's two ends, the From-identity exception, and
 * {@link planTransportEnvChange}.
 */

import {
	TRANSPORT_CREDENTIAL_ENV_KEYS,
	type TransportCredentialEnvKey,
} from './sendProviderCatalog';

/**
 * The SMTP relay presets moved to `./sendProviderCredentialFields` when the
 * catalog became the single declaration (the seams plan's P1.1: "SMTP presets
 * become catalog-attached data") — they are the data of ONE field descriptor,
 * the `smtp` entry's `host-port` endpoint, and nothing else ever needed them
 * apart from it.
 *
 * Re-exported here because the web setup wizard
 * (`apps/web/app/pages/setup/email.vue`) and the setup CLI (`apps/setup-cli`)
 * both import them from this module.
 */
export {
	SMTP_RELAY_PRESETS,
	type SmtpRelayPreset,
	type SmtpRelayPresetConfig,
} from './sendProviderCredentialFields';

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
 *
 * DERIVED, per the seams plan's D1: the per-provider middle is every env
 * variable the catalog's `credentialFields` declare, in catalog × field order.
 * The three keys around them are this list's own — `EMAIL_PROVIDER` names which
 * kind is active (it belongs to no kind) and the two From-identity keys are the
 * transport form's, not a provider's.
 *
 * WHAT THE DERIVATION KEEPS OUT, and why the catalog can be trusted to: a
 * variable that is required to SEND but is not a form FIELD stays out. The
 * installer writes `MTA_API_URL` / `MTA_API_KEY`; Mandrill issues
 * `MANDRILL_WEBHOOK_KEY` after the operator creates the webhook, later than and
 * independently of connecting the transport. This list is cleared-then-set on
 * every apply, so admitting either would let an unrelated key rotation unset a
 * working MTA or a working feedback loop. The entries declare them as
 * `requiredEnvVars` / `optionalEnvVars` WITHOUT a matching field, which is
 * exactly that distinction.
 *
 * ORDER IS NOT SEMANTIC. Both consumers key by NAME — one is a membership check,
 * the other iterates and hands the result back as pairs a caller reads by key —
 * so the derived order (catalog order) differs from the hand-written one it
 * replaced while the SET is identical, which `sendProviderCatalog.test.ts` pins
 * against the pre-move literal.
 *
 * ONE PLACE THE ORDER IS OBSERVABLE, so that "not semantic" is not read as "not
 * visible": {@link planTransportEnvChange} builds `merged` by iterating this
 * list, and `writeEnvFile` (`./setupEnv`) serialises a map with
 * `Object.entries`, i.e. in insertion order. A transport swap that introduces
 * credential keys the existing `.env` did not already carry therefore writes
 * those NEW lines in catalog order rather than in the historic hand-written one.
 * Cosmetic and deliberately unpinned — no key is added, dropped or mis-valued,
 * and keys already present keep their position — but it is a real difference a
 * reader may notice in a generated file.
 */
export const PROVIDER_ENV_KEYS: readonly ProviderEnvKey[] = Object.freeze([
	'EMAIL_PROVIDER',
	...TRANSPORT_CREDENTIAL_ENV_KEYS,
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
] as const);

export type ProviderEnvKey = 'EMAIL_PROVIDER' | TransportCredentialEnvKey | FromIdentityEnvKey;

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
