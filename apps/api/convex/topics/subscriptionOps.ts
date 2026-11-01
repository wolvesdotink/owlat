/**
 * Topic subscription — the writes the entry points compose.
 *
 * The per-membership operations (`subscribeOne`, `unsubscribeOne`), the DOI
 * handoff (`requestConfirmation`), the cached member count patch, and the
 * per-call unsubscribe effects. Only `subscription.ts` and its undo sibling
 * call these, so every write to `contactTopics` still goes through the Topic
 * subscription (module); `requestConfirmation` is also the Form submission
 * (module)'s handoff for a signup without a topic.
 */

import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { nanoid } from 'nanoid';
import { DOI_TOKEN_TTL_MS } from '../contacts/doiLifecycleReducer';
import { scheduleFanout } from '../webhooks/scheduleFanout';
import { recordContactActivity } from '../contactActivities/writer';
import {
	effectFlagsForUnsubscribeSource,
	requiresFreshConfirmation,
	type RemovedMembership,
	type SubscribeOutcome,
	type SubscribeSource,
	type UnsubscribeOutcome,
	type UnsubscribeSource,
} from './subscriptionContract';

// ─── DOI handoff ────────────────────────────────────────────────────────────

/**
 * Hand a contact to the DOI lifecycle as `pending` and return the token its
 * confirmation link carries. A contact already pending with a live token keeps
 * it (no second email), so every signup in one pending window shares one
 * token. A confirmed contact only gets here when `requiresFreshConfirmation`
 * held for an opt-out, so the request opens a new consent episode (`reopen`).
 */
export async function requestConfirmation(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	args: { now: number; siteUrl: string | undefined }
): Promise<string> {
	const tokenCandidate = nanoid(32);
	await ctx.runMutation(internal.contacts.doiLifecycle.transition, {
		contactId: contact._id,
		input: {
			to: 'pending',
			at: args.now,
			token: tokenCandidate,
			ttlMs: DOI_TOKEN_TTL_MS,
			...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
			...(contact.doiStatus === 'confirmed' ? { reopen: true } : {}),
		},
	});

	// The DOI lifecycle writes the candidate token on a real transition but
	// keeps the existing one on the idempotent `pending → pending` path.
	// Re-read so callers receive whichever token is actually stored.
	const updatedContact = await ctx.db.get(contact._id);
	return updatedContact?.doiConfirmationToken ?? tokenCandidate;
}

// ─── Subscribe side ─────────────────────────────────────────────────────────

interface SubscribeOneResult {
	outcome: SubscribeOutcome;
	// Number of new memberships inserted (0 or 1). Used by the caller to
	// coalesce the cachedMemberCount patch.
	insertedCount: number;
}

export async function subscribeOne(
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
	}
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
			q.eq('contactId', args.contactId).eq('topicId', args.topic._id)
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

	const doiRequired =
		(args.topic.requireDoubleOptIn === true || args.forceDoi === true) && args.skipDoi !== true;

	if (!requiresFreshConfirmation(contact, { source: args.source, doiRequired })) {
		// A completed opt-in lifts the global marketing opt-out — they are
		// actively opting back in, so they should once again be reachable by
		// matching audiences. Clears the `contacts.unsubscribedAt` signal set by
		// a prior global unsubscribe (see schema/contacts.ts). The consent rule
		// only lets a source that may lift an opt-out reach here with one set.
		//
		// Deliberately NOT cleared on the pending path below: a public form
		// (unauthenticated, any email) must not lift a persistent opt-out
		// without a fresh confirmed opt-in — that would re-open the
		// CAN-SPAM/GDPR gap PR-09 closes. For the pending path the opt-out is
		// lifted only at DOI-confirm time, in the lifecycle
		// (contacts/doiLifecycle.ts reduceConfirmed).
		const liftedOptOutAt = contact.unsubscribedAt;
		if (liftedOptOutAt !== undefined) {
			await ctx.db.patch(args.contactId, { unsubscribedAt: undefined });
		}

		// DOI is not in the way — fire the trigger now.
		await ctx.runMutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
			contactId: args.contactId,
			topicId: args.topic._id,
		});
		return {
			outcome: {
				ok: true,
				action: 'subscribed',
				membershipId,
				...(liftedOptOutAt !== undefined ? { liftedOptOutAt } : {}),
			},
			insertedCount: 1,
		};
	}

	// The subscribe waits for a confirmation (DOI applies and the contact is
	// not confirmed, or a form met a standing opt-out). Hand off to the DOI
	// lifecycle — its `fire_topic_subscribed_triggers` effect at confirm time
	// covers every DOI-required membership the Contact has at that moment, so
	// this module does not double-fire.
	//
	// The confirm-time fanout keys off `topic.requireDoubleOptIn`, so a
	// membership deferred for any other reason (the FORM forced DOI, or the
	// opt-out did, on a topic that doesn't require it) would be missed. Flag it
	// so the fanout still fires its trigger + activity; topic-DOI memberships
	// are already covered and don't need the flag.
	if (args.topic.requireDoubleOptIn !== true) {
		await ctx.db.patch(membershipId, { pendingDoiConfirmation: true });
	}

	const doiToken = await requestConfirmation(ctx, contact, {
		now: args.now,
		siteUrl: args.siteUrl,
	});

	return {
		outcome: { ok: true, action: 'pending_doi', membershipId, doiToken },
		insertedCount: 1,
	};
}

