/**
 * Contact marketing eligibility (helper) — the single definition of "may this
 * Contact still receive MARKETING mail?" at the contact level.
 *
 * Two contact-level facts end marketing eligibility, and every marketing path
 * has to agree on both:
 *   - `contacts.deletedAt` — the Contact was soft-deleted. It stays readable
 *     for the retention window, so an existence check alone lets it through.
 *     A Contact row that is GONE (permanently erased) is read the same way.
 *   - `contacts.unsubscribedAt` — the global marketing opt-out stamped by the
 *     public unsubscribe link / preference-center "unsubscribe from
 *     everything". That path writes NO `blockedEmails` row, so the suppression
 *     list alone never sees it.
 *
 * The `blockedEmails` suppression list is a separate, address-keyed boundary
 * owned by `lib/suppression.ts`; it is not repeated here.
 *
 * MARKETING ONLY. Neither fact blocks transactional mail: the schema documents
 * `unsubscribedAt` as marketing-only, and a soft-deleted contact's pending
 * receipt or password reset is not ours to drop by this rule. Callers decide
 * per send kind whether this gate applies (see `SUPPRESSION_SCOPE_BY_KIND` in
 * `delivery/nonCampaignIntake.ts` and `delivery/marketingDispatchGate.ts`).
 *
 * A third rule applies to segment audiences only: a Contact a transactional send
 * created needs a topic membership or a confirmed opt-in first
 * (`needsMembershipForSegment`).
 *
 * Consumers: campaign audience resolution (`campaigns/audienceCandidates.ts`),
 * the automation step claim (`automations/stepOrchestration.ts`), the
 * non-campaign intake for automation sends, and the worker's last gate before
 * dispatch.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** Why a Contact may no longer receive marketing mail. */
export const marketingIneligibilityValidator = v.union(
	v.literal('contact_deleted'),
	v.literal('contact_unsubscribed')
);

/** @see marketingIneligibilityValidator */
export type MarketingIneligibility = Infer<typeof marketingIneligibilityValidator>;

/**
 * The eligibility decision for one loaded Contact. `null` means eligible.
 * A missing row (`null`) is ineligible: a permanently erased Contact must not be
 * mailed from work that was queued while it still existed.
 */
export function contactMarketingIneligibility(
	contact: Pick<Doc<'contacts'>, 'deletedAt' | 'unsubscribedAt'> | null
): MarketingIneligibility | null {
	if (contact === null || contact.deletedAt !== undefined) return 'contact_deleted';
	if (contact.unsubscribedAt !== undefined) return 'contact_unsubscribed';
	return null;
}

/** {@link contactMarketingIneligibility} for a Contact id — one point read. */
export async function loadContactMarketingIneligibility(
	ctx: QueryCtx | MutationCtx,
	contactId: Id<'contacts'>
): Promise<MarketingIneligibility | null> {
	return contactMarketingIneligibility(await ctx.db.get(contactId));
}

/**
 * Whether a topic membership is still waiting for double opt-in, so the topic
 * audience will not mail it. THE definition: the audience selector
 * (`campaigns/audienceCandidates.ts` `selectRecipient`) excludes exactly these,
 * and the relay unsubscribe (`delivery/unsubscribeQueries.ts`) refuses to treat
 * them as a completed opt-in.
 *
 *  - The topic requires DOI and the contact has neither confirmed nor been
 *    marked `not_required` (an admin `skipDoi` subscribe, an import attest).
 *  - Or the membership carries `pendingDoiConfirmation`: a form forced DOI on a
 *    topic that does not require it, and the contact has not confirmed yet.
 */
export function isAwaitingDoubleOptIn(
	contact: Pick<Doc<'contacts'>, 'doiStatus'>,
	topicRequiresDoi: boolean,
	membershipPendingDoi: boolean | undefined
): boolean {
	if (
		topicRequiresDoi &&
		contact.doiStatus !== 'confirmed' &&
		contact.doiStatus !== 'not_required'
	) {
		return true;
	}
	return membershipPendingDoi === true;
}

/**
 * Whether a segment must check this Contact's topic memberships before it may
 * mail it: the Contact was created by a transactional send (`source` is set at
 * creation and never rewritten) and has not confirmed an opt-in. Someone who
 * only ever received a receipt gave no consent to marketing, so a segment, which
 * selects from the whole contacts table, may reach them only once they hold a
 * topic membership or a confirmed opt-in. Imports, forms and the API create
 * contacts under their own source, so no other contact pays for the probe.
 *
 * Segment audiences only: a topic audience already starts from a membership.
 */
export function needsMembershipForSegment(
	contact: Pick<Doc<'contacts'>, 'source' | 'doiStatus'>
): boolean {
	return contact.source === 'transactional' && contact.doiStatus !== 'confirmed';
}

/** Whether the Contact holds any topic membership. One indexed read. */
export async function holdsTopicMembership(
	ctx: QueryCtx | MutationCtx,
	contactId: Id<'contacts'>
): Promise<boolean> {
	const membership = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.first();
	return membership !== null;
}
