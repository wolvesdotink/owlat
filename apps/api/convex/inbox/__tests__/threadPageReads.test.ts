/**
 * What opening a Team Inbox conversation costs, counted: the messages read and
 * the bodies opened, for `queries.getThread` (the whole history) and for the
 * paged read in `threadPage.ts` (a page, and one body per expanded message).
 *
 * Bodies are counted at `lib/messageBody.openMessageBody`, the one call that
 * turns a stored body column into text; messages read are the `inboundMessages`
 * documents the handler's queries and point reads hand back (`observingDb`).
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import { observingDb } from '../../__tests__/indexRecorder.testlib';
import { getThread } from '../queries';
import { getMessage, getThreadPage, THREAD_PAGE_SIZE } from '../threadPage';

const opened = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../lib/messageBody', async () => {
	const actual =
		await vi.importActual<typeof import('../../lib/messageBody')>('../../lib/messageBody');
	return {
		...actual,
		openMessageBody: (stored: string) => {
			opened.count += 1;
			return actual.openMessageBody(stored);
		},
	};
});

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

beforeEach(() => {
	opened.count = 0;
});

type T = ReturnType<typeof convexTest>;
type Handler<Args, Result> = { _handler: (ctx: unknown, args: Args) => Promise<Result> };
type PageResult = {
	head: { takeOver: { messages: Array<{ messageId: string }> }; waiting: Array<{ _id: string }> };
	messages: Array<{ _id: string; textBody?: string; isBodyDeferred?: true }>;
	cursor: string;
	isDone: boolean;
};

const readThread = (getThread as unknown as Handler<{ threadId: string }, { messages: unknown[] }>)
	._handler;
const readPage = (
	getThreadPage as unknown as Handler<
		{ threadId: string; cursor?: string | null; limit?: number; withBodies?: boolean },
		PageResult
	>
)._handler;
const readMessage = (
	getMessage as unknown as Handler<{ messageId: string }, { _id: string; textBody?: string }>
)._handler;

const bodyOf = (i: number) => `Message ${i}: ${'x'.repeat(200)}`;

/** A thread of `size` text-only messages, oldest first; the newest is `draft_ready`. */
async function seedThread(t: T, size: number, statusOf?: (i: number) => string) {
	return await t.run(async (ctx) => {
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'A long conversation',
			normalizedSubject: 'a long conversation',
			contactIdentifier: 'dana@example.com',
			status: 'open',
			messageCount: size,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		const ids: Id<'inboundMessages'>[] = [];
		for (let i = 0; i < size; i++) {
			const status = statusOf?.(i) ?? (i === size - 1 ? 'draft_ready' : 'sent');
			ids.push(
				await ctx.db.insert('inboundMessages', {
					messageId: `<m${i}-${threadId}@example.com>`,
					from: 'dana@example.com',
					to: 'support@owlat.app',
					subject: 'A long conversation',
					textBody: bodyOf(i),
					processingStatus: status as 'sent',
					receivedAt: Date.now(),
					threadId,
				})
			);
		}
		return { threadId, ids };
	});
}

/** Run `handler` over an observed reader; the inbound documents read and bodies opened. */
async function counted<R>(t: T, run: (ctx: unknown) => Promise<R>) {
	let messagesRead = 0;
	opened.count = 0;
	const result = await t.run((ctx) =>
		run({
			...ctx,
			db: observingDb(ctx.db, {
				onRead(source, rows) {
					for (const row of rows) {
						const isInbound = source.startsWith('inboundMessages:') || 'processingStatus' in row;
						if (isInbound) messagesRead += 1;
					}
				},
			}),
		})
	);
	return { result, messagesRead, bodiesOpened: opened.count };
}

