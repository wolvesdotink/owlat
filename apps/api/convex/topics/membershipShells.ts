/**
 * The membership writes behind `topics.addContact` / `removeContact` and their
 * API-key `*Internal` variants. Each delegates to the Topic subscription
 * (module); the registered shells in `topics.ts` own the auth decision.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { throwNotFound } from '../_utils/errors';
import type { SubscribeOutcome } from './subscriptionContract';

export type AddContactResult = {
	membershipId: Id<'contactTopics'>;
	doiStatus: 'not_required' | 'pending' | 'confirmed';
};

export const addContactArgs = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
	// Optional: skip DOI for this specific addition (admin-authoritative).
	skipDoi: v.optional(v.boolean()),
	// Optional: site URL for confirmation email.
	siteUrl: v.optional(v.string()),
};

export async function addContactImpl(
	ctx: MutationCtx,
	args: { topicId: Id<'topics'>; contactId: Id<'contacts'>; skipDoi?: boolean; siteUrl?: string }
): Promise<AddContactResult> {
	const outcome: SubscribeOutcome = await ctx.runMutation(internal.topics.subscription.subscribe, {
		topicId: args.topicId,
		contactId: args.contactId,
		source: 'public_api',
		...(args.skipDoi === true ? { skipDoi: true } : {}),
		...(args.siteUrl ? { siteUrl: args.siteUrl } : {}),
	});

	if (!outcome.ok) {
		// `throwNotFound` is typed `never` — single tail call gives TS
		// the narrowing it needs to keep `outcome.ok === true` below.
		throwNotFound(outcome.reason === 'topic_not_found' ? 'Topic' : 'Contact');
	}

	// Preserve the legacy `{ membershipId, doiStatus }` return shape.
	// The form-confirmation path branches on `doiStatus === 'pending'` to
	// decide whether to record the submission as `pending_confirmation`,
	// so the `pending_doi` outcome MUST surface as 'pending' here.
	let doiStatus: 'not_required' | 'pending' | 'confirmed';
	if (outcome.action === 'pending_doi') {
		doiStatus = 'pending';
	} else {
		// 'subscribed' or 'already_member' — read the contact's current
		// doiStatus. Matches the pre-deepening behavior (returned the
		// contact's actual status when already a member; returned
		// 'not_required' or 'confirmed' depending on contact state when
		// subscribing without DOI request).
		const contact = await ctx.db.get(args.contactId);
		doiStatus = contact?.doiStatus ?? 'not_required';
	}

	return { membershipId: outcome.membershipId, doiStatus };
}

export const removeContactArgs = {
	topicId: v.id('topics'),
	contactId: v.id('contacts'),
};

export async function removeContactImpl(
	ctx: MutationCtx,
	args: { topicId: Id<'topics'>; contactId: Id<'contacts'> }
): Promise<void> {
	await ctx.runMutation(internal.topics.subscription.unsubscribe, {
		topicId: args.topicId,
		contactId: args.contactId,
		source: 'admin',
	});
}
