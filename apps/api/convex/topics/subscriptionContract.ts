/**
 * Topic subscription — the contract half.
 *
 * The source discriminators, outcome types, undo receipts, the source → effects
 * gating, the consent rule and the entry points' argument validators.
 * Everything here decides; nothing here touches `ctx`. `subscription.ts` owns
 * the registered entry points and `subscriptionOps.ts` the writes they compose.
 */

import { v, type Infer } from 'convex/values';
import { literalUnion } from '../lib/literalUnion';
import type { Doc, Id } from '../_generated/dataModel';

// ─── Source discriminators ──────────────────────────────────────────────────

const SUBSCRIBE_SOURCE_LITERALS = [
	'admin',
	'form',
	'import',
	'public_api',
	'automation',
	'preferences_page',
] as const;

export type SubscribeSource = (typeof SUBSCRIBE_SOURCE_LITERALS)[number];

const subscribeSourceValidator = literalUnion(SUBSCRIBE_SOURCE_LITERALS);

const UNSUBSCRIBE_SOURCE_LITERALS = [
	'admin',
	'public_email_link',
	'preferences_page',
	'public_api',
] as const;

export type UnsubscribeSource = (typeof UNSUBSCRIBE_SOURCE_LITERALS)[number];

const unsubscribeSourceValidator = literalUnion(UNSUBSCRIBE_SOURCE_LITERALS);

// ─── Outcome types ──────────────────────────────────────────────────────────

export type SubscribeOutcome =
	| {
			ok: true;
			action: 'subscribed';
			membershipId: Id<'contactTopics'>;
			// The global opt-out (`contacts.unsubscribedAt`) this subscribe lifted,
			// when it lifted one. An undo of the subscribe puts it back.
			liftedOptOutAt?: number;
	  }
	| {
			ok: true;
			action: 'pending_doi';
			membershipId: Id<'contactTopics'>;
			// The DOI confirmation token freshly written by the DOI lifecycle
			// during the `request_doi` effect. Surfaced so callers that record
			// a sibling row (e.g. the **Form submission (module)** writing
			// `formSubmissions.confirmationToken`) can avoid a contact re-read.
			doiToken: string;
	  }
	| { ok: true; action: 'already_member'; membershipId: Id<'contactTopics'> }
	| {
			ok: false;
			reason: 'contact_not_found' | 'topic_not_found' | 'contact_soft_deleted';
	  };

export type UnsubscribeOutcome =
	| { ok: true; action: 'unsubscribed'; topicId: Id<'topics'> }
	| { ok: true; action: 'not_member'; topicId: Id<'topics'> }
	| {
			ok: false;
			reason: 'contact_not_found' | 'topic_not_found';
			topicId?: Id<'topics'>;
	  };

// ─── Undo receipts ──────────────────────────────────────────────────────────
//
// What a bulk edit hands its caller so the edit can be undone exactly: the
// rows it inserted, or the rows it deleted as they were.

/** One membership a subscribe inserted, and the opt-out it lifted, if any. */
export const addedMembershipValidator = v.object({
	membershipId: v.id('contactTopics'),
	contactId: v.id('contacts'),
	liftedOptOutAt: v.optional(v.number()),
});
export type AddedMembership = Infer<typeof addedMembershipValidator>;

/**
 * One membership an unsubscribe deleted, with the fields a restore puts back.
 * `membershipId` is the id an add receipt knows the row by: its own, or the one
 * it was restored from (`contactTopics.restoredFrom`).
 */
export const removedMembershipValidator = v.object({
	membershipId: v.id('contactTopics'),
	contactId: v.id('contacts'),
	addedAt: v.number(),
	pendingDoiConfirmation: v.optional(v.boolean()),
	seedTag: v.optional(v.string()),
});
export type RemovedMembership = Infer<typeof removedMembershipValidator>;

// ─── Source → effects gating ────────────────────────────────────────────────
//
// The single place where "which side effects fire for which trigger" lives.
// New sources or new product decisions about which side effects fire land here.

interface UnsubscribeEffectFlags {
	incrementCampaignUnsubscribedStats: boolean;
	fireTopicUnsubscribedWebhook: boolean;
	/**
	 * Whether this unsubscribe is a RECEIVER-SIDE signal, i.e. the recipient
	 * reached for a link in a message we sent. Only those belong in the
	 * `unsubscribed` transport-outcome counter the standalone ramp's complaint
	 * proxy is derived from (`delivery/unsubscribeOutcome.ts`): an operator's
	 * bulk removal or an API caller's list hygiene says nothing about where our
	 * mail landed, and counting it would retreat a cell's ramp for an action the
	 * receivers never took.
	 */
	recordTransportUnsubscribeOutcome: boolean;
}

