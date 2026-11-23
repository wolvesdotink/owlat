/**
 * An email step that hits a configuration fault (no delivery provider, the
 * sender's domain not verified, sending suspended, no default sender) waits for
 * the fix instead of failing, for a bounded window.
 *
 * Driven through the real walker with a pinned clock. The recurring re-check is
 * a cron in production; convex-test does not run crons, so each test calls the
 * cron's function where a tick would fire.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import {
	createTestBlockedEmail,
	createTestDomain,
	createTestInstanceSettings,
	enableFeatures,
} from '../../__tests__/factories';
import { RETRY_DELAYS_MS } from '../../lib/constants';
import { AUTOMATION_FAILURE_BREAKER_THRESHOLD } from '../lifecycle';
import { CONFIGURATION_WAIT_MS } from '../configurationWait';
import {
	advanceAndRun,
	DAY_MS,
	runDueScheduled,
	runOf,
	runTotals,
	seedAutomation,
	seedRun,
	sends,
	stepRunsOf,
	walkerModules,
	type T,
} from './walkerHarness';

vi.mock('../../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
	const { realPermissionGate } = await import('../../__tests__/helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => 'editor');
	const session = async () => ({
		userId: 'user-alice',
		role: 'editor' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => 'user-alice'),
		getMutationContext: vi.fn().mockImplementation(session),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(session),
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				gate(permission, message);
				return session();
			}),
	};
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse('2026-10-20T15:30:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const MINUTE_MS = 60 * 1000;

/** A configuration fault: how to cause it, and the fix a person makes elsewhere. */
interface Fault {
	reason:
		| 'no_delivery_provider'
		| 'domain_not_verified'
		| 'sending_not_allowed'
		| 'no_default_sender';
	settings?: Record<string, unknown>;
	senderDomainStatus?: 'pending';
	before?: () => void;
	fix: (t: T) => Promise<void>;
}

const patchSettings = (t: T, fields: Record<string, unknown>) =>
	t.run(async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		await ctx.db.patch(settings!._id, fields);
	});

const FAULTS: Fault[] = [
	{
		reason: 'no_delivery_provider',
		before: () => {
			vi.stubEnv('EMAIL_PROVIDER', '');
			vi.stubEnv('MTA_API_URL', '');
			vi.stubEnv('MTA_API_KEY', '');
		},
		fix: async () => {
			vi.unstubAllEnvs();
		},
	},
	{
		reason: 'domain_not_verified',
		senderDomainStatus: 'pending',
		fix: (t) =>
			t.run(async (ctx) => {
				const domain = await ctx.db.query('domains').first();
				await ctx.db.patch(domain!._id, { status: 'verified' });
			}),
	},
	{
		reason: 'sending_not_allowed',
		settings: { abuseStatus: 'suspended' },
		fix: (t) => patchSettings(t, { abuseStatus: undefined }),
	},
	{
		reason: 'no_default_sender',
		settings: { defaultFromEmail: undefined },
		fix: (t) => patchSettings(t, { defaultFromEmail: 'noreply@example.com' }),
	},
];

const NO_DEFAULT_SENDER = FAULTS[3]!;

async function setup(fault: Fault): Promise<T> {
	const t = convexTest(schema, walkerModules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['automations']);
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: fault.senderDomainStatus ?? 'verified',
				lastVerifiedAt: Date.now(),
			})
		);
		const fields = {
			defaultFromEmail: 'noreply@example.com',
			defaultFromName: 'Owlat',
			...fault.settings,
		};
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) await ctx.db.patch(existing._id, fields);
		else await ctx.db.insert('instanceSettings', createTestInstanceSettings(fields));
	});
	fault.before?.();
	return t;
}

/** Start the run and let the error-retry backoff pass, as a failing step would. */
async function startAndSettle(t: T, runId: Id<'automationRuns'>): Promise<void> {
	await t.action(internal.automations.stepWalker.startAutomationRun, { automationRunId: runId });
	await runDueScheduled(t);
	for (const delay of RETRY_DELAYS_MS) await advanceAndRun(t, delay);
}

/** One tick of the re-check cron, and everything it sets off. */
async function recheckTick(t: T): Promise<void> {
	await t.mutation(internal.automations.configurationWait.probeWaitingStepRun, {});
	await runDueScheduled(t);
}

async function runsPanelRow(t: T, automationId: Id<'automations'>, runId: Id<'automationRuns'>) {
	const { runs } = await t.query(api.automations.analytics.getAutomationRuns, { automationId });
	return runs.find((run) => run._id === runId);
}

