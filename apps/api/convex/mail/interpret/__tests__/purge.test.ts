/**
 * Thread brief erasure against a real (convex-test) database: a purged
 * message takes its extractions, evidence, evidence-less claims, activity and
 * links with it and blocks in-flight runs (`purge.ts`); a deleted thread takes
 * all seven tables (`purgeThread.ts`); a Team Inbox message does the same in
 * its thread.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { threadRefToFields } from '../../../lib/validators/threadRef';
import { purgeSourcesFromThread, purgeThreadBrief } from '../purgeRun';
import { REDACTED_CLAIM_TEXT } from '../purgeClaims';
import { openMessageBody } from '../../../lib/messageBody';
import { seedFolder } from '../../__tests__/helpers.testlib';
import { modules, seedMailThread, seedTeamThread } from './interpret.testlib';
import {
	SENT,
	evidence,
	addSibling,
	applyArgs,
	insertFact,
	insertItem,
	linkItem,
	mailRows,
	purgeMessages,
} from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('message purge', () => {
	it('drops the purged message’s evidence, claims, activity and links', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const srcA = { kind: 'mail' as const, id: a };
		const srcB = { kind: 'mail' as const, id: b };

		// The reducer writes A's item, extraction, activity and the brief.
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		expect((await mailRows(t, threadId)).brief?.sourceCounts?.complete).toBe(1);
		const seeded = await t.run(async (ctx) => {
			await ctx.db.insert('interpretSources', {
				...threadRefToFields(ref),
				source: srcA,
				sourceKey: `mail:${a}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: false,
					isSenderKnown: true,
				},
				createdAt: SENT,
				updatedAt: SENT,
			});
			const onlyA = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.first())!._id;
			const both = await insertItem(ctx, ref, [srcA, srcB], {
				pendingUpdate: { evidence: [evidence(srcA)] },
			});
			const replacement = await insertItem(ctx, ref, [srcA]);
			const replaced = await insertItem(ctx, ref, [srcB], {
				status: 'superseded',
				replacedById: replacement,
				possibleDuplicateOfId: onlyA,
			});
			const oldFact = await insertFact(ctx, threadId, [srcB], { status: 'superseded' });
			const newFact = await insertFact(ctx, threadId, [srcA], { supersedesId: oldFact });
			const opActivity = await ctx.db.insert('threadActivity', {
				...threadRefToFields(ref),
				seq: 99,
				idempotencyKey: `mail:${threadId}|send:${a}`,
				type: 'reply_sent',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				visibility: 'substance',
				opRef: { kind: 'outbound', id: a },
				eventAt: SENT,
				recordedAt: SENT,
			});
			const links = await linkItem(ctx, onlyA, { mailboxId, threadId, messageId: b });
			const planId = await ctx.db.insert('draftResponsePlans', {
				...threadRefToFields(ref),
				draftKind: 'mailDraft',
				threadRevision: 1,
				itemRevisions: [
					{ itemId: onlyA, revision: 1 },
					{ itemId: both, revision: 1 },
				],
				stances: [
					{ itemId: onlyA, stance: 'answer', source: 'default' },
					{ itemId: both, stance: 'answer', source: 'default' },
				],
				ownerInputs: [{ questionId: 'q1', itemId: onlyA }],
				coverage: [{ itemId: onlyA, spans: [], verdict: 'addressed' }],
				newPromises: [],
				fileClaims: [],
				draftHash: 'h',
				verdict: 'covered',
				createdAt: SENT,
				updatedAt: SENT,
			});
			return { onlyA, both, replacement, replaced, oldFact, newFact, opActivity, planId, ...links };
		});
		expect((await mailRows(t, threadId)).thread?.briefTop?.latest).toBeDefined();

		await purgeMessages(t, [a]);

		const after = await mailRows(t, threadId);
		expect(after.thread).not.toBeNull();
		expect(after.interpretations).toHaveLength(0);
		// A's reducer activity (received, item opened) and the send naming it are gone.
		expect(after.activity).toHaveLength(0);
		const ids = after.items.map((i) => i._id);
		expect(ids).not.toContain(seeded.onlyA);
		expect(ids).not.toContain(seeded.replacement);
		const both = after.items.find((i) => i._id === seeded.both)!;
		expect(both.evidence.map((e) => e.source.id)).toEqual([b]);
		expect(both.revision).toBe(2);
		// The unconfirmed update held only the purged message's evidence.
		expect(both.pendingUpdate).toBeUndefined();
		// Its wording came from the purged message (first evidence): redacted, flagged.
		expect(both.isReviewNeeded).toBe(true);
		expect(await openMessageBody(both.display.de)).toBe(REDACTED_CLAIM_TEXT.de);
		const replaced = after.items.find((i) => i._id === seeded.replaced)!;
		expect(replaced).toMatchObject({ status: 'open' });
		expect(replaced.replacedById).toBeUndefined();
		expect(replaced.possibleDuplicateOfId).toBeUndefined();
		expect(after.facts.map((f) => [f._id, f.status])).toEqual([[seeded.oldFact, 'current']]);
		expect(after.plans[0]).toMatchObject({
			verdict: 'stale',
			itemRevisions: [{ itemId: seeded.both, revision: 1 }],
			stances: [{ itemId: seeded.both }],
			ownerInputs: [{ questionId: 'q1' }],
			coverage: [],
		});
		expect(after.brief).toMatchObject({
			// Bumped once, when the purge started (a re-read it schedules must not be erased).
			deletionEpoch: 1,
			interpretationRevision: 2,
			// Derived, not forced: no surviving source has a snapshot to re-read, no repair is outstanding.
			completeness: 'none',
			sourceCounts: { complete: 0, partial: 0, failed: 0, unreadable: 0, skipped: 0 },
			// The deleted items left the counters; the redacted survivor reads `unclear`, the reopened one `us`.
			itemCounts: expect.objectContaining({ us: 1, unclear: 1, closed: 0 }),
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('interpretSources').collect()).toHaveLength(0);
		});
		expect(after.brief?.checkpoint).toBeUndefined();
		expect(after.thread?.briefTop).toMatchObject({
			forYou: 1,
			top: { itemId: expect.any(String) },
		});
		expect(after.thread?.briefTop?.latest).toBeUndefined();
		await t.run(async (ctx) => {
			expect((await ctx.db.get(seeded.chatId))?.threadItemId).toBeUndefined();
			expect((await ctx.db.get(seeded.commitmentId))?.threadItemId).toBeUndefined();
		});
	});

	it('makes an in-flight interpretation with the old epoch come back erased', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		const loaded = (await mailRows(t, threadId)).brief!;

		await purgeMessages(t, [a]);

		const late = await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			...applyArgs(b, threadId),
			expectedRevision: loaded.interpretationRevision + 1,
			deletionEpoch: loaded.deletionEpoch,
		});
		expect(late).toEqual({ outcome: 'erased' });
		expect((await mailRows(t, threadId)).items).toHaveLength(0);
	});

	it('runs on the trash auto-purge too', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		const trash = await seedFolder(t, mailboxId, 'trash');
		await t.run(async (ctx) => {
			await ctx.db.patch(a, { folderId: trash, trashedAt: 1 });
			const mailbox = (await ctx.db.get(mailboxId))!;
			await ctx.db.insert('mailUserSettings', {
				userId: mailbox.userId!,
				autoAdvance: 'next',
				trashAutoPurgeDays: 7,
				createdAt: SENT,
				updatedAt: SENT,
			});
		});

		const out = await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});
		expect(out.purged).toBe(1);
		const after = await mailRows(t, threadId);
		expect(after.items).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.brief?.deletionEpoch).toBe(1);
		expect(await t.run((ctx) => ctx.db.get(b))).not.toBeNull();
	});
});

describe('thread purge', () => {
	it('deletes every thread brief table when the last message goes', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		const links = await t.run(async (ctx) => {
			const itemId = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.first())!._id;
			await insertFact(ctx, threadId, [{ kind: 'mail', id: messageId }]);
			await ctx.db.insert('threadViewerState', {
				...threadRefToFields(ref),
				userId: 'user-A',
				viewOverride: 'conversation',
				seenInterpretationRevision: 1,
				seenActivitySeq: 2,
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
				draftHash: 'h',
				verdict: 'pending',
				createdAt: SENT,
				updatedAt: SENT,
			});
			// The discussion message and the commitment outlive the item; only their links go.
			const links = await linkItem(ctx, itemId, { mailboxId, threadId, messageId });
			await ctx.db.insert('threadItemCorrections', {
				...threadRefToFields(ref),
				itemId,
				itemRevision: 1,
				kind: 'notARequest',
				userId: 'user-A',
				intent: 'request',
				facets: [],
				responsibility: 'us',
				verify: 'passed',
				evidenceSources: [{ sourceKey: `mail:${messageId}`, contentRevision: 'rev-1' }],
				createdAt: SENT,
			});
			await ctx.db.insert('noteReactions', {
				...threadRefToFields(ref),
				noteSource: 'chatMessage',
				chatMessageId: links.chatId,
				userId: 'user-A',
				emoji: '👍',
				createdAt: SENT,
			});
			return links;
		});

		await purgeMessages(t, [messageId]);

		const after = await mailRows(t, threadId);
		expect(after.thread).toBeNull();
		expect(after.items).toHaveLength(0);
		expect(after.facts).toHaveLength(0);
		expect(after.activity).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.brief).toBeNull();
		expect(after.viewers).toHaveLength(0);
		expect(after.plans).toHaveLength(0);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('threadItemCorrections').collect()).toHaveLength(0);
			expect(await ctx.db.query('noteReactions').collect()).toHaveLength(0);
			expect((await ctx.db.get(links.chatId))?.threadItemId).toBeUndefined();
			expect((await ctx.db.get(links.commitmentId))?.threadItemId).toBeUndefined();
		});
	});

	it('hands what does not fit inline to the scheduled drain', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) await insertItem(ctx, ref, [{ kind: 'mail', id: messageId }]);
			await purgeThreadBrief(ctx, ref, { isInline: false });
		});
		const before = await mailRows(t, threadId);
		expect(before.brief?.deletionEpoch).toBe(1);
		expect(before.items.length).toBeGreaterThan(0);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const after = await mailRows(t, threadId);
		expect(after.items).toHaveLength(0);
		expect(after.activity).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.brief).toBeNull();
	});
});

describe('team message purge', () => {
	it('drops the message’s evidence and unlinks the notes about deleted items', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		const src = { kind: 'inbound' as const, id: inboundId };
		const seeded = await t.run(async (ctx) => {
			const { _id, _creationTime, ...first } = (await ctx.db.get(inboundId))!;
			const other = {
				kind: 'inbound' as const,
				id: await ctx.db.insert('inboundMessages', { ...first, messageId: '<second@example.com>' }),
			};
			const gone = await insertItem(ctx, ref, [src]);
			const kept = await insertItem(ctx, ref, [src, other]);
			const noteId = await ctx.db.insert('threadNotes', {
				threadId,
				authorId: 'user-A',
				body: 'checking the refund',
				mentionedUserIds: [],
				threadItemId: gone,
				createdAt: SENT,
			});
			await ctx.db.insert('threadActivity', {
				...threadRefToFields(ref),
				seq: 1,
				idempotencyKey: `team:${threadId}|claim:${gone}`,
				type: 'item_claimed',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				visibility: 'housekeeping',
				itemId: gone,
				eventAt: SENT,
				recordedAt: SENT,
			});
			await ctx.db.insert('threadItemCorrections', {
				...threadRefToFields(ref),
				itemId: gone,
				itemRevision: 1,
				kind: 'notARequest',
				userId: 'user-A',
				intent: 'request',
				facets: [],
				responsibility: 'us',
				verify: 'passed',
				evidenceSources: [],
				createdAt: SENT,
			});
			await ctx.db.insert('threadActivity', {
				...threadRefToFields(ref),
				seq: 2,
				idempotencyKey: `team:${threadId}|send_queued:${inboundId}:${SENT}`,
				type: 'send_queued',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				visibility: 'substance',
				eventAt: SENT,
				recordedAt: SENT,
			});
			await purgeSourcesFromThread(ctx, ref, [src]);
			return { gone, kept, noteId };
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.gone)).toBeNull();
			expect((await ctx.db.get(seeded.kept))?.evidence).toHaveLength(1);
			const note = await ctx.db.get(seeded.noteId);
			expect(note).not.toBeNull();
			expect(note?.threadItemId).toBeUndefined();
			const activity = await ctx.db
				.query('threadActivity')
				.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', threadId))
				.collect();
			expect(activity).toHaveLength(0);
			expect(await ctx.db.query('threadItemCorrections').collect()).toHaveLength(0);
		});
	});
});