export function effectFlagsForUnsubscribeSource(source: UnsubscribeSource): UnsubscribeEffectFlags {
	switch (source) {
		case 'public_email_link':
			return {
				incrementCampaignUnsubscribedStats: true,
				fireTopicUnsubscribedWebhook: true,
				recordTransportUnsubscribeOutcome: true,
			};
		case 'preferences_page':
			return {
				incrementCampaignUnsubscribedStats: false,
				fireTopicUnsubscribedWebhook: true,
				// The preference centre is only reachable through the footer link of
				// a message we sent, so leaving from it is the same receiver-side
				// signal the one-click target is.
				recordTransportUnsubscribeOutcome: true,
			};
		case 'admin':
		case 'public_api':
			return {
				incrementCampaignUnsubscribedStats: false,
				fireTopicUnsubscribedWebhook: false,
				recordTransportUnsubscribeOutcome: false,
			};
	}
}

export function defaultUnsubscribeReason(source: UnsubscribeSource): string {
	switch (source) {
		case 'admin':
			return 'admin_remove';
		case 'public_email_link':
			return 'unsubscribe';
		case 'preferences_page':
			return 'preferences_page';
		case 'public_api':
			return 'api_remove';
	}
}

// ─── Consent rule ───────────────────────────────────────────────────────────
//
// A global opt-out (`contacts.unsubscribedAt`) is lifted by a completed opt-in.
// Who may complete one on the spot depends on who is asking. A public form
// takes any address from anyone, so on its own it never lifts an opt-out: the
// signup waits for a fresh confirmation, and an earlier confirmation does not
// count because the opt-out ended it.

/**
 * Whether a subscribe from `source` may lift a standing global opt-out on its
 * own authority.
 *   - `admin`, `import`, `public_api`, `automation`: an authenticated operator
 *     (session, API key, or an automation an operator built) acting on the
 *     record — the administrative override.
 *   - `preferences_page`: the recipient, through the capability link in a
 *     message sent to them.
 *   - `form`: no. Anonymous, so it needs the recipient's fresh confirmation.
 */
function sourceMayLiftOptOut(source: SubscribeSource): boolean {
	switch (source) {
		case 'admin':
		case 'import':
		case 'public_api':
		case 'automation':
		case 'preferences_page':
			return true;
		case 'form':
			return false;
	}
}

/**
 * The consent rule for one subscribe, and for a form signup without a topic:
 * whether it must wait for the recipient to confirm before it counts.
 *
 * True when the contact holds a global opt-out this source may not lift, or
 * when DOI applies (`doiRequired`, already net of `skipDoi`) and the contact
 * has not confirmed. Otherwise the subscribe completes at once and lifts any
 * opt-out.
 */
export function requiresFreshConfirmation(
	contact: Pick<Doc<'contacts'>, 'doiStatus' | 'unsubscribedAt'>,
	args: { source: SubscribeSource; doiRequired: boolean }
): boolean {
	if (contact.unsubscribedAt !== undefined && !sourceMayLiftOptOut(args.source)) return true;
	return args.doiRequired && contact.doiStatus !== 'confirmed';
}

// ─── Entry-point args ───────────────────────────────────────────────────────

export const subscribeArgsValidator = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	source: subscribeSourceValidator,
	skipDoi: v.optional(v.boolean()),
	forceDoi: v.optional(v.boolean()),
	siteUrl: v.optional(v.string()),
};

export const subscribeManyArgsValidator = {
	topicId: v.id('topics'),
	contactIds: v.array(v.id('contacts')),
	source: subscribeSourceValidator,
	skipDoi: v.optional(v.boolean()),
	siteUrl: v.optional(v.string()),
};

export const unsubscribeArgsValidator = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	source: unsubscribeSourceValidator,
	reason: v.optional(v.string()),
};

export const unsubscribeManyArgsValidator = {
	topicId: v.id('topics'),
	contactIds: v.array(v.id('contacts')),
	source: unsubscribeSourceValidator,
	reason: v.optional(v.string()),
};

export const unsubscribeAllForContactArgsValidator = {
	contactId: v.id('contacts'),
	/** The single-topic unsubscribe link. IGNORED when `topicIds` is also given. */
	topicId: v.optional(v.id('topics')),
	/**
	 * The preference centre's batch save. WINS over `topicId` when both are
	 * given: the array is the richer spelling of the same scope, so the union
	 * would silently widen a caller's intent and the singular would silently
	 * narrow it. Neither one present is the global opt-out — see the handler.
	 */
	topicIds: v.optional(v.array(v.id('topics'))),
	source: unsubscribeSourceValidator,
	reason: v.optional(v.string()),
};