export async function patchCachedMemberCountDelta(
	ctx: MutationCtx,
	topic: Doc<'topics'>,
	delta: number,
	now: number
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
	// The deleted row as `restoreMemberships` needs it. Only when `deleted`.
	removed?: RemovedMembership;
}

export async function unsubscribeOne(
	ctx: MutationCtx,
	args: {
		topic: Doc<'topics'>;
		contactId: Id<'contacts'>;
		source: UnsubscribeSource;
		reason: string;
		now: number;
	}
): Promise<UnsubscribeOneResult> {
	const membership = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact_and_topic', (q) =>
			q.eq('contactId', args.contactId).eq('topicId', args.topic._id)
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
			topicId: args.topic._id,
			topicName: args.topic.name,
			reason: args.reason,
		},
		occurredAt: args.now,
	});

	return {
		outcome: { ok: true, action: 'unsubscribed', topicId: args.topic._id },
		deleted: true,
		context: { topicId: args.topic._id, topicName: args.topic.name },
		removed: {
			membershipId: membership.restoredFrom ?? membership._id,
			contactId: membership.contactId,
			addedAt: membership.addedAt,
			...(membership.pendingDoiConfirmation === true ? { pendingDoiConfirmation: true } : {}),
			...(membership.seedTag !== undefined ? { seedTag: membership.seedTag } : {}),
		},
	};
}

async function fireTopicUnsubscribedWebhook(
	ctx: MutationCtx,
	args: {
		contactId: Id<'contacts'>;
		removedTopics: Array<{ topicId: Id<'topics'>; topicName: string }>;
		now: number;
	}
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
				topicId: t.topicId,
				topicName: t.topicName,
			})),
		},
	});
}

/**
 * Hand the contact's departure to the transport-outcome recorder, ONCE per call.
 *
 * Scheduled for the same reason `recordCampaignUnsubscribe` is: the RFC 8058
 * one-click response must not wait on an OCC retry of a shared outcome shard
 * during a post-blast unsubscribe burst. One schedule per call, not per
 * membership — every run redoes the same contact→send join and contends on the
 * same send row, and all but the first would decide `already_attributed`.
 */
export async function scheduleTransportUnsubscribeOutcome(
	ctx: MutationCtx,
	args: { contactId: Id<'contacts'>; now: number }
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
		contactId: args.contactId,
		at: args.now,
	});
}

// ─── Per-call effect runner ─────────────────────────────────────────────────

export async function applyUnsubscribeCallEffects(
	ctx: MutationCtx,
	args: {
		contactId: Id<'contacts'>;
		removedTopics: Array<{ topicId: Id<'topics'>; topicName: string }>;
		source: UnsubscribeSource;
		now: number;
		// Set by the global-opt-out entry point, which schedules the recorder
		// before it knows whether any membership will be deleted.
		transportOutcomeAlreadyScheduled?: boolean;
	}
): Promise<void> {
	if (args.removedTopics.length === 0) return;

	// Always (when at least one removal happened): patch contact.updatedAt.
	const contact = await ctx.db.get(args.contactId);
	if (contact) {
		await ctx.db.patch(args.contactId, { updatedAt: args.now });
	}

	const flags = effectFlagsForUnsubscribeSource(args.source);

	if (flags.incrementCampaignUnsubscribedStats) {
		// Off the synchronous path — see recordCampaignUnsubscribe.
		await ctx.scheduler.runAfter(0, internal.topics.subscription.recordCampaignUnsubscribe, {
			contactId: args.contactId,
		});
	}

	if (flags.recordTransportUnsubscribeOutcome && args.transportOutcomeAlreadyScheduled !== true) {
		await scheduleTransportUnsubscribeOutcome(ctx, { contactId: args.contactId, now: args.now });
	}

	if (flags.fireTopicUnsubscribedWebhook) {
		await fireTopicUnsubscribedWebhook(ctx, {
			contactId: args.contactId,
			removedTopics: args.removedTopics,
			now: args.now,
		});
	}
}
