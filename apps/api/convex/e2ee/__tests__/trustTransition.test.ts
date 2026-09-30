/**
 * Recipient-key trust transitions under overlapping writers.
 *
 * A discovery reads the row, goes to the network, then commits. Other writers
 * (another discovery, the refresh cron, an operator re-accept) can commit in
 * between. These suites drive those interleavings through the REAL persistence
 * mutations (`commitDiscoveredKey`, `recordDiscoveryMiss`, `reacceptKeyChange`)
 * and, at the end, through the discovery action itself, asserting that:
 *   - a result computed against an older row is never written over a newer one;
 *   - a miss only refreshes metadata and never removes or alters a pin;
 *   - a rotation proof only counts for the exact pin it was verified against;
 *   - an operator acceptance only adopts the key the operator was shown.
 */

import { readFileSync } from 'node:fs';
import { convexTest } from 'convex-test';
import * as openpgp from 'openpgp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import { enableSealedMail, modules, type ConvexTestCtx } from './sealedMailTestHelpers';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'admin', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin', role: 'owner' }),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

// Only the resolver is replaced, with a public-unicast answer, so the discovery
// fetch guard runs for real against an allowed address.
vi.mock('node:dns/promises', () => {
	const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
	return { default: { lookup }, lookup };
});

const ADMIN = { subject: 'admin', issuer: 'test', tokenIdentifier: 'test|admin' };
const ADDRESS = 'contact@peer.test';
const DOMAIN = 'peer.test';
const KEY_A = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const KEY_B = 'BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666';
const KEY_C = 'CCCC3333DDDD4444EEEE5555FFFF6666AAAA7777';
const DAY = 86_400_000;

type RunCtx = MutationCtx;

async function setup(): Promise<ConvexTestCtx> {
	const t = convexTest(schema, modules);
	await enableSealedMail(t);
	return t;
}

async function readRow(t: ConvexTestCtx, address = ADDRESS) {
	return await t.run(async (ctx: RunCtx) =>
		ctx.db
			.query('recipientKeys')
			.withIndex('by_address', (q) => q.eq('address', address))
			.first()
	);
}

/** The basis a discovery would record: what `getCached` returned before the fetch. */
async function readBasis(t: ConvexTestCtx) {
	const row = await readRow(t);
	return { revision: row?.revision ?? 0, pinnedFingerprint: row?.pinnedFingerprint };
}

function commit(
	t: ConvexTestCtx,
	basis: { revision: number; pinnedFingerprint?: string },
	fingerprint: string,
	rotation?: { oldFingerprint: string; newFingerprint: string }
) {
	return t.mutation(internal.e2ee.recipientKeys.commitDiscoveredKey, {
		address: ADDRESS,
		domain: DOMAIN,
		basis,
		fingerprint,
		publicKeyArmored: `KEY:${fingerprint}`,
		source: 'wkd',
		rotation,
		expiresAt: Date.now() + DAY,
	});
}

