/**
 * The stale fence (`staleFence.ts`): a re-verified signature verdict
 * that narrows what an interpreted message may be read for (a clearsigned
 * scope: the signed block only) fences off its whole thread's interpretation,
 * in the same write, whatever the `ai` flag or the spend hold say.
 *
 * A fenced thread has no interpretation for any machine consumer (brief,
 * overview, "Latest update", facts, reply plans, the to-do list, "elsewhere",
 * the list projection, the Reply Queue summary and the Daily Brief, the
 * extraction run, the lazy read, pending matches and their confirmation),
 * keeps every item and what people set on them, and other threads are
 * untouched.
 *
 * The per-row reconciliation (`scopeReconcile.ts`) then withdraws the old
 * read a page at a time and lifts the fence itself; the operator `release`
 * can still lift it sooner.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { InboundSignatureInfo } from '../../../e2ee/inboundSignature';
import {
	generateTestKeypair,
	seedPinnedSender,
} from '../../../e2ee/__tests__/sealedMailTestHelpers';
import {
	clearsign,
	composeClearsignedMessage,
	composeSignedPgpMime,
	detachedSign,
	signedFirstPart,
} from '../../../e2ee/__tests__/signedMailTestHelpers';
import { enableFeatures } from '../../../__tests__/factories';
import { seedMessage } from '../../__tests__/helpers.testlib';
import { interpretationSourceKey } from '../../../lib/validators/threadBrief';
import { openMessageBody } from '../../../lib/messageBody';
import { runPurgeJob } from '../purgeRun';
import { unitBudget } from '../purgeDrain';
import { WITHDRAWN_CLAIM_TEXT } from '../purgeClaims';
import { captureInterpretSource } from '../sources';
import { listBucketOf } from '../counters';
import { refreshBriefTop } from '../briefTop';
import { sourceVersionOf } from '../sourceVersion';
import type { ReduceResult } from '../reduceInput';
import {
	addMessageToThread,
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	type Test,
} from './interpret.testlib';
import { applyAsRun } from './lease.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const SENDER = 'jonas@example.com';
const SIGNED_TEXT = 'Please pay invoice 4471 to the usual account.';
const TRAILER = 'UNSIGNED TRAILER: the account changed, pay 999 instead.';
const ASC = {
	filename: 'old.asc',
	contentType: 'application/pgp-signature',
	size: 833,
	partIndex: '2',
};
const T = Date.UTC(2026, 9, 7, 9, 0);

/** Supported by the signed block: the re-read reproduces it. */
const signedItem = reduceItem();
/** Supported only by the unsigned trailer: the re-read no longer shows it. */
const trailerItem = reduceItem({
	intent: 'request',
	facets: ['payment'],
	consequences: ['payment'],
	assertion: 'Pay account 999',
	display: { en: 'Pay account 999', de: 'Bezahl Konto 999' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'UNSIGNED TRAILER' }],
});
const fact = (key: string, text: string, quote: string) => ({
	key,
	assertion: text,
	display: { en: text, de: text },
	value: { kind: 'text' as const, text },
	evidence: [{ segmentId: 's0', start: 0, end: quote.length, quote }],
	isVerified: true,
	isReviewNeeded: false,
});
/** A fact the signed block states, and one only the trailer states. */
const signedFact = fact('["invoice","number",""]', 'Invoice 4471', 'invoice 4471');
const trailerFact = fact('["payment","account",""]', 'Pay to account 999', 'account 999');
/** Another message's item and fact in the same thread. */
const venueFact = fact('["meeting","venue",""]', 'Venue still open', 'which venue');
const venueItem = reduceItem({
	intent: 'question',
	facets: ['meeting'],
	consequences: [],
	assertion: 'Confirm the venue',
	display: { en: 'Confirm the venue', de: 'Bestätig den Ort' },
	due: undefined,
	evidence: [{ segmentId: 's0', start: 0, end: 12, quote: 'which venue?' }],
});

/** Everything a person can set on an item: completion, a confirmation, a reminder. */
const HUMAN: Pick<
	Doc<'threadItems'>,
	'status' | 'completion' | 'correction' | 'remindAt' | 'confirmedFrom'
