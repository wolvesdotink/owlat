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
import { counterpartiesOf, nameOf, ROWS_PER_PERSON, scopeItems } from '../elsewhere';
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
		// The Team Inbox's organization (the instance's one).
		getSingletonOrganizationId: vi.fn(async () => 'org-1'),
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
					isPartial: false,
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

	it('adds the Team Inbox for an admin, never a teammate’s private mailbox, never this thread', async () => {
		const t = convexTest(schema, modules);
		const { here } = await seedWorld(t);
		session.current = { userId: 'user-A', role: 'admin', activeOrganizationId: 'org-1' };
		const out = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'de',
		});
		const texts = out!.groups[0]!.items.map((i) => i.text).sort();
		expect(texts).toEqual(['Jonas sends the signed NDA (de)', 'Refund order 42 (de)']);
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

	it('shows nothing at all when every match is in someone else’s mail (round 2 F3)', async () => {
		const t = convexTest(schema, modules);
		const here = await seedMailThread(t);
		await interpret(t, { kind: 'mail', ...here }, [fromJonas('Send the signed contract')]);
		const mailboxB = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		await seedFolder(t, mailboxB, 'inbox');
		for (let i = 0; i < 12; i++) {
			const theirs = await mailThreadIn(t, mailboxB, `B private ${i}`);
			await interpret(t, theirs, [fromJonas(`Private ${i}`)]);
		}
		const team = await seedTeamThread(t);
		await interpret(t, { kind: 'team', ...team }, [fromJonas('Refund order 42')]);
		const out = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
			limit: 25,
		});
		// No group, no "more", no position: nothing about the hidden rows.
		expect(out).toEqual({ groups: [] });
	});

	it('shows more of the same person on request, up to the bound (round 2 F4)', async () => {
		const t = convexTest(schema, modules);
		const here = await seedMailThread(t);
		await interpret(t, { kind: 'mail', ...here }, [fromJonas('Send the signed contract')]);
		for (let i = 0; i < 7; i++) {
			const other = await mailThreadIn(t, here.mailboxId, `Other ${i}`);
			await interpret(t, other, [fromJonas(`Open item ${i}`)]);
		}
		const first = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
		});
		expect(first!.groups[0]).toMatchObject({ isMore: true });
		expect(first!.groups[0]!.items).toHaveLength(5);
		const more = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
			limit: 25,
		});
		expect(more!.groups[0]).toMatchObject({ isMore: false });
		expect(more!.groups[0]!.items).toHaveLength(7);
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

	it('never reads another organization’s mailbox the viewer owns (round 3 F2)', async () => {
		const t = convexTest(schema, modules);
		const { here } = await seedWorld(t);
		const elsewhereOrg = await seedMailbox(t, {
			userId: 'user-A',
			organizationId: 'org-2',
			address: 'a@other.test',
		});
		await seedFolder(t, elsewhereOrg, 'inbox');
		const foreign = await mailThreadIn(t, elsewhereOrg, 'Other org');
		await interpret(t, foreign, [fromJonas('Other org secret')]);
		const out = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
			limit: 25,
		});
		const texts = out!.groups.flatMap((g) => g.items.map((i) => i.text));
		expect(texts).not.toContain('Other org secret');
		expect(texts).toEqual(['Jonas sends the signed NDA']);
	});

	it('bounds the rows it reads and says when it stopped short (round 3 F3)', async () => {
		const t = convexTest(schema, modules);
		const { here, other } = await seedWorld(t);
		await t.run(async (ctx) => {
			const visible = (await ctx.db
				.query('threadItems')
				.filter((q) => q.eq(q.field('mailThreadId'), other.threadId))
				.collect())!.find((i) => i.verify !== 'proposal')!;
			const { _id: _a, _creationTime: _b, ...fields } = visible;
			// Newer unconfirmed proposals in the viewer's own mailbox, past the budget.
			for (let i = 0; i < ROWS_PER_PERSON + 5; i++) {
				await ctx.db.insert('threadItems', {
					...fields,
					verify: 'proposal',
					updatedAt: visible.updatedAt + 1000 + i,
				});
			}
		});
		const out = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
		});
		// Nothing listable was reached: no group (the proposals are not listable).
		expect(out).toEqual({ groups: [] });
		// With a listable item inside the budget, the group says it is partial.
		await t.run(async (ctx) => {
			const extra = (await ctx.db
				.query('threadItems')
				.filter((q) => q.eq(q.field('mailThreadId'), other.threadId))
				.collect())!.find((i) => i.verify !== 'proposal')!;
			await ctx.db.patch(extra._id, { updatedAt: Date.now() * 2 });
		});
		const again = await t.query(api.mail.interpret.elsewhere.list, {
			threadRef: { kind: 'mail', id: here.threadId },
			locale: 'en',
		});
		expect(again!.groups[0]).toMatchObject({ isPartial: true, isMore: false });
		expect(again!.groups[0]!.items.map((i) => i.text)).toEqual(['Jonas sends the signed NDA']);
	});

	it('never reads more rows than the budget (round 4 F4)', async () => {
		const t = convexTest(schema, modules);
		const { here, other } = await seedWorld(t);
		await t.run(async (ctx) => {
			const visible = (await ctx.db
				.query('threadItems')
				.filter((q) => q.eq(q.field('mailThreadId'), other.threadId))
				.collect())!.find((i) => i.verify !== 'proposal')!;
			const { _id: _a, _creationTime: _b, ...fields } = visible;
			for (let i = 0; i < ROWS_PER_PERSON + 30; i++) {
				await ctx.db.insert('threadItems', {
					...fields,
					verify: 'proposal',
					updatedAt: visible.updatedAt + 1000 + i,
				});
			}
		});
		await t.run(async (ctx) => {
			let read = 0;
			const wrap = <T extends object>(target: T): T =>
				new Proxy(target, {
					get(obj, prop, receiver) {
						const value = Reflect.get(obj, prop, receiver) as unknown;
						if (typeof value !== 'function') return value;
						if (prop === 'take') {
							return async (n: number) => {
								const rows =
									(await (value as (n: number) => Promise<unknown[]>).call(obj, n)) ?? [];
								read += rows.length;
								return rows;
							};
						}
						return (...args: unknown[]) => {
							const out = (value as (...a: unknown[]) => unknown).apply(obj, args);
							return out && typeof out === 'object' && 'take' in out ? wrap(out) : out;
						};
					},
				});
			const counting = { ...ctx, db: wrap(ctx.db) } as typeof ctx;
			const budget = { rows: ROWS_PER_PERSON };
			const result = await scopeItems(
				counting,
				'jonas@example.com',
				{ kind: 'mailbox', mailboxId: here.mailboxId },
				{ kind: 'mail', id: here.threadId },
				6,
				budget
			);
			expect(read).toBe(ROWS_PER_PERSON);
			expect(budget.rows).toBe(0);
			expect(result.isCut).toBe(true);
		});
	});
});
