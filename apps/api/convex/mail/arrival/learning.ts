/**
 * Read on arrival, learning without asking: what the signals in
 * `./learningSignals.ts` lead to, each one undoable operation.
 *
 *   - {@link learnDigest}: a sender whose unread-archive evidence crossed both
 *     gates goes to `digest` with `statusSource: 'learned'` (operation
 *     `learned_status`, actor `learning`), and `learnedNoticeAt` is set: the
 *     Postbox shows "Mail from X now goes to your digest · Undo" once
 *     ({@link notices} / {@link acknowledge}).
 *   - {@link reverseOnReply}: our own reply to a learned-digest sender puts it
 *     back to the default and resets the evidence.
 *
 * Undo (`./operations.ts`) of a learned digest restores the status and leaves
 * the "do not relearn" sentinel (`count: -1`). Demoting is silent with undo;
 * promoting is never done here (the Daily Brief only suggests it, lane senders).
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { throwForbidden, throwNotFound } from '../../_utils/errors';
import { postboxMutation, postboxQuery } from '../_helpers';
import { isPersonalMailbox, requireMailboxAccess } from '../permissions';
import {
	addOperationChanges,
	resortSenderThreads,
	startSenderOperation,
	writeSenderStatus,
} from '../senders/operations';
import { isPersonalMailboxId } from '../senders/profiles';
import { hasEarnedLearnedDigest, isLearnableProfile, NO_EVIDENCE } from './learningSignals';

/** Operations the notice query reads, newest first. */
const NOTICE_SCAN = 50;

/** The notices one mailbox shows at most at once. */
const MAX_NOTICES = 5;

async function logStatus(
	ctx: MutationCtx,
	profile: Doc<'mailSenderProfiles'>,
	next: { status: 'digest' | 'keep'; statusSource: 'learned' | 'default' },
	extra: Partial<Doc<'mailSenderProfiles'>>
): Promise<Id<'mailArrivalOperations'>> {
	const now = Date.now();
	const operationId = await startSenderOperation(ctx, {
		mailboxId: profile.mailboxId,
		kind: 'learned_status',
		actor: 'learning',
		senderDigest: profile.senderDigest,
		now,
	});
	await writeSenderStatus(ctx, { profile, ...next, operationId, now });
	await ctx.db.patch(profile._id, { ...extra, updatedAt: now });
	await resortSenderThreads(ctx, profile);
	await addOperationChanges(ctx, operationId, 1);
	return operationId;
}

/**
 * The learned digest. Re-checks everything at write time: the mailbox is still
 * personal, the status still learnable (a `user` or `suggestion` status set in
 * between wins), and the evidence still earned (no sentinel).
 */
export const learnDigest = internalMutation({
	args: { profileId: v.id('mailSenderProfiles') },
	handler: async (ctx, args): Promise<Id<'mailArrivalOperations'> | null> => {
		const profile = await ctx.db.get(args.profileId);
		if (!profile || !isLearnableProfile(profile)) return null;
		if (!hasEarnedLearnedDigest(profile.unreadArchiveEvidence)) return null;
		if (!(await isPersonalMailboxId(ctx, profile.mailboxId))) return null;
		return await logStatus(
			ctx,
			profile,
			{ status: 'digest', statusSource: 'learned' },
			{ learnedNoticeAt: Date.now() }
		);
	},
});

/** Reply reversal: a learned digest goes back to `keep` / `default`, evidence reset. */
export const reverseOnReply = internalMutation({
	args: { profileId: v.id('mailSenderProfiles') },
	handler: async (ctx, args): Promise<Id<'mailArrivalOperations'> | null> => {
		const profile = await ctx.db.get(args.profileId);
		if (profile?.status !== 'digest' || profile.statusSource !== 'learned') return null;
		if (!(await isPersonalMailboxId(ctx, profile.mailboxId))) return null;
		return await logStatus(
			ctx,
			profile,
			{ status: 'keep', statusSource: 'default' },
			{ unreadArchiveEvidence: NO_EVIDENCE, learnedNoticeAt: undefined }
		);
	},
});

/** One pending "now goes to your digest" notice. */
export interface LearnedNotice {
	operationId: Id<'mailArrivalOperations'>;
	senderDigest: string;
	address: string;
	displayName?: string;
	learnedAt: number;
}

/**
 * The learned-digest notices still to show: the newest learned operations of
 * the mailbox whose sender still carries `learnedNoticeAt` and that operation
 * as its last. Bounded: the newest {@link NOTICE_SCAN} operations.
 */
export const notices = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args, session): Promise<LearnedNotice[]> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!owned.ok || !isPersonalMailbox(owned.mailbox)) return [];
		const operations = await ctx.db
			.query('mailArrivalOperations')
			.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.take(NOTICE_SCAN);
		const out: LearnedNotice[] = [];
		for (const operation of operations) {
			if (out.length >= MAX_NOTICES) break;
			if (operation.kind !== 'learned_status' || operation.status !== 'applied') continue;
			if (!operation.senderDigest) continue;
			const profile = await ctx.db
				.query('mailSenderProfiles')
				.withIndex('by_mailbox_sender', (q) =>
					q.eq('mailboxId', args.mailboxId).eq('senderDigest', operation.senderDigest!)
				)
				.unique();
			if (!profile || profile.learnedNoticeAt === undefined) continue;
			if (profile.lastOperationId !== operation._id || profile.statusSource !== 'learned') continue;
			out.push({
				operationId: operation._id,
				senderDigest: profile.senderDigest,
				address: profile.address,
				...(profile.displayName ? { displayName: profile.displayName } : {}),
				learnedAt: profile.learnedNoticeAt,
			});
		}
		return out;
	},
});

/** The notice was shown: it does not come back. */
// authz: requireMailboxAccess on the operation's mailbox.
export const acknowledge = postboxMutation({
	args: { operationId: v.id('mailArrivalOperations') },
	handler: async (ctx, args, session): Promise<void> => {
		const operation = await ctx.db.get(args.operationId);
		if (!operation) throwNotFound('Operation');
		const owned = await requireMailboxAccess(ctx, operation.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (!operation.senderDigest) return;
		const profile = await ctx.db
			.query('mailSenderProfiles')
			.withIndex('by_mailbox_sender', (q) =>
				q.eq('mailboxId', operation.mailboxId).eq('senderDigest', operation.senderDigest!)
			)
			.unique();
		if (!profile || profile.learnedNoticeAt === undefined) return;
		if (profile.lastOperationId !== operation._id) return;
		await ctx.db.patch(profile._id, { learnedNoticeAt: undefined, updatedAt: Date.now() });
	},
});
