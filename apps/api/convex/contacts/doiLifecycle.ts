/**
 * DOI lifecycle (module) — single writer of contacts.doiStatus.
 *
 * Owns the three-state machine `not_required → pending → confirmed` and the
 * companion-field atomicity (doiConfirmationToken, doiTokenExpiresAt,
 * doiConfirmedAt). Two entry points: `transition` (direct, by contactId) and
 * `transitionByConfirmationToken` (token-keyed — symmetric to Send lifecycle's
 * transitionByProviderMessageId). Reducers return { patch, effects, applied };
 * the runner is the only place that touches the DB and the scheduler.
 *
 * Consent episodes: a confirmation counts only for the episode it was issued
 * in. A global opt-out ends the episode (`endConsentEpisode`: the token is
 * withdrawn and `doiConsentEpisode` moves on), and a later public signup opens
 * a new one (`reopen`) instead of reusing the old confirmation. See ADR-0009's
 * 2026-10 amendments.
 *
 * Effects:
 *   send_confirmation_email          — schedules confirmationEmail.send
 *   fire_topic_subscribed_triggers   — fans out to DOI-required memberships
 *   contact_activity                 — one `topic_confirmed` row per
 *                                      DOI-required membership; routed
 *                                      through the Contact activity (module)
 *   carry_pending_submissions        — moves the form submissions that waited
 *                                      on a replaced token to the new one;
 *                                      routed through the Form submission
 *                                      (module)
 *
 * See docs/adr/0009-doi-lifecycle-module.md.
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	recordContactActivity,
	type MetadataFor,
	type RecordContactActivityArgs,
} from '../contactActivities/writer';
import type { ContactActivityType } from '../contactActivities/catalog';
import { recordAuditLog } from '../lib/auditLog';
import { defineLifecycle, refuse, type LifecycleReason } from '../lib/lifecycle';
import { logWarn } from '../lib/runtimeLog';
import { batchGet } from '../_utils/batchLoader';

// ─── Constants ──────────────────────────────────────────────────────────────

export const DOI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type DoiStatus = 'not_required' | 'pending' | 'confirmed';

export type TransitionInput =
	| {
			to: 'pending';
			at: number;
			token: string;
			ttlMs: number;
			siteUrl?: string;
			/**
			 * Open a new consent episode for a contact whose earlier confirmation
			 * a global opt-out has since ended. Sanctions `confirmed → pending`,
			 * and only while `contacts.unsubscribedAt` is set; refused otherwise.
			 */
			reopen?: boolean;
	  }
	| { to: 'confirmed'; at: number }
	| {
			// Admin-attest path: the contact was already DOI-confirmed at a source
			// platform (Mailchimp, Klaviyo, Stripe, ...). Relaxes the otherwise-
			// refused `not_required → confirmed` legal edge. See ADR-0019.
			to: 'confirmed';
			at: number;
			source: 'admin_attest';
			attestSource: string;
			triggeredBy?: string;
	  };

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

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('pending'),
		at: v.number(),
		token: v.string(),
		ttlMs: v.number(),
		siteUrl: v.optional(v.string()),
		reopen: v.optional(v.boolean()),
	}),
	// Admin-attest variant declared before the plain `{ to: 'confirmed', at }`
	// variant so the union validator matches the discriminated `source` field
	// before the simpler shape — see ADR-0019.
	v.object({
		to: v.literal('confirmed'),
		at: v.number(),
		source: v.literal('admin_attest'),
		attestSource: v.string(),
		triggeredBy: v.optional(v.string()),
	}),
	v.object({
		to: v.literal('confirmed'),
		at: v.number(),
	})
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// The graph and the dispatcher preamble that reads it live in the generic
// lifecycle core (`lib/lifecycle.ts`, ADR-0058); the reducers and effects below
// stay here. `confirmed` is terminal and this machine publishes the distinct
// `terminal` refusal, so `reportsTerminalRefusals` is on. The two edges the
// graph cannot express ride the per-call `isSanctionedEdge` opt-out in
// `dispatch` rather than being declared here: ADR-0019's admin-attest
// relaxation of `not_required → confirmed`, and the `reopen` of
// `confirmed → pending` for a contact whose consent a global opt-out ended.

const DOI_LIFECYCLE = defineLifecycle<DoiStatus>(
	{
		not_required: ['pending'],
		pending: ['confirmed'],
		confirmed: [],
	},
	{ reportsTerminalRefusals: true }
);

// ─── Effects ────────────────────────────────────────────────────────────────

/**
 * Per-lifecycle wrapper around the shared `RecordContactActivityArgs`
 * distributed union. Every lifecycle that writes contact activity rows
 * uses this same effect kind.
 */
type ContactActivityEffect = {
	[L in ContactActivityType]: {
		kind: 'contact_activity';
		literal: L;
		contactId: Id<'contacts'>;
		metadata: MetadataFor<L>;
		occurredAt: number;
	};
}[ContactActivityType];

