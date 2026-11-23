/**
 * GET /api/v1/transactional/{sendId} — the delivery status of one send the
 * transactional API created — and GET /api/v1/transactional, the list of them.
 *
 * It needs `transactional:send`, the scope that created the send: a key that
 * may send may follow up on what it sent, and no other key learns which
 * addresses this deployment mails. Every id that names no readable send
 * (unknown, malformed, another table's, a send no API call made, an erased
 * one) answers the same 404, so the route tells a caller nothing about rows it
 * could not have been handed.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import {
	errorResponse,
	invalidInputResponse,
	jsonResponse,
	lastPathSegment,
} from '../auth/apiResponses';
import { featureDisabledMessage } from '../lib/featureFlags';
import type { CursorPaginatedResponse, TransactionalSendStatus } from '@owlat/public-contract';
import { encodeSendListCursor, readSendListQuery } from './sendListQuery';

const NOT_FOUND = 'Transactional send not found';

/**
 * The scope and feature floor both reads share: the scope and the floor of
 * sending, with the same answers. Null when the read may go ahead.
 */
async function refuseRead(
	ctx: ActionCtx,
	request: Request,
	auth: AuthenticatedContext
): Promise<Response | null> {
	const denied = requireScope(auth, 'transactional:send', request.headers.get('Origin'));
	if (denied) return denied;
	const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	if (flags.transactional) return null;
	return errorResponse('forbidden', featureDisabledMessage('transactional'), {
		data: { reason: 'feature_disabled' },
	});
}

/**
 * GET /api/v1/transactional — the sends this API created, newest first, by
 * recipient, by status or by window (`./sendList.ts`). The same scope and the
 * same rows as the read by id, so a key learns no address it could not have
 * read one send at a time.
 */
export const listTransactionalSends = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const refused = await refuseRead(ctx, request, auth);
		if (refused) return refused;
		const query = readSendListQuery(new URL(request.url).searchParams, Date.now());
		if (!query.ok) return invalidInputResponse(query.message, query.field);
		const { filterKey: _filterKey, ...args } = query.value;
		const page = await ctx.runQuery(internal.transactional.sendList.listForApi, args);
		const body: CursorPaginatedResponse<TransactionalSendStatus> = {
			data: page.data,
			pagination: {
				limit: query.value.limit,
				cursor: page.cursor === null ? null : encodeSendListCursor(query.value, page.cursor),
				isDone: page.isDone,
			},
		};
		return jsonResponse(body);
	}
);

export const getTransactionalSend = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const refused = await refuseRead(ctx, request, auth);
		if (refused) return refused;
		const segment = lastPathSegment(request);
		if (!segment.ok) {
			return segment.reason === 'missing'
				? errorResponse('invalid_input', 'Send ID is required')
				: errorResponse('invalid_input', 'Invalid send ID format');
		}
		const status = await ctx.runQuery(internal.transactional.sendStatus.getForApi, {
			sendId: segment.value,
		});
		if (!status) return errorResponse('not_found', NOT_FOUND);
		return jsonResponse({ data: status });
	}
);
