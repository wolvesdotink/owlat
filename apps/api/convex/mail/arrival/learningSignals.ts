/**
 * Read on arrival, learning without asking (SPEC §4.3): the two signals the
 * learning listens to, recorded where they happen.
 *
 *   - **Unread archives.** The human archive mutations (`messageActions.archive`,
 *     and `move` into the Archive folder) read their messages BEFORE the move
 *     ({@link unreadArchiveCandidates}) and fold them into the sender's
 *     versioned `unreadArchiveEvidence` after it ({@link recordUnreadArchives}).
 *     A message counts only when it is live inbound mail nobody opened:
 *     `isOpenCounted === false` (set only by a counted live delivery, so a
 *     backfill or import never qualifies) and not seen. Rules, delayed actions,
 *     filters, Fix and auto-archive move mail through `moveMessagesToFolder`
 *     directly and never reach this module.
 *   - **Owner replies** ({@link noteOwnerReply}): our own reply resets the
 *     recipient's evidence at once (a queued learned digest then finds it
 *     unearned) and reverses a digest status that was learned.
 *
 * One call is one session per sender: `sessions` grows only when the session
 * key differs from the last one (the client action id, else the minute
 * bucket). The gates mirror `triageTally`'s (`MIN_OCCURRENCES`,
 * `MIN_SESSIONS`); its own archive tallies are NOT evidence here, because they
 * include read archives. `count: -1` is the "do not relearn" sentinel an undo
 * leaves behind.
 *
 * Acting on a signal (the learned digest, the reply reversal) is its own
 * operation in `./learning.ts`, scheduled from here: this module stays thin so
 * `messageActions.ts` can import it without an import cycle through the
 * sender-operation helpers (which move mail through `messageActions`). The
 * scheduled mutation re-checks every condition before it writes.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { MIN_OCCURRENCES, MIN_SESSIONS } from '../triageTally';
import { isOwnMessage } from '../needsReply';
import { mailboxOwnAddresses } from '../identities';
import { isPersonalMailbox } from '../permissions';
import { loadSenderProfile, senderKeyOf } from '../senders/profiles';

type Evidence = NonNullable<Doc<'mailSenderProfiles'>['unreadArchiveEvidence']>;
type Profile = Doc<'mailSenderProfiles'>;

/** The current evidence version. */
export const UNREAD_ARCHIVE_EVIDENCE_VERSION = 1;

/** Undo of a learned digest leaves this: never relearn on old evidence. */
export const DO_NOT_RELEARN: Evidence = { count: -1, sessions: 0, version: 1 };

/** Evidence back at zero (a reply reversed the learned status). */
export const NO_EVIDENCE: Evidence = { count: 0, sessions: 0, version: 1 };

/** Messages one archive call reads for evidence; a bulk sweep is one session anyway. */
const MAX_EVIDENCE_PER_CALL = 100;

/** Recipients of one reply checked for a learned status. */
const MAX_REPLY_RECIPIENTS = 10;

/** Live inbound mail nobody opened (see the module doc). Pure. */
export function isUnreadLiveInbound(
	message: Pick<Doc<'mailMessages'>, 'isOpenCounted' | 'flagSeen'>
): boolean {
	return message.isOpenCounted === false && !message.flagSeen;
}

/** The session one archive call counts as: the client action id, else the minute. Pure. */
export function archiveSessionKey(now: number, clientActionId?: string): string {
	return clientActionId ? `action:${clientActionId}` : `minute:${Math.floor(now / 60_000)}`;
}

/**
 * Fold one session's unread archives into the evidence. Null when the evidence
 * carries the "do not relearn" sentinel (or a newer version this code does not
 * understand): nothing is recorded. Pure.
 */
export function foldUnreadArchives(
	previous: Evidence | undefined,
	count: number,
	sessionKey: string
): Evidence | null {
	if (previous && (previous.count < 0 || previous.version !== UNREAD_ARCHIVE_EVIDENCE_VERSION)) {
		return null;
	}
	const base = previous ?? NO_EVIDENCE;
	return {
		count: base.count + count,
		sessions: base.sessions + (base.lastSessionKey === sessionKey ? 0 : 1),
		lastSessionKey: sessionKey,
		version: UNREAD_ARCHIVE_EVIDENCE_VERSION,
	};
}

/** Whether the evidence crossed both gates. Pure. */
export function hasEarnedLearnedDigest(evidence: Evidence | undefined): boolean {
	return (
		evidence !== undefined && evidence.count >= MIN_OCCURRENCES && evidence.sessions >= MIN_SESSIONS
	);
}

/**
 * Whether learning may set this sender's status: still the default `keep` (or
 * a previously learned one that was reversed). A `user` or `suggestion` status
 * is never changed. Pure.
 */
