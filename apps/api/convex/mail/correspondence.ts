/**
 * Prior correspondence: the owner wrote to someone. The evidence is the
 * address-book row (`mailContacts`, `useCount > 0`, see `senderEvidence.ts`),
 * written the same way whichever client the mail went out from: an Owlat
 * send (`contacts.internalRecordRecipients`) or a Sent copy that arrives from
 * another client, synced from the provider or APPENDed over IMAP
 * (`arrival/learningSignals.noteOwnerReply`). Without the second, a person
 * the owner only ever wrote to from a phone or a desktop client would read as
 * a stranger forever.
 *
 * A row is relationship evidence, so writing one also voids the address's
 * cold-pitch verdicts in the mailbox (`arrival/coldPitch.ts`).
 *
 * Isolate-safe; not a Convex function.
 */

import { normalizeEmail } from '@owlat/shared';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { voidColdPitchVerdictsOfSender } from './arrival/coldPitch';
import { loadSenderContact } from './senderEvidence';

/**
 * Count one mail the owner sent to each address: bump the existing row's use,
 * or create one. Addresses without an `@` are skipped.
 */
export async function recordCorrespondents(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	emails: Iterable<string>
): Promise<void> {
	const now = Date.now();
	for (const raw of emails) {
		const email = normalizeEmail(raw);
		if (!email.includes('@')) continue;
		const existing = await loadSenderContact(ctx, mailboxId, email);
		if (existing) {
			await ctx.db.patch(existing._id, { useCount: existing.useCount + 1, lastUsedAt: now });
		} else {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email,
				useCount: 1,
				lastUsedAt: now,
				createdAt: now,
			});
		}
		await voidColdPitchVerdictsOfSender(ctx, mailboxId, email);
	}
}
