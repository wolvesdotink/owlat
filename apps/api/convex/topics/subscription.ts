/**
 * Topic subscription (module) — single writer of contactTopics, source-conditional effects.
 *
 * Owns:
 *   - every write to `contactTopics` (insert + delete)
 *   - every maintenance of `topics.cachedMemberCount` (increment + decrement)
 *   - the DOI gate at subscribe time + the `request_doi` handoff to the DOI lifecycle
 *   - the `topic_subscribed` trigger fire when DOI is not in the way
 *   - the per-source effect bundle on unsubscribe (activity row, contact.updatedAt,
 *     form-confirmation clear, campaign-stats increment, topic.unsubscribed webhook)
 *
 * Five entry points keyed by shape:
 *   subscribe / subscribeMany                — one topic, one-or-many contacts
 *   unsubscribe / unsubscribeMany            — one topic, one-or-many contacts
 *   unsubscribeAllForContact                 — one contact, one-or-all topics
 *
 * Per-call effects (cached count patch, contact.updatedAt patch, form-clear,
 * campaign-stats, webhook) fire ONCE per call regardless of how many memberships
 * are touched. Per-membership effects (insert, delete, activity row) fire N times.
 *
 * See docs/adr/0013-topic-subscription-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { nanoid } from 'nanoid';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycle';
import { scheduleFanout } from '../webhooks/scheduleFanout';
import { recordContactActivity } from '../contactActivities/writer';

// ─── Source discriminators ──────────────────────────────────────────────────

export const SUBSCRIBE_SOURCE_LITERALS = [
	'admin',
	'form',
	'import',
	'public_api',
	'automation',
	'preferences_page',
] as const;

export type SubscribeSource = (typeof SUBSCRIBE_SOURCE_LITERALS)[number];

const subscribeSourceValidator = v.union(
	...SUBSCRIBE_SOURCE_LITERALS.map((l) => v.literal(l)),
);

export const UNSUBSCRIBE_SOURCE_LITERALS = [
	'admin',
	'public_email_link',
	'preferences_page',
	'public_api',
] as const;

export type UnsubscribeSource = (typeof UNSUBSCRIBE_SOURCE_LITERALS)[number];

const unsubscribeSourceValidator = v.union(
	...UNSUBSCRIBE_SOURCE_LITERALS.map((l) => v.literal(l)),
);

// ─── Outcome types ──────────────────────────────────────────────────────────

export type SubscribeOutcome =
	| { ok: true; action: 'subscribed'; membershipId: Id<'contactTopics'> }
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
			reason:
				| 'contact_not_found'
				| 'topic_not_found'
				| 'contact_soft_deleted';
	  };

export type UnsubscribeOutcome =
	| { ok: true; action: 'unsubscribed'; topicId: Id<'topics'> }
	| { ok: true; action: 'not_member'; topicId: Id<'topics'> }
	| {
			ok: false;
			reason: 'contact_not_found' | 'topic_not_found';
			topicId?: Id<'topics'>;
	  };

// ─── Source → effects gating ────────────────────────────────────────────────
//
// The single place where "which side effects fire for which trigger" lives.
// New sources or new product decisions about which side effects fire land here.

interface UnsubscribeEffectFlags {
	clearFormSubmissionConfirmations: boolean;
	incrementCampaignUnsubscribedStats: boolean;
	fireTopicUnsubscribedWebhook: boolean;
}

function effectFlagsForUnsubscribeSource(
	source: UnsubscribeSource,
): UnsubscribeEffectFlags {
	switch (source) {
		case 'public_email_link':
			return {
				clearFormSubmissionConfirmations: true,
				incrementCampaignUnsubscribedStats: true,
				fireTopicUnsubscribedWebhook: true,
			};
		case 'preferences_page':
			return {
				clearFormSubmissionConfirmations: true,
				incrementCampaignUnsubscribedStats: false,
				fireTopicUnsubscribedWebhook: true,
			};
		case 'admin':
		case 'public_api':
			return {
				clearFormSubmissionConfirmations: false,
				incrementCampaignUnsubscribedStats: false,
				fireTopicUnsubscribedWebhook: false,
			};
	}
}

function defaultUnsubscribeReason(source: UnsubscribeSource): string {
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

// ─── Subscribe side ─────────────────────────────────────────────────────────

interface SubscribeOneResult {
	outcome: SubscribeOutcome;
	// Number of new memberships inserted (0 or 1). Used by the caller to
	// coalesce the cachedMemberCount patch.
	insertedCount: number;
}

async function subscribeOne(
	ctx: MutationCtx,
	args: {
		topic: Doc<'topics'>;
		contactId: Id<'contacts'>;
		source: SubscribeSource;
		skipDoi: boolean;
		/**
		 * Force double opt-in even when the topic itself does not require it.
		 * Set by callers (e.g. a public form whose own "Enable Double Opt-In"
		 * toggle is on) so DOI is the UNION of the form and topic controls —
		 * never weaker than either. Ignored when `skipDoi` is set.
		 */
		forceDoi?: boolean;
		siteUrl: string | undefined;
		now: number;
	},
): Promise<SubscribeOneResult> {
	const contact = await ctx.db.get(args.contactId);
	if (!contact) {
		return {
			outcome: { ok: false, reason: 'contact_not_found' },
			insertedCount: 0,
		};
	}
	if (contact.deletedAt !== undefined) {
		return {
			outcome: { ok: false, reason: 'contact_soft_deleted' },
			insertedCount: 0,
		};
	}

	const existing = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact_and_topic', (q) =>
			q.eq('contactId', args.contactId).eq('topicId', args.topic._id),
		)
		.first();

	if (existing) {
		return {
			outcome: {
				ok: true,
				action: 'already_member',
				membershipId: existing._id,
			},
			insertedCount: 0,
		};
	}

	const membershipId = await ctx.db.insert('contactTopics', {
		contactId: args.contactId,
		topicId: args.topic._id,
		addedAt: args.now,
	});

	const requiresDoi =
		(args.topic.requireDoubleOptIn === true || args.forceDoi === true) &&
		args.skipDoi !== true;

	if (!requiresDoi || contact.doiStatus === 'confirmed') {
		// A completed opt-in (DOI not required, or the contact already
		// confirmed) lifts the global marketing opt-out — they are actively
		// opting back in, so they should once again be reachable by matching
		// audiences. Clears the `contacts.unsubscribedAt` signal set by a prior
		// global unsubscribe (see schema/contacts.ts).
		//
		// Deliberately NOT cleared on the DOI-pending path below: a public form
		// (unauthenticated, any email) bound to a DOI topic must not silently
		// lift a persistent opt-out without a confirmed opt-in — that would
		// re-open the CAN-SPAM/GDPR gap PR-09 closes. For the pending path the
		// opt-out is lifted only at DOI-confirm time, in the lifecycle
		// (contacts/doiLifecycle.ts reduceConfirmed).
		if (contact.unsubscribedAt !== undefined) {
			await ctx.db.patch(args.contactId, { unsubscribedAt: undefined });
		}

		// DOI is not in the way — fire the trigger now.
		await ctx.runMutation(
			internal.automations.triggers.fireTopicSubscribedTrigger,
			{
				contactId: args.contactId,
				topicId: args.topic._id,
			},
		);
		return {
			outcome: { ok: true, action: 'subscribed', membershipId },
			insertedCount: 1,
		};
	}

	// DOI is required and the contact is not yet confirmed.
	// Hand off to the DOI lifecycle — its `fire_topic_subscribed_triggers`
	// effect at confirm time covers every DOI-required membership the
	// Contact has at that moment, so this module does not double-fire.
	//
	// The confirm-time fanout keys off `topic.requireDoubleOptIn`, so a
	// membership deferred purely because the FORM forced DOI (on a topic that
	// doesn't require it) would be missed. Flag it so the fanout still fires
	// its trigger + activity; topic-DOI memberships are already covered and
	// don't need the flag.
	if (args.forceDoi === true && args.topic.requireDoubleOptIn !== true) {
		await ctx.db.patch(membershipId, { pendingDoiConfirmation: true });
	}

	const tokenCandidate = nanoid(32);
	await ctx.runMutation(internal.contacts.doiLifecycle.transition, {
		contactId: args.contactId,
		input: {
			to: 'pending',
			at: args.now,
			token: tokenCandidate,
			ttlMs: DOI_TOKEN_TTL_MS,
			...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
		},
	});

	// The DOI lifecycle writes the candidate token when transitioning from
	// `not_required → pending`, but keeps the existing token on the
	// `pending → pending` idempotent path. Re-read so callers receive
	// whichever token is actually stored.
	const updatedContact = await ctx.db.get(args.contactId);
	const doiToken = updatedContact?.doiConfirmationToken ?? tokenCandidate;

	return {
		outcome: { ok: true, action: 'pending_doi', membershipId, doiToken },
		insertedCount: 1,
	};
}

