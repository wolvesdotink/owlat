/**
 * Sender evidence for Postbox mail, read once and shared (AI routing plan, gap
 * L2). The header half is `lib/mailEvidence.ts`.
 *
 * Three things about a sender are easy to blur, and each consumer means a
 * different one, so they stay separate fields:
 *
 *   - ADDRESS-BOOK MEMBERSHIP (`isInAddressBook`): any `mailContacts` row. The
 *     smart-inbox category's "known correspondent" and the screener's "known
 *     contact" read this.
 *   - PRIOR CORRESPONDENCE (`hasCorresponded`): the owner has written to them
 *     (`useCount > 0`). Interpretation eligibility's "known sender" reads this.
 *   - SCREENER ACCEPTANCE (`isScreenerAccepted`), and the VIP flag. The
 *     first-time-sender screener reads these with membership
 *     ({@link isHeldOutByScreener}).
 *
 * The unattended-address screens (`no-reply@`, `notifications@`) are pure
 * functions of the address and stay in `needsReplyHeuristic.ts`.
 *
 * Each consumer still looks the row up by its own key (`fromAddress`
 * lowercased, or `normalizeEmail`, which also trims), so the lookup is
 * unchanged too.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

type SenderContact = Pick<Doc<'mailContacts'>, 'useCount' | 'isVip' | 'isScreenerAccepted'>;

export interface MailSenderEvidence {
	/** Any address-book row: the owner's address book, or someone they wrote to. */
	isInAddressBook: boolean;
	/** The owner has written to them. */
	hasCorresponded: boolean;
	/** Accepted through the first-time-sender screener. */
	isScreenerAccepted: boolean;
	/** The owner marked them important. */
	isVip: boolean;
}

/** The evidence of one address-book row, or of none. Pure. */
export function senderEvidenceOf(contact: SenderContact | null): MailSenderEvidence {
	return {
		isInAddressBook: contact !== null,
		hasCorresponded: (contact?.useCount ?? 0) > 0,
		isScreenerAccepted: contact?.isScreenerAccepted === true,
		isVip: contact?.isVip === true,
	};
}

/** The address-book row of `emailKey` in this mailbox (the caller's own key). */
export async function loadSenderContact(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	emailKey: string
): Promise<Doc<'mailContacts'> | null> {
	return ctx.db
		.query('mailContacts')
		.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailboxId).eq('email', emailKey))
		.first();
}

/**
 * The first-time-sender screener: with the screener on, a sender who is
 * neither in the address book, nor a VIP, nor accepted is held out of the
 * Reply Queue (and, L3, out of clarification). Pure.
 */
export function isHeldOutByScreener(opts: {
	screenerEnabled: boolean;
	sender: Pick<MailSenderEvidence, 'isInAddressBook' | 'isVip' | 'isScreenerAccepted'>;
}): boolean {
	if (!opts.screenerEnabled) return false;
	const s = opts.sender;
	return !(s.isVip || s.isScreenerAccepted || s.isInAddressBook);
}
