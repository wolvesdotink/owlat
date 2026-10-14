/**
 * The stale fence (#1320, `staleFence.ts`) at the boundaries Sol's round 5
 * found open, each shown leaking before the fence and closed after it:
 *
 *   - the Daily Brief email reads digest snapshots taken before the fence;
 *   - an arrival draft written from the old plan, late or already stored;
 *   - a stored reply-plan check (coverage, claims, promises) and a late one;
 *   - "Export my data" labels a fenced thread's interpretation as paused;
 *   - the team stream's notes keep their item reference, not its text;
 *
 * and the two AI draft paths round 6 found: the clarification card's draft,
 * and an Answer mode "Draft with AI" stream that started before the fence.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { captureInterpretSource } from '../sources';
import { fenceThreadInterpretation } from '../staleFence';
import { sourceVersionOf } from '../sourceVersion';
import { modules, reduceResult, seedMailThread, type Test } from './interpret.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
		requireSelf: vi.fn(async () => session),
		getUserIdFromSession: vi.fn(async () => session.userId),
	};
});

const SUMMARY = 'Pay account 999 today';
const STALE_DRAFT = 'I will pay account 999.';

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/** An interpreted Postbox thread in the Reply Queue, its flag carrying the model's summary. */
async function seedThread(t: Test) {
	const { mailboxId, messageId, threadId } = await seedMailThread(t);
	const source = { kind: 'mail' as const, id: messageId };
	await t.run((ctx) => captureInterpretSource(ctx, { source, isLive: true }));
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source,
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 2,
		sourceAt: Date.now(),
		direction: 'inbound',
		status: 'complete',
		result: reduceResult(),
		sourceVersion: (await t.run((ctx) => sourceVersionOf(ctx, source)))!,
		deletionEpoch: 0,
		expectedRevision: 0,
	});
	await t.run((ctx) =>
		ctx.db.patch(threadId, {
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'high',
				askSummary: SUMMARY,
				detectedAt: Date.now(),
			},
		})
	);
	const items = await t.run((ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);
	return { mailboxId, messageId, threadId, itemId: items[0]!._id };
}

const fence = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run((ctx) => fenceThreadInterpretation(ctx, threadId));

/** Put an arrival draft on the flag as stored, whatever the fence (a raced write). */
const storeSlot = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) => {
		const thread = (await ctx.db.get(threadId))!;
		await ctx.db.patch(threadId, {
			needsReply: {
				...thread.needsReply!,
				draftSlot: { draft: STALE_DRAFT, confidence: 0.9, generatedAt: Date.now() },
			},
		});
	});

