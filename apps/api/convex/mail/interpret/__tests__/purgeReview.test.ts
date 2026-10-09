/**
 * Review round 1 regressions of the thread brief erasure (Sol F3–F7, F13):
 * resumable ranges that finish, children before parents, back-references
 * repaired across pages, scope changes that never re-read a kept set, team
 * clarification links, and survivors restated, reverted and re-read.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { threadRefToFields, type ThreadRef } from '../../../lib/validators/threadRef';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';
import { openMessageBody, sealBodyAtWrite } from '../../../lib/messageBody';
import { unitBudget } from '../purgeDrain';
import { drivePurgeJob } from '../purgeRun';
import { itemLineage } from '../fold';
import { PURGE_RECHECK_CODE } from '../purgeQuestions';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';
import { SENT, addSibling, insertFact, insertItem, mailRows } from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** Drive a sources job in small slices until it finishes; the number of slices. */
async function purgeInSlices(
	t: Test,
	ref: ThreadRef,
	sources: InterpretationSource[],
	units: number,
	onSlice?: (slice: number) => Promise<void>
): Promise<number> {
	for (let slice = 1; slice < 500; slice++) {
		const isDone = await t.run((ctx) =>
			drivePurgeJob(ctx, 'test', { ref, kind: 'sources', sources }, unitBudget(units))
		);
		if (isDone) return slice;
		await onSlice?.(slice);
	}
	throw new Error('purge never finished');
}

function activityRow(ref: ThreadRef, seq: number, extra: Record<string, unknown> = {}) {
	return {
		...threadRefToFields(ref),
		seq,
		idempotencyKey: `${ref.kind}:${ref.id}|test:${seq}`,
		type: 'item_changed' as const,
		actor: { kind: 'system' as const },
		provenance: 'reported' as const,
		visibility: 'substance' as const,
		eventAt: SENT,
		recordedAt: SENT,
		...extra,
	};
}

async function current(
	ctx: MutationCtx,
	source: InterpretationSource,
	ref: ThreadRef,
	payload: object
) {
	return ctx.db.insert('messageInterpretations', {
		...threadRefToFields(ref),
		source,
		sourceKey: `${source.kind}:${source.id}`,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		mode: 'brief',
		status: 'complete',
		payload: await sealBodyAtWrite(JSON.stringify(payload)),
		deletionEpoch: 0,
		isCurrent: true,
		isCounted: true,
		appliedAt: SENT,
		createdAt: SENT,
		updatedAt: SENT,
	});
}

describe('F4: an item’s links are finished before the item goes', () => {
	it('clears 300 activity rows over several slices and only then deletes the item', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const src = { kind: 'mail' as const, id: messageId };
		const itemId = await t.run(async (ctx) => {
			const id = await insertItem(ctx, ref, [src]);
			for (let seq = 1; seq <= 300; seq++) {
				await ctx.db.insert('threadActivity', activityRow(ref, seq, { itemId: id }));
			}
			return id;
		});
		let sawItemWithLinks = false;
		const slices = await purgeInSlices(t, ref, [src], 50, async () => {
			const state = await t.run(async (ctx) => ({
				item: await ctx.db.get(itemId),
				links: (
					await ctx.db
						.query('threadActivity')
						.withIndex('by_item', (q) => q.eq('itemId', itemId))
						.take(1)
				).length,
			}));
			if (state.links > 0) {
				sawItemWithLinks = true;
				expect(state.item).not.toBeNull();
			}
		});
		expect(slices).toBeGreaterThan(3);
		expect(sawItemWithLinks).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(itemId)).toBeNull();
			expect(await ctx.db.query('threadActivity').collect()).toHaveLength(0);
			expect(await ctx.db.query('threadPurgeJobs').collect()).toHaveLength(0);
		});
	});
});

describe('F5: back-references are repaired thread-wide', () => {
	it('reopens and unflags claims that point at a deleted one pages away', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const srcA = { kind: 'mail' as const, id: a };
		const srcB = { kind: 'mail' as const, id: b };
		const seeded = await t.run(async (ctx) => {
			// Created first, so a slice reaches them long before the doomed ones.
			const replaced = await insertItem(ctx, ref, [srcB], { status: 'superseded' });
			const duplicate = await insertItem(ctx, ref, [srcB]);
			const conflicted = await insertFact(ctx, threadId, [srcB]);
			for (let i = 0; i < 150; i++) await insertItem(ctx, ref, [srcB]);
			const replacer = await insertItem(ctx, ref, [srcA]);
			const original = await insertItem(ctx, ref, [srcA]);
			const conflicting = await insertFact(ctx, threadId, [srcA]);
			await ctx.db.patch(replaced, { replacedById: replacer });
			await ctx.db.patch(duplicate, { possibleDuplicateOfId: original });
			await ctx.db.patch(conflicted, { conflictsWithId: conflicting });
			return { replaced, duplicate, conflicted, replacer, original, conflicting };
		});

		await purgeInSlices(t, ref, [srcA], 40);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.replacer)).toBeNull();
			expect(await ctx.db.get(seeded.original)).toBeNull();
			expect(await ctx.db.get(seeded.conflicting)).toBeNull();
			const replaced = (await ctx.db.get(seeded.replaced))!;
			expect(replaced.status).toBe('open');
			expect(replaced.replacedById).toBeUndefined();
			expect((await ctx.db.get(seeded.duplicate))!.possibleDuplicateOfId).toBeUndefined();
			expect((await ctx.db.get(seeded.conflicted))!.conflictsWithId).toBeUndefined();
		});
	});
});

