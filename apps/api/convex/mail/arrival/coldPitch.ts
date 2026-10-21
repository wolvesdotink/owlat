/**
 * Read on arrival (#1381): cold sales pitches, the one owner of who is asked,
 * what a verdict does and when it stops counting.
 *
 * WHO IS ASKED. R2 (`r2.ts`, `mail/ai/categoryClassify.ts`) adds the
 * cold-pitch question for a delivered message only when the cheap evidence
 * leaves it open (`coldPitchEvidence.ts isColdPitchCandidate`): the
 * `postbox.coldPitch` flag is on, the mailbox is personal, the message has an
 * arrival record, the sender is not in the address book (no contact row:
 * never written to, from Owlat or another client, not screener-accepted, no
 * VIP), the owner has made no choice about the sender (a status they set or
 * accepted, a placement override, a category override), the owner has taken
 * no part in the thread, the Reply Queue does not screen the message out as
 * bulk, list or no-reply mail, the thread is not fenced, and the sender does
 * not share a company domain with one of the mailbox's own addresses (a
 * public provider such as gmail.com does not count). The question rides on
 * the call R2 makes for an unresolved category or for rule questions; when
 * neither is due (a heuristic settled the category in the delivery and there
 * are no rule questions), the delivery schedules R2 for the question alone
 * (`deliveryPipeline/afterInsert.ts`, {@link isColdPitchAskable}).
 *
 * WHAT A VERDICT DOES. A yes is committed in R2's own mutation
 * ({@link commitColdPitchVerdict}), with the evidence checked again and only
 * while the message still reads as the model read it (the body fingerprint,
 * `interpret/sourceVersion.ts`), onto the
 * message's arrival record (`coldPitchAt`, and the sender's digest in
 * `coldPitchSenderDigest` so the sender's verdicts can be found). Then:
 *   - the Reply Queue holds the message out ({@link isHeldOutAsColdPitch},
 *     read by `needsReplyScoring.scoreAndScreenResult`, next to the screener),
 *     and a flag the classifier already set for this message is cleared, so
 *     either completion order ends without a queue entry;
 *   - the placement is `digest` (`@owlat/shared/arrivalPlacement`, after every
 *     choice the owner made and ahead of the inferred needs-reply verdict),
 *     and the digest lists it under Cold outreach (`mail/digest/select.ts`).
 * It never marks mail as spam and never moves it.
 *
 * WHEN IT STOPS COUNTING. A verdict stands only while the message would still
 * be asked about (`coldPitchEvidence.ts isColdPitchVerdictStanding`, read by
 * placement, the queue veto and Why here?), so any relationship evidence
 * that appears later voids it, and so does a fenced thread. Two writes make
 * that durable and re-place what the verdict placed:
 *   - an owner reply in the thread clears the thread's verdicts
 *     ({@link clearColdPitchOnReply}, from `learningSignals.noteOwnerReply`);
 *   - a contact row written for the sender (a send from Owlat, a Sent copy
 *     from another client, an acceptance, a VIP mark, an address-book entry)
 *     or a category override clears the sender's verdicts in the mailbox
 *     ({@link voidColdPitchVerdictsOfSender}, in bounded batches until none
 *     is left);
 *   - a re-verified signature that changes what the message reads as clears
 *     its verdict, judged on the old read ({@link clearColdPitchOfMessage},
 *     from `mailbox/signatureReverify.ts`).
 * A status or placement the owner sets re-sorts the sender's threads anyway
 * (`senders/operations.ts`), fencing re-places its thread
 * (`mailbox/signatureReverify.ts`), and a Fix of the thread outranks it.
 *
 * Isolate-safe.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { sourceVersionOf } from '../interpret/sourceVersion';
import { senderKeyOf } from '../senders/profiles';
import { refreshThreadsBounded } from '../senders/resortBatch';
import { refreshArrivalProjection } from './projection';
import { loadArrivalRecord } from './records';
import {
	isColdPitchCandidate,
	loadColdPitchEvidence,
	loadColdPitchStanding,
} from './coldPitchEvidence';

/**
 * Whether to ask the cold-pitch question about this message (module doc).
 * The flag first: while it is off (the default) the caller pays one
 * singleton read. `precedence` is the raw header, known only at ingest.
 */
export async function isColdPitchAskable(
	ctx: QueryCtx,
	messageId: Id<'mailMessages'>,
	precedence?: string
): Promise<boolean> {
	if (!(await isFeatureEnabled(ctx, 'postbox.coldPitch'))) return false;
	const evidence = await loadColdPitchEvidence(
		ctx,
		messageId,
		precedence !== undefined ? { precedence } : {}
	);
	return evidence !== null && isColdPitchCandidate(evidence);
}

/** For R2 (an action): whether to add the cold-pitch question for this message. */
export const isAskable = internalQuery({
	args: { messageId: v.id('mailMessages'), precedence: v.optional(v.string()) },
	handler: async (ctx, args): Promise<boolean> =>
		isColdPitchAskable(ctx, args.messageId, args.precedence),
});

