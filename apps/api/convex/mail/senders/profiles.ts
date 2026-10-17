/**
 * Sender profiles (SPEC §2.9, §5): one `mailSenderProfiles` row per
 * (personal mailbox, sender), keyed by `senderDigest` (SHA-256 of the bare
 * lowercased address, `decision/senderMemory.ts`).
 *
 * Only personal mailboxes keep profiles. A team inbox is org infrastructure,
 * and a person's reading counters say nothing about how a team reads it, so
 * every writer here refuses a mailbox that is not personal.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { WithoutSystemFields } from 'convex/server';
import type { MailCategory } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { senderDigest } from '../../decision/senderMemory';
import { extractEmail } from '../../lib/emailAddress';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { isPersonalMailbox } from '../permissions';
import { emptySenderWeeks } from './counters';

type DbCtx = Pick<QueryCtx, 'db'>;

/** The canonical address and its digest for any From field. */
export function senderKeyOf(fromAddress: string): { address: string; senderDigest: string } {
	const address = extractEmail(fromAddress).toLowerCase();
	return { address, senderDigest: senderDigest(address) };
}

export async function loadSenderProfile(
	ctx: DbCtx,
	mailboxId: Id<'mailboxes'>,
	digest: string
): Promise<Doc<'mailSenderProfiles'> | null> {
	return await ctx.db
		.query('mailSenderProfiles')
		.withIndex('by_mailbox_sender', (q) => q.eq('mailboxId', mailboxId).eq('senderDigest', digest))
		.unique();
}

/**
 * Whether the mailbox is (still) personal. Writers that run later than the
 * call that decided to write (a scheduled settlement, an open of mail counted
 * before the mailbox became a team inbox) check it again at write time.
 */
export async function isPersonalMailboxId(
	ctx: DbCtx,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	const mailbox = await ctx.db.get(mailboxId);
	return mailbox !== null && isPersonalMailbox(mailbox);
}

/** A new profile: `keep` by default, empty counters. */
export function newSenderProfile(args: {
	mailboxId: Id<'mailboxes'>;
	address: string;
	displayName?: string;
	now: number;
}): WithoutSystemFields<Doc<'mailSenderProfiles'>> {
	const key = senderKeyOf(args.address);
	return {
		mailboxId: args.mailboxId,
		senderDigest: key.senderDigest,
		address: key.address,
		...(args.displayName ? { displayName: args.displayName } : {}),
		status: 'keep',
		statusSource: 'default',
		...emptySenderWeeks(args.now),
		unusedDraftStreak: 0,
		createdAt: args.now,
		updatedAt: args.now,
	};
}

/** Load the profile, creating an empty `keep` one when the sender has none. */
export async function ensureSenderProfile(
	ctx: MutationCtx,
	args: { mailboxId: Id<'mailboxes'>; address: string; displayName?: string; now: number }
): Promise<Doc<'mailSenderProfiles'>> {
	const { senderDigest: digest } = senderKeyOf(args.address);
	const existing = await loadSenderProfile(ctx, args.mailboxId, digest);
	if (existing) return existing;
	const id = await ctx.db.insert('mailSenderProfiles', newSenderProfile(args));
	return (await ctx.db.get(id))!;
}

/** Messages a thread's newest-inbound lookup reads before giving up. */
const NEWEST_INBOUND_SCAN = 5;

/** The thread's newest message that is not the owner's own, or null. */
export async function newestInboundMessage(
	ctx: DbCtx,
	thread: Pick<Doc<'mailThreads'>, '_id'>,
	ownerAddress: string
): Promise<Doc<'mailMessages'> | null> {
	const newest = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
		.order('desc')
		.take(NEWEST_INBOUND_SCAN);
	return newest.find((message) => !isFromMailboxOwner(message, ownerAddress)) ?? null;
}

/**
 * `kind` follows the last settled category (§5). Called where a thread's
 * category is written (`mail/category.ts writeCategory`, `recategorize`), on
 * the sender of the thread's newest message; reads no message rows (the
 * category write is on the arrival hot path). When the owner wrote the newest
 * message there is nothing to note. Only an existing profile is updated: a
 * category alone never creates one.
 */
export async function noteSenderKind(
	ctx: MutationCtx,
	thread: Pick<Doc<'mailThreads'>, 'mailboxId' | 'latestFromAddress'>,
	label: MailCategory
): Promise<void> {
	if (!thread.latestFromAddress) return;
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return;
	const key = senderKeyOf(thread.latestFromAddress);
	if (key.address === mailbox.address.toLowerCase()) return;
	const profile = await loadSenderProfile(ctx, mailbox._id, key.senderDigest);
	if (!profile || profile.kind === label) return;
	await ctx.db.patch(profile._id, { kind: label, updatedAt: Date.now() });
}
