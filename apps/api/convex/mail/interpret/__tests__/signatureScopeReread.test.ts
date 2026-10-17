/**
 * The stale fence (#1320, `staleFence.ts`): a re-verified signature verdict
 * that narrows what an interpreted message may be read for (a clearsigned
 * scope: the signed block only) fences off its whole thread's interpretation,
 * in the same write, whatever the `ai` flag or the spend hold say.
 *
 * A fenced thread has no interpretation for any machine consumer (brief,
 * overview, "Latest update", facts, reply plans, the to-do list, "elsewhere",
 * the list projection, the Reply Queue summary and the Daily Brief, the
 * extraction run, the lazy read, pending matches and their confirmation),
 * keeps every item and what people set on them, and other threads are
 * untouched. There is no rebuild path, so only the operator `release` lifts it.
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
import { captureInterpretSource } from '../sources';
import { listBucketOf } from '../counters';
import { refreshBriefTop } from '../briefTop';
import { sourceVersionOf } from '../sourceVersion';
import type { ReduceResult } from '../reduceInput';
import { modules, reduceItem, reduceResult, seedMailThread, type Test } from './interpret.testlib';
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
});
afterEach(() => {
	vi.unstubAllEnvs();
});

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

	it('only the operator lifts the fence, and nothing else changes with it', async () => {
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
