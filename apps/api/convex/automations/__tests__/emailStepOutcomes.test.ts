/**
 * The automation email step's per-reason mapping of the Non-campaign send
 * intake's typed outcome (PIECE C2).
 *
 * The step used to catch a thrown `Error` from the enqueue mutation and
 * classify it by comparing `error.message` against an exported magic-string
 * constant — so only the ONE reason that had a constant was handled, and every
 * other refusal fell through to the generic failure branch. It now switches on
 * `outcome.reason` through a `Record<NonCampaignIntakeRejectionReason, …>` that
 * is total by construction.
 *
 * One test per reason, driven through the REAL `executeStep` walker so the
 * retry consequence of each mapping is visible:
 *   - `recipient_blocked` → the step COMPLETES as a no-op skip (no Send row, no
 *     `emailSendId`, no retry) — a permanent per-recipient state.
 *   - `no_delivery_provider` → the step FAILS, which is what makes a
 *     deployment-level misconfiguration visible; the walker's own bounded
 *     backoff applies, and nothing is written meanwhile.
 *   - `abuse_blocked` → the step FAILS for the same reason. This gate is NEW:
 *     before C2 the non-campaign path had no abuse check at all, so a suspended
 *     instance still sent automation mail.
 *   - positive control: an enqueued Send row and a completed step carrying its
 *     `emailSendId`.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestBlockedEmail,
	createTestContact,
	createTestEmailTemplate,
	createTestInstanceSettings,
} from '../../__tests__/factories';

vi.mock('../../delivery/workpool', () => ({
	transactionalEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
	campaignEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
}));

// `import.meta.glob('../../**')` omits the directory chain it climbed through,
// so the sibling `automations/*` modules — including the step module under
// test — are missing. Merge a second glob rooted at `automations/` and
// re-prefix its keys to the same `../../`-relative form.
const rootGlob = import.meta.glob('../../**/*.*s');
const automationsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../automations/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...automationsGlob }).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

const suppressed: Error[] = [];
const onRejection = (err: Error) => {
	if (
		err.message?.includes('Could not find module') ||
		err.message?.includes('Write outside of transaction')
	) {
		suppressed.push(err);
	} else {
		throw err;
	}
};
beforeEach(() => {
	suppressed.length = 0;
	process.on('unhandledRejection', onRejection);
});
afterEach(() => {
	process.removeListener('unhandledRejection', onRejection);
	vi.unstubAllEnvs();
});

async function seedSettings(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromEmail: 'noreply@example.com',
				defaultFromName: 'Owlat',
				...overrides,
			})
		);
	});
}

async function seedActiveEmailAutomation(
	t: TestConvex<typeof schema>,
	contactEmail: string
): Promise<{ automationRunId: Id<'automationRuns'>; stepRunId: Id<'automationStepRuns'> }> {
	return await t.run(async (ctx) => {
		const templateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				subject: 'Welcome {{firstName}}',
				htmlContent: '<p>Hello {{firstName}}</p>',
			})
		);
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ status: 'active' })
		);
		const stepId = await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({
				automationId,
				stepIndex: 0,
				stepType: 'email',
				config: { emailTemplateId: templateId },
			})
		);
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: contactEmail, firstName: 'Pat' })
		);
		const now = Date.now();
		const automationRunId = await ctx.db.insert('automationRuns', {
			automationId,
			contactId,
			currentStepIndex: 0,
			stepsExecuted: 0,
			status: 'running' as const,
			startedAt: now,
			triggeredBy: 'manual',
		});
		const stepRunId = await ctx.db.insert('automationStepRuns', {
			automationRunId,
			automationStepId: stepId,
			stepIndex: 0,
			stepType: 'email' as const,
			status: 'pending' as const,
			scheduledAt: now,
		});
		return { automationRunId, stepRunId };
	});
}

describe('automation email step — intake rejection mapping', () => {
	it('recipient_blocked → completes as a no-op skip with no Send row', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@example.com', reason: 'complained' })
			);
		});
		const { automationRunId, stepRunId } = await seedActiveEmailAutomation(
			t,
			'blocked@example.com'
		);

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId,
			stepRunId,
		});

		// The run advances/completes — the blocked recipient is a clean skip, not
		// a retryable failure. NOTHING is rescheduled.
		expect(result.success).toBe(true);
		expect(result.retrying).toBeUndefined();

		// No Send row was produced for the suppressed recipient.
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);

		// The step run completed with no emailSendId (a no-op skip).
		const stepRun = await t.run(async (ctx) => ctx.db.get(stepRunId));
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.emailSendId).toBeUndefined();
	});

	it('no_delivery_provider → fails the step, writes no row, and surfaces the operator detail', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		const { automationRunId, stepRunId } = await seedActiveEmailAutomation(
			t,
			'allowed@example.com'
		);
		vi.stubEnv('EMAIL_PROVIDER', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId,
			stepRunId,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/EMAIL_PROVIDER/);
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);
	});

	it('abuse_blocked → fails the step and writes no row when the instance is suspended', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t, { abuseStatus: 'suspended' });
		const { automationRunId, stepRunId } = await seedActiveEmailAutomation(
			t,
			'allowed@example.com'
		);

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId,
			stepRunId,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/suspended/i);
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);
	});

	it('enqueues a Send row for a non-blocked contact (positive control)', async () => {
		const t = convexTest(schema, modules);
		await seedSettings(t);
		const { automationRunId, stepRunId } = await seedActiveEmailAutomation(
			t,
			'allowed@example.com'
		);

		const result = await t.action(internal.automations.stepWalker.executeStep, {
			automationRunId,
			stepRunId,
		});
		expect(result.success).toBe(true);

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe('automation');
		expect(rows[0]?.email).toBe('allowed@example.com');
		expect(rows[0]?.status).toBe('queued');

		const stepRun = await t.run(async (ctx) => ctx.db.get(stepRunId));
		expect(stepRun?.status).toBe('completed');
		expect(stepRun?.emailSendId).toBe(rows[0]?._id);
	});
});
