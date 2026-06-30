import {
	extractArmoredCiphertext,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';

/**
 * Recovery model for an encrypted message in the reader.
 *
 * The reader hides an encrypted (unreadable) body, so it must give the user a
 * way to get the ciphertext out and decrypt it externally — otherwise an inline
 * ("armored") encrypted message, whose ciphertext lives in the body rather than
 * a downloadable PGP/MIME part, leaves the user stranded.
 *
 * Two shapes:
 *   - inline-armored: the body carries a `-----BEGIN PGP MESSAGE-----` block.
 *     We can `copy` the exact ciphertext with no network round-trip.
 *   - PGP/MIME: the ciphertext is a separate octet-stream part (recovered via
 *     the reader's attachment row), so there is nothing inline to copy.
 *
 * Either way the raw `.eml` download is offered (it carries headers + every
 * part), with the inline armor as a fallback when the raw blob is unavailable.
 *
 * Pure / framework-light so it can be unit-tested without mounting the SFC.
 */
export interface SecureMessageRecovery {
	/** True for pgp-encrypted / smime-encrypted classes. */
	isEncrypted: boolean;
	/** The inline armored ciphertext block, or null for the PGP/MIME shape. */
	armoredCiphertext: string | null;
	/** Whether a no-network "copy ciphertext" control should be offered. */
	canCopyCiphertext: boolean;
}

export function computeSecureMessageRecovery(
	klass: SecureMessageClass,
	textBody: string | undefined
): SecureMessageRecovery {
	const isEncrypted = isEncryptedClass(klass);
	const armoredCiphertext =
		isEncrypted && textBody ? extractArmoredCiphertext(textBody) : null;
	return {
		isEncrypted,
		armoredCiphertext,
		canCopyCiphertext: armoredCiphertext !== null,
	};
}
