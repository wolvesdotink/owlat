/**
 * DOI lifecycle (module) — single writer of contacts.doiStatus.
 *
 * Owns the three-state machine `not_required → pending → confirmed` and the
 * companion-field atomicity (doiConfirmationToken, doiTokenExpiresAt,
 * doiConfirmedAt). Two entry points: `transition` (direct, by contactId) and
 * `transitionByConfirmationToken` (token-keyed — symmetric to Send lifecycle's
 * transitionByProviderMessageId). Reducers return { patch, effects, applied };
 * the runner is the only place that touches the DB and the scheduler. The
 * types, validator, graph and reducers live in `doiLifecycleReducer.ts`.
 *
 * Consent episodes: a confirmation counts only for the episode it was issued
 * in. A global opt-out ends the episode (`endConsentEpisode`: the token is
 * withdrawn and `doiConsentEpisode` moves on), and a later public signup opens
 * a new one (`reopen`) instead of reusing the old confirmation.
 *
 * Effects:
 *   send_confirmation_email          — schedules contacts/confirmationEmail:sendConfirmationEmail
 *   fire_topic_subscribed_triggers   — fans out to DOI-required memberships
 *   contact_activity                 — one `topic_confirmed` row per
 *                                      DOI-required membership; routed
 *                                      through the Contact activity (module)
 *   carry_pending_submissions        — moves the form submissions that waited
 *                                      on a replaced token to the new one;
 *                                      routed through the Form submission
 *                                      (module)
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { recordContactActivity, type RecordContactActivityArgs } from '../contactActivities/writer';
import { recordAuditLog } from '../lib/auditLog';
import { refuse, type LifecycleReason } from '../lib/lifecycle';
import { batchGet } from '../_utils/batchLoader';
import { isFeatureEnabled } from '../lib/featureFlags';
import {
	consentEpisodeOf,
	DOI_LIFECYCLE,
	outgoingTokenToCarry,
	reduceConfirmed,
	reducePending,
	transitionInputValidator,
	type DoiRequiredTopic,
	type DoiStatus,
	type Effect,
	type ReducerResult,
	type TransitionInput,
} from './doiLifecycleReducer';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			from: DoiStatus;
			to: DoiStatus;
			contactId: Id<'contacts'>;
	  }
	| {
			ok: false;
			// `illegal_edge` / `terminal` come from the generic lifecycle core;
			// the token and contact reasons are this module's own.
			reason: LifecycleReason<'contact_not_found' | 'token_not_found' | 'token_expired'>;
			from?: DoiStatus;
			to?: DoiStatus;
	  };

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Hand the rows that waited on a replaced token to the Form submission
 * (module), in this transaction. Runs after the contact patch, so the contact
 * already holds `toToken`.
 */
async function carryPendingSubmissions(
	ctx: MutationCtx,
	args: { contactId: Id<'contacts'>; fromToken: string; toToken: string; episode: number }
): Promise<void> {
	await ctx.runMutation(internal.forms.pendingConfirmations.carryPendingSubmissions, {
		contactId: args.contactId,
		fromToken: args.fromToken,
		toToken: args.toToken,
		episode: args.episode,
	});
}

async function applyEffects(ctx: MutationCtx, effects: ReadonlyArray<Effect>): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'send_confirmation_email': {
				await ctx.scheduler.runAfter(0, internal.contacts.confirmationEmail.sendConfirmationEmail, {
					email: effect.email,
					firstName: effect.firstName,
					confirmationToken: effect.token,
					siteUrl: effect.siteUrl,
				});
				break;
			}
			case 'fire_topic_subscribed_triggers': {
				for (const topicId of effect.topicIds) {
					await ctx.runMutation(internal.automations.triggers.fireTopicSubscribedTrigger, {
						contactId: effect.contactId,
						topicId,
					});
				}
				break;
			}
			case 'contact_activity': {
				// Correlated-unions: see sendLifecycle.ts for the cast
				// rationale. The source-side `ContactActivityEffect` type
				// enforces literal ↔ metadata correlation.
				const args: RecordContactActivityArgs = {
					literal: effect.literal,
					contactId: effect.contactId,
					metadata: effect.metadata,
					occurredAt: effect.occurredAt,
				} as RecordContactActivityArgs;
				await recordContactActivity(ctx, args);
				break;
			}
			case 'carry_pending_submissions': {
				await carryPendingSubmissions(ctx, effect);
				break;
			}
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: effect.triggeredBy,
					action: effect.action,
					resource: 'contact',
					resourceId: effect.contactId,
					details: effect.details,
				});
				break;
			}
		}
	}
}

// ─── Lookup primitive ───────────────────────────────────────────────────────

/**
 * Find a Contact by its DOI confirmation token. Returns null if no row
 * matches. Used by the token-keyed transition entry point and by the
 * `topics.getContactByDoiToken` query (which wraps this for the pre-confirm
 * verification page). Read-only, so it accepts a `QueryCtx` too — a
 * `MutationCtx` still satisfies the wider type.
 */
