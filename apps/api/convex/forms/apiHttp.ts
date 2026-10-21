/**
 * Form submission HTTP shell — POST /forms/{formId}.
 *
 * The HTTP boundary (CORS, rate-limit, body parse, token extract, response
 * envelope) is owned by the **Public token endpoint (module)**; the
 * `:token` segment in the route happens to be the form endpoint id.
 *
 * The domain work (classification, contact resolution, topic add,
 * submission row write) lives in the **Form submission (module)** at
 * `convex/forms/submission.ts`.
 *
 * Redirect responses (302 to a user-defined success page) use the
 * factory's `raw` Response escape hatch — the shell layers CORS on top.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isSafeRedirectUrl } from '../lib/inputGuards';
import { publicCorsHeaders } from '../lib/cors';
import {
	ADMISSION_REFUSED,
	publicTokenEndpoint,
	type HandlerContext,
} from '../lib/publicTokenEndpoint';
import { getClientIp } from '../lib/publicRateLimit';
// Single source of truth: the mutation's real return contract lives in
// submission.ts. Re-declaring it here previously dropped required fields
// (submissionId, contactId, confirmationRequired) and risked silent drift.
import type { SubmitOutcome } from './submission';

/**
 * Build a 302 redirect Response. Falls back to JSON when the URL is unsafe;
 * the form shell's `raw` escape hatch wraps this so CORS is layered on by
 * the public-token endpoint shell.
 */
function buildRedirect(url: string): Response | null {
	if (!isSafeRedirectUrl(url)) {
		return null;
	}
	return new Response(null, {
		status: 302,
		headers: { Location: url },
	});
}

/**
 * CORS preflight for /forms/* — registered separately in `http.ts` because
 * the public-token-endpoint shell only handles the POST route.
 */
export const handleFormCors = httpAction(async () => {
	return new Response(null, {
		status: 204,
		headers: publicCorsHeaders('POST, OPTIONS'),
	});
});

/** Write the submission for a verified, admitted form. */
function submit(
	ctx: HandlerContext,
	formEndpointId: Id<'formEndpoints'>,
	submissionData: unknown,
	request: Request
): Promise<SubmitOutcome> {
	// Use the hardened, trusted-proxy-aware resolver for the stored audit IP —
	// never the spoofable leftmost X-Forwarded-For entry.
	const resolvedIp = getClientIp(request);
	return ctx.runMutation<SubmitOutcome>(internal.forms.submission.submit, {
		formEndpointId,
		submissionData,
		ipAddress: resolvedIp === 'unknown' ? undefined : resolvedIp,
		userAgent: request.headers.get('User-Agent') || undefined,
	});
}

/**
 * POST /forms/{formId}. The shell extracts the form id as `:token` (the
 * shell's parameter name is "token" — `submitForm` reads it as the form
 * endpoint id) and parses the multipart/json/urlencoded body.
 */
export const submitForm = publicTokenEndpoint(
	{
		path: '/forms/:token',
		method: 'POST',
		rateLimit: 'formSubmission',
		// Mix the form id into the rate-limit key (`<ip>:<sha256(formId)>`) so
		// each form gets its own window. Without this, when
		// RATE_LIMIT_TRUSTED_PROXY is unset (the default), getClientIp() returns
		// 'unknown' for everyone and ALL forms would share one 5/min bucket.
		// Only a form that exists and is active is charged to a bucket of its
		// own; any other id spends the bounded failure budget instead.
		rateLimitKeyMode: 'ip+token',
		cors: 'POST, OPTIONS',
		body: 'formData',
		resultMode: 'action',
	},
	async (ctx, { token, body: submissionData, request, admit }) => {
		const target = await ctx.runQuery<
			| { ok: true; formEndpointId: Id<'formEndpoints'> }
			| { ok: false; reason: 'feature_disabled' | 'form_not_found' | 'form_inactive' }
		>(internal.forms.endpoints.resolveSubmitTarget, { formEndpointId: token });
		if (target.ok && !(await admit())) return ADMISSION_REFUSED;
		const outcome = target.ok
			? await submit(ctx, target.formEndpointId, submissionData, request)
			: target;

		if (!outcome.ok) {
			if (outcome.reason === 'feature_disabled') {
				// Same status the feature floors use for a disabled flag. The
				// message stays neutral: the caller is an anonymous site visitor.
				return {
					ok: false,
					reason: 'feature_disabled',
					message: 'Form submissions are currently disabled',
					status: 403,
				};
			}
			if (outcome.reason === 'form_not_found') {
				return {
					ok: false,
					reason: 'form_not_found',
					message: 'Form not found',
					status: 404,
				};
			}
			return {
				ok: false,
				reason: 'form_inactive',
				message: 'This form is no longer accepting submissions',
				status: 403,
			};
		}

		switch (outcome.action) {
			case 'invalid':
				return {
					ok: false,
					reason: 'validation_error',
					message: outcome.errorMessage ?? 'Validation failed',
					status: 400,
				};
			case 'spam':
			case 'duplicate':
			case 'success': {
				if (outcome.redirectUrl) {
					const redirect = buildRedirect(outcome.redirectUrl);
					if (redirect) return { ok: true, raw: redirect };
				}
				return {
					ok: true,
					data: { message: 'Form submitted successfully' },
				};
			}
			case 'pending_confirmation': {
				if (outcome.redirectUrl) {
					const redirectWithConfirm = new URL(outcome.redirectUrl);
					redirectWithConfirm.searchParams.set('confirmation', 'pending');
					const redirect = buildRedirect(redirectWithConfirm.toString());
					if (redirect) return { ok: true, raw: redirect };
				}
				return {
					ok: true,
					data: {
						message: 'Please check your email to confirm your subscription',
						confirmationRequired: true,
					},
				};
			}
			default:
				return {
					ok: false,
					reason: 'unknown_action',
					message: 'Internal error',
					status: 500,
				};
		}
	}
);
