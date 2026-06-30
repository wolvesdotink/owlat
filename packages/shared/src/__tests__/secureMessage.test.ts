import { describe, it, expect } from 'vitest';
import {
	classifySecureMessage,
	extractArmoredCiphertext,
	extractClearsignedText,
	isEncryptedClass,
} from '../secureMessage';

describe('classifySecureMessage', () => {
	it('detects PGP/MIME signed + encrypted from part content types', () => {
		expect(
			classifySecureMessage({ attachments: [{ contentType: 'application/pgp-signature' }] })
		).toBe('pgp-signed');
		expect(
			classifySecureMessage({ attachments: [{ contentType: 'application/pgp-encrypted' }] })
		).toBe('pgp-encrypted');
	});

	it('detects S/MIME signed + encrypted', () => {
		expect(
			classifySecureMessage({ attachments: [{ contentType: 'application/pkcs7-signature' }] })
		).toBe('smime-signed');
		expect(
			classifySecureMessage({ attachments: [{ contentType: 'application/x-pkcs7-mime' }] })
		).toBe('smime-encrypted');
	});

	it('detects inline armored PGP from the body', () => {
		expect(classifySecureMessage({ textBody: 'x\n-----BEGIN PGP MESSAGE-----\n...' })).toBe(
			'pgp-encrypted'
		);
		expect(
			classifySecureMessage({ textBody: '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhi' })
		).toBe('pgp-clearsigned');
	});

	it('returns none for ordinary mail', () => {
		expect(
			classifySecureMessage({
				attachments: [{ contentType: 'application/pdf', filename: 'a.pdf' }],
				textBody: 'hello',
			})
		).toBe('none');
	});

	it('flags encrypted classes', () => {
		expect(isEncryptedClass('pgp-encrypted')).toBe(true);
		expect(isEncryptedClass('smime-encrypted')).toBe(true);
		expect(isEncryptedClass('pgp-signed')).toBe(false);
		expect(isEncryptedClass('none')).toBe(false);
	});
});

describe('extractClearsignedText', () => {
	it('extracts the cleartext and undoes dash-escaping', () => {
		const body = [
			'-----BEGIN PGP SIGNED MESSAGE-----',
			'Hash: SHA256',
			'',
			'Hello world',
			'- -----dashed line',
			'-----BEGIN PGP SIGNATURE-----',
			'iQEcBAEBCgAGBQJ...',
			'-----END PGP SIGNATURE-----',
		].join('\n');
		expect(extractClearsignedText(body)).toBe('Hello world\n-----dashed line');
	});

	it('returns null for non-clearsigned bodies', () => {
		expect(extractClearsignedText('just a normal message')).toBeNull();
	});

	it('tolerates CRLF line endings', () => {
		const body = [
			'-----BEGIN PGP SIGNED MESSAGE-----',
			'Hash: SHA256',
			'',
			'Hello CRLF',
			'-----BEGIN PGP SIGNATURE-----',
			'sig',
			'-----END PGP SIGNATURE-----',
		].join('\r\n');
		expect(extractClearsignedText(body)).toBe('Hello CRLF');
	});
});

/**
 * Lock the classifier against the part shapes of real RFC 3156 / RFC 8551
 * messages. The `attachments` here mirror what the MIME parser records for each
 * leaf part of these canonical structures, so a future refactor can't silently
 * regress the wire-format detection — including its KNOWN coarseness (S/MIME
 * signed-data is reported as `smime-encrypted` because owlat does not parse the
 * PKCS#7 smime-type, only the pkcs7-mime content-type).
 */
describe('classifySecureMessage — real RFC fixtures', () => {
	it('RFC 3156 multipart/encrypted (protocol application/pgp-encrypted) -> pgp-encrypted', () => {
		// Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"
		//   part 1: Content-Type: application/pgp-encrypted  (Version: 1)
		//   part 2: Content-Type: application/octet-stream   (the ciphertext)
		const cls = classifySecureMessage({
			attachments: [
				{ contentType: 'application/pgp-encrypted' },
				{ contentType: 'application/octet-stream', filename: 'encrypted.asc' },
			],
		});
		expect(cls).toBe('pgp-encrypted');
		expect(isEncryptedClass(cls)).toBe(true);
	});

	it('RFC 3156 multipart/signed (protocol application/pgp-signature) -> pgp-signed', () => {
		// Content-Type: multipart/signed; protocol="application/pgp-signature"
		//   part 1: the signed text/plain payload
		//   part 2: Content-Type: application/pgp-signature  (signature.asc)
		const cls = classifySecureMessage({
			attachments: [
				{ contentType: 'text/plain' },
				{ contentType: 'application/pgp-signature', filename: 'signature.asc' },
			],
			textBody: 'The signed message body.',
		});
		expect(cls).toBe('pgp-signed');
		expect(isEncryptedClass(cls)).toBe(false);
	});

	it('RFC 8551 S/MIME pkcs7-mime smime-type=signed-data -> smime-encrypted (known coarseness)', () => {
		// Content-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"
		// This is actually a SIGNED message, but owlat keys only off the
		// pkcs7-mime content-type, so it is reported as smime-encrypted. This
		// assertion DOCUMENTS that limitation rather than claiming correctness.
		const cls = classifySecureMessage({
			attachments: [
				{ contentType: 'application/pkcs7-mime', filename: 'smime.p7m' },
			],
		});
		expect(cls).toBe('smime-encrypted');
	});

	it('RFC 8551 S/MIME multipart/signed (application/pkcs7-signature) -> smime-signed', () => {
		const cls = classifySecureMessage({
			attachments: [
				{ contentType: 'text/plain' },
				{ contentType: 'application/pkcs7-signature', filename: 'smime.p7s' },
			],
		});
		expect(cls).toBe('smime-signed');
	});

	it('detects an inline-armored encrypted body with no PGP/MIME part', () => {
		const cls = classifySecureMessage({
			attachments: [],
			textBody: 'see below\n-----BEGIN PGP MESSAGE-----\nhQ..\n-----END PGP MESSAGE-----\n',
		});
		expect(cls).toBe('pgp-encrypted');
	});
});

describe('extractArmoredCiphertext', () => {
	const ARMORED = [
		'-----BEGIN PGP MESSAGE-----',
		'',
		'hQEMA1234567890abcdefPAYLOAD',
		'=AbCd',
		'-----END PGP MESSAGE-----',
	].join('\n');

	it('returns the full armored block from an inline body', () => {
		expect(extractArmoredCiphertext(`Hi there,\n\n${ARMORED}\n\nregards`)).toBe(ARMORED);
	});

	it('normalizes CRLF to LF', () => {
		const crlf = ARMORED.replace(/\n/g, '\r\n');
		expect(extractArmoredCiphertext(`prefix\r\n${crlf}`)).toBe(ARMORED);
	});

	it('recovers a truncated block (header but no footer)', () => {
		const truncated = '-----BEGIN PGP MESSAGE-----\n\nhQEMApayload-no-footer';
		expect(extractArmoredCiphertext(truncated)).toBe(truncated.trim());
	});

	it('returns null when the body holds no armored block', () => {
		expect(extractArmoredCiphertext('just a normal message')).toBeNull();
		// A PGP/MIME message keeps its ciphertext in a part, not the body, so the
		// inline-recovery escape hatch does not apply (the attachment row does).
		expect(extractArmoredCiphertext('Version: 1')).toBeNull();
	});
});
