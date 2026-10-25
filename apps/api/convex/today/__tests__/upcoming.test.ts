/**
 * Today's Upcoming band: one time order across scheduled sends, snooze
 * returns, follow-up reminders, Team Inbox snoozes and scheduled campaigns,
 * from only the sources the viewer may read.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { createTestCampaign, createTestTopic, enableFeatures } from '../../__tests__/factories';
import { mergeUpcoming } from '../upcoming';
import type { UpcomingItem } from '../upcomingSources';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => {
		if (sessionMock.role === null) return null;
		return {
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: sessionMock.orgId,
		};
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return session()!;
		}),
		getMutationContext: vi.fn(async () => {
			const s = session();
			if (!s) throw new Error('Not authenticated');
			return s;
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

const NOW = Date.UTC(2026, 9, 21, 8, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'], now: NOW });
	sessionMock.userId = 'user-A';
	sessionMock.role = 'editor';
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedInbox(
	t: TestConvex<typeof schema>,
	seed: Parameters<typeof seedMailbox>[1] = {}
): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, seed);
	await seedFolder(t, mailboxId);
	return mailboxId;
}

async function seedScheduledSend(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	at: number,
	opts: { subject?: string; state?: 'draft' | 'scheduled'; to?: string[] } = {}
): Promise<Id<'mailDrafts'>> {
	return await t.run((ctx) =>
		ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: opts.to ?? ['ines@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@owlat.test',
			subject: opts.subject ?? 'Re: Offer',
			bodyHtml: '<p>hi</p>',
			attachments: [],
			state: opts.state ?? 'scheduled',
			...(opts.state === 'draft' ? {} : { scheduledSendAt: at, undoToken: `tok-${at}` }),
			lastEditedAt: NOW - DAY,
			createdAt: NOW - DAY,
		})
	);
}

async function snooze(
	t: TestConvex<typeof schema>,
	messageId: Id<'mailMessages'>,
	until: number,
	threadId?: Id<'mailThreads'>
): Promise<void> {
	await t.run((ctx) =>
		ctx.db.patch(messageId, { snoozedUntil: until, ...(threadId ? { threadId } : {}) })
	);
}

async function threadOf(
	t: TestConvex<typeof schema>,
	messageId: Id<'mailMessages'>
): Promise<Id<'mailThreads'>> {
	return await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
}

async function armFollowUp(
	t: TestConvex<typeof schema>,
	messageId: Id<'mailMessages'>,
	remindAt: number
): Promise<Id<'mailThreads'>> {
	const threadId = await threadOf(t, messageId);
	await t.run((ctx) =>
		ctx.db.patch(threadId, {
			followUp: { messageId, remindAt, armedAt: NOW, waitingOn: 'mei@example.com' },
			followUpRemindAt: remindAt,
		})
	);
	return threadId;
}

async function seedCampaign(
	t: TestConvex<typeof schema>,
	at: number,
	overrides: Record<string, unknown> = {}
): Promise<Id<'campaigns'>> {
	return await t.run((ctx) =>
		ctx.db.insert(
			'campaigns',
			createTestCampaign({ name: 'Autumn', status: 'scheduled', scheduledAt: at, ...overrides })
		)
	);
}

async function seedTeamThread(
	t: TestConvex<typeof schema>,
	fields: { subject?: string; contactIdentifier?: string; snoozedUntil?: number }
): Promise<Id<'conversationThreads'>> {
	const subject = fields.subject ?? 'Question';
	return await t.run((ctx) =>
		ctx.db.insert('conversationThreads', {
			subject,
			normalizedSubject: subject.toLowerCase(),
			contactIdentifier: fields.contactIdentifier ?? 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: NOW - DAY,
			firstMessageAt: NOW - DAY,
			...(fields.snoozedUntil === undefined ? {} : { snoozedUntil: fields.snoozedUntil }),
			createdAt: NOW - DAY,
		})
	);
}

function list(t: TestConvex<typeof schema>, limit?: number) {
	return t.query(api.today.upcoming.list, limit === undefined ? {} : { limit });
}

describe('today.upcoming.list', () => {
	it('interleaves every kind in time order, labelled with its mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);
		const mailboxId = await seedInbox(t);
		await seedScheduledSend(t, mailboxId, NOW + 1 * HOUR, { subject: 'Re: Offer' });
		const invoice = await seedMessage(t, mailboxId, { subject: 'Invoice 42', fromName: 'Lumen' });
		await snooze(t, invoice, NOW + 3 * DAY);
		const sent = await seedMessage(t, mailboxId, { subject: 'Contract' });
		await armFollowUp(t, sent, NOW + 2 * DAY);
		const topicId = await t.run((ctx) =>
			ctx.db.insert('topics', createTestTopic({ name: 'Newsletter', requireDoubleOptIn: false }))
		);
		await seedCampaign(t, NOW + 5 * DAY, { audience: { kind: 'topic', topicId } });

		const page = await list(t);
		expect(page.hasMore).toBe(false);
		expect(page.items.map((i) => i.kind)).toEqual([
			'scheduled_send',
			'follow_up',
			'snooze_return',
			'campaign',
		]);
		const [send, followUp, snoozed, campaign] = page.items;
		expect(send).toMatchObject({
			subject: 'Re: Offer',
			firstRecipient: 'ines@example.com',
			recipientCount: 1,
			mailboxId,
			mailboxLabel: 'a@owlat.test',
		});
		expect(followUp).toMatchObject({ subject: 'Contract', waitingOn: 'mei@example.com' });
		expect(snoozed).toMatchObject({ subject: 'Invoice 42', from: 'Lumen', at: NOW + 3 * DAY });
		// Never counted: the band says so instead of scanning the audience.
		expect(campaign).toMatchObject({
			name: 'Autumn',
			timing: 'absolute',
			audienceName: 'Newsletter',
			recipients: null,
		});
	});

	it('serves the last exact audience count and the recipient-local send time', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);
		const topicId = await t.run((ctx) =>
			ctx.db.insert('topics', createTestTopic({ name: 'Newsletter', requireDoubleOptIn: false }))
		);
		await t.run((ctx) =>
			ctx.db.insert('audienceCountJobs', {
				audienceKey: `topic:${topicId}:doi=0`,
				audienceRef: topicId,
				audience: { kind: 'topic', topicId },
				resolvedAudience: { kind: 'topic', topicId },
				generation: 1,
				status: 'complete',
				cursor: '',
				total: 12_500,
				eligible: 12_400,
				pages: 3,
				startedAt: NOW - HOUR,
				updatedAt: NOW - HOUR,
				completedAt: NOW - HOUR,
			})
		);
		await seedCampaign(t, NOW + DAY, {
			audience: { kind: 'topic', topicId },
			useRecipientTimezone: true,
			scheduledHour: 9,
			scheduledMinute: 30,
		});

		const [campaign] = (await list(t)).items;
		expect(campaign).toMatchObject({
			kind: 'campaign',
			timing: 'recipient_local',
			localTime: { hour: 9, minute: 30 },
			recipients: { count: 12_400, countedAt: NOW - HOUR },
		});
	});

	it('finds the earliest send behind more than a page of other rows', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);
		const mailboxId = await seedInbox(t);
		// Drafts edited most recently would fill the Drafts list's page first.
		for (let i = 0; i < 12; i++) {
			await seedScheduledSend(t, mailboxId, NOW + (10 + i) * DAY, { subject: `later ${i}` });
		}
		for (let i = 0; i < 12; i++) await seedCampaign(t, NOW + (20 + i) * DAY);
		// Deleted and unscheduled campaigns never take a place on the page.
		for (let i = 0; i < 5; i++) {
			await seedCampaign(t, NOW + HOUR, { deletedAt: NOW - MIN, name: 'deleted' });
			await seedCampaign(t, NOW + HOUR, { status: 'draft', name: 'draft' });
		}
		await seedScheduledSend(t, mailboxId, NOW + 2 * HOUR, { subject: 'soonest' });

		const page = await list(t, 3);
		expect(page.items.map((i) => (i.kind === 'campaign' ? i.name : i.subject))).toEqual([
			'soonest',
			'later 0',
			'later 1',
		]);
		expect(page.hasMore).toBe(true);
		// A larger page continues in the same order.
		const bigger = await list(t, 15);
		expect(bigger.items.slice(0, 3)).toEqual(page.items);
		expect(bigger.items.filter((i) => i.kind === 'campaign')).toHaveLength(2);
		expect(bigger.items.some((i) => i.kind === 'campaign' && i.name !== 'Autumn')).toBe(false);
	});

	it('lists a snoozed conversation once, at its earliest return', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const first = await seedMessage(t, mailboxId, { subject: 'Invoice 42' });
		const threadId = await threadOf(t, first);
		const second = await seedMessage(t, mailboxId, { subject: 'Invoice 42 again' });
		await snooze(t, first, NOW + 2 * DAY, threadId);
		await snooze(t, second, NOW + DAY, threadId);
		// Already back: not upcoming.
		const woken = await seedMessage(t, mailboxId, { subject: 'old' });
		await snooze(t, woken, NOW - MIN);

		const page = await list(t);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ kind: 'snooze_return', threadId, at: NOW + DAY });
	});

	it('leaves out drafts that are not scheduled and follow-ups already due', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedScheduledSend(t, mailboxId, NOW + HOUR, { state: 'draft' });
		const sent = await seedMessage(t, mailboxId, { subject: 'Contract' });
		const threadId = await armFollowUp(t, sent, NOW + DAY);
		// The sweep fired: the watch is due and its remind time is gone.
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				followUp: { messageId: sent, remindAt: NOW - MIN, armedAt: NOW - DAY, dueAt: NOW },
				followUpRemindAt: undefined,
			})
		);
		expect((await list(t)).items).toEqual([]);
	});

	it("reads only the viewer's mailboxes, shared ones included, and only active ones", async () => {
		const t = convexTest(schema, modules);
		const mine = await seedInbox(t, { userId: 'user-A' });
		const theirs = await seedInbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const team = await seedInbox(t, {
			userId: 'user-B',
			address: 'team@owlat.test',
			scope: 'shared',
		});
		const suspended = await seedInbox(t, { userId: 'user-A', status: 'suspended' });
		await t.run((ctx) =>
			ctx.db.insert('mailboxMembers', {
				mailboxId: team,
				authUserId: 'user-A',
				role: 'member',
				addedBy: 'user-B',
				createdAt: NOW,
			})
		);
		await t.run((ctx) => ctx.db.patch(team, { displayName: 'Support' }));
		await seedScheduledSend(t, mine, NOW + HOUR, { subject: 'mine' });
		await seedScheduledSend(t, theirs, NOW + HOUR, { subject: 'theirs' });
		await seedScheduledSend(t, team, NOW + 2 * HOUR, { subject: 'team' });
		await seedScheduledSend(t, suspended, NOW + HOUR, { subject: 'suspended' });

		const page = await list(t);
		expect(page.items.map((i) => (i.kind === 'scheduled_send' ? i.subject : i.kind))).toEqual([
			'mine',
			'team',
		]);
		expect(page.items[1]).toMatchObject({ mailboxLabel: 'Support' });
	});

	it('shows nothing from a capability that is off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t, { featuresOff: true });
		// Campaigns are on by default; personal mail and the Team Inbox are off.
		await t.run((ctx) =>
			ctx.db.insert('instanceSettings', {
				featureFlags: { campaigns: false },
				createdAt: NOW,
				updatedAt: NOW,
			})
		);
		await seedScheduledSend(t, mailboxId, NOW + HOUR);
		await seedCampaign(t, NOW + DAY);
		await seedTeamThread(t, { snoozedUntil: NOW + DAY });
		sessionMock.role = 'owner';
		expect((await list(t)).items).toEqual([]);
	});

	it('lists Team Inbox snoozes for shared-inbox readers only', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await seedTeamThread(t, {
			subject: 'Refund request',
			contactIdentifier: 'jonas@example.com',
			snoozedUntil: NOW + DAY,
		});
		expect((await list(t)).items).toEqual([]);
		sessionMock.role = 'admin';
		const [team] = (await list(t)).items;
		expect(team).toMatchObject({
			kind: 'team_snooze_return',
			subject: 'Refund request',
			contact: 'jonas@example.com',
		});
	});
});

describe('mergeUpcoming', () => {
	const item = (key: string, at: number): UpcomingItem => ({
		kind: 'team_snooze_return',
		key,
		at,
		threadId: key as Id<'conversationThreads'>,
		subject: key,
		contact: 'x@example.com',
	});

	it('stops at a source horizon so an unscanned earlier item is never jumped', () => {
		const page = mergeUpcoming(
			[{ items: [item('a', 1), item('b', 5)] }, { items: [item('c', 2)], horizon: 3 }],
			10
		);
		expect(page.items.map((i) => i.key)).toEqual(['a', 'c']);
		expect(page.hasMore).toBe(true);
	});

	it('orders ties by key and reports more past the limit', () => {
		const page = mergeUpcoming([{ items: [item('b', 1), item('a', 1), item('c', 2)] }], 2);
		expect(page.items.map((i) => i.key)).toEqual(['a', 'b']);
		expect(page.hasMore).toBe(true);
	});
});
