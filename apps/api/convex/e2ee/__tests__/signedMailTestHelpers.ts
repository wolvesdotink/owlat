/**
 * Shared scaffolding for the F1 inbound-signature test surfaces
 * (`e2ee/__tests__/verifyInboundSignature.test.ts`,
 * `mail/__tests__/deliverySignedIngest.integration.test.ts`): compose real
 * RFC 3156 `multipart/signed` messages and inline clearsigned bodies from an
 * OpenPGP keypair, CRLF throughout, so both suites sign/verify the exact same
 * wire shapes. The keypair generator + pinned-sender seeding live next door in
 * `sealedMailTestHelpers.ts` and are reused as-is.
 */

import * as openpgp from 'openpgp';

/** A canonical text/plain first part (headers + body) with CRLF line endings. */
export function signedFirstPart(body: string): string {
	return [
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		body,
	].join('\r\n');
}

/** Detached-sign exact part text (already CRLF) with an armored private key. */
export async function detachedSign(part: string, privateKeyArmored: string): Promise<string> {
	const signingKeys = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
	return (await openpgp.sign({
		message: await openpgp.createMessage({ text: part }),
		signingKeys,
		detached: true,
		format: 'armored',
	})) as string;
}

/**
 * The `Content-Transfer-Encoding` the signature part is transmitted with. Armor
 * is 7-bit ASCII, so `7bit` is the common shape — but the part body is subject
 * to transfer encoding like any other, and mailers do ship `signature.asc`
 * base64- or quoted-printable-encoded. Under `base64` no literal armor line
 * survives in the raw text at all, which is exactly the shape the raw
 * structural gate has to keep recognising.
 */
export type SignaturePartEncoding = '7bit' | 'base64' | 'quoted-printable';

/** Encode an armor block as the signature part's body lines for `encoding`. */
function signaturePartBody(armor: string, encoding: SignaturePartEncoding): string[] {
	const crlfArmor = armor.trim().replace(/\r?\n/g, '\r\n');
	if (encoding === 'base64') {
		return (
			Buffer.from(crlfArmor, 'utf8')
				.toString('base64')
				.match(/.{1,76}/g) ?? []
		);
	}
	if (encoding === 'quoted-printable') {
		// RFC 2045 §6.7: armor is printable ASCII well under the 76-column limit,
		// so only `=` (the checksum line, base64 padding) needs escaping.
		return crlfArmor.split('\r\n').map((line) => line.replace(/=/g, '=3D'));
	}
	return crlfArmor.split('\r\n');
}

/**
 * Compose a full RFC 3156 `multipart/signed` message around an exact
 * (already-signed) first part. CRLF throughout, per the wire format. The first
 * part is emitted byte-for-byte — only the SIGNATURE part is ever re-encoded,
 * so the detached signature stays valid for every `signatureEncoding`.
 */
export function composeSignedPgpMime(args: {
	from: string;
	to: string;
	subject: string;
	part: string;
	signatureArmored: string;
	messageId: string;
	boundary?: string;
	signatureEncoding?: SignaturePartEncoding;
}): string {
	const boundary = args.boundary ?? 'owlat-f1-signed';
	const encoding = args.signatureEncoding ?? '7bit';
	return [
		`Message-ID: ${args.messageId}`,
		'Date: Sun, 16 Aug 2026 09:00:00 +0000',
		`From: ${args.from}`,
		`To: ${args.to}`,
		`Subject: ${args.subject}`,
		'MIME-Version: 1.0',
		'Content-Type: multipart/signed; micalg=pgp-sha256;',
		`\tprotocol="application/pgp-signature"; boundary="${boundary}"`,
		'',
		`--${boundary}`,
		args.part,
		`--${boundary}`,
		'Content-Type: application/pgp-signature; name="signature.asc"',
		...(encoding === '7bit' ? [] : [`Content-Transfer-Encoding: ${encoding}`]),
		'',
		...signaturePartBody(args.signatureArmored, encoding),
		`--${boundary}--`,
		'',
	].join('\r\n');
}

/** Clearsign text with an armored private key (returns the full armor block, LF). */
export async function clearsign(text: string, privateKeyArmored: string): Promise<string> {
	const signingKeys = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
	return (await openpgp.sign({
		message: await openpgp.createCleartextMessage({ text }),
		signingKeys,
	})) as string;
}

/** Compose a plain text/plain message whose body is a clearsigned block. */
export function composeClearsignedMessage(args: {
	from: string;
	to: string;
	subject: string;
	clearsignArmor: string;
	messageId: string;
}): string {
	return [
		`Message-ID: ${args.messageId}`,
		'Date: Sun, 16 Aug 2026 09:00:00 +0000',
		`From: ${args.from}`,
		`To: ${args.to}`,
		`Subject: ${args.subject}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		...args.clearsignArmor.trim().split('\n'),
		'',
	].join('\r\n');
}
