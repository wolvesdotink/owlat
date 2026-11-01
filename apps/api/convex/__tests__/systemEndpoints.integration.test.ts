/**
 * The system mail, update, release check, backup, audit log and storage
 * endpoints (`maintenance/`, `auditActions/logs`, `storage/files`): what each
 * reads and writes, and the auth floor each keeps. Only `Date` is faked.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const session = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'admin' | 'editor',
	isMember: true,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	const member = () => ({
		userId: 'admin-user',
		role: session.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => member()),
		getMutationContext: vi.fn(async () => member()),
		isActiveOrgMember: vi.fn(async () => session.isMember),
		getBetterAuthSessionWithRole: vi.fn(async () => member()),
		// The adminQuery floor (organization:manage).
		requireOrgPermission: vi.fn(async () => {
			if (session.role === 'editor') throw new Error('Insufficient permissions');
			return member();
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');
const NOW = Date.UTC(2026, 9, 1, 12);

type T = TestConvex<typeof schema>;
type User = ReturnType<T['withIdentity']>;

beforeEach(() => {
	session.role = 'owner';
	session.isMember = true;
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	vi.stubEnv('OWLAT_VERSION', '1.0.0');
	vi.stubEnv('SITE_URL', 'https://owlat.example');
	vi.stubEnv('EMAIL_PROVIDER', undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

/** A harness whose `admin` is a platform admin and whose `stranger` is not. */
async function setup(): Promise<{ t: T; admin: User; stranger: User }> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await t.run((ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId: 'admin-user',
			email: 'admin-user@example.com',
			role: 'admin',
			createdAt: NOW,
		})
	);
	return {
		t,
		admin: t.withIdentity({ subject: 'admin-user', issuer: 'test' }),
		stranger: t.withIdentity({ subject: 'stranger', issuer: 'test' }),
	};
}

/** Every `updateRun` row without its id. */
async function updateRuns(t: T) {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('systemUpdates')
				.withIndex('by_kind_and_startedAt', (q) => q.eq('kind', 'updateRun'))
				.collect()
		).map(({ _id, _creationTime, ...rest }) => rest)
	);
}

async function latestChecks(t: T) {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('systemUpdates')
				.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
				.collect()
		).map(({ _id, _creationTime, ...rest }) => rest)
	);
}

describe('system mail actions', () => {
	const mail = {
		to: 'user@example.com',
		from: 'Owlat <noreply@owlat.example>',
		subject: 'Reset your password',
		html: '<p>Reset link</p>',
	};

	it('trySendSystemEmail reports a configuration failure with no transport', async () => {
		const { t } = await setup();

		expect(await t.action(internal.maintenance.systemMail.trySendSystemEmail, mail)).toMatchObject({
			status: 'failed',
			provider: null,
			errorCode: 'CONFIGURATION',
		});
	});

	it('sendSystemEmail throws with no transport', async () => {
		const { t } = await setup();

		await expect(t.action(internal.maintenance.systemMail.sendSystemEmail, mail)).rejects.toThrow(
			/No system email transport configured/
		);
	});
});

