/**
 * The previous release's system mail, updates, backups, audit log and storage
 * paths (`systemMail:*`, `systemUpdates:*`, `systemUpdatesReleaseCheck:*`,
 * `backups:*`, `auditLogs:*`, `storage:*`) keep working against this release:
 * each old path takes the same arguments, declares the same result, keeps its
 * auth floor, and reads and writes what its moved function in `maintenance/`,
 * `auditActions/logs` or `storage/files` does.
 *
 * Only `Date` is faked, so two calls made at the same instant write rows that
 * compare equal.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import * as oldSystemMail from '../systemMail';
import * as oldUpdates from '../systemUpdates';
import * as oldReleaseCheck from '../systemUpdatesReleaseCheck';
import * as oldBackups from '../backups';
import * as oldAuditLogs from '../auditLogs';
import * as oldStorage from '../storage';
import * as systemMail from '../maintenance/systemMail';
import * as updates from '../maintenance/updates';
import * as releaseCheck from '../maintenance/releaseCheck';
import * as backups from '../maintenance/backups';
import * as auditLogs from '../auditActions/logs';
import * as storageFiles from '../storage/files';

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

/** Every `updateRun` row without the fields two equal writes cannot share. */
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

describe('previous-release system paths: shapes', () => {
	it('keep the builder kind, visibility, arguments and result of the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as {
				isQuery?: boolean;
				isMutation?: boolean;
				isAction?: boolean;
				isPublic?: boolean;
				isInternal?: boolean;
				exportArgs(): string;
				exportReturns(): string;
			};
			return {
				kind: [registered.isQuery, registered.isMutation, registered.isAction],
				visibility: [registered.isPublic, registered.isInternal],
				args: registered.exportArgs(),
				returns: registered.exportReturns(),
			};
		};
		const pairs: [unknown, unknown][] = [
			[oldSystemMail.sendSystemEmail, systemMail.sendSystemEmail],
			[oldSystemMail.trySendSystemEmail, systemMail.trySendSystemEmail],
			[oldUpdates.recordUpdateStart, updates.recordUpdateStart],
			[oldUpdates.recordUpdateFinish, updates.recordUpdateFinish],
			[oldUpdates.withdrawUpdateStart, updates.withdrawUpdateStart],
			[oldUpdates.getLatestRelease, updates.getLatestRelease],
			[oldUpdates.getUnfinishedUpdate, updates.getUnfinishedUpdate],
			[oldUpdates.recordUpdateActivity, updates.recordUpdateActivity],
			[oldUpdates.getRolloutActivity, updates.getRolloutActivity],
			[oldUpdates.listUpdateHistory, updates.listUpdateHistory],
			[oldReleaseCheck.checkForUpdates, releaseCheck.checkForUpdates],
			[oldReleaseCheck.cacheLatestRelease, releaseCheck.cacheLatestRelease],
			[oldReleaseCheck.cacheCheckFailure, releaseCheck.cacheCheckFailure],
			[oldReleaseCheck.getLatestCheckInternal, releaseCheck.getLatestCheckInternal],
			[oldBackups.getBackupState, backups.getBackupState],
			[oldBackups.setScheduleEnabled, backups.setScheduleEnabled],
			[oldBackups.logManualRun, backups.logManualRun],
			[oldAuditLogs.list, auditLogs.list],
			[oldAuditLogs.getStats, auditLogs.getStats],
			[oldAuditLogs.getActiveUsers, auditLogs.getActiveUsers],
			[oldStorage.generateUploadUrl, storageFiles.generateUploadUrl],
			[oldStorage.getUrl, storageFiles.getUrl],
		];
		expect(pairs).toHaveLength(22);
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		// The previous System page reads every field of the declared result.
		expect(Object.keys(JSON.parse(shape(oldReleaseCheck.checkForUpdates).returns).value)).toEqual([
			'latestVersion',
			'currentVersion',
			'updateAvailable',
			'releaseNotes',
			'publishedAt',
			'checkedAt',
			'error',
		]);
	});
});

