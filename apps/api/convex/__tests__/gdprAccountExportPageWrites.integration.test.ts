/**
 * What one `exportUserDataPage` call writes besides its answer: a page renews
 * the export session, a content page stages one leased artifact per row, a
 * row whose download link cannot be minted leaves no artifact, lease or blob
 * behind, and a page against an expired session writes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resetSessionMock } from './gdprSessionMock';
import {
	EXPORT_TEST_SECRET,
	EXPORT_TEST_SITE,
	newHarness,
	seedMember,
	seedOrg,
	seedProfile,
} from './gdprAccountFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

type Harness = ReturnType<typeof newHarness>;

const HOUR_MS = 60 * 60 * 1_000;

async function setup(t: Harness, expiresIn: number) {
	await seedProfile(t, 'auth-user-1');
	const orgId = await seedOrg(t);
	await seedMember(t, orgId, 'auth-user-1', 'owner');
	const sessionId = await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('emailTemplates', {
			name: 'Staged template',
			subject: 'Staged subject',
			content: '[]',
			type: 'marketing',
			status: 'draft',
			createdAt: now,
			updatedAt: now,
		});
		return ctx.db.insert('accountExportSessions', {
			userId: 'auth-user-1',
			artifactCount: 0,
			artifactBytes: 0,
			leaseCount: 0,
			createdAt: now,
			expiresAt: now + expiresIn,
		});
	});
	return { orgId, sessionId };
}

async function ledger(t: Harness, sessionId: Id<'accountExportSessions'>) {
	return await t.run(async (ctx) => ({
		session: await ctx.db.get(sessionId),
		artifacts: await ctx.db.query('accountExportArtifacts').collect(),
		leases: await ctx.db.query('accountExportArtifactLeases').collect(),
		blobs: await ctx.db.system.query('_storage').collect(),
	}));
}

beforeEach(() => {
	resetSessionMock();
	vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
	vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('exportUserDataPage writes', () => {
	it('renews the session on a page without content and stages nothing', async () => {
		const t = newHarness();
		const { sessionId } = await setup(t, 60_000);
		const before = Date.now();

		await t.action(api.auth.accountExport.exportUserDataPage, {
			userId: 'auth-user-1',
			exportSessionId: sessionId,
			resource: 'savedReplies',
		});

		const after = await ledger(t, sessionId);
		expect(after.session!.expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS);
		expect(after.artifacts).toEqual([]);
		expect(after.leases).toEqual([]);
		expect(after.blobs).toEqual([]);
	});

	it('stages one leased artifact for a content row and counts it on the session', async () => {
		const t = newHarness();
		const { orgId, sessionId } = await setup(t, 60_000);

		const page = await t.action(api.auth.accountExport.exportUserDataPage, {
			userId: 'auth-user-1',
			exportSessionId: sessionId,
			resource: 'emailTemplates',
			organizationId: orgId,
		});

		const row = JSON.parse(page.pageJson[0]!) as {
			contentArtifactId: Id<'accountExportArtifacts'>;
			contentLeaseToken: string;
			contentDownloadUrl: string;
		};
		const after = await ledger(t, sessionId);
		expect(after.artifacts).toEqual([
			expect.objectContaining({
				_id: row.contentArtifactId,
				sessionId,
				activeLeaseCount: 1,
			}),
		]);
		expect(new URL(row.contentDownloadUrl).searchParams.get('id')).toBe(
			after.artifacts[0]!.storageId
		);
		expect(after.leases).toEqual([
			expect.objectContaining({
				sessionId,
				artifactId: row.contentArtifactId,
				leaseToken: row.contentLeaseToken,
			}),
		]);
		expect(after.blobs).toHaveLength(1);
		expect(after.session).toMatchObject({
			artifactCount: 1,
			artifactBytes: after.artifacts[0]!.contentLength,
			leaseCount: 1,
		});
	});

	it('leaves no artifact, lease or blob when the download link cannot be minted', async () => {
		const t = newHarness();
		const { orgId, sessionId } = await setup(t, 60_000);
		// A sealed blob without a site to serve it from fails closed.
		vi.stubEnv('CONVEX_SITE_URL', undefined);

		await expect(
			t.action(api.auth.accountExport.exportUserDataPage, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				resource: 'emailTemplates',
				organizationId: orgId,
			})
		).rejects.toThrow();

		const after = await ledger(t, sessionId);
		expect(after.artifacts).toEqual([]);
		expect(after.leases).toEqual([]);
		expect(after.blobs).toEqual([]);
		expect(after.session).toMatchObject({ artifactCount: 0, artifactBytes: 0, leaseCount: 0 });
	});

	it('writes nothing for a page against an expired session', async () => {
		const t = newHarness();
		const { orgId, sessionId } = await setup(t, -1);
		const before = await ledger(t, sessionId);

		await expect(
			t.action(api.auth.accountExport.exportUserDataPage, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				resource: 'emailTemplates',
				organizationId: orgId,
			})
		).rejects.toThrow('Account export session is missing or expired');

		expect(await ledger(t, sessionId)).toEqual(before);
	});
});