describe('update endpoints', () => {
	it('recordUpdateStart, recordUpdateActivity and recordUpdateFinish write the run', async () => {
		const { t, admin } = await setup();

		const runId = await admin.mutation(api.maintenance.updates.recordUpdateStart, {
			versionFrom: '1.0.0',
			versionTo: '1.1.0',
		});
		expect(await admin.query(api.maintenance.updates.getUnfinishedUpdate, {})).toEqual({
			runId,
			versionTo: '1.1.0',
		});
		await admin.mutation(api.maintenance.updates.recordUpdateActivity, {});
		expect(await admin.query(api.maintenance.updates.getRolloutActivity, {})).toEqual({
			activeAt: NOW,
		});
		await admin.mutation(api.maintenance.updates.recordUpdateFinish, {
			runId,
			status: 'success',
			steps: [],
		});

		expect(await updateRuns(t)).toEqual([
			expect.objectContaining({
				status: 'success',
				initiatedBy: 'admin-user',
				lastActivityAt: NOW,
				finishedAt: NOW,
			}),
		]);
	});

	it('withdrawUpdateStart takes back a refused run', async () => {
		const { t, admin } = await setup();

		const runId = await admin.mutation(api.maintenance.updates.recordUpdateStart, {
			versionFrom: '1.0.0',
			versionTo: '1.1.0',
		});
		await admin.mutation(api.maintenance.updates.withdrawUpdateStart, { runId });
		expect(await updateRuns(t)).toEqual([]);
	});

	it('the reads answer the history, the cached release and no unfinished run', async () => {
		const { t, admin } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('systemUpdates', {
				kind: 'latestCheck',
				latestVersion: '1.2.0',
				releaseNotes: 'notes',
				publishedAt: NOW,
				checkedAt: NOW,
			});
			for (const versionTo of ['1.1.0', '1.2.0']) {
				await ctx.db.insert('systemUpdates', {
					kind: 'updateRun',
					versionFrom: '1.0.0',
					versionTo,
					startedAt: NOW - (versionTo === '1.1.0' ? 2 : 1),
					status: 'success',
					initiatedBy: 'admin-user',
				});
			}
		});

		const history = await admin.query(api.maintenance.updates.listUpdateHistory, { limit: 1 });
		expect(history.map((row) => row.versionTo)).toEqual(['1.2.0']);
		expect(await admin.query(api.maintenance.updates.getLatestRelease, {})).toMatchObject({
			latestVersion: '1.2.0',
			releaseNotes: 'notes',
		});
		expect(await admin.query(api.maintenance.updates.getUnfinishedUpdate, {})).toBeNull();
		expect(await admin.query(api.maintenance.updates.getRolloutActivity, {})).toEqual({
			activeAt: null,
		});
	});

	it('keep the platform-admin floor and the member answer', async () => {
		const { t, stranger } = await setup();
		const runId = await t.run((ctx) =>
			ctx.db.insert('systemUpdates', {
				kind: 'updateRun',
				versionFrom: '1.0.0',
				versionTo: '1.1.0',
				startedAt: NOW,
				status: 'running',
				initiatedBy: 'admin-user',
			})
		);
		const refused = /Platform admin access required/;

		await expect(
			stranger.mutation(api.maintenance.updates.recordUpdateStart, {
				versionFrom: '1.0.0',
				versionTo: '1.2.0',
			})
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.maintenance.updates.recordUpdateFinish, { runId, status: 'failed' })
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.maintenance.updates.withdrawUpdateStart, { runId })
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.maintenance.updates.recordUpdateActivity, {})
		).rejects.toThrow(refused);
		await expect(stranger.query(api.maintenance.updates.getLatestRelease, {})).rejects.toThrow(
			refused
		);
		await expect(stranger.query(api.maintenance.updates.getUnfinishedUpdate, {})).rejects.toThrow(
			refused
		);
		await expect(stranger.query(api.maintenance.updates.listUpdateHistory, {})).rejects.toThrow(
			refused
		);
		// Any member sees when the open run was last active; a non-member gets null.
		expect(await stranger.query(api.maintenance.updates.getRolloutActivity, {})).toEqual({
			activeAt: NOW,
		});
		session.isMember = false;
		expect(await stranger.query(api.maintenance.updates.getRolloutActivity, {})).toBeNull();

		expect(await updateRuns(t)).toEqual([
			expect.objectContaining({ status: 'running', versionTo: '1.1.0' }),
		]);
	});
});

describe('release check', () => {
	function stubRelease(tag: string) {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							tag_name: tag,
							body: `notes for ${tag}`,
							published_at: '2026-09-30T00:00:00Z',
							draft: false,
							prerelease: false,
						}),
						{ status: 200 }
					)
			)
		);
	}

	it('checkForUpdates answers the latest release and caches it in one row', async () => {
		const { t, admin } = await setup();
		stubRelease('v1.2.0');

		const first = await admin.action(api.maintenance.releaseCheck.checkForUpdates, { force: true });
		expect(first).toMatchObject({ latestVersion: '1.2.0', updateAvailable: true, checkedAt: NOW });
		const cache = await latestChecks(t);
		expect(cache).toHaveLength(1);

		// A second check refreshes the same row.
		expect(
			await admin.action(api.maintenance.releaseCheck.checkForUpdates, { force: true })
		).toEqual(first);
		expect(await latestChecks(t)).toEqual(cache);
	});

	it('keeps the platform-admin floor', async () => {
		const { t, stranger } = await setup();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await expect(
			stranger.action(api.maintenance.releaseCheck.checkForUpdates, { force: true })
		).rejects.toThrow(/Platform admin access required/);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await latestChecks(t)).toEqual([]);
	});

	it('the internal cache writes keep one latestCheck row, and the read returns it', async () => {
		const { t } = await setup();
		const release = { latestVersion: '1.2.0', releaseNotes: 'notes', publishedAt: NOW };

		await t.mutation(internal.maintenance.releaseCheck.cacheLatestRelease, release);
		await t.mutation(internal.maintenance.releaseCheck.cacheCheckFailure, {
			error: 'rate_limited',
		});

		const cache = await latestChecks(t);
		expect(cache).toEqual([
			{ kind: 'latestCheck', ...release, checkedAt: NOW, error: 'rate_limited' },
		]);
		expect(
			await t.query(internal.maintenance.releaseCheck.getLatestCheckInternal, {})
		).toMatchObject(cache[0]!);
	});
});

