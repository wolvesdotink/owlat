/**
 * Sealed Mail E4 — decrypt-on-ingest on the AI-inbox path (D3), the MIRROR half
 * of the hard gate.
 *
 * Drives the REAL `e2ee.open.decryptAndReceive` action end-to-end: it decrypts a
 * sealed message with the recipient's vault key, verifies the signature against
 * the pinned sender key, then hands the PLAINTEXT to
 * `inbox.messages.receiveMessage`. We then assert:
 *   - `inboundMessages` stores the DECRYPTED body (what the agent pipeline reads)
 *     + the restored real subject + the mirrored `isSealed` / `isSignatureValid`
 *     flags — a spoofed/absent signature never claims "verified";
 *   - the `unifiedMessages` mirror carries the DECRYPTED text (not ciphertext),
 *     so the cross-channel timeline + agent both consume real content.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import { sealMime } from '../../e2ee/seal';
import {
	generateTestKeypair,
	innerMessage,
	recipientVaultPublicKey,
	seedPinnedSender,
	type ConvexTestCtx,
} from '../../e2ee/__tests__/sealedMailTestHelpers';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import { openMessageBody } from '../../lib/messageBody';
import { isSealedAtRest } from '../../lib/atRestBodies';

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const RECIPIENT = 'inbox@example.com';
const SENDER = 'alice@sender.test';
const CANARY = 'CANARY_MIRROR_UNSEAL_4d7e02';
const REAL_SUBJECT = 'Sealed AI-inbox subject';

type T = ConvexTestCtx;

/** The exact protected-headers inner message these tests seal. */
function testInnerMessage(messageId: string): string {
	return innerMessage({
		from: SENDER,
		to: RECIPIENT,
		subject: REAL_SUBJECT,
		body: `Secret ${CANARY} for the agent.`,
		messageId,
	});
}

async function readMirror(
	t: T
): Promise<{ text?: string; isSealed?: boolean; isSignatureValid?: boolean }> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const row = await ctx.db.query('unifiedMessages').first();
		if (!row) throw new Error('no unifiedMessages mirror row');
		// WRITE-PATH PROOF: the mirror `content` is CIPHERTEXT on the raw row — the
		// receive path sealed it at write. (Without this the test would still pass
		// if sealing were a no-op, since openMessageBody passes plaintext through.)
		expect(isSealedAtRest(row.content)).toBe(true);
		// E8b seals the mirror `content` at rest; unseal before parsing.
		return JSON.parse(await openMessageBody(row.content)) as {
			text?: string;
			isSealed?: boolean;
			isSignatureValid?: boolean;
		};
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
		rateLimiterTest.register(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const sealed = await sealMime(testInnerMessage('<mirror-e4-0001@sender.test>'), {
			recipientPublicKeysArmored: [await recipientVaultPublicKey(t, RECIPIENT)],
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
			// WRITE-PATH PROOF: `textBody` is CIPHERTEXT on the raw row — the receive
			// path sealed it at write (this fails if `sealBodyAtWrite` is a no-op).
			expect(isSealedAtRest(row.textBody ?? '')).toBe(true);
			// E8b seals textBody at rest; unseal it so the plaintext assertions below
			// exercise the composed E2EE-decrypt → at-rest-seal → accessor-unseal path.
			return {
				...row,
				textBody: row.textBody === undefined ? undefined : await openMessageBody(row.textBody),
			};
		});
		expect(inbound.subject).toBe(REAL_SUBJECT);
		expect(inbound.textBody).toContain(CANARY);
		expect(inbound.textBody).not.toContain('-----BEGIN PGP MESSAGE-----');
		expect(inbound.isSealed).toBe(true);
		expect(inbound.isSignatureValid).toBe(true);
		expect(inbound.signerInstance).toBe('sender.test');

		// The unified-timeline mirror carries the DECRYPTED text + the sealed flag.
		const mirror = await readMirror(t);
		expect(mirror.text).toContain(CANARY);
		expect(mirror.isSealed).toBe(true);
		expect(mirror.isSignatureValid).toBe(true);
	});

	it('decrypts but records isSignatureValid:false against the wrong pinned key', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		const impostor = await generateTestKeypair('mallory@evil.test');
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: impostor.publicKeyArmored,
		});

		const sealed = await sealMime(testInnerMessage('<mirror-e4-0002@sender.test>'), {
			recipientPublicKeysArmored: [await recipientVaultPublicKey(t, RECIPIENT)],
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
			// WRITE-PATH PROOF: `textBody` is CIPHERTEXT on the raw row — the receive
			// path sealed it at write (this fails if `sealBodyAtWrite` is a no-op).
			expect(isSealedAtRest(row.textBody ?? '')).toBe(true);
			// E8b seals textBody at rest; unseal it so the plaintext assertions below
			// exercise the composed E2EE-decrypt → at-rest-seal → accessor-unseal path.
			return {
				...row,
				textBody: row.textBody === undefined ? undefined : await openMessageBody(row.textBody),
			};
		});
		expect(inbound.textBody).toContain(CANARY); // decrypted
		expect(inbound.isSealed).toBe(true);
		expect(inbound.isSignatureValid).toBe(false); // UNVERIFIED
		expect(inbound.signerInstance).toBeUndefined();
	});
});