describe('previous-release system mail paths', () => {
	const mail = {
		to: 'user@example.com',
		from: 'Owlat <noreply@owlat.example>',
		subject: 'Reset your password',
		html: '<p>Reset link</p>',
	};

	it('systemMail:trySendSystemEmail reports what maintenance/systemMail:trySendSystemEmail does', async () => {
		const { t } = await setup();

		const old = await t.action(internal.systemMail.trySendSystemEmail, mail);
		expect(old).toEqual(await t.action(internal.maintenance.systemMail.trySendSystemEmail, mail));
		expect(old).toMatchObject({ status: 'failed', provider: null, errorCode: 'CONFIGURATION' });
	});

	it('systemMail:sendSystemEmail throws what maintenance/systemMail:sendSystemEmail throws', async () => {
		const { t } = await setup();

		await expect(t.action(internal.systemMail.sendSystemEmail, mail)).rejects.toThrow(
			/No system email transport configured/
		);
		await expect(t.action(internal.maintenance.systemMail.sendSystemEmail, mail)).rejects.toThrow(
			/No system email transport configured/
		);
	});
});

describe('previous-release update paths', () => {
	it('systemUpdates:recordUpdateStart, recordUpdateActivity and recordUpdateFinish write what maintenance/updates does', async () => {
		const { t, admin } = await setup();
		const run = { versionFrom: '1.0.0', versionTo: '1.1.0' };
		const verdict = { status: 'success' as const, steps: [] };

		const oldRun = await admin.mutation(api.systemUpdates.recordUpdateStart, run);
		expect(await admin.query(api.systemUpdates.getUnfinishedUpdate, {})).toEqual({
			runId: oldRun,
			versionTo: '1.1.0',
		});
		expect(await admin.query(api.systemUpdates.getUnfinishedUpdate, {})).toEqual(
			await admin.query(api.maintenance.updates.getUnfinishedUpdate, {})
		);
		await admin.mutation(api.systemUpdates.recordUpdateActivity, {});
		expect(await admin.query(api.systemUpdates.getRolloutActivity, {})).toEqual({
			activeAt: NOW,
		});
		await admin.mutation(api.systemUpdates.recordUpdateFinish, { runId: oldRun, ...verdict });
		const [oldRow] = await updateRuns(t);

		await t.run((ctx) => ctx.db.delete(oldRun));
		const newRun = await admin.mutation(api.maintenance.updates.recordUpdateStart, run);
		await admin.mutation(api.maintenance.updates.recordUpdateActivity, {});
		await admin.mutation(api.maintenance.updates.recordUpdateFinish, { runId: newRun, ...verdict });

		expect(await updateRuns(t)).toEqual([oldRow]);
		expect(oldRow).toMatchObject({
			status: 'success',
			initiatedBy: 'admin-user',
			lastActivityAt: NOW,
			finishedAt: NOW,
		});
	});

	it('systemUpdates:withdrawUpdateStart takes back a refused run as maintenance/updates does', async () => {
		const { t, admin } = await setup();

		const runId = await admin.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: '1.0.0',
			versionTo: '1.1.0',
		});
		await admin.mutation(api.systemUpdates.withdrawUpdateStart, { runId });
		expect(await updateRuns(t)).toEqual([]);

		const newRunId = await admin.mutation(api.maintenance.updates.recordUpdateStart, {
			versionFrom: '1.0.0',
			versionTo: '1.1.0',
		});
		await admin.mutation(api.maintenance.updates.withdrawUpdateStart, { runId: newRunId });
		expect(await updateRuns(t)).toEqual([]);
	});

	it('the old update reads answer what maintenance/updates answers', async () => {
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

		const history = await admin.query(api.systemUpdates.listUpdateHistory, { limit: 1 });
		expect(history.map((row) => row.versionTo)).toEqual(['1.2.0']);
		expect(history).toEqual(
			await admin.query(api.maintenance.updates.listUpdateHistory, { limit: 1 })
		);
		const release = await admin.query(api.systemUpdates.getLatestRelease, {});
		expect(release).toMatchObject({ latestVersion: '1.2.0', releaseNotes: 'notes' });
		expect(release).toEqual(await admin.query(api.maintenance.updates.getLatestRelease, {}));
		expect(await admin.query(api.systemUpdates.getUnfinishedUpdate, {})).toBeNull();
		expect(await admin.query(api.systemUpdates.getRolloutActivity, {})).toEqual({
			activeAt: null,
		});
	});

	it('keep the platform-admin floor and the member answer on the old paths', async () => {
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
			stranger.mutation(api.systemUpdates.recordUpdateStart, {
				versionFrom: '1.0.0',
				versionTo: '1.2.0',
			})
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.systemUpdates.recordUpdateFinish, { runId, status: 'failed' })
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.systemUpdates.withdrawUpdateStart, { runId })
		).rejects.toThrow(refused);
		await expect(stranger.mutation(api.systemUpdates.recordUpdateActivity, {})).rejects.toThrow(
			refused
		);
		await expect(stranger.query(api.systemUpdates.getLatestRelease, {})).rejects.toThrow(refused);
		await expect(stranger.query(api.systemUpdates.getUnfinishedUpdate, {})).rejects.toThrow(
			refused
		);
		await expect(stranger.query(api.systemUpdates.listUpdateHistory, {})).rejects.toThrow(refused);
		// Any member sees when the open run was last active; a non-member gets null.
		expect(await stranger.query(api.systemUpdates.getRolloutActivity, {})).toEqual({
			activeAt: NOW,
		});
		session.isMember = false;
		expect(await stranger.query(api.systemUpdates.getRolloutActivity, {})).toBeNull();

		expect(await updateRuns(t)).toEqual([
			expect.objectContaining({ status: 'running', versionTo: '1.1.0' }),
		]);
	});
});

