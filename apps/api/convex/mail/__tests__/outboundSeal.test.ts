/**
 * Outbound sealing — the DB-integration half of the E3 hard gate (the pure
 * decision lives in `sealPolicy.test.ts`, the crypto in `e2ee/seal.test.ts`).
 *
 *   - `getOutboundSealInputs` reads the flag + org policy + per-recipient TOFU
 *     state + signer presence from the real tables, returning ONLY public key
 *     material (never the private signing key).
 *   - The all-recipients rule (D2): one keyless recipient => `decideSeal` sends
 *     plaintext with `recipient_no_key`; a `policy: 'off'` org never seals.
 *   - CAPSTONE: `internal.mail.outbound.dispatchDraft` is run END-TO-END under
 *     convex-test (no MTA env → the message is stored + the sent cascade runs but
 *     nothing is POSTed). We then read the blob at the sent row's `rawStorageId`
 *     and assert THOSE STORED BYTES carry no plaintext canary and the row's
 *     `encryptionInfo.sealed` is true — the exact bytes `outbound.ts` persisted,
 *     so a wiring bug (storing `raw` instead of the sealed bytes) fails here.
 *   - The agent-reply path (an AI-authored draft) dispatches through the SAME
 *     action and must seal identically.
 *   - `draftLifecycle.getSealState` returns all three composer states.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { decideSeal } from '../sealPolicy';
import { modules } from './testModules';
import { isSealedBytesAtRest } from '../../lib/atRestBodies';
import { readSealedBlobBytes } from '../../lib/sealedBlob';

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
		expect(inputs.discoveryAddresses).toEqual([]);
		expect(inputs.recipients).toHaveLength(1);
		expect(inputs.recipients[0]?.outcome).toBe('trusted');
		expect(inputs.recipients[0]?.pinnedPublicKeyArmored).toContain('PUBLIC KEY');
		// The private signing key must NEVER ride along in this query result.
		expect(JSON.stringify(inputs)).not.toContain('PRIVATE');

		expect(decideSeal(inputs).seal).toBe(true);
	});

	it('marks absent and expired recipient rows for dispatch-time discovery', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		await seedRecipient(t, 'expired@b.test', 'notFound');
		await t.run(async (ctx) => {
			const stale = await ctx.db
				.query('recipientKeys')
				.withIndex('by_address', (q) => q.eq('address', 'expired@b.test'))
				.first();
			if (stale) await ctx.db.patch(stale._id, { expiresAt: Date.now() - 1 });
		});

		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['new@b.test', 'expired@b.test'],
		});
		expect(inputs.discoveryAddresses).toEqual(['new@b.test', 'expired@b.test']);
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
		// sealedMail defaults ON at ship time; disable it explicitly to exercise
		// the flag-off branch (postbox on, sealed mail turned off for this deployment).
		await seedSettings(t, { flags: { postbox: true, sealedMail: false } });
		const inputs = await t.query(internal.mail.outboundQueries.getOutboundSealInputs, {
			fromAddress: 'alice@a.test',
			recipients: ['bob@b.test'],
		});
		expect(inputs.flagEnabled).toBe(false);
		expect(decideSeal(inputs)).toEqual({ seal: false, reason: 'flag_off' });
	});
});

describe('mail/outbound · dispatchDraft stores SEALED bytes (capstone)', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		// No MTA transport configured: dispatchDraft still stores the `.eml` and runs
		// the sent cascade, it just POSTs nothing. That is exactly the branch we want.
		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/**
	 * Seed a sealable Postbox draft (org auto-seal, a vault signing key for the
	 * From address, one trusted recipient), run the REAL `dispatchDraft` action,
	 * then hand back the bytes actually stored at the sent row's `rawStorageId`
	 * plus its `encryptionInfo`. `agent: true` marks the draft AI-authored (an
	 * `aiDraftBaseline` snapshot) — the agent-reply path — which dispatches through
	 * the identical action and must seal the same way.
	 */
	async function dispatchAndReadStored(
		t: T,
		opts: { agent: boolean; canary: string }
	): Promise<{ storedText: string; encryptionInfo: { isSealed: boolean } | undefined }> {
		await seedSettings(t);
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		const recipient = await generatePublicKey('bob@b.test');
		await seedRecipient(t, 'bob@b.test', 'trusted', recipient.publicKeyArmored);

		const draftId = await t.run(async (ctx) => {
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
			// The sent cascade needs the mailbox's Sent folder to land the message,
			// otherwise the `to:'sent'` transition refuses with `sent_folder_missing`
			// and no `mailMessages` row is ever stored.
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'Sent',
				role: 'sent',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 0,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			return await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['bob@b.test'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'alice@a.test',
				subject: `Confidential ${opts.canary}`,
				bodyHtml: `<p>the ${opts.canary} body</p>`,
				attachments: [],
				state: 'pending_send',
				scheduledSendAt: now + 10_000,
				undoToken: 'tok-seal',
				// An agent-authored reply carries the AI baseline snapshot; a human
				// draft does not. Both dispatch through the SAME dispatchDraft path.
				...(opts.agent
					? { aiDraftBaseline: { text: `agent original ${opts.canary}`, capturedAt: now } }
					: {}),
				lastEditedAt: now,
				createdAt: now,
			});
		});

		await t.action(internal.mail.outbound.dispatchDraft, { draftId, undoToken: 'tok-seal' });

		return await t.run(async (ctx) => {
			const rows = await ctx.db.query('mailMessages').collect();
			const sent = rows[0];
			if (!sent) throw new Error('dispatchDraft stored no sent mailMessages row');
			// E8b seals the stored `.eml` blob at rest (byte cipher) on top of any
			// E2EE PGP sealing. Prove that at-rest layer is present, then unseal it so
			// the assertions below inspect the actual (PGP or plaintext) `.eml`.
			const storedBlob = await ctx.storage.get(sent.rawStorageId);
			if (!storedBlob) throw new Error('stored .eml blob missing');
			expect(isSealedBytesAtRest(new Uint8Array(await storedBlob.arrayBuffer()))).toBe(true);
			const rawBytes = await readSealedBlobBytes(ctx.storage, sent.rawStorageId);
			return {
				storedText: rawBytes ? new TextDecoder().decode(rawBytes) : '',
				encryptionInfo: sent.encryptionInfo as { isSealed: boolean } | undefined,
			};
		});
	}

	it('CAPSTONE: the STORED .eml bytes carry no plaintext canary and the row is sealed', async () => {
		const t = convexTest(schema, modules);
		const CANARY = 'CANARY_OUTBOUND_HUMAN_a17f3b';
		const { storedText, encryptionInfo } = await dispatchAndReadStored(t, {
			agent: false,
			canary: CANARY,
		});
		// The bytes outbound.ts actually stored — the sealed ciphertext, not `raw`.
		expect(storedText).not.toContain(CANARY);
		expect(storedText).toContain('multipart/encrypted; protocol="application/pgp-encrypted"');
		expect(storedText).toMatch(/^Subject: \.\.\.\r?$/m);
		expect(encryptionInfo).toMatchObject({ isSealed: true, algorithm: 'pgp-mime' });
	});

	it('agent-reply path seals — an AI-authored draft stores sealed bytes too', async () => {
		const t = convexTest(schema, modules);
		const CANARY = 'CANARY_OUTBOUND_AGENT_b28e4c';
		const { storedText, encryptionInfo } = await dispatchAndReadStored(t, {
			agent: true,
			canary: CANARY,
		});
		expect(storedText).not.toContain(CANARY);
		expect(storedText).toContain('multipart/encrypted; protocol="application/pgp-encrypted"');
		expect(encryptionInfo).toMatchObject({ isSealed: true, algorithm: 'pgp-mime' });
	});
});

