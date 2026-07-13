/**
 * Composer-lock derivation for Sealed Mail (E5, flag `sealedMail`). Turns the
 * backend's per-draft `sealState` (mail/sealPolicy.ts `deriveSealState`, exposed
 * to the web by `api.mail.drafts.getComposerSealState`) into ONE honest lock
 * indicator for the compose surface.
 *
 * The honesty audit is a test, not a vibe: every string this can render maps 1:1
 * to a `sealState` the backend actually computed. `willSeal` is the ONLY state
 * that promises encryption; every other state explains, in plain language, why
 * the message would go out unsealed — and for `cannotSeal` sending unsealed is an
 * EXPLICIT act (the composer surfaces a distinct "Send unsealed" control, never a
 * silent plaintext send).
 *
 * This is the web-side mirror of the Convex `SealState` union (single source is
 * `mail/sealPolicy.ts`); the boundary keeps its own copy per this app's existing
 * cross-package pattern (see `utils/senderAuth.ts`).
 */

/** Why a draft cannot (or would not automatically) be sealed. Mirrors the Convex `SealSkipReason`. */
export type SealSkipReason =
	| 'flag_off'
	| 'policy_off'
	| 'policy_ask'
	| 'no_recipients'
	| 'recipient_no_key'
	| 'key_changed'
	| 'no_signing_key';

/** Web mirror of the Convex composer `SealState` union (`mail/sealPolicy.ts`). */
export type SealState =
	| { kind: 'willSeal' }
	| { kind: 'keyChanged'; addresses: string[] }
	| { kind: 'cannotSeal'; reason: SealSkipReason };

/** The three visual tones the lock renders in. FF tokens map off this in the component. */
export type SealLockTone = 'ok' | 'warn' | 'muted';

export interface ComposerLockResult {
	/** Discriminator carried through to the component for styling + branching. */
	kind: SealState['kind'];
	/** Short lock label. */
	summary: string;
	/** Plain-language explanation. */
	detail: string;
	tone: SealLockTone;
	icon: string;
	/**
	 * True ONLY for `cannotSeal`: sending in plaintext must be an explicit act, so
	 * the composer shows a distinct "Send unsealed" control rather than sealing
	 * silently or blocking. `willSeal` seals automatically; `keyChanged` defers to
	 * the key-change banner's re-accept before it can seal.
	 */
	allowSendUnsealed: boolean;
}

/**
 * Human-readable list join: "a", "a and b", "a, b and c". Plain language — no
 * Oxford comma, no crypto jargon.
 */
function joinAddresses(addresses: string[]): string {
	if (addresses.length === 0) return 'a recipient';
	if (addresses.length === 1) return addresses[0] as string;
	const head = addresses.slice(0, -1).join(', ');
	return `${head} and ${addresses[addresses.length - 1]}`;
}

/**
 * Plain-language reason copy for a `cannotSeal` state. Every branch is asserted
 * verbatim in the honesty test. The fallback keeps the union total without ever
 * over-claiming — it still says the message goes out unsealed.
 */
function cannotSealDetail(reason: SealSkipReason): string {
	switch (reason) {
		case 'policy_off':
			return 'Sealed mail is turned off for your workspace, so this message will be sent normally.';
		case 'recipient_no_key':
			return "Some of your recipients can't receive sealed mail yet, so this message will be sent normally.";
		case 'no_recipients':
			return 'Add a recipient to see whether this message can be sealed.';
		case 'no_signing_key':
			return "This address doesn't have a sealing key yet, so this message will be sent normally.";
		case 'policy_ask':
			return 'Sealed mail is available for these recipients. Turn it on for this message, or send it normally.';
		case 'flag_off':
			return 'Sealed mail is not available yet, so this message will be sent normally.';
		case 'key_changed':
			return "A recipient's key changed and needs review, so this message will be sent normally until you confirm it.";
	}
}

/**
 * Derive the composer lock indicator from a draft's seal state. Pure — no I/O —
 * so the honesty audit can enumerate every reachable string against its state.
 */
export function deriveComposerLock(state: SealState): ComposerLockResult {
	switch (state.kind) {
		case 'willSeal':
			return {
				kind: 'willSeal',
				summary: 'This message will be sealed',
				detail:
					'Everyone you are writing to can receive sealed mail, so Owlat will encrypt this message before it leaves your workspace.',
				tone: 'ok',
				icon: 'lucide:lock',
				allowSendUnsealed: false,
			};
		case 'keyChanged':
			return {
				kind: 'keyChanged',
				summary: "A recipient's key changed",
				detail: `The sealing key for ${joinAddresses(state.addresses)} changed since you last sealed mail to them. Review and confirm the new key before Owlat will seal to it.`,
				tone: 'warn',
				icon: 'lucide:key-round',
				allowSendUnsealed: false,
			};
		case 'cannotSeal':
			return {
				kind: 'cannotSeal',
				summary: "This message won't be sealed",
				detail: cannotSealDetail(state.reason),
				tone: 'muted',
				icon: 'lucide:lock-open',
				allowSendUnsealed: true,
			};
	}
}
