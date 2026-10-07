/**
 * RFC 3156 first-part extraction — the byte-exactness half of the F1 hard gate.
 *
 * The detached signature covers the first `multipart/signed` body part exactly
 * as transmitted, so the extractor must return those bytes UNTOUCHED: CRLF
 * intact, content-transfer-encoding NOT decoded, trailing whitespace and
 * padding preserved. These tests COMPOSE messages from a known part (including
 * a seeded-PRNG property sweep over bodies/CTEs/boundaries) and assert the
 * extraction is byte-identical to what was composed — plus the malformed
 * structures that must resolve to `null`, never a throw.
 */

import { describe, it, expect } from 'vitest';
import { extractRfc3156SignedPart } from '../rfc3156.js';

const ARMOR = [
	'-----BEGIN PGP SIGNATURE-----',
	'',
	'iQIzBAABCgAdFiEETESTTESTTESTTESTTESTTESTTESTTESTFAKE=',
	'=AbCd',
	'-----END PGP SIGNATURE-----',
].join('\r\n');

/** Compose a multipart/signed message around an exact first-part byte string. */
function compose(
	signedPart: string,
	opts: {
		boundary?: string;
		micalg?: string;
		preamble?: string;
		signatureCte?: 'base64' | 'quoted-printable';
		foldedContentType?: boolean;
		padding?: string;
	} = {}
): string {
	const boundary = opts.boundary ?? 'owlat-sig-boundary';
	const micalg = opts.micalg ?? 'pgp-sha256';
	const contentType = opts.foldedContentType
		? `Content-Type: multipart/signed; micalg=${micalg};\r\n\tprotocol="application/pgp-signature"; boundary="${boundary}"`
		: `Content-Type: multipart/signed; micalg=${micalg}; protocol="application/pgp-signature"; boundary="${boundary}"`;
	const sigHeaders = ['Content-Type: application/pgp-signature; name="signature.asc"'];
	let sigBody = ARMOR;
	if (opts.signatureCte === 'base64') {
		sigHeaders.push('Content-Transfer-Encoding: base64');
		sigBody = Buffer.from(ARMOR, 'latin1').toString('base64');
	} else if (opts.signatureCte === 'quoted-printable') {
		sigHeaders.push('Content-Transfer-Encoding: quoted-printable');
		sigBody = ARMOR.replace(/=/g, '=3D').replace(/-/g, '=2D');
	}
	const pad = opts.padding ?? '';
	return [
		'From: alice@sender.test',
		'To: bob@example.com',
		'Subject: signed message',
		'MIME-Version: 1.0',
		contentType,
		'',
		...(opts.preamble !== undefined ? [opts.preamble] : []),
		`--${boundary}${pad}`,
		signedPart,
		`--${boundary}${pad}`,
		...sigHeaders,
		'',
		sigBody,
		`--${boundary}--`,
		'',
	].join('\r\n');
}

function extract(raw: string) {
	return extractRfc3156SignedPart(Buffer.from(raw, 'latin1'));
}

function partText(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('latin1');
}

const SIMPLE_PART = [
	'Content-Type: text/plain; charset=utf-8',
	'Content-Transfer-Encoding: quoted-printable',
	'',
	'Byte-exact body with trailing spaces   ',
	'and a soft break=',
	'line.',
].join('\r\n');