async function patchCachedMemberCountDelta(
	ctx: MutationCtx,
	topic: Doc<'topics'>,
	delta: number,
	now: number,
): Promise<void> {
	if (delta === 0) return;
	const current = topic.cachedMemberCount ?? 0;
	await ctx.db.patch(topic._id, {
		cachedMemberCount: Math.max(0, current + delta),
		cachedCountUpdatedAt: now,
	});
}

// ─── Unsubscribe side ───────────────────────────────────────────────────────

interface UnsubscribeOneResult {
	outcome: UnsubscribeOutcome;
	// Whether a membership row was actually deleted. The caller uses this to
	// coalesce the per-topic cachedMemberCount decrement.
	deleted: boolean;
	// Membership context captured for the per-call effects (webhook payload,
	// observability). Only populated when `deleted` is true.
	context?: {
		topicId: Id<'topics'>;
		topicName: string;
	};
}

async function unsubscribeOne(
	ctx: MutationCtx,
	args: {
		topic: Doc<'topics'>;
		contactId: Id<'contacts'>;
		source: UnsubscribeSource;
		reason: string;
		now: number;
	},
): Promise<UnsubscribeOneResult> {
	const membership = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact_and_topic', (q) =>
			q.eq('contactId', args.contactId).eq('topicId', args.topic._id),
		)
		.first();

	if (!membership) {
		return {
			outcome: { ok: true, action: 'not_member', topicId: args.topic._id },
			deleted: false,
		};
	}

	await ctx.db.delete(membership._id);

	await recordContactActivity(ctx, {
		literal: 'topic_unsubscribed',
		contactId: args.contactId,
		metadata: {
			topicId: String(args.topic._id),
			topicName: args.topic.name,
			reason: args.reason,
		},
		occurredAt: args.now,
	});

	return {
		outcome: { ok: true, action: 'unsubscribed', topicId: args.topic._id },
		deleted: true,
		context: { topicId: args.topic._id, topicName: args.topic.name },
	};
}