export function isLearnableProfile(profile: Pick<Profile, 'status' | 'statusSource'>): boolean {
	return (
		profile.status === 'keep' &&
		(profile.statusSource === 'default' || profile.statusSource === 'learned')
	);
}

/** Per sender: how many of a call's messages are unread live archives. */
export interface UnreadArchiveCandidates {
	mailboxId: Id<'mailboxes'>;
	bySender: Map<string, number>;
}

/**
 * Read, BEFORE the move, which of the messages an archive call moves into
 * `targetFolderId` count as evidence. Reads only. Null when none do.
 */
export async function unreadArchiveCandidates(
	ctx: Pick<MutationCtx, 'db'>,
	messageIds: Id<'mailMessages'>[],
	targetFolderId: Id<'mailFolders'>
): Promise<UnreadArchiveCandidates | null> {
	const target = await ctx.db.get(targetFolderId);
	if (target?.role !== 'archive') return null;
	const messages = await Promise.all(
		messageIds.slice(0, MAX_EVIDENCE_PER_CALL).map((id) => ctx.db.get(id))
	);
	const bySender = new Map<string, number>();
	for (const message of messages) {
		if (!message || message.mailboxId !== target.mailboxId) continue;
		if (message.folderId === targetFolderId || !isUnreadLiveInbound(message)) continue;
		const { senderDigest } = senderKeyOf(message.fromAddress);
		bySender.set(senderDigest, (bySender.get(senderDigest) ?? 0) + 1);
	}
	return bySender.size > 0 ? { mailboxId: target.mailboxId, bySender } : null;
}

/**
 * Fold the candidates into each sender's evidence (after the move went
 * through), and schedule the learned digest for a sender whose evidence just
 * crossed both gates. Personal mailboxes only; senders without a profile were
 * never counted as delivered and are skipped.
 */
export async function recordUnreadArchives(
	ctx: MutationCtx,
	candidates: UnreadArchiveCandidates | null,
	opts: { now: number; clientActionId?: string }
): Promise<void> {
	if (!candidates) return;
	const mailbox = await ctx.db.get(candidates.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return;
	const sessionKey = archiveSessionKey(opts.now, opts.clientActionId);
	for (const [digest, count] of candidates.bySender) {
		const profile = await loadSenderProfile(ctx, mailbox._id, digest);
		if (!profile) continue;
		const evidence = foldUnreadArchives(profile.unreadArchiveEvidence, count, sessionKey);
		if (!evidence) continue;
		await ctx.db.patch(profile._id, { unreadArchiveEvidence: evidence, updatedAt: opts.now });
		if (isLearnableProfile(profile) && hasEarnedLearnedDigest(evidence)) {
			await ctx.scheduler.runAfter(0, internal.mail.arrival.learning.learnDigest, {
				profileId: profile._id,
			});
		}
	}
}

/**
 * Our own reply went out (synced or appended Sent copy, or an Owlat reply its
 * transport accepted): a To recipient whose digest status was LEARNED goes
 * back to the default (SPEC §4.3 reply reversal), as its own operation. A
 * `user` status stays. Cheap for inbound mail: one folder read.
 */
export async function noteOwnerReply(
	ctx: MutationCtx,
	message: Pick<
		Doc<'mailMessages'>,
		'_id' | 'mailboxId' | 'folderId' | 'fromAddress' | 'toAddresses' | 'outbound' | 'flagDraft'
	>
): Promise<void> {
	if (message.flagDraft) return;
	const folder = await ctx.db.get(message.folderId);
	if (folder?.role !== 'sent') return;
	const mailbox = await ctx.db.get(message.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return;
	if (!isOwnMessage(message, await mailboxOwnAddresses(ctx, mailbox))) return;
	const digests = new Set(
		message.toAddresses.slice(0, MAX_REPLY_RECIPIENTS).map((a) => senderKeyOf(a).senderDigest)
	);
	for (const digest of digests) {
		const profile = await loadSenderProfile(ctx, mailbox._id, digest);
		if (!profile) continue;
		// A reply says the person wants this sender's mail: evidence gathered so
		// far no longer counts, in THIS mutation, so a learned digest already
		// queued (`learning.learnDigest` re-checks the evidence) finds nothing to
		// act on. The "do not relearn" sentinel stays.
		const evidence = profile.unreadArchiveEvidence;
		if (evidence && evidence.count > 0) {
			await ctx.db.patch(profile._id, {
				unreadArchiveEvidence: NO_EVIDENCE,
				updatedAt: Date.now(),
			});
		}
		if (profile.status !== 'digest' || profile.statusSource !== 'learned') continue;
		await ctx.scheduler.runAfter(0, internal.mail.arrival.learning.reverseOnReply, {
			profileId: profile._id,
		});
	}
}