describe('extractRfc3156SignedPart — byte-exactness', () => {
	it('returns the first part byte-for-byte (CRLF + CTE preserved, no decode)', () => {
		const result = extract(compose(SIMPLE_PART));
		expect(result).not.toBeNull();
		expect(partText(result!.signedPart)).toBe(SIMPLE_PART);
		expect(result!.signatureArmored).toBe(ARMOR);
		expect(result!.micalg).toBe('pgp-sha256');
	});

	it('preserves a base64 first part UNdecoded (the signature covers the encoded form)', () => {
		const part = [
			'Content-Type: application/octet-stream',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('binary\r\ncontent\0here', 'latin1').toString('base64'),
		].join('\r\n');
		const result = extract(compose(part));
		expect(partText(result!.signedPart)).toBe(part);
	});

	it('handles a folded outer Content-Type and a preamble before the first boundary', () => {
		const result = extract(
			compose(SIMPLE_PART, { foldedContentType: true, preamble: 'This is a MIME preamble.' })
		);
		expect(partText(result!.signedPart)).toBe(SIMPLE_PART);
	});

	it('keeps a NESTED multipart first part intact (inner boundary is inert)', () => {
		const inner = 'inner-boundary';
		const part = [
			`Content-Type: multipart/mixed; boundary="${inner}"`,
			'',
			`--${inner}`,
			'Content-Type: text/plain',
			'',
			'nested text',
			`--${inner}`,
			'Content-Type: application/pdf; name="a.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			'JVBERi0xLjQ=',
			`--${inner}--`,
		].join('\r\n');
		const result = extract(compose(part));
		expect(partText(result!.signedPart)).toBe(part);
	});

	it('a body line that merely STARTS with the boundary text is not a delimiter', () => {
		const boundary = 'bnd';
		const part = [
			'Content-Type: text/plain',
			'',
			`--${boundary}-not-a-delimiter`, // prefix collision inside the part
			'still the first part',
		].join('\r\n');
		const result = extract(compose(part, { boundary }));
		expect(partText(result!.signedPart)).toBe(part);
	});

	it('tolerates transport padding after the boundary and a base64/qp-encoded signature part', () => {
		for (const signatureCte of ['base64', 'quoted-printable'] as const) {
			const result = extract(compose(SIMPLE_PART, { signatureCte, padding: ' \t' }));
			expect(partText(result!.signedPart)).toBe(SIMPLE_PART);
			expect(result!.signatureArmored).toBe(ARMOR);
		}
	});

	it('omits micalg when the outer content-type does not carry one', () => {
		const raw = compose(SIMPLE_PART).replace('micalg=pgp-sha256; ', '');
		const result = extract(raw);
		expect(result!.micalg).toBeUndefined();
		expect(partText(result!.signedPart)).toBe(SIMPLE_PART);
	});
});

/**
 * Property sweep: for ANY composed message, extraction returns exactly the
 * bytes that were composed in — across random bodies (including boundary-like
 * lines, trailing WSP, blank runs, high-bit bytes), random CTE declarations,
 * random boundaries, and optional preamble/padding. Seeded PRNG so a failure
 * reproduces.
 */
describe('extractRfc3156SignedPart — composed-fixture properties', () => {
	// Mulberry32 — tiny deterministic PRNG.
	function prng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function pick<T>(rand: () => number, items: readonly T[]): T {
		return items[Math.floor(rand() * items.length)] as T;
	}

	it('round-trips 200 random composed fixtures byte-exactly', () => {
		const rand = prng(0x3156);
		const cteLines = [
			'Content-Transfer-Encoding: 7bit',
			'Content-Transfer-Encoding: quoted-printable',
			'Content-Transfer-Encoding: base64',
			'Content-Transfer-Encoding: 8bit',
		];
		for (let i = 0; i < 200; i++) {
			const boundary = `b-${Math.floor(rand() * 1e9).toString(36)}`;
			const lineCount = 1 + Math.floor(rand() * 8);
			const bodyLines: string[] = [];
			for (let l = 0; l < lineCount; l++) {
				bodyLines.push(
					pick(rand, [
						'plain text line',
						'trailing spaces   ',
						'', // blank line inside the part
						`--${boundary}x`, // boundary-prefix collision
						'-- ', // signature separator lookalike
						'high-bit éü bytes',
						'=E2=98=83 qp-looking line',
						'QmFzZTY0IGxvb2tpbmcgbGluZQ==',
					])
				);
			}
			const part = [
				'Content-Type: text/plain; charset=utf-8',
				pick(rand, cteLines),
				'',
				...bodyLines,
			].join('\r\n');
			const raw = compose(part, {
				boundary,
				preamble: rand() < 0.3 ? 'preamble' : undefined,
				padding: rand() < 0.3 ? ' ' : '',
				signatureCte: rand() < 0.3 ? 'base64' : undefined,
				foldedContentType: rand() < 0.5,
			});
			const result = extract(raw);
			expect(result, `fixture ${i} (boundary ${boundary})`).not.toBeNull();
			expect(partText(result!.signedPart), `fixture ${i}`).toBe(part);
			expect(result!.signatureArmored, `fixture ${i}`).toBe(ARMOR);
		}
	});
});

