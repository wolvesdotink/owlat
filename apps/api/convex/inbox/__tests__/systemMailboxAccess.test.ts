/**
 * Mail the MTA's built-in `postmaster@`/`abuse@` route accepted is for the
 * instance admins only, and it is not a customer conversation.
 *
 * The auth path is real end to end: BetterAuth organization and member rows
 * are seeded through the registered component, each caller is a real identity
 * carrying its active organization, and nothing in `lib/sessionOrganization`
 * or `inbox/access.ts` is mocked. Fake timers keep scheduled jobs queued, so a
 * test reads what ingest scheduled and runs the notice fan-out itself.
 *
 * Search is pinned for the member only: convex-test has no `withSearchIndex`,
 * and the member's refusal happens before the search runs.
 */

import type { TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type schema from '../../schema';
import { api, components, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { enableFeatures } from '../../__tests__/factories';
import { newBetterAuthHarness } from '../../__tests__/testModules';
import {
	_resetSingletonOrgCacheForTests,
	hasPermission,
	type OrganizationRole,
} from '../../lib/sessionOrganization';
import type { MarketingNoticeEvent } from '../../lib/validators/marketingNotifications';
import { isSharedInboxReader } from '../access';

type T = TestConvex<typeof schema>;

const ADMIN = 'user-admin';
const MEMBER = 'user-editor';
const SENDER = 'listings@blocklist.example';
const SUBJECT = 'Listing of 192.0.2.10';

let t: T;
let organizationId: string;

async function seedMember(userId: string, role: OrganizationRole): Promise<void> {
	await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'member',
			data: { organizationId, userId, role, createdAt: Date.now() },
		},
	} as never);
}

function as(userId: string) {
	return t.withIdentity({ subject: userId, activeOrganizationId: organizationId });
}

function mail(messageId: string, overrides: Record<string, unknown> = {}) {
	return {
		from: `Blocklist <${SENDER}>`,
		to: 'abuse@bounces.example.com',
		subject: SUBJECT,
		textBody: 'Your sending IP was listed after spam reached our traps. Reply to delist.',
		headers: {},
		messageId,
		attachments: [],
		timestamp: Date.now(),
		...overrides,
	};
}

async function ingest(messageId: string, overrides: Record<string, unknown> = {}) {
	return t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
		mail: mail(messageId, overrides),
	});
}

async function systemMail(messageId = '<listing-1@blocklist.example>') {
	const { inboundMessageId } = await ingest(messageId, { systemMailbox: 'abuse' });
	const row = await t.run((ctx) => ctx.db.get(inboundMessageId));
	return { inboundMessageId, threadId: row!.threadId! };
}

/** Names of the scheduled jobs still pending. */
async function pendingJobs(): Promise<string[]> {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending')
			.map((job) => job.name)
	);
}

async function queuedNoticeEvents(): Promise<MarketingNoticeEvent[]> {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('marketing/notifications') && job.state.kind === 'pending')
			.map((job) => (job.args[0] as { event: MarketingNoticeEvent }).event)
	);
}