> = {
	status: 'done',
	completion: 'asserted',
	correction: { by: 'user-A', at: T + 1, kind: 'confirmed' },
	remindAt: T + 86_400_000,
	confirmedFrom: {
		kind: 'proposal',
		confirmation: { by: 'user-A', at: T + 1, kind: 'confirmed' },
		verify: 'passed',
		addedEvidenceKeys: [],
	},
};

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	// The reconciliation is scheduled: each test drives it ({@link reconcile}).
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

/** Run what is scheduled: the withdraw job's walk to its end, and what it schedules. */
const reconcile = (t: Test) => t.finishAllScheduledFunctions(vi.runAllTimers);

/**
 * An interpreted Postbox message as an older release left it: a clearsigned
 * text body with an unsigned trailer, an unrelated `.asc` attachment (so the
 * old read took the whole body), an unscoped verified verdict, and the raw
 * message the verifier reads.
 */
async function seedLegacy(t: Test, opts: { mime?: boolean } = {}) {
	const { mailboxId, messageId, threadId } = await seedMailThread(t);
	const sender = await generateTestKeypair(SENDER);
	await seedPinnedSender(t, {
		address: SENDER,
		domain: 'example.com',
		pinnedPublicKeyArmored: sender.publicKeyArmored,
	});
	const armor = await clearsign(SIGNED_TEXT, sender.privateKeyArmored);
	let raw: string;
	if (opts.mime) {
		const part = signedFirstPart(SIGNED_TEXT);
		raw = composeSignedPgpMime({
			from: SENDER,
			to: 'me@owlat.test',
			subject: 'Invoice',
			part,
			signatureArmored: await detachedSign(part, sender.privateKeyArmored),
			messageId: '<reread-mime@example.com>',
		});
	} else {
		raw = composeClearsignedMessage({
			from: SENDER,
			to: 'me@owlat.test',
			subject: 'Invoice',
			clearsignArmor: armor,
			messageId: '<reread-clear@example.com>',
		});
	}
	const legacy: InboundSignatureInfo = {
		isSigned: true,
		isSignatureValid: true,
		signerFingerprint: sender.fingerprint,
		keySource: 'pinned',
	};
	await t.run(async (ctx) => {
		const rawStorageId = await ctx.storage.store(new Blob([Buffer.from(raw, 'latin1')]));
		await ctx.db.patch(messageId, {
			rawStorageId,
			textBodyInline: opts.mime ? SIGNED_TEXT : `${armor.trim()}\n\n${TRAILER}`,
			attachments: opts.mime ? [] : [ASC],
			hasAttachments: !opts.mime,
			inboundSignatureInfo: legacy,
		});
		await captureInterpretSource(ctx, { source: { kind: 'mail', id: messageId }, isLive: true });
	});
	// The enqueue snapshot marks it outstanding; the cached read below records it.
	return { mailboxId, messageId, threadId };
}

/** Read the message as the old release did and record it; returns the thread's version etc. */
async function interpret(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	opts: {
		contentRevision: string;
		result?: ReduceResult;
		status?: 'complete' | 'failed';
		errorCode?: string;
	}
) {
	const brief = await t.run((ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);
	return applyAsRun(t, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: opts.contentRevision,
		extractorVersion: 2,
		sourceAt: T,
		direction: 'inbound',
		status: opts.status ?? 'complete',
		...(opts.result ? { result: opts.result } : {}),
		...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
		...(opts.errorCode === 'budget'
			? { budgetRefusal: { reason: 'monthly_ceiling' as const, limit: 'interpret' } }
			: {}),
		sourceVersion: (await t.run((ctx) => sourceVersionOf(ctx, { kind: 'mail', id: messageId })))!,
		deletionEpoch: brief?.deletionEpoch ?? 0,
		expectedRevision: brief?.interpretationRevision ?? 0,
	});
}

