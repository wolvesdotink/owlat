/**
 * Sealed Mail E4 — decrypt-on-ingest on the personal-mailbox path (D3), the
 * convex-test INGEST MATRIX half of the hard gate.
 *
 * Drives the REAL `mail.delivery.ingestFromWebhook` action end-to-end (no MTA env
 * ⇒ the attachment scan / capture no-op) over four cases:
 *   - sealed + good signature ⇒ the row stores the DECRYPTED plaintext + the real
 *     subject, the raw `.eml` at `rawStorageId` is the RETAINED sealed original
 *     (ciphertext, no canary), and `inboundEncryptionInfo` records
 *     `decrypted:true, signatureValid:true` with the signer fingerprint/instance;
 *   - sealed + a signature that does not match the pinned key ⇒ `signatureValid:
 *     false` (UNVERIFIED, decrypted anyway);
 *   - sealed but we hold NO vault key ⇒ the "Encrypted — can't decrypt" path is
 *     intact: the body stays ciphertext and `inboundEncryptionInfo` is
 *     `decrypted:false`;
 *   - a plaintext message ⇒ the untouched fast path (no `inboundEncryptionInfo`).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { sealMime } from '../../e2ee/seal';
import {
	bodyOf,
	generateTestKeypair,
	innerMessage,
	recipientVaultPublicKey,
	seedPinnedSender,
	type ConvexTestCtx,
} from '../../e2ee/__tests__/sealedMailTestHelpers';
import { modules } from './testModules';

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const RECIPIENT = 'me@example.com';
const SENDER = 'alice@sender.test';
const CANARY = 'CANARY_INGEST_UNSEAL_9f21ab';
const REAL_SUBJECT = 'Sealed ingest subject';
const MESSAGE_ID = '<ingest-e4-0001@sender.test>';

type T = ConvexTestCtx;

/** The exact protected-headers inner message these tests seal + expect back. */
function testInnerMessage(): string {
	return innerMessage({
		from: SENDER,
		to: RECIPIENT,
		subject: REAL_SUBJECT,
		body: `Confidential ${CANARY} numbers.`,
		messageId: MESSAGE_ID,
	});
}

async function seedSettings(t: T): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { postbox: true, senderAuthBadges: true, sealedMail: true },
			createdAt: Date.now(),
		});
	});
}