async function seedRow(
	t: ConvexTestCtx,
	fields: {
		outcome: 'trusted' | 'keyChanged' | 'notFound';
		pinned?: string;
		observed?: string;
		revision?: number;
	}
) {
	await t.run(async (ctx: RunCtx) => {
		await ctx.db.insert('recipientKeys', {
			address: ADDRESS,
			domain: DOMAIN,
			outcome: fields.outcome,
			pinnedFingerprint: fields.pinned,
			pinnedPublicKeyArmored: fields.pinned ? `KEY:${fields.pinned}` : undefined,
			observedFingerprint: fields.observed,
			observedPublicKeyArmored: fields.observed ? `KEY:${fields.observed}` : undefined,
			source: 'wkd',
			revision: fields.revision,
			expiresAt: Date.now() + DAY,
			discoveredAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('e2ee/recipientKeys · commitDiscoveredKey', () => {
	it('two first-use results read from an empty row: the second never replaces the first pin', async () => {
		const t = await setup();
		const empty = await readBasis(t);

		await expect(commit(t, empty, KEY_A)).resolves.toMatchObject({
			status: 'committed',
			outcome: 'trusted',
			action: 'firstUse',
		});
		// Same empty basis, different key: rejected as stale, nothing written.
		await expect(commit(t, empty, KEY_B)).resolves.toEqual({
			status: 'stale',
			outcome: 'trusted',
		});
		let row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.pinnedPublicKeyArmored).toBe(`KEY:${KEY_A}`);

		// The retry reads the committed row and sees an unsigned change.
		await expect(commit(t, await readBasis(t), KEY_B)).resolves.toMatchObject({
			status: 'committed',
			outcome: 'keyChanged',
			action: 'keyChanged',
		});
		row = await readRow(t);
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.pinnedPublicKeyArmored).toBe(`KEY:${KEY_A}`);
		expect(row?.observedFingerprint).toBe(KEY_B);
	});

	it('does not roll back a newer signed rotation with an observation read before it', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'trusted', pinned: KEY_A, observed: KEY_A, revision: 1 });
		const slow = await readBasis(t);
		const fast = await readBasis(t);

		await expect(
			commit(t, fast, KEY_B, { oldFingerprint: KEY_A, newFingerprint: KEY_B })
		).resolves.toMatchObject({ status: 'committed', action: 'signedRotation' });
		// The slow discovery fetched the old key before the rotation landed.
		await expect(commit(t, slow, KEY_A)).resolves.toMatchObject({ status: 'stale' });

		const row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_B);
		expect(row?.observedFingerprint).toBe(KEY_B);
	});

	it('accepts a rotation proof only for the pin it was verified against', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'trusted', pinned: KEY_C, observed: KEY_C, revision: 3 });
		const proofForA = { oldFingerprint: KEY_A, newFingerprint: KEY_B };

		// Read while the pin was A, committed after it became C: stale.
		await expect(
			commit(t, { revision: 2, pinnedFingerprint: KEY_A }, KEY_B, proofForA)
		).resolves.toMatchObject({ status: 'stale' });
		expect((await readRow(t))?.pinnedFingerprint).toBe(KEY_C);

		// Even on a current basis, a proof naming another old key is no proof.
		await expect(commit(t, await readBasis(t), KEY_B, proofForA)).resolves.toMatchObject({
			status: 'committed',
			outcome: 'keyChanged',
		});
		const row = await readRow(t);
		expect(row?.pinnedFingerprint).toBe(KEY_C);
		expect(row?.observedFingerprint).toBe(KEY_B);

		// A proof whose new key is not the committed key does not count either.
		await expect(
			commit(t, await readBasis(t), KEY_A, { oldFingerprint: KEY_C, newFingerprint: KEY_B })
		).resolves.toMatchObject({ status: 'committed', outcome: 'keyChanged' });
		expect((await readRow(t))?.pinnedFingerprint).toBe(KEY_C);
	});

	it('advances the revision on a transition and keeps it on a same-key refresh', async () => {
		const t = await setup();
		await commit(t, await readBasis(t), KEY_A);
		expect((await readRow(t))?.revision).toBe(1);

		// Two refreshes of the unchanged key from the same read both land.
		const basis = await readBasis(t);
		await expect(commit(t, basis, KEY_A)).resolves.toMatchObject({ action: 'unchanged' });
		await expect(commit(t, basis, KEY_A)).resolves.toMatchObject({ action: 'unchanged' });
		expect((await readRow(t))?.revision).toBe(1);

		await commit(t, await readBasis(t), KEY_B);
		expect((await readRow(t))?.revision).toBe(2);
	});

	it('treats a row written before revisions existed as revision 0', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'trusted', pinned: KEY_A, observed: KEY_A });
		await expect(
			commit(t, { revision: 0, pinnedFingerprint: KEY_A }, KEY_A)
		).resolves.toMatchObject({ status: 'committed', action: 'unchanged' });
	});
});

