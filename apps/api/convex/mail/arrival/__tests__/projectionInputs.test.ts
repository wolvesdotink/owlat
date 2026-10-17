/**
 * Read on arrival (SPEC §2.8): every writer of a projection input recomputes
 * the projection in its own mutation. These cover the needs-reply reconcile
 * paths (Sol r1 F9): a heuristic flag the sweep gives up on becomes settled
 * (`needs_me`), and a requeue makes it pending again (`today`).
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { writeArrivalRecord } from '../records';
import { refreshArrivalProjection } from '../projection';
import { enqueueNeedsReplyCheck } from '../../needsReply';
import { MAX_SWEEP_RETRIES } from '../../needsReplyPending';

type T = TestConvex<typeof schema>;

async function seedThread(t: T) {
	const mailboxId = await seedMailbox(t, { address: 'me@owlat.test' });
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, { fromAddress: 'sam@example.com' });
	const threadId = await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		await ctx.db.patch(message.threadId, {
			category: { label: 'notification', source: 'heuristic', classifiedAt: Date.now() },
		});
		await writeArrivalRecord(ctx, message, { isLive: true });
		return message.threadId;
	});
	return { mailboxId, messageId, threadId };
}

const placementOf = (t: T, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) => (await ctx.db.get(threadId))!.arrival?.placement);

describe('projection inputs: the needs-reply reconcile paths', () => {
	it('a heuristic flag the sweep gives up on settles to needs_me', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { messageId, threadId } = await seedThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				needsReply: { messageId, source: 'heuristic', urgency: 'normal', detectedAt: 1 },
				needsReplyPendingAt: 1,
				needsReplyRetryCount: MAX_SWEEP_RETRIES,
			});
			await refreshArrivalProjection(ctx, threadId);
		});
		expect(await placementOf(t, threadId)).toBe('updates');
		expect(await t.mutation(internal.mail.needsReplyPending.sweepPending, {})).toMatchObject({
			abandoned: 1,
		});
		expect(await placementOf(t, threadId)).toBe('needs_me');
	});

	it('a requeue makes a heuristic flag pending again', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { messageId, threadId } = await seedThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				needsReply: { messageId, source: 'heuristic', urgency: 'normal', detectedAt: 1 },
			});
			await refreshArrivalProjection(ctx, threadId);
		});
		expect(await placementOf(t, threadId)).toBe('needs_me');
		await t.run((ctx) => enqueueNeedsReplyCheck(ctx, threadId));
		expect(await placementOf(t, threadId)).toBe('updates');
	});
});
