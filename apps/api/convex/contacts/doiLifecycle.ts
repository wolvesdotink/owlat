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
 * Effects:
 *   send_confirmation_email          — schedules confirmationEmail.send
 *   fire_topic_subscribed_triggers   — fans out to DOI-required memberships
 *   contact_activity                 — one `topic_confirmed` row per
 *                                      DOI-required membership; routed
 *                                      through the Contact activity (module)
 *
 * See docs/adr/0009-doi-lifecycle-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	recordContactActivity,
	type MetadataFor,
	type RecordContactActivityArgs,
} from '../contactActivities/writer';
import type { ContactActivityType } from '../contactActivities/catalog';
import { recordAuditLog } from '../lib/auditLog';
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
			reason:
				| 'contact_not_found'
				| 'token_not_found'
				| 'token_expired'
				| 'illegal_edge'
				| 'terminal';
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
	}),
);

// ─── Legal-edges graph ──────────────────────────────────────────────────────

const LEGAL_EDGES: Record<DoiStatus, ReadonlySet<DoiStatus>> = {
	not_required: new Set<DoiStatus>(['pending']),
	pending: new Set<DoiStatus>(['confirmed']),
	confirmed: new Set<DoiStatus>(),
};

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
			// Fires on the admin-attest path. The token-keyed confirm and the
			// pending transition do not emit audit_log entries today — adding
			// universal audit_log to the DOI lifecycle is tracked separately;
			// this kind only fires for `to: 'confirmed', source: 'admin_attest'`.
			kind: 'audit_log';
			action: 'doi.admin_attested';
			contactId: Id<'contacts'>;
			triggeredBy: string;
			attestSource: string;
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

function reducePending(
	contact: Doc<'contacts'>,
	args: Extract<TransitionInput, { to: 'pending' }>,
): ReducerResult {
	const from = (contact.doiStatus ?? 'not_required') as DoiStatus;
	if (from === 'pending') {
		// Idempotent — already pending, no second email.
		return { patch: {}, effects: [], applied: 'recorded' };
	}
	const effects: Effect[] = [];
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
				`Set SITE_URL if this is a public double-opt-in flow.`,
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
	doiRequiredTopics: ReadonlyArray<DoiRequiredTopic>,
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
			attestSource: args.attestSource,
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
				metadata: { topicId: String(topic.id), topicName: topic.name },
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
	}
	return {
		patch,
		effects,
		applied: 'transitioned',
	};
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'send_confirmation_email': {
				await ctx.scheduler.runAfter(
					0,
					internal.confirmationEmail.sendConfirmationEmail,
					{
						email: effect.email,
						firstName: effect.firstName,
						confirmationToken: effect.token,
						siteUrl: effect.siteUrl,
					},
				);
				break;
			}
			case 'fire_topic_subscribed_triggers': {
				for (const topicId of effect.topicIds) {
					await ctx.runMutation(
						internal.automations.triggers.fireTopicSubscribedTrigger,
						{
							contactId: effect.contactId,
							topicId,
						},
					);
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
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: effect.triggeredBy,
					action: effect.action,
					resource: 'contact',
					resourceId: effect.contactId,
					details: { attestSource: effect.attestSource },
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
	token: string,
): Promise<Doc<'contacts'> | null> {
	return await ctx.db
		.query('contacts')
		.withIndex('by_doi_confirmation_token', (q) =>
			q.eq('doiConfirmationToken', token),
		)
		.first();
}

// ─── Topic membership resolution ────────────────────────────────────────────
//
// At confirm time, we need the contact's DOI-required topic memberships
// for both the trigger fanout and the activity rows. Loaded once and
// passed to the reducer so the reducer stays pure-ish.

async function loadDoiRequiredMemberships(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
): Promise<{
	topics: Array<DoiRequiredTopic>;
	clearMembershipIds: Array<Id<'contactTopics'>>;
}> {
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect();
	const topics: Array<DoiRequiredTopic> = [];
	const clearMembershipIds: Array<Id<'contactTopics'>> = [];
	for (const m of memberships) {
		const topic = await ctx.db.get(m.topicId);
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
	input: TransitionInput,
): Promise<TransitionOutcome> {
	const from = (contact.doiStatus ?? 'not_required') as DoiStatus;
	const isLegalEdge = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	// Admin-attest path relaxes the `not_required → confirmed` edge that the
	// token-keyed path refuses. Other DOI transitions ignore this branch.
	const isAdminAttestEdge =
		input.to === 'confirmed' &&
		'source' in input &&
		input.source === 'admin_attest' &&
		from === 'not_required';

	if (!isLegalEdge && !isSelfLoop && !isAdminAttestEdge) {
		if (LEGAL_EDGES[from].size === 0) {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	let result: ReducerResult;
	switch (input.to) {
		case 'pending':
			result = reducePending(contact, input);
			break;
		case 'confirmed': {
			const { topics, clearMembershipIds } = await loadDoiRequiredMemberships(
				ctx,
				contact._id,
			);
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
		if (
			contact.doiTokenExpiresAt !== undefined &&
			contact.doiTokenExpiresAt < args.input.at
		) {
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
 * the token.
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
		if (contact.email) {
			await ctx.scheduler.runAfter(
				0,
				internal.confirmationEmail.sendConfirmationEmail,
				{
					email: contact.email,
					firstName: contact.firstName,
					confirmationToken: args.token,
					siteUrl: args.siteUrl,
				},
			);
		}
		return { ok: true, from, contactId: args.contactId };
	},
});
