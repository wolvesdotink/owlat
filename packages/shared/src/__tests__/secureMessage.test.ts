import { describe, it, expect } from 'vitest';
import {
	classifySecureMessage,
	classifyRawSecureMessage,
	extractArmoredCiphertext,
	extractClearsignedBlock,
	extractClearsignedText,
	isClearsigned,
	isEncryptedClass,
	isSignedPgpMime,
} from '../secureMessage';

/** A real, structurally complete inline clearsigned body (RFC 4880 §7). */
const CLEARSIGNED_BODY = [
	'-----BEGIN PGP SIGNED MESSAGE-----',
	'Hash: SHA256',
	'',
	'Hello there',
	'-----BEGIN PGP SIGNATURE-----',
	'',
	'iQEcBAEBCgAGBQJ...',
	'-----END PGP SIGNATURE-----',
].join('\n');

/** The same body as a reply would quote it back — every line prefixed. */
function quoted(body: string, prefix = '> '): string {
	return body
		.split('\n')
		.map((line) => `${prefix}${line}`)
		.join('\n');
}

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
		expect(classifySecureMessage({ textBody: CLEARSIGNED_BODY })).toBe('pgp-clearsigned');
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
			attachments: [{ contentType: 'application/pkcs7-mime', filename: 'smime.p7m' }],
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

/**
 * The F1 raw-message structural gates — server twins of the classifier above.
 * Ingest (`mail/delivery.ts`) consumes these on the RAW RFC 5322 text, so they
 * are locked against real wire shapes here where the classifier lives.
 */
describe('raw-message gates — isSignedPgpMime / isClearsigned', () => {
	const signedRaw = [
		'From: alice@sender.test',
		'To: bob@example.com',
		'Subject: signed',
		'MIME-Version: 1.0',
		'Content-Type: multipart/signed; micalg=pgp-sha256;',
		'\tprotocol="application/pgp-signature"; boundary="sig-b"',
		'',
		'--sig-b',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Signed content.',
		'--sig-b',
		'Content-Type: application/pgp-signature; name="signature.asc"',
		'',
		'-----BEGIN PGP SIGNATURE-----',
		'',
		'iQ..',
		'-----END PGP SIGNATURE-----',
		'--sig-b--',
		'',
	].join('\r\n');

	const clearsignedRaw = [
		'From: alice@sender.test',
		'Subject: clearsigned',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'-----BEGIN PGP SIGNED MESSAGE-----',
		'Hash: SHA256',
		'',
		'Hello',
		'-----BEGIN PGP SIGNATURE-----',
		'iQ..',
		'-----END PGP SIGNATURE-----',
		'',
	].join('\r\n');

	const encryptedRaw = [
		'Content-Type: multipart/encrypted;',
		'\tprotocol="application/pgp-encrypted"; boundary="enc-b"',
		'',
		'--enc-b',
		'Content-Type: application/pgp-encrypted',
		'',
		'Version: 1',
		'--enc-b',
		'Content-Type: application/octet-stream',
		'',
		'-----BEGIN PGP MESSAGE-----',
		'hQ..',
		'-----END PGP MESSAGE-----',
		'--enc-b--',
		'',
	].join('\r\n');

	it('detects RFC 3156 multipart/signed (folded protocol parameter included)', () => {
		expect(isSignedPgpMime(signedRaw)).toBe(true);
		expect(isClearsigned(signedRaw)).toBe(false);
		expect(classifyRawSecureMessage(signedRaw)).toBe('pgp-signed');
	});

	it('detects an inline clearsigned body', () => {
		expect(isClearsigned(clearsignedRaw)).toBe(true);
		expect(isSignedPgpMime(clearsignedRaw)).toBe(false);
	});

	it('an ENCRYPTED message is neither signed-plaintext nor clearsigned (sealed path wins)', () => {
		expect(isSignedPgpMime(encryptedRaw)).toBe(false);
		expect(isClearsigned(encryptedRaw)).toBe(false);
		expect(isEncryptedClass(classifyRawSecureMessage(encryptedRaw))).toBe(true);
	});

	it('plaintext mail passes both gates untouched', () => {
		const plain = 'From: x@y.z\r\nSubject: hi\r\n\r\nJust text.\r\n';
		expect(isSignedPgpMime(plain)).toBe(false);
		expect(isClearsigned(plain)).toBe(false);
		expect(classifyRawSecureMessage(plain)).toBe('none');
	});
});

/**
 * FU1: innocent mail must never reach the warn-tone "signature invalid" badge.
 * Merely CONTAINING armor (a reply quoting a signed message) or naming a
 * content type used to classify as signed; the sender's key would then resolve,
 * verification of the quoted armor would fail, and mail nobody signed rendered
 * as "Signed · signature invalid". The structural gates therefore require armor
 * at an UNQUOTED line start plus the full clearsign structure — and the client
 * classifier and the raw server twin are asserted side by side here so they
 * cannot drift.
 */
