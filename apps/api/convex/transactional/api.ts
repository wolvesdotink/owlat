/**
 * Transactional send HTTP shell.
 *
 * Owns HTTP-boundary concerns:
 *   - Auth (via `createAuthenticatedHandler`).
 *   - CORS / OPTIONS preflight (registered separately in `http.ts`).
 *   - JSON body parsing.
 *   - This route's own request-body ceiling ({@link TRANSACTIONAL_MAX_BODY_BYTES}).
 *   - JSON-shape validation (required fields, types, email format, language
 *     format, envelope size, attachment count + size limits, https-only URL
 *     check), all of it before any attachment byte is stored.
 *   - Attachment validation, storage upload and the pending-upload handoff to
 *     dispatch, in `transactional/attachmentIntake.ts`.
 *   - Response shaping.
 *
 * The intake orchestration (abuse gate, blocklist, template lookup, domain
 * verification, variable validation, contact upsert, language resolution,
 * route resolution, attachment merging, row insert, counters, enqueue) lives
 * in the **Transactional send intake (module)** at `transactional/dispatch.ts`.
 *
 * See docs/adr/0021-transactional-send-intake-module.md.
 */

import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	MAX_BODY_BYTES,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import { jsonResponse, errorResponse } from '../auth/apiResponses';
import {
	isJsonPrimitiveRecord,
	isValidEmail,
	normalizeEmail,
	type JsonPrimitiveValue,
} from '../lib/inputGuards';
import { featureDisabledMessage } from '../lib/featureFlags';
import { utf8Bytes } from '../lib/bytes';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import type { OperationErrorCategory } from '@owlat/shared/operationError';
import type { DispatchRejectionReason } from './dispatch';
import { prepareAttachments, uploadAndDispatch, type AttachmentInput } from './attachmentIntake';

// ============================================================
// HTTP request / response types
// ============================================================

interface SendTransactionalBody {
	transactionalId?: string;
	slug?: string;
	email: string;
	dataVariables?: Record<string, JsonPrimitiveValue>;
	language?: string;
	attachments?: AttachmentInput[];
}

interface SendTransactionalResponse {
	status: 'queued';
	email: string;
	transactionalEmailId: string;
	slug: string;
	contactId?: string;
	contactCreated: boolean;
	language: string;
}

// ============================================================
// Shape validation
// ============================================================

const MAX_ATTACHMENTS = ATTACHMENT_COMPOSE_LIMITS.maxCount;
const MAX_TOTAL_SIZE = ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes;

/**
 * Everything in a request except attachment `content` keeps the 100,000-byte
 * budget every other v1 endpoint has for its whole body.
 */
const MAX_ENVELOPE_BYTES = MAX_BODY_BYTES;

/**
 * This route's request-body ceiling: the attachment budget as base64 (4 bytes
 * per 3, plus the padding each of up to {@link MAX_ATTACHMENTS} parts can add)
 * and the envelope above. With the 10 MiB budget that is 14,081,056 bytes.
 *
 * Sized against the HTTP action's real limits rather than raised blindly:
 * Convex accepts at most 20 MiB of request body, and an action has a 64 MiB V8
 * heap and a separate 64 MiB ArrayBuffer pool. Counting a copy at every step,
 * the pool holds the buffered body and its re-wrapped copy (~27 MiB) plus the
 * decoded attachments and one blob copy (20 MiB); the heap holds the body text
 * and the parsed strings (~27 MiB). Both stay well inside 64 MiB. The body is
 * still read through the authenticated shell's streaming cap, after the key
 * check, so an oversized one is cut off at the first byte past this number.
 */
export const TRANSACTIONAL_MAX_BODY_BYTES =
	Math.ceil(MAX_TOTAL_SIZE / 3) * 4 + 4 * MAX_ATTACHMENTS + MAX_ENVELOPE_BYTES;

/**
 * UTF-8 size of the request with every attachment's base64 `content` left out:
 * the part of the body that is not covered by the decoded-size budget.
 */
function envelopeBytes(body: SendTransactionalBody): number {
	const attachments = Array.isArray(body.attachments)
		? body.attachments.map((att) =>
				att && typeof att === 'object' && typeof att.content === 'string'
					? { ...att, content: undefined }
					: att
			)
		: body.attachments;
	return utf8Bytes(JSON.stringify({ ...body, attachments })).byteLength;
}

/**
 * Validate the request body shape — required fields, types, email format,
 * language format, attachment count + size limits, https-only URL check.
 * Returns a Response on failure, or null when the body passes every gate.
 * No DB access — this is the boundary check the module trusts has run.
 */