type Effect =
	| {
			kind: 'send_confirmation_email';
			email: string;
			firstName: string | undefined;
			token: string;
			siteUrl: string;
	  }
	| {
			kind: 'fire_topic_subscribed_triggers';
			contactId: Id<'contacts'>;
			topicIds: ReadonlyArray<Id<'topics'>>;
	  }
	| {
			// A new token replaced one the contact still held (a lapsed one; a
			// live token is kept). The form submissions that waited on it move to
			// the new token, so the next confirmation finalizes them as well.
			// `episode` is the contact's consent episode; a follow-up page that
			// finds it moved on stops.
			kind: 'carry_pending_submissions';
			contactId: Id<'contacts'>;
			fromToken: string;
			toToken: string;
			episode: number;
	  }
	| {
			// Fires on the admin-attest path and when a new consent episode is
			// opened over an earlier confirmation (`reopen`), so the confirmation
			// it supersedes stays on the record. The plain token-keyed confirm and
			// pending transitions do not emit audit_log entries today — adding
			// universal audit_log to the DOI lifecycle is tracked separately.
			kind: 'audit_log';
			action: 'doi.admin_attested' | 'doi.reconfirmation_requested';
			contactId: Id<'contacts'>;
			triggeredBy: string;
			details: Record<string, string | number>;
	  }
	| ContactActivityEffect;

type ReducerResult = {
	patch: Record<string, unknown>;
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
};

// ─── Reducers ───────────────────────────────────────────────────────────────
//
// Pure-ish: take the loaded contact + the typed transition args + (for the
// confirmed reducer) the pre-resolved DOI-required topic ids, return a
// ReducerResult. Reducers do not touch the DB or the scheduler.

/**
 * Whether the contact holds a confirmation token that can still be redeemed.
 * A pending contact can lack one: a global opt-out withdraws it, and an
 * unclicked one lapses after `DOI_TOKEN_TTL_MS`.
 */
function holdsLiveToken(contact: Doc<'contacts'>, at: number): boolean {
	if (contact.doiConfirmationToken === undefined) return false;
	return contact.doiTokenExpiresAt === undefined || contact.doiTokenExpiresAt >= at;
}

/**
 * Whether the contact is globally opted out and its token was issued at or
 * before that opt-out. Every token is minted with `DOI_TOKEN_TTL_MS`, so its
 * issue time is `doiTokenExpiresAt - DOI_TOKEN_TTL_MS`; a token without an
 * expiry predates expiries and counts as earlier. A global opt-out withdraws
 * the token now, so only a contact that opted out before that change can
 * still hold one (see migration 0057).
 */
export function tokenPredatesOptOut(
	contact: Pick<Doc<'contacts'>, 'doiConfirmationToken' | 'doiTokenExpiresAt' | 'unsubscribedAt'>
): boolean {
	if (contact.doiConfirmationToken === undefined || contact.unsubscribedAt === undefined) {
		return false;
	}
	if (contact.doiTokenExpiresAt === undefined) return true;
	return contact.doiTokenExpiresAt - DOI_TOKEN_TTL_MS <= contact.unsubscribedAt;
}

/** The contact's consent episode; a contact no global opt-out reached is in 0. */
function consentEpisodeOf(contact: Doc<'contacts'>): number {
	return contact.doiConsentEpisode ?? 0;
}

/**
 * The token whose pending form submissions a replacement by `newToken`
 * carries over, if any. A withdrawn token is no longer on the contact, and a
 * token that predates the contact's opt-out belongs to the episode the
 * opt-out ended, so neither is carried.
 */
function outgoingTokenToCarry(contact: Doc<'contacts'>, newToken: string): string | undefined {
	const token = contact.doiConfirmationToken;
	if (token === undefined || token === newToken || tokenPredatesOptOut(contact)) return undefined;
	return token;
}

function reducePending(
	contact: Doc<'contacts'>,
	args: Extract<TransitionInput, { to: 'pending' }>
): ReducerResult {
	const from = (contact.doiStatus ?? 'not_required') as DoiStatus;
	if (from === 'pending' && holdsLiveToken(contact, args.at)) {
		// Idempotent — already pending with a usable link, no second email.
		// Every signup made in this window shares the one token.
		return { patch: {}, effects: [], applied: 'recorded' };
	}
	const effects: Effect[] = [];
	if (from === 'confirmed') {
		// A new consent episode (dispatch only lets `reopen` through here). The
		// earlier confirmation is superseded, not erased: `doiConfirmedAt` is
		// left alone until the new one lands, and the audit row keeps both
		// timestamps after that.
		effects.push({
			kind: 'audit_log',
			action: 'doi.reconfirmation_requested',
			contactId: contact._id,
			triggeredBy: 'system',
			details: {
				...(contact.doiConfirmedAt !== undefined
					? { previousConfirmedAt: contact.doiConfirmedAt }
					: {}),
				...(contact.unsubscribedAt !== undefined ? { unsubscribedAt: contact.unsubscribedAt } : {}),
			},
		});
	}
	const carryFrom = outgoingTokenToCarry(contact, args.token);
	if (carryFrom !== undefined) {
		effects.push({
			kind: 'carry_pending_submissions',
			contactId: contact._id,
			fromToken: carryFrom,
			toToken: args.token,
			episode: consentEpisodeOf(contact),
		});
	}
	// Only schedule the confirmation email when the caller provides a siteUrl
	// — admin imports that pre-confirm out-of-band leave it absent.
	if (args.siteUrl && contact.email) {
		effects.push({
			kind: 'send_confirmation_email',
			email: contact.email,
			firstName: contact.firstName,
			token: args.token,
			siteUrl: args.siteUrl,
		});
	} else if (contact.email && !args.siteUrl) {
		// A contact with an email is being put into pending_doi but no siteUrl
		// was supplied, so no confirmation email can be built — the contact
		// would stay pending forever. Legitimate for admin imports that confirm
		// out-of-band; a likely misconfiguration for a public double-opt-in
		// flow (SITE_URL unset), so surface it rather than failing silently.
		logWarn(
			`DOI set to pending for contact ${contact._id} but no siteUrl was provided; ` +
				`no confirmation email sent — the contact will stay pending. ` +
				`Set SITE_URL if this is a public double-opt-in flow.`
		);
	}
	return {
		patch: {
			doiStatus: 'pending',
			doiConfirmationToken: args.token,
			doiTokenExpiresAt: args.at + args.ttlMs,
			updatedAt: args.at,
		},
		effects,
		applied: 'transitioned',
	};
}

