/**
 * Daily brief delivered as an email (idea 29).
 *
 * Three things are worth pinning:
 *   - the schedule is the USER's local clock, and it is at-most-once per local
 *     day, so a double cron tick or a retry cannot mail two briefs;
 *   - the delivered brief lands in the owner's own inbox as a real message with
 *     a deep link per item; and
 *   - the ANTI-LOOP guard holds: the brief the deployment mailed never becomes
 *     an item in the next brief.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import {
	DELIVERY_WINDOW_MINUTES,
	isBriefDue,
	localDayIndex,
	localMinuteOfDay,
} from '../briefEmail';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'user-A',
			role: 'owner',
			activeOrganizationId: 'org-1',
		})),
	};
});

/** 2026-03-01T06:00:00Z. */
const UTC_0600 = Date.UTC(2026, 2, 1, 6, 0, 0);

describe('local clock arithmetic', () => {
	it('reads the minute of day in the user timezone, not the server one', () => {
		// Berlin (+60): 06:00Z is 07:00 local.
		expect(localMinuteOfDay(UTC_0600, 60)).toBe(7 * 60);
		// Los Angeles (-480): the same instant is the PREVIOUS day, 22:00 local.
		expect(localMinuteOfDay(UTC_0600, -480)).toBe(22 * 60);
		expect(localDayIndex(UTC_0600, -480)).toBe(localDayIndex(UTC_0600, 60) - 1);
	});
});

describe('isBriefDue', () => {
	const pref = { enabled: true, minute: 7 * 60, utcOffsetMinutes: 60 };

	it('is never due when the preference is absent or off', () => {
		expect(isBriefDue(undefined, undefined, UTC_0600)).toBe(false);
		expect(isBriefDue({ ...pref, enabled: false }, undefined, UTC_0600)).toBe(false);
	});

	it('is due once the local clock enters the window', () => {
		expect(isBriefDue(pref, undefined, UTC_0600)).toBe(true);
		// One minute before 07:00 local is not yet due.
		expect(isBriefDue(pref, undefined, UTC_0600 - 60_000)).toBe(false);
	});

	it('closes the window rather than staying due all day', () => {
		const past = UTC_0600 + DELIVERY_WINDOW_MINUTES * 60_000;
		expect(isBriefDue(pref, undefined, past)).toBe(false);
	});

	it('is at most once per LOCAL day, so a second tick in the window sends nothing', () => {
		// Delivered a minute ago, same local day.
		expect(isBriefDue(pref, UTC_0600, UTC_0600 + 60_000)).toBe(false);
		// Delivered yesterday: due again.
		expect(isBriefDue(pref, UTC_0600 - 86_400_000, UTC_0600)).toBe(true);
	});

	it('handles a window that straddles local midnight', () => {
		// 00:05 local in Berlin is 23:05Z the previous day.
		const midnightPref = { enabled: true, minute: 5, utcOffsetMinutes: 60 };
		const at = Date.UTC(2026, 2, 1, 23, 5, 0);
		expect(isBriefDue(midnightPref, undefined, at)).toBe(true);
	});
});

async function seedBriefAndPreference(
	t: TestConvex<typeof schema>,
	over: { minute?: number; lastDeliveredAt?: number } = {}
): Promise<{ mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'> }> {
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice 4471' });
	const threadId = await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		const tid = message!.threadId;
		await ctx.db.patch(tid, { latestMessageId: messageId });
		await ctx.db.insert('mailUserSettings', {
			userId: 'user-A',
			autoAdvance: 'next',
			dailyBriefEmail: {
				enabled: true,
				minute: over.minute ?? 7 * 60,
				utcOffsetMinutes: 60,
			},
			...(over.lastDeliveredAt ? { lastDailyBriefEmailAt: over.lastDeliveredAt } : {}),
			createdAt: 1,
			updatedAt: 1,
		});
		await ctx.db.insert('mailDailyBriefs', {
			mailboxId,
			generatedAt: UTC_0600 - 3_600_000,
			items: [
				{
					kind: 'needs_reply',
					threadId: tid,
					priorityScore: 90,
					title: 'Invoice 4471 looks double-charged',
					subtitle: 'ines@brightpath.example',
				},
			],
			bundled: [],
			bundledCounts: { newsletter: 2, notification: 1, receipt: 0 },
			createdAt: UTC_0600 - 3_600_000,
		});
		return tid;
	});
	return { mailboxId, threadId };
}