export async function findContactByConfirmationToken(
	ctx: QueryCtx | MutationCtx,
	token: string
): Promise<Doc<'contacts'> | null> {
	return await ctx.db
		.query('contacts')
		.withIndex('by_doi_confirmation_token', (q) => q.eq('doiConfirmationToken', token))
		.first();
}

/**
 * Whether `token` was minted by a form submission while the `forms` flag is
 * off. Such a token neither resolves nor confirms, on any DOI surface, until
 * the flag is back on: the confirmation follows the flag like the public submit
 * endpoint does. A contact-level token that no form minted is unaffected.
 */
export async function isFormTokenDisabled(
	ctx: QueryCtx | MutationCtx,
	token: string
): Promise<boolean> {
	const submission = await ctx.db
		.query('formSubmissions')
		.withIndex('by_confirmation_token_and_status', (q) => q.eq('confirmationToken', token))
		.first();
	return submission !== null && !(await isFeatureEnabled(ctx, 'forms'));
}

// ─── Topic membership resolution ────────────────────────────────────────────
//
// At confirm time, we need the contact's DOI-required topic memberships
// for both the trigger fanout and the activity rows. Loaded once and
// passed to the reducer so the reducer stays pure-ish.

async function loadDoiRequiredMemberships(
	ctx: MutationCtx,
	contactId: Id<'contacts'>
): Promise<{
	topics: Array<DoiRequiredTopic>;
	clearMembershipIds: Array<Id<'contactTopics'>>;
}> {
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's topic memberships
	const topics: Array<DoiRequiredTopic> = [];
	const clearMembershipIds: Array<Id<'contactTopics'>> = [];
	// The topic rows are independent of each other and of the loop below.
	const topicsById = await batchGet(
		ctx,
		memberships.map((m) => m.topicId)
	);
	for (const m of memberships) {
		const topic = topicsById.get(m.topicId);
		// Include topic-DOI memberships AND form-forced-DOI memberships (the
		// latter flagged at subscribe time on a non-DOI topic).
		const deferredByForm = m.pendingDoiConfirmation === true;
		if (topic && (topic.requireDoubleOptIn || deferredByForm)) {
			topics.push({ id: m.topicId, name: topic.name });
		}
		if (deferredByForm) clearMembershipIds.push(m._id);
	}
	return { topics, clearMembershipIds };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	input: TransitionInput
): Promise<TransitionOutcome> {
	const from = (contact.doiStatus ?? 'not_required') as DoiStatus;

	// Admin-attest path relaxes the `not_required → confirmed` edge that the
	// token-keyed path refuses. Other DOI transitions ignore this branch.
	const isAdminAttestEdge =
		input.to === 'confirmed' &&
		'source' in input &&
		input.source === 'admin_attest' &&
		from === 'not_required';
	// A new consent episode over an earlier confirmation. Only a standing
	// global opt-out ends a confirmation, so without one there is nothing to
	// reopen and the edge stays refused.
	const isReopenEdge =
		input.to === 'pending' &&
		input.reopen === true &&
		from === 'confirmed' &&
		contact.unsubscribedAt !== undefined;

	const verdict = DOI_LIFECYCLE.classify(from, input.to, {
		isSanctionedEdge: isAdminAttestEdge || isReopenEdge,
	});

	if (verdict.kind === 'refused') {
		return refuse(verdict);
	}

	let result: ReducerResult;
	switch (input.to) {
		case 'pending':
			result = reducePending(contact, input);
			break;
		case 'confirmed': {
			const { topics, clearMembershipIds } = await loadDoiRequiredMemberships(ctx, contact._id);
			result = reduceConfirmed(contact, input, topics);
			// Clear the form-DOI deferral flags only when the fanout actually
			// fires (not on an idempotent re-confirm), so a later confirm can't
			// re-fire these memberships' triggers.
			if (result.applied !== 'recorded') {
				for (const id of clearMembershipIds) {
					await ctx.db.patch(id, { pendingDoiConfirmation: undefined });
				}
			}
			break;
		}
	}

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(contact._id, result.patch as Partial<Doc<'contacts'>>);
	}
	if (result.applied !== 'recorded') {
		await applyEffects(ctx, result.effects);
	}

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
		contactId: contact._id,
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Apply a DOI transition to a Contact identified by contactId. The only
 * writer of `contacts.doiStatus` and its companion fields (alongside the
 * **Contact resolution (module)** which writes the initial `'not_required'`
 * at Contact-create time).
 *
 * Atomic with: contact patch, schedule-confirmation-email,
 * fire-topic-subscribed-triggers, topic_confirmed contact activity rows.
 * Duplicate / illegal / terminal transitions are reported via
 * TransitionOutcome — never thrown.
 */
export const transition = internalMutation({
	args: { contactId: v.id('contacts'), input: transitionInputValidator },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return { ok: false, reason: 'contact_not_found' };
		return await dispatch(ctx, contact, args.input);
	},
});

