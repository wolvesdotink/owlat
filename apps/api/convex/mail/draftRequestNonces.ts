/**
 * The full-page composer's compose-request nonces (`drafts.create`'s
 * `requestNonce`): a mailbox-scoped binding from the nonce to the draft its
 * first create made.
 *
 * A remount of the same request that creates again gets that draft back, and
 * once the draft is sent or discarded learns it is gone instead of making a
 * second one, so the binding deliberately outlives its draft. It holds a nonce
 * and a draft id, nothing typed, and expires after 14 days (the client's
 * parked-request lifetime); each new binding prunes a few expired ones, so no
 * cron is needed. Split out of `drafts.ts` for the file-size ratchet.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** How long a nonce keeps naming its draft; an older request is not resumed. */
const REQUEST_NONCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Expired bindings removed per new binding. */
const PRUNE_BATCH = 10;

/** What `drafts.create` answers. */
export interface CreateDraftResult {
	draftId: Id<'mailDrafts'>;
	/** The row's envelope as created (or as it is now, when `existing`). */
	toAddresses: string[];
	subject: string;
	/** Lifecycle of an existing row; a new row is always `draft`. */
	state?: 'draft' | 'pending_send' | 'scheduled';
	inReplySubject?: string;
	inReplyFrom?: string;
	/** True when a nonce matched a draft a previous call already created. */
	existing?: boolean;
	/** With `existing`: that draft has since been sent or discarded. */
	missing?: boolean;
}

/** `drafts.create`'s answer for a draft an earlier call already made. */
export function existingDraftResult(draft: Doc<'mailDrafts'>): CreateDraftResult {
	return {
		draftId: draft._id,
		toAddresses: draft.toAddresses,
		subject: draft.subject,
		state: draft.state,
		existing: true,
	};
}

/**
 * `drafts.create`'s answer when `requestNonce` already made a draft in this
 * mailbox (live, or gone once sent or discarded); null when it did not, or
 * its binding expired.
 */
export async function findRequestDraft(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	requestNonce: string,
	now: number
): Promise<CreateDraftResult | null> {
	const binding = await ctx.db
		.query('mailDraftRequestNonces')
		.withIndex('by_mailbox_and_nonce', (q) =>
			q.eq('mailboxId', mailboxId).eq('requestNonce', requestNonce)
		)
		.first();
	if (!binding || binding.createdAt <= now - REQUEST_NONCE_TTL_MS) return null;
	const draft = await ctx.db.get(binding.draftId);
	if (draft) return existingDraftResult(draft);
	return { draftId: binding.draftId, toAddresses: [], subject: '', existing: true, missing: true };
}

/** Bind `requestNonce` to the draft it just made, pruning a few expired bindings. */
export async function bindRequestNonce(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	requestNonce: string,
	draftId: Id<'mailDrafts'>,
	now: number
): Promise<void> {
	await ctx.db.insert('mailDraftRequestNonces', {
		mailboxId,
		requestNonce,
		draftId,
		createdAt: now,
	});
	const expired = await ctx.db
		.query('mailDraftRequestNonces')
		.withIndex('by_mailbox_and_created', (q) =>
			q.eq('mailboxId', mailboxId).lt('createdAt', now - REQUEST_NONCE_TTL_MS)
		)
		.take(PRUNE_BATCH);
	for (const row of expired) await ctx.db.delete(row._id);
}
