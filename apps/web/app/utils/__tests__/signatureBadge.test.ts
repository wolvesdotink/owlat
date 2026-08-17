/**
 * Reader signature-badge derivation honesty audit (F2, D9) — the same
 * exhaustive verdict→copy audit the sealed (`sealedMessage.test.ts`) and
 * sender-auth (`senderAuth.test.ts`) drivers carry. The cardinal rules:
 *
 *   - "Signed · verified" is UNREACHABLE unless the signature verified against
 *     the pinned/discovered sender key (isSignatureValid AND a
 *     signerFingerprint present AND a real key source);
 *   - a verdict the verifier could not produce (`verification_error`, or an
 *     inconsistent record) renders NO claim — null → the structural
 *     "not verified" fallback — never "verified", never "invalid";
 *   - a present SEALED record always silences this driver (precedence:
 *     sealed record → signature record → structural class).
 */
import { describe, it, expect } from 'vitest';
import { deriveSignatureBadge, type InboundSignatureInfo } from '../signatureBadge';
import type { InboundEncryptionInfo } from '../sealedMessage';

const VERIFIED: InboundSignatureInfo = {
	isSigned: true,
	isSignatureValid: true,
	signerFingerprint: 'AABBCCDD00112233AABBCCDD00112233AABBCCDD',
	keySource: 'wkd',
};

const SEALED: InboundEncryptionInfo = {
	isSealed: true,
	isDecrypted: true,
	cipherSuite: 'pgp-mime',
	isSignatureValid: true,
	signerFingerprint: 'AABBCCDD00112233',
};

describe('deriveSignatureBadge', () => {
	it('returns null with no record (plaintext / pre-F1 row → structural fallback)', () => {
		expect(deriveSignatureBadge(undefined)).toBeNull();
	});

	it('PRECEDENCE: a present sealed record silences the signature driver entirely', () => {
		expect(deriveSignatureBadge(VERIFIED, SEALED)).toBeNull();
		// Even an undecryptable sealed record wins — the sealed driver renders it.
		expect(deriveSignatureBadge(VERIFIED, { isSealed: true, isDecrypted: false })).toBeNull();
	});

	it('verified: verbatim summary, ok tone, fingerprint + key source in the tooltip', () => {
		const badge = deriveSignatureBadge(VERIFIED);
		expect(badge?.state).toBe('verified');
		expect(badge?.summary).toBe('Signed · verified');
		expect(badge?.tone).toBe('ok');
		expect(badge?.fingerprint).toBe('AABB CCDD 0011 2233 AABB CCDD 0011 2233 AABB CCDD');
		// The short form is the fingerprint's last-16-hex tail (see `shortFingerprint`).
		expect(badge?.fingerprintShort).toBe('0011 2233 AABB CCDD');
		expect(badge?.tooltip).toContain('AABB CCDD 0011 2233 AABB CCDD 0011 2233 AABB CCDD');
		expect(badge?.tooltip).toContain("the sender's key directory (WKD)");
	});

	it('verified via a pinned key names the pin as the key source', () => {
		const badge = deriveSignatureBadge({ ...VERIFIED, keySource: 'pinned' });
		expect(badge?.state).toBe('verified');
		expect(badge?.tooltip).toContain('the trusted key on file for this sender');
	});

	it('verified via a manifest-discovered key names the manifest as the key source', () => {
		const badge = deriveSignatureBadge({ ...VERIFIED, keySource: 'manifest' });
		expect(badge?.state).toBe('verified');
		expect(badge?.tooltip).toContain("the sender's instance manifest");
	});

	it('HONESTY: signatureValid but NO signer fingerprint claims nothing (null → "not verified")', () => {
		expect(
			deriveSignatureBadge({ isSigned: true, isSignatureValid: true, keySource: 'wkd' })
		).toBeNull();
	});

	it('HONESTY: signatureValid with keySource not_found is inconsistent — claims nothing', () => {
		expect(
			deriveSignatureBadge({
				isSigned: true,
				isSignatureValid: true,
				signerFingerprint: 'AABBCCDD00112233',
				keySource: 'not_found',
			})
		).toBeNull();
	});

	it('HONESTY: a present fingerprint with signatureValid=false is NOT verified', () => {
		const badge = deriveSignatureBadge({
			isSigned: true,
			isSignatureValid: false,
			signerFingerprint: 'AABBCCDD00112233',
			keySource: 'wkd',
		});
		expect(badge?.state).toBe('invalid');
		expect(badge?.summary).toBe('Signed · signature invalid');
	});

	it('invalid: crypto ran against a real key and did not verify → verbatim copy, warn tone', () => {
		const badge = deriveSignatureBadge({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
		});
		expect(badge?.state).toBe('invalid');
		expect(badge?.summary).toBe('Signed · signature invalid');
		expect(badge?.tone).toBe('warn');
		expect(badge?.tooltip).toContain('may have been altered');
		expect(badge?.fingerprint).toBeUndefined();
	});

	it('invalid: a malformed signature part is rendered as invalid, not as an error', () => {
		const badge = deriveSignatureBadge({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'wkd',
			failure: 'malformed_signature',
		});
		expect(badge?.state).toBe('invalid');
		expect(badge?.summary).toBe('Signed · signature invalid');
	});

	it('key not found: verbatim copy, muted tone (an unknown sender, not a bad one)', () => {
		const badge = deriveSignatureBadge({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'not_found',
		});
		expect(badge?.state).toBe('keyNotFound');
		expect(badge?.summary).toBe('Signed · sender key not found');
		expect(badge?.tone).toBe('muted');
		expect(badge?.tooltip).toContain("couldn't be checked");
	});

	it('key changed: pin refusal → verbatim copy, danger tone', () => {
		const badge = deriveSignatureBadge({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
			failure: 'key_changed',
		});
		expect(badge?.state).toBe('keyChanged');
		expect(badge?.summary).toBe('Signed · sender key changed');
		expect(badge?.tone).toBe('danger');
		expect(badge?.tooltip).toContain('review the key change');
	});

	it('HONESTY: a verifier failure claims nothing — not "invalid", never "verified"', () => {
		// F1 writes exactly this shape when the verify action itself errored.
		expect(
			deriveSignatureBadge({
				isSigned: true,
				isSignatureValid: false,
				keySource: 'not_found',
				failure: 'verification_error',
			})
		).toBeNull();
	});

	it('the "verified" summary is unreachable across every non-verified shape', () => {
		const nonVerified: InboundSignatureInfo[] = [
			{ isSigned: true, isSignatureValid: false, keySource: 'wkd' },
			{ isSigned: true, isSignatureValid: false, keySource: 'not_found' },
			{ isSigned: true, isSignatureValid: false, keySource: 'pinned', failure: 'key_changed' },
			{ isSigned: true, isSignatureValid: false, keySource: 'wkd', failure: 'malformed_signature' },
			{
				isSigned: true,
				isSignatureValid: false,
				keySource: 'not_found',
				failure: 'verification_error',
			},
			{ isSigned: true, isSignatureValid: true, keySource: 'wkd' },
			{ isSigned: true, isSignatureValid: false, keySource: 'wkd', signerFingerprint: 'DEAD' },
		];
		for (const info of nonVerified) {
			expect(deriveSignatureBadge(info)?.summary).not.toBe('Signed · verified');
		}
	});
});
