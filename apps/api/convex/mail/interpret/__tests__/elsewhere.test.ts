/**
 * "With this contact elsewhere" (`elsewhere.list`): open items with this
 * thread's counterparty in OTHER threads, each passing its own thread's
 * reader rule (mailbox access, the Team Inbox reader role), never the thread
 * itself, never an unconfirmed proposal, never a closed item.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';
import { counterpartiesOf, nameOf, PERSON_SCAN } from '../elsewhere';
import type { ReduceItem } from '../reduceInput';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' } as {
		userId: string;
		role: string;
		activeOrganizationId: string;
	} | null,
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => session.current !== null),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);

const fromJonas = (text: string, extra: Partial<ReduceItem> = {}) =>
	reduceItem({
		assertion: text,
		display: { en: text, de: `${text} (de)` },
		requester: { email: 'jonas@example.com', name: 'Jonas', isUs: false },
		...extra,
	});

async function interpret(
	t: Test,
	at:
		| { kind: 'mail'; messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }
		| { kind: 'team'; inboundId: Id<'inboundMessages'>; threadId: Id<'conversationThreads'> },
	items: ReduceItem[]
) {
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		...(at.kind === 'mail'
			? {
					source: { kind: 'mail' as const, id: at.messageId },
					threadRef: { kind: 'mail' as const, id: at.threadId },
					mode: 'brief' as const,
				}
			: {
					source: { kind: 'inbound' as const, id: at.inboundId },
					threadRef: { kind: 'team' as const, id: at.threadId },
					mode: 'actions' as const,
				}),
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({
			items,
			...(at.kind === 'team' ? { latest: undefined, facts: [] } : {}),
		}),
	});
}

async function mailThreadIn(t: Test, mailboxId: Id<'mailboxes'>, subject: string) {
	const messageId = await seedMessage(t, mailboxId, {
		subject,
		fromAddress: 'jonas@example.com',
		receivedAt: SENT,
	});
	const threadId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
	return { kind: 'mail' as const, messageId, threadId };
}

describe('counterpartiesOf / nameOf', () => {
	it('ranks open items double and names a counterparty from the items', () => {
		const rows = [
			{ counterpartyKey: 'ana@example.com', status: 'done' as const },
			{ counterpartyKey: 'ana@example.com', status: 'done' as const },
			{ counterpartyKey: 'jonas@example.com', status: 'open' as const },
			{ counterpartyKey: 'jonas@example.com', status: 'open' as const },
			{ counterpartyKey: undefined, status: 'open' as const },
		];
		expect(counterpartiesOf(rows)).toEqual(['jonas@example.com', 'ana@example.com']);
		expect(
			nameOf('jonas@example.com', [
				{
					requester: { email: 'Jonas@Example.com', name: 'Jonas', isUs: false },
					responsible: { isUs: true },
				},
			])
		).toBe('Jonas');
	});
});

describe('elsewhere.list', () => {
	async function seedWorld(t: Test) {
		const here = await seedMailThread(t);
		await interpret(t, { kind: 'mail', ...here }, [fromJonas('Send the signed contract')]);
		// Elsewhere in the viewer's own mailbox.
		const other = await mailThreadIn(t, here.mailboxId, 'Framework agreement');
		await interpret(t, other, [
			fromJonas('Jonas sends the signed NDA', {
				requester: { isUs: true },
				responsible: { email: 'jonas@example.com', name: 'Jonas', isUs: false },
			}),
			fromJonas('Confirm the venue', { verify: 'proposal' }),
		]);
		// Someone else's mailbox.
		const mailboxB = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		await seedFolder(t, mailboxB, 'inbox');
		const elsewhereB = await mailThreadIn(t, mailboxB, 'B private');
		await interpret(t, elsewhereB, [fromJonas('Review B’s draft')]);
		// The Team Inbox.
		const team = await seedTeamThread(t);
		await interpret(t, { kind: 'team', ...team }, [fromJonas('Refund order 42')]);
		return { here, other };
	}

	it('lists the viewer’s readable open items with the same person, not this thread’s', async () => {
		const t = convexTest(schema, modules);
		const { here, other } = await seedWorld(t);
		const out = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en-GB',
		});
		expect(out).toEqual({
			groups: [
				{
					counterpartyKey: 'jonas@example.com',
					name: 'Jonas',
					isMore: false,
					items: [
						expect.objectContaining({
							threadRef: { kind: 'mail', id: other.threadId },
							subject: 'Framework agreement',
							text: 'Jonas sends the signed NDA',
							responsibility: 'them',
						}),
					],
				},
			],
		});
	});

	it('adds the Team Inbox and every mailbox for an admin, still never this thread', async () => {
		const t = convexTest(schema, modules);
		const { here } = await seedWorld(t);
		session.current = { userId: 'user-A', role: 'admin', activeOrganizationId: 'org-1' };
		const out = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'de',
		});
		const texts = out!.groups[0]!.items.map((i) => i.text).sort();
		expect(texts).toEqual([
			'Jonas sends the signed NDA (de)',
			'Refund order 42 (de)',
			'Review B’s draft (de)',
		]);
	});

	it('answers null to a reader who cannot open this thread', async () => {
		const t = convexTest(schema, modules);
		const { here } = await seedWorld(t);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		expect(
			await t.query(api.mail.interpret.elsewhere.list, {
				threadRef: { kind: 'mail', id: here.threadId },
				locale: 'en',
			})
		).toBeNull();
	});

	it('reads past rows the viewer cannot open and hands back a cursor when the scan stops (F7)', async () => {
		const t = convexTest(schema, modules);
		const { here, other } = await seedWorld(t);
		// More newer rows in someone else's mailbox than one scan reads.
		await t.run(async (ctx) => {
			const hidden = await ctx.db
				.query('threadItems')
				.filter((q) => q.neq(q.field('mailThreadId'), here.threadId))
				.collect();
			const template = hidden.find(
				(i) => i.counterpartyKey === 'jonas@example.com' && i.mailboxId !== undefined
			)!;
			const visible = hidden.find(
				(i) => i.mailThreadId === other.threadId && i.verify !== 'proposal'
			)!;
			const { _id: _a, _creationTime: _b, ...fields } = template;
			const theirs = hidden.find((i) => i.mailboxId !== visible.mailboxId && i.mailThreadId)!;
			for (let i = 0; i < PERSON_SCAN + 5; i++) {
				await ctx.db.insert('threadItems', {
					...fields,
					mailThreadId: theirs.mailThreadId,
					mailboxId: theirs.mailboxId,
					updatedAt: visible.updatedAt + 1000 + i,
				});
			}
		});
		const first = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
		});
		const group = first!.groups[0]!;
		expect(group.items).toEqual([]);
		expect(group.continueCursor).toBeDefined();
		const next = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
			more: { counterpartyKey: 'jonas@example.com', cursor: group.continueCursor! },
		});
		expect(next!.groups[0]!.items.map((i) => i.text)).toEqual(['Jonas sends the signed NDA']);
		expect(next!.groups[0]!.continueCursor).toBeUndefined();
	});

	it('refuses a Team Inbox thread while the Team Inbox is off (F8)', async () => {
		const t = convexTest(schema, modules);
		await seedWorld(t);
		const team = await t.run((ctx) => ctx.db.query('conversationThreads').first());
		session.current = { userId: 'user-A', role: 'admin', activeOrganizationId: 'org-1' };
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, {
				featureFlags: { ...settings!.featureFlags, inbox: false },
			});
		});
		expect(
			await t.query(api.mail.interpret.elsewhere.list, {
				threadRef: { kind: 'team', id: team!._id },
				locale: 'en',
			})
		).toBeNull();
	});
});
