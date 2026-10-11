import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { threadRefToFields, type ThreadRef } from '../lib/validators/threadRef';
import {
	draftRow,
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedIdentity,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * The thread brief under member erasure: a personal thread takes every brief
 * row with it, a personal draft its response plan; on a team inbox the
 * member's viewer state goes and the items assigned to them read Unassigned,
 * while the team's brief and a colleague's state stay.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const NOW = Date.UTC(2026, 9, 7, 9, 0);

async function seedBriefRows(
	ctx: MutationCtx,
	ref: ThreadRef,
	opts: { messageId: Id<'mailMessages'>; viewers: string[]; assignee?: string }
) {
	const fields = threadRefToFields(ref);
	const itemId = await ctx.db.insert('threadItems', {
		...fields,
		revision: 1,
		intent: 'request',
		facets: [],
		assertion: 'sealed',
		display: { en: 'sealed', de: 'sealed' },
		requester: { email: 'sender@example.com', isUs: false },
		responsible: { isUs: true },
		responsibility: 'us',
		...(opts.assignee ? { assigneeUserId: opts.assignee } : {}),
		status: 'open',
		disposition: 'unanswered',
		evidence: [
			{
				source: { kind: 'mail', id: opts.messageId },
				segmentId: 's0',
				start: 0,
				end: 4,
				contentRevision: 'rev-1',
			},
		],
		verify: 'passed',
		askedAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
	});
	await ctx.db.insert('threadActivity', {
		...fields,
		seq: 1,
		idempotencyKey: `${ref.kind}:${ref.id}|item:${itemId}`,
		type: 'item_opened',
		actor: { kind: 'system' },
		provenance: 'reported',
		visibility: 'substance',
		itemId,
		eventAt: NOW,
		recordedAt: NOW,
	});
	await ctx.db.insert('messageInterpretations', {
		...fields,
		source: { kind: 'mail', id: opts.messageId },
		sourceKey: `mail:${opts.messageId}`,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		mode: 'brief',
		status: 'complete',
		payload: 'sealed',
		deletionEpoch: 0,
		createdAt: NOW,
		updatedAt: NOW,
	});
	await ctx.db.insert('threadBriefs', {
		...fields,
		mode: 'brief',
		sourceRevision: 1,
		interpretationRevision: 1,
		lastActivitySeq: 1,
		completeness: 'complete',
		deletionEpoch: 0,
		updatedAt: NOW,
	});
	const viewerIds = [];
	for (const userId of opts.viewers) {
		viewerIds.push(
			await ctx.db.insert('threadViewerState', {
				...fields,
				userId,
				seenInterpretationRevision: 1,
				seenActivitySeq: 1,
				updatedAt: NOW,
			})
		);
	}
	return { itemId, viewerIds };
}

describe('member erasure of the thread brief', () => {
	it('erases personal briefs and the member’s state, keeps the team’s', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		const colleagueId = await seedIdentity(t, 'colleague@example.com');
		const personal = await seedPersonalMailbox(t, authUserId);
		const team = await seedPersonalMailbox(t, authUserId, {
			scope: 'shared',
			address: 'team@example.com',
		});
		const seeded = await t.run(async (ctx) => {
			const personalRows = await seedBriefRows(
				ctx,
				{ kind: 'mail', id: personal.threadId },
				{ messageId: personal.messageId, viewers: [authUserId] }
			);
			const draftId = await ctx.db.insert('mailDrafts', draftRow(personal.mailboxId, NOW));
			const planId = await ctx.db.insert('draftResponsePlans', {
				threadKind: 'mail',
				mailThreadId: personal.threadId,
				draftKind: 'mailDraft',
				mailDraftId: draftId,
				threadRevision: 1,
				itemRevisions: [{ itemId: personalRows.itemId, revision: 1 }],
				stances: [],
				ownerInputs: [],
				coverage: [],
				newPromises: [],
				fileClaims: [],
				draftHash: 'h',
				verdict: 'pending',
				createdAt: NOW,
				updatedAt: NOW,
			});
			const teamRows = await seedBriefRows(
				ctx,
				{ kind: 'mail', id: team.threadId },
				{ messageId: team.messageId, viewers: [authUserId, colleagueId], assignee: authUserId }
			);
			const teamRef = threadRefToFields({ kind: 'mail', id: team.threadId });
			const reactionId = await ctx.db.insert('noteReactions', {
				...teamRef,
				noteSource: 'chatMessage',
				userId: authUserId,
				emoji: '👍',
				createdAt: NOW,
			});
			const correctionId = await ctx.db.insert('threadItemCorrections', {
				...teamRef,
				itemId: teamRows.itemId,
				itemRevision: 1,
				kind: 'notARequest',
				userId: authUserId,
				intent: 'request',
				facets: [],
				responsibility: 'us',
				verify: 'passed',
				evidenceSources: [],
				createdAt: NOW,
			});
			return { personalRows, planId, teamRows, reactionId, correctionId };
		});

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			const id = personal.threadId;
			const left = [
				await ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', id))
					.first(),
				await ctx.db
					.query('threadActivity')
					.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', id))
					.first(),
				await ctx.db
					.query('messageInterpretations')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.first(),
				await ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.first(),
				await ctx.db
					.query('threadViewerState')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.first(),
			];
			expect(left).toEqual([null, null, null, null, null]);
			expect(await ctx.db.get(seeded.personalRows.itemId)).toBeNull();
			expect(await ctx.db.get(seeded.planId)).toBeNull();

			const teamItem = await ctx.db.get(seeded.teamRows.itemId);
			expect(teamItem).not.toBeNull();
			expect(teamItem?.assigneeUserId).toBeUndefined();
			expect(await ctx.db.get(seeded.reactionId)).toBeNull();
			expect((await ctx.db.get(seeded.correctionId))?.userId).toBe('[deleted account]');
			const [own, colleague] = seeded.teamRows.viewerIds;
			expect(await ctx.db.get(own!)).toBeNull();
			expect((await ctx.db.get(colleague!))?.userId).toBe(colleagueId);
			expect(
				await ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', team.threadId))
					.first()
			).not.toBeNull();
		});
	});
});