describe('structural gates reject quoted / merely-mentioned armor', () => {
	const REPLY_HEADERS = ['From: bob@example.com', 'Subject: Re: signed', '', ''].join('\r\n');

	it('a plaintext reply quoting a clearsigned message is not signed', () => {
		const body = `Thanks, got it.\n\nOn Monday, alice wrote:\n${quoted(CLEARSIGNED_BODY)}\n`;
		expect(classifySecureMessage({ textBody: body })).toBe('none');
		expect(classifyRawSecureMessage(REPLY_HEADERS + body)).toBe('none');
		expect(isClearsigned(REPLY_HEADERS + body)).toBe(false);
	});

	it.each([
		['double quote', '>> '],
		['tight quote', '>'],
		['indented quote', '  > '],
		['tab-indented quote', '\t> '],
		['plain indent', '  '],
	])('%s prefixes keep the armor out of the clearsign gate', (_label, prefix) => {
		const body = `see below\n${quoted(CLEARSIGNED_BODY, prefix)}\n`;
		expect(classifySecureMessage({ textBody: body })).toBe('none');
		expect(isClearsigned(body)).toBe(false);
	});

	it('a quoted encrypted block does not make the reply encrypted', () => {
		const body = `no idea what this is:\n${quoted('-----BEGIN PGP MESSAGE-----\nhQ..\n-----END PGP MESSAGE-----')}\n`;
		expect(classifySecureMessage({ textBody: body })).toBe('none');
		expect(isEncryptedClass(classifyRawSecureMessage(REPLY_HEADERS + body))).toBe(false);
	});

	it('CRLF quoting is rejected too (the wire form of the same reply)', () => {
		const raw = (REPLY_HEADERS + quoted(CLEARSIGNED_BODY) + '\n').replace(/\n/g, '\r\n');
		expect(isClearsigned(raw)).toBe(false);
		expect(classifyRawSecureMessage(raw)).toBe('none');
	});

	it('a clearsign header with no signature block is a mention, not a signature', () => {
		const body = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhi';
		expect(classifySecureMessage({ textBody: body })).toBe('none');
		expect(isClearsigned(body)).toBe(false);
	});

	it('a body that merely names the pgp-signature content type is not signed', () => {
		const raw = [
			'From: alice@sender.test',
			'Subject: how does PGP/MIME work?',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'The second part is labelled',
			'Content-Type: application/pgp-signature',
			'and carries the armor. Right?',
			'',
		].join('\r\n');
		expect(isSignedPgpMime(raw)).toBe(false);
		expect(classifyRawSecureMessage(raw)).toBe('none');
	});

	it('a quoted detached-signature part does not corroborate a signed classification', () => {
		const raw = [
			'From: bob@example.com',
			'Subject: Re: signed',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Here is what your mailer sent:',
			'Content-Type: application/pgp-signature; name="signature.asc"',
			'> -----BEGIN PGP SIGNATURE-----',
			'> iQ..',
			'> -----END PGP SIGNATURE-----',
			'',
		].join('\r\n');
		expect(isSignedPgpMime(raw)).toBe(false);
		expect(classifyRawSecureMessage(raw)).toBe('none');
	});

	it('real clearsigned mail still classifies — armor on the first line', () => {
		expect(classifySecureMessage({ textBody: CLEARSIGNED_BODY })).toBe('pgp-clearsigned');
		expect(isClearsigned(CLEARSIGNED_BODY)).toBe(true);
	});

	it('real clearsigned mail still classifies — armor after a preamble line', () => {
		const body = `Signed as always.\n\n${CLEARSIGNED_BODY}\n`;
		expect(classifySecureMessage({ textBody: body })).toBe('pgp-clearsigned');
		expect(isClearsigned(body)).toBe(true);
	});

	it('a clearsigned reply that also quotes one is signed, and its OWN block is extracted', () => {
		const body = `${CLEARSIGNED_BODY}\n\nOn Monday, alice wrote:\n${quoted(CLEARSIGNED_BODY.replace('Hello there', 'Quoted original'))}\n`;
		expect(classifySecureMessage({ textBody: body })).toBe('pgp-clearsigned');
		expect(extractClearsignedText(body)).toBe('Hello there');
		expect(extractClearsignedBlock(body)).toBe(CLEARSIGNED_BODY);
	});

	it('the quoted-armor reply yields no clearsign block to verify', () => {
		const body = `nothing signed here\n${quoted(CLEARSIGNED_BODY)}\n`;
		expect(extractClearsignedBlock(body)).toBeNull();
		expect(extractClearsignedText(body)).toBeNull();
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