async function clearFormSubmissionConfirmations(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
): Promise<void> {
	const formSubmissions = await ctx.db
		.query('formSubmissions')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.filter((q) => q.neq(q.field('confirmedAt'), undefined))
		.collect(); // bounded: one contact's form submissions

	for (const submission of formSubmissions) {
		await ctx.db.patch(submission._id, {
			confirmedAt: undefined,
		});
	}
}

/**
 * Attribute a contact's unsubscribe to their most-recent campaign send, OFF the
 * synchronous public-unsubscribe path. Scheduled (not called inline) so the
 * RFC 8058 one-click response isn't gated on an OCC retry of the shared campaign
 * row during a post-blast unsubscribe burst, and so `statsUnsubscribed` — an
 * AGGREGATED field — is written by an internal mutation rather than the
 * user-facing unsubscribe mutation (restoring the schema contract).
 */
export const recordCampaignUnsubscribe = internalMutation({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const recentEmailSend = await ctx.db
			.query('emailSends')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.order('desc')
			.first();
		if (!recentEmailSend) return;
		const campaign = await ctx.db.get(recentEmailSend.campaignId);
		if (!campaign) return;
		await ctx.db.patch(campaign._id, {
			statsUnsubscribed: (campaign.statsUnsubscribed ?? 0) + 1,
			updatedAt: Date.now(),
		});
	},
});

