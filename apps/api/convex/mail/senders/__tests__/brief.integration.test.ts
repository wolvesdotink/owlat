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
import { briefEmailSubject, sendersBlocks } from '../../briefEmailActions';
import { dailyBriefEmailCopy } from '../../../lib/systemEmailCopy';

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

describe('a brief that carries only the Senders line', () => {
	const UTC_0600 = Date.UTC(2026, 9, 12, 6);

	async function seedSendersOnlyBrief(t: T) {
		const { mailboxId } = await seedPersonalMailbox(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				dailyBriefEmail: { enabled: true, minute: 7 * 60, utcOffsetMinutes: 60 },
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.insert('mailDailyBriefs', {
				mailboxId,
				generatedAt: UTC_0600 - 3_600_000,
				items: [],
				bundled: [],
				bundledCounts: { newsletter: 0, notification: 0, receipt: 0 },
				senders: {
					rarelyRead: 3,
					openedInUpdates: [{ address: 'status@host.example', displayName: '<b>Host</b>' }],
				},
				createdAt: UTC_0600 - 3_600_000,
			});
		});
	}

	it('is still due, with the line in its payload', async () => {
		const t = convexTest(schema, modules);
		await seedSendersOnlyBrief(t);
		const due = await t.query(internal.mail.briefEmail.listDue, { now: UTC_0600 });
		expect(due).toHaveLength(1);
		expect(due[0]!.items).toEqual([]);
		expect(due[0]!.senders?.rarelyRead).toBe(3);
	});

	it('renders the line, escaped, with a subject that does not say "0 things"', () => {
		const copy = dailyBriefEmailCopy('en');
		expect(briefEmailSubject(copy, 0, true)).toBe('Your daily brief — your senders this week');
		expect(briefEmailSubject(copy, 2, true)).toBe(copy.subject(2));
		const [block] = sendersBlocks({
			senders: {
				rarelyRead: 3,
				openedInUpdates: [{ address: 'status@host.example', displayName: '<b>Host</b>' }],
			},
			copy,
			baseUrl: 'https://owlat.example',
		});
		const html = (block!.content as { html: string }).html;
		expect(html).toContain('3 senders you rarely read are waiting for a decision.');
		expect(html).toContain('You open everything from &lt;b&gt;Host&lt;/b&gt; in Updates.');
		expect(html).toContain('href="https://owlat.example/dashboard/postbox/senders?tab=review"');
	});
});
