/**
 * The weekly Senders line of the Daily Brief (SPEC §5): on Mondays the
 * persisted brief carries the rarely-read count and the "you open everything
 * from X in Updates" senders; on other days it carries nothing.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { internal } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { addSenderDelivery, addSenderOpen, emptySenderWeeks } from '../counters';
import { seedPersonalMailbox, seedProfile, type T } from './senders.testlib';

const MONDAY = Date.UTC(2026, 9, 12, 6);
const TUESDAY = Date.UTC(2026, 9, 13, 6);

async function seedSenders(t: T, mailboxId: Id<'mailboxes'>, now: number) {
	let unread = emptySenderWeeks(now);
	let read = emptySenderWeeks(now);
	for (let i = 0; i < 6; i++) {
		unread = addSenderDelivery(unread, now);
		read = addSenderOpen(addSenderDelivery(read, now), now, now);
	}
	await seedProfile(t, mailboxId, { ...unread, kind: 'newsletter', lastDeliveredAt: now });
	await seedProfile(t, mailboxId, {
		...read,
		address: 'status@host.example',
		displayName: 'Host',
		kind: 'notification',
		lastDeliveredAt: now,
	});
}

async function latestBrief(t: T, mailboxId: Id<'mailboxes'>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('mailDailyBriefs')
				.withIndex('by_mailbox_and_generated', (q) => q.eq('mailboxId', mailboxId))
				.order('desc')
				.first()
	);
}

describe('weekly Senders line', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rides along on Monday', async () => {
		vi.useFakeTimers({ now: MONDAY });
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedSenders(t, mailboxId, MONDAY);
		await t.mutation(internal.mail.dailyBrief.buildForMailbox, { mailboxId });
		expect((await latestBrief(t, mailboxId))!.senders).toEqual({
			rarelyRead: 1,
			openedInUpdates: [{ address: 'status@host.example', displayName: 'Host' }],
		});
	});

	it('stays out on other days', async () => {
		vi.useFakeTimers({ now: TUESDAY });
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedSenders(t, mailboxId, TUESDAY);
		await t.mutation(internal.mail.dailyBrief.buildForMailbox, { mailboxId });
		expect((await latestBrief(t, mailboxId))!.senders).toBeUndefined();
	});
});
