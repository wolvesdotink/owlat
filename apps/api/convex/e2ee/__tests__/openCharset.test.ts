/**
 * Inbound unsealing reads the decrypted inner message byte-exactly (#1284).
 *
 * Every case is a real OpenPGP round trip: the inner message is encrypted and
 * signed with `openpgp`, opened by `openSealed`, and restored by
 * `parseInnerMessage`. The inner message used to be decoded as UTF-8 as a whole
 * before its parts were extracted, so an 8-bit part lost every non-ASCII
 * character: `Price — 5€` came out as `Price \u0014 5�`.
 */

import * as openpgp from 'openpgp';
import { describe, it, expect, beforeAll } from 'vitest';
import { sealMime } from '../seal';
import { openSealed } from '../open';
import { parseInnerMessage } from '../inboundSeal';
import { generateTestKeypair, utf8Text, type TestKeypair } from './sealedMailTestHelpers';

const PRICE = 'Price — 5€';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** ISO-8859-1 bytes of `text` (every char must be at most U+00FF). */
function latin1(text: string): Uint8Array {
	return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** A single-part inner message: ASCII headers, then the body bytes as given. */
function innerBytes(headers: string[], body: Uint8Array): Uint8Array {
	return concat(utf8(`${headers.join('\r\n')}\r\n\r\n`), body);
}

let recipient: TestKeypair;
let sender: TestKeypair;

beforeAll(async () => {
	recipient = await generateTestKeypair('bob@b.instance.test');
	sender = await generateTestKeypair('alice@a.instance.test');
});

/** A PGP/MIME message whose encrypted payload is exactly `inner`. */
async function sealBytes(inner: Uint8Array): Promise<string> {
	const armored = (await openpgp.encrypt({
		message: await openpgp.createMessage({ binary: inner }),
		encryptionKeys: await openpgp.readKey({ armoredKey: recipient.publicKeyArmored }),
		signingKeys: await openpgp.readPrivateKey({ armoredKey: sender.privateKeyArmored }),
		format: 'armored',
	})) as string;
	return [
		'From: alice@a.instance.test',
		'To: bob@b.instance.test',
		'Subject: ...',
		'MIME-Version: 1.0',
		'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"',
		'',
		'--enc',
		'Content-Type: application/pgp-encrypted',
		'',
		'Version: 1',
		'--enc',
		'Content-Type: application/octet-stream; name="encrypted.asc"',
		'',
		armored,
		'--enc--',
		'',
	].join('\r\n');
}

/** Open a sealed message and return the decrypted bytes (asserting it verified). */
async function open(raw: string): Promise<Uint8Array> {
	const outcome = await openSealed({
		raw,
		recipientPrivateKeysArmored: [recipient.privateKeyArmored],
		senderPublicKeyArmored: sender.publicKeyArmored,
	});
	if (outcome.status !== 'opened') throw new Error('expected the message to open');
	expect(outcome.signatureValid).toBe(true);
	return outcome.innerMime;
}

async function roundTrip(inner: Uint8Array) {
	const decrypted = await open(await sealBytes(inner));
	expect(Buffer.from(decrypted)).toEqual(Buffer.from(inner));
	return parseInnerMessage(decrypted);
}

describe('e2ee/open · inner parts decode under their declared charset (#1284)', () => {
	it('restores an 8-bit UTF-8 part sealed by sealMime', async () => {
		const inner = [
			'From: alice@a.instance.test',
			'To: bob@b.instance.test',
			'Subject: Figures',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 8bit',
			'',
			PRICE,
		].join('\r\n');
		const sealed = await sealMime(inner, {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});

		const restored = parseInnerMessage(await open(sealed.mime));
		expect(restored.text).toBe(PRICE);
		expect(restored.subject).toBe('Figures');
	});

	it('restores 8-bit UTF-8 text and html branches of a multipart inner', async () => {
		const restored = await roundTrip(
			utf8(
				[
					'Subject: Figures',
					'MIME-Version: 1.0',
					'Content-Type: multipart/alternative; boundary="alt"',
					'',
					'--alt',
					'Content-Type: text/plain; charset=utf-8',
					'Content-Transfer-Encoding: 8bit',
					'',
					PRICE,
					'--alt',
					'Content-Type: text/html; charset=utf-8',
					'Content-Transfer-Encoding: 8bit',
					'',
					`<p>${PRICE}</p>`,
					'--alt--',
					'',
				].join('\r\n')
			)
		);
		expect(restored.text).toBe(PRICE);
		expect(restored.html).toBe(`<p>${PRICE}</p>`);
	});

	it('restores an 8-bit ISO-8859-1 part by its declared charset', async () => {
		const restored = await roundTrip(
			innerBytes(
				[
					'Subject: Grüße',
					'MIME-Version: 1.0',
					'Content-Type: text/plain; charset="iso-8859-1"',
					'Content-Transfer-Encoding: 8bit',
				],
				latin1('Grüße aus dem Café, 5 £')
			)
		);
		expect(restored.text).toBe('Grüße aus dem Café, 5 £');
	});

	it('leaves quoted-printable and base64 UTF-8 parts unchanged', async () => {
		const qp = await roundTrip(
			utf8(
				[
					'MIME-Version: 1.0',
					'Content-Type: text/plain; charset=utf-8',
					'Content-Transfer-Encoding: quoted-printable',
					'',
					'Price =E2=80=94 5=E2=82=AC',
				].join('\r\n')
			)
		);
		expect(qp.text).toBe(PRICE);

		const b64 = await roundTrip(
			utf8(
				[
					'MIME-Version: 1.0',
					'Content-Type: text/html; charset=utf-8',
					'Content-Transfer-Encoding: base64',
					'',
					Buffer.from(`<p>${PRICE}</p>`, 'utf-8').toString('base64'),
				].join('\r\n')
			)
		);
		expect(b64.html).toBe(`<p>${PRICE}</p>`);
	});

	it('reads a part that declares no charset as UTF-8, as before', async () => {
		const restored = await roundTrip(
			utf8(
				[
					'MIME-Version: 1.0',
					'Content-Type: text/plain',
					'Content-Transfer-Encoding: quoted-printable',
					'',
					'Price =E2=80=94 5=E2=82=AC',
				].join('\r\n')
			)
		);
		expect(restored.text).toBe(PRICE);
	});

	it('honors a quoted-printable ISO-8859-1 part', async () => {
		const restored = await roundTrip(
			utf8(
				[
					'MIME-Version: 1.0',
					'Content-Type: text/plain; charset=iso-8859-1',
					'Content-Transfer-Encoding: quoted-printable',
					'',
					'Gr=FC=DFe aus dem Caf=E9',
				].join('\r\n')
			)
		);
		expect(restored.text).toBe('Grüße aus dem Café');
	});

	it('restores a bare-text inline-armored payload as UTF-8', async () => {
		const bare = `First line: ${PRICE}\r\n\r\nSecond paragraph, no MIME headers.`;
		const armored = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: bare }),
			encryptionKeys: await openpgp.readKey({ armoredKey: recipient.publicKeyArmored }),
			signingKeys: await openpgp.readPrivateKey({ armoredKey: sender.privateKeyArmored }),
			format: 'armored',
		})) as string;
		const raw = ['From: alice@a.instance.test', 'Subject: ...', '', armored].join('\r\n');

		const decrypted = await open(raw);
		const restored = parseInnerMessage(decrypted);
		expect(restored.text).toBe(utf8Text(decrypted));
		expect(restored.text).toContain(`First line: ${PRICE}`);
		expect(restored.text).toContain('Second paragraph');
		expect(restored.subject).toBeUndefined();
	});
});

