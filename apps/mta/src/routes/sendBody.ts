/**
 * The wire shape of a `/send`, `/send/postbox` and `/send/system` body, as a
 * validator the intake decodes every request with before reading a field.
 *
 * It checks TYPES (a recipient is a string, a header map holds strings, a
 * re-entry context carries a numeric clock), so the handler never meets a
 * number where it calls `.toLowerCase()`. The intake's own policy stays in the
 * handler: which route accepts which fields, the routing-lease and re-entry
 * bounds, address syntax, attachment limits. Unknown keys are ignored, so a
 * Convex one release ahead can add a field without every send being refused
 * during the rollout.
 *
 * The handler assigns the decoded value to `MtaSendRequest`, so a field the
 * protocol package makes required, or narrows, stops compiling here until this
 * validator agrees with it.
 */

import { v } from 'convex/values';
import { DELIVERY_DOMAINS, GOVERNED_MESSAGE_TYPES } from '@owlat/shared/routingDispatch';
import { literalUnion } from '@owlat/worker-protocol/literalUnion';

/**
 * The largest body the intake reads: a Postbox PGP/MIME message of up to
 * 25 MiB arrives base64-encoded (a third larger), beside its HTML and headers.
 */
export const SEND_BODY_MAX_BYTES = 48 * 1024 * 1024;

const optionalString = v.optional(v.string());

export const sendBodyValidator = v.object({
	messageId: v.string(),
	workAttemptId: optionalString,
	routingReentryToken: optionalString,
	routingReentry: v.optional(
		v.object({
			// Opaque here: Convex re-reads it from its own snapshot.
			envelopeInput: v.any(),
			retryState: v.object({
				attempt: v.number(),
				startedAt: v.number(),
				idempotencyKey: v.string(),
				workAttemptId: optionalString,
				acceptanceReconciliation: v.optional(v.boolean()),
			}),
		})
	),
	to: v.string(),
	from: v.string(),
	subject: v.string(),
	html: v.string(),
	text: optionalString,
	sealedMimeBase64: optionalString,
	attachments: v.optional(
		v.array(v.object({ filename: v.string(), contentType: v.string(), contentBase64: v.string() }))
	),
	amp: optionalString,
	replyTo: optionalString,
	headers: v.optional(v.record(v.string(), v.string())),
	ipPool: literalUnion(['campaign', 'transactional'] as const),
	organizationId: v.string(),
	messageType: v.optional(literalUnion(GOVERNED_MESSAGE_TYPES)),
	deliveryDomain: v.optional(literalUnion(DELIVERY_DOMAINS)),
	// Read through `readEngagementScore`, which owns its shape and its fallback.
	engagementScore: v.optional(v.any()),
	dkimDomain: v.string(),
	allowedFromAddresses: v.optional(v.array(v.string())),
	routingLease: optionalString,
	allowWarmupOverflow: v.optional(v.boolean()),
});
