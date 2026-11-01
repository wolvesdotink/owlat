/**
 * Topic subscription (module) — single writer of contactTopics, source-conditional effects.
 *
 * Owns:
 *   - every write to `contactTopics` (insert + delete)
 *   - every maintenance of `topics.cachedMemberCount` (increment + decrement)
 *   - the DOI gate at subscribe time + the `request_doi` handoff to the DOI lifecycle
 *   - the consent rule for lifting a global opt-out (`requiresFreshConfirmation`),
 *     which the Form submission (module) also applies to signups without a topic
 *   - the `topic_subscribed` trigger fire when DOI is not in the way
 *   - the per-source effect bundle on unsubscribe (activity row, contact.updatedAt,
 *     campaign-stats increment, topic.unsubscribed webhook)
 *
 * Five entry points keyed by shape:
 *   subscribe / subscribeMany                — one topic, one-or-many contacts
 *   unsubscribe / unsubscribeMany            — one topic, one-or-many contacts
 *   unsubscribeAllForContact                 — one contact, some-or-all topics
 *
 * Plus the two inverses an operator's bulk "Undo" runs, each fed the receipt
 * its forward call returned (see "Undo of a bulk edit" below):
 *   revertSubscribeMany                      — undo a subscribeMany
 *   restoreMemberships                       — undo an unsubscribeMany
 *
 * Per-call effects (cached count patch, contact.updatedAt patch, campaign-stats,
 * webhook) fire ONCE per call regardless of how many memberships are touched.
 * Per-membership effects (insert, delete, activity row) fire N times.
 *
 * An unsubscribe leaves `formSubmissions.confirmedAt` alone: it is the record of
 * when a signup was confirmed, and no consent decision reads it. Whether a
 * returning contact must confirm again is `requiresFreshConfirmation`'s call,
 * from the contact row.
 *
 * Siblings: the contract in `subscriptionContract.ts`, the writes these entry
 * points compose in `subscriptionOps.ts`, the undo bodies in `subscriptionUndo.ts`.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { latestAttributableCampaignSend } from '../delivery/marketingSendAttribution';
import {
	addedMembershipValidator,
	defaultUnsubscribeReason,
	effectFlagsForUnsubscribeSource,
	removedMembershipValidator,
	subscribeArgsValidator,
	subscribeManyArgsValidator,
	unsubscribeAllForContactArgsValidator,
	unsubscribeArgsValidator,
	unsubscribeManyArgsValidator,
	type RemovedMembership,
	type SubscribeOutcome,
	type UnsubscribeOutcome,
} from './subscriptionContract';
import {
	applyUnsubscribeCallEffects,
	patchCachedMemberCountDelta,
	scheduleTransportUnsubscribeOutcome,
	subscribeOne,
	unsubscribeOne,
} from './subscriptionOps';
import { restoreRemovedMemberships, revertAddedMemberships } from './subscriptionUndo';

/**
 * Attribute a contact's unsubscribe to their most-recent campaign send, OFF the
 * synchronous public-unsubscribe path. Scheduled (not called inline) so the
 * RFC 8058 one-click response isn't gated on an OCC retry of the shared campaign
 * row during a post-blast unsubscribe burst, and so `statsUnsubscribed`, a
 * counter only internal mutations may move, is written by an internal mutation
 * rather than the user-facing unsubscribe mutation (the schema contract).
 *
 * WHICH send is the shared join's answer, not this module's: the transport
 * outcome scheduled beside this counter must not be able to name a different
 * campaign for the same departure.
 */
export const recordCampaignUnsubscribe = internalMutation({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const recentEmailSend = await latestAttributableCampaignSend(ctx.db, args.contactId);
		if (!recentEmailSend) return;
		const campaign = await ctx.db.get(recentEmailSend.campaignId);
		if (!campaign) return;
		await ctx.db.patch(campaign._id, {
			statsUnsubscribed: (campaign.statsUnsubscribed ?? 0) + 1,
			updatedAt: Date.now(),
		});
	},
});

// ─── Entry points ───────────────────────────────────────────────────────────

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

/**
 * Subscribe many Contacts to one Topic. Coalesces the cachedMemberCount
 * patch (one patch per call regardless of array size). Per-contact effects
 * (trigger fire, DOI handoff) fire N times.
 */