function validateRequestShape(body: SendTransactionalBody): Response | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return errorResponse('invalid_input', 'Request body must be a JSON object');
	}
	if (!body.email) {
		return errorResponse('invalid_input', 'email is required');
	}
	if (typeof body.email !== 'string') {
		return errorResponse('invalid_input', 'email must be a string');
	}
	if (!isValidEmail(body.email)) {
		return errorResponse('invalid_input', 'Invalid email format');
	}
	if (!body.transactionalId && !body.slug) {
		return errorResponse('invalid_input', 'Either transactionalId or slug is required');
	}
	if (body.dataVariables !== undefined && !isJsonPrimitiveRecord(body.dataVariables)) {
		return errorResponse(
			'invalid_input',
			'dataVariables must be an object of string, number, boolean or null values'
		);
	}
	if (body.language !== undefined && typeof body.language !== 'string') {
		return errorResponse('invalid_input', 'language must be a string');
	}
	if (body.language && !/^[a-z]{2}(-[A-Za-z]{2,3})?$/i.test(body.language)) {
		return errorResponse(
			'invalid_input',
			"language must be a valid language code (e.g., 'en', 'de', 'fr', 'en-US')"
		);
	}

	if (body.attachments !== undefined) {
		if (!Array.isArray(body.attachments)) {
			return errorResponse('invalid_input', 'attachments must be an array');
		}
		if (body.attachments.length > MAX_ATTACHMENTS) {
			return errorResponse('invalid_input', `Maximum ${MAX_ATTACHMENTS} attachments allowed`);
		}
	}
	if (envelopeBytes(body) > MAX_ENVELOPE_BYTES) {
		return errorResponse(
			'invalid_input',
			`Request fields other than attachment content exceed ${MAX_ENVELOPE_BYTES} bytes`
		);
	}

	return null;
}

// ============================================================
// Outcome → response mapping
// ============================================================

const REJECTION_RESPONSE_MAP: Record<
	DispatchRejectionReason,
	{ category: OperationErrorCategory; defaultMessage: string }
> = {
	feature_disabled: {
		// The status every feature floor uses for a disabled flag.
		category: 'forbidden',
		defaultMessage: featureDisabledMessage('transactional'),
	},
	abuse_blocked: {
		category: 'forbidden',
		defaultMessage: 'Your account has been suspended. Please contact support for assistance.',
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
	domain_unverified: {
		category: 'invalid_state',
		defaultMessage: 'Sending domain is not verified.',
	},
	invalid_variables: {
		category: 'invalid_input',
		defaultMessage: 'Invalid data variables',
	},
};

// ============================================================
// HTTP route handler
// ============================================================

/**
 * POST /api/v1/transactional — send a transactional email.
 */
export const sendTransactional = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'transactional:send', request.headers.get('Origin'));
		if (denied) return denied;
		// Refuse before any attachment is stored. `dispatch` repeats the check for
		// its own callers.
		const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
		if (!flags.transactional) {
			return errorResponse('forbidden', featureDisabledMessage('transactional'), {
				data: { reason: 'feature_disabled' },
			});
		}
		// Parse body.
		let body: SendTransactionalBody;
		try {
			body = (await request.json()) as SendTransactionalBody;
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}

		// JSON-shape validation.
		const shapeError = validateRequestShape(body);
		if (shapeError) return shapeError;

		// Every attachment is checked and decoded before any byte is stored.
		const preparedAttachments = prepareAttachments(body.attachments);
		if (!preparedAttachments.ok) return preparedAttachments.response;

		// Build the templateLookup discriminator.
		const templateLookup = body.transactionalId
			? {
					kind: 'id' as const,
					id: body.transactionalId as Id<'transactionalEmails'>,
				}
			: { kind: 'slug' as const, slug: body.slug! };

		const intake = await uploadAndDispatch(ctx, preparedAttachments.prepared, {
			templateLookup,
			email: normalizeEmail(body.email),
			dataVariables: body.dataVariables,
			language: body.language,
		});
		if (!intake.ok) return intake.response;
		const outcome = intake.outcome;
		if (!outcome.ok) {
			const map = REJECTION_RESPONSE_MAP[outcome.reason];
			return errorResponse(map.category, outcome.detail || map.defaultMessage, {
				data: { reason: outcome.reason },
			});
		}

		const response: SendTransactionalResponse = {
			status: 'queued',
			email: body.email,
			transactionalEmailId: outcome.sendId,
			slug: body.slug ?? '',
			contactId: outcome.contactId,
			contactCreated: outcome.contactCreated,
			language: outcome.language,
		};
		return jsonResponse({ data: response }, 202);
	},
	{ maxBodyBytes: TRANSACTIONAL_MAX_BODY_BYTES }
);