/**
 * Commit a yes, inside R2's commit mutation. `sourceVersion` is the body
 * fingerprint of the text the model read (`interpret/sourceVersion.ts`): a
 * read that changed since (a re-verified clearsigned signature narrows it)
 * makes the answer stale. The evidence is read again too: a contact, an
 * acceptance, an owner choice, an owner reply or a fence that landed while
 * the model ran makes the answer moot. Clears a needs-reply flag the
 * classifier already set for this message (the run keeps its pending marker,
 * and its later verdict is held out by {@link isHeldOutAsColdPitch}), then
 * re-projects. True when the verdict stands.
 */
export async function commitColdPitchVerdict(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	sourceVersion: string
): Promise<boolean> {
	const evidence = await loadColdPitchEvidence(ctx, messageId);
	if (!evidence || !isColdPitchCandidate(evidence)) return false;
	if ((await sourceVersionOf(ctx, { kind: 'mail', id: messageId })) !== sourceVersion) {
		return false;
	}
	const record = await loadArrivalRecord(ctx, messageId);
	const message = await ctx.db.get(messageId);
	if (!record || !message) return false;
	const now = Date.now();
	if (record.coldPitchAt === undefined) {
		await ctx.db.patch(record._id, {
			coldPitchAt: now,
			coldPitchSenderDigest: senderKeyOf(message.fromAddress).senderDigest,
			updatedAt: now,
		});
	}
	const thread = await ctx.db.get(record.threadId);
	if (thread?.needsReply?.messageId === messageId) {
		await ctx.db.patch(thread._id, { needsReply: undefined, updatedAt: now });
	}
	await refreshArrivalProjection(ctx, record.threadId);
	return true;
}

/**
 * Whether a needs-reply result for `message` is held out: its record carries a
 * verdict that still stands (`coldPitchEvidence.ts`, the same test placement
 * uses).
 */
export async function isHeldOutAsColdPitch(
	ctx: QueryCtx,
	message: Pick<Doc<'mailMessages'>, '_id'>
): Promise<boolean> {
	const record = await loadArrivalRecord(ctx, message._id);
	return record !== null && (await loadColdPitchStanding(ctx, record));
}

/** How many of a thread's newest arrival records an owner reply clears. */
const REPLY_CLEARS_RECORDS = 10;

/** The fields a cleared verdict loses. */
const CLEARED = { coldPitchAt: undefined, coldPitchSenderDigest: undefined } as const;

/** An owner reply in the thread clears its verdicts, then re-projects (module doc). */
export async function clearColdPitchOnReply(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const records = await ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_thread_source_order', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(REPLY_CLEARS_RECORDS);
	const pitched = records.filter((record) => record.coldPitchAt !== undefined);
	if (pitched.length === 0) return;
	const now = Date.now();
	for (const record of pitched) {
		await ctx.db.patch(record._id, { ...CLEARED, updatedAt: now });
	}
	await refreshArrivalProjection(ctx, threadId);
}

/**
 * The message's read changed (a re-verified signature narrowed it, see
 * `mailbox/signatureReverify.ts`): its verdict was judged on the old read, so
 * it is cleared. True when there was one; the caller re-projects the thread.
 */
export async function clearColdPitchOfMessage(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<boolean> {
	const record = await loadArrivalRecord(ctx, messageId);
	if (!record || record.coldPitchAt === undefined) return false;
	await ctx.db.patch(record._id, { ...CLEARED, updatedAt: Date.now() });
	return true;
}

/**
 * How many of a sender's verdicts one mutation clears. More are cleared by a
 * chain of {@link continueVoidSenderVerdicts} batches until none is left.
 */
export const SENDER_CLEARS_RECORDS = 50;

/**
 * Relationship evidence about `address` appeared in the mailbox (a contact
 * row, a category override): clear the sender's verdicts and re-place their
 * threads (module doc). One indexed read when there are none.
 */
export async function voidColdPitchVerdictsOfSender(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	address: string
): Promise<void> {
	await voidSenderVerdictsBatch(ctx, mailboxId, senderKeyOf(address).senderDigest);
}

/**
 * Clear one batch of the sender's verdicts and re-place their threads
 * (`refreshThreadsBounded` chains its own rest). A cleared record leaves the
 * index, so when more are left the next batch reads the same range again.
 */
async function voidSenderVerdictsBatch(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	senderDigest: string
): Promise<void> {
	const records = await ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_mailbox_cold_pitch_sender', (q) =>
			q.eq('mailboxId', mailboxId).eq('coldPitchSenderDigest', senderDigest)
		)
		.take(SENDER_CLEARS_RECORDS + 1);
	if (records.length === 0) return;
	const batch = records.slice(0, SENDER_CLEARS_RECORDS);
	const now = Date.now();
	for (const record of batch) {
		await ctx.db.patch(record._id, { ...CLEARED, updatedAt: now });
	}
	await refreshThreadsBounded(ctx, [...new Set(batch.map((record) => record.threadId))]);
	if (records.length > SENDER_CLEARS_RECORDS) {
		await ctx.scheduler.runAfter(0, internal.mail.arrival.coldPitch.continueVoidSenderVerdicts, {
			mailboxId,
			senderDigest,
		});
	}
}

/** The next batch of {@link voidColdPitchVerdictsOfSender}, while verdicts are left. */
export const continueVoidSenderVerdicts = internalMutation({
	args: { mailboxId: v.id('mailboxes'), senderDigest: v.string() },
	handler: async (ctx, args): Promise<void> => {
		await voidSenderVerdictsBatch(ctx, args.mailboxId, args.senderDigest);
	},
});