describe('previous-release release check paths', () => {
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

	it('systemUpdatesReleaseCheck:checkForUpdates answers and caches what maintenance/releaseCheck does', async () => {
		const { t, admin } = await setup();
		stubRelease('v1.2.0');

		const old = await admin.action(api.systemUpdatesReleaseCheck.checkForUpdates, { force: true });
		const oldCache = await latestChecks(t);
		const moved = await admin.action(api.maintenance.releaseCheck.checkForUpdates, {
			force: true,
		});

		expect(old).toEqual(moved);
		expect(old).toMatchObject({ latestVersion: '1.2.0', updateAvailable: true, checkedAt: NOW });
		expect(await latestChecks(t)).toEqual(oldCache);
		expect(oldCache).toHaveLength(1);
	});

	it('keeps the platform-admin floor on the old check', async () => {
		const { t, stranger } = await setup();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await expect(
			stranger.action(api.systemUpdatesReleaseCheck.checkForUpdates, { force: true })
		).rejects.toThrow(/Platform admin access required/);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await latestChecks(t)).toEqual([]);
	});

	it('the old internal cache paths read and write the latestCheck row as the moved ones do', async () => {
		const { t } = await setup();
		const release = { latestVersion: '1.2.0', releaseNotes: 'notes', publishedAt: NOW };

		await t.mutation(internal.systemUpdatesReleaseCheck.cacheLatestRelease, release);
		await t.mutation(internal.systemUpdatesReleaseCheck.cacheCheckFailure, {
			error: 'rate_limited',
		});
		const oldCache = await latestChecks(t);
		const oldRead = await t.query(internal.systemUpdatesReleaseCheck.getLatestCheckInternal, {});
		expect(oldRead).toEqual(
			await t.query(internal.maintenance.releaseCheck.getLatestCheckInternal, {})
		);

		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('systemUpdates').collect()) await ctx.db.delete(row._id);
		});
		await t.mutation(internal.maintenance.releaseCheck.cacheLatestRelease, release);
		await t.mutation(internal.maintenance.releaseCheck.cacheCheckFailure, {
			error: 'rate_limited',
		});

		expect(await latestChecks(t)).toEqual(oldCache);
		expect(oldCache).toEqual([
			{ kind: 'latestCheck', ...release, checkedAt: NOW, error: 'rate_limited' },
		]);
	});
});

describe('previous-release backup paths', () => {
	it('backups:setScheduleEnabled, logManualRun and getBackupState record what maintenance/backups does', async () => {
		const { t, admin } = await setup();

		expect(await admin.mutation(api.backups.setScheduleEnabled, { enabled: true })).toEqual({
			isScheduleEnabled: true,
		});
		expect(await admin.mutation(api.backups.logManualRun, { status: 'failed' })).toEqual({
			lastRunAt: NOW,
			lastRunStatus: 'failed',
		});
		const old = await admin.query(api.backups.getBackupState, {});
		expect(old).toEqual({
			isScheduleEnabled: true,
			lastRunAt: NOW,
			lastRunStatus: 'failed',
			updatedAt: NOW,
			updatedBy: 'admin-user@example.com',
		});

		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('backupState').collect()) await ctx.db.delete(row._id);
		});
		await admin.mutation(api.maintenance.backups.setScheduleEnabled, { enabled: true });
		await admin.mutation(api.maintenance.backups.logManualRun, { status: 'failed' });
		expect(await admin.query(api.maintenance.backups.getBackupState, {})).toEqual(old);
		expect(await admin.query(api.backups.getBackupState, {})).toEqual(old);
	});

	it('keep the platform-admin floor on the old backup paths', async () => {
		const { t, stranger } = await setup();
		const refused = /Platform admin access required/;

		await expect(stranger.query(api.backups.getBackupState, {})).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.backups.setScheduleEnabled, { enabled: true })
		).rejects.toThrow(refused);
		await expect(
			stranger.mutation(api.backups.logManualRun, { status: 'success' })
		).rejects.toThrow(refused);
		expect(await t.run((ctx) => ctx.db.query('backupState').collect())).toEqual([]);
	});
});

