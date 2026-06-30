import { v } from 'convex/values';
import { authedQuery, authedMutation, publicQuery, publicMutation } from '../lib/authedFunctions';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';

/** Per-batch cap for the scheduled form-submission cascade delete. */
const FORM_SUBMISSION_DELETE_BATCH = 256;
import { requireOrgPermission } from '../lib/sessionOrganization';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { throwNotFound, throwRateLimited, throwInvalidInput } from '../_utils/errors';
import { rateLimiter } from '../rateLimiter';
import { formFieldValidator } from '../lib/convexValidators';
import { assertFeatureEnabled } from '../lib/featureFlags';
import type { TransitionOutcome as DoiTransitionOutcome } from '../contacts/doiLifecycle';
import { findContactByConfirmationToken } from '../contacts/doiLifecycle';
import type { MarkConfirmedOutcome } from './submission';

// Field configuration type
export interface FormField {
	key: string;
	label: string;
	type: 'email' | 'text' | 'checkbox';
	required: boolean;
}

/**
 * Every form must keep an email-type field. Without one, submission.ts can
 * never resolve a recipient address and rejects every public POST with
 * 'Email is required' — a silently dead form. Enforce the invariant on the
 * server so it holds even when fields arrive outside the dashboard UI (SDK,
 * direct Convex client). Mirrors the same guard in useFormSettings.ts.
 */
function assertHasEmailField(fields: FormField[]): void {
	if (!fields.some((f) => f.type === 'email')) {
		throwInvalidInput('A form needs at least one email field');
	}
}

/**
 * List all form endpoints for an organization
 */
export const listByTeam = authedQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'forms');
		const forms = await ctx.db
			.query('formEndpoints')
			.collect(); // bounded: small per-org list

		return forms.map((form) => ({
			...form,
			totalSubmissions: form.submissionCount ?? 0,
			successfulSubmissions: form.successfulSubmissionCount ?? 0,
		}));
	},
});

/**
 * Get a single form endpoint by ID
 */
export const get = authedQuery({
	args: {
		formEndpointId: v.id('formEndpoints'),
	},
	handler: async (ctx, args) => {
		const form = await ctx.db.get(args.formEndpointId);
		if (!form) {
			return null;
		}

		return {
			...form,
			totalSubmissions: form.submissionCount ?? 0,
			successfulSubmissions: form.successfulSubmissionCount ?? 0,
		};
	},
});

/**
 * Get form endpoint by ID for public submission (minimal data).
 * honeypotFieldName excluded from public response to prevent bots from reading it.
 */
// public: embeddable signup form render — called by the public form widget with no session
export const getForSubmission = publicQuery({
	args: {
		formEndpointId: v.id('formEndpoints'),
	},
	handler: async (ctx, args) => {
		const form = await ctx.db.get(args.formEndpointId);
		if (!form) {
			return null;
		}

		return {
			_id: form._id,
			topicId: form.topicId,
			fields: form.fields,
			redirectUrl: form.redirectUrl,
			isActive: form.isActive,
			doubleOptIn: form.doubleOptIn,
		};
	},
});

/**
 * Create a new form endpoint
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		topicId: v.optional(v.id('topics')),
		fields: v.optional(v.array(formFieldValidator)),
		redirectUrl: v.optional(v.string()),
		honeypotFieldName: v.optional(v.string()),
		doubleOptIn: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage forms');
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.redirectUrl) validateStringLength(args.redirectUrl, STRING_LIMITS.URL, 'Redirect URL');
		// Explicit fields must include the email field; the unset path falls
		// back to the email-only default below, which trivially satisfies it.
		if (args.fields) assertHasEmailField(args.fields);

		const now = Date.now();

		// Default fields if not provided
		const defaultFields: FormField[] = [
			{ key: 'email', label: 'Email', type: 'email', required: true },
		];

		const formId = await ctx.db.insert('formEndpoints', {
			name: args.name,
			topicId: args.topicId,
			fields: args.fields || defaultFields,
			redirectUrl: args.redirectUrl,
			honeypotFieldName: args.honeypotFieldName,
			isActive: true,
			doubleOptIn: args.doubleOptIn,
			submissionCount: 0,
			createdAt: now,
			updatedAt: now,
		});

		return formId;
	},
});

/**
 * Update a form endpoint
 */
