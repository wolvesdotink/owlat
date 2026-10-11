/**
 * Item reactions (mail/interpret/reactions.ts, reactionRules.ts): the
 * lifecycle statements, remind, and the team verbs assign / claim, with the
 * reader rule of each thread kind, the revision bump, the activity row and
 * the list-row projection.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import betterAuthSchema from '../../../betterAuth/schema';
import { api, components, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { planReaction } from '../reactionRules';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' } as {
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
		getSingletonOrganizationId: vi.fn(async () => 'org-1'),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const betterAuthModules = import.meta.glob('../../../betterAuth/**/*.*s');
const SENT = Date.UTC(2026, 9, 7, 9, 0);

function harness(): Test {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

const asUser = (userId: string, role = 'owner') => {
	session.current = { userId, role, activeOrganizationId: 'org-1' };
};

/** An org member with a live profile and a BetterAuth membership row. */
async function seedMember(t: Test, userId: string, role: string): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('userProfiles', {
			authUserId: userId,
			email: `${userId}@owlat.test`,
			createdAt: now,
			updatedAt: now,
		});
	});
	await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'member', data: { organizationId: 'org-1', userId, role, createdAt: 1 } },
	} as never);
}

const forYou = reduceItem();
const theirs = reduceItem({
	assertion: 'Confirm the venue',
	display: { en: 'Jonas confirms the venue', de: 'Jonas bestätigt den Ort' },
	responsible: { email: 'jonas@example.com', isUs: false },
	facets: ['meeting'],
	consequences: [],
	due: undefined,
});

async function interpret(
	t: Test,
	source: { kind: 'mail'; id: Id<'mailMessages'> } | { kind: 'inbound'; id: Id<'inboundMessages'> },
	threadRef:
		| { kind: 'mail'; id: Id<'mailThreads'> }
		| { kind: 'team'; id: Id<'conversationThreads'> },
	overrides: Record<string, unknown> = {}
) {
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source,
		threadRef,
		mode: threadRef.kind === 'team' ? 'actions' : 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result:
			threadRef.kind === 'team'
				? reduceResult({ items: [forYou, theirs], latest: undefined, facts: undefined })
				: reduceResult({ items: [forYou, theirs] }),
		...overrides,
	});
}

async function itemsOf(t: Test, ref: { kind: 'mail' | 'team'; id: string }) {
	return t.run(async (ctx) => {
		const all = await ctx.db.query('threadItems').collect();
		return all
			.filter((i) =>
				ref.kind === 'mail' ? i.mailThreadId === ref.id : i.conversationThreadId === ref.id
			)
			.sort((a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : 1));
	});
}

async function mailSetup(t: Test, seed: Parameters<typeof seedMailThread>[1] = {}) {
	const { mailboxId, messageId, threadId } = await seedMailThread(t, seed);
	const ref = { kind: 'mail' as const, id: threadId };
	await interpret(t, { kind: 'mail', id: messageId }, ref);
	const items = await itemsOf(t, ref);
	const us = items.find((i) => i.responsibility === 'us')!;
	const them = items.find((i) => i.responsibility === 'them')!;
	return { mailboxId, messageId, threadId, ref, us, them };
}

async function teamSetup(t: Test, opts: { assignedTo?: string } = {}) {
	const { threadId, inboundId } = await seedTeamThread(t, opts);
	const ref = { kind: 'team' as const, id: threadId };
	// The run passes the thread assignee it loaded (load.ts) to the reducer.
	await interpret(
		t,
		{ kind: 'inbound', id: inboundId },
		ref,
		opts.assignedTo ? { threadAssigneeUserId: opts.assignedTo } : {}
	);
	const items = await itemsOf(t, ref);
	return { threadId, ref, us: items.find((i) => i.responsibility === 'us')! };
}

async function activityFor(t: Test, itemId: Id<'threadItems'>) {
	return t.run(async (ctx) =>
		(await ctx.db.query('threadActivity').collect())
			.filter((a) => a.itemId === itemId && a.actor.kind === 'user')
			.sort((a, b) => a.seq - b.seq)
	);
}