async function fireTopicUnsubscribedWebhook(
	ctx: MutationCtx,
	args: {
		contactId: Id<'contacts'>;
		removedTopics: Array<{ topicId: Id<'topics'>; topicName: string }>;
		now: number;
	},
): Promise<void> {
	if (args.removedTopics.length === 0) return;
	const contact = await ctx.db.get(args.contactId);
	// Email is optional on Contacts (phone/SMS/WhatsApp/generic origin), but
	// the webhook payload contract requires a string. Fall back to '' so
	// subscribers can still observe the unsubscribe event without breaking
	// the contract — matches the legacy behavior in unsubscribeQueries.ts.
	const emailForWebhook = contact?.email ?? '';

	await scheduleFanout(ctx, {
		literal: 'topic.unsubscribed',
		input: {
			contactId: args.contactId,
			email: emailForWebhook,
			unsubscribedAt: args.now,
			lists: args.removedTopics.map((t) => ({
				topicId: String(t.topicId),
				topicName: t.topicName,
			})),
		},
	});
}

// ─── Per-call effect runner ─────────────────────────────────────────────────

async function applyUnsubscribeCallEffects(
	ctx: MutationCtx,
	args: {
		contactId: Id<'contacts'>;
		removedTopics: Array<{ topicId: Id<'topics'>; topicName: string }>;
		source: UnsubscribeSource;
		now: number;
	},
): Promise<void> {
	if (args.removedTopics.length === 0) return;

	// Always (when at least one removal happened): patch contact.updatedAt.
	const contact = await ctx.db.get(args.contactId);
	if (contact) {
		await ctx.db.patch(args.contactId, { updatedAt: args.now });
	}

	const flags = effectFlagsForUnsubscribeSource(args.source);

	if (flags.clearFormSubmissionConfirmations) {
		await clearFormSubmissionConfirmations(ctx, args.contactId);
	}

	if (flags.incrementCampaignUnsubscribedStats) {
		// Off the synchronous path — see recordCampaignUnsubscribe.
		await ctx.scheduler.runAfter(0, internal.topics.subscription.recordCampaignUnsubscribe, {
			contactId: args.contactId,
		});
	}

	if (flags.fireTopicUnsubscribedWebhook) {
		await fireTopicUnsubscribedWebhook(ctx, {
			contactId: args.contactId,
			removedTopics: args.removedTopics,
			now: args.now,
		});
	}
}

// ─── Entry points ───────────────────────────────────────────────────────────

const subscribeArgsValidator = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	source: subscribeSourceValidator,
	skipDoi: v.optional(v.boolean()),
	forceDoi: v.optional(v.boolean()),
	siteUrl: v.optional(v.string()),
};

/**
 * Subscribe a Contact to a Topic. Single membership op.
 */
export const subscribe = internalMutation({
	args: subscribeArgsValidator,
	handler: async (ctx, args): Promise<SubscribeOutcome> => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) return { ok: false, reason: 'topic_not_found' };

		const now = Date.now();
		const { outcome, insertedCount } = await subscribeOne(ctx, {
			topic,
			contactId: args.contactId,
			source: args.source,
			skipDoi: args.skipDoi === true,
			forceDoi: args.forceDoi === true,
			siteUrl: args.siteUrl,
			now,
		});

		if (insertedCount > 0) {
			await patchCachedMemberCountDelta(ctx, topic, insertedCount, now);
		}

		return outcome;
	},
});

const subscribeManyArgsValidator = {
	topicId: v.id('topics'),
	contactIds: v.array(v.id('contacts')),
	source: subscribeSourceValidator,
	skipDoi: v.optional(v.boolean()),
	siteUrl: v.optional(v.string()),
};

/**
 * Subscribe many Contacts to one Topic. Coalesces the cachedMemberCount
 * patch (one patch per call regardless of array size). Per-contact effects
 * (trigger fire, DOI handoff) fire N times.
 */
