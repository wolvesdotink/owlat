/**
 * Read on arrival (#1381): cold sales pitches, the one owner of who is asked,
 * what a verdict does and when it stops counting.
 *
 * WHO IS ASKED. R2 (`r2.ts`, `mail/ai/categoryClassify.ts`) adds the
 * cold-pitch question for a delivered message only when the cheap evidence
 * leaves it open ({@link isColdPitchCandidate}): the `postbox.coldPitch` flag
 * is on, the mailbox is personal, the message has an arrival record, the
 * sender is not in the address book (no contact row: never written to, not
 * screener-accepted, no VIP), the owner has made no choice about the sender
 * (a status they set or accepted, a placement override, a category override),
 * the owner has taken no part in the thread, and the sender does not share a
 * company domain with one of the mailbox's own addresses (a public provider
 * such as gmail.com does not count). The question rides on a call R2 makes
 * anyway; it never adds a model call of its own.
 *
 * WHAT A VERDICT DOES. A yes is committed in R2's own mutation
 * ({@link commitColdPitchVerdict}), with the evidence checked again, onto the
 * message's arrival record (`coldPitchAt`). Then:
 *   - the Reply Queue holds the message out ({@link isHeldOutAsColdPitch},
 *     read by `needsReplyScoring.scoreAndScreenResult`, next to the screener),
 *     and a flag the classifier already set for this message is cleared, so
 *     either completion order ends without a queue entry;
 *   - the placement is `digest` (`@owlat/shared/arrivalPlacement`, after every
 *     choice the owner made and ahead of the inferred needs-reply verdict),
 *     and the digest lists it under Cold outreach (`mail/digest/select.ts`).
 * It never marks mail as spam and never moves it.
 *
 * WHEN IT STOPS COUNTING. An owner reply in the thread clears it
 * ({@link clearColdPitchOnReply}, from `learningSignals.noteOwnerReply`). The
 * reply also gives the sender a contact row and the thread a sent message, so
 * a late R2 answer finds the message no longer a candidate and cannot restore
 * it. A choice the owner makes about the sender later (a status, a placement)
 * voids it where it is read (`projection.ts isColdPitchStanding`), and a Fix
 * of the thread outranks it in placement.
 *
 * Isolate-safe.
 */

import { v } from 'convex/values';
import { emailDomain, normalizeEmail } from '@owlat/shared';
import type { Doc, Id } from '../../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { isPersonalMailbox } from '../permissions';
import { mailboxOwnAddresses } from '../identities';
import { loadSenderContact } from '../senderEvidence';
import {
	hasOwnerSenderChoice,
	isColdPitchStanding,
	refreshArrivalProjection,
	senderProfileOf,
} from './projection';
import { loadArrivalRecord } from './records';

/**
 * Public mail providers: sharing one of these with the mailbox owner says
 * nothing about a relationship, so it never counts as same-domain evidence.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
	'aol.com',
	'fastmail.com',
	'gmail.com',
	'gmx.at',
	'gmx.ch',
	'gmx.de',
	'gmx.net',
	'googlemail.com',
	'hotmail.com',
	'icloud.com',
	'live.com',
	'mac.com',
	'mail.com',
	'mailbox.org',
	'me.com',
	'msn.com',
	'outlook.com',
	'posteo.de',
	'proton.me',
	'protonmail.com',
	't-online.de',
	'web.de',
	'yahoo.com',
	'yandex.com',
	'zoho.com',
]);

/** The cheap evidence about one delivered message's sender. */
export interface ColdPitchEvidence {
	isFlagOn: boolean;
	isPersonalMailbox: boolean;
	/** Live inbound mail of a personal mailbox has one (`records.ts`). */
	hasArrivalRecord: boolean;
	/** Sent by the mailbox itself (its address or an alias), or outbound. */
	isFromOwner: boolean;
	/** Any `mailContacts` row: written to, address book, screener-accepted, VIP. */
	isInAddressBook: boolean;
	/** A sender status the owner set or accepted, or a placement override. */
	hasOwnerSenderChoice: boolean;
	/** The owner recategorized this sender's mail. */
	hasCategoryOverride: boolean;
	/** The owner sent mail in this thread. */
	isOwnerInThread: boolean;
	senderDomain: string;
	/** The domains of the mailbox's own addresses (its address and aliases). */
	ownDomains: readonly string[];
}

/** Whether the sender shares a company domain with the mailbox. Pure. */
export function isSameCompanyDomain(senderDomain: string, ownDomains: readonly string[]): boolean {
	if (senderDomain === '' || PUBLIC_MAIL_DOMAINS.has(senderDomain)) return false;
	return ownDomains.includes(senderDomain);
}