beforeEach(async () => {
	vi.useFakeTimers();
	_resetSingletonOrgCacheForTests();
	t = newBetterAuthHarness();
	rateLimiterTest.register(t);
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'organization',
			data: { name: 'Owlat', slug: 'owlat', createdAt: Date.now() },
		},
	} as never)) as { _id: string };
	organizationId = org._id;
	await seedMember(ADMIN, 'admin');
	await seedMember(MEMBER, 'editor');
	await enableFeatures(t, ['inbox', 'ai.agent']);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('postmaster and abuse mail is read by instance admins only', () => {
	it('keeps the reader gate at exactly the roles that hold organization:manage', () => {
		for (const role of ['owner', 'admin', 'editor'] as const) {
			expect(isSharedInboxReader({ role })).toBe(hasPermission(role, 'organization:manage'));
		}
	});

	it('is absent from a member’s list, counts, reader and search', async () => {
		const { inboundMessageId, threadId } = await systemMail();
		const member = as(MEMBER);

		expect(await member.query(api.inbox.queries.listThreads, {})).toEqual({
			threads: [],
			nextCursor: null,
		});
		expect(await member.query(api.inbox.queries.listThreads, { search: 'Listing' })).toEqual({
			threads: [],
			nextCursor: null,
		});
		expect(await member.query(api.inbox.queries.getThreadFilterCounts, {})).toBeNull();
		expect(await member.query(api.inbox.queries.getInboundStats, {})).toBeNull();
		expect(await member.query(api.inbox.queries.getThread, { threadId })).toBeNull();
		expect(
			await member.query(api.inbox.threadPage.getMessage, { messageId: inboundMessageId })
		).toBeNull();
	});

	it('is in an admin’s list, counts and reader', async () => {
		const { inboundMessageId, threadId } = await systemMail();
		const admin = as(ADMIN);

		const list = await admin.query(api.inbox.queries.listThreads, {});
		expect(list.threads.map((thread: { _id: string }) => thread._id)).toEqual([threadId]);
		expect(await admin.query(api.inbox.queries.getThreadFilterCounts, {})).toMatchObject({
			open: 1,
		});
		expect(await admin.query(api.inbox.queries.getInboundStats, {})).toMatchObject({
			received: 1,
		});
		const thread = await admin.query(api.inbox.queries.getThread, { threadId });
		expect(thread?.messages.map((m: { _id: string }) => m._id)).toEqual([inboundMessageId]);
		expect(
			await admin.query(api.inbox.threadPage.getMessage, { messageId: inboundMessageId })
		).toMatchObject({ _id: inboundMessageId, subject: SUBJECT });
	});

	it('notifies the admins with a link to the conversation, and no member', async () => {
		const { threadId } = await systemMail();
		const events = await queuedNoticeEvents();
		expect(events).toEqual([{ kind: 'postmaster_mail', inboundMessageId: expect.any(String) }]);
		await t.mutation(internal.marketing.notifications.fanOut, { event: events[0]! });

		const rows = await t.run((ctx) => ctx.db.query('marketingNotices').collect());
		expect(rows.map((row) => row.userId)).toEqual([ADMIN]);

		expect(await as(MEMBER).query(api.marketing.notifications.listRecent, {})).toEqual([]);
		expect(await as(ADMIN).query(api.marketing.notifications.listRecent, {})).toEqual([
			expect.objectContaining({
				kind: 'postmaster_mail',
				url: `/dashboard/inbox/${threadId}`,
				name: 'abuse@bounces.example.com',
				detail: SENDER,
			}),
		]);
	});
});

describe('postmaster and abuse mail is not a customer conversation', () => {
	it('files no contact, timeline row or activity for the sender', async () => {
		const { inboundMessageId, threadId } = await systemMail();

		const stored = await t.run(async (ctx) => ({
			message: await ctx.db.get(inboundMessageId),
			thread: await ctx.db.get(threadId),
			contacts: await ctx.db.query('contacts').collect(),
			activities: await ctx.db.query('contactActivities').collect(),
			timeline: await ctx.db.query('unifiedMessages').collect(),
		}));
		expect(stored.message).toMatchObject({ systemMailbox: 'abuse', processingStatus: 'received' });
		expect(stored.message?.contactId).toBeUndefined();
		expect(stored.thread).toMatchObject({ systemMailbox: 'abuse', contactIdentifier: SENDER });
		expect(stored.contacts).toEqual([]);
		expect(stored.activities).toEqual([]);
		expect(stored.timeline).toEqual([]);
	});

	it('never schedules the agent, and the walker refuses to start it', async () => {
		const { inboundMessageId } = await systemMail();
		expect((await pendingJobs()).filter((name) => name.startsWith('agent/'))).toEqual([]);

		await t.action(internal.agent.walker.start, { inboundMessageId });
		expect((await pendingJobs()).filter((name) => name.startsWith('agent/'))).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get(inboundMessageId)))?.processingStatus).toBe('received');
	});

	it('keeps unmarked mail to the same address on the ordinary path', async () => {
		const { inboundMessageId } = await ingest('<route-1@example.org>', {
			from: 'Customer <ana@example.org>',
			to: 'postmaster@bounces.example.com',
		});
		const row = await t.run((ctx) => ctx.db.get(inboundMessageId));
		expect(row?.systemMailbox).toBeUndefined();
		expect(row?.contactId).toBeDefined();
		expect(await pendingJobs()).toContain('agent/walker:start');
		expect(await queuedNoticeEvents()).toEqual([]);
	});

	it('never threads customer mail into a postmaster conversation, or the reverse', async () => {
		const { threadId: systemThread } = await systemMail('<listing-2@blocklist.example>');
		const { inboundMessageId: customerId } = await ingest('<customer-2@blocklist.example>', {
			inReplyTo: '<listing-2@blocklist.example>',
		});
		const customerThread = (await t.run((ctx) => ctx.db.get(customerId)))!.threadId!;
		expect(customerThread).not.toBe(systemThread);

		const { threadId: secondSystem } = await systemMail('<listing-3@blocklist.example>');
		expect(secondSystem).toBe(systemThread);
		const threads = await t.run((ctx) => ctx.db.get(customerThread as Id<'conversationThreads'>));
		expect(threads?.systemMailbox).toBeUndefined();
	});
});
