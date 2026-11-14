/**
 * GET /api/v1/transactional/{sendId} — the delivery status of one send the
 * transactional API created.
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
import { errorResponse, jsonResponse, lastPathSegment } from '../auth/apiResponses';
import { featureDisabledMessage } from '../lib/featureFlags';

const NOT_FOUND = 'Transactional send not found';

export const getTransactionalSend = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'transactional:send', request.headers.get('Origin'));
		if (denied) return denied;
		// The same feature floor as sending, with the same answer.
		const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
		if (!flags.transactional) {
			return errorResponse('forbidden', featureDisabledMessage('transactional'), {
				data: { reason: 'feature_disabled' },
			});
		}
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
