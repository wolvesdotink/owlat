import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { publicQuery } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { normalizeEmail } from '../lib/inputGuards';
import { afterEventSecond } from '../lib/clock';
import { isAwaitingDoubleOptIn } from '../lib/marketingEligibility';
import type { UnsubscribeOutcome } from '../topics/subscription';
import { resolveWorkspaceLogo, type WorkspaceLogo } from '../workspaces/branding';

type ProcessUnsubscribeResult =
	| { success: false; reason: 'not_found' }
	| { success: true; alreadyUnsubscribed: true }
	| { success: true; alreadyUnsubscribed: false; listsRemoved: number };

/** A relay unsubscribe older than the contact's re-subscribe, left unapplied. */
type RelayUnsubscribeSkipped = { success: true; skipped: 'resubscribed_after_event' };

/**
 * Who is sending — for the recipient-facing pages (unsubscribe, preferences,
 * subscription confirmation). A recipient has never heard of Owlat, so those
 * pages lead with the sender's name, and when a link is broken or expired they
 * offer the sender's address as the other way to opt out.
 *
 * Token-independent on purpose: the error states are exactly the ones where no
 * token resolves. It returns only what every campaign already carries in its
 * From header — the instance's default sender name and address — plus the
 * workspace logo, which exists to be shown on exactly these pages (#810).
 *
 * The sign-in and invitation pages read it too: they are the same kind of
 * page, reached without an account.
 */
// public: recipient pages name the sender before (or without) a valid token; returns only the public From identity
// authz: no session on recipient pages; the From name and address and the logo are public by construction.
// token-safe: projects instanceSettings to the sender name, address and logo URLs only.
export const getRecipientSender = publicQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{ name: string | null; contactEmail: string | null } & WorkspaceLogo> => {
		const settings = await ctx.db.query('instanceSettings').first();
		return {
			name: settings?.defaultFromName?.trim() || null,
			contactEmail: settings?.defaultFromEmail?.trim() || null,
			...(await resolveWorkspaceLogo(ctx, settings)),
		};
	},
});

// Internal query to get contact for unsubscribe verification
export const getContactForUnsubscribe = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return null;

		// Get instance display name from settings
		const settings = await ctx.db.query('instanceSettings').first();

		// Check if contact is subscribed to any topics
		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: one contact's topic memberships

		const hasActiveSubscriptions = memberships.length > 0;

		return {
			_id: contact._id,
			email: contact.email,
			firstName: contact.firstName,
			lastName: contact.lastName,
			subscribed: hasActiveSubscriptions,
			organizationName: settings?.defaultFromName ?? 'Unknown',
		};
	},
});

/**
 * Public unsubscribe link entry point.
 *
 * Thin shell delegating to the Topic subscription (module)'s
 * `unsubscribeAllForContact` entry. The module owns the membership delete,
 * the topic_unsubscribed activity row, the cachedMemberCount decrement, the
 * contact.updatedAt patch, the campaigns.statsUnsubscribed increment, and the
 * topic.unsubscribed webhook fanout — all gated on
 * `source: 'public_email_link'`. A global opt-out also withdraws the contact's
 * DOI confirmation token. Whether a later signup must confirm again is decided
 * from the contact row by `requiresFreshConfirmation` (topics/subscription.ts),
 * not from the form submissions, whose `confirmedAt` an unsubscribe keeps.
 *
 * See docs/adr/0013-topic-subscription-module.md.
 */
export const processUnsubscribe = internalMutation({
	args: {
		contactId: v.id('contacts'),
		topicId: v.optional(v.id('topics')), // Optional: specific topic to unsubscribe from
	},
	handler: async (ctx, args): Promise<ProcessUnsubscribeResult> => {
		return await applyPublicUnsubscribe(ctx, args);
	},
});

/**
 * The shared body of the public unsubscribe: delegate to the Topic
 * subscription (module) and translate its outcomes into the legacy response
 * shape. Both entry points below go through this so a link click and a relay's
 * `unsub` webhook cannot drift apart in source, reason or reported result.
 */
async function applyPublicUnsubscribe(
	ctx: MutationCtx,
	args: { contactId: Id<'contacts'>; topicId?: Id<'topics'>; topicIds?: Id<'topics'>[] }
): Promise<ProcessUnsubscribeResult> {
	const { outcomes }: { outcomes: UnsubscribeOutcome[] } = await ctx.runMutation(
		internal.topics.subscription.unsubscribeAllForContact,
		{
			contactId: args.contactId,
			...(args.topicId ? { topicId: args.topicId } : {}),
			...(args.topicIds ? { topicIds: args.topicIds } : {}),
			source: 'public_email_link',
			reason: 'unsubscribe',
		}
	);

	// Preserve the legacy response shape.
	// - contact_not_found maps to { success: false, reason: 'not_found' }.
	// - no memberships removed (already not a member, or empty memberships):
	//   { success: true, alreadyUnsubscribed: true }.
	// - removals happened: { success: true, alreadyUnsubscribed: false, listsRemoved }.
	for (const outcome of outcomes) {
		if (!outcome.ok && outcome.reason === 'contact_not_found') {
			return { success: false, reason: 'not_found' };
		}
	}

	const removedCount = outcomes.filter((o) => o.ok && o.action === 'unsubscribed').length;

	if (removedCount === 0) {
		return { success: true, alreadyUnsubscribed: true };
	}

	return {
		success: true,
		alreadyUnsubscribed: false,
		listsRemoved: removedCount,
	};
}

