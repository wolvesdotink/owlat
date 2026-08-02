/**
 * Which send does a contact's unsubscribe answer?
 *
 * TWO consumers, ONE answer. `campaigns.statsUnsubscribed`
 * (`topics/subscription.ts:recordCampaignUnsubscribe`) and the `unsubscribed`
 * transport outcome (`delivery/unsubscribeOutcome.ts`) are written by two
 * different scheduled mutations off the same public unsubscribe, and a
 * dashboard that disagrees with the ramp gate about which campaign a departure
 * belongs to is a defect in whichever of the two is read second. The join lives
 * here so there is exactly one of it to be right or wrong.
 *
 * The unsubscribe carries no send id — the RFC 8058 one-click target and the
 * preference centre are both CONTACT-keyed — so "the most recent marketing send
 * that actually reached a transport" is the whole of the attribution rule.
 */

import type { DatabaseReader } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * How far back through a contact's sends a candidate is looked for, per table.
 *
 * Neither read may be unbounded. `transactionalSends` mixes marketing drips with
 * password resets, receipts and agent replies, so a filtered `.first()` would
 * read every one of them for a contact who has received transactional mail and
 * never a drip. `emailSends` needs the same bound for the same reason once
 * undispatched rows are skipped: a blast pre-creates the whole audience in
 * `queued`, so a contact can carry several rows no transport has seen yet.
 *
 * An unsubscribe answers a RECENT message; a send buried under this many later
 * ones is not the one being answered.
 */
export const ATTRIBUTION_LOOKBACK_SENDS = 25;

/**
 * Whether a transport has actually been handed this send.
 *
 * A `queued` row is not a message anyone received: `delivery/sends.createBatch`
 * pre-creates the whole audience, and the `sendAssignments` row that carries the
 * cell is written later, inside the scheduled `enqueueCampaignEmails`
 * transaction — up to a day later on the timezone path. Attributing an
 * unsubscribe to one would stamp an undispatched row, record nothing (it has no
 * assignment yet), and — because the stamp is the uniqueness gate — permanently
 * hide the delivered send that actually produced the signal. `failed` never
 * reached a receiver either.
 *
 * Both witnesses are checked because the `sent` transition writes them together
 * (`reduceSent`); either one alone is enough to say a transport has it.
 */
function reachedATransport(send: Doc<'emailSends'> | Doc<'transactionalSends'>): boolean {
	return send.sentAt !== undefined || (send.status !== 'queued' && send.status !== 'failed');
}

/** The most recent dispatched campaign send this contact received. */
export async function latestAttributableCampaignSend(
	db: DatabaseReader,
	contactId: Id<'contacts'>
): Promise<Doc<'emailSends'> | null> {
	const recent = await db
		.query('emailSends')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.order('desc')
		.take(ATTRIBUTION_LOOKBACK_SENDS);
	return recent.find(reachedATransport) ?? null;
}

/**
 * The most recent dispatched AUTOMATION drip this contact received.
 *
 * `kind: 'automation'` is the marketing boundary on `transactionalSends`: a drip
 * carries the one-click pair (`buildTransactionalListUnsubscribe`), while a
 * transactional API send, an agent reply and a member-only `test` preview do not
 * — attributing an unsubscribe to one of those would move a counter for a
 * message that could not have produced it.
 */
export async function latestAttributableAutomationSend(
	db: DatabaseReader,
	contactId: Id<'contacts'>
): Promise<Doc<'transactionalSends'> | null> {
	const recent = await db
		.query('transactionalSends')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.order('desc')
		.take(ATTRIBUTION_LOOKBACK_SENDS);
	return recent.find((send) => send.kind === 'automation' && reachedATransport(send)) ?? null;
}