export const subscribeMany = internalMutation({
	args: subscribeManyArgsValidator,
	handler: async (
		ctx,
		args,
	): Promise<{ outcomes: SubscribeOutcome[] }> => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			return {
				outcomes: args.contactIds.map(
					(): SubscribeOutcome => ({ ok: false, reason: 'topic_not_found' }),
				),
			};
		}

		const now = Date.now();
		const outcomes: SubscribeOutcome[] = [];
		let totalInserted = 0;

		for (const contactId of args.contactIds) {
			const result = await subscribeOne(ctx, {
				topic,
				contactId,
				source: args.source,
				skipDoi: args.skipDoi === true,
				siteUrl: args.siteUrl,
				now,
			});
			outcomes.push(result.outcome);
			totalInserted += result.insertedCount;
		}

		if (totalInserted > 0) {
			await patchCachedMemberCountDelta(ctx, topic, totalInserted, now);
		}

		return { outcomes };
	},
});

const unsubscribeArgsValidator = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	source: unsubscribeSourceValidator,
	reason: v.optional(v.string()),
};

/**
 * Unsubscribe a Contact from a Topic. Single membership op.
 *
 * Per-call effects (cached count decrement, contact.updatedAt, form-clear,
 * campaign-stats, webhook) fire ONCE for the single membership. The webhook
 * payload's `lists` array contains exactly one entry.
 */
export const unsubscribe = internalMutation({
	args: unsubscribeArgsValidator,
	handler: async (ctx, args): Promise<UnsubscribeOutcome> => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			return { ok: false, reason: 'topic_not_found', topicId: args.topicId };
		}

		// Defensive contact lookup — preserves the legacy 'contact_not_found'
		// outcome for callers expecting it. A soft-deleted contact still has
		// its membership rows (cascade is hard-delete on identities, not on
		// memberships), so we treat soft-deleted as unsubscribable for the
		// remove side — same as the public unsubscribe link's behavior today.
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			return {
				ok: false,
				reason: 'contact_not_found',
				topicId: args.topicId,
			};
		}

		const now = Date.now();
		const reason = args.reason ?? defaultUnsubscribeReason(args.source);

		const result = await unsubscribeOne(ctx, {
			topic,
			contactId: args.contactId,
			source: args.source,
			reason,
			now,
		});

		if (result.deleted && result.context) {
			await patchCachedMemberCountDelta(ctx, topic, -1, now);
			await applyUnsubscribeCallEffects(ctx, {
				contactId: args.contactId,
				removedTopics: [result.context],
				source: args.source,
				now,
			});
		}

		return result.outcome;
	},
});

const unsubscribeManyArgsValidator = {
	topicId: v.id('topics'),
	contactIds: v.array(v.id('contacts')),
	source: unsubscribeSourceValidator,
	reason: v.optional(v.string()),
};

/**
 * Unsubscribe many Contacts from one Topic. Coalesces the cachedMemberCount
 * patch. Per-contact effects (activity row, contact.updatedAt, form-clear,
 * campaign-stats, webhook) fire per contact — each contact's events are
 * independent of the others.
 */
export const unsubscribeMany = internalMutation({
	args: unsubscribeManyArgsValidator,
	handler: async (
		ctx,
		args,
	): Promise<{ outcomes: UnsubscribeOutcome[] }> => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			return {
				outcomes: args.contactIds.map(
					(): UnsubscribeOutcome => ({
						ok: false,
						reason: 'topic_not_found',
						topicId: args.topicId,
					}),
				),
			};
		}

		const now = Date.now();
		const reason = args.reason ?? defaultUnsubscribeReason(args.source);
		const outcomes: UnsubscribeOutcome[] = [];
		let totalDeleted = 0;

		for (const contactId of args.contactIds) {
			const contact = await ctx.db.get(contactId);
			if (!contact) {
				outcomes.push({
					ok: false,
					reason: 'contact_not_found',
					topicId: args.topicId,
				});
				continue;
			}

			const result = await unsubscribeOne(ctx, {
				topic,
				contactId,
				source: args.source,
				reason,
				now,
			});
			outcomes.push(result.outcome);

			if (result.deleted && result.context) {
				totalDeleted += 1;
				// Per-contact call effects fire once per contact regardless of
				// the batch size (admin source: only contact.updatedAt is
				// relevant; other flags are off).
				await applyUnsubscribeCallEffects(ctx, {
					contactId,
					removedTopics: [result.context],
					source: args.source,
					now,
				});
			}
		}

		if (totalDeleted > 0) {
			await patchCachedMemberCountDelta(ctx, topic, -totalDeleted, now);
		}

		return { outcomes };
	},
});