/**
 * Address-keyed entry point for a RELAY-reported unsubscribe (Mandrill
 * `unsub`).
 *
 * A relay's unsubscribe surface knows an email address and nothing else — there
 * is no contact id and no send on the wire — so the join has to happen here. It
 * then takes the SAME path a click on our own one-click link takes, deliberately:
 * a departure that reached us through the reference arm must produce the same
 * membership delete, the same `contacts.unsubscribedAt` opt-out stamp, the same
 * `topic.unsubscribed` webhook and the same `unsubscribed` transport outcome as
 * one that reached us directly, or the two arms disagree about who is still
 * mailable and gate 3's complaint proxy reads the difference as a signal.
 *
 * `source: 'public_email_link'` (via the shared body above) is the honest label:
 * a recipient reached for an unsubscribe link in a message we sent. It is not an
 * operator's bulk removal, which is what the `admin` source exists to exclude
 * from the outcome counter.
 *
 * FAIL-SOFT: an address with no contact — a suppressed one-off, or a contact
 * deleted since the send — returns `not_found` rather than throwing, so the
 * webhook acknowledges instead of asking the relay to redeliver forever.
 *
 * `eventAt` (#1228) is when the relay saw the person leave. The event reports
 * what they were subscribed to THEN, so a late or replayed one must not undo a
 * re-subscribe that came after it — see {@link applyRelayUnsubscribe}.
 */
export const processUnsubscribeByEmail = internalMutation({
	args: { email: v.string(), eventAt: v.optional(v.number()) },
	handler: async (ctx, args): Promise<ProcessUnsubscribeResult | RelayUnsubscribeSkipped> => {
		const normalized = normalizeEmail(args.email);
		if (!normalized) return { success: false, reason: 'not_found' };
		const contact = await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) => q.eq('email', normalized))
			.first();
		if (!contact) return { success: false, reason: 'not_found' };
		if (args.eventAt === undefined) {
			return await applyPublicUnsubscribe(ctx, { contactId: contact._id });
		}
		return await applyRelayUnsubscribe(ctx, contact, args.eventAt);
	},
});

/**
 * Apply a relay unsubscribe observed at `eventAt`, minus whatever the contact
 * COMPLETED an opt-in to after it.
 *
 *  - A double opt-in confirmed after the event is the contact's own, later
 *    consent: nothing is applied.
 *  - No completed membership added after the event: the ordinary global
 *    unsubscribe, which also removes a signup still waiting for confirmation.
 *    Only a completed opt-in may stand against an opt-out: an anonymous form
 *    can create a pending membership for any address, and had the opt-out been
 *    recorded on time that signup would have had to wait for a fresh
 *    confirmation anyway. The person can sign up again.
 *  - Otherwise the contact was subscribed again, with a completed opt-in, after
 *    they left. Those memberships stay and the global opt-out is not stamped (a
 *    subscribe allowed to complete over an opt-out lifts it); everything else,
 *    including pending signups, is removed.
 *
 * Millisecond `addedAt` and `doiConfirmedAt` against Mandrill's whole-second
 * `ts` are compared through `afterEventSecond`: a subscribe or a confirmation in
 * the event's own second counts as before it, the side that unsubscribes.
 */
async function applyRelayUnsubscribe(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	eventAt: number
): Promise<ProcessUnsubscribeResult | RelayUnsubscribeSkipped> {
	const skipped: RelayUnsubscribeSkipped = { success: true, skipped: 'resubscribed_after_event' };
	const later = afterEventSecond(eventAt);
	if (contact.doiConfirmedAt !== undefined && contact.doiConfirmedAt >= later) return skipped;
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contact._id))
		.collect(); // bounded: one contact's topic memberships
	const kept = new Set<Id<'contactTopics'>>();
	for (const membership of memberships) {
		if (membership.addedAt >= later && (await isCompletedOptIn(ctx, contact, membership))) {
			kept.add(membership._id);
		}
	}
	if (kept.size === 0) return await applyPublicUnsubscribe(ctx, { contactId: contact._id });
	const removedTopicIds = memberships
		.filter((membership) => !kept.has(membership._id))
		.map((membership) => membership.topicId);
	if (removedTopicIds.length === 0) return skipped;
	return await applyPublicUnsubscribe(ctx, { contactId: contact._id, topicIds: removedTopicIds });
}

/**
 * Whether a membership is a completed opt-in: one the topic audience would mail,
 * as opposed to a signup still waiting for double opt-in. Decided by the
 * audience selector's own predicate, so an admin `skipDoi` subscribe counts as
 * completed exactly when it would be mailed.
 */
async function isCompletedOptIn(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	membership: Doc<'contactTopics'>
): Promise<boolean> {
	const topic = await ctx.db.get(membership.topicId);
	return !isAwaitingDoubleOptIn(
		contact,
		topic?.requireDoubleOptIn === true,
		membership.pendingDoiConfirmation
	);
}
