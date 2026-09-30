/**
 * Shared shapes and helpers for the member-erasure phases (`identityPhases.ts`,
 * `mailboxPhases.ts`, `memberPhases.ts`).
 *
 * The loops and the per-transaction budget are the contact erasure's
 * (`contacts/erasure/phaseKit.ts`, `budget.ts`): same platform limits, same
 * resume-by-re-reading rule. Only the subject differs — here a BetterAuth user
 * id instead of a contact id.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { ErasureBudget } from '../../contacts/erasure/budget';
import { deleteBlobQuietly } from '../../lib/storageBlobs';
import { isPersonalMailbox } from '../../mail/permissions';

export interface MemberPhaseContext {
	ctx: MutationCtx;
	/** The BetterAuth user id being erased. */
	authUserId: string;
	/** The login email the identity had when the erasure began. */
	email: string;
	budget: ErasureBudget;
	/** The phase's saved pagination cursor, when it uses one. */
	cursor: string | undefined;
}

export interface MemberPhaseOutcome {
	isDone: boolean;
	/** Where to resume a paginated phase that is not done. */
	cursor?: string;
}

export type MemberPhaseRunner = (phase: MemberPhaseContext) => Promise<MemberPhaseOutcome>;

/** Replaces the member's id on rows the organization keeps. */
export const DELETED_ACCOUNT_ID = '[deleted account]';

/**
 * The member's personal mailboxes. A `shared` team inbox or a `seed` they
 * connected is organization infrastructure and is never returned: an admin
 * reassigns a team inbox (`transferOwnership`), and a seed stays org-owned
 * until `disconnectSeed` retires it.
 */
export async function personalMailboxes(
	phase: MemberPhaseContext
): Promise<Array<Doc<'mailboxes'>>> {
	const owned = await phase.ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', phase.authUserId))
		.collect(); // bounded: a user's own mailboxes (personal + any team inboxes or seeds they connected)
	for (const mailbox of owned) phase.budget.chargeRead(mailbox);
	return owned.filter(isPersonalMailbox);
}

/**
 * Run `each` over the personal mailboxes until one of them runs out of budget.
 * Returns whether every mailbox is done.
 */
export async function forEachPersonalMailbox(
	phase: MemberPhaseContext,
	each: (mailbox: Doc<'mailboxes'>) => Promise<boolean>
): Promise<MemberPhaseOutcome> {
	for (const mailbox of await personalMailboxes(phase)) {
		if (!(await each(mailbox))) return { isDone: false };
	}
	return { isDone: true };
}

/**
 * Delete a blob this erasure removes, with its upload receipt. The receipt is
 * deletion authority for the bytes and names the uploader; once the bytes are
 * gone it only points at nothing.
 */
export async function deleteBlobAndReceipt(
	phase: MemberPhaseContext,
	storageId: Id<'_storage'>,
	context: Record<string, unknown>
): Promise<void> {
	const receipt = await phase.ctx.db
		.query('storageUploads')
		.withIndex('by_storage', (q) => q.eq('storageId', storageId))
		.first();
	if (receipt) {
		phase.budget.chargeRead(receipt);
		await phase.ctx.db.delete(receipt._id);
	}
	await deleteBlobQuietly(phase.ctx.storage, storageId, '[member erasure]', context);
}
