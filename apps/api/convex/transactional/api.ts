/**
 * Transactional send HTTP shell.
 *
 * Owns HTTP-boundary concerns:
 *   - Auth (via `createAuthenticatedHandler`).
 *   - CORS / OPTIONS preflight (registered separately in `http.ts`).
 *   - JSON body parsing.
 *   - JSON-shape validation (required fields, types, email format, language
 *     format, attachment count + size limits, https-only URL check).
 *   - Attachment storage upload (base64 decode → `ctx.storage.store`).
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
import {
	createAuthenticatedHandler,
	jsonResponse,
	errorResponse,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiAuth';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import type { OperationErrorCategory } from '@owlat/shared/operationError';
import type {
	AttachmentRef,
	DispatchOutcome,
	DispatchRejectionReason,
} from './dispatch';

// ============================================================
// HTTP request / response types
// ============================================================

// Convex action context shape used inside the HTTP handler — narrowed to the
// surfaces we touch (storage + runMutation).
interface ActionContext {
	runQuery: <T>(query: unknown, args: unknown) => Promise<T>;
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
	runAction: <T>(action: unknown, args: unknown) => Promise<T>;
	storage: {
		store(blob: Blob): Promise<string>;
		getUrl(storageId: string): Promise<string | null>;
	};
}

interface AttachmentInput {
	filename: string;
	content?: string; // Base64-encoded (mutually exclusive with url)
	url?: string; // HTTPS URL (mutually exclusive with content)
	contentType?: string;
}

interface SendTransactionalBody {
	transactionalId?: string;
	slug?: string;
	email: string;
	dataVariables?: Record<string, unknown>;
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
 * Validate the request body shape — required fields, types, email format,
 * language format, attachment count + size limits, https-only URL check.
 * Returns a Response on failure, or null when the body passes every gate.
 * No DB access — this is the boundary check the module trusts has run.
 */
function validateRequestShape(body: SendTransactionalBody): Response | null {
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
	if (body.dataVariables !== undefined && typeof body.dataVariables !== 'object') {
		return errorResponse('invalid_input', 'dataVariables must be an object');
	}
	if (body.language !== undefined && typeof body.language !== 'string') {
		return errorResponse('invalid_input', 'language must be a string');
	}
	if (body.language && !/^[a-z]{2}(-[A-Za-z]{2,3})?$/i.test(body.language)) {
		return errorResponse(
			'invalid_input',
			"language must be a valid language code (e.g., 'en', 'de', 'fr', 'en-US')",
		);
	}

	if (body.attachments !== undefined) {
		if (!Array.isArray(body.attachments)) {
			return errorResponse('invalid_input', 'attachments must be an array');
		}
		if (body.attachments.length > MAX_ATTACHMENTS) {
			return errorResponse(
				'invalid_input',
				`Maximum ${MAX_ATTACHMENTS} attachments allowed`,
			);
		}
	}

	return null;
}

// ============================================================
// Attachment storage upload
// ============================================================

type AttachmentUploadResult =
	| { ok: true; refs: AttachmentRef[] | undefined }
	| { ok: false; response: Response };

/**
 * Decode and store base64 attachments to Convex storage; pass HTTPS URL
 * attachments through verbatim. Returns the prepared `AttachmentRef[]` the
 * dispatch module consumes (or undefined when there were no attachments).
 *
 * Requires action context (`ctx.storage.store` is action-only) — this is
 * why the HTTP shell handles attachments rather than the mutation-shaped
 * dispatch module.
 */
