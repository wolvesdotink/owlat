/**
 * Form submission (module) — single intake path for public form endpoints.
 *
 * Owns:
 *   - the classifier that picks one of five submission outcomes from a
 *     raw POST: `spam | invalid | duplicate | pending_confirmation | success`
 *   - all writes to `formSubmissions` (insert at submit + the
 *     `pending_confirmation → success` patch at confirm)
 *   - the `formEndpoints.submissionCount` denormalization
 *   - delegation into the **Contact resolution (module)** (`upsert` mode)
 *     and the **Topic subscription (module)** (`subscribe`) — the form
 *     path no longer carries its own find-or-create or routes through
 *     `api.topics.topics.addContact`'s auth shell.
 *
 * Two entry points keyed by shape:
 *   submit                       — one HTTP POST → one row
 *   markConfirmedByToken         — `pending_confirmation → success`
 *
 * Mirrors **Contact resolution (module)**'s shape (intake + `action`
 * discriminator), not the Outbound lifecycle shape — most rows land
 * directly in a terminal state at create time.
 *
 * See docs/adr/0015-form-submission-module.md.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { createContact } from '../contacts/creation';
import type { SubscribeOutcome } from '../topics/subscription';
import { isValidEmail, normalizeEmail, STRING_LIMITS } from '../lib/inputGuards';
import { jsonPrimitiveRecord } from '../lib/convexValidators';
import { getOptional } from '../lib/env';
import { logWarn } from '../lib/runtimeLog';

// ─── Types ──────────────────────────────────────────────────────────────────

export const SUBMIT_ACTION_LITERALS = [
	'spam',
	'invalid',
	'duplicate',
	'pending_confirmation',
	'success',
] as const;

export type SubmitAction = (typeof SUBMIT_ACTION_LITERALS)[number];

export type SubmitOutcome =
	| {
			ok: true;
			submissionId: Id<'formSubmissions'>;
			action: SubmitAction;
			contactId?: Id<'contacts'>;
			// HTTP-shell metadata — the module read the form already, so the
			// caller doesn't need a second query to shape its response.
			redirectUrl?: string;
			confirmationRequired?: boolean;
			errorMessage?: string;
	  }
	| {
			ok: false;
			reason: 'form_not_found' | 'form_inactive';
	  };

export type MarkConfirmedOutcome =
	| { ok: true; submissionId: Id<'formSubmissions'> }
	| {
			ok: false;
			reason:
				| 'no_submission_for_token'
				| 'already_confirmed'
				| 'invalid_state';
	  };

// ─── Subscribe-result shape (narrowed to what the classifier needs) ─────────

type SubscribeOkResult = Extract<SubscribeOutcome, { ok: true }>;

// ─── Classifier ─────────────────────────────────────────────────────────────

/**
 * Decide the submission status from the upstream module outcomes.
 *
 * Pure function — exported for unit tests. Six matrix inputs:
 *   - no topicId × Contact resolution {matched, created}
 *   - topicId set × subscribe action {already_member, subscribed, pending_doi}
 */
export function classifyAction(
	resolveAction: 'matched' | 'created' | 'updated',
	subscribeResult: SubscribeOkResult | undefined,
	topicExpected = false,
): SubmitAction {
	// A topic subscription was expected but failed (`subscribeResult` is set
	// only on success). The contact was upserted but not subscribed, so this is
	// NOT a successful submission — classify as `invalid` so it doesn't bump
	// `successfulSubmissionCount`. Distinct from the no-topic path below, which
	// `subscribeResult === undefined` alone could not tell apart.
	if (topicExpected && !subscribeResult) {
		return 'invalid';
	}
	// No topicId on the form — classify on Contact resolution alone.
	if (!subscribeResult) {
		return resolveAction === 'created' ? 'success' : 'duplicate';
	}
	// topicId set — subscribe was called.
	if (subscribeResult.action === 'already_member') return 'duplicate';
	if (subscribeResult.action === 'pending_doi') return 'pending_confirmation';
	return 'success';
}

// ─── Field validation ──────────────────────────────────────────────────────

interface FormField {
	key: string;
	label: string;
	type: 'email' | 'text' | 'checkbox';
	required: boolean;
}

interface ValidateResult {
	email: string | null;
	errors: string[];
}

/**
 * Run the configured form fields against the raw submission data. Returns
 * the extracted email (lowercased + trimmed) and any validation errors.
 */
