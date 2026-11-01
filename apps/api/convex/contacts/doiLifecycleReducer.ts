/**
 * DOI lifecycle — the deciding half.
 *
 * The status and transition types, the transition validator, the legal-edges
 * graph, the effect union, the token rules and the reducers that turn a
 * transition into `{ patch, effects, applied }`. Nothing here touches `ctx`:
 * `doiLifecycle.ts` owns the dispatcher that applies the result, the effect
 * runner and every mutation, so it stays the single writer of
 * `contacts.doiStatus`.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MetadataFor } from '../contactActivities/writer';
import type { ContactActivityType } from '../contactActivities/catalog';
import { defineLifecycle } from '../lib/lifecycle';
import { logWarn } from '../lib/runtimeLog';

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
			// refused `not_required → confirmed` legal edge.
			to: 'confirmed';
			at: number;
			source: 'admin_attest';
			attestSource: string;
			triggeredBy?: string;
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

export const transitionInputValidator = v.union(
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
	// before the simpler shape.
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
// lifecycle core (`lib/lifecycle.ts`); the reducers and effects below
// stay here. `confirmed` is terminal and this machine publishes the distinct
// `terminal` refusal, so `reportsTerminalRefusals` is on. The two edges the
// graph cannot express ride the per-call `isSanctionedEdge` opt-out in
// `dispatch` (doiLifecycle.ts) rather than being declared here: the admin-attest
// relaxation of `not_required → confirmed`, and the `reopen` of
// `confirmed → pending` for a contact whose consent a global opt-out ended.

export const DOI_LIFECYCLE = defineLifecycle<DoiStatus>(
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

export type Effect =
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

export type ReducerResult = {
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
export function consentEpisodeOf(contact: Doc<'contacts'>): number {
	return contact.doiConsentEpisode ?? 0;
}

/**
 * The token whose pending form submissions a replacement by `newToken`
 * carries over, if any. A withdrawn token is no longer on the contact, and a
 * token that predates the contact's opt-out belongs to the episode the
 * opt-out ended, so neither is carried.
 */
export function outgoingTokenToCarry(
	contact: Doc<'contacts'>,
	newToken: string
): string | undefined {
	const token = contact.doiConfirmationToken;
	if (token === undefined || token === newToken || tokenPredatesOptOut(contact)) return undefined;
	return token;
}

export function reducePending(
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

export interface DoiRequiredTopic {
	id: Id<'topics'>;
	name: string;
}

type ConfirmedInput = Extract<TransitionInput, { to: 'confirmed' }>;
type AdminAttestInput = Extract<ConfirmedInput, { source: 'admin_attest' }>;

function isAdminAttest(input: ConfirmedInput): input is AdminAttestInput {
	return 'source' in input && input.source === 'admin_attest';
}

export function reduceConfirmed(
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
	// subscribe time (see topics/subscriptionOps.ts subscribeOne). Only emitted
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
