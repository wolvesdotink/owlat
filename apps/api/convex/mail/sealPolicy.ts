/**
 * Pure Sealed-Mail sealing-decision logic (plan 2026-07-11, locked decisions D2
 * + D5). No `ctx`, no db, no `openpgp` — plain data in, a decision out — so BOTH
 * the V8 plane (`mail/draftLifecycle.ts`, for the composer's `sealState`) and the
 * Node plane (`mail/outbound.ts`, at dispatch) share ONE source of truth and can
 * never drift into two subtly-different "should we seal?" answers.
 *
 * D2: AUTO-SEAL only when EVERY recipient has a usable pinned key — never a mixed
 * send. An org policy override (`auto` / `ask` / `off`) sits in front of that.
 * D5: this governs the Postbox 1:1 plane only; campaigns/transactional are
 * untouched and never reach this module.
 *
 * This module owns the Sealed-Mail Convex validators too (`sealPolicyValidator`,
 * `sealSkipReasonValidator`, `mailEncryptionInfoValidator`) so each validator
 * sits next to the TypeScript type it mirrors — the single source of truth for
 * the sealing vocabulary — rather than drifting apart in `lib/convexValidators`.
 * Importing `convex/values` here keeps the module pure of `ctx`/db/network.
 */

import { v } from 'convex/values';

/** Org-level sealing policy (`instanceSettings.sealPolicy`). Unset ⇒ `auto`. */
export type SealPolicy = 'auto' | 'ask' | 'off';

/**
 * Convex validator for the org sealing policy (`instanceSettings.sealPolicy`,
 * locked decision D2). `auto` seals whenever every recipient has a usable pinned
 * key; `ask` keeps sealing available but never seals automatically (the message
 * goes out normally); `off` never seals. Unset ⇒ treated as `auto` at resolution
 * time. Mirrors {@link SealPolicy}.
 */
export const sealPolicyValidator = v.union(v.literal('auto'), v.literal('ask'), v.literal('off'));

/**
 * The trust state of ONE recipient's discovered key, mirroring
 * `recipientKeys.outcome` plus `missing` for an address we have never discovered
 * (no cache row at all).
 */
export type RecipientKeyOutcome = 'trusted' | 'keyChanged' | 'notFound' | 'missing';

/** One recipient's discovery state as the dispatch/compose paths read it. */
export interface RecipientKeyState {
	address: string;
	outcome: RecipientKeyOutcome;
	/** Armored PUBLIC key of the pinned fingerprint; present only when trusted. */
	pinnedPublicKeyArmored?: string;
}

/** Everything the dispatch-time seal decision reads, gathered by a V8 query. */
export interface SealInputs {
	/** Whether the `sealedMail` feature flag is live. */
	flagEnabled: boolean;
	/** The resolved org policy (`auto` when unset). */
	policy: SealPolicy;
	/** Whether an active address key exists for the From address (the signer). */
	hasSigningKey: boolean;
	/** Per-recipient discovery state (deduped To+Cc+Bcc). */
	recipients: RecipientKeyState[];
}

/** Why an outbound message was NOT sealed — recorded verbatim in `encryptionInfo.reason`. */
export type SealSkipReason =
	| 'flag_off'
	| 'policy_off'
	| 'policy_ask'
	| 'no_recipients'
	| 'recipient_no_key'
	| 'key_changed'
	| 'no_signing_key';

/** Convex validator mirroring {@link SealSkipReason} exactly (kept in lockstep). */
export const sealSkipReasonValidator = v.union(
	v.literal('flag_off'),
	v.literal('policy_off'),
	v.literal('policy_ask'),
	v.literal('no_recipients'),
	v.literal('recipient_no_key'),
	v.literal('key_changed'),
	v.literal('no_signing_key')
);

/** The dispatch-time decision: seal (with the exact recipient keys) or send plaintext. */
export type SealDecision =
	| { seal: true; recipientPublicKeysArmored: string[] }
	| { seal: false; reason: SealSkipReason };

/**
 * The honest outbound sealing record persisted on a sent mailMessages row
 * (`mailMessages.encryptionInfo`). A DISCRIMINATED UNION so the type itself
 * enforces the "honest by construction" claim: a `sealed:true` value MUST carry
 * the exact PGP/MIME fingerprints used, and a `sealed:false` value MUST carry the
 * `reason`. Neither "sealed with no fingerprints" nor "unsealed with no reason"
 * is representable. Mirrored one-for-one by {@link mailEncryptionInfoValidator}.
 */
export type OutboundEncryptionInfo =
	| {
			sealed: true;
			algorithm: 'pgp-mime';
			recipientFingerprints: string[];
			signingFingerprint: string;
	  }
	| { sealed: false; reason: SealSkipReason };

/**
 * Convex validator mirroring {@link OutboundEncryptionInfo} — a `v.union` of the
 * two honest shapes (sealed-with-fingerprints / unsealed-with-reason). Stored as
 * `mailMessages.encryptionInfo` (schema/mail.ts) and echoed in the draft
 * lifecycle's sent-context validator.
 */
