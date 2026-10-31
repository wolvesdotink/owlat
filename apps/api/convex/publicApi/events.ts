import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiHandlers';
import { jsonResponse, errorResponse } from '../auth/apiResponses';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import type { SendEventResponse } from '@owlat/public-contract';
import { decodeRequest, sendEventRequestSchema } from '@owlat/public-contract/schemas';
import {
	idempotencyRefusalResponse,
	readIdempotencyKey,
	replayHeaders,
	resolveIdempotency,
} from '../auth/apiRequestReceipts';

/**
 * POST /api/v1/events - Send an event to trigger automations
 *
 * The request and response shapes are the public contract's
 * (`@owlat/public-contract`); email syntax is checked here, after decoding.
 *
 * An `Idempotency-Key` header makes a repeat of the same request return the
 * first response (with `Idempotent-Replayed: true`) without firing again
 * (`auth/apiRequestReceipts.ts`).
 */
export const sendEvent = createAuthenticatedHandler(
	async (ctx: ActionCtx, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'events:write', request.headers.get('Origin'));
		if (denied) return denied;
		const idempotencyKey = readIdempotencyKey(request);
		if (!idempotencyKey.ok) return errorResponse('invalid_input', idempotencyKey.message);
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}
		const decoded = decodeRequest(sendEventRequestSchema, raw);
		if (!decoded.ok) return errorResponse('invalid_input', decoded.message);
		const body = decoded.value;
		if (!isValidEmail(body.email)) {
			return errorResponse('invalid_input', 'Invalid email format');
		}

		const createContactIfNotExists = body.createContactIfNotExists ?? false;
		const idempotency = await resolveIdempotency(ctx, idempotencyKey.key, 'events', () => ({
			email: body.email,
			eventName: body.eventName,
			eventProperties: body.eventProperties ?? null,
			createContactIfNotExists,
		}));

		// One mutation resolves (or creates) the contact, fires the triggers and
		// records the receipt, so a keyed repeat cannot do any of it twice.
		let result;
		try {
			result = await ctx.runMutation(internal.automations.triggers.sendEvent, {
				email: normalizeEmail(body.email),
				eventName: body.eventName,
				eventProperties: body.eventProperties,
				createContactIfNotExists,
				...(idempotency ? { idempotency } : {}),
			});
		} catch {
			// Locked error envelope — do not echo the raw internal error message.
			return errorResponse('invalid_input', 'Failed to send event');
		}

		if (!result.ok) {
			if (result.reason !== 'contact_not_found') return idempotencyRefusalResponse(result.reason);
			return errorResponse(
				'not_found',
				`Contact with email "${body.email}" not found. Set createContactIfNotExists: true to create the contact automatically.`
			);
		}

		const response: SendEventResponse = {
			eventId: result.eventId,
			contactId: result.contactId,
			eventName: body.eventName,
			triggeredAutomations: result.triggeredAutomations,
			contactCreated: result.contactCreated,
		};
		return jsonResponse({ data: response }, 201, replayHeaders(result.replayed));
	}
);
