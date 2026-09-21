/**
 * The agent approved-reply's per-reason mapping of the Non-campaign send
 * intake's typed outcome (PR-08 test 3, rewritten for PIECE C2).
 *
 * `agent.agentPipeline.sendApprovedReply` dispatches an approved draft through
 * `delivery/nonCampaignIntake.intake`. Pre-C2 the intake THREW its refusals and
 * this action caught them into `fail(err.message)` — flattening a suppressed
 * recipient, an expected and permanent per-recipient state, into the same
 * `failed` transition as a real fault (and leaving the message eligible for the
 * failed-action retry cron to re-drive forever). It now switches on
 * `outcome.reason` through a total record:
 *
 *   - `recipient_blocked` → `archived` with reason `sender_blocked`. The same
 *     edge, the same reason and the same `'transactional'` suppression scope
 *     `inbox/messages.ts` uses when blocklisted mail ARRIVES — the identical
 *     verdict about the identical address, observed at reply time. `archived`
 *     is TERMINAL, so nothing retries it; this is the agent-side reading of how
 *     the automation step completes-without-sending for the same reason.
 *   - `no_delivery_provider` / `abuse_blocked` → `failed`. These are about the
 *     DEPLOYMENT: the draft is still good and should send once an operator
 *     fixes the configuration or the suspension lifts, so the message keeps
 *     surfacing as a fault and stays re-drivable.
 *
 * In every rejection case NO `agent_reply` Send row is produced. Positive
 * control: a non-blocked from-address enqueues one and leaves the message in
 * `approved` (the Send completion module — excluded here — would later drive it
 * to `sent`).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestBlockedEmail,
	createTestContact,
	createTestInboundMessage,
	createTestInstanceSettings,
} from '../../__tests__/factories';

// Stub the workpool so the enqueue's `enqueueAction` is a no-op.
vi.mock('../../delivery/workpool', () => ({
	transactionalEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
	campaignEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
}));

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `agent/__tests__` file omits
// the sibling `agent/*` modules (including `agent/agentPipeline.ts`, the unit
// under test). Merge a second glob rooted at `agent/` and re-prefix its keys to
// the same `../../`-relative form so convex-test's single module-root prefix
// resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const agentGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../agent/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...agentGlob };
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
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
});

async function seedApprovedMessage(
	t: TestConvex<typeof schema>,
	fromEmail: string,
	settingsOverrides: Record<string, unknown> = {}
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromEmail: 'support@acme.test',
				defaultFromName: 'Acme Support',
				...settingsOverrides,
			})
		);
		const contactId = await ctx.db.insert('contacts', createTestContact({ email: fromEmail }));
		// threadId/contactId are optional on inboundMessages; the agent email
		// branch only reads `message.from` and the optional `message.contactId`.
		// Seed a real contactId and omit the thread to avoid coupling the test to
		// the conversationThreads shape.
		return await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				from: `Customer <${fromEmail}>`,
				to: 'support@acme.test',
				subject: 'Need help',
				processingStatus: 'approved',
				draftResponse: 'Here is the help you asked for.',
				draftSubject: 'Re: Need help',
				threadId: undefined,
				contactId,
			})
		);
	});
}

describe('agent.sendApprovedReply — intake rejection mapping', () => {
	it('recipient_blocked → archives the message as sender_blocked and enqueues no row', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'blocked@customer.test', reason: 'complained' })
			);
		});
		const inboundMessageId = await seedApprovedMessage(t, 'blocked@customer.test');

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId,
		});

		// No agent_reply Send row was produced for the suppressed recipient.
		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);

		// A blocklisted recipient is a policy verdict, not a fault: the message
		// reaches the ARCHIVED terminal state, not `failed` — so the failed-action
		// retry cron can never re-drive a send that will never be allowed.
		const message = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
		expect(message?.processingStatus).toBe('archived');
		expect(message?.processingStatus).not.toBe('sent');
		expect(message?.processingStatus).not.toBe('failed');
	});

	it('no_delivery_provider → fails the message (a deployment fault, still re-drivable)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedApprovedMessage(t, 'ok@customer.test');
		vi.stubEnv('EMAIL_PROVIDER', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
		try {
			await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId });
		} finally {
			vi.unstubAllEnvs();
		}

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);

		const message = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
		expect(message?.processingStatus).toBe('failed');
		expect(message?.errorMessage).toMatch(/EMAIL_PROVIDER/);
	});

	it('abuse_blocked → fails the message when the instance is suspended', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedApprovedMessage(t, 'ok@customer.test', {
			abuseStatus: 'suspended',
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId });

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(0);

		const message = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
		expect(message?.processingStatus).toBe('failed');
		expect(message?.errorMessage).toMatch(/suspended/i);
	});

	it('ok → enqueues an agent_reply row for a non-blocked from-address (positive control)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedApprovedMessage(t, 'ok@customer.test');

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId,
		});

		const rows = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe('agent_reply');
		expect(rows[0]?.email).toBe('ok@customer.test');
		expect(rows[0]?.inboundMessageId).toBe(inboundMessageId);

		// The message stays in `approved`; the Send completion module (excluded
		// from this harness) is what later drives it to `sent`.
		const message = await t.run(async (ctx) => ctx.db.get(inboundMessageId));
		expect(message?.processingStatus).toBe('approved');
	});
});
