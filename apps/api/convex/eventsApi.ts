import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
	createAuthenticatedHandler,
	jsonResponse,
	errorResponse,
	requireScope,
	type AuthenticatedContext,
} from "./auth/apiAuth";
import { isValidEmail, normalizeEmail } from './lib/inputGuards';

// Type for the action context
interface ActionContext {
	runQuery: <T>(query: unknown, args: unknown) => Promise<T>;
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
	runAction: <T>(action: unknown, args: unknown) => Promise<T>;
}

// Request body type for sending events
interface SendEventBody {
	email: string;
	eventName: string;
	eventProperties?: Record<string, unknown>;
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

// Contact type from database
interface Contact {
	_id: Id<'contacts'>;
	email: string;
	firstName?: string;
	lastName?: string;
	source: 'api' | 'import' | 'form';
	createdAt: number;
	updatedAt: number;
}

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 10);
	return `evt_${timestamp}${random}`;
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
 */
export const sendEvent = createAuthenticatedHandler(
	async (ctx: ActionContext, request: Request, auth: AuthenticatedContext): Promise<Response> => {
		const denied = requireScope(auth, 'events:write', request.headers.get('Origin'));
		if (denied) return denied;
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
				'eventName must start with a letter and contain only alphanumeric characters, underscores, or hyphens (max 100 chars)',
			);
		}

		// Validate optional fields
		if (body.eventProperties !== undefined && typeof body.eventProperties !== 'object') {
			return errorResponse('invalid_input', 'eventProperties must be an object');
		}

		if (
			body.createContactIfNotExists !== undefined &&
			typeof body.createContactIfNotExists !== 'boolean'
		) {
			return errorResponse('invalid_input', 'createContactIfNotExists must be a boolean');
		}

		// Check if contact exists
		const existingContact = await ctx.runQuery<Contact | null>(
			internal.contacts.contacts.getByEmailForTeam,
			{
				email: normalizeEmail(body.email),
			}
		);

		let contactCreated = false;
		let contactId: Id<'contacts'>;

		if (!existingContact) {
			if (!body.createContactIfNotExists) {
				return errorResponse(
					'not_found',
					`Contact with email "${body.email}" not found. Set createContactIfNotExists: true to create the contact automatically.`,
				);
			}

			// Create the contact
			contactId = await ctx.runMutation<Id<'contacts'>>(
				internal.contacts.contacts.createForTeam,
				{
					email: body.email,
					source: 'api' as const,
				}
			);
			contactCreated = true;
		} else {
			contactId = existingContact._id;
		}

		// Call the sendEvent mutation to fire automation triggers
		try {
			const result = await ctx.runMutation<{
				contactId: Id<'contacts'>;
				eventName: string;
				triggeredAutomations: number;
			}>(
				internal.automations.triggers.sendEvent,
				{
					email: normalizeEmail(body.email),
					eventName: body.eventName,
					eventProperties: body.eventProperties,
					createContactIfNotExists: false, // We already handled contact creation above
				}
			);

			const eventId = generateEventId();

			const response: SendEventResponse = {
				eventId,
				contactId: contactId,
				eventName: body.eventName,
				triggeredAutomations: result.triggeredAutomations,
				contactCreated,
			};

			return jsonResponse(
				{
					data: response,
				},
				201
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to send event';
			return errorResponse('invalid_input', message);
		}
	}
);
