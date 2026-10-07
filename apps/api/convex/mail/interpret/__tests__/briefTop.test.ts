/**
 * The thread brief folded down for list rows (`mailThreads.briefTop`) and the
 * Workbench "To do, no reply needed" band:
 *   - the fold counts tracked items (no proposals, no closed ones), picks the
 *     top item by compareForYou, for-you before waiting;
 *   - refreshBriefTop writes it from the thread's open items, keeps the stored
 *     latest line unless given a new one, and never writes one in actions mode;
 *   - list rows and Answer queue rows carry it unsealed;
 *   - the band lists threads with open for-you items that need no reply.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { deriveBriefTop, refreshBriefTop, type BriefTopItem } from '../briefTop';
import { groupToDoItems } from '../todo';

const SESSION = { userId: 'test-user', role: 'owner', activeOrganizationId: 'test-org' };
const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
	requireOrgMember: vi.fn(),
}));
vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireOrgMember: sessionMocks.requireOrgMember,
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(SESSION);
	sessionMocks.requireOrgMember.mockResolvedValue(SESSION);
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 7, 9);

function item(over: Partial<BriefTopItem> & { _id: string }): BriefTopItem {
	return {
		responsibility: 'us',
		status: 'open',
		verify: 'passed',
		facets: [],
		askedAt: T0,
		display: { en: `${over._id} en`, de: `${over._id} de` },
		...over,
		_id: over._id as Id<'threadItems'>,
	};
}

describe('deriveBriefTop', () => {
	it('counts tracked items and picks the soonest for-you item', () => {
		const fold = deriveBriefTop([
			item({ _id: 'a', facets: ['meeting'] }),
			item({ _id: 'b', due: { phrase: 'Fri', at: T0 + 2 * DAY, isAmbiguous: false } }),
			item({
				_id: 'c',
				responsibility: 'them',
				due: { phrase: 'Mon', at: T0 + DAY, isAmbiguous: false },
			}),
			item({ _id: 'd', verify: 'proposal' }),
			item({ _id: 'e', status: 'done' }),
			item({ _id: 'f', responsibility: 'unclear' }),
		]);
		expect(fold.forYou).toBe(3);
		expect(fold.waiting).toBe(1);
		expect(fold.top).toEqual({
			itemId: 'b',
			responsibility: 'us',
			text: { en: 'b en', de: 'b de' },
			dueAt: T0 + 2 * DAY,
		});
	});

	it('falls back to the first waiting item, and to nothing', () => {
		expect(deriveBriefTop([item({ _id: 'w', responsibility: 'them' })]).top?.itemId).toBe('w');
		expect(deriveBriefTop([])).toEqual({ forYou: 0, waiting: 0 });
	});
});

describe('groupToDoItems', () => {
	it('keeps one row per thread and skips proposals', () => {
		const rows = groupToDoItems([
			{ _id: 'i1', mailThreadId: 't1', verify: 'passed' },
			{ _id: 'i2', mailThreadId: 't1', verify: 'passed' },
			{ _id: 'i3', mailThreadId: 't2', verify: 'proposal' },
		] as unknown as Doc<'threadItems'>[]);
		expect(rows.map((r) => [r.threadId, r.first._id, r.count])).toEqual([['t1', 'i1', 2]]);
	});
});

type T = ReturnType<typeof convexTest>;

async function seedInterpreted(
	t: T,
	mode: 'brief' | 'actions' = 'brief'
): Promise<{ mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'> }> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'Invoice 2026-10',
		fromAddress: 'billing@example.com',
		fromName: 'Hetzner Online',
	});
	const threadId = await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		const id = message!.threadId;
		await ctx.db.patch(id, { latestMessageId: messageId });
		await ctx.db.insert('threadBriefs', {
			threadKind: 'mail',
			mailThreadId: id,
			mode,
			sourceRevision: 1,
			interpretationRevision: 3,
			lastActivitySeq: 0,
			completeness: 'complete',
			deletionEpoch: 0,
			updatedAt: T0,
		});
		const party = { isUs: false, email: 'billing@example.com' };
		await ctx.db.insert('threadItems', {
			threadKind: 'mail',
			mailThreadId: id,
			mailboxId,
			revision: 1,
			intent: 'request',
			facets: ['payment'],
			assertion: 'Pay the invoice',
			display: { en: 'Pay €38.08', de: 'Zahle 38,08 €' },
			requester: party,
			responsible: { isUs: true },
			responsibility: 'us',
			status: 'open',
			disposition: 'unanswered',
			due: { phrase: 'by 21 Oct', at: T0 + 14 * DAY, isAmbiguous: false },
			evidence: [],
			verify: 'passed',
			askedAt: T0,
			createdAt: T0,
			updatedAt: T0,
		});
		return id;
	});
	return { mailboxId, threadId };
}

describe('refreshBriefTop and the list reads', () => {
	it('projects the top item onto list rows, keeping the latest line until replaced', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedInterpreted(t);
		await t.run((ctx) =>
			refreshBriefTop(ctx, threadId, { latest: { en: 'Invoice is out.', de: 'Rechnung ist da.' } })
		);
		// A reaction refresh passes no latest: the stored one stays.
		await t.run((ctx) => refreshBriefTop(ctx, threadId));

		const result = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
			limit: 10,
		});
		expect(result.messages[0]!.briefTop).toEqual({
			mode: 'brief',
			forYou: 1,
			waiting: 0,
			top: {
				itemId: expect.any(String),
				responsibility: 'us',
				text: { en: 'Pay €38.08', de: 'Zahle 38,08 €' },
				dueAt: T0 + 14 * DAY,
			},
			latest: { en: 'Invoice is out.', de: 'Rechnung ist da.' },
			isReplyNeeded: false,
		});
		const stored = await t.run((ctx) => ctx.db.get(threadId));
		expect(stored!.briefTop!.revision).toBe(3);
	});

	it('never stores a latest line for a shared (actions mode) thread', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedInterpreted(t, 'actions');
		await t.run((ctx) => refreshBriefTop(ctx, threadId, { latest: { en: 'x', de: 'y' } }));
		const stored = await t.run((ctx) => ctx.db.get(threadId));
		expect(stored!.briefTop!.mode).toBe('actions');
		expect(stored!.briefTop!.latest).toBeUndefined();
	});
});

describe('listNoReplyToDo', () => {
	it('lists open for-you items of threads that need no reply', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['postbox']);
		const { mailboxId, threadId } = await seedInterpreted(t);
		const rows = await t.query(api.mail.interpret.todo.listNoReplyToDo, { mailboxId });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			threadId,
			text: { en: 'Pay €38.08', de: 'Zahle 38,08 €' },
			dueAt: T0 + 14 * DAY,
			count: 1,
			fromName: 'Hetzner Online',
			subject: 'Invoice 2026-10',
		});
	});

	it('leaves out a thread the Answer queue already shows', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['postbox']);
		const { mailboxId, threadId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			await ctx.db.patch(threadId, {
				needsReply: {
					messageId: thread!.latestMessageId!,
					source: 'llm',
					urgency: 'normal',
					detectedAt: T0,
				},
			});
		});
		expect(await t.query(api.mail.interpret.todo.listNoReplyToDo, { mailboxId })).toEqual([]);
	});
});
