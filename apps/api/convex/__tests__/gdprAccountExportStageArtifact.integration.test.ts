/**
 * `stageArtifact`, the one commit per staged export row: it leases only an
 * artifact holding the blob the page minted its link for, registers a blob
 * the page stored when the key is free, and otherwise leases nothing, deletes
 * the page's own blob and hands back what the key holds now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resetSessionMock } from './gdprSessionMock';
import { newHarness, seedProfile } from './gdprAccountFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

type Harness = ReturnType<typeof newHarness>;

const KEY = 'emailTemplates:row-1:digest';

async function setup(t: Harness) {
	await seedProfile(t, 'auth-user-1');
	return await t.run(async (ctx) => {
		const now = Date.now();
		const sessionId = await ctx.db.insert('accountExportSessions', {
			userId: 'auth-user-1',
			artifactCount: 0,
			artifactBytes: 0,
			leaseCount: 0,
			createdAt: now,
			expiresAt: now + 60_000,
		});
		const blob = await ctx.storage.store(new Blob(['{"a":1}']));
		return { sessionId, blob };
	});
}

async function storeBlob(t: Harness): Promise<Id<'_storage'>> {
	return await t.run((ctx) => ctx.storage.store(new Blob(['{"a":1}'])));
}

async function ledger(t: Harness, sessionId: Id<'accountExportSessions'>) {
	return await t.run(async (ctx) => ({
		session: await ctx.db.get(sessionId),
		artifacts: await ctx.db.query('accountExportArtifacts').collect(),
		leases: await ctx.db.query('accountExportArtifactLeases').collect(),
		blobs: (await ctx.db.system.query('_storage').collect()).map((blob) => blob._id),
	}));
}

const stage = (
	t: Harness,
	sessionId: Id<'accountExportSessions'>,
	storageId: Id<'_storage'>,
	isFreshBlob: boolean,
	leaseToken: string
) =>
	t.mutation(internal.auth.accountExportArtifacts.stageArtifact, {
		userId: 'auth-user-1',
		sessionId,
		artifactKey: KEY,
		storageId,
		isFreshBlob,
		contentLength: 7,
		leaseToken,
	});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('stageArtifact', () => {
	it('registers a fresh blob under a free key, then leases the same artifact again', async () => {
		const t = newHarness();
		const { sessionId, blob } = await setup(t);

		const first = await stage(t, sessionId, blob, true, 'lease-1');
		expect(first).toEqual({ kind: 'staged', artifactId: expect.any(String) });
		const second = await stage(t, sessionId, blob, false, 'lease-2');
		expect(second).toEqual(first);

		const after = await ledger(t, sessionId);
		expect(after.artifacts).toEqual([
			expect.objectContaining({ storageId: blob, artifactKey: KEY, activeLeaseCount: 2 }),
		]);
		expect(after.leases.map((lease) => lease.leaseToken).sort()).toEqual(['lease-1', 'lease-2']);
		expect(after.session).toMatchObject({ artifactCount: 1, artifactBytes: 7, leaseCount: 2 });
	});

	it('leases nothing and deletes its own blob when another blob holds the key', async () => {
		const t = newHarness();
		const { sessionId, blob } = await setup(t);
		await stage(t, sessionId, blob, true, 'lease-1');
		const late = await storeBlob(t);
		const before = await ledger(t, sessionId);

		const result = await stage(t, sessionId, late, true, 'lease-2');

		expect(result).toEqual({
			kind: 'restage',
			artifact: expect.objectContaining({ storageId: blob, artifactKey: KEY }),
		});
		const after = await ledger(t, sessionId);
		expect(after.artifacts).toEqual(before.artifacts);
		expect(after.leases).toEqual(before.leases);
		expect(after.blobs).toEqual(before.blobs.filter((id) => id !== late));
		expect(after.session).toMatchObject({ artifactCount: 1, leaseCount: 1 });
	});

	it('leases nothing when the artifact the page found is gone and it brought no blob', async () => {
		const t = newHarness();
		const { sessionId, blob } = await setup(t);
		const before = await ledger(t, sessionId);

		expect(await stage(t, sessionId, blob, false, 'lease-1')).toEqual({
			kind: 'restage',
			artifact: null,
		});
		const after = await ledger(t, sessionId);
		expect(after.artifacts).toEqual([]);
		expect(after.leases).toEqual([]);
		// Not the page's blob to delete: it read it from the artifact.
		expect(after.blobs).toEqual(before.blobs);
	});

	it('renews the session it stages into', async () => {
		const t = newHarness();
		const { sessionId, blob } = await setup(t);
		const before = Date.now();

		await stage(t, sessionId, blob, true, 'lease-1');

		const { session } = await ledger(t, sessionId);
		expect(session!.expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1_000);
	});

	it('registers nothing past the session quota', async () => {
		const t = newHarness();
		const { sessionId, blob } = await setup(t);
		await t.run((ctx) => ctx.db.patch(sessionId, { artifactCount: 5_000 }));

		await expect(stage(t, sessionId, blob, true, 'lease-1')).rejects.toThrow(
			'Account export staging quota exceeded'
		);
		expect((await ledger(t, sessionId)).artifacts).toEqual([]);
	});
});