describe('e2ee.open.decryptAndReceive — the raw-bytes fields the second writer threads', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/**
	 * `decryptAndReceive` is the SECOND writer of an `inboundMessages` row, and
	 * anything the plaintext path stores has to be threaded through it as well.
	 * Nothing proved that. A refactor that dropped one of these from the args or
	 * from the `...extras` spread would land every SEALED inbound message with no
	 * raw blob — every attachment rendering as "no longer stored" on a message
	 * that arrived a minute ago — and an infected sealed message would NOT be
	 * quarantined, because `virusVerdict` would never reach `receiveMessage`.
	 * Every existing test would stay green.
	 */
	it('carries rawStorageId, rawSize and an infected verdict through to the row', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: RECIPIENT });
		const sender = await generateTestKeypair(SENDER);
		await seedPinnedSender(t, {
			address: SENDER,
			domain: 'sender.test',
			pinnedPublicKeyArmored: sender.publicKeyArmored,
		});

		const sealed = await sealMime(testInnerMessage('<mirror-e4-0003@sender.test>'), {
			recipientPublicKeysArmored: [await recipientVaultPublicKey(t, RECIPIENT)],
			signingKeyArmored: sender.privateKeyArmored,
		});

		const rawStorageId = await t.run(
			async (ctx) =>
				await ctx.storage.store(new Blob(['sealed raw bytes'], { type: 'message/rfc822' }))
		);

		await t.action(internal.e2ee.open.decryptAndReceive, {
			armoredCiphertext: sealed.armoredCiphertext,
			recipientAddress: RECIPIENT,
			from: SENDER,
			to: RECIPIENT,
			subject: '...',
			textBody: sealed.armoredCiphertext,
			messageId: '<mirror-e4-0003@sender.test>',
			timestamp: Date.now(),
			rawStorageId,
			rawSize: 16,
			virusVerdict: 'infected',
		});

		const row = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const found = await ctx.db.query('inboundMessages').first();
			if (!found) throw new Error('no inboundMessages row');
			return found;
		});

		expect(row.rawStorageId).toBe(rawStorageId);
		expect(row.rawSize).toBe(16);
		// The retention marker is derived from `rawStorageId` inside
		// `receiveMessage`, so it proves the id actually arrived there.
		expect(row.isRawRetained).toBe(true);
		// And the verdict reached the quarantine decision, not just the column.
		expect(row.virusVerdict).toBe('infected');
		expect(row.processingStatus).toBe('quarantined');
		const actions = await t.run((ctx) => ctx.db.query('agentActions').collect());
		expect(actions).toHaveLength(0);
	});
});