describe('the stale fence at the boundaries round 5 found open', () => {
	it('drops the model summary from a digest snapshot taken before the fence', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedThread(t);
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				dailyBriefEmail: {
					enabled: true,
					minute: Math.floor((now % 86_400_000) / 60_000),
					utcOffsetMinutes: 0,
				},
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.mutation(internal.mail.dailyBrief.buildForMailbox, { mailboxId });
		const subtitle = async () => {
			const due = await t.query(internal.mail.briefEmail.listDue, { now });
			return due[0]?.items[0]?.subtitle;
		};
		expect(await subtitle()).toBe(SUMMARY);

		await fence(t, threadId);

		const due = await t.query(internal.mail.briefEmail.listDue, { now });
		expect(due[0]?.items).toHaveLength(1);
		expect(due[0]?.items[0]?.subtitle).toBeUndefined();
		expect(JSON.stringify(due)).not.toContain('999');
	});

	it('neither keeps nor shows an arrival draft written from the old plan', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedThread(t);
		await storeSlot(t, threadId);
		const slot = () => t.query(api.mail.needsReply.getDraftSlot, { threadId });
		const queued = async () =>
			(await t.query(api.mail.needsReply.listQueue, { mailboxId })).items.find(
				(i) => i.threadId === threadId
			);
		expect((await slot())?.draft).toBe(STALE_DRAFT);
		expect((await queued())?.hasDraftSlot).toBe(true);

		await fence(t, threadId);
		// The fence drops the stored one; a late write of one is refused.
		await t.mutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId,
			triggerMessageId: messageId,
			draft: STALE_DRAFT,
			confidence: 0.9,
		});
		expect((await t.run((ctx) => ctx.db.get(threadId)))!.needsReply?.draftSlot).toBeUndefined();
		// One that slipped in anyway is never shown.
		await storeSlot(t, threadId);
		expect(await slot()).toBeNull();
		expect((await queued())?.hasDraftSlot).toBe(false);
		const thread = await t.query(api.mail.mailbox.messages.listThreadMessages, { messageId });
		expect(thread?.thread?.needsReply?.draftSlot).toBeUndefined();
	});

	it('hides a stored plan check and refuses a late one', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(t);
		await storeSlot(t, threadId);
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('draftResponsePlans', {
				threadKind: 'mail',
				mailThreadId: threadId,
				draftKind: 'arrivalDraft',
				threadRevision: 1,
				itemRevisions: [],
				stances: [],
				ownerInputs: [],
				coverage: [],
				newPromises: [],
				fileClaims: [],
				draftHash: 'h',
				verdict: 'covered',
				planRevision: 0,
				checkedPlanRevision: 0,
				createdAt: now,
				updatedAt: now,
			})
		);
		const threadRef = { kind: 'mail' as const, id: threadId };
		const draftRef = { kind: 'arrivalDraft' as const, id: threadId };
		const view = () => t.query(api.mail.interpret.responsePlan.get, { threadRef, draftRef });
		expect((await view())?.checkedThreadRevision).toBe(1);

		await fence(t, threadId);
		await storeSlot(t, threadId);

		const fenced = await view();
		expect(fenced?.checkedThreadRevision).toBeUndefined();
		expect(fenced?.verdict).toBe('pending');
		expect(fenced?.coverage).toEqual([]);
		expect(fenced?.newPromises).toEqual([]);
		const late = await t.mutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
			threadRef,
			draftRef,
			threadRevision: 1,
			itemRevisions: [],
			stances: [],
			coverage: [],
			fileClaims: [],
			newPromises: [],
			draftHash: 'h2',
			verdict: 'covered',
			planRevision: 0,
			deletionEpoch: 0,
			attachmentSetHash: '',
			isCheckIncomplete: false,
		});
		expect(late).toEqual({ isStored: false });
	});

	it("labels a fenced thread's exported interpretation as paused, on every page", async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedThread(t);
		const exportRows = async () => {
			const rows: Array<Record<string, unknown>> = [];
			let cursor: string | null = null;
			for (let page = 0; page < 20; page++) {
				const result: { page: unknown[]; isDone: boolean; continueCursor: string } = await t.query(
					internal.auth.accountExportThreadBriefQueries.listMailboxThreadBriefs,
					{
						userId: 'user-A',
						mailboxId,
						paginationOpts: { numItems: 1, cursor },
					}
				);
				rows.push(...(result.page as Array<Record<string, unknown>>));
				if (result.isDone) break;
				cursor = result.continueCursor;
			}
			return rows.filter((r) => r['threadId'] === threadId);
		};
		const before = await exportRows();
		expect(before.map((r) => r['kind'])).toEqual(
			expect.arrayContaining(['thread', 'item', 'activity'])
		);
		for (const row of before) expect(row['isInterpretationPaused']).toBeUndefined();

		await fence(t, threadId);

		const after = await exportRows();
		// Complete, as stored: the same rows, each labelled.
		expect(after.map((r) => r['kind'])).toEqual(before.map((r) => r['kind']));
		for (const row of after) {
			expect(row['isInterpretationPaused']).toBe(true);
			expect(row['interpretationStaleSince']).toBeTypeOf('number');
		}
	});

	it("keeps a note's item reference but not the item's text", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		const { threadId, itemId } = await seedThread(t);
		const now = Date.now();
		await t.run(async (ctx) => {
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel',
				name: 'Invoice',
				normalizedName: `mail-thread-${threadId}`,
				visibility: 'private',
				createdBy: 'user-A',
				purpose: 'mail_thread_discussion',
				linkedMailThreadId: threadId,
				createdAt: now,
				updatedAt: now,
				lastMessageAt: now,
				messageCount: 1,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'user-A',
				text: 'Is this right?',
				threadItemId: itemId,
				createdAt: now,
			});
		});
		const note = async () =>
			(await t.query(api.mail.interpret.teamStream.page, { threadId, locale: 'en' }))?.entries.find(
				(e) => e.kind === 'note'
			) as Record<string, unknown> | undefined;
		expect((await note())?.['threadItemText']).toBeTypeOf('string');

		await fence(t, threadId);

		const fenced = await note();
		expect(fenced?.['body']).toBe('Is this right?');
		expect(fenced?.['threadItemId']).toBe(itemId);
		expect(fenced?.['threadItemText']).toBeUndefined();
	});

	it("strips the clarification card's AI draft, refuses a late one, and keeps the answers", async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedThread(t);
		const answeredAt = Date.now();
		const answer = { value: 'Use the usual one', at: answeredAt };
		await t.run(async (ctx) => {
			const thread = (await ctx.db.get(threadId))!;
			await ctx.db.patch(threadId, {
				needsReply: {
					...thread.needsReply!,
					clarification: {
						isNeeded: false,
						questions: [{ id: 'q1', slotType: 'text', text: 'Which account?', answer }],
						askedAt: answeredAt - 1,
						answeredAt,
						draft: STALE_DRAFT,
					},
				},
			});
		});
		const prepared = () => t.query(api.mail.needsReplyPrepared.getPreparedDraft, { threadId });
		expect((await prepared())?.clarificationDraft).toBe(STALE_DRAFT);

		await fence(t, threadId);
		const stored = async () =>
			(await t.run((ctx) => ctx.db.get(threadId)))!.needsReply!.clarification!;
		expect((await stored()).draft).toBeUndefined();
		expect((await stored()).questions[0]!.answer).toEqual(answer);
		expect((await stored()).answeredAt).toBe(answeredAt);

		// A draft (or new gap questions) written from before the fence lands nowhere.
		const guard = { threadId, expectedAnsweredAt: answeredAt };
		await t.mutation(internal.mail.ai.needsReplyClarify.persistClarificationDraft, {
			...guard,
			draft: STALE_DRAFT,
		});
		await t.mutation(internal.mail.ai.needsReplyClarify.askAboutDraftGaps, {
			...guard,
			questions: [{ id: 'q2', slotType: 'text', text: 'Which account number?' }],
		});
		expect((await stored()).draft).toBeUndefined();
		expect((await stored()).questions.map((q) => q.id)).toEqual(['q1']);

		// One that slipped in anyway is never shown; the answers are.
		await t.run(async (ctx) => {
			const thread = (await ctx.db.get(threadId))!;
			const flag = thread.needsReply!;
			await ctx.db.patch(threadId, {
				needsReply: { ...flag, clarification: { ...flag.clarification!, draft: STALE_DRAFT } },
			});
		});
		const shown = await prepared();
		// The card says the AI reply is paused, rather than waiting for one.
		expect(shown?.clarification?.isPaused).toBe(true);
		expect(shown?.clarificationDraft).toBeNull();
		expect(shown?.slotDraft).toBeNull();
		expect(shown?.clarification?.questions[0]?.answer).toEqual(answer);
		const queued = (await t.query(api.mail.needsReply.listQueue, { mailboxId })).items.find(
			(i) => i.threadId === threadId
		);
		expect(queued?.clarification?.draft).toBeUndefined();
		expect(JSON.stringify(shown)).not.toContain('999');
	});

	it('keeps nothing of a Draft with AI stream that started before the fence', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedThread(t);
		const now = Date.now();
		const OWN = '<p>My own words.</p>';
		const { draftId, sessionId } = await t.run(async (ctx) => {
			const draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				threadId,
				toAddresses: ['jonas@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@owlat.test',
				subject: 'Re: invoice',
				bodyHtml: OWN,
				attachments: [],
				state: 'draft' as const,
				lastEditedAt: now,
				createdAt: now,
			});
			const sessionId = await ctx.db.insert('answerAskSessions', {
				ownerId: 'user-A',
				organizationId: 'org-1',
				target: { kind: 'mailDraft', draftId },
				targetKey: `mailDraft:${draftId}`,
				locale: 'en',
				round: 1,
				status: 'drafting',
				questions: [{ id: 'q1', slotType: 'text', text: 'Which account?' }],
				attachedFiles: [],
				createdAt: now,
				updatedAt: now,
			});
			return { draftId, sessionId };
		});
		const target = { kind: 'mailDraft' as const, draftId };
		const streamId = await t.mutation(internal.mail.ai.composeDraftStore.openSessionStream, {
			sessionId,
		});
		const read = () => t.query(api.mail.draftStreamStore.getDraftStream, { streamId });
		await t.mutation(internal.mail.draftStreamStore.appendDraftStream, {
			streamId,
			text: 'I will pay',
		});
		expect((await read())?.text).toBe('I will pay');

		await fence(t, threadId);

		// Still running: told to stop. Finalized: kept as nothing.
		expect(
			await t.mutation(internal.mail.draftStreamStore.appendDraftStream, {
				streamId,
				text: 'I will pay account 999',
			})
		).toEqual({ stop: true });
		await t.mutation(internal.mail.draftStreamStore.finalizeDraftStream, {
			streamId,
			text: STALE_DRAFT,
			status: 'complete',
		});
		const row = (await t.run((ctx) => ctx.db.get(streamId)))!;
		expect(row).toMatchObject({ status: 'error', text: '', errorMessage: 'draft_paused_stale' });
		expect(await read()).toMatchObject({
			status: 'error',
			text: '',
			errorMessage: 'draft_paused_stale',
		});
		const view = await t.query(api.mail.ai.composeDraftStore.getSession, { target });
		expect(view).toMatchObject({ status: 'error', questions: [], streamId });
		// The person's own draft is untouched.
		expect((await t.run((ctx) => ctx.db.get(draftId)))!.bodyHtml).toBe(OWN);
	});

	it('pauses an Answer stream opened the old way (no thread on it) and one with no session', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedThread(t);
		const now = Date.now();
		// Inserted as a release before the fence opened them: the stream carries
		// no thread, only its session knows it.
		const { legacyId, orphanId } = await t.run(async (ctx) => {
			const draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				threadId,
				toAddresses: ['jonas@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@owlat.test',
				subject: 'Re: invoice',
				bodyHtml: '<p></p>',
				attachments: [],
				state: 'draft' as const,
				lastEditedAt: now,
				createdAt: now,
			});
			const stream = {
				ownerId: 'user-A',
				surface: 'answer' as const,
				status: 'streaming' as const,
				text: '',
				createdAt: now,
				updatedAt: now,
			};
			const legacyId = await ctx.db.insert('aiDraftStreams', stream);
			const orphanId = await ctx.db.insert('aiDraftStreams', stream);
			await ctx.db.insert('answerAskSessions', {
				ownerId: 'user-A',
				organizationId: 'org-1',
				target: { kind: 'mailDraft', draftId },
				targetKey: `mailDraft:${draftId}`,
				locale: 'en',
				round: 1,
				status: 'drafting',
				questions: [],
				streamId: legacyId,
				attachedFiles: [],
				createdAt: now,
				updatedAt: now,
			});
			return { legacyId, orphanId };
		});
		const finalize = (streamId: Id<'aiDraftStreams'>) =>
			t.mutation(internal.mail.draftStreamStore.finalizeDraftStream, {
				streamId,
				text: STALE_DRAFT,
				status: 'complete',
			});
		const read = (streamId: Id<'aiDraftStreams'>) =>
			t.query(api.mail.draftStreamStore.getDraftStream, { streamId });

		// Before the fence, the session's stream is an ordinary draft.
		await t.mutation(internal.mail.draftStreamStore.appendDraftStream, {
			streamId: legacyId,
			text: 'I will pay',
		});
		expect((await read(legacyId))?.text).toBe('I will pay');

		await fence(t, threadId);
		await finalize(legacyId);
		expect(await read(legacyId)).toMatchObject({
			status: 'error',
			text: '',
			errorMessage: 'draft_paused_stale',
		});
		// An Answer stream no session owns cannot be tied to a thread: it fails closed.
		await finalize(orphanId);
		expect(await read(orphanId)).toMatchObject({ status: 'error', text: '' });
	});
});