describe('backup endpoints', () => {
	it('setScheduleEnabled and logManualRun record the state getBackupState reads', async () => {
		const { t, admin } = await setup();

		expect(
			await admin.mutation(api.maintenance.backups.setScheduleEnabled, { enabled: true })
		).toEqual({
			isScheduleEnabled: true,
		});
		expect(
			await admin.mutation(api.maintenance.backups.logManualRun, { status: 'failed' })
		).toEqual({
			lastRunAt: NOW,
			lastRunStatus: 'failed',
		});
		expect(await admin.query(api.maintenance.backups.getBackupState, {})).toEqual({
			isScheduleEnabled: true,
			lastRunAt: NOW,
			lastRunStatus: 'failed',
			updatedAt: NOW,
			updatedBy: 'admin-user@example.com',
		});
		expect(await t.run((ctx) => ctx.db.query('backupState').collect())).toHaveLength(1);
	});

	it('keep the platform-admin floor', async () => {
		const { t, stranger } = await setup();
		const refused = /Platform admin access required/;

		await expect(stranger.query(api.maintenance.backups.getBackupState, {})).rejects.toThrow(
			refused
		);
		await expect(
			stranger.mutation(api.maintenance.backups.setScheduleEnabled, { enabled: true })
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.maintenance.backups.logManualRun, { status: 'success' })
		).rejects.toThrow(refused);
		expect(await t.run((ctx) => ctx.db.query('backupState').collect())).toEqual([]);
	});
});

describe('audit log reads', () => {
	async function seedAudit(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert('userProfiles', {
				authUserId: 'admin-user',
				email: 'admin-user@example.com',
				name: 'Admin',
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('auditLogs', {
				userId: 'admin-user',
				action: 'campaign.created',
				resource: 'campaign',
				organizationId: 'org-1',
				createdAt: NOW - 2000,
			});
			await ctx.db.insert('auditLogs', {
				userId: 'admin-user',
				action: 'settings.updated',
				resource: 'settings',
				organizationId: 'org-1',
				createdAt: NOW - 1000,
			});
			await ctx.db.insert('auditLogs', {
				userId: 'admin-user',
				action: 'settings.updated',
				resource: 'settings',
				organizationId: 'org-2',
				createdAt: NOW - 500,
			});
		});
	}

	it("list, getStats and getActiveUsers answer the organization's entries", async () => {
		const { t, admin } = await setup();
		await seedAudit(t);
		const filter = { resource: 'settings', limit: 10 };

		const page = await admin.query(api.auditActions.logs.list, filter);
		expect(page.logs.map((log) => [log.action, log.organizationId])).toEqual([
			['settings.updated', 'org-1'],
		]);
		expect(page.logs[0]?.userProfile?.name).toBe('Admin');

		expect(await admin.query(api.auditActions.logs.getStats, {})).toEqual({
			total: 2,
			byResource: { campaign: 1, settings: 1 },
			byAction: { 'campaign.created': 1, 'settings.updated': 1 },
		});

		const users = await admin.query(api.auditActions.logs.getActiveUsers, {});
		expect(users.map((user) => user.authUserId)).toEqual(['admin-user']);
	});

	it('keep the organization:manage floor', async () => {
		const { t, admin } = await setup();
		await seedAudit(t);
		session.role = 'editor';

		await expect(admin.query(api.auditActions.logs.list, {})).rejects.toThrow(
			/Insufficient permissions/
		);
		await expect(admin.query(api.auditActions.logs.getStats, {})).rejects.toThrow(
			/Insufficient permissions/
		);
		await expect(admin.query(api.auditActions.logs.getActiveUsers, {})).rejects.toThrow(
			/Insufficient permissions/
		);
	});
});

describe('storage endpoints', () => {
	async function storedBlob(t: T): Promise<Id<'_storage'>> {
		return await t.run((ctx) => ctx.storage.store(new Blob(['logo'])));
	}

	it('generateUploadUrl mints a pending upload bound to the caller', async () => {
		const { t, admin } = await setup();

		const url = await admin.mutation(api.storage.files.generateUploadUrl, {});

		const token = /^https:\/\/owlat\.example\/api\/storage\/upload\?token=(.+)$/.exec(url)?.[1];
		expect(token).toEqual(expect.any(String));
		const uploads = await t.run((ctx) => ctx.db.query('storageUploads').collect());
		expect(
			uploads.map(({ token, userId, organizationId, status }) => [
				token,
				userId,
				organizationId,
				status,
			])
		).toEqual([[token, 'admin-user', 'org-1', 'pending']]);
	});

	it('getUrl resolves only a media asset blob', async () => {
		const { t, admin } = await setup();
		const assetBlob = await storedBlob(t);
		const otherBlob = await storedBlob(t);
		await t.run((ctx) =>
			ctx.db.insert('mediaAssets', {
				storageId: assetBlob,
				filename: 'logo.png',
				mimeType: 'image/png',
				fileSize: 4,
				url: 'https://owlat.example/logo.png',
				uploadedBy: 'admin-user',
				createdAt: NOW,
				updatedAt: NOW,
			})
		);

		expect(await admin.query(api.storage.files.getUrl, { storageId: assetBlob })).toEqual(
			expect.any(String)
		);
		await expect(admin.query(api.storage.files.getUrl, { storageId: otherBlob })).rejects.toThrow(
			/File/
		);
	});
});
