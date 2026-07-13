/**
 * Outbound sealing — the hard test gate for the E3 `sealMime` piece.
 *
 *   (a) STRUCTURE + HONESTY — the output is PGP/MIME (multipart/encrypted, the
 *       `application/pgp-encrypted` protocol part), it decrypts with the
 *       recipient key AND its signature verifies with the sender key, the REAL
 *       subject travels inside the ciphertext while the OUTER subject is the
 *       literal placeholder "..." (locked decision D4), and no plaintext canary
 *       survives in the outer message.
 *   (b) ATTACHMENTS SURVIVE — a base64 attachment part round-trips inside.
 *   (c) ALL RECIPIENTS — encrypting to two keys lets EITHER private key open it.
 *   (d) CROSS-CHECK FIXTURE — the committed `protected-headers-input.eml` is
 *       sealed, decrypted, signature-verified, and structurally compared to the
 *       fixture (GnuPG re-verification is documented as QA follow-up in the
 *       fixtures README; openpgp.js is the automated regression here).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { classifySecureMessage } from '@owlat/shared/secureMessage';
import { sealMime, OUTER_SUBJECT_PLACEHOLDER } from '../seal';

interface TestKeypair {
	fingerprint: string;
	publicKeyArmored: string;
	privateKeyArmored: string;
}

async function generateTestKeypair(email: string): Promise<TestKeypair> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		type: 'curve25519',
		userIDs: [{ name: email, email }],
		format: 'armored',
	});
	const key = await openpgp.readKey({ armoredKey: publicKey });
	return {
		fingerprint: key.getFingerprint().toUpperCase(),
		publicKeyArmored: publicKey,
		privateKeyArmored: privateKey,
	};
}

const CANARY = 'CANARY_SEALED_BODY_9d1e7a';
const REAL_SUBJECT = 'Secret quarterly numbers';

function sampleMessage(): string {
	return [
		'Message-ID: <plain-0001@a.instance.test>',
		'Date: Mon, 13 Jul 2026 09:00:00 +0000',
		'From: alice@a.instance.test',
		'To: bob@b.instance.test',
		`Subject: ${REAL_SUBJECT}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 7bit',
		'',
		`Here are the ${CANARY} figures you asked for.`,
		'',
	].join('\r\n');
}

async function decryptInner(
	armoredCiphertext: string,
	recipientPrivateKeyArmored: string,
	senderPublicKeyArmored: string
): Promise<{ inner: string; signatureValid: boolean }> {
	const message = await openpgp.readMessage({ armoredMessage: armoredCiphertext });
	const decryptionKeys = await openpgp.readPrivateKey({ armoredKey: recipientPrivateKeyArmored });
	const verificationKeys = await openpgp.readKey({ armoredKey: senderPublicKeyArmored });
	const { data, signatures } = await openpgp.decrypt({
		message,
		decryptionKeys,
		verificationKeys,
		format: 'binary',
	});
	const inner = new TextDecoder().decode(data as Uint8Array);
	// Fail CLOSED: an UNSIGNED sealMime output yields an empty `signatures` array,
	// and `await undefined` would otherwise resolve and report a bogus valid
	// signature. Assert a signature is actually present before verifying it.
	const [sig] = signatures;
	if (!sig) {
		throw new Error('sealed message carried no signatures — signing is fail-open');
	}
	let signatureValid = false;
	try {
		await sig.verified;
		signatureValid = true;
	} catch {
		signatureValid = false;
	}
	return { inner, signatureValid };
}

describe('e2ee/seal · sealMime', () => {
	it('produces PGP/MIME with protected headers that decrypts + verifies', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');

		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});

		// PGP/MIME structure.
		expect(sealed.mime).toContain(
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"'
		);
		expect(sealed.mime).toContain('Content-Type: application/pgp-encrypted');
		// The armored body classifies as an encrypted PGP message.
		expect(classifySecureMessage({ textBody: sealed.armoredCiphertext })).toBe('pgp-encrypted');

		// Outer subject is the placeholder; the real subject + canary never leak out.
		expect(sealed.outerSubject).toBe(OUTER_SUBJECT_PLACEHOLDER);
		expect(sealed.mime).toMatch(/^Subject: \.\.\.\r?$/m);
		expect(sealed.mime).not.toContain(REAL_SUBJECT);
		expect(sealed.mime).not.toContain(CANARY);

		// Decrypt + verify — the real subject + body live INSIDE.
		const { inner, signatureValid } = await decryptInner(
			sealed.armoredCiphertext,
			recipient.privateKeyArmored,
			sender.publicKeyArmored
		);
		expect(signatureValid).toBe(true);
		expect(inner).toContain(`Subject: ${REAL_SUBJECT}`);
		expect(inner).toContain(CANARY);
		// Protected-headers marker on the inner root Content-Type.
		expect(inner).toContain('protected-headers="v1"');

		// Honest encryptionInfo: exactly the keys used.
		expect(sealed.encryptionInfo.algorithm).toBe('pgp-mime');
		expect(sealed.encryptionInfo.recipientFingerprints).toEqual([recipient.fingerprint]);
		expect(sealed.encryptionInfo.signingFingerprint).toBe(sender.fingerprint);
	});

	it('preserves attachments inside the sealed payload', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		const withAttachment = [
			'Message-ID: <plain-0002@a.instance.test>',
			'From: alice@a.instance.test',
			'To: bob@b.instance.test',
			'Subject: With attachment',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="att_boundary"',
			'',
			'--att_boundary',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'body text',
			'--att_boundary',
			'Content-Type: application/octet-stream; name="report.bin"',
			'Content-Transfer-Encoding: base64',
			'Content-Disposition: attachment; filename="report.bin"',
			'',
			'aGVsbG8gc2VhbGVkIHdvcmxk',
			'--att_boundary--',
			'',
		].join('\r\n');

		const sealed = await sealMime(withAttachment, {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});
		const { inner, signatureValid } = await decryptInner(
			sealed.armoredCiphertext,
			recipient.privateKeyArmored,
			sender.publicKeyArmored
		);
		expect(signatureValid).toBe(true);
		expect(inner).toContain('filename="report.bin"');
		expect(inner).toContain('aGVsbG8gc2VhbGVkIHdvcmxk');
		expect(sealed.mime).not.toContain('aGVsbG8gc2VhbGVkIHdvcmxk');
	});

	it('protectSubject:false omits the inner marker but still seals + hides the subject', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');

		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
			protectSubject: false,
		});
		// The outer subject is the placeholder and the real subject/body never leak
		// EITHER WAY — `false` only drops the compliant-reader hint.
		expect(sealed.mime).toMatch(/^Subject: \.\.\.\r?$/m);
		expect(sealed.mime).not.toContain(REAL_SUBJECT);
		expect(sealed.mime).not.toContain(CANARY);

		const { inner, signatureValid } = await decryptInner(
			sealed.armoredCiphertext,
			recipient.privateKeyArmored,
			sender.publicKeyArmored
		);
		expect(signatureValid).toBe(true);
		expect(inner).toContain(`Subject: ${REAL_SUBJECT}`);
		expect(inner).toContain(CANARY);
		// The one difference from the protected path: no marker was injected.
		expect(inner).not.toContain('protected-headers="v1"');
	});

	it('appends the protected-headers marker cleanly to a FOLDED Content-Type', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		// Content-Type parameters continue on a folded line — the marker must land at
		// the end of the FULL logical header, never run together as `mixed;; protected`.
		const foldedContentType = [
			'Message-ID: <folded-0001@a.instance.test>',
			'From: alice@a.instance.test',
			'To: bob@b.instance.test',
			`Subject: ${REAL_SUBJECT}`,
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed;',
			' boundary="fold_boundary"',
			'',
			'--fold_boundary',
			'Content-Type: text/plain; charset=utf-8',
			'',
			`the ${CANARY} body`,
			'--fold_boundary--',
			'',
		].join('\r\n');

		const sealed = await sealMime(foldedContentType, {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});
		const { inner, signatureValid } = await decryptInner(
			sealed.armoredCiphertext,
			recipient.privateKeyArmored,
			sender.publicKeyArmored
		);
		expect(signatureValid).toBe(true);
		// Well-formed: the marker sits after the (folded) boundary parameter…
		expect(inner).toContain('boundary="fold_boundary"; protected-headers="v1"');
		// …and never as a run-together `;;` blob on the first physical line.
		expect(inner).not.toContain('multipart/mixed;; protected-headers');
	});

	it('seals to ALL recipients — either private key opens it (D2)', async () => {
		const r1 = await generateTestKeypair('bob@b.instance.test');
		const r2 = await generateTestKeypair('carol@c.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');

		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [r1.publicKeyArmored, r2.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});
		expect(sealed.encryptionInfo.recipientFingerprints.sort()).toEqual(
			[r1.fingerprint, r2.fingerprint].sort()
		);

		for (const priv of [r1.privateKeyArmored, r2.privateKeyArmored]) {
			const { inner, signatureValid } = await decryptInner(
				sealed.armoredCiphertext,
				priv,
				sender.publicKeyArmored
			);
			expect(signatureValid).toBe(true);
			expect(inner).toContain(CANARY);
		}
	});

	it('cross-check fixture — decrypt(seal(input)) is structurally the input', async () => {
		const fixturePath = fileURLToPath(
			new URL(
				'../../../../../fixtures/sealed-mail/pgp/protected-headers-input.eml',
				import.meta.url
			)
		);
		const fixture = readFileSync(fixturePath, 'utf-8').replace(/\r?\n/g, '\r\n');

		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');

		const sealed = await sealMime(fixture, {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});
		// Outer message hides the fixture's real subject + canary.
		expect(sealed.mime).toMatch(/^Subject: \.\.\.\r?$/m);
		expect(sealed.mime).not.toContain('Q3 board numbers');
		expect(sealed.mime).not.toContain('CANARY_SEALED_FIXTURE_PLAINTEXT_2f8c1a');

		const { inner, signatureValid } = await decryptInner(
			sealed.armoredCiphertext,
			recipient.privateKeyArmored,
			sender.publicKeyArmored
		);
		expect(signatureValid).toBe(true);

		// Structural regression: every fixture line (minus the injected
		// protected-headers marker on the root Content-Type) is recovered verbatim,
		// in order — real subject, body canary, and the base64 attachment.
		const innerNormalized = inner.replace(/; protected-headers="v1"/, '');
		expect(innerNormalized).toContain(fixture.trimEnd());
	});
});
