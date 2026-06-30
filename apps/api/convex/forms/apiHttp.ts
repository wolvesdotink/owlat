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
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isSafeRedirectUrl } from '../lib/inputGuards';
import { publicCorsHeaders } from '../lib/cors';
import { publicTokenEndpoint } from '../lib/publicTokenEndpoint';
import { getClientIp } from '../publicRateLimit';
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
		// Mix the form id into the rate-limit key (`<ip>:<formId>`) so each form
		// gets its own window. Without this, when RATE_LIMIT_TRUSTED_PROXY is
		// unset (the default), getClientIp() returns 'unknown' for everyone and
		// ALL forms share one 5/min bucket — flooding any single form (even a
		// non-existent id) would 429 every newsletter/contact form on the
		// instance. Keying on the form id isolates that blast radius to the
		// targeted form; legitimate submissions to other forms are unaffected.
		rateLimitKeyMode: 'ip+token',
		cors: 'POST, OPTIONS',
		body: 'formData',
		resultMode: 'action',
	},
	async (ctx, { token: formEndpointId, body: submissionData, request }) => {
		// Use the hardened, trusted-proxy-aware resolver for the stored audit IP —
		// never the spoofable leftmost X-Forwarded-For entry.
		const resolvedIp = getClientIp(request);
		const ipAddress = resolvedIp === 'unknown' ? undefined : resolvedIp;
		const userAgent = request.headers.get('User-Agent') || undefined;

		const outcome = await ctx.runMutation<SubmitOutcome>(
			internal.forms.submission.submit,
			{
				formEndpointId: formEndpointId as Id<'formEndpoints'>,
				submissionData,
				ipAddress,
				userAgent,
			},
		);

		if (!outcome.ok) {
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
	},
);
