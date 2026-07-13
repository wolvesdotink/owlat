/**
 * Sealed Mail E4 — decrypt-on-ingest on the AI-inbox path (D3), the MIRROR half
 * of the hard gate.
 *
 * Drives the REAL `e2ee.open.decryptAndReceive` action end-to-end: it decrypts a
 * sealed message with the recipient's vault key, verifies the signature against
 * the pinned sender key, then hands the PLAINTEXT to
 * `inbox.messages.receiveMessage`. We then assert:
 *   - `inboundMessages` stores the DECRYPTED body (what the agent pipeline reads)
 *     + the restored real subject + the mirrored `sealed` / `signatureValid`
 *     flags — a spoofed/absent signature never claims "verified";
 *   - the `unifiedMessages` mirror carries the DECRYPTED text (not ciphertext),
 *     so the cross-channel timeline + agent both consume real content.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import { sealMime } from '../../e2ee/seal';
import { modules } from '../../mail/__tests__/testModules';

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const RECIPIENT = 'inbox@example.com';
const SENDER = 'alice@sender.test';
const CANARY = 'CANARY_MIRROR_UNSEAL_4d7e02';
const REAL_SUBJECT = 'Sealed AI-inbox subject';

type T = ReturnType<typeof convexTest>;

async function generateTestKeypair(
	email: string
): Promise<{ publicKeyArmored: string; privateKeyArmored: string }> {
	const { publicKey, privateKey } = await openpgp.generateKey({
		type: 'curve25519',
		userIDs: [{ name: email, email }],
		format: 'armored',
	});
	return { publicKeyArmored: publicKey, privateKeyArmored: privateKey };
}

async function recipientPublicKey(t: T): Promise<string> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const row = await ctx.db
			.query('keyVault')
			.withIndex('by_address', (q) => q.eq('address', RECIPIENT))
			.first();
		if (!row) throw new Error('recipient vault key missing');
		return row.publicKeyArmored;
	});
}

async function seedPinnedSender(t: T, pinnedPublicKeyArmored: string): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('recipientKeys', {
			address: SENDER,
			domain: 'sender.test',
			outcome: 'trusted',
			pinnedFingerprint: 'FP',
			pinnedPublicKeyArmored,
			expiresAt: now + 60_000,
			discoveredAt: now,
			updatedAt: now,
		});
	});
}

function innerMessage(): string {
	return [
		'Message-ID: <mirror-e4-0001@sender.test>',
		`From: ${SENDER}`,
		`To: ${RECIPIENT}`,
		`Subject: ${REAL_SUBJECT}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: 7bit',
		'',
		`Secret ${CANARY} for the agent.`,
		'',
	].join('\r\n');
}

async function readMirror(
	t: T
): Promise<{ text?: string; sealed?: boolean; signatureValid?: boolean }> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const row = await ctx.db.query('unifiedMessages').first();
		if (!row) throw new Error('no unifiedMessages mirror row');
		return JSON.parse(row.content) as { text?: string; sealed?: boolean; signatureValid?: boolean };
	});
}

describe('e2ee.open.decryptAndReceive — mirror + agent consume decrypted text (E4/D3)', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('decrypts, verifies, and both inboundMessages + the mirror carry plaintext', async () => {
		const t = convexTest(schema, modules);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, sender.publicKeyArmored);

		const sealed = await sealMime(innerMessage(), {
			recipientPublicKeysArmored: [await recipientPublicKey(t)],
			signingKeyArmored: sender.privateKeyArmored,
		});

		await t.action(internal.e2ee.open.decryptAndReceive, {
			armoredCiphertext: sealed.armoredCiphertext,
			recipientAddress: RECIPIENT,
			from: SENDER,
			to: RECIPIENT,
			// The MTA-parsed outer subject is the `...` placeholder; the body it saw
			// is the ciphertext.
			subject: '...',
			textBody: sealed.armoredCiphertext,
			messageId: '<mirror-e4-0001@sender.test>',
			timestamp: Date.now(),
		});

		// inboundMessages holds the DECRYPTED body (the agent pipeline's input) +
		// the restored real subject + honest sealed flags.
		const inbound = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const row = await ctx.db.query('inboundMessages').first();
			if (!row) throw new Error('no inboundMessages row');
			return row;
		});
		expect(inbound.subject).toBe(REAL_SUBJECT);
		expect(inbound.textBody).toContain(CANARY);
		expect(inbound.textBody).not.toContain('-----BEGIN PGP MESSAGE-----');
		expect(inbound.sealed).toBe(true);
		expect(inbound.signatureValid).toBe(true);
		expect(inbound.signerInstance).toBe('sender.test');

		// The unified-timeline mirror carries the DECRYPTED text + the sealed flag.
		const mirror = await readMirror(t);
		expect(mirror.text).toContain(CANARY);
		expect(mirror.sealed).toBe(true);
		expect(mirror.signatureValid).toBe(true);
	});

	it('decrypts but records signatureValid:false against the wrong pinned key', async () => {
		const t = convexTest(schema, modules);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		const impostor = await generateTestKeypair('mallory@evil.test');
		await seedPinnedSender(t, impostor.publicKeyArmored);

		const sealed = await sealMime(innerMessage(), {
			recipientPublicKeysArmored: [await recipientPublicKey(t)],
			signingKeyArmored: sender.privateKeyArmored,
		});

		await t.action(internal.e2ee.open.decryptAndReceive, {
			armoredCiphertext: sealed.armoredCiphertext,
			recipientAddress: RECIPIENT,
			from: SENDER,
			to: RECIPIENT,
			subject: '...',
			textBody: sealed.armoredCiphertext,
			messageId: '<mirror-e4-0002@sender.test>',
			timestamp: Date.now(),
		});

		const inbound = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const row = await ctx.db.query('inboundMessages').first();
			if (!row) throw new Error('no inboundMessages row');
			return row;
		});
		expect(inbound.textBody).toContain(CANARY); // decrypted
		expect(inbound.sealed).toBe(true);
		expect(inbound.signatureValid).toBe(false); // UNVERIFIED
		expect(inbound.signerInstance).toBeUndefined();
	});
});
