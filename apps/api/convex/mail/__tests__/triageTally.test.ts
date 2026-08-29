/**
 * Suggest rules from observed behaviour (idea 27).
 *
 * The properties worth pinning, in the order they matter:
 *   - nothing is ever auto-applied: the tally produces an OFFER, and only an
 *     explicit accept writes a filter;
 *   - the gate is recurrence, not volume — one bulk sweep cannot manufacture a
 *     rule, however many messages it covered;
 *   - a dismissal is final for that sender+verb, and an undo removes the rule it
 *     created without re-offering it;
 *   - the read reveals nothing to someone who cannot read the mailbox.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import {
	DOMINANCE_RATIO,
	MIN_OCCURRENCES,
	MIN_SESSIONS,
	triageSuggestionFor,
} from '../triageTally';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

describe('triageSuggestionFor', () => {
	it('offers nothing below the occurrence floor', () => {
		expect(
			triageSuggestionFor([{ verb: 'archive', count: MIN_OCCURRENCES - 1, sessions: MIN_SESSIONS }])
		).toBeNull();
	});

	it('offers nothing when one bulk sweep produced every occurrence', () => {
		// 40 messages, one action. Volume is not a habit — this is the recurrence
		// gate, and it is the whole reason a backlog clear-out cannot write a rule.
		expect(triageSuggestionFor([{ verb: 'archive', count: 40, sessions: 1 }])).toBeNull();
	});

	it('offers the dominant verb once both gates clear', () => {
		expect(
			triageSuggestionFor([{ verb: 'archive', count: MIN_OCCURRENCES, sessions: MIN_SESSIONS }])
		).toEqual({ verb: 'archive', count: MIN_OCCURRENCES, total: MIN_OCCURRENCES });
	});

	it('offers nothing when no verb dominates', () => {
		// The user does different things with this sender's mail; a rule would be
		// wrong for some of it.
		const split = Math.ceil((MIN_OCCURRENCES * (1 - DOMINANCE_RATIO)) / DOMINANCE_RATIO) + 2;
		expect(
			triageSuggestionFor([
				{ verb: 'archive', count: MIN_OCCURRENCES, sessions: MIN_SESSIONS },
				{ verb: 'trash', count: split, sessions: MIN_SESSIONS },
			])
		).toBeNull();
	});

	it('never promotes a second verb on the evidence of a declined one', () => {
		expect(
			triageSuggestionFor([
				{ verb: 'archive', count: 20, sessions: 5, dismissedAt: 1 },
				{ verb: 'trash', count: MIN_OCCURRENCES, sessions: MIN_SESSIONS },
			])
		).toBeNull();
	});

	it('stops offering a verb the user already accepted', () => {
		expect(
			triageSuggestionFor([{ verb: 'archive', count: 20, sessions: 5, actedFilterId: 'filter-1' }])
		).toBeNull();
	});
});

describe('recording from the triage mutations', () => {
	async function inbox(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		await seedFolder(t, mailboxId, 'archive');
		await seedFolder(t, mailboxId, 'trash');
		return mailboxId;
	}

	async function tallies(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
		return t.run(async (ctx) =>
			ctx.db
				.query('mailTriageTallies')
				.withIndex('by_mailbox_and_sender', (q) => q.eq('mailboxId', mailboxId))
				.collect()
		);
	}

	it('counts messages and sessions separately', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await inbox(t);
		const a = await seedMessage(t, mailboxId, { subject: 'a', fromAddress: 'news@x.example' });
		const b = await seedMessage(t, mailboxId, { subject: 'b', fromAddress: 'news@x.example' });
		const c = await seedMessage(t, mailboxId, { subject: 'c', fromAddress: 'news@x.example' });

		// One call over two messages, then a second call over one.
		await t.mutation(api.mail.messageActions.archive, { messageIds: [a, b] });
		await t.mutation(api.mail.messageActions.archive, { messageIds: [c] });

		const rows = await tallies(t, mailboxId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			senderAddress: 'news@x.example',
			verb: 'archive',
			count: 3,
			sessions: 2,
		});
	});

	it('keeps a verb per sender rather than one row per message', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await inbox(t);
		const a = await seedMessage(t, mailboxId, { subject: 'a', fromAddress: 'news@x.example' });
		const b = await seedMessage(t, mailboxId, { subject: 'b', fromAddress: 'other@y.example' });
		await t.mutation(api.mail.messageActions.trash, { messageIds: [a, b] });

		const rows = await tallies(t, mailboxId);
		expect(rows.map((r) => r.senderAddress).sort()).toEqual(['news@x.example', 'other@y.example']);
		expect(rows.every((r) => r.verb === 'trash' && r.count === 1 && r.sessions === 1)).toBe(true);
	});
});

describe('mail.triageTally suggestion lifecycle', () => {
	async function seedEarnedSuggestion(
		t: TestConvex<typeof schema>
	): Promise<{ mailboxId: Id<'mailboxes'>; messageId: Id<'mailMessages'> }> {
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		await seedFolder(t, mailboxId, 'archive');
		const messageId = await seedMessage(t, mailboxId, {
			subject: 'latest',
			fromAddress: 'news@x.example',
		});
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('mailTriageTallies', {
				mailboxId,
				senderAddress: 'news@x.example',
				verb: 'archive',
				count: MIN_OCCURRENCES + 3,
				sessions: MIN_SESSIONS + 1,
				firstAt: now - 1000,
				lastAt: now,
				createdAt: now,
				updatedAt: now,
			});
		});
		return { mailboxId, messageId };
	}

	it('surfaces the earned suggestion on the sender of the open message', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedEarnedSuggestion(t);
		const result = await t.query(api.mail.triageTally.forMessage, { messageId });
		expect(result?.suggestion).toMatchObject({ verb: 'archive' });
		expect(result?.accepted).toBeNull();
	});

	it('creates a real, ordinary filter on accept and links back to it', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId } = await seedEarnedSuggestion(t);

		const { filterId } = await t.mutation(api.mail.triageTally.acceptSuggestion, {
			mailboxId,
			senderAddress: 'news@x.example',
			verb: 'archive',
			name: 'Always archive news@x.example',
		});
		const filter = await t.run(async (ctx) => ctx.db.get(filterId));
		expect(filter?.name).toBe('Always archive news@x.example');
		expect(filter?.conditions).toEqual([{ field: 'from', op: 'equals', value: 'news@x.example' }]);
		expect(filter?.actions[0]?.type).toBe('moveToFolder');
		expect(filter?.isEnabled).toBe(true);

		// The offer is replaced by the rule it became, with a link to it.
		const after = await t.query(api.mail.triageTally.forMessage, { messageId });
		expect(after?.suggestion).toBeNull();
		expect(after?.accepted).toMatchObject({ filterId, verb: 'archive' });
	});

	it('refuses to create a rule the evidence does not support', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		await seedFolder(t, mailboxId, 'archive');
		await expect(
			t.mutation(api.mail.triageTally.acceptSuggestion, {
				mailboxId,
				senderAddress: 'stranger@x.example',
				verb: 'archive',
				name: 'Always archive',
			})
		).rejects.toThrow();
	});

	it('retires the offer on dismiss and never brings it back', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId } = await seedEarnedSuggestion(t);
		await t.mutation(api.mail.triageTally.dismissSuggestion, {
			mailboxId,
			senderAddress: 'news@x.example',
			verb: 'archive',
		});
		const after = await t.query(api.mail.triageTally.forMessage, { messageId });
		expect(after?.suggestion).toBeNull();
		expect(after?.accepted).toBeNull();
	});

	it('deletes the created rule on undo, without re-offering it', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId } = await seedEarnedSuggestion(t);
		const { filterId } = await t.mutation(api.mail.triageTally.acceptSuggestion, {
			mailboxId,
			senderAddress: 'news@x.example',
			verb: 'archive',
			name: 'Always archive news@x.example',
		});

		await t.mutation(api.mail.triageTally.undoSuggestion, {
			mailboxId,
			senderAddress: 'news@x.example',
			verb: 'archive',
		});
		expect(await t.run(async (ctx) => ctx.db.get(filterId))).toBeNull();
		const after = await t.query(api.mail.triageTally.forMessage, { messageId });
		expect(after?.suggestion).toBeNull();
		expect(after?.accepted).toBeNull();
	});

	it('reveals nothing to someone without access to the mailbox', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seedEarnedSuggestion(t);
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		expect(await t.query(api.mail.triageTally.forMessage, { messageId })).toBeNull();
	});
});
