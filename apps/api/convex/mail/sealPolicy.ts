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
 */

/** Org-level sealing policy (`instanceSettings.sealPolicy`). Unset ⇒ `auto`. */
export type SealPolicy = 'auto' | 'ask' | 'off';

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

/** The dispatch-time decision: seal (with the exact recipient keys) or send plaintext. */
export type SealDecision =
	| { seal: true; recipientPublicKeysArmored: string[] }
	| { seal: false; reason: SealSkipReason };

/**
 * The honest outbound sealing record persisted on a sent mailMessages row
 * (`mailMessages.encryptionInfo`). Never claims more than what actually happened:
 * `sealed:false` always carries the `reason`; `sealed:true` carries the exact
 * PGP/MIME fingerprints used.
 */
export interface OutboundEncryptionInfo {
	sealed: boolean;
	reason?: SealSkipReason;
	algorithm?: 'pgp-mime';
	recipientFingerprints?: string[];
	signingFingerprint?: string;
}

/**
 * Decide whether THIS dispatch auto-seals. Order matters: the cheapest / most
 * decisive gates first, then the all-recipients rule (D2 — one keyless recipient
 * forces plaintext), then the signer check, and only `policy === 'auto'` actually
 * seals automatically. `policy === 'ask'` is a deliberate plaintext-with-reason
 * here: the composer opt-in that turns `ask` into a seal is the E5 piece; until
 * then `ask` behaves as "ready, but not automatic".
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
	// Keys are ready. `ask` waits for the composer opt-in (E5); only `auto` seals now.
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
 * Derive the composer's `sealState` from the policy + recipient states. Pure.
 * `keyChanged` takes precedence over a generic "no key" so the user sees the
 * specific rotation warning rather than a vague block.
 */
export function deriveSealState(policy: SealPolicy, recipients: RecipientKeyState[]): SealState {
	if (policy === 'off') return { kind: 'cannotSeal', reason: 'policy_off' };
	if (recipients.length === 0) return { kind: 'cannotSeal', reason: 'no_recipients' };
	const changed = recipients.filter((r) => r.outcome === 'keyChanged').map((r) => r.address);
	if (changed.length > 0) return { kind: 'keyChanged', addresses: changed };
	const allTrusted = recipients.every((r) => r.outcome === 'trusted' && !!r.pinnedPublicKeyArmored);
	if (!allTrusted) return { kind: 'cannotSeal', reason: 'recipient_no_key' };
	return { kind: 'willSeal' };
}