const unsubscribeAllForContactArgsValidator = {
	contactId: v.id('contacts'),
	topicId: v.optional(v.id('topics')),
	source: unsubscribeSourceValidator,
	reason: v.optional(v.string()),
};

/**
 * Unsubscribe a Contact from one or all of its Topics.
 *
 * `topicId === undefined` removes the Contact from every Topic they belong
 * to. Per-contact effects (form-clear, campaign-stats, single webhook with
 * the array of removed topics) fire ONCE for the call regardless of how
 * many memberships are deleted. Per-membership effects (delete row,
 * activity row, per-topic cachedMemberCount decrement) fire N times.
 *
 * This is the entry point used by the public unsubscribe link.
 */
export const unsubscribeAllForContact = internalMutation({
	args: unsubscribeAllForContactArgsValidator,
	handler: async (
		ctx,
		args,
	): Promise<{ outcomes: UnsubscribeOutcome[] }> => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) {
			return {
				outcomes: [
					{
						ok: false,
						reason: 'contact_not_found',
					},
				],
			};
		}

		// A global unsubscribe (no `topicId`) is a contact-level marketing
		// opt-out, not just a membership delete. Record it as a persistent
		// `contacts.unsubscribedAt` signal that the Audience resolution (module)
		// consults — segment campaigns select from the contacts table
		// independent of topic membership, so without this a globally-
		// unsubscribed Contact stays reachable by any matching segment
		// (CAN-SPAM/GDPR). Stamped even when the Contact has no live memberships
		// to delete, because a segment can still match them. See the
		// `unsubscribedAt` field doc in schema/contacts.ts.
		const isGlobalUnsubscribe = args.topicId === undefined;
		if (isGlobalUnsubscribe && contact.unsubscribedAt === undefined) {
			await ctx.db.patch(args.contactId, { unsubscribedAt: Date.now() });
		}

		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: one contact's topic memberships

		// Filter to one topic if requested.
		const inScope = args.topicId
			? memberships.filter((m) => m.topicId === args.topicId)
			: memberships;

		if (inScope.length === 0) {
			return {
				outcomes: args.topicId
					? [{ ok: true, action: 'not_member', topicId: args.topicId }]
					: [],
			};
		}

		const now = Date.now();
		const reason = args.reason ?? defaultUnsubscribeReason(args.source);
		const outcomes: UnsubscribeOutcome[] = [];
		const removedContexts: Array<{
			topicId: Id<'topics'>;
			topicName: string;
		}> = [];

		// Group by topicId so each topic's cachedMemberCount is patched once.
		const perTopicDeletions = new Map<Id<'topics'>, number>();

		for (const membership of inScope) {
			const topic = await ctx.db.get(membership.topicId);
			if (!topic) {
				outcomes.push({
					ok: false,
					reason: 'topic_not_found',
					topicId: membership.topicId,
				});
				continue;
			}

			const result = await unsubscribeOne(ctx, {
				topic,
				contactId: args.contactId,
				source: args.source,
				reason,
				now,
			});
			outcomes.push(result.outcome);

			if (result.deleted && result.context) {
				removedContexts.push(result.context);
				perTopicDeletions.set(
					membership.topicId,
					(perTopicDeletions.get(membership.topicId) ?? 0) + 1,
				);
			}
		}

		// One cachedMemberCount patch per affected topic.
		for (const [topicId, deletionCount] of perTopicDeletions) {
			const topic = await ctx.db.get(topicId);
			if (topic) {
				await patchCachedMemberCountDelta(ctx, topic, -deletionCount, now);
			}
		}

		// Per-call effects: contact.updatedAt, optional form-clear, optional
		// campaign-stats, optional single webhook with all removed topics.
		if (removedContexts.length > 0) {
			await applyUnsubscribeCallEffects(ctx, {
				contactId: args.contactId,
				removedTopics: removedContexts,
				source: args.source,
				now,
			});
		}

		return { outcomes };
	},
});
