/**
 * Integration tests for the backups surface (apps/api/convex/backups.ts).
 *
 * `getBackupState` / `setScheduleEnabled` / `logManualRun` are secure-by-default
 * functions whose auth floor (`authedQuery` / `authedMutation` →
 * `requireOrgMember`) we mock to pass, so `requirePlatformAdmin` is the only
 * gate under test: there must be a `platformAdmins` row for the calling subject.
 *
 * The "CLI boundary" is the host — the app never triggers a real backup — so
 * these tests exercise the record → read round-trip that the panel relies on:
 * an admin flips the schedule / logs a run, and the query reflects it.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMock = vi.hoisted(() => ({ subject: 'caller-user' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'caller-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.subject),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'caller-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'caller-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => ({
			subject: sessionMock.subject,
			issuer: 'test',
			tokenIdentifier: `test|${sessionMock.subject}`,
		})),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const setCaller = (subject: string) => {
	sessionMock.subject = subject;
};

async function seedAdmin(
	t: ReturnType<typeof convexTest>,
	authUserId: string,
	role: 'admin' | 'superadmin' = 'admin',
	email = `${authUserId}@example.com`
): Promise<Id<'platformAdmins'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId,
			email,
			role,
			createdAt: Date.now(),
		})
	);
}

beforeEach(() => {
	setCaller('caller-user');
});

describe('backups.getBackupState (admin gating)', () => {
	it('rejects a caller with no platformAdmins row (even an org owner)', async () => {
		const t = convexTest(schema, modules);
		setCaller('not-a-platform-admin');
		await expect(t.query(api.backups.getBackupState, {})).rejects.toThrow(
			/Platform admin access required/
		);
	});

	it('returns null before any state is recorded (empty state)', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'caller-user');
		expect(await t.query(api.backups.getBackupState, {})).toBeNull();
	});
});

describe('backups.setScheduleEnabled (admin gating)', () => {
	it('rejects a non-admin caller', async () => {
		const t = convexTest(schema, modules);
		setCaller('not-a-platform-admin');
		await expect(t.mutation(api.backups.setScheduleEnabled, { enabled: true })).rejects.toThrow(
			/Platform admin access required/
		);
	});
});

describe('backups schedule round-trip', () => {
	it('enable then disable is reflected by the query, with audit fields', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'caller-user', 'admin', 'admin@example.com');

		await t.mutation(api.backups.setScheduleEnabled, { enabled: true });
		let state = await t.query(api.backups.getBackupState, {});
		expect(state?.isScheduleEnabled).toBe(true);
		expect(state?.updatedBy).toBe('admin@example.com');
		expect(typeof state?.updatedAt).toBe('number');

		await t.mutation(api.backups.setScheduleEnabled, { enabled: false });
		state = await t.query(api.backups.getBackupState, {});
		expect(state?.isScheduleEnabled).toBe(false);
	});

	it('does not create a second row on repeated writes (singleton)', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'caller-user');

		await t.mutation(api.backups.setScheduleEnabled, { enabled: true });
		await t.mutation(api.backups.setScheduleEnabled, { enabled: false });

		const rows = await t.run(async (ctx) => ctx.db.query('backupState').collect());
		expect(rows).toHaveLength(1);
	});
});

describe('backups.logManualRun round-trip', () => {
	it('rejects a non-admin caller', async () => {
		const t = convexTest(schema, modules);
		setCaller('not-a-platform-admin');
		await expect(t.mutation(api.backups.logManualRun, { status: 'success' })).rejects.toThrow(
			/Platform admin access required/
		);
	});

	it('records the run timestamp + status and the query reflects it', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'caller-user');

		const before = Date.now();
		await t.mutation(api.backups.logManualRun, { status: 'success' });
		const state = await t.query(api.backups.getBackupState, {});

		expect(state?.lastRunStatus).toBe('success');
		expect(state?.lastRunAt).toBeGreaterThanOrEqual(before);
		// Logging a run before any schedule attestation defaults isScheduleEnabled to false.
		expect(state?.isScheduleEnabled).toBe(false);
	});

	it('preserves a previously-recorded schedule when logging a run', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'caller-user');

		await t.mutation(api.backups.setScheduleEnabled, { enabled: true });
		await t.mutation(api.backups.logManualRun, { status: 'failed' });

		const state = await t.query(api.backups.getBackupState, {});
		expect(state?.isScheduleEnabled).toBe(true);
		expect(state?.lastRunStatus).toBe('failed');
	});
});
