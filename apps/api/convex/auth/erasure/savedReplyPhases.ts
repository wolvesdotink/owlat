/**
 * The member's personal saved replies, with the files they own. A personal
 * reply's files may be borrowed by drafts in other mailboxes; those drafts
 * refuse to send without them rather than keep the member's data alive.
 *
 * Runs before `mailboxRecords`, which would delete the legacy rows of a
 * personal mailbox without their files.
 */

import type { Doc } from '../../_generated/dataModel';
import { drainEach } from '../../contacts/erasure/phaseKit';
import { deleteSavedReplyWithFiles } from '../../mail/savedReplyAttachments';
import { forEachPersonalMailbox, type MemberPhaseRunner } from './phaseKit';

export const eraseSavedReplies: MemberPhaseRunner = async (phase) => {
	const { ctx, authUserId, budget } = phase;
	const remove = async (row: Doc<'mailSnippets'>) => {
		budget.chargeRows(await deleteSavedReplyWithFiles(ctx, row));
	};
	const isOwnedDone = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('mailSnippets')
				.withIndex('by_owner', (q) => q.eq('ownerUserId', authUserId))
				.take(n),
		remove
	);
	if (!isOwnedDone) return { isDone: false };
	return forEachPersonalMailbox(phase, (mailbox) =>
		drainEach(
			budget,
			(n) =>
				ctx.db
					.query('mailSnippets')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
					.take(n),
			remove
		)
	);
};
