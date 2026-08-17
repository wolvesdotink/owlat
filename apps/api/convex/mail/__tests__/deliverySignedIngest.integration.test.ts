/**
 * Inbound PGP-SIGNED mail on the personal-mailbox path — the F1 convex-test
 * INGEST half of the hard gate (the crypto/verdict matrix lives in
 * `e2ee/__tests__/verifyInboundSignature.test.ts`).
 *
 * Drives the REAL `mail.delivery.ingestFromWebhook` action end-to-end (no MTA
 * env ⇒ the attachment scan / capture no-op) and asserts:
 *   - a detached-signed (RFC 3156) message DELIVERS with an honest verified
 *     `inboundSignatureInfo` (fingerprint + keySource), bodies untouched;
 *   - a clearsigned message delivers with the same verified record;
 *   - a plaintext reply merely QUOTING one gets NO record at all (FU1);
 *   - a TAMPERED signed message still delivers — verdict invalid, delivery
 *     NEVER blocked (D10);
 *   - an unknown-sender signed message delivers with the honest `not_found`
 *     verdict;
 *   - the SEALED path is untouched: a sealed message gets its
 *     `inboundEncryptionInfo` and NO signature record;
 *   - the PLAINTEXT path is untouched: neither record, body byte-identical.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { sealMime } from '../../e2ee/seal';
import {
	generateTestKeypair,
	innerMessage,
	recipientVaultPublicKey,
	seedPinnedSender,
	type ConvexTestCtx,
} from '../../e2ee/__tests__/sealedMailTestHelpers';
import {
	clearsign,
	composeClearsignedMessage,
	composeSignedPgpMime,
	detachedSign,
	signedFirstPart,
	type SignaturePartEncoding,
} from '../../e2ee/__tests__/signedMailTestHelpers';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import { openMailMessageInlineBody } from '../../lib/messageBody';

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const RECIPIENT = 'me@example.com';
const SENDER = 'alice@sender.test';
const CANARY = 'CANARY_SIGNED_INGEST_2b91cd';

type T = ConvexTestCtx;

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
	raw: string,
	args: { subject: string; textBody?: string; messageId: string }
): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> {
	return await t.action(internal.mail.delivery.ingestFromWebhook, {
		deliveryId: 'd-1',
		rawBytesBase64: Buffer.from(raw, 'utf8').toString('base64'),
		recipientAddress: RECIPIENT,
		from: SENDER,
		to: [RECIPIENT],
		cc: [],
		bcc: [],
		subject: args.subject,
		textBody: args.textBody,
		messageId: args.messageId,
		attachments: [],
	});
}

async function readRow(t: T, messageId: Id<'mailMessages'>) {
	return await t.run(async (ctx) => {
		const msg = await ctx.db.get(messageId);
		if (!msg) throw new Error('mailMessages row missing');
		const { text, html } = await openMailMessageInlineBody(msg);
		return { ...msg, textBodyInline: text, htmlBodyInline: html };
	});
}

async function composeDetachedSigned(
	privateKeyArmored: string,
	opts: { signatureEncoding?: SignaturePartEncoding; messageId?: string } = {}
): Promise<string> {
	const part = signedFirstPart(`Signed ${CANARY} content.`);
	return composeSignedPgpMime({
		from: SENDER,
		to: RECIPIENT,
		subject: 'signed ingest',
		part,
		signatureArmored: await detachedSign(part, privateKeyArmored),
		messageId: opts.messageId ?? '<signed-ingest-0001@sender.test>',
		...(opts.signatureEncoding ? { signatureEncoding: opts.signatureEncoding } : {}),
	});
}

describe('mail.delivery.ingestFromWebhook — inbound signature verification (F1/D9)', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('detached-signed mail delivers with a verified verdict, body untouched', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t);
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const result = await ingest(t, await composeDetachedSigned(sender.privateKeyArmored), {
			subject: 'signed ingest',
			textBody: `Signed ${CANARY} content.`,
			messageId: '<signed-ingest-0001@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		// Delivery untouched: the parsed body + subject flow through unchanged.
		expect(msg.subject).toBe('signed ingest');
		expect(msg.textBodyInline).toBe(`Signed ${CANARY} content.`);
		// Honest verified record, sibling of (not inside) the sealed union.
		expect(msg.inboundSignatureInfo).toEqual({
			isSigned: true,
			isSignatureValid: true,
			signerFingerprint: sender.fingerprint,
			keySource: 'pinned',
		});
		expect(msg.inboundEncryptionInfo).toBeUndefined();
	});

	it.each([
		['base64', '<signed-ingest-0004@sender.test>'],
		['quoted-printable', '<signed-ingest-0005@sender.test>'],
	] as Array<[SignaturePartEncoding, string]>)(
		'a %s-encoded signature part verifies end-to-end (no literal armor line)',
		async (signatureEncoding, messageId) => {
			// The raw structural gate used to demand a literal, unquoted
			// `-----BEGIN PGP SIGNATURE-----` line to corroborate the scraped
			// content-type. A transfer-encoded signature part has none, so ingest
			// skipped verification entirely and these messages — genuinely signed,
			// genuinely verifiable — were stuck on "signed · not verified".
			const t = convexTest(schema, modules);
			await seedMailbox(t);
			const sender = await generateTestKeypair(SENDER);
			await seedPinnedSender(t, {
				address: SENDER,
				domain: 'sender.test',
				pinnedPublicKeyArmored: sender.publicKeyArmored,
			});

			const raw = await composeDetachedSigned(sender.privateKeyArmored, {
				signatureEncoding,
				messageId,
			});
			if (signatureEncoding === 'base64') {
				expect(raw).not.toContain('-----BEGIN PGP SIGNATURE-----');
			}

			const result = await ingest(t, raw, {
				subject: 'signed ingest',
				textBody: `Signed ${CANARY} content.`,
				messageId,
			});
			expect('messageId' in result).toBe(true);
			if (!('messageId' in result)) return;

			const msg = await readRow(t, result.messageId);
			expect(msg.inboundSignatureInfo).toEqual({
				isSigned: true,
				isSignatureValid: true,
				signerFingerprint: sender.fingerprint,
				keySource: 'pinned',
			});
			expect(msg.textBodyInline).toBe(`Signed ${CANARY} content.`);
		}
	);

	it('clearsigned mail delivers with a verified verdict (inline verify)', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t);
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const raw = composeClearsignedMessage({
			from: SENDER,
			to: RECIPIENT,
			subject: 'clearsigned ingest',
			clearsignArmor: await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored),
			messageId: '<clearsigned-ingest-0001@sender.test>',
		});
		const result = await ingest(t, raw, {
			subject: 'clearsigned ingest',
			textBody: `Clear ${CANARY} text.`,
			messageId: '<clearsigned-ingest-0001@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		expect(msg.inboundSignatureInfo).toEqual({
			isSigned: true,
			isSignatureValid: true,
			signerFingerprint: sender.fingerprint,
			keySource: 'pinned',
		});
	});

	it('a plaintext reply QUOTING a clearsigned message gets NO signature record', async () => {
		// FU1: the sender's key RESOLVES here (pinned), so before the structural
		// gates were line-anchored this innocent reply verified the quoted armor,
		// failed, and rendered "Signed · signature invalid" for unsigned mail.
		const t = convexTest(schema, modules);
		await seedMailbox(t);
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const quotedArmor = (await clearsign(`Clear ${CANARY} text.`, sender.privateKeyArmored))
			.trim()
			.split('\n')
			.map((line) => `> ${line}`);
		const textBody = ['Thanks, received.', '', 'On Sunday, alice wrote:', ...quotedArmor].join(
			'\n'
		);
		const raw = [
			'Message-ID: <quoted-ingest-0001@sender.test>',
			`From: ${SENDER}`,
			`To: ${RECIPIENT}`,
			'Subject: Re: clearsigned ingest',
			'Content-Type: text/plain; charset=utf-8',
			'',
			...textBody.split('\n'),
			'',
		].join('\r\n');
		const result = await ingest(t, raw, {
			subject: 'Re: clearsigned ingest',
			textBody,
			messageId: '<quoted-ingest-0001@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		expect(msg.textBodyInline).toBe(textBody);
		expect(msg.inboundSignatureInfo).toBeUndefined();
		expect(msg.inboundEncryptionInfo).toBeUndefined();
	});

	it('a TAMPERED signed message still DELIVERS — verdict invalid, never blocked', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t);
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const raw = (await composeDetachedSigned(sender.privateKeyArmored)).replace(
			CANARY,
			'TAMPERED_CONTENT'
		);
		const result = await ingest(t, raw, {
			subject: 'signed ingest',
			textBody: 'Signed TAMPERED_CONTENT content.',
			messageId: '<signed-ingest-0002@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		expect(msg.inboundSignatureInfo).toEqual({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'pinned',
		});
		// The message itself delivered normally into INBOX.
		expect(msg.textBodyInline).toContain('TAMPERED_CONTENT');
	});

	it('an unknown-sender signed message delivers with the honest not_found verdict', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t);
		const sender = await generateTestKeypair(SENDER);

		const result = await ingest(t, await composeDetachedSigned(sender.privateKeyArmored), {
			subject: 'signed ingest',
			textBody: `Signed ${CANARY} content.`,
			messageId: '<signed-ingest-0003@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		expect(msg.inboundSignatureInfo).toEqual({
			isSigned: true,
			isSignatureValid: false,
			keySource: 'not_found',
		});
	});

	it('the SEALED path is untouched: sealed record present, NO signature record', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { postbox: true, senderAuthBadges: true, sealedMail: true },
				createdAt: Date.now(),
			});
		});
		await seedMailbox(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const sealed = await sealMime(
			innerMessage({
				from: SENDER,
				to: RECIPIENT,
				subject: 'Sealed subject',
				body: `Sealed ${CANARY} body.`,
				messageId: '<sealed-ingest-0001@sender.test>',
			}),
			{
				recipientPublicKeysArmored: [await recipientVaultPublicKey(t, RECIPIENT)],
				signingKeyArmored: sender.privateKeyArmored,
			}
		);
		const result = await ingest(t, sealed.mime, {
			subject: '...',
			textBody: sealed.armoredCiphertext,
			messageId: '<sealed-ingest-0001@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		expect(msg.inboundEncryptionInfo).toMatchObject({
			isSealed: true,
			isDecrypted: true,
			isSignatureValid: true,
		});
		// The sealed record owns its own signature claim — no sibling record.
		expect(msg.inboundSignatureInfo).toBeUndefined();
	});

	it('the PLAINTEXT path is untouched: neither record, body byte-identical', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t);

		const raw = [
			'Message-ID: <plain-ingest-0001@sender.test>',
			`From: ${SENDER}`,
			`To: ${RECIPIENT}`,
			'Subject: plain ingest',
			'Content-Type: text/plain; charset=utf-8',
			'',
			`Plain ${CANARY} body.`,
			'',
		].join('\r\n');
		const result = await ingest(t, raw, {
			subject: 'plain ingest',
			textBody: `Plain ${CANARY} body.`,
			messageId: '<plain-ingest-0001@sender.test>',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		const msg = await readRow(t, result.messageId);
		expect(msg.textBodyInline).toBe(`Plain ${CANARY} body.`);
		expect(msg.inboundEncryptionInfo).toBeUndefined();
		expect(msg.inboundSignatureInfo).toBeUndefined();
	});
});
