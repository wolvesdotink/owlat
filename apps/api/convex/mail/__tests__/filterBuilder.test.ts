/**
 * Filter-builder upgrades (idea 39) — the match-any grouping, the reorder that
 * makes `priority` reachable, the dry-run preview, and the retroactive run over
 * existing mail.
 *
 * The load-bearing properties: `matchType` absent still means AND (no existing
 * filter changes meaning), the preview runs the SAME predicate delivery does,
 * and the retroactive sweep refuses to forward/delete anything.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { evaluateFilters, filterConditionsMatch, type EvalMessage } from '../filters';
import { hasRetroactiveActions } from '../filterRun';
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

async function drainScheduler(t: TestConvex<typeof schema>): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

const MESSAGE: EvalMessage = {
	from: 'ines@brightpath.example',
	to: ['me@hinterland.camp'],
	cc: [],
	subject: 'Invoice 4471',
	bodyText: 'the invoice is attached',
	size: 2048,
	hasAttachment: true,
};

const FROM_INES = { field: 'from' as const, op: 'contains' as const, value: 'ines' };
const SUBJECT_QUOTE = { field: 'subject' as const, op: 'contains' as const, value: 'quote' };

describe('filterConditionsMatch', () => {
	it('AND-s by default, so an existing filter keeps its meaning', () => {
		expect(filterConditionsMatch({ conditions: [FROM_INES, SUBJECT_QUOTE] }, MESSAGE)).toBe(false);
		expect(
			filterConditionsMatch({ conditions: [FROM_INES, SUBJECT_QUOTE], matchType: 'all' }, MESSAGE)
		).toBe(false);
	});

	it('OR-s under match-any', () => {
		expect(
			filterConditionsMatch({ conditions: [FROM_INES, SUBJECT_QUOTE], matchType: 'any' }, MESSAGE)
		).toBe(true);
	});

	it('matches nothing on an empty group, under either mode', () => {
		// Under `any`, an empty group would otherwise vacuously match every
		// message in the mailbox.
		expect(filterConditionsMatch({ conditions: [], matchType: 'any' }, MESSAGE)).toBe(false);
		expect(filterConditionsMatch({ conditions: [] }, MESSAGE)).toBe(false);
	});
});

describe('hasRetroactiveActions', () => {
	it('is false for a rule that only forwards or deletes', () => {
		expect(hasRetroactiveActions({ actions: [{ type: 'forward', forwardTo: 'x@y.z' }] })).toBe(
			false
		);
		expect(hasRetroactiveActions({ actions: [{ type: 'discard' }] })).toBe(false);
	});

	it('is true as soon as one safe action is present', () => {
		expect(hasRetroactiveActions({ actions: [{ type: 'delete' }, { type: 'markRead' }] })).toBe(
			true
		);
	});
});

describe('mail.filters matchType round trip', () => {
	it('stores `any` and clears it back to absent on `all`', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Either',
			conditions: [FROM_INES, SUBJECT_QUOTE],
			actions: [{ type: 'markRead' }],
			matchType: 'any',
		});
		let list = await t.query(api.mail.filters.list, { mailboxId });
		expect(list[0]?.matchType).toBe('any');

		// Absent is the pre-toggle meaning, so toggling back must not leave a
		// stored `'all'` behind.
		await t.mutation(api.mail.filters.update, { filterId, matchType: 'all' });
		list = await t.query(api.mail.filters.list, { mailboxId });
		expect(list[0]?.matchType).toBeUndefined();
	});

	it('drives the delivery-time evaluator', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Either',
			conditions: [FROM_INES, SUBJECT_QUOTE],
			actions: [{ type: 'markFlagged' }],
			matchType: 'any',
		});
		const filters = await t.query(api.mail.filters.list, { mailboxId });
		expect(evaluateFilters(filters, MESSAGE).actions.map((a) => a.type)).toEqual(['markFlagged']);
	});
});

describe('mail.filters.reorder', () => {
	it('rewrites priority in the order given', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const ids: Id<'mailFilters'>[] = [];
		for (const name of ['a', 'b', 'c']) {
			ids.push(
				await t.mutation(api.mail.filters.create, {
					mailboxId,
					name,
					conditions: [FROM_INES],
					actions: [{ type: 'markRead' }],
				})
			);
		}
		await t.mutation(api.mail.filters.reorder, {
			mailboxId,
			filterIds: [ids[2]!, ids[0]!, ids[1]!],
		});
		const list = await t.query(api.mail.filters.list, { mailboxId });
		// `list` reads the by_mailbox_and_priority index, so the run order IS the
		// list order — that is the whole point of making priority writable.
		expect(list.map((f) => f.name)).toEqual(['c', 'a', 'b']);
		expect(list.map((f) => f.priority)).toEqual([100, 200, 300]);
	});

	it('refuses a non-owner', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(
			t.mutation(api.mail.filters.reorder, { mailboxId, filterIds: [] })
		).rejects.toThrow();
	});
});

describe('mail.filters.preview', () => {
	it('reports the matches and the honest scan size', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { subject: 'Invoice 4471', fromAddress: 'ines@bp.example' });
		await seedMessage(t, mailboxId, { subject: 'Lunch?', fromAddress: 'mei@example.com' });

		const res = await t.query(api.mail.filters.preview, {
			mailboxId,
			conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
		});
		expect(res.matches.map((m) => m.subject)).toEqual(['Invoice 4471']);
		expect(res.matchCount).toBe(1);
		expect(res.scanned).toBe(2);
	});

	it('previews the draft grouping, not just the saved one', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { subject: 'Invoice 4471', fromAddress: 'ines@bp.example' });
		await seedMessage(t, mailboxId, { subject: 'Lunch?', fromAddress: 'mei@example.com' });

		const conditions = [
			{ field: 'subject' as const, op: 'contains' as const, value: 'invoice' },
			{ field: 'from' as const, op: 'contains' as const, value: 'mei' },
		];
		expect((await t.query(api.mail.filters.preview, { mailboxId, conditions })).matchCount).toBe(0);
		expect(
			(await t.query(api.mail.filters.preview, { mailboxId, conditions, matchType: 'any' }))
				.matchCount
		).toBe(2);
	});

	it('returns nothing for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		const res = await t.query(api.mail.filters.preview, {
			mailboxId,
			conditions: [FROM_INES],
		});
		expect(res).toEqual({ matches: [], scanned: 0, matchCount: 0 });
	});
});

describe('mail.filterRun', () => {
	it('applies the safe actions to the backlog and reports progress', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedFolder(t, mailboxId, 'archive');
		const labelId = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Invoices' });
		const hit = await seedMessage(t, mailboxId, {
			subject: 'Invoice 4471',
			fromAddress: 'ines@bp.example',
		});
		const missId = await seedMessage(t, mailboxId, { subject: 'Lunch?' });

		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'File invoices',
			conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
			actions: [{ type: 'addLabel', labelId }, { type: 'markRead' }],
		});

		await t.mutation(api.mail.filterRun.start, { filterId });
		await drainScheduler(t);

		const job = await t.query(api.mail.filterRun.status, { filterId });
		expect(job?.status).toBe('completed');
		expect(job?.scannedCount).toBe(2);
		expect(job?.matchedCount).toBe(1);

		await t.run(async (ctx) => {
			const matched = (await ctx.db.get(hit))!;
			expect(matched.labelIds).toEqual([labelId]);
			expect(matched.flagSeen).toBe(true);
			const untouched = (await ctx.db.get(missId))!;
			expect(untouched.labelIds).toEqual([]);
			expect(untouched.flagSeen).toBe(false);
		});
	});

	it('never forwards, deletes or discards retroactively', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice 4471' });
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Drop invoices',
			conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
			actions: [{ type: 'discard' }, { type: 'forward', forwardTo: 'someone@example.com' }],
		});

		await t.mutation(api.mail.filterRun.start, { filterId });
		await drainScheduler(t);

		// The rule matched — the message is still exactly where it was.
		expect((await t.query(api.mail.filterRun.status, { filterId }))?.matchedCount).toBe(1);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(messageId)).not.toBeNull();
		});
	});

	it('is idempotent across a re-run', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const labelId = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Invoices' });
		const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice 4471' });
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'File invoices',
			conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
			actions: [{ type: 'addLabel', labelId }],
		});

		await t.mutation(api.mail.filterRun.start, { filterId });
		await drainScheduler(t);
		await t.mutation(api.mail.filterRun.start, { filterId });
		await drainScheduler(t);

		await t.run(async (ctx) => {
			// One label, not two: the second sweep must not double what the first did.
			expect((await ctx.db.get(messageId))!.labelIds).toEqual([labelId]);
		});
	});

	it('moves matching mail into the rule’s target folder', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const archiveId = await seedFolder(t, mailboxId, 'archive');
		const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice 4471' });
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'Archive invoices',
			conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
			actions: [{ type: 'moveToFolder', folderId: archiveId }],
		});

		await t.mutation(api.mail.filterRun.start, { filterId });
		await drainScheduler(t);

		await t.run(async (ctx) => {
			expect((await ctx.db.get(messageId))!.folderId).toBe(archiveId);
			// The shared move helper keeps both folders' counters honest.
			expect((await ctx.db.get(archiveId))!.totalCount).toBe(1);
		});
	});

	it('drops the run job when the filter is deleted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'x',
			conditions: [FROM_INES],
			actions: [{ type: 'markRead' }],
		});
		await t.mutation(api.mail.filterRun.start, { filterId });
		await drainScheduler(t);
		await t.mutation(api.mail.filters.remove, { filterId });

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('mailFilterRunJobs').collect();
			expect(jobs).toHaveLength(0);
		});
	});

	it('refuses a non-owner', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		const filterId = await t.mutation(api.mail.filters.create, {
			mailboxId,
			name: 'x',
			conditions: [FROM_INES],
			actions: [{ type: 'markRead' }],
		});
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(t.mutation(api.mail.filterRun.start, { filterId })).rejects.toThrow();
	});
});
