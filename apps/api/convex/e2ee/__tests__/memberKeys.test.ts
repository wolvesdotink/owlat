/**
 * The member-facing half of Sealed Mail (plan idea 55).
 *
 * Two things are being defended here. First, HONESTY: the Preferences card must
 * say "this address has no key" when it has none, because a member whose mail is
 * not actually being sealed learns it here or nowhere. Second, SCOPE: the
 * ownership predicate behind the recovery-kit gate must answer for the SESSION
 * user and nobody else — it is the check that stops one member from asking for
 * another's private key, and its only input is the address.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import { enableSealedMail, modules } from './sealedMailTestHelpers';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const fromIdentity = async (ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) => {
		const identity = (await ctx.auth.getUserIdentity()) as { subject?: string } | null;
		return { userId: identity?.subject ?? 'test-user', role: 'member' };
	};
	return {
		...actual,
		requireOrgMember: vi.fn(fromIdentity),
		getMutationContext: vi.fn(fromIdentity),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

const ALICE = { subject: 'alice', issuer: 'test', tokenIdentifier: 'test|alice' };
const BOB = { subject: 'bob', issuer: 'test', tokenIdentifier: 'test|bob' };

type Ctx = ReturnType<typeof convexTest>;
// `t.run`'s callback ctx is generic on the handle, and the handle type above has
// no data model, so seed helpers annotate it with this project's MutationCtx to
// get the real tables and indexes back.
type RunCtx = MutationCtx;

async function seedMailbox(t: Ctx, userId: string, address: string): Promise<void> {
	await t.run(async (ctx: RunCtx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'org1',
			address,
			domain: address.split('@')[1]!,
			status: 'active',
			usedBytes: 0,
			uidValidity: Date.now(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return mailboxId;
	});
}

async function seedAlias(t: Ctx, alias: string, targetAddress: string): Promise<void> {
	await t.run(async (ctx: RunCtx) => {
		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_address', (q) => q.eq('address', targetAddress))
			.first();
		await ctx.db.insert('mailAliases', {
			alias,
			targetMailboxId: mailbox!._id,
			organizationId: 'org1',
			createdAt: Date.now(),
		});
	});
}

async function seedVaultKey(t: Ctx, address: string, fingerprint: string): Promise<void> {
	await t.run(async (ctx: RunCtx) => {
		await ctx.db.insert('keyVault', {
			kind: 'address',
			address,
			domain: address.split('@')[1]!,
			wkdHash: 'hash',
			fingerprint,
			algorithm: 'eddsaLegacy',
			publicKeyArmored: 'PUB',
			publicKeyBinaryBase64: 'UFVC',
			sealedPrivateKey: { ciphertext: 'c', iv: 'i', authTag: 'a' },
			isActive: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('e2ee/memberKeys · getOwnSealedMailStatus', () => {
	it('reports every address the caller sends as, and which of them hold a key', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		await seedMailbox(t, 'alice', 'alice@owlat.test');
		await seedAlias(t, 'sales@owlat.test', 'alice@owlat.test');
		await seedVaultKey(t, 'alice@owlat.test', 'FPRALICE');

		const status = await t
			.withIdentity(ALICE)
			.query(api.e2ee.memberKeys.getOwnSealedMailStatus, {});
		expect(status.enabled).toBe(true);
		expect(status.addresses).toEqual([
			{ address: 'alice@owlat.test', hasKey: true, fingerprint: 'FPRALICE' },
			// The alias is a real sendable identity with no key of its own — said
			// plainly rather than hidden behind the mailbox that does have one.
			{ address: 'sales@owlat.test', hasKey: false, fingerprint: null },
		]);
	});

	it('never reports an address belonging to another member', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		await seedMailbox(t, 'alice', 'alice@owlat.test');
		await seedMailbox(t, 'bob', 'bob@owlat.test');
		await seedVaultKey(t, 'bob@owlat.test', 'FPRBOB');

		const status = await t
			.withIdentity(ALICE)
			.query(api.e2ee.memberKeys.getOwnSealedMailStatus, {});
		expect(status.addresses.map((a) => a.address)).toEqual(['alice@owlat.test']);
	});

	it('reports the flag as off rather than throwing, so the card can self-hide', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, 'alice', 'alice@owlat.test');
		await expect(
			t.withIdentity(ALICE).query(api.e2ee.memberKeys.getOwnSealedMailStatus, {})
		).resolves.toEqual({ enabled: false, addresses: [] });
	});
});

describe('e2ee/memberKeys · isOwnSendableAddress', () => {
	it('accepts the mailbox address the caller owns, and its aliases', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, 'alice', 'alice@owlat.test');
		await seedAlias(t, 'sales@owlat.test', 'alice@owlat.test');
		const asAlice = t.withIdentity(ALICE);
		await expect(
			asAlice.query(internal.e2ee.memberKeys.isOwnSendableAddress, {
				address: 'Alice@Owlat.test',
			})
		).resolves.toBe(true);
		await expect(
			asAlice.query(internal.e2ee.memberKeys.isOwnSendableAddress, { address: 'sales@owlat.test' })
		).resolves.toBe(true);
	});

	it('refuses an address belonging to another member', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, 'alice', 'alice@owlat.test');
		await seedMailbox(t, 'bob', 'bob@owlat.test');
		await expect(
			t
				.withIdentity(ALICE)
				.query(internal.e2ee.memberKeys.isOwnSendableAddress, { address: 'bob@owlat.test' })
		).resolves.toBe(false);
	});

	it('refuses a shared inbox the caller is only a MEMBER of', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, 'alice', 'team@owlat.test');
		await t.run(async (ctx: RunCtx) => {
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_address', (q) => q.eq('address', 'team@owlat.test'))
				.first();
			await ctx.db.patch(mailbox!._id, { scope: 'shared' });
			await ctx.db.insert('mailboxMembers', {
				mailboxId: mailbox!._id,
				authUserId: 'bob',
				role: 'member',
				addedBy: 'alice',
				createdAt: Date.now(),
			});
		});
		// Bob can read and send from the team inbox. That does not make its private
		// key his to download.
		await expect(
			t
				.withIdentity(BOB)
				.query(internal.e2ee.memberKeys.isOwnSendableAddress, { address: 'team@owlat.test' })
		).resolves.toBe(false);
	});

	it('refuses an anonymous caller and a suspended mailbox', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, 'alice', 'alice@owlat.test');
		await expect(
			t.query(internal.e2ee.memberKeys.isOwnSendableAddress, { address: 'alice@owlat.test' })
		).resolves.toBe(false);

		await t.run(async (ctx: RunCtx) => {
			const mailbox = await ctx.db
				.query('mailboxes')
				.withIndex('by_address', (q) => q.eq('address', 'alice@owlat.test'))
				.first();
			await ctx.db.patch(mailbox!._id, { status: 'suspended' });
		});
		await expect(
			t
				.withIdentity(ALICE)
				.query(internal.e2ee.memberKeys.isOwnSendableAddress, { address: 'alice@owlat.test' })
		).resolves.toBe(false);
	});
});

describe('e2ee/memberKeys · the recovery-kit re-auth throttle', () => {
	it('locks out after five failures and keeps its own budget', async () => {
		const t = convexTest(schema, modules);
		const address = 'alice@owlat.test';
		const throttled = () => t.query(internal.e2ee.memberKeys.isRecoveryKitThrottled, { address });

		expect(await throttled()).toBe(false);
		for (let i = 0; i < 4; i++) {
			await t.mutation(internal.e2ee.memberKeys.recordRecoveryKitFailure, { address });
		}
		expect(await throttled()).toBe(false);
		await t.mutation(internal.e2ee.memberKeys.recordRecoveryKitFailure, { address });
		expect(await throttled()).toBe(true);
	});

	it('does not count SMTP/IMAP failures, so a mail client cannot lock the prompt', async () => {
		const t = convexTest(schema, modules);
		const address = 'alice@owlat.test';
		await t.run(async (ctx: RunCtx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert('mailAuthFailures', {
					address,
					scope: 'smtp',
					occurredAt: Date.now(),
				});
			}
		});
		await expect(
			t.query(internal.e2ee.memberKeys.isRecoveryKitThrottled, { address })
		).resolves.toBe(false);
	});

	it('lets an old lockout expire', async () => {
		const t = convexTest(schema, modules);
		const address = 'alice@owlat.test';
		await t.run(async (ctx: RunCtx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert('mailAuthFailures', {
					address,
					scope: 'recovery-kit',
					occurredAt: Date.now() - 60 * 60 * 1000,
				});
			}
		});
		await expect(
			t.query(internal.e2ee.memberKeys.isRecoveryKitThrottled, { address })
		).resolves.toBe(false);
	});
});
