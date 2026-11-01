import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';
import { expectScheduledFailure } from './helpers/scheduledFailures';

/**
 * What `inbox/messages.receiveMessage` does with a stored arrival after the
 * insert: which scheduled jobs it leaves behind (walker start, coalesce batch,
 * reply-outcome classification) and the status the row is left in. Each case
 * pins one disposition of the receive plan, so the live mutation is held to the
 * order the pure decision describes.
 */

beforeEach(() => {
	expectScheduledFailure('agent/walker:start');
	expectScheduledFailure('agent/walker:resumeDraft');
	expectScheduledFailure('agent/outcomeFeedback:classifyReplyOutcome');
	expectScheduledFailure('agent/coalescing:processCoalescedBatch');
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/') &&
			!path.includes('agent/outcomeFeedback') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type Test = ReturnType<typeof convexTest>;

function setup(): Test {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function enableAgent(t: Test, coalesceWindowMs?: number, isAgentOn = true): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { ai: true, 'ai.agent': isAgentOn, inbox: true },
			createdAt: Date.now(),
		});
		if (coalesceWindowMs !== undefined) {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				maxDailyAutoReplies: 100,
				coalesceWindowMs,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	});
}

/** Scheduled job names, without the module prefix noise. */
async function scheduled(t: Test): Promise<string[]> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		return jobs.map((job) => job.name ?? '').sort();
	});
}

const count = (names: readonly string[], fragment: string): number =>
	names.filter((name) => name.includes(fragment)).length;

let sequence = 0;
function arrival(overrides: Record<string, unknown> = {}) {
	sequence += 1;
	return {
		from: 'Pat Doe <pat@example.com>',
		to: 'inbox@owlat.example',
		subject: `Question ${sequence}`,
		textBody: 'Can you help?',
		messageId: `<disposition-${sequence}@example.com>`,
		timestamp: Date.now(),
		...overrides,
	};
}

describe('receiveMessage dispositions', () => {
	it('skips the coalesce window while the agent feature is off and starts the walker', async () => {
		// Receive reads the flag only to decide whether to coalesce; the start
		// itself is not gated on it.
		const t = setup();
		await enableAgent(t, 30_000, false);
		const result = await t.mutation(internal.inbox.messages.receiveMessage, arrival());
		expect(result.isDuplicate).toBe(false);
		const names = await scheduled(t);
		expect(count(names, 'walker')).toBe(1);
		expect(count(names, 'processCoalescedBatch')).toBe(0);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(result.inboundMessageId))?.processingStatus).toBe('received');
		});
	});

	it('quarantines infected mail and schedules neither the walker nor reply feedback', async () => {
		const t = setup();
		await enableAgent(t);
		const result = await t.mutation(
			internal.inbox.messages.receiveMessage,
			arrival({ virusVerdict: 'infected', inReplyTo: '<earlier@example.com>' })
		);
		const names = await scheduled(t);
		expect(count(names, 'walker')).toBe(0);
		expect(count(names, 'classifyReplyOutcome')).toBe(0);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(result.inboundMessageId))?.processingStatus).toBe('quarantined');
		});
	});

	it('schedules reply-outcome feedback for a reply, then the walker', async () => {
		const t = setup();
		await enableAgent(t);
		await t.mutation(
			internal.inbox.messages.receiveMessage,
			arrival({ inReplyTo: '<earlier@example.com>' })
		);
		const names = await scheduled(t);
		expect(count(names, 'classifyReplyOutcome')).toBe(1);
		expect(count(names, 'walker')).toBe(1);
	});

	it('defers to a coalesce batch instead of starting the walker when a window is set', async () => {
		const t = setup();
		await enableAgent(t, 30_000);
		const result = await t.mutation(internal.inbox.messages.receiveMessage, arrival());
		const names = await scheduled(t);
		expect(count(names, 'walker')).toBe(0);
		expect(count(names, 'processCoalescedBatch')).toBe(1);
		await t.run(async (ctx) => {
			const batches = await ctx.db.query('coalesceBatches').collect();
			expect(batches.map((batch) => batch.leaderMessageId)).toEqual([result.inboundMessageId]);
		});
	});

	it('stores mail past the per-sender cost cap without starting the walker', async () => {
		const t = setup();
		await enableAgent(t);
		// The per-sender bucket holds 20 starts.
		for (let i = 0; i < 20; i += 1) {
			await t.mutation(internal.inbox.messages.receiveMessage, arrival());
		}
		expect(count(await scheduled(t), 'walker')).toBe(20);
		const capped = await t.mutation(internal.inbox.messages.receiveMessage, arrival());
		expect(count(await scheduled(t), 'walker')).toBe(20);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(capped.inboundMessageId))?.processingStatus).toBe('received');
		});
	});
});