export function validateFields(
	fields: FormField[],
	submissionData: Record<string, string>,
): ValidateResult {
	const errors: string[] = [];
	let email = '';

	for (const field of fields) {
		const value = submissionData[field.key];

		if (field.required && (!value || value.trim() === '')) {
			errors.push(`${field.label} is required`);
			continue;
		}

		if (value && value.length > STRING_LIMITS.FORM_FIELD_VALUE) {
			errors.push(`${field.label} exceeds maximum length`);
			continue;
		}

		if (field.type === 'email' && value) {
			if (!isValidEmail(value.trim())) {
				errors.push(`${field.label} must be a valid email address`);
			} else {
				email = normalizeEmail(value);
			}
		}
	}

	if (!email && errors.length === 0) {
		errors.push('Email is required');
	}

	return { email: email || null, errors };
}

// ─── Row writer ────────────────────────────────────────────────────────────

async function insertSubmission(
	ctx: MutationCtx,
	args: {
		form: Doc<'formEndpoints'>;
		status: SubmitAction;
		data: Record<string, string>;
		ipAddress?: string;
		userAgent?: string;
		contactId?: Id<'contacts'>;
		errorMessage?: string;
		confirmationToken?: string;
	},
): Promise<Id<'formSubmissions'>> {
	const now = Date.now();
	const submissionId = await ctx.db.insert('formSubmissions', {
		formEndpointId: args.form._id,
		contactId: args.contactId,
		data: args.data,
		status: args.status,
		ipAddress: args.ipAddress,
		userAgent: args.userAgent,
		errorMessage: args.errorMessage,
		confirmationToken: args.confirmationToken,
		confirmationEmailSentAt: args.confirmationToken ? now : undefined,
		submittedAt: now,
	});

	await ctx.db.patch(args.form._id, {
		submissionCount: (args.form.submissionCount ?? 0) + 1,
		successfulSubmissionCount:
			(args.form.successfulSubmissionCount ?? 0) +
			(args.status === 'success' ? 1 : 0),
		updatedAt: now,
	});

	return submissionId;
}

// ─── Contact-field extraction ──────────────────────────────────────────────

function extractContactFields(submissionData: Record<string, string>): {
	firstName?: string;
	lastName?: string;
} {
	const firstName = (
		submissionData['firstName'] ||
		submissionData['first_name'] ||
		''
	).trim();
	const lastName = (
		submissionData['lastName'] ||
		submissionData['last_name'] ||
		''
	).trim();
	const fields: { firstName?: string; lastName?: string } = {};
	if (firstName) fields.firstName = firstName;
	if (lastName) fields.lastName = lastName;
	return fields;
}

// ─── Entry points ──────────────────────────────────────────────────────────

const submitArgsValidator = {
	formEndpointId: v.id('formEndpoints'),
	submissionData: jsonPrimitiveRecord,
	ipAddress: v.optional(v.string()),
	userAgent: v.optional(v.string()),
};

/**
 * Submit a form. One HTTP POST → one row.
 *
 * Pre-classification gates (form_not_found, form_inactive) return
 * `{ ok: false, reason }` without writing a row. Everything else lands as
 * a `formSubmissions` row with one of the five terminal-or-pending statuses.
 *
 * `submissionData` is `Record<string, string | number | boolean>` per the
 * `jsonPrimitiveRecord` shape — string values from JSON / form-urlencoded
 * / multipart bodies pass through unchanged.
 */