export const update = authedMutation({
	args: {
		formEndpointId: v.id('formEndpoints'),
		name: v.optional(v.string()),
		topicId: v.optional(v.id('topics')),
		fields: v.optional(v.array(formFieldValidator)),
		redirectUrl: v.optional(v.string()),
		honeypotFieldName: v.optional(v.string()),
		isActive: v.optional(v.boolean()),
		doubleOptIn: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage forms');
		// Validate input lengths
		if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.redirectUrl) validateStringLength(args.redirectUrl, STRING_LIMITS.URL, 'Redirect URL');
		// A fields update may not drop the email field — otherwise the form
		// goes silently dead (every submission fails 'Email is required').
		if (args.fields !== undefined) assertHasEmailField(args.fields);

		const { formEndpointId, ...updates } = args;

		const form = await ctx.db.get(formEndpointId);
		if (!form) {
			throwNotFound('Form endpoint');
		}


		// Build update object with only provided fields
		const updateData: Record<string, unknown> = {
			updatedAt: Date.now(),
		};

		if (updates.name !== undefined) updateData['name'] = updates.name;
		if (updates.topicId !== undefined) updateData['topicId'] = updates.topicId;
		if (updates.fields !== undefined) updateData['fields'] = updates.fields;
		if (updates.redirectUrl !== undefined) updateData['redirectUrl'] = updates.redirectUrl;
		if (updates.honeypotFieldName !== undefined)
			updateData['honeypotFieldName'] = updates.honeypotFieldName;
		if (updates.isActive !== undefined) updateData['isActive'] = updates.isActive;
		if (updates.doubleOptIn !== undefined) updateData['doubleOptIn'] = updates.doubleOptIn;

		await ctx.db.patch(formEndpointId, updateData);

		return formEndpointId;
	},
});

/**
 * Delete a form endpoint and all its submissions
 */
export const remove = authedMutation({
	args: {
		formEndpointId: v.id('formEndpoints'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage', 'Only owners and admins can manage forms');
		const form = await ctx.db.get(args.formEndpointId);
		if (!form) {
			throwNotFound('Form endpoint');
		}

		// Deactivate immediately (stops new submissions), then drain the unbounded
		// submission history in scheduled batches before deleting the endpoint —
		// instead of collecting + deleting an entire form's lifetime of submissions
		// (one row per public POST, incl. spam) in one mutation, which exceeded the
		// per-transaction read/write budget on a busy form and made it undeletable.
		await ctx.db.patch(args.formEndpointId, { isActive: false, updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.forms.endpoints.drainAndDeleteForm, {
			formEndpointId: args.formEndpointId,
		});
	},
});

/**
 * Scheduled cascade: delete one bounded page of a form's submissions per
 * invocation, rescheduling until drained, then delete the endpoint row. Reuses
 * the batched-continuation shape of organizations/deletion/steps/formSubmissions.
 */
export const drainAndDeleteForm = internalMutation({
	args: { formEndpointId: v.id('formEndpoints') },
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query('formSubmissions')
			.withIndex('by_form_endpoint', (q) => q.eq('formEndpointId', args.formEndpointId))
			.take(FORM_SUBMISSION_DELETE_BATCH);

		for (const submission of batch) {
			await ctx.db.delete(submission._id);
		}

		if (batch.length === FORM_SUBMISSION_DELETE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.forms.endpoints.drainAndDeleteForm, {
				formEndpointId: args.formEndpointId,
			});
		} else {
			// Get-before-delete: a concurrent double-remove schedules two drain
			// chains; the second reaching this branch would otherwise delete an
			// already-deleted endpoint and throw from the scheduled function.
			const endpoint = await ctx.db.get(args.formEndpointId);
			if (endpoint) await ctx.db.delete(args.formEndpointId);
		}
	},
});

/**
 * Get recent submissions for a form endpoint
 */
