/**
 * `/api/v1/saved-blocks`: list, read, create and replace saved blocks with an
 * API key. Reads need `templates:read`, writes `templates:write`.
 */

import type { SavedBlockInput, SavedBlockWriteResult } from '@owlat/public-contract';
import {
	decodeRequest,
	readListQuery,
	savedBlockRequestSchema,
} from '@owlat/public-contract/schemas';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
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
	pathSegmentAfter,
} from '../auth/apiResponses';
import { isValidConvexId } from '../lib/inputGuards';
import { checkContent, MAX_STORED_EMAIL_BYTES } from './templateContent';
import { MAX_TEMPLATE_BODY_BYTES } from './transactionalEmailsHttp';

const PATH_MARKER = 'saved-blocks';

function blockIdFromPath(request: Request): Id<'emailBlocks'> | Response {
	const segment = pathSegmentAfter(request, PATH_MARKER);
	if (!segment.ok && segment.reason === 'missing') {
		return invalidInputResponse('The saved block ID is required', 'id');
	}
	const parts = new URL(request.url).pathname.split('/');
	if (parts.slice(parts.indexOf(PATH_MARKER) + 2).some(Boolean)) {
		return errorResponse('not_found', 'Not found');
	}
	if (!segment.ok || !isValidConvexId(segment.value)) {
		return invalidInputResponse('Invalid saved block ID format', 'id');
	}
	return segment.value as Id<'emailBlocks'>;
}

/** The checked fields of a decoded body, or the 400 to answer. */
function prepareWrite(body: SavedBlockInput):
	| {
			ok: true;
			fields: { name: string; description: string; content: string };
			issues: SavedBlockWriteResult['issues'];
	  }
	| { ok: false; response: Response } {
	const check = checkContent(body.blocks);
	if (check.firstError) {
		return {
			ok: false,
			response: errorResponse(
				'invalid_input',
				check.firstError.blockId
					? `Block ${check.firstError.blockId}: ${check.firstError.message}`
					: check.firstError.message,
				{
					data: {
						reason: 'invalid_content',
						field: 'blocks',
						...(check.firstError.blockId ? { blockId: check.firstError.blockId } : {}),
						issues: check.issues,
					},
				}
			),
		};
	}
	const content = JSON.stringify({ blocks: check.blocks });
	if (new TextEncoder().encode(content).length > MAX_STORED_EMAIL_BYTES) {
		return {
			ok: false,
			response: errorResponse('invalid_input', 'The saved block is too large to store.', {
				data: { reason: 'content_too_large', field: 'blocks' },
			}),
		};
	}
	return {
		ok: true,
		fields: { name: body.name.trim(), description: body.description?.trim() ?? '', content },
		issues: check.issues,
	};
}

async function decodeBody(
	request: Request
): Promise<{ ok: true; body: SavedBlockInput } | { ok: false; response: Response }> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return { ok: false, response: errorResponse('invalid_input', 'Invalid JSON in request body') };
	}
	const decoded = decodeRequest(savedBlockRequestSchema, raw);
	if (!decoded.ok) {
		return { ok: false, response: invalidInputResponse(decoded.message, decoded.field) };
	}
	return { ok: true, body: decoded.value };
}

function rateLimitedResponse(retryAfterSeconds: number, auth: AuthenticatedContext): Response {
	return errorResponse(
		'rate_limited',
		'Too many template writes from this API key. Retry after the Retry-After header.',
		{
			data: { reason: 'template_write_rate_limited' },
			retryAfter: retryAfterSeconds,
			rateLimit: auth.rateLimit,
		}
	);
}

/**
 * GET /api/v1/saved-blocks - List saved blocks, oldest first.
 */
export const listSavedBlocks = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:read', request.headers.get('Origin'));
		if (denied) return denied;
		const query = readListQuery(new URL(request.url).searchParams);
		if (!query.ok) return invalidInputResponse(query.message, query.field);
		if (query.value.search !== undefined) {
			return invalidInputResponse('Saved blocks cannot be searched', 'search');
		}
		try {
			const page = await ctx.runQuery(internal.publicApi.savedBlocks.listForApi, {
				limit: query.value.limit,
				cursor: query.value.cursor,
			});
			return jsonResponse(page);
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to list saved blocks');
		}
	}
);

/**
 * POST /api/v1/saved-blocks - Create a saved block.
 */
export const createSavedBlock = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:write', request.headers.get('Origin'));
		if (denied) return denied;
		const decoded = await decodeBody(request);
		if (!decoded.ok) return decoded.response;
		const prepared = prepareWrite(decoded.body);
		if (!prepared.ok) return prepared.response;
		try {
			const outcome = await ctx.runMutation(internal.publicApi.savedBlocks.createForApi, {
				keyId: auth.keyId,
				...prepared.fields,
			});
			if (!outcome.ok) return rateLimitedResponse(outcome.retryAfterSeconds, auth);
			const data: SavedBlockWriteResult = { block: outcome.block, issues: prepared.issues };
			return jsonResponse({ data }, 201);
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to create the saved block');
		}
	},
	{ maxBodyBytes: MAX_TEMPLATE_BODY_BYTES }
);

/**
 * GET /api/v1/saved-blocks/{id} - One saved block with its content.
 */
export const getSavedBlock = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:read', request.headers.get('Origin'));
		if (denied) return denied;
		const blockId = blockIdFromPath(request);
		if (blockId instanceof Response) return blockId;
		try {
			const block = await ctx.runQuery(internal.publicApi.savedBlocks.getForApi, { blockId });
			if (!block) return errorResponse('not_found', 'Saved block not found');
			return jsonResponse({ data: block });
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to read the saved block');
		}
	}
);

/**
 * PUT /api/v1/saved-blocks/{id} - Replace a saved block's name, description
 * and blocks; a content change reaches every email that links it.
 */
export const updateSavedBlock = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'templates:write', request.headers.get('Origin'));
		if (denied) return denied;
		const blockId = blockIdFromPath(request);
		if (blockId instanceof Response) return blockId;
		const decoded = await decodeBody(request);
		if (!decoded.ok) return decoded.response;
		const prepared = prepareWrite(decoded.body);
		if (!prepared.ok) return prepared.response;
		try {
			const outcome = await ctx.runMutation(internal.publicApi.savedBlocks.updateForApi, {
				keyId: auth.keyId,
				blockId,
				...prepared.fields,
			});
			if (!outcome.ok) return rateLimitedResponse(outcome.retryAfterSeconds, auth);
			const data: SavedBlockWriteResult = { block: outcome.block, issues: prepared.issues };
			return jsonResponse({ data });
		} catch (error) {
			return errorResponseFromThrow(error, 'Failed to update the saved block');
		}
	},
	{ maxBodyBytes: MAX_TEMPLATE_BODY_BYTES }
);
