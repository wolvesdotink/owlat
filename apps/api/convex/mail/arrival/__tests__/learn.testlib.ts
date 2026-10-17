/**
 * Fixtures for the learn lane tests (SPEC §4): live deliveries through the real
 * hosted MX path (arrival record, sender profile, projection), and readers for
 * the operation log.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../../schema';
import type { Doc, Id } from '../../../_generated/dataModel';
import { modules } from '../../__tests__/helpers.testlib';
import { deliverHosted, type T } from '../../senders/__tests__/senders.testlib';

/**
 * A test deployment for these suites. Live deliveries schedule the classifier
 * and the arrival read, which take rate-limiter tokens, so the component is
 * registered.
 */
export function learnTest(): T {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

export {
	OWNER,
	SENDER,
	deliverHosted,
	profileOf,
	roleOf,
	seedPersonalMailbox,
	seedProfile,
	seedSenderMessages,
	type T,
} from '../../senders/__tests__/senders.testlib';

/** The operation header and its change rows. */
export async function operationOf(t: T, operationId: Id<'mailArrivalOperations'>) {
	return await t.run(async (ctx) => ({
		operation: (await ctx.db.get(operationId))!,
		changes: await ctx.db
			.query('mailArrivalOperationChanges')
			.withIndex('by_operation', (q) => q.eq('operationId', operationId))
			.collect(),
	}));
}

/** Deliver one live message and return it with its thread. */
export async function deliverLive(
	t: T,
	opts: Parameters<typeof deliverHosted>[1] = {}
): Promise<{ message: Doc<'mailMessages'>; thread: Doc<'mailThreads'> }> {
	const id = await deliverHosted(t, opts);
	if (!id) throw new Error('delivery skipped');
	return await t.run(async (ctx) => {
		const message = (await ctx.db.get(id))!;
		return { message, thread: (await ctx.db.get(message.threadId))! };
	});
}

export async function threadOf(t: T, threadId: Id<'mailThreads'>): Promise<Doc<'mailThreads'>> {
	return await t.run(async (ctx) => (await ctx.db.get(threadId))!);
}

export async function messageOf(t: T, id: Id<'mailMessages'>): Promise<Doc<'mailMessages'>> {
	return await t.run(async (ctx) => (await ctx.db.get(id))!);
}

/** Patch a message's arrival record. */
export async function patchRecord(
	t: T,
	messageId: Id<'mailMessages'>,
	patch: Partial<Doc<'mailArrivalRecords'>>
): Promise<void> {
	await t.run(async (ctx) => {
		const record = await ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first();
		if (!record) throw new Error('no arrival record');
		await ctx.db.patch(record._id, patch);
	});
}