describe('previous-release audit log paths', () => {
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

	it('auditLogs:list, getStats and getActiveUsers answer what auditActions/logs answers', async () => {
		const { t, admin } = await setup();
		await seedAudit(t);
		const filter = { resource: 'settings', limit: 10 };

		const page = await admin.query(api.auditLogs.list, filter);
		expect(page).toEqual(await admin.query(api.auditActions.logs.list, filter));
		expect(page.logs.map((log) => [log.action, log.organizationId])).toEqual([
			['settings.updated', 'org-1'],
		]);
		expect(page.logs[0]?.userProfile?.name).toBe('Admin');

		const stats = await admin.query(api.auditLogs.getStats, {});
		expect(stats).toEqual(await admin.query(api.auditActions.logs.getStats, {}));
		expect(stats).toEqual({
			total: 2,
			byResource: { campaign: 1, settings: 1 },
			byAction: { 'campaign.created': 1, 'settings.updated': 1 },
		});

		const users = await admin.query(api.auditLogs.getActiveUsers, {});
		expect(users).toEqual(await admin.query(api.auditActions.logs.getActiveUsers, {}));
		expect(users.map((user) => user.authUserId)).toEqual(['admin-user']);
	});

	it('keep the organization:manage floor on the old audit paths', async () => {
		const { t, admin } = await setup();
		await seedAudit(t);
		session.role = 'editor';

		await expect(admin.query(api.auditLogs.list, {})).rejects.toThrow(/Insufficient permissions/);
		await expect(admin.query(api.auditLogs.getStats, {})).rejects.toThrow(
			/Insufficient permissions/
		);
		await expect(admin.query(api.auditLogs.getActiveUsers, {})).rejects.toThrow(
			/Insufficient permissions/
		);
	});
});

describe('previous-release storage paths', () => {
	async function storedBlob(t: T): Promise<Id<'_storage'>> {
		return await t.run((ctx) => ctx.storage.store(new Blob(['logo'])));
	}

	it('storage:generateUploadUrl mints an upload as storage/files:generateUploadUrl does', async () => {
		const { t, admin } = await setup();

		const oldUrl = await admin.mutation(api.storage.generateUploadUrl, {});
		const newUrl = await admin.mutation(api.storage.files.generateUploadUrl, {});

		const tokenOf = (url: string) =>
			/^https:\/\/owlat\.example\/api\/storage\/upload\?token=(.+)$/.exec(url)?.[1];
		expect(tokenOf(oldUrl)).toEqual(expect.any(String));
		expect(tokenOf(newUrl)).toEqual(expect.any(String));
		const uploads = await t.run((ctx) => ctx.db.query('storageUploads').collect());
		expect(
			uploads.map(({ token, userId, organizationId, status }) => [
				token,
				userId,
				organizationId,
				status,
			])
		).toEqual([
			[tokenOf(oldUrl), 'admin-user', 'org-1', 'pending'],
			[tokenOf(newUrl), 'admin-user', 'org-1', 'pending'],
		]);
	});

	it('storage:getUrl resolves only a media asset blob, as storage/files:getUrl does', async () => {
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

		const url = await admin.query(api.storage.getUrl, { storageId: assetBlob });
		expect(url).toEqual(expect.any(String));
		expect(url).toEqual(await admin.query(api.storage.files.getUrl, { storageId: assetBlob }));
		await expect(admin.query(api.storage.getUrl, { storageId: otherBlob })).rejects.toThrow(/File/);
		await expect(admin.query(api.storage.files.getUrl, { storageId: otherBlob })).rejects.toThrow(
			/File/
		);
	});
});