describe('e2ee/recipientKeys · recordDiscoveryMiss', () => {
	const miss = (t: ConvexTestCtx) =>
		t.mutation(internal.e2ee.recipientKeys.recordDiscoveryMiss, {
			address: ADDRESS,
			domain: DOMAIN,
			expiresAt: Date.now() + 60_000,
		});

	it('a miss that started before a pin was committed leaves that pin alone', async () => {
		const t = await setup();
		// The miss's lookup started on an empty row; the pin lands first.
		await commit(t, await readBasis(t), KEY_A);
		const before = await readRow(t);
		await miss(t);

		const row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.pinnedPublicKeyArmored).toBe(`KEY:${KEY_A}`);
		expect(row?.observedFingerprint).toBe(KEY_A);
		expect(row?.revision).toBe(before?.revision);
		// Only freshness moved: a pinned row is re-checked sooner.
		expect(row!.expiresAt).toBeLessThan(before!.expiresAt);
	});

	it('keeps a pending key change pending', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'keyChanged', pinned: KEY_A, observed: KEY_B, revision: 4 });
		await miss(t);
		const row = await readRow(t);
		expect(row?.outcome).toBe('keyChanged');
		expect(row?.observedFingerprint).toBe(KEY_B);
		expect(row?.revision).toBe(4);
	});

	it('writes a negative entry that does not make a concurrent first use stale', async () => {
		const t = await setup();
		const empty = await readBasis(t);
		await miss(t);
		expect((await readRow(t))?.outcome).toBe('notFound');

		await expect(commit(t, empty, KEY_A)).resolves.toMatchObject({
			status: 'committed',
			action: 'firstUse',
		});
		expect((await readRow(t))?.pinnedFingerprint).toBe(KEY_A);
	});
});

describe('e2ee/recipientKeys · reacceptKeyChange', () => {
	const reaccept = (t: ConvexTestCtx, observedFingerprint: string) =>
		t.withIdentity(ADMIN).mutation(api.e2ee.recipientKeys.reacceptKeyChange, {
			address: ADDRESS,
			observedFingerprint,
		});

	it('a discovery read before the acceptance cannot commit over it', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'keyChanged', pinned: KEY_A, observed: KEY_B, revision: 2 });
		const delayed = await readBasis(t);

		await expect(reaccept(t, KEY_B)).resolves.toEqual({
			reaccepted: true,
			pinnedFingerprint: KEY_B,
		});
		// The delayed discovery still saw the old key.
		await expect(commit(t, delayed, KEY_A)).resolves.toMatchObject({ status: 'stale' });

		const row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_B);
		expect(row?.revision).toBe(3);
	});

	it('refuses an acceptance of a key other than the one now observed', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'keyChanged', pinned: KEY_A, observed: KEY_B, revision: 2 });
		// Discovery observes yet another key after the operator's view was drawn.
		await commit(t, await readBasis(t), KEY_C);
		expect((await readRow(t))?.observedFingerprint).toBe(KEY_C);

		await expect(reaccept(t, KEY_B)).resolves.toEqual({ reaccepted: false });
		const row = await readRow(t);
		expect(row?.outcome).toBe('keyChanged');
		expect(row?.pinnedFingerprint).toBe(KEY_A);

		// Accepting what is actually on the row still works.
		await expect(reaccept(t, KEY_C)).resolves.toMatchObject({ reaccepted: true });
		expect((await readRow(t))?.pinnedFingerprint).toBe(KEY_C);
	});

	it('still accepts a call without a fingerprint from a previous-release client', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'keyChanged', pinned: KEY_A, observed: KEY_B });
		await expect(
			t.withIdentity(ADMIN).mutation(api.e2ee.recipientKeys.reacceptKeyChange, { address: ADDRESS })
		).resolves.toMatchObject({ reaccepted: true });
		const row = await readRow(t);
		expect(row?.pinnedFingerprint).toBe(KEY_B);
		expect(row?.revision).toBe(1);
	});
});