interface DoiRequiredTopic {
	id: Id<'topics'>;
	name: string;
}

type ConfirmedInput = Extract<TransitionInput, { to: 'confirmed' }>;
type AdminAttestInput = Extract<ConfirmedInput, { source: 'admin_attest' }>;

function isAdminAttest(input: ConfirmedInput): input is AdminAttestInput {
	return 'source' in input && input.source === 'admin_attest';
}

function reduceConfirmed(
	contact: Doc<'contacts'>,
	args: ConfirmedInput,
	doiRequiredTopics: ReadonlyArray<DoiRequiredTopic>
): ReducerResult {
	const from = (contact.doiStatus ?? 'not_required') as DoiStatus;
	if (from === 'confirmed') {
		// Idempotent — already confirmed.
		return { patch: {}, effects: [], applied: 'recorded' };
	}
	const adminAttest = isAdminAttest(args);
	const effects: Effect[] = [];
	if (adminAttest) {
		effects.push({
			kind: 'audit_log',
			action: 'doi.admin_attested',
			contactId: contact._id,
			triggeredBy: args.triggeredBy ?? 'system',
			details: { attestSource: args.attestSource },
		});
		effects.push({
			kind: 'contact_activity',
			literal: 'doi_attested',
			contactId: contact._id,
			metadata: { attestSource: args.attestSource },
			occurredAt: args.at,
		});
	}
	if (doiRequiredTopics.length > 0) {
		effects.push({
			kind: 'fire_topic_subscribed_triggers',
			contactId: contact._id,
			topicIds: doiRequiredTopics.map((t) => t.id),
		});
		// One `contact_activity` effect per confirmed Topic membership —
		// metadata pre-resolved here so the reducer stays pure and the
		// runner is uniform with the other lifecycles' `contact_activity`
		// effects.
		for (const topic of doiRequiredTopics) {
			effects.push({
				kind: 'contact_activity',
				literal: 'topic_confirmed',
				contactId: contact._id,
				metadata: { topicId: topic.id, topicName: topic.name },
				occurredAt: args.at,
			});
		}
	}
	const patch: Record<string, unknown> = {
		doiStatus: 'confirmed',
		doiConfirmedAt: args.at,
		updatedAt: args.at,
	};
	// A genuine confirmed opt-in (token-click or admin-attest) lifts a prior
	// global marketing opt-out — this is the authoritative point at which a
	// DOI-pending re-subscribe becomes a real opt-in, so the persistent
	// `contacts.unsubscribedAt` signal is cleared here rather than at
	// subscribe time (see topics/subscription.ts subscribeOne). Only emitted
	// when an opt-out is actually set so the patch stays a no-op otherwise.
	if (contact.unsubscribedAt !== undefined) {
		patch['unsubscribedAt'] = undefined;
	}
	if (adminAttest) {
		patch['doiAttestedSource'] = args.attestSource;
	} else {
		// Token-keyed path clears the consumed token + expiry. Admin-attest
		// from `not_required` has no token to clear — the contact never had
		// one — so the explicit `undefined` patches stay scoped to the
		// token-keyed path.
		patch['doiConfirmationToken'] = undefined;
		patch['doiTokenExpiresAt'] = undefined;
		// A recipient confirmation supersedes an earlier attestation (a
		// reopened episode on an attested contact); the attest audit row keeps
		// that history.
		if (contact.doiAttestedSource !== undefined) patch['doiAttestedSource'] = undefined;
	}
	return {
		patch,
		effects,
		applied: 'transitioned',
	};
}

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
				await ctx.scheduler.runAfter(0, internal.confirmationEmail.sendConfirmationEmail, {
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
		if (!contact) return { ok: false, reason: 'token_not_found' };
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
			await ctx.scheduler.runAfter(0, internal.confirmationEmail.sendConfirmationEmail, {
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