export const submit = internalMutation({
	args: submitArgsValidator,
	handler: async (ctx, args): Promise<SubmitOutcome> => {
		const form = await ctx.db.get(args.formEndpointId);
		if (!form) return { ok: false, reason: 'form_not_found' };
		if (!form.isActive) return { ok: false, reason: 'form_inactive' };

		// `jsonPrimitiveRecord` is `Record<string, string | number | boolean>`.
		// Coerce all field values to string up-front — every form field's value
		// reaches this module via HTTP body parsing, which encodes everything
		// as strings, but the validator is permissive.
		const data: Record<string, string> = {};
		for (const [key, raw] of Object.entries(args.submissionData)) {
			let stringValue = String(raw);
			if (stringValue.length > STRING_LIMITS.FORM_FIELD_VALUE) {
				stringValue = stringValue.substring(0, STRING_LIMITS.FORM_FIELD_VALUE);
			}
			data[key] = stringValue;
		}

		// ─── Honeypot ────────────────────────────────────────────────────────
		const honeypotFieldName = form.honeypotFieldName || '_hp_field';
		if (data[honeypotFieldName]) {
			const submissionId = await insertSubmission(ctx, {
				form,
				status: 'spam',
				data,
				ipAddress: args.ipAddress,
				userAgent: args.userAgent,
			});
			return {
				ok: true,
				submissionId,
				action: 'spam',
				redirectUrl: form.redirectUrl,
			};
		}

		// ─── Field validation ────────────────────────────────────────────────
		const fields = form.fields as FormField[];
		const { email, errors } = validateFields(fields, data);

		if (errors.length > 0 || !email) {
			const errorMessage = errors.join('; ');
			const submissionId = await insertSubmission(ctx, {
				form,
				status: 'invalid',
				data,
				ipAddress: args.ipAddress,
				userAgent: args.userAgent,
				errorMessage,
			});
			return {
				ok: true,
				submissionId,
				action: 'invalid',
				errorMessage,
			};
		}

		// ─── Contact resolution (upsert) ─────────────────────────────────────
		const contactFields = extractContactFields(data);
		const resolveResult = await createContact(ctx, {
			channel: 'email',
			identifier: email,
			source: 'form',
			mode: 'upsert',
			contactFields,
		});
		const contactId = resolveResult.contactId;

		// ─── Topic subscription (if form has a topic) ────────────────────────
		let subscribeResult: SubscribeOkResult | undefined;
		if (form.topicId) {
			const siteUrl = getOptional('SITE_URL') || undefined;
			const subscribeOutcome: SubscribeOutcome = await ctx.runMutation(
				internal.topics.subscription.subscribe,
				{
					topicId: form.topicId,
					contactId,
					source: 'form',
					// Honor the form's own "Enable Double Opt-In" toggle. DOI is the
					// union of the form and topic controls, so ticking it forces a
					// confirmation step even when the topic itself does not require
					// one (previously this toggle was persisted + shown but never
					// consulted — a GDPR/compliance footgun).
					...(form.doubleOptIn === true ? { forceDoi: true } : {}),
					...(siteUrl ? { siteUrl } : {}),
				},
			);

			if (subscribeOutcome.ok) {
				subscribeResult = subscribeOutcome;
			} else {
				// The contact was upserted but the topic subscribe failed
				// (contact_not_found / topic_not_found / contact_soft_deleted —
				// e.g. the form's topic was deleted, leaving a stale topicId).
				// Surface it; the classifier marks the submission `invalid` below
				// (topicExpected) so it is not recorded as a successful signup.
				logWarn(
					`Form ${form._id} subscribe to topic ${String(form.topicId)} failed: ${subscribeOutcome.reason}`,
				);
			}
		}

		// ─── Classify + write submission row ─────────────────────────────────
		const action = classifyAction(
			resolveResult.action,
			subscribeResult,
			form.topicId !== undefined,
		);
		const confirmationToken =
			subscribeResult?.action === 'pending_doi'
				? subscribeResult.doiToken
				: undefined;

		const submissionId = await insertSubmission(ctx, {
			form,
			status: action,
			data,
			ipAddress: args.ipAddress,
			userAgent: args.userAgent,
			contactId,
			confirmationToken,
		});

		return {
			ok: true,
			submissionId,
			action,
			contactId,
			redirectUrl: form.redirectUrl,
			confirmationRequired: action === 'pending_confirmation',
		};
	},
});

const markConfirmedByTokenArgsValidator = {
	token: v.string(),
};

/**
 * Patch a form submission from `pending_confirmation → success`.
 *
 * Called by the form-confirm HTTP handler AFTER
 * `doiLifecycle.transitionByConfirmationToken` commits the contact-side
 * state. Each module owns its own table — DOI patches the contact, this
 * patches the submission row.
 *
 * Idempotent: re-confirming an already-`success` row returns
 * `{ ok: false, reason: 'already_confirmed' }` (not an error condition;
 * the caller maps it to a success response).
 */
export const markConfirmedByToken = internalMutation({
	args: markConfirmedByTokenArgsValidator,
	handler: async (ctx, args): Promise<MarkConfirmedOutcome> => {
		const submission = await ctx.db
			.query('formSubmissions')
			.withIndex('by_confirmation_token', (q) =>
				q.eq('confirmationToken', args.token),
			)
			.first();

		if (!submission) {
			return { ok: false, reason: 'no_submission_for_token' };
		}
		if (submission.status === 'success') {
			return { ok: false, reason: 'already_confirmed' };
		}
		if (submission.status !== 'pending_confirmation') {
			return { ok: false, reason: 'invalid_state' };
		}

		await ctx.db.patch(submission._id, {
			status: 'success',
			confirmedAt: Date.now(),
		});

		const form = await ctx.db.get(submission.formEndpointId);
		if (form) {
			await ctx.db.patch(form._id, {
				successfulSubmissionCount:
					(form.successfulSubmissionCount ?? 0) + 1,
			});
		}

		return { ok: true, submissionId: submission._id };
	},
});
