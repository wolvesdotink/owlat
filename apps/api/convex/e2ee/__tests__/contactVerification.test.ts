/**
 * Human key verification (plan idea 54) — the contact-level trust claim that
 * sits on TOP of TOFU pinning.
 *
 * The properties worth defending are all about what the claim CANNOT do:
 *   - it cannot be made about a key the caller did not see (the fingerprint
 *     passed in must still be the pin);
 *   - it cannot be made about a key we would not seal to (`keyChanged`);
 *   - it cannot outlive the key it was made about — a rotation or a re-accept
 *     leaves it STALE, with no sweep and no migration;
 *   - it cannot become anonymous: the reader is told whether the check was
 *     theirs or a teammate's.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { enableSealedMail, modules } from './sealedMailTestHelpers';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async (ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) => {
			const identity = (await ctx.auth.getUserIdentity()) as { subject?: string } | null;
			return { userId: identity?.subject ?? 'test-user', role: 'member' };
		}),
		getMutationContext: vi.fn(
			async (ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) => {
				const identity = (await ctx.auth.getUserIdentity()) as { subject?: string } | null;
				return { userId: identity?.subject ?? 'test-user', role: 'member' };
			}
		),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		// The re-accept path next door is admin-gated; the stale-verification test
		// drives it, so the admin floor is satisfied here too.
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'alice', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'alice', role: 'owner' }),
	};
});

const ALICE = { subject: 'alice', issuer: 'test', tokenIdentifier: 'test|alice' };
const BOB = { subject: 'bob', issuer: 'test', tokenIdentifier: 'test|bob' };

const PIN = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const ROTATED = 'FFFF9999EEEE8888DDDD7777CCCC6666BBBB5555';

type Ctx = ReturnType<typeof convexTest>;

/** Seed one discovered, trusted recipient row for `contact@peer.test`. */
async function seedTrustedContact(t: Ctx, fingerprint = PIN): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('recipientKeys', {
			address: 'contact@peer.test',
			domain: 'peer.test',
			outcome: 'trusted',
			pinnedFingerprint: fingerprint,
			pinnedPublicKeyArmored: 'KEY:PINNED',
			observedFingerprint: fingerprint,
			source: 'wkd',
			expiresAt: Date.now() + 86_400_000,
			discoveredAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function setup(): Promise<Ctx> {
	const t = convexTest(schema, modules);
	await enableSealedMail(t);
	await seedTrustedContact(t);
	return t;
}

const readStatus = (t: Ctx, identity = ALICE) =>
	t
		.withIdentity(identity)
		.query(api.e2ee.recipientKeys.getRecipientKeyStatus, { address: 'contact@peer.test' });

describe('e2ee/recipientKeys · setContactKeyVerified', () => {
	it('records an attributed verification against the fingerprint the caller saw', async () => {
		const t = await setup();
		await expect(
			t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'contact@peer.test',
				verified: true,
				fingerprint: PIN,
			})
		).resolves.toEqual({ verified: true });

		const mine = await readStatus(t, ALICE);
		expect(mine?.verifiedFingerprint).toBe(PIN);
		expect(mine?.verifiedAt).toBeTypeOf('number');
		expect(mine?.verifiedByMe).toBe(true);

		// The same row read by someone else is verified, but not by THEM.
		const theirs = await readStatus(t, BOB);
		expect(theirs?.verifiedFingerprint).toBe(PIN);
		expect(theirs?.verifiedByMe).toBe(false);
	});

	it('normalises the fingerprint it stores, so spacing never breaks a comparison', async () => {
		const t = await setup();
		await t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
			address: 'contact@peer.test',
			verified: true,
			// Exactly what the panel renders: grouped, and pasted back lower-cased.
			fingerprint: 'aaaa 1111 bbbb 2222 cccc 3333 dddd 4444 eeee 5555',
		});
		expect((await readStatus(t))?.verifiedFingerprint).toBe(PIN);
	});

	it('refuses a fingerprint that is no longer the pin', async () => {
		const t = await setup();
		await expect(
			t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'contact@peer.test',
				verified: true,
				fingerprint: ROTATED,
			})
		).rejects.toThrow();
		expect((await readStatus(t))?.verifiedFingerprint).toBeNull();
	});

	it('refuses to verify at all without a fingerprint', async () => {
		const t = await setup();
		await expect(
			t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'contact@peer.test',
				verified: true,
			})
		).rejects.toThrow();
	});

	it('refuses to verify a contact whose key changed under us', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('recipientKeys', {
				address: 'contact@peer.test',
				domain: 'peer.test',
				outcome: 'keyChanged',
				pinnedFingerprint: PIN,
				pinnedPublicKeyArmored: 'KEY:PINNED',
				observedFingerprint: ROTATED,
				observedPublicKeyArmored: 'KEY:OBSERVED',
				source: 'wkd',
				expiresAt: Date.now() + 86_400_000,
				discoveredAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await expect(
			t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'contact@peer.test',
				verified: true,
				fingerprint: PIN,
			})
		).rejects.toThrow();
	});

	it('refuses an address we have never discovered', async () => {
		const t = convexTest(schema, modules);
		await enableSealedMail(t);
		await expect(
			t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'stranger@peer.test',
				verified: true,
				fingerprint: PIN,
			})
		).rejects.toThrow();
	});

	it('lets anyone withdraw a verification, with no fingerprint needed', async () => {
		const t = await setup();
		await t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
			address: 'contact@peer.test',
			verified: true,
			fingerprint: PIN,
		});
		// Removing a trust claim is the safe direction, so a teammate may do it.
		await expect(
			t.withIdentity(BOB).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'contact@peer.test',
				verified: false,
			})
		).resolves.toEqual({ verified: false });
		const status = await readStatus(t);
		expect(status?.verifiedFingerprint).toBeNull();
		expect(status?.verifiedAt).toBeNull();
		expect(status?.verifiedByMe).toBe(false);
	});

	it('stays shut when Sealed Mail is off', async () => {
		const t = convexTest(schema, modules);
		await seedTrustedContact(t);
		await expect(
			t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
				address: 'contact@peer.test',
				verified: true,
				fingerprint: PIN,
			})
		).rejects.toThrow();
	});
});