export const getSubmissions = authedQuery({
	args: {
		formEndpointId: v.id('formEndpoints'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const form = await ctx.db.get(args.formEndpointId);
		if (!form) return [];


		const limit = args.limit || 50;

		const submissions = await ctx.db
			.query('formSubmissions')
			.withIndex('by_form_endpoint', (q) => q.eq('formEndpointId', args.formEndpointId))
			.order('desc')
			.take(limit);

		// Omit the DOI confirmationToken — it is a capability that confirms the
		// subscription; the member-facing submission list must not expose it.
		return submissions.map(({ confirmationToken: _confirmationToken, ...rest }) => rest);
	},
});

/**
 * Get form submission by confirmation token
 */
// public: DOI confirmation landing page — token is the capability, no session
export const getByConfirmationToken = publicQuery({
	args: {
		token: v.string(),
	},
	handler: async (ctx, args) => {
		const submission = await ctx.db
			.query('formSubmissions')
			.withIndex('by_confirmation_token', (q) => q.eq('confirmationToken', args.token))
			.first();

		if (!submission) {
			// No form submission for this token. The same /confirm?token= link is
			// also sent for contact-level DOI added via the public API or any other
			// non-form path, which mints the contact's doiConfirmationToken but
			// writes no formSubmissions row. Fall back to that so those links resolve.
			const contact = await findContactByConfirmationToken(ctx, args.token);
			if (!contact) return null;
			if (contact.doiTokenExpiresAt && contact.doiTokenExpiresAt < Date.now()) return null;
			const settings = await ctx.db.query('instanceSettings').first();
			return {
				_id: contact._id,
				formEndpointId: null,
				contactId: contact._id,
				status: contact.doiStatus === 'confirmed' ? 'success' : 'pending_confirmation',
				email: contact.email ?? '',
				organizationName: settings?.defaultFromName ?? 'Unknown',
				topicId: null,
				confirmedAt: contact.doiConfirmedAt,
			};
		}

		// Get the form endpoint to get topic info
		const form = await ctx.db.get(submission.formEndpointId);
		if (!form) {
			return null;
		}

		// Get the instance name
		const instanceSettings = await ctx.db.query('instanceSettings').first();
		const instanceName = instanceSettings?.defaultFromName ?? 'Unknown';

		// Get email from submission data
		const data = submission.data as Record<string, unknown> | undefined;
		const email = (data?.['email'] as string) || '';

		return {
			_id: submission._id,
			formEndpointId: submission.formEndpointId,
			contactId: submission.contactId,
			status: submission.status,
			email,
			organizationName: instanceName,
			topicId: form.topicId,
			confirmedAt: submission.confirmedAt,
		};
	},
});

/**
 * Confirm a form submission (double opt-in).
 *
 * Per ADR-0009 + ADR-0015: the form submission's `confirmationToken` is
 * the same string as the contact's `doiConfirmationToken`. Each module
 * owns its own table — this handler chains the two:
 *   1. **DOI lifecycle (module)** patches the contact + fires the
 *      `fire_topic_subscribed_triggers` and `contact_activity_topic_confirmed`
 *      effects.
 *   2. **Form submission (module)** patches the `formSubmissions` row to
 *      `success` via `markConfirmedByToken`.
 *
 * Idempotent — re-confirming an already-`success` submission returns
 * `{ success: true, alreadyConfirmed: true }` without erroring.
 */
type ConfirmSubmissionResult =
	| { success: true; alreadyConfirmed: boolean }
	| { success: false; error: string };

// public: double-opt-in confirmation via secret token — followed from an email link, no session
export const confirmSubmission = publicMutation({
	args: {
		token: v.string(),
	},
	handler: async (ctx, args): Promise<ConfirmSubmissionResult> => {
		const now = Date.now();

		// This publicMutation is reachable directly on the Convex client API,
		// parallel to the rate-limited HTTP /confirm/doi route — cap confirm
		// storms against a single token (the high-entropy token itself defeats
		// enumeration; this bounds replay/refresh hammering of a known one).
		const { ok, retryAfter } = await rateLimiter.limit(ctx, 'doiConfirmation', {
			key: `token:${args.token}`,
		});
		if (!ok) {
			throwRateLimited('Too many confirmation attempts. Please try again shortly.', retryAfter);
		}

		// Step 1: peek the form-side state. The DOI side clears its token on
		// confirm (per the lifecycle reducer), so a second click can't be
		// disambiguated via DOI alone — the form-side memory of the token
		// outlives DOI's. Catching the already-`success` case here also
		// avoids a redundant DOI mutation when the user just refreshes the
		// confirmation page.
		const submission = await ctx.db
			.query('formSubmissions')
			.withIndex('by_confirmation_token', (q) =>
				q.eq('confirmationToken', args.token),
			)
			.first();

		if (!submission) {
			// Contact-level DOI (added via the public API / any non-form path) mints
			// the same token but has no formSubmissions row. Confirm it directly via
			// the DOI lifecycle — there is no form row to patch in step 3.
			const doiOnly: DoiTransitionOutcome = await ctx.runMutation(
				internal.contacts.doiLifecycle.transitionByConfirmationToken,
				{ token: args.token, input: { to: 'confirmed', at: now } },
			);
			if (!doiOnly.ok) {
				if (doiOnly.reason === 'token_expired') return { success: false, error: 'token_expired' };
				return { success: false, error: 'invalid_token' };
			}
			return { success: true, alreadyConfirmed: doiOnly.applied === 'recorded' };
		}
		if (submission.status === 'success') {
			return { success: true, alreadyConfirmed: true };
		}
		if (submission.status !== 'pending_confirmation') {
			return { success: false, error: 'invalid_status' };
		}

		// Step 2: confirm DOI on the contact. The lifecycle module owns the
		// contact-side patch, the trigger fanout, the topic_confirmed
		// activity rows, and the token-expiry check.
		const doiOutcome: DoiTransitionOutcome = await ctx.runMutation(
			internal.contacts.doiLifecycle.transitionByConfirmationToken,
			{
				token: args.token,
				input: { to: 'confirmed', at: now },
			},
		);

		if (!doiOutcome.ok) {
			if (doiOutcome.reason === 'token_expired') {
				return { success: false, error: 'token_expired' };
			}
			// token_not_found — the contact-side has no row matching this token.
			return { success: false, error: 'invalid_token' };
		}

		// Step 3: patch the form submission row to `success`. The peek above
		// already filtered to `pending_confirmation`, so the only soft outcome
		// here is the unlikely race where another caller flipped the row
		// between the peek and now.
		const submissionOutcome: MarkConfirmedOutcome = await ctx.runMutation(
			internal.forms.submission.markConfirmedByToken,
			{ token: args.token },
		);

		if (!submissionOutcome.ok) {
			if (submissionOutcome.reason === 'already_confirmed') {
				return { success: true, alreadyConfirmed: true };
			}
			if (submissionOutcome.reason === 'no_submission_for_token') {
				return { success: false, error: 'invalid_token' };
			}
			return { success: false, error: 'invalid_status' };
		}

		return { success: true, alreadyConfirmed: doiOutcome.applied === 'recorded' };
	},
});
