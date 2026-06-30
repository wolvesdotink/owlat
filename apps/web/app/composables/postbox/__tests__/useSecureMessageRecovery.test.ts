/**
 * Recovery-path tests for the reader's encrypted-message escape hatch.
 *
 * The reader hides an encrypted (unreadable) body and renders PostboxSecurityBadge
 * instead. For an inline ("armored") encrypted body the ciphertext lives in the
 * body — there is no separate PGP/MIME part to download — so the badge must offer
 * a no-network "Copy encrypted message" control that yields the exact ciphertext,
 * or the user is stranded with an unreadable, unrecoverable message.
 *
 * A PGP/MIME message keeps its ciphertext in a downloadable octet-stream part, so
 * there is nothing inline to copy: recovery there is the reader's attachment row
 * (which renders unconditionally for `msg.attachments.length > 0`). We lock that
 * the inline-copy control is NOT offered for that shape.
 *
 * We assert the pure recovery model rather than mounting the SFC — the badge is a
 * thin shell over `computeSecureMessageRecovery` (mirrors the postboxSanitize
 * test, which tests the pure config the component renders from).
 *
 * RFC 3156 (PGP/MIME), RFC 4880 §6.2 (ASCII armor), RFC 8551 (S/MIME).
 */
import { describe, it, expect } from 'vitest';
import { computeSecureMessageRecovery } from '../useSecureMessageRecovery';

const ARMORED = [
	'-----BEGIN PGP MESSAGE-----',
	'',
	'hQEMA1234567890abcdefGENCRYPTEDPAYLOAD',
	'=AbCd',
	'-----END PGP MESSAGE-----',
].join('\n');

describe('computeSecureMessageRecovery — inline-armored encrypted body', () => {
	it('offers a copy control that yields the armored ciphertext', () => {
		const r = computeSecureMessageRecovery('pgp-encrypted', `Hi,\n\n${ARMORED}\n\nbye`);
		expect(r.isEncrypted).toBe(true);
		expect(r.canCopyCiphertext).toBe(true);
		expect(r.armoredCiphertext).toBe(ARMORED);
	});

	it('still treats smime-encrypted as encrypted', () => {
		const r = computeSecureMessageRecovery('smime-encrypted', undefined);
		expect(r.isEncrypted).toBe(true);
	});
});

describe('computeSecureMessageRecovery — PGP/MIME part shape (regression-lock)', () => {
	it('offers NO inline copy when the ciphertext is in a part, not the body', () => {
		// PGP/MIME: classified pgp-encrypted from the part content-type, but the
		// body carries no armor block — recovery is the reader's attachment row.
		const r = computeSecureMessageRecovery('pgp-encrypted', 'Version: 1\n');
		expect(r.isEncrypted).toBe(true);
		expect(r.armoredCiphertext).toBeNull();
		expect(r.canCopyCiphertext).toBe(false);
	});

	it('offers NO inline copy for an encrypted message with no body at all', () => {
		const r = computeSecureMessageRecovery('pgp-encrypted', undefined);
		expect(r.canCopyCiphertext).toBe(false);
	});
});

describe('computeSecureMessageRecovery — non-encrypted classes', () => {
	it('signed / clearsigned / none offer no recovery controls', () => {
		for (const klass of ['pgp-signed', 'pgp-clearsigned', 'smime-signed', 'none'] as const) {
			const r = computeSecureMessageRecovery(klass, ARMORED);
			expect(r.isEncrypted).toBe(false);
			expect(r.canCopyCiphertext).toBe(false);
			expect(r.armoredCiphertext).toBeNull();
		}
	});
});
