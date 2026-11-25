/**
 * `/api/v1/brand-kit`: read and change the brand kit with an API key. The read
 * needs `brand-kit:read`, the write `brand-kit:write`.
 */

import {
	BRAND_KIT_LOGO_FIELDS,
	BRAND_KIT_WRITABLE_FIELDS,
	brandKitUpdateRequestSchema,
	decodeRequest,
} from '@owlat/public-contract/schemas';
import { internal } from '../_generated/api';
import type { BrandKitPatch } from './brandKit';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import {
	errorResponse,
	errorResponseFromThrow,
	invalidInputResponse,
	jsonResponse,
} from '../auth/apiResponses';

/**
 * The 400 for a field the write does not take, or `null`. Checked before the
 * schema so the answer names the field; the schema refuses it as well.
 */
function refusedField(body: unknown): Response | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	for (const field of Object.keys(body)) {
		if (BRAND_KIT_LOGO_FIELDS.includes(field)) {
			return invalidInputResponse(
				'The logos cannot be set through the API. Choose them on the brand kit page.',
				field
			);
		}
		if (!BRAND_KIT_WRITABLE_FIELDS.includes(field)) {
			return invalidInputResponse(`Unknown field ${field}`, field);
		}
	}
	return null;
}

/**
 * GET /api/v1/brand-kit - The brand kit, as the brand kit page shows it.
 */
export const getBrandKit = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'brand-kit:read', request.headers.get('Origin'));
		if (denied) return denied;
		try {
			const kit = await ctx.runQuery(internal.publicApi.brandKit.getForApi, {});
			return jsonResponse({ data: kit });
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to read the brand kit');
		}
	}
);

/**
 * PUT /api/v1/brand-kit - Change the fields the body names; the rest keep
 * their stored value. Answers with the whole kit as stored.
 */
export const updateBrandKit = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'brand-kit:write', request.headers.get('Origin'));
		if (denied) return denied;
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}
		const refused = refusedField(raw);
		if (refused) return refused;
		const decoded = decodeRequest(brandKitUpdateRequestSchema, raw);
		if (!decoded.ok) return invalidInputResponse(decoded.message, decoded.field);
		try {
			const outcome = await ctx.runMutation(internal.publicApi.brandKit.updateForApi, {
				keyId: auth.keyId,
				patch: decoded.value as BrandKitPatch,
			});
			if (!outcome.ok) {
				return errorResponse(
					'rate_limited',
					'Too many template writes from this API key. Retry after the Retry-After header.',
					{
						data: { reason: 'template_write_rate_limited' },
						retryAfter: outcome.retryAfterSeconds,
						rateLimit: auth.rateLimit,
					}
				);
			}
			return jsonResponse({ data: outcome.kit });
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to update the brand kit');
		}
	}
);