const get = (t: Test, id: Id<'threadItems'>) =>
	t.run(async (ctx) => (await ctx.db.get(id)) as Doc<'threadItems'>);

describe('lifecycle reactions on a Postbox thread', () => {
	it('marks done: asserted, corrected, revision bumped, activity and list row updated', async () => {
		const t = harness();
		const { us, threadId } = await mailSetup(t);
		expect((await t.run(async (ctx) => ctx.db.get(threadId)))?.briefTop?.forYou).toBe(1);

		const result = await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		expect(result).toEqual({ itemId: us._id, revision: 2 });
		const item = await get(t, us._id);
		expect(item).toMatchObject({
			status: 'done',
			completion: 'asserted',
			revision: 2,
			correction: { by: 'user-A', kind: 'markedDone' },
		});
		expect(item.updatedAt).toBeGreaterThanOrEqual(us.updatedAt);
		// The person set this status: a purge of a message never resets it.
		expect(item.statusSource).toMatchObject({ sourceKey: 'user:user-A' });
		expect(item.lastTransitionAt).toBe(item.statusSource?.at);

		const [row] = await activityFor(t, us._id);
		expect(row).toMatchObject({
			type: 'item_closed',
			actor: { kind: 'user', id: 'user-A' },
			provenance: 'asserted',
			visibility: 'substance',
			itemRevision: 2,
			delta: { statusFrom: 'open', statusTo: 'done', completion: 'asserted' },
		});
		expect(row!.idempotencyKey.endsWith(`|react:${us._id}:2`)).toBe(true);
		expect((await t.run(async (ctx) => ctx.db.get(threadId)))?.briefTop?.forYou).toBe(0);
	});

	it('undo reverses Mark done and clears the correction', async () => {
		const t = harness();
		const { us, threadId } = await mailSetup(t);
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id });
		const item = await get(t, us._id);
		expect(item.status).toBe('open');
		expect(item.completion).toBeUndefined();
		expect(item.correction).toBeUndefined();
		expect(item.revision).toBe(3);
		expect(item.statusSource).toMatchObject({ sourceKey: 'user:user-A' });
		expect((await activityFor(t, us._id)).map((a) => a.type)).toEqual([
			'item_closed',
			'item_reopened',
		]);
		expect((await t.run(async (ctx) => ctx.db.get(threadId)))?.briefTop?.forYou).toBe(1);
	});

	it('stops tracking, and undo brings the item back', async () => {
		const t = harness();
		const { us } = await mailSetup(t);
		await t.mutation(api.mail.interpret.reactions.untrack, { itemId: us._id });
		expect(await get(t, us._id)).toMatchObject({
			status: 'untracked',
			correction: { kind: 'untracked' },
		});
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id });
		expect((await get(t, us._id)).status).toBe('open');
	});

	it('Not a request untracks the item and logs the correction for the eval, without text', async () => {
		const t = harness();
		const { us, messageId } = await mailSetup(t);
		await t.mutation(api.mail.interpret.reactions.notARequest, { itemId: us._id });
		expect(await get(t, us._id)).toMatchObject({
			status: 'untracked',
			correction: { kind: 'notARequest', by: 'user-A' },
		});
		const logs = await t.run(async (ctx) => ctx.db.query('threadItemCorrections').collect());
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			threadKind: 'mail',
			itemId: us._id,
			itemRevision: 1,
			kind: 'notARequest',
			userId: 'user-A',
			intent: 'request',
			facets: ['file', 'signature'],
			responsibility: 'us',
			verify: 'passed',
			evidenceSources: [{ sourceKey: `mail:${messageId}`, contentRevision: 'rev-1' }],
		});
		expect(JSON.stringify(logs[0])).not.toContain('signed contract');
		expect((await activityFor(t, us._id))[0]?.type).toBe('item_corrected');
	});

	it('marks a them-item received, and refuses it on an item that is ours', async () => {
		const t = harness();
		const { us, them } = await mailSetup(t);
		await expect(
			t.mutation(api.mail.interpret.reactions.markReceived, { itemId: us._id })
		).rejects.toThrow(/someone else owes/);
		await t.mutation(api.mail.interpret.reactions.markReceived, { itemId: them._id });
		expect(await get(t, them._id)).toMatchObject({
			status: 'done',
			completion: 'asserted',
			correction: { kind: 'markedDone' },
		});
	});

	it('confirms a proposal and refuses a confirmed item', async () => {
		const t = harness();
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await interpret(t, { kind: 'mail', id: messageId }, ref, {
			result: reduceResult({ items: [reduceItem({ verify: 'proposal' })] }),
		});
		const [item] = await itemsOf(t, ref);
		expect((await t.run(async (ctx) => ctx.db.get(threadId)))?.briefTop?.forYou).toBe(0);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: item!._id });
		expect(await get(t, item!._id)).toMatchObject({
			verify: 'passed',
			status: 'open',
			correction: { kind: 'confirmed' },
		});
		expect((await activityFor(t, item!._id))[0]?.type).toBe('proposal_confirmed');
		expect((await t.run(async (ctx) => ctx.db.get(threadId)))?.briefTop?.forYou).toBe(1);
		await expect(
			t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: item!._id })
		).rejects.toThrow();
	});

	it('refuses illegal edges: done twice, undo with nothing to undo', async () => {
		const t = harness();
		const { us } = await mailSetup(t);
		await expect(t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id })).rejects.toThrow(
			/nothing to undo/
		);
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		await expect(
			t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id })
		).rejects.toThrow();
		expect((await get(t, us._id)).revision).toBe(2);
	});

	it('sets and clears a reminder without touching the lifecycle', async () => {
		const t = harness();
		const { us } = await mailSetup(t);
		const at = Date.now() + 86_400_000;
		await t.mutation(api.mail.interpret.reactions.remind, { itemId: us._id, remindAt: at });
		expect(await get(t, us._id)).toMatchObject({ remindAt: at, status: 'open', revision: 2 });
		expect((await get(t, us._id)).correction).toBeUndefined();
		const [row] = await activityFor(t, us._id);
		expect(row).toMatchObject({
			type: 'item_reminder_set',
			visibility: 'housekeeping',
			provenance: 'recorded',
		});
		await t.mutation(api.mail.interpret.reactions.remind, { itemId: us._id, remindAt: null });
		expect((await get(t, us._id)).remindAt).toBeUndefined();
		await expect(
			t.mutation(api.mail.interpret.reactions.remind, {
				itemId: us._id,
				remindAt: Date.now() + 5 * 365 * 86_400_000,
			})
		).rejects.toThrow();
	});

	it('refuses a caller who cannot read the mailbox and leaves the item alone', async () => {
		const t = harness();
		const { us } = await mailSetup(t, { userId: 'someone-else' });
		asUser('user-A', 'member');
		for (const reaction of ['markDone', 'untrack', 'notARequest', 'undo'] as const) {
			await expect(
				t.mutation(api.mail.interpret.reactions[reaction], { itemId: us._id })
			).rejects.toThrow();
		}
		await expect(
			t.mutation(api.mail.interpret.reactions.remind, { itemId: us._id, remindAt: null })
		).rejects.toThrow();
		expect(await get(t, us._id)).toMatchObject({ status: 'open', revision: 1 });
	});

	it('keeps the brief’s item counters in step (one write path with the reducer)', async () => {
		const t = harness();
		const { us, ref } = await mailSetup(t);
		const counts = () =>
			t.run(
				async (ctx) =>
					(
						await ctx.db
							.query('threadBriefs')
							.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
							.first()
					)?.itemCounts
			);
		const before = await counts();
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		expect(await counts()).toMatchObject({
			us: (before?.us ?? 0) - 1,
			closed: (before?.closed ?? 0) + 1,
		});
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id });
		expect(await counts()).toEqual(before);
	});

	it('keeps the person’s correction when the model later says otherwise', async () => {
		const t = harness();
		const { us, messageId, ref } = await mailSetup(t);
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		await interpret(t, { kind: 'mail', id: messageId }, ref, {
			contentRevision: 'rev-2',
			expectedRevision: 1,
			sourceAt: SENT + 1,
			result: reduceResult({
				items: [],
				transitions: [
					{
						itemId: us._id,
						to: 'open',
						evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'still' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		// The correction holds through the re-extraction (an ordered replay of
		// the thread re-applies it); how a conflict is flagged for review is the
		// reducer's (interpret lane, review F16).
		expect(await get(t, us._id)).toMatchObject({
			status: 'done',
			correction: { kind: 'markedDone' },
		});
	});
});

describe('Team Inbox items', () => {
	it('lets a shared-inbox reader react and refuses a plain member', async () => {
		const t = harness();
		const { us, threadId } = await teamSetup(t);
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		const [row] = await activityFor(t, us._id);
		expect(row).toMatchObject({ threadKind: 'team', conversationThreadId: threadId });
		asUser('user-B', 'member');
		await expect(
			t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id })
		).rejects.toThrow();
		expect((await get(t, us._id)).status).toBe('done');
	});

	it('claims atomically: the first claimer gets it, the second is refused', async () => {
		const t = harness();
		const { us } = await teamSetup(t);
		const claimed = await t.mutation(api.mail.interpret.reactions.claimItem, { itemId: us._id });
		expect(claimed.revision).toBe(2);
		const item = await get(t, us._id);
		expect(item).toMatchObject({ assigneeUserId: 'user-A', responsibility: 'us', status: 'open' });
		expect(item.completion).toBeUndefined();
		expect((await activityFor(t, us._id))[0]).toMatchObject({
			type: 'item_claimed',
			visibility: 'housekeeping',
			actor: { kind: 'user', id: 'user-A' },
		});
		// Claiming your own item again changes nothing.
		expect(await t.mutation(api.mail.interpret.reactions.claimItem, { itemId: us._id })).toEqual({
			itemId: us._id,
			revision: 2,
		});
		asUser('user-B');
		await expect(
			t.mutation(api.mail.interpret.reactions.claimItem, { itemId: us._id })
		).rejects.toThrow(/already took/);
		expect((await get(t, us._id)).assigneeUserId).toBe('user-A');
	});

	it('defaults items to the thread assignee (D4), which a claim does not override', async () => {
		const t = harness();
		const { us } = await teamSetup(t, { assignedTo: 'user-B' });
		expect(us.assigneeUserId).toBe('user-B');
		await expect(
			t.mutation(api.mail.interpret.reactions.claimItem, { itemId: us._id })
		).rejects.toThrow();
	});

	it('assigns to a teammate who can read the inbox, refuses one who cannot, and unassigns', async () => {
		const t = harness();
		const { us } = await teamSetup(t);
		await seedMember(t, 'user-B', 'admin');
		await seedMember(t, 'user-C', 'member');
		await t.mutation(api.mail.interpret.reactions.assignItem, {
			itemId: us._id,
			assigneeUserId: 'user-B',
		});
		expect(await get(t, us._id)).toMatchObject({ assigneeUserId: 'user-B', revision: 2 });
		const [row] = await activityFor(t, us._id);
		expect(row?.type).toBe('item_assigned');
		await expect(
			t.mutation(api.mail.interpret.reactions.assignItem, {
				itemId: us._id,
				assigneeUserId: 'user-C',
			})
		).rejects.toThrow(/cannot open/);
		await expect(
			t.mutation(api.mail.interpret.reactions.assignItem, {
				itemId: us._id,
				assigneeUserId: 'nobody',
			})
		).rejects.toThrow();
		await t.mutation(api.mail.interpret.reactions.assignItem, {
			itemId: us._id,
			assigneeUserId: null,
		});
		expect((await get(t, us._id)).assigneeUserId).toBeUndefined();
	});
});

describe('team verbs on Postbox threads', () => {
	it('refuses assign and claim on a personal thread', async () => {
		const t = harness();
		const { us } = await mailSetup(t);
		await expect(
			t.mutation(api.mail.interpret.reactions.claimItem, { itemId: us._id })
		).rejects.toThrow(/personal thread/);
		await expect(
			t.mutation(api.mail.interpret.reactions.assignItem, {
				itemId: us._id,
				assigneeUserId: 'user-A',
			})
		).rejects.toThrow(/personal thread/);
	});

	it('assigns a shared-mailbox item to a mailbox member', async () => {
		const t = harness();
		const { messageId, threadId, mailboxId } = await seedMailThread(t, { scope: 'shared' });
		const ref = { kind: 'mail' as const, id: threadId };
		await interpret(t, { kind: 'mail', id: messageId }, ref, {
			mode: 'actions',
			result: reduceResult({ items: [forYou], latest: undefined, facts: undefined }),
		});
		const [item] = await itemsOf(t, ref);
		await seedMember(t, 'user-M', 'member');
		await seedMember(t, 'user-X', 'member');
		await t.run(async (ctx) => {
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId: 'user-M',
				role: 'member',
				addedBy: 'user-A',
				createdAt: 1,
			});
		});
		await t.mutation(api.mail.interpret.reactions.assignItem, {
			itemId: item!._id,
			assigneeUserId: 'user-M',
		});
		expect((await get(t, item!._id)).assigneeUserId).toBe('user-M');
		await expect(
			t.mutation(api.mail.interpret.reactions.assignItem, {
				itemId: item!._id,
				assigneeUserId: 'user-X',
			})
		).rejects.toThrow(/cannot open/);
	});
});

