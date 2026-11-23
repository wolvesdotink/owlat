/**
 * Why a failed automation run failed, as the runs panel reads it.
 *
 * Each failure path of the walker records a reason code from a closed set on
 * the failing step run, and `getAutomationRuns` returns it with the stored
 * sentence as detail. Driven through the real walker, retries included, so the
 * code is the one the run ends with; a fault of the sending setup fails the
 * step only once its wait for the fix is over (`configurationWait.ts`). A
 * failed step run written before codes
 * existed (only an English `errorMessage`) reads as `unknown` with its text.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import {
	createTestAutomationStep,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestInstanceSettings,
	enableFeatures,
} from '../../__tests__/factories';
import { MAX_STEPS_PER_RUN, STEP_LEASE_MS } from '../stepOrchestration';
import { CONFIGURATION_WAIT_MS } from '../configurationWait';
import { MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from '../../lib/constants';
import {
	advanceAndRun,
	runDueScheduled,
	runOf,
	seedAutomation,
	seedRun,
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
		getUserIdFromSession: vi.fn().mockResolvedValue('user-alice'),
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

async function setup(
	settings: Record<string, unknown> = {},
	senderDomainStatus: 'verified' | 'pending' = 'verified'
): Promise<T> {
	const t = convexTest(schema, walkerModules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['automations']);
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: senderDomainStatus,
				lastVerifiedAt: Date.now(),
			})
		);
		// `enableFeatures` wrote the singleton settings row; the walker reads that one.
		const fields = {
			defaultFromEmail: 'noreply@example.com',
			defaultFromName: 'Owlat',
			...settings,
		};
		const existing = await ctx.db.query('instanceSettings').first();
		if (existing) await ctx.db.patch(existing._id, fields);
		else await ctx.db.insert('instanceSettings', createTestInstanceSettings(fields));
	});
	return t;
}

/**
 * Start the run and let every retry fire, so the step ends failed. With
 * `waitForFix`, also let a configuration fault's wait run out.
 */
async function runUntilFailed(
	t: T,
	runId: Id<'automationRuns'>,
	options: { waitForFix?: boolean } = {}
): Promise<void> {
	await t.action(internal.automations.stepWalker.startAutomationRun, { automationRunId: runId });
	await runDueScheduled(t);
	for (const delay of RETRY_DELAYS_MS) await advanceAndRun(t, delay);
	if (options.waitForFix) await advanceAndRun(t, CONFIGURATION_WAIT_MS);
	const run = await runOf(t, runId);
	expect(run.status).toBe('cancelled');
	expect(run.endReason).toBe('step_failed');
}

async function failureOf(t: T, automationId: Id<'automations'>, runId: Id<'automationRuns'>) {
	const { runs } = await t.query(api.automations.analytics.getAutomationRuns, {
		automationId,
		endReason: 'step_failed',
	});
	return runs.find((run) => run._id === runId)?.failure;
}

