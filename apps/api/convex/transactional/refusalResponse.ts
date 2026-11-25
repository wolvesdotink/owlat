/**
 * How `POST /api/v1/transactional` answers a refused send: the status, the
 * message and the `error.data` each refusal of the intake
 * (`./dispatchDecision.ts`) carries. A real send and a dry run (`./dryRun.ts`)
 * both answer through here, so a dry run reports a refusal word for word as
 * the send would.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { errorResponse } from '../auth/apiResponses';
import { IDEMPOTENCY_REFUSAL_MESSAGES } from '../auth/apiRequestReceipts';
import { sendingHoldLiftSentence } from '../delivery/sendingHoldLift';
import type { SendIntakeAbuseState } from '../delivery/sendIntakeGates';
import { featureDisabledMessage } from '../lib/featureFlags';
import type { OperationErrorCategory } from '@owlat/shared/operationError';
import type { SendingHoldLift } from '@owlat/public-contract';
import type { DispatchRefusal, DispatchRejectionReason } from './dispatchDecision';

/**
 * The 403 for a suspended or banned instance. The caller may run the instance
 * itself, so the message names who lifts it instead of "support". `data` keeps
 * `reason` for existing clients and adds the status, since when, and the
 * stored reason and how it lifts (`GET /api/v1/status` carries the same). That
 * reason is free text from the reputation job (rates, a sending domain, a
 * campaign id) or a platform admin's note, the same text the workspace's
 * members see on Delivery health. `lift` is read after the refusal, so it is
 * `null` only if the suspension lifted in between.
 */
function abuseBlockedResponse(
	outcome: {
		detail?: string;
		abuse?: SendIntakeAbuseState;
	},
	lift: SendingHoldLift | null
): Response {
	const status = outcome.abuse?.status ?? 'suspended';
	const since = outcome.abuse?.since ?? null;
	const detail = outcome.detail || null;
	const message = [
		status === 'banned'
			? 'Sending is permanently disabled on this Owlat instance.'
			: 'Sending is suspended on this Owlat instance.',
		// A ban never lifts by itself, and its first sentence already says so.
		status === 'suspended' && lift ? sendingHoldLiftSentence(lift) : null,
		'A platform admin of this instance can lift it in the operator console.',
		// Last, because a stored reason carries no closing punctuation.
		detail ? `Reason: ${detail}` : null,
	]
		.filter((part) => part !== null)
		.join(' ');
	return errorResponse('forbidden', message, {
		data: {
			reason: 'abuse_blocked',
			status,
			since: since === null ? null : new Date(since).toISOString(),
			detail,
			lift,
		},
	});
}

const REJECTION_RESPONSE_MAP: Record<
	Exclude<DispatchRejectionReason, 'abuse_blocked'>,
	{ category: OperationErrorCategory; defaultMessage: string }
> = {
	feature_disabled: {
		// The status every feature floor uses for a disabled flag.
		category: 'forbidden',
		defaultMessage: featureDisabledMessage('transactional'),
	},
	no_delivery_provider: {
		// 422: the instance isn't in a state that can send transactional email
		// (no delivery provider configured) — mirrors `domain_unverified`.
		category: 'invalid_state',
		defaultMessage:
			'No email delivery provider is configured for this instance. Transactional email requires a delivery provider (MTA, Resend, or SES).',
	},
	recipient_blocked: {
		category: 'invalid_state',
		defaultMessage:
			'This email address is blocked. The recipient may have previously bounced or filed a complaint.',
	},
	template_not_found: {
		category: 'not_found',
		defaultMessage: 'Transactional email not found',
	},
	template_not_published: {
		category: 'invalid_state',
		defaultMessage: 'Transactional email is not published.',
	},
	template_no_content: {
		category: 'invalid_state',
		defaultMessage: 'Transactional email has no HTML content. Please save and publish it first.',
	},
	sender_not_configured: {
		category: 'invalid_state',
		defaultMessage: 'No default sender is configured for this instance.',
	},
	domain_unverified: {
		category: 'invalid_state',
		defaultMessage: 'Sending domain is not verified.',
	},
	invalid_variables: {
		category: 'invalid_input',
		defaultMessage: 'Invalid data variables',
	},
	recipient_rate_limited: {
		category: 'rate_limited',
		defaultMessage:
			'Too many emails from this template to this recipient. Try again later; the instance admin sets this limit.',
	},
	daily_send_limit: {
		category: 'rate_limited',
		defaultMessage:
			'This API key has reached its daily transactional send limit, which the instance admin sets.',
	},
	idempotency_conflict: {
		category: 'conflict',
		defaultMessage: IDEMPOTENCY_REFUSAL_MESSAGES.idempotency_conflict,
	},
	idempotency_erased: {
		category: 'conflict',
		defaultMessage: IDEMPOTENCY_REFUSAL_MESSAGES.idempotency_erased,
	},
};

/** The response a send answers `refusal` with. */
export async function dispatchRefusalResponse(
	ctx: ActionCtx,
	refusal: DispatchRefusal
): Promise<Response> {
	if (refusal.reason === 'abuse_blocked') {
		const lift = await ctx.runQuery(internal.publicApi.status.sendingHoldLift, {});
		return abuseBlockedResponse(refusal, lift);
	}
	const map = REJECTION_RESPONSE_MAP[refusal.reason];
	return errorResponse(map.category, refusal.detail || map.defaultMessage, {
		data: {
			reason: refusal.reason,
			...(refusal.variables && { field: 'dataVariables', variables: refusal.variables }),
		},
		...(refusal.retryAfterMs !== undefined && {
			retryAfter: Math.max(1, Math.ceil(refusal.retryAfterMs / 1000)),
		}),
	});
}
