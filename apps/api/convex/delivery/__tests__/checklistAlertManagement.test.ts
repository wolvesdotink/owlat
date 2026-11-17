import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, components } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import schema from '../../schema';
import betterAuthSchema from '../../betterAuth/schema';
import { betterAuthModules } from '../../__tests__/testModules';
import { VAPID_ENV } from '../../push/__tests__/pushFixtures';
import {
	requireAdminContext,
	requireOrgPermission,
	type OrganizationRole,
} from '../../lib/sessionOrganization';
import type * as SessionOrganizationModule from '../../lib/sessionOrganization';

/** Who is calling. The role is checked by the real permission map, not stubbed open. */
const caller = vi.hoisted(() => ({
	userId: 'admin',
	role: 'admin' as OrganizationRole,
	activeOrganizationId: 'org',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../../lib/sessionOrganization'
	);
	const { realPermissionGate } = await import('../../__tests__/helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => caller.role);
	return {
		...actual,
		requireAdminContext: vi.fn(async () => {
			gate('organization:manage');
			return { ...caller };
		}),
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: string, message?: string) => {
			gate(permission, message);
			return { ...caller };
		}),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

async function insertRegressionAlert(ctx: MutationCtx, identity: string) {
	const evidence = {
		organizationId: 'org',
		itemId: 'deployment.ptr' as const,
		scopeKind: 'deployment' as const,
		targetKey: '3:org|deployment',
		attemptId: 'attempt',
		validator: 'test',
		status: 'fail' as const,
		observedValues: [],
		diagnostic: 'failed',
		observedAt: 1_000,
		createdAt: 1_000,
	};
	const previousEvidenceId = await ctx.db.insert('deliverabilityEvidence', {
		...evidence,
		attemptId: 'previous',
		status: 'pass',
	});
	const regressedEvidenceId = await ctx.db.insert('deliverabilityEvidence', evidence);
	return ctx.db.insert('deliverabilityRegressionAlerts', {
		organizationId: 'org',
		identity,
		itemId: 'deployment.ptr',
		targetKey: '3:org|deployment',
		previousEvidenceId,
		regressedEvidenceId,
		observedAt: 1_000,
		message: 'failed',
		emailNotificationState: 'pending',
		createdAt: 1_000,
	});
}

describe('deliverability alert management', () => {
	it('cancels queued recipients, preserves in-flight work, and acknowledges manual resolution', async () => {
		const t = convexTest(schema, modules);
		const alertId = await t.run(async (ctx) => {
			const alertId = await insertRegressionAlert(ctx, 'manual-resolution');
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId,
				userId: 'queued',
				status: 'pending',
				attemptCount: 1,
				nextAttemptAt: 5_000,
			});
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId,
				userId: 'in-flight',
				status: 'sending',
				attemptCount: 1,
				attemptToken: 'send-token',
				attemptStartedAt: 2_000,
			});
			return alertId;
		});

		await expect(
			t.mutation(api.delivery.checklistAlertManagement.resolve, { alertId })
		).resolves.toBe(true);
		const state = await t.run(async (ctx) => ({
			alert: await ctx.db.get(alertId),
			recipients: await ctx.db.query('deliverabilityAlertRecipients').collect(),
		}));
		expect(state.alert?.resolvedAt).toEqual(expect.any(Number));
		expect(state.alert?.acknowledgedAt).toBe(state.alert?.resolvedAt);
		expect(state.alert?.emailNotificationState).toBe('pending');
		expect(state.recipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ userId: 'queued', status: 'cancelled' }),
				expect.objectContaining({
					userId: 'in-flight',
					status: 'sending',
					attemptToken: 'send-token',
				}),
			])
		);
	});

	it('makes a pending-only alert terminal and clears stale claim metadata', async () => {
		const t = convexTest(schema, modules);
		const alertId = await t.run(async (ctx) => {
			const alertId = await insertRegressionAlert(ctx, 'pending-only-resolution');
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org',
				alertId,
				userId: 'queued',
				status: 'pending',
				attemptCount: 2,
				attemptToken: 'stale-claim',
				attemptStartedAt: 2_000,
				nextAttemptAt: 5_000,
				unavailableReason: 'missing_email',
			});
			return alertId;
		});

		await expect(
			t.mutation(api.delivery.checklistAlertManagement.resolve, { alertId })
		).resolves.toBe(true);
		const state = await t.run(async (ctx) => ({
			alert: await ctx.db.get(alertId),
			recipient: await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_alert', (q) => q.eq('alertId', alertId))
				.unique(),
		}));
		expect(state.alert?.emailNotificationState).toBe('unavailable');
		expect(state.alert?.emailNotifiedAt).toBeUndefined();
		expect(state.recipient).toMatchObject({
			status: 'cancelled',
			attemptCount: 2,
		});
		expect(state.recipient).not.toHaveProperty('attemptToken');
		expect(state.recipient).not.toHaveProperty('attemptStartedAt');
		expect(state.recipient).not.toHaveProperty('nextAttemptAt');
		expect(state.recipient).not.toHaveProperty('unavailableReason');
	});

	it("reads another organization's alert as missing, on the floor session alone", async () => {
		const t = convexTest(schema, modules);
		const alertId = await t.run(async (ctx) => {
			const alertId = await insertRegressionAlert(ctx, 'foreign-org');
			await ctx.db.patch(alertId, { organizationId: 'other-org' });
			return alertId;
		});
		vi.mocked(requireAdminContext).mockClear();
		vi.mocked(requireOrgPermission).mockClear();

		await expect(
			t.mutation(api.delivery.checklistAlertManagement.acknowledge, { alertId })
		).rejects.toThrow(/Deliverability alert not found/);
		await expect(
			t.mutation(api.delivery.checklistAlertManagement.resolve, { alertId })
		).rejects.toThrow(/Deliverability alert not found/);
		expect((await t.run(async (ctx) => ctx.db.get(alertId)))?.acknowledgedAt).toBeUndefined();
		// The admin floor resolves the session once per call; the alert lookup
		// reuses it instead of resolving again.
		expect(vi.mocked(requireAdminContext)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(requireOrgPermission)).not.toHaveBeenCalled();
	});
});