/** A thread read by the old release, with what people set on its items and the caches it feeds. */
async function seedInterpreted(t: Test) {
	const { mailboxId, messageId, threadId } = await seedLegacy(t);
	await interpret(t, messageId, threadId, {
		contentRevision: 'rev-old-read',
		result: reduceResult({ items: [signedItem, trailerItem], facts: [signedFact, trailerFact] }),
	});
	await t.run(async (ctx) => {
		const items = await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect();
		for (const item of items) {
			// The list projection follows the status, as the write path keeps it.
			await ctx.db.patch(item._id, { ...HUMAN, listBucket: listBucketOf({ ...item, ...HUMAN }) });
		}
		await ctx.db.patch(threadId, {
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'high',
				askSummary: 'Pay account 999 today',
				detectedAt: T,
			},
		});
		await refreshBriefTop(ctx, threadId, { latest: { en: 'Pay 999', de: 'Zahl 999' } });
	});
	return { mailboxId, messageId, threadId };
}

/** Another thread of the same mailbox, read the ordinary way. */
async function seedOtherThread(t: Test, mailboxId: Id<'mailboxes'>) {
	const otherId = await seedMessage(t, mailboxId, {
		subject: 'Venue',
		fromAddress: SENDER,
		textBodyInline: 'Which venue do we use?',
	});
	const otherThreadId = await t.run(async (ctx) => (await ctx.db.get(otherId))!.threadId);
	await t.run((ctx) =>
		captureInterpretSource(ctx, { source: { kind: 'mail', id: otherId }, isLive: true })
	);
	await interpret(t, otherId, otherThreadId, {
		contentRevision: 'rev-venue',
		result: reduceResult({ items: [venueItem], facts: [venueFact] }),
	});
	return { otherId, otherThreadId };
}

/** What every machine consumer makes of a thread. */
async function consumersOf(
	t: Test,
	mailboxId: Id<'mailboxes'>,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>
) {
	const threadRef = { kind: 'mail' as const, id: threadId };
	const brief = await t.query(api.mail.interpret.brief.get, { threadRef, locale: 'en' });
	const plan = await t.query(internal.mail.interpret.responsePlanDraft.loadForDraft, { threadRef });
	const todo = await t.query(api.mail.interpret.todo.listNoReplyToDo, { mailboxId });
	const queue = await t.query(api.mail.needsReply.listQueue, { mailboxId });
	await t.mutation(internal.mail.dailyBrief.buildForMailbox, { mailboxId });
	const daily = await t.run(async (ctx) => {
		const briefs = await ctx.db.query('mailDailyBriefs').collect();
		return briefs[briefs.length - 1];
	});
	const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
	return {
		thread,
		brief: brief!,
		planItems: plan.items.length,
		isInToDo: todo.rows.some((r) => r.threadId === threadId),
		queueSummary: queue.items.find((i) => i.threadId === threadId)?.askSummary,
		dailySubtitle: daily?.items.find((i) => i.threadId === threadId)?.subtitle,
		isRunSkipped: await t.query(internal.mail.interpret.staleFence.isSourceFenced, {
			source: { kind: 'mail', id: messageId },
		}),
	};
}

async function itemsOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run((ctx) =>
		ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);
}

function expectFenced(c: Awaited<ReturnType<typeof consumersOf>>, items: Doc<'threadItems'>[]) {
	expect(c.thread.interpretationStaleSince).toBeTypeOf('number');
	// The brief: the items with what people set on them, nothing the model derived.
	expect(c.brief.gap?.reason).toBe('stale');
	expect(c.brief.mode === 'brief' && c.brief.standing).toBeFalsy(); // facts, overview
	expect(c.brief.activity).toEqual([]);
	expect(c.brief.mode === 'brief' && c.brief.latest).toBeFalsy();
	expect(c.brief.mode === 'brief' && c.brief.messageLatest).toBeFalsy();
	expect(items).toHaveLength(2);
	for (const item of items) expect(item).toMatchObject(HUMAN);
	// Reply plans, the to-do list, the list projection, the summaries, the run.
	expect(c.planItems).toBe(0);
	expect(c.isInToDo).toBe(false);
	expect(c.thread.briefTop).toBeUndefined();
	expect(c.thread.needsReply?.askSummary).toBeUndefined();
	expect(c.thread.needsReply).toMatchObject({ urgency: 'high' });
	expect(c.queueSummary).toBeUndefined();
	expect(c.dailySubtitle).toBe(SENDER);
	expect(c.isRunSkipped).toBe(true);
}