async function uploadAttachments(
	ctx: ActionContext,
	attachments: AttachmentInput[] | undefined,
): Promise<AttachmentUploadResult> {
	if (!attachments || attachments.length === 0) {
		return { ok: true, refs: undefined };
	}

	let totalDecodedSize = 0;
	const refs: AttachmentRef[] = [];

	for (let i = 0; i < attachments.length; i++) {
		const att = attachments[i] as AttachmentInput;

		if (!att.filename || typeof att.filename !== 'string') {
			return {
				ok: false,
				response: errorResponse(
					'invalid_input',
					`attachments[${i}].filename is required and must be a string`,
				),
			};
		}
		if (att.filename.includes('/') || att.filename.includes('\\')) {
			return {
				ok: false,
				response: errorResponse(
					'invalid_input',
					`attachments[${i}].filename must not contain path separators`,
				),
			};
		}

		const hasContent = att.content !== undefined;
		const hasUrl = att.url !== undefined;
		if (hasContent === hasUrl) {
			return {
				ok: false,
				response: errorResponse(
					'invalid_input',
					`attachments[${i}] must have exactly one of "content" (base64) or "url"`,
				),
			};
		}

		if (hasUrl) {
			if (typeof att.url !== 'string' || !att.url.startsWith('https://')) {
				return {
					ok: false,
					response: errorResponse(
						'invalid_input',
						`attachments[${i}].url must be an HTTPS URL`,
					),
				};
			}
			refs.push({
				filename: att.filename,
				contentType: att.contentType,
				url: att.url,
			});
			continue;
		}

		// Base64 content path: decode, count bytes against budget, upload.
		if (typeof att.content !== 'string') {
			return {
				ok: false,
				response: errorResponse(
					'invalid_input',
					`attachments[${i}].content must be a base64-encoded string`,
				),
			};
		}

		let decoded: Uint8Array;
		try {
			decoded = Uint8Array.from(atob(att.content), (c) => c.charCodeAt(0));
		} catch {
			return {
				ok: false,
				response: errorResponse(
					'invalid_input',
					`attachments[${i}].content is not valid base64`,
				),
			};
		}

		totalDecodedSize += decoded.byteLength;
		if (totalDecodedSize > MAX_TOTAL_SIZE) {
			return {
				ok: false,
				response: errorResponse(
					'invalid_input',
					`Total attachment size exceeds ${MAX_TOTAL_SIZE / (1024 * 1024)}MB limit`,
				),
			};
		}

		const contentType = att.contentType || 'application/octet-stream';
		const blob = new Blob([decoded as BlobPart], { type: contentType });
		const storageId = await ctx.storage.store(blob);
		const storageUrl = await ctx.storage.getUrl(storageId);

		if (!storageUrl) {
			return {
				ok: false,
				response: errorResponse('internal', 'Failed to store attachment'),
			};
		}

		refs.push({
			filename: att.filename,
			contentType: att.contentType,
			url: storageUrl,
			storageId,
		});
	}

	return { ok: true, refs: refs.length > 0 ? refs : undefined };
}

// ============================================================
// Outcome → response mapping
// ============================================================

const REJECTION_RESPONSE_MAP: Record<
	DispatchRejectionReason,
	{ category: OperationErrorCategory; defaultMessage: string }
> = {
	abuse_blocked: {
		category: 'forbidden',
		defaultMessage:
			'Your account has been suspended. Please contact support for assistance.',
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
		defaultMessage:
			'Transactional email has no HTML content. Please save and publish it first.',
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
	async (
		ctx: ActionContext,
		request: Request,
		auth: AuthenticatedContext,
	): Promise<Response> => {
		const denied = requireScope(auth, 'transactional:send', request.headers.get('Origin'));
		if (denied) return denied;
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

		// Attachment storage upload (action-only — has to happen here, not in
		// the mutation-shaped dispatch module).
		const uploadResult = await uploadAttachments(ctx, body.attachments);
		if (!uploadResult.ok) return uploadResult.response;

		// Build the templateLookup discriminator.
		const templateLookup = body.transactionalId
			? {
					kind: 'id' as const,
					id: body.transactionalId as Id<'transactionalEmails'>,
				}
			: { kind: 'slug' as const, slug: body.slug! };

		// Dispatch.
		const outcome = (await ctx.runMutation<DispatchOutcome>(
			internal.transactional.dispatch.dispatch,
			{
				templateLookup,
				email: normalizeEmail(body.email),
				dataVariables: body.dataVariables,
				language: body.language,
				attachmentRefs: uploadResult.refs,
			},
		)) as DispatchOutcome;

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
);