async function seedMailbox(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: RECIPIENT,
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		for (const [name, role] of [
			['INBOX', 'inbox'],
			['Spam', 'spam'],
		] as const) {
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

async function ingest(
	t: T,
	sealedMimeText: string,
	textBody: string
): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> {
	return await t.action(internal.mail.delivery.ingestFromWebhook, {
		deliveryId: 'd-1',
		rawBytesBase64: Buffer.from(sealedMimeText, 'utf8').toString('base64'),
		recipientAddress: RECIPIENT,
		from: SENDER,
		to: [RECIPIENT],
		cc: [],
		bcc: [],
		// The outer subject a relay sees is the `...` placeholder (protected headers).
		subject: '...',
		textBody,
		messageId: '<ingest-e4-0001@sender.test>',
		attachments: [],
	});
}

async function readRow(t: T, messageId: Id<'mailMessages'>) {
	return await t.run(async (ctx) => {
		const msg = await ctx.db.get(messageId);
		if (!msg) throw new Error('mailMessages row missing');
		const rawBlob = await ctx.storage.get(msg.rawStorageId);
		const rawText = rawBlob ? await rawBlob.text() : '';
		return { msg, rawText };
	});
}

describe('mail.delivery.ingestFromWebhook — decrypt-on-ingest (Sealed Mail E4/D3)', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('sealed + good signature ⇒ plaintext stored, original retained, verified record', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await seedMailbox(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const sealed = await sealMime(testInnerMessage(), {
			recipientPublicKeysArmored: [await recipientVaultPublicKey(t, RECIPIENT)],
			signingKeyArmored: sender.privateKeyArmored,
		});
		const result = await ingest(t, sealed.mime, sealed.armoredCiphertext);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const { msg, rawText } = await readRow(t, result.messageId);
		// Restored plaintext + real subject flow into the pipeline (D3). BYTE-EQUAL
		// body (card acceptance): the stored plaintext is byte-for-byte the exact
		// inner-message body, not merely "contains the canary".
		expect(msg.subject).toBe(REAL_SUBJECT);
		expect(msg.textBodyInline).toBe(bodyOf(testInnerMessage()));
		expect(msg.textBodyInline).toContain(CANARY);
		// The retained raw `.eml` is the sealed ORIGINAL — ciphertext, no canary.
		expect(rawText).toContain('multipart/encrypted; protocol="application/pgp-encrypted"');
		expect(rawText).not.toContain(CANARY);
		// Honest verified record.
		expect(msg.inboundEncryptionInfo).toMatchObject({
			sealed: true,
			decrypted: true,
			cipherSuite: 'pgp-mime',
			signatureValid: true,
			signerInstance: 'sender.test',
		});
		expect((msg.inboundEncryptionInfo as { signerFingerprint?: string }).signerFingerprint).toMatch(
			/^[0-9A-F]{40}$/
		);
	});

	it('sealed + wrong pinned key ⇒ decrypted but signatureValid:false (UNVERIFIED)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await seedMailbox(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		const impostor = await generateTestKeypair('mallory@evil.test');
		// The message is signed by `sender`, but the PINNED key is the impostor's.
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: impostor.publicKeyArmored,
		});

		const sealed = await sealMime(testInnerMessage(), {
			recipientPublicKeysArmored: [await recipientVaultPublicKey(t, RECIPIENT)],
			signingKeyArmored: sender.privateKeyArmored,
		});
		const result = await ingest(t, sealed.mime, sealed.armoredCiphertext);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const { msg } = await readRow(t, result.messageId);
		expect(msg.textBodyInline).toContain(CANARY); // still decrypted
		expect(msg.inboundEncryptionInfo).toMatchObject({
			sealed: true,
			decrypted: true,
			signatureValid: false,
		});
		// A false signature makes NO signer claim.
		expect(
			(msg.inboundEncryptionInfo as { signerFingerprint?: string }).signerFingerprint
		).toBeUndefined();
	});

	it('sealed but no vault key ⇒ the "Encrypted — can\'t decrypt" path is intact', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await seedMailbox(t);
		// Recipient has NO vault key, so we cannot open the message.
		const recipientOnly = await generateTestKeypair(RECIPIENT);
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const sealed = await sealMime(testInnerMessage(), {
			recipientPublicKeysArmored: [recipientOnly.publicKeyArmored],
			signingKeyArmored: sender.privateKeyArmored,
		});
		const result = await ingest(t, sealed.mime, sealed.armoredCiphertext);
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const { msg } = await readRow(t, result.messageId);
		// Body stays ciphertext (unchanged), never the plaintext canary.
		expect(msg.textBodyInline ?? '').not.toContain(CANARY);
		expect(msg.textBodyInline ?? '').toContain('-----BEGIN PGP MESSAGE-----');
		expect(msg.inboundEncryptionInfo).toEqual({ sealed: true, decrypted: false });
	});

	it('a plaintext message ⇒ the untouched fast path (no encryption record)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await seedMailbox(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });

		const plain = [
			'Message-ID: <plain-e4-0002@sender.test>',
			`From: ${SENDER}`,
			`To: ${RECIPIENT}`,
			'Subject: Just a plaintext note',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'nothing sealed here at all',
			'',
		].join('\r\n');
		const result = await t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd-2',
			rawBytesBase64: Buffer.from(plain, 'utf8').toString('base64'),
			recipientAddress: RECIPIENT,
			from: SENDER,
			to: [RECIPIENT],
			cc: [],
			bcc: [],
			subject: 'Just a plaintext note',
			textBody: 'nothing sealed here at all',
			messageId: '<plain-e4-0002@sender.test>',
			attachments: [],
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const { msg } = await readRow(t, result.messageId);
		expect(msg.subject).toBe('Just a plaintext note');
		expect(msg.textBodyInline).toBe('nothing sealed here at all');
		expect(msg.inboundEncryptionInfo).toBeUndefined();
	});
});