describe('deliverability alert channels', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		Object.assign(caller, { userId: 'admin', role: 'admin', activeOrganizationId: 'org' });
	});

	/** An organization whose members have real user rows with addresses. */
	async function seedOrganization() {
		const t = convexTest(schema, modules);
		t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
		const org = (await t.mutation(components.betterAuth.adapter.create, {
			input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: 1 } },
		} as never)) as { _id: string };
		const ids: Record<string, string> = {};
		for (const [name, role] of [
			['owner', 'owner'],
			['admin', 'admin'],
			['editor', 'editor'],
		] as const) {
			const user = (await t.mutation(components.betterAuth.adapter.create, {
				input: {
					model: 'user',
					data: {
						name,
						email: `${name}@example.com`,
						emailVerified: true,
						createdAt: 1,
						updatedAt: 1,
					},
				},
			} as never)) as { _id: string };
			ids[name] = user._id;
			await t.mutation(components.betterAuth.adapter.create, {
				input: {
					model: 'member',
					data: { organizationId: org._id, userId: user._id, role, createdAt: 1 },
				},
			} as never);
		}
		const seedDevice = (userId: string, n: number) =>
			t.run((ctx) =>
				ctx.db.insert('pushSubscriptions', {
					userId,
					endpoint: `https://push.example.com/${userId}/${n}`,
					p256dh: 'key',
					auth: 'auth',
					label: 'Firefox on Linux',
					timeZone: 'UTC',
					createdAt: 1,
				})
			);
		await seedDevice(ids['admin']!, 1);
		await seedDevice(ids['admin']!, 2);
		await seedDevice(ids['owner']!, 1);
		await seedDevice(ids['editor']!, 1);
		// The owner switched deliverability alerts off.
		await t.run((ctx) =>
			ctx.db.insert('marketingNotificationSettings', {
				userId: ids['owner']!,
				isDeliverabilityAlertsOn: false,
				updatedAt: 1,
			})
		);
		Object.assign(caller, { userId: ids['admin']!, activeOrganizationId: org._id });
		return { t, ids };
	}

	it('counts the owners and admins each channel reaches, and the caller own reach', async () => {
		for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
		vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com');
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const { t } = await seedOrganization();

		expect(await t.query(api.delivery.checklistAlertChannels.getChannels, {})).toEqual({
			// The editor is not an alert recipient.
			email: { recipientCount: 2, isSenderConfigured: true, isOnOwnMta: true },
			// The owner switched the kind off: only the admin hears about it in the app.
			inApp: { recipientCount: 1 },
			push: { isConfigured: true, deviceCount: 2 },
			me: { isSwitchOn: true, deviceCount: 2 },
		});
	});

	it('reports push as not set up on a server without push keys', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'ses');
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		vi.stubEnv('DEFAULT_FROM_EMAIL', '');
		const { t } = await seedOrganization();
		const channels = await t.query(api.delivery.checklistAlertChannels.getChannels, {});
		expect(channels.push).toEqual({ isConfigured: false, deviceCount: 0 });
		expect(channels.email).toMatchObject({ isSenderConfigured: false, isOnOwnMta: false });
	});

	it('is refused to an editor', async () => {
		const { t, ids } = await seedOrganization();
		Object.assign(caller, { userId: ids['editor']!, role: 'editor' });
		await expect(t.query(api.delivery.checklistAlertChannels.getChannels, {})).rejects.toThrow();
	});
});
