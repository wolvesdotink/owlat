/**
 * What a person does to a sender: set its status, unsubscribe, and
 * resume paused auto-drafts. Each is one undoable operation (`./operations.ts`).
 *
 * A sender is named either by `{mailboxId, senderDigest}` (the Senders page)
 * or by a `messageId` from it (the reader's ⇧E / ⇧O), which creates an empty
 * profile when the sender has none yet. Personal mailboxes only.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { MutationSessionContext } from '../../lib/sessionOrganization';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../../_utils/errors';
import { arrivalChangeRow } from '../arrival/changeRows';
import { postboxMutation } from '../_helpers';
import { internalMutation } from '../../lib/writeFence';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { isPersonalMailbox, requireMailboxAccess } from '../permissions';
import {
	addOperationChanges,
	archiveSenderInbox,
	changeSenderStatus,
	isArchivingStatus,
	resortSenderThreads,
	startSenderOperation,
} from './operations';
import { ensureSenderProfile, isPersonalMailboxId, loadSenderProfile } from './profiles';
import { senderTargetValidator, type SenderTarget } from './targets';
import {
	findUnsubscribeTarget,
	requestExternalUnsubscribe,
	type UnsubscribeMethod,
	type UnsubscribeTarget,
} from './unsubscribe';

async function requirePersonalMailbox(
	ctx: MutationCtx,
	mailboxId: Doc<'mailboxes'>['_id'],
	session?: MutationSessionContext
): Promise<Doc<'mailboxes'>> {
	const owned = await requireMailboxAccess(ctx, mailboxId, 'member', session);
	if (!owned.ok) throwForbidden('Mailbox not accessible');
	if (!isPersonalMailbox(owned.mailbox)) throwInvalidInput('Senders are personal mail only');
	return owned.mailbox;
}

/** The profile a target names, after the mailbox access check. */
export async function resolveSenderTarget(
	ctx: MutationCtx,
	target: SenderTarget,
	session?: MutationSessionContext
): Promise<{ profile: Doc<'mailSenderProfiles'>; message?: Doc<'mailMessages'> }> {
	if ('messageId' in target) {
		const message = await ctx.db.get(target.messageId);
		if (!message) throwNotFound('Message');
		const mailbox = await requirePersonalMailbox(ctx, message.mailboxId, session);
		if (isFromMailboxOwner(message, mailbox.address)) throwInvalidInput('That is your own mail');
		const profile = await ensureSenderProfile(ctx, {
			mailboxId: mailbox._id,
			address: message.fromAddress,
			displayName: message.fromName,
			now: Date.now(),
		});
		return { profile, message };
	}
	await requirePersonalMailbox(ctx, target.mailboxId, session);
	const profile = await loadSenderProfile(ctx, target.mailboxId, target.senderDigest);
	if (!profile) throwNotFound('Sender');
	return { profile };
}

/** Keep, Digest or Auto-archive. Unsubscribe has its own verb below. */
// authz: requireMailboxAccess on the sender's mailbox (resolveSenderTarget).
export const setStatus = postboxMutation({
	args: {
		target: senderTargetValidator,
		status: v.union(v.literal('keep'), v.literal('digest'), v.literal('auto_archive')),
	},
	handler: async (ctx, args, session) => {
		const { profile } = await resolveSenderTarget(ctx, args.target, session);
		const change = await changeSenderStatus(ctx, {
			profile,
			status: args.status,
			statusSource: 'user',
			kind: 'sender_status',
			actor: 'user',
		});
		return {
			operationId: change?.operationId ?? null,
			archived: change?.archived ?? 0,
			address: profile.address,
		};
	},
});

/** What `startUnsubscribe` decided, for the action that runs the external request. */
export type UnsubscribeStart = {
	method: UnsubscribeMethod | null;
	/** The message whose header the request uses. */
	messageId?: Id<'mailMessages'>;
	httpUrl?: string;
	mailtoUrl?: string;
	address: string;
} & (
	| {
			scope: 'personal';
			profileId: Id<'mailSenderProfiles'>;
			requestedAt: number;
			operationId: Id<'mailArrivalOperations'> | null;
			archived: number;
	  }
	| { scope: 'shared' }
);

function targetFields(target: UnsubscribeTarget | null) {
	return {
		method: target?.method ?? null,
		...(target ? { messageId: target.messageId } : {}),
		...(target?.httpUrl ? { httpUrl: target.httpUrl } : {}),
		...(target?.mailtoUrl ? { mailtoUrl: target.mailtoUrl } : {}),
	};
}

