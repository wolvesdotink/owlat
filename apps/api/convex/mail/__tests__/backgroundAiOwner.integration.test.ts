/**
 * Background Postbox AI is charged to the mailbox owner (#1380).
 *
 * Scheduled actions run without a session, so before #1380 every background
 * gate call shared one 'anon' key: one mailbox's burst rate-limited every other
 * mailbox's refinement. These tests run the real actions with NO session (the
 * scheduled-function case) and the model seam mocked:
 *
 *   - owner A's empty `postboxAiBackground` bucket refuses A's work only; owner
 *     B's category refinement and commitment extraction still run;
 *   - the commitment sweep spreads the extractions it schedules
 *     (`EXTRACT_STAGGER_MS`), so one tick cannot drain an owner's bucket.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { EXTRACT_STAGGER_MS } from '../commitments';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	// A scheduled function: Convex passes it no auth.
	return { ...actual, getBetterAuthSessionWithRole: vi.fn(async () => null) };
});

const runLlmObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/llmProvider', async () => {
	const actual = await vi.importActual<object>('../../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});

vi.mock('../../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<object>('../../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

type T = TestConvex<typeof schema>;

beforeEach(() => {
	runLlmObjectMock.mockReset();
});

async function setup(): Promise<T> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['ai']);
	return t;
}

/** A mailbox of `userId` with an inbox and a sent folder. */
async function mailboxOf(t: T, userId: string, address: string): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, { userId, address });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	return mailboxId;
}

/** Empty `ownerUserId`'s background bucket, as an arrival burst would. */
async function drainBackgroundBucket(t: T, ownerUserId: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		const refused = await t.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId }).then(
			() => false,
			() => true
		);
		if (refused) return;
	}
	throw new Error('the background bucket never refused');
}

async function categoryOf(t: T, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		return (await ctx.db.get(message!.threadId))?.category;
	});
}

describe('background AI is keyed per mailbox owner (#1380)', () => {
	it('one owner’s empty bucket leaves another owner’s category refinement alone', async () => {
		const t = await setup();
		const a = await mailboxOf(t, 'owner-a', 'a@owlat.test');
		const b = await mailboxOf(t, 'owner-b', 'b@owlat.test');
		const aMessage = await seedMessage(t, a, { subject: 'Quick question' });
		const bMessage = await seedMessage(t, b, { subject: 'Quick question' });
		runLlmObjectMock.mockResolvedValue({
			object: { category: 'newsletter' },
			tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			modelUsed: 'test-model',
		});
		await drainBackgroundBucket(t, 'owner-a');

		for (const messageId of [aMessage, bMessage]) {
			const threadId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
			await t.action(internal.mail.ai.categoryClassify.classifyThread, { threadId });
		}

		expect(await categoryOf(t, aMessage)).toMatchObject({ label: 'other', source: 'heuristic' });
		expect(await categoryOf(t, bMessage)).toMatchObject({ label: 'newsletter', source: 'llm' });
		expect(runLlmObjectMock).toHaveBeenCalledOnce();
	});

	it('one owner’s empty bucket leaves another owner’s commitment extraction alone', async () => {
		const t = await setup();
		const a = await mailboxOf(t, 'owner-a', 'a@owlat.test');
		const b = await mailboxOf(t, 'owner-b', 'b@owlat.test');
		const sent = (mailboxId: Id<'mailboxes'>, fromAddress: string) =>
			seedMessage(t, mailboxId, {
				role: 'sent',
				fromAddress,
				subject: 'Report',
				textBodyInline: "I'll send the report Friday",
			});
		const aMessage = await sent(a, 'a@owlat.test');
		const bMessage = await sent(b, 'b@owlat.test');
		runLlmObjectMock.mockResolvedValue({
			object: {
				hasCommitment: true,
				description: 'Send the report',
				dueDate: null,
				duePhrase: 'Friday',
			},
			tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			modelUsed: 'test-model',
		});
		await drainBackgroundBucket(t, 'owner-a');

		for (const messageId of [aMessage, bMessage]) {
			await t.action(internal.mail.ai.commitmentExtract.extractCommitment, {
				messageId,
				direction: 'outbound',
			});
		}

		const rows = await t.run((ctx) => ctx.db.query('mailCommitments').collect());
		expect(rows.map((row) => row.mailboxId)).toEqual([b]);
	});
});

describe('commitment sweep (#1380)', () => {
	it('spreads the extractions it schedules instead of firing them at once', async () => {
		const t = await setup();
		const mailboxId = await mailboxOf(t, 'owner-a', 'a@owlat.test');
		for (let i = 0; i < 3; i++) {
			const messageId = await seedMessage(t, mailboxId, {
				role: 'sent',
				fromAddress: 'a@owlat.test',
				subject: `Report ${i}`,
				textBodyInline: "I'll send the report Friday",
				receivedAt: Date.now() - i,
			});
			await t.run((ctx) =>
				ctx.db.patch(messageId, {
					toAddresses: ['alice@example.com'],
					outbound: { state: 'sent', recipients: [] },
				})
			);
		}

		// Each `runAfter` reads the clock itself, so a loaded host can let a
		// millisecond pass between two of them (6001 vs 6000). Freeze only
		// `Date` for the sweep: the offsets are then exactly the stagger.
		const before = Date.now();
		vi.useFakeTimers({ toFake: ['Date'], now: before });
		let scheduled: number;
		try {
			({ scheduled } = await t.mutation(internal.mail.commitments.sweep, {}));
		} finally {
			vi.useRealTimers();
		}
		expect(scheduled).toBe(3);

		const times = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect())
				.filter((job) => job.name.includes('extractCommitment'))
				.map((job) => job.scheduledTime)
				.sort((x, y) => x - y)
		);
		expect(times).toHaveLength(3);
		const offsets = times.map((time) => time - times[0]!);
		expect(offsets).toEqual([0, EXTRACT_STAGGER_MS, 2 * EXTRACT_STAGGER_MS]);
		expect(times[0]).toBeGreaterThanOrEqual(before);
	});
});