describe('F6/F7: a scope change walks every kept row once', () => {
	it('clears 250 viewer overrides, 250 plans, old fact activity and an old-mode extraction behind 250 new ones', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		const source = { kind: 'mail' as const, id: messageId };
		const oldMode = await t.run(async (ctx) => {
			await ctx.db.insert('threadBriefs', {
				...threadRefToFields(ref),
				mode: 'brief',
				sourceRevision: 1,
				interpretationRevision: 1,
				lastActivitySeq: 700,
				completeness: 'complete',
				deletionEpoch: 0,
				updatedAt: SENT,
			});
			for (let i = 0; i < 250; i++) {
				await ctx.db.insert('messageInterpretations', {
					...threadRefToFields(ref),
					source,
					sourceKey: `mail:new-${i}`,
					contentRevision: 'r',
					extractorVersion: 1,
					mode: 'actions',
					status: 'complete',
					deletionEpoch: 0,
					createdAt: SENT,
					updatedAt: SENT,
				});
			}
			const old = await ctx.db.insert('messageInterpretations', {
				...threadRefToFields(ref),
				source,
				sourceKey: 'mail:old',
				contentRevision: 'r',
				extractorVersion: 1,
				mode: 'brief',
				status: 'complete',
				deletionEpoch: 0,
				createdAt: SENT,
				updatedAt: SENT,
			});
			for (let seq = 1; seq <= 600; seq++) {
				await ctx.db.insert(
					'threadActivity',
					activityRow(ref, seq, seq <= 5 ? { type: 'fact_changed' } : {})
				);
			}
			for (let i = 0; i < 250; i++) {
				await ctx.db.insert('threadViewerState', {
					...threadRefToFields(ref),
					userId: `user-${i}`,
					viewOverride: 'overview',
					seenInterpretationRevision: 1,
					seenActivitySeq: 1,
					updatedAt: SENT,
				});
				await ctx.db.insert('draftResponsePlans', {
					...threadRefToFields(ref),
					draftKind: 'mailDraft',
					threadRevision: 1,
					itemRevisions: [],
					stances: [],
					ownerInputs: [],
					coverage: [],
					newPromises: [],
					fileClaims: [],
					draftHash: `h${i}`,
					verdict: 'covered',
					createdAt: SENT,
					updatedAt: SENT,
				});
			}
			await ctx.db.patch(mailboxId, { scope: 'shared' });
			return old;
		});

		await t.mutation(internal.mail.interpret.purgeJobs.invalidateMailboxThreads, {
			mailboxId,
			mode: 'actions',
			cursor: null,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			const viewers = await ctx.db.query('threadViewerState').collect();
			expect(viewers.filter((v) => v.viewOverride !== undefined)).toHaveLength(0);
			const plans = await ctx.db.query('draftResponsePlans').collect();
			expect(plans.filter((p) => p.verdict !== 'stale')).toHaveLength(0);
			const activity = await ctx.db.query('threadActivity').collect();
			expect(activity).toHaveLength(595);
			expect(activity.some((a) => a.type === 'fact_changed')).toBe(false);
			expect(await ctx.db.get(oldMode)).toBeNull();
			expect(await ctx.db.query('messageInterpretations').collect()).toHaveLength(250);
			const brief = await ctx.db.query('threadBriefs').first();
			// Moved to the new mode and its epoch bumped ONCE, however many slices it took.
			expect(brief).toMatchObject({ mode: 'actions', deletionEpoch: 1 });
			expect(await ctx.db.query('threadPurgeJobs').collect()).toHaveLength(0);
		});
	});
});

describe('F13: team clarification and ask-session links', () => {
	it('clears links to deleted items from other messages and team ask sessions', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		const src = { kind: 'inbound' as const, id: inboundId };
		const seeded = await t.run(async (ctx) => {
			const itemId = await insertItem(ctx, ref, [src]);
			const { _id, _creationTime, ...first } = (await ctx.db.get(inboundId))!;
			const question = { id: 'q1', slotType: 'free_text', text: 'Which order?', itemId };
			const other = await ctx.db.insert('inboundMessages', {
				...first,
				messageId: '<second@example.com>',
				pendingClarification: { questions: [question], askedAt: SENT },
			});
			const sessionId = await ctx.db.insert('answerAskSessions', {
				ownerId: 'user-A',
				organizationId: 'org-1',
				target: { kind: 'teamThread', threadId },
				targetKey: `teamThread:${threadId}`,
				locale: 'en',
				round: 1,
				status: 'asking',
				questions: [question],
				attachedFiles: [],
				createdAt: SENT,
				updatedAt: SENT,
			});
			return { itemId, other, sessionId };
		});

		await purgeInSlices(t, ref, [src], 400);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.itemId)).toBeNull();
			const other = (await ctx.db.get(seeded.other))!;
			expect(other.pendingClarification?.questions[0]).toMatchObject({
				id: 'q1',
				text: 'Which order?',
			});
			expect(other.pendingClarification?.questions[0]?.itemId).toBeUndefined();
			const session = (await ctx.db.get(seeded.sessionId))!;
			expect(session.questions[0]?.itemId).toBeUndefined();
		});
	});
});

