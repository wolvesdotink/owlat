/**
 * Outbound sealing — the DB-integration half of the E3 hard gate (the pure
 * decision lives in `sealPolicy.test.ts`, the crypto in `e2ee/seal.test.ts`).
 *
 *   - `getOutboundSealInputs` reads the flag + org policy + per-recipient TOFU
 *     state + signer presence from the real tables, returning ONLY public key
 *     material (never the private signing key).
 *   - The all-recipients rule (D2): one keyless recipient => `decideSeal` sends
 *     plaintext with `recipient_no_key`; a `policy: 'off'` org never seals.
 *   - CAPSTONE: the public keys the query hands back, fed through `sealMime` with
 *     the vault's own signing key, produce ciphertext whose stored `.eml` bytes
 *     contain NO plaintext canary — the exact bytes `outbound.ts` stores.
 *   - `draftLifecycle.getSealState` returns all three composer states.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createSecretBox } from '../../lib/credentialCrypto';
import { decideSeal } from '../sealPolicy';
import { sealMime } from '../../e2ee/seal';
import { modules } from './testModules';

const E2EE_KEY_BOX = { salt: 'owlat:e2ee:keys:salt:v1', info: 'owlat:e2ee:keys:v1' };
const INSTANCE_SECRET = 'unit-test-instance-secret-value';

const SEALED_FLAGS = { postbox: true, senderAuthBadges: true, sealedMail: true };

type T = ReturnType<typeof convexTest>;

async function seedSettings(
	t: T,
	opts: { flags?: Record<string, boolean>; sealPolicy?: 'auto' | 'ask' | 'off' } = {}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: opts.flags ?? SEALED_FLAGS,
			...(opts.sealPolicy ? { sealPolicy: opts.sealPolicy } : {}),
			createdAt: Date.now(),
		});
	});
}

async function seedRecipient(
	t: T,
	address: string,
	outcome: 'trusted' | 'keyChanged' | 'notFound',
	pinnedPublicKeyArmored?: string
): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('recipientKeys', {
			address,
			domain: address.slice(address.indexOf('@') + 1),
			outcome,
			...(pinnedPublicKeyArmored ? { pinnedPublicKeyArmored, pinnedFingerprint: 'FP' } : {}),
			expiresAt: now + 60_000,
			discoveredAt: now,
			updatedAt: now,
		});
	});
}

async function generatePublicKey(
	email: string
): Promise<{ publicKeyArmored: string; privateKeyArmored: string }> {
	const { publicKey, privateKey } = await openpgp.generateKey({
		type: 'curve25519',
		userIDs: [{ name: email, email }],
		format: 'armored',
	});
	return { publicKeyArmored: publicKey, privateKeyArmored: privateKey };
}

describe('mail/outboundSeal · getOutboundSealInputs + decideSeal', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('gathers policy + signer + per-recipient TOFU state (public keys only)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		// A real signing key in the vault for the From address.
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		const { publicKeyArmored } = await generatePublicKey('bob@b.test');
		await seedRecipient(t, 'bob@b.test', 'trusted', publicKeyArmored);

		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['bob@b.test', 'BOB@b.test'], // dedupes on normalized address
		});
		expect(inputs.flagEnabled).toBe(true);
		expect(inputs.policy).toBe('auto');
		expect(inputs.hasSigningKey).toBe(true);
		expect(inputs.recipients).toHaveLength(1);
		expect(inputs.recipients[0]?.outcome).toBe('trusted');
		expect(inputs.recipients[0]?.pinnedPublicKeyArmored).toContain('PUBLIC KEY');
		// The private signing key must NEVER ride along in this query result.
		expect(JSON.stringify(inputs)).not.toContain('PRIVATE');

		expect(decideSeal(inputs).seal).toBe(true);
	});

	it('one keyless recipient => plaintext with reason recorded (D2, no mixed send)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		const { publicKeyArmored } = await generatePublicKey('bob@b.test');
		await seedRecipient(t, 'bob@b.test', 'trusted', publicKeyArmored);
		await seedRecipient(t, 'dave@d.test', 'notFound');

		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['bob@b.test', 'dave@d.test'],
		});
		expect(decideSeal(inputs)).toEqual({ seal: false, reason: 'recipient_no_key' });
	});

	it('policy off never seals even when every recipient is trusted', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t, { sealPolicy: 'off' });
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		const { publicKeyArmored } = await generatePublicKey('bob@b.test');
		await seedRecipient(t, 'bob@b.test', 'trusted', publicKeyArmored);

		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['bob@b.test'],
		});
		expect(inputs.policy).toBe('off');
		expect(decideSeal(inputs)).toEqual({ seal: false, reason: 'policy_off' });
	});

	it('flag off never seals (defaults to plaintext with flag_off)', async () => {
		const t = convexTest(schema, modules);
		// No sealedMail flag seeded.
		await seedSettings(t, { flags: { postbox: true } });
		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['bob@b.test'],
		});
		expect(inputs.flagEnabled).toBe(false);
		expect(decideSeal(inputs)).toEqual({ seal: false, reason: 'flag_off' });
	});

	it('CAPSTONE: the sealed .eml bytes carry NO plaintext canary', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		const recipient = await generatePublicKey('bob@b.test');
		await seedRecipient(t, 'bob@b.test', 'trusted', recipient.publicKeyArmored);

		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['bob@b.test'],
		});
		const decision = decideSeal(inputs);
		expect(decision.seal).toBe(true);
		if (!decision.seal) throw new Error('expected seal');

		// Open the vault signing key exactly as outbound.ts does.
		const signingRow = await t.query(internal.e2ee.keys.getAddressKeyInternal, {
			address: 'alice@a.test',
		});
		expect(signingRow).not.toBeNull();
		const box = createSecretBox(INSTANCE_SECRET, E2EE_KEY_BOX);
		const signingKeyArmored = box.open(signingRow!.sealedPrivateKey);

		const CANARY = 'CANARY_OUTBOUND_SEALED_a17f3b';
		const raw = [
			'Message-ID: <c@a.test>',
			'From: alice@a.test',
			'To: bob@b.test',
			'Subject: Confidential subject line',
			'MIME-Version: 1.0',
			'Content-Type: text/plain; charset=utf-8',
			'',
			`the ${CANARY} body`,
			'',
		].join('\r\n');

		const sealed = await sealMime(raw, {
			recipientPublicKeysArmored: decision.recipientPublicKeysArmored,
			signingKeyArmored,
			protectSubject: true,
		});
		// The stored .eml (== sealed.mime) leaks neither the body canary nor the subject.
		expect(sealed.mime).not.toContain(CANARY);
		expect(sealed.mime).not.toContain('Confidential subject line');
		expect(sealed.mime).toMatch(/^Subject: \.\.\.\r?$/m);
		expect(sealed.encryptionInfo.algorithm).toBe('pgp-mime');
	});
});

describe('mail/draftLifecycle · getSealState (three composer states)', () => {
	async function insertDraft(t: T, recipients: string[]): Promise<Id<'mailDrafts'>> {
		return await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'u1',
				organizationId: 'o1',
				address: 'alice@a.test',
				domain: 'a.test',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			return await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: recipients,
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'alice@a.test',
				subject: 'hi',
				bodyHtml: '',
				attachments: [],
				state: 'draft',
				lastEditedAt: now,
				createdAt: now,
			});
		});
	}

	it('willSeal when policy allows and the recipient is trusted', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await seedRecipient(t, 'bob@b.test', 'trusted', 'ARMORED');
		const draftId = await insertDraft(t, ['bob@b.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'willSeal',
		});
	});

	it('keyChanged surfaces the rotated recipient', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await seedRecipient(t, 'eve@e.test', 'keyChanged');
		const draftId = await insertDraft(t, ['eve@e.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'keyChanged',
			addresses: ['eve@e.test'],
		});
	});

	it('cannotSeal when a recipient has no usable key', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		const draftId = await insertDraft(t, ['nokey@x.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'cannotSeal',
			reason: 'recipient_no_key',
		});
	});

	it('cannotSeal (flag_off) when Sealed Mail is disabled', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t, { flags: { postbox: true } });
		await seedRecipient(t, 'bob@b.test', 'trusted', 'ARMORED');
		const draftId = await insertDraft(t, ['bob@b.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'cannotSeal',
			reason: 'flag_off',
		});
	});
});