/** The v0.6.5 write path, still reachable by a discovery action mid-run at deploy. */
describe('e2ee/recipientKeys · upsertDiscovery (previous-release shim)', () => {
	const legacyUpsert = (
		t: ConvexTestCtx,
		fields: { outcome: 'trusted' | 'keyChanged' | 'notFound'; pinned?: string; observed?: string }
	) =>
		t.mutation(internal.e2ee.recipientKeys.upsertDiscovery, {
			address: ADDRESS,
			domain: DOMAIN,
			outcome: fields.outcome,
			pinnedFingerprint: fields.pinned,
			pinnedPublicKeyArmored: fields.pinned ? `KEY:${fields.pinned}` : undefined,
			observedFingerprint: fields.observed,
			observedPublicKeyArmored: fields.observed ? `KEY:${fields.observed}` : undefined,
			source: 'wkd',
			expiresAt: Date.now() + DAY,
		});

	it('pins a first key on a row with no pin', async () => {
		const t = await setup();
		await legacyUpsert(t, { outcome: 'trusted', pinned: KEY_A, observed: KEY_A });
		const row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.revision).toBe(1);
	});

	it('does not replace a pin with a decision made against an older row', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'trusted', pinned: KEY_A, observed: KEY_A, revision: 1 });
		// The old action saw no pin, so it believed KEY_B was a first use.
		await legacyUpsert(t, { outcome: 'trusted', pinned: KEY_B, observed: KEY_B });
		const row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.revision).toBe(1);
	});

	it('does not clear a pending key change', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'keyChanged', pinned: KEY_A, observed: KEY_B, revision: 2 });
		await legacyUpsert(t, { outcome: 'trusted', pinned: KEY_A, observed: KEY_A });
		expect((await readRow(t))?.outcome).toBe('keyChanged');
	});

	it('treats a miss as freshness only, whatever pin the old action copied', async () => {
		const t = await setup();
		await seedRow(t, { outcome: 'trusted', pinned: KEY_A, observed: KEY_A, revision: 1 });
		await legacyUpsert(t, { outcome: 'notFound' });
		const row = await readRow(t);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.pinnedPublicKeyArmored).toBe(`KEY:${KEY_A}`);
	});
});

describe('e2ee/discovery · discoverRecipientKey starts over when its read goes stale', () => {
	const BOB = 'bob@sealed.example.org';
	let bobBinary: Uint8Array;
	let bobFp: string;

	beforeAll(async () => {
		const armored = readFileSync(
			new URL('../../../fixtures/sealed-mail/pgp-mime/keys/bob.pub.asc', import.meta.url),
			'utf8'
		);
		const key = await openpgp.readKey({ armoredKey: armored });
		bobBinary = key.write();
		bobFp = key.getFingerprint().toUpperCase();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/**
	 * Serve bob's key over WKD (or a 404 when `wkd` is false). `duringFirstFetch`
	 * runs while the first WKD request is outstanding, i.e. after the discovery
	 * has read the row and before it commits.
	 */
	function stubWkd(opts: { wkd: boolean; duringFirstFetch: () => Promise<void> }) {
		let first = true;
		vi.stubGlobal('fetch', async (input: string | URL) => {
			const url = new URL(String(input));
			if (!url.pathname.startsWith('/.well-known/openpgpkey/hu/')) {
				return new Response(null, { status: 404 });
			}
			if (first) {
				first = false;
				await opts.duringFirstFetch();
			}
			return opts.wkd
				? new Response(bobBinary.slice(), { status: 200 })
				: new Response(null, { status: 404 });
		});
	}

	const competingFirstUse = (t: ConvexTestCtx) =>
		t.mutation(internal.e2ee.recipientKeys.commitDiscoveredKey, {
			address: BOB,
			domain: 'sealed.example.org',
			basis: { revision: 0 },
			fingerprint: KEY_A,
			publicKeyArmored: 'KEY:A',
			source: 'wkd',
			expiresAt: Date.now() + DAY,
		});

	it('surfaces a different key as keyChanged instead of replacing a pin committed mid-flight', async () => {
		const t = await setup();
		stubWkd({ wkd: true, duringFirstFetch: async () => void (await competingFirstUse(t)) });

		const result = await t.action(internal.e2ee.discovery.discoverRecipientKey, {
			address: BOB,
			force: true,
		});
		expect(result).toMatchObject({ outcome: 'keyChanged', action: 'keyChanged' });
		const row = await readRow(t, BOB);
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.observedFingerprint).toBe(bobFp);
	});

	it('keeps a pin committed while its failed lookup was outstanding', async () => {
		const t = await setup();
		stubWkd({ wkd: false, duringFirstFetch: async () => void (await competingFirstUse(t)) });

		await expect(
			t.action(internal.e2ee.discovery.discoverRecipientKey, { address: BOB, force: true })
		).resolves.toMatchObject({ outcome: 'notFound' });
		const row = await readRow(t, BOB);
		expect(row?.outcome).toBe('trusted');
		expect(row?.pinnedFingerprint).toBe(KEY_A);
		expect(row?.pinnedPublicKeyArmored).toBe('KEY:A');
	});
});