describe('e2ee/recipientKeys · a verification does not outlive its key', () => {
	it('goes stale when an admin re-accepts a changed key', async () => {
		const t = await setup();
		await t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
			address: 'contact@peer.test',
			verified: true,
			fingerprint: PIN,
		});

		// The contact rotates without a signed statement, and an admin re-accepts.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('recipientKeys')
				.withIndex('by_address', (q) => q.eq('address', 'contact@peer.test'))
				.first();
			await ctx.db.patch(row!._id, {
				outcome: 'keyChanged',
				observedFingerprint: ROTATED,
				observedPublicKeyArmored: 'KEY:ROTATED',
			});
		});
		await t
			.withIdentity(ALICE)
			.mutation(api.e2ee.recipientKeys.reacceptKeyChange, { address: 'contact@peer.test' });

		// The verification was not deleted — it simply no longer describes the pin,
		// which is what makes it self-invalidating rather than reliant on a sweep.
		const status = await readStatus(t);
		expect(status?.pinnedFingerprint).toBe(ROTATED);
		expect(status?.verifiedFingerprint).toBe(PIN);
		expect(status?.verifiedFingerprint).not.toBe(status?.pinnedFingerprint);
	});

	it('survives an ordinary re-discovery of the SAME key', async () => {
		const t = await setup();
		await t.withIdentity(ALICE).mutation(api.e2ee.recipientKeys.setContactKeyVerified, {
			address: 'contact@peer.test',
			verified: true,
			fingerprint: PIN,
		});
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('recipientKeys')
				.withIndex('by_address', (q) => q.eq('address', 'contact@peer.test'))
				.first();
			// What `upsertDiscovery` writes on a cache refresh: everything but the
			// verification fields.
			await ctx.db.patch(row!._id, { expiresAt: Date.now() + 86_400_000 });
		});
		const status = await readStatus(t);
		expect(status?.verifiedFingerprint).toBe(status?.pinnedFingerprint);
	});
});