describe('e2ee/open · protected headers decode (#1284)', () => {
	const body = (subjectLine: string): Uint8Array =>
		utf8(
			[
				subjectLine,
				'MIME-Version: 1.0',
				'Content-Type: text/plain; charset=utf-8',
				'Content-Transfer-Encoding: 8bit',
				'',
				PRICE,
			].join('\r\n')
		);

	it('decodes an RFC 2047 encoded protected subject', async () => {
		const encoded = Buffer.from('Preis — 5€', 'utf-8').toString('base64');
		const restored = await roundTrip(body(`Subject: =?UTF-8?B?${encoded}?=`));
		expect(restored.subject).toBe('Preis — 5€');
		expect(restored.text).toBe(PRICE);
	});

	it('decodes adjacent RFC 2047 words in their own charset across a fold', async () => {
		const restored = await roundTrip(
			body('Subject: =?ISO-8859-1?Q?Gr=FC=DFe_aus?=\r\n =?ISO-8859-1?Q?_dem_Caf=E9?=')
		);
		expect(restored.subject).toBe('Grüße aus dem Café');
	});

	it('decodes a raw UTF-8 protected subject (RFC 6532)', async () => {
		const restored = await roundTrip(body('Subject: Preis — 5€'));
		expect(restored.subject).toBe('Preis — 5€');
		expect(restored.text).toBe(PRICE);
	});

	it.each([
		['à', 'Voilà'],
		['Р', 'Привет, Р'],
		['😠', 'Grr 😠'],
	])('keeps a raw UTF-8 subject whose last character is %s', async (_last, subject) => {
		// Each of these ends in the byte 0xA0, which String#trim takes for a
		// no-break space when it runs on the bytes instead of the text.
		const restored = await roundTrip(body(`Subject: ${subject}`));
		expect(restored.subject).toBe(subject);
	});

	it('unfolds a folded raw UTF-8 subject', async () => {
		const restored = await roundTrip(body('Subject: Grüße aus\r\n dem Café, voilà'));
		expect(restored.subject).toBe('Grüße aus dem Café, voilà');
	});

	it.each([
		['Q', '=?UTF-8?Q?hello=0D=0A*_BYE_x?='],
		['B', `=?UTF-8?B?${Buffer.from('hello\r\n* BYE x', 'utf-8').toString('base64')}?=`],
	])('turns CR/LF from a %s-encoded subject into a space', async (_enc, encoded) => {
		const restored = await roundTrip(body(`Subject: ${encoded}`));
		expect(restored.subject).toBe('hello * BYE x');
		expect(restored.subject).not.toMatch(/[\r\n]/);
	});

	it('replaces other control characters from an encoded subject but keeps TAB', async () => {
		const restored = await roundTrip(body('Subject: =?UTF-8?Q?a=00b=07_=1B_c=09d=7F?='));
		expect(restored.subject).toBe('a b c\td');
	});

	it('still finds the headers behind a leading UTF-8 byte-order mark', async () => {
		const restored = await roundTrip(
			concat(Uint8Array.of(0xef, 0xbb, 0xbf), body('Subject: Preis — 5€'))
		);
		expect(restored.subject).toBe('Preis — 5€');
		expect(restored.text).toBe(PRICE);
	});
});
