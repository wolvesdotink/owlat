/**
 * Events: `POST /api/v1/events`.
 *
 * Email syntax is the server's own check, applied after decoding.
 */

import { z } from 'zod';
import { jsonPrimitiveRecordSchema, requestBody, requiredString } from './common';

/** An event name: a letter, then up to 99 letters, digits, `_` or `-`. */
export const EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;

export const sendEventRequestSchema = requestBody({
	email: requiredString('email is required', 'email must be a string'),
	eventName: requiredString('eventName is required', 'eventName must be a string').regex(
		EVENT_NAME_PATTERN,
		{
			error:
				'eventName must start with a letter and contain only alphanumeric characters, underscores, or hyphens (max 100 chars)',
		}
	),
	eventProperties: jsonPrimitiveRecordSchema(
		'eventProperties must be an object of string, number, boolean or null values'
	).optional(),
	createContactIfNotExists: z
		.boolean({ error: 'createContactIfNotExists must be a boolean' })
		.optional(),
});

export const sendEventResponseSchema = z.strictObject({
	eventId: z.string(),
	contactId: z.string(),
	eventName: z.string(),
	triggeredAutomations: z.number().int(),
	contactCreated: z.boolean(),
});