/**
 * Same as `transition`, but keyed by `doiConfirmationToken` rather than
 * contactId. Used by the customer-facing confirmation endpoints
 * (`/confirm/doi?token=…` and form-confirm via `/forms/confirm/:formId`)
 * which receive the token from the URL but do not know the contactId.
 *
 * Returns `{ ok: false, reason: 'token_not_found' }` for unknown tokens
 * and `{ ok: false, reason: 'token_expired' }` for tokens past
 * `doiTokenExpiresAt`. The contact row is not patched in either failure
 * case — callers translate the outcome to the appropriate HTTP response.
 */
export const transitionByConfirmationToken = internalMutation({
	args: { token: v.string(), input: transitionInputValidator },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const contact = await findContactByConfirmationToken(ctx, args.token);
		if (!contact || (await isFormTokenDisabled(ctx, args.token))) {
			return { ok: false, reason: 'token_not_found' };
		}
		if (contact.doiTokenExpiresAt !== undefined && contact.doiTokenExpiresAt < args.input.at) {
			return { ok: false, reason: 'token_expired' };
		}
		return await dispatch(ctx, contact, args.input);
	},
});

// ─── In-state token refresh ─────────────────────────────────────────────────
//
// A separate operation from `transition` — refreshes the pending token and
// re-sends the confirmation email *without* changing `doiStatus`. Lives in
// this module so all writes to the DOI fields (status + token + ttl) go
// through one file.

export type RefreshOutcome =
	| { ok: true; from: DoiStatus; contactId: Id<'contacts'> }
	| {
			ok: false;
			reason: 'contact_not_found' | 'not_pending';
			from?: DoiStatus;
	  };

/**
 * Generate a new confirmation token for a Contact already in `pending`
 * state and schedule the confirmation email. Refuses with `not_pending`
 * if the Contact is not currently in `pending`. Used by the
 * resend-confirmation user-facing flow — distinct from `transition`
 * because it deliberately keeps the status the same while replacing
 * the token. The form submissions that waited on the replaced token move
 * to the new one, so confirming the resent link finalizes them.
 */
export const refreshPendingToken = internalMutation({
	args: {
		contactId: v.id('contacts'),
		at: v.number(),
		token: v.string(),
		ttlMs: v.number(),
		siteUrl: v.string(),
	},
	handler: async (ctx, args): Promise<RefreshOutcome> => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return { ok: false, reason: 'contact_not_found' };
		const from = (contact.doiStatus ?? 'not_required') as DoiStatus;
		if (from !== 'pending') {
			return { ok: false, reason: 'not_pending', from };
		}
		await ctx.db.patch(args.contactId, {
			doiConfirmationToken: args.token,
			doiTokenExpiresAt: args.at + args.ttlMs,
			updatedAt: args.at,
		});
		const carryFrom = outgoingTokenToCarry(contact, args.token);
		if (carryFrom !== undefined) {
			await carryPendingSubmissions(ctx, {
				contactId: args.contactId,
				fromToken: carryFrom,
				toToken: args.token,
				episode: consentEpisodeOf(contact),
			});
		}
		if (contact.email) {
			await ctx.scheduler.runAfter(0, internal.contacts.confirmationEmail.sendConfirmationEmail, {
				email: contact.email,
				firstName: contact.firstName,
				confirmationToken: args.token,
				siteUrl: args.siteUrl,
			});
		}
		return { ok: true, from, contactId: args.contactId };
	},
});

// ─── Ending a consent episode ───────────────────────────────────────────────
//
// The other half of a consent episode's boundary. A global opt-out ends the
// episode, so a confirmation link minted before it must not lift it later:
// the token is withdrawn and `doiStatus` is left as it is. A later signup
// mints a fresh token (see `reducePending`) and the episode starts over.
// `doiConsentEpisode` moves on as well, so a form-submission carry still
// paging through the old episode's rows stops instead of following that
// fresh token or its confirmation.

/**
 * Clear a loaded Contact's confirmation token, leaving `doiStatus` as it is.
 * The form submissions that waited on the token keep it and are not carried
 * to a later one. Returns whether there was a token to clear.
 */
export async function withdrawToken(
	ctx: MutationCtx,
	contact: Doc<'contacts'>,
	at: number
): Promise<boolean> {
	if (contact.doiConfirmationToken === undefined) return false;
	await ctx.db.patch(contact._id, {
		doiConfirmationToken: undefined,
		doiTokenExpiresAt: undefined,
		updatedAt: at,
	});
	return true;
}

/**
 * End a Contact's consent episode: withdraw its outstanding confirmation
 * token, if any, and move `doiConsentEpisode` on. Called by the Topic
 * subscription (module) on every global opt-out, with or without a token,
 * because a carry can still be paging after the token was spent on a
 * confirmation.
 */
export const endConsentEpisode = internalMutation({
	args: { contactId: v.id('contacts'), at: v.number() },
	handler: async (ctx, args): Promise<{ withdrawn: boolean }> => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return { withdrawn: false };
		const withdrawn = await withdrawToken(ctx, contact, args.at);
		await ctx.db.patch(contact._id, {
			doiConsentEpisode: consentEpisodeOf(contact) + 1,
			updatedAt: args.at,
		});
		return { withdrawn };
	},
});
