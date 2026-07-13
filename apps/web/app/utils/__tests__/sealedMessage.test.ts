/**
 * Reader sealed-badge derivation honesty audit (Sealed Mail E5). The cardinal
 * rule: "Sealed — sender verified" is UNREACHABLE unless the message decrypted
 * AND its signature verified against the pinned sender key (signatureValid AND a
 * signerFingerprint present — the pin match). Every weaker combination reads
 * "not verified"; an undecryptable ciphertext reads "can't decrypt".
 */
import { describe, it, expect } from 'vitest';
import { deriveSealedBadge, type InboundEncryptionInfo } from '../sealedMessage';

const VERIFIED: InboundEncryptionInfo = {
	sealed: true,
	decrypted: true,
	cipherSuite: 'pgp-mime',
	signatureValid: true,
	signerFingerprint: 'AABBCCDD00112233',
	signerInstance: 'b.test',
};

describe('deriveSealedBadge', () => {
	it('returns null with no record (plaintext / legacy row → no sealed badge)', () => {
		expect(deriveSealedBadge(undefined)).toBeNull();
	});

	it('verified: verbatim summary + detail ONLY when signatureValid AND a signer fingerprint', () => {
		const badge = deriveSealedBadge(VERIFIED);
		expect(badge?.state).toBe('verified');
		expect(badge?.summary).toBe('Sealed — sender verified');
		expect(badge?.detail).toBe(
			'This message was encrypted end-to-end, and we confirmed it was really signed by the sender.'
		);
		expect(badge?.tone).toBe('ok');
	});

	it('HONESTY: signatureValid but NO signer fingerprint is NOT verified', () => {
		const badge = deriveSealedBadge({
			sealed: true,
			decrypted: true,
			cipherSuite: 'pgp-mime',
			signatureValid: true,
			// no signerFingerprint → no pin match → cannot claim verified
		});
		expect(badge?.state).toBe('unverified');
		expect(badge?.summary).toBe('Sealed — sender not verified');
	});

	it('HONESTY: a present fingerprint with signatureValid=false is NOT verified', () => {
		const badge = deriveSealedBadge({
			sealed: true,
			decrypted: true,
			cipherSuite: 'pgp-mime',
			signatureValid: false,
			signerFingerprint: 'AABBCCDD00112233',
		});
		expect(badge?.state).toBe('unverified');
		expect(badge?.summary).toBe('Sealed — sender not verified');
	});

	it('unverified: verbatim copy', () => {
		const badge = deriveSealedBadge({
			sealed: true,
			decrypted: true,
			cipherSuite: 'pgp-mime',
			signatureValid: false,
		});
		expect(badge?.detail).toBe(
			"This message was encrypted end-to-end, but we couldn't confirm who signed it."
		);
		expect(badge?.tone).toBe('warn');
	});

	it("can't decrypt: verbatim copy, warn tone", () => {
		const badge = deriveSealedBadge({ sealed: true, decrypted: false });
		expect(badge?.state).toBe('cantDecrypt');
		expect(badge?.summary).toBe("Encrypted — can't decrypt");
		expect(badge?.detail).toBe(
			"This message was encrypted just for its recipient, and Owlat doesn't hold a key that can open it."
		);
		expect(badge?.tone).toBe('warn');
	});

	it('the "verified" summary is unreachable across every non-verified shape', () => {
		const nonVerified: InboundEncryptionInfo[] = [
			{ sealed: true, decrypted: false },
			{ sealed: true, decrypted: true, cipherSuite: 'pgp-mime', signatureValid: false },
			{ sealed: true, decrypted: true, cipherSuite: 'pgp-mime', signatureValid: true },
			{
				sealed: true,
				decrypted: true,
				cipherSuite: 'pgp-mime',
				signatureValid: false,
				signerFingerprint: 'DEAD',
			},
		];
		for (const info of nonVerified) {
			expect(deriveSealedBadge(info)?.summary).not.toBe('Sealed — sender verified');
		}
	});
});