describe('an email step waits for configuration instead of failing', () => {
	it.each(FAULTS)('$reason: the step waits and nothing counts as failed', async (fault) => {
		const t = await setup(fault);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		await startAndSettle(t, runId);

		const [stepRun] = await stepRunsOf(t, runId);
		expect(stepRun?.status).toBe('pending');
		expect(stepRun?.waitingFor).toBe(fault.reason);
		expect(stepRun?.waitingUntil).toBe(Date.now() - 36_000 + CONFIGURATION_WAIT_MS);
		const run = await runOf(t, runId);
		expect(run.status).toBe('running');
		expect(run.endReason).toBeUndefined();
		expect(await sends(t)).toHaveLength(0);

		const row = await runsPanelRow(t, automationId, runId);
		expect(row?.failure).toBeNull();
		expect(row?.waiting).toMatchObject({
			reason: fault.reason,
			until: stepRun?.waitingUntil,
		});
	});

	it('does not count toward the self-pause, however many runs wait', async () => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		for (let i = 0; i <= AUTOMATION_FAILURE_BREAKER_THRESHOLD; i++) {
			const { runId } = await seedRun(t, automationId, { email: `reader${i}@example.com` });
			await startAndSettle(t, runId);
		}

		const automation = await t.run(async (ctx) => ctx.db.get(automationId));
		expect(automation?.status).toBe('active');
		expect(automation?.consecutiveRunFailures ?? 0).toBe(0);
		const stats = await t.query(api.automations.analytics.getAutomationStats, { automationId });
		expect(stats?.failedStepRuns).toBe(0);
	});

	it.each(FAULTS)(
		'$reason: once fixed, the next re-check sends the mail once and the run moves on',
		async (fault) => {
			const t = await setup(fault);
			const { automationId } = await seedAutomation(t, [
				{ email: 'Welcome' },
				{ delayDays: 2 },
				{ email: 'Follow-up' },
			]);
			const { runId } = await seedRun(t, automationId);
			await startAndSettle(t, runId);
			// Re-checks while still broken send nothing and keep the step waiting.
			await advanceAndRun(t, 5 * MINUTE_MS);
			await recheckTick(t);
			expect(await sends(t)).toHaveLength(0);

			await advanceAndRun(t, 3 * 60 * MINUTE_MS);
			await fault.fix(t);
			await recheckTick(t);

			const mail = await sends(t);
			expect(mail).toHaveLength(1);
			const [email, delay] = await stepRunsOf(t, runId);
			expect(email?.status).toBe('completed');
			expect(email?.emailSendId).toBe(mail[0]?._id);
			// The delay after the wait counts from when the mail went out.
			expect(delay?.stepType).toBe('delay');
			expect(delay?.delayUntil).toBe(Date.now() + 2 * DAY_MS);
			const run = await runOf(t, runId);
			expect(run.status).toBe('running');
			// The re-checks were not new executions of the email step, and the
			// delay step has not run yet.
			expect(run.stepsExecuted).toBe(1);
			expect((await runsPanelRow(t, automationId, runId))?.waiting).toBeNull();
		}
	);

	it('when one waiting step goes out, the others are released and each sends once', async () => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const runIds: Id<'automationRuns'>[] = [];
		for (let i = 0; i < 4; i++) {
			const { runId } = await seedRun(t, automationId, { email: `reader${i}@example.com` });
			await startAndSettle(t, runId);
			runIds.push(runId);
		}

		await NO_DEFAULT_SENDER.fix(t);
		await recheckTick(t);

		const mail = await sends(t);
		expect(mail.map((send) => send.email).sort()).toEqual([
			'reader0@example.com',
			'reader1@example.com',
			'reader2@example.com',
			'reader3@example.com',
		]);
		for (const runId of runIds) expect((await runOf(t, runId)).status).toBe('completed');
		expect((await runTotals(t, automationId)).statsCompleted).toBe(4);
	});

	it('a re-check tick re-runs one waiting step, not all of them', async () => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const runIds: Id<'automationRuns'>[] = [];
		for (let i = 0; i < 3; i++) {
			const { runId } = await seedRun(t, automationId, { email: `reader${i}@example.com` });
			await startAndSettle(t, runId);
			runIds.push(runId);
		}
		const checkedAt = async () =>
			Promise.all(runIds.map(async (runId) => (await stepRunsOf(t, runId))[0]?.waitingCheckedAt));
		const before = await checkedAt();

		await advanceAndRun(t, 5 * MINUTE_MS);
		await recheckTick(t);

		const after = await checkedAt();
		expect(after.filter((value, i) => value !== before[i])).toHaveLength(1);
	});

	it.each(FAULTS)(
		'$reason: still broken when the window ends, the step fails with its reason',
		async (fault) => {
			const t = await setup(fault);
			const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
			const { runId } = await seedRun(t, automationId);
			await startAndSettle(t, runId);

			await advanceAndRun(t, CONFIGURATION_WAIT_MS);

			const [stepRun] = await stepRunsOf(t, runId);
			expect(stepRun?.status).toBe('failed');
			expect(stepRun?.failureReason).toBe(fault.reason);
			const run = await runOf(t, runId);
			expect(run.status).toBe('cancelled');
			expect(run.endReason).toBe('step_failed');
			const automation = await t.run(async (ctx) => ctx.db.get(automationId));
			expect(automation?.consecutiveRunFailures).toBe(1);
			const row = await runsPanelRow(t, automationId, runId);
			expect(row?.failure?.reason).toBe(fault.reason);
			expect(row?.waiting).toBeNull();
			expect(await sends(t)).toHaveLength(0);
		}
	);
});

