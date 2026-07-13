/**
 * Reader sealed-badge derivation for Sealed Mail (E5, flag `sealedMail`). Turns
 * the inbound sealing record persisted at decrypt-on-ingest (D3,
 * `mailMessages.inboundEncryptionInfo`) into ONE honest badge state.
 *
 * The cardinal rule (the honesty audit is a test, not a vibe): a state may never
 * claim more than what was cryptographically checked. "Sealed — sender verified"
 * is reachable ONLY when the message decrypted AND its signature verified against
 * the pinned sender key — i.e. `isSignatureValid === true` AND a `signerFingerprint`
 * is present (the pin match). Any weaker combination renders "Sealed — sender not
 * verified"; an undecryptable ciphertext renders the "can't decrypt" state.
 *
 * This is the web-side mirror of the Convex `InboundEncryptionInfo` union (single
 * source is `e2ee/inboundSeal.ts`); the boundary keeps its own copy per this
 * app's existing cross-package pattern (see `utils/senderAuth.ts`).
 */

/** Web mirror of the Convex `InboundEncryptionInfo` union (`e2ee/inboundSeal.ts`). */
export type InboundEncryptionInfo =
	| {
			isSealed: true;
			isDecrypted: true;
			cipherSuite: string;
			isSignatureValid: boolean;
			signerFingerprint?: string;
			signerInstance?: string;
	  }
	| { isSealed: true; isDecrypted: false };

export type SealedBadgeState = 'verified' | 'unverified' | 'cantDecrypt';

export interface SealedBadgeResult {
	state: SealedBadgeState;
	/** Short chip label. */
	summary: string;
	/** Expandable plain-language explanation. */
	detail: string;
	tone: 'ok' | 'warn';
	icon: string;
}

/**
 * Derive the reader's sealed badge from the inbound encryption record. Pure — no
 * side effects — so the honesty audit can enumerate every reachable string
 * against its condition. Returns `null` when there is no sealing record at all (a
 * plaintext message, or a legacy row): the reader shows no sealed badge rather
 * than asserting anything.
 */
export function deriveSealedBadge(
	info: InboundEncryptionInfo | undefined
): SealedBadgeResult | null {
	if (!info) return null;

	// Sealed on the wire but we hold no usable key — nothing decrypted, so no
	// signature claim is representable. This is the "Encrypted — can't decrypt"
	// state (the pre-Sealed-Mail behaviour), now driven by the honest record.
	if (!info.isDecrypted) {
		return {
			state: 'cantDecrypt',
			summary: "Encrypted — can't decrypt",
			detail:
				"This message was encrypted just for its recipient, and Owlat doesn't hold a key that can open it.",
			tone: 'warn',
			icon: 'lucide:lock',
		};
	}

	// The ONLY path to "verified": the body decrypted AND its signature verified
	// against the PINNED sender key. `isSignatureValid` alone is not enough — a
	// verified signature always carries the signer's fingerprint (the pin match),
	// so we require both. This double gate is the honesty audit.
	if (info.isSignatureValid && !!info.signerFingerprint) {
		return {
			state: 'verified',
			summary: 'Sealed — sender verified',
			detail:
				'This message was encrypted end-to-end, and we confirmed it was really signed by the sender.',
			tone: 'ok',
			icon: 'lucide:lock',
		};
	}

	// Decrypted, but the signature did not verify against the pinned sender key
	// (or no signer fingerprint was recovered). We opened it, but we can't vouch
	// for who signed it.
	return {
		state: 'unverified',
		summary: 'Sealed — sender not verified',
		detail: "This message was encrypted end-to-end, but we couldn't confirm who signed it.",
		tone: 'warn',
		icon: 'lucide:lock',
	};
}