export const subscribeMany = internalMutation({
	args: subscribeManyArgsValidator,
	handler: async (ctx, args): Promise<{ outcomes: SubscribeOutcome[] }> => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			return {
				outcomes: args.contactIds.map((): SubscribeOutcome => ({
					ok: false,
					reason: 'topic_not_found',
				})),
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

/**
 * Unsubscribe a Contact from a Topic. Single membership op.
 *
 * Per-call effects (cached count decrement, contact.updatedAt, campaign-stats,
 * webhook) fire ONCE for the single membership. The webhook
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

/**
 * Unsubscribe many Contacts from one Topic. Coalesces the cachedMemberCount
 * patch. Per-contact effects (activity row, contact.updatedAt, campaign-stats,
 * webhook) fire per contact — each contact's events are
 * independent of the others.
 */
export const unsubscribeMany = internalMutation({
	args: unsubscribeManyArgsValidator,
	handler: async (
		ctx,
		args
	): Promise<{ outcomes: UnsubscribeOutcome[]; removed: RemovedMembership[] }> => {
		const topic = await ctx.db.get(args.topicId);
		if (!topic) {
			return {
				outcomes: args.contactIds.map((): UnsubscribeOutcome => ({
					ok: false,
					reason: 'topic_not_found',
					topicId: args.topicId,
				})),
				removed: [],
			};
		}

		const now = Date.now();
		const reason = args.reason ?? defaultUnsubscribeReason(args.source);
		const outcomes: UnsubscribeOutcome[] = [];
		// What was deleted, so an operator's bulk remove can be undone exactly.
		const removed: RemovedMembership[] = [];
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

			if (result.removed) removed.push(result.removed);
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

		return { outcomes, removed };
	},
});

/**
 * Unsubscribe a Contact from some or all of its Topics.
 *
 * NO topic scope at all (`topicId` and `topicIds` both absent) removes the
 * Contact from every Topic they belong to AND is a contact-level opt-out.
 * `topicId` is the single-topic unsubscribe link; `topicIds` is the preference
 * centre's batch save — several toggles, ONE recipient action, so an empty
 * array is an empty scope and never a global opt-out. Two spellings of one
 * scope: given BOTH, `topicIds` wins and `topicId` is dropped.
 *
 * Per-contact effects (campaign-stats, the transport-outcome attribution, a
 * single webhook with the array of removed topics) fire ONCE for the call
 * regardless of how many memberships are deleted. Per-membership effects
 * (delete row, activity row, per-topic cachedMemberCount decrement) fire N
 * times.
 *
 * This is the entry point used by the public unsubscribe link.
 */
export const unsubscribeAllForContact = internalMutation({
	args: unsubscribeAllForContactArgsValidator,
	handler: async (ctx, args): Promise<{ outcomes: UnsubscribeOutcome[] }> => {
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

		const now = Date.now();
		// One scope, however it was spelled — `topicIds` wins the pair, as the
		// args doc states — and its ABSENCE is what makes this call a global
		// opt-out.
		const scopedTopicIds = args.topicIds ?? (args.topicId ? [args.topicId] : undefined);

		// A global unsubscribe is a contact-level marketing opt-out, not just a
		// membership delete. Record it as a persistent `contacts.unsubscribedAt`
		// signal that the Audience resolution (module) consults — segment
		// campaigns select from the contacts table independent of topic
		// membership, so without this a globally-unsubscribed Contact stays
		// reachable by any matching segment (CAN-SPAM/GDPR). Stamped even when the
		// Contact has no live memberships to delete, because a segment can still
		// match them. See the `unsubscribedAt` field doc in schema/contacts.ts.
		const isGlobalUnsubscribe = scopedTopicIds === undefined;
		if (isGlobalUnsubscribe && contact.unsubscribedAt === undefined) {
			await ctx.db.patch(args.contactId, { unsubscribedAt: now });
		}
		// The opt-out also ends the open consent episode: a confirmation link
		// minted before it must not lift it later. The DOI lifecycle withdraws
		// the token and moves the episode on; a later signup gets a fresh token.
		if (isGlobalUnsubscribe) {
			await ctx.runMutation(internal.contacts.doiLifecycle.endConsentEpisode, {
				contactId: args.contactId,
				at: now,
			});
		}

		const flags = effectFlagsForUnsubscribeSource(args.source);
		// A global opt-out is the recipient's signal WHETHER OR NOT it finds
		// membership rows to delete. A segment-audience campaign resolves its
		// recipients from the contacts table and still gives them the contact
		// one-click pair (`resolveListUnsubscribeHeader`), so those recipients
		// have no `contactTopics` row at all — gating the transport outcome on a
		// deletion would leave its counter without a writer, and the standalone
		// ramp's gate 3 at `insufficient_data`, on every segment-sending
		// deployment. The per-send stamp, not this call, is the uniqueness gate.
		const emitsTransportOutcome = isGlobalUnsubscribe && flags.recordTransportUnsubscribeOutcome;
		if (emitsTransportOutcome) {
			await scheduleTransportUnsubscribeOutcome(ctx, { contactId: args.contactId, now });
		}

		const memberships = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: one contact's topic memberships

		// Filter to the requested topics if a scope was given.
		const inScope = scopedTopicIds
			? memberships.filter((m) => scopedTopicIds.includes(m.topicId))
			: memberships;

		if (inScope.length === 0) {
			return {
				outcomes: (scopedTopicIds ?? []).map((topicId) => ({
					ok: true,
					action: 'not_member',
					topicId,
				})),
			};
		}

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
					(perTopicDeletions.get(membership.topicId) ?? 0) + 1
				);
			}
		}

		// A requested topic the Contact was never a member of still gets an answer,
		// so a batch's outcomes line up with what was asked for.
		for (const topicId of scopedTopicIds ?? []) {
			if (!inScope.some((m) => m.topicId === topicId)) {
				outcomes.push({ ok: true, action: 'not_member', topicId });
			}
		}

		// One cachedMemberCount patch per affected topic.
		for (const [topicId, deletionCount] of perTopicDeletions) {
			const topic = await ctx.db.get(topicId);
			if (topic) {
				await patchCachedMemberCountDelta(ctx, topic, -deletionCount, now);
			}
		}

		// Per-call effects: contact.updatedAt, optional campaign-stats,
		// optional single webhook with all removed topics.
		if (removedContexts.length > 0) {
			await applyUnsubscribeCallEffects(ctx, {
				contactId: args.contactId,
				removedTopics: removedContexts,
				source: args.source,
				now,
				transportOutcomeAlreadyScheduled: emitsTransportOutcome,
			});
		}

		return { outcomes };
	},
});

