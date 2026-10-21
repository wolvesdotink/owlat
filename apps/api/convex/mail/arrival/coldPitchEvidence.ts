/**
 * Read on arrival (#1381): the cheap evidence about a delivered message's
 * sender that decides both whether R2 asks the cold-pitch question and
 * whether a committed verdict still stands. One test serves both
 * ({@link isColdPitchCandidate}): a verdict stands exactly while the message
 * would still be asked about, so every piece of relationship evidence that
 * appears later (a contact row from a send, an acceptance, a VIP mark, an
 * address-book entry, a mail the owner wrote from another client, an owner
 * choice about the sender, a reply in the thread) and a fenced thread void it
 * wherever it is read: placement (`projection.ts`), the Reply Queue veto
 * (`coldPitch.ts isHeldOutAsColdPitch`) and Why here? (`explain.ts`). The
 * `postbox.coldPitch` flag only gates asking; a verdict already committed
 * keeps standing when the flag is turned off.
 *
 * Split out of `coldPitch.ts` so the projection can read it: this module
 * reads, never writes, and imports nothing that refreshes a projection.
 *
 * Isolate-safe.
 */

import { emailDomain, normalizeEmail } from '@owlat/shared';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { isPersonalMailbox } from '../permissions';
import { mailboxOwnAddresses } from '../ownAddresses';
import { loadSenderContact } from '../senderEvidence';
import { isBulkOrNoReplySender } from '../needsReplyHeuristic';
import { isFencedThread } from '../interpret/staleFence';
import { loadSenderProfile, senderKeyOf } from '../senders/profiles';

/**
 * Public mail providers: sharing one of these with the mailbox owner says
 * nothing about a relationship, so it never counts as same-domain evidence.
 */
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
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
	/**
	 * Any `mailContacts` row: written to (from Owlat or, through the Sent copy,
	 * from another client), address book, screener-accepted, VIP.
	 */
	isInAddressBook: boolean;
	/** A sender status the owner set or accepted, or a placement override. */
	hasOwnerSenderChoice: boolean;
	/** The owner recategorized this sender's mail. */
	hasCategoryOverride: boolean;
	/** The owner sent mail in this thread. */
	isOwnerInThread: boolean;
	/**
	 * The Reply Queue screens the message out as bulk, list or no-reply mail
	 * (`needsReplyHeuristic.isBulkOrNoReplySender`): it never reaches Needs you
	 * or the queue, so a verdict would change nothing worth a model call.
	 */
	isBulkOrNoReply: boolean;
	/** The thread's interpretation is fenced off (`interpret/staleFence.ts`). */
	isFenced: boolean;
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
		!evidence.isBulkOrNoReply &&
		!evidence.isFenced &&
		!isSameCompanyDomain(evidence.senderDomain, evidence.ownDomains)
	);
}

/**
 * Whether a committed verdict still stands: the message would still be asked
 * about today. The flag is left out: it gates asking only (module doc). Pure.
 */
export function isColdPitchVerdictStanding(
	record: Pick<Doc<'mailArrivalRecords'>, 'coldPitchAt'>,
	evidence: ColdPitchEvidence | null
): boolean {
	if (record.coldPitchAt === undefined || evidence === null) return false;
	return isColdPitchCandidate({ ...evidence, isFlagOn: true });
}

/** Whether a sender profile carries a choice the owner made: a status they set or accepted, a placement. Pure. */
export function hasOwnerSenderChoice(
	profile: Pick<Doc<'mailSenderProfiles'>, 'statusSource' | 'placementOverride'> | null
): boolean {
	if (!profile) return false;
	return (
		profile.statusSource === 'user' ||
		profile.statusSource === 'suggestion' ||
		profile.placementOverride !== undefined
	);
}

/** Whether the owner took part in the thread. Pure. */
export function isOwnerInThread(
	thread: Pick<Doc<'mailThreads'>, 'folderRoles' | 'latestReply'>
): boolean {
	return thread.latestReply !== undefined || thread.folderRoles.includes('sent');
}

/**
 * Read the evidence of one message; null when the message, thread or mailbox
 * is gone. `precedence` is the raw Precedence header, known only at ingest.
 */
export async function loadColdPitchEvidence(
	ctx: QueryCtx,
	messageId: Id<'mailMessages'>,
	opts: { precedence?: string } = {}
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
		ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first(),
		loadSenderContact(ctx, mailbox._id, senderEmail),
		loadSenderProfile(ctx, mailbox._id, senderKeyOf(message.fromAddress).senderDigest),
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
		isBulkOrNoReply: isBulkOrNoReplySender({
			fromAddress: message.fromAddress,
			hasListUnsubscribe: message.unsubscribe !== undefined,
			...(opts.precedence !== undefined ? { precedence: opts.precedence } : {}),
			...(message.replyToAddress ? { replyToAddress: message.replyToAddress } : {}),
		}),
		isFenced: isFencedThread(thread),
		senderDomain: emailDomain(senderEmail),
		ownDomains: [...ownAddresses].map(emailDomain),
	};
}

/**
 * Whether the record's verdict still stands (module doc). Pays the evidence
 * reads only when the record carries a verdict.
 */
export async function loadColdPitchStanding(
	ctx: QueryCtx,
	record: Pick<Doc<'mailArrivalRecords'>, 'messageId' | 'coldPitchAt'>
): Promise<boolean> {
	if (record.coldPitchAt === undefined) return false;
	return isColdPitchVerdictStanding(record, await loadColdPitchEvidence(ctx, record.messageId));
}