describe('extractRfc3156SignedPart — malformed structures resolve to null', () => {
	it('rejects a non-multipart/signed message', () => {
		const raw = ['Content-Type: text/plain', '', 'hello', ''].join('\r\n');
		expect(extract(raw)).toBeNull();
	});

	it('rejects multipart/signed without a boundary parameter', () => {
		const raw = [
			'Content-Type: multipart/signed; protocol="application/pgp-signature"',
			'',
			'--x',
			'Content-Type: text/plain',
			'',
			'hi',
			'--x--',
			'',
		].join('\r\n');
		expect(extract(raw)).toBeNull();
	});

	it('rejects a message with no header/body split', () => {
		expect(extract('Content-Type: multipart/signed; boundary="b"')).toBeNull();
	});

	it('rejects a single-part message (no second delimiter)', () => {
		const raw = [
			'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain',
			'',
			'only part',
			'',
		].join('\r\n');
		expect(extract(raw)).toBeNull();
	});

	it('rejects a missing close-delimiter after the signature part', () => {
		const raw = [
			'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain',
			'',
			'part',
			'--b',
			'Content-Type: application/pgp-signature',
			'',
			ARMOR,
			'', // no --b-- close-delimiter
		].join('\r\n');
		expect(extract(raw)).toBeNull();
	});

	it('rejects a third part after the signature part (RFC 1847: exactly two parts)', () => {
		const raw = compose(SIMPLE_PART).replace(
			'--owlat-sig-boundary--',
			[
				'--owlat-sig-boundary',
				'Content-Type: text/html; charset=utf-8',
				'',
				'<p>not covered by the signature</p>',
				'--owlat-sig-boundary--',
			].join('\r\n')
		);
		expect(extract(raw)).toBeNull();
	});

	it('rejects a close-delimiter with junk after it (a MIME parser reads past it)', () => {
		const raw = compose(SIMPLE_PART).replace(
			'--owlat-sig-boundary--',
			'--owlat-sig-boundary--extra'
		);
		expect(extract(raw)).toBeNull();
	});

	it('accepts transport padding after the close-delimiter', () => {
		const raw = compose(SIMPLE_PART).replace('--owlat-sig-boundary--', '--owlat-sig-boundary-- \t');
		expect(extract(raw)).not.toBeNull();
	});

	it('still accepts an epilogue after the close-delimiter', () => {
		const raw = `${compose(SIMPLE_PART)}epilogue text that no reader renders\r\n`;
		expect(extract(raw)).not.toBeNull();
	});

	it('rejects a second part that is not application/pgp-signature', () => {
		const raw = compose(SIMPLE_PART).replace(
			'Content-Type: application/pgp-signature; name="signature.asc"',
			'Content-Type: application/octet-stream'
		);
		expect(extract(raw)).toBeNull();
	});

	it('rejects a signature part whose body carries no armor', () => {
		const raw = compose(SIMPLE_PART).replaceAll(ARMOR, 'not an armored signature');
		expect(extract(raw)).toBeNull();
	});

	it('rejects an immediately-closed multipart (close-delimiter as first boundary)', () => {
		const raw = [
			'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"',
			'',
			'--b--',
			'',
		].join('\r\n');
		expect(extract(raw)).toBeNull();
	});
});
