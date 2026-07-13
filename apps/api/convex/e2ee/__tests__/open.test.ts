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
 *   (c) INTEROP FIXTURES — the committed, offline-generated sealed `.eml`s open
 *       correctly and their protected headers are restored, in BOTH provenances:
 *       the openpgp.js-generated `fixtures/sealed-mail/pgp/` fixture AND the
 *       genuine GnuPG-generated `apps/api/fixtures/sealed-mail/gnupg/` group
 *       (keys, encryption, and signature all produced by `gpg` — true
 *       cross-implementation interop for the inbound direction).
 *   (d) DETECTION + PARSING — `isSealedPgpMime` recognises PGP/MIME + inline
 *       armor and passes plaintext through; `parseInnerMessage` restores subject
 *       and text/html from single-part AND multipart inner messages.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as openpgp from 'openpgp';
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

function gnupgFixturePath(name: string): string {
	return fileURLToPath(new URL(`../../../fixtures/sealed-mail/gnupg/${name}`, import.meta.url));
}

function readGnupgFixture(name: string): string {
	return readFileSync(gnupgFixturePath(name), 'utf-8');
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
		expect(restored.text).toContain(CANARY);
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
		expect(parseInnerMessage(outcome.innerMime).text).toContain(CANARY);
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

	it('INLINE ARMOR: a bare-text (non-MIME) payload opens byte-equal, content preserved', async () => {
		// Inline-armored PGP (the shape `isSealedPgpMime` + the dispatcher AI-inbox
		// gate both opt into) decrypts to BARE TEXT, not a MIME entity. A naive MIME
		// parse would swallow the first paragraph as "headers" (or, with no blank
		// line, yield an empty body) and silently lose the decrypted content — this
		// pins that the whole payload is restored verbatim.
		const recipient = await generateTestKeypair('bob@b.instance.test');
		const sender = await generateTestKeypair('alice@a.instance.test');
		const barePayload = `First paragraph with ${CANARY}.\r\n\r\nSecond paragraph — no MIME headers at all.`;
		const armored = (await openpgp.encrypt({
			message: await openpgp.createMessage({ text: barePayload }),
			encryptionKeys: await openpgp.readKey({ armoredKey: recipient.publicKeyArmored }),
			signingKeys: await openpgp.readPrivateKey({ armoredKey: sender.privateKeyArmored }),
			format: 'armored',
		})) as string;
		const raw = [
			'From: alice@a.instance.test',
			'To: bob@b.instance.test',
			'Subject: ...',
			'',
			armored,
		].join('\r\n');

		expect(isSealedPgpMime(raw)).toBe(true);
		const outcome = await openSealed({
			raw,
			recipientPrivateKeysArmored: [recipient.privateKeyArmored],
			senderPublicKeyArmored: sender.publicKeyArmored,
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(true);
		const restored = parseInnerMessage(outcome.innerMime);
		// The ENTIRE decrypted payload is the text body — byte-equal to what was
		// decrypted (no header-swallowing), with both paragraphs intact. (Compared
		// to `outcome.innerMime` rather than `barePayload` because OpenPGP text
		// literals canonicalize line endings — the point is nothing is lost.)
		expect(restored.text).toBe(outcome.innerMime);
		expect(restored.text).toContain(CANARY);
		expect(restored.text).toContain('Second paragraph');
		expect(restored.html).toBeUndefined();
		expect(restored.subject).toBeUndefined();
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
		expect(restored.text).toContain('CANARY_INBOUND_INTEROP_5b2c1d');
		expect(restored.html).toContain('CANARY_INBOUND_INTEROP_5b2c1d');
		expect(restored.html).toContain('<p>HTML');
	});

	it('the cipher-suite constant is the PGP/MIME profile', () => {
		expect(INBOUND_CIPHER_SUITE).toBe('pgp-mime');
	});
});

describe('e2ee/open · GnuPG interop (gpg-generated fixtures)', () => {
	// TRUE cross-implementation interop for the inbound direction: every byte of
	// OpenPGP material in `apps/api/fixtures/sealed-mail/gnupg/` — the throwaway
	// keys, the encryption, the signature — was produced OFFLINE by GnuPG
	// (gpg 2.5.21 via `gnupg/generate.sh`), and here the openpgp.js ingest path
	// opens it. The group carries its own gpg-minted recipient keypair because
	// gpg cannot encrypt to the openpgp.js `pgp/inbound-recipient` key (a v4 key
	// with RFC 9580 new-style algorithm IDs, rejected by GnuPG); the sender key is
	// wired through `senderPublicKeyArmored` exactly like the openpgp.js fixture —
	// the same pinned-key seam the ingest actions resolve into.
	const recipientPriv = readGnupgFixture('keys/recipient.sec.asc');
	const senderPub = readGnupgFixture('keys/sender.pub.asc');

	it('opens the gpg-sealed protected-headers fixture — verify + restore, byte-equal', async () => {
		const raw = readGnupgFixture('sealed-protected-headers.eml');
		expect(isSealedPgpMime(raw)).toBe(true);

		const outcome = await openSealed({
			raw,
			recipientPrivateKeysArmored: [recipientPriv],
			senderPublicKeyArmored: senderPub,
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(true);
		const senderKey = await openpgp.readKey({ armoredKey: senderPub });
		expect(outcome.signerFingerprint).toBe(senderKey.getFingerprint().toUpperCase());

		// BYTE-EQUAL: gpg's literal packet preserves the committed plaintext input
		// exactly, so the recovered inner MIME is the committed input, byte for byte.
		expect(outcome.innerMime).toBe(readGnupgFixture('inner-protected-headers.eml'));

		// Protected headers restored (D4): the real subject + BOTH body branches
		// travelled inside the ciphertext; the outer `.eml` carries only `Subject: ...`.
		const restored = parseInnerMessage(outcome.innerMime);
		expect(restored.subject).toBe('GnuPG sealed interop figures');
		expect(restored.text).toContain('CANARY_GNUPG_INTEROP_9f41aa');
		expect(restored.html).toContain('CANARY_GNUPG_INTEROP_9f41aa');
	});

	it('opens the gpg-sealed fixture WITHOUT protected headers — no inner subject claim', async () => {
		const raw = readGnupgFixture('sealed-no-protected-headers.eml');
		expect(isSealedPgpMime(raw)).toBe(true);

		const outcome = await openSealed({
			raw,
			recipientPrivateKeysArmored: [recipientPriv],
			senderPublicKeyArmored: senderPub,
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(true);
		expect(outcome.innerMime).toBe(readGnupgFixture('inner-no-protected-headers.eml'));

		// No protected headers inside ⇒ no restored subject (the OUTER subject stays
		// authoritative on ingest); the body still decrypts.
		const restored = parseInnerMessage(outcome.innerMime);
		expect(restored.subject).toBeUndefined();
		expect(restored.text).toContain('CANARY_GNUPG_PLAIN_2ee7c3');
	});

	it('reports the gpg fixture UNVERIFIED against the WRONG pinned sender key', async () => {
		// Cross-provenance wrong-key: pin the openpgp.js fixture sender against the
		// gpg-signed message — decrypts, but stays fail-closed UNVERIFIED.
		const outcome = await openSealed({
			raw: readGnupgFixture('sealed-protected-headers.eml'),
			recipientPrivateKeysArmored: [recipientPriv],
			senderPublicKeyArmored: readFileSync(fixturePath('inbound-sender.public.asc'), 'utf-8'),
		});
		expect(outcome.status).toBe('opened');
		if (outcome.status !== 'opened') return;
		expect(outcome.signatureValid).toBe(false);
		expect(outcome.signerFingerprint).toBeUndefined();
		expect(parseInnerMessage(outcome.innerMime).text).toContain('CANARY_GNUPG_INTEROP_9f41aa');
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
		expect(r.text).toContain('the single-part body');
		expect(r.html).toBeUndefined();
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
		expect(r.text).toContain('text branch');
		expect(r.html).toContain('<b>html branch</b>');
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

	it('returns a bare non-MIME payload verbatim as text (inline armor)', () => {
		// No Content-Type / MIME-Version → not a MIME entity. Multi-paragraph, so a
		// naive header/body split would swallow the first paragraph as headers.
		const bare = 'First paragraph.\r\n\r\nSecond paragraph, no headers at all.';
		const r = parseInnerMessage(bare);
		expect(r.text).toBe(bare);
		expect(r.subject).toBeUndefined();
		expect(r.html).toBeUndefined();
	});

	it('returns a single-line non-MIME payload (no blank line) verbatim as text', () => {
		const bare = 'just one line, no blank line, no headers';
		const r = parseInnerMessage(bare);
		expect(r.text).toBe(bare);
		expect(r.subject).toBeUndefined();
		expect(r.html).toBeUndefined();
	});

	it('does not mistake a leading non-MIME "Word: value" line for headers', () => {
		// A body line that happens to look header-shaped must NOT trigger MIME
		// parsing — only a real `Content-Type:` / `MIME-Version:` does.
		const bare = 'Note: this is body text\r\n\r\nand more body';
		const r = parseInnerMessage(bare);
		expect(r.text).toBe(bare);
		expect(r.subject).toBeUndefined();
	});
});
