/**
 * Inbound unsealing — the crypto + parsing half of the E4 hard gate (the
 * convex-test ingest matrix lives in `mail/__tests__/inboundUnseal.test.ts`, the
 * mirror end-to-end in `inbox/__tests__/inboundUnsealMirror.test.ts`).
 *
 *   (a) ROUND-TRIP with E3 — a message sealed by `sealMime` (E3) opens via
 *       `openSealed` (E4): the body decrypts, the signature verifies against the
 *       sender key, and the protected headers (real Subject + bodies, D4) are
 *       restored byte-equal.
 *   (b) FAILURE HONESTY — a decrypt against the WRONG sender key still opens but
 *       reports `signatureValid: false` (UNVERIFIED, never "verified"); a decrypt
 *       against the WRONG recipient key resolves to `cannotDecrypt` (today's
 *       "Encrypted — can't decrypt" path), never a thrown ingest failure.
 *   (c) INTEROP FIXTURES — the committed, offline-generated sealed `.eml`
 *       (encrypted to the published test recipient key, signed by the test sender
 *       key) opens correctly and its protected headers are restored.
 *   (d) DETECTION + PARSING — `isSealedPgpMime` recognises PGP/MIME + inline
 *       armor and passes plaintext through; `parseInnerMessage` restores subject
 *       and text/html from single-part AND multipart inner messages.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { sealMime } from '../seal';
import { openSealed } from '../open';
import { isSealedPgpMime, parseInnerMessage, INBOUND_CIPHER_SUITE } from '../inboundSeal';
import { bodyOf, generateTestKeypair } from './sealedMailTestHelpers';

const CANARY = 'CANARY_INBOUND_OPEN_7c3e91';
const REAL_SUBJECT = 'Sealed quarterly figures';

function sampleMessage(): string {
	return [
		'Message-ID: <plain-e4-0001@a.instance.test>',
		'Date: Mon, 13 Jul 2026 09:00:00 +0000',
		'From: alice@a.instance.test',
		'To: bob@b.instance.test',
		`Subject: ${REAL_SUBJECT}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 7bit',
		'',
		`Here are the ${CANARY} figures.`,
		'',
	].join('\r\n');
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`../../../../../fixtures/sealed-mail/pgp/${name}`, import.meta.url));
}

describe('e2ee/open · openSealed', () => {
	it('round-trips an E3-sealed message — decrypts, verifies, restores headers', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});

		const outcome = await openSealed({
			raw: sealed.mime,
			recipientPrivateKeysArmored: [recipient.privateKeyArmored],
			senderPublicKeyArmored: sender.publicKeyArmored,
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(true);
		expect(outcome.signerFingerprint).toBe(sender.fingerprint);

		// Card acceptance: BYTE-EQUAL body. The decrypted inner body is byte-for-byte
		// the exact body we sealed (not merely "contains the canary").
		expect(bodyOf(outcome.innerMime)).toBe(bodyOf(sampleMessage()));

		const restored = parseInnerMessage(outcome.innerMime);
		expect(restored.subject).toBe(REAL_SUBJECT);
		expect(restored.textBody).toContain(CANARY);
	});

	it('decrypts but reports signatureValid:false against the WRONG sender key', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		const impostor = await generateTestKeypair('mallory@evil.test');
		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});

		const outcome = await openSealed({
			raw: sealed.mime,
			recipientPrivateKeysArmored: [recipient.privateKeyArmored],
			// Pin the WRONG key: the body decrypts (recipient key is right) but the
			// signature cannot verify → UNVERIFIED, never "verified".
			senderPublicKeyArmored: impostor.publicKeyArmored,
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(false);
		expect(outcome.signerFingerprint).toBeUndefined();
		// The plaintext is still recovered — decrypt-on-ingest stores it UNVERIFIED.
		expect(parseInnerMessage(outcome.innerMime).textBody).toContain(CANARY);
	});

	it('opens without a sender key as UNVERIFIED (no pin ⇒ no signature claim)', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});

		const outcome = await openSealed({
			raw: sealed.mime,
			recipientPrivateKeysArmored: [recipient.privateKeyArmored],
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(false);
	});

	it('cannotDecrypt against the WRONG recipient key — no throw', async () => {
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const stranger = await generateTestKeypair('nobody@x.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		const sealed = await sealMime(sampleMessage(), {
			recipientPublicKeysArmored: [recipient.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});

		const outcome = await openSealed({
			raw: sealed.mime,
			recipientPrivateKeysArmored: [stranger.privateKeyArmored],
			senderPublicKeyArmored: sender.publicKeyArmored,
		});
		expect(outcome.status).toBe('cannotDecrypt');
	});

	it('cannotDecrypt when the raw carries no armored ciphertext', async () => {
		const stranger = await generateTestKeypair('nobody@x.test');
		const outcome = await openSealed({
			raw: 'From: a@b.test\r\nSubject: plain\r\n\r\njust text',
			recipientPrivateKeysArmored: [stranger.privateKeyArmored],
		});
		expect(outcome.status).toBe('cannotDecrypt');
	});

	it('INTEROP: the committed offline-sealed fixture opens + restores headers', async () => {
		const raw = readFileSync(fixturePath('inbound-sealed-goodsig.eml'), 'utf-8');
		const recipientPriv = readFileSync(fixturePath('inbound-recipient.secret.asc'), 'utf-8');
		const senderPub = readFileSync(fixturePath('inbound-sender.public.asc'), 'utf-8');

		expect(isSealedPgpMime(raw)).toBe(true);
		const outcome = await openSealed({
			raw,
			recipientPrivateKeysArmored: [recipientPriv],
			senderPublicKeyArmored: senderPub,
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(true);

		const restored = parseInnerMessage(outcome.innerMime);
		// Protected headers restored: the real subject + BOTH bodies from the
		// multipart/alternative inner (the outer `.eml` carries only `Subject: ...`).
		expect(restored.subject).toBe('Q3 sealed interop numbers');
		expect(restored.textBody).toContain('CANARY_INBOUND_INTEROP_5b2c1d');
		expect(restored.htmlBody).toContain('CANARY_INBOUND_INTEROP_5b2c1d');
		expect(restored.htmlBody).toContain('<p>HTML');
	});

	it('the cipher-suite constant is the PGP/MIME profile', () => {
		expect(INBOUND_CIPHER_SUITE).toBe('pgp-mime');
	});
});

describe('e2ee/inboundSeal · isSealedPgpMime', () => {
	it('detects PGP/MIME multipart/encrypted', () => {
		const raw = readFileSync(fixturePath('inbound-sealed-goodsig.eml'), 'utf-8');
		expect(isSealedPgpMime(raw)).toBe(true);
	});

	it('detects an inline-armored PGP body', () => {
		const raw = [
			'From: a@b.test',
			'Subject: ...',
			'',
			'-----BEGIN PGP MESSAGE-----',
			'',
			'wcBMA0v...ciphertext...',
			'-----END PGP MESSAGE-----',
		].join('\r\n');
		expect(isSealedPgpMime(raw)).toBe(true);
	});

	it('passes a plaintext message through (not sealed)', () => {
		const raw = 'From: a@b.test\r\nSubject: hello\r\n\r\nplain body, nothing sealed';
		expect(isSealedPgpMime(raw)).toBe(false);
	});
});

describe('e2ee/inboundSeal · parseInnerMessage', () => {
	it('restores subject + body from a single-part text/plain inner', () => {
		const inner = [
			'From: a@b.test',
			'Subject: Single part subject',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'the single-part body',
			'',
		].join('\r\n');
		const r = parseInnerMessage(inner);
		expect(r.subject).toBe('Single part subject');
		expect(r.textBody).toContain('the single-part body');
		expect(r.htmlBody).toBeUndefined();
	});

	it('restores text + html from a multipart/alternative inner', () => {
		const inner = [
			'Subject: Multi part subject',
			'Content-Type: multipart/alternative; boundary="bx"',
			'',
			'--bx',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'text branch',
			'--bx',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<b>html branch</b>',
			'--bx--',
			'',
		].join('\r\n');
		const r = parseInnerMessage(inner);
		expect(r.subject).toBe('Multi part subject');
		expect(r.textBody).toContain('text branch');
		expect(r.htmlBody).toContain('<b>html branch</b>');
	});

	it('unfolds a folded Subject header', () => {
		const inner = [
			'Subject: a very long',
			'  folded subject',
			'Content-Type: text/plain',
			'',
			'body',
		].join('\r\n');
		expect(parseInnerMessage(inner).subject).toBe('a very long folded subject');
	});
});
