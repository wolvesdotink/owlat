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
 * A topic adds a third fact for mail sent on its behalf: the Contact must still
 * be a member the topic audience would mail (`topicIneligibility`). A campaign
 * to the topic selects exactly those members, and an automation that belongs
 * to a topic (`automationTopicId`) gates each email on the same rule, so both
 * agree about who may be mailed.
 *
 * A further rule applies to segment audiences only: a Contact a transactional send
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
	v.literal('contact_unsubscribed'),
	// Not a mailable member of the topic the mail is sent for: the membership
	// was removed, the topic was deleted (which deletes its memberships), or the
	// membership still waits for double opt-in.
	v.literal('topic_unsubscribed')
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
): Exclude<MarketingIneligibility, 'topic_unsubscribed'> | null {
	if (contact === null || contact.deletedAt !== undefined) return 'contact_deleted';
	if (contact.unsubscribedAt !== undefined) return 'contact_unsubscribed';
	return null;
}

/** {@link contactMarketingIneligibility} for a Contact id — one point read. */
export async function loadContactMarketingIneligibility(
	ctx: QueryCtx | MutationCtx,
	contactId: Id<'contacts'>
): Promise<Exclude<MarketingIneligibility, 'topic_unsubscribed'> | null> {
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

/**
 * Whether the Contact is no longer a member the topic audience would mail:
 * `'topic_unsubscribed'`, or `null` when it still is. The topic audience
 * (`campaigns/audienceCandidates.ts`) mails a membership row that is not
 * awaiting double opt-in; this is that rule for one Contact. A deleted topic
 * has no memberships left (`topics/topics.ts` `remove`), so it reads as left,
 * as a campaign to it reaches nobody. Two point reads, three when a membership
 * exists.
 */
export async function topicIneligibility(
	ctx: QueryCtx | MutationCtx,
	contact: Pick<Doc<'contacts'>, '_id' | 'doiStatus'>,
	topicId: Id<'topics'>
): Promise<'topic_unsubscribed' | null> {
	const membership = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact_and_topic', (q) => q.eq('contactId', contact._id).eq('topicId', topicId))
		.first();
	if (membership === null) return 'topic_unsubscribed';
	const topic = await ctx.db.get(topicId);
	if (topic === null) return 'topic_unsubscribed';
	return isAwaitingDoubleOptIn(
		contact,
		topic.requireDoubleOptIn === true,
		membership.pendingDoiConfirmation
	)
		? 'topic_unsubscribed'
		: null;
}

/**
 * The topic an automation's emails are sent for, or `null` when they belong to
 * none. `automations.topicId` decides when it is set (`null` is an explicit "no
 * topic"). Unset, a "Subscribed to topic" automation belongs to its trigger's
 * topic, so a contact who leaves the topic that started the series stops
 * getting it; any other trigger has no topic. Derived here, at read time, so
 * automations written before the field existed need no backfill.
 */
export function automationTopicId(
	ctx: QueryCtx | MutationCtx,
	automation: Pick<Doc<'automations'>, 'topicId' | 'triggerType' | 'triggerConfig'>
): Id<'topics'> | null {
	if (automation.topicId !== undefined) return automation.topicId;
	if (automation.triggerType !== 'topic_subscribed') return null;
	const configured = (automation.triggerConfig as { topicId?: unknown } | undefined)?.topicId;
	return typeof configured === 'string' ? ctx.db.normalizeId('topics', configured) : null;
}

/**
 * {@link topicIneligibility} for the topic `automation` belongs to, or `null`
 * when it belongs to none.
 */
export async function automationTopicIneligibility(
	ctx: QueryCtx | MutationCtx,
	automation: Pick<Doc<'automations'>, 'topicId' | 'triggerType' | 'triggerConfig'>,
	contact: Pick<Doc<'contacts'>, '_id' | 'doiStatus'>
): Promise<{ reason: 'topic_unsubscribed'; topicId: Id<'topics'> } | null> {
	const topicId = automationTopicId(ctx, automation);
	if (topicId === null) return null;
	const reason = await topicIneligibility(ctx, contact, topicId);
	return reason === null ? null : { reason, topicId };
}