/** Whether R2 may ask the cold-pitch question about this message (module doc). Pure. */
export function isColdPitchCandidate(evidence: ColdPitchEvidence): boolean {
	return (
		evidence.isFlagOn &&
		evidence.isPersonalMailbox &&
		evidence.hasArrivalRecord &&
		!evidence.isFromOwner &&
		!evidence.isInAddressBook &&
		!evidence.hasOwnerSenderChoice &&
		!evidence.hasCategoryOverride &&
		!evidence.isOwnerInThread &&
		!isSameCompanyDomain(evidence.senderDomain, evidence.ownDomains)
	);
}

/** Whether the owner took part in the thread. Pure. */
export function isOwnerInThread(
	thread: Pick<Doc<'mailThreads'>, 'folderRoles' | 'latestReply'>
): boolean {
	return thread.latestReply !== undefined || thread.folderRoles.includes('sent');
}

/** Read the evidence of one message; null when the message, thread or mailbox is gone. */
export async function loadColdPitchEvidence(
	ctx: QueryCtx,
	messageId: Id<'mailMessages'>
): Promise<ColdPitchEvidence | null> {
	const message = await ctx.db.get(messageId);
	if (!message) return null;
	const [thread, mailbox] = await Promise.all([
		ctx.db.get(message.threadId),
		ctx.db.get(message.mailboxId),
	]);
	if (!thread || !mailbox || mailbox.status !== 'active') return null;
	const ownAddresses = await mailboxOwnAddresses(ctx, mailbox);
	const senderEmail = normalizeEmail(message.fromAddress);
	const [record, contact, profile, override, isFlagOn] = await Promise.all([
		loadArrivalRecord(ctx, messageId),
		loadSenderContact(ctx, mailbox._id, senderEmail),
		senderProfileOf(ctx, mailbox._id, message.fromAddress),
		ctx.db
			.query('mailSenderCategoryOverrides')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', mailbox._id).eq('senderEmail', message.fromAddress.toLowerCase())
			)
			.first(),
		isFeatureEnabled(ctx, 'postbox.coldPitch'),
	]);
	return {
		isFlagOn,
		isPersonalMailbox: isPersonalMailbox(mailbox),
		hasArrivalRecord: record !== null,
		isFromOwner: message.outbound !== undefined || ownAddresses.has(senderEmail),
		isInAddressBook: contact !== null,
		hasOwnerSenderChoice: hasOwnerSenderChoice(profile),
		hasCategoryOverride: override !== null,
		isOwnerInThread: isOwnerInThread(thread),
		senderDomain: emailDomain(senderEmail),
		ownDomains: [...ownAddresses].map(emailDomain),
	};
}

/** For R2 (an action): whether to add the cold-pitch question for this message. */
export const isAskable = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<boolean> => {
		// The flag first: while it is off (the default) R2 pays one singleton read.
		if (!(await isFeatureEnabled(ctx, 'postbox.coldPitch'))) return false;
		const evidence = await loadColdPitchEvidence(ctx, args.messageId);
		return evidence !== null && isColdPitchCandidate(evidence);
	},
});

/**
 * Commit a yes, inside R2's commit mutation. The evidence is read again: a
 * contact, an acceptance, an owner choice or an owner reply that landed while
 * the model ran makes the answer moot. Clears a needs-reply flag the
 * classifier already set for this message (the run keeps its pending marker,
 * and its later verdict is held out by {@link isHeldOutAsColdPitch}), then
 * re-projects. True when the verdict stands.
 */
export async function commitColdPitchVerdict(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<boolean> {
	const evidence = await loadColdPitchEvidence(ctx, messageId);
	if (!evidence || !isColdPitchCandidate(evidence)) return false;
	const record = await loadArrivalRecord(ctx, messageId);
	if (!record) return false;
	const now = Date.now();
	if (record.coldPitchAt === undefined) {
		await ctx.db.patch(record._id, { coldPitchAt: now, updatedAt: now });
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
 * verdict that still stands (`projection.ts isColdPitchStanding`, the same
 * test placement uses).
 */
export async function isHeldOutAsColdPitch(
	ctx: Pick<QueryCtx, 'db'>,
	message: Pick<Doc<'mailMessages'>, '_id' | 'mailboxId' | 'fromAddress'>
): Promise<boolean> {
	const record = await loadArrivalRecord(ctx, message._id);
	if (record?.coldPitchAt === undefined) return false;
	const profile = await senderProfileOf(ctx, message.mailboxId, message.fromAddress);
	return isColdPitchStanding(record, profile);
}

/** How many of a thread's newest arrival records an owner reply clears. */
const REPLY_CLEARS_RECORDS = 10;

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
		await ctx.db.patch(record._id, { coldPitchAt: undefined, updatedAt: now });
	}
	await refreshArrivalProjection(ctx, threadId);
}
