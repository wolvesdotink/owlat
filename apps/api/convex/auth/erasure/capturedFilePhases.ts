/**
 * The attachments captured into Files (`semanticFiles`) from a personal
 * mailbox's mail, erased with the mailbox (`eraseMailboxRecords`). Split out
 * of `mailboxPhases.ts` at the size cap.
 *
 * Each goes with its contact links, its bytes (unless the inbound retention
 * sweep released them) and its extraction marker. The knowledge learned from
 * it stays: knowledge from a file that is gone is restricted to owners and
 * admins (inbox/access.ts `isInboxDerivedKnowledge`).
 */

import type { Doc, Id } from '../../_generated/dataModel';
import { drainEach } from '../../contacts/erasure/phaseKit';
import { deleteBlobQuietly } from '../../lib/storageBlobs';
import { dropExtractionProgress } from '../../knowledge/extractionProgress';
import type { MemberPhaseContext } from './phaseKit';

async function deleteCapturedFile(
	phase: MemberPhaseContext,
	file: Doc<'semanticFiles'>
): Promise<void> {
	const { ctx, budget } = phase;
	const links = await ctx.db
		.query('semanticFileContacts')
		.withIndex('by_file', (q) => q.eq('fileId', file._id))
		.collect(); // bounded: junction rows for one file (contacts per file)
	for (const link of links) {
		budget.charge(link);
		await ctx.db.delete(link._id);
	}
	if (file.storageId) {
		await deleteBlobQuietly(ctx.storage, file.storageId, '[member erasure]', { fileId: file._id });
	}
	await dropExtractionProgress(ctx, 'file', file._id);
	await ctx.db.delete(file._id);
}

/** Delete the mailbox's captured files. Returns whether none are left. */
export function eraseCapturedFiles(
	phase: MemberPhaseContext,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	return drainEach(
		phase.budget,
		(n) =>
			phase.ctx.db
				.query('semanticFiles')
				.withIndex('by_source_mailbox', (q) => q.eq('sourceMailboxId', mailboxId))
				.take(n),
		(file) => deleteCapturedFile(phase, file)
	);
}