describe('F3: a survivor is restated, reverted and re-read', () => {
	async function seedSurvivor(t: Test) {
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const srcA = { kind: 'mail' as const, id: a };
		const srcB = { kind: 'mail' as const, id: b };
		return { a, b, threadId, ref, srcA, srcB };
	}

	it('restates wording from a surviving claim and reverts a status the purged message set', async () => {
		const t = convexTest(schema, modules);
		const { a, threadId, ref, srcA, srcB } = await seedSurvivor(t);
		const claim = reduceItem({
			assertion: 'Send the countersigned contract',
			display: {
				en: 'Send the countersigned contract',
				de: 'Schick den gegengezeichneten Vertrag',
			},
			due: { phrase: 'by Monday', at: Date.UTC(2026, 9, 12), isAmbiguous: false },
		});
		const itemId = await t.run(async (ctx) => {
			await current(ctx, srcB, ref, reduceResult({ items: [claim] }));
			return insertItem(ctx, ref, [srcA, srcB], {
				lineage: `mail:${a}#origin`,
				lineageKeys: [`mail:${a}#origin`, itemLineage(`mail:${srcB.id}`, claim)],
				status: 'done',
				completion: 'reported',
				statusSource: { sourceKey: `mail:${a}`, at: SENT },
				confirmedFrom: {
					kind: 'heldChange',
					confirmation: { by: 'user-A', at: SENT, kind: 'confirmed' },
					verify: 'passed',
					addedEvidenceKeys: [`mail:${a}|rev-1|s0:0:4`, `mail:${srcB.id}|rev-1|s0:0:4`],
				},
			});
		});

		await purgeInSlices(t, ref, [srcA], 400);

		const item = await t.run((ctx) => ctx.db.get(itemId));
		expect(item).toMatchObject({ status: 'open', isReviewNeeded: true, due: claim.due });
		expect(item?.completion).toBeUndefined();
		expect(item?.statusSource).toBeUndefined();
		expect(await openMessageBody(item!.assertion)).toBe('Send the countersigned contract');
		expect(item?.lineageKeys).toEqual([itemLineage(`mail:${srcB.id}`, claim)]);
		// Its saved values may restore what the purged message said: the undo snapshot goes.
		expect(item?.confirmedFrom).toBeUndefined();
		// A claim survived on less evidence: incomplete until the thread is re-read.
		expect((await mailRows(t, threadId)).brief?.completeness).toBe('partial');
	});

	it('redacts wording with no surviving claim, marks the brief partial and schedules a re-read', async () => {
		const t = convexTest(schema, modules);
		const { a, threadId, ref, srcA, srcB } = await seedSurvivor(t);
		const counted = await t.run(async (ctx) => {
			await ctx.db.insert('threadBriefs', {
				...threadRefToFields(ref),
				mode: 'brief',
				sourceRevision: 2,
				interpretationRevision: 2,
				lastActivitySeq: 0,
				completeness: 'complete',
				sourceCounts: { complete: 1, partial: 0, failed: 0, unreadable: 0, skipped: 0 },
				deletionEpoch: 0,
				updatedAt: SENT,
			});
			const row = await current(ctx, srcB, ref, reduceResult({ items: [] }));
			await ctx.db.insert('interpretSources', {
				...threadRefToFields(ref),
				source: srcB,
				sourceKey: `mail:${srcB.id}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: false,
					isSenderKnown: true,
				},
				createdAt: SENT,
				updatedAt: SENT,
			});
			await insertItem(ctx, ref, [srcA, srcB], {
				lineage: `mail:${a}#origin`,
				due: { phrase: 'by Friday', at: Date.UTC(2026, 9, 9), isAmbiguous: false },
				amount: { value: 120, currency: 'EUR' },
			});
			return row;
		});

		await purgeInSlices(t, ref, [srcA], 400);

		const state = await mailRows(t, threadId);
		const item = state.items[0]!;
		expect(await openMessageBody(item.display.en)).toBe('Details removed with the deleted message');
		expect(item.due).toBeUndefined();
		expect(item.amount).toBeUndefined();
		expect(item.isReviewNeeded).toBe(true);
		expect(state.brief?.completeness).toBe('partial');
		expect(state.brief?.sourceCounts).toMatchObject({ complete: 0, partial: 1 });
		await t.run(async (ctx) => {
			expect(await ctx.db.get(counted)).toMatchObject({
				status: 'partial',
				errorCode: PURGE_RECHECK_CODE,
			});
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.map((s) => [s.name, s.args[0]])).toContainEqual([
				'mail/interpret/run:interpretMessage',
				{ source: srcB },
			]);
		});
	});
});
