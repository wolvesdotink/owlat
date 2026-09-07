/**
 * accountExport staging replay and quotas: one active session and one staged
 * artifact per page cursor, fresh staging when a row changes mid-session, an
 * explicit failure when the session quota is full, and streamed artifacts
 * released so a session can stage past its in-flight cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resetSessionMock } from './gdprSessionMock';
import {
	EXPORT_TEST_SECRET,
	EXPORT_TEST_SITE,
	newHarness,
	seedProfile,
	seedOrg,
	seedMember,
} from './gdprAccountFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('accountExport staging replay and quotas', () => {
	it('reuses one active session and one staged artifact for repeated page cursors', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('emailTemplates', {
				name: 'Replay-safe template',
				subject: 'Replay subject',
				content: JSON.stringify([{ id: 'text', type: 'text', content: { html: 'body' } }]),
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
		});

		const firstManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		const secondManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		expect(secondManifest.exportSessionId).toBe(firstManifest.exportSessionId);

		const pageArgs = {
			userId: 'auth-user-1',
			exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
			resource: 'emailTemplates' as const,
			organizationId: orgId,
		};
		const firstPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const replayedPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const staged = (page: (typeof firstPage)['pageJson']) => {
			const row = JSON.parse(page[0]!) as {
				contentDownloadUrl: string;
				contentArtifactId: Id<'accountExportArtifacts'>;
				contentLeaseToken: string;
			};
			return {
				...row,
				storageId: new URL(row.contentDownloadUrl).searchParams.get('id'),
			};
		};
		const first = staged(firstPage.pageJson);
		const replay = staged(replayedPage.pageJson);
		expect(replay.storageId).toBe(first.storageId);
		expect(replay.contentLeaseToken).not.toBe(first.contentLeaseToken);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: first.contentArtifactId,
				leaseToken: first.contentLeaseToken,
			})
		).resolves.toBe(true);
		const replayUrl = new URL(replay.contentDownloadUrl);
		await expect(t.fetch(`${replayUrl.pathname}${replayUrl.search}`)).resolves.toMatchObject({
			ok: true,
		});

		const ledger = await t.run(async (ctx) => ({
			sessions: await ctx.db.query('accountExportSessions').collect(),
			artifacts: await ctx.db.query('accountExportArtifacts').collect(),
			leases: await ctx.db.query('accountExportArtifactLeases').collect(),
		}));
		expect(ledger.sessions).toHaveLength(1);
		expect(ledger.artifacts).toHaveLength(1);
		expect(ledger.leases).toHaveLength(1);
		expect(ledger.sessions[0]).toMatchObject({
			artifactCount: 1,
			artifactBytes: ledger.artifacts[0]!.contentLength,
		});

		vi.stubEnv('INSTANCE_SECRET', undefined);
		await expect(t.action(api.auth.accountExport.exportUserDataPage, pageArgs)).rejects.toThrow(
			'Could not create account export artifact URL'
		);
		await expect(
			t.run(async (ctx) => ({
				artifacts: await ctx.db.query('accountExportArtifacts').collect(),
				leases: await ctx.db.query('accountExportArtifactLeases').collect(),
			}))
		).resolves.toMatchObject({
			artifacts: [expect.objectContaining({ activeLeaseCount: 1 })],
			leases: [expect.objectContaining({ leaseToken: replay.contentLeaseToken })],
		});
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: replay.contentArtifactId,
				leaseToken: 'wrong-token',
			})
		).resolves.toBe(false);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: replay.contentArtifactId,
				leaseToken: replay.contentLeaseToken,
			})
		).resolves.toBe(true);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: replay.contentArtifactId,
				leaseToken: replay.contentLeaseToken,
			})
		).resolves.toBe(false);
		await expect(
			t.run(async (ctx) => ({
				artifact: await ctx.db.get(replay.contentArtifactId),
				leases: await ctx.db.query('accountExportArtifactLeases').collect(),
				blob: await ctx.storage.get(replay.storageId as Id<'_storage'>),
			}))
		).resolves.toEqual({ artifact: null, leases: [], blob: null });
	});

	it('stages fresh content when a row changes during a reused session', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		const templateId = await t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert('emailTemplates', {
				name: 'Mutable template',
				subject: 'Mutable subject',
				content: JSON.stringify([{ id: 'text', type: 'text', content: { html: 'first' } }]),
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
		});

		const firstManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		const pageArgs = {
			userId: 'auth-user-1',
			exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
			resource: 'emailTemplates' as const,
			organizationId: orgId,
		};
		const firstPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		await t.run(async (ctx) => {
			await ctx.db.patch(templateId, {
				content: JSON.stringify([{ id: 'text', type: 'text', content: { html: 'second' } }]),
				updatedAt: Date.now() + 1,
			});
		});
		const secondManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		expect(secondManifest.exportSessionId).toBe(firstManifest.exportSessionId);
		const secondPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);

		const stagedContent = async (page: (typeof firstPage)['pageJson']) => {
			const row = JSON.parse(page[0]!) as { contentDownloadUrl: string };
			const stagedUrl = new URL(row.contentDownloadUrl);
			const response = await t.fetch(`${stagedUrl.pathname}${stagedUrl.search}`);
			expect(response.ok).toBe(true);
			return {
				storageId: stagedUrl.searchParams.get('id'),
				content: await response.json(),
			};
		};
		const firstContent = await stagedContent(firstPage.pageJson);
		const secondContent = await stagedContent(secondPage.pageJson);
		expect(firstContent.storageId).not.toBe(secondContent.storageId);
		expect(firstContent.content).toMatchObject({
			editorContent: {
				availability: 'available',
				value: [{ content: { html: 'first' } }],
			},
		});
		expect(secondContent.content).toMatchObject({
			editorContent: {
				availability: 'available',
				value: [{ content: { html: 'second' } }],
			},
		});
		const artifacts = await t.run(async (ctx) => ctx.db.query('accountExportArtifacts').collect());
		expect(artifacts).toHaveLength(2);
	});

	it('fails explicitly without registering another artifact when the session quota is full', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		const sessionId = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('emailTemplates', {
				name: 'Quota template',
				subject: 'Quota subject',
				content: '[]',
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
			return ctx.db.insert('accountExportSessions', {
				userId: 'auth-user-1',
				artifactCount: 5_000,
				artifactBytes: 0,
				createdAt: now,
				expiresAt: now + 60_000,
			});
		});

		await expect(
			t.action(api.auth.accountExport.exportUserDataPage, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				resource: 'emailTemplates',
				organizationId: orgId,
			})
		).rejects.toThrow('Account export staging quota exceeded');
		const artifacts = await t.run(async (ctx) => ctx.db.query('accountExportArtifacts').collect());
		expect(artifacts).toHaveLength(0);
	});

	it('releases streamed artifacts so one session can stage beyond its in-flight cap', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		const initialExpiry = Date.now() + 60_000;
		const sessionId = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('emailTemplates', {
				name: 'In-flight quota template',
				subject: 'Quota subject',
				content: '[]',
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
			return ctx.db.insert('accountExportSessions', {
				userId: 'auth-user-1',
				artifactCount: 4_999,
				artifactBytes: 0,
				createdAt: now,
				expiresAt: initialExpiry,
			});
		});
		const pageArgs = {
			userId: 'auth-user-1',
			exportSessionId: sessionId,
			resource: 'emailTemplates' as const,
			organizationId: orgId,
		};
		const stagedArtifact = (pageJson: string[]) => {
			const row = JSON.parse(pageJson[0]!) as {
				contentArtifactId: Id<'accountExportArtifacts'>;
				contentDownloadUrl: string;
				contentLeaseToken: string;
			};
			return {
				artifactId: row.contentArtifactId,
				storageId: new URL(row.contentDownloadUrl).searchParams.get('id'),
				leaseToken: row.contentLeaseToken,
			};
		};

		const firstPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const first = stagedArtifact(firstPage.pageJson);
		expect(
			await t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				artifactId: first.artifactId,
				leaseToken: first.leaseToken,
			})
		).toBe(true);

		const secondPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const second = stagedArtifact(secondPage.pageJson);
		expect(second.storageId).not.toBe(first.storageId);
		const ledger = await t.run(async (ctx) => ({
			session: await ctx.db.get(sessionId),
			artifacts: await ctx.db.query('accountExportArtifacts').collect(),
		}));
		expect(ledger.session).toMatchObject({ artifactCount: 5_000 });
		expect(ledger.session!.expiresAt).toBeGreaterThan(initialExpiry + 30 * 60_000);
		expect(ledger.artifacts).toHaveLength(1);

		expect(
			await t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				artifactId: second.artifactId,
				leaseToken: second.leaseToken,
			})
		).toBe(true);
		expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toMatchObject({
			artifactCount: 4_999,
			artifactBytes: 0,
		});
	});
});