export const mailEncryptionInfoValidator = v.union(
	v.object({
		sealed: v.literal(true),
		// PGP/MIME (RFC 9580 profile) is the only sealing algorithm today.
		algorithm: v.literal('pgp-mime'),
		// Uppercase-hex fingerprints of the recipient encryption keys the body was
		// sealed to (public material).
		recipientFingerprints: v.array(v.string()),
		// Uppercase-hex fingerprint of the sender address key that signed the body.
		signingFingerprint: v.string(),
	}),
	v.object({
		sealed: v.literal(false),
		// Why the message went plaintext — see SealSkipReason.
		reason: sealSkipReasonValidator,
	})
);

/**
 * Decide whether THIS dispatch auto-seals. Order matters: the cheapest / most
 * decisive gates first, then the all-recipients rule (D2 — one keyless recipient
 * forces plaintext), then the signer check, and only `policy === 'auto'` actually
 * seals automatically. `policy === 'ask'` is a deliberate plaintext-with-reason
 * here: it keeps sealing available but never seals automatically, so the message
 * goes out normally with `reason:'policy_ask'`.
 */
export function decideSeal(inputs: SealInputs): SealDecision {
	if (!inputs.flagEnabled) return { seal: false, reason: 'flag_off' };
	if (inputs.policy === 'off') return { seal: false, reason: 'policy_off' };
	if (inputs.recipients.length === 0) return { seal: false, reason: 'no_recipients' };
	// A conflicting (unsigned) key change must never silently seal to the new key.
	if (inputs.recipients.some((r) => r.outcome === 'keyChanged')) {
		return { seal: false, reason: 'key_changed' };
	}
	// D2: seal ONLY when ALL recipients have a usable pinned key.
	const keys: string[] = [];
	for (const r of inputs.recipients) {
		if (r.outcome !== 'trusted' || !r.pinnedPublicKeyArmored) {
			return { seal: false, reason: 'recipient_no_key' };
		}
		keys.push(r.pinnedPublicKeyArmored);
	}
	if (!inputs.hasSigningKey) return { seal: false, reason: 'no_signing_key' };
	// Keys are ready. `ask` never seals automatically; only `auto` seals now.
	if (inputs.policy === 'ask') return { seal: false, reason: 'policy_ask' };
	return { seal: true, recipientPublicKeysArmored: keys };
}

/**
 * The composer-facing seal readiness for a draft (consumed by the E5 compose
 * surface). Answers "can this draft be sealed?" — distinct from `decideSeal`,
 * which answers "does THIS automatic dispatch seal?". `willSeal` means the keys
 * are present and the org allows sealing; `keyChanged` surfaces the addresses
 * whose key rotated without a signed statement (the reader must re-accept);
 * `cannotSeal` carries the blocking reason.
 */
export type SealState =
	| { kind: 'willSeal' }
	| { kind: 'keyChanged'; addresses: string[] }
	| { kind: 'cannotSeal'; reason: SealSkipReason };

/**
 * Sending permission for a feature-enabled draft. A key change is never
 * bypassable; every other plaintext outcome requires the distinct explicit
 * consent action rendered by the composer.
 */
export function canSendWithSealState(state: SealState, allowUnsealed: boolean): boolean {
	if (state.kind === 'willSeal') return true;
	if (state.kind === 'keyChanged') return false;
	return allowUnsealed;
}

/**
 * Derive the composer's `sealState` from the policy, recipient states, AND
 * whether the sender has a signing key. Pure. Walks the SAME gates in the SAME
 * order as {@link decideSeal} (the dispatch decision) so the composer's promise
 * can never claim more than what the sender actually does — the honesty rule is
 * enforced by construction, not by convention:
 *   - `off`               → `cannotSeal('policy_off')`
 *   - no recipients       → `cannotSeal('no_recipients')`
 *   - a rotated key       → `keyChanged` (surfaced ahead of a generic "no key" so
 *                           the reader sees the specific rotation warning)
 *   - any keyless recip.  → `cannotSeal('recipient_no_key')`
 *   - no sender key        → `cannotSeal('no_signing_key')`
 *   - policy `ask`        → `cannotSeal('policy_ask')` (keys are ready, but the
 *                           org asks before sealing, so it goes out normally)
 *   - otherwise           → `willSeal`
 * `flag_off` is handled by the caller before this runs. This mirrors
 * `decideSeal`'s ordering exactly: recipient checks, then the signer, then `ask`.
 */
export function deriveSealState(
	policy: SealPolicy,
	recipients: RecipientKeyState[],
	hasSigningKey: boolean
): SealState {
	if (policy === 'off') return { kind: 'cannotSeal', reason: 'policy_off' };
	if (recipients.length === 0) return { kind: 'cannotSeal', reason: 'no_recipients' };
	const changed = recipients.filter((r) => r.outcome === 'keyChanged').map((r) => r.address);
	if (changed.length > 0) return { kind: 'keyChanged', addresses: changed };
	const allTrusted = recipients.every((r) => r.outcome === 'trusted' && !!r.pinnedPublicKeyArmored);
	if (!allTrusted) return { kind: 'cannotSeal', reason: 'recipient_no_key' };
	if (!hasSigningKey) return { kind: 'cannotSeal', reason: 'no_signing_key' };
	// Keys are ready. Under `ask` the org wants a human decision, so the composer
	// reports "won't seal automatically" rather than promising encryption.
	if (policy === 'ask') return { kind: 'cannotSeal', reason: 'policy_ask' };
	return { kind: 'willSeal' };
}