/**
 * The local half of the ONE unsubscribe path (Senders page, Subscriptions
 * panel, reader chip, ⇧O; `./unsubscribeActions.ts unsubscribe` runs it):
 * personal mail gets local status `unsubscribed` (undoable, archives the
 * newest ≤200 Inbox messages) and a mailto / https target is recorded as
 * `opened`; the one-click result is recorded by the action after its POST.
 * A team inbox has no sender standing, so its message only yields the target
 * and nothing is written.
 */
// authz: requireMailboxAccess on the message's / sender's mailbox, with the
// session the calling action propagates.
export const startUnsubscribe = internalMutation({
	args: { target: senderTargetValidator },
	handler: async (ctx, args): Promise<UnsubscribeStart> => {
		if ('messageId' in args.target) {
			const message = await ctx.db.get(args.target.messageId);
			if (!message) throwNotFound('Message');
			const owned = await requireMailboxAccess(ctx, message.mailboxId);
			if (!owned.ok) throwForbidden('Mailbox not accessible');
			if (!isPersonalMailbox(owned.mailbox)) {
				const sender = { mailboxId: message.mailboxId, address: message.fromAddress };
				const target = await findUnsubscribeTarget(ctx, sender, message);
				return { scope: 'shared', address: message.fromAddress, ...targetFields(target) };
			}
		}
		const { profile, message } = await resolveSenderTarget(ctx, args.target);
		const target = await findUnsubscribeTarget(ctx, profile, message);
		const change = await changeSenderStatus(ctx, {
			profile,
			status: 'unsubscribed',
			statusSource: 'user',
			kind: 'unsubscribe',
			actor: 'user',
		});
		const requestedAt = Date.now();
		if (target && target.method !== 'one_click') {
			await requestExternalUnsubscribe(ctx, profile, target, { now: requestedAt });
		}
		return {
			scope: 'personal',
			profileId: profile._id,
			requestedAt,
			operationId: change?.operationId ?? null,
			archived: change?.archived ?? 0,
			address: profile.address,
			...targetFields(target),
		};
	},
});

/** Clear the unused-draft pause lane drafts set (§7), as one operation. */
// authz: requireMailboxAccess on the sender's mailbox (resolveSenderTarget).
export const resumeDrafts = postboxMutation({
	args: { target: senderTargetValidator },
	handler: async (ctx, args, session) => {
		const { profile } = await resolveSenderTarget(ctx, args.target, session);
		if (profile.autoDraftPausedAt === undefined && profile.unusedDraftStreak === 0) {
			return { operationId: null };
		}
		const now = Date.now();
		const operationId = await startSenderOperation(ctx, {
			mailboxId: profile.mailboxId,
			kind: 'draft_resume',
			actor: 'user',
			senderDigest: profile.senderDigest,
			now,
		});
		await ctx.db.patch(profile._id, {
			autoDraftPausedAt: undefined,
			unusedDraftStreak: 0,
			lastOperationId: operationId,
			updatedAt: now,
		});
		await ctx.db.insert(
			'mailArrivalOperationChanges',
			arrivalChangeRow({
				operationId,
				mailboxId: profile.mailboxId,
				change: {
					kind: 'senderDraftPause',
					senderDigest: profile.senderDigest,
					before: {
						...(profile.autoDraftPausedAt !== undefined
							? { autoDraftPausedAt: profile.autoDraftPausedAt }
							: {}),
						unusedDraftStreak: profile.unusedDraftStreak,
					},
					after: { unusedDraftStreak: 0 },
				},
				now,
			})
		);
		await addOperationChanges(ctx, operationId, 1);
		return { operationId };
	},
});

/**
 * One sender's archive or re-sort after an apply, logged into the apply's
 * operation. Skipped when the sender's status changed again since (the
 * operation is no longer the profile's last).
 */
export const settleSuggestedSender = internalMutation({
	args: {
		operationId: v.id('mailArrivalOperations'),
		profileId: v.id('mailSenderProfiles'),
	},
	handler: async (ctx, args) => {
		const profile = await ctx.db.get(args.profileId);
		if (!profile || profile.lastOperationId !== args.operationId) return;
		// The mailbox may have become a team inbox since the apply: never
		// archive a team inbox's mail on a person's sender status.
		if (!(await isPersonalMailboxId(ctx, profile.mailboxId))) return;
		if (!isArchivingStatus(profile.status)) {
			await resortSenderThreads(ctx, profile);
			return;
		}
		const archived = await archiveSenderInbox(ctx, {
			profile,
			operationId: args.operationId,
			now: Date.now(),
		});
		await addOperationChanges(ctx, args.operationId, archived);
	},
});