describe('the stale fence (#1320)', () => {
	it('fences the thread off at once when AI is off', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedInterpreted(t);
		expect((await consumersOf(t, mailboxId, messageId, threadId)).dailySubtitle).toBe(
			'Pay account 999 today'
		);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		expectFenced(await consumersOf(t, mailboxId, messageId, threadId), await itemsOf(t, threadId));
		// Nothing reads it again; a lazy open says why.
		expect(
			await t.mutation(api.mail.interpret.lazy.ensure, {
				threadRef: { kind: 'mail', id: threadId },
			})
		).toEqual({ isEnqueued: false, reason: 'fenced' });
	});

	it('stays fenced when a read is refused by the spend hold, and through later writes', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai']);
		const { mailboxId, messageId, threadId } = await seedInterpreted(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		// A run already past the fence check is refused by the spend hold and records that.
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-signed-block',
			status: 'failed',
			errorCode: 'budget',
		});
		// Nothing of it is written to the fenced thread, not even the failure.
		const attempts = await t.run((ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.collect()
		);
		expect(attempts.map((a) => a.contentRevision)).toEqual(['rev-old-read']);
		// A projection write of a run in flight brings no summary back.
		await t.run(async (ctx) => {
			await refreshBriefTop(ctx, threadId, { latest: { en: 'Pay 999', de: 'Zahl 999' } });
		});
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId,
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'high',
				askSummary: 'Pay account 999 today',
			},
		});

		expectFenced(await consumersOf(t, mailboxId, messageId, threadId), await itemsOf(t, threadId));
	});

	it('proposes no pending match and confirms nothing the model proposed', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedInterpreted(t);
		const items = await itemsOf(t, threadId);
		await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.first();
			await ctx.db.patch(brief!._id, { pendingMatchRuns: 1 });
			const proposal = { ...items[0]!, verify: 'proposal' as const };
			await ctx.db.patch(items[0]!._id, { verify: 'proposal', listBucket: listBucketOf(proposal) });
			const open = { ...items[1]!, status: 'open' as const };
			await ctx.db.patch(items[1]!._id, {
				status: 'open',
				completion: undefined,
				listBucket: listBucketOf(open),
			});
		});
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		await t.mutation(internal.mail.interpret.pendingMatch.matchPendingTransitions, {
			threadRef: { kind: 'mail', id: threadId },
			itemIds: items.map((i) => i._id),
			sourceKey: 'mail:other',
			deletionEpoch: 0,
		});
		const after = await itemsOf(t, threadId);
		for (const item of after) expect(item.pendingUpdate).toBeUndefined();
		expect(
			(await t.run((ctx) =>
				ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
					.first()
			))!.pendingMatchRuns
		).toBeUndefined();
		await expect(
			t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: items[0]!._id })
		).rejects.toThrow(/suggestions are paused/);
		// What a person decides alone still works.
		await t.mutation(api.mail.interpret.reactions.remind, {
			itemId: items[1]!._id,
			remindAt: Date.now() + 2 * 86_400_000,
		});
	});

	it('fences a thread with more than 500 items whole', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedInterpreted(t);
		await t.run(async (ctx) => {
			const [first] = await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.take(1);
			const { _id, _creationTime, ...item } = first!;
			for (let i = 0; i < 520; i++) {
				await ctx.db.insert('threadItems', {
					...item,
					status: 'open',
					verify: 'passed',
					correction: undefined,
					completion: undefined,
					confirmedFrom: undefined,
					listBucket: listBucketOf({ ...item, status: 'open', verify: 'passed' }),
					askedAt: T + i,
				});
			}
		});
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const c = await consumersOf(t, mailboxId, messageId, threadId);
		expect(c.brief.gap?.reason).toBe('stale');
		expect(c.brief.mode === 'brief' && c.brief.standing).toBeFalsy();
		expect(c.planItems).toBe(0);
		expect(c.isInToDo).toBe(false);
		expect(c.thread.briefTop).toBeUndefined();

		// The walk pages through every row; the fence holds until its last page.
		const jobId = (await withdrawJobOf(t, threadId))!._id;
		let slices = 0;
		for (let isDone = false; !isDone; slices++) {
			isDone = await t.run((ctx) => runPurgeJob(ctx, jobId, unitBudget(100)));
			const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
			expect(thread.interpretationStaleSince === undefined).toBe(isDone);
		}
		expect(slices).toBeGreaterThan(5);
		const items = await itemsOf(t, threadId);
		expect(items).toHaveLength(522);
		expect(items.filter((i) => i.withdrawal !== undefined)).toHaveLength(522);
		expect(items.every((i) => i.verify === 'proposal' && i.evidence.length === 0)).toBe(true);
	});

	it('leaves other threads alone', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId } = await seedInterpreted(t);
		const { otherId, otherThreadId } = await seedOtherThread(t, mailboxId);
		const before = await consumersOf(t, mailboxId, otherId, otherThreadId);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const after = await consumersOf(t, mailboxId, otherId, otherThreadId);
		expect(after.thread.interpretationStaleSince).toBeUndefined();
		expect(after.brief.gap?.reason).not.toBe('stale');
		expect(after.brief.mode === 'brief' && after.brief.standing?.facts.length).toBeGreaterThan(0);
		expect(after.planItems).toBe(before.planItems);
		expect(after.thread.briefTop).toEqual(before.thread.briefTop);
		expect(after.isRunSkipped).toBe(false);
	});

	it('the operator can still lift the fence before the walk is done, changing nothing else', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedInterpreted(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		const items = await itemsOf(t, threadId);

		expect(await t.mutation(internal.mail.interpret.staleFence.release, { threadId })).toBe(true);
		expect(await t.mutation(internal.mail.interpret.staleFence.release, { threadId })).toBe(false);

		const c = await consumersOf(t, mailboxId, messageId, threadId);
		expect(c.thread.interpretationStaleSince).toBeUndefined();
		expect(c.brief.gap?.reason).not.toBe('stale');
		expect(c.isRunSkipped).toBe(false);
		expect(await itemsOf(t, threadId)).toEqual(items);
	});

	it('does not fence when the new scope reads the body as it was (MIME)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t, { mime: true });
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({ items: [signedItem] }),
		});
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
		expect(thread.interpretationStaleSince).toBeUndefined();
	});

	it('fences a thread whose narrowed message was read as sent (history)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		// Filed in Sent and read by the history pass: an `outboundMail:` source only.
		const source = { kind: 'outboundMail' as const, id: messageId };
		await applyAsRun(t, {
			source,
			threadRef: { kind: 'mail', id: threadId },
			mode: 'brief',
			contentRevision: 'rev-sent',
			extractorVersion: 2,
			sourceAt: T,
			direction: 'outbound',
			status: 'complete',
			result: reduceResult({ items: [trailerItem] }),
			sourceVersion: (await t.run((ctx) => sourceVersionOf(ctx, source)))!,
			deletionEpoch: 0,
			expectedRevision: 0,
		});

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });

		const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
		expect(thread.interpretationStaleSince).toBeTypeOf('number');
		expect(await t.query(internal.mail.interpret.staleFence.isSourceFenced, { source })).toBe(true);
	});

	it('does not fence a thread the message never contributed to', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		const thread = (await t.run((ctx) => ctx.db.get(threadId)))!;
		expect((await t.run((ctx) => ctx.db.get(messageId)))!.inboundSignatureInfo).toMatchObject({
			scope: 'clearsigned',
		});
		expect(thread.interpretationStaleSince).toBeUndefined();
	});
});

