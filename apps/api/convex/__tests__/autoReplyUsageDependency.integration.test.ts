/**
 * The daily auto-reply count and the Team Inbox thread reader share no document.
 *
 * Every open `inbox/queries:getThread` re-runs when a document it read
 * changes. The count is written on every autonomous reply, so it must live
 * where no reader of an unrelated thread looks. These tests record the
 * document ids `getThread` reads and the ids the auto-reply lifecycle writes
 * (`dependencyDb`) and require the two sets to be disjoint, which is what a
 * subscription invalidation needs; convex-test does not simulate one.
 *
 * The count also has to survive the deploy that moves it: a deployment's
 * agentConfig row still carries today's count, and the daily limit must not
 * restart from zero.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getThread } from '../inbox/queries';
import { transition } from '../inbox/processingLifecycle';
import { dependencyDb, type DocumentDependencies } from './indexRecorder.testlib';
import { expectScheduledFailure } from './helpers/scheduledFailures';

beforeEach(() => {
	expectScheduledFailure('agent/walker:start');
	expectScheduledFailure('agent/walker:resumeDraft');
});

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type T = ReturnType<typeof convexTest>;

type Handler<Args, Result> = { _handler: (ctx: unknown, args: Args) => Promise<Result> };
const readThread = (getThread as unknown as Handler<{ threadId: string }, unknown>)._handler;
const runTransition = (transition as unknown as Handler<unknown, { ok: boolean }>)._handler;

async function seedConfig(t: T, usage: { count: number; resetAt: number }) {
	return await t.run((ctx) =>
		ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.8,
			maxDailyAutoReplies: 100,
			coalesceWindowMs: 10 * 60 * 1000,
			dailyAutoReplyCount: usage.count,
			dailyAutoReplyResetAt: usage.resetAt,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
}

/** A thread holding one message in `status`. */
async function seedThread(t: T, status: 'sent' | 'received' | 'drafting') {
	return await t.run(async (ctx) => {
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Help please',
			normalizedSubject: 'help please',
			contactIdentifier: 'sender@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		const messageId = await ctx.db.insert('inboundMessages', {
			messageId: `<${status}-${threadId}@example.com>`,
			from: 'sender@example.com',
			to: 'support@owlat.app',
			subject: 'Help please',
			textBody: 'I need help',
			processingStatus: status,
			receivedAt: Date.now(),
			threadId,
		});
		return { threadId, messageId };
	});
}

function deps(): DocumentDependencies {
	return { read: new Set(), written: new Set() };
}

async function readerDeps(t: T, threadId: Id<'conversationThreads'>) {
	const recorded = deps();
	const view = await t.run((ctx) =>
		readThread({ ...ctx, db: dependencyDb(ctx.db, recorded) }, { threadId })
	);
	return { recorded, view: view as { takeOver: { receivedWaitMs?: number } } };
}

/** One autonomous reply approved on `messageId`, as the route step's commit lands it. */
async function autoReplyDeps(t: T, messageId: Id<'inboundMessages'>) {
	const recorded = deps();
	const outcome = await t.run((ctx) =>
		runTransition(
			{ ...ctx, db: dependencyDb(ctx.db, recorded) },
			{ inboundMessageId: messageId, input: { to: 'approved', at: Date.now(), source: 'auto' } }
		)
	);
	expect(outcome.ok).toBe(true);
	return recorded;
}

function shared(reader: DocumentDependencies, writer: DocumentDependencies): string[] {
	return [...reader.read].filter((id) => writer.written.has(id));
}

const laterToday = () => Date.now() + 60 * 60 * 1000;

describe('auto-reply usage vs. the Team Inbox thread reader', () => {
	it('a settled thread reads nothing an unrelated auto-reply writes', async () => {
		const t = convexTest(schema, modules);
		const configId = await seedConfig(t, { count: 3, resetAt: laterToday() });
		const settled = await seedThread(t, 'sent');
		const other = await seedThread(t, 'drafting');

		const reader = await readerDeps(t, settled.threadId);
		const writer = await autoReplyDeps(t, other.messageId);

		expect(shared(reader.recorded, writer)).toEqual([]);
		// No message waits out the coalescing window, so the settings are not read.
		expect(reader.recorded.read.has(configId)).toBe(false);
		expect(reader.view.takeOver.receivedWaitMs).toBeUndefined();
	});

	it('a thread with a received message still reads the window, and an auto-reply leaves it alone', async () => {
		const t = convexTest(schema, modules);
		const configId = await seedConfig(t, { count: 3, resetAt: laterToday() });
		const pending = await seedThread(t, 'received');
		const other = await seedThread(t, 'drafting');

		const reader = await readerDeps(t, pending.threadId);
		const writer = await autoReplyDeps(t, other.messageId);

		expect(reader.recorded.read.has(configId)).toBe(true);
		expect(reader.view.takeOver.receivedWaitMs).toBe(11 * 60 * 1000);
		expect(writer.written.has(configId)).toBe(false);
		expect(shared(reader.recorded, writer)).toEqual([]);
	});
});

describe('auto-reply usage across the deploy that moves it', () => {
	async function reportedUsage(t: T) {
		const config = await t.query(internal.agent.agentPipeline.getAgentConfig, {});
		return { count: config?.dailyAutoReplyCount, resetAt: config?.dailyAutoReplyResetAt };
	}

	it('keeps counting from the day’s count stored on agentConfig', async () => {
		const t = convexTest(schema, modules);
		const resetAt = laterToday();
		await seedConfig(t, { count: 7, resetAt });
		expect(await reportedUsage(t)).toEqual({ count: 7, resetAt });

		await autoReplyDeps(t, (await seedThread(t, 'drafting')).messageId);
		expect(await reportedUsage(t)).toEqual({ count: 8, resetAt });

		await autoReplyDeps(t, (await seedThread(t, 'drafting')).messageId);
		expect(await reportedUsage(t)).toEqual({ count: 9, resetAt });
	});

	it('restarts at one when the stored day has ended', async () => {
		const t = convexTest(schema, modules);
		await seedConfig(t, { count: 99, resetAt: Date.now() - 1 });

		await autoReplyDeps(t, (await seedThread(t, 'drafting')).messageId);
		const usage = await reportedUsage(t);
		expect(usage.count).toBe(1);
		expect(usage.resetAt).toBeGreaterThan(Date.now());
	});

	it('leaves the agentConfig row untouched while counting', async () => {
		const t = convexTest(schema, modules);
		const configId = await seedConfig(t, { count: 2, resetAt: laterToday() });
		const before = await t.run((ctx) => ctx.db.get(configId));

		await autoReplyDeps(t, (await seedThread(t, 'drafting')).messageId);

		expect(await t.run((ctx) => ctx.db.get(configId))).toEqual(before);
		expect((await reportedUsage(t)).count).toBe(3);
	});
});
