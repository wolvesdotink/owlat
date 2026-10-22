import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import {
	createAuthenticatedHandler,
	requireScope,
	type AuthenticatedContext,
} from './auth/apiHandlers';
import { jsonResponse, errorResponse } from './auth/apiResponses';
import {
	isJsonPrimitiveRecord,
	isValidEmail,
	normalizeEmail,
	type JsonPrimitiveValue,
} from './lib/inputGuards';
import {
	idempotencyRefusalResponse,
	readIdempotencyKey,
	replayHeaders,
	resolveIdempotency,
} from './auth/apiRequestReceipts';

// Request body type for sending events
interface SendEventBody {
	email: string;
	eventName: string;
	eventProperties?: Record<string, JsonPrimitiveValue>;
	createContactIfNotExists?: boolean;
}

// Response type
interface SendEventResponse {
	eventId: string;
	contactId: string;
	eventName: string;
	triggeredAutomations: number;
	contactCreated: boolean;
}

/**
 * POST /api/v1/events - Send an event to trigger automations
 *
 * Request body:
 * - email (required): Contact email address
 * - eventName (required): Name of the event
 * - eventProperties (optional): Additional properties for the event
 * - createContactIfNotExists (optional): Create contact if not found (default: false)
 *
 * Response:
 * - eventId: Unique identifier for this event
 * - contactId: ID of the associated contact
 * - eventName: Name of the event that was sent
 * - triggeredAutomations: Number of automations triggered
 * - contactCreated: Whether a new contact was created
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
		// Parse request body
		let body: SendEventBody;
		try {
			body = await request.json();
		} catch {
			return errorResponse('invalid_input', 'Invalid JSON in request body');
		}

		// Validate required fields
		if (!body.email) {
			return errorResponse('invalid_input', 'email is required');
		}

		if (typeof body.email !== 'string') {
			return errorResponse('invalid_input', 'email must be a string');
		}

		if (!isValidEmail(body.email)) {
			return errorResponse('invalid_input', 'Invalid email format');
		}

		if (!body.eventName) {
			return errorResponse('invalid_input', 'eventName is required');
		}

		if (typeof body.eventName !== 'string') {
			return errorResponse('invalid_input', 'eventName must be a string');
		}

		// Validate eventName format (alphanumeric, underscores, hyphens)
		const eventNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;
		if (!eventNameRegex.test(body.eventName)) {
			return errorResponse(
				'invalid_input',
				'eventName must start with a letter and contain only alphanumeric characters, underscores, or hyphens (max 100 chars)'
			);
		}

		// Validate optional fields
		if (body.eventProperties !== undefined && !isJsonPrimitiveRecord(body.eventProperties)) {
			return errorResponse(
				'invalid_input',
				'eventProperties must be an object of string, number, boolean or null values'
			);
		}

		if (
			body.createContactIfNotExists !== undefined &&
			typeof body.createContactIfNotExists !== 'boolean'
		) {
			return errorResponse('invalid_input', 'createContactIfNotExists must be a boolean');
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