// ─── Undo of a bulk edit ────────────────────────────────────────────────────
//
// An operator's bulk add or remove can be taken back for a few seconds. The
// forward call returned a receipt naming exactly what it changed, and these
// inverses touch only that: rows another writer added or removed in between are
// left alone. Neither replays the forward call's effects in reverse, and
// neither fires the effects of the opposite call: a confirmation email already
// sent and an automation already started stay, and a restore requests no DOI,
// fires no trigger and lifts no opt-out.

/**
 * Undo a `subscribeMany`: delete the memberships it inserted while they are
 * still those rows, and put back a global opt-out the subscribe lifted, unless
 * one is set again. A row an undone remove put back counts as the row it
 * replaced (`restoredFrom`), so undoing a remove and then the add before it
 * restores the original absence; a row re-added fresh since has neither id
 * and stays.
 */
export const revertSubscribeMany = internalMutation({
	args: {
		topicId: v.id('topics'),
		added: v.array(addedMembershipValidator),
	},
	handler: async (ctx, args): Promise<{ reverted: number }> => revertAddedMemberships(ctx, args),
});

/**
 * Undo an `unsubscribeMany`: put back the memberships it deleted, as they were,
 * each marked with the id it replaces so an undo of the add that created it
 * still finds it. A contact that is a member again, or has been deleted since,
 * is skipped. The
 * form-DOI deferral flag comes back only while the contact is still unconfirmed:
 * a confirmation in between would otherwise leave the restored row excluded
 * from the audience with nothing left to clear the flag.
 */
export const restoreMemberships = internalMutation({
	args: {
		topicId: v.id('topics'),
		removed: v.array(removedMembershipValidator),
	},
	handler: async (ctx, args): Promise<{ restored: number }> => restoreRemovedMemberships(ctx, args),
});