describe('the reason a failed run failed', () => {
	it('no_delivery_provider: no transport is set up', async () => {
		const t = await setup();
		vi.stubEnv('EMAIL_PROVIDER', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		await runUntilFailed(t, runId, { waitForFix: true });

		const failure = await failureOf(t, automationId, runId);
		expect(failure?.reason).toBe('no_delivery_provider');
		expect(failure?.detail).toMatch(/EMAIL_PROVIDER/);
	});

	it('domain_not_verified: the default sender is not on a verified domain', async () => {
		const t = await setup({}, 'pending');
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		await runUntilFailed(t, runId, { waitForFix: true });

		const failure = await failureOf(t, automationId, runId);
		expect(failure?.reason).toBe('domain_not_verified');
		expect(failure?.detail).toMatch(/"example\.com" is not verified/);
	});

	it('sending_not_allowed: the instance is suspended', async () => {
		const t = await setup({ abuseStatus: 'suspended' });
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		await runUntilFailed(t, runId, { waitForFix: true });

		expect((await failureOf(t, automationId, runId))?.reason).toBe('sending_not_allowed');
	});

	it('no_default_sender: the instance has no default sender', async () => {
		const t = await setup({ defaultFromEmail: undefined });
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);

		await runUntilFailed(t, runId, { waitForFix: true });

		expect((await failureOf(t, automationId, runId))?.reason).toBe('no_default_sender');
	});

	it('template_missing and template_empty: the step has no usable email', async () => {
		const t = await setup();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId: missingRunId } = await seedRun(t, automationId);
		await t.run(async (ctx) => {
			await ctx.db.patch(stepIds[0]!, { config: { emailTemplateId: '' } });
		});
		await runUntilFailed(t, missingRunId);
		expect((await failureOf(t, automationId, missingRunId))?.reason).toBe('template_missing');

		const { runId: emptyRunId } = await seedRun(t, automationId, { email: 'empty@example.com' });
		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ subject: 'Empty', htmlContent: '' })
			);
			await ctx.db.patch(stepIds[0]!, { config: { emailTemplateId: templateId } });
		});
		await runUntilFailed(t, emptyRunId);
		expect((await failureOf(t, automationId, emptyRunId))?.reason).toBe('template_empty');
	});

	it('contact_no_email: the contact has no email address', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId, { email: undefined });

		await runUntilFailed(t, runId);

		expect((await failureOf(t, automationId, runId))?.reason).toBe('contact_no_email');
	});

	it('invalid_step_config: the step config does not parse', async () => {
		const t = await setup();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		await t.run(async (ctx) => {
			await ctx.db.patch(stepIds[0]!, { config: { duration: 1, unit: 'days' } });
		});
		const { runId } = await seedRun(t, automationId);

		await runUntilFailed(t, runId);

		const failure = await failureOf(t, automationId, runId);
		expect(failure?.reason).toBe('invalid_step_config');
		expect(failure?.detail).toMatch(/emailTemplateId must be a string/);
	});

	it('step_limit: the run hit the step-execution cap', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		await t.run(async (ctx) => {
			await ctx.db.patch(runId, { stepsExecuted: MAX_STEPS_PER_RUN });
		});

		await t.action(internal.automations.stepWalker.startAutomationRun, { automationRunId: runId });
		await runDueScheduled(t);

		expect((await failureOf(t, automationId, runId))?.reason).toBe('step_limit');
	});

	it('interrupted: the step kept dying past its recovery budget', async () => {
		const t = await setup();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		const stepRunId = await t.run(async (ctx) => {
			return await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepIds[0]!,
				stepIndex: 0,
				stepType: 'email',
				status: 'executing',
				scheduledAt: Date.now() - STEP_LEASE_MS,
				startedAt: Date.now() - STEP_LEASE_MS,
				retryCount: MAX_RETRY_ATTEMPTS,
				leaseExpiresAt: Date.now() - 1,
			});
		});

		await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId: runId,
			stepRunId,
			retryCount: MAX_RETRY_ATTEMPTS + 1,
		});

		expect((await failureOf(t, automationId, runId))?.reason).toBe('interrupted');
	});

	it('a failed step run with only a stored sentence reads as unknown with that sentence', async () => {
		const t = await setup();
		const { automationId, stepIds } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'cancelled',
				startedAt: Date.now() - 1000,
				completedAt: Date.now(),
				triggeredBy: 'contact_created',
				endReason: 'step_failed',
			});
			await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepIds[0]!,
				stepIndex: 0,
				stepType: 'email',
				status: 'failed',
				scheduledAt: Date.now() - 1000,
				completedAt: Date.now(),
				errorMessage: 'SMTP connection reset',
			});
			return { runId };
		});

		expect(await failureOf(t, automationId, runId)).toEqual({
			reason: 'unknown',
			detail: 'SMTP connection reset',
		});
	});

	it('a run that did not fail carries no failure', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t, [{ email: 'Welcome' }]);
		const { runId } = await seedRun(t, automationId);
		await t.action(internal.automations.stepWalker.startAutomationRun, { automationRunId: runId });
		await runDueScheduled(t);
		const { runs } = await t.query(api.automations.analytics.getAutomationRuns, { automationId });
		expect(runs.find((run) => run._id === runId)?.failure).toBeNull();
	});
});