describe('planReaction', () => {
	const actor = { userId: 'u', now: 5 };
	const open = {
		status: 'open' as const,
		verify: 'passed' as const,
		responsibility: 'us' as const,
		evidence: [] as Doc<'threadItems'>['evidence'],
	};
	const ev = (segmentId: string) => ({
		source: { kind: 'mail' as const, id: 'm1' as Id<'mailMessages'> },
		segmentId,
		start: 0,
		end: 4,
		contentRevision: 'r1',
	});

	it('applies a held update to a tracked item, clears it and records the confirmation', () => {
		const plan = planReaction(
			{
				...open,
				evidence: [ev('s0')],
				pendingUpdate: {
					evidence: [ev('s0'), ev('s3')],
					due: { phrase: 'by Friday', isAmbiguous: false, at: 9 },
				},
			},
			'confirmProposal',
			actor
		);
		expect(plan).toMatchObject({
			ok: true,
			patch: { evidence: [ev('s0'), ev('s3')], due: { phrase: 'by Friday', at: 9 } },
			clears: ['pendingUpdate'],
			activity: 'proposal_confirmed',
		});
		// The correction is what an ordered replay preserves.
		expect(plan).toMatchObject({ patch: { correction: { kind: 'confirmed', by: 'u' } } });
	});

	it('confirms a proposal item together with its held update', () => {
		const plan = planReaction(
			{
				...open,
				verify: 'proposal',
				pendingUpdate: { evidence: [], amount: { value: 40, currency: 'EUR' } },
			},
			'confirmProposal',
			actor
		);
		expect(plan).toMatchObject({
			ok: true,
			patch: { verify: 'passed', correction: { kind: 'confirmed' }, amount: { value: 40 } },
			clears: ['pendingUpdate'],
		});
	});

	it('refuses to confirm a tracked item with nothing held', () => {
		expect(planReaction(open, 'confirmProposal', actor).ok).toBe(false);
	});

	it('reopens an item the model closed and locks it with a reopened correction', () => {
		const plan = planReaction({ ...open, status: 'done', completion: 'reported' }, 'undo', actor);
		expect(plan).toMatchObject({
			ok: true,
			patch: { status: 'open', correction: { kind: 'reopened', by: 'u', at: 5 } },
			clears: ['completion'],
			activity: 'item_reopened',
		});
	});

	it('undoes a confirmation back to a proposal', () => {
		const plan = planReaction(
			{ ...open, correction: { by: 'u', at: 1, kind: 'confirmed' } },
			'undo',
			actor
		);
		expect(plan).toMatchObject({ ok: true, patch: { verify: 'proposal' }, clears: ['correction'] });
	});

	it('refuses to move a replaced item', () => {
		for (const reaction of ['markDone', 'untrack', 'notARequest', 'undo'] as const) {
			expect(planReaction({ ...open, status: 'superseded' }, reaction, actor).ok).toBe(false);
		}
	});

	it('only changes the correction of an item already untracked', () => {
		expect(
			planReaction(
				{ ...open, status: 'untracked', correction: { by: 'u', at: 1, kind: 'untracked' } },
				'notARequest',
				actor
			)
		).toMatchObject({ ok: true, patch: { correction: { kind: 'notARequest' } } });
	});
});