describe('mail.briefEmail.listDue', () => {
	it('returns the newest brief with a deep link per item', async () => {
		const t = convexTest(schema, modules);
		await seedBriefAndPreference(t);
		const due = await t.query(internal.mail.briefEmail.listDue, { now: UTC_0600 });
		expect(due).toHaveLength(1);
		expect(due[0]?.items[0]).toMatchObject({
			title: 'Invoice 4471 looks double-charged',
		});
		expect(due[0]?.items[0]?.path).toMatch(/^\/dashboard\/postbox\/inbox\//);
		expect(due[0]?.bundledCounts).toEqual({ newsletter: 2, notification: 1, receipt: 0 });
	});

	it('returns nobody outside the window', async () => {
		const t = convexTest(schema, modules);
		await seedBriefAndPreference(t, { minute: 23 * 60 });
		expect(await t.query(internal.mail.briefEmail.listDue, { now: UTC_0600 })).toEqual([]);
	});

	it('returns nobody who already got today s brief', async () => {
		const t = convexTest(schema, modules);
		await seedBriefAndPreference(t, { lastDeliveredAt: UTC_0600 - 60_000 });
		expect(await t.query(internal.mail.briefEmail.listDue, { now: UTC_0600 })).toEqual([]);
	});

	it('sends nothing when no brief has been built yet', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		await seedFolder(t, mailboxId, 'inbox');
		await t.run(async (ctx) => {
			await ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				dailyBriefEmail: { enabled: true, minute: 7 * 60, utcOffsetMinutes: 60 },
				createdAt: 1,
				updatedAt: 1,
			});
		});
		expect(await t.query(internal.mail.briefEmail.listDue, { now: UTC_0600 })).toEqual([]);
	});
});

describe('mail.briefEmail.deliverBriefEmail', () => {
	async function deliver(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
		const rawStorageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw'])));
		return t.mutation(internal.mail.briefEmail.deliverBriefEmail, {
			userId: 'user-A',
			mailboxId,
			rawStorageId,
			rawSize: 3,
			messageId: 'brief-1@hinterland.camp',
			subject: 'Your daily brief — 1 thing needs you',
			bodyText: 'What needs you today',
			bodyHtml: '<p>What needs you today</p>',
			snippet: 'What needs you today',
		});
	}

	it('files the brief into the owner s own inbox, unread', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedBriefAndPreference(t);
		expect(await deliver(t, mailboxId)).toEqual({ delivered: true });

		const delivered = await t.run(async (ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_rfc822_message_id', (q) =>
					q.eq('rfc822MessageId', 'brief-1@hinterland.camp')
				)
				.first()
		);
		expect(delivered?.mailboxId).toBe(mailboxId);
		expect(delivered?.flagSeen).toBe(false);
	});

	it('stamps the delivery so the next tick does not send a second copy', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedBriefAndPreference(t);
		await deliver(t, mailboxId);
		const settings = await t.run(async (ctx) =>
			ctx.db
				.query('mailUserSettings')
				.withIndex('by_user', (q) => q.eq('userId', 'user-A'))
				.first()
		);
		expect(settings?.lastDailyBriefEmailAt).toBeGreaterThan(0);
		expect(isBriefDue(settings?.dailyBriefEmail, settings?.lastDailyBriefEmailAt, Date.now())).toBe(
			false
		);
	});

	it('marks its thread so the brief never re-enters the next brief', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedBriefAndPreference(t);
		await deliver(t, mailboxId);

		const briefThread = await t.run(async (ctx) => {
			const delivered = await ctx.db
				.query('mailMessages')
				.withIndex('by_rfc822_message_id', (q) =>
					q.eq('rfc822MessageId', 'brief-1@hinterland.camp')
				)
				.first();
			return ctx.db.get(delivered!.threadId);
		});
		expect(briefThread?.isSelfDeliveredBrief).toBe(true);

		// And the builder skips it: give the brief's own thread every signal that
		// would normally make it an item, then rebuild.
		await t.run(async (ctx) => {
			await ctx.db.patch(briefThread!._id, {
				category: { label: 'newsletter', source: 'heuristic', classifiedAt: Date.now() },
			});
		});
		await t.mutation(internal.mail.dailyBrief.buildForMailbox, { mailboxId });
		const newest = await t.run(async (ctx) =>
			ctx.db
				.query('mailDailyBriefs')
				.withIndex('by_mailbox_and_generated', (q) => q.eq('mailboxId', mailboxId))
				.order('desc')
				.first()
		);
		expect(newest?.bundled.some((b) => b.threadId === briefThread!._id)).toBe(false);
	});
});