describe('opening a Team Inbox conversation', () => {
	it.each([10, 100, 1000])('%i messages: the whole history vs. one page', async (size) => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(t, size);
		const page = Math.min(size, THREAD_PAGE_SIZE);

		const legacy = await counted(t, (ctx) => readThread(ctx, { threadId }));
		expect(legacy.result.messages).toHaveLength(size);
		expect(legacy).toMatchObject({ messagesRead: size, bodiesOpened: size });

		// Answer mode: envelopes only. The page, plus the one waiting draft the
		// status index finds.
		const envelopes = await counted(t, (ctx) => readPage(ctx, { threadId }));
		expect(envelopes.result.messages.map((m) => m._id)).toEqual(ids.slice(-page));
		expect(envelopes.result.messages.every((m) => m.isBodyDeferred && !m.textBody)).toBe(true);
		expect(envelopes.result.head.waiting.map((m) => m._id)).toEqual([ids[size - 1]]);
		expect(envelopes).toMatchObject({ messagesRead: page + 1, bodiesOpened: 0 });

		// The thread page shows every loaded message open: one body per message of the page.
		const withBodies = await counted(t, (ctx) => readPage(ctx, { threadId, withBodies: true }));
		expect(withBodies.result.messages.at(-1)?.textBody).toBe(bodyOf(size - 1));
		expect(withBodies).toMatchObject({ messagesRead: page + 1, bodiesOpened: page + 1 });

		// Expanding the oldest message: one point read, one body.
		const expanded = await counted(t, (ctx) => readMessage(ctx, { messageId: ids[0]! }));
		expect(expanded.result.textBody).toBe(bodyOf(0));
		expect(expanded).toMatchObject({ messagesRead: 1, bodiesOpened: 1 });
	});

	it('walks the whole history through the cursor, each message once, in order', async () => {
		const t = convexTest(schema, modules);
		const { threadId, ids } = await seedThread(t, 1000);

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		for (;;) {
			const result: PageResult = (await counted(t, (ctx) => readPage(ctx, { threadId, cursor })))
				.result;
			seen.unshift(...result.messages.map((m) => m._id));
			pages += 1;
			if (result.isDone) break;
			cursor = result.cursor;
		}

		expect(seen).toEqual(ids);
		expect(pages).toBe(1000 / THREAD_PAGE_SIZE);
	});

	it('stops a page of large bodies at its byte budget, and the cursor carries on', async () => {
		const t = convexTest(schema, modules);
		const threadId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('conversationThreads', {
				subject: 'Newsletters',
				normalizedSubject: 'newsletters',
				contactIdentifier: 'dana@example.com',
				status: 'open',
				messageCount: 30,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			});
			for (let i = 0; i < 30; i++) {
				await ctx.db.insert('inboundMessages', {
					messageId: `<big${i}@example.com>`,
					from: 'dana@example.com',
					to: 'support@owlat.app',
					subject: 'Newsletters',
					textBody: `${i} ${'y'.repeat(250 * 1024)}`,
					processingStatus: 'sent',
					receivedAt: Date.now(),
					threadId: id,
				});
			}
			return id;
		});

		const first = await counted(t, (ctx) => readPage(ctx, { threadId }));
		expect(first.result.messages.length).toBeLessThan(THREAD_PAGE_SIZE);
		expect(first.result.isDone).toBe(false);

		let total = first.result.messages.length;
		let cursor: string | null = first.result.cursor;
		for (;;) {
			const next: PageResult = (await counted(t, (ctx) => readPage(ctx, { threadId, cursor })))
				.result;
			total += next.messages.length;
			if (next.isDone) break;
			cursor = next.cursor;
		}
		expect(total).toBe(30);
	});

	it('reads the takeover facts from the status index, wherever the message sits', async () => {
		const t = convexTest(schema, modules);
		// The oldest message is still being scanned, far behind the first page.
		const { threadId, ids } = await seedThread(t, 100, (i) =>
			i === 0 ? 'security_check' : 'sent'
		);

		const legacy = (await counted(t, (ctx) => readThread(ctx, { threadId }))).result as {
			takeOver: unknown;
		};
		const paged = await counted(t, (ctx) => readPage(ctx, { threadId }));

		expect(paged.result.head.takeOver).toEqual(legacy.takeOver);
		expect(paged.result.head.takeOver.messages.map((m) => m.messageId)).toEqual([ids[0]]);
		expect(paged.messagesRead).toBe(THREAD_PAGE_SIZE + 1);
	});
});
