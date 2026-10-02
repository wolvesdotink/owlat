/**
 * Team Inbox response targets: which threads a switch-on starts a clock on,
 * the reply paths outside the processing lifecycle (channel and chat replies),
 * a message a person overrules back into needing a reply, and a second save
 * while a sweep is still walking.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { expectScheduledFailure } from './helpers/scheduledFailures';

const ADMIN = vi.hoisted(() => ({
	userId: 'admin-1',
	role: 'owner' as const,
	activeOrganizationId: 'org-1',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgPermission: vi.fn().mockResolvedValue(ADMIN),
		requireAdminContext: vi.fn().mockResolvedValue(ADMIN),
		getMutationContext: vi.fn().mockResolvedValue(ADMIN),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue(ADMIN),
	};
});
vi.mock('../inbox/access', async () => {
	const actual = await vi.importActual('../inbox/access');
	return { ...actual, listSharedInboxReaderIds: vi.fn().mockResolvedValue(['admin-1']) };
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const HOUR = 60 * 60 * 1000;

const calendarPolicy = {
	isEnabled: true,
	firstResponseMinutes: 60,
	nextResponseMinutes: 120,
	hoursMode: 'calendar' as const,
	timeZone: 'UTC',
	businessHours: [],
	holidays: [],
};

async function setup() {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { inbox: true },
			createdAt: Date.now(),
		});
	});
	return t;
}

type T = Awaited<ReturnType<typeof setup>>;

async function insertThread(t: T, overrides: Partial<Doc<'conversationThreads'>> = {}) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('conversationThreads', {
			subject: 'Help',
			normalizedSubject: 'help',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
			...overrides,
		});
	});
}

let messageSeq = 0;
async function insertMessage(
	t: T,
	threadId: Id<'conversationThreads'>,
	processingStatus: Doc<'inboundMessages'>['processingStatus'],
	receivedAt = Date.now()
) {
	messageSeq++;
	return await t.run((ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `<r${messageSeq}@example.com>`,
			from: 'customer@example.com',
			to: 'support@example.com',
			subject: 'Help',
			processingStatus,
			receivedAt,
			threadId,
		})
	);
}

const getThread = (t: T, id: Id<'conversationThreads'>) => t.run((ctx) => ctx.db.get(id));

async function runApplySweep(t: T) {
	const stored = await t.query(api.inbox.sla.policy.getPolicy, {});
	await t.mutation(internal.inbox.sla.apply.applyPage, {
		generation: stored!.updatedAt,
		cursor: null,
	});
}

describe('switching targets on', () => {
	it('starts clocks only where the customer still waits on an answer', async () => {
		const t = await setup();
		const answered = await insertThread(t);
		await insertMessage(t, answered, 'sent');
		const filedAway = await insertThread(t);
		await insertMessage(t, filedAway, 'informational');
		const pending = await insertThread(t);
		await insertMessage(t, pending, 'sent', Date.now() - 2 * HOUR);
		await insertMessage(t, pending, 'draft_ready');
		const snoozed = await insertThread(t, { snoozedUntil: Date.now() + 5 * HOUR });
		await insertMessage(t, snoozed, 'received');

		await t.mutation(api.inbox.sla.policy.savePolicy, calendarPolicy);
		await runApplySweep(t);

		expect((await getThread(t, answered))!.responseDueAt).toBeUndefined();
		expect((await getThread(t, filedAway))!.responseDueAt).toBeUndefined();
		expect((await getThread(t, pending))!.responseDueAt).toBeGreaterThan(Date.now());
		const paused = await getThread(t, snoozed);
		expect(paused!.responseDueAt).toBeUndefined();
		expect(paused!.responsePausedRemainingMs).toBe(HOUR);
	});

	it('every save schedules a sweep, so a second save does not strand the first', async () => {
		const t = await setup();
		await t.mutation(api.inbox.sla.policy.savePolicy, calendarPolicy);
		await t.mutation(api.inbox.sla.policy.savePolicy, {
			...calendarPolicy,
			firstResponseMinutes: 30,
		});
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(scheduled.filter((job) => job.name.includes('applyPage'))).toHaveLength(2);

		const thread = await insertThread(t);
		await runApplySweep(t);
		expect((await getThread(t, thread))!.responseDueAt).toBeLessThanOrEqual(
			Date.now() + 30 * 60 * 1000
		);
	});
});

describe('replies outside the processing lifecycle', () => {
	it('a channel reply recorded as sent closes the clock', async () => {
		const t = await setup();
		await t.mutation(api.inbox.sla.policy.savePolicy, calendarPolicy);
		const threadId = await insertThread(t, {
			channel: 'sms',
			responseDueAt: Date.now() + HOUR,
			responseDueKind: 'first',
		});
		await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId,
			channel: 'sms',
			content: JSON.stringify({ text: 'On it' }),
			status: 'sent',
		});
		const thread = await getThread(t, threadId);
		expect(thread!.responseDueAt).toBeUndefined();
		expect(thread!).toMatchObject({ slaMetCount: 1 });
		expect(thread!.firstResponseAt).toBeDefined();

		// A failed send is no reply.
		const failed = await insertThread(t, { channel: 'sms', responseDueAt: Date.now() + HOUR });
		await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId: failed,
			channel: 'sms',
			content: JSON.stringify({ text: 'On it' }),
			status: 'failed',
		});
		expect((await getThread(t, failed))!.responseDueAt).toBeDefined();
	});

	it('a chat reply closes the clock', async () => {
		const t = await setup();
		await t.mutation(api.inbox.sla.policy.savePolicy, calendarPolicy);
		const threadId = await insertThread(t, {
			channel: 'chat',
			responseDueAt: Date.now() - 1,
			responseDueKind: 'first',
		});
		await t.mutation(api.unifiedMessages.sendChatMessage, { threadId, text: 'Sorry for the wait' });
		const thread = await getThread(t, threadId);
		expect(thread!.responseDueAt).toBeUndefined();
		expect(thread!).toMatchObject({ slaMissedCount: 1 });
	});
});

describe('a message that needs a reply after all', () => {
	it('starts a clock from its arrival when a person asks for a draft of an update', async () => {
		const t = await setup();
		await t.mutation(api.inbox.sla.policy.savePolicy, calendarPolicy);
		const arrived = Date.now() - 10 * 60 * 1000;
		const threadId = await insertThread(t);
		const messageId = await insertMessage(t, threadId, 'informational', arrived);
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'drafting', at: Date.now() },
		});
		expect(await getThread(t, threadId)).toMatchObject({
			responseDueAt: arrived + HOUR,
			responseClockStartedAt: arrived,
		});
	});

	it('starts a clock when a message is released from quarantine', async () => {
		// The release re-enters the agent pipeline, which this suite leaves out.
		expectScheduledFailure('agent/walker:start');
		const t = await setup();
		await t.mutation(api.inbox.sla.policy.savePolicy, calendarPolicy);
		const arrived = Date.now() - 10 * 60 * 1000;
		const threadId = await insertThread(t);
		const messageId = await insertMessage(t, threadId, 'quarantined', arrived);
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'received', at: Date.now(), source: 'release_quarantine' },
		});
		expect((await getThread(t, threadId))!.responseDueAt).toBe(arrived + HOUR);
	});
});
