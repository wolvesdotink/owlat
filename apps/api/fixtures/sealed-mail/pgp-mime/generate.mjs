/**
 * Offline, developer-only regenerator for the PGP/MIME interop fixtures.
 *
 * Produces REAL OpenPGP material with the checked-in `openpgp` dependency (no
 * GnuPG required), so CI never needs `gpg`:
 *   - good-sig.eml         detached signature that VERIFIES over the signed part
 *   - bad-sig.eml          signature over the ORIGINAL body; embedded body was
 *                          modified, so verification MUST fail
 *   - protected-headers.eml PGP/MIME multipart/encrypted; decrypts to an inner
 *                          MIME part whose Subject is the real one (outer Subject
 *                          stays the literal "..." per locked decision D4)
 *
 * The throwaway test keys (alice/bob, public + private) are committed alongside
 * so verification/decryption is reproducible. They protect nothing — regenerate
 * freely.
 *
 * Run (from apps/api, where `openpgp` resolves):
 *   node convex/../fixtures/sealed-mail/pgp-mime/generate.mjs
 * or point NODE_PATH at any dir with `openpgp` installed.
 *
 * All message bytes use CRLF (RFC 5322 / RFC 3156); .gitattributes exempts this
 * corpus from EOL normalization so the signed bytes stay exact.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as openpgp from 'openpgp';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRLF = '\r\n';
const crlf = (lines) => lines.join(CRLF);

async function main() {
	const { privateKey: aliceArmored, publicKey: alicePubArmored } = await openpgp.generateKey({
		type: 'ecc',
		curve: 'curve25519',
		userIDs: [{ name: 'Alice', email: 'alice@sealed.example.com' }],
		format: 'armored',
	});
	const { privateKey: bobArmored, publicKey: bobPubArmored } = await openpgp.generateKey({
		type: 'ecc',
		curve: 'curve25519',
		userIDs: [{ name: 'Bob', email: 'bob@sealed.example.org' }],
		format: 'armored',
	});

	const aliceKey = await openpgp.readPrivateKey({ armoredKey: aliceArmored });
	const alicePub = await openpgp.readKey({ armoredKey: alicePubArmored });
	const bobKey = await openpgp.readPrivateKey({ armoredKey: bobArmored });
	const bobPub = await openpgp.readKey({ armoredKey: bobPubArmored });

	// --- good-sig.eml -------------------------------------------------------
	// The signed part is the entire first MIME entity (its headers + blank line
	// + body), canonical CRLF, with NO trailing CRLF (the CRLF before the
	// boundary belongs to the delimiter). openpgp normalizes text to CRLF for
	// the signature computation, so a verifier extracting these exact bytes
	// succeeds.
	const goodSignedPart = crlf([
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Hello Bob,',
		'',
		'This body is covered by a valid detached OpenPGP signature.',
		'',
		'-- Alice',
	]);
	const goodSig = await openpgp.sign({
		message: await openpgp.createMessage({ text: goodSignedPart }),
		signingKeys: aliceKey,
		detached: true,
		format: 'armored',
	});
	writeEml('good-sig.eml', [
		'From: Alice <alice@sealed.example.com>',
		'To: Bob <bob@sealed.example.org>',
		'Subject: Signed hello',
		'Date: Fri, 11 Jul 2026 12:00:00 +0000',
		'Message-ID: <good-sig-0001@sealed.example.com>',
		'MIME-Version: 1.0',
		'Content-Type: multipart/signed; micalg=pgp-sha256;',
		' protocol="application/pgp-signature"; boundary="sig-boundary-good"',
		'',
		'--sig-boundary-good',
		goodSignedPart,
		'--sig-boundary-good',
		'Content-Type: application/pgp-signature; name="signature.asc"',
		'Content-Description: OpenPGP digital signature',
		'Content-Disposition: attachment; filename="signature.asc"',
		'',
		goodSig.trimEnd(),
		'',
		'--sig-boundary-good--',
		'',
	]);

	// --- bad-sig.eml --------------------------------------------------------
	// Sign the ORIGINAL body, then embed a MODIFIED body: verification fails.
	const badOriginalPart = crlf([
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Hello Bob,',
		'',
		'This is the ORIGINAL body that was actually signed.',
		'',
		'-- Alice',
	]);
	const badModifiedPart = crlf([
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Hello Bob,',
		'',
		'This body was MODIFIED after signing, so the signature must not verify.',
		'',
		'-- Alice',
	]);
	const badSig = await openpgp.sign({
		message: await openpgp.createMessage({ text: badOriginalPart }),
		signingKeys: aliceKey,
		detached: true,
		format: 'armored',
	});
	writeEml('bad-sig.eml', [
		'From: Alice <alice@sealed.example.com>',
		'To: Bob <bob@sealed.example.org>',
		'Subject: Tampered hello',
		'Date: Fri, 11 Jul 2026 12:05:00 +0000',
		'Message-ID: <bad-sig-0001@sealed.example.com>',
		'MIME-Version: 1.0',
		'Content-Type: multipart/signed; micalg=pgp-sha256;',
		' protocol="application/pgp-signature"; boundary="sig-boundary-bad"',
		'',
		'--sig-boundary-bad',
		badModifiedPart,
		'--sig-boundary-bad',
		'Content-Type: application/pgp-signature; name="signature.asc"',
		'Content-Description: OpenPGP digital signature',
		'Content-Disposition: attachment; filename="signature.asc"',
		'',
		badSig.trimEnd(),
		'',
		'--sig-boundary-bad--',
		'',
	]);

	// --- protected-headers.eml ---------------------------------------------
	// Real subject travels inside the encrypted part; outer Subject is "..." (D4).
	const innerPart = crlf([
		'Content-Type: text/plain; charset=utf-8',
		'Subject: Quarterly key rotation plan',
		'',
		'Hello Bob,',
		'',
		'This body is encrypted with PGP/MIME. The real subject is carried in the',
		'protected headers above; the outer envelope shows only "...".',
		'',
		'-- Alice',
	]);
	const encrypted = await openpgp.encrypt({
		message: await openpgp.createMessage({ text: innerPart }),
		encryptionKeys: bobPub,
		format: 'armored',
	});
	writeEml('protected-headers.eml', [
		'From: Alice <alice@sealed.example.com>',
		'To: Bob <bob@sealed.example.org>',
		'Subject: ...',
		'Date: Fri, 11 Jul 2026 12:15:00 +0000',
		'Message-ID: <protected-headers-0001@sealed.example.com>',
		'MIME-Version: 1.0',
		'Content-Type: multipart/encrypted;',
		' protocol="application/pgp-encrypted"; boundary="enc-boundary-ph"',
		'',
		'--enc-boundary-ph',
		'Content-Type: application/pgp-encrypted',
		'Content-Description: PGP/MIME version identification',
		'',
		'Version: 1',
		'',
		'--enc-boundary-ph',
		'Content-Type: application/octet-stream; name="encrypted.asc"',
		'Content-Description: OpenPGP encrypted message',
		'Content-Disposition: inline; filename="encrypted.asc"',
		'',
		encrypted.trimEnd(),
		'',
		'--enc-boundary-ph--',
		'',
	]);

	// Commit the throwaway keys so verification is reproducible offline.
	writeFileSync(join(HERE, 'keys', 'alice.pub.asc'), alicePubArmored);
	writeFileSync(join(HERE, 'keys', 'alice.sec.asc'), aliceArmored);
	writeFileSync(join(HERE, 'keys', 'bob.pub.asc'), bobPubArmored);
	writeFileSync(join(HERE, 'keys', 'bob.sec.asc'), bobArmored);

	// --- self-verify (fail loudly if the material is not real) -------------
	const goodOk = await verifyDetached(goodSignedPart, goodSig, alicePub);
	if (!goodOk) throw new Error('good-sig did not verify');
	const badOk = await verifyDetached(badModifiedPart, badSig, alicePub);
	if (badOk) throw new Error('bad-sig unexpectedly verified');
	const dec = await openpgp.decrypt({
		message: await openpgp.readMessage({ armoredMessage: encrypted }),
		decryptionKeys: bobKey,
	});
	if (!String(dec.data).includes('Quarterly key rotation plan')) {
		throw new Error('protected-headers did not decrypt to the inner subject');
	}
	console.info('OK: good-sig verifies, bad-sig fails, protected-headers decrypts');
}

async function verifyDetached(text, armoredSignature, verificationKey) {
	const verification = await openpgp.verify({
		message: await openpgp.createMessage({ text }),
		signature: await openpgp.readSignature({ armoredSignature }),
		verificationKeys: verificationKey,
	});
	try {
		await verification.signatures[0].verified;
		return true;
	} catch {
		return false;
	}
}

function writeEml(name, lines) {
	writeFileSync(join(HERE, name), lines.join(CRLF), 'latin1');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