describe('mail/draftLifecycle · getSealState (three composer states)', () => {
	// Minting the From-address signing key opens the E2EE secret box, so the
	// vault crypto needs INSTANCE_SECRET — same as the dispatch-path describes.
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

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

	it('willSeal when policy allows, the recipient is trusted, and the sender can sign', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		// A minted signing key for the From address — willSeal now requires it, so
		// the composer promise matches what dispatch would actually do.
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		await seedRecipient(t, 'bob@b.test', 'trusted', 'ARMORED');
		const draftId = await insertDraft(t, ['bob@b.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'willSeal',
		});
	});

	it('cannotSeal (no_signing_key) when the sender has no minted key', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		// Recipient is trusted, but the From address never had a key minted: the
		// composer must NOT promise sealing when dispatch would send plaintext.
		await seedRecipient(t, 'bob@b.test', 'trusted', 'ARMORED');
		const draftId = await insertDraft(t, ['bob@b.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'cannotSeal',
			reason: 'no_signing_key',
		});
	});

	it('cannotSeal (policy_ask) when everything is ready but the org asks first', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t, { sealPolicy: 'ask' });
		await t.action(internal.e2ee.keysNode.mintForAddress, { address: 'alice@a.test' });
		await seedRecipient(t, 'bob@b.test', 'trusted', 'ARMORED');
		const draftId = await insertDraft(t, ['bob@b.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'cannotSeal',
			reason: 'policy_ask',
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
		// sealedMail defaults ON now; turn it off explicitly to test the disabled branch.
		await seedSettings(t, { flags: { postbox: true, sealedMail: false } });
		await seedRecipient(t, 'bob@b.test', 'trusted', 'ARMORED');
		const draftId = await insertDraft(t, ['bob@b.test']);
		expect(await t.query(internal.mail.draftLifecycle.getSealState, { draftId })).toEqual({
			kind: 'cannotSeal',
			reason: 'flag_off',
		});
	});

	it('throws for a missing draft rather than mislabelling it "no_recipients"', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		const draftId = await insertDraft(t, ['bob@b.test']);
		await t.run(async (ctx) => {
			await ctx.db.delete(draftId);
		});
		await expect(t.query(internal.mail.draftLifecycle.getSealState, { draftId })).rejects.toThrow(
			/not found/
		);
	});
});