async function withdrawJobOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run((ctx) =>
		ctx.db
			.query('threadPurgeJobs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);
}

const T2 = T + 3_600_000;

/**
 * A thread of two messages: the narrowed one's old read made `signedItem`
 * (confirmed by a person, with a reminder) and `trailerItem`, and two facts;
 * a later message made `venueItem` and its fact. The Reply Queue flag carries
 * the model's summary.
 */
async function seedTwoMessages(t: Test) {
	const { mailboxId, messageId, threadId } = await seedLegacy(t);
	await interpret(t, messageId, threadId, {
		contentRevision: 'rev-old-read',
		result: reduceResult({ items: [signedItem, trailerItem], facts: [signedFact, trailerFact] }),
	});
	const signedId = (await itemsOf(t, threadId)).find((i) => i.amount === undefined && i.due)!._id;
	await t.run(async (ctx) => {
		await ctx.db.patch(signedId, {
			correction: { by: 'user-A', at: T + 1, kind: 'confirmed' },
			remindAt: T + 86_400_000,
		});
		await ctx.db.patch(threadId, {
			needsReply: {
				messageId,
				source: 'llm',
				urgency: 'high',
				askSummary: 'Pay account 999 today',
				detectedAt: T,
			},
		});
	});
	const otherId = await addMessageToThread(
		t,
		{ mailboxId, threadId },
		{ text: 'Which venue do we use?', receivedAt: T2 }
	);
	await t.run((ctx) =>
		captureInterpretSource(ctx, { source: { kind: 'mail', id: otherId }, isLive: true })
	);
	await interpretOther(
		t,
		otherId,
		threadId,
		reduceResult({ items: [venueItem], facts: [venueFact] })
	);
	return { mailboxId, messageId, threadId, otherId, signedId };
}

/** A read of another message of the thread, as a run records it now. */
async function interpretOther(
	t: Test,
	messageId: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	result: ReduceResult,
	contentRevision = 'rev-other'
) {
	const source = { kind: 'mail' as const, id: messageId };
	const brief = await t.run((ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);
	return applyAsRun(t, {
		source,
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision,
		extractorVersion: 2,
		sourceAt: T2,
		direction: 'inbound',
		status: 'complete',
		result,
		sourceVersion: (await t.run((ctx) => sourceVersionOf(ctx, source)))!,
		deletionEpoch: brief!.deletionEpoch,
		expectedRevision: brief!.interpretationRevision,
	});
}

async function itemById(t: Test, id: Id<'threadItems'>) {
	return (await t.run((ctx) => ctx.db.get(id)))!;
}

async function factTexts(t: Test, threadId: Id<'mailThreads'>) {
	const facts = await t.run((ctx) =>
		ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);
	return Promise.all(facts.map((f) => openMessageBody(f.display.en)));
}

describe('per-row reconciliation of a narrowed read', () => {
	it('withdraws what the read alone supported, keeps the rest, and lifts the fence itself', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId, signedId } = await seedTwoMessages(t);
		const items = await itemsOf(t, threadId);
		const trailerId = items.find((i) => i._id !== signedId && i.intent === 'request')!._id;
		const venueId = items.find((i) => i.intent === 'question')!._id;

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		expect((await t.run((ctx) => ctx.db.get(threadId)))!.interpretationStaleSince).toBeTypeOf(
			'number'
		);
		await reconcile(t);

		const c = await consumersOf(t, mailboxId, messageId, threadId);
		expect(c.thread.interpretationStaleSince).toBeUndefined();
		expect(await withdrawJobOf(t, threadId)).toBeNull();
		expect(c.isRunSkipped).toBe(false);
		expect(c.brief.gap?.reason).not.toBe('stale');

		// The read's items stay with what people set, out of every machine path.
		const signed = await itemById(t, signedId);
		expect(signed).toMatchObject({
			verify: 'proposal',
			evidence: [],
			remindAt: T + 86_400_000,
			withdrawal: {
				messageId,
				verify: 'passed',
				confirmation: { by: 'user-A', kind: 'confirmed' },
			},
		});
		expect(signed.correction).toBeUndefined();
		expect((await itemById(t, trailerId)).withdrawal).toMatchObject({ messageId });
		// The other message's item and fact are untouched; the read's facts are gone.
		const venue = await itemById(t, venueId);
		expect(venue.withdrawal).toBeUndefined();
		expect(venue.evidence).toHaveLength(1);
		expect(await factTexts(t, threadId)).toEqual(['Venue still open']);
		expect(c.planItems).toBe(1);

		// The brief: the other message's facts and lines, the withdrawn items marked.
		expect(c.brief.mode === 'brief' && c.brief.standing?.facts.map((f) => f.text)).toEqual([
			'Venue still open',
		]);
		const messageLatest = c.brief.mode === 'brief' ? (c.brief.messageLatest ?? []) : [];
		expect(messageLatest.some((l) => l.messageId === messageId)).toBe(false);
		const shown = c.brief.mode === 'brief' ? c.brief.forYou : [];
		expect(shown.find((i) => i.id === signedId)?.withdrawn).toEqual({
			at: expect.any(Number),
			confirmedAt: T + 1,
		});
		expect(shown.find((i) => i.id === venueId)?.withdrawn).toBeUndefined();

		// The needs-reply summary (and the Daily Brief subtitle) waits for a new read.
		expect(c.thread.needsReply).toMatchObject({ urgency: 'high' });
		expect(c.thread.needsReply?.askSummary).toBeUndefined();
		expect(c.dailySubtitle).toBe(SENDER);

		// The withdrawn message is read again on the next open, under its new scope.
		const snapshot = await t.run((ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) =>
					q.eq('sourceKey', interpretationSourceKey({ kind: 'mail', id: messageId }))
				)
				.first()
		);
		expect(snapshot).toMatchObject({ isDeferred: true, deferReason: 'scope_reread' });
		const extractions = await t.run((ctx) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_source_revision', (q) =>
					q.eq('sourceKey', interpretationSourceKey({ kind: 'mail', id: messageId }))
				)
				.collect()
		);
		expect(extractions).toEqual([]);

		// Nobody confirms a withdrawn item; what a person decides alone still works.
		await expect(
			t.mutation(api.mail.interpret.reactions.confirmProposal, { itemId: signedId })
		).rejects.toThrow(/read again/);
		await t.mutation(api.mail.interpret.reactions.remind, {
			itemId: trailerId,
			remindAt: Date.now() + 2 * 86_400_000,
		});
	});

	it('restores an item only when a read under the new scope restates every field', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, signedId } = await seedTwoMessages(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		await reconcile(t);
		const before = await itemsOf(t, threadId);
		const trailerId = before.find((i) => i._id !== signedId && i.intent === 'request')!._id;

		// The signed block's read: the same request with another deadline, and
		// the trailer's wording as an unverified claim. Neither restores.
		const moved = {
			...signedItem,
			due: { ...signedItem.due!, at: signedItem.due!.at! + 86_400_000 },
		};
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-signed-block',
			result: reduceResult({ items: [moved, { ...trailerItem, verify: 'proposal' }] }),
		});
		expect((await itemById(t, signedId)).withdrawal).toBeDefined();
		expect((await itemById(t, trailerId)).withdrawal).toBeDefined();
		expect(await itemsOf(t, threadId)).toHaveLength(before.length + 2);

		// A read that restates it in full restores it, with the person's confirmation.
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-signed-block-2',
			result: reduceResult({ items: [signedItem] }),
		});
		const restored = await itemById(t, signedId);
		expect(restored.withdrawal).toBeUndefined();
		expect(restored).toMatchObject({
			verify: 'passed',
			correction: { by: 'user-A', kind: 'confirmed' },
			due: signedItem.due,
		});
		expect(restored.evidence.map((e) => e.contentRevision)).toEqual(['rev-signed-block-2']);
		expect((await itemById(t, trailerId)).withdrawal).toBeDefined();
	});

	it('passes a withdrawn item by on every later fold', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, otherId, signedId } = await seedTwoMessages(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		await reconcile(t);
		const withdrawn = await itemById(t, signedId);

		// Another message names it, merges a claim into it and closes it.
		await interpretOther(
			t,
			otherId,
			threadId,
			reduceResult({
				items: [{ ...signedItem, matchItemId: signedId }],
				transitions: [
					{
						itemId: signedId,
						to: 'done',
						evidence: [{ segmentId: 's0', start: 0, end: 5, quote: 'which' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
			'rev-other-2'
		);

		const after = await itemById(t, signedId);
		expect(after.revision).toBe(withdrawn.revision);
		expect(after.status).toBe(withdrawn.status);
		expect(after.evidence).toEqual([]);
		expect(after.withdrawal).toEqual(withdrawn.withdrawal);
	});

	it('redacts what the read set on an item other messages support too', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedLegacy(t);
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({ items: [trailerItem] }),
		});
		const [shared] = await itemsOf(t, threadId);
		const otherId = await addMessageToThread(
			t,
			{ mailboxId: (await t.run((ctx) => ctx.db.get(threadId)))!.mailboxId, threadId },
			{ text: 'Yes, pay account 999.', receivedAt: T2 }
		);
		await t.run((ctx) =>
			captureInterpretSource(ctx, { source: { kind: 'mail', id: otherId }, isLive: true })
		);
		await interpretOther(
			t,
			otherId,
			threadId,
			reduceResult({ items: [{ ...trailerItem, matchItemId: shared!._id }] })
		);
		expect((await itemById(t, shared!._id)).evidence).toHaveLength(2);

		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		await reconcile(t);

		const item = await itemById(t, shared!._id);
		expect(item.withdrawal).toBeUndefined();
		expect(item.evidence.map((e) => e.source.id)).toEqual([otherId]);
		expect(await openMessageBody(item.display.en)).toBe(WITHDRAWN_CLAIM_TEXT.en);
		expect(item.redactedFields).toContain('assertion');
		expect(item.isReviewNeeded).toBe(true);
	});

	it("retires the read's waiting transitions", async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedLegacy(t);
		await interpret(t, messageId, threadId, {
			contentRevision: 'rev-old-read',
			result: reduceResult({
				items: [],
				transitions: [
					{
						about: 'Pay invoice 4471',
						to: 'done',
						evidence: [{ segmentId: 's0', start: 0, end: 16, quote: 'UNSIGNED TRAILER' }],
						isVerified: true,
						isReviewNeeded: false,
					},
				],
			}),
		});
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		await reconcile(t);
		expect((await t.run((ctx) => ctx.db.get(threadId)))!.interpretationStaleSince).toBeUndefined();

		// The request arrives later: nothing waits to settle it any more.
		const otherId = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'Please pay invoice 4471.', receivedAt: T2 }
		);
		await t.run((ctx) =>
			captureInterpretSource(ctx, { source: { kind: 'mail', id: otherId }, isLive: true })
		);
		await interpretOther(
			t,
			otherId,
			threadId,
			reduceResult({
				items: [
					reduceItem({
						assertion: 'Pay invoice 4471',
						display: { en: 'Pay invoice 4471', de: 'Bezahl Rechnung 4471' },
					}),
				],
			})
		);
		await reconcile(t);
		const [item] = await itemsOf(t, threadId);
		expect(item!.pendingUpdate).toBeUndefined();
		expect(item!.status).toBe('open');
	});

	it('reconciles a thread an earlier release fenced without a walk (migration 0070)', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, signedId } = await seedTwoMessages(t);
		await t.action(internal.mail.mailbox.signatureReverify.run, { messageId });
		// What an earlier release left: the fence and the scoped verdict, no job.
		const job = (await withdrawJobOf(t, threadId))!;
		await t.run((ctx) => ctx.db.delete(job._id));

		await t.mutation(internal.migrations['0070_reconcile_fenced_threads'].run, {});
		await reconcile(t);

		expect((await t.run((ctx) => ctx.db.get(threadId)))!.interpretationStaleSince).toBeUndefined();
		expect((await itemById(t, signedId)).withdrawal).toMatchObject({ messageId });
		expect(await factTexts(t, threadId)).toEqual(['Venue still open']);
	});
});