describe('undoing a confirmation (review round 1, F10)', () => {
	const EUR = (value: number) => ({ value, currency: 'EUR' });

	/** A tracked €100 item whose next message claims €1,000, unverified: held as a pending update. */
	async function heldThousand(t: Test) {
		const { us, messageId } = await mailSetup(t);
		const quote = {
			source: { kind: 'mail' as const, id: messageId },
			segmentId: 's9',
			start: 0,
			end: 9,
			contentRevision: 'rev-2',
		};
		await t.run(async (ctx) => {
			await ctx.db.patch(us._id, {
				amount: EUR(100),
				pendingUpdate: { evidence: [quote], amount: EUR(1000) },
			});
		});
		return { us: await get(t, us._id), quote };
	}

	it('puts a confirmed held change back exactly: €100, verified, €1,000 pending again', async () => {
		const t = harness();
		const { us } = await heldThousand(t);
		const before = us.evidence.length;

		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: us._id });
		const confirmed = await get(t, us._id);
		expect(confirmed).toMatchObject({
			amount: EUR(1000),
			verify: 'passed',
			correction: { kind: 'confirmed' },
			confirmedFrom: { kind: 'heldChange', verify: 'passed', amount: EUR(100) },
		});
		expect(confirmed.pendingUpdate).toBeUndefined();
		expect(confirmed.evidence).toHaveLength(before + 1);

		await t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id });
		const undone = await get(t, us._id);
		expect(undone).toMatchObject({
			amount: EUR(100),
			verify: 'passed',
			pendingUpdate: { amount: EUR(1000) },
			status: 'open',
		});
		expect(undone.pendingUpdate?.evidence).toHaveLength(1);
		expect(undone.evidence).toHaveLength(before);
		expect(undone.correction).toBeUndefined();
		expect(undone.confirmedFrom).toBeUndefined();
		expect((await activityFor(t, us._id)).map((a) => a.type)).toEqual([
			'proposal_confirmed',
			'item_corrected',
		]);
	});

	it('puts a confirmed proposal back to "Check this" with its values', async () => {
		const t = harness();
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await interpret(t, { kind: 'mail', id: messageId }, ref, {
			result: reduceResult({ items: [reduceItem({ verify: 'proposal', amount: EUR(100) })] }),
		});
		const [item] = await itemsOf(t, ref);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: item!._id });
		expect((await get(t, item!._id)).confirmedFrom?.kind).toBe('proposal');
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: item!._id });
		const undone = await get(t, item!._id);
		expect(undone).toMatchObject({ verify: 'proposal', amount: EUR(100) });
		expect(undone.correction).toBeUndefined();
		expect(undone.confirmedFrom).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get(threadId)))?.briefTop?.forYou).toBe(0);
	});

	it('keeps the confirmation when a later Mark done is undone', async () => {
		const t = harness();
		const { us } = await heldThousand(t);
		await t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: us._id });
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: us._id });
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id });
		const item = await get(t, us._id);
		expect(item).toMatchObject({
			status: 'open',
			amount: EUR(1000),
			correction: { kind: 'confirmed' },
			confirmedFrom: { kind: 'heldChange', amount: EUR(100) },
		});
		// …and the confirmation itself can still be undone afterwards.
		await t.mutation(api.mail.interpret.reactions.undo, { itemId: us._id });
		expect(await get(t, us._id)).toMatchObject({
			amount: EUR(100),
			pendingUpdate: { amount: EUR(1000) },
		});
	});
});