describe('a waiting step never sends twice or to someone it should not', () => {
	it('a wait whose end passed unchecked fails with its reason, even once sending works', async () => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		await startAndSettle(t, runId);
		// Nothing ran when the wait ended (the deployment was down), and the
		// setup was fixed an hour after it.
		const [stepRun] = await stepRunsOf(t, runId);
		const endedAt = Date.now() - 60 * MINUTE_MS;
		await t.run(async (ctx) =>
			ctx.db.patch(stepRun!._id, { waitingUntil: endedAt, delayUntil: endedAt })
		);
		await NO_DEFAULT_SENDER.fix(t);

		// The sweep for due pending steps and the re-check both find it.
		await t.action(internal.automations.stepWalker.processPendingDelays, {});
		await recheckTick(t);

		expect(await sends(t)).toHaveLength(0);
		const [settled] = await stepRunsOf(t, runId);
		expect(settled?.status).toBe('failed');
		expect(settled?.failureReason).toBe('no_default_sender');
		expect((await runOf(t, runId)).endReason).toBe('step_failed');
	});

	it('a re-check racing a second firing of the same step sends once', async () => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		await startAndSettle(t, runId);
		const [stepRun] = await stepRunsOf(t, runId);
		await NO_DEFAULT_SENDER.fix(t);

		// The cron releases the step and schedules its re-check; the sweep for
		// due pending steps fires the same step run at the same moment.
		await t.mutation(internal.automations.configurationWait.probeWaitingStepRun, {});
		await Promise.all([
			t.action(internal.automations.stepWalker.executeStep, {
				automationRunId: runId,
				stepRunId: stepRun!._id,
			}),
			t.action(internal.automations.stepWalker.processPendingDelays, {}),
			runDueScheduled(t),
		]);
		await runDueScheduled(t);
		// The give-up firing scheduled when the step started waiting finds it done.
		await advanceAndRun(t, CONFIGURATION_WAIT_MS);

		expect(await sends(t)).toHaveLength(1);
		expect((await runOf(t, runId)).status).toBe('completed');
	});

	it.each([
		{
			name: 'left the automation',
			change: (t: T, runId: Id<'automationRuns'>) =>
				t.run(async (ctx) => {
					await ctx.db.patch(runId, { status: 'cancelled', completedAt: Date.now() });
				}),
			runStatus: 'cancelled',
		},
		{
			name: 'was deleted',
			change: (t: T, _runId: Id<'automationRuns'>, contactId: Id<'contacts'>) =>
				t.run(async (ctx) => {
					await ctx.db.patch(contactId, { deletedAt: Date.now() });
				}),
			runStatus: 'cancelled',
		},
		{
			name: 'unsubscribed',
			change: (t: T, _runId: Id<'automationRuns'>, contactId: Id<'contacts'>) =>
				t.run(async (ctx) => {
					await ctx.db.patch(contactId, { unsubscribedAt: Date.now() });
				}),
			runStatus: 'completed',
		},
		{
			name: 'was blocklisted',
			change: (t: T) =>
				t.run(async (ctx) => {
					await ctx.db.insert(
						'blockedEmails',
						createTestBlockedEmail({ email: 'reader@example.com', reason: 'complained' })
					);
				}),
			runStatus: 'completed',
		},
	])('a contact who $name while waiting is not mailed', async ({ change, runStatus }) => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId, contactId } = await seedRun(t, automationId);
		await startAndSettle(t, runId);

		await change(t, runId, contactId);
		await NO_DEFAULT_SENDER.fix(t);
		await recheckTick(t);
		await advanceAndRun(t, CONFIGURATION_WAIT_MS);

		expect(await sends(t)).toHaveLength(0);
		expect((await runOf(t, runId)).status).toBe(runStatus);
	});

	it.each([
		{ name: 'paused', patch: { status: 'paused' as const } },
		{ name: 'deleted', patch: { status: 'paused' as const, deletedAt: Date.now() } },
	])('a waiting run of an automation $name meanwhile does not send', async ({ patch }) => {
		const t = await setup(NO_DEFAULT_SENDER);
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		await startAndSettle(t, runId);

		await t.run(async (ctx) => ctx.db.patch(automationId, patch));
		await NO_DEFAULT_SENDER.fix(t);
		await recheckTick(t);

		expect(await sends(t)).toHaveLength(0);
		const run = await runOf(t, runId);
		expect(run.status).toBe('cancelled');
		expect(run.endReason).toBeUndefined();
		const automation = await t.run(async (ctx) => ctx.db.get(automationId));
		expect(automation?.consecutiveRunFailures ?? 0).toBe(0);
	});
});
